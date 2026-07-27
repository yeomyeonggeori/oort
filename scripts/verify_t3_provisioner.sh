#!/usr/bin/env bash
# MOMO-647 / ADR-0136 T3 provisioner + active-time credit ledger gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-provisioner] $*"; }
fail() { echo "[t3-provisioner] FAIL $*" >&2; exit 1; }
pass() { echo "[t3-provisioner] PASS $*"; }

MIGRATION="server/Migrations/045_t3_provisioner_credit_ledger.sql"
test -f "$MIGRATION" || fail "missing $MIGRATION"
grep -q "CREATE TABLE work_host_usage_interval" "$MIGRATION" \
  || fail "active/pause interval ledger missing"
grep -q "WHEN state = 'active' AND ended_at IS NOT NULL" "$MIGRATION" \
  || fail "active seconds must be generated only for active intervals"
grep -q "ALTER TABLE %I FORCE ROW LEVEL SECURITY" "$MIGRATION" \
  || fail "new tenant tables must FORCE RLS"
if git diff --name-only HEAD -- schema_v0.sql | grep -q .; then
  fail "schema_v0.sql must not change"
fi
scripts/check_migration_numbers.sh server/Migrations >/dev/null
bash -n "$0"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" \
  python3 -m py_compile scripts/mock_e2b.py

if [ "${T3_GATE_RUN_DOCKER:-1}" != "1" ]; then
  pass "static migration and fixture checks"
  exit 0
fi

for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing $tool"
done

# Deliberately never source .env/.env.worktree. MOMO-647 E2B credentials are
# orchestrator-owned; this gate uses a literal fake key against a local mock.
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
SAFE_ENV_FILE="$REPO_ROOT/infra/.env.example"
PROJECT="${T3_GATE_PROJECT:-momo855t3}"
API_PORT="${T3_GATE_API_PORT:-28050}"
PG_PORT="${T3_GATE_POSTGRES_PORT:-28051}"
CENT_PORT_HOST="${T3_GATE_CENTRIFUGO_PORT:-28052}"
HERMES_PORT_HOST="${T3_GATE_HERMES_PORT:-28053}"
MOCK_E2B_PORT="${T3_GATE_MOCK_E2B_PORT:-28055}"
BOOT_TIMEOUT="${T3_GATE_BOOT_TIMEOUT:-2400}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-provisioner.XXXXXX")"
BASE_URL="http://127.0.0.1:$API_PORT"
GATE_E2B_KEY=""

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    E2B_API_BASE_URL="http://host.docker.internal:$MOCK_E2B_PORT" \
    E2B_API_KEY="$GATE_E2B_KEY" E2B_TEMPLATE_ID="momo-workd" \
    MOMO_PUBLIC_BASE_URL="https://momo.invalid" \
    MOMO_T3_RATE_MICRO_USD_PER_SECOND=25 \
    docker compose --env-file "$SAFE_ENV_FILE" -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "${MOCK_E2B_PID:-}" ]; then
    kill "$MOCK_E2B_PID" >/dev/null 2>&1 || true
    wait "$MOCK_E2B_PID" >/dev/null 2>&1 || true
  fi
  if [ "${T3_GATE_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-t3-provisioner.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[t3-provisioner] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 scripts/mock_e2b.py --host 0.0.0.0 --port "$MOCK_E2B_PORT" \
  >"$TMP_DIR/mock-e2b.log" 2>&1 &
MOCK_E2B_PID=$!
deadline=$(( $(date -u +%s) + 30 ))
until curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/health" >/dev/null 2>&1; do
  [ "$(date -u +%s)" -lt "$deadline" ] || fail "mock E2B health timeout"
  sleep 1
done

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

log "booting isolated PG18/API with E2B key absent"
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
OWNER_EMAIL="t3-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="t3-$RUN_TAG"
TOPUP_REF="$(python3 -c 'import uuid; print(uuid.uuid4())')"
DUMMY_PROVISION="$(python3 -c 'import uuid; print(uuid.uuid4())')"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$OWNER_ID', '$WS_ID', 'human', 'active', 'T3 Owner', 't3-owner-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID', '$OWNER_ID', 'owner');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner');
COMMIT;
SQL

TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken')"

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

CLOUD_PATH="/v1/workspaces/$WS_ID/work-hosts/cloud"
api POST "$CLOUD_PATH" '{"displayName":"T3 gate","confirmPaidCloud":true}'
expect_status 503 "missing E2B key must fail only T3 closed"
printf '%s' "$BODY" | jq -er '.error.message | contains("E2B")' >/dev/null
pass "missing key returns readable 503"

GATE_E2B_KEY="local-mock-not-a-credential"
compose up -d --force-recreate api
wait_api

api POST "$CLOUD_PATH" '{"displayName":"T3 gate","confirmPaidCloud":true}'
expect_status 409 "missing credit ledger"
printf '%s' "$BODY" | jq -er '.error.message | contains("크레딧")' >/dev/null
pass "missing balance rejects before E2B create"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO credit_entry (workspace_id, delta_micro_usd, reason, ref_id)
VALUES ('$WS_ID', 1000000, 'topup', '$TOPUP_REF');
UPDATE work_pool SET max_active=1, per_member_soft_limit=1 WHERE workspace_id='$WS_ID';
INSERT INTO work_cloud_host
  (id, workspace_id, requester_member_id, state, bootstrap_token_digest,
   bootstrap_expires_at, unit_rate_micro_usd_second)
VALUES
  ('$DUMMY_PROVISION', '$WS_ID', '$OWNER_ID', 'provisioning',
   repeat('0',64), clock_timestamp()+interval '10 minutes', 25);
COMMIT;
SQL
api POST "$CLOUD_PATH" '{"displayName":"T3 gate","confirmPaidCloud":true}'
expect_status 409 "slot exhaustion"
printf '%s' "$BODY" | jq -er '.error.message | contains("슬롯")' >/dev/null
pass "slot exhaustion returns readable reason"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
DELETE FROM work_cloud_host WHERE id='$DUMMY_PROVISION';
UPDATE work_pool SET max_active=2, per_member_soft_limit=2 WHERE workspace_id='$WS_ID';
COMMIT;
SQL

api POST "$CLOUD_PATH" '{"displayName":"T3 gate","confirmPaidCloud":true}'
expect_status 202 "mock E2B provision"
PROVISION_ID="$(printf '%s' "$BODY" | jq -er '.cloudHost.provisionId')"
BOOTSTRAP_TOKEN="$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq -er '.requests[0].body.envVars.MOMO_WORKD_REGISTRATION_TOKEN')"
[ "$(sql_value <<SQL
SELECT count(*) FROM work_cloud_host
 WHERE id='$PROVISION_ID'
   AND bootstrap_token_digest <> '$BOOTSTRAP_TOKEN'
   AND length(bootstrap_token_digest)=64;
SQL
)" = "1" ] || fail "raw bootstrap token reached PostgreSQL"

PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="
REGISTER_BODY="$(jq -cn --arg key "$PUBLIC_KEY" \
  '{scope:"workspace",type:"cloud",displayName:"T3 gate",publicKey:$key,
    capabilities:{"tool.codex":true}}')"
STATUS="$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X POST \
  "$BASE_URL/v1/workspaces/$WS_ID/work-hosts/cloud/register" \
  -H 'Content-Type: application/json' \
  -H "Authorization: MomoBootstrap $BOOTSTRAP_TOKEN" \
  --data "$REGISTER_BODY")"
BODY="$(<"$TMP_DIR/response.json")"
expect_status 201 "cloud workd self-registration"
HOST_ID="$(printf '%s' "$BODY" | jq -er '.workHost.id')"
pass "mock E2B create + one-shot Ed25519 cloud registration"

api POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg ch "$CHANNEL_ID" --arg host "$HOST_ID" \
    '{channelId:$ch,hostId:$host,tool:"codex",label:"T3 ledger gate"}')"
