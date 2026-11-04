#!/usr/bin/env python3
"""Railway service-catalog checker (#2205, ship-lanes audit §A.2–A.6).

infra/railway/railway.json is typed into Railway by hand, so every rule here
names something Railway does with a value, not a style preference:

* A start command replaces the image ENTRYPOINT in exec form. The oort image is
  ENTRYPOINT [momo-rust-entrypoint]; a bare role name is exit 127.
* Pre-deploy needs a shell for `VAR=… cmd && …`.
* Centrifugo v6 reads only its own env names, not the generator's, and the
  literals that replace infra/centrifugo.json must say what that file says.
* Railway volumes mount root-owned; api must init the drive dir as root and drop
  to uid 10001, and must not keep the superuser DSN pre-deploy needed.
* Postgres must be the compose PG18 + pgvector pin, not a plugin.
* Push keys arrive as sealed base64 variables and land on tmpfs only.
* `${{shared.KEY}}` must name a key the generator writes.
* README's hand-mapped table must list every value that is not an identity
  reference, so the operator can type it from one place.

Shell start commands are checked as parsed commands (shlex, `;` `&&` `||` `|`
kept as separators), not substrings: a `chown` inside an echo string or a
`umask` after the key is written does not count. Each service's whole command
list is also compared with a canonical list — operators, order and values
fixed, only echo text free — so an added `set -x`, a second `k=`, a `||` in
place of `;` or a redefined `run()` is RED even where no named rule looks.

The Hermes service (#4072, ADR-0203 D6) is private, pinned by the same image
digest as compose, starts only through the lock gate, and holds no oort secret.

The GitHub App surface (#4221, ADR-0205): GITHUB_APP_MASTER_KEY and
MOMO_PUBLIC_BASE_URL are on api and on no other service (by name or by
`${{shared.GITHUB_APP_MASTER_KEY}}` reference, services outside the compose-twin
table included), and the address is exactly `https://${{shared.OORT_SITE_ADDRESS}}`
— the api accepts only an absolute https origin, so a wrong host that still
starts with `https://` would be accepted silently.

Each service's variable names must be ones its compose twin sets (plus the
Railway-only extras named below), and infra/centrifugo.json may only hold the
settings the catalog's Centrifugo literals stand in for.

`--prove-mutations` copies the catalog (and README) to scratch, breaks one rule
at a time and requires each copy to fail naming that rule. The committed files
are hashed before and after.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shlex
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

OORT_ROLES = (
    "api",
    "relay",
    "webhook-sender",
    "agent-worker",
    "notifier",
    "push-relay",
)
REQUIRED_SERVICES = OORT_ROLES + ("centrifugo", "caddy", "postgres", "hermes")
CENTRIFUGO_MAP = {
    "CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY": "${{shared.CENT_TOKEN_HMAC}}",
    "CENTRIFUGO_HTTP_API_KEY": "${{shared.CENT_API_KEY}}",
    "CENTRIFUGO_CLIENT_ALLOWED_ORIGINS": "${{shared.CENTRIFUGO_ALLOWED_ORIGINS}}",
    "CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS": (
        '{"X-Centrifugo-Proxy-Secret":"${{shared.CENT_PROXY_SECRET}}"}'
    ),
}
# Literals derived from infra/centrifugo.json (cross-checked below) plus the
# log level. Anything else named CENTRIFUGO_* is an unreviewed setting.
CENTRIFUGO_DERIVED = (
    "CENTRIFUGO_CHANNEL_NAMESPACES",
    "CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT",
    "CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_INCLUDE_CONNECTION_META",
    "CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ENABLED",
)
CENTRIFUGO_ALLOWED = set(CENTRIFUGO_MAP) | set(CENTRIFUGO_DERIVED) | {"CENTRIFUGO_LOG_LEVEL"}
# Literal values an operator types by hand that the audit table (§A.2) names.
HAND_LITERALS = {
    "HOST", "PORT", "CENT_API_URL", "RAILWAY_RUN_UID",
    # #4072: the same-server Hermes wiring is typed by hand, so the README lists it.
    "HERMES_BASE_URL", "AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK", "AGENT_PROVIDER_LOCAL_HOSTS",
    "OORT_COHOSTED_AGENT_TOOLS_LOCKED", "API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_PORT",
    "HERMES_LOGIN_RELAY_URL",  # #4079: the login relay sidecar, hermes.railway.internal:8643
    # #4820 C2b 3부: the two halves of the hosted expression door are typed by hand, so the README lists both.
    "OORT_HOSTED_MEDIA_STRICT", "HERMES_MEDIA_DELIVERY_STRICT",
    # #4934: the api's private address the worker reads a requester's picture through is typed by hand too.
    "OORT_API_INTERNAL_ORIGIN",
}
# Shared variables the operator creates by hand (the generator does not print them).
# HERMES_API_KEY: `openssl rand -hex 32`, one value for hermes' API_SERVER_KEY and the
# HERMES_API_KEY of api and agent-worker.
OPERATOR_SHARED = {"HERMES_API_KEY", "HERMES_LOGIN_RELAY_KEY"}  # the relay key: its own secret, never derived from the chat key (#4078)
# ADR-0205 / #4221: the GitHub App surface of api. The key seals the App's private key and webhook secret, so it
# reaches api and nothing else (ADR-0205 D1; ADR-0203 D6-2 keeps oort secrets out of the Hermes service). The public
# address is what GitHub is told to call; the api reads it only as an absolute https origin
# (T3Settings::ready_public_base_url) and ignores anything else, so the catalog pins the one shape: the scheme typed,
# the host the operator's single declared edge host (OORT_SITE_ADDRESS, which the generator writes).
GITHUB_KEY_VAR = "GITHUB_APP_MASTER_KEY"
GITHUB_KEY_VALUE = "${{shared.GITHUB_APP_MASTER_KEY}}"
PUBLIC_BASE_VAR = "MOMO_PUBLIC_BASE_URL"
PUBLIC_BASE_VALUE = "https://${{shared.OORT_SITE_ADDRESS}}"
HERMES_SHARED_KEY = "${{shared.HERMES_API_KEY}}"
HERMES_RELAY_SHARED_KEY = "${{shared.HERMES_LOGIN_RELAY_KEY}}"
HERMES_PORT = 8642
HERMES_DATA = "/opt/data"
HERMES_GUARD_DIR = HERMES_DATA + "/plugins/oort-image-guard"  # #4820 review: the oort image_generate guard plugin
HERMES_KEYS = {"public", "image", "startCommand", "port", "privateHostname", "volume", "variables"}
HERMES_PY = "/opt/hermes/.venv/bin/python"
REF_RE = re.compile(r"\$\{\{([^}]*)\}\}")
SHARED_RE = re.compile(r"^shared\.([A-Za-z_][A-Za-z0-9_]*)$")
PLACEHOLDER_PREFIXES = ("<sealed:", "<operator:")
SEALED_SERVICES = {"push-relay", "notifier"}
DRIVE_DIR = "/var/lib/oort/drive"
PG_DATA_MOUNT = "/var/lib/postgresql"
SETPRIV = ["setpriv", "--reuid=momo", "--regid=momo", "--init-groups"]
# (service, sealed base64 variable, path variable the binary reads)
PUSH_KEYS = (
    ("push-relay", "APNS_KEY_P8_B64", "MOMO_APNS_KEY_PATH"),
    ("notifier", "RELAY_SIGNING_KEY_B64", "MOMO_PUSH_RELAY_PRIVATE_KEY_PATH"),
)
ANY = object()  # wildcard for one word (echo messages)


def refusal_pattern(tests: list[list[object]]) -> list[tuple[object, list[object]]]:
    """`T1 && T2 … || { echo … >&2; exit 78; }` as commands (first operator ";")."""
    pattern: list[tuple[object, list[object]]] = [(";", tests[0])]
    pattern += [("&&", test) for test in tests[1:]]
    pattern += [
        ("||", ["{", "echo", ANY, ">", "&", "2"]),
        (";", ["exit", "78"]),
        (";", ["}"]),
    ]
    return pattern


def push_canonical(role: str, key_var: str, key_file: str, path_var: str) -> list[tuple[object, list[object]]]:
    return (
        [("", ["set", "-eu"]), (";", ["umask", "077"])]
        + refusal_pattern(
            [
                ["[", "-d", "/dev/shm", "]"],
                ["[", "-w", "/dev/shm", "]"],
                ["[", "$(stat -f -c %T /dev/shm)", "=", "tmpfs", "]"],
            ]
        )
        + [
            (";", [":", "${%s:?%s is required}" % (key_var, key_var)]),
            (";", ["k=/dev/shm/%s" % key_file]),
            (";", ["printf", "%s", "$" + key_var]),
            ("|", ["base64", "-d", ">$k"]),
            (";", ["[", "-s", "$k", "]"]),
            (";", ["unset", key_var]),
            (";", ["export", path_var + "=$k"]),
            (";", ["exec", "momo-rust-entrypoint", role]),
        ]
    )


# The whole command list each shell start command must parse to. A change here
# is a deliberate change of the catalog, reviewed in both places.
CANONICAL_SHELL: dict[str, list[tuple[object, list[object]]]] = {
    "api": [("", ["set", "-eu"])]
    + refusal_pattern([["[", "$(id -u)", "=", "0", "]"]])
    + [
        (";", ["d=${MOMO_DRIVE_LOCAL_DIR:?MOMO_DRIVE_LOCAL_DIR is required}"]),
        (";", ["mkdir", "-p", "$d"]),
        (";", ["chown", "-R", "momo:momo", "$d"]),
        (
            ";",
            ["exec", "setpriv", "--reuid=momo", "--regid=momo", "--init-groups", "env"]
            + [w for name in (
                "MIGRATE_DATABASE_URL",
                "POSTGRES_PASSWORD",
                "MOMO_APP_POSTGRES_PASSWORD",
                "RELAY_POSTGRES_PASSWORD",
                "WORKER_POSTGRES_PASSWORD",
                "NOTIFIER_POSTGRES_PASSWORD",
                "MOMO_INITIAL_OWNER_PASSWORD",
            ) for w in ("-u", name)]
            + ["HOME=/home/momo", "momo-rust-entrypoint", "api"],
        ),
    ],
    "push-relay": push_canonical("push-relay", "APNS_KEY_P8_B64", "apns-key.p8", "MOMO_APNS_KEY_PATH"),
    "notifier": push_canonical(
        "notifier", "RELAY_SIGNING_KEY_B64", "relay-signing-key.pem", "MOMO_PUSH_RELAY_PRIVATE_KEY_PATH"
    ),
}
CANONICAL_PREDEPLOY: list[tuple[object, list[object]]] = [
    ("", ["set", "-eu"]),
    (";", ["run()", "{", "if", "[", "$(id -u)", "=", "0", "]"]),
    (";", ["then", "setpriv", "--reuid=momo", "--regid=momo", "--init-groups", "env", "HOME=/home/momo", "$@"]),
    (";", ["else", "$@"]),
    (";", ["fi"]),
    (";", ["}"]),
    (";", ["run", "env", "DATABASE_URL=$MIGRATE_DATABASE_URL", "MOMO_RUNTIME_ROLE_PROVISION=1", "/usr/local/bin/momo-migrate"]),
    (
        "&&",
        [
            "run",
            "env",
            "DATABASE_URL=$MIGRATE_DATABASE_URL",
            "MOMO_BOOTSTRAP_RUNTIME_ROLES=0",
            "MOMO_ENV=${MOMO_MIGRATE_ENV:-development}",
            "/usr/local/bin/momo-migrate",
        ],
    ),
]
CANONICAL_ARGV: dict[str, list[str] | None] = {
    "relay": ["momo-rust-entrypoint", "relay"],
    "webhook-sender": ["momo-rust-entrypoint", "webhook-sender"],
    "agent-worker": ["momo-rust-entrypoint", "agent-worker"],
    "centrifugo": ["centrifugo"],
    "caddy": ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
    "postgres": None,  # the image default
}

# Railway service -> the compose services whose `environment` keys it may use,
# and the Railway-only names it adds (each with its reason).
COMPOSE_TWINS: dict[str, tuple[list[tuple[str, str]], set[str]]] = {
    # api also hosts pre-deploy = compose runtime-roles + migrate. The renamed
    # pre-deploy inputs (compose passes them as DATABASE_URL / MOMO_ENV) and
    # RAILWAY_RUN_UID (root for the drive volume) are Railway-only.
    "api": (
        [("docker-compose.rust.yml", "api"), ("docker-compose.rust.yml", "migrate"), ("docker-compose.rust.yml", "runtime-roles")],
        {"RAILWAY_RUN_UID", "MIGRATE_DATABASE_URL", "MOMO_MIGRATE_ENV"},
    ),
    "relay": ([("docker-compose.rust.yml", "relay")], set()),
    "webhook-sender": ([("docker-compose.rust.yml", "webhook-sender")], set()),
    "agent-worker": ([("docker-compose.rust.yml", "agent-worker")], set()),
    # compose mounts config.yaml and lockgate.py read-only; Railway has no bind mount, so
    # both arrive as base64 variables the start command decodes.
    "hermes": ([("docker-compose.rust.yml", "hermes")], {"HERMES_CONFIG_B64", "HERMES_LOCKGATE_B64", "HERMES_IMAGE_GUARD_B64", "HERMES_IMAGE_GUARD_MANIFEST_B64", "HERMES_LOGIN_RELAY_B64", "HERMES_LOGIN_PROBE_B64"}),
    "postgres": ([("docker-compose.rust.yml", "postgres")], set()),
    # compose mounts infra/centrifugo.json; these four env literals replace it.
    "centrifugo": ([("docker-compose.rust.yml", "centrifugo")], set(CENTRIFUGO_DERIVED)),
    # compose bind-mounts the key files; Railway passes them as sealed base64.
    "notifier": ([("docker-compose.push.yml", "notifier")], {"RELAY_SIGNING_KEY_B64"}),
    "push-relay": ([("docker-compose.push.yml", "push-relay")], {"APNS_KEY_P8_B64"}),
    # Railway routes the domain to PORT.
    "caddy": ([("caddy.override.yml", "caddy")], {"PORT"}),
}
# The `online` namespace (#4692, ADR-0160 ②) is the workspace roll-call: clients
# subscribe through the proxy only to be COUNTED, and the api reads Centrifugo's
# presence table through the server API. It is therefore presence-ONLY. Any other
# option is a leak: `join_leave` pushes the connect/disconnect stream of people
# outside a subscriber's roster to every subscriber (a guest among them), and any
# `allow_presence_for_*` / `allow_history_for_*` / `allow_publish_for_*` /
# `allow_subscribe_for_client` lets a client read or write the table itself. The
# entry is compared WHOLE, so adding an option is red, not just the known-bad ones.
ONLINE_NAMESPACE = {
    "name": "online",
    "presence": True,
    "history_size": 0,
    "history_ttl": "0s",
    "subscribe_proxy_enabled": True,
    "channel_regex": "^ws[0-9A-Fa-f-]{36}$",
}


def online_namespace_errors(namespaces: object, where: str) -> list[str]:
    entries = [n for n in (namespaces if isinstance(namespaces, list) else []) if isinstance(n, dict) and n.get("name") == "online"]
    if len(entries) != 1:
        return ["%s must define exactly one `online` namespace (#4692: the roster reads availability from its presence table)" % where]
    if entries[0] != ONLINE_NAMESPACE:
        return [
            "%s online namespace must be presence-only (#4692): exactly %s, got %s — join_leave or any allow_* option "
            "hands subscribers the connect/disconnect stream or the table itself"
            % (where, json.dumps(ONLINE_NAMESPACE, sort_keys=True), json.dumps(entries[0], sort_keys=True))
        ]
    return []


# Leaf settings of infra/centrifugo.json the catalog's Centrifugo literals carry
# (lists are one setting). A new key there must be carried here first.
KNOWN_CENTRIFUGO_SETTINGS = {
    "channel.namespaces",
    "channel.proxy.subscribe.endpoint",
    "channel.proxy.subscribe.include_connection_meta",
    "channel.proxy.subscribe.http.static_headers.X-Centrifugo-Proxy-Secret",
    "client.allowed_origins",
    "client.subscription_token.enabled",
}



def hermes_config_shas(repo_root: Path, errors: list[str]) -> list[str]:
    """The sha256 of every config the gate and the start command accept, in the catalog's order: the renderer rebuilds them from the repo's
    own pieces (same input, same bytes). lockgate.py carries the same table (`ACCEPTED_CONFIG_SHA256`); the two have to be one list."""
    import importlib.util

    def load(name: str):
        spec = importlib.util.spec_from_file_location("catalog_check_" + name, repo_root / "infra" / "hermes" / (name + ".py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    try:
        renderer, gate = load("render_model_config"), load("lockgate")
        catalog = renderer.repo_catalog(str(repo_root / "infra" / "hermes"))
        shas = {name: renderer.sha256_of(text) for name, text in catalog.items()}
    except Exception as exc:  # a renderer that cannot render the catalog is a catalog nobody can accept
        errors.append("infra/hermes/render_model_config.py cannot rebuild the config catalog: %s" % exc.__class__.__name__)
        return []
    if dict(gate.ACCEPTED_CONFIG_SHA256) != {sha: name for name, sha in shas.items()} \
            or list(gate.ACCEPTED_CONFIG_SHA256.values()) != list(shas):
        errors.append(
            "infra/hermes/lockgate.py ACCEPTED_CONFIG_SHA256 is not the config catalog `render_model_config.py --catalog` rebuilds "
            "(names, hashes and order): update the table, then the start command and HERMES_LOCKGATE_B64"
        )
    return list(shas.values())


def hermes_canonical(
    config_shas: list[str], gate_sha: str, guard_sha: str, manifest_sha: str, relay_sha: str, probe_sha: str
) -> list[tuple[object, list[object]]]:
    """#4072: config and gate arrive as base64 variables and are PINNED to the repo bytes.

    #4935: the config is pinned to a LIST of sha256 values, not one: the default config and the connector-mode config of each model
    fragment (`infra/hermes/render_model_config.py --catalog`). `sha256sum <config> | cut -c1-64 | grep -qxF -e <h> ...` passes only when the
    decoded file's hash is exactly one of them (whole-line, fixed-string match), and `|| { echo ... >&2; exit 78; }` says why it stopped.

    The sha256 check is what makes the start command fail-closed against an empty, stale or swapped
    variable: `printf " " | base64 -d` is an empty gate script that would exit 0 and start Hermes unchecked
    (review M3). The gate runs BEFORE the image's own entrypoint (which starts the gateway ahead of any CMD),
    `set -e` stops the service on a non-zero gate, and `exec` hands PID 1 to the dispatcher.

    #4078: the login relay block comes AFTER the gate and only when HERMES_LOGIN_RELAY_KEY is set (no key = no
    process, the Q3 off switch). With a key, the sidecar and probe are decoded, PINNED to the repo bytes (a stale
    sidecar would be a stale security boundary) and launched in the background (`launch` moves the key into a 0400
    file of a dedicated uid and starts `serve` as that uid). The key variables are UNSET before `exec`, so the
    gateway and every `hermes` child inherit no copy.

    #4820 review: the oort-owned image guard plugin (a Hermes user plugin, `pre_tool_call`) is decoded into
    /opt/data/plugins/oort-image-guard BEFORE the gate, both files pinned to the repo bytes, because the gate
    verifies those bytes again, loads them into its scratch home and calls the real dispatch path with a canary."""
    return [
        ("", ["set", "-eu"]),
        (";", ["umask", "022"]),
        (";", [":", "${HERMES_CONFIG_B64:?}", "${HERMES_LOCKGATE_B64:?}", "${HERMES_IMAGE_GUARD_B64:?}",
               "${HERMES_IMAGE_GUARD_MANIFEST_B64:?}", "${API_SERVER_KEY:?}"]),
        (";", ["mkdir", "-p", HERMES_GUARD_DIR]),
        (";", ["printf", "%s", "$HERMES_CONFIG_B64"]),
        ("|", ["base64", "-d", ">", HERMES_DATA + "/config.yaml"]),
        (";", ["printf", "%s", "$HERMES_LOCKGATE_B64"]),
        ("|", ["base64", "-d", ">", "/tmp/lockgate.py"]),
        (";", ["printf", "%s", "$HERMES_IMAGE_GUARD_B64"]),
        ("|", ["base64", "-d", ">", HERMES_GUARD_DIR + "/__init__.py"]),
        (";", ["printf", "%s", "$HERMES_IMAGE_GUARD_MANIFEST_B64"]),
        ("|", ["base64", "-d", ">", HERMES_GUARD_DIR + "/plugin.yaml"]),
        (";", ["sha256sum", HERMES_DATA + "/config.yaml"]),
        ("|", ["cut", "-c1-64"]),
        ("|", ["grep", "-qxF"] + [word for sha in config_shas for word in ("-e", sha)]),
        ("||", ["{", "echo", ANY, ">", "&", "2"]),
        (";", ["exit", "78"]),
        (";", ["}"]),
        (";", ["echo", "%s  %s" % (gate_sha, "/tmp/lockgate.py")]),
        ("|", ["sha256sum", "-c", "-"]),
        (";", ["echo", "%s  %s" % (guard_sha, HERMES_GUARD_DIR + "/__init__.py")]),
        ("|", ["sha256sum", "-c", "-"]),
        (";", ["echo", "%s  %s" % (manifest_sha, HERMES_GUARD_DIR + "/plugin.yaml")]),
        ("|", ["sha256sum", "-c", "-"]),
        (";", [HERMES_PY, "/tmp/lockgate.py", "gate", HERMES_DATA + "/config.yaml"]),
        (";", ["[", "-z", "${HERMES_LOGIN_RELAY_KEY:-}", "]"]),
        ("||", ["{", ":", "${HERMES_LOGIN_RELAY_B64:?}", "${HERMES_LOGIN_PROBE_B64:?}"]),
        (";", ["printf", "%s", "$HERMES_LOGIN_RELAY_B64"]),
        ("|", ["base64", "-d", ">", "/tmp/login_relay.py"]),
        (";", ["printf", "%s", "$HERMES_LOGIN_PROBE_B64"]),
        ("|", ["base64", "-d", ">", "/tmp/mcp_login_probe.py"]),
        (";", ["echo", "%s  %s" % (relay_sha, "/tmp/login_relay.py")]),
        ("|", ["sha256sum", "-c", "-"]),
        (";", ["echo", "%s  %s" % (probe_sha, "/tmp/mcp_login_probe.py")]),
        ("|", ["sha256sum", "-c", "-"]),
        (";", ["OORT_LOGIN_RELAY_PROBE=/tmp/mcp_login_probe.py", HERMES_PY, "-B", "/tmp/login_relay.py", "launch", "&", "}"]),
        (";", ["unset", "HERMES_LOGIN_RELAY_KEY", "HERMES_LOGIN_RELAY_B64", "HERMES_LOGIN_PROBE_B64"]),
        (";", [HERMES_PY, "/tmp/lockgate.py", "report", "&", "exec",
               "/opt/hermes/docker/entrypoint-dispatch.sh", "gateway", "run"]),
    ]

def canonical_diff(
    commands: list[tuple[str, list[str]]], canonical: list[tuple[object, list[object]]]
) -> str | None:
    """First difference between parsed commands and the canonical list, or None."""
    def show(words: list[object]) -> list[str]:
        return ["<echo text>" if w is ANY else str(w) for w in words]

    for index, (want_op, want_words) in enumerate(canonical):
        if index >= len(commands):
            return "command #%d missing, want %s %s" % (index, want_op or "(first)", show(want_words))
        op, words = commands[index]
        if op != want_op or not words_match(words, want_words):
            return "command #%d is %s %s, want %s %s" % (
                index, op or "(first)", words, want_op or "(first)", show(want_words)
            )
    if len(commands) > len(canonical):
        op, words = commands[len(canonical)]
        return "extra command #%d %s %s" % (len(canonical), op, words)
    return None


def compose_env_keys(text: str) -> dict[str, set[str]]:
    """services.<name>.environment keys of a compose file (map form)."""
    keys: dict[str, set[str]] = {}
    in_services = in_env = False
    service = None
    for line in text.splitlines():
        if re.match(r"^\S", line):
            in_services = bool(re.match(r"^services:\s*$", line))
            service, in_env = None, False
            continue
        if not in_services:
            continue
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if match:
            service, in_env = match.group(1), False
            keys.setdefault(service, set())
            continue
        if service is None:
            continue
        if re.match(r"^    environment:\s*$", line):
            in_env = True
            continue
        if in_env:
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            match = re.match(r"^      ([A-Za-z_][A-Za-z0-9_]*):", line)
            if match:
                keys[service].add(match.group(1))
            elif re.match(r"^ {0,4}\S", line):
                in_env = False
    return keys


def leaf_settings(node: object, prefix: str = "") -> set[str]:
    if isinstance(node, dict):
        out: set[str] = set()
        for key, value in node.items():
            out |= leaf_settings(value, "%s.%s" % (prefix, key) if prefix else key)
        return out
    return {prefix}


def compose_image(compose_text: str, service: str) -> str | None:
    """`image:` of a top-level service in docker-compose.rust.yml."""
    in_service = False
    for line in compose_text.splitlines():
        if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
            in_service = line.strip() == service + ":"
            continue
        if in_service:
            match = re.match(r"^    image:\s*(\S+)\s*$", line)
            if match:
                return match.group(1)
    return None


def split_start(command: object) -> list[str] | None:
    if not isinstance(command, str) or not command.strip():
        return None
    try:
        return shlex.split(command)
    except ValueError:
        return None


def shell_script(command: object) -> str | None:
    argv = split_start(command)
    if argv and len(argv) == 3 and argv[0] == "/bin/sh" and argv[1] == "-c":
        return argv[2]
    return None


def shell_commands(script: str | None) -> list[tuple[str, list[str]]]:
    """Top-level simple commands of a sh -c script: (preceding operator, words).

    The operator is `;`, `&&`, `||`, `|`, or "" for the first command. Quoted
    text stays one word, so an echo message can never pass for a command.
    """
    if not script:
        return []
    lexer = shlex.shlex(script, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    commands: list[tuple[str, list[str]]] = []
    current: list[str] = []
    operator = ""
    try:
        for token in lexer:
            if token in (";", "&&", "||", "|"):
                if current:
                    commands.append((operator, current))
                current, operator = [], token
                continue
            current.append(token)
    except ValueError:
        return []
    if current:
        commands.append((operator, current))
    return commands


def words_match(words: list[str], pattern: list[object]) -> bool:
    return len(words) == len(pattern) and all(
        want is ANY or want == got for want, got in zip(pattern, words)
    )


def find_sequence(
    commands: list[tuple[str, list[str]]], pattern: list[tuple[object, list[object]]]
) -> int:
    """Index of the first contiguous run of commands matching pattern, or -1.
    A pattern operator of ANY matches any operator."""
    for start in range(len(commands) - len(pattern) + 1):
        ok = True
        for offset, (want_op, want_words) in enumerate(pattern):
            op, words = commands[start + offset]
            if (want_op is not ANY and op != want_op) or not words_match(words, want_words):
                ok = False
                break
        if ok:
            return start
    return -1


def find_command(commands: list[tuple[str, list[str]]], pattern: list[object]) -> int:
    return find_sequence(commands, [(ANY, pattern)])


def refusal(tests: list[list[object]]) -> list[tuple[object, list[object]]]:
    """`T1 && T2 … || { echo … >&2; exit 78; }` as a command pattern."""
    pattern: list[tuple[object, list[object]]] = [(ANY, tests[0])]
    pattern += [("&&", test) for test in tests[1:]]
    pattern += [
        ("||", ["{", "echo", ANY, ">", "&", "2"]),
        (";", ["exit", "78"]),
        (";", ["}"]),
    ]
    return pattern


def readme_rows(readme: str) -> set[tuple[str, str]]:
    rows = set()
    for line in readme.splitlines():
        match = re.match(r"^\|\s*([a-z-]+)\s*\|\s*`([A-Z0-9_]+)`\s*\|", line)
        if match:
            rows.add((match.group(1), match.group(2)))
    return rows


def api_start_errors(api: dict, api_vars: dict) -> list[str]:
    errors: list[str] = []
    commands = shell_commands(shell_script(api.get("startCommand")))
    if not commands or commands[0][1] != ["set", "-eu"]:
        errors.append("api start command must begin with `set -eu`")
    guard = find_sequence(commands, refusal([["[", "$(id -u)", "=", "0", "]"]]))
    bind = next(
        (i for i, (_, w) in enumerate(commands) if len(w) == 1 and w[0].startswith("d=${MOMO_DRIVE_LOCAL_DIR:?")),
        -1,
    )
    mkdir = find_command(commands, ["mkdir", "-p", "$d"])
    chown = find_command(commands, ["chown", "-R", "momo:momo", "$d"])
    last = commands[-1][1] if commands else []
    if guard < 0 or (chown >= 0 and guard > chown):
        errors.append(
            "api start command must refuse without root (`[ \"$(id -u)\" = 0 ] || { …; exit 78; }`) before chown"
        )
    if bind < 0 or mkdir < 0 or not bind < mkdir:
        errors.append("api start command must bind d=\"${MOMO_DRIVE_LOCAL_DIR:?…}\" and mkdir -p \"$d\"")
    if chown < 0 or chown < mkdir or chown >= len(commands) - 1:
        errors.append(
            "api start command must chown -R momo:momo \"$d\" (as a command, after mkdir, before the exec)"
        )
    # exec setpriv --reuid=momo --regid=momo --init-groups env (-u NAME)+ HOME=/home/momo momo-rust-entrypoint api
    head = ["exec"] + SETPRIV + ["env"]
    tail = ["HOME=/home/momo", "momo-rust-entrypoint", "api"]
    middle = last[len(head) : len(last) - len(tail)] if len(last) >= len(head) + len(tail) else []
    pairs_ok = len(middle) >= 2 and len(middle) % 2 == 0 and all(
        middle[i] == "-u" and re.fullmatch(r"[A-Z0-9_]+", middle[i + 1]) for i in range(0, len(middle), 2)
    )
    if last[: len(head)] != head or last[len(last) - len(tail) :] != tail or not pairs_ok:
        errors.append(
            "api start command must end with `exec setpriv --reuid=momo --regid=momo "
            "--init-groups env -u … HOME=/home/momo momo-rust-entrypoint api`: %r" % (last,)
        )
    dropped = {middle[i + 1] for i in range(0, len(middle), 2)} if pairs_ok else set()
    must_drop = {"MIGRATE_DATABASE_URL", "POSTGRES_PASSWORD", "MOMO_INITIAL_OWNER_PASSWORD"} | {
        name for name in api_vars if name.endswith("_POSTGRES_PASSWORD")
    }
    if not must_drop <= dropped:
        errors.append(
            "api start command keeps pre-deploy secrets in the server env "
            "(env -u missing): %s" % ",".join(sorted(must_drop - dropped))
        )
    return errors


def predeploy_errors(api: dict) -> list[str]:
    errors: list[str] = []
    pre = api.get("preDeployCommand")
    script = shell_script(pre[0]) if isinstance(pre, list) and len(pre) == 1 else None
    if script is None:
        return [
            "api preDeploy must be one `/bin/sh -c '…'` string (VAR=… cmd && … "
            "needs a shell): %r" % (pre,)
        ]
    commands = shell_commands(script)
    roles = ["run", "env", "DATABASE_URL=$MIGRATE_DATABASE_URL", "MOMO_RUNTIME_ROLE_PROVISION=1", "/usr/local/bin/momo-migrate"]
    migrate = [
        "run",
        "env",
        "DATABASE_URL=$MIGRATE_DATABASE_URL",
        "MOMO_BOOTSTRAP_RUNTIME_ROLES=0",
        "MOMO_ENV=${MOMO_MIGRATE_ENV:-development}",
        "/usr/local/bin/momo-migrate",
    ]
    if len(commands) < 2 or find_sequence(commands[-2:], [(ANY, roles), ("&&", migrate)]) != 0:
        errors.append(
            "api preDeploy must end with roles (MOMO_RUNTIME_ROLE_PROVISION=1) && "
            "migrate (MOMO_BOOTSTRAP_RUNTIME_ROLES=0), both on MIGRATE_DATABASE_URL via run"
        )
    run_def = [
        (ANY, ["run()", "{", "if", "[", "$(id -u)", "=", "0", "]"]),
        (";", ["then"] + SETPRIV + ["env", "HOME=/home/momo", "$@"]),
        (";", ["else", "$@"]),
        (";", ["fi"]),
        (";", ["}"]),
    ]
    if find_sequence(commands, run_def) < 0:
        errors.append(
            "api preDeploy must drop to momo when root (run() { if root: setpriv "
            "--reuid=momo --regid=momo --init-groups …; else as is; }) — "
            "RAILWAY_RUN_UID=0 makes pre-deploy root too"
        )
    return errors


def push_start_errors(service: str, svc: dict, key_var: str, path_var: str) -> list[str]:
    errors: list[str] = []
    prefix = "%s start command:" % service
    commands = shell_commands(shell_script(svc.get("startCommand")))
    if not commands or commands[0][1] != ["set", "-eu"]:
        errors.append("%s must begin with `set -eu`" % prefix)
    umask = find_command(commands, ["umask", "077"])
    guard = find_sequence(
        commands,
        refusal(
            [
                ["[", "-d", "/dev/shm", "]"],
                ["[", "-w", "/dev/shm", "]"],
                ["[", "$(stat -f -c %T /dev/shm)", "=", "tmpfs", "]"],
            ]
        ),
    )
    keyfile = next(
        (i for i, (_, w) in enumerate(commands) if len(w) == 1 and w[0].startswith("k=")), -1
    )
    write = find_sequence(
        commands, [(ANY, ["printf", "%s", "$" + key_var]), ("|", ["base64", "-d", ">$k"])]
    )
    nonempty = find_command(commands, ["[", "-s", "$k", "]"])
    unset = find_command(commands, ["unset", key_var])
    export = find_command(commands, ["export", path_var + "=$k"])
    last = len(commands) - 1
    if write < 0 or nonempty < 0 or not write < nonempty:
        errors.append(
            "%s key must be decoded with printf %%s \"$%s\" | base64 -d >\"$k\" and checked non-empty"
            % (prefix, key_var)
        )
        return errors
    if umask < 0 or umask > write:
        errors.append("%s umask 077 must come before the key is written" % prefix)
    if guard < 0 or guard > write:
        errors.append(
            "%s /dev/shm must be checked as a writable tmpfs (exit 78) before the key is written" % prefix
        )
    if keyfile < 0 or not commands[keyfile][1][0].startswith("k=/dev/shm/") or keyfile > write:
        errors.append("%s key file must be k=/dev/shm/… (tmpfs) before the write" % prefix)
    if unset < 0 or not nonempty < unset < last:
        errors.append("%s %s must be unset before exec" % (prefix, key_var))
    if export < 0 or not nonempty < export < last:
        errors.append("%s %s must be exported as \"$k\" before exec" % (prefix, path_var))
    return errors


def centrifugo_errors(services: dict, centrifugo_json: dict, compose: str) -> list[str]:
    errors: list[str] = []
    cent = services["centrifugo"]
    cent_vars = cent.get("variables") if isinstance(cent.get("variables"), dict) else {}
    for name, value in CENTRIFUGO_MAP.items():
        if cent_vars.get(name) != value:
            errors.append(
                "centrifugo %s %r != %r (v6 reads only its own names)"
                % (name, cent_vars.get(name), value)
            )
    unexpected = sorted(k for k in cent_vars if k.startswith("CENTRIFUGO_") and k not in CENTRIFUGO_ALLOWED)
    if "CENTRIFUGO_PORT" in cent_vars:
        errors.append("centrifugo CENTRIFUGO_PORT is not a v6 key")
    elif unexpected:
        errors.append("centrifugo has unreviewed CENTRIFUGO_* keys: %s" % ",".join(unexpected))
    want_cent_image = compose_image(compose, "centrifugo")
    if cent.get("image") != want_cent_image:
        errors.append("centrifugo image %r != compose %r" % (cent.get("image"), want_cent_image))

    # The literals stand in for the mounted infra/centrifugo.json: same settings.
    channel = centrifugo_json.get("channel") or {}
    subscribe = ((channel.get("proxy") or {}).get("subscribe")) or {}
    client = centrifugo_json.get("client") or {}
    try:
        namespaces = json.loads(cent_vars.get("CENTRIFUGO_CHANNEL_NAMESPACES", "null"))
    except json.JSONDecodeError:
        namespaces = None
    if namespaces != channel.get("namespaces"):
        errors.append("centrifugo CENTRIFUGO_CHANNEL_NAMESPACES != infra/centrifugo.json channel.namespaces")
    errors.extend(online_namespace_errors(channel.get("namespaces"), "infra/centrifugo.json"))
    errors.extend(online_namespace_errors(namespaces, "centrifugo CENTRIFUGO_CHANNEL_NAMESPACES"))
    api = services["api"]
    endpoint_path = urlparse(str(subscribe.get("endpoint", ""))).path
    want_endpoint = "http://%s:%s%s" % (api.get("privateHostname"), api.get("port"), endpoint_path)
    if not endpoint_path or cent_vars.get("CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT") != want_endpoint:
        errors.append(
            "centrifugo CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT %r != %r (api privateHostname:port + infra/centrifugo.json path)"
            % (cent_vars.get("CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT"), want_endpoint)
        )
    want_meta = json.dumps(bool(subscribe.get("include_connection_meta")))
    if cent_vars.get("CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_INCLUDE_CONNECTION_META") != want_meta:
        errors.append(
            "centrifugo CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_INCLUDE_CONNECTION_META %r != %r (infra/centrifugo.json)"
            % (cent_vars.get("CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_INCLUDE_CONNECTION_META"), want_meta)
        )
    want_token = json.dumps(bool((client.get("subscription_token") or {}).get("enabled")))
    if cent_vars.get("CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ENABLED") != want_token:
        errors.append(
            "centrifugo CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ENABLED %r != %r (infra/centrifugo.json)"
            % (cent_vars.get("CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ENABLED"), want_token)
        )
    want_headers = set(((subscribe.get("http") or {}).get("static_headers") or {}).keys())
    try:
        got_headers = set(
            json.loads(
                REF_RE.sub("x", cent_vars.get("CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS", "{}"))
            ).keys()
        )
    except json.JSONDecodeError:
        got_headers = set()
    if got_headers != want_headers:
        errors.append(
            "centrifugo proxy static header names %s != infra/centrifugo.json %s"
            % (sorted(got_headers), sorted(want_headers))
        )
    return errors


def hermes_errors(services: dict, compose: str, repo_root: Path) -> list[str]:
    """The same-server Hermes (ADR-0203 D6/D8/D9): private, digest-pinned, gate-first, no oort secret."""
    errors: list[str] = []
    hermes = services["hermes"]
    variables = hermes.get("variables") or {}
    image = hermes.get("image")
    twin_image = compose_image(compose, "hermes")
    if not isinstance(image, str) or not re.search(r"@sha256:[0-9a-f]{64}$", image):
        errors.append("hermes image %r must be pinned by an index digest (@sha256:…)" % (image,))
    elif image != twin_image:
        errors.append("hermes image %r != the compose hermes image %r" % (image, twin_image))
    if hermes.get("public") is not False:
        errors.append("hermes public must be exactly false (a string or a missing key is not)")
    extra_keys = sorted(set(hermes) - HERMES_KEYS)
    if extra_keys:
        errors.append("hermes has keys the catalog does not review (domain? replicas? restart?): %s" % ",".join(extra_keys))
    shas = []
    for name in ("lockgate.py", "plugins/oort-image-guard/__init__.py",
                 "plugins/oort-image-guard/plugin.yaml", "login_relay.py", "mcp_login_probe.py"):
        try:
            shas.append(hashlib.sha256((repo_root / "infra" / "hermes" / name).read_bytes()).hexdigest())
        except OSError as exc:
            errors.append("infra/hermes/%s unreadable: %s" % (name, exc.__class__.__name__))
    config_shas = hermes_config_shas(repo_root, errors)
    if len(shas) == 5 and config_shas:
        diff = canonical_diff(shell_commands(shell_script(hermes.get("startCommand"))), hermes_canonical(config_shas, *shas))
        if diff:
            errors.append(
                "hermes start command is not the canonical command list (gate-first, fail-closed, config pinned to the sha256 LIST of "
                "`render_model_config.py --catalog` (the default config and a connector-mode config for each model fragment), gate and "
                "the two image-guard plugin files pinned to the sha256 of lockgate.py and plugins/oort-image-guard/*, the plugin "
                "installed before the gate; the login relay block only with a key, its two files pinned the same way, key variables "
                "unset before exec): %s" % diff
            )
    if (hermes.get("volume") or {}).get("mountPath") != HERMES_DATA:
        errors.append("hermes volume mountPath %r != %s" % ((hermes.get("volume") or {}).get("mountPath"), HERMES_DATA))
    if hermes.get("port") != HERMES_PORT or variables.get("API_SERVER_PORT") != str(HERMES_PORT):
        errors.append("hermes port and API_SERVER_PORT must be %d" % HERMES_PORT)
    if variables.get("API_SERVER_ENABLED") != "true":
        errors.append("hermes API_SERVER_ENABLED must be true")
    if variables.get("API_SERVER_HOST") != "0.0.0.0":
        errors.append(
            "hermes API_SERVER_HOST must be 0.0.0.0 (an environment created after 2025-10-16 resolves "
            "internal names to IPv4 and IPv6; `::` is runtime-unverified, ADR-0203 D9)"
        )
    if variables.get("API_SERVER_KEY") != HERMES_SHARED_KEY:
        errors.append("hermes API_SERVER_KEY %r must be %s" % (variables.get("API_SERVER_KEY"), HERMES_SHARED_KEY))
    for forbidden in ("API_SERVER_CORS_ORIGINS", "HERMES_YOLO_MODE", "HERMES_DASHBOARD"):
        if forbidden in variables:
            errors.append("hermes must not set %s (lock gate invariant)" % forbidden)
    if variables.get("HERMES_LOGIN_RELAY_KEY") != HERMES_RELAY_SHARED_KEY:
        errors.append(
            "hermes HERMES_LOGIN_RELAY_KEY %r must be %s (its own shared secret, not the chat key)"
            % (variables.get("HERMES_LOGIN_RELAY_KEY"), HERMES_RELAY_SHARED_KEY)
        )
    for name in ("HERMES_CONFIG_B64", "HERMES_LOCKGATE_B64", "HERMES_IMAGE_GUARD_B64", "HERMES_IMAGE_GUARD_MANIFEST_B64",
                 "HERMES_LOGIN_RELAY_B64", "HERMES_LOGIN_PROBE_B64"):
        if not str(variables.get(name, "")).startswith("<operator:"):
            errors.append("hermes %s must be an <operator: …> placeholder (base64 of the repo file)" % name)
    if hermes.get("healthcheckPath") is not None:
        errors.append("hermes healthcheckPath is runtime-unverified on Railway; leave it unset")
    base = "http://%s:%d/v1" % (hermes.get("privateHostname"), HERMES_PORT)
    if hermes.get("privateHostname") != "hermes.railway.internal":
        errors.append("hermes privateHostname must be hermes.railway.internal")
    for role in ("api", "agent-worker"):
        got = (services[role].get("variables") or {})
        want = {
            "HERMES_BASE_URL": base,
            "HERMES_API_KEY": HERMES_SHARED_KEY,
            "AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK": "1",
            # exact host, never a wildcard (ADR-0004 증보 2026-09-08)
            "AGENT_PROVIDER_LOCAL_HOSTS": hermes.get("privateHostname"),
        }
        if role == "api":
            want["OORT_COHOSTED_AGENT_TOOLS_LOCKED"] = "1"
            # #4079: the login relay (api only): the sidecar's private address and its own shared key.
            want["HERMES_LOGIN_RELAY_URL"] = "http://%s:8643" % hermes.get("privateHostname")
            want["HERMES_LOGIN_RELAY_KEY"] = HERMES_RELAY_SHARED_KEY
        for var, value in want.items():
            if got.get(var) != value:
                errors.append("%s %s %r must be %r (same-server Hermes wiring)" % (role, var, got.get(var), value))
    for var in ("HERMES_LOGIN_RELAY_URL", "HERMES_LOGIN_RELAY_KEY"):
        if var in (services["agent-worker"].get("variables") or {}):
            errors.append("agent-worker must not carry %s (the login relay is api only, #4079)" % var)
    if "OORT_COHOSTED_AGENT_TOOLS_LOCKED" in (services["agent-worker"].get("variables") or {}):
        errors.append("agent-worker must not carry OORT_COHOSTED_AGENT_* (api only, ADR-0203 증보 K-S2)")
    return errors


SELF_MEDIA_VAR = "OORT_SELF_MEDIA_ORIGIN"
SELF_MEDIA_SERVICES = ("agent-worker", "hermes")


def self_media_errors(services: dict) -> list[str]:
    """#4820 C2a (owner 10-30 decision): the origin of the requester's short-lived photo address reaches exactly two services.

    agent-worker builds the address under it and hermes' image guard lets `image_url` carry exactly that origin, so both
    hold the one value `https://${{shared.OORT_SITE_ADDRESS}}` (the edge's own host; lockgate.py refuses anything that is not
    that shape) and no other service has the variable by name or by reference. It is a separate name on purpose:
    MOMO_PUBLIC_BASE_URL stays api only (ADR-0205 D1, see github_errors)."""
    errors: list[str] = []
    for name in SELF_MEDIA_SERVICES:
        got = (services[name].get("variables") or {}).get(SELF_MEDIA_VAR)
        if got != PUBLIC_BASE_VALUE:
            errors.append(
                "%s %s %r must be %s (the one origin the image guard accepts; without it no photo address is minted)"
                % (name, SELF_MEDIA_VAR, got, PUBLIC_BASE_VALUE)
            )
    for name, svc in services.items():
        if name not in SELF_MEDIA_SERVICES and SELF_MEDIA_VAR in (svc.get("variables") or {}):
            errors.append("%s must not carry %s (agent-worker and hermes only, #4820 C2a)" % (name, SELF_MEDIA_VAR))
    return errors


API_INTERNAL_VAR = "OORT_API_INTERNAL_ORIGIN"


def api_internal_errors(services: dict) -> list[str]:
    """#4934 (ADR-0151 증보 3): agent-worker reads a requester's attachment THROUGH the api, at the api's private address.

    A Railway volume attaches to one service, so the `local` archive is api's alone. The worker mints a single-use address
    in the database and spends it itself at `{origin}/v1/self-media/{ws}/{token}`; the origin is the api's own declaration
    (`privateHostname` + `port`, plain http on the private network), never the public edge (the single-use credential would
    otherwise travel the internet to reach the service next door) and never derived from anything else. Only agent-worker
    carries the name: no other service has a business reading a requester's picture."""
    errors: list[str] = []
    api = services["api"]
    want = "http://%s:%s" % (api.get("privateHostname"), api.get("port"))
    got = (services["agent-worker"].get("variables") or {}).get(API_INTERNAL_VAR)
    if got != want:
        errors.append(
            "agent-worker %s %r must be %s (the api's own private address; without it the worker cannot read "
            "a requester's picture on Railway, #4934)" % (API_INTERNAL_VAR, got, want)
        )
    for name, svc in services.items():
        if name != "agent-worker" and API_INTERNAL_VAR in (svc.get("variables") or {}):
            errors.append("%s must not carry %s (agent-worker only, #4934)" % (name, API_INTERNAL_VAR))
    return errors


