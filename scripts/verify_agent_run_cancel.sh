#!/usr/bin/env bash
# MOMO-557 / ADR-0132 D1-D2 isolated human cancel + agent pause runtime gate.
# Docker execution belongs to momo-main; workers run syntax/build/unit gates.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[agent-cancel] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${AGENT_CANCEL_PROJECT:-momo557cancel-$RUN_TAG}"
API_PORT="${AGENT_CANCEL_API_PORT:-28184}"
CENT_PORT="${AGENT_CANCEL_CENTRIFUGO_PORT:-28185}"
PG_PORT="${AGENT_CANCEL_POSTGRES_PORT:-28186}"
HERMES_PORT="${AGENT_CANCEL_HERMES_PORT:-28187}"
BOOT_TIMEOUT="${AGENT_CANCEL_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-cancel.XXXXXX")"
OVERRIDE_FILE="$TMP_DIR/cancel.override.yml"

cat >"$OVERRIDE_FILE" <<'YAML'
services:
  api:
    environment:
      MEMORY_EXTRACTION_ENABLED: "0"
      MEMORY_EMBEDDING_ENABLED: "0"
  worker:
    environment:
      MEMORY_EXTRACTION_ENABLED: "0"
      MEMORY_EMBEDDING_ENABLED: "0"
      WORKER_POLL_INTERVAL_MS: "25"
  mock-hermes:
    environment:
      MOCK_HERMES_EVENT_DELAY_SECONDS: "0.5"
YAML

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    AGENT_PROVIDER_MODE=local-mock AGENT_GATEWAY_MODE=worker \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
}

python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[agent-cancel] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[agent-cancel] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${AGENT_CANCEL_KEEP:-0}" = "1" ]; then
    echo "[agent-cancel] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-agent-cancel.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[agent-cancel] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }
fail() { echo "[agent-cancel] FAIL $*" >&2; exit 1; }
pass() { echo "[agent-cancel] PASS $*"; }

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
ADMIN_PASSWORD="cancel-admin-$(uuid)"
NONMEMBER_ID="00000000-0000-7000-8000-000000005571"
NONMEMBER_EMAIL="cancel-nonmember-$RUN_TAG@momo.local"
NONMEMBER_PASSWORD="cancel-nonmember-$(uuid)"
RUN_ID="00000000-0000-7000-8000-000000005572"
HOST_ID="00000000-0000-7000-8000-000000005573"
SESSION_ID="00000000-0000-7000-8000-000000005574"
ROOT_MESSAGE_ID="00000000-0000-7000-8000-000000005575"
CONTROL_ID="00000000-0000-7000-8000-000000005576"
APPROVAL_ID="00000000-0000-7000-8000-000000005577"

echo "[agent-cancel] booting isolated API stack $PROJECT"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api migrate db-roles >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done

ADMIN_ID="$(sql_value <<SQL
SELECT lower(member_id::text) FROM human WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
AGENT_ROW="$(run_sql -tA <<SQL | head -n 1
SELECT lower(m.id::text) || '|' || m.handle
  FROM member m JOIN agent a ON a.workspace_id=m.workspace_id AND a.member_id=m.id
  JOIN membership ms ON ms.workspace_id=m.workspace_id AND ms.member_id=m.id
 WHERE m.workspace_id='$WS_ID' AND ms.channel_id='$CHANNEL_ID' AND ms.left_at IS NULL
 ORDER BY m.id LIMIT 1;
SQL
)"
AGENT_ID="${AGENT_ROW%%|*}"
AGENT_HANDLE="${AGENT_ROW#*|}"
[ -n "$ADMIN_ID" ] && [ -n "$AGENT_ID" ] || fail "seed admin/agent missing"

run_sql <<SQL
UPDATE human SET password_hash=momo_password_hash('$ADMIN_PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
INSERT INTO member (id,workspace_id,kind,status,display_name,handle)
VALUES ('$NONMEMBER_ID','$WS_ID','human','active','Cancel Nonmember','cancel-nonmember-$RUN_TAG');
INSERT INTO human (member_id,workspace_id,email,email_verified,password_hash,tz)
VALUES ('$NONMEMBER_ID','$WS_ID','$NONMEMBER_EMAIL',true,momo_password_hash('$NONMEMBER_PASSWORD'),'UTC');
INSERT INTO workspace_membership (workspace_id,member_id,role)
VALUES ('$WS_ID','$NONMEMBER_ID','member');
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
ADMIN_TOKEN="$(login demo@momo.local "$ADMIN_PASSWORD")"
NONMEMBER_TOKEN="$(login "$NONMEMBER_EMAIL" "$NONMEMBER_PASSWORD")"

PAUSE_URL="$BASE_URL/v1/workspaces/$WS_ID/agents/$AGENT_ID/pause"
curl -fsS -X PUT "$PAUSE_URL" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data '{"paused":true}' \
  | jq -e '.profile.paused == true' >/dev/null
PAUSED_TRIGGER="MOMO557-PAUSED-$RUN_TAG"
PAUSED_MESSAGE="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg c "$(uuid)" --arg b "@$AGENT_HANDLE $PAUSED_TRIGGER" \
    '{clientMsgId:$c,type:"text",body:$b}')")"