expect_status 201 "T3 work session create"
SESSION_ID="$(printf '%s' "$BODY" | jq -er '.workSession.id')"
sleep 2

api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/cloud/pause"
expect_status 200 "T3 pause"
sleep 2
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/cloud/resume"
expect_status 200 "T3 resume"
sleep 2
api PATCH "/v1/workspaces/$WS_ID/work-sessions/$SESSION_ID" \
  '{"status":"ended","exitCode":0}'
expect_status 200 "T3 session end and settle"

INTERVALS="$(sql_value <<SQL
SELECT count(*) || ':' ||
       count(*) FILTER (WHERE i.state='paused' AND i.active_seconds=0) || ':' ||
       COALESCE(sum(i.active_seconds),0)
  FROM work_host_usage_interval i
  JOIN work_host_usage u ON u.id=i.usage_id
 WHERE u.session_id='$SESSION_ID';
SQL
)"
IFS=: read -r INTERVAL_COUNT PAUSED_ZERO ACTIVE_SECONDS <<EOF
$INTERVALS
EOF
[ "$INTERVAL_COUNT" = "3" ] || fail "expected active/paused/active intervals, got $INTERVALS"
[ "$PAUSED_ZERO" = "1" ] || fail "paused interval counted as active: $INTERVALS"
[ "$ACTIVE_SECONDS" -ge 2 ] && [ "$ACTIVE_SECONDS" -le 6 ] \
  || fail "unexpected active seconds $ACTIVE_SECONDS"

LEDGER_ACTIVE="$(sql_value <<SQL
SELECT active_seconds FROM work_host_usage WHERE session_id='$SESSION_ID';
SQL
)"
[ "$LEDGER_ACTIVE" = "$ACTIVE_SECONDS" ] || fail "usage aggregate mismatch"
DEBIT="$(sql_value <<SQL
SELECT -delta_micro_usd FROM credit_entry
 WHERE workspace_id='$WS_ID' AND reason='t3_usage' AND ref_id='$SESSION_ID';
SQL
)"
[ "$DEBIT" = "$((ACTIVE_SECONDS * 25))" ] || fail "credit debit mismatch"

# Tenant isolation under the real NOBYPASSRLS app role.
RLS_VISIBLE="$(run_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$WS_ID';
SELECT count(*) FROM work_host_usage WHERE session_id='$SESSION_ID';
ROLLBACK;
SQL
)"
[ "$RLS_VISIBLE" = "1" ] || fail "owner workspace cannot see its T3 usage"
CROSS_WS="00000000-0000-7000-8000-000000000099"
RLS_HIDDEN="$(run_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_WS';
SELECT count(*) FROM work_host_usage WHERE session_id='$SESSION_ID';
ROLLBACK;
SQL
)"
[ "$RLS_HIDDEN" = "0" ] || fail "cross-workspace T3 usage leaked"

if [ "${T3_GATE_PROVE_RED_PAUSE:-0}" = "1" ]; then
  # Simulates the forbidden regression: every interval, including pause, bills
  # by wall time. The gate must become red because this exceeds the stored
  # active-only total after the deliberate two-second pause.
  REVERTED_TOTAL="$(sql_value <<SQL
SELECT COALESCE(sum(floor(extract(epoch FROM (i.ended_at-i.started_at)))::bigint),0)
  FROM work_host_usage_interval i
  JOIN work_host_usage u ON u.id=i.usage_id
 WHERE u.session_id='$SESSION_ID';
SQL
)"
  [ "$REVERTED_TOTAL" = "$LEDGER_ACTIVE" ] \
    || fail "red proof: reverted pause accounting bills $REVERTED_TOTAL vs active-only $LEDGER_ACTIVE"
fi

api DELETE "/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/cloud"
expect_status 200 "T3 destroy"
curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq -e '.states.momo647sandbox == "destroyed"' >/dev/null

pass "ledger consistency, pause exclusion, credit debit, RLS isolation, lifecycle"
