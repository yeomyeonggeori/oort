#!/usr/bin/env bash
# LIVE-1 / ADR-0165 display-attach runtime verifier.
#
# Four phases, each proving something the others cannot:
#
#   1. capability plane  the ignored conformance suite against an isolated
#                        PostgreSQL 18 and the real in-process Axum router:
#                        who may publish a screen, who may watch it, and what
#                        cuts a stream that is already open.
#   2. signalling        two local peers over a real WebSocket
#                        (scripts/display_signaling_probe.py), plus its own red
#                        proof — a producer that negotiates a datachannel MUST
#                        be caught.
#   3. template contract infra/cubesandbox/display-template/template.spec.json
#                        cross-read against the server's own constants, so a
#                        template that drifts from the server it registers with
#                        fails here rather than in front of a person watching a
#                        black rectangle.
#   4. no regression     the PTY attach suites this goal extended.
#
# What this verifier does NOT prove, and says so in its own PASS line: that a
# real WebRTC producer inside a CubeSandbox microVM behaves this way. Nothing in
# this repository can build or boot one — see
# infra/cubesandbox/display-template/README.md.
#
# Optional inputs:
#   DISPLAY_ATTACH_VERIFY_REGRESSION=0   skip phase 4 for fast local iteration
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

fail() {
  printf '[display-attach] FAIL: %s\n' "$*" >&2
  exit 1
}

note() { printf '[display-attach] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# ownership contract
#
# Every destructive step below asks the same question first: is this exact
# resource one THIS invocation created? The predicate is pure so it can be
# self-tested without a Docker daemon (`--verify-cleanup-contract`), and the
# absence checks are tri-state on purpose — an `inspect` failure alone never
# proves absence, because Docker returns the same non-zero status for "no such
# object" and for "the daemon is unwell".
# ---------------------------------------------------------------------------

DOCKER_BIN="${DOCKER_BIN:-docker}"

owned_resource_matches() {
  local expected_id="$1" actual_id="$2" expected_label="$3" actual_label="$4"
  local expected_name="$5" actual_name="$6"
  [ -n "$expected_id" ] &&
    [ "$actual_id" = "$expected_id" ] &&
    [ "$actual_label" = "$expected_label" ] &&
    [ "$actual_name" = "$expected_name" ]
}

valid_docker_object_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

docker_full_refs() {
  case "$1" in
    container) "$DOCKER_BIN" ps -aq --no-trunc ;;
    network) "$DOCKER_BIN" network ls -q --no-trunc ;;
    *) return 2 ;;
  esac
}

# 0 = present/readable, 1 = proven absent by a successful full listing,
# 2 = daemon/read/parse ambiguity.
docker_query_state() {
  local kind="$1" ref="$2" format="$3" output_var="$4" output refs
  case "$kind" in
    container) output="$("$DOCKER_BIN" inspect --format "$format" "$ref" 2>/dev/null)" && {
      printf -v "$output_var" '%s' "$output"; return 0;
    } ;;
    network) output="$("$DOCKER_BIN" network inspect --format "$format" "$ref" 2>/dev/null)" && {
      printf -v "$output_var" '%s' "$output"; return 0;
    } ;;
    *) return 2 ;;
  esac
  refs="$(docker_full_refs "$kind" 2>/dev/null)" || return 2
  if grep -Fqx -- "$ref" <<<"$refs"; then
    return 2 # listed: inspect failed for a reason other than absence
  fi
  printf -v "$output_var" '%s' ''
  return 1
}

docker_require_absent() {
  local ignored='' rc=0
  docker_query_state "$1" "$2" '{{.Id}}' ignored || rc=$?
  [ "$rc" -eq 1 ]
}

docker_remove_and_verify() {
  local kind="$1" ref="$2"
  case "$kind" in
    container) "$DOCKER_BIN" rm -f "$ref" >/dev/null 2>&1 || return 1 ;;
    network) "$DOCKER_BIN" network rm "$ref" >/dev/null 2>&1 || return 1 ;;
    *) return 1 ;;
  esac
  docker_require_absent "$kind" "$ref"
}

docker_named_ids() {
  case "$1" in
    container) "$DOCKER_BIN" ps -aq --no-trunc --filter "name=^${2}$" ;;
    network) "$DOCKER_BIN" network ls -q --no-trunc --filter "name=^${2}$" ;;
    *) return 2 ;;
  esac
}

prove_name_absent() {
  local ids
  ids="$(docker_named_ids "$1" "$2" 2>/dev/null)" || return 1
  [ -z "$ids" ]
}

