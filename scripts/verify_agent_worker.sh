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
#   5) a low-limit budget trips before spending
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
POSTGRES_DB=${POSTGRES_DB:-momo}
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
MOCK_PID=
WORKER_PID=

cleanup() {
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
DELETE FROM outbox WHERE payload->>'run_id' IN ('$RUN_ID', '$TRIP_RUN_ID');
DELETE FROM budget_window WHERE budget_id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');
DELETE FROM budget WHERE id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');
DELETE FROM agent_run WHERE id IN ('$RUN_ID', '$TRIP_RUN_ID');
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
  WINDOW_OK=$(psql_scalar "SELECT count(*) FROM budget_window WHERE budget_id='$BUDGET_ID' AND reserved_micro_usd=0 AND spent_micro_usd=6;")

  HISTORY_JSON=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$AGENT_CHANNEL\",\"limit\":20}" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')
  PARTIAL_OK=$(printf '%s' "$HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "agent.partial")
      | select(.payload.runId == $run)
      | select((.payload.text // "") | contains("MOMO-004 SSE path verified"))
    ] | length
  ')

  if [ "$RUN_OK" = "1" ] && [ "$OUTBOX_OK" = "1" ] \
    && [ "$USAGE_OK" = "1" ] && [ "$WINDOW_OK" = "1" ] \
    && [ "$PARTIAL_OK" != "0" ]; then
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

echo "[agent-worker] success path verified: agent.partial + usage_ledger + budget_window"

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
echo "[agent-worker] logs: worker=$WORKER_LOG mock=$MOCK_LOG"
