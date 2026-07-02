#!/usr/bin/env bash
# =============================================================================
# scripts/verify_macos_real_backend_ui.sh — MOMO-205 real-backend macOS smoke gate
#
# Verifies the SwiftPM MomoMacDevApp REST backend path against local Docker +
# host MomoServer. GUI launch is opt-in with LOCAL_GATE_LAUNCH_UI=1 so headless
# runners can still PASS the deterministic REST/evidence portion.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "[macos-real-backend] FAIL: $*" >&2
  if [ "${SERVER_LOG:-}" != "" ] && [ -f "$SERVER_LOG" ]; then
    echo "[macos-real-backend] server log: $SERVER_LOG" >&2
    tail -160 "$SERVER_LOG" >&2 || true
  fi
  if [ "${UI_LOG:-}" != "" ] && [ -f "$UI_LOG" ]; then
    echo "[macos-real-backend] UI log: $UI_LOG" >&2
    tail -160 "$UI_LOG" >&2 || true
  fi
  exit 1
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

ENV_FILE="${ENV_FILE:-}"
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE="$candidate"
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

require_bin curl
require_bin jq
require_bin swift
require_bin uuidgen

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  fail "psql not found; install PostgreSQL client/libpq and retry"
fi

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-momo}"
POSTGRES_USER="${POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-momo}"
PORT="${PORT:-8080}"
CENT_PORT="${CENT_PORT:-8000}"
CENT_API_KEY="${CENT_API_KEY:-dev-insecure-cent-api-key}"
CENT_API_URL="${CENT_API_URL:-http://localhost:${CENT_PORT}/api}"
JWT_HMAC="${JWT_HMAC:-dev-insecure-jwt-hmac-change-me}"
CENT_TOKEN_HMAC="${CENT_TOKEN_HMAC:-dev-insecure-cent-token-hmac}"

ADMIN_DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}}"
APP_DATABASE_URL="postgres://momo_app:momo_app_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
BASE_URL="http://127.0.0.1:${PORT}"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
HUMAN_EMAIL="demo@momo.local"
HUMAN_ID="00000000-0000-7000-8000-000000000101"
AGENT_ID="00000000-0000-7000-8000-000000000103"
AGENT_HANDLE="hermes"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
RUN_ID_FIXTURE="00000000-0000-7000-8000-000000205101"
APPROVAL_MSG_ID="00000000-0000-7000-8000-000000205201"
APPROVAL_ID="00000000-0000-7000-8000-000000205301"
USAGE_ID="00000000-0000-7000-8000-000000205401"
CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MENTION_CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
MESSAGE_BODY="MOMO-205 real-backend GUI smoke ${RUN_SUFFIX}"
MENTION_BODY="@${AGENT_HANDLE} MOMO-256 macOS Hermes mention smoke ${RUN_SUFFIX}"

