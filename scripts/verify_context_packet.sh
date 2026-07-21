#!/usr/bin/env bash
# MOMO-528 / ADR-0129 D4 isolated immutable Context Packet verifier.
# Docker execution belongs to the orchestrator; workers run syntax/build/unit gates.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[context-packet] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${CONTEXT_PACKET_PROJECT:-momo528packet-$RUN_TAG}"
API_PORT="${CONTEXT_PACKET_API_PORT:-28100}"
CENT_PORT="${CONTEXT_PACKET_CENTRIFUGO_PORT:-28101}"
PG_PORT="${CONTEXT_PACKET_POSTGRES_PORT:-28102}"
HERMES_PORT="${CONTEXT_PACKET_HERMES_PORT:-28103}"
BOOT_TIMEOUT="${CONTEXT_PACKET_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-context-packet.XXXXXX")"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    AGENT_PROVIDER_MODE=local-mock AGENT_GATEWAY_MODE=worker \
    MEMORY_EXTRACTION_ENABLED=0 MEMORY_EMBEDDING_ENABLED=0 \
    CONTEXT_PACKET_TTL_SECONDS=1 \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[context-packet] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[context-packet] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${CONTEXT_PACKET_KEEP:-0}" = "1" ]; then
    echo "[context-packet] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-context-packet.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[context-packet] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
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
fail() { echo "[context-packet] FAIL $*" >&2; exit 1; }
pass() { echo "[context-packet] PASS $*"; }

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
HIDDEN_CHANNEL_ID="00000000-0000-7000-8000-000000005281"
OTHER_MEMBER_ID="00000000-0000-7000-8000-000000005282"
PASSWORD="packet-$(uuid)"

echo "[context-packet] booting isolated API stack $PROJECT"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api migrate db-roles >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done

demo_rows="$(sql_value <<SQL
SELECT count(*) FROM human WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
[ "$demo_rows" = "1" ] || fail "unexpected demo account seed state"
run_sql <<SQL
UPDATE human SET password_hash=momo_password_hash('$PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL

LOGIN_JSON="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e demo@momo.local --arg p "$PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')")"
TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -er '.accessToken')"
OWNER_ID="$(sql_value <<SQL
SELECT lower(member_id::text) FROM human WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
AGENT_ROW="$(run_sql -tA <<SQL | head -1
SELECT lower(m.id::text) || '|' || m.handle FROM member m JOIN agent a ON a.member_id=m.id
 WHERE m.workspace_id='$WS_ID' AND m.status='active' ORDER BY m.created_at,m.id LIMIT 1;
SQL
)"
AGENT_ID="${AGENT_ROW%%|*}"
AGENT_HANDLE="${AGENT_ROW#*|}"
[ -n "$AGENT_ID" ] && [ -n "$AGENT_HANDLE" ] || fail "demo agent unavailable"

run_sql <<SQL
INSERT INTO membership (workspace_id,channel_id,member_id,role)
VALUES ('$WS_ID','$CHANNEL_ID','$AGENT_ID','member')
ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at=NULL;
INSERT INTO member (id,workspace_id,kind,status,display_name,handle)
VALUES ('$OTHER_MEMBER_ID','$WS_ID','human','active','Packet unrelated member','packet-unrelated');
INSERT INTO channel (id,workspace_id,kind,name,created_by)
VALUES ('$HIDDEN_CHANNEL_ID','$WS_ID','private','packet-hidden-$RUN_TAG','$OWNER_ID');
INSERT INTO channel_seq (channel_id,workspace_id,last_seq) VALUES ('$HIDDEN_CHANNEL_ID','$WS_ID',0);
INSERT INTO membership (workspace_id,channel_id,member_id,role)
VALUES ('$WS_ID','$HIDDEN_CHANNEL_ID','$OWNER_ID','owner');
SQL

send_message() {
  local channel="$1" body="$2"
  curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/channels/$channel/messages" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg c "$(uuid)" --arg b "$body" '{clientMsgId:$c,type:"text",body:$b}')"
}

