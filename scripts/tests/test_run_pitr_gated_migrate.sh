#!/usr/bin/env bash
# Isolated security contract for run_pitr_gated_migrate.sh. The fake Docker CLI
# records argv but cannot contact a daemon or execute migration SQL.
set -Eeuo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(CDPATH='' cd -- "$script_dir/../.." && pwd -P)
runner=$root/scripts/run_pitr_gated_migrate.sh
[ -f "$runner" ] || {
  printf '[test-pitr-gated-migrate] missing runner\n' >&2
  exit 1
}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/momo-pitr-gated-migrate.XXXXXX")
cleanup() {
  if [ -d "$fixture" ]; then
    find "$fixture" -depth -delete >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf '[test-pitr-gated-migrate] FAIL %s\n' "$*" >&2
  exit 1
}

real_docker=$(command -v docker) || fail "docker is required for the real Compose render"

fake_bin=$fixture/bin
docker_config=$fixture/docker-config
docker_log=$docker_config/docker.log
mkdir -p "$fake_bin" "$docker_config"

cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
env_files=()
cidfile=''
previous=''
for argument in "$@"; do
  if [ "$previous" = --env-file ]; then
    env_files+=("$argument")
  elif [ "$previous" = --cidfile ]; then
    cidfile=$argument
  fi
  previous=$argument
done
{
  printf 'CALL'
  printf ' %s' "$@"
  printf '\n'
  printf 'AMBIENT MOMO_RUST_IMAGE=%s MOMO_PITR_EVIDENCE_REQUIRED=%s COMPOSE_FILE=%s\n' \
    "${MOMO_RUST_IMAGE-unset}" \
    "${MOMO_PITR_EVIDENCE_REQUIRED-unset}" \
    "${COMPOSE_FILE-unset}"
} >>"$DOCKER_CONFIG/docker.log"

arguments=" $* "
if [[ "$arguments" == *" container create "* ]]; then
  if [ -f "$DOCKER_CONFIG/lock-collision" ]; then
    printf '%s\n' 'Conflict. The container name is already in use.' >&2
    exit 1
  fi
  lock_id=$(printf '%064d' 0 | tr 0 a)
  [ -n "$cidfile" ] || exit 89
  (umask 077; printf '%s\n' "$lock_id" >"$cidfile")
  printf '%s\n' "$lock_id"
  exit 0
fi
if [[ "$arguments" == *" container start "* ]]; then
  [ ! -f "$DOCKER_CONFIG/lock-start-fail" ] || exit 55
  exit 0
fi
if [[ "$arguments" == *" container inspect -f {{.State.Running}} "* ]]; then
  if [ -f "$DOCKER_CONFIG/lock-not-running" ]; then
    printf '%s\n' false
  else
    printf '%s\n' true
  fi
  exit 0
fi
if [[ "$arguments" == *" container rm -f "* ]]; then
  if [ -f "$DOCKER_CONFIG/lock-rm-fail-once" ]; then
    find "$DOCKER_CONFIG/lock-rm-fail-once" -delete
    exit 55
  fi
  exit 0
fi
if [[ "$arguments" == *" config --quiet "* ]] && [ -f "$DOCKER_CONFIG/swap-source" ]; then
  swap_source=$(<"$DOCKER_CONFIG/swap-source")
  # Simulate an attended operator/editor replacing every original authority
  # after config has started. The runner's subsequent `run` must still consume
  # its already-authenticated private snapshots.
  printf '%s\n' 'MOMO_ENV=production' 'MOMO_RUST_IMAGE=busybox:latest' \
    >"$swap_source/operator.env"
  printf '%s\n' 'MOMO_PGBACKREST_CIPHER_FILE=/tmp/foreign' \
    'PGBACKREST_REPO_VOLUME_NAME=foreign-repo' >"$swap_source/backup.env"
  printf '%s\n' 'MOMO_PITR_EVIDENCE_REQUIRED=0' >"$swap_source/bindings.env"
  chmod 600 "$swap_source/operator.env" "$swap_source/backup.env" "$swap_source/bindings.env"
  printf '%s\n' '{"Result":"PASS"}' >"$swap_source/evidence.json"
  chmod 600 "$swap_source/evidence.json"
  for secret in evidence-hmac-key migrate-cipher postgres-cipher; do
    chmod 600 "$swap_source/$secret"
    printf '%s\n' 'foreign-secret-after-config-0123456789abcdef0123456789abcdef' \
      >"$swap_source/$secret"
    chmod 400 "$swap_source/$secret"
  done
  if [ -f "$swap_source/push.env" ]; then
    printf '%s\n' 'MOMO_RUST_IMAGE=busybox:latest' >"$swap_source/push.env"
    printf '%s\n' 'MOMO_RUST_IMAGE=busybox:latest' >"$swap_source/overlays.env"
    chmod 600 "$swap_source/push.env" "$swap_source/overlays.env"
  fi
fi

