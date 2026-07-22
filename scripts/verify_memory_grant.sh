#!/usr/bin/env bash
# MOMO-549 isolated memory visibility grant CRUD + serving-filter verifier.
# Docker execution belongs to the orchestrator; workers run syntax/build/unit gates.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[memory-grant] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${MEMORY_GRANT_PROJECT:-momo549grant-$RUN_TAG}"
API_PORT="${MEMORY_GRANT_API_PORT:-28160}"
CENT_PORT="${MEMORY_GRANT_CENTRIFUGO_PORT:-28161}"
PG_PORT="${MEMORY_GRANT_POSTGRES_PORT:-28162}"
HERMES_PORT="${MEMORY_GRANT_HERMES_PORT:-28163}"
BOOT_TIMEOUT="${MEMORY_GRANT_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-memory-grant.XXXXXX")"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    AGENT_PROVIDER_MODE=local-mock AGENT_GATEWAY_MODE=worker \
    MEMORY_EXTRACTION_ENABLED=0 MEMORY_EMBEDDING_ENABLED=0 \
    CONTEXT_PACKET_TTL_SECONDS=1 \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

if [ -n "$(compose ps -aq 2>/dev/null)" ]; then
  echo "[memory-grant] compose project already exists: $PROJECT" >&2
  exit 1
fi
python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[memory-grant] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[memory-grant] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${MEMORY_GRANT_KEEP:-0}" = "1" ]; then
    echo "[memory-grant] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-memory-grant.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[memory-grant] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
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
run_app_sql() {
  compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres \
    psql -U momo_app -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }
fail() { echo "[memory-grant] FAIL $*" >&2; exit 1; }
pass() { echo "[memory-grant] PASS $*"; }

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
SUBJECT_ID="00000000-0000-7000-8000-000000005491"
OTHER_ID="00000000-0000-7000-8000-000000005492"
AGENT_OWNER_ID="00000000-0000-7000-8000-000000005493"
AGENT_ID="00000000-0000-7000-8000-000000005494"
INACTIVE_ID="00000000-0000-7000-8000-000000005495"
SUBJECT_EMAIL="grant-subject-$RUN_TAG@momo.local"
OTHER_EMAIL="grant-other-$RUN_TAG@momo.local"
AGENT_OWNER_EMAIL="grant-owner-$RUN_TAG@momo.local"
SUBJECT_PASSWORD="grant-subject-$(uuid)"
OTHER_PASSWORD="grant-other-$(uuid)"
AGENT_OWNER_PASSWORD="grant-owner-$(uuid)"
ADMIN_PASSWORD="grant-admin-$(uuid)"
AGENT_HANDLE="grant-agent-$RUN_TAG"
MEMORY_TEXT="grant549 lighthouse retention"

