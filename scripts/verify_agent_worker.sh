#!/usr/bin/env sh
# =============================================================================
# scripts/verify_agent_worker.sh — MOMO-004 AgentWorker runtime gate
#
# Prereq:
#   make up
#   make migrate
#
# Verifies:
#   1) demo "mention" fixture creates one agent_job outbox row
#   2) AgentWorker claims it with SKIP LOCKED and calls an OpenAI-compatible
#      SSE gateway (scripts/mock_hermes.py by default)
#   3) Centrifugo history receives agent.partial
#   4) cost reserve/reconcile writes budget_window + usage_ledger
#   5) MomoServer cost-snapshots endpoint exposes the server-owned projection
#   6) a low-limit budget trips before spending
# =============================================================================
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

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
AGENT_ID=00000000-0000-7000-8000-000000000102
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
AGENT_CHANNEL=agent:ws${WORKSPACE_ID}.${AGENT_ID}

TMP_ROOT=${TMPDIR:-/tmp}
MOCK_LOG=${TMP_ROOT}/momo-mock-hermes-$$.log
WORKER_LOG=${TMP_ROOT}/momo-agent-worker-$$.log
SERVER_LOG=${TMP_ROOT}/momo-cost-projection-server-$$.log
COST_PROJECTION_JSON=${TMP_ROOT}/momo-cost-projection-$$.json
MOCK_PID=
WORKER_PID=
SERVER_PID=

cleanup() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "${WORKER_PID:-}" != "" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
  if [ "${MOCK_PID:-}" != "" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
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

verify_cost_projection_endpoint() {
  start_server
  LOGIN_JSON=$(curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"demo@momo.local\",\"password\":\"demo\",\"workspace\":\"$WORKSPACE_ID\"}" \
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
echo "[agent-worker] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null

echo "[agent-worker] starting mock hermes on ${HERMES_BASE_URL}"
python3 "$REPO_ROOT/scripts/mock_hermes.py" --host 127.0.0.1 --port "$HERMES_PORT" \
  >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
wait_http "http://127.0.0.1:${HERMES_PORT}/health" "mock hermes"

echo "[agent-worker] seeding mention-driven agent_job fixture"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

DELETE FROM usage_ledger WHERE run_id IN ('$RUN_ID', '$TRIP_RUN_ID');
DELETE FROM audit_log WHERE target_id = '$RESUME_APPROVAL_ID' OR run_id = '$RESUME_RUN_ID';
-- The all-profile local gate runs approval-decision verification before this
-- script. That verifier intentionally leaves a resume_approval job as durable
-- evidence, but this AgentWorker verifier owns the demo workspace queue while
-- it runs and must not claim another verifier's pending agent_job first.
DELETE FROM outbox
 WHERE workspace_id = '$WORKSPACE_ID'
   AND kind = 'agent_job'
   AND status IN ('pending', 'processing');
DELETE FROM outbox WHERE payload->>'run_id' IN ('$RUN_ID', '$RESUME_RUN_ID', '$TRIP_RUN_ID')
   OR payload->>'resume_from_approval_id' = '$RESUME_APPROVAL_ID'
   OR payload->'data'->'payload'->>'run_id' IN ('$RUN_ID', '$RESUME_RUN_ID', '$TRIP_RUN_ID');
DELETE FROM approval WHERE id = '$RESUME_APPROVAL_ID';
DELETE FROM budget_window WHERE budget_id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');
DELETE FROM budget WHERE id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');
DELETE FROM message WHERE run_id = '$RESUME_RUN_ID';
DELETE FROM agent_run WHERE id IN ('$RUN_ID', '$RESUME_RUN_ID', '$TRIP_RUN_ID');
DELETE FROM message WHERE id IN ('$MESSAGE_ID', '$TRIP_MESSAGE_ID');

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', '@김인턴 MOMO-004 런타임 검증해줘', '$CLIENT_MSG_ID'
  FROM bumped;

INSERT INTO budget
  (id, workspace_id, grain, limit_micro_usd, period_seconds)
VALUES
  ('$BUDGET_ID', '$WORKSPACE_ID', 'workspace', 1000000, 3600);

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', '$MESSAGE_ID',
   'queued', 0, 12, 0,
   jsonb_build_object('prompt', '@김인턴 MOMO-004 런타임 검증해줘'),
   'momo-004-success');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '@김인턴 MOMO-004 런타임 검증해줘',
     'max_output_tokens', 64,
     'tool_grants', jsonb_build_array(jsonb_build_object(
       'tool_name', 'github.search_issues',
       'provider', 'github',
       'grant', 'read',
       'risk', 'read',
       'approval_policy', 'none',
       'resource_scope_summary', 'repo:Dawn-kim-official/momo',
       'capability_version', 'mock-github@0.1.0',
       'policy_version', 'capability-policy@2026-06-30'
     )),
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL

echo "[agent-worker] starting AgentWorker"
(
  cd "$REPO_ROOT"
  RELAY_DATABASE_URL="postgres://momo_worker:momo_worker_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  HERMES_BASE_URL="$HERMES_BASE_URL" \
  HERMES_API_KEY="$HERMES_API_KEY" \
  WORKER_POLL_INTERVAL_MS="$WORKER_POLL_INTERVAL_MS" \
  swift run --package-path workers/AgentWorker AgentWorker
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
  # In the full local gate, approval-decision verification can leave a valid
  # same-run resume agent_job that the worker processes before this fixture.
  # The immutable usage_ledger assertion above proves this run's exact cost;
  # the shared workspace budget window only needs to show that reservations
  # were released and at least this run's spend was reconciled.
  WINDOW_OK=$(psql_scalar "SELECT count(*) FROM budget_window WHERE budget_id='$BUDGET_ID' AND reserved_micro_usd=0 AND spent_micro_usd>=6;")

  HISTORY_JSON=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$AGENT_CHANNEL\",\"limit\":20}" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')
  PARTIAL_OK=$(printf '%s' "$HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "agent.partial")
      | select((.payload.run_id // .payload.runId) == $run)
      | select((.payload.text // "") | contains("MOMO-004 SSE path verified"))
    ] | length
  ')
  TOOL_PARTIAL_OK=$(printf '%s' "$HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "agent.partial")
      | select((.payload.run_id // .payload.runId) == $run)
      | select(.payload.tool_call_name == "github.search_issues")
      | select((.payload.tool_call_args | type) == "object")
      | select(.payload.tool_call_args.query == "MOMO-201 live tool-call fixture")
      | select(.payload.tool_call_args.limit == 2)
      | select(.payload.tool_call_args_truncated == false)
    ] | length
  ')

  if [ "$RUN_OK" = "1" ] && [ "$OUTBOX_OK" = "1" ] \
    && [ "$USAGE_OK" = "1" ] && [ "$WINDOW_OK" = "1" ] \
    && [ "$PROJECTION_OK" = "1" ] \
    && [ "$PARTIAL_OK" != "0" ] && [ "$TOOL_PARTIAL_OK" != "0" ]; then
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
  exit 1
fi

echo "[agent-worker] success path verified: agent.partial text + MOMO-201 tool_call progress + usage_ledger + budget_window + cost_projection"
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
       '$HUMAN_ID', 'text', '@김인턴 예산 초과 테스트', '$TRIP_CLIENT_MSG_ID'
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
   jsonb_build_object('prompt', '@김인턴 예산 초과 테스트'),
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
     'prompt', '@김인턴 예산 초과 테스트',
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
echo "[agent-worker] logs: worker=$WORKER_LOG mock=$MOCK_LOG server=$SERVER_LOG cost_projection=$COST_PROJECTION_JSON"