HOSTED_STRICT_VAR = "OORT_HOSTED_MEDIA_STRICT"
MEDIA_STRICT_VAR = "HERMES_MEDIA_DELIVERY_STRICT"


def hosted_media_strict_errors(services: dict) -> list[str]:
    """#4820 C2b 3부 (ADR-0218 G3.7 (b)): the two halves of the hosted expression door, one on each service.

    hermes carries the literal `1`: lockgate.py refuses to start the picture tool without exactly that (and refuses the name
    in the volume's .env), so a template without it would be a Hermes that cannot boot. agent-worker carries the operator's
    attestation EMPTY: the template never attests for the operator, the door opens only when someone sets `1` there (a worker
    cannot see Hermes, so an attestation shipped in the template would be a claim nobody made). No other service has either
    name."""
    errors: list[str] = []
    got = (services["hermes"].get("variables") or {}).get(MEDIA_STRICT_VAR)
    if got != "1":
        errors.append(
            "hermes %s %r must be '1' (lockgate.py refuses to start the picture tool without exactly that)"
            % (MEDIA_STRICT_VAR, got)
        )
    got = (services["agent-worker"].get("variables") or {}).get(HOSTED_STRICT_VAR)
    if got != "":
        errors.append(
            "agent-worker %s %r must be present and empty (the template does not attest strict media delivery for the "
            "operator; the hosted door opens only on an operator's exact 1)" % (HOSTED_STRICT_VAR, got)
        )
    for name, svc in services.items():
        variables = svc.get("variables") or {}
        if name != "hermes" and MEDIA_STRICT_VAR in variables:
            errors.append("%s must not carry %s (hermes only, #4820 C2b)" % (name, MEDIA_STRICT_VAR))
        if name != "agent-worker" and HOSTED_STRICT_VAR in variables:
            errors.append("%s must not carry %s (agent-worker only, #4820 C2b)" % (name, HOSTED_STRICT_VAR))
    return errors


