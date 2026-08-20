#!/usr/bin/env bash
# Focused fail-closed contract tests for #1330.  The restore RED matrix uses a
# fake Docker CLI and therefore cannot touch real containers or volumes.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd -P)"
RESTORE="$ROOT/scripts/pgbackrest_pitr_restore.sh"
VERIFY="$ROOT/scripts/verify_pgbackrest_pitr.sh"

fail() {
  printf '[test-pgbackrest-pitr] FAIL %s\n' "$*" >&2
  exit 1
}

for path in "$RESTORE" "$VERIFY" "$ROOT/infra/rust/pgbackrest.conf"; do
  [ -f "$path" ] || fail "missing path=$path"
done

fixture="$(mktemp -d "${TMPDIR:-/tmp}/momo-pitr-contract.XXXXXX")"
cleanup() {
  if [ -d "$fixture" ]; then
    find "$fixture" -depth -delete >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fake_bin="$fixture/bin"
mkdir "$fake_bin"
fake_log="$fixture/docker.log"
touch "$fake_log"

cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$FAKE_DOCKER_LOG"
printf '\n' >>"$FAKE_DOCKER_LOG"

case "${1:-} ${2:-}" in
  'volume inspect')
    volume="${!#}"
    if [ "${FAKE_DOCKER_CASE:-}" = ownership_collision ]; then
      [ "${FAKE_COLLISION_KIND:-}" = volume ] && [ "$volume" = "$FAKE_COLLISION_NAME" ]
      exit
    fi
    if [ "${FAKE_DOCKER_CASE:-}" = repo_down ] && [ "$volume" = "$FAKE_REPO_VOLUME" ]; then
      exit 1
    fi
    case "$volume" in
      "$FAKE_SOURCE_VOLUME") role=source ;;
      "$FAKE_REPO_VOLUME") role=repo ;;
      "$FAKE_RESTORE_VOLUME") role=restore ;;
      *) exit 1 ;;
    esac
    printf 'true|%s|%s|%s\n' "$FAKE_RUN_ID" "$role" "$FAKE_PROJECT"
    ;;
  'volume prune')
    if [ -n "${FAKE_FOREIGN_MARKER:-}" ] \
      && { [[ " $* " != *' -af '* ]] \
        || [[ " $* " != *" --filter label=com.momo.pitr.invocation-id=${FAKE_EXPECT_INVOCATION_ID} "* ]]; }; then
      find "$FAKE_FOREIGN_MARKER" -delete
    fi
    exit 0
    ;;
  'volume rm')
    if [ -n "${FAKE_FOREIGN_MARKER:-}" ] \
      && [[ " $* " == *" ${FAKE_FOREIGN_VOLUME} "* ]]; then
      find "$FAKE_FOREIGN_MARKER" -delete
    fi
    exit 0
    ;;
  'image inspect')
    if { [ "${FAKE_DOCKER_CASE:-}" = attach_cleanup ] \
      || [ "${FAKE_DOCKER_CASE:-}" = local_id ] \
      || [ "${FAKE_DOCKER_CASE:-}" = ownership_collision ]; } \
      && [ "${3:-}" = --format ]; then
      if [[ " $* " == *'org.opencontainers.image.revision'* ]]; then
        printf '%s\n' "${FAKE_IMAGE_REVISION:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
      else
        printf '%s\n' "$FAKE_IMAGE_ID"
      fi
    fi
    exit 0
    ;;
  create\ *)
    if [ "${FAKE_DOCKER_CASE:-}" = attach_cleanup ] \
      || [ "${FAKE_DOCKER_CASE:-}" = local_id ] \
      || [ "${FAKE_DOCKER_CASE:-}" = ownership_collision ]; then
      printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    fi
    exit 0
    ;;
  cp\ *)
    if [ "${FAKE_DOCKER_CASE:-}" = ownership_collision ]; then
      destination="${!#}"
      mkdir -p "$destination"
      printf 'SELECT 1;\n' >"$destination/001_fixture.sql"
      exit 0
    fi
    { [ "${FAKE_DOCKER_CASE:-}" = attach_cleanup ] \
      || [ "${FAKE_DOCKER_CASE:-}" = local_id ]; } && exit 55
    ;;
  'container inspect')
    if [ "${3:-}" = --format ]; then
      printf '%s\n' "${FAKE_SOURCE_CONTAINER_ID:-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee}"
      exit 0
    fi
    if [ "${FAKE_DOCKER_CASE:-}" = ownership_collision ] \
      && [ "${FAKE_COLLISION_KIND:-}" = container ] \
      && [ "${3:-}" = "$FAKE_COLLISION_NAME" ]; then
      exit 0
    fi
    exit 1
    ;;
  'ps -aq')
    if [ "${FAKE_DOCKER_CASE:-}" = mounted ]; then
      printf 'stopped-target\n'
    elif [ "${FAKE_DOCKER_CASE:-}" = restore_fail ] \
      && [[ " $* " == *com.momo.pitr.invocation-id=* ]]; then
      printf '%s\n' 'deadbeefcafe'
    elif [ "${FAKE_DOCKER_CASE:-}" = attach_cleanup ] \
      && [[ " $* " == *com.momo.pitr.invocation-id=* ]]; then
      printf '%s\n' "$FAKE_ORPHAN_CONTAINER"
    fi
    ;;
  'inspect --format')
    if [ "${FAKE_DOCKER_CASE:-}" = mounted ]; then
      printf '%s\n' "$FAKE_RESTORE_VOLUME"
    fi
    ;;
  'run --rm')
    arguments=" $* "
    if [[ "$arguments" == *"-target-preflight-"* ]] \
      && [ "${FAKE_DOCKER_CASE:-}" = nonempty ]; then
      exit 1
    fi
    if [[ "$arguments" == *"-target-preflight-"* ]] \
      && [ "${FAKE_DOCKER_CASE:-}" = container_race ]; then
      exit 125
    fi
    if [[ "$arguments" == *"-restore-job-"* ]] \
      && [ "${FAKE_DOCKER_CASE:-}" = restore_fail ]; then
      exit 42
    fi
    ;;
  'rm -f') exit 0 ;;
  'volume ls')
    :
    ;;
  'network inspect')
    if [ "${FAKE_DOCKER_CASE:-}" = ownership_collision ] \
      && [ "${FAKE_COLLISION_KIND:-}" = network ] \
      && [ "${3:-}" = "$FAKE_COLLISION_NAME" ]; then
      exit 0
    fi
    exit 1
    ;;
  'network ls')
    [ "${FAKE_DOCKER_CASE:-}" = attach_cleanup ] \
      && printf '%s\n' 'facefeedcafe'
    ;;
  'network rm') exit 0 ;;
