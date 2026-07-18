#!/usr/bin/env bash
# MOMO-479 thread projection + replies API + AgentWorker root preservation gate.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[thread-projection] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq
need uuidgen

PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 \
    && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' \
      >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
[ -n "$PYTHON_BIN" ] || {
  echo "[thread-projection] missing python >= 3.10" >&2
  exit 1
}

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${THREAD_PROJECTION_PROJECT:-momo479threadprojection}"
API_PORT="${THREAD_PROJECTION_API_PORT:-27850}"
CENT_PORT_HOST="${THREAD_PROJECTION_CENTRIFUGO_PORT:-27851}"
PG_PORT="${THREAD_PROJECTION_POSTGRES_PORT:-27852}"
HERMES_PORT_HOST="${THREAD_PROJECTION_HERMES_PORT:-27853}"
BOOT_TIMEOUT="${THREAD_PROJECTION_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${THREAD_PROJECTION_ASSERT_TIMEOUT:-240}"
RUN_SUFFIX="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-thread-projection-$RUN_SUFFIX"
mkdir -p "$TMP_DIR"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
HUMAN_ID="00000000-0000-7000-8000-000000000101"
AGENT_ID="00000000-0000-7000-8000-000000000103"
OTHER_WS_ID="47900000-0000-7000-8000-000000000099"
CENT_CHANNEL="ch:ws${WS_ID}.${CHANNEL_ID}"
CENT_API_KEY="${CENT_API_KEY:-change-me-cent-api-key}"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${THREAD_PROJECTION_KEEP:-0}" = "1" ]; then
    echo "[thread-projection] leaving compose project '$PROJECT' up"
    echo "[thread-projection] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$TMP_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
CENT_API_URL="http://127.0.0.1:$CENT_PORT_HOST/api"

echo "[thread-projection] booting isolated api/relay/worker stack '$PROJECT'"
compose up -d api relay worker
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay worker >&2 || true
    echo "[thread-projection] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[thread-projection] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql \
    -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e 'demo@momo.local' --arg p 'dev-password' --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken')"

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" body="${3:-}" out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[thread-projection] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}
send_message() {
  local client_id="$1" body="$2" root_id="${3:-}" payload
  if [ -n "$root_id" ]; then
    payload="$(jq -cn --arg c "$client_id" --arg b "$body" --arg r "$root_id" \
      '{clientMsgId:$c,body:$b,rootId:$r}')"
  else
    payload="$(jq -cn --arg c "$client_id" --arg b "$body" \
      '{clientMsgId:$c,body:$b}')"
  fi
  api POST "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" "$payload"
}

ROOT_CLIENT_ID="$(uuidgen)"
send_message "$ROOT_CLIENT_ID" "MOMO-479 thread projection root"
expect_status 201 "root send"
ROOT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"
printf '%s' "$RESPONSE_BODY" | jq -e 'has("thread") | not' >/dev/null

reply_ids=()
reply_seqs=()
for index in 1 2 3; do
  send_message "$(uuidgen)" "historical reply $index" "$ROOT_ID"
  expect_status 201 "historical reply $index"
  reply_id="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"
  reply_seq="$(printf '%s' "$RESPONSE_BODY" | jq -er '.seq')"
  reply_ids+=("$reply_id")
  reply_seqs+=("$reply_seq")
done
REPLY_ONE_ID="${reply_ids[0]}"
REPLY_TWO_ID="${reply_ids[1]}"
REPLY_ONE_SEQ="${reply_seqs[0]}"
REPLY_TWO_SEQ="${reply_seqs[1]}"
REPLY_THREE_SEQ="${reply_seqs[2]}"

# Preserve one deleted reply as a tombstone in the historical reply window.
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE message
   SET state = 'deleted', body = NULL, deleted_at = clock_timestamp()
 WHERE id = '$REPLY_TWO_ID';
COMMIT;
SQL

api GET "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages?after=0&limit=100"
expect_status 200 "history rollup"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg root "$ROOT_ID" --argjson last "$REPLY_THREE_SEQ" '
    .messages[]
    | select((.id | ascii_downcase) == $root)
    | .thread.reply_count == 3
      and .thread.last_reply_seq == $last
      and (.thread.last_reply_at | type == "number")
  ' >/dev/null

# An idempotent top-level send returns the existing root with its rollup.
send_message "$ROOT_CLIENT_ID" "MOMO-479 thread projection root"
expect_status 201 "root idempotent response rollup"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg root "$ROOT_ID" --argjson last "$REPLY_THREE_SEQ" '
    (.id | ascii_downcase) == $root
    and .thread.reply_count == 3
    and .thread.last_reply_seq == $last
  ' >/dev/null

api GET "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages/$ROOT_ID/replies?limit=2"
expect_status 200 "replies first page"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/replies-page-1.json"
CURSOR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.nextCursor')"
[ "$CURSOR" = "$REPLY_TWO_SEQ" ] || {
  echo "[thread-projection] FAIL cursor: expected $REPLY_TWO_SEQ, got $CURSOR" >&2
  exit 1
}
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg one "$REPLY_ONE_ID" --arg two "$REPLY_TWO_ID" '
    [.messages[].id | ascii_downcase] == [$one, $two]
    and (.messages[1].deletedAt != null)
    and (.messages[1].body == null)
  ' >/dev/null

