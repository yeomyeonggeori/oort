#!/usr/bin/env bash
# MOMO-524 / ADR-0128 D4-D6 lifecycle completion verifier.
# Docker execution belongs to the orchestrator; workers run bash/static tests only.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[lifecycle-completion] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${LIFECYCLE_COMPLETION_PROJECT:-momo524lifecycle-$RUN_TAG}"
API_PORT="${LIFECYCLE_COMPLETION_API_PORT:-28060}"
CENT_PORT="${LIFECYCLE_COMPLETION_CENTRIFUGO_PORT:-28061}"
PG_PORT="${LIFECYCLE_COMPLETION_POSTGRES_PORT:-28062}"
HERMES_PORT="${LIFECYCLE_COMPLETION_HERMES_PORT:-28063}"
BOOT_TIMEOUT="${LIFECYCLE_COMPLETION_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-lifecycle-completion.XXXXXX")"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

if [ -n "$(compose ps -aq 2>/dev/null)" ]; then
  echo "[lifecycle-completion] compose project already exists: $PROJECT" >&2
  exit 1
fi
python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[lifecycle-completion] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[lifecycle-completion] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${LIFECYCLE_COMPLETION_KEEP:-0}" = "1" ]; then
    echo "[lifecycle-completion] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-lifecycle-completion.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[lifecycle-completion] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[lifecycle-completion] booting isolated stack $PROJECT"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api migrate db-roles >&2 || true
    echo "[lifecycle-completion] api health timeout" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

WS_ID="00000000-0000-7000-8000-000000000001"
PUBLIC_CH="00000000-0000-7000-8000-000000000201"
OWNER_ID="00000000-0000-7000-8000-000000000101"
LEAVER_ID="$(uuid)"
VIEWER_ID="$(uuid)"
PRIVATE_CH="$(uuid)"
DM_CH="$(uuid)"
LEAVER_EMAIL="m524-leaver-$RUN_TAG@momo.local"
VIEWER_EMAIL="m524-viewer-$RUN_TAG@momo.local"
PASSWORD="lifecycle-$(uuid)"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle) VALUES
 ('$LEAVER_ID','$WS_ID','human','active','Lifecycle Leaver','m524-leaver-$RUN_TAG'),
 ('$VIEWER_ID','$WS_ID','human','active','Audit Viewer','m524-viewer-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz) VALUES
 ('$LEAVER_ID','$WS_ID','$LEAVER_EMAIL',true,momo_password_hash('$PASSWORD'),'UTC'),
 ('$VIEWER_ID','$WS_ID','$VIEWER_EMAIL',true,momo_password_hash('$PASSWORD'),'UTC');
INSERT INTO workspace_membership (workspace_id,member_id,role) VALUES
 ('$WS_ID','$LEAVER_ID','member'),('$WS_ID','$VIEWER_ID','member');
INSERT INTO membership (workspace_id,channel_id,member_id,role) VALUES
 ('$WS_ID','$PUBLIC_CH','$LEAVER_ID','member'),
 ('$WS_ID','$PUBLIC_CH','$VIEWER_ID','member');
INSERT INTO channel (id,workspace_id,kind,name,created_by)
VALUES ('$PRIVATE_CH','$WS_ID','private','m524-private-$RUN_TAG','$OWNER_ID');
INSERT INTO channel_seq (channel_id,workspace_id,last_seq) VALUES ('$PRIVATE_CH','$WS_ID',0);
INSERT INTO membership (workspace_id,channel_id,member_id,role)
VALUES ('$WS_ID','$PRIVATE_CH','$LEAVER_ID','member');
INSERT INTO channel (id,workspace_id,kind,name,dm_key,created_by)
VALUES ('$DM_CH','$WS_ID','dm',NULL,'m524-dm-$RUN_TAG','$OWNER_ID');
INSERT INTO channel_seq (channel_id,workspace_id,last_seq) VALUES ('$DM_CH','$WS_ID',0);
INSERT INTO membership (workspace_id,channel_id,member_id,role) VALUES
 ('$WS_ID','$DM_CH','$OWNER_ID','member'),('$WS_ID','$DM_CH','$LEAVER_ID','member');
UPDATE human SET password_hash=momo_password_hash('$PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
COMMIT;
SQL

login() {
  local email="$1" out="$TMP_DIR/login.json" status
  status="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$PASSWORD" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')")"
  [ "$status" = 200 ] || { cat "$out" >&2; exit 1; }
  jq -er '.accessToken' <"$out"
}

api() {
  local token="$1" method="$2" path="$3" body="${4:-}" out="$TMP_DIR/response.json"
  local -a args
  args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]+"${args[@]}"}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect() {
  local expected="$1" label="$2"
  [ "$RESPONSE_STATUS" = "$expected" ] || {
    echo "[lifecycle-completion] $label expected $expected, got $RESPONSE_STATUS: $RESPONSE_BODY" >&2
    exit 1
  }
}

OWNER_TOKEN="$(login demo@momo.local)"
LEAVER_TOKEN="$(login "$LEAVER_EMAIL")"
VIEWER_TOKEN="$(login "$VIEWER_EMAIL")"

# D4 channel leave: DMs reject; public leaves freely; a last private member
# archives the channel in the same transaction as left_at.
api "$LEAVER_TOKEN" DELETE "/v1/workspaces/$WS_ID/channels/$DM_CH/members/me"
expect 403 "DM self-leave"
api "$LEAVER_TOKEN" DELETE "/v1/workspaces/$WS_ID/channels/$PUBLIC_CH/members/me"
expect 200 "public channel self-leave"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.archived')" = false ] || exit 1
api "$LEAVER_TOKEN" DELETE "/v1/workspaces/$WS_ID/channels/$PRIVATE_CH/members/me"
expect 200 "private last-member self-leave"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.archived')" = true ] || exit 1
channel_leave_rows="$(sql_value <<SQL
SELECT (SELECT count(*) FROM membership WHERE member_id='$LEAVER_ID' AND channel_id='$PUBLIC_CH' AND left_at IS NOT NULL)
     + (SELECT count(*) FROM membership WHERE member_id='$LEAVER_ID' AND channel_id='$PRIVATE_CH' AND left_at IS NOT NULL)
     + (SELECT count(*) FROM channel WHERE id='$PRIVATE_CH' AND archived_at IS NOT NULL);
SQL
)"
[ "$channel_leave_rows" = 3 ] || { echo "[lifecycle-completion] channel leave rows=$channel_leave_rows" >&2; exit 1; }