# ---------------------------------------------------------------------------
# daemon-free self-test of the contract above
# ---------------------------------------------------------------------------

if [ "${1:-}" = "--verify-cleanup-contract" ]; then
  [ "$#" -eq 1 ] || fail "usage: scripts/verify_display_attach.sh [--verify-cleanup-contract]"
  owned_resource_matches id id nonce nonce name name ||
    fail "cleanup contract rejected its exact owned resource"
  if owned_resource_matches '' id nonce nonce name name; then
    fail "cleanup contract accepted a resource this invocation never acquired"
  fi
  if owned_resource_matches id other nonce nonce name name; then
    fail "cleanup contract accepted a replaced immutable id"
  fi
  if owned_resource_matches id id nonce foreign name name; then
    fail "cleanup contract accepted a foreign invocation label"
  fi
  if owned_resource_matches id id nonce nonce name foreign; then
    fail "cleanup contract accepted a foreign resource name"
  fi
  VALID_ID="$(printf '0%.0s' {1..64})"
  valid_docker_object_id "$VALID_ID" || fail "cleanup contract rejected a valid object id"
  for invalid in "${VALID_ID}0" "${VALID_ID%?}" "${VALID_ID%?}A" "sha256:$VALID_ID"; do
    if valid_docker_object_id "$invalid"; then
      fail "cleanup contract accepted a malformed object id"
    fi
  done

  # Tri-state absence, against a fake daemon. The case that matters is the
  # middle one: a listed object whose inspect failed is AMBIGUOUS, and treating
  # it as absent is how a verifier reports a clean teardown it did not perform.
  SELF_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-display-attach-selftest.XXXXXX")"
  FAKE_DOCKER="$SELF_TEST_DIR/docker"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -u' \
    'case "$1 $2" in' \
    '  "inspect --format") [ "${FAKE_INSPECT:-ok}" = ok ] && { printf "%s\n" "$FAKE_REF"; exit 0; }; exit 1 ;;' \
    'esac' \
    'case "$1" in' \
    '  ps) [ "${FAKE_LIST:-ok}" = ok ] || exit 9; [ "${FAKE_LISTED:-0}" = 1 ] && printf "%s\n" "$FAKE_REF"; exit 0 ;;' \
    '  rm) case "${FAKE_REMOVE:-ok}" in fail) exit 8 ;; lie) exit 0 ;; ok) printf "%s\n" removed >"$SELF_TEST_STATE"; exit 0 ;; esac ;;' \
    '  *) exit 9 ;;' \
    'esac' >"$FAKE_DOCKER"
  chmod 700 "$FAKE_DOCKER"
  export FAKE_REF="$VALID_ID" SELF_TEST_STATE="$SELF_TEST_DIR/state"
  DOCKER_BIN="$FAKE_DOCKER"

  QUERY=''
  FAKE_INSPECT=ok docker_query_state container "$VALID_ID" '{{.Id}}' QUERY ||
    fail "tri-state query rejected a readable object"
  [ "$QUERY" = "$VALID_ID" ] || fail "tri-state query changed the immutable id"

  RC=0
  FAKE_INSPECT=fail FAKE_LISTED=0 docker_query_state container "$VALID_ID" '{{.Id}}' QUERY || RC=$?
  [ "$RC" -eq 1 ] || fail "tri-state query did not distinguish proven absence"

  RC=0
  FAKE_INSPECT=fail FAKE_LISTED=1 docker_query_state container "$VALID_ID" '{{.Id}}' QUERY || RC=$?
  [ "$RC" -eq 2 ] || fail "tri-state query hid inspect failure for a listed object"

  RC=0
  FAKE_INSPECT=fail FAKE_LIST=fail docker_query_state container "$VALID_ID" '{{.Id}}' QUERY || RC=$?
  [ "$RC" -eq 2 ] || fail "tri-state query treated a daemon failure as absence"

  if FAKE_INSPECT=ok FAKE_REMOVE=lie docker_remove_and_verify container "$VALID_ID"; then
    fail "survivor absence check was false-green after a lying removal"
  fi
  if FAKE_REMOVE=fail docker_remove_and_verify container "$VALID_ID"; then
    fail "removal error did not propagate"
  fi

  DOCKER_BIN=docker
  rm -r -- "$SELF_TEST_DIR"
  note "PASS daemon-free ownership/tri-state-absence/removal contract"
  exit 0
fi
[ "$#" -eq 0 ] || fail "usage: scripts/verify_display_attach.sh [--verify-cleanup-contract]"

for command_name in cargo docker jq openssl python3; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "missing required command: $command_name"
done