esac
SH
chmod +x "$fake_bin/docker"

run_id='contract-20260812-0001'
project='pitrcontract'
source_volume="momo-pitr-${run_id}-source"
repo_volume="momo-pitr-${run_id}-repo"
restore_volume="momo-pitr-${run_id}-restore"
resource_suffix='0123456789abcdef0123456789abcdef'
source_volume="${source_volume}-${resource_suffix}"
repo_volume="${repo_volume}-${resource_suffix}"
restore_volume="${restore_volume}-${resource_suffix}"
image_id="sha256:$(printf 'a%.0s' {1..64})"
target='2026-08-12T03:04:05.123456Z'
cipher="$fixture/cipher"
printf '%s\n' '0123456789abcdef0123456789abcdef0123456789abcdef' >"$cipher"
chmod 600 "$cipher"

invoke_restore() {
  local case_name="$1" source="$2" repo="$3" restore="$4" secret="$5"
  shift 5
  env \
    PATH="$fake_bin:$PATH" \
    FAKE_DOCKER_LOG="$fake_log" \
    FAKE_DOCKER_CASE="$case_name" \
    FAKE_RUN_ID="$run_id" \
    FAKE_PROJECT="$project" \
    FAKE_SOURCE_VOLUME="$source_volume" \
    FAKE_REPO_VOLUME="$repo_volume" \
    FAKE_RESTORE_VOLUME="$restore_volume" \
    "$@" \
    "$RESTORE" \
      --mode isolated --image "$image_id" --run-id "$run_id" --stanza momo \
      --compose-project "$project" \
      --source-volume "$source" --repo-volume "$repo" \
      --restore-volume "$restore" --target "$target" --cipher-secret "$secret"
}

expect_red() {
  local label="$1" expected="$2"
  shift 2
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$label unexpectedly passed"
  [[ "$output" == *"$expected"* ]] \
    || fail "$label wrong error expected=$expected output=$output"
}

: >"$fake_log"
invoke_restore positive "$source_volume" "$repo_volume" "$restore_volume" "$cipher" \
  | grep -Fq '[pgbackrest-restore] PASS' || fail "positive restore contract"
grep -Eq -- "--name momo-pitr-${run_id}-target-preflight-[0-9a-f]{32} " "$fake_log" \
  || fail "restore preflight container is not invocation suffixed"
grep -Eq -- "--name momo-pitr-${run_id}-restore-job-[0-9a-f]{32} " "$fake_log" \
  || fail "restore job container is not invocation suffixed"
# shellcheck disable=SC2016 # `$2` is the literal inner restore-shell argument.
restore_time_contract='--type=time --target="$2" --target-action=promote'
grep -Fq -- "$restore_time_contract" "$fake_log" \
  || fail "time target restore flags absent"
