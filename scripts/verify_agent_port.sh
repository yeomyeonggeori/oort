#!/usr/bin/env bash
# ADR-0162 / #1363 Hosted Agent Port runtime verifier.
#
# Phase 1 runs the ignored conformance tests against an isolated PostgreSQL 18
# container and the real in-process Axum router. Phase 2 builds (or reuses) the
# deploy Rust image and drives one authenticated modern request through that
# image, proving the shipped entrypoint contains the same route.
#
# Optional inputs:
#   MOMO_RUST_IMAGE=<local image ref>  reuse a previously built deploy image
#   AGENT_PORT_VERIFY_IMAGE=0          skip phase 2 for a fast local iteration
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

fail() {
  printf '[agent-port] FAIL: %s\n' "$*" >&2
  exit 1
}

note() { printf '[agent-port] %s\n' "$*"; }

# Pure predicate used by every destructive cleanup. Keeping this separate makes
# the foreign-resource preservation rule testable without a Docker daemon.
owned_resource_matches() {
  local expected_id="$1" actual_id="$2" expected_label="$3" actual_label="$4"
  local expected_name="$5" actual_name="$6"
  [ -n "$expected_id" ] &&
    [ "$actual_id" = "$expected_id" ] &&
    [ "$actual_label" = "$expected_label" ] &&
    [ "$actual_name" = "$expected_name" ]
}

valid_docker_object_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
valid_docker_image_id() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }

DOCKER_BIN="${DOCKER_BIN:-docker}"
GREP_BIN="${GREP_BIN:-grep}"

# Pipe-free exact membership: `printf | grep -q` is unsafe under pipefail when
# grep finds an early line and printf exits 141/SIGPIPE. Return 0=found,
# 1=not found, 2=grep/read failure.
exact_ref_membership() {
  local refs="$1" ref="$2" grep_rc=0
  "$GREP_BIN" -Fqx -- "$ref" <<<"$refs" || grep_rc=$?
  case "$grep_rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

# Return 0=present/readable, 1=proven absent by a successful full listing,
# 2=daemon/read/parse ambiguity. An inspect error alone never proves absence:
# Docker uses the same non-zero status for "no such object" and daemon faults.
docker_full_refs() {
  local kind="$1"
  case "$kind" in
    container) "$DOCKER_BIN" ps -aq --no-trunc ;;
    network) "$DOCKER_BIN" network ls -q --no-trunc ;;
    volume) "$DOCKER_BIN" volume ls -q ;;
    image) "$DOCKER_BIN" image ls -aq --no-trunc ;;
    *) return 2 ;;
  esac
}

docker_query_state() {
  local kind="$1" ref="$2" format="$3" output_var="$4"
  local output refs membership_rc=0
  case "$kind" in
    container) output="$("$DOCKER_BIN" inspect --format "$format" "$ref" 2>/dev/null)" && {
      printf -v "$output_var" '%s' "$output"; return 0;
    } ;;
    network) output="$("$DOCKER_BIN" network inspect --format "$format" "$ref" 2>/dev/null)" && {
      printf -v "$output_var" '%s' "$output"; return 0;
    } ;;
    volume) output="$("$DOCKER_BIN" volume inspect --format "$format" "$ref" 2>/dev/null)" && {
      printf -v "$output_var" '%s' "$output"; return 0;
    } ;;
    image) output="$("$DOCKER_BIN" image inspect --format "$format" "$ref" 2>/dev/null)" && {
      printf -v "$output_var" '%s' "$output"; return 0;
    } ;;
    *) return 2 ;;
  esac
  refs="$(docker_full_refs "$kind" 2>/dev/null)" || return 2
  exact_ref_membership "$refs" "$ref" || membership_rc=$?
  case "$membership_rc" in
    0) return 2 ;; # listed: inspect failed for a reason other than absence
    1) ;;
    *) return 2 ;;
  esac
  printf -v "$output_var" '%s' ''
  return 1
}

docker_image_ref_query_state() {
  local ref="$1" format="$2" output_var="$3" output ids
  output="$("$DOCKER_BIN" image inspect --format "$format" "$ref" 2>/dev/null)" && {
    printf -v "$output_var" '%s' "$output"
    return 0
  }
  ids="$("$DOCKER_BIN" image ls -q --no-trunc "$ref" 2>/dev/null)" || return 2
  [ -z "$ids" ] || return 2
  printf -v "$output_var" '%s' ''
  return 1
}

docker_require_absent() {
  local kind="$1" ref="$2" ignored='' rc=0
  docker_query_state "$kind" "$ref" '{{.Id}}' ignored || rc=$?
  case "$rc" in
    1) return 0 ;;
    0|2) return 1 ;;
    *) return 1 ;;
  esac
}

docker_remove_and_verify() {
  local kind="$1" ref="$2"
  case "$kind" in
    container) "$DOCKER_BIN" rm -f "$ref" >/dev/null 2>&1 || return 1 ;;
    network) "$DOCKER_BIN" network rm "$ref" >/dev/null 2>&1 || return 1 ;;
    volume) "$DOCKER_BIN" volume rm "$ref" >/dev/null 2>&1 || return 1 ;;
    image) "$DOCKER_BIN" image rm "$ref" >/dev/null 2>&1 || return 1 ;;
    *) return 1 ;;
  esac
  docker_require_absent "$kind" "$ref"
}

file_uid() {
  stat -f '%u' -- "$1" 2>/dev/null || stat -c '%u' -- "$1" 2>/dev/null
}

file_mode() {
  stat -f '%Lp' -- "$1" 2>/dev/null || stat -c '%a' -- "$1" 2>/dev/null
}