# `psql` applies `infra/e2e/bootstrap_roles.sql`, and the conformance suite
# resolves it exactly this way (`resolve_psql`). Checked here as well so a
# missing client is a named failure in one second rather than a panic after a
# PostgreSQL boot — and NOT with a bare `command -v`, because Homebrew keeps
# libpq off PATH by default and that would refuse a machine that can run this.
if ! command -v psql >/dev/null 2>&1; then
  PSQL_FOUND=0
  for candidate in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
    if [ -x "$candidate/psql" ]; then
      PSQL_FOUND=1
      break
    fi
  done
  [ "$PSQL_FOUND" = "1" ] ||
    fail "psql not found on PATH or in the Homebrew libpq locations the suite falls back to"
fi

RUN_NONCE="$(openssl rand -hex 16)"
RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RUN_NONCE"
LABEL_KEY="com.momo.display-attach-verifier"
NETWORK="momo-display-attach-network-$RUN_TAG"
PG_CONTAINER="momo-display-attach-pg-$RUN_TAG"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-display-attach.XXXXXX")"
PG_PASSWORD="$(openssl rand -hex 24)"
PG_ENV_FILE="$TMP_DIR/postgres.env"
NETWORK_ID=""
PG_CONTAINER_ID=""
CLEANUP_DONE=0

perform_cleanup() {
  local failed=0 binding rc actual_id actual_name actual_label
  case "$TMP_DIR" in
    "${TMPDIR:-/tmp}"/momo-display-attach.*) rm -r -- "$TMP_DIR" 2>/dev/null || failed=1 ;;
    *) printf '[display-attach] refusing unexpected temp cleanup path: %s\n' "$TMP_DIR" >&2; failed=1 ;;
  esac

  if [ -n "$PG_CONTAINER_ID" ]; then
    rc=0
    docker_query_state container "$PG_CONTAINER_ID" \
      "{{.Id}}|{{.Name}}|{{ index .Config.Labels \"$LABEL_KEY\" }}" binding || rc=$?
    case "$rc" in
      1) ;; # already gone
      0)
        IFS='|' read -r actual_id actual_name actual_label <<EOF
$binding
EOF
        if owned_resource_matches "$PG_CONTAINER_ID" "$actual_id" "$RUN_TAG" "$actual_label" \
          "/$PG_CONTAINER" "$actual_name"; then
          docker_remove_and_verify container "$PG_CONTAINER_ID" || failed=1
        else
          printf '[display-attach] refusing foreign/replaced container cleanup\n' >&2
          failed=1
        fi
        ;;
      *) failed=1 ;;
    esac
  fi

  if [ -n "$NETWORK_ID" ]; then
    rc=0
    docker_query_state network "$NETWORK_ID" \
      "{{.Id}}|{{.Name}}|{{ index .Labels \"$LABEL_KEY\" }}" binding || rc=$?
    case "$rc" in
      1) ;;
      0)
        IFS='|' read -r actual_id actual_name actual_label <<EOF
$binding
EOF
        if owned_resource_matches "$NETWORK_ID" "$actual_id" "$RUN_TAG" "$actual_label" \
          "$NETWORK" "$actual_name"; then
          docker_remove_and_verify network "$NETWORK_ID" || failed=1
        else
          printf '[display-attach] refusing foreign/replaced network cleanup\n' >&2
          failed=1
        fi
        ;;
      *) failed=1 ;;
    esac
  fi

  # Absence is asserted, not assumed: a removal that returned 0 and left the
  # object behind is the failure this line exists for.
  [ -z "$PG_CONTAINER_ID" ] || docker_require_absent container "$PG_CONTAINER_ID" || failed=1
  [ -z "$NETWORK_ID" ] || docker_require_absent network "$NETWORK_ID" || failed=1

  if [ "$failed" -ne 0 ]; then
    printf '[display-attach] cleanup failed or an owned resource survived\n' >&2
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

# ---------------------------------------------------------------------------
# phase 3 first: it needs no daemon, so a drifted template fails in a second
# rather than after a PostgreSQL boot.
# ---------------------------------------------------------------------------

SPEC="infra/cubesandbox/display-template/template.spec.json"
[ -f "$SPEC" ] || fail "template spec missing: $SPEC"

spec_value() { jq -er "$1" "$SPEC" 2>/dev/null; }

note "phase 3/4: template spec ↔ server constant cross-read"

# The subprotocol the browser dials with must be the one the probe speaks.
SPEC_SUBPROTOCOL="$(spec_value '.signalling.subprotocol')" ||
  fail "spec does not declare signalling.subprotocol"