grep -Fq -- '--archive-mode=off restore' "$fake_log" \
  || fail "restore archive mode not forced off"

expect_red source_equals_target source_is_restore_target \
  invoke_restore default "$restore_volume" "$repo_volume" "$restore_volume" "$cipher"
expect_red unsuffixed_restore restore_volume_invocation_suffix_invalid \
  invoke_restore default "$source_volume" "$repo_volume" "momo-pitr-${run_id}-restore" "$cipher"
expect_red repo_unavailable 'volume_missing role=repo' \
  invoke_restore repo_down "$source_volume" "$repo_volume" "$restore_volume" "$cipher"
expect_red stopped_target_mounted restore_target_mounted \
  invoke_restore mounted "$source_volume" "$repo_volume" "$restore_volume" "$cipher"
expect_red nonempty_target restore_target_nonempty \
  invoke_restore nonempty "$source_volume" "$repo_volume" "$restore_volume" "$cipher"
expect_red missing_cipher cipher_secret_missing \
  invoke_restore default "$source_volume" "$repo_volume" "$restore_volume" "$fixture/missing"

multiline="$fixture/multiline"
printf '0123456789abcdef0123456789abcdef\nsecond-line\n' >"$multiline"
chmod 600 "$multiline"
expect_red multiline_cipher cipher_secret_not_single_line \
  invoke_restore default "$source_volume" "$repo_volume" "$restore_volume" "$multiline"

chmod 644 "$cipher"
expect_red writable_cipher cipher_secret_mode_not_owner_only \
  invoke_restore default "$source_volume" "$repo_volume" "$restore_volume" "$cipher"
chmod 600 "$cipher"

# A trailing LF is transport formatting, not secret entropy.  Equal effective
# payloads must be rejected before Docker even when only one file has that LF.
equal_hmac="$fixture/equal-hmac"
printf '%s' '0123456789abcdef0123456789abcdef0123456789abcdef' >"$equal_hmac"
chmod 600 "$equal_hmac"
equal_evidence="$fixture/equal-evidence"
mkdir "$equal_evidence"
chmod 700 "$equal_evidence"
: >"$fake_log"
expect_red equal_effective_secrets repository_cipher_and_hmac_key_must_be_distinct \
  env PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$fake_log" \
    FAKE_DOCKER_CASE=local_id FAKE_IMAGE_ID="$image_id" \
    FAKE_IMAGE_REVISION="$(printf 'b%.0s' {1..40})" \
    "$VERIFY" \
      --mode isolated --run-id equal-secrets-20260812 \
      --compose-project equalsecrets \
      --postgres-image-local-tag local-postgres:test \
      --candidate-migrate-image-local-tag local-candidate:test \
      --git-commit "$(printf 'b%.0s' {1..40})" \
      --cipher-secret "$cipher" --hmac-key "$equal_hmac" \
      --evidence-dir "$equal_evidence"
! grep -Fq 'create --name ' "$fake_log" \
  || fail "equal effective secrets reached candidate execution"

expect_red ambient_cipher_env ambient_pgbackrest_env_forbidden \
  invoke_restore default "$source_volume" "$repo_volume" "$restore_volume" "$cipher" \
    PGBACKREST_REPO1_CIPHER_PASS=forbidden
expect_red volume_injection volume_prefix_or_role_mismatch \
  invoke_restore default "${source_volume};touch" "$repo_volume" "$restore_volume" "$cipher"
expect_red path_injection cipher_secret_path_invalid \
  invoke_restore default "$source_volume" "$repo_volume" "$restore_volume" '/tmp/not allowed'

: >"$fake_log"
expect_red restore_failure '' \
  invoke_restore restore_fail "$source_volume" "$repo_volume" "$restore_volume" "$cipher"
grep -Fq "rm -f momo-pitr-${run_id}-restore-job" "$fake_log" \
  && fail "restore cleanup used a caller-derived container name"
grep -Fq 'rm -f deadbeefcafe' "$fake_log" \
  || fail "failed restore job owned by this invocation was not cleaned"
grep -Fq '/run/input/pgbackrest_repo1_cipher_pass' "$fake_log" \
  || fail "restore did not mount the caller cipher as an input"
grep -Fq 'install -o postgres -g postgres -m 0400' "$fake_log" \
  || fail "restore did not stage a postgres-owned cipher secret"

: >"$fake_log"
expect_red preflight_name_race restore_target_preflight_failed \
  invoke_restore container_race "$source_volume" "$repo_volume" "$restore_volume" "$cipher"
grep -Fq 'rm -f ' "$fake_log" \
  && fail "preflight name race deleted a foreign container"
