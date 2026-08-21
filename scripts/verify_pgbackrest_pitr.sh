#!/usr/bin/env bash
# PostgreSQL 18 + pgBackRest online-backup/time-target PITR closed loop (#1330).
#
# `isolated` creates and later removes a disposable source/repository/restore
# set. `attach` proves the same online-backup contract against the exact live
# source container and volumes supplied by a deployment wrapper.  Attach mode
# never stops the source database.  Both modes restore only to a new run-scoped
# volume and emit a signed, caller-bound evidence envelope after cleanup.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly SCHEMA='momo-pitr-evidence/v1'
readonly STANZA='momo'
readonly ARCHIVE_COMMAND='/usr/local/bin/oort-pgbackrest --stanza=momo archive-push %p'

fail() {
  printf '[pgbackrest-pitr] RED %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: scripts/verify_pgbackrest_pitr.sh \
  --mode isolated|attach --run-id RUN_ID --compose-project PROJECT \
  --postgres-image-ref REPOSITORY@sha256:DIGEST \
  --candidate-migrate-image-ref REPOSITORY@sha256:DIGEST \
  --git-commit 40HEX \
  --cipher-secret FILE --hmac-key FILE --evidence-dir DIR \
  [--evidence-owner-uid UID] \
  [--source-container NAME --source-volume NAME --repo-volume NAME] \
  [--restore-volume NAME] [--database NAME --database-user ROLE]

Attach mode requires source-container/source-volume/repo-volume.  Isolated mode
derives all three names from RUN_ID and rejects overrides.

For a local-only isolated rehearsal, replace both digest-ref options with
--postgres-image-local-tag TAG and --candidate-migrate-image-local-tag TAG.
The tags are resolved once to immutable local image IDs; evidence labels these
identities runtime-unverified.local-build-id and must never be used by attach.
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
  local path="$1" kind="$2" minimum="$3" allowed_owner="$4" mode owner
  [[ "$path" == /* ]] || fail "${kind}_path_not_absolute"
  [[ "$path" =~ ^/[A-Za-z0-9._/+@%=-]+(/[A-Za-z0-9._+@%=-]+)*$ ]] \
    || fail "${kind}_path_invalid"
  [ ! -L "$path" ] || fail "${kind}_symlink"
  [ -f "$path" ] || fail "${kind}_missing"
  mode="$(portable_mode "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "${kind}_mode_unreadable"
  if (( 8#$mode & 077 )); then
    fail "${kind}_mode_not_owner_only"
  fi
  owner="$(portable_uid "$path")"
  if [ "$owner" != "$(id -u)" ] && [ "$owner" != "0" ] \
    && [ "$owner" != "$allowed_owner" ]; then
    fail "${kind}_owner_untrusted"
  fi
  python3 - "$path" "$minimum" <<'PY' || fail "${kind}_not_one_valid_line"
import pathlib
import sys

data = pathlib.Path(sys.argv[1]).read_bytes()
if data.endswith(b"\n"):
    data = data[:-1]
if not (int(sys.argv[2]) <= len(data) <= 4096):
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
  local path="$1" expected="$2" kind="$3"
  [ ! -L "$path" ] && [ -f "$path" ] || fail "${kind}_identity_changed"
  [ "$(secret_identity "$path")" = "$expected" ] || fail "${kind}_identity_changed"
}

stage_secret() {
  local source="$1" destination="$2" minimum="$3" expected_identity="$4"
  python3 - "$source" "$destination" "$minimum" "$expected_identity" <<'PY' \
    || fail "secret_stage_failed"
import os
import pathlib
import stat
import sys

source, destination, minimum, expected = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
expected_parts = expected.split(":")
if len(expected_parts) != 5:
    raise SystemExit(1)
expected_identity = (
    int(expected_parts[0]), int(expected_parts[1]), int(expected_parts[2]),
    int(expected_parts[3], 8), int(expected_parts[4]),
)
flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(source, flags)
try:
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise SystemExit(1)
    actual_identity = (
        before.st_dev, before.st_ino, before.st_size,
        stat.S_IMODE(before.st_mode), before.st_uid,
    )
    if actual_identity != expected_identity:
        raise SystemExit(1)
    data = b""
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        data += chunk
        if len(data) > 4097:
            raise SystemExit(1)
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size):
        raise SystemExit(1)
finally:
    os.close(fd)
payload = data[:-1] if data.endswith(b"\n") else data
if not (minimum <= len(payload) <= 4096) or any(c in payload for c in (b"\n", b"\r", b"\0")):
    raise SystemExit(1)
out = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(out, data)
    os.fsync(out)
finally:
    os.close(out)
PY
}

source_psql() {
  assert_source_running
  docker exec -i "$source_container_id" \
    psql -X -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" "$@"
}

# Single clock source for every evidence timestamp: PostgreSQL clock_timestamp()
# on the live source. Mixing host UTC with PG time is a false-RED chronology
# when the two clocks disagree by even a second.
pg_clock_utc() {
  local ts
  ts="$(source_psql -qAtc "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');")"
  [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$ ]] \
    || fail "pg_clock_utc_invalid value=$ts"
  printf '%s' "$ts"
}

restore_psql() {
  docker exec -i "$restored_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" "$@"
}

source_pgbackrest() {
  assert_source_running
  docker exec --user postgres "$source_container_id" \
    /usr/local/bin/oort-pgbackrest \
    --config=/etc/pgbackrest/pgbackrest.conf --stanza="$STANZA" "$@"
}

# stanza-create is not idempotent: a second attach/deploy against an existing
# repository fails closed and aborts the PITR loop. Probe info for the configured
# stanza and skip create when it is already present. A false-negative (info
# fails for any other reason) still attempts create, which is the first-run path.
ensure_pgbackrest_stanza() {
  local info_json
  assert_source_running
  if info_json="$(docker exec --user postgres "$source_container_id" \
      /usr/local/bin/oort-pgbackrest \
      --config=/etc/pgbackrest/pgbackrest.conf --stanza="$STANZA" \
      --output=json info 2>/dev/null)" \
    && jq -e --arg stanza "$STANZA" \
      'type=="array" and length>=1 and .[0].name==$stanza
       and ((.[0].status.message // "") == "ok"
            or (.[0].status.message // "") == "no valid backups")' \
      >/dev/null 2>&1 <<<"$info_json"; then
    printf '[pgbackrest-pitr] stanza %s exists; skip stanza-create\n' "$STANZA"
    return 0
  fi
  source_pgbackrest stanza-create
}

assert_source_running() {
  [[ "${source_container_id:-}" =~ ^[0-9a-f]{12,64}$ ]] \
    || fail "source_container_id_unavailable"
  docker container inspect "$source_container_id" >/dev/null 2>&1 \
    || fail "source_container_missing"
  [ "$(docker inspect --format '{{.State.Running}}' "$source_container_id" 2>/dev/null)" = true ] \
    || fail "source_container_not_running"
}

wait_for_postgres() {
  local container="$1" attempt=0
  until docker exec "$container" pg_isready -U "$database_user" -d "$database" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 90 ]; then
      docker logs "$container" >&2 || true
      fail "postgres_not_ready container=$container"
    fi
    sleep 1
  done
}

drop_probe_best_effort() {
  # EXIT-trap safe: do not go through the fail-closed source helper (that aborts
  # the trap and skips volume/network cleanup). Intermediate RED after
  # probe_created=1 still attempts DROP SCHEMA IF EXISTS.
  [ "${probe_created:-0}" -eq 1 ] || return 0
  if [ -z "${source_container_id:-}" ]; then
    printf '[pgbackrest-pitr] RED probe_cleanup_unverified reason=source_id_unset schema=%s\n' \
      "$probe_schema" >&2
    return 0
  fi
  if ! docker container inspect "$source_container_id" >/dev/null 2>&1; then
    printf '[pgbackrest-pitr] RED probe_cleanup_unverified reason=source_missing schema=%s\n' \
      "$probe_schema" >&2
    return 0
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$source_container_id" 2>/dev/null || true)" != true ]; then
    printf '[pgbackrest-pitr] RED probe_cleanup_unverified reason=source_not_running schema=%s\n' \
      "$probe_schema" >&2
    return 0
  fi
  if ! docker exec -i "$source_container_id" \
    psql -X -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" \
    -qAtc "DROP SCHEMA IF EXISTS \"$probe_schema\" CASCADE;" >/dev/null 2>&1; then
    printf '[pgbackrest-pitr] RED probe_cleanup_failed schema=%s\n' "$probe_schema" >&2
    return 0
  fi
  probe_created=0
}

cleanup_resources() {
  local container network
  set +e
  drop_probe_best_effort
  while IFS= read -r container; do
    [[ "$container" =~ ^[0-9a-f]{12,64}$ ]] || continue
    docker rm -f "$container" >/dev/null 2>&1
  done < <(docker ps -aq --filter "label=com.momo.pitr.invocation-id=$invocation_id" 2>/dev/null)
  # Volume names are not ownership capabilities.  A same-name foreign
  # replacement between list and rm must survive cleanup, so ask the daemon to
  # atomically prune only unused volumes that still carry our invocation label.
  docker volume prune -af \
    --filter "label=com.momo.pitr.invocation-id=$invocation_id" \
    >/dev/null 2>&1
  while IFS= read -r network; do
    [[ "$network" =~ ^[0-9a-f]{12,64}$ ]] \
      && docker network rm "$network" >/dev/null 2>&1
  done < <(docker network ls -q --filter "label=com.momo.pitr.invocation-id=$invocation_id" 2>/dev/null)
  if [ "${keep_scratch_for_evidence:-0}" -ne 1 ] \
    && [ -n "$scratch_dir" ] && [ -d "$scratch_dir" ]; then
    find "$scratch_dir" -depth -delete >/dev/null 2>&1
  fi
  set -e
}

cleanup_owned_final_artifacts() {
  [ -n "${artifact_ownership_manifest:-}" ] \
    && [ -f "$artifact_ownership_manifest" ] \
    && [ ! -L "$artifact_ownership_manifest" ] || return 0
  python3 - "$artifact_ownership_manifest" <<'PY' >/dev/null 2>&1 || true
import json
import os
import stat
import sys

manifest_path = sys.argv[1]
flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(manifest_path, flags)
try:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) & 0o077:
        raise SystemExit(1)
    raw = b""
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        raw += chunk
        if len(raw) > 65536:
            raise SystemExit(1)
finally:
    os.close(fd)

for item in json.loads(raw):
    path = item["final"]
    expected = (int(item["device"]), int(item["inode"]))
    try:
        actual = os.lstat(path)
    except FileNotFoundError:
        continue
    if stat.S_ISREG(actual.st_mode) and (actual.st_dev, actual.st_ino) == expected:
        os.unlink(path)
PY
}

cleanup_trap() {
  local status=$?
  if [ "$cleanup_complete" -ne 1 ]; then
    [ "$status" -ne 0 ] || status=1
    if [ "${published_complete:-0}" -ne 1 ]; then
      cleanup_owned_final_artifacts
    fi
    keep_scratch_for_evidence=0
    cleanup_resources
  fi
  exit "$status"
}

mode=""
run_id=""
compose_project=""
postgres_image_ref=""
candidate_image_ref=""
postgres_image_local_tag=""
candidate_image_local_tag=""
git_commit=""
cipher_secret=""
hmac_key=""
evidence_dir=""
evidence_owner_uid="$(id -u)"
evidence_owner_uid_explicit=0
source_container=""
source_volume=""
repo_volume=""
restore_volume=""
database="momo"
database_user="momo"
seen_flags='|'

for env_name in $(compgen -e); do
  case "$env_name" in
    PGBACKREST_*|PGBACKREST) fail "ambient_pgbackrest_env_forbidden name=$env_name" ;;
  esac
done

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode|--run-id|--compose-project|--postgres-image-ref|--candidate-migrate-image-ref|--postgres-image-local-tag|--candidate-migrate-image-local-tag|--git-commit|--cipher-secret|--hmac-key|--evidence-dir|--evidence-owner-uid|--source-container|--source-volume|--repo-volume|--restore-volume|--database|--database-user)
      flag="$1"
      [ "$#" -ge 2 ] || usage
      case "$seen_flags" in *"|$flag|"*) fail "duplicate_argument flag=$flag" ;; esac
      seen_flags="${seen_flags}${flag}|"
      value="$2"
      case "$flag" in
        --mode) mode="$value" ;;
        --run-id) run_id="$value" ;;
        --compose-project) compose_project="$value" ;;
        --postgres-image-ref) postgres_image_ref="$value" ;;
        --candidate-migrate-image-ref) candidate_image_ref="$value" ;;
        --postgres-image-local-tag) postgres_image_local_tag="$value" ;;
        --candidate-migrate-image-local-tag) candidate_image_local_tag="$value" ;;
        --git-commit) git_commit="$value" ;;
        --cipher-secret) cipher_secret="$value" ;;
        --hmac-key) hmac_key="$value" ;;
        --evidence-dir) evidence_dir="$value" ;;
        --evidence-owner-uid)
          evidence_owner_uid="$value"
          evidence_owner_uid_explicit=1
          ;;
        --source-container) source_container="$value" ;;
        --source-volume) source_volume="$value" ;;
        --repo-volume) repo_volume="$value" ;;
        --restore-volume) restore_volume="$value" ;;
        --database) database="$value" ;;
        --database-user) database_user="$value" ;;
      esac
      shift 2
      ;;
    -h|--help) usage ;;
    *) fail "unknown_argument" ;;
  esac
done

for command in docker grep jq openssl python3; do need "$command"; done
[ "$mode" = isolated ] || [ "$mode" = attach ] || fail "mode_invalid"
[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{15,47}$ ]] || fail "run_id_invalid"
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail "compose_project_invalid"
[[ "$git_commit" =~ ^[0-9a-f]{40}$ ]] || fail "git_commit_invalid"
[[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || fail "database_invalid"
[[ "$database_user" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || fail "database_user_invalid"
[[ "$evidence_owner_uid" =~ ^[0-9]+$ ]] || fail "evidence_owner_uid_invalid"
if [ "$evidence_owner_uid" != "$(id -u)" ] && [ "$(id -u)" != 0 ]; then
  fail "only_root_can_change_evidence_owner"
fi
if [ "$mode" = attach ]; then
  [ "$evidence_owner_uid_explicit" -eq 1 ] \
    || fail "attach_evidence_owner_uid_required"
  [ "$evidence_owner_uid" = 10001 ] \
    || fail "attach_evidence_owner_uid_must_be_10001"
fi
[ "$database" = momo ] || fail "database_must_match_canonical_config"
[ "$database_user" = momo ] || fail "database_user_must_match_canonical_config"
[[ "$evidence_dir" == /* ]] || fail "evidence_dir_not_absolute"
[[ "$evidence_dir" =~ ^/[A-Za-z0-9._/+@%=-]+(/[A-Za-z0-9._+@%=-]+)*$ ]] \
  || fail "evidence_dir_invalid"
umask 077
if [ -e "$evidence_dir" ]; then
  [ ! -L "$evidence_dir" ] && [ -d "$evidence_dir" ] \
    || fail "evidence_dir_not_real_directory"
else
  mkdir -p "$evidence_dir"
fi
evidence_mode="$(portable_mode "$evidence_dir")"
if (( 8#$evidence_mode & 077 )); then
  fail "evidence_dir_mode_not_owner_only"
fi
[ "$(portable_uid "$evidence_dir")" = "$(id -u)" ] \
  || fail "evidence_dir_owner_untrusted"
# Refuse a replay before the cleanup trap is armed.  A same-run retry must
# never interpret an operator's existing signed evidence as our own artifact.
json_file="$evidence_dir/pgbackrest-pitr-${run_id}.json"
md_file="$evidence_dir/pgbackrest-pitr-${run_id}.md"
env_file="$evidence_dir/pgbackrest-pitr-${run_id}.env"
migrate_cipher_file="$evidence_dir/pgbackrest-pitr-${run_id}.cipher"
for reserved in \
  "$json_file" "$md_file" "$env_file" "$migrate_cipher_file"; do
  [ ! -e "$reserved" ] && [ ! -L "$reserved" ] || fail "evidence_already_exists"
done
validate_secret_file "$cipher_secret" cipher_secret 32 999
validate_secret_file "$hmac_key" hmac_key 32 10001
cipher_secret_host_path="$cipher_secret"
hmac_key_host_path="$hmac_key"
cipher_input_identity="$(secret_identity "$cipher_secret")"
hmac_input_identity="$(secret_identity "$hmac_key")"

if [ -n "$postgres_image_local_tag" ] || [ -n "$candidate_image_local_tag" ]; then
  [ "$mode" = isolated ] || fail "local_image_tags_forbidden_in_attach"
  [ -z "$postgres_image_ref" ] && [ -z "$candidate_image_ref" ] \
    || fail "image_ref_and_local_tag_are_mutually_exclusive"
  [ -n "$postgres_image_local_tag" ] && [ -n "$candidate_image_local_tag" ] \
    || fail "both_local_image_tags_required"
  for local_tag in "$postgres_image_local_tag" "$candidate_image_local_tag"; do
    [[ "$local_tag" =~ ^[A-Za-z0-9._/:+-]{1,255}$ ]] \
      && [[ "$local_tag" != *@* ]] \
      || fail "local_image_tag_invalid"
  done
  docker image inspect "$postgres_image_local_tag" >/dev/null 2>&1 \
    || fail "postgres_local_image_missing"
  docker image inspect "$candidate_image_local_tag" >/dev/null 2>&1 \
    || fail "candidate_local_image_missing"
  postgres_image_id="$(docker image inspect --format '{{.Id}}' "$postgres_image_local_tag")"
  candidate_runtime_image="$(docker image inspect --format '{{.Id}}' "$candidate_image_local_tag")"
  postgres_image_digest="$postgres_image_id"
  candidate_migrate_image_digest="$candidate_runtime_image"
  postgres_image_ref="runtime-unverified.local-build-id/oort-postgres@${postgres_image_id}"
  candidate_image_ref="runtime-unverified.local-build-id/oort-migrate@${candidate_runtime_image}"
else
  [[ "$postgres_image_ref" =~ ^[A-Za-z0-9._/:+-]+@sha256:[0-9a-f]{64}$ ]] \
    || fail "postgres_image_ref_not_digest_pinned"
  [[ "$candidate_image_ref" =~ ^[A-Za-z0-9._/:+-]+@sha256:[0-9a-f]{64}$ ]] \
    || fail "candidate_image_ref_not_digest_pinned"
  postgres_image_digest="${postgres_image_ref##*@}"
  candidate_migrate_image_digest="${candidate_image_ref##*@}"
  docker image inspect "$postgres_image_ref" >/dev/null 2>&1 || fail "postgres_image_not_local"
  docker image inspect "$candidate_image_ref" >/dev/null 2>&1 || fail "candidate_image_not_local"
  postgres_image_id="$(docker image inspect --format '{{.Id}}' "$postgres_image_ref")"
  candidate_runtime_image="$(docker image inspect --format '{{.Id}}' "$candidate_image_ref")"
fi
[[ "$postgres_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "postgres_image_id_invalid"
[[ "$candidate_runtime_image" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || fail "candidate_image_id_invalid"
postgres_runtime_image="$postgres_image_id"

postgres_image_revision="$(docker image inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$postgres_runtime_image" 2>/dev/null)" || fail "postgres_image_revision_missing"
candidate_image_revision="$(docker image inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$candidate_runtime_image" 2>/dev/null)" || fail "candidate_image_revision_missing"
[[ "$postgres_image_revision" =~ ^[0-9a-f]{40}$ ]] \
  || fail "postgres_image_revision_invalid"
[[ "$candidate_image_revision" =~ ^[0-9a-f]{40}$ ]] \
  || fail "candidate_image_revision_invalid"
[ "$postgres_image_revision" = "$git_commit" ] \
  || fail "postgres_image_revision_mismatch"
[ "$candidate_image_revision" = "$git_commit" ] \
  || fail "candidate_image_revision_mismatch"

invocation_id="$(openssl rand -hex 16)"
[[ "$invocation_id" =~ ^[0-9a-f]{32}$ ]] || fail "invocation_id_generation_failed"
resource_suffix="$invocation_id"

expected_source="momo-pitr-${run_id}-source-${resource_suffix}"
expected_repo="momo-pitr-${run_id}-repo-${resource_suffix}"
expected_restore="momo-pitr-${run_id}-restore-${resource_suffix}"
expected_source_container="momo-pitr-${run_id}-source-db-${resource_suffix}"
expected_candidate_container="momo-pitr-${run_id}-migration-read-${resource_suffix}"
network_name="momo-pitr-${run_id}-network-${resource_suffix}"
restored_container="momo-pitr-${run_id}-restored-db-${resource_suffix}"
validation_volume="momo-pitr-${run_id}-validation-${resource_suffix}"

if [ "$mode" = isolated ]; then
  [ -z "$source_container" ] && source_container="$expected_source_container"
  [ -z "$source_volume" ] && source_volume="$expected_source"
  [ -z "$repo_volume" ] && repo_volume="$expected_repo"
  [ -z "$restore_volume" ] && restore_volume="$expected_restore"
  [ "$source_container" = "$expected_source_container" ] || fail "isolated_source_container_override"
  [ "$source_volume" = "$expected_source" ] || fail "isolated_source_volume_override"
  [ "$repo_volume" = "$expected_repo" ] || fail "isolated_repo_volume_override"
else
  [ -n "$source_container" ] && [ -n "$source_volume" ] && [ -n "$repo_volume" ] \
    || fail "attach_source_bindings_required"
  [[ "$source_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || fail "source_container_invalid"
  [[ "$source_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || fail "source_volume_invalid"
  [[ "$repo_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || fail "repo_volume_invalid"
  [ -z "$restore_volume" ] || fail "attach_restore_volume_override_forbidden"
  restore_volume="$expected_restore"
  [ "$source_container" != "$expected_candidate_container" ] \
    && [ "$source_container" != "$restored_container" ] \
    || fail "attached_source_name_collides_with_disposable"
fi
[ "$restore_volume" = "$expected_restore" ] || fail "restore_volume_not_run_scoped"
[ "$source_volume" != "$restore_volume" ] || fail "source_is_restore_target"
[ "$source_volume" != "$repo_volume" ] || fail "source_is_repo"
[ "$restore_volume" != "$repo_volume" ] || fail "restore_is_repo"
[ "$source_volume" != "$validation_volume" ] \
  && [ "$repo_volume" != "$validation_volume" ] \
  || fail "attached_volume_collides_with_validation"

scratch_dir=""
candidate_container=""
candidate_container_id=""
source_container_id=""
restored_container_id=""
probe_created=0
keep_scratch_for_evidence=0
cleanup_complete=0
published_complete=0
artifact_ownership_manifest=""
trap cleanup_trap EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

scratch_dir="$(mktemp -d "$evidence_dir/.momo-pitr-${run_id}-${resource_suffix}.XXXXXX")"
[ "$(portable_mode "$scratch_dir")" = 700 ] \
  || fail "scratch_directory_mode_not_0700"
json_tmp="$scratch_dir/evidence.json"
md_tmp="$scratch_dir/evidence.md"
env_tmp="$scratch_dir/bindings.env"
migrate_cipher_tmp="$scratch_dir/migrate.cipher"
artifact_ownership_manifest="$scratch_dir/published-artifacts.json"
assert_secret_identity "$cipher_secret" "$cipher_input_identity" cipher_secret
assert_secret_identity "$hmac_key" "$hmac_input_identity" hmac_key
staged_cipher="$scratch_dir/pgbackrest_repo1_cipher_pass"
staged_hmac="$scratch_dir/momo_pitr_hmac_key"
stage_secret "$cipher_secret" "$staged_cipher" 32 "$cipher_input_identity"
stage_secret "$hmac_key" "$staged_hmac" 32 "$hmac_input_identity"
cipher_secret="$staged_cipher"
hmac_key="$staged_hmac"
cipher_staged_identity="$(secret_identity "$cipher_secret")"
hmac_staged_identity="$(secret_identity "$hmac_key")"
python3 - \
  "$cipher_secret" "$cipher_staged_identity" \
  "$hmac_key" "$hmac_staged_identity" <<'PY' \
  || fail "repository_cipher_and_hmac_key_must_be_distinct"
import hmac
import os
import stat
import sys

def read_identity(path: str, encoded: str) -> bytes:
    parts = encoded.split(":")
    if len(parts) != 5:
        raise SystemExit(1)
    expected = (int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3], 8), int(parts[4]))
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(fd)
        actual = (before.st_dev, before.st_ino, before.st_size,
                  stat.S_IMODE(before.st_mode), before.st_uid)
        if not stat.S_ISREG(before.st_mode) or actual != expected:
            raise SystemExit(1)
        data = b""
        while True:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            data += chunk
            if len(data) > 4097:
                raise SystemExit(1)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mode, before.st_uid) != \
           (after.st_dev, after.st_ino, after.st_size, after.st_mode, after.st_uid):
            raise SystemExit(1)
    finally:
        os.close(fd)
    return data[:-1] if data.endswith(b"\n") else data

if hmac.compare_digest(
    read_identity(sys.argv[1], sys.argv[2]),
    read_identity(sys.argv[3], sys.argv[4]),
):
    raise SystemExit(1)
PY
candidate_container="$expected_candidate_container"
candidate_container_id="$(docker create --name "$candidate_container" \
  --label com.momo.pitr.managed=true \
  --label "com.momo.pitr.run-id=$run_id" \
  --label "com.momo.pitr.invocation-id=$invocation_id" \
  --label com.momo.pitr.role=migration-read \
  --entrypoint /bin/true "$candidate_runtime_image")"
[[ "$candidate_container_id" =~ ^[0-9a-f]{12,64}$ ]] \
  || fail "candidate_container_id_invalid"
mkdir -p "$scratch_dir/migrations"
docker cp "$candidate_container_id:/opt/momo/migrations/." "$scratch_dir/migrations"
docker rm "$candidate_container_id" >/dev/null
candidate_container=""
candidate_container_id=""
migrations_sha256="$(python3 - "$scratch_dir/migrations" <<'PY'
import hashlib
import os
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
pattern = re.compile(r"^[0-9]{3}_.+\.sql$")
files = []
for entry in os.scandir(root):
    name_bytes = os.fsencode(entry.name)
    try:
        name_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SystemExit(f"non-UTF8 migration filename: {exc}")
    if b"\n" in name_bytes or b"\x00" in name_bytes:
        raise SystemExit("invalid migration filename")
    if pattern.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
        files.append((name_bytes, pathlib.Path(entry.path)))
if not files:
    raise SystemExit("empty migration set")
h = hashlib.sha256(b"momo-migrations/v1\n")
for name, path in sorted(files, key=lambda item: item[0]):
    data = path.read_bytes()
    h.update(name)
    h.update(b"\0")
    h.update(str(len(data)).encode("ascii"))
    h.update(b"\0")
    h.update(data)
    h.update(b"\n")
print(h.hexdigest())
PY
)"
[[ "$migrations_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "candidate_migrations_hash_invalid"

config_file="$ROOT/infra/rust/pgbackrest.conf"
[ ! -L "$config_file" ] && [ -f "$config_file" ] || fail "pgbackrest_config_missing"
config_file="$(cd "$(dirname "$config_file")" && pwd -P)/$(basename "$config_file")"

# The probe is owned by this invocation, not merely by the caller-supplied
# run-id.  Pre-arming cleanup is therefore safe even if CREATE's commit result
# becomes ambiguous after a connection failure.
probe_schema="momo_pitr_probe_${invocation_id:0:24}"

if [ "$mode" = isolated ]; then
  for existing in "$source_container" "$restored_container"; do
    ! docker container inspect "$existing" >/dev/null 2>&1 || fail "container_name_exists name=$existing"
  done
  for existing in "$source_volume" "$repo_volume" "$restore_volume" "$validation_volume"; do
    ! docker volume inspect "$existing" >/dev/null 2>&1 || fail "volume_name_exists name=$existing"
  done
  ! docker network inspect "$network_name" >/dev/null 2>&1 || fail "network_name_exists"
  docker network create \
    --label com.momo.pitr.managed=true \
    --label "com.momo.pitr.run-id=$run_id" \
    --label "com.momo.pitr.invocation-id=$invocation_id" \
    --label "com.docker.compose.project=$compose_project" \
    "$network_name" >/dev/null
  [ "$(docker network inspect --format '{{index .Labels "com.momo.pitr.invocation-id"}}' "$network_name")" = "$invocation_id" ] \
    || fail "network_ownership_not_acquired"
  for pair in "$source_volume:source" "$repo_volume:repo"; do
    volume="${pair%%:*}"
    role="${pair##*:}"
    docker volume create \
      --label com.momo.pitr.managed=true \
      --label "com.momo.pitr.run-id=$run_id" \
      --label "com.momo.pitr.invocation-id=$invocation_id" \
      --label "com.momo.pitr.role=$role" \
      --label "com.docker.compose.project=$compose_project" \
      "$volume" >/dev/null
    [ "$(docker volume inspect --format '{{index .Labels "com.momo.pitr.invocation-id"}}' "$volume")" = "$invocation_id" ] \
      || fail "volume_ownership_not_acquired role=$role"
  done
  docker run --rm \
    --label com.momo.pitr.managed=true \
    --label "com.momo.pitr.run-id=$run_id" \
    --label "com.momo.pitr.invocation-id=$invocation_id" \
    --network none --user 0:0 \
    --mount "type=volume,src=$repo_volume,dst=/repo" \
    --entrypoint /bin/sh "$postgres_runtime_image" \
    -ceu 'chown postgres:postgres /repo; chmod 750 /repo'
  source_container_id="$(docker run -d --name "$source_container" \
    --label com.momo.pitr.managed=true \
    --label "com.momo.pitr.run-id=$run_id" \
    --label "com.momo.pitr.invocation-id=$invocation_id" \
    --label com.momo.pitr.role=source-db \
    --label "com.docker.compose.project=$compose_project" \
    --network "$network_name" \
    -e POSTGRES_DB="$database" -e POSTGRES_USER="$database_user" \
    -e POSTGRES_PASSWORD=momo-pitr-disposable-only \
    --mount "type=volume,src=$source_volume,dst=/var/lib/postgresql" \
    --mount "type=volume,src=$repo_volume,dst=/var/lib/pgbackrest" \
    --mount "type=bind,src=$config_file,dst=/etc/pgbackrest/pgbackrest.conf,readonly" \
    --mount "type=bind,src=$cipher_secret,dst=/run/input/pgbackrest_repo1_cipher_pass,readonly" \
    --entrypoint /bin/sh "$postgres_runtime_image" -ceu '
      install -d -o postgres -g postgres -m 0700 /run/secrets
      install -o postgres -g postgres -m 0400 \
        /run/input/pgbackrest_repo1_cipher_pass \
        /run/secrets/pgbackrest_repo1_cipher_pass
      exec /usr/local/bin/docker-entrypoint.sh postgres \
        -c wal_level=replica \
        -c archive_mode=on \
        -c archive_timeout=60s \
        -c "archive_command=/usr/local/bin/oort-pgbackrest --stanza=momo archive-push %p"
    ')"
  [[ "$source_container_id" =~ ^[0-9a-f]{12,64}$ ]] \
    || fail "source_container_id_invalid"
  wait_for_postgres "$source_container_id"
else
  source_container_id="$(docker container inspect --format '{{.Id}}' \
    "$source_container" 2>/dev/null)" || fail "source_container_missing"
  [[ "$source_container_id" =~ ^[0-9a-f]{12,64}$ ]] \
    || fail "source_container_id_invalid"
  assert_source_running
  [ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$source_container_id")" = "$compose_project" ] \
    || fail "attached_source_project_mismatch"
  [ "$(docker inspect --format '{{.Image}}' "$source_container_id")" = "$postgres_image_id" ] \
    || fail "attached_source_image_mismatch"
  source_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{println .Type "|" .Name}}{{end}}{{end}}' "$source_container_id")"
  [ "$source_mount" = "volume | $source_volume" ] || fail "attached_source_volume_mismatch"
  repo_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/pgbackrest"}}{{println .Type "|" .Name}}{{end}}{{end}}' "$source_container_id")"
  [ "$repo_mount" = "volume | $repo_volume" ] || fail "attached_repo_volume_mismatch"
  for pair in "$source_volume:source" "$repo_volume:repo"; do
    volume="${pair%%:*}"
    role="${pair##*:}"
    labels="$(docker volume inspect --format \
      '{{index .Labels "com.momo.pitr.managed"}}|{{index .Labels "com.momo.pitr.role"}}|{{index .Labels "com.docker.compose.project"}}' \
      "$volume" 2>/dev/null)" || fail "attached_volume_missing role=$role"
    case "$labels" in
      "||$compose_project"|"true|$role|$compose_project") ;;
      *) fail "attached_volume_project_or_role_mismatch role=$role" ;;
    esac
  done
  ! docker volume inspect "$restore_volume" >/dev/null 2>&1 || fail "restore_volume_exists"
  ! docker volume inspect "$validation_volume" >/dev/null 2>&1 \
    || fail "validation_volume_exists"
  ! docker network inspect "$network_name" >/dev/null 2>&1 || fail "network_name_exists"
  docker network create \
    --label com.momo.pitr.managed=true \
    --label "com.momo.pitr.run-id=$run_id" \
    --label "com.momo.pitr.invocation-id=$invocation_id" \
    --label "com.docker.compose.project=$compose_project" \
    "$network_name" >/dev/null
  [ "$(docker network inspect --format '{{index .Labels "com.momo.pitr.invocation-id"}}' "$network_name")" = "$invocation_id" ] \
    || fail "network_ownership_not_acquired"
fi

archive_mode="$(source_psql -qAtc 'SHOW archive_mode;')"
archive_command="$(source_psql -qAtc 'SHOW archive_command;')"
archive_timeout="$(source_psql -qAtc "SELECT setting FROM pg_settings WHERE name='archive_timeout';")"
[ "$archive_mode" = on ] || fail "archive_mode_not_on"
[ "$archive_command" = "$ARCHIVE_COMMAND" ] || fail "archive_command_not_exact"
[ "$archive_timeout" = 60 ] || fail "archive_timeout_not_60"

source_system_identifier="$(source_psql -qAtc 'SELECT system_identifier::text FROM pg_control_system();')"
[[ "$source_system_identifier" =~ ^[0-9]+$ ]] || fail "source_system_identifier_invalid"
postgres_version="$(source_psql -qAtc 'SHOW server_version;')"
assert_source_running
pgbackrest_version="$(docker exec --user postgres "$source_container_id" \
  /usr/bin/pgbackrest version | sed 's/^pgBackRest //')"
[ "$pgbackrest_version" = 2.59.0 ] || fail "pgbackrest_version_drift"

started_at="$(pg_clock_utc)"
probe_created=1
source_psql --single-transaction -q -v run_id="$run_id" <<SQL
CREATE SCHEMA "$probe_schema";
CREATE TABLE "$probe_schema".marker (
  run_id text NOT NULL,
  marker text NOT NULL CHECK (marker IN ('A', 'B')),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, marker)
);
INSERT INTO "$probe_schema".marker (run_id, marker) VALUES (:'run_id', 'A');
SQL

ensure_pgbackrest_stanza
# Same-repo second pass: the first call creates on an empty repo, this one must
# skip. A bare second stanza-create is the 2nd-deploy RED this helper exists to
# prevent, and catching it here does not require a second full e2e.
ensure_pgbackrest_stanza
source_pgbackrest check
source_pgbackrest --type=full backup

source_backup_completed_at="$(pg_clock_utc)"
backup_pre_json="$(source_pgbackrest --output=json info)"
backup_stop_epoch="$(jq -er '.[0].backup | map(select(.type == "full" and .error == false)) | last | .timestamp.stop' <<<"$backup_pre_json")"
[[ "$backup_stop_epoch" =~ ^[0-9]+$ ]] || fail "backup_stop_epoch_invalid"
target_wait_attempt=0
while :; do
  source_epoch="$(source_psql -qAtc 'SELECT floor(extract(epoch FROM clock_timestamp()))::bigint;')"
  if [ "$source_epoch" -gt "$backup_stop_epoch" ]; then
    break
  fi
  target_wait_attempt=$((target_wait_attempt + 1))
  [ "$target_wait_attempt" -lt 10 ] || fail "source_clock_did_not_pass_backup_stop"
  sleep 1
done
recovery_target_time="$(pg_clock_utc)"
source_psql -q -v run_id="$run_id" <<SQL
INSERT INTO "$probe_schema".marker (run_id, marker) VALUES (:'run_id', 'B');
SQL
marker_order_ok="$(source_psql -qAt -v run_id="$run_id" -v target="$recovery_target_time" <<SQL
SELECT CASE WHEN
  count(*) FILTER (WHERE marker = 'A') = 1 AND
  count(*) FILTER (WHERE marker = 'B' AND committed_at > :'target'::timestamptz) = 1
THEN 'yes' ELSE 'no' END
FROM "$probe_schema".marker WHERE run_id = :'run_id';
SQL
)"
[ "$marker_order_ok" = yes ] || fail "marker_target_order_invalid"

b_wal_segment="$(source_psql -qAtc 'SELECT pg_walfile_name(pg_current_wal_lsn());')"
[[ "$b_wal_segment" =~ ^[0-9A-F]{24}$ ]] || fail "marker_b_wal_invalid"
source_psql -qAtc 'SELECT pg_switch_wal();' >/dev/null
archive_attempt=0
while :; do
  last_archived_wal="$(source_psql -qAtc "SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver;")"
  if [[ "$last_archived_wal" =~ ^[0-9A-F]{24}$ ]] \
    && [[ "$last_archived_wal" > "$b_wal_segment" || "$last_archived_wal" = "$b_wal_segment" ]]; then
    break
  fi
  archive_attempt=$((archive_attempt + 1))
  [ "$archive_attempt" -lt 60 ] || fail "marker_b_wal_not_archived"
  sleep 1
done
source_pgbackrest check
info_json="$(source_pgbackrest --output=json info)"
jq -e 'type == "array" and length == 1 and .[0].status.code == 0' \
  >/dev/null <<<"$info_json" || fail "pgbackrest_info_not_ok"
backup_label="$(jq -er '.[0].backup | map(select(.type == "full" and .error == false)) | last | .label' <<<"$info_json")"
backup_type="$(jq -er '.[0].backup | map(select(.label == $label)) | last | .type' --arg label "$backup_label" <<<"$info_json")"
backup_lsn_start="$(jq -er '.[0].backup | map(select(.label == $label)) | last | .lsn.start' --arg label "$backup_label" <<<"$info_json")"
backup_lsn_stop="$(jq -er '.[0].backup | map(select(.label == $label)) | last | .lsn.stop' --arg label "$backup_label" <<<"$info_json")"
archive_wal_start="$(jq -er '.[0].backup | map(select(.label == $label)) | last | .archive.start' --arg label "$backup_label" <<<"$info_json")"
backup_archive_stop="$(jq -er '.[0].backup | map(select(.label == $label)) | last | .archive.stop' --arg label "$backup_label" <<<"$info_json")"
archive_wal_stop="$(jq -er '[.[0].archive[].max | select(. != null)] | last' <<<"$info_json")"
[ "$backup_type" = full ] || fail "latest_backup_not_full"
[[ "$backup_lsn_start" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] || fail "backup_lsn_start_invalid"
[[ "$backup_lsn_stop" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] || fail "backup_lsn_stop_invalid"
[[ "$archive_wal_start" =~ ^[0-9A-F]{24}$ ]] || fail "archive_wal_start_invalid"
[[ "$backup_archive_stop" =~ ^[0-9A-F]{24}$ ]] || fail "backup_archive_stop_invalid"
[[ "$archive_wal_stop" =~ ^[0-9A-F]{24}$ ]] || fail "archive_wal_stop_invalid"
[[ "$archive_wal_stop" > "$backup_archive_stop" || "$archive_wal_stop" = "$backup_archive_stop" ]] \
  || fail "post_backup_archive_not_observed"
[[ "$archive_wal_stop" > "$b_wal_segment" || "$archive_wal_stop" = "$b_wal_segment" ]] \
  || fail "marker_b_archive_not_observed"

docker volume create \
  --label com.momo.pitr.managed=true \
  --label "com.momo.pitr.run-id=$run_id" \
  --label "com.momo.pitr.invocation-id=$invocation_id" \
  --label com.momo.pitr.role=restore \
  --label "com.docker.compose.project=$compose_project" \
  "$restore_volume" >/dev/null
[ "$(docker volume inspect --format '{{index .Labels "com.momo.pitr.invocation-id"}}' "$restore_volume")" = "$invocation_id" ] \
  || fail "restore_volume_ownership_not_acquired"

restore_args=(
  --mode "$mode" --image "$postgres_image_id" --run-id "$run_id"
  --stanza "$STANZA" --compose-project "$compose_project"
  --source-volume "$source_volume" --repo-volume "$repo_volume"
  --restore-volume "$restore_volume" --target "$recovery_target_time"
  --cipher-secret "$cipher_secret"
)
assert_secret_identity "$cipher_secret_host_path" "$cipher_input_identity" cipher_secret
assert_secret_identity "$cipher_secret" "$cipher_staged_identity" cipher_secret
if [ "$mode" = attach ]; then
  restore_args+=(--source-container "$source_container_id")
fi
"$ROOT/scripts/pgbackrest_pitr_restore.sh" "${restore_args[@]}"

restored_container_id="$(docker run -d --name "$restored_container" \
  --label com.momo.pitr.managed=true \
  --label "com.momo.pitr.run-id=$run_id" \
  --label "com.momo.pitr.invocation-id=$invocation_id" \
  --label com.momo.pitr.role=restored-db \
  --label "com.docker.compose.project=$compose_project" \
  --network "$network_name" \
  --mount "type=volume,src=$restore_volume,dst=/var/lib/postgresql" \
  --mount "type=volume,src=$repo_volume,dst=/var/lib/pgbackrest,readonly" \
  --mount "type=bind,src=$config_file,dst=/etc/pgbackrest/pgbackrest.conf,readonly" \
  --mount "type=bind,src=$cipher_secret,dst=/run/input/pgbackrest_repo1_cipher_pass,readonly" \
  --entrypoint /bin/sh "$postgres_runtime_image" -ceu '
    install -d -o postgres -g postgres -m 0700 /run/secrets
    install -o postgres -g postgres -m 0400 \
      /run/input/pgbackrest_repo1_cipher_pass \
      /run/secrets/pgbackrest_repo1_cipher_pass
    install -d -o postgres -g postgres -m 0700 /tmp/pgbackrest
    sed -i "s#/usr/bin/pgbackrest#/usr/local/bin/oort-pgbackrest#" \
      /var/lib/postgresql/18/docker/postgresql.auto.conf
    exec /usr/local/bin/docker-entrypoint.sh postgres
  ')"
[[ "$restored_container_id" =~ ^[0-9a-f]{12,64}$ ]] \
  || fail "restored_container_id_invalid"
wait_for_postgres "$restored_container_id"
restored_at="$(pg_clock_utc)"

marker_a_count="$(restore_psql -qAt -v run_id="$run_id" <<SQL
SELECT count(*) FROM "$probe_schema".marker WHERE run_id = :'run_id' AND marker = 'A';
SQL
)"
marker_b_count="$(restore_psql -qAt -v run_id="$run_id" <<SQL
SELECT count(*) FROM "$probe_schema".marker WHERE run_id = :'run_id' AND marker = 'B';
SQL
)"
[ "$marker_a_count" = 1 ] || fail "restored_marker_a_missing"
[ "$marker_b_count" = 0 ] || fail "restored_marker_b_present"
[ "$(restore_psql -qAtc 'SELECT pg_is_in_recovery();')" = f ] || fail "restore_still_in_recovery"
[ "$(restore_psql -qAtc 'SHOW archive_mode;')" = off ] || fail "restored_archive_mode_not_off"
restore_system_identifier="$(restore_psql -qAtc 'SELECT system_identifier::text FROM pg_control_system();')"
[ "$restore_system_identifier" = "$source_system_identifier" ] \
  || fail "restore_system_identifier_mismatch"

source_psql -qAtc "DROP SCHEMA \"$probe_schema\" CASCADE;" >/dev/null
probe_created=0
[ "$(source_psql -qAtc "SELECT count(*) FROM pg_namespace WHERE nspname='$probe_schema';")" = 0 ] \
  || fail "source_probe_cleanup_failed"

completed_at="$(pg_clock_utc)"
duration_seconds="$(python3 - "$started_at" "$completed_at" <<'PY'
import datetime
import sys
start = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
end = datetime.datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
print(max(1, int((end - start).total_seconds())))
PY
)"
cleanup_container_leaks=0
cleanup_volume_leaks=0

forged_evidence="$scratch_dir/candidate-forged-evidence.json"
tampered_evidence="$scratch_dir/candidate-tampered-evidence.json"
expired_evidence="$scratch_dir/candidate-expired-evidence.json"

export SCHEMA run_id started_at source_backup_completed_at recovery_target_time restored_at completed_at duration_seconds
export git_commit compose_project STANZA postgres_image_ref postgres_image_digest postgres_image_id
export candidate_migrate_image_digest migrations_sha256 postgres_version pgbackrest_version
export source_volume restore_volume repo_volume source_system_identifier restore_system_identifier
export backup_label backup_type backup_lsn_start backup_lsn_stop archive_wal_start archive_wal_stop
export marker_a_count marker_b_count archive_mode ARCHIVE_COMMAND cleanup_container_leaks cleanup_volume_leaks
export hmac_key_host_path
assert_secret_identity "$cipher_secret_host_path" "$cipher_input_identity" cipher_secret
assert_secret_identity "$cipher_secret" "$cipher_staged_identity" cipher_secret
assert_secret_identity "$hmac_key_host_path" "$hmac_input_identity" hmac_key
assert_secret_identity "$hmac_key" "$hmac_staged_identity" hmac_key
cipher_fingerprint="$(python3 - \
  "$hmac_key" "$hmac_staged_identity" \
  "$cipher_secret" "$cipher_staged_identity" <<'PY'
import hashlib
import hmac
import os
import stat
import sys

def read_identity(path: str, encoded: str) -> bytes:
    parts = encoded.split(":")
    if len(parts) != 5:
        raise SystemExit(1)
    expected = (int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3], 8), int(parts[4]))
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(fd)
        actual = (before.st_dev, before.st_ino, before.st_size,
                  stat.S_IMODE(before.st_mode), before.st_uid)
        if not stat.S_ISREG(before.st_mode) or actual != expected:
            raise SystemExit(1)
        chunks = []
        while True:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mode, before.st_uid) != \
           (after.st_dev, after.st_ino, after.st_size, after.st_mode, after.st_uid):
            raise SystemExit(1)
        return b"".join(chunks)
    finally:
        os.close(fd)

key = read_identity(sys.argv[1], sys.argv[2])
cipher = read_identity(sys.argv[3], sys.argv[4])
if key.endswith(b"\n"):
    key = key[:-1]
if cipher.endswith(b"\n"):
    cipher = cipher[:-1]
print(hmac.new(
    key,
    b"momo-pitr-cipher-fingerprint/v1\n" + cipher,
    hashlib.sha256,
).hexdigest())
PY
)"
[[ "$cipher_fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail "cipher_fingerprint_invalid"
export cipher_fingerprint
# The fingerprint helper and signer are separate reads.  Re-check both the
# operator paths and the staged immutable copies at the second trust boundary.
assert_secret_identity "$cipher_secret_host_path" "$cipher_input_identity" cipher_secret
assert_secret_identity "$cipher_secret" "$cipher_staged_identity" cipher_secret
assert_secret_identity "$hmac_key_host_path" "$hmac_input_identity" hmac_key
assert_secret_identity "$hmac_key" "$hmac_staged_identity" hmac_key
python3 - \
  "$hmac_key" "$hmac_staged_identity" \
  "$cipher_secret" "$cipher_staged_identity" \
  "$json_tmp" "$md_tmp" "$env_tmp" "$migrate_cipher_tmp" \
  "$json_file" "$migrate_cipher_file" "$evidence_owner_uid" \
  "$forged_evidence" "$tampered_evidence" "$expired_evidence" <<'PY'
import copy
import atexit
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import stat
import sys

created_paths = []
generation_complete = [False]

def cleanup_partial() -> None:
    if generation_complete[0]:
        return
    for path in reversed(created_paths):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

atexit.register(cleanup_partial)

def read_identity(path: str, encoded: str) -> bytes:
    parts = encoded.split(":")
    if len(parts) != 5:
        raise SystemExit(1)
    expected = (int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3], 8), int(parts[4]))
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(fd)
        actual = (before.st_dev, before.st_ino, before.st_size,
                  stat.S_IMODE(before.st_mode), before.st_uid)
        if not stat.S_ISREG(before.st_mode) or actual != expected:
            raise SystemExit(1)
        chunks = []
        while True:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mode, before.st_uid) != \
           (after.st_dev, after.st_ino, after.st_size, after.st_mode, after.st_uid):
            raise SystemExit(1)
        return b"".join(chunks)
    finally:
        os.close(fd)

key = read_identity(sys.argv[1], sys.argv[2])
if key.endswith(b"\n"):
    key = key[:-1]
cipher_raw = read_identity(sys.argv[3], sys.argv[4])
cipher = cipher_raw[:-1] if cipher_raw.endswith(b"\n") else cipher_raw
cipher_fingerprint = hmac.new(
    key,
    b"momo-pitr-cipher-fingerprint/v1\n" + cipher,
    hashlib.sha256,
).hexdigest()
if not hmac.compare_digest(cipher_fingerprint, os.environ["cipher_fingerprint"]):
    raise SystemExit("cipher fingerprint changed between reads")
payload = {
    "result": "PASS",
    "run_id": os.environ["run_id"],
    "started_at": os.environ["started_at"],
    "source_backup_completed_at": os.environ["source_backup_completed_at"],
    "recovery_target_time": os.environ["recovery_target_time"],
    "restored_at": os.environ["restored_at"],
    "completed_at": os.environ["completed_at"],
    "duration_seconds": int(os.environ["duration_seconds"]),
    "git_commit": os.environ["git_commit"],
    "compose_project": os.environ["compose_project"],
    "stanza": os.environ["STANZA"],
    "postgres_image_ref": os.environ["postgres_image_ref"],
    "postgres_image_digest": os.environ["postgres_image_digest"],
    "postgres_image_id": os.environ["postgres_image_id"],
    "candidate_migrate_image_digest": os.environ["candidate_migrate_image_digest"],
    "migrations_sha256": os.environ["migrations_sha256"],
    "postgres_version": os.environ["postgres_version"],
    "pgbackrest_version": os.environ["pgbackrest_version"],
    "source_volume": os.environ["source_volume"],
    "restore_volume": os.environ["restore_volume"],
    "repo_volume": os.environ["repo_volume"],
    "source_system_identifier": os.environ["source_system_identifier"],
    "restore_system_identifier": os.environ["restore_system_identifier"],
    "cipher_type": "aes-256-cbc",
    "cipher_fingerprint_hmac_sha256": cipher_fingerprint,
    "backup_label": os.environ["backup_label"],
    "backup_type": os.environ["backup_type"],
    "backup_lsn_start": os.environ["backup_lsn_start"],
    "backup_lsn_stop": os.environ["backup_lsn_stop"],
    "archive_wal_start": os.environ["archive_wal_start"],
    "archive_wal_stop": os.environ["archive_wal_stop"],
    "marker_a_count": int(os.environ["marker_a_count"]),
    "marker_b_count": int(os.environ["marker_b_count"]),
    "archive_mode": os.environ["archive_mode"],
    "archive_command": os.environ["ARCHIVE_COMMAND"],
    "archive_timeout_seconds": 60,
    "cleanup_container_leaks": int(os.environ["cleanup_container_leaks"]),
    "cleanup_volume_leaks": int(os.environ["cleanup_volume_leaks"]),
}
canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
signature = hmac.new(key, b"momo-pitr-evidence/v1\n" + canonical, hashlib.sha256).hexdigest()
envelope = {"schema": os.environ["SCHEMA"], "payload": payload, "signature": signature}

json_tmp = pathlib.Path(sys.argv[5])
md_tmp = pathlib.Path(sys.argv[6])
env_tmp = pathlib.Path(sys.argv[7])
migrate_cipher_tmp = pathlib.Path(sys.argv[8])
json_final = pathlib.Path(sys.argv[9])
migrate_cipher_final = pathlib.Path(sys.argv[10])
evidence_owner_uid = int(sys.argv[11])
forged_evidence = pathlib.Path(sys.argv[12])
tampered_evidence = pathlib.Path(sys.argv[13])
expired_evidence = pathlib.Path(sys.argv[14])

def exclusive_write(path: pathlib.Path, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    created_paths.append(path)

exclusive_write(
    json_tmp,
    (json.dumps(envelope, indent=2, sort_keys=True) + "\n").encode("utf-8"),
)

# These are candidate-binary RED probes, not publishable evidence.  A forged
# signature and a payload mutation must both stop at HMAC verification.  The
# expired variant is re-signed so it reaches and fails the freshness gate.
forged = copy.deepcopy(envelope)
forged["signature"] = "0" * 64
exclusive_write(
    forged_evidence,
    (json.dumps(forged, indent=2, sort_keys=True) + "\n").encode("utf-8"),
)
tampered = copy.deepcopy(envelope)
tampered["payload"]["marker_b_count"] = 1
exclusive_write(
    tampered_evidence,
    (json.dumps(tampered, indent=2, sort_keys=True) + "\n").encode("utf-8"),
)
expired = copy.deepcopy(envelope)
for field in (
    "started_at", "source_backup_completed_at", "recovery_target_time",
    "restored_at", "completed_at",
):
    timestamp = datetime.datetime.fromisoformat(
        expired["payload"][field].replace("Z", "+00:00")
    ) - datetime.timedelta(hours=1)
    expired["payload"][field] = timestamp.isoformat(
        timespec="microseconds"
    ).replace("+00:00", "Z")
expired_canonical = json.dumps(
    expired["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=False
).encode("utf-8")
expired["signature"] = hmac.new(
    key, b"momo-pitr-evidence/v1\n" + expired_canonical, hashlib.sha256
).hexdigest()
exclusive_write(
    expired_evidence,
    (json.dumps(expired, indent=2, sort_keys=True) + "\n").encode("utf-8"),
)
exclusive_write(md_tmp, "\n".join([
    "## pgBackRest time-target PITR evidence",
    f"- Result: `{payload['result']}`",
    f"- Run ID: `{payload['run_id']}`",
    f"- Commit: `{payload['git_commit']}`",
    f"- Source / restore / repo: `{payload['source_volume']}` / `{payload['restore_volume']}` / `{payload['repo_volume']}`",
    f"- PostgreSQL image: `{payload['postgres_image_ref']}` (`{payload['postgres_image_id']}`)",
    f"- PostgreSQL / pgBackRest: `{payload['postgres_version']}` / `{payload['pgbackrest_version']}`",
    f"- Backup: `{payload['backup_label']}` (`{payload['backup_type']}`, LSN `{payload['backup_lsn_start']}` → `{payload['backup_lsn_stop']}`)",
    f"- WAL: `{payload['archive_wal_start']}` → `{payload['archive_wal_stop']}`",
    f"- Recovery target: `{payload['recovery_target_time']}`",
    f"- Cipher fingerprint (HMAC): `{payload['cipher_fingerprint_hmac_sha256']}`",
    f"- Marker A / B: `{payload['marker_a_count']}` / `{payload['marker_b_count']}`",
    f"- Duration: `{payload['duration_seconds']}s`",
    f"- Cleanup container / volume leaks: `{payload['cleanup_container_leaks']}` / `{payload['cleanup_volume_leaks']}`",
    f"- Evidence signature: `{signature}`",
    "",
]).encode("utf-8"))

bindings = {
    "MOMO_MIGRATE_ENV": "production",
    "MOMO_PITR_EVIDENCE_REQUIRED": "1",
    "MOMO_PITR_BOOTSTRAP_EMPTY": "0",
    "MOMO_PITR_EVIDENCE_FILE": str(json_final),
    "MOMO_PITR_HMAC_KEY_FILE": os.environ["hmac_key_host_path"],
    "MOMO_PITR_MIGRATE_CIPHER_FILE": str(migrate_cipher_final),
    "MOMO_PITR_EXPECT_RUN_ID": payload["run_id"],
    "MOMO_PITR_EXPECT_GIT_COMMIT": payload["git_commit"],
    "MOMO_PITR_EXPECT_COMPOSE_PROJECT": payload["compose_project"],
    "MOMO_PITR_EXPECT_SOURCE_VOLUME": payload["source_volume"],
    "MOMO_PITR_EXPECT_RESTORE_VOLUME": payload["restore_volume"],
    "MOMO_PITR_EXPECT_REPO_VOLUME": payload["repo_volume"],
    "MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST": payload["postgres_image_digest"],
    "MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST": payload["candidate_migrate_image_digest"],
    "MOMO_PITR_EXPECT_STANZA": payload["stanza"],
    "MOMO_PITR_EXPECT_CIPHER_TYPE": payload["cipher_type"],
    "MOMO_PITR_EXPECT_CIPHER_FINGERPRINT": payload["cipher_fingerprint_hmac_sha256"],
    "MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER": payload["source_system_identifier"],
    "MOMO_POSTGRES_PGBACKREST_IMAGE": payload["postgres_image_ref"],
}
allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./:@%+=,-")
for name, value in bindings.items():
    if not value or any(ch not in allowed for ch in value) or "\n" in value or "\r" in value:
        raise SystemExit(f"unsafe dotenv binding: {name}")
exclusive_write(
    env_tmp,
    "".join(f"{name}={bindings[name]}\n" for name in sorted(bindings)).encode("utf-8"),
)
exclusive_write(migrate_cipher_tmp, cipher_raw)

for path in (json_tmp, md_tmp, env_tmp):
    os.chmod(path, 0o600)
for path in (json_tmp, md_tmp):
    os.chown(path, evidence_owner_uid, -1)
os.chmod(migrate_cipher_tmp, 0o400)
os.chown(migrate_cipher_tmp, evidence_owner_uid, -1)
generation_complete[0] = True
PY

# Exercise the *candidate binary*, not a host-side JSON parser, before any SQL
# could pass in production.  This is isolated-only: attach mode deliberately
# leaves the attended production migrate invocation to the compose wrapper.
if [ "$mode" = isolated ]; then
  docker volume create \
    --label com.momo.pitr.managed=true \
    --label "com.momo.pitr.run-id=$run_id" \
    --label "com.momo.pitr.invocation-id=$invocation_id" \
    --label com.momo.pitr.role=validation \
    --label "com.docker.compose.project=$compose_project" \
    "$validation_volume" >/dev/null
  [ "$(docker volume inspect --format '{{index .Labels "com.momo.pitr.invocation-id"}}' "$validation_volume")" = "$invocation_id" ] \
    || fail "validation_volume_ownership_not_acquired"
  docker run --rm --network none --user 0:0 \
    --mount "type=volume,src=$validation_volume,dst=/validation" \
    --mount "type=bind,src=$json_tmp,dst=/input/evidence.json,readonly" \
    --mount "type=bind,src=$forged_evidence,dst=/input/forged.json,readonly" \
    --mount "type=bind,src=$tampered_evidence,dst=/input/tampered.json,readonly" \
    --mount "type=bind,src=$expired_evidence,dst=/input/expired.json,readonly" \
    --mount "type=bind,src=$hmac_key_host_path,dst=/input/hmac,readonly" \
    --mount "type=bind,src=$migrate_cipher_tmp,dst=/input/cipher,readonly" \
    --entrypoint /bin/sh "$postgres_runtime_image" -ceu '
      install -o 10001 -g 10001 -m 0600 /input/evidence.json /validation/evidence.json
      install -o 10001 -g 10001 -m 0600 /input/forged.json /validation/forged.json
      install -o 10001 -g 10001 -m 0600 /input/tampered.json /validation/tampered.json
      install -o 10001 -g 10001 -m 0600 /input/expired.json /validation/expired.json
      install -o 10001 -g 10001 -m 0400 /input/hmac /validation/hmac
      install -o 10001 -g 10001 -m 0400 \
        /input/cipher /validation/pgbackrest_repo1_cipher_pass
    '
  run_candidate_migrate() {
    local evidence_name="$1"
    docker run --rm \
      --label com.momo.pitr.managed=true \
      --label "com.momo.pitr.run-id=$run_id" \
      --label "com.momo.pitr.invocation-id=$invocation_id" \
      --label com.momo.pitr.role=candidate-verifier \
      --network "container:$source_container_id" \
      --mount "type=volume,src=$validation_volume,dst=/run/secrets,readonly" \
      -e DATABASE_URL=postgres://momo:momo-pitr-disposable-only@127.0.0.1:5432/momo \
      -e MOMO_ENV=production \
      -e MOMO_PITR_EVIDENCE_REQUIRED=1 \
      -e MOMO_PITR_BOOTSTRAP_EMPTY=0 \
      -e "MOMO_PITR_EVIDENCE_PATH=/run/secrets/$evidence_name" \
      -e MOMO_PITR_HMAC_KEY_PATH=/run/secrets/hmac \
      -e "MOMO_PITR_EXPECT_RUN_ID=$run_id" \
      -e "MOMO_PITR_EXPECT_GIT_COMMIT=$git_commit" \
      -e "MOMO_PITR_EXPECT_COMPOSE_PROJECT=$compose_project" \
      -e "MOMO_PITR_EXPECT_SOURCE_VOLUME=$source_volume" \
      -e "MOMO_PITR_EXPECT_RESTORE_VOLUME=$restore_volume" \
      -e "MOMO_PITR_EXPECT_REPO_VOLUME=$repo_volume" \
      -e "MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST=$postgres_image_digest" \
      -e "MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST=$candidate_migrate_image_digest" \
      -e MOMO_PITR_EXPECT_STANZA=momo \
      -e MOMO_PITR_EXPECT_CIPHER_TYPE=aes-256-cbc \
      -e "MOMO_PITR_EXPECT_CIPHER_FINGERPRINT=$cipher_fingerprint" \
      -e "MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER=$source_system_identifier" \
      -e MOMO_BOOTSTRAP_RUNTIME_ROLES=1 \
      -e MOMO_AGENT_SEED_MODE=none \
      -e MIGRATE_IDEMPOTENCY_CHECK=1 \
      "$candidate_runtime_image" migrate
  }

  assert_candidate_sql_absent() {
    [ "$(source_psql -qAtc "SELECT to_regclass('public.schema_migrations') IS NULL;")" = t ] \
      || fail "candidate_red_reached_migration_sql"
  }

  for negative in \
    'forged.json|evidence signature mismatch' \
    'tampered.json|evidence signature mismatch' \
    'expired.json|evidence is older than 15 minutes'; do
    evidence_name="${negative%%|*}"
    expected_failure="${negative#*|}"
    assert_candidate_sql_absent
    set +e
    candidate_red_output="$(run_candidate_migrate "$evidence_name" 2>&1)"
    candidate_red_status=$?
    set -e
    [ "$candidate_red_status" -ne 0 ] \
      || fail "candidate_red_unexpected_pass evidence=$evidence_name"
    [[ "$candidate_red_output" == *"PITR gate: $expected_failure"* ]] \
      || fail "candidate_red_wrong_failure evidence=$evidence_name expected=$expected_failure"
    assert_candidate_sql_absent
    printf '[pgbackrest-pitr] expected RED evidence=%s reason=%s sql_reached=0\n' \
      "$evidence_name" "$expected_failure"
  done

  run_candidate_migrate evidence.json
fi

keep_scratch_for_evidence=1
cleanup_resources
cleanup_container_leaks="$(docker ps -aq --filter "label=com.momo.pitr.invocation-id=$invocation_id" | wc -l | tr -d '[:space:]')"
cleanup_volume_leaks="$(docker volume ls -q --filter "label=com.momo.pitr.invocation-id=$invocation_id" | wc -l | tr -d '[:space:]')"
cleanup_network_leaks="$(docker network ls -q --filter "label=com.momo.pitr.invocation-id=$invocation_id" | wc -l | tr -d '[:space:]')"
[ "$cleanup_container_leaks" = 0 ] || fail "cleanup_container_leak"
[ "$cleanup_volume_leaks" = 0 ] || fail "cleanup_volume_leak"
[ "$cleanup_network_leaks" = 0 ] || fail "cleanup_network_leak"

python3 - "$artifact_ownership_manifest" \
  "$json_tmp" "$json_file" \
  "$md_tmp" "$md_file" \
  "$env_tmp" "$env_file" \
  "$migrate_cipher_tmp" "$migrate_cipher_file" <<'PY'
import json
import os
import pathlib
import signal
import stat
import sys

manifest = pathlib.Path(sys.argv[1])
pairs = [(pathlib.Path(sys.argv[index]), pathlib.Path(sys.argv[index + 1]))
         for index in range(2, len(sys.argv), 2)]
ownership = []
for temporary, final in pairs:
    candidate = temporary.lstat()
    if not stat.S_ISREG(candidate.st_mode):
        raise SystemExit("candidate artifact is not a regular file")
    ownership.append({
        "final": str(final),
        "device": candidate.st_dev,
        "inode": candidate.st_ino,
    })

manifest_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
manifest_fd = os.open(manifest, manifest_flags, 0o600)
try:
    encoded = (json.dumps(ownership, sort_keys=True) + "\n").encode("utf-8")
    os.write(manifest_fd, encoded)
    os.fsync(manifest_fd)
finally:
    os.close(manifest_fd)

def interrupt(signum, frame):
    del frame
    raise InterruptedError(signum)

for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, interrupt)

def unlink_if_owned(final: pathlib.Path, expected: os.stat_result) -> None:
    try:
        actual = final.lstat()
    except FileNotFoundError:
        return
    if (stat.S_ISREG(actual.st_mode)
            and (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino)):
        final.unlink()

linked = []
try:
    for temporary, final in pairs:
        expected = temporary.lstat()
        os.link(temporary, final, follow_symlinks=False)
        linked.append((final, expected))
except BaseException:
    for final, expected in reversed(linked):
        unlink_if_owned(final, expected)
    raise
PY

# Returning from the publisher means all four hard links exist and have an
# inode-qualified ownership manifest.  From this point onward the evidence set
# is complete; an interrupt during scratch removal preserves the valid finals
# while the EXIT trap still removes the secret-bearing scratch directory.
published_complete=1
keep_scratch_for_evidence=0
[ -n "$scratch_dir" ] && [ -d "$scratch_dir" ] \
  || fail "scratch_directory_lost_before_cleanup"
find "$scratch_dir" -depth -delete
scratch_dir=""
cleanup_complete=1

printf '[pgbackrest-pitr] PASS run_id=%s evidence=%s\n' "$run_id" "$json_file"