PAUSED_MESSAGE_ID="$(printf '%s' "$PAUSED_MESSAGE" | jq -er '.id|ascii_downcase')"
PAUSED_ASSERT="$(sql_value <<SQL
SELECT (SELECT count(*) FROM agent_run WHERE trigger_message_id='$PAUSED_MESSAGE_ID')::text || '|' ||
       (SELECT count(*) FROM message WHERE channel_id='$CHANNEL_ID' AND type='system'
         AND props->>'kind'='agent_paused' AND props->>'agent_member_id' ILIKE '$AGENT_ID')::text || '|' ||
       (SELECT count(*) FROM audit_log WHERE action='agent.mention.paused'
         AND subject_member_id='$AGENT_ID')::text;
SQL
)"
[ "$PAUSED_ASSERT" = "0|1|1" ] || fail "pause final consumer mismatch: $PAUSED_ASSERT"
pass "pause endpoint blocks enqueue and writes the durable system line/audit"

curl -fsS -X PUT "$PAUSE_URL" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data '{"paused":false}' \
  | jq -e '.profile.paused == false' >/dev/null

run_sql <<SQL
WITH bumped AS (
  UPDATE channel_seq SET last_seq=last_seq+1
   WHERE workspace_id='$WS_ID' AND channel_id='$CHANNEL_ID' RETURNING last_seq
)
INSERT INTO message
  (id,workspace_id,channel_id,seq,hlc_ts,hlc_count,author_member_id,type,props,client_msg_id)
SELECT '$ROOT_MESSAGE_ID','$WS_ID','$CHANNEL_ID',last_seq,0,0,'$ADMIN_ID','system',
       jsonb_build_object('kind','work_session','session_id','$SESSION_ID'), '$ROOT_MESSAGE_ID'
  FROM bumped;
INSERT INTO work_host
  (id,workspace_id,scope,owner_member_id,type,display_name,public_key,capabilities,last_seen_at)
VALUES ('$HOST_ID','$WS_ID','member','$ADMIN_ID','workd','MOMO-557 host',
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{"codex":true}', now());
INSERT INTO work_session
  (id,workspace_id,channel_id,member_id,host_id,root_message_id,tool,label,status)
VALUES ('$SESSION_ID','$WS_ID','$CHANNEL_ID','$ADMIN_ID','$HOST_ID','$ROOT_MESSAGE_ID',
        'codex','MOMO-557 linked session','running');
INSERT INTO agent_run
  (id,workspace_id,agent_member_id,channel_id,status,input,idempotency_key)
VALUES ('$RUN_ID','$WS_ID','$AGENT_ID','$CHANNEL_ID','queued','{"type":"mention"}',
        'momo557-cancel-$RUN_TAG');
INSERT INTO work_control
  (id,workspace_id,channel_id,requester_member_id,target_host_id,session_id,kind,payload,status)
VALUES ('$CONTROL_ID','$WS_ID','$CHANNEL_ID','$AGENT_ID','$HOST_ID','$SESSION_ID',
        'input','{"text":"continue"}','acked');
INSERT INTO audit_log
  (workspace_id,actor_member_id,action,target_type,target_id,run_id,detail)
VALUES ('$WS_ID','$AGENT_ID','work.control.requested','work_control','$CONTROL_ID','$RUN_ID','{}');
INSERT INTO approval
  (id,workspace_id,run_id,channel_id,requested_by,action_type,payload,status)
VALUES ('$APPROVAL_ID','$WS_ID','$RUN_ID','$CHANNEL_ID','$AGENT_ID','tool_call','{}','pending');
INSERT INTO outbox (workspace_id,kind,status,method,payload,partition_key)
VALUES ('$WS_ID','agent_job','pending','publish',
        jsonb_build_object('run_id','$RUN_ID','workspace_id','$WS_ID','channel_id','$CHANNEL_ID',
          'agent_member_id','$AGENT_ID','author_member_id','$ADMIN_ID','model','mock','prompt','cancel'),
        '$AGENT_ID');
SQL

CANCEL_URL="$BASE_URL/v1/workspaces/$WS_ID/agent-runs/$RUN_ID/cancel"
status="$(curl -sS -o "$TMP_DIR/nonmember.json" -w '%{http_code}' -X POST "$CANCEL_URL" \
  -H "Authorization: Bearer $NONMEMBER_TOKEN")"
[ "$status" = "403" ] || fail "non-channel human expected 403, got $status"
CANCEL_JSON="$(curl -fsS -X POST "$CANCEL_URL" -H "Authorization: Bearer $ADMIN_TOKEN")"
printf '%s' "$CANCEL_JSON" | jq -e --arg run "$RUN_ID" --arg session "$SESSION_ID" '
  (.runId|ascii_downcase)==$run and .status=="cancelled"
  and (.linkedWorkSessionIds|map(ascii_downcase))==[$session]
  and .workSessionsTerminated==false
' >/dev/null || fail "cancel response did not expose the linked session boundary"

LEDGER_ASSERT="$(sql_value <<SQL
SELECT (SELECT status::text FROM agent_run WHERE id='$RUN_ID') || '|' ||
       (SELECT status FROM approval WHERE id='$APPROVAL_ID') || '|' ||
       (SELECT status FROM work_session WHERE id='$SESSION_ID') || '|' ||
       (SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'run_id'='$RUN_ID' AND status='done')::text || '|' ||
       (SELECT count(*) FROM audit_log WHERE action='agent.run.cancelled' AND run_id='$RUN_ID'
          AND detail->'linked_work_session_ids' @> to_jsonb('$SESSION_ID'::text)
          AND detail->>'work_sessions_terminated'='false')::text || '|' ||
       (SELECT count(*) FROM message WHERE run_id='$RUN_ID' AND type='system'
          AND props->>'kind'='agent_run_cancelled')::text;
SQL
)"
[ "$LEDGER_ASSERT" = "cancelled|cancelled|running|1|1|1" ] \
  || fail "cancel ledger/outbox/session/system-line mismatch: $LEDGER_ASSERT"