grep -Fq 'com.momo.pitr.invocation-id=' "$fake_log" \
  || fail "restore helper did not bind cleanup ownership to an invocation label"

# Exercise the verifier's real EXIT cleanup in attach mode.  Even if the live
# source and repo already carry the caller's run-id label, only disposable
# run-scoped resources may appear in a remove argv.
attach_run_id='attach-cleanup-20260812-001'
attach_project='attachcleanup'
attach_source_container='live-postgres-source'
attach_source_volume='production-postgres-data'
attach_repo_volume='production-pgbackrest-repo'
attach_restore_volume="momo-pitr-${attach_run_id}-restore"
attach_resource_suffix='0123456789abcdef0123456789abcdef'
attach_actual_restore_volume="${attach_restore_volume}-${attach_resource_suffix}"
attach_orphan_container='deadbeefcafe'
attach_evidence="$fixture/attach-evidence"
attach_hmac="$fixture/hmac"
mkdir "$attach_evidence"
chmod 700 "$attach_evidence"
printf '%s\n' 'abcdef0123456789abcdef0123456789abcdef0123456789' >"$attach_hmac"
chmod 600 "$attach_hmac"
foreign_volume_marker="$fixture/foreign-volume-still-alive"
printf '%s\n' "$attach_actual_restore_volume" >"$foreign_volume_marker"
: >"$fake_log"

root_fake_bin="$fixture/root-bin"
mkdir "$root_fake_bin"
cp "$fake_bin/docker" "$root_fake_bin/docker"
cat >"$root_fake_bin/python3" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# stage_secret(source, destination, minimum) is the only Python operation
# reached before the deliberately injected candidate-image docker-cp failure.
if [ "$#" -eq 5 ] && [ "$1" = - ]; then
  cp "$2" "$3"
  chmod 600 "$3"
fi
SH
cat >"$root_fake_bin/jq" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$root_fake_bin/openssl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 3 ] && [ "$1" = rand ] && [ "$2" = -hex ] && [ "$3" = 16 ]; then
  printf '%s\n' '0123456789abcdef0123456789abcdef'
  exit 0
fi
exit 64
SH
chmod +x "$root_fake_bin/docker" "$root_fake_bin/python3" \
  "$root_fake_bin/jq" "$root_fake_bin/openssl"

set +e
docker run --rm --network none \
  --mount "type=bind,src=$ROOT,dst=/repo,readonly" \
  --mount "type=bind,src=$fixture,dst=/fixture" \
  -e PATH=/fixture/root-bin:/usr/bin:/bin \
  -e FAKE_DOCKER_LOG=/fixture/docker.log \
  -e FAKE_DOCKER_CASE=attach_cleanup \
  -e "FAKE_RUN_ID=$attach_run_id" \
  -e "FAKE_PROJECT=$attach_project" \
  -e "FAKE_SOURCE_CONTAINER=$attach_source_container" \
  -e "FAKE_ORPHAN_CONTAINER=$attach_orphan_container" \
  -e "FAKE_SOURCE_VOLUME=$attach_source_volume" \
  -e "FAKE_REPO_VOLUME=$attach_repo_volume" \
  -e "FAKE_RESTORE_VOLUME=$attach_restore_volume" \
  -e "FAKE_IMAGE_ID=$image_id" \
  -e "FAKE_IMAGE_REVISION=$(printf 'b%.0s' {1..40})" \
  -e "FAKE_FOREIGN_MARKER=/fixture/foreign-volume-still-alive" \
  -e "FAKE_FOREIGN_VOLUME=$attach_actual_restore_volume" \
  -e "FAKE_EXPECT_INVOCATION_ID=$attach_resource_suffix" \
  --entrypoint /bin/bash \
  debian:bookworm-slim -ceu '
    install -o root -g root -m 0600 /fixture/cipher /tmp/cipher
    install -o root -g root -m 0600 /fixture/hmac /tmp/hmac
    install -d -o root -g root -m 0700 /tmp/evidence
    exec /repo/scripts/verify_pgbackrest_pitr.sh \
      --mode attach --run-id "$FAKE_RUN_ID" --compose-project "$FAKE_PROJECT" \
      --postgres-image-ref "postgres@$FAKE_IMAGE_ID" \
      --candidate-migrate-image-ref "candidate@$FAKE_IMAGE_ID" \
      --git-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
      --cipher-secret /tmp/cipher --hmac-key /tmp/hmac \
      --evidence-dir /tmp/evidence --evidence-owner-uid 10001 \
      --source-container "$FAKE_SOURCE_CONTAINER" \
      --source-volume "$FAKE_SOURCE_VOLUME" \
      --repo-volume "$FAKE_REPO_VOLUME"
  ' >/dev/null 2>&1