if [[ "$arguments" == *" run --rm --no-deps migrate "* ]]; then
  [ "${#env_files[@]}" -eq 3 ] || exit 71
  snapshot_dir=$(dirname -- "${env_files[0]}")
  [ "$(dirname -- "${env_files[1]}")" = "$snapshot_dir" ] || exit 72
  [ "$(dirname -- "${env_files[2]}")" = "$snapshot_dir" ] || exit 73
  [ "$(stat -f '%Lp' "$snapshot_dir" 2>/dev/null || stat -c '%a' "$snapshot_dir")" = 700 ] || exit 74
  grep -Fxq 'MOMO_ENV=production' "${env_files[0]}" || exit 75
  grep -Eq '^MOMO_RUST_IMAGE=ghcr.io/example/oort@sha256:b{64}$' "${env_files[0]}" || exit 76
  grep -Fxq 'MOMO_PITR_EVIDENCE_REQUIRED=1' "${env_files[2]}" || exit 77
  evidence_snapshot=$(awk -F= '$1 == "MOMO_PITR_EVIDENCE_FILE" { print substr($0, index($0, "=") + 1) }' "${env_files[2]}")
  hmac_snapshot=$(awk -F= '$1 == "MOMO_PITR_HMAC_KEY_FILE" { print substr($0, index($0, "=") + 1) }' "${env_files[2]}")
  migrate_cipher_snapshot=$(awk -F= '$1 == "MOMO_PITR_MIGRATE_CIPHER_FILE" { print substr($0, index($0, "=") + 1) }' "${env_files[2]}")
  postgres_cipher_snapshot=$(awk -F= '$1 == "MOMO_PGBACKREST_CIPHER_FILE" { print substr($0, index($0, "=") + 1) }' "${env_files[1]}")
  for nested in "$evidence_snapshot" "$hmac_snapshot" "$migrate_cipher_snapshot" "$postgres_cipher_snapshot"; do
    [ "$(dirname -- "$nested")" = "$snapshot_dir" ] && [ -f "$nested" ] || exit 78
  done
  grep -Fq '"schema": "momo-pitr-evidence/v1"' "$evidence_snapshot" || exit 79
  grep -Fq 'evidence-hmac-key-0123456789abcdef' "$hmac_snapshot" || exit 80
  cmp -s "$migrate_cipher_snapshot" "$postgres_cipher_snapshot" || exit 81
  grep -Fq 'repository-cipher-0123456789abcdef' "$migrate_cipher_snapshot" || exit 82
  printf 'SNAPSHOT_OK\n' >>"$DOCKER_CONFIG/docker.log"
fi
if [ "${#env_files[@]}" -eq 5 ]; then
  snapshot_dir=$(dirname -- "${env_files[0]}")
  for env_file in "${env_files[@]}"; do
    [ "$(dirname -- "$env_file")" = "$snapshot_dir" ] || exit 83
  done
  grep -Fxq 'MOMO_ENV=production' "${env_files[0]}" || exit 84
  grep -Eq '^MOMO_RUST_IMAGE=ghcr.io/example/oort@sha256:b{64}$' "${env_files[0]}" || exit 85
  grep -Fxq 'MOMO_APNS_SENDER=live' "${env_files[3]}" || exit 86
  grep -Fxq 'MOMO_T3_ENABLED=1' "${env_files[4]}" || exit 87
  ! grep -Fq 'busybox:latest' "${env_files[3]}" "${env_files[4]}" || exit 88
  printf 'DEPLOY_SNAPSHOT_OK\n' >>"$DOCKER_CONFIG/docker.log"
fi
exit 0
SH
chmod +x "$fake_bin/docker"

