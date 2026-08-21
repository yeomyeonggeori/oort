#!/usr/bin/env bash
# Run the canonical Rust production migration only after validating a fresh,
# signed pgBackRest PITR evidence bundle produced by verify_pgbackrest_pitr.sh.
#
# This wrapper deliberately never sources a dotenv input. Docker Compose
# receives private snapshots under an empty ambient environment, after the
# required env/evidence files (plus optional production deploy env), evidence
# envelope, and owner-only secret files have been validated without following
# their final path components.
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/run_pitr_gated_migrate.sh \
    --operator-env /absolute/path/to/operator.env \
    --backup-env /run/momo-pitr/backup.env \
    --bindings-env /absolute/path/to/pgbackrest-pitr-RUN_ID.env \
    [--deploy-production-stack \
      --push-env /absolute/path/to/push-relay.secrets.env \
      --overlays-env /absolute/path/to/overlays.secrets.env]

The bindings file must be the owner-only 19-key artifact emitted by
scripts/verify_pgbackrest_pitr.sh. Only the signed-evidence production mode
(MOMO_PITR_EVIDENCE_REQUIRED=1, MOMO_PITR_BOOTSTRAP_EMPTY=0) is accepted.
The owner-only backup env has exactly MOMO_PGBACKREST_CIPHER_FILE and
PGBACKREST_REPO_VOLUME_NAME. Keys must not overlap across the three files.
First-install empty-database bootstrap is a separate attended lifecycle and
cannot be requested through this existing-database migration entrypoint.
`--deploy-production-stack` keeps validation, migration, and the scoped NCP
service rollout inside one private env snapshot. It never recreates postgres,
runtime-roles, or migrate through a raw `compose up`.
USAGE
}

fail() {
  printf 'PITR gated migrate: %s\n' "$*" >&2
  exit 1
}

operator_env=''
backup_env=''
bindings_env=''
deploy_production=0
push_env=''
overlays_env=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --operator-env|--backup-env|--bindings-env|--push-env|--overlays-env)
      [ "$#" -ge 2 ] || fail "$1 requires a file path"
      value=$2
      [ -n "$value" ] || fail "$1 requires a non-empty file path"
      case "$1" in
        --operator-env)
          [ -z "$operator_env" ] || fail "duplicate --operator-env"
          operator_env=$value
          ;;
        --backup-env)
          [ -z "$backup_env" ] || fail "duplicate --backup-env"
          backup_env=$value
          ;;
        --bindings-env)
          [ -z "$bindings_env" ] || fail "duplicate --bindings-env"
          bindings_env=$value
          ;;
        --push-env)
          [ -z "$push_env" ] || fail "duplicate --push-env"
          push_env=$value
          ;;
        --overlays-env)
          [ -z "$overlays_env" ] || fail "duplicate --overlays-env"
          overlays_env=$value
          ;;
      esac
      shift 2
      ;;
    --deploy-production-stack)
      [ "$deploy_production" -eq 0 ] || fail "duplicate --deploy-production-stack"
      deploy_production=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$operator_env" ] || fail "--operator-env is required"
[ -n "$backup_env" ] || fail "--backup-env is required"
[ -n "$bindings_env" ] || fail "--bindings-env is required"
if [ "$deploy_production" -eq 1 ]; then
  [ -n "$push_env" ] || fail "--push-env is required with --deploy-production-stack"
  [ -n "$overlays_env" ] || fail "--overlays-env is required with --deploy-production-stack"
elif [ -n "$push_env" ] || [ -n "$overlays_env" ]; then
  fail "--push-env/--overlays-env require --deploy-production-stack"
fi
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"

script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd -P)
base_compose=$repo_root/infra/rust/docker-compose.rust.yml
backup_compose=$repo_root/infra/rust/docker-compose.backup.yml
push_compose=$repo_root/infra/rust/docker-compose.push.yml
t3_compose=$repo_root/infra/rust/t3.override.yml
caddy_compose=$repo_root/infra/rust/caddy.override.yml
origin_compose=$repo_root/infra/rust/cent-origin.override.yml
[ -f "$base_compose" ] || fail "canonical Rust Compose file is missing"
[ -f "$backup_compose" ] || fail "canonical backup overlay is missing"
if [ "$deploy_production" -eq 1 ]; then
  for compose_path in "$push_compose" "$t3_compose" "$caddy_compose" "$origin_compose"; do
    [ -f "$compose_path" ] || fail "canonical production overlay is missing"
  done
fi

umask 077
snapshot_dir=$(mktemp -d /tmp/momo-pitr-gate.XXXXXX) \
  || fail "cannot create the private migration snapshot directory"