attach_status=$?
set -e
[ "$attach_status" -eq 55 ] || fail "attach cleanup fixture did not reach injected cp failure"
! grep -Fq "rm -f $attach_source_container " "$fake_log" \
  || fail "attach cleanup attempted to remove the live source container"
! grep -Fq "volume rm $attach_source_volume " "$fake_log" \
  || fail "attach cleanup attempted to remove the live source volume"
! grep -Fq "volume rm $attach_repo_volume " "$fake_log" \
  || fail "attach cleanup attempted to remove the live repo volume"
! grep -Fq 'volume rm ' "$fake_log" \
  || fail "attach cleanup used a name-targeted volume removal"
grep -Fq "volume prune -af --filter label=com.momo.pitr.invocation-id=" "$fake_log" \
  || fail "attach cleanup did not use daemon-side all-volume label prune"
[ -f "$foreign_volume_marker" ] \
  || fail "cleanup deleted a foreign same-name replacement volume"
grep -Fq "rm -f $attach_orphan_container " "$fake_log" \
  || fail "attach cleanup did not remove a disposable orphan container"

set +e
attach_owner_output="$(env \
  PATH="$fake_bin:$PATH" \
  FAKE_DOCKER_LOG="$fake_log" \
  FAKE_DOCKER_CASE=attach_cleanup \
  FAKE_RUN_ID="$attach_run_id" \
  FAKE_PROJECT="$attach_project" \
  FAKE_SOURCE_CONTAINER="$attach_source_container" \
  FAKE_ORPHAN_CONTAINER="$attach_orphan_container" \
  FAKE_SOURCE_VOLUME="$attach_source_volume" \
  FAKE_REPO_VOLUME="$attach_repo_volume" \
  FAKE_RESTORE_VOLUME="$attach_restore_volume" \
  FAKE_IMAGE_ID="$image_id" \
  FAKE_IMAGE_REVISION="$(printf 'b%.0s' {1..40})" \
  "$VERIFY" \
    --mode attach --run-id "$attach_run_id" --compose-project "$attach_project" \
    --postgres-image-ref "postgres@${image_id}" \
    --candidate-migrate-image-ref "candidate@${image_id}" \
    --git-commit "$(printf 'b%.0s' {1..40})" \
    --cipher-secret "$cipher" --hmac-key "$attach_hmac" \
    --evidence-dir "$attach_evidence" \
    --source-container "$attach_source_container" \
    --source-volume "$attach_source_volume" --repo-volume "$attach_repo_volume" \
    2>&1)"
attach_owner_status=$?
set -e
[ "$attach_owner_status" -ne 0 ] \
  && [[ "$attach_owner_output" == *attach_evidence_owner_uid_required* ]] \
  || fail "attach mode accepted an implicit evidence owner"

# Classic Docker Engine may leave RepoDigests empty after a local-only build.
# The isolated launcher resolves each mutable tag exactly once to `.Id` and
# then executes only that sha256 ID, without inventing an OCI manifest digest.
local_evidence="$fixture/local-evidence"
mkdir "$local_evidence"
chmod 700 "$local_evidence"
: >"$fake_log"
set +e
local_output="$(env \
  PATH="$fake_bin:$PATH" \
  FAKE_DOCKER_LOG="$fake_log" \
  FAKE_DOCKER_CASE=local_id \
  FAKE_RUN_ID="$run_id" \
  FAKE_PROJECT="$project" \
  FAKE_SOURCE_VOLUME="$source_volume" \
  FAKE_REPO_VOLUME="$repo_volume" \
  FAKE_RESTORE_VOLUME="$restore_volume" \
  FAKE_IMAGE_ID="$image_id" \
  FAKE_IMAGE_REVISION="$(printf 'b%.0s' {1..40})" \
  "$VERIFY" \
    --mode isolated --run-id "$run_id" --compose-project "$project" \
    --postgres-image-local-tag local-postgres:test \
    --candidate-migrate-image-local-tag local-candidate:test \
    --git-commit "$(printf 'b%.0s' {1..40})" \
    --cipher-secret "$cipher" --hmac-key "$attach_hmac" \
    --evidence-dir "$local_evidence" \
    2>&1)"
local_status=$?
set -e
[ "$local_status" -eq 55 ] \
  || fail "local ID fixture did not reach injected cp failure output=$local_output"
! grep -Fq RepoDigests "$fake_log" || fail "local path depends on RepoDigests"
grep -Eq "create --name momo-pitr-${run_id}-migration-read-[0-9a-f]{32} " "$fake_log" \
  || fail "local image ID path did not reach immutable candidate execution"
grep -Fq "$image_id" "$fake_log" || fail "local image tag was not resolved to sha256 ID"

