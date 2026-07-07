#!/usr/bin/env bash
# scripts/verify_hermes_gateway_adapter.sh — MOMO-325 Hermes gateway platform path
#
# Verifies the product direction where Hermes treats momo as a messaging
# platform, while momo keeps the execution ledger SoT:
#   REST @hermes mention -> agent_run + outbox(agent_job, method=gateway)
#   -> agent: realtime job broadcast row -> gateway status/complete REST callback
#   -> durable timeline message + usage_ledger + audit_log.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=scripts/runtime_process_guard.sh
. "$REPO_ROOT/scripts/runtime_process_guard.sh"

ENV_FILE=${ENV_FILE:-}
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE=$candidate
      break
    fi
  done
fi

if [ "$ENV_FILE" != "" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[hermes-gateway] missing required command: $1" >&2
    exit 1
  fi
}

require_bin curl
require_bin jq
require_bin python3
require_bin swift

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN=$(command -v psql)
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[hermes-gateway] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_DB=${POSTGRES_DB:-momo}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo}
PORT=${PORT:-8080}
BASE_URL=${BASE_URL:-http://127.0.0.1:${PORT}}
AGENT_GATEWAY_SECRET=${AGENT_GATEWAY_SECRET:-momo-325-local-gateway-secret-00000000000000000000000000000000}

WORKSPACE_ID=00000000-0000-7000-8000-000000000001
HUMAN_EMAIL=demo@momo.local
HUMAN_PASSWORD=dev-password
AGENT_ID=00000000-0000-7000-8000-000000000103
CHANNEL_ID=00000000-0000-7000-8000-000000000202
CLIENT_MSG_ID=00000000-0000-7000-8000-000000325001
BODY='@hermes MOMO-325 gateway native platform smoke'
FINAL_BODY='Hermes gateway mock completed MOMO-325 through momo REST.'

TMP_ROOT=${TMPDIR:-/tmp}
SERVER_LOG=${TMP_ROOT}/momo-hermes-gateway-server-$$.log
SERVER_PID=

cleanup() {
  momo_cleanup_tracked_pids "hermes-gateway verifier" "$SERVER_PID"
}
trap cleanup EXIT INT TERM

psql_url() {
  printf 'postgres://%s:%s@%s:%s/%s' \
    "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$POSTGRES_HOST" "$POSTGRES_PORT" "$POSTGRES_DB"
}

psql_run() {
  "$PSQL_BIN" "$(psql_url)" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

psql_scalar() {
  psql_run -t -A -c "$1" | tr -d '[:space:]'
}

json_escape() {
  python3 - "$1" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1]))
PY
}

wait_http() {
  url=$1
  name=$2
  deadline=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[hermes-gateway] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "[hermes-gateway] ${name} did not become ready: ${url}" >&2
  return 1
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[hermes-gateway] $BASE_URL is already serving /health; stop it before this isolated verifier." >&2
    exit 1
  fi
  echo "[hermes-gateway] starting MomoServer in AGENT_GATEWAY_MODE=gateway"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="postgres://momo_app:momo_app_dev_pw@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    PORT="$PORT" \
    AGENT_GATEWAY_MODE=gateway \
    AGENT_GATEWAY_SECRET="$AGENT_GATEWAY_SECRET" \
    RATE_LIMIT_PER_MEMBER=0 \
    RATE_LIMIT_PER_IP=0 \
    swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  wait_http "$BASE_URL/health" "MomoServer"
}

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":$(json_escape "$HUMAN_EMAIL"),\"password\":$(json_escape "$HUMAN_PASSWORD"),\"workspace\":$(json_escape "$WORKSPACE_ID")}"
}

send_mention() {
  token=$1
  curl -fsS -X POST "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    -d "{\"clientMsgId\":\"${CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":$(json_escape "$BODY"),\"props\":{\"gate\":\"MOMO-325\",\"path\":\"hermes-gateway\"}}"
}

post_gateway_event() {
  run_id=$1
  curl -fsS -X POST "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" \
    -H "X-Momo-Agent-Gateway-Secret: ${AGENT_GATEWAY_SECRET}" \
    -H 'Content-Type: application/json' \
    -d '{"status":"running","detail":"mock gateway accepted agent.job"}' >/dev/null
}

post_gateway_complete() {
  run_id=$1
  curl -fsS -X POST "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/complete" \
    -H "X-Momo-Agent-Gateway-Secret: ${AGENT_GATEWAY_SECRET}" \
    -H 'Content-Type: application/json' \
    -d "{\"status\":\"succeeded\",\"body\":$(json_escape "$FINAL_BODY"),\"usage\":{\"model\":\"hermes-agent\",\"prompt_tokens\":11,\"completion_tokens\":7,\"cached_tokens\":0,\"reasoning_tokens\":0,\"cost_micro_usd\":0,\"was_estimated\":true}}"
}

cleanup_fixture_rows() {
  psql_run >/dev/null <<SQL
SELECT set_config('app.workspace_id', '${WORKSPACE_ID}', false);
CREATE TEMP TABLE momo325_runs AS
SELECT id
  FROM agent_run
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     input::text LIKE '%MOMO-325%'
     OR trigger_message_id IN (
       SELECT id
         FROM message
        WHERE workspace_id = '${WORKSPACE_ID}'
          AND (client_msg_id = '${CLIENT_MSG_ID}' OR body = '${BODY}')
     )
   );
DELETE FROM outbox
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     payload->>'idempotency_key' LIKE '%MOMO-325%'
     OR payload::text LIKE '%${CLIENT_MSG_ID}%'
     OR payload::text LIKE '%${BODY}%'
     OR payload::text LIKE '%${FINAL_BODY}%'
     OR payload->'data'->'payload'->>'run_id' IN (
       SELECT id::text FROM momo325_runs
     )
   );
