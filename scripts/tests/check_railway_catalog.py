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
`umask` after the key is written does not count.

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
REQUIRED_SERVICES = OORT_ROLES + ("centrifugo", "caddy", "postgres")
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
HAND_LITERALS = {"HOST", "PORT", "CENT_API_URL", "RAILWAY_RUN_UID"}
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
                elif shared.group(1) not in generator_keys:
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
        # README: drop the WORKER_DATABASE_URL row → the table no longer covers
        # a value the operator must type.
        readme = readme_path.read_text()
        kept = [
            line
            for line in readme.splitlines(True)
            if not re.match(r"^\|\s*agent-worker\s*\|\s*`WORKER_DATABASE_URL`", line)
        ]
        if len(kept) == len(readme.splitlines(True)):
            raise SystemExit("README has no agent-worker WORKER_DATABASE_URL row to drop")
        dest_readme = scratch / "README.md"
        dest_readme.write_text("".join(kept))
        errors = collect_errors(catalog_path, compose_path, centrifugo_path, keys_path, dest_readme)
        if not any("agent-worker WORKER_DATABASE_URL" in error for error in errors):
            raise SystemExit("mutation readme-row-missing did not fail on the README table: %s" % errors)
        print("mutation readme-row-missing RED (README hand-mapped table missing rows)")
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
