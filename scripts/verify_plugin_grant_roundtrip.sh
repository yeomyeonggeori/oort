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
# momo_adapter는 dataclass(slots=True)로 Python >= 3.10 필요 — 게이트 환경의
# PATH가 Xcode 툴체인 python3(3.9)를 앞세울 수 있어 명시 탐색한다.
PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"; break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "[plugin-roundtrip] missing python >= 3.10" >&2; exit 1; }

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
NOTION="com.momo.plugins.notion"
LINEAR="com.momo.plugins.linear"

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
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WORKSPACE_ID', '$HUMAN_ID', 'owner'),
  ('$WORKSPACE_ID', '$AGENT_ID', 'member');
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

GITHUB_PATH="/v1/workspaces/$WORKSPACE_ID/plugins/$GITHUB"
NOTION_PATH="/v1/workspaces/$WORKSPACE_ID/plugins/$NOTION"
LINEAR_PATH="/v1/workspaces/$WORKSPACE_ID/plugins/$LINEAR"

api POST "$GITHUB_PATH/install" "$HUMAN_TOKEN" '{"enabled":true}' "$TMP_DIR/install-github.json"
api POST "$NOTION_PATH/install" "$HUMAN_TOKEN" '{"enabled":true}' "$TMP_DIR/install-notion.json"
api POST "$LINEAR_PATH/install" "$HUMAN_TOKEN" '{"enabled":true}' "$TMP_DIR/install-linear.json"

api POST "$GITHUB_PATH/grants" "$HUMAN_TOKEN" '{"scope":"github:read"}' "$TMP_DIR/grant-github.json"
api POST "$NOTION_PATH/grants" "$HUMAN_TOKEN" '{"scope":"notion:read"}' "$TMP_DIR/grant-notion.json"
api POST "$LINEAR_PATH/grants" "$HUMAN_TOKEN" '{"scope":"linear:read"}' "$TMP_DIR/grant-linear.json"
jq -e '.status == "active" and .capabilities == ["github.list_repositories"]' "$TMP_DIR/grant-github.json" >/dev/null
jq -e '.status == "active" and .capabilities == ["notion.search"]' "$TMP_DIR/grant-notion.json" >/dev/null
jq -e '.status == "active" and .capabilities == ["linear.list_issues"]' "$TMP_DIR/grant-linear.json" >/dev/null

api POST "/v1/workspaces/$WORKSPACE_ID/agents/$AGENT_ID/credentials" "$HUMAN_TOKEN" \
  '{"label":"MOMO-449 verifier"}' "$TMP_DIR/credential.json"
AGENT_TOKEN="$(jq -er '.token' "$TMP_DIR/credential.json")"

POLICY_PATH="/v1/workspaces/$WORKSPACE_ID/plugins?delegatedMemberId=$HUMAN_ID&channelId=$CHANNEL_ID"
api GET "$POLICY_PATH" "$AGENT_TOKEN" '' "$TMP_DIR/before.json"
jq -e --arg plugin "$GITHUB" '
  .toolPolicy.plugins == [
    {
      pluginId: $plugin,
      mcp: {url:"https://api.githubcopilot.com/mcp/", transport:"streamable_http"},
      egressDomains:["api.githubcopilot.com"],
      tools:[{name:"github.list_repositories", risk:"read", approvalTier:"read_only"}]
    },
    {
      pluginId: "com.momo.plugins.linear",
      mcp: {url:"https://mcp.linear.app/mcp", transport:"streamable_http"},
      egressDomains:["mcp.linear.app"],
      tools:[{name:"linear.list_issues", risk:"read", approvalTier:"read_only"}]
    },
    {
      pluginId: "com.momo.plugins.notion",
      mcp: {url:"https://mcp.notion.com/mcp", transport:"streamable_http"},
      egressDomains:["mcp.notion.com"],
      tools:[{name:"notion.search", risk:"read", approvalTier:"read_only"}]
    }
  ]
' "$TMP_DIR/before.json" >/dev/null

PYTHONPATH="$REPO_ROOT/adapters/hermes" "$PYTHON_BIN" - "$TMP_DIR/before.json" <<'PY'
import json
import sys
from momo_adapter import MomoAdapter

with open(sys.argv[1], encoding="utf-8") as handle:
    response = json.load(handle)
policy = MomoAdapter._normalize_plugin_tool_policy(response)
assert len(policy["plugins"]) == 3, policy
serialized = json.dumps(policy, sort_keys=True).lower()
for forbidden in ("credential", "access_token", "refresh_token", "authorization", "password"):
    assert forbidden not in serialized, forbidden
PY

api DELETE "$NOTION_PATH/grants/notion:read" "$HUMAN_TOKEN" '' "$TMP_DIR/revoke-notion.json"
jq -e '.status == "revoked"' "$TMP_DIR/revoke-notion.json" >/dev/null
api GET "$POLICY_PATH" "$AGENT_TOKEN" '' "$TMP_DIR/after.json"
jq -e -s '
  .[1].toolPolicy.plugins ==
    [.[0].toolPolicy.plugins[] | select(.pluginId != "com.momo.plugins.notion")]
' "$TMP_DIR/before.json" "$TMP_DIR/after.json" >/dev/null

api DELETE "$LINEAR_PATH/grants/linear:read" "$HUMAN_TOKEN" '' "$TMP_DIR/revoke-linear.json"
jq -e '.status == "revoked"' "$TMP_DIR/revoke-linear.json" >/dev/null
api GET "$POLICY_PATH" "$AGENT_TOKEN" '' "$TMP_DIR/after-linear.json"
jq -e -s '
  .[1].toolPolicy.plugins ==
    [.[0].toolPolicy.plugins[] | select(.pluginId != "com.momo.plugins.linear")]
' "$TMP_DIR/after.json" "$TMP_DIR/after-linear.json" >/dev/null

api DELETE "$GITHUB_PATH/grants/github:read" "$HUMAN_TOKEN" '' "$TMP_DIR/revoke-github.json"
jq -e '.status == "revoked"' "$TMP_DIR/revoke-github.json" >/dev/null
api GET "$POLICY_PATH" "$AGENT_TOKEN" '' "$TMP_DIR/after-github.json"
jq -e '.toolPolicy.plugins == []' "$TMP_DIR/after-github.json" >/dev/null

echo "MOMO-458 GitHub/Notion/Linear grant Context Packet roundtrip PASS (no provider network call)"