VISIBLE_SOURCE="$(send_message "$CHANNEL_ID" 'Context Packet visible memory source' | jq -er '.id|ascii_downcase')"
HIDDEN_SOURCE="$(send_message "$HIDDEN_CHANNEL_ID" 'Context Packet granted hidden source' | jq -er '.id|ascii_downcase')"
run_sql <<SQL
UPDATE membership SET left_at=now()
 WHERE channel_id='$HIDDEN_CHANNEL_ID' AND member_id='$OWNER_ID';
WITH inserted AS (
  INSERT INTO memory_item
    (workspace_id,scope,subject_member_id,agent_member_id,kind,body,confidence,created_by_kind)
  VALUES
    ('$WS_ID','workspace',NULL,NULL,'profile','Always-on company profile',1,'worker'),
    ('$WS_ID','member','$OWNER_ID',NULL,'fact','launch packet actor fact',1,'worker'),
    ('$WS_ID','agent',NULL,'$AGENT_ID','episode','launch packet agent episode',1,'worker'),
    ('$WS_ID','member','$OTHER_MEMBER_ID',NULL,'fact','launch packet unrelated fact',1,'worker')
  RETURNING id,workspace_id
)
INSERT INTO memory_source_ref (workspace_id,memory_id,message_id,channel_id)
SELECT workspace_id,id,'$VISIBLE_SOURCE','$CHANNEL_ID' FROM inserted;
WITH item AS (
  INSERT INTO memory_item (workspace_id,scope,subject_member_id,kind,body,confidence,created_by_kind)
  VALUES ('$WS_ID','member','$OTHER_MEMBER_ID','fact','launch packet explicit grant',1,'worker')
  RETURNING id,workspace_id
), source AS (
  INSERT INTO memory_source_ref (workspace_id,memory_id,message_id,channel_id)
  SELECT workspace_id,id,'$HIDDEN_SOURCE','$HIDDEN_CHANNEL_ID' FROM item
)
INSERT INTO memory_visibility_grant (workspace_id,memory_id,grantee_kind,grantee_id,granted_by)
SELECT workspace_id,id,'agent','$AGENT_ID','$OWNER_ID' FROM item;
SQL

# Install+grant through the public API so plugin_capability_projection is a real
# policy projection, not a verifier-only mock row.
PLUGIN_PATH="$BASE_URL/v1/workspaces/$WS_ID/plugins/com.momo.plugins.github"
curl -fsS -X POST "$PLUGIN_PATH/install" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data '{"enabled":true}' >/dev/null
curl -fsS -X POST "$PLUGIN_PATH/grants" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"scope":"github:read","accessToken":"verifier-opaque-not-persisted"}' >/dev/null

FIRST="$(send_message "$CHANNEL_ID" "@$AGENT_HANDLE launch packet")"
FIRST_MESSAGE_ID="$(printf '%s' "$FIRST" | jq -er '.id|ascii_downcase')"
FIRST_PACKET_ID="$(sql_value <<SQL
SELECT lower(cp.packet_id::text) FROM context_packet cp JOIN agent_run ar ON ar.id=cp.run_id
 WHERE ar.trigger_message_id='$FIRST_MESSAGE_ID' ORDER BY cp.created_at DESC LIMIT 1;
SQL
)"
[ -n "$FIRST_PACKET_ID" ] || fail "mention did not issue packet"
PACKET_URL="$BASE_URL/v1/workspaces/$WS_ID/context-packets/$FIRST_PACKET_ID"
GET_ONE="$(curl -fsS "$PACKET_URL" -H "Authorization: Bearer $TOKEN")"
GET_TWO="$(curl -fsS "$PACKET_URL" -H "Authorization: Bearer $TOKEN")"
[ "$(printf '%s' "$GET_ONE" | jq -S '.content')" = "$(printf '%s' "$GET_TWO" | jq -S '.content')" ] \
  || fail "packet changed between reads"
pass "packet content is immutable across repeated GET"

