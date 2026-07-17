#!/usr/bin/env bash
# MOMO-449 / ADR-0113 SE-04C grant -> Context Packet tool policy verifier.
# Docker execution belongs to momo-main; workers run bash -n only.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[plugin-roundtrip] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need uuidgen
need python3

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${PLUGIN_ROUNDTRIP_PROJECT:-momo449pluginroundtrip}"
API_PORT="${PLUGIN_ROUNDTRIP_PORT:-19900}"
PG_PORT="${PLUGIN_ROUNDTRIP_POSTGRES_PORT:-19901}"
CENT_PORT_HOST="${PLUGIN_ROUNDTRIP_CENT_PORT:-19902}"
HERMES_PORT_HOST="${PLUGIN_ROUNDTRIP_HERMES_PORT:-19903}"
BOOT_TIMEOUT="${PLUGIN_ROUNDTRIP_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-plugin-roundtrip-$RUN_ID"
mkdir -p "$TMP_DIR"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
HUMAN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
AGENT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
HUMAN_EMAIL="plugin-roundtrip-$RUN_ID@momo.local"
HUMAN_PASSWORD="plugin-$(uuidgen | tr '[:upper:]' '[:lower:]')"
GITHUB="com.momo.plugins.github"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${PLUGIN_ROUNDTRIP_KEEP:-0}" = "1" ]; then
    echo "[plugin-roundtrip] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[plugin-roundtrip] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[plugin-roundtrip] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[plugin-roundtrip] api exited" >&2
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
  ('$HUMAN_ID', '$WORKSPACE_ID', 'human', 'active', 'Plugin Delegator', 'plugin-delegator-$RUN_ID'),
  ('$AGENT_ID', '$WORKSPACE_ID', 'agent', 'active', 'Plugin Agent', 'plugin-agent-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$HUMAN_ID', '$WORKSPACE_ID', '$HUMAN_EMAIL', true,
        momo_password_hash('$HUMAN_PASSWORD'), 'UTC');
INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES ('$AGENT_ID', '$WORKSPACE_ID', 'hermes-agent', 'http://localhost:8088/v1',
        'MOMO-449 verifier', '$HUMAN_ID');
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

PLUGIN_PATH="/v1/workspaces/$WORKSPACE_ID/plugins/$GITHUB"
api POST "$PLUGIN_PATH/install" "$HUMAN_TOKEN" '{"enabled":true}' "$TMP_DIR/install.json"
api POST "$PLUGIN_PATH/grants" "$HUMAN_TOKEN" '{"scope":"github:read"}' "$TMP_DIR/grant.json"
jq -e '.status == "active" and .capabilities == ["github.list_repositories"]' "$TMP_DIR/grant.json" >/dev/null

api POST "/v1/workspaces/$WORKSPACE_ID/agents/$AGENT_ID/credentials" "$HUMAN_TOKEN" \
  '{"label":"MOMO-449 verifier"}' "$TMP_DIR/credential.json"
AGENT_TOKEN="$(jq -er '.token' "$TMP_DIR/credential.json")"

POLICY_PATH="/v1/workspaces/$WORKSPACE_ID/plugins?delegatedMemberId=$HUMAN_ID&channelId=$CHANNEL_ID"
api GET "$POLICY_PATH" "$AGENT_TOKEN" '' "$TMP_DIR/before.json"
jq -e --arg plugin "$GITHUB" '
  .toolPolicy.plugins == [{
    pluginId: $plugin,
    mcp: {url:"https://api.githubcopilot.com/mcp/", transport:"streamable_http"},
    egressDomains:["api.githubcopilot.com"],
    tools:[{name:"github.list_repositories", risk:"read", approvalTier:"read_only"}]
  }]
' "$TMP_DIR/before.json" >/dev/null

PYTHONPATH="$REPO_ROOT/adapters/hermes" python3 - "$TMP_DIR/before.json" <<'PY'
import json
import sys
from momo_adapter import MomoAdapter

with open(sys.argv[1], encoding="utf-8") as handle:
    response = json.load(handle)
policy = MomoAdapter._normalize_plugin_tool_policy(response)
assert len(policy["plugins"]) == 1, policy
serialized = json.dumps(policy, sort_keys=True).lower()
for forbidden in ("credential", "access_token", "refresh_token", "authorization", "password"):
    assert forbidden not in serialized, forbidden
PY

api DELETE "$PLUGIN_PATH/grants/github:read" "$HUMAN_TOKEN" '' "$TMP_DIR/revoke.json"
jq -e '.status == "revoked"' "$TMP_DIR/revoke.json" >/dev/null
api GET "$POLICY_PATH" "$AGENT_TOKEN" '' "$TMP_DIR/after.json"
jq -e '.toolPolicy.plugins == []' "$TMP_DIR/after.json" >/dev/null

echo "MOMO-449 plugin grant Context Packet roundtrip PASS (no GitHub network call)"