api GET "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages/$ROOT_ID/replies?cursor=$CURSOR&limit=2"
expect_status 200 "replies second page"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/replies-page-2.json"
"$PYTHON_BIN" - "$TMP_DIR/replies-page-1.json" "$TMP_DIR/replies-page-2.json" \
  "$REPLY_ONE_SEQ" "$REPLY_TWO_SEQ" "$REPLY_THREE_SEQ" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    first = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    second = json.load(handle)
expected = [int(value) for value in sys.argv[3:]]
actual = [message["seq"] for message in first["messages"] + second["messages"]]
if actual != expected or second.get("nextCursor") is not None:
    raise SystemExit(f"cursor roundtrip mismatch: actual={actual}, expected={expected}")
PY

# Relay must deliver the projection to Centrifugo history, not merely leave an
# outbox row behind.
THREAD_EVENT_OK=0
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  history="$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg ch "$CENT_CHANNEL" '{channel:$ch,limit:100,reverse:true}')" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')"
  matches="$(printf '%s' "$history" | jq -r \
    --arg root "$ROOT_ID" --argjson last "$REPLY_THREE_SEQ" '
      [.result.publications[]?.data
       | select(.type == "thread.updated")
       | select((.payload.root_id | ascii_downcase) == $root)
       | select(.payload.reply_count == 3)
       | select(.payload.last_reply_seq == $last)] | length
    ' 2>/dev/null || printf '0')"
  if [ "$matches" != "0" ]; then
    THREAD_EVENT_OK=1
    break
  fi
  sleep 1
done
[ "$THREAD_EVENT_OK" = "1" ] || {
  compose logs --tail 120 relay >&2 || true
  echo "[thread-projection] FAIL thread.updated was not delivered" >&2
  exit 1
}

# Mention Hermes from inside the thread. The worker's durable response must
# inherit ROOT_ID, increment the same rollup, append the agent participant, and
# publish another thread.updated in its INSERT transaction.
send_message "$(uuidgen)" "@hermes MOMO-479 reply inside this thread" "$ROOT_ID"
expect_status 201 "threaded agent trigger"
TRIGGER_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"
TRIGGER_SEQ="$(printf '%s' "$RESPONSE_BODY" | jq -er '.seq')"

AGENT_ASSERTION=""
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  AGENT_ASSERTION="$(sql_value <<SQL
SELECT concat_ws(':', lower(m.id::text), lower(COALESCE(m.root_id::text, '')), m.seq,
                 t.reply_count, t.last_reply_seq,
                 (ARRAY['$HUMAN_ID'::uuid, '$AGENT_ID'::uuid] <@ t.participant_ids)::int,
                 r.status)
  FROM agent_run r
  JOIN message m ON m.run_id = r.id
  JOIN thread t ON t.root_id = '$ROOT_ID'
 WHERE r.trigger_message_id = '$TRIGGER_ID'
   AND m.author_member_id = '$AGENT_ID'
   AND m.type = 'text'
 LIMIT 1;
SQL
)"
  case "$AGENT_ASSERTION" in
    *":$ROOT_ID:"*":5:"*":1:succeeded") break ;;
  esac
  if [ -n "$(compose ps -aq --status exited worker 2>/dev/null)" ]; then
    compose logs --tail 160 worker >&2 || true
    echo "[thread-projection] worker exited" >&2
    exit 1
  fi
  sleep 1
done

IFS=: read -r _ AGENT_ROOT_ID AGENT_SEQ REPLY_COUNT \
  LAST_REPLY_SEQ PARTICIPANTS_OK RUN_STATUS <<EOF
$AGENT_ASSERTION
EOF
[ "$AGENT_ROOT_ID" = "$ROOT_ID" ] \
  && [ "$REPLY_COUNT" = "5" ] \
  && [ "$LAST_REPLY_SEQ" = "$AGENT_SEQ" ] \
  && [ "$PARTICIPANTS_OK" = "1" ] \
  && [ "$RUN_STATUS" = "succeeded" ] || {
    compose logs --tail 160 worker relay >&2 || true
    echo "[thread-projection] FAIL agent reply projection: $AGENT_ASSERTION" >&2
    exit 1
  }
[ "$AGENT_SEQ" -gt "$TRIGGER_SEQ" ] || {
  echo "[thread-projection] FAIL agent reply did not receive the next message seq" >&2
  exit 1
}

got="$(sql_value <<SQL
SELECT count(*)
  FROM outbox
 WHERE workspace_id = '$WS_ID'
   AND payload->'data'->>'type' = 'thread.updated'
   AND lower(payload->'data'->'payload'->>'root_id') = '$ROOT_ID'
   AND (payload->'data'->'payload'->>'last_reply_seq')::bigint = $AGENT_SEQ
   AND (payload->'data'->'payload'->>'reply_count')::int = 5;
SQL
)"
[ "$got" = "1" ] || {
  echo "[thread-projection] FAIL agent thread.updated outbox: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id = '$OTHER_WS_ID';
SELECT count(*) FROM thread WHERE root_id = '$ROOT_ID';
COMMIT;
SQL
)"
[ "$got" = "0" ] || {
  echo "[thread-projection] FAIL cross-tenant thread RLS: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
SELECT count(*)
  FROM pg_class
 WHERE relname IN ('message', 'thread')
   AND relrowsecurity
   AND relforcerowsecurity;
SQL
)"
[ "$got" = "2" ] || {
  echo "[thread-projection] FAIL FORCE RLS metadata: $got" >&2
  exit 1
}

echo "MOMO-479 thread projection + replies cursor + realtime + AgentWorker root_id + RLS PASS"