private_file_is_safe() {
  local path="$1"
  [ -f "$path" ] &&
    [ ! -L "$path" ] &&
    [ "$(file_uid "$path")" = "$(id -u)" ] &&
    [ "$(file_mode "$path")" = "600" ]
}

write_private_lines() {
  local path="$1"
  shift
  [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
  (umask 077; : >"$path") || return 1
  local line
  for line in "$@"; do
    printf '%s\n' "$line" >>"$path" || return 1
  done
  chmod 600 "$path" || return 1
  private_file_is_safe "$path"
}

SIGNAL_CLEANUP_WORKER=0
if [ "${1:-}" = "--signal-cleanup-worker" ]; then
  SIGNAL_CLEANUP_WORKER=1
  shift
fi

if [ "${1:-}" = "--verify-cleanup-contract" ]; then
  owned_resource_matches id-ours id-ours nonce-ours nonce-ours name-ours name-ours ||
    fail "cleanup contract rejected its exact owned resource"
  if owned_resource_matches '' id-foreign nonce-ours nonce-ours name-ours name-ours; then
    fail "cleanup contract accepted a resource this invocation never acquired"
  fi
  if owned_resource_matches id-ours id-foreign nonce-ours nonce-ours name-ours name-ours; then
    fail "cleanup contract accepted a replaced immutable id"
  fi
  if owned_resource_matches id-ours id-ours nonce-ours nonce-foreign name-ours name-ours; then
    fail "cleanup contract accepted a foreign invocation label"
  fi
  if owned_resource_matches id-ours id-ours nonce-ours nonce-ours name-ours name-foreign; then
    fail "cleanup contract accepted a foreign resource name"
  fi
  VALID_OBJECT_ID="$(printf '0%.0s' {1..64})"
  VALID_IMAGE_ID="sha256:$VALID_OBJECT_ID"
  valid_docker_object_id "$VALID_OBJECT_ID" ||
    fail "cleanup contract rejected an exact 64-character lowercase object id"
  valid_docker_image_id "$VALID_IMAGE_ID" ||
    fail "cleanup contract rejected an exact sha256 image id"
  for invalid_id in "${VALID_OBJECT_ID}0" "${VALID_OBJECT_ID%?}" "${VALID_OBJECT_ID%?}A" "sha256:$VALID_OBJECT_ID"; do
    if valid_docker_object_id "$invalid_id"; then
      fail "cleanup contract accepted a malformed object id"
    fi
  done
  for invalid_id in "$VALID_OBJECT_ID" "sha256:${VALID_OBJECT_ID}0" "sha256:${VALID_OBJECT_ID%?}" "sha256:${VALID_OBJECT_ID%?}A"; do
    if valid_docker_image_id "$invalid_id"; then
      fail "cleanup contract accepted a malformed image id"
    fi
  done
  owned_resource_matches "$VALID_IMAGE_ID" "$VALID_IMAGE_ID" nonce-ours nonce-ours "$VALID_IMAGE_ID" "$VALID_IMAGE_ID" ||
    fail "immutable image execution binding rejected its exact image id"
  if owned_resource_matches "$VALID_IMAGE_ID" "sha256:${VALID_OBJECT_ID%?}1" nonce-ours nonce-ours "$VALID_IMAGE_ID" "$VALID_IMAGE_ID"; then
    fail "immutable image execution binding accepted a retagged image id"
  fi
  SELF_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-port-selftest.XXXXXX")"
  SELF_TEST_SECRET="$SELF_TEST_DIR/secret.env"
  LARGE_REFS="$VALID_OBJECT_ID"$'\n'"$(awk 'BEGIN { line=""; for (j=0; j<64; j++) line=line "b"; for (i=1; i<200000; i++) print line }')"
  exact_ref_membership "$LARGE_REFS" "$VALID_OBJECT_ID" ||
    fail "pipe-free membership missed an early match in a 200k-line listing"
  unset LARGE_REFS
  GREP_ERROR_BIN="$SELF_TEST_DIR/grep-error"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 2' >"$GREP_ERROR_BIN"
  chmod 700 "$GREP_ERROR_BIN"
  ORIGINAL_GREP_BIN="$GREP_BIN"
  GREP_BIN="$GREP_ERROR_BIN"
  MEMBERSHIP_RC=0
  exact_ref_membership "$VALID_OBJECT_ID" "$VALID_OBJECT_ID" || MEMBERSHIP_RC=$?
  [ "$MEMBERSHIP_RC" -eq 2 ] || fail "membership grep/read error was not fail-closed"
  GREP_BIN="$ORIGINAL_GREP_BIN"
  write_private_lines "$SELF_TEST_SECRET" 'SECRET=not-a-real-secret' ||
    fail "private-file contract could not create a 0600 owned regular file"
  private_file_is_safe "$SELF_TEST_SECRET" ||
    fail "private-file contract rejected its owned file"
  ln -s "$SELF_TEST_SECRET" "$SELF_TEST_DIR/symlink.env"
  if private_file_is_safe "$SELF_TEST_DIR/symlink.env"; then
    fail "private-file contract followed a symlink"
  fi
  FAKE_DOCKER="$SELF_TEST_DIR/docker"
  FAKE_STATE_FILE="$SELF_TEST_DIR/docker.state"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -u' \
    'state="$(cat "$FAKE_DOCKER_STATE_FILE")"' \
    'if [ "${FAKE_SIGNAL_MODE:-0}" = 1 ]; then' \
    '  case "$1 $2" in' \
    '    "network ls") [ "$state" = present ] && printf "%s\n" "$FAKE_DOCKER_REF"; exit 0 ;;' \
    '    "network create") printf "%s\n" present >"$FAKE_DOCKER_STATE_FILE"; kill -TERM "$PPID"; sleep 1; exit 0 ;;' \
    '    "network inspect") [ "$state" = present ] || exit 1; printf "%s|%s|%s\n" "$FAKE_DOCKER_REF" "$FAKE_EXPECTED_NETWORK" "$FAKE_EXPECTED_LABEL"; exit 0 ;;' \
    '    "network rm") printf "%s\n" absent >"$FAKE_DOCKER_STATE_FILE"; exit 0 ;;' \
    '    "image ls"|"ps -aq") exit 0 ;;' \
    '    *) exit 9 ;;' \
    '  esac' \
    'fi' \
    'case "$1" in' \
    '  inspect)' \
    '    [ "${FAKE_INSPECT_MODE:-ok}" = ok ] && [ "$state" = present ] && { printf "%s\n" "$FAKE_DOCKER_REF"; exit 0; }' \
    '    exit 1 ;;' \
    '  ps)' \
    '    [ "${FAKE_LIST_MODE:-ok}" = ok ] || exit 9' \
    '    [ "$state" = present ] && printf "%s\n" "$FAKE_DOCKER_REF"' \
    '    exit 0 ;;' \
    '  rm)' \
    '    case "${FAKE_REMOVE_MODE:-ok}" in' \
    '      fail) exit 8 ;;' \
    '      lie) exit 0 ;;' \
    '      ok) printf "%s\n" absent >"$FAKE_DOCKER_STATE_FILE"; exit 0 ;;' \
    '    esac ;;' \
    '  *) exit 9 ;;' \
    'esac' >"$FAKE_DOCKER"
  chmod 700 "$FAKE_DOCKER"
  FAKE_DOCKER_REF="$VALID_OBJECT_ID"
  FAKE_DOCKER_STATE_FILE="$FAKE_STATE_FILE"
  export FAKE_DOCKER_STATE_FILE FAKE_DOCKER_REF
  ORIGINAL_DOCKER_BIN="$DOCKER_BIN"
  DOCKER_BIN="$FAKE_DOCKER"
  printf '%s\n' present >"$FAKE_STATE_FILE"
  FAKE_INSPECT_MODE=ok FAKE_LIST_MODE=ok
  export FAKE_INSPECT_MODE FAKE_LIST_MODE
  QUERY_OUTPUT=''
  docker_query_state container "$VALID_OBJECT_ID" '{{.Id}}' QUERY_OUTPUT ||
    fail "tri-state Docker query rejected a readable full-ID object"
  [ "$QUERY_OUTPUT" = "$VALID_OBJECT_ID" ] || fail "tri-state Docker query changed the immutable id"
  printf '%s\n' absent >"$FAKE_STATE_FILE"
  FAKE_INSPECT_MODE=fail
  export FAKE_INSPECT_MODE
  QUERY_RC=0
  docker_query_state container "$VALID_OBJECT_ID" '{{.Id}}' QUERY_OUTPUT || QUERY_RC=$?
  [ "$QUERY_RC" -eq 1 ] || fail "tri-state Docker query did not distinguish proven absence"
  printf '%s\n' present >"$FAKE_STATE_FILE"
  QUERY_RC=0
  docker_query_state container "$VALID_OBJECT_ID" '{{.Id}}' QUERY_OUTPUT || QUERY_RC=$?
  [ "$QUERY_RC" -eq 2 ] || fail "tri-state Docker query hid inspect failure for a listed object"
  printf '%s\n' absent >"$FAKE_STATE_FILE"
  FAKE_LIST_MODE=fail
  export FAKE_LIST_MODE
  QUERY_RC=0
  docker_query_state container "$VALID_OBJECT_ID" '{{.Id}}' QUERY_OUTPUT || QUERY_RC=$?
  [ "$QUERY_RC" -eq 2 ] || fail "tri-state Docker query treated daemon/list failure as absence"
  FAKE_INSPECT_MODE=ok FAKE_LIST_MODE=ok
  export FAKE_INSPECT_MODE FAKE_LIST_MODE
  printf '%s\n' present >"$FAKE_STATE_FILE"
  FAKE_REMOVE_MODE=fail; export FAKE_REMOVE_MODE
  if docker_remove_and_verify container "$VALID_OBJECT_ID"; then
    fail "Docker removal error did not propagate"
  fi
  printf '%s\n' present >"$FAKE_STATE_FILE"
  FAKE_REMOVE_MODE=lie; export FAKE_REMOVE_MODE
  if docker_remove_and_verify container "$VALID_OBJECT_ID"; then
    fail "Docker survivor absence check was false-green"
  fi
  printf '%s\n' present >"$FAKE_STATE_FILE"
  FAKE_REMOVE_MODE=ok; export FAKE_REMOVE_MODE
  docker_remove_and_verify container "$VALID_OBJECT_ID" ||
    fail "Docker exact removal plus proven absence was rejected"
  printf '%s\n' absent >"$FAKE_STATE_FILE"
  FAKE_SIGNAL_MODE=1
  FAKE_SIGNAL_LOCK_RECORD="$SELF_TEST_DIR/signal-lock.path"
  export FAKE_SIGNAL_MODE FAKE_SIGNAL_LOCK_RECORD
  SIGNAL_RC=0
  PATH="$SELF_TEST_DIR:$PATH" DOCKER_BIN="$FAKE_DOCKER" \
    "$0" --signal-cleanup-worker >/dev/null 2>&1 || SIGNAL_RC=$?
  [ "$SIGNAL_RC" -eq 143 ] || fail "signal cleanup worker did not preserve TERM status (rc=$SIGNAL_RC)"
  [ "$(cat "$FAKE_STATE_FILE")" = absent ] || fail "signal cleanup stranded a mutation-gap network"
  SIGNAL_LOCK_PATH="$(cat "$FAKE_SIGNAL_LOCK_RECORD")"
  [ ! -e "$SIGNAL_LOCK_PATH" ] || fail "signal cleanup stranded the invocation lock"
  DOCKER_BIN="$ORIGINAL_DOCKER_BIN"
  unset FAKE_DOCKER_STATE_FILE FAKE_DOCKER_REF FAKE_INSPECT_MODE FAKE_LIST_MODE FAKE_REMOVE_MODE
  unset FAKE_SIGNAL_MODE FAKE_SIGNAL_LOCK_RECORD
  rm -r -- "$SELF_TEST_DIR"
  if grep -E 'grep.*\$IMAGE_TOKEN|--env.*(POSTGRES_PASSWORD|DATABASE_URL|JWT_HMAC)=|digest\(.*\$IMAGE_TOKEN' "$0" | grep -v 'static secret-argv contract' >/dev/null; then
    fail "static secret-argv contract found a raw verifier secret in an external argv"
  fi
  note "PASS daemon-free tri-state cleanup ownership/removal contract"
  exit 0