printf '%s' "$GET_ONE" | jq -e --arg agent "$AGENT_ID" '
  .content.schema == "momo.context_packet.v0"
  and (.content.scope.permission_basis | index("actor_channel_member") != null)
  and ([.content.memory_refs[] | select(.reason_included=="profile_always")] | length == 1)
  and ([.content.memory_refs[] | select(.excerpt|contains("actor fact"))] | length == 1)
  and ([.content.memory_refs[] | select(.excerpt|contains("agent episode"))] | length == 1)
  and ([.content.memory_refs[] | select(.excerpt|contains("unrelated fact"))] | length == 0)
  and ([.content.memory_refs[] | select((.excerpt|contains("explicit grant")) and .permission_snapshot=="active_visibility_grant")] | length == 1)
  and ([.content.tool_grants[] | select(.tool_name=="github.list_repositories")] | length == 1)
  and ([.content.tool_grants[] | .capability_version | contains("mock")] | any | not)
' >/dev/null || fail "memory/tool/permission packet projection mismatch"
pass "profile/query scopes, explicit grant, real tool projection, and mock absence"

PAYLOAD_OK="$(sql_value <<SQL
SELECT count(*) FROM outbox o JOIN agent_run ar ON ar.id=(o.payload->>'run_id')::uuid
 WHERE o.kind='agent_job' AND ar.trigger_message_id='$FIRST_MESSAGE_ID'
   AND o.payload->'memory_refs'=o.payload->'context_packet'->'memory_refs'
   AND o.payload->'context_packet'=o.payload->'context_packet_projection'
   AND lower(o.payload->>'context_packet_id')=lower('$FIRST_PACKET_ID');
SQL
)"
[ "$PAYLOAD_OK" = "1" ] || fail "worker/gateway additive payload compatibility failed"
pass "AgentJobPayload memory_refs and immutable packet aliases agree"

sleep 2
EXPIRED="$(curl -fsS "$PACKET_URL" -H "Authorization: Bearer $TOKEN" | jq -r '.expired')"
[ "$EXPIRED" = "true" ] || fail "packet did not expire under verifier TTL"
run_sql <<SQL
UPDATE memory_visibility_grant SET revoked_at=now()
 WHERE workspace_id='$WS_ID' AND grantee_kind='agent' AND grantee_id='$AGENT_ID';
SQL
SECOND="$(send_message "$CHANNEL_ID" "@$AGENT_HANDLE launch packet")"
SECOND_MESSAGE_ID="$(printf '%s' "$SECOND" | jq -er '.id|ascii_downcase')"
SECOND_PACKET_ID="$(sql_value <<SQL
SELECT lower(cp.packet_id::text) FROM context_packet cp JOIN agent_run ar ON ar.id=cp.run_id
 WHERE ar.trigger_message_id='$SECOND_MESSAGE_ID' ORDER BY cp.created_at DESC LIMIT 1;
SQL
)"
[ "$SECOND_PACKET_ID" != "$FIRST_PACKET_ID" ] || fail "expired packet was reused"
SECOND_GET="$(curl -fsS "$BASE_URL/v1/workspaces/$WS_ID/context-packets/$SECOND_PACKET_ID" \
  -H "Authorization: Bearer $TOKEN")"
printf '%s' "$SECOND_GET" | jq -e '
  [.content.memory_refs[] | select(.excerpt|contains("explicit grant"))] | length == 0
' >/dev/null || fail "revoked visibility grant survived reissue"
pass "expiry issues a new packet and revoked grant is excluded"

mutation_status=0
run_sql <<SQL >/dev/null 2>&1 || mutation_status=$?
UPDATE context_packet SET content=jsonb_set(content,'{audit,mutated}','true'::jsonb)
 WHERE packet_id='$FIRST_PACKET_ID';
SQL
[ "$mutation_status" -ne 0 ] || fail "database allowed immutable packet UPDATE"
pass "database rejects packet mutation"

foreign_visible="$(run_app_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='00000000-0000-7000-8000-000000000999';
SELECT count(*) FROM context_packet WHERE workspace_id='$WS_ID';
ROLLBACK;
SQL
)"
[ "$foreign_visible" = "0" ] || fail "FORCE RLS leaked context packets"
pass "context_packet FORCE RLS tenant isolation"

echo "[context-packet] PASS all checks"