make_bundle() {
  local label=$1
  local destination=$fixture/$label
  mkdir "$destination"
  python3 - "$destination" <<'PY'
import hashlib
import hmac
import json
import os
import pathlib
import sys
from datetime import datetime, timedelta, timezone

directory = pathlib.Path(sys.argv[1]).resolve()
project = "pitrgate"
run_id = "gate-20260812T030000Z"
resource_suffix = "e" * 32
postgres_digest = "sha256:" + "a" * 64
migrate_digest = "sha256:" + "b" * 64
git_commit = "c" * 40
system_identifier = "7591234567890123456"
key = b"evidence-hmac-key-0123456789abcdef0123456789abcdef0123456789"
cipher = b"repository-cipher-0123456789abcdef0123456789abcdef0123456789"
fingerprint = hmac.new(
    key,
    b"momo-pitr-cipher-fingerprint/v1\n" + cipher,
    hashlib.sha256,
).hexdigest()
completed = datetime.now(timezone.utc) - timedelta(seconds=2)
started = completed - timedelta(seconds=21)
backup_completed = started + timedelta(seconds=10)
target = backup_completed + timedelta(seconds=1)
restored = completed - timedelta(seconds=1)
timestamp = lambda value: value.isoformat(timespec="microseconds").replace("+00:00", "Z")

key_path = directory / "evidence-hmac-key"
archive_cipher_path = directory / "postgres-cipher"
migrate_cipher_path = directory / "migrate-cipher"
evidence_path = directory / "evidence.json"
operator_path = directory / "operator.env"
backup_path = directory / "backup.env"
bindings_path = directory / "bindings.env"

key_path.write_bytes(key + b"\n")
archive_cipher_path.write_bytes(cipher + b"\n")
migrate_cipher_path.write_bytes(cipher + b"\n")

payload = {
    "result": "PASS",
    "run_id": run_id,
    "started_at": timestamp(started),
    "source_backup_completed_at": timestamp(backup_completed),
    "recovery_target_time": timestamp(target),
    "restored_at": timestamp(restored),
    "completed_at": timestamp(completed),
    "duration_seconds": 21,
    "git_commit": git_commit,
    "compose_project": project,
    "stanza": "momo",
    "postgres_image_ref": f"ghcr.io/example/oort-postgres@{postgres_digest}",
    "postgres_image_digest": postgres_digest,
    "postgres_image_id": postgres_digest,
    "candidate_migrate_image_digest": migrate_digest,
    "migrations_sha256": "d" * 64,
    "postgres_version": "18.0",
    "pgbackrest_version": "2.56.0",
    "source_volume": f"{project}-pgdata",
    "restore_volume": f"momo-pitr-{run_id}-restore-{resource_suffix}",
    "repo_volume": f"{project}-pgbackrest-repo",
    "source_system_identifier": system_identifier,
    "restore_system_identifier": system_identifier,
    "cipher_type": "aes-256-cbc",
    "cipher_fingerprint_hmac_sha256": fingerprint,
    "backup_label": "20260812-030000F",
    "backup_type": "full",
    "backup_lsn_start": "0/1000000",
    "backup_lsn_stop": "0/2000000",
    "archive_wal_start": "000000010000000000000001",
    "archive_wal_stop": "000000010000000000000002",
    "marker_a_count": 1,
    "marker_b_count": 0,
    "archive_mode": "on",
    "archive_command": "/usr/local/bin/oort-pgbackrest --stanza=momo archive-push %p",
    "archive_timeout_seconds": 60,
    "cleanup_container_leaks": 0,
    "cleanup_volume_leaks": 0,
}
canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
signature = hmac.new(
    key,
    b"momo-pitr-evidence/v1\n" + canonical,
    hashlib.sha256,
).hexdigest()
envelope = {
    "schema": "momo-pitr-evidence/v1",
    "payload": payload,
    "signature": signature,
}
evidence_path.write_text(json.dumps(envelope, sort_keys=True) + "\n")

operator = {
    "CENT_API_KEY": "compose-render-cent-api-key",
    "CENT_PROXY_SECRET": "compose-render-cent-proxy-secret",
    "CENT_TOKEN_HMAC": "compose-render-cent-token-hmac",
    "COMPOSE_PROJECT_NAME": project,
    "DB_VOLUME_NAME": f"{project}-pgdata",
    "JWT_HMAC": "compose-render-jwt-hmac",
    "MIGRATE_DATABASE_URL": "postgres://momo:owner-password@postgres:5432/momo",
    "MOMO_APP_DATABASE_URL": "postgres://momo_app:app-password@postgres:5432/momo",
    "MOMO_APP_POSTGRES_PASSWORD": "app-password",
    "MOMO_CENTRIFUGO_WS_URL": "wss://oort.example.invalid/connection/websocket",
    "MOMO_ENV": "production",
    "MOMO_RUST_IMAGE": f"ghcr.io/example/oort@{migrate_digest}",
    "POSTGRES_DB": "momo",
    "POSTGRES_PASSWORD": "owner-password",
    "POSTGRES_USER": "momo",
    "PROVIDER_LINK_MASTER_KEY": "compose-render-provider-master-key",
    "RELAY_DATABASE_URL": "postgres://momo_relay:relay-password@postgres:5432/momo",
    "RELAY_POSTGRES_PASSWORD": "relay-password",
    "WORKER_POSTGRES_PASSWORD": "worker-password",
}
backup = {
    "MOMO_PGBACKREST_CIPHER_FILE": str(archive_cipher_path),
    "PGBACKREST_REPO_VOLUME_NAME": f"{project}-pgbackrest-repo",
}
bindings = {
    "MOMO_MIGRATE_ENV": "production",
    "MOMO_PITR_EVIDENCE_REQUIRED": "1",
    "MOMO_PITR_BOOTSTRAP_EMPTY": "0",
    "MOMO_PITR_EVIDENCE_FILE": str(evidence_path),
    "MOMO_PITR_HMAC_KEY_FILE": str(key_path),
    "MOMO_PITR_MIGRATE_CIPHER_FILE": str(migrate_cipher_path),
    "MOMO_PITR_EXPECT_RUN_ID": run_id,
    "MOMO_PITR_EXPECT_GIT_COMMIT": git_commit,
    "MOMO_PITR_EXPECT_COMPOSE_PROJECT": project,
    "MOMO_PITR_EXPECT_SOURCE_VOLUME": f"{project}-pgdata",
    "MOMO_PITR_EXPECT_RESTORE_VOLUME": f"momo-pitr-{run_id}-restore-{resource_suffix}",
    "MOMO_PITR_EXPECT_REPO_VOLUME": f"{project}-pgbackrest-repo",
    "MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST": postgres_digest,
    "MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST": migrate_digest,
    "MOMO_PITR_EXPECT_STANZA": "momo",
    "MOMO_PITR_EXPECT_CIPHER_TYPE": "aes-256-cbc",
    "MOMO_PITR_EXPECT_CIPHER_FINGERPRINT": fingerprint,
    "MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER": system_identifier,
    "MOMO_POSTGRES_PGBACKREST_IMAGE": f"ghcr.io/example/oort-postgres@{postgres_digest}",
}
for path, values in (
    (operator_path, operator),
    (backup_path, backup),
    (bindings_path, bindings),
):
    path.write_text("".join(f"{name}={values[name]}\n" for name in sorted(values)))
    path.chmod(0o600)
backup_path.write_text(
    "# exact two-key attended POSIX topology\n\n"
    + "".join(f"{name}={backup[name]}\n" for name in sorted(backup))
)
backup_path.chmod(0o600)

euid = os.geteuid()
service_uid = 10001 if euid == 0 else euid
postgres_uid = 999 if euid == 0 else euid
for path in (key_path, migrate_cipher_path):
    path.chmod(0o400)
    os.chown(path, service_uid, -1)
archive_cipher_path.chmod(0o400)
os.chown(archive_cipher_path, postgres_uid, -1)
evidence_path.chmod(0o600)
os.chown(evidence_path, service_uid, -1)
PY
  printf '%s\n' "$destination"
}