# Preserve authored messages while the workspace identity and memberships leave.
api "$LEAVER_TOKEN" POST "/v1/workspaces/$WS_ID/channels/$DM_CH/messages" \
  "$(jq -cn --arg id "$(uuid)" '{clientMsgId:$id,type:"text",body:"m524 preserved history"}')"
expect 201 "pre-leave message"
MESSAGE_ID="$(lower "$(printf '%s' "$RESPONSE_BODY" | jq -er '.message.id')")"
api "$OWNER_TOKEN" DELETE "/v1/workspaces/$WS_ID/members/me"
expect 409 "last owner self-leave"
api "$LEAVER_TOKEN" DELETE "/v1/workspaces/$WS_ID/members/me"
expect 200 "workspace self-leave"
api "$LEAVER_TOKEN" GET "/v1/workspaces/$WS_ID/channels"
expect 401 "revoked login token after workspace leave"
leave_state="$(sql_value <<SQL
SELECT (SELECT count(*) FROM workspace_membership WHERE member_id='$LEAVER_ID')
     + (SELECT count(*) FROM membership WHERE member_id='$LEAVER_ID')
     + (SELECT count(*) FROM member WHERE id='$LEAVER_ID' AND status='deleted')
     + (SELECT count(*) FROM message WHERE id='$MESSAGE_ID' AND author_member_id='$LEAVER_ID');
SQL
)"
[ "$leave_state" = 2 ] || { echo "[lifecycle-completion] workspace leave/history state=$leave_state" >&2; exit 1; }

# D6 agent credentials die on suspend/remove. Reinstate does not resurrect the
# old bearer; explicit reissue is required before it can dispatch again.
create_agent() {
  local handle="$1"
  api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents" \
    "$(jq -cn --arg h "$handle" '{displayName:"Lifecycle Agent",handle:$h,model:"hermes-agent",baseUrl:"https://hermes.example.net/v1"}')"
  expect 201 "agent creation $handle"
  AGENT_ID="$(lower "$(printf '%s' "$RESPONSE_BODY" | jq -er '.agent.id')")"
}
issue_credential() {
  api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" '{"label":"m524 verifier"}'
  expect 201 "agent credential issue"
  AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"
}
gateway_probe() {
  api "$1" GET "/v1/workspaces/$WS_ID/agents/$2/gateway/jobs/pending"
}

