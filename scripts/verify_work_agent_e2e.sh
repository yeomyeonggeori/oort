#!/usr/bin/env bash
# MOMO-486 / ADR-0114 chat -> work_spawn -> approval -> session-thread control E2E.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[work-agent] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq

find_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
        >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "[work-agent] Python 3.10+ not found (tried python3.13 through python3)" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORK_AGENT_GATE_PROJECT:-momo486workagent}"
API_PORT="${WORK_AGENT_GATE_API_PORT:-27930}"
CENT_PORT_HOST="${WORK_AGENT_GATE_CENTRIFUGO_PORT:-27931}"
PG_PORT="${WORK_AGENT_GATE_POSTGRES_PORT:-27932}"
HERMES_PORT_HOST="${WORK_AGENT_GATE_HERMES_PORT:-27933}"
BOOT_TIMEOUT="${WORK_AGENT_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${WORK_AGENT_GATE_ASSERT_TIMEOUT:-240}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-agent.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_TENANT_ID="48600000-0000-7000-8000-000000000099"
CENT_CHANNEL="ch:ws${WS_ID}.${CHANNEL_ID}"
CENT_API_KEY="${CENT_API_KEY:-change-me-cent-api-key}"
OWNER_ID="$(new_uuid)"
AGENT_ONE_ID="$(new_uuid)"
AGENT_TWO_ID="$(new_uuid)"
HOST_ID="$(new_uuid)"
HOST_PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="
OWNER_EMAIL="work-agent-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
ACTIVE_AGENT_TOKEN=""

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" MOMO_AGENT_TOKEN="$ACTIVE_AGENT_TOKEN" \
    MOMO_WORK_HOST_ID="$HOST_ID" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  ACTIVE_AGENT_TOKEN=""
  if [ "${WORK_AGENT_GATE_KEEP:-0}" = "1" ]; then
    echo "[work-agent] leaving compose project '$PROJECT' up"
    echo "[work-agent] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-work-agent.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[work-agent] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
CENT_API_URL="http://127.0.0.1:$CENT_PORT_HOST/api"

echo "[work-agent] booting isolated api/relay stack '$PROJECT'"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[work-agent] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-agent] api exited" >&2
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

wait_sql() {
  local expected="$1" label="$2" query value
  query="$(cat)"
  deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    value="$(printf '%s\n' "$query" | sql_value)"
    if [ "$value" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  compose logs --tail 160 worker api relay mock-hermes >&2 || true
  echo "[work-agent] FAIL $label: expected '$expected', got '$value'" >&2
  exit 1
}

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Work Agent Owner', 'wao-$RUN_TAG'),
  ('$AGENT_ONE_ID', '$WS_ID', 'agent', 'active', 'Work Agent One', 'waa-$RUN_TAG'),
  ('$AGENT_TWO_ID', '$WS_ID', 'agent', 'active', 'Work Agent Two', 'wab-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ONE_ID', '$WS_ID', 'hermes-agent', 'http://mock-hermes:8088/v1',
   'MOMO-486 primary requester', '$OWNER_ID'),
  ('$AGENT_TWO_ID', '$WS_ID', 'hermes-agent', 'http://mock-hermes:8088/v1',
   'MOMO-486 foreign requester', '$OWNER_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ONE_ID', 'member'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_TWO_ID', 'member');
COMMIT;
SQL

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[work-agent] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    printf '%s' "$RESPONSE_BODY" | jq \
      'del(.token,.accessToken,.refreshToken)' >&2 2>/dev/null || \
      echo "[work-agent] non-JSON response body redacted" >&2
    exit 1
  }
}

curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" >"$TMP_DIR/login.json"
OWNER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/login.json")"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-hosts" \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
    '{scope:"member",type:"app",displayName:"MOMO-486 host",publicKey:$key,
      capabilities:{"tool.codex":true}}')"
expect_status 201 "work host registration"
HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase')"

mint_agent_token() {
  local agent_id="$1" label="$2"
  api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$agent_id/credentials" \
    "$(jq -cn --arg label "$label" '{label:$label}')"
  expect_status 201 "agent bearer create"
  printf '%s' "$RESPONSE_BODY" | jq -e \
    '.credential.scopes | index("work:control") != null' >/dev/null
  printf '%s' "$RESPONSE_BODY" | jq -er '.token'
}
AGENT_ONE_TOKEN="$(mint_agent_token "$AGENT_ONE_ID" 'MOMO-486 primary')"
AGENT_TWO_TOKEN="$(mint_agent_token "$AGENT_TWO_ID" 'MOMO-486 foreign')"