grep -Fq "SUBPROTOCOL = \"$SPEC_SUBPROTOCOL\"" scripts/display_signaling_probe.py ||
  fail "spec subprotocol '$SPEC_SUBPROTOCOL' is not the one the probe speaks"
# ...and the one the BROWSER dials with (LIVE-2). The probe stands in for a
# viewer; the web client IS one, and a template that agrees with the probe while
# disagreeing with the shipped client fails in front of a person rather than
# here.
grep -Fq "DISPLAY_SUBPROTOCOL = \"$SPEC_SUBPROTOCOL\"" \
  clients/web/src/features/work/displayStream.ts ||
  fail "spec subprotocol '$SPEC_SUBPROTOCOL' is not the one the web client dials"

# ADR-0165 D4 on the client side of the same absence. The producer not offering
# a datachannel is the guarantee; a VIEWER that could ask for one, or open one,
# would leave that guarantee resting entirely on the far side of the wire.
#
# The forms tested are the CODE forms, not the words: both files discuss
# `open_input` and `createDataChannel` at length in their headers, and a check
# that could not tell an explanation from an implementation would either fail on
# the documentation or be deleted for doing so. `displayStream.test.ts` holds the
# comment-stripped form of this over both files; these two are here so the
# display verifier fails on its own without a node toolchain.
! grep -Fq '"open_input"' clients/web/src/features/work/displayStream.ts ||
  fail "the web client encodes open_input — ADR-0165 D4 makes view-only the absence of that encoder"
! grep -Fq 'createDataChannel(' clients/web/src/features/work/DisplayObserver.tsx ||
  fail "the web display surface opens a datachannel — ADR-0165 D4"

# The capability grammar is the server's, not a second one.
SPEC_PREFIX="$(spec_value '.signalling.capabilityPrefix')" ||
  fail "spec does not declare signalling.capabilityPrefix"
grep -Fq "CAPABILITY_PREFIX: &str = \"$SPEC_PREFIX\"" \
  server-rust/crates/momo-t3/src/terminal_attach.rs ||
  fail "spec capability prefix '$SPEC_PREFIX' is not momo_t3's"

# The advertisement key is the one issuance is fail-closed on.
SPEC_CAPABILITY_KEY="$(spec_value '.workdRegistration.advertise.capabilityKey')" ||
  fail "spec does not declare workdRegistration.advertise.capabilityKey"
grep -Fq "HOST_DISPLAY_CAPABILITY_KEY: &str = \"$SPEC_CAPABILITY_KEY\"" \
  server-rust/crates/momo-t3/src/terminal_attach.rs ||
  fail "spec host capability key '$SPEC_CAPABILITY_KEY' is not the one the server gates on"

# Both signed routes exist, spelled the way the spec tells a daemon to call them.
for spec_route in '.signalling.validateRoute' '.workdRegistration.publishBinding.route'; do
  route="$(spec_value "$spec_route")" || fail "spec does not declare $spec_route"
  # `POST /path` or a bare path; reduce to the axum template the router mounts.
  route="${route##* }"
  route="$(printf '%s' "$route" | sed -e 's|{workspace}|{ws}|' -e 's|{session}|{session}|' -e 's|{host}|{host}|')"
  grep -Fq "\"$route\"" server-rust/bins/momo-server/src/lib.rs ||
    fail "spec route '$route' is not mounted by the router"
  grep -Fq "$(basename "$route")" server-rust/bins/momo-server/src/work_host_auth.rs ||
    fail "spec route '$route' is not on the signed-path allow-list"
done

# The ADR-0165 absences, asserted as absences.
[ "$(spec_value '.producer.inputDatachannel')" = "false" ] ||
  fail "spec declares an input datachannel — ADR-0165 D4 says view-only is its absence"
[ "$(spec_value '.producer.recording')" = "false" ] ||
  fail "spec declares recording — ADR-0165 D5 forbids it"
[ "$(spec_value '.ice.turn')" = "null" ] ||
  fail "spec names a TURN server — ADR-0165 D3 forbids a third-party one and makes an oort one an ADR 증보"
[ "$(spec_value '.producer.direction')" = "sendonly" ] ||
  fail "spec does not declare a sendonly producer"
# The honest label is part of the spec, not a footnote to it.
spec_value '.unverified.iceReachability' >/dev/null ||
  fail "spec dropped the named unmeasured items — an honest label that can be deleted silently is not one"
note "PASS template spec agrees with the server it registers with"

# ---------------------------------------------------------------------------
# phase 2: the signalling contract, and proof the probe can fail
# ---------------------------------------------------------------------------

