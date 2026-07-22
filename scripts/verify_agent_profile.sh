#!/usr/bin/env bash
# MOMO-537 / ADR-0131 isolated agent profile + Context Packet consumer gate.
# Docker execution belongs to the orchestrator; workers run syntax/build/unit gates.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[agent-profile] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${AGENT_PROFILE_PROJECT:-momo537profile-$RUN_TAG}"
API_PORT="${AGENT_PROFILE_API_PORT:-28150}"
CENT_PORT="${AGENT_PROFILE_CENTRIFUGO_PORT:-28151}"
PG_PORT="${AGENT_PROFILE_POSTGRES_PORT:-28152}"
HERMES_PORT="${AGENT_PROFILE_HERMES_PORT:-28153}"
BOOT_TIMEOUT="${AGENT_PROFILE_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-profile.XXXXXX")"
OVERRIDE_FILE="$TMP_DIR/profile.override.yml"
DUMP_FILE="$TMP_DIR/hermes-requests.jsonl"

cat >"$OVERRIDE_FILE" <<'YAML'
services:
  mock-hermes:
    environment:
      MOCK_HERMES_REQUEST_DUMP: /tmp/momo-agent-profile-requests.jsonl
  api:
    environment:
      MEMORY_EXTRACTION_ENABLED: "0"
      MEMORY_EMBEDDING_ENABLED: "0"
  worker:
    environment:
      MEMORY_EXTRACTION_ENABLED: "0"
      MEMORY_EMBEDDING_ENABLED: "0"
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
    raise SystemExit(f"[agent-profile] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[agent-profile] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${AGENT_PROFILE_KEEP:-0}" = "1" ]; then
    echo "[agent-profile] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-agent-profile.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[agent-profile] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
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
fail() { echo "[agent-profile] FAIL $*" >&2; exit 1; }
pass() { echo "[agent-profile] PASS $*"; }

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
OWNER_ID="00000000-0000-7000-8000-000000005371"
OTHER_ID="00000000-0000-7000-8000-000000005372"
OWNER_EMAIL="profile-owner-$RUN_TAG@momo.local"
OTHER_EMAIL="profile-other-$RUN_TAG@momo.local"
OWNER_PASSWORD="profile-owner-$(uuid)"
OTHER_PASSWORD="profile-other-$(uuid)"
ADMIN_PASSWORD="profile-admin-$(uuid)"
AGENT_HANDLE="profile-agent-$RUN_TAG"
PROFILE_TEXT="PROFILE537 answer with the concise release-check format."

echo "[agent-profile] booting isolated API+worker stack $PROJECT"
compose up -d api worker
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api worker migrate db-roles mock-hermes >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done

ADMIN_ID="$(sql_value <<SQL
SELECT lower(member_id::text) FROM human WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
[ -n "$ADMIN_ID" ] || fail "demo administrator missing"
run_sql <<SQL
UPDATE human SET password_hash=momo_password_hash('$ADMIN_PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
INSERT INTO member (id,workspace_id,kind,status,display_name,handle)
VALUES
 ('$OWNER_ID','$WS_ID','human','active','Profile Owner','profile-owner-$RUN_TAG'),
 ('$OTHER_ID','$WS_ID','human','active','Profile Other','profile-other-$RUN_TAG');
INSERT INTO human (member_id,workspace_id,email,email_verified,password_hash,tz)
VALUES
 ('$OWNER_ID','$WS_ID','$OWNER_EMAIL',true,momo_password_hash('$OWNER_PASSWORD'),'UTC'),
 ('$OTHER_ID','$WS_ID','$OTHER_EMAIL',true,momo_password_hash('$OTHER_PASSWORD'),'UTC');
INSERT INTO workspace_membership (workspace_id,member_id,role)
VALUES ('$WS_ID','$OWNER_ID','member'),('$WS_ID','$OTHER_ID','member');
INSERT INTO membership (workspace_id,channel_id,member_id,role)
VALUES ('$WS_ID','$CHANNEL_ID','$OWNER_ID','member'),('$WS_ID','$CHANNEL_ID','$OTHER_ID','member')
ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at=NULL;
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
ADMIN_TOKEN="$(login demo@momo.local "$ADMIN_PASSWORD")"
OWNER_TOKEN="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
OTHER_TOKEN="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")"