start_worker() {
  ACTIVE_AGENT_TOKEN="$1"
  compose up -d --force-recreate worker
}
stop_worker() {
  compose stop worker >/dev/null
  ACTIVE_AGENT_TOKEN=""
}
send_message() {
  local body="$1" root_id="${2:-}" client_id payload
  client_id="$(new_uuid)"
  if [ -n "$root_id" ]; then
    payload="$(jq -cn --arg client "$client_id" --arg body "$body" --arg root "$root_id" \
      '{clientMsgId:$client,type:"text",body:$body,rootId:$root}')"
  else
    payload="$(jq -cn --arg client "$client_id" --arg body "$body" \
      '{clientMsgId:$client,type:"text",body:$body}')"
  fi
  api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" "$payload"
  expect_status 201 "send agent mention"
  printf '%s' "$RESPONSE_BODY" | jq -er '.id | ascii_downcase'
}

echo "[work-agent] mention -> work_spawn -> pending approval"
SPAWN_TRIGGER_ID="$(send_message "@waa-$RUN_TAG MOMO-486 SPAWN")"
SPAWN_RUN_ID="$(printf "SELECT id FROM agent_run WHERE trigger_message_id='%s';\n" \
  "$SPAWN_TRIGGER_ID" | sql_value)"
[ -n "$SPAWN_RUN_ID" ] || {
  echo "[work-agent] FAIL mention did not create agent_run" >&2
  exit 1
}
start_worker "$AGENT_ONE_TOKEN"
wait_sql "1" "spawn control pending and truthful run completion" <<SQL
SELECT count(*)
  FROM work_control wc
  JOIN audit_log a ON a.target_id=wc.id AND a.action='work.control.requested'
 WHERE wc.requester_member_id='$AGENT_ONE_ID'
   AND wc.kind='spawn' AND wc.status='pending_approval'
   AND a.run_id='$SPAWN_RUN_ID'
   AND EXISTS (
     SELECT 1 FROM agent_run r
      WHERE r.id='$SPAWN_RUN_ID' AND r.status='succeeded'
   )
   AND EXISTS (
     SELECT 1 FROM message m
      WHERE m.run_id='$SPAWN_RUN_ID' AND m.author_member_id='$AGENT_ONE_ID'
        AND m.root_id IS NULL AND m.body LIKE '%승인 대기%'
   );
SQL
SPAWN_CONTROL_ID="$(printf "SELECT target_id FROM audit_log WHERE action='work.control.requested' AND run_id='%s';\n" \
  "$SPAWN_RUN_ID" | sql_value)"
APPROVAL_MESSAGE_ID="$(printf "SELECT approval_message_id FROM work_control WHERE id='%s';\n" \
  "$SPAWN_CONTROL_ID" | sql_value)"
APPROVAL_ID="$(printf "SELECT id FROM approval WHERE request_message_id='%s';\n" \
  "$APPROVAL_MESSAGE_ID" | sql_value)"
stop_worker

echo "[work-agent] human approval dispatches without reviving the completed run"
DECISION_ID="$(new_uuid)"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/approvals/$APPROVAL_ID/decision" \
  "$(jq -cn --arg approval "$APPROVAL_ID" --arg decision "$DECISION_ID" \
    '{approval_id:$approval,approve:true,reason:"MOMO-486 approved",client_decision_id:$decision}')"
expect_status 200 "spawn approval"
wait_sql "1:0" "approved control dispatch without resume job" <<SQL
SELECT
  (SELECT count(*) FROM work_control
    WHERE id='$SPAWN_CONTROL_ID' AND status='dispatched')
  || ':' ||
  (SELECT count(*) FROM outbox
    WHERE kind='agent_job' AND method='resume_approval'
      AND payload->>'run_id' ILIKE '$SPAWN_RUN_ID');
SQL

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$HOST_ID" \
    '{channelId:$channel,hostId:$host,tool:"codex",label:"MOMO-486 spawned session"}')"
expect_status 201 "host creates spawned session"
SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
SESSION_ROOT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.rootMessageId | ascii_downcase')"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-controls/$SPAWN_CONTROL_ID/ack" \
  "$(jq -cn --arg session "$SESSION_ID" '{ok:true,sessionId:$session}')"
expect_status 200 "host acknowledges spawned session"

wait_sql "1:1:1" "session ledger, card, and lifecycle event" <<SQL
SELECT
  (SELECT count(*) FROM work_control
    WHERE id='$SPAWN_CONTROL_ID' AND status='acked' AND session_id='$SESSION_ID')
  || ':' ||
  (SELECT count(*) FROM message
    WHERE id='$SESSION_ROOT_ID' AND type='system'
      AND props->>'kind'='work_session'
      AND props->>'session_id' ILIKE '$SESSION_ID'
      AND props->>'status'='running')
  || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.started'
      AND payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID');
SQL

