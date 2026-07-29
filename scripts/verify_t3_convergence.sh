#!/usr/bin/env bash
# MOMO-668 / ADR-0140 D4 — T-4 convergence.
#
# What this gate claims, in one sentence: every way a T3 provider call can fail
# to answer has exactly one named landing place, the landing place is reached by
# asking the provider what is true rather than by guessing, and a response whose
# durable intent has been superseded cannot land anywhere at all.
#
# The ADR-0140 D4 table, one runtime scenario per row:
#   pausing failed        -> running, and billing never stopped (no `paused`
#                            interval was ever opened)
#   resuming failed       -> paused, and no `active` interval was opened
#   pausing + gone        -> t3_terminate('provider_missing'), settled once
#   destroy failed        -> retried forever with growing backoff, then converges
#                            the moment the provider recovers
#   deadline exceeded     -> the provider is *asked* (probe), and the answer —
#                            not the timer — decides. Proven twice: a resume
#                            converges to running on `present` without a second
#                            resume call, and a pause reverts to running.
#
# red proof: `T3_CONVERGENCE_PROVE_RED=stale-response` rewrites
# `t3_lifecycle_intent_is_current` (migration 057) to `RETURN true` in an
# isolated repo copy — i.e. removes the (operation_id, version) revalidation —
# and requires the named `stale-response-changed-state` assertion to fail. With
# the guard in place the superseded pause response is discarded; without it, a
# provider answer about an operation nobody is running any more closes the
# billing interval of a sandbox that is provably still running.
#
# Docker verification is the orchestrator's to run. `T3_GATE_RUN_DOCKER=0` keeps
# the static half.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-convergence] $*"; }
fail() { echo "[t3-convergence] FAIL $*" >&2; exit 1; }
pass() { echo "[t3-convergence] PASS $*"; }

# ---- red proof: isolated source copy -----------------------------------------

if [ "${T3_CONVERGENCE_PROVE_RED:-}" = "stale-response" ] \
  && [ "${T3_CONVERGENCE_RED_CHILD:-0}" != "1" ]; then
  RED_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-convergence-red.XXXXXX")"
  RED_LOG="$RED_ROOT/red-proof.log"
  python3 - "$REPO_ROOT" "$RED_ROOT/repo" <<'PY'
import shutil
import sys

source, destination = sys.argv[1:]
ignored = {".git", ".build", ".swiftpm", "DerivedData", "node_modules"}


def ignore(directory, names):
    return {
        name for name in names
        if name in ignored or name == ".env" or name.startswith(".env.")
    }


shutil.copytree(source, destination, ignore=ignore)
PY
  python3 - "$RED_ROOT/repo/server/Migrations/057_t3_lifecycle_deadline.sql" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
needle = """  RETURN v_state IS NOT DISTINCT FROM p_expected_state
     AND v_operation_id IS NOT DISTINCT FROM p_operation_id
     AND v_version IS NOT DISTINCT FROM p_version;
"""
if source.count(needle) != 1:
    raise SystemExit("[t3-convergence] red proof mutation marker drifted")
path.write_text(source.replace(needle, "  RETURN true;\n", 1))
PY
  set +e
  T3_CONVERGENCE_RED_CHILD=1 \
    T3_CONVERGENCE_PROJECT="${T3_CONVERGENCE_PROJECT:-momo668conv}red" \
    bash "$RED_ROOT/repo/scripts/verify_t3_convergence.sh" >"$RED_LOG" 2>&1
  RED_STATUS=$?
  set -e
  if [ "$RED_STATUS" -eq 0 ] \
    || ! grep -q "FAIL stale-response-changed-state" "$RED_LOG"; then
    cat "$RED_LOG" >&2
    case "$RED_ROOT" in
      "${TMPDIR:-/tmp}"/momo-t3-convergence-red.*) rm -r -- "$RED_ROOT" ;;
    esac
    fail "stale-response red proof did not fail by name"
  fi
  case "$RED_ROOT" in
    "${TMPDIR:-/tmp}"/momo-t3-convergence-red.*) rm -r -- "$RED_ROOT" ;;
  esac
  pass "red proof: removing the (operation_id, version) revalidation lets a superseded provider response change state"
  exit 0
fi

# ---- static half -------------------------------------------------------------

