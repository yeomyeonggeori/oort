#!/usr/bin/env bash
# =============================================================================
# scripts/verify_agent_worker.sh — MOMO-004 AgentWorker runtime gate
#
# Prereq:
#   make up
#   make migrate
#
# Verifies:
#   1) REST channel send with @hermes creates exactly one agent_job outbox row
#   2) duplicate client_msg_id REST retry does not create a duplicate job
#   3) AgentWorker claims it with SKIP LOCKED and calls an OpenAI-compatible
#      SSE gateway (scripts/mock_hermes.py by default)
#   4) Centrifugo agent: history receives agent.partial/tool_call progress
#   5) OutboxRelay publishes the final durable channel message.new response
#   6) cost reserve/reconcile writes budget_window + usage_ledger
#   7) MomoServer cost-snapshots endpoint exposes the server-owned projection
#   8) a low-limit budget trips before spending
# =============================================================================
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
    echo "[agent-worker] missing required command: $1" >&2
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
  echo "[agent-worker] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

psql_run() {
  if [ "${DATABASE_URL:-}" != "" ]; then
    "$PSQL_BIN" "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  else
    "$PSQL_BIN" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  fi
}

psql_scalar() {
  psql_run -t -A -c "$1" | tr -d '[:space:]'
}

POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_DB=${POSTGRES_DB:-momo}
PORT=${PORT:-8080}
BASE_URL=${BASE_URL:-http://127.0.0.1:${PORT}}
CENT_PORT=${CENT_PORT:-8000}
CENT_API_KEY=${CENT_API_KEY:-dev-insecure-cent-api-key}
HERMES_PORT=${HERMES_PORT:-8088}
HERMES_API_KEY=${HERMES_API_KEY:-dev-insecure-hermes-bearer}
WORKER_POLL_INTERVAL_MS=${WORKER_POLL_INTERVAL_MS:-100}

CENT_API_URL=${CENT_API_URL:-http://localhost:${CENT_PORT}/api}
case "$CENT_API_URL" in
  *centrifugo*) CENT_API_URL="http://localhost:${CENT_PORT}/api" ;;
esac

HERMES_BASE_URL=${HERMES_BASE_URL:-http://localhost:${HERMES_PORT}/v1}

WORKSPACE_ID=00000000-0000-7000-8000-000000000001
HUMAN_ID=00000000-0000-7000-8000-000000000101
AGENT_ID=00000000-0000-7000-8000-000000000103
CHANNEL_ID=00000000-0000-7000-8000-000000000202
RUN_ID=00000000-0000-7000-8000-000000000904
RESUME_RUN_ID=00000000-0000-7000-8000-000000000924
RESUME_APPROVAL_ID=00000000-0000-7000-8000-000000000925
TRIP_RUN_ID=00000000-0000-7000-8000-000000000914
BUDGET_ID=00000000-0000-7000-8000-000000000905
TRIP_BUDGET_ID=00000000-0000-7000-8000-000000000915
MESSAGE_ID=00000000-0000-7000-8000-000000000906
TRIP_MESSAGE_ID=00000000-0000-7000-8000-000000000916
CLIENT_MSG_ID=00000000-0000-7000-8000-000000000907
TRIP_CLIENT_MSG_ID=00000000-0000-7000-8000-000000000917
GUARD_DEPTH_RUN_ID=00000000-0000-7000-8000-000000000934
GUARD_DEPTH_MESSAGE_ID=00000000-0000-7000-8000-000000000935
GUARD_DEPTH_CLIENT_MSG_ID=00000000-0000-7000-8000-000000000936
GUARD_STEP_RUN_ID=00000000-0000-7000-8000-000000000937
GUARD_STEP_MESSAGE_ID=00000000-0000-7000-8000-000000000938
GUARD_STEP_CLIENT_MSG_ID=00000000-0000-7000-8000-000000000939
GUARD_G1_RUN_ID=00000000-0000-7000-8000-000000000940
GUARD_G1_DECOY_RUN_ID=00000000-0000-7000-8000-000000000941
GUARD_G1_MESSAGE_ID=00000000-0000-7000-8000-000000000942
GUARD_G1_CLIENT_MSG_ID=00000000-0000-7000-8000-000000000943
GUARD_G2_RUN_ID=00000000-0000-7000-8000-000000000944
GUARD_G2_MESSAGE_ID=00000000-0000-7000-8000-000000000945
GUARD_G2_CLIENT_MSG_ID=00000000-0000-7000-8000-000000000946
GUARD_G2_AGENT_MSG1_ID=00000000-0000-7000-8000-000000000947
GUARD_G2_AGENT_MSG2_ID=00000000-0000-7000-8000-000000000948
GUARD_G2_RESET_MESSAGE_ID=00000000-0000-7000-8000-000000000949
GUARD_G2_RESET_CLIENT_MSG_ID=00000000-0000-7000-8000-00000000094a
# MOMO-301 review round: gate thresholds are lowered via env so the trip
# scenarios stay compatible with the 007 SoT CHECKs (depth <= 4): the
# a2a_depth trip seeds depth=2 with MAX_DEPTH=1 (gate blocks depth > MAX_DEPTH),
# and the G2 trip seeds 2 consecutive agent text messages with
# MAX_CONSECUTIVE_AUTO=2. All other fixtures sit at depth=0 / streak=0.
GUARD_MAX_DEPTH=${GUARD_MAX_DEPTH:-1}
GUARD_MAX_CONSECUTIVE_AUTO=${GUARD_MAX_CONSECUTIVE_AUTO:-2}
AGENT_CHANNEL=agent:ws${WORKSPACE_ID}.${AGENT_ID}
CENT_CHANNEL=ch:ws${WORKSPACE_ID}.${CHANNEL_ID}
NON_MEMBER_AGENT_ID=00000000-0000-7000-8000-000000215102
NON_MEMBER_CLIENT_MSG_ID=00000000-0000-7000-8000-000000215107

TMP_ROOT=${TMPDIR:-/tmp}
MOCK_LOG=${TMP_ROOT}/momo-mock-hermes-$$.log
WORKER_LOG=${TMP_ROOT}/momo-agent-worker-$$.log
SERVER_LOG=${TMP_ROOT}/momo-cost-projection-server-$$.log
RELAY_LOG=${TMP_ROOT}/momo-agent-worker-relay-$$.log
COST_PROJECTION_JSON=${TMP_ROOT}/momo-cost-projection-$$.json
MOCK_PID=
WORKER_PID=
SERVER_PID=
RELAY_PID=

cleanup() {
  momo_cleanup_tracked_pids "agent-worker verifier" "$SERVER_PID" "$WORKER_PID" "$RELAY_PID" "$MOCK_PID"
}
trap cleanup EXIT INT TERM

wait_http() {
  url=$1
  name=$2
  deadline=$(($(date +%s) + 30))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[agent-worker] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "[agent-worker] ${name} did not become ready: ${url}" >&2
  return 1
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[agent-worker] MomoServer already started by verifier"
      return 0
    fi
    echo "[agent-worker] $BASE_URL is already serving /health; stop the existing server before running this verifier." >&2
    exit 1
  fi

  echo "[agent-worker] starting MomoServer for cost projection endpoint"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="postgres://momo_app:momo_app_dev_pw@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
    PORT="$PORT" \
    swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  deadline=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[agent-worker] MomoServer exited before health became green" >&2
      tail -120 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[agent-worker] MomoServer health is green"
      return 0
    fi
    sleep 1
  done
  echo "[agent-worker] timed out waiting for MomoServer health" >&2
  tail -120 "$SERVER_LOG" >&2 || true
  exit 1
}

start_relay() {
  if [ "${RELAY_PID:-}" != "" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
    return 0
  fi

  echo "[agent-worker] starting OutboxRelay for final channel message.new evidence"
  (
    cd "$REPO_ROOT"
    swift build --package-path relay/OutboxRelay --product OutboxRelay >/dev/null
    RELAY_BIN="$(swift build --package-path relay/OutboxRelay --show-bin-path)/OutboxRelay"
    exec env \
      RELAY_DATABASE_URL="postgres://momo_relay:momo_relay_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}" \
      CENT_API_URL="$CENT_API_URL" \
      CENT_API_KEY="$CENT_API_KEY" \
      RELAY_POLL_INTERVAL_MS=100 \
      "$RELAY_BIN"
  ) >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
}

verify_cost_projection_endpoint() {
  start_server
  LOGIN_JSON=$(curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"demo@momo.local\",\"password\":\"dev-password\",\"workspace\":\"$WORKSPACE_ID\"}" \
    "$BASE_URL/v1/auth/login")
  ACCESS_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken')
  if [ "$ACCESS_TOKEN" = "" ] || [ "$ACCESS_TOKEN" = "null" ]; then
    echo "[agent-worker] failed to obtain access token for cost projection endpoint" >&2
    printf '%s\n' "$LOGIN_JSON" >&2
    exit 1
  fi

  curl -fsS \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/cost-snapshots?limit=10" \
    > "$COST_PROJECTION_JSON"

  if ! jq -e --arg run "$RUN_ID" '
      .schema == "momo.cost_snapshot.channel.v0"
      and .channel_id == "'"$CHANNEL_ID"'"
      and any(.snapshots[]?;
        .run_id == $run
        and .reserved_micro_usd == 0
        and .spent_micro_usd == 6
        and .is_reconciled == true
        and .was_estimated == false
        and .limit_state == "normal"
      )
    ' "$COST_PROJECTION_JSON" >/dev/null; then
    echo "[agent-worker] cost projection endpoint contract did not verify" >&2
    cat "$COST_PROJECTION_JSON" >&2
    echo "[agent-worker] server log: $SERVER_LOG" >&2
    exit 1
  fi

  echo "[agent-worker] cost projection endpoint verified: $COST_PROJECTION_JSON"
}

echo "[agent-worker] using env file: ${ENV_FILE:-<none>}"
momo_cleanup_runtime_ports "agent-worker verifier preflight" "$PORT" "$HERMES_PORT" || {
  echo "[agent-worker] verifier ports are occupied by non-momo processes; stop them or choose PORT/HERMES_PORT overrides." >&2
  exit 1
}
echo "[agent-worker] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null

start_server
start_relay

echo "[agent-worker] starting mock hermes on ${HERMES_BASE_URL}"
python3 "$REPO_ROOT/scripts/mock_hermes.py" --host 127.0.0.1 --port "$HERMES_PORT" \
  >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
wait_http "http://127.0.0.1:${HERMES_PORT}/health" "mock hermes"

echo "[agent-worker] preparing REST mention-routing fixture"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

DELETE FROM usage_ledger
 WHERE run_id IN ('$RUN_ID', '$TRIP_RUN_ID')
    OR run_id IN (
      SELECT id FROM agent_run
       WHERE workspace_id = '$WORKSPACE_ID'
         AND idempotency_key LIKE 'mention:%:$AGENT_ID'
    );
DELETE FROM audit_log WHERE target_id = '$RESUME_APPROVAL_ID' OR run_id = '$RESUME_RUN_ID';
-- MOMO-301 loop-guard trip fixtures (audit/outbox/message/agent_run rerun hygiene)
DELETE FROM audit_log
 WHERE run_id IN ('$GUARD_DEPTH_RUN_ID', '$GUARD_STEP_RUN_ID',
                  '$GUARD_G1_RUN_ID', '$GUARD_G1_DECOY_RUN_ID', '$GUARD_G2_RUN_ID');
DELETE FROM outbox
 WHERE payload->>'run_id' IN ('$GUARD_DEPTH_RUN_ID', '$GUARD_STEP_RUN_ID',
                              '$GUARD_G1_RUN_ID', '$GUARD_G2_RUN_ID')
    OR payload->'data'->'payload'->>'run_id' IN
       ('$GUARD_DEPTH_RUN_ID', '$GUARD_STEP_RUN_ID', '$GUARD_G1_RUN_ID', '$GUARD_G2_RUN_ID');
DELETE FROM agent_run
 WHERE id IN ('$GUARD_DEPTH_RUN_ID', '$GUARD_STEP_RUN_ID',
              '$GUARD_G1_RUN_ID', '$GUARD_G1_DECOY_RUN_ID', '$GUARD_G2_RUN_ID');
DELETE FROM message
 WHERE run_id IN ('$GUARD_DEPTH_RUN_ID', '$GUARD_STEP_RUN_ID',
                  '$GUARD_G1_RUN_ID', '$GUARD_G2_RUN_ID')
    OR id IN ('$GUARD_DEPTH_MESSAGE_ID', '$GUARD_STEP_MESSAGE_ID', '$GUARD_G1_MESSAGE_ID',
              '$GUARD_G2_MESSAGE_ID', '$GUARD_G2_AGENT_MSG1_ID', '$GUARD_G2_AGENT_MSG2_ID',
              '$GUARD_G2_RESET_MESSAGE_ID')
    OR client_msg_id IN ('$GUARD_DEPTH_CLIENT_MSG_ID', '$GUARD_STEP_CLIENT_MSG_ID',
                         '$GUARD_G1_CLIENT_MSG_ID', '$GUARD_G2_CLIENT_MSG_ID',
                         '$GUARD_G2_RESET_CLIENT_MSG_ID');
DELETE FROM audit_log
 WHERE workspace_id = '$WORKSPACE_ID'
   AND run_id IN (
      SELECT id FROM agent_run
       WHERE workspace_id = '$WORKSPACE_ID'
         AND idempotency_key LIKE 'mention:%:$AGENT_ID'
   );
DELETE FROM audit_log
 WHERE workspace_id = '$WORKSPACE_ID'
   AND target_id IN (
     SELECT id FROM message
      WHERE workspace_id = '$WORKSPACE_ID'
        AND client_msg_id IN ('$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID')
   );
DELETE FROM audit_log
 WHERE workspace_id = '$WORKSPACE_ID'
   AND run_id IN (
      SELECT ar.id
        FROM agent_run ar
        JOIN message trigger_message ON trigger_message.id = ar.trigger_message_id
       WHERE ar.workspace_id = '$WORKSPACE_ID'
         AND trigger_message.workspace_id = '$WORKSPACE_ID'
         AND trigger_message.client_msg_id IN ('$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID')
   );
-- Keep cleanup verifier-owned. Do not clear the whole demo workspace agent_job
-- queue because local dogfood may have real pending Hermes work in the same DB.
DELETE FROM outbox
 WHERE workspace_id = '$WORKSPACE_ID'
   AND (payload->>'run_id' IN ('$RUN_ID', '$RESUME_RUN_ID', '$TRIP_RUN_ID')
   OR payload->>'resume_from_approval_id' = '$RESUME_APPROVAL_ID'
   OR payload->>'trigger_message_id' IN (
     SELECT id::text FROM message
      WHERE workspace_id = '$WORKSPACE_ID'
        AND client_msg_id IN ('$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID')
   )
   OR payload->'data'->'payload'->>'run_id' IN ('$RUN_ID', '$RESUME_RUN_ID', '$TRIP_RUN_ID'));
DELETE FROM approval
 WHERE workspace_id = '$WORKSPACE_ID'
   AND id = '$RESUME_APPROVAL_ID';
DELETE FROM budget_window
 WHERE workspace_id = '$WORKSPACE_ID'
   AND budget_id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');
DELETE FROM budget
 WHERE workspace_id = '$WORKSPACE_ID'
   AND id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');
DELETE FROM message
 WHERE workspace_id = '$WORKSPACE_ID'
   AND run_id = '$RESUME_RUN_ID';
DELETE FROM message
 WHERE workspace_id = '$WORKSPACE_ID'
   AND run_id IN (
      SELECT ar.id
        FROM agent_run ar
        JOIN message trigger_message ON trigger_message.id = ar.trigger_message_id
       WHERE ar.workspace_id = '$WORKSPACE_ID'
         AND trigger_message.workspace_id = '$WORKSPACE_ID'
         AND trigger_message.client_msg_id IN ('$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID')
    )
   AND id NOT IN (
      SELECT trigger_message_id
        FROM agent_run
       WHERE workspace_id = '$WORKSPACE_ID'
         AND trigger_message_id IS NOT NULL
   );
DELETE FROM message
 WHERE workspace_id = '$WORKSPACE_ID'
   AND run_id IN (
      SELECT id FROM agent_run
       WHERE workspace_id = '$WORKSPACE_ID'
         AND idempotency_key LIKE 'mention:%:$AGENT_ID'
    )
   AND id NOT IN (
      SELECT trigger_message_id FROM agent_run
       WHERE workspace_id = '$WORKSPACE_ID'
         AND idempotency_key LIKE 'mention:%:$AGENT_ID'
         AND trigger_message_id IS NOT NULL
   );
DELETE FROM agent_run
 WHERE workspace_id = '$WORKSPACE_ID'
   AND trigger_message_id IN (
      SELECT id
        FROM message
       WHERE workspace_id = '$WORKSPACE_ID'
         AND client_msg_id IN ('$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID')
   );
DELETE FROM agent_run
 WHERE id IN ('$RUN_ID', '$RESUME_RUN_ID', '$TRIP_RUN_ID')
    OR (
      workspace_id = '$WORKSPACE_ID'
      AND idempotency_key LIKE 'mention:%:$AGENT_ID'
    );
DELETE FROM message
 WHERE id IN ('$MESSAGE_ID', '$TRIP_MESSAGE_ID')
    OR client_msg_id IN ('$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID')
    OR body IN ('@hermes MOMO-256 Local Hermes bridge 검증해줘',
                '@no-channel-agent should not be invoked');

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$NON_MEMBER_AGENT_ID', '$WORKSPACE_ID', 'agent', 'active',
        'No Channel Agent', 'no-channel-agent')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('$NON_MEMBER_AGENT_ID', '$WORKSPACE_ID', 'hermes-agent',
        'http://localhost:8088/v1',
        'This agent is intentionally not a channel member for MOMO-215.',
        '$HUMAN_ID', 1, 12)
ON CONFLICT (member_id) DO UPDATE
  SET model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      system_prompt = EXCLUDED.system_prompt;

DELETE FROM membership
 WHERE workspace_id = '$WORKSPACE_ID'
   AND channel_id = '$CHANNEL_ID'
   AND member_id = '$NON_MEMBER_AGENT_ID';

INSERT INTO budget
  (id, workspace_id, grain, limit_micro_usd, period_seconds)
VALUES
  ('$BUDGET_ID', '$WORKSPACE_ID', 'workspace', 1000000, 3600);

COMMIT;
SQL

LOGIN_JSON=$(curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"demo@momo.local\",\"password\":\"dev-password\",\"workspace\":\"$WORKSPACE_ID\"}" \
  "$BASE_URL/v1/auth/login")
ACCESS_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken')
if [ "$ACCESS_TOKEN" = "" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  echo "[agent-worker] failed to obtain access token for mention send" >&2
  printf '%s\n' "$LOGIN_JSON" >&2
  exit 1
fi

MENTION_BODY='@hermes MOMO-256 Local Hermes bridge 검증해줘'
SEND_PAYLOAD=$(jq -cn --arg client "$CLIENT_MSG_ID" --arg body "$MENTION_BODY" \
  '{clientMsgId:$client,type:"text",body:$body}')
SEND_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$SEND_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")
DUP_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$SEND_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")

MESSAGE_ID=$(printf '%s' "$SEND_JSON" | jq -r '.id')
MESSAGE_SEQ=$(printf '%s' "$SEND_JSON" | jq -r '.seq')
DUP_MESSAGE_ID=$(printf '%s' "$DUP_JSON" | jq -r '.id')
DUP_MESSAGE_SEQ=$(printf '%s' "$DUP_JSON" | jq -r '.seq')
if [ "$MESSAGE_ID" = "" ] || [ "$MESSAGE_ID" = "null" ] || [ "$MESSAGE_ID" != "$DUP_MESSAGE_ID" ] || [ "$MESSAGE_SEQ" != "$DUP_MESSAGE_SEQ" ]; then
  echo "[agent-worker] REST message idempotency did not return the same message" >&2
  printf 'send=%s\ndup=%s\n' "$SEND_JSON" "$DUP_JSON" >&2
  exit 1
fi

RUN_ID=$(psql_scalar "SELECT upper(id::text) FROM agent_run WHERE workspace_id='$WORKSPACE_ID' AND trigger_message_id='$MESSAGE_ID' AND agent_member_id='$AGENT_ID' AND idempotency_key='mention:${MESSAGE_ID}:${AGENT_ID}';")
JOB_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND payload->>'trigger_message_id'='$MESSAGE_ID' AND payload->>'agent_member_id'='$AGENT_ID';")
CONTEXT_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND lower(payload->>'run_id')=lower('$RUN_ID') AND payload->'context_packet_projection'->>'schema'='momo.context_packet.mention_projection.v0' AND lower(payload->'source_attribution'->>'message_id')=lower('$MESSAGE_ID') AND lower(payload->>'author_member_id')=lower('$HUMAN_ID');")
AUDIT_QUEUED=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='$WORKSPACE_ID' AND action='agent.mention.queued' AND target_id='$MESSAGE_ID' AND run_id='$RUN_ID';")
if [ "$RUN_ID" = "" ] || [ "$JOB_COUNT" != "1" ] || [ "$CONTEXT_OK" != "1" ] || [ "$AUDIT_QUEUED" != "1" ]; then
  echo "[agent-worker] REST mention routing did not create exactly one contextual agent_job" >&2
  printf 'message=%s run=%s jobs=%s context=%s audit=%s\n' "$MESSAGE_ID" "$RUN_ID" "$JOB_COUNT" "$CONTEXT_OK" "$AUDIT_QUEUED" >&2
  exit 1
fi

NON_MEMBER_BODY='@no-channel-agent should not be invoked'
NON_MEMBER_PAYLOAD=$(jq -cn --arg client "$NON_MEMBER_CLIENT_MSG_ID" --arg body "$NON_MEMBER_BODY" \
  '{clientMsgId:$client,type:"text",body:$body}')
NON_MEMBER_SEND_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$NON_MEMBER_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")
NON_MEMBER_MESSAGE_ID=$(printf '%s' "$NON_MEMBER_SEND_JSON" | jq -r '.id')
NON_MEMBER_JOB_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND payload->>'trigger_message_id'='$NON_MEMBER_MESSAGE_ID' AND payload->>'agent_member_id'='$NON_MEMBER_AGENT_ID';")
NON_MEMBER_AUDIT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='$WORKSPACE_ID' AND action='agent.mention.skipped' AND target_id='$NON_MEMBER_MESSAGE_ID' AND subject_member_id='$NON_MEMBER_AGENT_ID' AND detail->>'reason'='agent_not_channel_member';")
if [ "$NON_MEMBER_JOB_COUNT" != "0" ] || [ "$NON_MEMBER_AUDIT" != "1" ]; then
  echo "[agent-worker] non-channel agent mention did not fail closed as no-op + audit" >&2
  printf 'message=%s jobs=%s audit=%s\n' "$NON_MEMBER_MESSAGE_ID" "$NON_MEMBER_JOB_COUNT" "$NON_MEMBER_AUDIT" >&2
  exit 1
fi

echo "[agent-worker] REST @hermes mention routing verified: message=$MESSAGE_ID seq=$MESSAGE_SEQ run=$RUN_ID duplicate_jobs=$JOB_COUNT non_member_noop=ok"

echo "[agent-worker] starting AgentWorker"
(
  cd "$REPO_ROOT"
  swift build --package-path workers/AgentWorker --product AgentWorker >/dev/null
  WORKER_BIN="$(swift build --package-path workers/AgentWorker --show-bin-path)/AgentWorker"
  exec env \
    RELAY_DATABASE_URL="postgres://momo_worker:momo_worker_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}" \
    CENT_API_URL="$CENT_API_URL" \
    CENT_API_KEY="$CENT_API_KEY" \
    HERMES_BASE_URL="$HERMES_BASE_URL" \
    HERMES_API_KEY="$HERMES_API_KEY" \
    WORKER_POLL_INTERVAL_MS="$WORKER_POLL_INTERVAL_MS" \
    MAX_DEPTH="$GUARD_MAX_DEPTH" \
    MAX_CONSECUTIVE_AUTO="$GUARD_MAX_CONSECUTIVE_AUTO" \
    "$WORKER_BIN"
) >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[agent-worker] polling success path"
SUCCESS_OK=0
deadline=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[agent-worker] AgentWorker exited early" >&2
    tail -80 "$WORKER_LOG" >&2 || true
    exit 1
  fi

  RUN_OK=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$RUN_ID' AND status='succeeded';")
  OUTBOX_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'run_id'='$RUN_ID' AND status='done';")
  USAGE_OK=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE run_id='$RUN_ID' AND prompt_tokens=11 AND completion_tokens=7 AND cost_micro_usd=6 AND was_estimated=false;")
  PROJECTION_OK=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$RUN_ID' AND input #>> '{cost_projection,source}' = 'agent_worker' AND (input #>> '{cost_projection,reserved_micro_usd}')::bigint = 0;")
  FINAL_MESSAGE_OK=$(psql_scalar "SELECT count(*) FROM message WHERE workspace_id='$WORKSPACE_ID' AND channel_id='$CHANNEL_ID' AND run_id='$RUN_ID' AND author_member_id='$AGENT_ID' AND type='text' AND body LIKE '%MOMO-004 SSE path verified%';")
  FINAL_BROADCAST_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='broadcast' AND payload->'data'->>'type'='message.new' AND payload->'data'->'payload'->>'run_id'='$RUN_ID' AND payload->'data'->'payload'->>'type'='text' AND (payload->>'version')::bigint = (payload->'data'->>'seq')::bigint AND status IN ('pending', 'processing', 'done') AND last_error IS NULL;")
  # In the full local gate, approval-decision verification can leave a valid
  # same-run resume agent_job that the worker processes before this fixture.
  # The immutable usage_ledger assertion above proves this run's exact cost;
  # the shared workspace budget window only needs to show that reservations
  # were released and at least this run's spend was reconciled.
  WINDOW_OK=$(psql_scalar "SELECT count(*) FROM budget_window WHERE budget_id='$BUDGET_ID' AND reserved_micro_usd=0 AND spent_micro_usd>=6;")

  HISTORY_JSON=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$AGENT_CHANNEL\",\"limit\":100,\"reverse\":true}" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')
  PARTIAL_OK=$(printf '%s' "$HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "agent.partial")
      | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
      | select((.payload.text // "") | contains("MOMO-004 SSE path verified"))
    ] | length
  ')
  TOOL_PARTIAL_OK=$(printf '%s' "$HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "agent.partial")
      | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
      | select(.payload.tool_call_name == "github.search_issues")
      | select((.payload.tool_call_args | type) == "object")
      | select(.payload.tool_call_args.query == "MOMO-201 live tool-call fixture")
      | select(.payload.tool_call_args.limit == 2)
      | select(.payload.tool_call_args_truncated == false)
    ] | length
  ')
  CHANNEL_HISTORY_JSON=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$CENT_CHANNEL\",\"limit\":100,\"reverse\":true}" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')
  FINAL_LIVE_OK=$(printf '%s' "$CHANNEL_HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "message.new")
      | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
      | select(.payload.type == "text")
      | select((.payload.body // "") | contains("MOMO-004 SSE path verified"))
      | select(.seq == .payload.seq)
    ] | length
  ')

  if [ "$RUN_OK" = "1" ] && [ "$OUTBOX_OK" = "1" ] \
    && [ "$USAGE_OK" = "1" ] && [ "$WINDOW_OK" = "1" ] \
    && [ "$PROJECTION_OK" = "1" ] \
    && [ "$FINAL_MESSAGE_OK" = "1" ] && [ "$FINAL_BROADCAST_OK" != "0" ] \
    && [ "$PARTIAL_OK" != "0" ] && [ "$TOOL_PARTIAL_OK" != "0" ] \
    && [ "$FINAL_LIVE_OK" != "0" ]; then
    SUCCESS_OK=1
    break
  fi
  sleep 1
done

if [ "$SUCCESS_OK" != "1" ]; then
  echo "[agent-worker] success path did not verify" >&2
  echo "[agent-worker] worker log:" >&2
  tail -120 "$WORKER_LOG" >&2 || true
  echo "[agent-worker] mock hermes log:" >&2
  tail -120 "$MOCK_LOG" >&2 || true
  echo "[agent-worker] relay log:" >&2
  tail -120 "$RELAY_LOG" >&2 || true
  exit 1
fi

echo "[agent-worker] success path verified: REST mention -> agent_job -> agent.partial/tool_call + final channel message.new + usage_ledger + budget_window + cost_projection"
verify_cost_projection_endpoint

echo "[agent-worker] seeding approved deterministic resume fixture"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$RESUME_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID',
   'queued', 1, 12, 0,
   jsonb_build_object('prompt', 'MOMO-178 approved mock resume'),
   'momo-178-approved-resume');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, requested_by,
   action_type, payload, status, decided_by, decided_at, decision_reason)
VALUES
  ('$RESUME_APPROVAL_ID', '$WORKSPACE_ID', '$RESUME_RUN_ID', '$CHANNEL_ID', '$AGENT_ID',
   'tool_call',
   jsonb_build_object(
     'run_id', '$RESUME_RUN_ID',
     'action_type', 'tool_call',
     'tool_call', jsonb_build_object(
       'call_id', 'call_momo_178_echo',
       'name', 'momo.mock.echo',
       'arguments', jsonb_build_object('message', 'approved hello'),
       'tool_grant', jsonb_build_object(
         'tool_name', 'momo.mock.echo',
         'approval_policy', 'always',
         'capability_version', 'mock-tool@0.1.0',
         'policy_version', 'capability-policy@2026-06-29'
       )
     ),
     'resume_model', 'same_run_new_agent_job'
   ),
   'approved', '$HUMAN_ID', now(), 'runtime smoke approval');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'resume_approval',
   jsonb_build_object(
     'run_id', '$RESUME_RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '',
     'resume_from_approval_id', '$RESUME_APPROVAL_ID',
     'approved_tool_call', jsonb_build_object(
       'call_id', 'call_momo_178_echo',
       'name', 'momo.mock.echo',
       'arguments', jsonb_build_object('message', 'approved hello'),
       'payload_sha256', 'sha256:${RESUME_APPROVAL_ID}'
     ),
     'policy_evidence', jsonb_build_object(
       'tool_name', 'momo.mock.echo',
       'approval_policy', 'always',
       'capability_version', 'mock-tool@0.1.0',
       'policy_version', 'capability-policy@2026-06-29'
     ),
     'approval_decision', jsonb_build_object(
       'approval_id', '$RESUME_APPROVAL_ID',
       'status', 'approved'
     ),
     'step_count', 1,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL

RESUME_OK=0
deadline=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  RUN_DONE=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$RESUME_RUN_ID' AND status='succeeded' AND output->>'ok'='true';")
  JOB_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND method='resume_approval' AND payload->>'resume_from_approval_id'='$RESUME_APPROVAL_ID' AND status='done' AND last_error IS NULL;")
  RESULT_MSG=$(psql_scalar "SELECT count(*) FROM message WHERE run_id='$RESUME_RUN_ID' AND type='tool_result' AND props->>'approval_id'='$RESUME_APPROVAL_ID' AND props->>'call_id'='call_momo_178_echo' AND props->>'is_error'='false';")
  AUDIT_OK=$(psql_scalar "SELECT count(*) FROM audit_log WHERE run_id='$RESUME_RUN_ID' AND action IN ('approval.resume','tool.executed');")
  # In the all-profile gate, a relay process from the previous verifier can
  # consume this broadcast quickly. The invariant is that AgentWorker created a
  # non-failed broadcast outbox row for the tool_result, not that it remains
  # pending at the exact polling instant.
  BROADCAST_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='message.new' AND payload->'data'->'payload'->>'run_id'='$RESUME_RUN_ID' AND payload->'data'->'payload'->>'type'='tool_result' AND (payload->>'version')::bigint = (payload->'data'->>'seq')::bigint AND status IN ('pending', 'done') AND last_error IS NULL;")

  if [ "$RUN_DONE" = "1" ] && [ "$JOB_DONE" = "1" ] \
    && [ "$RESULT_MSG" = "1" ] && [ "$AUDIT_OK" = "2" ] \
    && [ "$BROADCAST_OK" = "1" ]; then
    RESUME_OK=1
    break
  fi
  sleep 1
done

if [ "$RESUME_OK" != "1" ]; then
  echo "[agent-worker] approved resume path did not verify" >&2
  tail -160 "$WORKER_LOG" >&2 || true
  exit 1
fi

echo "[agent-worker] approved resume path verified: final tool_result/message.new + audit + resume job done"

echo "[agent-worker] seeding low-limit circuit-breaker fixture"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$TRIP_MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', '@hermes 예산 초과 테스트', '$TRIP_CLIENT_MSG_ID'
  FROM bumped;

INSERT INTO budget
  (id, workspace_id, grain, agent_member_id, channel_id, limit_micro_usd, period_seconds)
VALUES
  ('$TRIP_BUDGET_ID', '$WORKSPACE_ID', 'agent_channel',
   '$AGENT_ID', '$CHANNEL_ID', 1, 3600);

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$TRIP_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', '$TRIP_MESSAGE_ID',
   'queued', 0, 12, 0,
   jsonb_build_object('prompt', '@hermes 예산 초과 테스트'),
   'momo-004-trip');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$TRIP_RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '@hermes 예산 초과 테스트',
     'max_output_tokens', 64,
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL

TRIP_OK=0
deadline=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  RUN_FAILED=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$TRIP_RUN_ID' AND status='failed' AND error #>> '{}' = 'G5 budget trip (agent_channel)';")
  OUTBOX_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'run_id'='$TRIP_RUN_ID' AND status='done';")
  NO_SPEND=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE run_id='$TRIP_RUN_ID';")

  if [ "$RUN_FAILED" = "1" ] && [ "$OUTBOX_DONE" = "1" ] && [ "$NO_SPEND" = "0" ]; then
    TRIP_OK=1
    break
  fi
  sleep 1
done

if [ "$TRIP_OK" != "1" ]; then
  echo "[agent-worker] circuit-breaker path did not verify" >&2
  tail -120 "$WORKER_LOG" >&2 || true
  exit 1
fi

echo "[agent-worker] circuit-breaker path verified: low-limit budget trips before spend"

# =============================================================================
# MOMO-301 deterministic loop-guard trip scenarios (a2a_depth/G3/G1/G2, DB SoT).
# Payload gate seeds are intentionally 0 so a trip proves the worker read the
# authoritative agent_run/agent/message state from Postgres, not the outbox
# payload. The §3.4 depth cap is labeled a2a_depth in durable records (audit
# detail/props/agent_run.error) — the canonical L4 §3.3 G4 is SimHash.
# =============================================================================

seed_guard_fixture() {
  guard_run_id=$1
  guard_message_id=$2
  guard_client_msg_id=$3
  guard_body=$4
  guard_step_count=$5
  guard_depth=$6
  guard_idem_key=$7

  psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$guard_message_id', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', '$guard_body', '$guard_client_msg_id'
  FROM bumped;

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$guard_run_id', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', '$guard_message_id',
   'queued', $guard_step_count, 12, $guard_depth,
   jsonb_build_object('prompt', '$guard_body'),
   '$guard_idem_key');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$guard_run_id',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '$guard_body',
     'max_output_tokens', 64,
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL
}

wait_guard_trip() {
  guard_run_id=$1
  guard_gate=$2
  guard_label=$3

  guard_ok=0
  deadline=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    RUN_FAILED=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$guard_run_id' AND status='failed' AND error->>'code'='loop_guard_tripped' AND error->>'gate'='$guard_gate';")
    AUDIT_OK=$(psql_scalar "SELECT count(*) FROM audit_log WHERE run_id='$guard_run_id' AND action='agent.guard.tripped' AND target_type='agent_run' AND detail->>'gate'='$guard_gate';")
    DEGRADED_OK=$(psql_scalar "SELECT count(*) FROM message WHERE run_id='$guard_run_id' AND type='system' AND author_member_id='$AGENT_ID' AND body LIKE '%loop-safety guard $guard_gate%' AND props->>'gate'='$guard_gate';")
    BROADCAST_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='message.new' AND payload->'data'->'payload'->>'run_id'='$guard_run_id' AND payload->'data'->'payload'->>'type'='system' AND (payload->>'version')::bigint = (payload->'data'->>'seq')::bigint AND status IN ('pending','processing','done') AND last_error IS NULL;")
    JOB_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'run_id'='$guard_run_id' AND status='done';")
    NO_SPEND=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE run_id='$guard_run_id';")

    if [ "$RUN_FAILED" = "1" ] && [ "$AUDIT_OK" = "1" ] && [ "$DEGRADED_OK" = "1" ] \
      && [ "$BROADCAST_OK" = "1" ] && [ "$JOB_DONE" = "1" ] && [ "$NO_SPEND" = "0" ]; then
      guard_ok=1
      break
    fi
    sleep 1
  done

  if [ "$guard_ok" != "1" ]; then
    echo "[agent-worker] loop-guard $guard_label trip did not verify" >&2
    printf 'run_failed=%s audit=%s degraded=%s broadcast=%s job_done=%s no_spend=%s\n' \
      "${RUN_FAILED:-}" "${AUDIT_OK:-}" "${DEGRADED_OK:-}" "${BROADCAST_OK:-}" "${JOB_DONE:-}" "${NO_SPEND:-}" >&2
    tail -120 "$WORKER_LOG" >&2 || true
    exit 1
  fi
  echo "[agent-worker] loop-guard $guard_label trip verified: failed run + audit_log + degraded system message + no spend"
}

echo "[agent-worker] seeding a2a_depth trip fixture (agent_run.depth=2 > MAX_DEPTH=$GUARD_MAX_DEPTH env, payload depth=0, CHECK depth<=4 respected)"
seed_guard_fixture "$GUARD_DEPTH_RUN_ID" "$GUARD_DEPTH_MESSAGE_ID" "$GUARD_DEPTH_CLIENT_MSG_ID" \
  '@hermes MOMO-301 depth cap trip' 0 2 'momo-301-guard-depth'
wait_guard_trip "$GUARD_DEPTH_RUN_ID" "a2a_depth" "a2a_depth(hop-depth)"

echo "[agent-worker] seeding G3 step-cap trip fixture (agent_run.step_count=12, payload step_count=0)"
seed_guard_fixture "$GUARD_STEP_RUN_ID" "$GUARD_STEP_MESSAGE_ID" "$GUARD_STEP_CLIENT_MSG_ID" \
  '@hermes MOMO-301 step cap trip' 12 0 'momo-301-guard-step'
wait_guard_trip "$GUARD_STEP_RUN_ID" "G3" "G3(step)"

echo "[agent-worker] seeding G1 concurrency trip fixture (decoy running run for the same agent)"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id,
   status, step_count, max_steps, depth, input, idempotency_key, started_at)
VALUES
  ('$GUARD_G1_DECOY_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID',
   'running', 1, 12, 0,
   jsonb_build_object('prompt', 'MOMO-301 G1 decoy live run'),
   'momo-301-guard-g1-decoy', now());
COMMIT;
SQL
seed_guard_fixture "$GUARD_G1_RUN_ID" "$GUARD_G1_MESSAGE_ID" "$GUARD_G1_CLIENT_MSG_ID" \
  '@hermes MOMO-301 concurrency trip' 0 0 'momo-301-guard-g1'
wait_guard_trip "$GUARD_G1_RUN_ID" "G1" "G1(concurrency)"

# Release the decoy semaphore so later verifiers (live-channel/hermes-bridge/
# m3-dbc reruns) are not G1-blocked by a synthetic live run.
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
UPDATE agent_run
   SET status = 'cancelled', finished_at = now(), updated_at = now()
 WHERE id = '$GUARD_G1_DECOY_RUN_ID';
COMMIT;
SQL

# G2 per-agent consecutive-auto trip: seed a human message followed by 2 agent
# text messages by the demo agent (no run_id -> each counts once), so the demo
# agent's counter since the last human message is 2 = MAX_CONSECUTIVE_AUTO env.
# The next run for this agent must trip G2 before any provider call.
echo "[agent-worker] seeding G2 consecutive-auto trip fixture (2 trailing agent text messages, MAX_CONSECUTIVE_AUTO=$GUARD_MAX_CONSECUTIVE_AUTO env)"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$GUARD_G2_MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', '@hermes MOMO-301 consecutive auto trip', '$GUARD_G2_CLIENT_MSG_ID'
  FROM bumped;

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body)
SELECT '$GUARD_G2_AGENT_MSG1_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$AGENT_ID', 'text', 'MOMO-301 G2 auto reply 1'
  FROM bumped;

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body)
SELECT '$GUARD_G2_AGENT_MSG2_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$AGENT_ID', 'text', 'MOMO-301 G2 auto reply 2'
  FROM bumped;

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$GUARD_G2_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', '$GUARD_G2_MESSAGE_ID',
   'queued', 0, 12, 0,
   jsonb_build_object('prompt', '@hermes MOMO-301 consecutive auto trip'),
   'momo-301-guard-g2');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$GUARD_G2_RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '@hermes MOMO-301 consecutive auto trip',
     'max_output_tokens', 64,
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL
wait_guard_trip "$GUARD_G2_RUN_ID" "G2" "G2(consecutive-auto)"

# Reset the demo agent's auto-reply counter with a human message so later
# verifiers in the same profile do not inherit the seeded streak.
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$GUARD_G2_RESET_MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', 'MOMO-301 G2 counter reset', '$GUARD_G2_RESET_CLIENT_MSG_ID'
  FROM bumped;
COMMIT;
SQL

echo "[agent-worker] loop-guard trip scenarios verified: a2a_depth(hop-depth) G3(step) G1(concurrency) G2(consecutive-auto)"
echo "[agent-worker] logs: worker=$WORKER_LOG mock=$MOCK_LOG server=$SERVER_LOG cost_projection=$COST_PROJECTION_JSON"
