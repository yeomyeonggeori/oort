#!/usr/bin/env bash
# MOMO-457 / ADR-0113 SE-04D hosted read-only Drive MCP verifier.
# Docker execution belongs to momo-main; workers run bash -n only.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[drive-mcp] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${DRIVE_MCP_PROJECT:-momo457drivemcp}"
API_PORT="${DRIVE_MCP_PORT:-20100}"
PG_PORT="${DRIVE_MCP_POSTGRES_PORT:-20101}"
CENT_PORT_HOST="${DRIVE_MCP_CENT_PORT:-20102}"
HERMES_PORT_HOST="${DRIVE_MCP_HERMES_PORT:-20103}"
BOOT_TIMEOUT="${DRIVE_MCP_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-drive-mcp-$RUN_ID"
mkdir -p "$TMP_DIR"

# Keep the repository's shared compose contract untouched. This verifier-only
# overlay makes the stub an explicit opt-in inside the isolated API container.
OVERRIDE_FILE="$TMP_DIR/drive-stub.override.yml"
cat >"$OVERRIDE_FILE" <<'YAML'
services:
  api:
    environment:
      MOMO_ENV: local
      MOMO_DRIVE_BACKEND: stub
YAML

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
HUMAN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
AGENT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
HUMAN_EMAIL="drive-mcp-$RUN_ID@momo.local"
HUMAN_PASSWORD="drive-$(uuidgen | tr '[:upper:]' '[:lower:]')"
DRIVE_PLUGIN="com.momo.plugins.drive"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${DRIVE_MCP_KEEP:-0}" = "1" ]; then
    echo "[drive-mcp] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[drive-mcp] booting isolated stub API stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[drive-mcp] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[drive-mcp] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$HUMAN_ID', '$WORKSPACE_ID', 'human', 'active', 'Drive Delegator', 'drive-delegator-$RUN_ID'),
  ('$AGENT_ID', '$WORKSPACE_ID', 'agent', 'active', 'Drive Agent', 'drive-agent-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$HUMAN_ID', '$WORKSPACE_ID', '$HUMAN_EMAIL', true,
        momo_password_hash('$HUMAN_PASSWORD'), 'UTC');
INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES ('$AGENT_ID', '$WORKSPACE_ID', 'hermes-agent', 'http://localhost:8088/v1',
        'MOMO-457 verifier', '$HUMAN_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$HUMAN_ID', 'owner'),
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
COMMIT;
SQL

api() {
  local method="$1" path="$2" token="$3" body="${4:-}" out="$5"
  local -a args=(-fsS -X "$method" -H "Content-Type: application/json" -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}" "$BASE_URL$path" >"$out"
}

LOGIN_JSON="$TMP_DIR/login.json"
curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$HUMAN_EMAIL" --arg p "$HUMAN_PASSWORD" '{email:$e,password:$p}')" \
  >"$LOGIN_JSON"
HUMAN_TOKEN="$(jq -er '.accessToken' "$LOGIN_JSON")"

PLUGIN_PATH="/v1/workspaces/$WORKSPACE_ID/plugins/$DRIVE_PLUGIN"
api POST "$PLUGIN_PATH/install" "$HUMAN_TOKEN" '{"enabled":true}' "$TMP_DIR/install.json"
api POST "$PLUGIN_PATH/grants" "$HUMAN_TOKEN" '{"scope":"drive:read"}' "$TMP_DIR/grant.json"
jq -e '.status == "active" and (.capabilities | sort) == ["drive.export_text","drive.get_file_metadata","drive.search_files"]' \
  "$TMP_DIR/grant.json" >/dev/null

api POST "/v1/workspaces/$WORKSPACE_ID/agents/$AGENT_ID/credentials" "$HUMAN_TOKEN" \
  '{"label":"MOMO-457 verifier"}' "$TMP_DIR/credential.json"
AGENT_TOKEN="$(jq -er '.token' "$TMP_DIR/credential.json")"