chmod 700 "$snapshot_dir" \
  || fail "cannot secure the private migration snapshot directory"
deploy_lock_name=momo-pitr-production-deploy-lock
deploy_lock_id=''
deploy_lock_cidfile=$snapshot_dir/deploy-lock.cid
clean_env=()
release_deploy_lock() {
  if [ -z "$deploy_lock_id" ] && [ -f "$deploy_lock_cidfile" ] && [ ! -L "$deploy_lock_cidfile" ]; then
    candidate_lock_id=$(<"$deploy_lock_cidfile")
    if [[ "$candidate_lock_id" =~ ^[0-9a-f]{64}$ ]]; then
      deploy_lock_id=$candidate_lock_id
    fi
  fi
  if [ -n "$deploy_lock_id" ]; then
    # The immutable container ID is the ownership token. Never remove by the
    # fixed name: another attended invocation must not be able to inherit our
    # cleanup if the daemon state changes underneath a failing command.
    if ! "${clean_env[@]}" docker container rm -f "$deploy_lock_id" >/dev/null 2>&1; then
      return 1
    fi
    deploy_lock_id=''
    find "$deploy_lock_cidfile" -delete >/dev/null 2>&1 || return 1
  fi
  return 0
}
cleanup_snapshot() {
  release_deploy_lock || true
  if [ -n "${snapshot_dir:-}" ] && [ -d "$snapshot_dir" ] && [ ! -L "$snapshot_dir" ]; then
    find "$snapshot_dir" -depth -delete >/dev/null 2>&1 || true
  fi
}
trap cleanup_snapshot EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
operator_snapshot=$snapshot_dir/operator.env
backup_snapshot=$snapshot_dir/backup.env
bindings_snapshot=$snapshot_dir/bindings.env
push_snapshot=$snapshot_dir/push.env
overlays_snapshot=$snapshot_dir/overlays.env

# All validation occurs before the first Docker invocation. The Python helper
# opens final components with O_NOFOLLOW and never prints file values.
validate_bundle() {
  python3 - "$operator_env" "$backup_env" "$bindings_env" "$snapshot_dir" \
    "$deploy_production" "$push_env" "$overlays_env" <<'PY'
import hashlib
import hmac
import json
import os
import pathlib
import re
import stat
import sys
from datetime import datetime, timezone


class GateError(Exception):
    pass


def reject(message: str) -> None:
    raise GateError(message)


def open_regular(path_text: str, label: str):
    path = pathlib.Path(path_text)
    if not path.is_absolute():
        reject(f"{label} path must be absolute")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        reject(f"cannot open {label} as a no-follow file: {error.strerror}")
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            reject(f"{label} must be a regular file")
        return path, fd, metadata
    except Exception:
        os.close(fd)
        raise


def parse_dotenv(
    data: bytes,
    label: str,
    *,
    exact_keys=None,
    generated_lines: bool = False,
) -> dict[str, str]:
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        reject(f"{label} must be UTF-8")
    if "\r" in text or "\x00" in text:
        reject(f"{label} contains a forbidden control byte")
    values: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line or line.startswith("#"):
            if generated_lines:
                reject(f"{label} line {number} is not a generated binding")
            continue
        if line.startswith("export ") or "=" not in line:
            reject(f"{label} line {number} is not KEY=value")
        name, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
            reject(f"{label} line {number} has an invalid key")
        if name in values:
            reject(f"{label} contains duplicate key {name}")
        values[name] = value
    if exact_keys is not None:
        missing = exact_keys - values.keys()
        unknown = values.keys() - exact_keys
        if missing:
            reject(f"{label} is missing required keys: " + ", ".join(sorted(missing)))
        if unknown:
            reject(f"{label} contains unknown keys: " + ", ".join(sorted(unknown)))
    return values


def one_line_secret(data: bytes, label: str, *, minimum: int = 32) -> bytes:
    if data.endswith(b"\n"):
        data = data[:-1]
    if not minimum <= len(data) <= 4096 or any(byte in data for byte in (0, 10, 13)):
        reject(f"{label} must be exactly one {minimum}..4096 byte line")
    return data


def json_no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            reject(f"evidence JSON contains duplicate key {key}")
        value[key] = item
    return value


def require_equal(actual, expected, label: str) -> None:
    if not isinstance(actual, str) or not hmac.compare_digest(actual, expected):
        reject(f"evidence and bindings disagree for {label}")


def exclusive_snapshot(
    directory: pathlib.Path,
    name: str,
    data: bytes,
    *,
    mode: int,
    owner: int,
) -> pathlib.Path:
    path = directory / name
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except OSError as error:
        reject(f"cannot create private snapshot {name}: {error.strerror}")
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                reject(f"short write while creating private snapshot {name}")
            view = view[written:]
        os.fsync(fd)
        if os.geteuid() == 0:
            os.fchown(fd, owner, -1)
        elif owner != os.geteuid():
            reject(f"cannot assign private snapshot {name} to its service uid")
        os.fchmod(fd, mode)
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != owner
            or stat.S_IMODE(metadata.st_mode) != mode
            or metadata.st_size != len(data)
        ):
            reject(f"private snapshot {name} metadata verification failed")
    finally:
        os.close(fd)
    return path