fi
[ "$#" -eq 0 ] || fail "usage: scripts/verify_agent_port.sh [--verify-cleanup-contract]"

for command_name in cargo curl docker jq openssl uuidgen xxd; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "missing required command: $command_name"
done

RUN_NONCE="$(openssl rand -hex 16)"
RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RUN_NONCE"
LABEL_KEY="com.momo.agent-port-verifier"
NETWORK="momo-agent-port-network-$RUN_TAG"
PG_CONTAINER="momo-agent-port-pg-$RUN_TAG"
API_CONTAINER="momo-agent-port-api-$RUN_TAG"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-port.XXXXXX")"
PG_PASSWORD="$(openssl rand -hex 24)"
PG_ENV_FILE="$TMP_DIR/postgres.env"
API_ENV_FILE="$TMP_DIR/api.env"
TOKEN_NEEDLE_FILE="$TMP_DIR/token-needle.txt"
API_LOG_FILE="$TMP_DIR/api.log"
BUILT_IMAGE=""
BUILT_IMAGE_ID=""
NETWORK_ID=""
PG_CONTAINER_ID=""
API_CONTAINER_ID=""
MUTATION_STARTED=0
CLEANUP_DONE=0
LOCK_DIR="${TMPDIR:-/tmp}/momo-agent-port-$RUN_TAG.lock"
mkdir "$LOCK_DIR" 2>/dev/null || fail "invocation lock already exists: $LOCK_DIR"
chmod 700 "$LOCK_DIR" || fail "could not protect invocation lock"
LOCK_IDENTITY="$(stat -f '%d:%i:%u:%Lp' -- "$LOCK_DIR" 2>/dev/null || stat -c '%d:%i:%u:%a' -- "$LOCK_DIR" 2>/dev/null)"