def github_errors(services: dict) -> list[str]:
    """ADR-0205 / #4221: the GitHub App key and public address reach api only, in the one shape the api accepts.

    The compose-twin rule already refuses a name a service's compose twin does not set, but it cannot see a service
    that is not in COMPOSE_TWINS, and it never asks api for the two variables at all (an api that lost them turns the
    whole GitHub surface into a silent 503/409). Every service of the catalog is walked here, by name and by
    `${{shared.GITHUB_APP_MASTER_KEY}}` reference."""
    errors: list[str] = []
    api_vars = services["api"].get("variables") or {}
    if api_vars.get(GITHUB_KEY_VAR) != GITHUB_KEY_VALUE:
        errors.append(
            "api %s %r must be %s (without it the GitHub routes answer 503)"
            % (GITHUB_KEY_VAR, api_vars.get(GITHUB_KEY_VAR), GITHUB_KEY_VALUE)
        )
    if api_vars.get(PUBLIC_BASE_VAR) != PUBLIC_BASE_VALUE:
        errors.append(
            "api %s %r must be %s (an absolute https origin on the one host the operator declared for this edge; "
            "the api ignores anything else and the GitHub App registration answers 409 public_address_required)"
            % (PUBLIC_BASE_VAR, api_vars.get(PUBLIC_BASE_VAR), PUBLIC_BASE_VALUE)
        )
    for name, svc in services.items():
        if name == "api":
            continue
        for var, value in (svc.get("variables") or {}).items():
            refs = [ref.strip() for ref in REF_RE.findall(str(value))]
            if var == GITHUB_KEY_VAR or "shared.%s" % GITHUB_KEY_VAR in refs:
                errors.append(
                    "%s %s: %s reaches api only (ADR-0205 D1: it opens the App's stored private key; "
                    "ADR-0203 D6-2: the Hermes service and the workers hold no oort secret)"
                    % (name, var, GITHUB_KEY_VAR)
                )
            if var == PUBLIC_BASE_VAR:
                errors.append(
                    "%s %s: %s belongs to api only (the address GitHub is told to call; no other service reads it)"
                    % (name, var, PUBLIC_BASE_VAR)
                )
    return errors


