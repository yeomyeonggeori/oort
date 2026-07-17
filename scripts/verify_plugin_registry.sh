#!/usr/bin/env bash
# MOMO-410 / ADR-0113 SE-04A plugin registry runtime-db verifier.
# Docker execution belongs to momo-main; workers run bash -n only.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[plugin-reg] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${PLUGIN_GATE_PROJECT:-momo410plugins}"
API_PORT="${PLUGIN_GATE_PORT:-19800}"
PG_PORT="${PLUGIN_GATE_POSTGRES_PORT:-19801}"
CENT_PORT_HOST="${PLUGIN_GATE_CENT_PORT:-19802}"
HERMES_PORT_HOST="${PLUGIN_GATE_HERMES_PORT:-19803}"
BOOT_TIMEOUT="${PLUGIN_GATE_BOOT_TIMEOUT:-2400}"
RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-plugin-reg-$RUN_ID"
mkdir -p "$TMP_DIR"

DEMO_WS="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL="00000000-0000-7000-8000-000000000201"
WS_B="41000000-0000-7000-8000-000000000001"
OWNER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OWNER_EMAIL="plugin-owner-$RUN_ID@momo.local"
MEMBER_EMAIL="plugin-member-$RUN_ID@momo.local"
OTHER_EMAIL="plugin-other-$RUN_ID@momo.local"
OWNER_PASSWORD="plugin-$(uuidgen | tr '[:upper:]' '[:lower:]')"
MEMBER_PASSWORD="plugin-$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_PASSWORD="plugin-$(uuidgen | tr '[:upper:]' '[:lower:]')"
RAW_MARKER="raw-oauth-$(uuidgen | tr '[:upper:]' '[:lower:]')"
GITHUB="com.momo.plugins.github"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${PLUGIN_GATE_KEEP:-0}" = "1" ]; then
    echo "[plugin-reg] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[plugin-reg] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[plugin-reg] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[plugin-reg] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$DEMO_WS', 'human', 'active', 'Plugin Owner', 'plugin-owner-$RUN_EPOCH'),
  ('$MEMBER_ID', '$DEMO_WS', 'human', 'active', 'Plugin Member', 'plugin-member-$RUN_EPOCH');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$DEMO_WS', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$MEMBER_ID', '$DEMO_WS', '$MEMBER_EMAIL', true, momo_password_hash('$MEMBER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$DEMO_WS', '$GENERAL_CHANNEL', '$OWNER_ID', 'owner'),
  ('$DEMO_WS', '$GENERAL_CHANNEL', '$MEMBER_ID', 'member');

INSERT INTO workspace (id, slug, name)
VALUES ('$WS_B', 'momo-plugin-b-$RUN_EPOCH', 'Plugin Gate B');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$OTHER_ID', '$WS_B', 'human', 'active', 'Plugin Other', 'plugin-other-$RUN_EPOCH');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OTHER_ID', '$WS_B', '$OTHER_EMAIL', true, momo_password_hash('$OTHER_PASSWORD'), 'UTC');
COMMIT;

CREATE TABLE momo410_manifest_backup AS
SELECT plugin_id, manifest, manifest_digest, revoked_at FROM plugin_registry;
SQL

RESPONSE_STATUS=""
RESPONSE_BODY=""
api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[plugin-reg] FAIL $2: expected $1 got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
  echo "[plugin-reg] ok: $2 (HTTP $1)"
}
login() {
  local body
  body="$(jq -cn --arg e "$1" --arg p "$2" --arg w "${3:-}" \
    'if $w == "" then {email:$e,password:$p} else {email:$e,password:$p,workspace:$w} end')"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' -d "$body" |
    jq -r '.accessToken'
}

OWNER_ACCESS="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
MEMBER_ACCESS="$(login "$MEMBER_EMAIL" "$MEMBER_PASSWORD")"
OTHER_ACCESS="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD" "$WS_B")"
PLUGINS="/v1/workspaces/$DEMO_WS/plugins"
GITHUB_PATH="$PLUGINS/$GITHUB"

api GET "$PLUGINS" "" "$OWNER_ACCESS"
expect_status 200 "active member lists catalog"
[ "$(printf '%s' "$RESPONSE_BODY" | jq '.plugins | length')" = "5" ] || {
  echo "[plugin-reg] official catalog must contain five seeds after MOMO-457" >&2; exit 1; }
printf '%s' "$RESPONSE_BODY" | jq -e '
  [.plugins[].pluginId] | sort == ["com.momo.plugins.drive","com.momo.plugins.github","com.momo.plugins.linear","com.momo.plugins.notion","external_webhook"]
