#!/usr/bin/env sh
# =============================================================================
# scripts/verify_agent_context.sh — MOMO-302 context assembly runtime gate
#
# Prereq:
#   make up
#   make migrate
#
# Proves the agent stops being amnesiac: a @hermes mention now carries the
# same-channel conversation history (recent-N/thread window) into the hermes
# chat request, with correct speaker→role mapping and a char-budget window.
#
# Scenario (single AgentWorker run, mock hermes request captured to a dump):
#   1) seed prior channel messages ("파인애플 재고는 7개다" + an agent turn)
#      plus two long padding messages, and an off-topic message in ANOTHER
#      channel (cross-channel isolation probe);
#   2) @mention the agent via REST POST /messages (the trigger);
#   3) AgentWorker assembles + calls mock hermes; the mock dumps the request;
#   4) assert from the dump:
#      (a) seeded history messages are delivered as recent context,
#      (b) the agent's own prior turn maps to role=assistant (others=user),
#      (c) the other-channel message is NOT present (session boundary),
#      (d) a small AGENT_CONTEXT_MAX_CHARS drops the oldest padding while the
#          trigger + newest history survive (worker logs a trim count).
#
# This verifier owns the demo workspace agent_job queue while it runs and
# cleans up its own server/worker/mock processes on exit.
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
    echo "[agent-context] missing required command: $1" >&2
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
  echo "[agent-context] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

psql_run() {
  if [ "${DATABASE_URL:-}" != "" ]; then
    "$PSQL_BIN" "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  else
    "$PSQL_BIN" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  fi
}

POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_DB=${POSTGRES_DB:-momo}
# Dedicated ports so this verifier does not collide with verify_agent_worker.sh
# when both run in the same local gate profile.
PORT=${AGENT_CONTEXT_PORT:-8082}
BASE_URL=http://127.0.0.1:${PORT}
HERMES_PORT=${AGENT_CONTEXT_HERMES_PORT:-8090}
HERMES_BASE_URL=http://localhost:${HERMES_PORT}/v1
HERMES_API_KEY=${HERMES_API_KEY:-dev-insecure-hermes-bearer}
CENT_API_KEY=${CENT_API_KEY:-dev-insecure-cent-api-key}
CENT_PORT=${CENT_PORT:-8000}
CENT_API_URL=${CENT_API_URL:-http://localhost:${CENT_PORT}/api}
WORKER_POLL_INTERVAL_MS=${WORKER_POLL_INTERVAL_MS:-100}

# History window knobs under test.
SERVER_MAX_MESSAGES=5     # AGENT_CONTEXT_MAX_MESSAGES: isolate our 5 recent rows
WORKER_MAX_CHARS=200      # AGENT_CONTEXT_MAX_CHARS: force oldest-padding drop

WORKSPACE_ID=00000000-0000-7000-8000-000000000001
HUMAN_ID=00000000-0000-7000-8000-000000000101
AGENT_ID=00000000-0000-7000-8000-000000000103
TARGET_CHANNEL=00000000-0000-7000-8000-000000000202
OTHER_CHANNEL=00000000-0000-7000-8000-000000000201
BUDGET_ID=00000000-0000-7000-8000-000000000302
CLIENT_MSG_ID=00000000-0000-7000-8000-000000302907

TMP_ROOT=${TMPDIR:-/tmp}
MOCK_LOG=${TMP_ROOT}/momo-ctx-mock-$$.log
WORKER_LOG=${TMP_ROOT}/momo-ctx-worker-$$.log
SERVER_LOG=${TMP_ROOT}/momo-ctx-server-$$.log
DUMP_FILE=${TMP_ROOT}/momo-ctx-hermes-request-$$.jsonl
MOCK_PID=
WORKER_PID=
SERVER_PID=

cleanup() {
  for pid in "$WORKER_PID" "$SERVER_PID" "$MOCK_PID"; do
    if [ "${pid:-}" != "" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

wait_http() {
  url=$1
  name=$2
  deadline=$(($(date +%s) + 30))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[agent-context] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "[agent-context] ${name} did not become ready: ${url}" >&2
  return 1
}

echo "[agent-context] using env file: ${ENV_FILE:-<none>}"
echo "[agent-context] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null

if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  echo "[agent-context] $BASE_URL already serving /health; stop it before running this verifier." >&2
  exit 1
fi

echo "[agent-context] starting MomoServer (AGENT_CONTEXT_MAX_MESSAGES=$SERVER_MAX_MESSAGES)"
(
  cd "$REPO_ROOT"
  DATABASE_URL="postgres://momo_app:momo_app_dev_pw@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
  PORT="$PORT" \
  AGENT_CONTEXT_MAX_MESSAGES="$SERVER_MAX_MESSAGES" \
  swift run --package-path server MomoServer
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

deadline=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[agent-context] MomoServer exited before health became green" >&2
    tail -120 "$SERVER_LOG" >&2 || true
    exit 1
  fi
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[agent-context] MomoServer health is green"
    break
  fi
  sleep 1
done
curl -fsS "$BASE_URL/health" >/dev/null 2>&1 || { echo "[agent-context] server health timeout" >&2; exit 1; }

echo "[agent-context] starting mock hermes with request dump: $DUMP_FILE"
: > "$DUMP_FILE"
MOCK_HERMES_REQUEST_DUMP="$DUMP_FILE" \
  python3 "$REPO_ROOT/scripts/mock_hermes.py" --host 127.0.0.1 --port "$HERMES_PORT" \
  >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
wait_http "http://127.0.0.1:${HERMES_PORT}/health" "mock hermes"

echo "[agent-context] seeding channel history + off-topic cross-channel message"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

-- Own the queue + clear any prior CTX302 fixtures so counts are deterministic.
DELETE FROM outbox
 WHERE workspace_id = '$WORKSPACE_ID'
   AND kind = 'agent_job'
   AND status IN ('pending', 'processing');
DELETE FROM outbox
 WHERE workspace_id = '$WORKSPACE_ID'
   AND payload->>'trigger_message_id' IN (
     SELECT id::text FROM message
      WHERE workspace_id = '$WORKSPACE_ID' AND body LIKE 'CTX302%'
   );
DELETE FROM agent_run
 WHERE workspace_id = '$WORKSPACE_ID'
   AND trigger_message_id IN (
     SELECT id FROM message
      WHERE workspace_id = '$WORKSPACE_ID' AND body LIKE 'CTX302%'
   );
DELETE FROM message
 WHERE workspace_id = '$WORKSPACE_ID'
   AND (body LIKE 'CTX302%' OR client_msg_id = '$CLIENT_MSG_ID');

-- 1) oldest padding (dropped by the small char budget)
WITH b AS (UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = '$TARGET_CHANNEL' RETURNING last_seq)
INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body)
SELECT '$WORKSPACE_ID', '$TARGET_CHANNEL', b.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', 'CTX302 PADDINGONE ' || repeat('가나다라마바사아 ', 120)
  FROM b;

WITH b AS (UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = '$TARGET_CHANNEL' RETURNING last_seq)
INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body)
SELECT '$WORKSPACE_ID', '$TARGET_CHANNEL', b.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', 'CTX302 PADDINGTWO ' || repeat('자차카타파하 ', 120)
  FROM b;

-- 2) human history keeper (must be delivered as recent context)
WITH b AS (UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = '$TARGET_CHANNEL' RETURNING last_seq)
INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body)
SELECT '$WORKSPACE_ID', '$TARGET_CHANNEL', b.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', 'CTX302 파인애플 재고는 7개다'
  FROM b;