def collect_errors(
    catalog_path: Path,
    compose_path: Path,
    centrifugo_path: Path,
    keys_path: Path,
    readme_path: Path,
) -> list[str]:
    errors: list[str] = []
    try:
        data = json.loads(catalog_path.read_text())
    except json.JSONDecodeError as exc:
        return ["railway.json is not JSON: %s" % exc]
    compose = compose_path.read_text()
    centrifugo_json = json.loads(centrifugo_path.read_text())
    generator_keys = {
        line.strip() for line in keys_path.read_text().splitlines() if line.strip()
    }
    readme = readme_path.read_text()

    if "plugins" in data:
        errors.append(
            "postgres: plugins %r present — the Railway Postgres template has no "
            "pgvector; use the image service" % data.get("plugins")
        )
    services = data.get("services")
    if not isinstance(services, dict):
        return errors + ["services missing"]
    missing = [name for name in REQUIRED_SERVICES if name not in services]
    if missing:
        return errors + ["services missing: %s" % ",".join(missing)]

    def variables(name: str) -> dict:
        value = services[name].get("variables")
        return value if isinstance(value, dict) else {}

    # -- each service gets only what its compose twin gets -------------------
    compose_keys = {
        fname: compose_env_keys((compose_path.parent / fname).read_text())
        for fname in sorted({f for twins, _ in COMPOSE_TWINS.values() for f, _ in twins})
    }
    for name, (twins, extras) in COMPOSE_TWINS.items():
        allowed = set(extras)
        for fname, twin in twins:
            if twin not in compose_keys[fname]:
                errors.append("compose twin %s:%s not found" % (fname, twin))
            allowed |= compose_keys[fname].get(twin, set())
        outside = sorted(set(variables(name)) - allowed)
        if outside:
            errors.append(
                "%s variables outside its compose twin (%s): %s"
                % (name, ", ".join("%s:%s" % twin for twin in twins), ",".join(outside))
            )

    # -- infra/centrifugo.json holds only what the literals carry ------------
    settings = leaf_settings(centrifugo_json)
    if settings != KNOWN_CENTRIFUGO_SETTINGS:
        errors.append(
            "infra/centrifugo.json settings differ from what the Railway Centrifugo "
            "literals carry: new %s, gone %s"
            % (sorted(settings - KNOWN_CENTRIFUGO_SETTINGS), sorted(KNOWN_CENTRIFUGO_SETTINGS - settings))
        )

    # -- start commands (exec form replaces ENTRYPOINT) ---------------------
    for role in OORT_ROLES:
        command = services[role].get("startCommand")
        if split_start(command) == ["momo-rust-entrypoint", role]:
            continue
        commands = shell_commands(shell_script(command))
        last = commands[-1][1] if commands else []
        if last[:1] == ["exec"] and last[-2:] == ["momo-rust-entrypoint", role]:
            continue
        errors.append(
            "%s start command %r: must be `momo-rust-entrypoint %s` or "
            "`/bin/sh -c '… exec … momo-rust-entrypoint %s'` (Railway start "
            "command replaces the image ENTRYPOINT in exec form)"
            % (role, command, role, role)
        )

    # -- pre-deploy ----------------------------------------------------------
    errors.extend(predeploy_errors(services["api"]))

    # -- canonical command lists (whole list: operators, order, values) ------
    for name, canonical in CANONICAL_SHELL.items():
        diff = canonical_diff(shell_commands(shell_script(services[name].get("startCommand"))), canonical)
        if diff:
            errors.append(
                "%s start command is not the canonical command list (operators, order "
                "and values are fixed; only echo text may vary): %s" % (name, diff)
            )
    for name, argv in CANONICAL_ARGV.items():
        command = services[name].get("startCommand")
        got = split_start(command) if command is not None else None
        if got != argv:
            errors.append("%s start command is not the canonical command list: %r != %r" % (name, got, argv))
    pre = services["api"].get("preDeployCommand")
    pre_script = shell_script(pre[0]) if isinstance(pre, list) and len(pre) == 1 else None
    diff = canonical_diff(shell_commands(pre_script), CANONICAL_PREDEPLOY)
    if diff:
        errors.append(
            "api preDeploy is not the canonical command list (operators, order and "
            "values are fixed): %s" % diff
        )

    # -- api drive volume, UID, privilege drop, DSN --------------------------
    api_vars = variables("api")
    api_volume = services["api"].get("volume") or {}
    if api_volume.get("mountPath") != DRIVE_DIR:
        errors.append("api volume mountPath %r != %s" % (api_volume.get("mountPath"), DRIVE_DIR))
    if api_vars.get("RAILWAY_RUN_UID") != "0":
        errors.append("api RAILWAY_RUN_UID must be \"0\" (volumes mount root-owned)")
    errors.extend(api_start_errors(services["api"], api_vars))
    if api_vars.get("DATABASE_URL") != "${{shared.MOMO_APP_DATABASE_URL}}":
        errors.append(
            "api DATABASE_URL %r must be ${{shared.MOMO_APP_DATABASE_URL}} "
            "(momo_app, NOBYPASSRLS)" % api_vars.get("DATABASE_URL")
        )
    if api_vars.get("HOST") != "0.0.0.0" or api_vars.get("PORT") != str(
        services["api"].get("port")
    ):
        errors.append("api HOST/PORT must be 0.0.0.0 / the api port")

    cent = services["centrifugo"]
    cent_url = "http://%s:%s/api" % (cent.get("privateHostname"), cent.get("port"))
    for name in ("api", "relay"):
        if variables(name).get("CENT_API_URL") != cent_url:
            errors.append(
                "%s CENT_API_URL %r != %s" % (name, variables(name).get("CENT_API_URL"), cent_url)
            )

    # -- Centrifugo native names + infra/centrifugo.json parity --------------
    errors.extend(centrifugo_errors(services, centrifugo_json, compose))

    # -- same-server Hermes ---------------------------------------------------
    errors.extend(hermes_errors(services, compose, compose_path.parents[2]))

    # -- GitHub App key + public address: api only (ADR-0205, #4221) ----------
    errors.extend(github_errors(services))
    errors.extend(self_media_errors(services))
    errors.extend(api_internal_errors(services))
    errors.extend(hosted_media_strict_errors(services))

    # -- Postgres image service ----------------------------------------------
    pg = services["postgres"]
    want_pg_image = compose_image(compose, "postgres")
    if not want_pg_image or pg.get("image") != want_pg_image:
        errors.append("postgres image %r != compose %r" % (pg.get("image"), want_pg_image))
    if (pg.get("volume") or {}).get("mountPath") != PG_DATA_MOUNT:
        errors.append("postgres volume mountPath %r != %s" % ((pg.get("volume") or {}).get("mountPath"), PG_DATA_MOUNT))
    if pg.get("startCommand") is not None:
        errors.append("postgres startCommand must stay the image default (null)")
    for name in ("POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"):
        if variables("postgres").get(name) != "${{shared.%s}}" % name:
            errors.append("postgres %s must be ${{shared.%s}}" % (name, name))
    worker_url = "postgres://momo_worker:${{shared.WORKER_POSTGRES_PASSWORD}}@%s:%s/${{shared.POSTGRES_DB}}" % (
        pg.get("privateHostname"),
        pg.get("port"),
    )
    if variables("agent-worker").get("WORKER_DATABASE_URL") != worker_url:
        errors.append(
            "agent-worker WORKER_DATABASE_URL %r != %r"
            % (variables("agent-worker").get("WORKER_DATABASE_URL"), worker_url)
        )

    # -- push-relay / notifier -----------------------------------------------
    relay_svc = services["push-relay"]
    relay_vars = variables("push-relay")
    for name, want in (
        ("MOMO_APNS_ENV", "production"),
        ("MOMO_APNS_SENDER", "live"),
        ("MOMO_PUSH_RELAY_HOST", "0.0.0.0"),
        ("MOMO_PUSH_RELAY_PORT", str(relay_svc.get("port"))),
    ):
        if relay_vars.get(name) != want:
            errors.append("push-relay %s %r != %r" % (name, relay_vars.get(name), want))
    notifier_vars = variables("notifier")
    push_url = "http://%s:%s/v1/push" % (relay_svc.get("privateHostname"), relay_svc.get("port"))
    if notifier_vars.get("PUSH_RELAY_URL") != push_url:
        errors.append("notifier PUSH_RELAY_URL %r != %s" % (notifier_vars.get("PUSH_RELAY_URL"), push_url))
    if notifier_vars.get("MOMO_PUSH_NOTIFIER_ENABLED") != "1":
        errors.append("notifier MOMO_PUSH_NOTIFIER_ENABLED must be \"1\"")
    server_id = notifier_vars.get("PUSH_RELAY_SERVER_ID") or ""
    if not server_id or '"%s"' % server_id not in str(relay_vars.get("MOMO_RELAY_SERVERS")):
        errors.append("notifier PUSH_RELAY_SERVER_ID %r is not a key of push-relay MOMO_RELAY_SERVERS" % server_id)
    for service, key_var, path_var in PUSH_KEYS:
        errors.extend(push_start_errors(service, services[service], key_var, path_var))
        if not str(variables(service).get(key_var, "")).startswith("<sealed:"):
            errors.append("%s %s must be a sealed variable on that service" % (service, key_var))

    # -- webhook-sender key (#2066) ------------------------------------------
    sender_key = variables("webhook-sender").get("OUTBOUND_WEBHOOK_MASTER_KEY")
    if sender_key is None or sender_key != api_vars.get("OUTBOUND_WEBHOOK_MASTER_KEY"):
        errors.append(
            "webhook-sender OUTBOUND_WEBHOOK_MASTER_KEY %r must be the same "
            "reference as api (#2066: no JWT_HMAC fallback, no compose `:?`)"
            % (sender_key,)
        )

    # -- references, placeholders, exposure ----------------------------------
    hand_rows_needed: set[tuple[str, str]] = set()
    for name, svc in services.items():
        if svc.get("public") is True and name != "caddy":
            errors.append("%s must not be public (caddy is the only edge)" % name)
        for var, value in (svc.get("variables") or {}).items():
            value = str(value)
            if value.startswith(PLACEHOLDER_PREFIXES):
                if value.startswith("<sealed:") and name not in SEALED_SERVICES:
                    errors.append("%s %s: sealed values belong only to push-relay/notifier" % (name, var))
                hand_rows_needed.add((name, var))
                continue
            refs = REF_RE.findall(value)
            for ref in refs:
                shared = SHARED_RE.match(ref)
                if not shared:
                    errors.append("%s %s: reference ${{%s}} is not ${{shared.KEY}}" % (name, var, ref))
                elif shared.group(1) not in generator_keys and shared.group(1) not in OPERATOR_SHARED:
                    errors.append(
                        "%s %s: ${{shared.%s}} is not a key the generator writes"
                        % (name, var, shared.group(1))
                    )
            identity = value == "${{shared.%s}}" % var
            if refs and not identity:
                hand_rows_needed.add((name, var))
            elif not refs and var in HAND_LITERALS:
                hand_rows_needed.add((name, var))
    if services["caddy"].get("public") is not True:
        errors.append("caddy must be the public service")

    # -- README hand-mapped table --------------------------------------------
    rows = readme_rows(readme)
    missing_rows = sorted(hand_rows_needed - rows)
    if missing_rows:
        errors.append(
            "README hand-mapped table missing rows: %s"
            % ", ".join("%s %s" % row for row in missing_rows)
        )
    hand_table = {row for row in rows if row[0] in ("api", "relay", "webhook-sender", "agent-worker", "centrifugo", "caddy")}
    if len(hand_table) < 9:
        errors.append("README hand-mapped table has %d app/centrifugo/caddy rows (< 9)" % len(hand_table))
    return errors


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(text: str, old: str, new: str, kind: str) -> str:
    if text.count(old) != 1:
        raise SystemExit("mutation %s: %r found %d times (want 1)" % (kind, old, text.count(old)))
    return text.replace(old, new, 1)