echo "[memory-grant] booting isolated API stack $PROJECT"
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
SELECT lower(member_id::text) FROM human
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
[ -n "$ADMIN_ID" ] || fail "demo administrator missing"
run_sql <<SQL
UPDATE human SET password_hash=momo_password_hash('$ADMIN_PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
INSERT INTO member (id,workspace_id,kind,status,display_name,handle)
VALUES
 ('$SUBJECT_ID','$WS_ID','human','active','Grant Subject','grant-subject-$RUN_TAG'),
 ('$OTHER_ID','$WS_ID','human','active','Grant Other','grant-other-$RUN_TAG'),
 ('$AGENT_OWNER_ID','$WS_ID','human','active','Grant Agent Owner','grant-owner-$RUN_TAG'),
 ('$INACTIVE_ID','$WS_ID','human','suspended','Grant Inactive','grant-inactive-$RUN_TAG'),
 ('$AGENT_ID','$WS_ID','agent','active','Grant Agent','$AGENT_HANDLE');
INSERT INTO human (member_id,workspace_id,email,email_verified,password_hash,tz)
VALUES
 ('$SUBJECT_ID','$WS_ID','$SUBJECT_EMAIL',true,momo_password_hash('$SUBJECT_PASSWORD'),'UTC'),
 ('$OTHER_ID','$WS_ID','$OTHER_EMAIL',true,momo_password_hash('$OTHER_PASSWORD'),'UTC'),
 ('$AGENT_OWNER_ID','$WS_ID','$AGENT_OWNER_EMAIL',true,momo_password_hash('$AGENT_OWNER_PASSWORD'),'UTC');
INSERT INTO agent (member_id,workspace_id,model,base_url,owner_human_id)
VALUES ('$AGENT_ID','$WS_ID','hermes-default','http://mock-hermes:8080/v1','$AGENT_OWNER_ID');
INSERT INTO workspace_membership (workspace_id,member_id,role)
VALUES
 ('$WS_ID','$SUBJECT_ID','member'),('$WS_ID','$OTHER_ID','member'),
 ('$WS_ID','$AGENT_OWNER_ID','member'),('$WS_ID','$AGENT_ID','member');
INSERT INTO membership (workspace_id,channel_id,member_id,role)
VALUES
 ('$WS_ID','$CHANNEL_ID','$SUBJECT_ID','member'),
 ('$WS_ID','$CHANNEL_ID','$OTHER_ID','member'),
 ('$WS_ID','$CHANNEL_ID','$AGENT_OWNER_ID','member'),
 ('$WS_ID','$CHANNEL_ID','$AGENT_ID','member')
ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at=NULL;
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
ADMIN_TOKEN="$(login demo@momo.local "$ADMIN_PASSWORD")"
SUBJECT_TOKEN="$(login "$SUBJECT_EMAIL" "$SUBJECT_PASSWORD")"
OTHER_TOKEN="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")"
AGENT_OWNER_TOKEN="$(login "$AGENT_OWNER_EMAIL" "$AGENT_OWNER_PASSWORD")"

SOURCE_MESSAGE_ID="$(curl -fsS -X POST \
  "$BASE_URL/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $SUBJECT_TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg c "$(uuid)" --arg b 'MOMO-549 grant source' \
    '{clientMsgId:$c,type:"text",body:$b}')" | jq -er '.id|ascii_downcase')"
MEMORY_ID="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/memories" \
  -H "Authorization: Bearer $SUBJECT_TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg subject "$SUBJECT_ID" --arg body "$MEMORY_TEXT" \
    --arg message "$SOURCE_MESSAGE_ID" --arg channel "$CHANNEL_ID" \
    '{scope:"member",subjectMemberId:$subject,kind:"fact",body:$body,confidence:1,
      sourceRefs:[{messageId:$message,channelId:$channel}]}')" | jq -er '.memory.id|ascii_downcase')"
[ -n "$MEMORY_ID" ] || fail "member-scope memory creation failed"

# This public endpoint executes migration 030 memory_search_hybrid through the
# ordinary tenant role; no verifier-only direct function call is used.
SEARCH_URL="$BASE_URL/v1/workspaces/$WS_ID/memories/search?q=grant549%20lighthouse%20retention&agent=$AGENT_ID"
BEFORE_SEARCH="$(curl -fsS "$SEARCH_URL" -H "Authorization: Bearer $OTHER_TOKEN")"
printf '%s' "$BEFORE_SEARCH" | jq -e --arg memory "$MEMORY_ID" '
  [.hits[] | select((.memory.id|ascii_downcase)==$memory)] | length == 0
' >/dev/null || fail "ungranted memory was visible through agent scope"

GRANTS_URL="$BASE_URL/v1/workspaces/$WS_ID/memories/$MEMORY_ID/grants"
GRANT_BODY="$(jq -cn --arg id "$AGENT_ID" '{granteeKind:"agent",granteeId:$id}')"
GRANTED="$(curl -fsS -X POST "$GRANTS_URL" -H "Authorization: Bearer $SUBJECT_TOKEN" \
  -H 'Content-Type: application/json' --data "$GRANT_BODY")"
GRANT_ID="$(printf '%s' "$GRANTED" | jq -er '.grant.id|ascii_downcase')"
printf '%s' "$GRANTED" | jq -e --arg memory "$MEMORY_ID" --arg agent "$AGENT_ID" '
  (.grant.memoryId|ascii_downcase)==$memory
  and .grant.granteeKind=="agent" and (.grant.granteeId|ascii_downcase)==$agent
  and .grant.revokedAtMs==null