docker_named_ids() {
  local kind="$1" name="$2"
  case "$kind" in
    container) "$DOCKER_BIN" ps -aq --no-trunc --filter "name=^${name}$" ;;
    network) "$DOCKER_BIN" network ls -q --no-trunc --filter "name=^${name}$" ;;
    image) "$DOCKER_BIN" image ls -q --no-trunc "$name" ;;
    *) return 2 ;;
  esac
}

prove_name_absent() {
  local kind="$1" name="$2" ids
  ids="$(docker_named_ids "$kind" "$name" 2>/dev/null)" || return 1
  [ -z "$ids" ]
}

rediscover_container_if_owned() {
  local expected_name="$1" output_var="$2" ids id binding rc=0 actual_id actual_name actual_label
  ids="$(docker_named_ids container "$expected_name" 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 0
  [ "$(printf '%s\n' "$ids" | awk 'NF {count++} END {print count+0}')" -eq 1 ] || return 1
  id="$ids"
  valid_docker_object_id "$id" || return 1
  docker_query_state container "$id" '{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.momo.agent-port-verifier" }}' binding || rc=$?
  [ "$rc" -eq 0 ] || return 1
  IFS='|' read -r actual_id actual_name actual_label <<EOF
$binding
EOF
  owned_resource_matches "$id" "$actual_id" "$RUN_TAG" "$actual_label" "/$expected_name" "$actual_name" || return 1
  printf -v "$output_var" '%s' "$id"
}

rediscover_network_if_owned() {
  local ids id binding rc=0 actual_id actual_name actual_label
  ids="$(docker_named_ids network "$NETWORK" 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 0
  [ "$(printf '%s\n' "$ids" | awk 'NF {count++} END {print count+0}')" -eq 1 ] || return 1
  id="$ids"
  valid_docker_object_id "$id" || return 1
  docker_query_state network "$id" '{{.Id}}|{{.Name}}|{{ index .Labels "com.momo.agent-port-verifier" }}' binding || rc=$?
  [ "$rc" -eq 0 ] || return 1
  IFS='|' read -r actual_id actual_name actual_label <<EOF
$binding
EOF
  owned_resource_matches "$id" "$actual_id" "$RUN_TAG" "$actual_label" "$NETWORK" "$actual_name" || return 1
  NETWORK_ID="$id"
}

