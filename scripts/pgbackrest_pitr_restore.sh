#!/usr/bin/env bash
# Restore one pgBackRest backup into a new, inactive Docker volume.
#
# This is the destructive half of #1330, so its accepted input language is
# intentionally tiny.  The caller creates and labels all three volumes; this
# wrapper proves that the restore target is distinct, empty, and not mounted by
# *any* container (including stopped containers) before pgBackRest is invoked.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)"

fail() {
  printf '[pgbackrest-restore] RED %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: scripts/pgbackrest_pitr_restore.sh \
  --mode isolated|attach --image IMAGE_ID --run-id RUN_ID --stanza momo \
  --compose-project PROJECT [--source-container CONTAINER] \
  --source-volume VOLUME --repo-volume VOLUME --restore-volume VOLUME \
  --target 2026-08-12T12:34:56.123456Z --cipher-secret FILE
EOF
  exit 2
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_command name=$1"
}

portable_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

portable_uid() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

validate_secret_file() {
  local path="$1"
  local mode owner
  [[ "$path" == /* ]] || fail "cipher_secret_path_not_absolute"
  [[ "$path" =~ ^/[A-Za-z0-9._/+@%=-]+(/[A-Za-z0-9._+@%=-]+)*$ ]] \
    || fail "cipher_secret_path_invalid"
  [ ! -L "$path" ] || fail "cipher_secret_symlink"
  [ -f "$path" ] || fail "cipher_secret_missing"
  mode="$(portable_mode "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "cipher_secret_mode_unreadable"
  if (( 8#$mode & 077 )); then
    fail "cipher_secret_mode_not_owner_only"
  fi
  owner="$(portable_uid "$path")"
  if [ "$owner" != "$(id -u)" ] && [ "$owner" != "0" ]; then
    fail "cipher_secret_owner_untrusted"
  fi
  python3 - "$path" <<'PY' || fail "cipher_secret_not_single_line"
import pathlib
import sys

data = pathlib.Path(sys.argv[1]).read_bytes()
if data.endswith(b"\n"):
    data = data[:-1]
if not (32 <= len(data) <= 4096):
    raise SystemExit(1)
if b"\n" in data or b"\r" in data or b"\x00" in data:
    raise SystemExit(1)
PY
}

secret_identity() {
  local path="$1"
  if stat -f '%d:%i:%z:%Lp:%u' "$path" >/dev/null 2>&1; then
    stat -f '%d:%i:%z:%Lp:%u' "$path"
  else
    stat -c '%d:%i:%s:%a:%u' "$path"
  fi
}

assert_secret_identity() {
  local path="$1" expected="$2"
  [ ! -L "$path" ] && [ -f "$path" ] \
    || fail "cipher_secret_identity_changed"
  [ "$(secret_identity "$path")" = "$expected" ] \
    || fail "cipher_secret_identity_changed"
}

validate_volume() {
  local volume="$1" role="$2" expected
  local labels
  expected="momo-pitr-${run_id}-${role}-${resource_suffix}"
  if [ "$mode" = "isolated" ] || [ "$role" = "restore" ]; then
    [ "$volume" = "$expected" ] || fail "volume_prefix_or_role_mismatch role=$role"
  else
    [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
      || fail "volume_name_invalid role=$role"
  fi
  labels="$(docker volume inspect --format \
    '{{index .Labels "com.momo.pitr.managed"}}|{{index .Labels "com.momo.pitr.run-id"}}|{{index .Labels "com.momo.pitr.role"}}|{{index .Labels "com.docker.compose.project"}}' \
    "$volume" 2>/dev/null)" || fail "volume_missing role=$role"
  if [ "$mode" = "isolated" ] || [ "$role" = "restore" ]; then
    [ "$labels" = "true|$run_id|$role|$compose_project" ] \
      || fail "volume_label_mismatch role=$role"
  else
    case "$labels" in
      "|||$compose_project"|"true||$role|$compose_project") ;;
      *) fail "attached_volume_project_or_role_mismatch role=$role" ;;
    esac
  fi
}

source_mount_proof() {
  local labels mounts
  docker container inspect "$source_container" >/dev/null 2>&1 \
    || fail "source_container_missing"
  labels="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' \
    "$source_container")"
  [ "$labels" = "$compose_project" ] || fail "source_container_project_mismatch"
  mounts="$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{println .Type "|" .Name}}{{end}}{{end}}' \
    "$source_container")"
  [ "$mounts" = "volume | $source_volume" ] || fail "source_volume_mount_not_exact"
  [ "$(docker inspect --format '{{.State.Running}}' "$source_container")" = "true" ] \
    || fail "attached_source_not_running"
}

target_mounting_containers() {
  local container mounts
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    mounts="$(docker inspect --format \
      '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' \
      "$container" 2>/dev/null || true)"
    if printf '%s\n' "$mounts" | grep -Fxq "$restore_volume"; then
      printf '%s\n' "$container"
    fi
  done < <(docker ps -aq)
}

for env_name in $(compgen -e); do
  case "$env_name" in
    PGBACKREST_*|PGBACKREST) fail "ambient_pgbackrest_env_forbidden name=$env_name" ;;
  esac
done

mode=""
image=""
run_id=""
stanza=""
compose_project=""
source_container=""
source_volume=""
repo_volume=""
restore_volume=""
target=""
cipher_secret=""
seen_flags="|"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode|--image|--run-id|--stanza|--compose-project|--source-container|--source-volume|--repo-volume|--restore-volume|--target|--cipher-secret)
      flag="$1"
      [ "$#" -ge 2 ] || usage
      case "$seen_flags" in
        *"|$flag|"*) fail "duplicate_argument flag=$flag" ;;
      esac
      seen_flags="${seen_flags}${flag}|"
      value="$2"
      case "$flag" in
        --mode) mode="$value" ;;
        --image) image="$value" ;;
        --run-id) run_id="$value" ;;
        --stanza) stanza="$value" ;;
        --compose-project) compose_project="$value" ;;
        --source-container) source_container="$value" ;;
        --source-volume) source_volume="$value" ;;
        --repo-volume) repo_volume="$value" ;;
        --restore-volume) restore_volume="$value" ;;
        --target) target="$value" ;;
        --cipher-secret) cipher_secret="$value" ;;
      esac
      shift 2
      ;;
    -h|--help) usage ;;
    *) fail "unknown_argument" ;;
  esac
done

need docker
need grep
need python3

[ -n "$mode" ] && [ -n "$image" ] && [ -n "$run_id" ] && [ -n "$stanza" ] \
  && [ -n "$compose_project" ] \
  && [ -n "$source_volume" ] && [ -n "$repo_volume" ] \
  && [ -n "$restore_volume" ] && [ -n "$target" ] \
  && [ -n "$cipher_secret" ] || usage

[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$ ]] || fail "run_id_invalid"
[ "$mode" = "isolated" ] || [ "$mode" = "attach" ] || fail "mode_invalid"
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail "compose_project_invalid"
[ "$stanza" = "momo" ] || fail "stanza_invalid"
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "image_must_be_local_sha256_id"
[[ "$target" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$ ]] \
  || fail "target_not_rfc3339_utc"
pgbackrest_target="$(python3 - "$target" <<'PY'
import datetime
import sys
value = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
if value.utcoffset() != datetime.timedelta(0):
    raise SystemExit(1)
print(value.strftime("%Y-%m-%d %H:%M:%S.%f+00"))
PY
)" || fail "target_not_valid_utc"

validate_secret_file "$cipher_secret"
cipher_secret_identity="$(secret_identity "$cipher_secret")"
docker image inspect "$image" >/dev/null 2>&1 || fail "image_missing"

resource_suffix="${restore_volume##*-}"
[[ "$resource_suffix" =~ ^[0-9a-f]{32}$ ]] \
  || fail "restore_volume_invocation_suffix_invalid"
[ "$restore_volume" = "momo-pitr-${run_id}-restore-${resource_suffix}" ] \
  || fail "volume_prefix_or_role_mismatch role=restore"

[ "$source_volume" != "$restore_volume" ] || fail "source_is_restore_target"
[ "$source_volume" != "$repo_volume" ] || fail "source_is_repo_volume"
[ "$restore_volume" != "$repo_volume" ] || fail "restore_is_repo_volume"
validate_volume "$source_volume" source
validate_volume "$repo_volume" repo
validate_volume "$restore_volume" restore
if [ "$mode" = "attach" ]; then
  [[ "$source_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
    || fail "source_container_invalid"
  source_mount_proof
elif [ -n "$source_container" ]; then
  fail "source_container_forbidden_in_isolated_mode"
fi

mounted="$(target_mounting_containers)"
[ -z "$mounted" ] || fail "restore_target_mounted container=$mounted"

config_file="$ROOT/infra/rust/pgbackrest.conf"
[ ! -L "$config_file" ] && [ -f "$config_file" ] || fail "canonical_config_missing"
config_file="$(cd "$(dirname "$config_file")" && pwd -P)/$(basename "$config_file")"

invocation_id="$(openssl rand -hex 16)" || fail "invocation_id_generation_failed"
[[ "$invocation_id" =~ ^[0-9a-f]{32}$ ]] || fail "invocation_id_generation_failed"
preflight_container="momo-pitr-${run_id}-target-preflight-${invocation_id}"
restore_container="momo-pitr-${run_id}-restore-job-${invocation_id}"
cleanup() {
  local owned_id
  while IFS= read -r owned_id; do
    [ -z "$owned_id" ] && continue
    [[ "$owned_id" =~ ^[0-9a-f]{12,64}$ ]] || continue
    docker rm -f "$owned_id" >/dev/null 2>&1 || true
  done < <(docker ps -aq \
    --filter "label=com.momo.pitr.invocation-id=$invocation_id" 2>/dev/null || true)
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

for container in "$preflight_container" "$restore_container"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    fail "container_name_already_exists"
  fi
done

# Docker Desktop does not expose named-volume mountpoints to the macOS host.
# Inspect emptiness through the already-pinned PostgreSQL image, with no network
# and a read-only mount, then remove that container before pgBackRest starts.
preflight_status=0
docker run --rm --name "$preflight_container" \
  --label com.momo.pitr.managed=true \
  --label "com.momo.pitr.run-id=$run_id" \
  --label "com.momo.pitr.invocation-id=$invocation_id" \
  --label com.momo.pitr.role=preflight \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,src=$restore_volume,dst=/target,readonly" \
  --entrypoint /bin/sh "$image" \
  -ceu 'test -z "$(find /target -mindepth 1 -print -quit)"' \
  || preflight_status=$?
case "$preflight_status" in
  0) ;;
  1) fail "restore_target_nonempty" ;;
  *) fail "restore_target_preflight_failed" ;;
esac

mounted="$(target_mounting_containers)"
[ -z "$mounted" ] || fail "restore_target_mounted_after_preflight container=$mounted"
assert_secret_identity "$cipher_secret" "$cipher_secret_identity"

# Do not inherit image-level pgBackRest environment.  Every option is either a
# fixed literal, the validated time target, or the validated `momo` stanza.
docker run --rm --name "$restore_container" \
  --label com.momo.pitr.managed=true \
  --label "com.momo.pitr.run-id=$run_id" \
  --label "com.momo.pitr.invocation-id=$invocation_id" \
  --label com.momo.pitr.role=restore-job \
  --network none --security-opt no-new-privileges \
  --user 0:0 \
  --mount "type=volume,src=$restore_volume,dst=/var/lib/postgresql" \
  --mount "type=volume,src=$repo_volume,dst=/var/lib/pgbackrest,readonly" \
  --mount "type=bind,src=$config_file,dst=/etc/pgbackrest/pgbackrest.conf,readonly" \
  --mount "type=bind,src=$cipher_secret,dst=/run/input/pgbackrest_repo1_cipher_pass,readonly" \
  --tmpfs /tmp:rw,noexec,nosuid,size=67108864 \
  --entrypoint /bin/sh "$image" -ceu '
    mkdir -p /var/lib/postgresql/18
    chown postgres:postgres /var/lib/postgresql/18
    install -d -o postgres -g postgres -m 0700 /run/secrets
    install -o postgres -g postgres -m 0400 \
      /run/input/pgbackrest_repo1_cipher_pass \
      /run/secrets/pgbackrest_repo1_cipher_pass
    exec gosu postgres /usr/local/bin/oort-pgbackrest \
      --config=/etc/pgbackrest/pgbackrest.conf \
      --stanza="$1" \
      --pg1-path=/var/lib/postgresql/18/docker \
      --repo1-path=/var/lib/pgbackrest \
      --type=time --target="$2" --target-action=promote \
      --archive-mode=off restore
  ' sh "$stanza" "$pgbackrest_target"

printf '[pgbackrest-restore] PASS run_id=%s target=%s restore_volume=%s\n' \
  "$run_id" "$target" "$restore_volume"