MIGRATION="server/Migrations/057_t3_lifecycle_deadline.sql"
RULES="services/CloudProviderKit/Sources/CloudProviderKit/CloudLifecycleConvergence.swift"
RECONCILER="workers/NotifierWorker/Sources/NotifierWorker/CloudLifecycleReconciler.swift"
ROUTES="server/Sources/MomoServer/Routes/CloudProvisionerRoutes.swift"
for required in "$MIGRATION" "$RULES" "$RECONCILER" "$ROUTES" \
  "server/Sources/MomoServer/Cloud/T3LifecycleIntent.swift" \
  "workers/NotifierWorker/Sources/NotifierWorker/T3LifecycleIntent.swift"; do
  test -f "$required" || fail "missing $required"
done

grep -q "work_cloud_host_deadline_ck" "$MIGRATION" \
  || fail "named gate deadline-is-structural"
grep -q "t3_lifecycle_intent_is_current" "$MIGRATION" \
  || fail "named gate stale-response-guard-exists"
grep -q "t3_claim_lifecycle_operation" "$MIGRATION" \
  || fail "named gate durable-claim-bumps-version"
grep -q "pause_abandoned" "$MIGRATION" && grep -q "resume_abandoned" "$MIGRATION" \
  || fail "named gate convergence-transitions-declared"
grep -q "afterDeadline" "$RULES" && grep -q "afterProviderCall" "$RULES" \
  || fail "named gate convergence-table-is-one-place"
grep -q "T3LifecycleIntent.isCurrent" "$RECONCILER" \
  || fail "named gate reconciler-revalidates"
grep -q "T3LifecycleIntent.isCurrent" "$ROUTES" \
  || fail "named gate rest-revalidates"
# ADR-0140 D4 ②: the idempotency key is the durable operation, never the host.
grep -q "let idempotencyKey = operationID.uuidString.lowercased()" "$RECONCILER" \
  || fail "named gate idempotency-key-is-the-operation"
grep -q "idempotencyKey: target.operationID.uuidString.lowercased()" \
  server/Sources/MomoServer/Routes/WorkSessionRoutes.swift \
  || fail "named gate host-pause-idempotency-key-is-the-operation"
# 052/053 are sealed by this ticket's contract.
if git diff --name-only HEAD -- \
  server/Migrations/052_t3_lifecycle_advisory_lock.sql \
  server/Migrations/053_t3_lifecycle_canonicalization.sql | grep -q .; then
  fail "migrations 052/053 must not change"
fi
if git diff --name-only HEAD -- schema_v0.sql | grep -q .; then
  fail "schema_v0.sql must not change"
fi
scripts/check_migration_numbers.sh server/Migrations >/dev/null
bash -n "$0"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" \
  python3 -m py_compile scripts/mock_provider.py

if [ "${T3_GATE_RUN_DOCKER:-1}" != "1" ]; then
  pass "static convergence-rule, deadline and revalidation checks"
  exit 0
fi

# ---- runtime half ------------------------------------------------------------

for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing $tool"
done

find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-t3conv-openssl.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" genpkey -algorithm ED25519 -out "$probe" >/dev/null 2>&1; then
      rm -f "$probe"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  rm -f "$probe"
  fail "no OpenSSL with Ed25519 support found"
}
OPENSSL_BIN="$(find_openssl)"