def mutate_catalog(kind: str, data: dict) -> None:
    services = data["services"]
    api, relay_push, notifier = services["api"], services["push-relay"], services["notifier"]
    cent_vars = services["centrifugo"]["variables"]
    if kind == "start-bare-api":
        api["startCommand"] = "api"
    elif kind == "start-bare-relay":
        services["relay"]["startCommand"] = "relay"
    elif kind == "start-no-exec":
        notifier["startCommand"] = replace_once(
            notifier["startCommand"], "exec momo-rust-entrypoint notifier", "momo-rust-entrypoint notifier; true", kind
        )
    elif kind == "predeploy-raw":
        api["preDeployCommand"] = [shell_script(api["preDeployCommand"][0])]
    elif kind == "predeploy-no-privdrop":
        api["preDeployCommand"] = [
            replace_once(
                api["preDeployCommand"][0],
                'setpriv --reuid=momo --regid=momo --init-groups env HOME=/home/momo "$@"',
                '"$@"',
                kind,
            )
        ]
    elif kind == "centrifugo-origins-dropped":
        del cent_vars["CENTRIFUGO_CLIENT_ALLOWED_ORIGINS"]
    elif kind == "centrifugo-compose-name":
        del cent_vars["CENTRIFUGO_HTTP_API_KEY"]
        cent_vars["CENT_API_KEY"] = "${{shared.CENT_API_KEY}}"
    elif kind == "centrifugo-namespaces-drift":
        cent_vars["CENTRIFUGO_CHANNEL_NAMESPACES"] = cent_vars["CENTRIFUGO_CHANNEL_NAMESPACES"].replace(
            '"history_size":300', '"history_size":30', 1
        )
    elif kind == "centrifugo-online-leaks":
        # the roll-call namespace gains a client-readable presence table
        cent_vars["CENTRIFUGO_CHANNEL_NAMESPACES"] = replace_once(
            cent_vars["CENTRIFUGO_CHANNEL_NAMESPACES"],
            '"name":"online","presence":true,',
            '"name":"online","presence":true,"allow_presence_for_subscriber":true,',
            kind,
        )
    elif kind == "centrifugo-endpoint-drift":
        # the compose host instead of the Railway private one (built, not typed:
        # a literal compose address is a known gitleaks false positive)
        cent_vars["CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT"] = "http://%s:%d/v1/centrifugo/subscribe" % ("api", 8080)
    elif kind == "centrifugo-connection-meta-off":
        cent_vars["CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_INCLUDE_CONNECTION_META"] = "false"
    elif kind == "centrifugo-subscription-token-off":
        cent_vars["CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ENABLED"] = "false"
    elif kind == "api-volume-missing":
        del api["volume"]
    elif kind == "api-run-uid-missing":
        del api["variables"]["RAILWAY_RUN_UID"]
    elif kind == "api-keeps-superuser":
        api["startCommand"] = replace_once(api["startCommand"], "-u MIGRATE_DATABASE_URL ", "", kind)
    elif kind == "api-keeps-postgres-password":
        api["startCommand"] = replace_once(api["startCommand"], "-u POSTGRES_PASSWORD ", "", kind)
    elif kind == "api-no-setpriv":
        api["startCommand"] = replace_once(
            api["startCommand"], "exec setpriv --reuid=momo --regid=momo --init-groups env", "exec env", kind
        )
    elif kind == "api-exec-not-last":
        api["startCommand"] = replace_once(api["startCommand"], "momo-rust-entrypoint api'", "momo-rust-entrypoint api; true'", kind)
    elif kind == "api-chown-in-echo":
        api["startCommand"] = replace_once(api["startCommand"], 'chown -R momo:momo "$d";', 'echo "chown -R momo:momo $d";', kind)
    elif kind == "api-chown-not-recursive":
        api["startCommand"] = replace_once(api["startCommand"], "chown -R momo:momo", "chown momo:momo", kind)
    elif kind == "api-no-root-guard":
        api["startCommand"] = re.sub(r'\[ "\$\(id -u\)" = 0 \] \|\| \{ echo "[^"]*" >&2; exit 78; \}; ', "", api["startCommand"], count=1)
    elif kind == "api-dsn-superuser":
        api["variables"]["DATABASE_URL"] = "${{shared.MIGRATE_DATABASE_URL}}"
    elif kind == "postgres-plugin":
        data["plugins"] = ["postgresql"]
    elif kind == "postgres-image-drift":
        services["postgres"]["image"] = "postgres:18"
    elif kind == "postgres-volume-missing":
        del services["postgres"]["volume"]
    elif kind == "worker-url-drift":
        services["agent-worker"]["variables"]["WORKER_DATABASE_URL"] = services["agent-worker"][
            "variables"
        ]["WORKER_DATABASE_URL"].replace("postgres.railway.internal", "postgres")
    elif kind == "push-sandbox":
        relay_push["variables"]["MOMO_APNS_ENV"] = "sandbox"
    elif kind == "push-key-on-disk":
        relay_push["startCommand"] = replace_once(relay_push["startCommand"], "k=/dev/shm/", "k=/tmp/", kind)
    elif kind == "push-umask-after-write":
        cmd = replace_once(relay_push["startCommand"], "umask 077; ", "", kind)
        relay_push["startCommand"] = replace_once(cmd, 'base64 -d >"$k"; ', 'base64 -d >"$k"; umask 077; ', kind)
    elif kind == "push-no-shm-guard":
        relay_push["startCommand"] = re.sub(r"\[ -d /dev/shm \].*?exit 78; \}; ", "", relay_push["startCommand"], count=1)
    elif kind == "push-guard-no-tmpfs":
        relay_push["startCommand"] = replace_once(
            relay_push["startCommand"], ' && [ "$(stat -f -c %T /dev/shm)" = tmpfs ]', "", kind
        )
    elif kind == "notifier-no-unset":
        notifier["startCommand"] = replace_once(notifier["startCommand"], "unset RELAY_SIGNING_KEY_B64; ", "", kind)
    elif kind == "sealed-shared":
        relay_push["variables"]["APNS_KEY_P8_B64"] = "${{shared.APNS_KEY_P8_B64}}"
    elif kind == "sender-key-dropped":
        del services["webhook-sender"]["variables"]["OUTBOUND_WEBHOOK_MASTER_KEY"]
    elif kind == "unknown-shared-ref":
        api["variables"]["JWT_HMAC"] = "${{shared.JWT_HMAC_TYPO}}"
    elif kind == "api-public":
        api["public"] = True
    elif kind == "push-set-x":  # G1: xtrace prints the base64 key into the logs
        relay_push["startCommand"] = replace_once(relay_push["startCommand"], "set -eu; ", "set -eu; set -x; ", kind)
    elif kind == "push-key-path-escape":  # G2: /dev/shm/../../tmp is on disk
        relay_push["startCommand"] = replace_once(
            relay_push["startCommand"], "k=/dev/shm/apns-key.p8", "k=/dev/shm/../../tmp/apns-key.p8", kind
        )
    elif kind == "push-unset-conditional":  # G3: the key stays in the server env
        relay_push["startCommand"] = replace_once(
            relay_push["startCommand"], '[ -s "$k" ]; unset APNS_KEY_P8_B64;', '[ -s "$k" ] || unset APNS_KEY_P8_B64;', kind
        )
    elif kind == "notifier-umask-skipped":  # G4: umask never runs
        notifier["startCommand"] = replace_once(notifier["startCommand"], "umask 077; ", "true || umask 077; ", kind)
    elif kind == "api-chown-skipped":  # G5: chown never runs
        api["startCommand"] = replace_once(api["startCommand"], 'mkdir -p "$d"; chown -R', 'mkdir -p "$d" || chown -R', kind)
    elif kind == "push-key-reassigned":  # G6: a second k= writes the key to disk
        relay_push["startCommand"] = replace_once(
            relay_push["startCommand"], "k=/dev/shm/apns-key.p8; ", "k=/dev/shm/apns-key.p8; k=/var/tmp/apns-key.p8; ", kind
        )
    elif kind == "predeploy-run-redefined":  # G7: run() redefined without the drop
        api["preDeployCommand"] = [
            replace_once(
                api["preDeployCommand"][0],
                "run env DATABASE_URL=\"$MIGRATE_DATABASE_URL\" MOMO_RUNTIME_ROLE_PROVISION=1",
                "run() { \"$@\"; }; run env DATABASE_URL=\"$MIGRATE_DATABASE_URL\" MOMO_RUNTIME_ROLE_PROVISION=1",
                kind,
            )
        ]
    elif kind == "relay-as-root":  # G8
        services["relay"]["variables"]["RAILWAY_RUN_UID"] = "0"
    elif kind == "relay-superuser-dsn":  # G9
        services["relay"]["variables"]["MIGRATE_DATABASE_URL"] = "${{shared.MIGRATE_DATABASE_URL}}"
    elif kind == "sender-cent-api-key":  # G10
        services["webhook-sender"]["variables"]["CENT_API_KEY"] = "${{shared.CENT_API_KEY}}"
    elif kind == "hermes-config-hash-dropped":  # #4935: one accepted config no longer in the start command's list
        command = services["hermes"]["startCommand"]
        listed = re.search(r"grep -qxF((?: -e [0-9a-f]{64})+)", command)
        if listed is None:
            raise SystemExit("mutation %s: no config hash list in the hermes start command" % kind)
        last = re.findall(r" -e [0-9a-f]{64}", listed.group(1))[-1]
        services["hermes"]["startCommand"] = command.replace(listed.group(1), listed.group(1)[: -len(last)], 1)
    elif kind == "hermes-config-hash-foreign":  # #4935: a config nobody rebuilds from the repo's pieces is accepted
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"], "grep -qxF -e ", "grep -qxF -e " + "0" * 64 + " -e ", kind
        )
    elif kind == "hermes-config-substring":  # #4935: whole-line match weakened to a substring match
        services["hermes"]["startCommand"] = replace_once(services["hermes"]["startCommand"], "grep -qxF -e ", "grep -qF -e ", kind)
    elif kind == "hermes-config-check-dropped":  # #4935: the config is not checked at all
        services["hermes"]["startCommand"] = re.sub(
            r"sha256sum /opt/data/config\.yaml \| cut -c1-64 \| grep -qxF(?: -e [0-9a-f]{64})+ \|\| \{ echo \"[^\"]*\" >&2; exit 78; \}; ",
            "", services["hermes"]["startCommand"],
        )
    elif kind == "hermes-guard-sha-stale":  # #4820 review: the pinned guard bytes no longer match the plugin file
        command = services["hermes"]["startCommand"]
        stale = re.search(r"echo \"([0-9a-f]{64})  /opt/data/plugins/oort-image-guard/__init__\.py", command)
        if stale is None:
            raise SystemExit("mutation %s: no guard sha in the hermes start command" % kind)
        services["hermes"]["startCommand"] = command.replace(stale.group(1), "0" * 64, 1)
    elif kind == "hermes-no-guard-install":  # the guard is not decoded: the gate would refuse, but nothing may assume that
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"],
            'printf %s "$HERMES_IMAGE_GUARD_B64" | base64 -d > /opt/data/plugins/oort-image-guard/__init__.py; ',
            "",
            kind,
        )
    elif kind == "hermes-no-gate":  # #4072: the lock gate line removed
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"],
            "/opt/hermes/.venv/bin/python /tmp/lockgate.py gate /opt/data/config.yaml; ",
            "",
            kind,
        )
    elif kind == "hermes-gate-nonfatal":
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"],
            "gate /opt/data/config.yaml;",
            "gate /opt/data/config.yaml || true;",
            kind,
        )
    elif kind == "hermes-public":
        services["hermes"]["public"] = True
    elif kind == "hermes-public-string":
        services["hermes"]["public"] = "true"
    elif kind == "hermes-extra-key":
        services["hermes"]["domain"] = "hermes.example.test"
    elif kind == "hermes-gate-sha-stale":  # the pinned gate bytes no longer match infra/hermes/lockgate.py
        command = services["hermes"]["startCommand"]
        stale = re.search(r"echo \"([0-9a-f]{64})  /tmp/lockgate\.py", command)
        if stale is None:
            raise SystemExit("mutation %s: no gate sha in the hermes start command" % kind)
        services["hermes"]["startCommand"] = command.replace(stale.group(1), "0" * 64, 1)
    elif kind == "hermes-no-sha-check":  # the sha256sum -c steps removed: an empty decoded gate would pass
        services["hermes"]["startCommand"] = re.sub(
            r'echo "[0-9a-f]{64}  [^"]+" \| sha256sum -c -; ', "", services["hermes"]["startCommand"]
        )
    elif kind == "hermes-no-gate":  # #4072: the lock gate line removed
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"],
            "/opt/hermes/.venv/bin/python /tmp/lockgate.py gate /opt/data/config.yaml; ",
            "",
            kind,
        )
    elif kind == "hermes-gate-nonfatal":
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"],
            "gate /opt/data/config.yaml;",
            "gate /opt/data/config.yaml || true;",
            kind,
        )
    elif kind == "hermes-public":
        services["hermes"]["public"] = True
    elif kind == "hermes-public-string":
        services["hermes"]["public"] = "true"
    elif kind == "hermes-extra-key":
        services["hermes"]["domain"] = "hermes.example.test"
    elif kind == "hermes-gate-sha-stale":
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"], "/tmp/lockgate.py\"", "/tmp/lockgate.py\"", kind
        ).replace(re.search(r"echo \"([0-9a-f]{64})  /tmp/lockgate.py", services["hermes"]["startCommand"]).group(1), "0" * 64, 1)
    elif kind == "hermes-no-sha-check":
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"], "; sha256sum -c -", "", kind
        ) if False else re.sub(r" \| sha256sum -c -;", ";", services["hermes"]["startCommand"])
    elif kind == "hermes-image-floating":
        services["hermes"]["image"] = "nousresearch/hermes-agent:latest"
    elif kind == "hermes-oort-secret":
        services["hermes"]["variables"]["PROVIDER_LINK_MASTER_KEY"] = "${{shared.PROVIDER_LINK_MASTER_KEY}}"
    elif kind == "hermes-cors-open":
        services["hermes"]["variables"]["API_SERVER_CORS_ORIGINS"] = "*"
    elif kind == "hermes-key-literal":
        services["hermes"]["variables"]["API_SERVER_KEY"] = "dev-insecure-hermes-bearer"
    elif kind == "api-relay-key-chat-key":  # #4079: api reads the relay key from the chat key
        api["variables"]["HERMES_LOGIN_RELAY_KEY"] = "${{shared.HERMES_API_KEY}}"
    elif kind == "api-relay-url-wrong":
        api["variables"]["HERMES_LOGIN_RELAY_URL"] = "http://hermes.railway.internal:8642"
    elif kind == "worker-relay-key":
        services["agent-worker"]["variables"]["HERMES_LOGIN_RELAY_KEY"] = "${{shared.HERMES_LOGIN_RELAY_KEY}}"
    elif kind == "hermes-relay-key-chat-key":  # #4078: the relay key reuses the chat key
        services["hermes"]["variables"]["HERMES_LOGIN_RELAY_KEY"] = "${{shared.HERMES_API_KEY}}"
    elif kind == "hermes-relay-stale-sha":  # a stale sidecar would be a stale security boundary
        command = services["hermes"]["startCommand"]
        stale = re.search(r"echo \"([0-9a-f]{64})  /tmp/login_relay\.py", command)
        if stale is None:
            raise SystemExit("mutation %s: no relay sha in the hermes start command" % kind)
        services["hermes"]["startCommand"] = command.replace(stale.group(1), "0" * 64, 1)
    elif kind == "hermes-relay-key-not-unset":  # the gateway would inherit the relay key
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"], "unset HERMES_LOGIN_RELAY_KEY HERMES_LOGIN_RELAY_B64 HERMES_LOGIN_PROBE_B64; ", "", kind
        )
    elif kind == "hermes-relay-unconditional":  # the sidecar would start without a key
        services["hermes"]["startCommand"] = replace_once(
            services["hermes"]["startCommand"], '[ -z "${HERMES_LOGIN_RELAY_KEY:-}" ] || { ', "{ ", kind
        )
    elif kind == "api-hermes-wildcard-host":
        api["variables"]["AGENT_PROVIDER_LOCAL_HOSTS"] = "*.railway.internal"
    elif kind == "api-hermes-attest-dropped":
        del api["variables"]["OORT_COHOSTED_AGENT_TOOLS_LOCKED"]
    elif kind == "worker-hermes-attest":
        services["agent-worker"]["variables"]["OORT_COHOSTED_AGENT_TOOLS_LOCKED"] = "1"
    elif kind == "api-github-key-dropped":  # #4221: api without the key: the GitHub routes answer 503
        del api["variables"][GITHUB_KEY_VAR]
    elif kind == "worker-github-key":  # ADR-0203 D6-2: a worker must not open the App's stored key
        services["agent-worker"]["variables"][GITHUB_KEY_VAR] = GITHUB_KEY_VALUE
    elif kind == "hermes-github-key":  # by name only: the value is not a reference, so only the name can give it away
        services["hermes"]["variables"][GITHUB_KEY_VAR] = "<operator: the api's GITHUB_APP_MASTER_KEY>"
    elif kind == "worker-github-key-renamed":  # the same shared secret under a name no compose twin lists
        services["agent-worker"]["variables"]["GH_APP_SEAL"] = GITHUB_KEY_VALUE
    elif kind == "extra-service-github-key":  # a service COMPOSE_TWINS does not know: only the named rule can see it
        services["github-worker"] = {
            "public": False,
            "image": services["relay"]["image"],
            "startCommand": "momo-rust-entrypoint relay",
            "variables": {GITHUB_KEY_VAR: GITHUB_KEY_VALUE},
        }
    elif kind == "api-public-base-dropped":  # #4221: api without the address answers 409 public_address_required
        del api["variables"][PUBLIC_BASE_VAR]
    elif kind == "api-public-base-http":  # the api ignores anything but an absolute https origin
        api["variables"][PUBLIC_BASE_VAR] = "http://${{shared.OORT_SITE_ADDRESS}}"
    elif kind == "api-public-base-wrong-host":  # starts with https:// and has a host, so the api would accept it
        api["variables"][PUBLIC_BASE_VAR] = "https://${{shared.MOMO_CENTRIFUGO_WS_URL}}"
    elif kind == "worker-public-base":
        services["agent-worker"]["variables"][PUBLIC_BASE_VAR] = PUBLIC_BASE_VALUE
    elif kind == "worker-self-media-dropped":
        del services["agent-worker"]["variables"][SELF_MEDIA_VAR]
    elif kind == "hermes-self-media-wrong-host":
        services["hermes"]["variables"][SELF_MEDIA_VAR] = "https://${{shared.MOMO_CENTRIFUGO_WS_URL}}"
    elif kind == "relay-self-media-origin":
        services["relay"]["variables"][SELF_MEDIA_VAR] = PUBLIC_BASE_VALUE
    elif kind == "worker-api-internal-dropped":  # the worker could not read a requester's picture on Railway
        del services["agent-worker"]["variables"][API_INTERNAL_VAR]
    elif kind == "worker-api-internal-wrong-port":  # not the port the api listens on
        services["agent-worker"]["variables"][API_INTERNAL_VAR] = "http://api.railway.internal:3000"
    elif kind == "worker-api-internal-public-edge":  # the single-use credential would cross the public edge
        services["agent-worker"]["variables"][API_INTERNAL_VAR] = PUBLIC_BASE_VALUE
    elif kind == "relay-api-internal-origin":
        services["relay"]["variables"][API_INTERNAL_VAR] = "http://api.railway.internal:8080"
    elif kind == "worker-hosted-strict-dropped":
        del services["agent-worker"]["variables"][HOSTED_STRICT_VAR]
    elif kind == "worker-hosted-strict-attested":  # the template would attest strict media delivery for the operator
        services["agent-worker"]["variables"][HOSTED_STRICT_VAR] = "1"
    elif kind == "hermes-media-strict-dropped":  # a Hermes the lock gate would refuse to start
        del services["hermes"]["variables"][MEDIA_STRICT_VAR]
    elif kind == "hermes-media-strict-wrong":  # Hermes reads `true` as strict, the gate takes only an exact 1
        services["hermes"]["variables"][MEDIA_STRICT_VAR] = "true"
    elif kind == "relay-hosted-strict":
        services["relay"]["variables"][HOSTED_STRICT_VAR] = "1"
    else:
        raise SystemExit("unknown catalog mutation %s" % kind)