DELETE FROM usage_ledger
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND run_id IN (
     SELECT id FROM momo325_runs
   );
DELETE FROM audit_log
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     detail::text LIKE '%${CLIENT_MSG_ID}%'
     OR detail::text LIKE '%MOMO-325%'
     OR action LIKE 'agent.gateway.%'
     OR run_id IN (
       SELECT id FROM momo325_runs
     )
   );
DELETE FROM agent_run
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND id IN (SELECT id FROM momo325_runs);
DELETE FROM message
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     client_msg_id = '${CLIENT_MSG_ID}'
     OR body = '${BODY}'
     OR body = '${FINAL_BODY}'
     OR props->>'source' = 'hermes_gateway'
   );
DROP TABLE momo325_runs;
SQL
}

assert_equals() {
  expected=$1
  actual=$2
  label=$3
  if [ "$expected" != "$actual" ]; then
    echo "[hermes-gateway] assertion failed: ${label}: expected=${expected} actual=${actual}" >&2
    tail -120 "$SERVER_LOG" >&2 || true
    exit 1
  fi
}

echo "[hermes-gateway] ensuring docker compose + migrations"
( cd "$REPO_ROOT" && make up >/dev/null && MIGRATE_IDEMPOTENCY_CHECK=1 make migrate >/dev/null )

cleanup_fixture_rows
momo_cleanup_port_listener "$PORT" "hermes-gateway verifier API" || {
  echo "[hermes-gateway] API port ${PORT} is occupied by a non-momo process" >&2
  exit 1
}

start_server
LOGIN_JSON=$(login)
ACCESS_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken')
if [ "$ACCESS_TOKEN" = "" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  echo "[hermes-gateway] login failed" >&2
  printf '%s\n' "$LOGIN_JSON" >&2
  exit 1
fi

SEND_JSON=$(send_mention "$ACCESS_TOKEN")
RUN_ID=$(psql_scalar "SELECT id FROM agent_run WHERE workspace_id='${WORKSPACE_ID}' AND trigger_message_id=(SELECT id FROM message WHERE client_msg_id='${CLIENT_MSG_ID}' LIMIT 1) LIMIT 1")
if [ "$RUN_ID" = "" ]; then
  echo "[hermes-gateway] @hermes mention did not create agent_run" >&2
  printf '%s\n' "$SEND_JSON" >&2
  tail -120 "$SERVER_LOG" >&2 || true
  exit 1
fi

JOB_METHOD=$(psql_scalar "SELECT method FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "gateway" "$JOB_METHOD" "agent_job method"

JOB_STATUS=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "pending" "$JOB_STATUS" "agent_job initial status"

AGENT_JOB_BROADCAST=$(psql_scalar "SELECT payload->'data'->>'type' FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='agent.job' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "agent.job" "$AGENT_JOB_BROADCAST" "agent: realtime job broadcast"

UNAUTHORIZED_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/agent-runs/${RUN_ID}/gateway/events" -H 'Content-Type: application/json' -d '{"status":"running"}')
assert_equals "401" "$UNAUTHORIZED_CODE" "gateway callback without secret"

post_gateway_event "$RUN_ID"
COMPLETE_JSON=$(post_gateway_complete "$RUN_ID")
FINAL_SEQ=$(printf '%s' "$COMPLETE_JSON" | jq -r '.seq')
if [ "$FINAL_SEQ" = "" ] || [ "$FINAL_SEQ" = "null" ]; then
  echo "[hermes-gateway] completion response missing seq" >&2
  printf '%s\n' "$COMPLETE_JSON" >&2
  exit 1
fi
RETRY_COMPLETE_JSON=$(post_gateway_complete "$RUN_ID")
RETRY_FINAL_SEQ=$(printf '%s' "$RETRY_COMPLETE_JSON" | jq -r '.seq')
assert_equals "$FINAL_SEQ" "$RETRY_FINAL_SEQ" "gateway complete idempotent retry seq"

RUN_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${RUN_ID}'")
assert_equals "succeeded" "$RUN_STATUS" "agent_run status"

FINAL_MESSAGE_COUNT=$(psql_scalar "SELECT count(*) FROM message WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND author_member_id='${AGENT_ID}' AND body='${FINAL_BODY}'")
assert_equals "1" "$FINAL_MESSAGE_COUNT" "durable final timeline message"

USAGE_COUNT=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND agent_member_id='${AGENT_ID}'")
assert_equals "1" "$USAGE_COUNT" "usage ledger row"

AUDIT_COUNT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND action IN ('agent.gateway.status','agent.gateway.completed')")
assert_equals "2" "$AUDIT_COUNT" "gateway audit rows"

FINAL_BROADCAST_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}')")
assert_equals "1" "$FINAL_BROADCAST_COUNT" "durable final message broadcast idempotency"

JOB_DONE=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "done" "$JOB_DONE" "agent_job settled"

echo "[hermes-gateway] PASS: run=${RUN_ID} final_seq=${FINAL_SEQ}"
echo "[hermes-gateway] real Hermes gateway CLI/plugin load remains runtime-unverified(real hermes gateway missing) unless a user-provided Hermes runtime is present."