OUT_DIR="${MACOS_REAL_BACKEND_OUT_DIR:-${TMPDIR:-/tmp}/momo-macos-real-backend}"
mkdir -p "$OUT_DIR"
SERVER_LOG="$OUT_DIR/momo-server-${RUN_SUFFIX}.log"
UI_LOG="$OUT_DIR/macos-dev-app-${RUN_SUFFIX}.log"
REST_LOGIN_FILE="$OUT_DIR/login-${RUN_SUFFIX}.json"
REST_CHANNELS_FILE="$OUT_DIR/channels-${RUN_SUFFIX}.json"
REST_INVITE_CREATE_FILE="$OUT_DIR/invite-create-${RUN_SUFFIX}.json"
REST_INVITE_LIST_FILE="$OUT_DIR/invite-list-${RUN_SUFFIX}.json"
REST_INVITE_REVOKE_FILE="$OUT_DIR/invite-revoke-${RUN_SUFFIX}.json"
REST_JOIN_INVITE_CREATE_FILE="$OUT_DIR/invite-create-join-${RUN_SUFFIX}.json"
REST_JOIN_FILE="$OUT_DIR/join-${RUN_SUFFIX}.json"
REST_JOIN_INVITE_LIST_FILE="$OUT_DIR/invite-list-after-join-${RUN_SUFFIX}.json"
REST_SECOND_CHANNELS_FILE="$OUT_DIR/second-user-channels-${RUN_SUFFIX}.json"
REST_SECOND_MEMBERS_FILE="$OUT_DIR/second-user-members-${RUN_SUFFIX}.json"
REST_CHANNEL_CREATE_FILE="$OUT_DIR/channel-create-${RUN_SUFFIX}.json"
REST_MEMBER_ADD_FILE="$OUT_DIR/member-add-${RUN_SUFFIX}.json"
REST_MEMBER_REMOVE_FILE="$OUT_DIR/member-remove-${RUN_SUFFIX}.json"
REST_SEND_FILE="$OUT_DIR/send-${RUN_SUFFIX}.json"
REST_MENTION_SEND_FILE="$OUT_DIR/mention-send-${RUN_SUFFIX}.json"
REST_HISTORY_FILE="$OUT_DIR/history-${RUN_SUFFIX}.json"
EVIDENCE_FILE="$OUT_DIR/evidence-${RUN_SUFFIX}.md"
SERVER_PID=""
UI_RESULT="skipped"

cleanup() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

psql_admin() {
  "$PSQL_BIN" "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

wait_http() {
  local url="$1"
  local name="$2"
  local deadline
  local wait_seconds="${MACOS_REAL_BACKEND_WAIT_SECONDS:-240}"
  if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]] || [ "$wait_seconds" -lt 1 ]; then
    fail "MACOS_REAL_BACKEND_WAIT_SECONDS must be a positive integer"
  fi
  deadline=$(($(date +%s) + wait_seconds))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[macos-real-backend] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not become ready: ${url}"
}

echo "[macos-real-backend] using env file: ${ENV_FILE:-<none>}"
echo "[macos-real-backend] api=${BASE_URL} postgres_port=${POSTGRES_PORT} launch_ui=${LOCAL_GATE_LAUNCH_UI:-0}"

echo "[macos-real-backend] starting Docker compose and applying migrations"
(cd "$REPO_ROOT" && make up)
(cd "$REPO_ROOT" && make migrate)

echo "[macos-real-backend] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null

echo "[macos-real-backend] seeding approval/cost UI fixture"
psql_admin <<SQL
BEGIN;
SET LOCAL row_security = off;

DELETE FROM usage_ledger WHERE id = '${USAGE_ID}' OR run_id = '${RUN_ID_FIXTURE}';
DELETE FROM approval_decision WHERE approval_id = '${APPROVAL_ID}';
DELETE FROM audit_log WHERE target_id = '${APPROVAL_ID}' OR run_id = '${RUN_ID_FIXTURE}';
DELETE FROM outbox
 WHERE payload @> jsonb_build_object('approval_id', '${APPROVAL_ID}')
    OR payload @> jsonb_build_object('run_id', '${RUN_ID_FIXTURE}');
DELETE FROM approval WHERE id = '${APPROVAL_ID}';
DELETE FROM message WHERE id = '${APPROVAL_MSG_ID}' OR run_id = '${RUN_ID_FIXTURE}';
DELETE FROM agent_run WHERE id = '${RUN_ID_FIXTURE}';