' >/dev/null || fail "grant response projection mismatch"

REPLAYED="$(curl -fsS -X POST "$GRANTS_URL" -H "Authorization: Bearer $SUBJECT_TOKEN" \
  -H 'Content-Type: application/json' --data "$GRANT_BODY")"
[ "$(printf '%s' "$REPLAYED" | jq -r '.grant.id|ascii_downcase')" = "$GRANT_ID" ] \
  || fail "active grant replay changed ledger id"
GRANT_AUDIT_COUNT="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID' AND action='memory.visibility_grant.granted'
   AND target_id='$GRANT_ID';
SQL
)"
[ "$GRANT_AUDIT_COUNT" = "1" ] || fail "active grant replay duplicated audit evidence"

AFTER_GRANT_SEARCH="$(curl -fsS "$SEARCH_URL" -H "Authorization: Bearer $OTHER_TOKEN")"
printf '%s' "$AFTER_GRANT_SEARCH" | jq -e --arg memory "$MEMORY_ID" '
  [.hits[] | select((.memory.id|ascii_downcase)==$memory)] | length == 1
' >/dev/null || fail "active grant did not immediately affect memory_search_hybrid"
pass "grant REST immediately opens migration 030 search visibility"

status="$(curl -sS -o "$TMP_DIR/forbidden.json" -w '%{http_code}' "$GRANTS_URL" \
  -H "Authorization: Bearer $OTHER_TOKEN")"
[ "$status" = "403" ] || fail "non-scope member GET expected 403, got $status"
status="$(curl -sS -o "$TMP_DIR/inactive.json" -w '%{http_code}' -X POST "$GRANTS_URL" \
  -H "Authorization: Bearer $SUBJECT_TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg id "$INACTIVE_ID" '{granteeKind:"member",granteeId:$id}')")"
[ "$status" = "400" ] || fail "inactive member grant expected 400, got $status"
ADMIN_LIST="$(curl -fsS "$GRANTS_URL" -H "Authorization: Bearer $ADMIN_TOKEN")"
printf '%s' "$ADMIN_LIST" | jq -e --arg grant "$GRANT_ID" '
  [.grants[] | select((.id|ascii_downcase)==$grant and .revokedAtMs==null)] | length == 1
' >/dev/null || fail "administrator grant list mismatch"

AGENT_MEMORY_ID="$(run_sql -tA <<SQL | tr -d '[:space:]'
WITH item AS (
  INSERT INTO memory_item
    (workspace_id,scope,agent_member_id,kind,body,confidence,created_by_kind)
  VALUES ('$WS_ID','agent','$AGENT_ID','fact','agent owner grant fixture',1,'worker')
  RETURNING id,workspace_id
), source AS (
  INSERT INTO memory_source_ref (workspace_id,memory_id,message_id,channel_id)
  SELECT workspace_id,id,'$SOURCE_MESSAGE_ID','$CHANNEL_ID' FROM item
)
SELECT lower(id::text) FROM item;
SQL
)"
OWNER_STATUS="$(curl -sS -o "$TMP_DIR/owner-list.json" -w '%{http_code}' \
  "$BASE_URL/v1/workspaces/$WS_ID/memories/$AGENT_MEMORY_ID/grants" \
  -H "Authorization: Bearer $AGENT_OWNER_TOKEN")"
[ "$OWNER_STATUS" = "200" ] || fail "agent owner GET expected 200, got $OWNER_STATUS"
pass "admin, member subject, agent owner, and non-owner authorization boundaries"

send_mention() {
  curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" \
    -H "Authorization: Bearer $OTHER_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg c "$(uuid)" --arg b "@$AGENT_HANDLE $MEMORY_TEXT" \
      '{clientMsgId:$c,type:"text",body:$b}')"
}
FIRST_MESSAGE_ID="$(send_mention | jq -er '.id|ascii_downcase')"
FIRST_PACKET_ID="$(sql_value <<SQL
SELECT lower(cp.packet_id::text) FROM context_packet cp JOIN agent_run ar ON ar.id=cp.run_id
 WHERE ar.trigger_message_id='$FIRST_MESSAGE_ID' ORDER BY cp.created_at DESC LIMIT 1;
