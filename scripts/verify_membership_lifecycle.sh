#!/usr/bin/env bash
# MOMO-523 / ADR-0128 D1-D3 isolated membership lifecycle verifier.
# Docker execution belongs to the orchestrator; workers run bash/static tests only.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[membership] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${MEMBERSHIP_GATE_PROJECT:-momo523membership-$RUN_TAG}"
API_PORT="${MEMBERSHIP_GATE_API_PORT:-28050}"
CENT_PORT="${MEMBERSHIP_GATE_CENTRIFUGO_PORT:-28051}"
PG_PORT="${MEMBERSHIP_GATE_POSTGRES_PORT:-28052}"
HERMES_PORT="${MEMBERSHIP_GATE_HERMES_PORT:-28053}"
BOOT_TIMEOUT="${MEMBERSHIP_GATE_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-membership.XXXXXX")"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

if [ -n "$(compose ps -aq 2>/dev/null)" ]; then
  echo "[membership] compose project already exists: $PROJECT" >&2
  exit 1
fi
python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket, sys
ports = [int(x) for x in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[membership] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[membership] reserved port preflight failed: {error}")
finally:
    for sock in sockets: sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${MEMBERSHIP_GATE_KEEP:-0}" = "1" ]; then
    echo "[membership] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-membership.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[membership] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[membership] booting isolated stack $PROJECT"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api migrate db-roles >&2 || true
    echo "[membership] api health timeout" >&2
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

WS_ID="00000000-0000-7000-8000-000000000001"
PUBLIC_CH="00000000-0000-7000-8000-000000000201"
OWNER_ID="00000000-0000-7000-8000-000000000101"
ADMIN_ID="$(uuid)"; MEMBER_ID="$(uuid)"; GUEST_ID="$(uuid)"; HIDDEN_ID="$(uuid)"
ADMIN_EMAIL="m523-admin-$RUN_TAG@momo.local"
MEMBER_EMAIL="m523-member-$RUN_TAG@momo.local"
GUEST_EMAIL="m523-guest-$RUN_TAG@momo.local"
HIDDEN_EMAIL="m523-hidden-$RUN_TAG@momo.local"
PASSWORD="membership-$(uuid)"

# Migration backfill: every active legacy channel member has a workspace row,
# all legacy owner/admin holders map to owner/admin, and each populated workspace
# retains at least one owner.
backfill_missing="$(sql_value <<SQL
SELECT count(*) FROM membership ms
JOIN member m ON m.id=ms.member_id AND m.workspace_id=ms.workspace_id
WHERE ms.left_at IS NULL AND m.status='active' AND m.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM workspace_membership wm
                   WHERE wm.workspace_id=ms.workspace_id AND wm.member_id=ms.member_id);
SQL
)"
[ "$backfill_missing" = "0" ] || { echo "[membership] backfill missing=$backfill_missing" >&2; exit 1; }
backfill_bad_admin="$(sql_value <<SQL
SELECT count(*) FROM membership ms
WHERE ms.left_at IS NULL AND ms.role IN ('owner','admin')
  AND NOT EXISTS (SELECT 1 FROM workspace_membership wm
                   WHERE wm.workspace_id=ms.workspace_id AND wm.member_id=ms.member_id
                     AND wm.role IN ('owner','admin'));
SQL
)"
[ "$backfill_bad_admin" = "0" ] || { echo "[membership] backfill role mismatch=$backfill_bad_admin" >&2; exit 1; }
backfill_ownerless="$(sql_value <<SQL
SELECT count(*) FROM (
  SELECT ms.workspace_id
    FROM membership ms
    JOIN member m ON m.id=ms.member_id AND m.workspace_id=ms.workspace_id
   WHERE ms.left_at IS NULL AND m.status='active' AND m.deleted_at IS NULL
   GROUP BY ms.workspace_id
) populated
WHERE NOT EXISTS (SELECT 1 FROM workspace_membership wm
                   WHERE wm.workspace_id=populated.workspace_id AND wm.role='owner');