' >/dev/null
printf '%s' "$RESPONSE_BODY" | jq -e '
  ([.plugins[] | select(.recommended == true) | .pluginId] | sort) ==
    ["com.momo.plugins.drive","com.momo.plugins.github","external_webhook"] and
  ([.plugins[] | select(.recommended == false) | .pluginId] | sort) ==
    ["com.momo.plugins.linear","com.momo.plugins.notion"] and
  ([.plugins[] | has("recommended")] | all)
' >/dev/null

api GET "$GITHUB_PATH" "" "$OWNER_ACCESS"
expect_status 200 "catalog detail is readable"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.plugin.manifest.mcp.url')" = "https://api.githubcopilot.com/mcp/" ] || exit 1
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.plugin.manifest.momo.egressDomains[0]')" = "api.githubcopilot.com" ] || exit 1

api GET "$PLUGINS" "" "$OTHER_ACCESS"
expect_status 403 "cross-workspace JWT/path mismatch denied"

api POST "$GITHUB_PATH/install" '{"enabled":true}' "$MEMBER_ACCESS"
expect_status 403 "non-admin install denied"

got="$(printf "SELECT count(*) FROM plugin_capability_projection WHERE workspace_id='$DEMO_WS' AND plugin_id='$GITHUB';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[plugin-reg] projection exists without grant" >&2; exit 1; }

api POST "$GITHUB_PATH/install" '{"enabled":true}' "$OWNER_ACCESS"
expect_status 201 "owner installs and enables GitHub"
got="$(printf "SELECT count(*) FROM plugin_capability_projection WHERE workspace_id='$DEMO_WS' AND plugin_id='$GITHUB';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[plugin-reg] install alone projected capabilities" >&2; exit 1; }

grant_body="$(jq -cn --arg s 'github:read' --arg marker "$RAW_MARKER" '{scope:$s,accessToken:$marker}')"
api POST "$GITHUB_PATH/grants" "$grant_body" "$OWNER_ACCESS"
expect_status 201 "delegated user grants github:read"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.memberId')" = "$(printf '%s' "$OWNER_ID" | tr '[:lower:]' '[:upper:]')" ] || \
  [ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.memberId' | tr '[:upper:]' '[:lower:]')" = "$OWNER_ID" ] || exit 1
case "$RESPONSE_BODY" in *"$RAW_MARKER"*) echo "[plugin-reg] raw marker leaked in response" >&2; exit 1;; esac

got="$(printf "SELECT count(*) FROM plugin_capability_projection WHERE workspace_id='$DEMO_WS' AND member_id='$OWNER_ID' AND plugin_id='$GITHUB' AND scope='github:read';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[plugin-reg] expected one projected capability, got $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM plugin_grant WHERE workspace_id='$DEMO_WS' AND member_id='$OWNER_ID' AND plugin_id='$GITHUB' AND scope='github:read' AND status='active' AND granted_audit_id IS NOT NULL;\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[plugin-reg] four-tuple grant/audit missing" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM audit_log WHERE action IN ('plugin.installed','plugin.grant.created') AND actor_member_id='$OWNER_ID';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[plugin-reg] install/grant audit rows missing" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM plugin_registry WHERE manifest::text LIKE '%%$RAW_MARKER%%'; SELECT count(*) FROM audit_log WHERE detail::text LIKE '%%$RAW_MARKER%%';\n" | run_sql -tA | tr '\n' ':')"
[ "$got" = "0:0:" ] || { echo "[plugin-reg] raw credential marker persisted" >&2; exit 1; }

api DELETE "$GITHUB_PATH/grants/github:read" "" "$OWNER_ACCESS"
expect_status 200 "delegated user revokes own grant"
got="$(printf "SELECT count(*) FROM plugin_capability_projection WHERE workspace_id='$DEMO_WS' AND plugin_id='$GITHUB';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[plugin-reg] revoke-grant did not invalidate projection" >&2; exit 1; }

api POST "$GITHUB_PATH/grants" '{"scope":"github:read"}' "$OWNER_ACCESS"
expect_status 200 "revoked four-tuple can be re-granted"
api DELETE "$GITHUB_PATH/install" "" "$OWNER_ACCESS"
expect_status 200 "owner revokes install"
got="$(printf "SELECT count(*) FROM plugin_capability_projection WHERE workspace_id='$DEMO_WS' AND plugin_id='$GITHUB';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[plugin-reg] install revoke did not invalidate projection" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM plugin_grant WHERE workspace_id='$DEMO_WS' AND plugin_id='$GITHUB' AND status='active';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[plugin-reg] install revoke left active grants" >&2; exit 1; }