UPDATE channel_seq
   SET last_seq = GREATEST(
         last_seq,
         205900,
         COALESCE((SELECT max(seq) FROM message WHERE channel_id = '${CHANNEL_ID}'), 0)
       )
 WHERE channel_id = '${CHANNEL_ID}';

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, step_count, max_steps, depth, input, started_at)
VALUES
  ('${RUN_ID_FIXTURE}', '${WORKSPACE_ID}', '${AGENT_ID}', '${CHANNEL_ID}', 'awaiting_approval', 1, 12, 0,
   '{"prompt":"MOMO-205 macOS REST backend smoke approval/cost fixture"}'::jsonb, now());

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props, run_id)
VALUES
  ('${APPROVAL_MSG_ID}', '${WORKSPACE_ID}', '${CHANNEL_ID}', 205901, 1782864000000, 0, '${AGENT_ID}',
   'approval_request', 'MOMO-205 approval/cost fixture',
   jsonb_build_object(
     'approval_id', '${APPROVAL_ID}',
     'approval_status', 'pending',
     'action_type', 'github.create_issue',
     'tool_name', 'github.create_issue',
     'title', 'Create rollout checklist issue',
     'summary', 'Real-backend fixture for MomoMacDevApp approval and cost surfaces.',
     'estimated_micro_usd', 820000,
     'reserved_micro_usd', 820000,
     'spent_micro_usd', 340000,
     'is_reversible', true
   ),
   '${RUN_ID_FIXTURE}');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, request_message_id, requested_by,
   action_type, payload, status, expires_at)
VALUES
  ('${APPROVAL_ID}', '${WORKSPACE_ID}', '${RUN_ID_FIXTURE}', '${CHANNEL_ID}', '${APPROVAL_MSG_ID}', '${AGENT_ID}',
   'tool_call',
   jsonb_build_object(
     'run_id', '${RUN_ID_FIXTURE}',
     'action_type', 'github.create_issue',
     'tool_call', jsonb_build_object(
       'call_id', 'call_momo_205_smoke',
       'name', 'github.create_issue',
       'arguments', jsonb_build_object('title', 'Create rollout checklist issue')
     )
   ),
   'pending', now() + interval '1 hour');

INSERT INTO usage_ledger
  (id, workspace_id, run_id, agent_member_id, channel_id, model,
   prompt_tokens, completion_tokens, cost_micro_usd, was_estimated)
VALUES
  ('${USAGE_ID}', '${WORKSPACE_ID}', '${RUN_ID_FIXTURE}', '${AGENT_ID}', '${CHANNEL_ID}', 'hermes-agent',
   1200, 480, 340000, false);

UPDATE channel_seq
   SET last_seq = GREATEST(last_seq, 205901)
 WHERE channel_id = '${CHANNEL_ID}';

COMMIT;
SQL

if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  fail "${BASE_URL}/health is already serving; stop the existing MomoServer before running this verifier"
fi

echo "[macos-real-backend] starting MomoServer"
(
  cd "$REPO_ROOT"
  DATABASE_URL="$APP_DATABASE_URL" \
  HOST="127.0.0.1" \
  PORT="$PORT" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  JWT_HMAC="$JWT_HMAC" \
  CENT_TOKEN_HMAC="$CENT_TOKEN_HMAC" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  swift run --package-path server MomoServer
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_http "$BASE_URL/health" "MomoServer"

echo "[macos-real-backend] REST login"
curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${HUMAN_EMAIL}\",\"password\":\"dev-password\",\"workspace\":\"${WORKSPACE_ID}\"}" \
  "$BASE_URL/v1/auth/login" >"$REST_LOGIN_FILE"
ACCESS_TOKEN="$(jq -r '.accessToken // empty' "$REST_LOGIN_FILE")"
[ "$ACCESS_TOKEN" != "" ] || fail "login did not return accessToken"
jq -e --arg member "$HUMAN_ID" '.member.id == $member and (.accessToken | length) > 20' "$REST_LOGIN_FILE" >/dev/null \
  || fail "login response missing expected seeded member"

echo "[macos-real-backend] REST channel list"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels" >"$REST_CHANNELS_FILE"
jq -e --arg channel "$CHANNEL_ID" '.channels[] | select(.id == $channel and .name == "agent-lab")' "$REST_CHANNELS_FILE" >/dev/null \
  || fail "channel list did not include agent-lab"

INVITE_EXPIRES_AT_MS="$(( ($(date +%s) + 7 * 24 * 60 * 60) * 1000 ))"
echo "[macos-real-backend] REST invite create/list/revoke"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"role\":\"member\",\"maxUses\":1,\"expiresAtMs\":${INVITE_EXPIRES_AT_MS},\"metadata\":{\"gate\":\"MOMO-226\",\"purpose\":\"revoke-smoke\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites" >"$REST_INVITE_CREATE_FILE"
INVITE_REVOKE_ID="$(jq -r '.invite.id // empty' "$REST_INVITE_CREATE_FILE")"
INVITE_REVOKE_CODE="$(jq -r '.code // empty' "$REST_INVITE_CREATE_FILE")"
[ "$INVITE_REVOKE_ID" != "" ] && [ "$INVITE_REVOKE_CODE" != "" ] \
  || fail "invite create response missing id/code: $(cat "$REST_INVITE_CREATE_FILE")"
jq -e '.invite.role == "member" and .invite.maxUses == 1 and .invite.usedCount == 0 and (.code | length) > 20' "$REST_INVITE_CREATE_FILE" >/dev/null \
  || fail "invite create response missing expected member invite"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites?include_revoked=true&limit=20" >"$REST_INVITE_LIST_FILE"
jq -e --arg invite "$INVITE_REVOKE_ID" '.invites[] | select(.id == $invite and .revokedAtMs == null)' "$REST_INVITE_LIST_FILE" >/dev/null \
  || fail "invite list did not include fresh active invite"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"MOMO-226 revoke smoke"}' \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites/${INVITE_REVOKE_ID}/revoke" >"$REST_INVITE_REVOKE_FILE"