rediscover_image_if_owned() {
  local ids id binding rc=0 actual_id actual_label
  [ -n "$BUILT_IMAGE" ] || return 0
  ids="$(docker_named_ids image "$BUILT_IMAGE" 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 0
  [ "$(printf '%s\n' "$ids" | awk 'NF {count++} END {print count+0}')" -eq 1 ] || return 1
  id="$ids"
  valid_docker_image_id "$id" || return 1
  docker_query_state image "$id" '{{.Id}}|{{ index .Config.Labels "com.momo.agent-port-verifier" }}' binding || rc=$?
  [ "$rc" -eq 0 ] || return 1
  IFS='|' read -r actual_id actual_label <<EOF
$binding
EOF
  owned_resource_matches "$id" "$actual_id" "$RUN_TAG" "$actual_label" "$id" "$actual_id" || return 1
  BUILT_IMAGE_ID="$id"
}

rediscover_owned_resources() {
  rediscover_container_if_owned "$PG_CONTAINER" PG_CONTAINER_ID || return 1
  rediscover_container_if_owned "$API_CONTAINER" API_CONTAINER_ID || return 1
  rediscover_network_if_owned || return 1
  rediscover_image_if_owned || return 1
}

cleanup_container_if_owned() {
  local acquired_id="$1" expected_name="$2" binding rc=0 actual_id actual_label actual_name
  [ -n "$acquired_id" ] || return 0
  docker_query_state container "$acquired_id" '{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.momo.agent-port-verifier" }}' binding || rc=$?
  case "$rc" in
    1) return 0 ;;
    0) ;;
    *) return 1 ;;
  esac
  IFS='|' read -r actual_id actual_name actual_label <<EOF
$binding
EOF
  if owned_resource_matches \
    "$acquired_id" "$actual_id" "$RUN_TAG" "$actual_label" \
    "/$expected_name" "$actual_name"; then
    docker_remove_and_verify container "$acquired_id"
  else
    printf '[agent-port] refusing foreign/replaced container cleanup: %s\n' "$expected_name" >&2
    return 1
  fi
}

cleanup_network_if_owned() {
  local binding rc=0 actual_id actual_label actual_name
  [ -n "$NETWORK_ID" ] || return 0
  docker_query_state network "$NETWORK_ID" '{{.Id}}|{{.Name}}|{{ index .Labels "com.momo.agent-port-verifier" }}' binding || rc=$?
  case "$rc" in
    1) return 0 ;;
    0) ;;
    *) return 1 ;;
  esac
  IFS='|' read -r actual_id actual_name actual_label <<EOF
$binding
EOF
  if owned_resource_matches \
    "$NETWORK_ID" "$actual_id" "$RUN_TAG" "$actual_label" "$NETWORK" "$actual_name"; then
    docker_remove_and_verify network "$NETWORK_ID"
  else
    printf '[agent-port] refusing foreign/replaced network cleanup: %s\n' "$NETWORK" >&2
    return 1
  fi
}

cleanup_image_if_owned() {
  local binding rc=0 actual_id actual_label
  [ -n "$BUILT_IMAGE_ID" ] || return 0
  docker_query_state image "$BUILT_IMAGE_ID" '{{.Id}}|{{ index .Config.Labels "com.momo.agent-port-verifier" }}' binding || rc=$?
  case "$rc" in
    1) return 0 ;;
    0) ;;
    *) return 1 ;;
  esac
  IFS='|' read -r actual_id actual_label <<EOF
$binding
EOF
  if owned_resource_matches \
    "$BUILT_IMAGE_ID" "$actual_id" "$RUN_TAG" "$actual_label" \
    "$BUILT_IMAGE_ID" "$actual_id"; then
    # Remove the immutable image we acquired. Never remove through the mutable
    # tag: another process could retarget that name after the inspect above.
    docker_remove_and_verify image "$BUILT_IMAGE_ID"
  else
    printf '[agent-port] refusing foreign/replaced image cleanup: %s\n' "$BUILT_IMAGE" >&2
    return 1
  fi
}