POLICY_PATH="/v1/workspaces/$WORKSPACE_ID/plugins?delegatedMemberId=$HUMAN_ID&channelId=$CHANNEL_ID"
api GET "$POLICY_PATH" "$AGENT_TOKEN" '' "$TMP_DIR/policy.json"
jq -e --arg plugin "$DRIVE_PLUGIN" --arg url "$BASE_URL/v1/mcp/drive" '
  .toolPolicy.plugins == [{
    pluginId: $plugin,
    mcp: {url:$url, transport:"streamable_http"},
    egressDomains:["www.googleapis.com","oauth2.googleapis.com"],
    tools:[
      {name:"drive.export_text", risk:"read", approvalTier:"read_only"},
      {name:"drive.get_file_metadata", risk:"read", approvalTier:"read_only"},
      {name:"drive.search_files", risk:"read", approvalTier:"read_only"}
    ]
  }]
' "$TMP_DIR/policy.json" >/dev/null

MCP_PATH="/v1/mcp/drive?delegatedMemberId=$HUMAN_ID&channelId=$CHANNEL_ID"
mcp() {
  local body="$1" out="$2"
  api POST "$MCP_PATH" "$AGENT_TOKEN" "$body" "$out"
}

mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$TMP_DIR/initialize.json"
jq -e '.result.protocolVersion == "2025-06-18" and .result.serverInfo.name == "momo/drive-mcp"' \
  "$TMP_DIR/initialize.json" >/dev/null

mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$TMP_DIR/tools.json"
jq -e '[.result.tools[].name] == ["drive.search_files","drive.get_file_metadata","drive.export_text"] and all(.result.tools[]; .annotations.readOnlyHint == true)' \
  "$TMP_DIR/tools.json" >/dev/null

mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"drive.search_files","arguments":{"query":"handbook"}}}' \
  "$TMP_DIR/search.json"
jq -e '.result.isError == false and .result.structuredContent.files[0].id == "stub-doc-1"' \
  "$TMP_DIR/search.json" >/dev/null

mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"drive.get_file_metadata","arguments":{"fileId":"stub-text-1"}}}' \
  "$TMP_DIR/metadata.json"
jq -e '.result.isError == false and .result.structuredContent.name == "readme.txt"' \
  "$TMP_DIR/metadata.json" >/dev/null

mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"drive.export_text","arguments":{"fileId":"stub-doc-1","maxBytes":1000}}}' \
  "$TMP_DIR/export.json"
jq -e '.result.isError == false and .result.structuredContent.text == "momo Drive stub document"' \
  "$TMP_DIR/export.json" >/dev/null

api DELETE "$PLUGIN_PATH/grants/drive:read" "$HUMAN_TOKEN" '' "$TMP_DIR/revoke.json"
jq -e '.status == "revoked"' "$TMP_DIR/revoke.json" >/dev/null
mcp '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"drive.search_files","arguments":{}}}' \
  "$TMP_DIR/denied.json"
jq -e '.error.code == -32003 and .error.data.code == "momo.drive.grant_required"' \
  "$TMP_DIR/denied.json" >/dev/null

AUDIT_COUNTS="$(run_sql -tA <<SQL | tr -d '[:space:]'
SET row_security = off;
SELECT count(*) FILTER (WHERE detail->>'outcome' = 'success') || ':' ||
       count(*) FILTER (WHERE detail->>'outcome' = 'grant_denied')
  FROM audit_log
 WHERE workspace_id = '$WORKSPACE_ID'
   AND actor_member_id = '$AGENT_ID'
   AND subject_member_id = '$HUMAN_ID'
   AND action = 'plugin.drive.tool_result';
SQL
)"
[ "$AUDIT_COUNTS" = "3:1" ] || { echo "[drive-mcp] unexpected audit counts: $AUDIT_COUNTS" >&2; exit 1; }

if grep -qiE 'private_key|access_token|refresh_token|client_secret' "$TMP_DIR"/*.json 2>/dev/null; then
  echo "[drive-mcp] credential-shaped response material detected" >&2
  exit 1
fi

echo "MOMO-457 hosted read-only Drive MCP roundtrip PASS (stub only; no Google network call)"