replace_binding() {
  local file=$1 key=$2 value=$3 temporary
  temporary=$file.tmp
  awk -F= -v key="$key" -v value="$value" \
    '$1 == key { print key "=" value; next } { print }' "$file" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$file"
}

drop_binding() {
  local file=$1 key=$2 temporary
  temporary=$file.tmp
  awk -F= -v key="$key" '$1 != key { print }' "$file" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$file"
}

invoke() {
  local directory=$1
  shift
  env \
    PATH="$fake_bin:$PATH" \
    DOCKER_CONFIG="$docker_config" \
    "$@" \
    bash "$runner" \
      --operator-env "$directory/operator.env" \
      --backup-env "$directory/backup.env" \
      --bindings-env "$directory/bindings.env"
}

invoke_deploy() {
  local directory=$1
  shift
  env \
    PATH="$fake_bin:$PATH" \
    DOCKER_CONFIG="$docker_config" \
    "$@" \
    bash "$runner" \
      --operator-env "$directory/operator.env" \
      --backup-env "$directory/backup.env" \
      --bindings-env "$directory/bindings.env" \
      --deploy-production-stack \
      --push-env "$directory/push.env" \
      --overlays-env "$directory/overlays.env"
}

expect_red_before_docker() {
  local label=$1 directory=$2 expected=$3
  local output status
  : >"$docker_log"
  set +e
  output=$(invoke "$directory" 2>&1)
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$label unexpectedly passed"
  [ ! -s "$docker_log" ] || fail "$label reached Docker (migration SQL boundary)"
  [[ "$output" == *"$expected"* ]] \
    || fail "$label wrong error expected=$expected output=$output"
}

positive=$(make_bundle positive)
: >"$docker_log"
printf '%s\n' "$positive" >"$docker_config/swap-source"
invoke "$positive" \
  MOMO_RUST_IMAGE=busybox:latest \
  MOMO_PITR_EVIDENCE_REQUIRED=0 \
  COMPOSE_FILE=/tmp/attacker-compose.yml \
  >/dev/null
[ "$(grep -c '^CALL ' "$docker_log")" -eq 6 ] \
  || fail "positive path must call config, acquire/release the lock, and migrate exactly once"
python3 - "$docker_log" "$root" <<'PY'
import pathlib
import re
import sys

lines = pathlib.Path(sys.argv[1]).read_text().splitlines()
root = re.escape(sys.argv[2])
prefix = (
    r"CALL compose --env-file (/tmp/momo-pitr-gate\.[^/]+)/operator\.env "
    r"--env-file \1/backup\.env --env-file \1/bindings\.env "
    rf"-f {root}/infra/rust/docker-compose\.rust\.yml "
    rf"-f {root}/infra/rust/docker-compose\.backup\.yml "
)
assert any(re.fullmatch(prefix + r"config --quiet", line) for line in lines), lines
assert any(re.fullmatch(prefix + r"run --rm --no-deps migrate", line) for line in lines), lines
create = next(i for i, line in enumerate(lines) if " container create " in f" {line} ")
start = next(i for i, line in enumerate(lines) if " container start " in f" {line} ")
inspect = next(i for i, line in enumerate(lines) if " container inspect " in f" {line} ")
migrate = next(i for i, line in enumerate(lines) if " run --rm --no-deps migrate" in line)
release = next(i for i, line in enumerate(lines) if " container rm -f " in f" {line} ")
assert create < start < inspect < migrate < release, lines
PY
[ "$(grep -c '^SNAPSHOT_OK$' "$docker_log")" -eq 1 ] \
  || fail "config-time original swap changed the private run snapshot"
! grep -Fq -- "$positive/operator.env" "$docker_log" \
  || fail "Docker received the mutable original operator env"