SQL
)"
[ -n "$FIRST_PACKET_ID" ] || fail "active grant mention did not issue packet"
FIRST_PACKET="$(curl -fsS "$BASE_URL/v1/workspaces/$WS_ID/context-packets/$FIRST_PACKET_ID" \
  -H "Authorization: Bearer $OTHER_TOKEN")"
printf '%s' "$FIRST_PACKET" | jq -e --arg memory "$MEMORY_ID" '
  [.content.memory_refs[] |
    select((.memory_id|ascii_downcase)==$memory and .permission_snapshot=="active_visibility_grant")]
  | length == 1
' >/dev/null || fail "active grant memory missing from Context Packet"

sleep 2
REVOKED="$(curl -fsS -X DELETE "$GRANTS_URL" -H "Authorization: Bearer $SUBJECT_TOKEN" \
  -H 'Content-Type: application/json' --data "$GRANT_BODY")"
REVOKED_AT="$(printf '%s' "$REVOKED" | jq -er '.grant.revokedAtMs')"
[ "$REVOKED_AT" -gt 0 ] || fail "revoke response omitted revokedAtMs"
REVOKED_REPLAY="$(curl -fsS -X DELETE "$GRANTS_URL" \
  -H "Authorization: Bearer $SUBJECT_TOKEN" -H 'Content-Type: application/json' \
  --data "$GRANT_BODY")"
[ "$(printf '%s' "$REVOKED_REPLAY" | jq -er '.grant.revokedAtMs')" = "$REVOKED_AT" ] \
  || fail "idempotent re-revoke changed revokedAtMs"
REVOKE_AUDIT_COUNT="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID' AND action='memory.visibility_grant.revoked'
   AND target_id='$GRANT_ID';
SQL
)"
[ "$REVOKE_AUDIT_COUNT" = "1" ] || fail "idempotent re-revoke duplicated audit evidence"

AFTER_REVOKE_SEARCH="$(curl -fsS "$SEARCH_URL" -H "Authorization: Bearer $OTHER_TOKEN")"
printf '%s' "$AFTER_REVOKE_SEARCH" | jq -e --arg memory "$MEMORY_ID" '
  [.hits[] | select((.memory.id|ascii_downcase)==$memory)] | length == 0
' >/dev/null || fail "revoked grant remained visible in memory search"

SECOND_MESSAGE_ID="$(send_mention | jq -er '.id|ascii_downcase')"
SECOND_PACKET_ID="$(sql_value <<SQL
SELECT lower(cp.packet_id::text) FROM context_packet cp JOIN agent_run ar ON ar.id=cp.run_id
 WHERE ar.trigger_message_id='$SECOND_MESSAGE_ID' ORDER BY cp.created_at DESC LIMIT 1;
SQL
)"
[ -n "$SECOND_PACKET_ID" ] && [ "$SECOND_PACKET_ID" != "$FIRST_PACKET_ID" ] \
  || fail "revoke did not issue a new packet"
SECOND_PACKET="$(curl -fsS "$BASE_URL/v1/workspaces/$WS_ID/context-packets/$SECOND_PACKET_ID" \
  -H "Authorization: Bearer $OTHER_TOKEN")"
# Keep the revoke assertion grammar aligned with verify_context_packet.sh.
printf '%s' "$SECOND_PACKET" | jq -e --arg memory "$MEMORY_ID" '
  [.content.memory_refs[] | select((.memory_id|ascii_downcase)==$memory)] | length == 0
' >/dev/null || fail "revoked visibility grant survived packet reissue"
pass "revoke closes search visibility and excludes memory_refs on packet reissue"

RLS_COUNT="$(run_app_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='00000000-0000-7000-8000-000000000999';
SELECT count(*) FROM memory_visibility_grant WHERE id='$GRANT_ID';
ROLLBACK;
SQL
)"
[ "$RLS_COUNT" = "0" ] || fail "FORCE RLS exposed foreign visibility grant"
pass "memory_visibility_grant stays isolated through the ordinary app role"

echo "[memory-grant] PASS MOMO-549 grant CRUD, audit, search, packet, auth, and RLS"