CATALOG_MUTATIONS: tuple[tuple[str, str], ...] = (
    ("start-bare-api", "must be `momo-rust-entrypoint api`"),
    ("start-bare-relay", "must be `momo-rust-entrypoint relay`"),
    ("start-no-exec", "must be `momo-rust-entrypoint notifier`"),
    ("predeploy-raw", "api preDeploy must be one"),
    ("predeploy-no-privdrop", "api preDeploy must drop to momo when root"),
    ("centrifugo-origins-dropped", "centrifugo CENTRIFUGO_CLIENT_ALLOWED_ORIGINS"),
    ("centrifugo-compose-name", "centrifugo CENTRIFUGO_HTTP_API_KEY"),
    ("centrifugo-namespaces-drift", "centrifugo CENTRIFUGO_CHANNEL_NAMESPACES != infra/centrifugo.json"),
    ("centrifugo-online-leaks", "centrifugo CENTRIFUGO_CHANNEL_NAMESPACES online namespace must be presence-only"),
    ("centrifugo-endpoint-drift", "centrifugo CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT"),
    ("centrifugo-connection-meta-off", "centrifugo CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_INCLUDE_CONNECTION_META"),
    ("centrifugo-subscription-token-off", "centrifugo CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ENABLED"),
    ("api-volume-missing", "api volume mountPath"),
    ("api-run-uid-missing", "api RAILWAY_RUN_UID"),
    ("api-keeps-superuser", "keeps pre-deploy secrets in the server env (env -u missing): MIGRATE_DATABASE_URL"),
    ("api-keeps-postgres-password", "keeps pre-deploy secrets in the server env (env -u missing): POSTGRES_PASSWORD"),
    ("api-no-setpriv", "api start command must end with `exec setpriv"),
    ("api-exec-not-last", "api start command must end with `exec setpriv"),
    ("api-chown-in-echo", "api start command must chown -R momo:momo"),
    ("api-chown-not-recursive", "api start command must chown -R momo:momo"),
    ("api-no-root-guard", "api start command must refuse without root"),
    ("api-dsn-superuser", "api DATABASE_URL"),
    ("postgres-plugin", "postgres: plugins"),
    ("postgres-image-drift", "postgres image"),
    ("postgres-volume-missing", "postgres volume mountPath"),
    ("worker-url-drift", "agent-worker WORKER_DATABASE_URL"),
    ("push-sandbox", "push-relay MOMO_APNS_ENV"),
    ("push-key-on-disk", "push-relay start command: key file must be k=/dev/shm/"),
    ("push-umask-after-write", "push-relay start command: umask 077 must come before the key is written"),
    ("push-no-shm-guard", "push-relay start command: /dev/shm must be checked as a writable tmpfs"),
    ("push-guard-no-tmpfs", "push-relay start command: /dev/shm must be checked as a writable tmpfs"),
    ("notifier-no-unset", "notifier start command: RELAY_SIGNING_KEY_B64 must be unset before exec"),
    ("sealed-shared", "push-relay APNS_KEY_P8_B64 must be a sealed variable"),
    ("sender-key-dropped", "webhook-sender OUTBOUND_WEBHOOK_MASTER_KEY"),
    ("unknown-shared-ref", "JWT_HMAC_TYPO"),
    ("api-public", "api must not be public"),
    ("push-set-x", "push-relay start command is not the canonical command list"),
    ("push-key-path-escape", "push-relay start command is not the canonical command list"),
    ("push-unset-conditional", "push-relay start command is not the canonical command list"),
    ("notifier-umask-skipped", "notifier start command is not the canonical command list"),
    ("api-chown-skipped", "api start command is not the canonical command list"),
    ("push-key-reassigned", "push-relay start command is not the canonical command list"),
    ("predeploy-run-redefined", "api preDeploy is not the canonical command list"),
    ("relay-as-root", "relay variables outside its compose twin"),
    ("relay-superuser-dsn", "relay variables outside its compose twin"),
    ("sender-cent-api-key", "webhook-sender variables outside its compose twin"),
    ("hermes-no-gate", "hermes start command is not the canonical command list"),
    ("hermes-gate-nonfatal", "hermes start command is not the canonical command list"),
    ("hermes-public", "hermes must not be public"),
    ("hermes-public-string", "hermes public must be exactly false"),
    ("hermes-extra-key", "hermes has keys the catalog does not review"),
    ("hermes-gate-sha-stale", "hermes start command is not the canonical command list"),
    ("hermes-no-sha-check", "hermes start command is not the canonical command list"),
    ("hermes-guard-sha-stale", "hermes start command is not the canonical command list"),
    ("hermes-config-hash-dropped", "hermes start command is not the canonical command list"),
    ("hermes-config-hash-foreign", "hermes start command is not the canonical command list"),
    ("hermes-config-substring", "hermes start command is not the canonical command list"),
    ("hermes-config-check-dropped", "hermes start command is not the canonical command list"),
    ("hermes-no-guard-install", "hermes start command is not the canonical command list"),
    ("hermes-image-floating", "hermes image"),
    ("hermes-oort-secret", "hermes variables outside its compose twin"),
    ("hermes-cors-open", "hermes variables outside its compose twin"),
    ("hermes-key-literal", "hermes API_SERVER_KEY"),
    ("api-relay-key-chat-key", "api HERMES_LOGIN_RELAY_KEY"),
    ("api-relay-url-wrong", "api HERMES_LOGIN_RELAY_URL"),
    ("worker-relay-key", "agent-worker"),
    ("hermes-relay-key-chat-key", "hermes HERMES_LOGIN_RELAY_KEY"),
    ("hermes-relay-stale-sha", "hermes start command is not the canonical command list"),
    ("hermes-relay-key-not-unset", "hermes start command is not the canonical command list"),
    ("hermes-relay-unconditional", "hermes start command is not the canonical command list"),
    ("api-hermes-wildcard-host", "api AGENT_PROVIDER_LOCAL_HOSTS"),
    ("api-hermes-attest-dropped", "api OORT_COHOSTED_AGENT_TOOLS_LOCKED"),
    ("worker-hermes-attest", "agent-worker variables outside its compose twin"),
    ("api-github-key-dropped", "api GITHUB_APP_MASTER_KEY"),
    ("worker-github-key", "GITHUB_APP_MASTER_KEY reaches api only"),
    ("hermes-github-key", "GITHUB_APP_MASTER_KEY reaches api only"),
    ("worker-github-key-renamed", "GITHUB_APP_MASTER_KEY reaches api only"),
    ("extra-service-github-key", "GITHUB_APP_MASTER_KEY reaches api only"),
    ("api-public-base-dropped", "api MOMO_PUBLIC_BASE_URL"),
    ("api-public-base-http", "api MOMO_PUBLIC_BASE_URL"),
    ("api-public-base-wrong-host", "api MOMO_PUBLIC_BASE_URL"),
    ("worker-public-base", "MOMO_PUBLIC_BASE_URL belongs to api only"),
    ("worker-self-media-dropped", "agent-worker OORT_SELF_MEDIA_ORIGIN"),
    ("hermes-self-media-wrong-host", "hermes OORT_SELF_MEDIA_ORIGIN"),
    ("relay-self-media-origin", "relay must not carry OORT_SELF_MEDIA_ORIGIN"),
    ("worker-api-internal-dropped", "agent-worker OORT_API_INTERNAL_ORIGIN"),
    ("worker-api-internal-wrong-port", "agent-worker OORT_API_INTERNAL_ORIGIN"),
    ("worker-api-internal-public-edge", "agent-worker OORT_API_INTERNAL_ORIGIN"),
    ("relay-api-internal-origin", "relay must not carry OORT_API_INTERNAL_ORIGIN"),
    ("worker-hosted-strict-dropped", "agent-worker OORT_HOSTED_MEDIA_STRICT"),
    ("worker-hosted-strict-attested", "agent-worker OORT_HOSTED_MEDIA_STRICT"),
    ("hermes-media-strict-dropped", "hermes HERMES_MEDIA_DELIVERY_STRICT"),
    ("hermes-media-strict-wrong", "hermes HERMES_MEDIA_DELIVERY_STRICT"),
    ("relay-hosted-strict", "relay must not carry OORT_HOSTED_MEDIA_STRICT"),
)