def dotenv_bytes(values: dict[str, str]) -> bytes:
    return "".join(f"{name}={values[name]}\n" for name in sorted(values)).encode("utf-8")


def assert_open_file_unchanged(
    fd: int,
    metadata,
    expected: bytes,
    label: str,
) -> None:
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        remaining = len(expected) + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        current = b"".join(chunks)
        after = os.fstat(fd)
    except OSError as error:
        reject(f"cannot re-read {label}: {error.strerror}")
    before_identity = (metadata.st_dev, metadata.st_ino, metadata.st_uid, metadata.st_mode, metadata.st_size)
    after_identity = (after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_size)
    if after_identity != before_identity or not hmac.compare_digest(current, expected):
        reject(f"{label} changed during snapshot creation")


try:
    operator_path = os.path.abspath(sys.argv[1])
    backup_path = os.path.abspath(sys.argv[2])
    bindings_path = os.path.abspath(sys.argv[3])
    snapshot_path = pathlib.Path(sys.argv[4])
    deploy_production = sys.argv[5] == "1"
    push_path = os.path.abspath(sys.argv[6]) if deploy_production else ""
    overlays_path = os.path.abspath(sys.argv[7]) if deploy_production else ""
    effective_uid = os.geteuid()
    operator_owners = {effective_uid, 0}
    # On Linux production hosts the operator runs as root and artifacts mounted
    # into momo-migrate are exact uid 10001. Non-root ownership is allowed only
    # for local Docker Desktop rehearsal; the in-container verifier independently
    # requires its own uid and therefore remains fail closed on Linux.
    service_uid = 10001 if effective_uid == 0 else effective_uid
    service_owners = {service_uid}
    postgres_uid = 999 if effective_uid == 0 else effective_uid

    try:
        snapshot_metadata = os.lstat(snapshot_path)
    except OSError as error:
        reject(f"cannot inspect private snapshot directory: {error.strerror}")
    if (
        not snapshot_path.is_absolute()
        or not stat.S_ISDIR(snapshot_metadata.st_mode)
        or stat.S_ISLNK(snapshot_metadata.st_mode)
        or snapshot_metadata.st_uid != effective_uid
        or stat.S_IMODE(snapshot_metadata.st_mode) != 0o700
    ):
        reject("private snapshot directory must be an absolute owner-only real directory")

    held_inputs = []

    def read_held(
        path_text: str,
        label: str,
        *,
        exact_mode: int,
        owners: set[int],
        minimum: int,
        maximum: int,
    ) -> bytes:
        _path, fd, metadata = open_regular(path_text, label)
        try:
            if stat.S_IMODE(metadata.st_mode) != exact_mode:
                reject(f"{label} mode must be {exact_mode:04o}")
            if metadata.st_uid not in owners:
                reject(f"{label} owner is not permitted")
            if not minimum <= metadata.st_size <= maximum:
                reject(f"{label} size is outside the permitted range")
            chunks = []
            remaining = maximum + 1
            while remaining > 0:
                chunk = os.read(fd, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            if len(data) > maximum:
                reject(f"{label} exceeds its maximum size")
            assert_open_file_unchanged(fd, metadata, data, label)
            held_inputs.append((fd, metadata, data, label))
            return data
        except Exception:
            os.close(fd)
            raise

    operator_raw = read_held(
        operator_path, "operator env", exact_mode=0o600, owners=operator_owners, minimum=1, maximum=65536
    )
    bindings_raw = read_held(
        bindings_path, "bindings env", exact_mode=0o600, owners=operator_owners, minimum=1, maximum=16384
    )
    backup_raw = read_held(
        backup_path, "backup env", exact_mode=0o600, owners=operator_owners, minimum=1, maximum=4096
    )
    push_raw = b""
    overlays_raw = b""
    if deploy_production:
        push_raw = read_held(
            push_path, "push env", exact_mode=0o600, owners=operator_owners, minimum=1, maximum=16384
        )
        overlays_raw = read_held(
            overlays_path, "overlays env", exact_mode=0o600, owners=operator_owners, minimum=1, maximum=16384
        )

    exact_binding_keys = {
        "MOMO_MIGRATE_ENV",
        "MOMO_PITR_EVIDENCE_REQUIRED",
        "MOMO_PITR_BOOTSTRAP_EMPTY",
        "MOMO_PITR_EVIDENCE_FILE",
        "MOMO_PITR_HMAC_KEY_FILE",
        "MOMO_PITR_MIGRATE_CIPHER_FILE",
        "MOMO_PITR_EXPECT_RUN_ID",
        "MOMO_PITR_EXPECT_GIT_COMMIT",
        "MOMO_PITR_EXPECT_COMPOSE_PROJECT",
        "MOMO_PITR_EXPECT_SOURCE_VOLUME",
        "MOMO_PITR_EXPECT_RESTORE_VOLUME",
        "MOMO_PITR_EXPECT_REPO_VOLUME",
        "MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST",
        "MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST",
        "MOMO_PITR_EXPECT_STANZA",
        "MOMO_PITR_EXPECT_CIPHER_TYPE",
        "MOMO_PITR_EXPECT_CIPHER_FINGERPRINT",
        "MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER",
        "MOMO_POSTGRES_PGBACKREST_IMAGE",
    }
    operator = parse_dotenv(operator_raw, "operator env")
    backup = parse_dotenv(
        backup_raw,
        "backup env",
        exact_keys={"MOMO_PGBACKREST_CIPHER_FILE", "PGBACKREST_REPO_VOLUME_NAME"},
    )
    bindings = parse_dotenv(
        bindings_raw,
        "bindings env",
        exact_keys=exact_binding_keys,
        generated_lines=True,
    )
    push = parse_dotenv(push_raw, "push env") if deploy_production else {}
    overlays = parse_dotenv(overlays_raw, "overlays env") if deploy_production else {}

    forbidden_operator_keys = {
        name
        for name in operator
        if (
            (name.startswith("COMPOSE_") and name != "COMPOSE_PROJECT_NAME")
            or name.startswith("DOCKER_")
            or name.startswith("MOMO_PITR_")
            or name
            in {
                "MOMO_MIGRATE_ENV",
                "MOMO_POSTGRES_PGBACKREST_IMAGE",
                "MOMO_IN_CONTAINER",
                "MOMO_MIGRATIONS_DIR",
                "MOMO_BOOTSTRAP_ROLES_SQL",
                "MOMO_RUNTIME_ROLES_SQL",
                "MOMO_SET_OWNER_SQL",
                "MOMO_BOOTSTRAP_OWNER_SQL",
            }
        )
    }
    if forbidden_operator_keys:
        reject(
            "operator env contains a reserved control/bindings key: "
            + ", ".join(sorted(forbidden_operator_keys))
        )

    reserved_deploy_keys = {
        "MOMO_ENV",
        "MOMO_RUST_IMAGE",
        "MOMO_POSTGRES_PGBACKREST_IMAGE",
        "DB_VOLUME_NAME",
        "PGBACKREST_REPO_VOLUME_NAME",
        "MOMO_PGBACKREST_CIPHER_FILE",
    }
    for label, values in (("push", push), ("overlays", overlays)):
        forbidden = {
            name
            for name in values
            if (
                name in reserved_deploy_keys
                or name.startswith("MOMO_PITR_")
                or name.startswith("COMPOSE_")
                or name.startswith("DOCKER_")
            )
        }
        if forbidden:
            reject(
                f"{label} env contains a reserved deployment key: "
                + ", ".join(sorted(forbidden))
            )

    sources = (
        ("operator", operator),
        ("backup", backup),
        ("bindings", bindings),
        ("push", push),
        ("overlays", overlays),
    )
    for index, (left_label, left) in enumerate(sources):
        for right_label, right in sources[index + 1 :]:
            overlap = left.keys() & right.keys()
            if overlap:
                reject(
                    f"{left_label} and {right_label} env files overlap: "
                    + ", ".join(sorted(overlap))
                )

    safe_value = re.compile(r"[A-Za-z0-9_./:@%+=,-]+\Z")
    for name, value in bindings.items():
        if not value or safe_value.fullmatch(value) is None:
            reject(f"bindings env contains a shell-active or invalid value for {name}")

    fixed = {
        "MOMO_MIGRATE_ENV": "production",
        "MOMO_PITR_EVIDENCE_REQUIRED": "1",
        "MOMO_PITR_BOOTSTRAP_EMPTY": "0",
        "MOMO_PITR_EXPECT_STANZA": "momo",
        "MOMO_PITR_EXPECT_CIPHER_TYPE": "aes-256-cbc",
    }
    for name, expected in fixed.items():
        if bindings[name] != expected:
            reject(f"bindings env requires {name}={expected}")

    run_id = bindings["MOMO_PITR_EXPECT_RUN_ID"]
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{15,47}", run_id) is None:
        reject("MOMO_PITR_EXPECT_RUN_ID has an invalid format")
    if re.fullmatch(r"[0-9a-f]{40}", bindings["MOMO_PITR_EXPECT_GIT_COMMIT"]) is None:
        reject("MOMO_PITR_EXPECT_GIT_COMMIT must be a lowercase 40-byte commit id")
    digest_pattern = re.compile(r"sha256:[0-9a-f]{64}\Z")
    for name in ("MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST", "MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST"):
        if digest_pattern.fullmatch(bindings[name]) is None:
            reject(f"{name} must be a lowercase sha256 digest")
    if re.fullmatch(r"[0-9a-f]{64}", bindings["MOMO_PITR_EXPECT_CIPHER_FINGERPRINT"]) is None:
        reject("MOMO_PITR_EXPECT_CIPHER_FINGERPRINT must be a lowercase HMAC digest")
    if re.fullmatch(r"[1-9][0-9]{9,21}", bindings["MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER"]) is None:
        reject("MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER has an invalid format")

    project = operator.get("COMPOSE_PROJECT_NAME", "")
    if operator.get("MOMO_ENV") != "production":
        reject("operator env must set MOMO_ENV=production")
    if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project) is None:
        reject("operator env must set a valid COMPOSE_PROJECT_NAME")
    if bindings["MOMO_PITR_EXPECT_COMPOSE_PROJECT"] != project:
        reject("MOMO_PITR_EXPECT_COMPOSE_PROJECT disagrees with operator env")
    source_volume = operator.get("DB_VOLUME_NAME", f"{project}-pgdata")
    repo_volume = backup["PGBACKREST_REPO_VOLUME_NAME"]
    if bindings["MOMO_PITR_EXPECT_SOURCE_VOLUME"] != source_volume:
        reject("MOMO_PITR_EXPECT_SOURCE_VOLUME disagrees with operator env")
    if bindings["MOMO_PITR_EXPECT_REPO_VOLUME"] != repo_volume:
        reject("MOMO_PITR_EXPECT_REPO_VOLUME disagrees with operator env")
    restore_pattern = re.compile(
        rf"momo-pitr-{re.escape(run_id)}-restore-[0-9a-f]{{32}}\Z"
    )
    if restore_pattern.fullmatch(bindings["MOMO_PITR_EXPECT_RESTORE_VOLUME"]) is None:
        reject("MOMO_PITR_EXPECT_RESTORE_VOLUME is not bound to the run id")

    postgres_ref = bindings["MOMO_POSTGRES_PGBACKREST_IMAGE"]
    if re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", postgres_ref) is None:
        reject("MOMO_POSTGRES_PGBACKREST_IMAGE must be digest pinned")
    if postgres_ref.rsplit("@", 1)[1] != bindings["MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST"]:
        reject("PostgreSQL image ref and expected digest disagree")
    migrate_ref = operator.get("MOMO_RUST_IMAGE", "")
    if re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", migrate_ref) is None:
        reject("operator MOMO_RUST_IMAGE must be digest pinned")
    if migrate_ref.rsplit("@", 1)[1] != bindings["MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST"]:
        reject("candidate migrate image and expected digest disagree")

    evidence_raw = read_held(
        bindings["MOMO_PITR_EVIDENCE_FILE"],
        "PITR evidence",
        exact_mode=0o600,
        owners=service_owners,
        minimum=1,
        maximum=65536,
    )
    key_raw = read_held(
        bindings["MOMO_PITR_HMAC_KEY_FILE"],
        "PITR HMAC key",
        exact_mode=0o400,
        owners=service_owners,
        minimum=32,
        maximum=4097,
    )
    migrate_cipher_raw = read_held(
        bindings["MOMO_PITR_MIGRATE_CIPHER_FILE"],
        "migrate repository cipher",
        exact_mode=0o400,
        owners=service_owners,
        minimum=32,
        maximum=4097,
    )
    postgres_cipher_path = backup["MOMO_PGBACKREST_CIPHER_FILE"]
    postgres_cipher_raw = read_held(
        postgres_cipher_path,
        "PostgreSQL repository cipher",
        exact_mode=0o400,
        owners={postgres_uid},
        minimum=32,
        maximum=4097,
    )
    key = one_line_secret(key_raw, "PITR HMAC key")
    migrate_cipher = one_line_secret(migrate_cipher_raw, "migrate repository cipher")
    postgres_cipher = one_line_secret(postgres_cipher_raw, "PostgreSQL repository cipher")
    if hmac.compare_digest(key, migrate_cipher):
        reject("PITR HMAC key and repository cipher must be distinct")
    if not hmac.compare_digest(migrate_cipher, postgres_cipher):
        reject("PostgreSQL and migrate repository cipher files differ")

    try:
        envelope = json.loads(
            evidence_raw.decode("utf-8", "strict"),
            object_pairs_hook=json_no_duplicates,
            parse_constant=lambda value: reject(f"PITR evidence contains invalid number {value}"),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        reject(f"PITR evidence is not strict JSON: {error}")
    if not isinstance(envelope, dict) or set(envelope) != {"schema", "payload", "signature"}:
        reject("PITR evidence envelope has an invalid shape")
    if envelope["schema"] != "momo-pitr-evidence/v1":
        reject("PITR evidence schema is not momo-pitr-evidence/v1")
    payload = envelope["payload"]
    signature = envelope["signature"]
    if not isinstance(payload, dict) or not isinstance(signature, str):
        reject("PITR evidence payload or signature has an invalid type")
    if re.fullmatch(r"[0-9a-f]{64}", signature) is None:
        reject("PITR evidence signature has an invalid format")
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    computed_signature = hmac.new(
        key,
        b"momo-pitr-evidence/v1\n" + canonical,
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, computed_signature):
        reject("PITR evidence signature verification failed")

    payload_keys = {
        "result",
        "run_id",
        "started_at",
        "source_backup_completed_at",
        "recovery_target_time",
        "restored_at",
        "completed_at",
        "duration_seconds",
        "git_commit",
        "compose_project",
        "stanza",
        "postgres_image_ref",
        "postgres_image_digest",
        "postgres_image_id",
        "candidate_migrate_image_digest",
        "migrations_sha256",
        "postgres_version",
        "pgbackrest_version",
        "source_volume",
        "restore_volume",
        "repo_volume",
        "source_system_identifier",
        "restore_system_identifier",
        "cipher_type",
        "cipher_fingerprint_hmac_sha256",
        "backup_label",
        "backup_type",
        "backup_lsn_start",
        "backup_lsn_stop",
        "archive_wal_start",
        "archive_wal_stop",
        "marker_a_count",
        "marker_b_count",
        "archive_mode",
        "archive_command",
        "archive_timeout_seconds",
        "cleanup_container_leaks",
        "cleanup_volume_leaks",
    }
    if set(payload) != payload_keys:
        reject("PITR evidence payload does not match the v1 signed field set")
    if payload["result"] != "PASS":
        reject("PITR evidence result is not PASS")
    if payload["cleanup_container_leaks"] != 0 or payload["cleanup_volume_leaks"] != 0:
        reject("PITR evidence reports cleanup leaks")
    if type(payload["duration_seconds"]) is not int or payload["duration_seconds"] <= 0:
        reject("PITR evidence duration is invalid")
    try:
        timestamps = [
            datetime.fromisoformat(payload[name].replace("Z", "+00:00"))
            for name in (
                "started_at",
                "source_backup_completed_at",
                "recovery_target_time",
                "restored_at",
                "completed_at",
            )
        ]
    except (AttributeError, ValueError):
        reject("PITR evidence timestamps are invalid")
    if any(value.tzinfo is None for value in timestamps):
        reject("PITR evidence timestamps must include UTC offsets")
    started, backup_completed, target, restored, completed = timestamps
    if not (started <= backup_completed <= target < restored <= completed):
        reject("PITR evidence timestamp chronology is invalid")
    measured = int((completed - started).total_seconds())
    if abs(measured - payload["duration_seconds"]) > 2 or payload["duration_seconds"] > 86400:
        reject("PITR evidence duration does not match its timestamps")
    now = datetime.now(timezone.utc)
    completed_utc = completed.astimezone(timezone.utc)
    age_seconds = (now - completed_utc).total_seconds()
    if age_seconds < 0:
        reject("PITR evidence is in the future")
    if age_seconds > 15 * 60:
        reject("PITR evidence is older than 15 minutes")
    comparisons = {
        "run_id": bindings["MOMO_PITR_EXPECT_RUN_ID"],
        "git_commit": bindings["MOMO_PITR_EXPECT_GIT_COMMIT"],
        "compose_project": bindings["MOMO_PITR_EXPECT_COMPOSE_PROJECT"],
        "stanza": bindings["MOMO_PITR_EXPECT_STANZA"],
        "postgres_image_ref": bindings["MOMO_POSTGRES_PGBACKREST_IMAGE"],
        "postgres_image_digest": bindings["MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST"],
        "candidate_migrate_image_digest": bindings["MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST"],
        "source_volume": bindings["MOMO_PITR_EXPECT_SOURCE_VOLUME"],
        "restore_volume": bindings["MOMO_PITR_EXPECT_RESTORE_VOLUME"],
        "repo_volume": bindings["MOMO_PITR_EXPECT_REPO_VOLUME"],
        "source_system_identifier": bindings["MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER"],
        "cipher_type": bindings["MOMO_PITR_EXPECT_CIPHER_TYPE"],
        "cipher_fingerprint_hmac_sha256": bindings["MOMO_PITR_EXPECT_CIPHER_FINGERPRINT"],
    }
    for field, expected in comparisons.items():
        require_equal(payload[field], expected, field)

    computed_fingerprint = hmac.new(
        key,
        b"momo-pitr-cipher-fingerprint/v1\n" + migrate_cipher,
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(
        computed_fingerprint,
        bindings["MOMO_PITR_EXPECT_CIPHER_FINGERPRINT"],
    ):
        reject("repository cipher fingerprint verification failed")

    # Freeze all trusted bytes into a runner-owned directory before Compose is
    # invoked. Env files point only at the nested snapshots, so a concurrent
    # replacement of any operator artifact cannot change the rendered image,
    # project, database target, or mounted evidence after this boundary.
    evidence_snapshot = exclusive_snapshot(
        snapshot_path,
        "evidence.json",
        evidence_raw,
        mode=0o600,
        owner=service_uid,
    )
    hmac_snapshot = exclusive_snapshot(
        snapshot_path,
        "evidence-hmac-key",
        key_raw,
        mode=0o400,
        owner=service_uid,
    )
    migrate_cipher_snapshot = exclusive_snapshot(
        snapshot_path,
        "migrate-cipher",
        migrate_cipher_raw,
        mode=0o400,
        owner=service_uid,
    )
    postgres_cipher_snapshot = exclusive_snapshot(
        snapshot_path,
        "postgres-cipher",
        postgres_cipher_raw,
        mode=0o400,
        owner=postgres_uid,
    )
    frozen_backup = dict(backup)
    frozen_backup["MOMO_PGBACKREST_CIPHER_FILE"] = str(postgres_cipher_snapshot)
    frozen_bindings = dict(bindings)
    frozen_bindings["MOMO_PITR_EVIDENCE_FILE"] = str(evidence_snapshot)
    frozen_bindings["MOMO_PITR_HMAC_KEY_FILE"] = str(hmac_snapshot)
    frozen_bindings["MOMO_PITR_MIGRATE_CIPHER_FILE"] = str(migrate_cipher_snapshot)
    exclusive_snapshot(
        snapshot_path,
        "operator.env",
        operator_raw,
        mode=0o600,
        owner=effective_uid,
    )
    exclusive_snapshot(
        snapshot_path,
        "backup.env",
        dotenv_bytes(frozen_backup),
        mode=0o600,
        owner=effective_uid,
    )
    exclusive_snapshot(
        snapshot_path,
        "bindings.env",
        dotenv_bytes(frozen_bindings),
        mode=0o600,
        owner=effective_uid,
    )
    if deploy_production:
        exclusive_snapshot(
            snapshot_path,
            "push.env",
            push_raw,
            mode=0o600,
            owner=effective_uid,
        )
        exclusive_snapshot(
            snapshot_path,
            "overlays.env",
            overlays_raw,
            mode=0o600,
            owner=effective_uid,
        )
    for fd, metadata, data, label in held_inputs:
        assert_open_file_unchanged(fd, metadata, data, label)
    for fd, _metadata, _data, _label in held_inputs:
        os.close(fd)
    held_inputs.clear()
except GateError as error:
    print(f"PITR gated migrate: {error}", file=sys.stderr)
    raise SystemExit(1)
finally:
    for fd, _metadata, _data, _label in locals().get("held_inputs", []):
        try:
            os.close(fd)
        except OSError:
            pass
PY
}

validate_bundle

# `validate_bundle` wrote this exact digest-pinned value into the private,
# runner-owned snapshot. Do not reopen the mutable operator input here.
migrate_ref=$(awk -F= '$1 == "MOMO_RUST_IMAGE" { print substr($0, index($0, "=") + 1) }' \
  "$operator_snapshot")
[ -n "$migrate_ref" ] || fail "private operator snapshot lost MOMO_RUST_IMAGE"

# Docker Compose gives ambient process variables higher precedence than env
# files. Start it from a deliberately empty environment so no caller export can
# override the two validated files. Keep only Docker transport/config settings.
clean_env=(env -i "PATH=$PATH")
for name in HOME DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG XDG_RUNTIME_DIR SSL_CERT_FILE SSL_CERT_DIR; do
  if [ "${!name+x}" = x ]; then
    clean_env+=("$name=${!name}")
  fi
done

migrate_compose=(
  docker compose
  --env-file "$operator_snapshot"
  --env-file "$backup_snapshot"
  --env-file "$bindings_snapshot"
  -f "$base_compose"
  -f "$backup_compose"
)

if [ "$deploy_production" -eq 1 ]; then
  deploy_compose=(
    docker compose
    --env-file "$operator_snapshot"
    --env-file "$backup_snapshot"
    --env-file "$bindings_snapshot"
    --env-file "$push_snapshot"
    --env-file "$overlays_snapshot"
    -f "$base_compose"
    -f "$backup_compose"
    -f "$push_compose"
    -f "$t3_compose"
    -f "$caddy_compose"
    -f "$origin_compose"
  )
  "${clean_env[@]}" "${deploy_compose[@]}" config --quiet
else
  "${clean_env[@]}" "${migrate_compose[@]}" config --quiet
fi

# Serialize every signed migration invocation on this Docker daemon. The
# fixed-name create is atomic; a concurrent or crash-stale owner fails closed
# before either invocation can reach migration SQL. The lock lives from the
# first in-container lineage check through the final healthy service rollout,
# closing the older-candidate/newer-schema interleaving. The candidate image
# was already digest- and evidence-bound above; override its application
# entrypoint with an inert shell so acquiring the mutex has no product side
# effects.
deploy_lock_error=$snapshot_dir/deploy-lock-create.err
set +e
deploy_lock_output=$("${clean_env[@]}" docker container create \
  --name "$deploy_lock_name" \
  --cidfile "$deploy_lock_cidfile" \
  --label com.momo.pitr.deploy-lock=true \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --entrypoint /bin/sh \
  "$migrate_ref" \
  -c 'trap : TERM INT; while :; do sleep 3600; done' 2>"$deploy_lock_error")
deploy_lock_status=$?
set -e
if [ "$deploy_lock_status" -ne 0 ]; then
  fail "another PITR migration/deployment holds the daemon lock"
fi
if [[ ! "$deploy_lock_output" =~ ^[0-9a-f]{64}$ ]]; then
  fail "Docker returned an invalid PITR deployment lock container id"
fi
deploy_lock_id=$deploy_lock_output
[ "$(<"$deploy_lock_cidfile")" = "$deploy_lock_id" ] \
  || fail "Docker deployment lock id and cidfile disagree"
"${clean_env[@]}" docker container start "$deploy_lock_id" >/dev/null \
  || fail "cannot start the PITR deployment lock container"
[ "$("${clean_env[@]}" docker container inspect -f '{{.State.Running}}' "$deploy_lock_id")" = true ] \
  || fail "PITR deployment lock container is not running"

# Both invocations consume the same private immutable-by-untrusted-operators
# snapshot. The in-container Rust verifier independently authenticates the
# mounted evidence, HMAC key, cipher fingerprint, and live system identifier.
"${clean_env[@]}" "${migrate_compose[@]}" run --rm --no-deps migrate

if [ "$deploy_production" -eq 1 ]; then
  # PostgreSQL is deliberately absent from every command below. The signed
  # evidence and in-container verifier just bound the live cluster; a final
  # `up` must not silently recreate it. Likewise runtime-roles and migrate are
  # one-shots and cannot be replayed through Compose dependency expansion.
  "${clean_env[@]}" "${deploy_compose[@]}" \
    up -d --no-deps --wait centrifugo push-relay
  "${clean_env[@]}" "${deploy_compose[@]}" \
    run --rm --no-deps web-init
  "${clean_env[@]}" "${deploy_compose[@]}" \
    up -d --no-deps --wait api relay webhook-sender agent-worker notifier caddy
fi

release_deploy_lock || fail "cannot release the PITR deployment lock container"