create_agent "m524-suspend-$RUN_TAG"
SUSPEND_AGENT_ID="$AGENT_ID"
issue_credential
SUSPEND_TOKEN="$AGENT_TOKEN"
gateway_probe "$SUSPEND_TOKEN" "$SUSPEND_AGENT_ID"
expect 200 "pre-suspend gateway authentication"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/members/$SUSPEND_AGENT_ID/suspend"
expect 200 "agent suspend"
[ "$(sql_value <<SQL
SELECT count(*) FROM token
 WHERE workspace_id='$WS_ID' AND actor_member_id='$SUSPEND_AGENT_ID'
   AND kind='agent_bearer' AND revoked_at IS NOT NULL;
SQL
)" = 1 ] || { echo "[lifecycle-completion] suspend did not revoke agent credential" >&2; exit 1; }
gateway_probe "$SUSPEND_TOKEN" "$SUSPEND_AGENT_ID"
expect 401 "suspended agent gateway authentication"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/members/$SUSPEND_AGENT_ID/reinstate"
expect 200 "agent reinstate"
gateway_probe "$SUSPEND_TOKEN" "$SUSPEND_AGENT_ID"
expect 401 "reinstate keeps credential revoked"

create_agent "m524-remove-$RUN_TAG"
REMOVE_AGENT_ID="$AGENT_ID"
issue_credential
REMOVE_TOKEN="$AGENT_TOKEN"
api "$OWNER_TOKEN" DELETE "/v1/workspaces/$WS_ID/members/$REMOVE_AGENT_ID"
expect 200 "agent remove"
[ "$(sql_value <<SQL
SELECT count(*) FROM token
 WHERE workspace_id='$WS_ID' AND actor_member_id='$REMOVE_AGENT_ID'
   AND kind='agent_bearer' AND revoked_at IS NOT NULL;
SQL
)" = 1 ] || { echo "[lifecycle-completion] remove did not revoke agent credential" >&2; exit 1; }
gateway_probe "$REMOVE_TOKEN" "$REMOVE_AGENT_ID"
expect 401 "removed agent gateway authentication"

# Handle bans block both identity creation and credential pairing.
BANNED_HANDLE="m524-banned-$RUN_TAG"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/bans" \
  "$(jq -cn --arg h "$BANNED_HANDLE" '{handle:$h,reason:"m524 verifier"}')"
expect 201 "agent handle ban"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents" \
  "$(jq -cn --arg h "$BANNED_HANDLE" '{displayName:"Banned Agent",handle:$h,model:"hermes-agent",baseUrl:"https://hermes.example.net/v1"}')"
expect 403 "banned agent creation"

create_agent "m524-pairing-$RUN_TAG"
PAIRING_AGENT_ID="$AGENT_ID"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/bans" \
  "$(jq -cn --arg h "m524-pairing-$RUN_TAG" '{handle:$h,reason:"pairing block"}')"
expect 201 "pairing handle ban"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$PAIRING_AGENT_ID/credentials" '{"label":"must fail"}'
expect 403 "banned agent pairing"

# D5 admin audit projection: permission, action-prefix, subject, time range,
# and UUID keyset cursor all work without crossing the RLS tenant boundary.
api "$VIEWER_TOKEN" GET "/v1/workspaces/$WS_ID/audit"
expect 403 "non-admin audit access"
NOW_MS="$(( $(date -u +%s) * 1000 + 60000 ))"
api "$OWNER_TOKEN" GET "/v1/workspaces/$WS_ID/audit?actions=member.&target_member_id=$SUSPEND_AGENT_ID&from_ms=0&to_ms=$NOW_MS&limit=1"
expect 200 "filtered audit page"
[ "$(printf '%s' "$RESPONSE_BODY" | jq '.events | length')" = 1 ] || exit 1
NEXT_CURSOR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.nextCursor')"
api "$OWNER_TOKEN" GET "/v1/workspaces/$WS_ID/audit?actions=member.&target_member_id=$SUSPEND_AGENT_ID&cursor=$NEXT_CURSOR&limit=1"
expect 200 "audit cursor page"
printf '%s' "$RESPONSE_BODY" | jq -e --arg id "$SUSPEND_AGENT_ID" \
  '.events | all((.subjectMemberId | ascii_downcase) == $id)' >/dev/null

RLS_WORKSPACE="$(uuid)"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO workspace (id,slug,name) VALUES ('$RLS_WORKSPACE','m524-rls-$RUN_TAG','M524 RLS');
INSERT INTO audit_log (workspace_id,action,detail) VALUES ('$RLS_WORKSPACE','m524.hidden','{}');
COMMIT;
SQL
rls_hidden="$(run_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id = '$WS_ID';
SELECT count(*) FROM audit_log WHERE workspace_id='$RLS_WORKSPACE';
ROLLBACK;
SQL
)"
[ "$rls_hidden" = 0 ] || { echo "[lifecycle-completion] audit RLS leaked rows=$rls_hidden" >&2; exit 1; }

echo "[lifecycle-completion] PASS self-leave, agent credential symmetry, bans, audit filters/cursor, and RLS"