restore_registry() {
  run_sql <<SQL
UPDATE plugin_registry p
   SET manifest = b.manifest,
       manifest_digest = b.manifest_digest,
       revoked_at = b.revoked_at,
       updated_at = now()
  FROM momo410_manifest_backup b
 WHERE p.plugin_id = b.plugin_id;
SQL
}
mutate_field() {
  local path="$1" value="$2"
  run_sql -v path="$path" -v value="$value" <<'SQL'
WITH changed AS (
  SELECT plugin_id, jsonb_set(manifest, :'path'::text[], :'value'::jsonb) AS manifest
    FROM plugin_registry WHERE plugin_id = 'com.momo.plugins.github'
)
UPDATE plugin_registry p
   SET manifest = c.manifest,
       manifest_digest = 'sha256:' || encode(sha256(convert_to(c.manifest::text, 'UTF8')), 'hex'),
       revoked_at = NULL
  FROM changed c WHERE p.plugin_id = c.plugin_id;
SQL
}
expect_manifest_rejected() {
  api POST "$GITHUB_PATH/install" '{"enabled":true}' "$OWNER_ACCESS"
  expect_status 409 "$1"
  restore_registry
}

mutate_field '{mcp,protocolVersion}' '"2099-01-01"'
expect_manifest_rejected "unknown protocol rejected"
mutate_field '{mcp,tools,0,risk}' '"future-risk"'
expect_manifest_rejected "unknown risk rejected"
mutate_field '{mcp,tools,0,approvalPolicy}' '"maybe"'
expect_manifest_rejected "unknown approval policy rejected"
mutate_field '{mcp,tools,0,inputSchema,additionalProperties}' 'true'
expect_manifest_rejected "open/unknown tool schema rejected"
mutate_field '{plugin,license,spdx}' '"GPL-3.0-only"'
expect_manifest_rejected "GPL SPDX rejected"

run_sql <<SQL
WITH changed AS (
  SELECT plugin_id, manifest - 'momo' AS manifest
    FROM plugin_registry WHERE plugin_id = '$GITHUB'
)
UPDATE plugin_registry p
   SET manifest = c.manifest,
       manifest_digest = 'sha256:' || encode(sha256(convert_to(c.manifest::text, 'UTF8')), 'hex')
  FROM changed c WHERE p.plugin_id = c.plugin_id;
SQL
expect_manifest_rejected "malformed/missing manifest field rejected"

run_sql -c "UPDATE plugin_registry SET manifest_digest='sha256:$(printf '0%.0s' {1..64})' WHERE plugin_id='$GITHUB'"
expect_manifest_rejected "digest mismatch rejected"
run_sql -c "UPDATE plugin_registry SET revoked_at=now() WHERE plugin_id='$GITHUB'"
expect_manifest_rejected "revoked catalog entry rejected"

# Review #435 M2: the projection RLS assertion is only meaningful while a
# grant is ACTIVE — the registry was left revoked by the last rejection case
# and install/grant were revoked earlier, so a zero-row projection would pass
# vacuously. Restore the registry entry and re-run the real REST install +
# grant so all three tenant tables carry a live DEMO_WS row when tenant B looks.
restore_registry
api POST "$GITHUB_PATH/install" '{"enabled":true}' "$OWNER_ACCESS"
expect_status 200 "re-install before RLS assertion"
api POST "$GITHUB_PATH/grants" '{"scope":"github:read"}' "$OWNER_ACCESS"
expect_status 200 "re-grant before RLS assertion"
got="$(printf "SELECT count(*) FROM plugin_capability_projection WHERE workspace_id='$DEMO_WS' AND plugin_id='$GITHUB';\n" | sql_scalar)"
[ "$got" != "0" ] || { echo "[plugin-reg] expected a live projection before the RLS assertion" >&2; exit 1; }
run_sql <<SQL
SET ROLE momo_app;
BEGIN;
SELECT set_config('app.workspace_id', '$WS_B', true);
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM workspace_plugin_install WHERE workspace_id = '$DEMO_WS';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace install leaked across RLS: %', got; END IF;
  SELECT count(*) INTO got FROM plugin_grant WHERE workspace_id = '$DEMO_WS';
  IF got <> 0 THEN RAISE EXCEPTION 'plugin grant leaked across RLS: %', got; END IF;
  SELECT count(*) INTO got FROM plugin_capability_projection WHERE workspace_id = '$DEMO_WS';
  IF got <> 0 THEN RAISE EXCEPTION 'capability projection leaked across RLS: %', got; END IF;
END \$\$;
COMMIT;
RESET ROLE;
DROP TABLE momo410_manifest_backup;
SQL

echo
echo "MOMO-410 plugin registry verification PASS"
echo "- official seeds: GitHub/Notion/Linear endpoints + external_webhook registry marker"
echo "- validator: protocol/risk/approval/SPDX/malformed/digest/revoked fail closed"
echo "- runtime: install -> grant -> revoke-grant -> re-grant -> revoke-install, same-tx audit, immediate projection invalidation"
echo "- custody A: raw marker absent from tables, responses, and audit detail; tenant tables FORCE RLS isolated"