jq -e --arg invite "$INVITE_REVOKE_ID" '.id == $invite and .revokedAtMs != null and .revocationReason == "MOMO-226 revoke smoke"' "$REST_INVITE_REVOKE_FILE" >/dev/null \
  || fail "invite revoke response did not reflect revoked state"

SECOND_EMAIL="momo226-second-${RUN_SUFFIX}@momo.local"
SECOND_HANDLE="momo226-$$"
SECOND_PASSWORD="dev-password"
echo "[macos-real-backend] REST invite create + second user join"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"role\":\"member\",\"maxUses\":1,\"expiresAtMs\":${INVITE_EXPIRES_AT_MS},\"metadata\":{\"gate\":\"MOMO-226\",\"purpose\":\"join-smoke\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites" >"$REST_JOIN_INVITE_CREATE_FILE"
JOIN_INVITE_ID="$(jq -r '.invite.id // empty' "$REST_JOIN_INVITE_CREATE_FILE")"
JOIN_INVITE_CODE="$(jq -r '.code // empty' "$REST_JOIN_INVITE_CREATE_FILE")"
[ "$JOIN_INVITE_ID" != "" ] && [ "$JOIN_INVITE_CODE" != "" ] \
  || fail "join invite create response missing id/code"

curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"${JOIN_INVITE_CODE}\",\"email\":\"${SECOND_EMAIL}\",\"displayName\":\"MOMO 226 Second User\",\"handle\":\"${SECOND_HANDLE}\",\"password\":\"${SECOND_PASSWORD}\",\"timeZone\":\"UTC\"}" \
  "$BASE_URL/v1/join" >"$REST_JOIN_FILE"
SECOND_ACCESS_TOKEN="$(jq -r '.accessToken // empty' "$REST_JOIN_FILE")"
SECOND_MEMBER_ID="$(jq -r '.member.id // empty' "$REST_JOIN_FILE" | tr '[:upper:]' '[:lower:]')"
[ "$SECOND_ACCESS_TOKEN" != "" ] && [ "$SECOND_MEMBER_ID" != "" ] \
  || fail "second user join response missing token/member: $(cat "$REST_JOIN_FILE")"
jq -e --arg ws "$WORKSPACE_ID" '.workspaceId == $ws and .createdMember == true and (.memberships | length) >= 1' "$REST_JOIN_FILE" >/dev/null \
  || fail "second user join response missing workspace/memberships"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites?include_revoked=true&limit=20" >"$REST_JOIN_INVITE_LIST_FILE"