-- 3) the agent's own prior turn (must map to role=assistant)
WITH b AS (UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = '$TARGET_CHANNEL' RETURNING last_seq)
INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, run_id)
SELECT '$WORKSPACE_ID', '$TARGET_CHANNEL', b.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$AGENT_ID', 'text', 'CTX302 재고를 확인했습니다', NULL
  FROM b;

-- 4) off-topic message in ANOTHER channel (session boundary probe)
WITH b AS (UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = '$OTHER_CHANNEL' RETURNING last_seq)
INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body)
SELECT '$WORKSPACE_ID', '$OTHER_CHANNEL', b.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', 'CTX302 OTHERCHANNELSECRET off-topic'
  FROM b;

-- Clear restrictive per-agent/per-channel budgets left in the shared DB volume
-- by a prior verifier (e.g. verify_agent_worker's agent_channel trip budget,
-- which it only cleans at the START of its own next run) so the cost reserve
-- does not trip before the hermes call — only the generous workspace budget
-- below should govern this smoke. budget_window cascades on delete.
DELETE FROM budget
 WHERE workspace_id = '$WORKSPACE_ID'
   AND grain <> 'workspace'
   AND (channel_id = '$TARGET_CHANNEL' OR agent_member_id = '$AGENT_ID');

-- generous workspace budget so reserve never trips before the hermes call
INSERT INTO budget (id, workspace_id, grain, limit_micro_usd, period_seconds)
VALUES ('$BUDGET_ID', '$WORKSPACE_ID', 'workspace', 1000000, 3600)
ON CONFLICT (id) DO NOTHING;

COMMIT;
SQL

echo "[agent-context] starting AgentWorker (AGENT_CONTEXT_MAX_CHARS=$WORKER_MAX_CHARS)"
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
    AGENT_CONTEXT_MAX_CHARS="$WORKER_MAX_CHARS" \
    "$WORKER_BIN"
) >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[agent-context] logging in + sending @hermes trigger"
LOGIN_JSON=$(curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"demo@momo.local\",\"password\":\"dev-password\",\"workspace\":\"$WORKSPACE_ID\"}" \
  "$BASE_URL/v1/auth/login")