perform_cleanup() {
  local cleanup_failed=0 survivor
  if [ "$MUTATION_STARTED" -eq 1 ]; then
    rediscover_owned_resources || cleanup_failed=1
  fi
  # Host-side secrets are cheap to remove and must not wait behind a hung
  # daemon cleanup. The directory is verifier-created, private, and path-bound.
  case "$TMP_DIR" in
    "${TMPDIR:-/tmp}"/momo-agent-port.*) rm -r -- "$TMP_DIR" || cleanup_failed=1 ;;
    *) printf '[agent-port] refusing unexpected temp cleanup path: %s\n' "$TMP_DIR" >&2; cleanup_failed=1 ;;
  esac
  cleanup_container_if_owned "$API_CONTAINER_ID" "$API_CONTAINER" || cleanup_failed=1
  cleanup_container_if_owned "$PG_CONTAINER_ID" "$PG_CONTAINER" || cleanup_failed=1
  cleanup_network_if_owned || cleanup_failed=1
  cleanup_image_if_owned || cleanup_failed=1
  for survivor in "$API_CONTAINER_ID" "$PG_CONTAINER_ID"; do
    [ -z "$survivor" ] || docker_require_absent container "$survivor" || cleanup_failed=1
  done
  [ -z "$NETWORK_ID" ] || docker_require_absent network "$NETWORK_ID" || cleanup_failed=1
  [ -z "$BUILT_IMAGE_ID" ] || docker_require_absent image "$BUILT_IMAGE_ID" || cleanup_failed=1
  if [ -d "$LOCK_DIR" ]; then
    if [ "$(stat -f '%d:%i:%u:%Lp' -- "$LOCK_DIR" 2>/dev/null || stat -c '%d:%i:%u:%a' -- "$LOCK_DIR" 2>/dev/null)" = "$LOCK_IDENTITY" ]; then
      rmdir "$LOCK_DIR" || cleanup_failed=1
    else
      printf '[agent-port] refusing replaced invocation-lock cleanup\n' >&2
      cleanup_failed=1
    fi
  fi
  if [ "$cleanup_failed" -ne 0 ]; then
    printf '[agent-port] cleanup failed or an owned resource survived\n' >&2
    return 1
  fi
  CLEANUP_DONE=1
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$CLEANUP_DONE" -eq 0 ]; then
    perform_cleanup || [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$SIGNAL_CLEANUP_WORKER" -eq 1 ]; then
  export FAKE_EXPECTED_NETWORK="$NETWORK" FAKE_EXPECTED_LABEL="$RUN_TAG"
  printf '%s\n' "$LOCK_DIR" >"${FAKE_SIGNAL_LOCK_RECORD:?missing signal lock record}"
fi

prove_name_absent network "$NETWORK" || fail "network name already exists or could not be proven absent"
prove_name_absent container "$PG_CONTAINER" || fail "PostgreSQL container name already exists or could not be proven absent"
prove_name_absent container "$API_CONTAINER" || fail "API container name already exists or could not be proven absent"

note "creating labeled, isolated PostgreSQL 18 network"
MUTATION_STARTED=1
NETWORK_ID="$(docker network create --label "$LABEL_KEY=$RUN_TAG" "$NETWORK")"
valid_docker_object_id "$NETWORK_ID" || fail "Docker returned a malformed network id"
write_private_lines "$PG_ENV_FILE" \
  'POSTGRES_DB=momo' \
  'POSTGRES_USER=momo' \
  "POSTGRES_PASSWORD=$PG_PASSWORD" ||
  fail "could not create private PostgreSQL env file"
MUTATION_STARTED=1
PG_CONTAINER_ID="$(docker run --detach --rm \
  --name "$PG_CONTAINER" \
  --label "$LABEL_KEY=$RUN_TAG" \
  --network "$NETWORK_ID" \
  --network-alias postgres \
  --publish 127.0.0.1::5432 \
  --env-file "$PG_ENV_FILE" \
  pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e \
  )"
valid_docker_object_id "$PG_CONTAINER_ID" ||
  fail "Docker returned a malformed PostgreSQL container id"
PG_NETWORK_ID=''
PG_INSPECT_RC=0
docker_query_state container "$PG_CONTAINER_ID" '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}' PG_NETWORK_ID || PG_INSPECT_RC=$?
[ "$PG_INSPECT_RC" -eq 0 ] || fail "could not read the PostgreSQL container network binding"
[ "$PG_NETWORK_ID" = "$NETWORK_ID" ] || fail "PostgreSQL container joined an unexpected network"

for _ in $(seq 1 90); do
  if docker exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null 2>&1 ||
  fail "PostgreSQL 18 did not become ready"

PG_BINDING="$(docker port "$PG_CONTAINER_ID" 5432/tcp | head -1)"
PG_PORT="${PG_BINDING##*:}"
case "$PG_PORT" in
  ''|*[!0-9]*) fail "could not resolve the isolated PostgreSQL host port" ;;
esac

note "phase 1/2: real momo_app RLS router + PG18 conformance"
(
  cd server-rust
  PGHOST=127.0.0.1 \
    PGPORT="$PG_PORT" \
    PGUSER=momo \
    PGDATABASE=momo \
    PGPASSWORD="$PG_PASSWORD" \
  DATABASE_URL="postgres://momo:$PG_PASSWORD@127.0.0.1:$PG_PORT/momo" \
    MOMO_APP_PASSWORD=momo_app_dev_pw \
    cargo test -p momo-server --test agent_port_conformance_pg \
      -- --ignored --test-threads=1 --nocapture
)

if [ "${AGENT_PORT_VERIFY_IMAGE:-1}" = "0" ]; then
  perform_cleanup || fail "explicit normal teardown failed"
  trap - EXIT INT TERM
  note "PASS PG18/Rust router conformance (deploy-image phase explicitly skipped)"
  exit 0
fi

if [ -n "${MOMO_RUST_IMAGE:-}" ]; then
  IMAGE="$MOMO_RUST_IMAGE"
  IMAGE_ID=''
  IMAGE_QUERY_RC=0
  docker_image_ref_query_state "$IMAGE" '{{.Id}}' IMAGE_ID || IMAGE_QUERY_RC=$?
  [ "$IMAGE_QUERY_RC" -eq 0 ] || fail "MOMO_RUST_IMAGE is absent or could not be read"
  valid_docker_image_id "$IMAGE_ID" || fail "Docker returned a malformed reused image id"
  RUN_IMAGE_ID="$IMAGE_ID"
  note "phase 2/2: reusing deploy image $IMAGE"