jq -e --arg invite "$JOIN_INVITE_ID" '.invites[] | select(.id == $invite and .usedCount == 1)' "$REST_JOIN_INVITE_LIST_FILE" >/dev/null \
  || fail "invite list after join did not show usedCount=1"

curl -fsS \
  -H "Authorization: Bearer ${SECOND_ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels" >"$REST_SECOND_CHANNELS_FILE"
jq -e --arg channel "$CHANNEL_ID" '.channels[] | select(.id == $channel and .name == "agent-lab")' "$REST_SECOND_CHANNELS_FILE" >/dev/null \
  || fail "second user channel load did not include agent-lab"

curl -fsS \
  -H "Authorization: Bearer ${SECOND_ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/members" >"$REST_SECOND_MEMBERS_FILE"
jq -e --arg member "$SECOND_MEMBER_ID" '.members[] | select((.id | ascii_downcase) == $member and .kind == "human")' "$REST_SECOND_MEMBERS_FILE" >/dev/null \
  || fail "second user member roster did not include joined member"

CHANNEL_MANAGEMENT_NAME="momo218-$(date +%s)-$$"
echo "[macos-real-backend] REST channel create/member add/remove"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"kind\":\"private\",\"name\":\"${CHANNEL_MANAGEMENT_NAME}\",\"topic\":\"MOMO-218 macOS channel management smoke\"}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels" >"$REST_CHANNEL_CREATE_FILE"
CHANNEL_MANAGEMENT_ID="$(jq -r '.channel.id // empty' "$REST_CHANNEL_CREATE_FILE")"
[ "$CHANNEL_MANAGEMENT_ID" != "" ] || fail "channel create response missing channel id"
jq -e --arg name "$CHANNEL_MANAGEMENT_NAME" '
  .channel.kind == "private"
  and .channel.name == $name
  and .creatorMembership.memberId == "'"${HUMAN_ID}"'"
  and .creatorMembership.role == "owner"
  and .creatorMembership.leftAtMs == null
' "$REST_CHANNEL_CREATE_FILE" >/dev/null \
  || fail "channel create response missing private channel/owner membership"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"memberId\":\"${AGENT_ID}\",\"role\":\"member\"}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_MANAGEMENT_ID}/members" >"$REST_MEMBER_ADD_FILE"
jq -e --arg agent "$AGENT_ID" --arg channel "$CHANNEL_MANAGEMENT_ID" '
  .membership.memberId == $agent
  and .membership.channelId == $channel
  and .membership.role == "member"
  and .membership.leftAtMs == null
' "$REST_MEMBER_ADD_FILE" >/dev/null \
  || fail "agent add response missing active membership"

curl -fsS \
  -X DELETE \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_MANAGEMENT_ID}/members/${AGENT_ID}" >"$REST_MEMBER_REMOVE_FILE"
jq -e --arg agent "$AGENT_ID" --arg channel "$CHANNEL_MANAGEMENT_ID" '
  .membership.memberId == $agent
  and .membership.channelId == $channel
  and .membership.leftAtMs != null
' "$REST_MEMBER_REMOVE_FILE" >/dev/null \
  || fail "agent remove response missing leftAtMs"

echo "[macos-real-backend] REST send"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"clientMsgId\":\"${CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":\"${MESSAGE_BODY}\",\"props\":{\"gate\":\"MOMO-205\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" >"$REST_SEND_FILE"
MESSAGE_ID="$(jq -r '.id // empty' "$REST_SEND_FILE")"
MESSAGE_SEQ="$(jq -r '.seq // empty' "$REST_SEND_FILE")"
[ "$MESSAGE_ID" != "" ] && [ "$MESSAGE_SEQ" != "" ] && [ "$MESSAGE_SEQ" != "null" ] \
  || fail "send response missing id/seq: $(cat "$REST_SEND_FILE")"