SQL
)"
[ "$backfill_ownerless" = "0" ] || { echo "[membership] ownerless backfill=$backfill_ownerless" >&2; exit 1; }

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle) VALUES
 ('$ADMIN_ID','$WS_ID','human','active','Lifecycle Admin','m523-admin-$RUN_TAG'),
 ('$MEMBER_ID','$WS_ID','human','active','Lifecycle Member','m523-member-$RUN_TAG'),
 ('$GUEST_ID','$WS_ID','human','active','Lifecycle Guest','m523-guest-$RUN_TAG'),
 ('$HIDDEN_ID','$WS_ID','human','active','Lifecycle Hidden','m523-hidden-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz) VALUES
 ('$ADMIN_ID','$WS_ID','$ADMIN_EMAIL',true,momo_password_hash('$PASSWORD'),'UTC'),
 ('$MEMBER_ID','$WS_ID','$MEMBER_EMAIL',true,momo_password_hash('$PASSWORD'),'UTC'),
 ('$GUEST_ID','$WS_ID','$GUEST_EMAIL',true,momo_password_hash('$PASSWORD'),'UTC'),
 ('$HIDDEN_ID','$WS_ID','$HIDDEN_EMAIL',true,momo_password_hash('$PASSWORD'),'UTC');
INSERT INTO workspace_membership (workspace_id,member_id,role) VALUES
 ('$WS_ID','$ADMIN_ID','admin'),('$WS_ID','$MEMBER_ID','member'),
 ('$WS_ID','$GUEST_ID','guest'),('$WS_ID','$HIDDEN_ID','member');
INSERT INTO membership (workspace_id,channel_id,member_id,role) VALUES
 ('$WS_ID','$PUBLIC_CH','$ADMIN_ID','admin'),('$WS_ID','$PUBLIC_CH','$MEMBER_ID','member'),
 ('$WS_ID','$PUBLIC_CH','$GUEST_ID','guest');
COMMIT;
SQL

login_status() {
  local email="$1" out="$TMP_DIR/login.json"
  LOGIN_STATUS="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$PASSWORD" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')")"
  LOGIN_BODY="$(<"$out")"
}
login() { login_status "$1"; [ "$LOGIN_STATUS" = 200 ] || { echo "$LOGIN_BODY" >&2; exit 1; }; printf '%s' "$LOGIN_BODY" | jq -er '.accessToken'; }
OWNER_TOKEN="$(login demo@momo.local)"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL")"
MEMBER_TOKEN="$(login "$MEMBER_EMAIL")"
GUEST_TOKEN="$(login "$GUEST_EMAIL")"

api() {
  local token="$1" method="$2" path="$3" body="${4:-}" out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[membership] FAIL $2 expected $1 got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2; exit 1
  }
  echo "[membership] PASS $2 ($1)"
}

MEMBER_PATH="/v1/workspaces/$WS_ID/members/$MEMBER_ID"
api "$OWNER_TOKEN" PATCH "$MEMBER_PATH/role" '{"role":"admin"}'
expect 200 "owner promotes workspace member"
api "$ADMIN_TOKEN" PATCH "$MEMBER_PATH/role" '{"role":"member"}'
expect 403 "admin cannot manipulate equal admin"
api "$OWNER_TOKEN" PATCH "$MEMBER_PATH/role" '{"role":"member"}'
expect 200 "owner demotes workspace admin"
api "$OWNER_TOKEN" PATCH "/v1/workspaces/$WS_ID/members/$OWNER_ID/role" '{"role":"member"}'
expect 409 "last owner cannot be downgraded"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/members/$OWNER_ID/suspend"
expect 409 "last owner cannot be suspended"
api "$OWNER_TOKEN" DELETE "/v1/workspaces/$WS_ID/members/$OWNER_ID" '{}'
expect 409 "last owner cannot be removed"
api "$OWNER_TOKEN" PATCH "/v1/workspaces/$WS_ID/members/$ADMIN_ID/role" '{"role":"owner"}'
expect 200 "owner appoints another owner"