# Never sources .env: the provider key below is a literal fake pointed at a
# local mock substrate.
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
SAFE_ENV_FILE="$REPO_ROOT/infra/.env.example"
PROJECT="${T3_CONVERGENCE_PROJECT:-momo668conv}"
API_PORT="${T3_CONVERGENCE_API_PORT:-28070}"
PG_PORT="${T3_CONVERGENCE_POSTGRES_PORT:-28071}"
CENT_PORT_HOST="${T3_CONVERGENCE_CENTRIFUGO_PORT:-28072}"
HERMES_PORT_HOST="${T3_CONVERGENCE_HERMES_PORT:-28073}"
PUSH_PORT_HOST="${T3_CONVERGENCE_PUSH_RELAY_PORT:-28074}"
MOCK_PORT="${T3_CONVERGENCE_MOCK_PORT:-28075}"
BOOT_TIMEOUT="${T3_CONVERGENCE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${T3_CONVERGENCE_ASSERT_TIMEOUT:-180}"
RUN_TAG="$(date -u +%s)-$$"
OWNER_EMAIL="t3conv-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="t3conv-$RUN_TAG"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-convergence.XXXXXX")"
BASE_URL="http://127.0.0.1:$API_PORT"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" PUSH_RELAY_PORT="$PUSH_PORT_HOST" \
    MOMO_T3_ENABLED=1 \
    MOMO_T3_PROVIDER="mock-a" \
    MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL="http://host.docker.internal:$MOCK_PORT" \
    MOMO_T3_PROVIDER_MOCK_A_API_KEY="mock-a-not-a-credential" \
    MOMO_T3_PROVIDER_MOCK_A_IMAGE_REF="momo-workd" \
    MOMO_PUBLIC_BASE_URL="https://momo.invalid" \
    MOMO_T3_RATE_MICRO_USD_PER_SECOND=25 \
    PLATFORM_ADMIN_EMAILS="$OWNER_EMAIL" \
    PLATFORM_ADMIN_LOGIN_SECRET="local-gate-admin-secret" \
    MOMO_HOST_OFFLINE_GRACE_S=1 NOTIFIER_POLL_INTERVAL_MS=100 \
    docker compose --env-file "$SAFE_ENV_FILE" -p "$PROJECT" -f "$COMPOSE_FILE" \
      --profile push "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "${MOCK_PID:-}" ]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  if [ "${T3_CONVERGENCE_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-t3-convergence.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[t3-convergence] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 scripts/mock_provider.py --host 0.0.0.0 --port "$MOCK_PORT" \
  --provider-id mock-a >"$TMP_DIR/mock-a.log" 2>&1 &
MOCK_PID=$!
deadline=$(( $(date -u +%s) + 30 ))
until curl -fsS "http://127.0.0.1:$MOCK_PORT/health" >/dev/null 2>&1; do
  [ "$(date -u +%s)" -lt "$deadline" ] || fail "mock substrate health timeout"
  sleep 1
done

control() { curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/controls/$1" >/dev/null; }
mock_count() {
  curl -fsS "http://127.0.0.1:$MOCK_PORT/requests" \
    | jq "[.requests[] | select(.path | endswith(\"$1\"))] | length"
}

wait_api() {
  local deadline
  deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
  until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
    if [ "$(date -u +%s)" -ge "$deadline" ]; then
      compose logs --tail 200 api >&2 || true
      fail "API health timeout"
    fi
    sleep 2
  done
}

log "booting isolated PG18/API with mock-a as the substrate"
compose up -d api
wait_api

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" \
    -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
OWNER_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TOPUP_REF="$(python3 -c 'import uuid; print(uuid.uuid4())')"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$OWNER_ID'::uuid, '$WS_ID'::uuid, 'human'::member_kind,
        'active'::member_status, 'T3 Conv Owner', 't3conv-owner-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID'::uuid, '$WS_ID'::uuid, '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID'::uuid, '$OWNER_ID'::uuid, 'owner');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID'::uuid, '$CHANNEL_ID'::uuid, '$OWNER_ID'::uuid, 'owner');
UPDATE work_pool SET max_active=8, per_member_soft_limit=8
 WHERE workspace_id='$WS_ID'::uuid;
COMMIT;
SQL

login() {
  TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w,
        platformAdminSecret:"local-gate-admin-secret"}')" | jq -er '.accessToken')"
}
login

STATUS=""
BODY=""
api() {
  local method="$1" path="$2" data="${3:-}"
  local -a args=(-sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN")
  [ -n "$data" ] && args+=(--data "$data")
  STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  BODY="$(<"$TMP_DIR/response.json")"
}
expect_status() {
  [ "$STATUS" = "$1" ] || {
    echo "$BODY" >&2
    fail "$2: expected $1 got $STATUS"
  }
}
expect_failure() {
  case "$STATUS" in
    2*) echo "$BODY" >&2; fail "$1: expected a refusal, got $STATUS" ;;
  esac
}

api POST "/v1/admin/workspaces/$WS_ID/credits/topups" \
  "$(jq -cn --arg ref "$TOPUP_REF" '{amountMicroUsd:9000000,idempotencyRef:$ref}')"
expect_status 200 "instance-operator topup"

compose up -d notifier