# Disposable names carry a cryptographically random invocation suffix and
# volume cleanup never addresses a name.  Therefore an own-created volume that
# is removed/replaced by a foreign same-name volume before EXIT cannot be
# deleted by this verifier; the daemon-side label filter is the authority.
# shellcheck disable=SC2016 # `$invocation_id` is literal source under test.
grep -Fq 'resource_suffix="$invocation_id"' "$VERIFY" \
  || fail "verifier resources are not invocation suffixed"
grep -Fq 'pg_clock_utc' "$VERIFY" \
  || fail "verify does not sample evidence timestamps from PostgreSQL clock_timestamp"
! grep -Fq 'utc_now' "$VERIFY" \
  || fail "verify still mixes host UTC with PostgreSQL clock_timestamp"
grep -Fq 'started_at="$(pg_clock_utc)"' "$VERIFY" \
  || fail "started_at is not sourced from the PostgreSQL clock"
grep -Fq 'restored_at="$(pg_clock_utc)"' "$VERIFY" \
  || fail "restored_at is not sourced from the PostgreSQL clock"
grep -Fq 'completed_at="$(pg_clock_utc)"' "$VERIFY" \
  || fail "completed_at is not sourced from the PostgreSQL clock"
grep -Fq 'ensure_pgbackrest_stanza' "$VERIFY" \
  || fail "verify does not skip stanza-create when the stanza already exists"
[ "$(grep -c '^ensure_pgbackrest_stanza$' "$VERIFY")" -eq 2 ] \
  || fail "verify does not prove same-repo stanza-create skip with a second call"
[ "$(grep -c 'source_pgbackrest stanza-create' "$VERIFY")" -eq 1 ] \
  || fail "verify must stanza-create only through the existence probe"
grep -Fq 'stanza %s exists; skip stanza-create' "$VERIFY" \
  || fail "verify does not log the existing-stanza skip"
grep -Fq 'no valid backups' "$VERIFY" \
  || fail "verify must not treat a missing stanza path as an existing stanza"
grep -Fq 'docker volume prune -af' "$VERIFY" \
  || fail "verifier volume cleanup is not daemon-side prune -a"
! grep -Eq 'docker volume (rm|remove)' "$VERIFY" \
  || fail "verifier contains name-targeted volume cleanup"

# OCI revision labels bind both immutable runtime images to the claimed source
# commit before any candidate extraction or database operation.
revision_evidence="$fixture/revision-evidence"
mkdir "$revision_evidence"
chmod 700 "$revision_evidence"
: >"$fake_log"
expect_red revision_mismatch postgres_image_revision_mismatch \
  env PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$fake_log" \
    FAKE_DOCKER_CASE=local_id FAKE_IMAGE_ID="$image_id" \
    FAKE_IMAGE_REVISION="$(printf 'e%.0s' {1..40})" \
    "$VERIFY" \
      --mode isolated --run-id revision-mismatch-20260812 \
      --compose-project revision \
      --postgres-image-local-tag local-postgres:test \
      --candidate-migrate-image-local-tag local-candidate:test \
      --git-commit "$(printf 'b%.0s' {1..40})" \
      --cipher-secret "$cipher" --hmac-key "$attach_hmac" \
      --evidence-dir "$revision_evidence"
! grep -Fq 'create --name ' "$fake_log" \
  || fail "revision mismatch reached candidate execution"

replay_run_id='evidence-replay-20260812'
replay_dir="$fixture/evidence-replay"
mkdir "$replay_dir"
chmod 700 "$replay_dir"
replay_json="$replay_dir/pgbackrest-pitr-${replay_run_id}.json"
printf '%s\n' 'operator-owned-existing-evidence' >"$replay_json"
replay_before="$(shasum -a 256 "$replay_json" | awk '{print $1}')"
: >"$fake_log"
expect_red evidence_replay_preserved evidence_already_exists \
  env PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$fake_log" \
    "$VERIFY" \
      --mode isolated --run-id "$replay_run_id" --compose-project replay \
      --postgres-image-local-tag never-reached-postgres \
      --candidate-migrate-image-local-tag never-reached-candidate \
      --git-commit "$(printf 'd%.0s' {1..40})" \
      --cipher-secret "$cipher" --hmac-key "$attach_hmac" \
      --evidence-dir "$replay_dir"
[ "$(shasum -a 256 "$replay_json" | awk '{print $1}')" = "$replay_before" ] \
  || fail "same-run retry modified existing evidence"
[ ! -s "$fake_log" ] || fail "evidence replay reached Docker before failing"