else
  IMAGE="momo-rust:agent-port-$RUN_TAG"
  prove_name_absent image "$IMAGE" || fail "build image tag already exists or could not be proven absent"
  note "phase 2/2: building deploy image $IMAGE"
  BUILT_IMAGE="$IMAGE"
  MUTATION_STARTED=1
  docker build \
    --label "$LABEL_KEY=$RUN_TAG" \
    --file server-rust/Dockerfile \
    --tag "$IMAGE" \
    . >"$TMP_DIR/image-build.log" 2>&1 || {
      tail -80 "$TMP_DIR/image-build.log" >&2
      fail "deploy Rust image build failed"
    }
  BUILT_IMAGE_ID=''
  BUILT_IMAGE_QUERY_RC=0
  docker_image_ref_query_state "$BUILT_IMAGE" '{{.Id}}' BUILT_IMAGE_ID || BUILT_IMAGE_QUERY_RC=$?
  [ "$BUILT_IMAGE_QUERY_RC" -eq 0 ] || fail "built image is absent or could not be read"
  valid_docker_image_id "$BUILT_IMAGE_ID" || fail "Docker returned a malformed built image id"
  RUN_IMAGE_ID="$BUILT_IMAGE_ID"
fi

IMAGE_WORKSPACE="$(uuidgen | tr '[:upper:]' '[:lower:]')"
IMAGE_AGENT="$(uuidgen | tr '[:upper:]' '[:lower:]')"
IMAGE_SECRET="$(openssl rand -hex 32)"
IMAGE_TOKEN="momo_agent_v1.$IMAGE_WORKSPACE.$IMAGE_SECRET"
IMAGE_TOKEN_HASH="$(printf '%s' "$IMAGE_TOKEN" | openssl dgst -sha256 -binary | xxd -p -c 256)"

# The raw bearer travels only through this private shell and psql stdin. It is
# never a process argument, environment variable, image layer, or log line.
docker exec --interactive "$PG_CONTAINER_ID" \
  psql -U momo -d momo -v ON_ERROR_STOP=1 --no-psqlrc --quiet >/dev/null <<SQL
BEGIN;
INSERT INTO workspace (id, slug, name)
VALUES ('$IMAGE_WORKSPACE', 'agent-port-image-$RUN_TAG', 'Agent Port Image Smoke');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$IMAGE_AGENT', '$IMAGE_WORKSPACE', 'agent', 'active',
        'Image Hosted Agent', 'image-agent-$RUN_TAG');
INSERT INTO agent (member_id, workspace_id, model, base_url)
VALUES ('$IMAGE_AGENT', '$IMAGE_WORKSPACE', 'hosted-agent',
        'https://provider.invalid/v1');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$IMAGE_WORKSPACE', '$IMAGE_AGENT', 'member');
INSERT INTO token
  (workspace_id, kind, actor_member_id, token_hash, scopes, label)
VALUES
  ('$IMAGE_WORKSPACE', 'agent_bearer', '$IMAGE_AGENT',
   decode('$IMAGE_TOKEN_HASH', 'hex'), ARRAY['agent:port:connect'],
   'agent-port-image-smoke');
COMMIT;
SQL

JWT_HMAC="$(openssl rand -hex 32)"
write_private_lines "$TOKEN_NEEDLE_FILE" \
  "$IMAGE_TOKEN" "$IMAGE_TOKEN_HASH" "$IMAGE_SECRET" "${IMAGE_SECRET:0:24}" \
  "$PG_PASSWORD" "$JWT_HMAC" 'momo_app_dev_pw' \
  'postgres://momo_app:momo_app_dev_pw@postgres:5432/momo' ||
  fail "could not create private log needle"
write_private_lines "$API_ENV_FILE" \
  'DATABASE_URL=postgres://momo_app:momo_app_dev_pw@postgres:5432/momo' \
  "JWT_HMAC=$JWT_HMAC" \
  'MOMO_ENV=local' \
  'PORT=8080' \
  'MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:8000/connection/websocket' \
  'MOMO_AGENT_PORT_RATE_LIMIT_PER_TOKEN=0' \
  'MOMO_AGENT_PORT_RATE_LIMIT_PER_AGENT=0' \
  'MOMO_AGENT_PORT_RATE_LIMIT_PER_IP=0' ||
  fail "could not create private API env file"
MUTATION_STARTED=1
API_CONTAINER_ID="$(docker run --detach --rm \
  --name "$API_CONTAINER" \
  --label "$LABEL_KEY=$RUN_TAG" \
  --network "$NETWORK_ID" \
  --publish 127.0.0.1::8080 \
  --env-file "$API_ENV_FILE" \
  "$RUN_IMAGE_ID" api)"
valid_docker_object_id "$API_CONTAINER_ID" || fail "Docker returned a malformed API container id"
API_CONTAINER_IMAGE_ID=''
API_INSPECT_RC=0
docker_query_state container "$API_CONTAINER_ID" '{{.Image}}' API_CONTAINER_IMAGE_ID || API_INSPECT_RC=$?
[ "$API_INSPECT_RC" -eq 0 ] || fail "could not read API container image binding"
[ "$API_CONTAINER_IMAGE_ID" = "$RUN_IMAGE_ID" ] ||
  fail "API container did not start from the captured immutable image id"
API_NETWORK_ID=''
API_INSPECT_RC=0
docker_query_state container "$API_CONTAINER_ID" '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}' API_NETWORK_ID || API_INSPECT_RC=$?
[ "$API_INSPECT_RC" -eq 0 ] || fail "could not read API container network binding"
[ "$API_NETWORK_ID" = "$NETWORK_ID" ] || fail "API container joined an unexpected network"

API_BINDING="$(docker port "$API_CONTAINER_ID" 8080/tcp | head -1)"
API_PORT="${API_BINDING##*:}"
case "$API_PORT" in
  ''|*[!0-9]*) fail "could not resolve the deploy-image API host port" ;;