echo "[macos-real-backend] REST agent mention send"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"clientMsgId\":\"${MENTION_CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":\"${MENTION_BODY}\",\"props\":{\"gate\":\"MOMO-256\",\"agent_handle\":\"${AGENT_HANDLE}\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" >"$REST_MENTION_SEND_FILE"
MENTION_MESSAGE_ID="$(jq -r '.id // empty' "$REST_MENTION_SEND_FILE")"
MENTION_MESSAGE_SEQ="$(jq -r '.seq // empty' "$REST_MENTION_SEND_FILE")"
[ "$MENTION_MESSAGE_ID" != "" ] && [ "$MENTION_MESSAGE_SEQ" != "" ] && [ "$MENTION_MESSAGE_SEQ" != "null" ] \
  || fail "mention send response missing id/seq: $(cat "$REST_MENTION_SEND_FILE")"

MENTION_JOB_COUNT="$(psql_admin -Atc "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='agent_job' AND payload->>'trigger_message_id'='${MENTION_MESSAGE_ID}' AND payload->>'agent_member_id'='${AGENT_ID}';")"
[ "$MENTION_JOB_COUNT" = "1" ] || fail "mention send did not create exactly one agent_job for @${AGENT_HANDLE}; count=${MENTION_JOB_COUNT}"

echo "[macos-real-backend] REST history"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages?limit=20" >"$REST_HISTORY_FILE"
jq -e --arg id "$MESSAGE_ID" --arg body "$MESSAGE_BODY" '.messages[] | select(.id == $id and .body == $body and .type == "text")' "$REST_HISTORY_FILE" >/dev/null \
  || fail "history did not include sent text message"
jq -e --arg id "$MENTION_MESSAGE_ID" --arg body "$MENTION_BODY" '.messages[] | select(.id == $id and .body == $body and .type == "text")' "$REST_HISTORY_FILE" >/dev/null \
  || fail "history did not include sent agent mention message"
jq -e --arg id "$APPROVAL_MSG_ID" --arg approval "$APPROVAL_ID" '
  .messages[]
  | select(.id == $id and .type == "approval_request")
  | select(.props.approval_id == $approval)
  | select(.props.approval_status == "pending")
  | select(.props.estimated_micro_usd == 820000)
  | select(.runId == "'"${RUN_ID_FIXTURE}"'")
' "$REST_HISTORY_FILE" >/dev/null \
  || fail "history did not include approval/cost structured props"

if [ "${LOCAL_GATE_LAUNCH_UI:-0}" = "1" ]; then
  echo "[macos-real-backend] launching MomoMacDevApp against ${BASE_URL}"
  set +e
  MOMO_SERVER_BASE_URL="$BASE_URL" \
  MOMO_WORKSPACE_ID="$WORKSPACE_ID" \
  MOMO_CHANNEL_ID="$CHANNEL_ID" \
  MOMO_LOGIN_EMAIL="$HUMAN_EMAIL" \
  MOMO_LOGIN_PASSWORD="dev-password" \
  MACOS_DEV_RUN_DIRECT_EXEC=1 \
    "$REPO_ROOT/scripts/macos_dev_run.sh" --verify --logs --terminate 2>&1 | tee "$UI_LOG"
  UI_CODE=${PIPESTATUS[0]}
  set -e
  [ "$UI_CODE" -eq 0 ] || fail "MomoMacDevApp launch verifier failed with exit ${UI_CODE}"
  grep -q "process is running" "$UI_LOG" || fail "UI launch log missing process evidence"
  grep -q "window smoke passed" "$UI_LOG" || fail "UI launch log missing window_count evidence"
  UI_RESULT="pass"
else
  echo "[macos-real-backend] UI launch skipped; set LOCAL_GATE_LAUNCH_UI=1 to require process/window evidence"
fi