python3 - "$VERIFY" "$ROOT/server-rust/bins/momo-migrate/src/pitr.rs" \
  "$ROOT/server-rust/bins/momo-migrate/src/main.rs" "$ROOT/server-rust/Dockerfile" \
  "$ROOT/docs/runbooks/pgbackrest-pitr.md" <<'PY'
import pathlib
import re
import sys

producer = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
migrate = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
drop_probe = producer.split("drop_probe_best_effort() {", 1)[1].split("\n}\n", 1)[0]
assert "source_psql" not in drop_probe, drop_probe
assert "fail " not in drop_probe, drop_probe
assert "DROP SCHEMA IF EXISTS" in drop_probe
assert "cleanup_resources() {" in producer
assert "drop_probe_best_effort" in producer.split("cleanup_resources() {", 1)[1].split("\n}\n", 1)[0]
main = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
dockerfile = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")
runbook = pathlib.Path(sys.argv[5]).read_text(encoding="utf-8")

def object_keys(marker: str) -> list[str]:
    after = producer.split(marker, 1)[1]
    block = after.split("\n}", 1)[0]
    return re.findall(r'^\s+"([A-Z_a-z0-9]+)":', block, flags=re.MULTILINE)

payload_expected = {
    "result", "run_id", "started_at", "source_backup_completed_at",
    "recovery_target_time", "restored_at", "completed_at", "duration_seconds",
    "git_commit", "compose_project", "stanza", "postgres_image_ref",
    "postgres_image_digest", "postgres_image_id", "candidate_migrate_image_digest",
    "migrations_sha256", "postgres_version", "pgbackrest_version", "source_volume",
    "restore_volume", "repo_volume", "source_system_identifier",
    "restore_system_identifier", "cipher_type", "cipher_fingerprint_hmac_sha256",
    "backup_label", "backup_type", "backup_lsn_start", "backup_lsn_stop",
    "archive_wal_start", "archive_wal_stop", "marker_a_count", "marker_b_count",
    "archive_mode", "archive_command", "archive_timeout_seconds",
    "cleanup_container_leaks", "cleanup_volume_leaks",
}
payload_keys = object_keys("payload = {")
assert len(payload_keys) == len(set(payload_keys)) == 38, payload_keys
assert set(payload_keys) == payload_expected, set(payload_keys) ^ payload_expected

bindings_expected = {
    "MOMO_MIGRATE_ENV", "MOMO_PITR_EVIDENCE_REQUIRED",
    "MOMO_PITR_BOOTSTRAP_EMPTY", "MOMO_PITR_EVIDENCE_FILE",
    "MOMO_PITR_HMAC_KEY_FILE", "MOMO_PITR_MIGRATE_CIPHER_FILE",
    "MOMO_PITR_EXPECT_RUN_ID", "MOMO_PITR_EXPECT_GIT_COMMIT",
    "MOMO_PITR_EXPECT_COMPOSE_PROJECT", "MOMO_PITR_EXPECT_SOURCE_VOLUME",
    "MOMO_PITR_EXPECT_RESTORE_VOLUME", "MOMO_PITR_EXPECT_REPO_VOLUME",
    "MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST", "MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST",
    "MOMO_PITR_EXPECT_STANZA", "MOMO_PITR_EXPECT_CIPHER_TYPE",
    "MOMO_PITR_EXPECT_CIPHER_FINGERPRINT", "MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER",
    "MOMO_POSTGRES_PGBACKREST_IMAGE",
}
binding_keys = object_keys("bindings = {")
assert len(binding_keys) == len(set(binding_keys)) == 19, binding_keys
assert set(binding_keys) == bindings_expected, set(binding_keys) ^ bindings_expected

