#!/usr/bin/env python3
"""Railway service-catalog checker (#2205, ship-lanes audit §A.2–A.6).

infra/railway/railway.json is typed into Railway by hand, so every rule here
names something Railway does with a value, not a style preference:

* A start command replaces the image ENTRYPOINT in exec form. The oort image is
  ENTRYPOINT [momo-rust-entrypoint]; a bare role name is exit 127.
* Pre-deploy needs a shell for `VAR=… cmd && …`.
* Centrifugo v6 reads only its own env names, not the generator's.
* Railway volumes mount root-owned; api must init the drive dir as root and drop
  to uid 10001, and must not keep the superuser DSN pre-deploy needed.
* Postgres must be the compose PG18 + pgvector pin, not a plugin.
* Push keys arrive as sealed base64 variables and land on tmpfs only.
* `${{shared.KEY}}` must name a key the generator writes.
* README's hand-mapped table must list every value that is not an identity
  reference, so the operator can type it from one place.

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
# Literal values an operator types by hand that the audit table (§A.2) names.
HAND_LITERALS = {"HOST", "PORT", "CENT_API_URL", "RAILWAY_RUN_UID"}
REF_RE = re.compile(r"\$\{\{([^}]*)\}\}")
SHARED_RE = re.compile(r"^shared\.([A-Za-z_][A-Za-z0-9_]*)$")
PLACEHOLDER_PREFIXES = ("<sealed:", "<operator:")
SEALED_SERVICES = {"push-relay", "notifier"}
DRIVE_DIR = "/var/lib/oort/drive"
PG_DATA_MOUNT = "/var/lib/postgresql"


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


def readme_rows(readme: str) -> set[tuple[str, str]]:
    rows = set()
    for line in readme.splitlines():
        match = re.match(r"^\|\s*([a-z-]+)\s*\|\s*`([A-Z0-9_]+)`\s*\|", line)
        if match:
            rows.add((match.group(1), match.group(2)))
    return rows


def collect_errors(
    catalog_path: Path, compose_path: Path, keys_path: Path, readme_path: Path
) -> list[str]:
    errors: list[str] = []
    try:
        data = json.loads(catalog_path.read_text())
    except json.JSONDecodeError as exc:
        return ["railway.json is not JSON: %s" % exc]
    compose = compose_path.read_text()
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
        argv = split_start(command)
        if argv == ["momo-rust-entrypoint", role]:
            continue
        script = shell_script(command)
        if script is not None and re.search(
            r"(?:^|;)\s*exec\s+(?:\S+\s+)*momo-rust-entrypoint\s+%s\s*$" % re.escape(role),
            script.strip(),
        ):
            continue
        errors.append(
            "%s start command %r: must be `momo-rust-entrypoint %s` or "
            "`/bin/sh -c '… exec … momo-rust-entrypoint %s'` (Railway start "
            "command replaces the image ENTRYPOINT in exec form)"
            % (role, command, role, role)
        )

    # -- pre-deploy ----------------------------------------------------------
    pre = services["api"].get("preDeployCommand")
    pre_script = None
    if isinstance(pre, list) and len(pre) == 1:
        pre_script = shell_script(pre[0])
    if pre_script is None:
        errors.append(
            "api preDeploy must be one `/bin/sh -c '…'` string (VAR=… cmd && … "
            "needs a shell): %r" % (pre,)
        )
    else:
        roles_at = pre_script.find("MOMO_RUNTIME_ROLE_PROVISION=1")
        migrate_at = pre_script.find("MOMO_BOOTSTRAP_RUNTIME_ROLES=0")
        if (
            roles_at < 0
            or migrate_at < 0
            or roles_at > migrate_at
            or pre_script.count('DATABASE_URL="$MIGRATE_DATABASE_URL"') != 2
            or pre_script.count("/usr/local/bin/momo-migrate") != 2
            or "&&" not in pre_script[roles_at:migrate_at]
        ):
            errors.append(
                "api preDeploy must run roles (MOMO_RUNTIME_ROLE_PROVISION=1) && "
                "migrate (MOMO_BOOTSTRAP_RUNTIME_ROLES=0), both on "
                "MIGRATE_DATABASE_URL"
            )

    # -- api drive volume, UID, privilege drop, DSN --------------------------
    api_vars = variables("api")
    api_volume = services["api"].get("volume") or {}
    if api_volume.get("mountPath") != DRIVE_DIR:
        errors.append("api volume mountPath %r != %s" % (api_volume.get("mountPath"), DRIVE_DIR))
    if api_vars.get("RAILWAY_RUN_UID") != "0":
        errors.append("api RAILWAY_RUN_UID must be \"0\" (volumes mount root-owned)")
    api_script = shell_script(services["api"].get("startCommand")) or ""
    for needle in (
        "chown momo:momo",
        "setpriv --reuid=momo --regid=momo --init-groups",
        "momo-rust-entrypoint api",
    ):
        if needle not in api_script:
            errors.append("api start command missing %r (drive init + privilege drop)" % needle)
    dropped = set(re.findall(r"(?:^|\s)-u\s+([A-Z0-9_]+)", api_script))
    must_drop = {"MIGRATE_DATABASE_URL", "MOMO_INITIAL_OWNER_PASSWORD"} | {
        name for name in api_vars if name.endswith("_POSTGRES_PASSWORD")
    }
    if not must_drop <= dropped:
        errors.append(
            "api start command keeps pre-deploy secrets in the server env "
            "(env -u missing): %s" % ",".join(sorted(must_drop - dropped))
        )
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

    # -- Centrifugo native names ---------------------------------------------
    cent_vars = variables("centrifugo")
    for name, value in CENTRIFUGO_MAP.items():
        if cent_vars.get(name) != value:
            errors.append(
                "centrifugo %s %r != %r (v6 reads only its own names)"
                % (name, cent_vars.get(name), value)
            )
    if "CENTRIFUGO_PORT" in cent_vars:
        errors.append("centrifugo CENTRIFUGO_PORT is not a v6 key")
    want_cent_image = compose_image(compose, "centrifugo")
    if cent.get("image") != want_cent_image:
        errors.append("centrifugo image %r != compose %r" % (cent.get("image"), want_cent_image))

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
    for service, key_var, path_var in (
        ("push-relay", "APNS_KEY_P8_B64", "MOMO_APNS_KEY_PATH"),
        ("notifier", "RELAY_SIGNING_KEY_B64", "MOMO_PUSH_RELAY_PRIVATE_KEY_PATH"),
    ):
        script = shell_script(services[service].get("startCommand")) or ""
        for needle in (
            "umask 077",
            "k=/dev/shm/",
            "unset %s" % key_var,
            'export %s="$k"' % path_var,
        ):
            if needle not in script:
                errors.append(
                    "%s start command missing %r (key must land on tmpfs 0600, "
                    "not in env or on disk)" % (service, needle)
                )
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


def mutate_catalog(kind: str, data: dict) -> None:
    services = data["services"]
    if kind == "start-bare-api":
        services["api"]["startCommand"] = "api"
    elif kind == "start-bare-relay":
        services["relay"]["startCommand"] = "relay"
    elif kind == "start-no-exec":
        cmd = services["notifier"]["startCommand"]
        services["notifier"]["startCommand"] = cmd.replace(
            "exec momo-rust-entrypoint notifier", "momo-rust-entrypoint notifier; true"
        )
    elif kind == "predeploy-raw":
        services["api"]["preDeployCommand"] = [shell_script(services["api"]["preDeployCommand"][0])]
    elif kind == "centrifugo-origins-dropped":
        del services["centrifugo"]["variables"]["CENTRIFUGO_CLIENT_ALLOWED_ORIGINS"]
    elif kind == "centrifugo-compose-name":
        del services["centrifugo"]["variables"]["CENTRIFUGO_HTTP_API_KEY"]
        services["centrifugo"]["variables"]["CENT_API_KEY"] = "${{shared.CENT_API_KEY}}"
    elif kind == "api-volume-missing":
        del services["api"]["volume"]
    elif kind == "api-run-uid-missing":
        del services["api"]["variables"]["RAILWAY_RUN_UID"]
    elif kind == "api-keeps-superuser":
        services["api"]["startCommand"] = services["api"]["startCommand"].replace(
            "-u MIGRATE_DATABASE_URL ", ""
        )
    elif kind == "api-dsn-superuser":
        services["api"]["variables"]["DATABASE_URL"] = "${{shared.MIGRATE_DATABASE_URL}}"
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
        services["push-relay"]["variables"]["MOMO_APNS_ENV"] = "sandbox"
    elif kind == "push-key-on-disk":
        services["push-relay"]["startCommand"] = services["push-relay"]["startCommand"].replace(
            "/dev/shm/", "/tmp/"
        )
    elif kind == "sealed-shared":
        services["push-relay"]["variables"]["APNS_KEY_P8_B64"] = "${{shared.APNS_KEY_P8_B64}}"
    elif kind == "sender-key-dropped":
        del services["webhook-sender"]["variables"]["OUTBOUND_WEBHOOK_MASTER_KEY"]
    elif kind == "unknown-shared-ref":
        services["api"]["variables"]["JWT_HMAC"] = "${{shared.JWT_HMAC_TYPO}}"
    elif kind == "api-public":
        services["api"]["public"] = True
    else:
        raise SystemExit("unknown catalog mutation %s" % kind)


CATALOG_MUTATIONS: tuple[tuple[str, str], ...] = (
    ("start-bare-api", "must be `momo-rust-entrypoint api`"),
    ("start-bare-relay", "must be `momo-rust-entrypoint relay`"),
    ("start-no-exec", "must be `momo-rust-entrypoint notifier`"),
    ("predeploy-raw", "api preDeploy must be one"),
    ("centrifugo-origins-dropped", "centrifugo CENTRIFUGO_CLIENT_ALLOWED_ORIGINS"),
    ("centrifugo-compose-name", "centrifugo CENTRIFUGO_HTTP_API_KEY"),
    ("api-volume-missing", "api volume mountPath"),
    ("api-run-uid-missing", "api RAILWAY_RUN_UID"),
    ("api-keeps-superuser", "keeps pre-deploy secrets in the server env (env -u missing): MIGRATE_DATABASE_URL"),
    ("api-dsn-superuser", "api DATABASE_URL"),
    ("postgres-plugin", "postgres: plugins"),
    ("postgres-image-drift", "postgres image"),
    ("postgres-volume-missing", "postgres volume mountPath"),
    ("worker-url-drift", "agent-worker WORKER_DATABASE_URL"),
    ("push-sandbox", "push-relay MOMO_APNS_ENV"),
    ("push-key-on-disk", "push-relay start command missing 'k=/dev/shm/'"),
    ("sealed-shared", "push-relay APNS_KEY_P8_B64 must be a sealed variable"),
    ("sender-key-dropped", "webhook-sender OUTBOUND_WEBHOOK_MASTER_KEY"),
    ("unknown-shared-ref", "JWT_HMAC_TYPO"),
    ("api-public", "api must not be public"),
)


def prove_mutations(
    catalog_path: Path, compose_path: Path, keys_path: Path, readme_path: Path
) -> None:
    origin = (file_digest(catalog_path), file_digest(readme_path))
    base = json.loads(catalog_path.read_text())
    with tempfile.TemporaryDirectory(prefix="oort-railway-catalog.") as tmp:
        scratch = Path(tmp)
        for kind, needle in CATALOG_MUTATIONS:
            data = copy.deepcopy(base)
            mutate_catalog(kind, data)
            dest = scratch / ("%s.json" % kind)
            dest.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            errors = collect_errors(dest, compose_path, keys_path, readme_path)
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
        errors = collect_errors(catalog_path, compose_path, keys_path, dest_readme)
        if not any("agent-worker WORKER_DATABASE_URL" in error for error in errors):
            raise SystemExit("mutation readme-row-missing did not fail on the README table: %s" % errors)
        print("mutation readme-row-missing RED (README hand-mapped table missing rows)")
    if (file_digest(catalog_path), file_digest(readme_path)) != origin:
        raise SystemExit("committed catalog/README changed during scratch mutations")
    leftover = collect_errors(catalog_path, compose_path, keys_path, readme_path)
    if leftover:
        raise SystemExit("committed catalog drifted after scratch mutations: %s" % "; ".join(leftover))
    print("scratch mutations restored; committed catalog still passes")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("railway_json")
    parser.add_argument("compose_yml")
    parser.add_argument("generator_keys", help="file with one generator key per line")
    parser.add_argument("readme")
    parser.add_argument("--prove-mutations", action="store_true")
    args = parser.parse_args(argv)
    paths = [Path(args.railway_json), Path(args.compose_yml), Path(args.generator_keys), Path(args.readme)]
    errors = collect_errors(*paths)
    if errors:
        raise SystemExit("; ".join(errors))
    print("catalog ok: %d services" % len(json.loads(paths[0].read_text())["services"]))
    if args.prove_mutations:
        prove_mutations(*paths)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