{
  echo "## MOMO-205 macOS Real-Backend Smoke Evidence"
  echo "- Result: PASS"
  echo "- Base URL: \`${BASE_URL}\`"
  echo "- Workspace: \`${WORKSPACE_ID}\`"
  echo "- Channel: \`agent-lab\` / \`${CHANNEL_ID}\`"
  echo "- REST login: member=\`${HUMAN_ID}\`, access_token_len=\`$(jq -r '.accessToken | length' "$REST_LOGIN_FILE")\`"
  echo "- REST channel list: count=\`$(jq -r '.channels | length' "$REST_CHANNELS_FILE")\`, includes \`agent-lab\`"
  echo "- REST invite admin: created invite \`${INVITE_REVOKE_ID}\`, listed active state, revoked with reason \`MOMO-226 revoke smoke\`"
  echo "- REST invite join: second_user=\`${SECOND_EMAIL}\`, member_id=\`${SECOND_MEMBER_ID}\`, invite=\`${JOIN_INVITE_ID}\`, used_count=\`1\`"
  echo "- REST second-user state load: channels include \`agent-lab\`, members include joined human"
  echo "- REST channel management: created private channel \`${CHANNEL_MANAGEMENT_NAME}\` / \`${CHANNEL_MANAGEMENT_ID}\`, agent add/remove membership PASS"
  echo "- REST send: message_id=\`${MESSAGE_ID}\`, seq=\`${MESSAGE_SEQ}\`, client_msg_id=\`${CLIENT_MSG_ID}\`"
  echo "- REST agent mention: body=\`${MENTION_BODY}\`, message_id=\`${MENTION_MESSAGE_ID}\`, seq=\`${MENTION_MESSAGE_SEQ}\`, agent_job_count=\`${MENTION_JOB_COUNT}\`"
  echo "- REST history: includes sent text, agent mention source message, plus approval_request \`${APPROVAL_MSG_ID}\` with approval_id \`${APPROVAL_ID}\`"
  echo "- Approval surface data: status=\`pending\`, action=\`github.create_issue\`, estimated_micro_usd=\`820000\`"
  echo "- Cost surface data: reserved_micro_usd=\`820000\`, spent_micro_usd=\`340000\`, usage_ledger_id=\`${USAGE_ID}\`"
  echo "- UI launch: \`${UI_RESULT}\`"
  if [ "$UI_RESULT" = "skipped" ]; then
    echo "- UI skip criterion: \`LOCAL_GATE_LAUNCH_UI\` was not \`1\`; REST/backend smoke is PASS and process/window evidence is intentionally not required."
  else
    echo "- UI process/window evidence: \`${UI_LOG}\`"
  fi
  echo "- Evidence files: login=\`${REST_LOGIN_FILE}\`, channels=\`${REST_CHANNELS_FILE}\`, invite_create=\`${REST_INVITE_CREATE_FILE}\`, invite_list=\`${REST_INVITE_LIST_FILE}\`, invite_revoke=\`${REST_INVITE_REVOKE_FILE}\`, join_invite_create=\`${REST_JOIN_INVITE_CREATE_FILE}\`, join=\`${REST_JOIN_FILE}\`, join_invite_list=\`${REST_JOIN_INVITE_LIST_FILE}\`, second_channels=\`${REST_SECOND_CHANNELS_FILE}\`, second_members=\`${REST_SECOND_MEMBERS_FILE}\`, channel_create=\`${REST_CHANNEL_CREATE_FILE}\`, member_add=\`${REST_MEMBER_ADD_FILE}\`, member_remove=\`${REST_MEMBER_REMOVE_FILE}\`, send=\`${REST_SEND_FILE}\`, mention_send=\`${REST_MENTION_SEND_FILE}\`, history=\`${REST_HISTORY_FILE}\`, server_log=\`${SERVER_LOG}\`"
} >"$EVIDENCE_FILE"

cat "$EVIDENCE_FILE"
echo "[macos-real-backend] evidence: $EVIDENCE_FILE"
echo "[macos-real-backend] PASS macOS real-backend smoke gate"