# Provision one host and let the cloud workd consume its one-shot token exactly
# as it would in production.
provision_host() {
  local label="$1" create_ref private_key public_der public_key
  local bootstrap_token register_body deadline seen_before
  create_ref="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  seen_before="$(mock_count '/v1/instances')"

  api POST "/v1/workspaces/$WS_ID/work-hosts/cloud" \
    "$(jq -cn --arg ref "$create_ref" --arg n "$label" \
      '{displayName:$n,confirmPaidCloud:true,idempotencyRef:$ref}')"
  expect_status 202 "$label provisioning accepted"

  deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  bootstrap_token=""
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    bootstrap_token="$(curl -fsS "http://127.0.0.1:$MOCK_PORT/requests" \
      | jq -r "[.requests[] | select(.path == \"/v1/instances\")][$seen_before].body.env.MOMO_WORKD_REGISTRATION_TOKEN // empty")"
    [ -n "$bootstrap_token" ] && break
    sleep 1
  done
  [ -n "$bootstrap_token" ] || fail "$label: reconciler never created an instance"

  private_key="$TMP_DIR/$label-private.pem"
  public_der="$TMP_DIR/$label-public.der"
  "$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$private_key" >/dev/null 2>&1
  "$OPENSSL_BIN" pkey -in "$private_key" -pubout -outform DER \
    -out "$public_der" >/dev/null 2>&1
  public_key="$(tail -c 32 "$public_der" | "$OPENSSL_BIN" base64 -A)"
  register_body="$(jq -cn --arg key "$public_key" --arg n "$label" \
    '{scope:"workspace",type:"cloud",displayName:$n,publicKey:$key,
      capabilities:{"tool.codex":true}}')"
  STATUS="$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X POST \
    "$BASE_URL/v1/workspaces/$WS_ID/work-hosts/cloud/register" \
    -H 'Content-Type: application/json' \
    -H "Authorization: MomoBootstrap $bootstrap_token" \
    --data "$register_body")"
  BODY="$(<"$TMP_DIR/response.json")"
  expect_status 201 "$label cloud workd self-registration"
  PROVISIONED_HOST_ID="$(printf '%s' "$BODY" | jq -er '.workHost.id')"
}

cloud_state() {
  sql_value <<SQL
SELECT state FROM work_cloud_host WHERE host_id='$1'::uuid;
SQL
}
wait_cloud_state() {
  local host_id="$1" want="$2" name="$3" seen deadline
  deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    seen="$(cloud_state "$host_id")"
    [ "$seen" = "$want" ] && return 0
    sleep 1
  done
  compose logs --tail 200 notifier >&2 || true
  fail "$name: cloud host stayed '$seen', expected '$want'"
}
interval_counts() {
  sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_host_usage_interval i
     JOIN work_host_usage u ON u.id=i.usage_id
    WHERE u.host_id='$1'::uuid AND i.state='active') || ':' ||
  (SELECT count(*) FROM work_host_usage_interval i
     JOIN work_host_usage u ON u.id=i.usage_id
    WHERE u.host_id='$1'::uuid AND i.state='paused');
SQL
}
session_status() {
  sql_value <<SQL
SELECT status FROM work_session WHERE id='$1'::uuid;
SQL
}

provision_host "conv-primary"
HOST_A="$PROVISIONED_HOST_ID"
api POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg ch "$CHANNEL_ID" --arg host "$HOST_A" \
    '{channelId:$ch,hostId:$host,tool:"codex",label:"convergence"}')"
expect_status 201 "work session create"
SESSION_A="$(printf '%s' "$BODY" | jq -er '.workSession.id')"
pass "host provisioned, registered, and running a paid session"

# --- 1. pausing failed -> running, and billing never stopped ------------------
control fail-pause
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_A/cloud/pause"
expect_failure "a refused pause must not answer 2xx"
wait_cloud_state "$HOST_A" "running" "pause-failure-converges-to-running"
[ "$(interval_counts "$HOST_A")" = "1:0" ] \
  || fail "pause-failure-keeps-billing: $(interval_counts "$HOST_A")"
[ "$(session_status "$SESSION_A")" = "running" ] \
  || fail "pause-failure-keeps-session-running: $(session_status "$SESSION_A")"
pass "a pause that did not happen returns to running with the meter still on"