note "phase 2/4: two-peer signalling round trip + red proof"
python3 scripts/display_signaling_probe.py --prove-red >"$TMP_DIR/probe-red.log" 2>&1 || {
  cat "$TMP_DIR/probe-red.log" >&2
  fail "the signalling probe did not catch a producer that negotiates a datachannel"
}
python3 scripts/display_signaling_probe.py >"$TMP_DIR/probe.log" 2>&1 || {
  cat "$TMP_DIR/probe.log" >&2
  fail "the view-only signalling round trip did not complete"
}
grep -Fq "PASS subprotocol/validate/view_only/no_input" "$TMP_DIR/probe.log" ||
  fail "the probe did not report its four named stages"

# ---------------------------------------------------------------------------
# phase 1: the capability plane against a real PostgreSQL 18
# ---------------------------------------------------------------------------

prove_name_absent network "$NETWORK" ||
  fail "network name already exists or could not be proven absent"
prove_name_absent container "$PG_CONTAINER" ||
  fail "PostgreSQL container name already exists or could not be proven absent"

note "phase 1/4: capability plane on isolated PostgreSQL 18 + the real Axum router"
NETWORK_ID="$("$DOCKER_BIN" network create --label "$LABEL_KEY=$RUN_TAG" "$NETWORK")"
valid_docker_object_id "$NETWORK_ID" || fail "Docker returned a malformed network id"

# The password reaches PostgreSQL through a private 0600 env file, never argv.
(umask 077; printf 'POSTGRES_DB=momo\nPOSTGRES_USER=momo\nPOSTGRES_PASSWORD=%s\n' \
  "$PG_PASSWORD" >"$PG_ENV_FILE")
PG_CONTAINER_ID="$("$DOCKER_BIN" run --detach \
  --name "$PG_CONTAINER" \
  --label "$LABEL_KEY=$RUN_TAG" \
  --network "$NETWORK_ID" \
  --publish 127.0.0.1::5432 \
  --env-file "$PG_ENV_FILE" \
  pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e)"
valid_docker_object_id "$PG_CONTAINER_ID" || fail "Docker returned a malformed container id"

for _ in $(seq 1 90); do
  if "$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null 2>&1 ||
  fail "PostgreSQL 18 did not become ready"

PG_BINDING="$("$DOCKER_BIN" port "$PG_CONTAINER_ID" 5432/tcp | head -1)"
PG_PORT="${PG_BINDING##*:}"
case "$PG_PORT" in
  ''|*[!0-9]*) fail "could not resolve the isolated PostgreSQL host port" ;;
esac

run_suite() {
  local suite="$1"
  (
    cd server-rust
    PGHOST=127.0.0.1 PGPORT="$PG_PORT" PGUSER=momo PGDATABASE=momo \
      PGPASSWORD="$PG_PASSWORD" \
      DATABASE_URL="postgres://momo:$PG_PASSWORD@127.0.0.1:$PG_PORT/momo" \
      MOMO_APP_PASSWORD=momo_app_dev_pw \
      cargo test -p momo-server --test "$suite" -- --ignored --test-threads=1
  )
}

run_suite display_attach_conformance_pg || fail "display attach conformance failed"

# ---------------------------------------------------------------------------
# phase 4: the suites this goal extended must still be green
# ---------------------------------------------------------------------------

if [ "${DISPLAY_ATTACH_VERIFY_REGRESSION:-1}" = "1" ]; then
  note "phase 4/4: no regression in the PTY attach + reattach suites"
  # `terminal_attach.rs` grew a `kind` axis and the three session projections
  # grew a column. These are the suites that would notice.
  run_suite reattach_smoke_pg || fail "reattach/terminal-attach regression"
  run_suite t3_smoke_pg || fail "T3 lifecycle regression"
  run_suite work_control_spawn_conformance_pg || fail "work-control spawn regression"
  run_suite daemon_ack_resume_conformance_pg || fail "daemon ack/resume regression"
else
  note "phase 4/4 skipped (DISPLAY_ATTACH_VERIFY_REGRESSION=0)"
fi

perform_cleanup || fail "explicit normal teardown failed"
trap - EXIT INT TERM
note "PASS host-signed binding / observer-only issuance / fail-closed advertisement / revocation"
note "PASS remoteDisplayAvailable across list, reattach and RETURNING"
note "PASS two-peer view-only signalling contract (red proof included)"
note "runtime-unverified(cubesandbox webrtc producer): no microVM was built or booted;"
note "  ICE reachability from a browser to a sandbox remains unmeasured —"
note "  see infra/cubesandbox/display-template/README.md"