esac
BASE_URL="http://127.0.0.1:$API_PORT"
for _ in $(seq 1 90); do
  if curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1; then
    break
  fi
  API_RUNNING=''
  API_RUNNING_RC=0
  docker_query_state container "$API_CONTAINER_ID" '{{.State.Running}}' API_RUNNING || API_RUNNING_RC=$?
  [ "$API_RUNNING_RC" -eq 0 ] || fail "could not read API container state during health wait"
  if [ "$API_RUNNING" != true ]; then
    write_private_lines "$API_LOG_FILE" || fail "could not create private API log capture"
    docker logs "$API_CONTAINER_ID" >"$API_LOG_FILE" 2>&1 || true
    FAILURE_LOG_SCAN_RC=0
    grep -Fq -f "$TOKEN_NEEDLE_FILE" "$API_LOG_FILE" || FAILURE_LOG_SCAN_RC=$?
    case "$FAILURE_LOG_SCAN_RC" in
      0) fail "deploy-image failure logs contained a verifier credential" ;;
      1) ;;
      *) fail "deploy-image failure log secret scan failed" ;;
    esac
    tail -80 "$API_LOG_FILE" >&2
    fail "deploy-image API exited before health became green"
  fi
  sleep 1
done
curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1 || {
  write_private_lines "$API_LOG_FILE" || fail "could not create private API log capture"
  docker logs "$API_CONTAINER_ID" >"$API_LOG_FILE" 2>&1 || true
  TIMEOUT_LOG_SCAN_RC=0
  grep -Fq -f "$TOKEN_NEEDLE_FILE" "$API_LOG_FILE" || TIMEOUT_LOG_SCAN_RC=$?
  case "$TIMEOUT_LOG_SCAN_RC" in
    0) fail "deploy-image timeout logs contained a verifier credential" ;;
    1) ;;
    *) fail "deploy-image timeout log secret scan failed" ;;
  esac
  tail -80 "$API_LOG_FILE" >&2
  fail "deploy-image API health timeout"
}

REQUEST_FILE="$TMP_DIR/request.json"
CURL_CONFIG="$TMP_DIR/curl.conf"
RESPONSE_HEADERS="$TMP_DIR/response.headers"
RESPONSE_BODY="$TMP_DIR/response.json"
write_private_lines "$REQUEST_FILE" \
  '{"jsonrpc":"2.0","id":"image-smoke","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"image-verifier","version":"1.0.0"}}}}' ||
  fail "could not create private request file"
write_private_lines "$CURL_CONFIG" \
  "header = \"Authorization: Bearer $IMAGE_TOKEN\"" ||
  fail "could not create private curl config"

HTTP_STATUS="$(curl --silent --show-error \
  --config "$CURL_CONFIG" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'MCP-Protocol-Version: 2026-07-28' \
  --header 'Mcp-Method: server/discover' \
  --data-binary "@$REQUEST_FILE" \
  --dump-header "$RESPONSE_HEADERS" \
  --output "$RESPONSE_BODY" \
  --write-out '%{http_code}' \
  "$BASE_URL/v1/mcp/agent-port")"
[ "$HTTP_STATUS" = "200" ] || fail "deploy-image Agent Port returned HTTP $HTTP_STATUS"
jq -e '
  .jsonrpc == "2.0" and
  .id == "image-smoke" and
  .result.protocolVersion == "2026-07-28" and
  .result.resultType == "server/discover" and
  .result.capabilities.tools.listChanged == false and
  .result.cache == {"scope":"private","ttlSeconds":300}
' "$RESPONSE_BODY" >/dev/null || fail "deploy-image discover response drifted"
grep -Eiq '^cache-control:[[:space:]]*private, no-store' "$RESPONSE_HEADERS" ||
  fail "deploy-image response did not disable shared caching"
if grep -Eiq '^mcp-session-id:' "$RESPONSE_HEADERS"; then
  fail "deploy-image response unexpectedly established an MCP session"
fi

IMAGE_DB_EVIDENCE="$(docker exec "$PG_CONTAINER_ID" psql -U momo -d momo -tA --no-psqlrc -c \
  "SELECT (SELECT count(*) FROM audit_log WHERE workspace_id='$IMAGE_WORKSPACE' AND action='auth.agent_bearer.used'), (SELECT count(*) FROM token WHERE workspace_id='$IMAGE_WORKSPACE' AND last_used_at IS NOT NULL), (SELECT count(*) FROM message WHERE workspace_id='$IMAGE_WORKSPACE') + (SELECT count(*) FROM outbox WHERE workspace_id='$IMAGE_WORKSPACE') + (SELECT count(*) FROM agent_run WHERE workspace_id='$IMAGE_WORKSPACE');")"
[ "$IMAGE_DB_EVIDENCE" = "1|1|0" ] ||
  fail "deploy-image audit/last-used/no-product-write evidence was $IMAGE_DB_EVIDENCE"
write_private_lines "$API_LOG_FILE" || fail "could not create private API log capture"
docker logs "$API_CONTAINER_ID" >"$API_LOG_FILE" 2>&1 ||
  fail "could not capture complete deploy-image API logs"
LOG_SCAN_RC=0
grep -Fq -f "$TOKEN_NEEDLE_FILE" "$API_LOG_FILE" || LOG_SCAN_RC=$?
case "$LOG_SCAN_RC" in
  0) fail "deploy-image logs retained a verifier credential" ;;
  1) ;;
  *) fail "deploy-image log secret scan failed" ;;
esac

perform_cleanup || fail "explicit normal teardown failed"
trap - EXIT INT TERM
note "PASS PG18 credential/RLS/audit/rate/no-write conformance"
note "PASS source-checkout-free Rust deploy image Agent Port smoke"