# --- 2. resuming failed -> paused, and no interval is opened ------------------
control heal
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_A/cloud/pause"
expect_status 200 "healthy pause"
[ "$(interval_counts "$HOST_A")" = "1:1" ] \
  || fail "pause-opens-exactly-one-paused-interval: $(interval_counts "$HOST_A")"

control fail-resume
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_A/cloud/resume"
expect_failure "a refused resume must not answer 2xx"
wait_cloud_state "$HOST_A" "paused" "resume-failure-converges-to-paused"
[ "$(interval_counts "$HOST_A")" = "1:1" ] \
  || fail "resume-failure-opens-no-interval: $(interval_counts "$HOST_A")"
[ "$(session_status "$SESSION_A")" = "idle" ] \
  || fail "resume-failure-keeps-session-idle: $(session_status "$SESSION_A")"
pass "a resume that did not happen returns to paused and opens no billing interval"

# --- 3. deadline exceeded -> probe decides, not the timer ---------------------
# The substrate is healthy and the instance is alive. A `resuming` intent whose
# deadline has already passed must converge on what the provider *says*, and it
# must do so without issuing a second resume — the probe is the evidence.
control heal
RESUME_CALLS_BEFORE="$(mock_count '/resume')"
run_sql <<SQL
UPDATE work_cloud_host
   SET state='resuming',
       lifecycle_operation_id=uuidv7(),
       lifecycle_operation_kind='resume',
       lifecycle_operation_started_at=clock_timestamp() - interval '10 minutes',
       lifecycle_operation_deadline_at=clock_timestamp() - interval '5 minutes',
       lifecycle_operation_attempts=0,
       lifecycle_operation_next_attempt_at=NULL,
       lifecycle_operation_version=lifecycle_operation_version + 1
 WHERE host_id='$HOST_A'::uuid;
SQL
wait_cloud_state "$HOST_A" "running" "deadline-probe-converges"
[ "$(mock_count '/resume')" = "$RESUME_CALLS_BEFORE" ] \
  || fail "deadline-converges-on-the-probe-not-a-retry"
[ "$(interval_counts "$HOST_A")" = "2:1" ] \
  || fail "deadline-resume-opens-exactly-one-active-interval: $(interval_counts "$HOST_A")"
[ "$(session_status "$SESSION_A")" = "running" ] \
  || fail "deadline-resume-restores-the-session: $(session_status "$SESSION_A")"
pass "an expired intent converged on the provider's answer, with no second call"

# --- 4. the instance is gone -> provider_missing, settled exactly once --------
control resume-missing
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_A/cloud/pause"
expect_failure "pause against a dead instance must not answer 2xx"
CONVERGED=""
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  CONVERGED="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_cloud_host
    WHERE host_id='$HOST_A'::uuid AND state='destroyed') || ':' ||
  (SELECT count(*) FROM work_host_usage
    WHERE session_id='$SESSION_A'::uuid
      AND settled_at IS NOT NULL
      AND settled_reason='provider_missing') || ':' ||
  (SELECT count(*) FROM credit_entry
    WHERE workspace_id='$WS_ID'::uuid AND reason='t3_usage'
      AND lower(ref_id::text)=lower('$SESSION_A')) || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.cloud.resume_failed'
      AND lower(detail->>'session_id')=lower('$SESSION_A')
      AND detail->>'reason'='sandbox_missing');
SQL
)"
  [ "$CONVERGED" = "1:1:1:1" ] && break
  sleep 1
done
[ "$CONVERGED" = "1:1:1:1" ] || {
  compose logs --tail 200 notifier >&2 || true
  fail "provider-missing-convergence: $CONVERGED"
}
pass "a provably gone instance settled once through t3_terminate('provider_missing')"

# --- 5. destroy is never abandoned -------------------------------------------
control heal
provision_host "conv-destroy"
HOST_B="$PROVISIONED_HOST_ID"
control fail-destroy
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_B/cloud/destroy"
expect_failure "a refused destroy must not answer 2xx"

BACKOFF=""
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  BACKOFF="$(sql_value <<SQL
SELECT state || ':' || (lifecycle_operation_attempts >= 3)::text || ':' ||
       (lifecycle_operation_next_attempt_at
          > clock_timestamp() + interval '10 seconds')::text
  FROM work_cloud_host WHERE host_id='$HOST_B'::uuid;