CREATE_BODY="$(jq -cn \
  --arg name 'Profile Agent' --arg handle "$AGENT_HANDLE" \
  --arg owner "$OWNER_ID" \
  '{displayName:$name,handle:$handle,model:"hermes-default",baseUrl:"https://hermes.example/v1",ownerHumanId:$owner,
    profile:{instructions:"initial profile",modelPref:"external-premium",
      enabledTools:["github.list_repositories"],triggers:{mention:true,schedule:{cron:"0 9 * * 1"}}}}')"
CREATE_RESPONSE="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' --data "$CREATE_BODY")"
AGENT_ID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.agent.id|ascii_downcase')"
run_sql <<SQL
INSERT INTO membership (workspace_id,channel_id,member_id,role)
VALUES ('$WS_ID','$CHANNEL_ID','$AGENT_ID','member')
ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at=NULL;
SQL

PROFILE_URL="$BASE_URL/v1/workspaces/$WS_ID/agents/$AGENT_ID/profile"
OWNER_GET="$(curl -fsS "$PROFILE_URL" -H "Authorization: Bearer $OWNER_TOKEN")"
printf '%s' "$OWNER_GET" | jq -e '
  .profile.version == 1 and .profile.modelPref == "external-premium"
  and .profile.triggers.mention == true
  and .profile.triggers.schedule.cron == "0 9 * * 1"
' >/dev/null || fail "simultaneous creation profile or owner GET mismatch"
pass "creation form persists profile atomically and agent owner can read it"

PUT_BODY="$(jq -cn --arg instructions "$PROFILE_TEXT" \
  '{instructions:$instructions,modelPref:"external-premium",
    enabledTools:["github.list_repositories"],triggers:{mention:true,schedule:{cron:"0 9 * * 1"}}}')"
PUT_RESPONSE="$(curl -fsS -X PUT "$PROFILE_URL" -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' --data "$PUT_BODY")"
printf '%s' "$PUT_RESPONSE" | jq -e --arg instructions "$PROFILE_TEXT" '
  .profile.version == 2 and .profile.instructions == $instructions
  and .profile.enabledTools == ["github.list_repositories"]
' >/dev/null || fail "profile PUT/version increment mismatch"

status="$(curl -sS -o "$TMP_DIR/forbidden.json" -w '%{http_code}' "$PROFILE_URL" \
  -H "Authorization: Bearer $OTHER_TOKEN")"
[ "$status" = "403" ] || fail "non-owner member GET expected 403, got $status"
status="$(curl -sS -o "$TMP_DIR/credential.json" -w '%{http_code}' -X PUT "$PROFILE_URL" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  --data '{"instructions":"x","enabledTools":[],"apiKey":"must-not-store"}')"
[ "$status" = "400" ] || fail "credential-shaped profile field expected 400, got $status"
pass "profile authorization, version, schedule roundtrip, and credential rejection"

RLS_COUNT="$(run_app_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000002';
SELECT count(*) FROM agent_profile WHERE agent_member_id='$AGENT_ID';
COMMIT;
SQL
)"
[ "$RLS_COUNT" = "0" ] || fail "cross-workspace RLS exposed profile"
pass "agent_profile FORCE RLS isolates workspace rows"

PLUGIN_PATH="$BASE_URL/v1/workspaces/$WS_ID/plugins/com.momo.plugins.github"
curl -fsS -X POST "$PLUGIN_PATH/install" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data '{"enabled":true}' >/dev/null
curl -fsS -X POST "$PLUGIN_PATH/grants" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data '{"scope":"github:read"}' >/dev/null

TRIGGER_BODY="@$AGENT_HANDLE PROFILE537 mention consumer check"
SEND_RESPONSE="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg c "$(uuid)" --arg b "$TRIGGER_BODY" '{clientMsgId:$c,type:"text",body:$b}')")"
MESSAGE_ID="$(printf '%s' "$SEND_RESPONSE" | jq -er '.id|ascii_downcase')"