ACCESS_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken')
if [ "$ACCESS_TOKEN" = "" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  echo "[agent-context] failed to obtain access token" >&2
  printf '%s\n' "$LOGIN_JSON" >&2
  exit 1
fi

TRIGGER_BODY='CTX302 @hermes 파인애플 재고 몇 개야?'
SEND_PAYLOAD=$(jq -cn --arg client "$CLIENT_MSG_ID" --arg body "$TRIGGER_BODY" \
  '{clientMsgId:$client,type:"text",body:$body}')
curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$SEND_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$TARGET_CHANNEL/messages" >/dev/null

echo "[agent-context] waiting for the assembled hermes request dump"
FOUND=0
deadline=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[agent-context] AgentWorker exited early" >&2
    tail -80 "$WORKER_LOG" >&2 || true
    exit 1
  fi
  if grep -q '파인애플 재고 몇 개야' "$DUMP_FILE" 2>/dev/null; then
    FOUND=1
    break
  fi
  sleep 1
done

if [ "$FOUND" != "1" ]; then
  echo "[agent-context] no assembled hermes request captured" >&2
  echo "[agent-context] worker log:" >&2; tail -120 "$WORKER_LOG" >&2 || true
  echo "[agent-context] mock log:" >&2; tail -60 "$MOCK_LOG" >&2 || true
  exit 1
fi

echo "[agent-context] asserting assembled context invariants"
python3 - "$DUMP_FILE" <<'PY'
import json, sys

path = sys.argv[1]
requests = []
with open(path, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if line:
            requests.append(json.loads(line))

# Pick the request that carries our trigger turn.
target = None
for req in requests:
    msgs = req.get("messages", [])
    if any("파인애플 재고 몇 개야" in (m.get("content") or "") for m in msgs):
        target = req
        break

if target is None:
    print("FAIL: trigger request not found in dump", file=sys.stderr)
    sys.exit(1)

messages = target["messages"]
roles = [m["role"] for m in messages]
contents = [m.get("content") or "" for m in messages]
non_system = [m for m in messages if m["role"] != "system"]


def content_of(token):
    return next((c for c in contents if token in c), None)


# (system) the agent's own system prompt seeds the first message
if roles[0] != "system":
    print(f"FAIL: expected first message role=system, got {roles[0]}", file=sys.stderr)
    sys.exit(1)

# (a) seeded human history is delivered as recent context
if content_of("파인애플 재고는 7개다") is None:
    print("FAIL: seeded history message not delivered as recent context", file=sys.stderr)
    sys.exit(1)

# (b) the agent's own prior turn maps to role=assistant; humans map to user
assistant_msgs = [m for m in messages if m["role"] == "assistant"]
if not any("재고를 확인했습니다" in (m.get("content") or "") for m in assistant_msgs):
    print("FAIL: agent's own prior turn not mapped to role=assistant", file=sys.stderr)
    sys.exit(1)
human_hist = next((m for m in messages if "파인애플 재고는 7개다" in (m.get("content") or "")), None)
if human_hist is None or human_hist["role"] != "user":
    print("FAIL: human history not mapped to role=user", file=sys.stderr)
    sys.exit(1)

# (c) session boundary: the other-channel message must NOT appear
if content_of("OTHERCHANNELSECRET") is not None:
    print("FAIL: cross-channel message leaked into the window", file=sys.stderr)
    sys.exit(1)

# (d) small char budget dropped the oldest padding; trigger survives
if content_of("PADDINGONE") is not None or content_of("PADDINGTWO") is not None:
    print("FAIL: oldest padding was not dropped under the char budget", file=sys.stderr)
    sys.exit(1)
if content_of("파인애플 재고 몇 개야") is None:
    print("FAIL: trigger message was dropped (must always be kept)", file=sys.stderr)
    sys.exit(1)
# window was seeded with 5 rows (2 padding + 2 keepers + trigger); budget trims it
if len(non_system) >= 5:
    print(f"FAIL: expected trimmed window (<5 non-system), got {len(non_system)}", file=sys.stderr)
    sys.exit(1)

print(
    "[agent-context] OK: system+history assembled, self=assistant/others=user, "
    f"cross-channel excluded, budget trimmed to {len(non_system)} non-system turns"
)
PY

# The worker must have logged the drop (count only — never message bodies).
if ! grep -q "context window trimmed to budget" "$WORKER_LOG"; then
  echo "[agent-context] worker did not log a budget trim" >&2
  tail -120 "$WORKER_LOG" >&2 || true
  exit 1
fi

echo "[agent-context] context assembly verified: recent-N history + role mapping + session boundary + token budget"
echo "[agent-context] logs: worker=$WORKER_LOG mock=$MOCK_LOG server=$SERVER_LOG dump=$DUMP_FILE"