api "$OWNER_TOKEN" PATCH "/v1/workspaces/$WS_ID/channels/$PUBLIC_CH/members/$MEMBER_ID/role" '{"role":"admin"}'
expect 200 "channel role change"
api "$MEMBER_TOKEN" PATCH "/v1/workspaces/$WS_ID/channels/$PUBLIC_CH/members/$MEMBER_ID/role" '{"role":"member"}'
expect 403 "self channel role change denied"

api "$OWNER_TOKEN" POST "$MEMBER_PATH/suspend"
expect 200 "member suspension"
api "$MEMBER_TOKEN" GET "/v1/workspaces/$WS_ID/channels"
expect 401 "existing token revoked on suspension"
login_status "$MEMBER_EMAIL"
[ "$LOGIN_STATUS" = 403 ] && printf '%s' "$LOGIN_BODY" | jq -e '.error.message == "member is suspended"' >/dev/null \
  || { echo "[membership] suspended login did not return explicit 403" >&2; exit 1; }
api "$OWNER_TOKEN" POST "$MEMBER_PATH/reinstate"
expect 200 "member reinstatement"
MEMBER_TOKEN="$(login "$MEMBER_EMAIL")"

# Guest sees only members/channels/messages intersecting its channel membership.
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/channels" \
  "$(jq -cn --arg n "m523-private-$RUN_TAG" '{kind:"private",name:$n}')"
expect 201 "private channel creation"
PRIVATE_CH="$(printf '%s' "$RESPONSE_BODY" | jq -er '.channel.id | ascii_downcase')"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/channels/$PRIVATE_CH/members" \
  "$(jq -cn --arg m "$HIDDEN_ID" '{memberId:$m,role:"member"}')"
expect 200 "hidden member private membership"
api "$GUEST_TOKEN" GET "/v1/workspaces/$WS_ID/members"
expect 200 "guest roster"
printf '%s' "$RESPONSE_BODY" | jq -e --arg hidden "$HIDDEN_ID" \
  '[.members[].id | ascii_downcase] | index($hidden) == null' >/dev/null \
  || { echo "[membership] guest roster leaked hidden member" >&2; exit 1; }
api "$GUEST_TOKEN" GET "/v1/workspaces/$WS_ID/channels"
expect 200 "guest channel list"
printf '%s' "$RESPONSE_BODY" | jq -e --arg private "$PRIVATE_CH" \
  '[.channels[].id | ascii_downcase] | index($private) == null' >/dev/null \
  || { echo "[membership] guest channel list leaked private channel" >&2; exit 1; }

send_message() {
  local token="$1" channel="$2" body="$3"
  api "$token" POST "/v1/workspaces/$WS_ID/channels/$channel/messages" \
    "$(jq -cn --arg id "$(uuid)" --arg b "$body" '{clientMsgId:$id,type:"text",body:$b}')"
  expect 201 "message send"
}
send_message "$OWNER_TOKEN" "$PRIVATE_CH" "hiddenneedle-$RUN_TAG"
send_message "$MEMBER_TOKEN" "$PUBLIC_CH" "visibleneedle-$RUN_TAG"
api "$GUEST_TOKEN" GET "/v1/workspaces/$WS_ID/search/messages?q=needle-$RUN_TAG"
expect 200 "guest search"
printf '%s' "$RESPONSE_BODY" | jq -e --arg public "$PUBLIC_CH" \
  '.hits | length == 1 and (.[0].channelId | ascii_downcase) == $public' >/dev/null \
  || { echo "[membership] guest search projection mismatch" >&2; exit 1; }