wait_for_event() {
  local event_type="$1" id_key="$2" id_value="$3" found=0 history matches
  deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    history="$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
      -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg ch "$CENT_CHANNEL" '{channel:$ch,limit:200,reverse:true}')" \
      "$CENT_API_URL/history" 2>/dev/null || printf '{}')"
    matches="$(printf '%s' "$history" | jq -r \
      --arg event "$event_type" --arg key "$id_key" --arg value "$id_value" '
      [.result.publications[]?.data
       | select(.type == $event)
       | select((.payload[$key] | ascii_downcase) == ($value | ascii_downcase))]
      | length' 2>/dev/null || printf '0')"
    if [ "$matches" != "0" ]; then
      found=1
      break
    fi
    sleep 1
  done
  [ "$found" = "1" ] || {
    compose logs --tail 120 relay >&2 || true
    echo "[work-agent] FAIL $event_type was not delivered for $id_value" >&2
    exit 1
  }
}
wait_for_event "work.control.dispatched" "control_id" "$SPAWN_CONTROL_ID"
wait_for_event "work.control.acked" "control_id" "$SPAWN_CONTROL_ID"
wait_for_event "work.session.started" "session_id" "$SESSION_ID"

echo "[work-agent] session thread -> lineage work_input -> dispatched/acked"
INPUT_TRIGGER_ID="$(send_message \
  "@waa-$RUN_TAG MOMO-486 INPUT session=$SESSION_ID text=lineage-ok" \
  "$SESSION_ROOT_ID")"
INPUT_RUN_ID="$(printf "SELECT id FROM agent_run WHERE trigger_message_id='%s';\n" \
  "$INPUT_TRIGGER_ID" | sql_value)"
start_worker "$AGENT_ONE_TOKEN"
wait_sql "1" "lineage input dispatched without duplicate reply" <<SQL
SELECT count(*)
  FROM work_control wc
  JOIN audit_log a ON a.target_id=wc.id AND a.action='work.control.requested'
 WHERE wc.requester_member_id='$AGENT_ONE_ID'
   AND wc.session_id='$SESSION_ID' AND wc.kind='input'
   AND wc.status='dispatched' AND wc.payload->>'text'='lineage-ok'
   AND a.run_id='$INPUT_RUN_ID'
   AND NOT EXISTS (
     SELECT 1 FROM message m
      WHERE m.run_id='$INPUT_RUN_ID' AND m.author_member_id='$AGENT_ONE_ID'
   );
SQL
INPUT_CONTROL_ID="$(printf "SELECT target_id FROM audit_log WHERE action='work.control.requested' AND run_id='%s';\n" \
  "$INPUT_RUN_ID" | sql_value)"
stop_worker
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-controls/$INPUT_CONTROL_ID/ack" \
  "$(jq -cn --arg session "$SESSION_ID" '{ok:true,sessionId:$session}')"
expect_status 200 "host acknowledges lineage input"
wait_for_event "work.control.acked" "control_id" "$INPUT_CONTROL_ID"

echo "[work-agent] foreign requester lineage is rejected exactly as HTTP 403"
FOREIGN_CONTROL_COUNT_BEFORE="$(printf \
  "SELECT count(*) FROM work_control WHERE requester_member_id='%s' AND session_id='%s';\n" \
  "$AGENT_TWO_ID" "$SESSION_ID" | sql_value)"
FOREIGN_TRIGGER_ID="$(send_message \
  "@wab-$RUN_TAG MOMO-486 INPUT session=$SESSION_ID text=foreign-must-fail" \
  "$SESSION_ROOT_ID")"
FOREIGN_RUN_ID="$(printf "SELECT id FROM agent_run WHERE trigger_message_id='%s';\n" \
  "$FOREIGN_TRIGGER_ID" | sql_value)"
start_worker "$AGENT_TWO_TOKEN"
wait_sql "1" "foreign lineage 403 is a truthful session-thread reply" <<SQL
SELECT count(*) FROM message
 WHERE run_id='$FOREIGN_RUN_ID'
   AND author_member_id='$AGENT_TWO_ID'
   AND root_id='$SESSION_ROOT_ID'
   AND body LIKE '%HTTP 403%'
   AND body LIKE '%session is outside the approved requester lineage%';
SQL
stop_worker
FOREIGN_CONTROL_COUNT_AFTER="$(printf \
  "SELECT count(*) FROM work_control WHERE requester_member_id='%s' AND session_id='%s';\n" \
  "$AGENT_TWO_ID" "$SESSION_ID" | sql_value)"
[ "$FOREIGN_CONTROL_COUNT_AFTER" = "$FOREIGN_CONTROL_COUNT_BEFORE" ] || {
  echo "[work-agent] FAIL forbidden requester persisted a success control" >&2
  exit 1
}

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_TENANT_ID';
SELECT
  (SELECT count(*) FROM work_control WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM work_session WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM message WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM outbox WHERE workspace_id='$WS_ID');
COMMIT;
SQL
)"
[ "$got" = "0:0:0:0" ] || {
  echo "[work-agent] FAIL cross-tenant RLS isolation: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT count(*) FROM pg_class
 WHERE relname IN ('work_control','work_session')
   AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$got" = "2" ] || {
  echo "[work-agent] FAIL FORCE RLS metadata: $got" >&2
  exit 1
}

echo "MOMO-486 chat/spawn/approval/session-thread input + exact lineage 403 + RLS PASS"