curl -fsS -X POST "$CANCEL_URL" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -e '.status=="cancelled"' >/dev/null
IDEMPOTENT_COUNT="$(sql_value <<SQL
SELECT count(*) FROM audit_log WHERE action='agent.run.cancelled' AND run_id='$RUN_ID';
SQL
)"
[ "$IDEMPOTENT_COUNT" = "1" ] || fail "repeated cancel duplicated the ledger"
pass "cancel atomically retires pending work and preserves linked work_session"

compose up -d worker
# The worker service compiles from source on first boot; wait for the runtime
# start marker before opening the short claim window below.
worker_deadline=$(( $(date -u +%s) + ${AGENT_CANCEL_WORKER_BOOT_TIMEOUT:-1800} ))
until compose logs worker 2>/dev/null | grep -q "agent worker starting"; do
  if [ "$(date -u +%s)" -ge "$worker_deadline" ]; then
    compose logs --tail 60 worker >&2 || true
    fail "worker runtime did not start before the claim scenario"
  fi
  sleep 5
done
LIVE_TRIGGER="MOMO557-LIVE-$RUN_TAG"
LIVE_MESSAGE="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg c "$(uuid)" --arg b "@$AGENT_HANDLE $LIVE_TRIGGER" \
    '{clientMsgId:$c,type:"text",body:$b}')")"
LIVE_MESSAGE_ID="$(printf '%s' "$LIVE_MESSAGE" | jq -er '.id|ascii_downcase')"
deadline=$(( $(date -u +%s) + 120 ))
LIVE_RUN_ID=""
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  LIVE_RUN_ID="$(sql_value <<SQL
SELECT lower(ar.id::text)
  FROM agent_run ar
  JOIN outbox o ON lower(o.payload->>'run_id')=lower(ar.id::text)
 WHERE ar.trigger_message_id='$LIVE_MESSAGE_ID'
   AND o.kind='agent_job' AND o.status='processing'
 LIMIT 1;
SQL
)"
  [ -n "$LIVE_RUN_ID" ] && break
  sleep 0.02
done
if [ -z "$LIVE_RUN_ID" ]; then
  echo "[agent-cancel] diagnostics: run/outbox state for live trigger" >&2
  sql_value >&2 <<SQL || true
SELECT coalesce(json_agg(json_build_object(
         'run', lower(ar.id::text), 'run_status', ar.status::text,
         'outbox_status', o.status, 'outbox_error', o.last_error))::text, '[]')
  FROM agent_run ar
  LEFT JOIN outbox o ON o.kind='agent_job' AND lower(o.payload->>'run_id')=lower(ar.id::text)
 WHERE ar.trigger_message_id='$LIVE_MESSAGE_ID';
SQL
  compose logs --tail 120 worker >&2 || true
  fail "worker did not reach live processing boundary"
fi
curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/agent-runs/$LIVE_RUN_ID/cancel" \
  -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null
sleep 2
LIVE_ASSERT="$(sql_value <<SQL
SELECT (SELECT status::text FROM agent_run WHERE id='$LIVE_RUN_ID') || '|' ||
       (SELECT status FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')='$LIVE_RUN_ID' LIMIT 1) || '|' ||
       (SELECT count(*) FROM message WHERE run_id='$LIVE_RUN_ID' AND type='text'
          AND author_member_id='$AGENT_ID')::text;
SQL
)"
[ "$LIVE_ASSERT" = "cancelled|done|0" ] \
  || fail "worker final consumer revived or published after cancel: $LIVE_ASSERT"
pass "running worker observes DB cancellation and suppresses durable agent output"

RLS_COUNT="$(compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres \
  psql -U momo_app -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='00000000-0000-7000-8000-000000000002';
SELECT count(*) FROM agent_profile WHERE agent_member_id='$AGENT_ID';
COMMIT;
SQL
)"
[ "$RLS_COUNT" = "0" ] || fail "cross-workspace RLS exposed pause state"
pass "agent_profile pause state remains FORCE RLS isolated"

echo "[agent-cancel] PASS pause/enqueue, cancel/ledger, linked-session boundary, and worker stop"