deadline=$(( $(date -u +%s) + 120 ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  if compose exec -T mock-hermes sh -c \
    "test -f /tmp/momo-agent-profile-requests.jsonl && grep -q PROFILE537 /tmp/momo-agent-profile-requests.jsonl" \
    >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
compose exec -T mock-hermes sh -c 'cat /tmp/momo-agent-profile-requests.jsonl' >"$DUMP_FILE" \
  || fail "mock Hermes request dump missing"
grep -q PROFILE537 "$DUMP_FILE" || fail "mention did not reach mock Hermes"

PACKET_JSON="$(run_sql -tA <<SQL
SELECT cp.content::text
  FROM context_packet cp
  JOIN agent_run ar ON ar.id=cp.run_id
 WHERE ar.trigger_message_id='$MESSAGE_ID'
 ORDER BY cp.created_at DESC LIMIT 1;
SQL
)"
[ -n "$PACKET_JSON" ] || fail "mention did not issue Context Packet"
printf '%s' "$PACKET_JSON" | jq -e --arg profile "$PROFILE_TEXT" '
  (.system_prompt | startswith("You are operating inside momo."))
  and (.system_prompt | contains($profile))
  and ((.system_prompt | index("Server-issued")) < (.system_prompt | index($profile)))
  and .agent_profile.tool_policy == "intersection"
  and .agent_profile.model == "hermes-default"
  and ([.tool_grants[].tool_name] == ["github.list_repositories"])
  and ([.tool_grants[].tool_name] | index("github.search_issues") == null)
' >/dev/null || fail "packet preamble/profile/tool intersection/model projection mismatch"

PAYLOAD_ASSERT="$(sql_value <<SQL
SELECT count(*) FROM outbox o JOIN agent_run ar ON ar.id=(o.payload->>'run_id')::uuid
 WHERE o.kind='agent_job' AND ar.trigger_message_id='$MESSAGE_ID'
   AND o.payload->>'model'='hermes-default'
   AND o.payload->>'system_prompt' LIKE '%PROFILE537 answer%'
   AND jsonb_array_length(o.payload->'tool_grants')=1
   AND o.payload->'tool_grants'->0->>'tool_name'='github.list_repositories';
SQL
)"
[ "$PAYLOAD_ASSERT" = "1" ] || fail "agent_job payload profile projection mismatch"
IGNORED_AUDIT="$(sql_value <<SQL
SELECT count(*) FROM audit_log al JOIN agent_run ar ON ar.id=al.run_id
 WHERE ar.trigger_message_id='$MESSAGE_ID'
   AND al.action='agent.profile.model_pref.ignored'
   AND al.detail->>'requested_model'='external-premium';
SQL
)"
[ "$IGNORED_AUDIT" = "1" ] || fail "disallowed model preference audit must occur exactly once"
pass "packet preamble priority, tool intersection, and model fail-closed audit"

python3 - "$DUMP_FILE" "$PROFILE_TEXT" "$TRIGGER_BODY" <<'PY'
import json, sys
path, profile, trigger = sys.argv[1:]
target = None
with open(path, encoding="utf-8") as handle:
    for line in handle:
        request = json.loads(line)
        if any(trigger in str(message.get("content") or "") for message in request.get("messages", [])):
            target = request
            break
if target is None:
    raise SystemExit("[agent-profile] FAIL target mock Hermes request missing")
messages = target.get("messages", [])
if not messages or messages[0].get("role") != "system":
    raise SystemExit("[agent-profile] FAIL first mock Hermes message is not system")
system = str(messages[0].get("content") or "")
if not system.startswith("You are operating inside momo.") or profile not in system:
    raise SystemExit("[agent-profile] FAIL profile instructions absent from mock Hermes system message")
if system.index("Server-issued") >= system.index(profile):
    raise SystemExit("[agent-profile] FAIL profile precedes server policy preamble")
if target.get("model") != "hermes-default":
    raise SystemExit("[agent-profile] FAIL disallowed profile model reached mock Hermes")
PY
pass "mention roundtrip injects profile instructions into mock Hermes request"

echo "[agent-profile] PASS CRUD, RLS, packet policy, tool/model narrowing, audit, and end-to-end consumption"