def prove_mutations(
    catalog_path: Path,
    compose_path: Path,
    centrifugo_path: Path,
    keys_path: Path,
    readme_path: Path,
) -> None:
    origin = (file_digest(catalog_path), file_digest(readme_path), file_digest(centrifugo_path))
    base = json.loads(catalog_path.read_text())
    with tempfile.TemporaryDirectory(prefix="oort-railway-catalog.") as tmp:
        scratch = Path(tmp)
        for kind, needle in CATALOG_MUTATIONS:
            data = copy.deepcopy(base)
            mutate_catalog(kind, data)
            if data == base:
                raise SystemExit("mutation %s changed nothing — it proves nothing" % kind)
            dest = scratch / ("%s.json" % kind)
            dest.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            errors = collect_errors(dest, compose_path, centrifugo_path, keys_path, readme_path)
            joined = "; ".join(errors)
            if not errors:
                raise SystemExit("mutation %s still passed — rule is not load-bearing" % kind)
            if needle not in joined:
                raise SystemExit("mutation %s failed without naming its rule (%s): %s" % (kind, needle, joined))
            print("mutation %s RED (%s)" % (kind, needle))
        # README: drop one row → the table no longer covers a value the operator must type. The first row is the
        # long-standing one; the next two are the hosted door's halves (#4820 C2b 3부); the last is #4934's.
        readme = readme_path.read_text()
        for service, var, label in (
            ("agent-worker", "WORKER_DATABASE_URL", "readme-row-missing"),
            ("agent-worker", HOSTED_STRICT_VAR, "readme-row-missing-hosted-strict"),
            ("agent-worker", API_INTERNAL_VAR, "readme-row-missing-api-internal"),
            ("hermes", MEDIA_STRICT_VAR, "readme-row-missing-media-strict"),
        ):
            kept = [
                line
                for line in readme.splitlines(True)
                if not re.match(r"^\|\s*%s\s*\|\s*`%s`" % (re.escape(service), re.escape(var)), line)
            ]
            if len(kept) == len(readme.splitlines(True)):
                raise SystemExit("README has no %s %s row to drop" % (service, var))
            dest_readme = scratch / ("README-%s.md" % label)
            dest_readme.write_text("".join(kept))
            errors = collect_errors(catalog_path, compose_path, centrifugo_path, keys_path, dest_readme)
            if not any("%s %s" % (service, var) in error for error in errors):
                raise SystemExit("mutation %s did not fail on the README table: %s" % (label, errors))
            print("mutation %s RED (README hand-mapped table missing rows)" % label)
        # infra/centrifugo.json gains a setting the Railway literals do not carry.
        cent = json.loads(centrifugo_path.read_text())
        cent.setdefault("client", {})["connection_limit"] = 10
        dest_cent = scratch / "centrifugo.json"
        dest_cent.write_text(json.dumps(cent))
        errors = collect_errors(catalog_path, compose_path, dest_cent, keys_path, readme_path)
        if not any("infra/centrifugo.json settings differ" in error for error in errors):
            raise SystemExit("mutation centrifugo-json-new-key did not fail: %s" % errors)
        print("mutation centrifugo-json-new-key RED (infra/centrifugo.json settings differ)")
    if (file_digest(catalog_path), file_digest(readme_path), file_digest(centrifugo_path)) != origin:
        raise SystemExit("committed catalog/README/centrifugo.json changed during scratch mutations")
    leftover = collect_errors(catalog_path, compose_path, centrifugo_path, keys_path, readme_path)
    if leftover:
        raise SystemExit("committed catalog drifted after scratch mutations: %s" % "; ".join(leftover))
    print("scratch mutations restored; committed catalog still passes")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("railway_json")
    parser.add_argument("compose_yml")
    parser.add_argument("centrifugo_json", help="infra/centrifugo.json, the settings the env literals replace")
    parser.add_argument("generator_keys", help="file with one generator key per line")
    parser.add_argument("readme")
    parser.add_argument("--prove-mutations", action="store_true")
    args = parser.parse_args(argv)
    paths = [
        Path(args.railway_json),
        Path(args.compose_yml),
        Path(args.centrifugo_json),
        Path(args.generator_keys),
        Path(args.readme),
    ]
    errors = collect_errors(*paths)
    if errors:
        raise SystemExit("; ".join(errors))
    print("catalog ok: %d services" % len(json.loads(paths[0].read_text())["services"]))
    if args.prove_mutations:
        prove_mutations(*paths)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