assert "docker stop" not in producer and "docker restart" not in producer
assert 'com.momo.pitr.invocation-id' in producer
assert 'source_psql --single-transaction' in producer
assert producer.index('probe_created=1') < producer.index('source_psql --single-transaction')
assert 'docker volume prune -af' in producer
assert '--filter "label=com.momo.pitr.invocation-id=$invocation_id"' in producer
assert not re.search(r"docker\s+volume\s+(?:rm|remove)\b", producer)
assert 'source_container_id="$(docker container inspect --format \'{{.Id}}\'' in producer
assert 'docker exec -i "$source_container_id"' in producer
assert 'docker exec --user postgres "$source_container_id"' in producer
assert 'restore_args+=(--source-container "$source_container_id")' in producer
assert '--network "container:$source_container_id"' in producer
assert not re.search(r'docker exec(?:\s+--user postgres)?\s+"\$source_container"', producer)
assert producer.index("cleanup_resources\ncleanup_container_leaks=") < producer.index("pairs = [")
assert '"$candidate_runtime_image" migrate' in producer
assert "'forged.json|evidence signature mismatch'" in producer
assert "'tampered.json|evidence signature mismatch'" in producer
assert "'expired.json|evidence is older than 15 minutes'" in producer
assert "candidate_red_reached_migration_sql" in producer
assert 'momo-pitr-cipher-fingerprint/v1\\n' in producer
assert 'const CIPHER_SECRET_PATH: &str = "/run/secrets/pgbackrest_repo1_cipher_pass"' in migrate
assert "a_rotated_repository_cipher_rejects_otherwise_valid_evidence" in migrate
assert "tamper_forged_unknown_and_duplicate_json_are_rejected" in migrate
assert "expired_future_and_fail_results_are_rejected" in migrate
assert "mixed_host_and_pg_clock_chronology_is_rejected" in migrate
assert "pg_clock_equal_adjacent_timestamps_are_accepted" in migrate
assert "live_pg_clock" in migrate
assert "PG_CLOCK_SQL" in migrate
assert "Utc::now()" not in migrate
assert "active_target_markers_archive_and_cleanup_are_fail_closed" in migrate
assert "production_image_paths_are_fixed_and_overrides_are_rejected" in main
for override in (
    "MOMO_MIGRATIONS_DIR", "MOMO_BOOTSTRAP_ROLES_SQL",
    "MOMO_RUNTIME_ROLES_SQL", "MOMO_SET_OWNER_SQL",
    "MOMO_BOOTSTRAP_OWNER_SQL",
):
    assert f'"{override}"' in main
    assert f"{override}=" not in dockerfile
assert dockerfile.count("ENV MOMO_IN_CONTAINER=1") == 1

# The first-transition copy/paste block must fail closed before it changes the
# database image: strict subshell, canonical refs, exact two-file rewrites,
# distinct effective secrets, and both pulls ordered before the DB-only up.
transition = runbook.split("NCP의 첫 전환 전에는", 1)[1].split("평상시 `backup.env`", 1)[0]
assert "(\nset -Eeuo pipefail\n" in transition
assert r'r"ghcr\.io/yeomyeonggeori/oort-postgres@sha256:[0-9a-f]{64}"' in transition
assert r'r"ghcr\.io/yeomyeonggeori/oort@sha256:[0-9a-f]{64}"' in transition
assert 'replace_exact(\n    preproof_path,\n    "MOMO_POSTGRES_PGBACKREST_IMAGE",\n    postgres,' in transition
assert 'replace_exact(operator_path, "MOMO_RUST_IMAGE", app)' in transition
for secret_guard in (
    'getattr(os, "O_NOFOLLOW", 0)', 'stat.S_ISREG',
    '(before.st_dev, before.st_ino, before.st_size)',
    'data[:-1] if data.endswith(b"\\n") else data',
    'hmac.compare_digest(read_secret(sys.argv[1]), read_secret(sys.argv[2]))',
):
    assert secret_guard in transition, secret_guard
app_pull = 'docker image pull "$APP_IMAGE_REF"'
postgres_pull = '-f docker-compose.rust.yml -f docker-compose.backup.yml pull postgres'
database_up = '-f docker-compose.rust.yml -f docker-compose.backup.yml \\\n  up -d --no-deps --wait postgres'
assert transition.index(app_pull) < transition.index(postgres_pull) < transition.index(database_up)

for relative in (
    "scripts/verify_openapi_contract_rust.sh",
    "scripts/verify_owner_bootstrap_rust.sh",
):
    consumer = (pathlib.Path(sys.argv[1]).parents[1] / relative).read_text(encoding="utf-8")
    required = (
        "MOMO_MIGRATE_ENV=development",
        "MOMO_PITR_EVIDENCE_REQUIRED=0",
        "MOMO_PITR_BOOTSTRAP_EMPTY=0",
    )
    for binding in required:
        assert consumer.count(binding) == 1, (relative, binding)
lane_overlay = (pathlib.Path(sys.argv[1]).parents[1] / "infra/rust/docker-compose.lane-phone.yml").read_text(
    encoding="utf-8"
)
for binding in (
    "MOMO_ENV: development",
    'MOMO_PITR_EVIDENCE_REQUIRED: "0"',
    'MOMO_PITR_BOOTSTRAP_EMPTY: "0"',
):
    assert lane_overlay.count(binding) == 1, binding
phone_launcher = (pathlib.Path(sys.argv[1]).parents[1] / "clients/mobile/scripts/lane-phone.sh").read_text(
    encoding="utf-8"
)
assert "MOMO_MIGRATE_ENV=" not in phone_launcher
assert "MOMO_PITR_" not in phone_launcher
PY

cargo test --quiet --manifest-path "$ROOT/server-rust/Cargo.toml" \
  -p momo-migrate pitr::tests

printf '[test-pgbackrest-pitr] PASS\n'