SQL
)"
  [ "$BACKOFF" = "destroy_pending:true:true" ] && break
  sleep 2
done
[ "$BACKOFF" = "destroy_pending:true:true" ] \
  || fail "destroy-retries-forever-with-backoff: $BACKOFF"

control heal
run_sql <<SQL
UPDATE work_cloud_host SET lifecycle_operation_next_attempt_at = clock_timestamp()
 WHERE host_id='$HOST_B'::uuid;
SQL
wait_cloud_state "$HOST_B" "destroyed" "destroy-converges-once-the-provider-recovers"
pass "destroy retried with growing backoff and converged the moment it could"

# --- 6. a superseded provider response changes nothing (red-proof scenario) ---
control heal
provision_host "conv-stale"
HOST_C="$PROVISIONED_HOST_ID"
api POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg ch "$CHANNEL_ID" --arg host "$HOST_C" \
    '{channelId:$ch,hostId:$host,tool:"codex",label:"stale response"}')"
expect_status 201 "stale-scenario work session create"
SESSION_C="$(printf '%s' "$BODY" | jq -er '.workSession.id')"

# The first pause is held open at the substrate: the instance keeps running for
# the whole scenario, so any later `paused` reading is provably false.
control pause-block-then-fail
curl -sS -o "$TMP_DIR/stale-pause.json" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/v1/workspaces/$WS_ID/work-hosts/$HOST_C/cloud/pause" \
  >"$TMP_DIR/stale-pause.status" 2>/dev/null &
STALE_PID=$!

deadline=$(( $(date -u +%s) + 60 ))
until [ "$(cloud_state "$HOST_C")" = "pausing" ]; do
  [ "$(date -u +%s)" -lt "$deadline" ] || fail "stale-scenario: intent never committed"
  sleep 1
done
OPERATION_1="$(sql_value <<SQL
SELECT lower(lifecycle_operation_id::text) FROM work_cloud_host
 WHERE host_id='$HOST_C'::uuid;
SQL
)"

# Expire the intent. The reconciler probes, the instance answers `present`, and
# ADR-0140 D4 sends a pause that never happened back to `running`.
run_sql <<SQL
UPDATE work_cloud_host
   SET lifecycle_operation_deadline_at = clock_timestamp() - interval '1 minute',
       lifecycle_operation_next_attempt_at = clock_timestamp()
 WHERE host_id='$HOST_C'::uuid;
SQL
wait_cloud_state "$HOST_C" "running" "pausing-deadline-reverts-to-running"

# A second pause supersedes the first operation and is refused by the substrate,
# so the host is left in `pausing` under an operation nobody answered.
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_C/cloud/pause"
expect_failure "superseding pause must not answer 2xx"
OPERATION_2="$(sql_value <<SQL
SELECT lower(lifecycle_operation_id::text) FROM work_cloud_host
 WHERE host_id='$HOST_C'::uuid;
SQL
)"
[ "$OPERATION_1" != "$OPERATION_2" ] \
  || fail "stale-scenario: the second pause did not supersede the first"

# Take the reconciler out so the only writer left is the stale response itself.
compose stop notifier >/dev/null 2>&1 || true
control release-pause
wait "$STALE_PID" 2>/dev/null || true
sleep 3

STALE_RESULT="$(sql_value <<SQL
SELECT (SELECT count(*) FROM work_cloud_host
         WHERE host_id='$HOST_C'::uuid AND state='paused') || ':' ||
       (SELECT count(*) FROM work_host_usage_interval i
          JOIN work_host_usage u ON u.id=i.usage_id
         WHERE u.host_id='$HOST_C'::uuid AND i.state='paused') || ':' ||
       (SELECT status FROM work_session WHERE id='$SESSION_C'::uuid);
SQL
)"
# Reached under the red proof: with the (operation_id, version) revalidation
# removed, a response about an operation that was abandoned minutes ago closes
# the billing interval of a sandbox the substrate is still running.
[ "$STALE_RESULT" = "0:0:running" ] \
  || fail "stale-response-changed-state: $STALE_RESULT"
compose start notifier >/dev/null 2>&1 || true
pass "a superseded provider response was discarded, not applied"

pass "ADR-0140 D4 convergence: every phase lands by name, deadlines are decided by the provider, and stale responses die"