# Removal preserves authored message rows while removing roster/memberships.
api "$OWNER_TOKEN" DELETE "$MEMBER_PATH" '{"ban":false}'
expect 200 "workspace member removal"
removed_state="$(sql_value <<SQL
SELECT ((SELECT count(*) FROM workspace_membership WHERE member_id='$MEMBER_ID')=0
    AND (SELECT count(*) FROM membership WHERE member_id='$MEMBER_ID')=0
    AND (SELECT status='deleted' FROM member WHERE id='$MEMBER_ID')
    AND (SELECT count(*) FROM message WHERE author_member_id='$MEMBER_ID')>0)::int;
SQL
)"
[ "$removed_state" = "1" ] || { echo "[membership] removal/history assertion failed" >&2; exit 1; }

# Ban blocks authenticated redeem and public join; deletion permits rejoin.
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/bans" \
  "$(jq -cn --arg e "$HIDDEN_EMAIL" --arg r test '{email:$e,reason:$r}')"
expect 201 "email ban creation"
BAN_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.ban.id')"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/invites" '{"role":"member","maxUses":5}'
expect 201 "invite creation for redeem check"
INVITE_CODE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.code')"
HIDDEN_TOKEN="$(login "$HIDDEN_EMAIL")"
api "$HIDDEN_TOKEN" POST "/v1/workspaces/$WS_ID/invites/redeem" \
  "$(jq -cn --arg c "$INVITE_CODE" '{code:$c}')"
expect 403 "banned invite redeem"
api "$OWNER_TOKEN" DELETE "/v1/workspaces/$WS_ID/bans/$BAN_ID"
expect 200 "email unban"

JOIN_EMAIL="m523-rejoin-$RUN_TAG@momo.local"; JOIN_HANDLE="m523-rejoin-$RUN_TAG"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/bans" \
  "$(jq -cn --arg e "$JOIN_EMAIL" --arg h "$JOIN_HANDLE" '{email:$e,handle:$h}')"
expect 201 "join identity ban"
JOIN_BAN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.ban.id')"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/invites" '{"role":"guest","maxUses":5}'
expect 201 "invite creation for public join"
JOIN_CODE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.code')"
JOIN_BODY="$(jq -cn --arg c "$JOIN_CODE" --arg e "$JOIN_EMAIL" --arg h "$JOIN_HANDLE" --arg p "$PASSWORD" \
  '{code:$c,email:$e,displayName:"Rejoin Member",handle:$h,password:$p}')"
api "" POST "/v1/join" "$JOIN_BODY"
expect 403 "banned public join"
api "$OWNER_TOKEN" DELETE "/v1/workspaces/$WS_ID/bans/$JOIN_BAN"
expect 200 "join identity unban"
api "" POST "/v1/join" "$JOIN_BODY"
expect 201 "unbanned public rejoin"

audit_ok="$(sql_value <<SQL
SELECT (count(*) FILTER (WHERE action='role.changed') >= 3
    AND count(*) FILTER (WHERE action='member.suspended') = 1
    AND count(*) FILTER (WHERE action='member.reinstated') = 1
    AND count(*) FILTER (WHERE action='member.removed') = 1
    AND count(*) FILTER (WHERE action='ban.created') = 2
    AND count(*) FILTER (WHERE action='ban.deleted') = 2)::int
FROM audit_log WHERE workspace_id='$WS_ID';
SQL
)"
[ "$audit_ok" = "1" ] || { echo "[membership] audit assertion failed" >&2; exit 1; }

RLS_WS="$(uuid)"
rls_hidden="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='%s'; SELECT count(*) FROM workspace_membership WHERE workspace_id='%s'; ROLLBACK;\n" "$RLS_WS" "$WS_ID" \
  | run_sql -tA | tr -d '[:space:]')"
[ "$rls_hidden" = "0" ] || { echo "[membership] RLS isolation failed" >&2; exit 1; }

echo "[membership] PASS lifecycle, hierarchy, guest projection, audit, and RLS"