snapshot_operator=$(awk '
  $1 == "CALL" {
    for (idx = 1; idx <= NF; idx++) {
      if ($idx == "--env-file") { print $(idx + 1); exit }
    }
  }
' "$docker_log")
snapshot_path=$(dirname -- "$snapshot_operator")
[ -n "$snapshot_path" ] && [ ! -e "$snapshot_path" ] \
  || fail "private migration snapshot was not removed after Docker returned"
[ "$(grep -c '^AMBIENT MOMO_RUST_IMAGE=unset MOMO_PITR_EVIDENCE_REQUIRED=unset COMPOSE_FILE=unset$' "$docker_log")" -eq 6 ] \
  || fail "ambient Compose overrides reached Docker"
find "$docker_config/swap-source" -delete

# The fixed daemon-wide name is the cross-invocation mutex. A concurrent or
# crash-stale owner must stop this invocation before migration SQL, and its
# foreign lock must never be removed by our cleanup path.
lock_collision=$(make_bundle lock-collision)
: >"$docker_log"
touch "$docker_config/lock-collision"
set +e
lock_output=$(invoke "$lock_collision" 2>&1)
lock_status=$?
set -e
find "$docker_config/lock-collision" -delete
[ "$lock_status" -ne 0 ] || fail "daemon lock collision unexpectedly passed"
[[ "$lock_output" == *'another PITR migration/deployment holds the daemon lock'* ]] \
  || fail "daemon lock collision returned the wrong error: $lock_output"
grep -Fq 'container create --name momo-pitr-production-deploy-lock' "$docker_log" \
  || fail "daemon lock collision never attempted the fixed-name atomic create"
! grep -Fq 'run --rm --no-deps migrate' "$docker_log" \
  || fail "daemon lock collision reached migration SQL"
! grep -Fq 'container rm -f' "$docker_log" \
  || fail "daemon lock collision removed the foreign lock owner"

for failure_mode in start-fail not-running; do
  lock_failure=$(make_bundle "lock-$failure_mode")
  : >"$docker_log"
  touch "$docker_config/lock-$failure_mode"
  set +e
  invoke "$lock_failure" >/dev/null 2>&1
  lock_failure_status=$?
  set -e
  find "$docker_config/lock-$failure_mode" -delete
  [ "$lock_failure_status" -ne 0 ] || fail "lock $failure_mode unexpectedly passed"
  ! grep -Fq 'run --rm --no-deps migrate' "$docker_log" \
    || fail "lock $failure_mode reached migration SQL"
  [ "$(grep -c 'container rm -f aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$docker_log")" -eq 1 ] \
    || fail "lock $failure_mode did not clean exactly its immutable container id"
done

lock_release_failure=$(make_bundle lock-release-failure)
: >"$docker_log"
touch "$docker_config/lock-rm-fail-once"
set +e
invoke "$lock_release_failure" >/dev/null 2>&1
lock_release_status=$?
set -e
[ "$lock_release_status" -ne 0 ] \
  || fail "deployment lock cleanup failure was reported green"
[ "$(grep -c 'container rm -f aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$docker_log")" -eq 2 ] \
  || fail "deployment lock cleanup failure did not trigger the EXIT retry"

deploy=$(make_bundle deploy)
printf '%s\n' \
  'MOMO_APNS_SENDER=live' \
  'MOMO_APNS_ENV=production' \
  'MOMO_APNS_KEY_HOST_PATH=/run/host/apns.p8' \
  'MOMO_RELAY_SIGNING_KEY_HOST_PATH=/run/host/relay.pem' \
  >"$deploy/push.env"
printf '%s\n' \
  'MOMO_T3_ENABLED=1' \
  'PLATFORM_ADMIN_EMAILS=owner@example.com' \
  'MOMO_PUBLIC_BASE_URL=https://app.oor7.com' \
  'CENTRIFUGO_ALLOWED_ORIGINS=https://app.oor7.com' \
  'CADDY_HTTP_PORT=80' \
  'CADDY_HTTPS_PORT=443' \
  >"$deploy/overlays.env"
chmod 600 "$deploy/push.env" "$deploy/overlays.env"
: >"$docker_log"
printf '%s\n' "$deploy" >"$docker_config/swap-source"
invoke_deploy "$deploy" \
  MOMO_RUST_IMAGE=busybox:latest \
  MOMO_PITR_EVIDENCE_REQUIRED=0 \
  COMPOSE_FILE=/tmp/attacker-compose.yml \
  >/dev/null
[ "$(grep -c '^CALL ' "$docker_log")" -eq 9 ] \
  || fail "deploy path must call config, migrate, two staged starts, and final start"
python3 - "$docker_log" <<'PY'
import pathlib
import sys

lines = pathlib.Path(sys.argv[1]).read_text().splitlines()

def index(fragment: str) -> int:
    return next(i for i, line in enumerate(lines) if fragment in line)

create = index(" container create ")
start = index(" container start ")
inspect = index(" container inspect -f {{.State.Running}} ")
migrate = index(" run --rm --no-deps migrate")
transport = index(" up -d --no-deps --wait centrifugo push-relay")
web_init = index(" run --rm --no-deps web-init")
final = index(" up -d --no-deps --wait api relay webhook-sender agent-worker notifier caddy")
release = index(" container rm -f ")
assert create < start < inspect < migrate < transport < web_init < final < release, lines
create_line = lines[create]
for fragment in (
    "--name momo-pitr-production-deploy-lock",
    "--cidfile /tmp/momo-pitr-gate.",
    "--label com.momo.pitr.deploy-lock=true",
    "--network none",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    "--entrypoint /bin/sh",
    "ghcr.io/example/oort@sha256:" + "b" * 64,
):
    assert fragment in create_line, (fragment, create_line)
PY
[ "$(grep -c '^DEPLOY_SNAPSHOT_OK$' "$docker_log")" -eq 4 ] \
  || fail "production deployment did not retain one five-env private snapshot"
[ "$(grep -c '^SNAPSHOT_OK$' "$docker_log")" -eq 1 ] \
  || fail "production deployment migrate did not use the authenticated snapshot"
grep -Fq 'up -d --no-deps --wait centrifugo push-relay' "$docker_log" \
  || fail "production deployment did not stage healthy transport services"
grep -Fq 'run --rm --no-deps web-init' "$docker_log" \
  || fail "production deployment did not stage web assets before Caddy"
grep -Fq 'up -d --no-deps --wait api relay webhook-sender agent-worker notifier caddy' "$docker_log" \
  || fail "production deployment did not wait for the final scoped service rollout"
! grep -Eq 'up .*\b(postgres|runtime-roles|migrate)\b' "$docker_log" \
  || fail "production deployment replayed a database or migration one-shot through up"
[ "$(grep -c '^AMBIENT MOMO_RUST_IMAGE=unset MOMO_PITR_EVIDENCE_REQUIRED=unset COMPOSE_FILE=unset$' "$docker_log")" -eq 9 ] \
  || fail "ambient overrides reached a production deployment command"
find "$docker_config/swap-source" -delete

# Render the real canonical Compose pair with the exact three validated files.
# This is daemon-free but catches interpolation, overlay, mount, and service-name
# drift that the fake Docker argv test cannot model.
render=$(make_bundle real-render)
real_config=$fixture/real-compose.json
env -i \
  PATH="$(dirname -- "$real_docker"):/usr/local/bin:/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  "$real_docker" compose \
    --env-file "$render/operator.env" \
    --env-file "$render/backup.env" \
    --env-file "$render/bindings.env" \
    -f "$root/infra/rust/docker-compose.rust.yml" \
    -f "$root/infra/rust/docker-compose.backup.yml" \
    config --format json >"$real_config"
python3 - "$real_config" "$render" <<'PY'
import json
import pathlib
import sys

config = json.loads(pathlib.Path(sys.argv[1]).read_text())
fixture = pathlib.Path(sys.argv[2]).resolve()
migrate = config["services"]["migrate"]
environment = migrate["environment"]
assert migrate["image"] == "ghcr.io/example/oort@sha256:" + "b" * 64
assert environment["MOMO_ENV"] == "production"
assert environment["MOMO_PITR_EVIDENCE_REQUIRED"] == "1"
assert environment["MOMO_PITR_BOOTSTRAP_EMPTY"] == "0"
assert environment["MOMO_PITR_EXPECT_CIPHER_FINGERPRINT"]
mounts = {item["target"]: item for item in migrate["volumes"]}
assert mounts["/run/momo-pitr/evidence.json"]["source"] == str(fixture / "evidence.json"), mounts
assert mounts["/run/secrets/momo_pitr_hmac_key"]["source"] == str(fixture / "evidence-hmac-key"), mounts
assert mounts["/run/secrets/pgbackrest_repo1_cipher_pass"]["source"] == str(fixture / "migrate-cipher"), mounts
assert all(
    mounts[target]["read_only"]
    for target in (
        "/run/momo-pitr/evidence.json",
        "/run/secrets/momo_pitr_hmac_key",
        "/run/secrets/pgbackrest_repo1_cipher_pass",
    )
)
PY

# Existing self-host/smoke env (development + skip keys) must not beat the
# backup overlay. `${VAR:-default}` interpolates from process env first.
ambient_config=$fixture/ambient-compose.json
env -i \
  PATH="$(dirname -- "$real_docker"):/usr/local/bin:/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  MOMO_MIGRATE_ENV=development \
  MOMO_PITR_EVIDENCE_REQUIRED=0 \
  MOMO_PITR_BOOTSTRAP_EMPTY=1 \
  "$real_docker" compose \
    --env-file "$render/operator.env" \
    --env-file "$render/backup.env" \
    --env-file "$render/bindings.env" \
    -f "$root/infra/rust/docker-compose.rust.yml" \
    -f "$root/infra/rust/docker-compose.backup.yml" \
    config --format json >"$ambient_config"
python3 - "$ambient_config" <<'PY'
import json
import pathlib
import sys

environment = json.loads(pathlib.Path(sys.argv[1]).read_text())["services"]["migrate"]["environment"]
assert environment["MOMO_ENV"] == "production", environment["MOMO_ENV"]
assert environment["MOMO_PITR_EVIDENCE_REQUIRED"] == "1", environment["MOMO_PITR_EVIDENCE_REQUIRED"]
assert environment["MOMO_PITR_BOOTSTRAP_EMPTY"] == "0", environment["MOMO_PITR_BOOTSTRAP_EMPTY"]
PY

missing_evidence=$(make_bundle missing-evidence)
find "$missing_evidence/evidence.json" -delete
expect_red_before_docker missing_evidence "$missing_evidence" 'cannot open PITR evidence'

symlink_evidence=$(make_bundle symlink-evidence)
mv "$symlink_evidence/evidence.json" "$symlink_evidence/evidence.real"
ln -s evidence.real "$symlink_evidence/evidence.json"
expect_red_before_docker symlink_evidence "$symlink_evidence" 'cannot open PITR evidence as a no-follow file'

symlink_bindings=$(make_bundle symlink-bindings)
mv "$symlink_bindings/bindings.env" "$symlink_bindings/bindings.real"
ln -s bindings.real "$symlink_bindings/bindings.env"
expect_red_before_docker symlink_bindings "$symlink_bindings" 'cannot open bindings env as a no-follow file'

symlink_operator=$(make_bundle symlink-operator)
mv "$symlink_operator/operator.env" "$symlink_operator/operator.real"
ln -s operator.real "$symlink_operator/operator.env"
expect_red_before_docker symlink_operator "$symlink_operator" 'cannot open operator env as a no-follow file'

symlink_backup=$(make_bundle symlink-backup)
mv "$symlink_backup/backup.env" "$symlink_backup/backup.real"
ln -s backup.real "$symlink_backup/backup.env"
expect_red_before_docker symlink_backup "$symlink_backup" 'cannot open backup env as a no-follow file'

symlink_cipher=$(make_bundle symlink-cipher)
mv "$symlink_cipher/postgres-cipher" "$symlink_cipher/postgres-cipher.real"
ln -s postgres-cipher.real "$symlink_cipher/postgres-cipher"
expect_red_before_docker symlink_cipher "$symlink_cipher" 'cannot open PostgreSQL repository cipher as a no-follow file'

bad_permission=$(make_bundle bad-permission)
chmod 644 "$bad_permission/evidence-hmac-key"
expect_red_before_docker bad_permission "$bad_permission" 'PITR HMAC key mode must be 0400'

bad_env_permission=$(make_bundle bad-env-permission)
chmod 644 "$bad_env_permission/bindings.env"
expect_red_before_docker bad_env_permission "$bad_env_permission" 'bindings env mode must be 0600'

duplicate_binding=$(make_bundle duplicate-binding)
printf '%s\n' 'MOMO_PITR_EXPECT_STANZA=momo' >>"$duplicate_binding/bindings.env"
expect_red_before_docker duplicate_binding "$duplicate_binding" 'duplicate key MOMO_PITR_EXPECT_STANZA'

unknown_binding=$(make_bundle unknown-binding)
printf '%s\n' 'RESULT=PASS' >>"$unknown_binding/bindings.env"
expect_red_before_docker unknown_binding "$unknown_binding" 'unknown keys: RESULT'

commented_binding=$(make_bundle commented-binding)
printf '%s\n' '# generated bindings cannot contain hand-authored lines' >>"$commented_binding/bindings.env"
expect_red_before_docker commented_binding "$commented_binding" 'is not a generated binding'

missing_binding=$(make_bundle missing-binding)
drop_binding "$missing_binding/bindings.env" MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER
expect_red_before_docker missing_binding "$missing_binding" 'missing required keys: MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER'

shell_active=$(make_bundle shell-active)
marker=$fixture/shell-injection-ran
replace_binding "$shell_active/bindings.env" MOMO_PITR_EXPECT_RUN_ID "\$(touch $marker)"
expect_red_before_docker shell_active "$shell_active" 'shell-active or invalid value for MOMO_PITR_EXPECT_RUN_ID'
[ ! -e "$marker" ] || fail "dotenv shell injection executed"

forged_pass=$(make_bundle forged-pass)
printf '%s\n' '{"Result":"PASS","result":"PASS"}' >"$forged_pass/evidence.json"
chmod 600 "$forged_pass/evidence.json"
expect_red_before_docker forged_pass "$forged_pass" 'PITR evidence envelope has an invalid shape'

tampered_signature=$(make_bundle tampered-signature)
python3 - "$tampered_signature/evidence.json" <<'PY'
import json
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["payload"]["marker_b_count"] = 1
path.write_text(json.dumps(value) + "\n")
path.chmod(0o600)
PY
expect_red_before_docker tampered_signature "$tampered_signature" 'signature verification failed'

stale_evidence=$(make_bundle stale-evidence)
python3 - "$stale_evidence/evidence.json" "$stale_evidence/evidence-hmac-key" <<'PY'
import hashlib
import hmac
import json
import pathlib
import sys
from datetime import datetime, timedelta, timezone

path = pathlib.Path(sys.argv[1])
key = pathlib.Path(sys.argv[2]).read_bytes().removesuffix(b"\n")
value = json.loads(path.read_text())
completed = datetime.now(timezone.utc) - timedelta(hours=1)
started = completed - timedelta(seconds=21)
times = {
    "started_at": started,
    "source_backup_completed_at": started + timedelta(seconds=10),
    "recovery_target_time": started + timedelta(seconds=11),
    "restored_at": completed - timedelta(seconds=1),
    "completed_at": completed,
}
for name, timestamp in times.items():
    value["payload"][name] = timestamp.isoformat(timespec="microseconds").replace("+00:00", "Z")
canonical = json.dumps(
    value["payload"],
    sort_keys=True,
    separators=(",", ":"),
    ensure_ascii=False,
).encode()
value["signature"] = hmac.new(
    key,
    b"momo-pitr-evidence/v1\n" + canonical,
    hashlib.sha256,
).hexdigest()
path.write_text(json.dumps(value) + "\n")
path.chmod(0o600)
PY
expect_red_before_docker stale_evidence "$stale_evidence" 'PITR evidence is older than 15 minutes'

wrong_cipher=$(make_bundle wrong-cipher)
chmod 600 "$wrong_cipher/postgres-cipher"
printf '%s\n' 'different-cipher-0123456789abcdef0123456789abcdef0123456789' >"$wrong_cipher/postgres-cipher"
chmod 400 "$wrong_cipher/postgres-cipher"
expect_red_before_docker wrong_cipher "$wrong_cipher" 'repository cipher files differ'

equal_trust_secrets=$(make_bundle equal-trust-secrets)
chmod 600 "$equal_trust_secrets/evidence-hmac-key"
cp "$equal_trust_secrets/migrate-cipher" "$equal_trust_secrets/evidence-hmac-key"
chmod 400 "$equal_trust_secrets/evidence-hmac-key"
expect_red_before_docker equal_trust_secrets "$equal_trust_secrets" \
  'PITR HMAC key and repository cipher must be distinct'

bad_restore_suffix=$(make_bundle bad-restore-suffix)
replace_binding "$bad_restore_suffix/bindings.env" MOMO_PITR_EXPECT_RESTORE_VOLUME \
  "momo-pitr-gate-20260812T030000Z-restore"
expect_red_before_docker bad_restore_suffix "$bad_restore_suffix" \
  'MOMO_PITR_EXPECT_RESTORE_VOLUME is not bound to the run id'

missing_backup=$(make_bundle missing-backup)
drop_binding "$missing_backup/backup.env" PGBACKREST_REPO_VOLUME_NAME
expect_red_before_docker missing_backup "$missing_backup" 'missing required keys: PGBACKREST_REPO_VOLUME_NAME'

duplicate_backup=$(make_bundle duplicate-backup)
printf '%s\n' 'PGBACKREST_REPO_VOLUME_NAME=second-repo' >>"$duplicate_backup/backup.env"
expect_red_before_docker duplicate_backup "$duplicate_backup" 'duplicate key PGBACKREST_REPO_VOLUME_NAME'

unknown_backup=$(make_bundle unknown-backup)
printf '%s\n' 'PGBACKREST_REPO1_TYPE=s3' >>"$unknown_backup/backup.env"
expect_red_before_docker unknown_backup "$unknown_backup" 'unknown keys: PGBACKREST_REPO1_TYPE'

overlap_backup=$(make_bundle overlap-backup)
printf '%s\n' "MOMO_PGBACKREST_CIPHER_FILE=$overlap_backup/postgres-cipher" >>"$overlap_backup/operator.env"
expect_red_before_docker overlap_backup "$overlap_backup" 'operator and backup env files overlap: MOMO_PGBACKREST_CIPHER_FILE'

duplicate_operator=$(make_bundle duplicate-operator)
printf '%s\n' 'MOMO_RUST_IMAGE=busybox:latest' >>"$duplicate_operator/operator.env"
expect_red_before_docker duplicate_operator "$duplicate_operator" 'duplicate key MOMO_RUST_IMAGE'

compose_control=$(make_bundle compose-control)
printf '%s\n' 'COMPOSE_FILE=/tmp/attacker-compose.yml' >>"$compose_control/operator.env"
expect_red_before_docker compose_control "$compose_control" 'reserved control/bindings key: COMPOSE_FILE'

for override_key in \
  MOMO_IN_CONTAINER \
  MOMO_MIGRATIONS_DIR \
  MOMO_BOOTSTRAP_ROLES_SQL \
  MOMO_RUNTIME_ROLES_SQL \
  MOMO_SET_OWNER_SQL \
  MOMO_BOOTSTRAP_OWNER_SQL; do
  override_case=$(printf '%s' "$override_key" | tr '[:upper:]_' '[:lower:]-')
  override_bundle=$(make_bundle "override-$override_case")
  printf '%s=%s\n' "$override_key" /tmp/attacker.sql >>"$override_bundle/operator.env"
  expect_red_before_docker \
    "override_$override_case" \
    "$override_bundle" \
    "reserved control/bindings key: $override_key"
done

# This runner is never a bootstrap switch. All disabled/dual/empty-bootstrap
# flag combinations fail before Docker, so a populated production DB observes
# zero migration SQL even if a caller attempts a direct flag bypass here.
disabled=$(make_bundle disabled)
replace_binding "$disabled/bindings.env" MOMO_PITR_EVIDENCE_REQUIRED 0
expect_red_before_docker disabled "$disabled" 'requires MOMO_PITR_EVIDENCE_REQUIRED=1'

both_enabled=$(make_bundle both-enabled)
replace_binding "$both_enabled/bindings.env" MOMO_PITR_BOOTSTRAP_EMPTY 1
expect_red_before_docker both_enabled "$both_enabled" 'requires MOMO_PITR_BOOTSTRAP_EMPTY=0'

bootstrap_intent=$(make_bundle bootstrap-intent)
replace_binding "$bootstrap_intent/bindings.env" MOMO_PITR_EVIDENCE_REQUIRED 0
replace_binding "$bootstrap_intent/bindings.env" MOMO_PITR_BOOTSTRAP_EMPTY 1
expect_red_before_docker bootstrap_intent "$bootstrap_intent" 'requires MOMO_PITR_EVIDENCE_REQUIRED=1'

arbitrary_expected=$(make_bundle arbitrary-expected)
replace_binding "$arbitrary_expected/bindings.env" MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER 7599999999999999999
expect_red_before_docker arbitrary_expected "$arbitrary_expected" 'evidence and bindings disagree for source_system_identifier'

invalid_run_id=$(make_bundle invalid-run-id)
replace_binding "$invalid_run_id/bindings.env" MOMO_PITR_EXPECT_RUN_ID "$(printf 'a%.0s' {1..49})"
expect_red_before_docker invalid_run_id "$invalid_run_id" 'MOMO_PITR_EXPECT_RUN_ID has an invalid format'

printf '[test-pitr-gated-migrate] PASS\n'
