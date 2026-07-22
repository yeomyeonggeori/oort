#!/usr/bin/env bash
# MOMO-533 / ADR-0130 D3 work_tool_profile catalog, fail-closed spawn, workd projection, audit, and RLS gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[work-tool-profile] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq

find_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
        >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "[work-tool-profile] Python 3.10+ not found" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORK_TOOL_PROFILE_GATE_PROJECT:-momo533worktoolprofile}"
API_PORT="${WORK_TOOL_PROFILE_GATE_API_PORT:-28080}"
CENT_PORT_HOST="${WORK_TOOL_PROFILE_GATE_CENTRIFUGO_PORT:-28081}"
PG_PORT="${WORK_TOOL_PROFILE_GATE_POSTGRES_PORT:-28082}"
HERMES_PORT_HOST="${WORK_TOOL_PROFILE_GATE_HERMES_PORT:-28083}"
BOOT_TIMEOUT="${WORK_TOOL_PROFILE_GATE_BOOT_TIMEOUT:-2400}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-tool-profile.XXXXXX")"

# Preflight every newly assigned host port before compose can mutate runtime state.
"$PYTHON_BIN" - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket, sys
for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError as exc:
        raise SystemExit(f"[work-tool-profile] port {port} unavailable: {exc}")
    finally:
        sock.close()
PY

WS_ID="00000000-0000-7000-8000-000000000001"
CROSS_WS_ID="53300000-0000-7000-8000-000000000099"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
OWNER_ID="$(new_uuid)"
MEMBER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
RUN_SEED_ID="$(new_uuid)"
RUN_NEW_ID="$(new_uuid)"
RUN_DISABLED_ID="$(new_uuid)"
RUN_MISSING_ID="$(new_uuid)"
OWNER_EMAIL="work-tool-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
MEMBER_EMAIL="work-tool-member-$RUN_TAG@momo.local"
MEMBER_PASSWORD="member-$(new_uuid)"
HOST_PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORK_TOOL_PROFILE_GATE_KEEP:-0}" = "1" ]; then
    echo "[work-tool-profile] leaving compose project '$PROJECT' up"
    echo "[work-tool-profile] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-work-tool-profile.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[work-tool-profile] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[work-tool-profile] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-tool-profile] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-tool-profile] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql \
    -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Tool Profile Owner', 'wtp-owner-$RUN_TAG'),
  ('$MEMBER_ID', '$WS_ID', 'human', 'active', 'Tool Profile Member', 'wtp-member-$RUN_TAG'),
  ('$AGENT_ID', '$WS_ID', 'agent', 'active', 'Tool Profile Agent', 'wtp-agent-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$MEMBER_ID', '$WS_ID', '$MEMBER_EMAIL', true, momo_password_hash('$MEMBER_PASSWORD'), 'UTC');
INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES ('$AGENT_ID', '$WS_ID', 'hermes-agent', 'http://localhost:8088/v1',
        'MOMO-533 verifier', '$OWNER_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$MEMBER_ID', 'member'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WS_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$MEMBER_ID', 'member'),
  ('$WS_ID', '$AGENT_ID', 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_SEED_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running', '{}'::jsonb, 1, 50, 0, 'momo-533-seed-$RUN_TAG'),
  ('$RUN_NEW_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running', '{}'::jsonb, 1, 50, 0, 'momo-533-new-$RUN_TAG'),
  ('$RUN_DISABLED_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running', '{}'::jsonb, 1, 50, 0, 'momo-533-disabled-$RUN_TAG'),
  ('$RUN_MISSING_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running', '{}'::jsonb, 1, 50, 0, 'momo-533-missing-$RUN_TAG');
COMMIT;
SQL

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[work-tool-profile] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

login() {
  local email="$1" password="$2" output="$3"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$password" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" >"$output"
}
login "$OWNER_EMAIL" "$OWNER_PASSWORD" "$TMP_DIR/owner-login.json"
login "$MEMBER_EMAIL" "$MEMBER_PASSWORD" "$TMP_DIR/member-login.json"
OWNER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/owner-login.json")"
MEMBER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/member-login.json")"

PROFILE_PATH="/v1/workspaces/$WS_ID/work-tool-profiles"
api "$OWNER_TOKEN" GET "$PROFILE_PATH"
expect_status 200 "seed catalog list"
printf '%s' "$RESPONSE_BODY" | jq -e '
  [.workToolProfiles[] | select(.enabled) | .toolKey] == ["claude","codex","opencode","shell"]
  and all(.workToolProfiles[]; (.launchTemplate | keys) == ["arguments","command"])
  and all(.workToolProfiles[]; .envPolicy == {})
' >/dev/null

api "$MEMBER_TOKEN" GET "$PROFILE_PATH"
expect_status 403 "non-admin catalog list"

api "$OWNER_TOKEN" POST "$PROFILE_PATH" \
  '{"toolKey":"kimi","displayName":"Kimi","launchTemplate":{"command":"kimi","arguments":["--print"]},"tierDefaults":{"mode":"ask"},"envPolicy":{"mode":"allowlist","passthrough":["KIMI_HOME"]}}'
expect_status 201 "custom profile create"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.workToolProfile.toolKey == "kimi"
   and .workToolProfile.enabled == true
   and .workToolProfile.envPolicy == {"mode":"allowlist","passthrough":["KIMI_HOME"]}' >/dev/null

api "$OWNER_TOKEN" POST "$PROFILE_PATH" \
  '{"toolKey":"unsafe","displayName":"Unsafe","launchTemplate":{"command":"unsafe","arguments":["/tmp/secret"]}}'
expect_status 400 "absolute path rejection"
api "$OWNER_TOKEN" POST "$PROFILE_PATH" \
  '{"toolKey":"unsafe","displayName":"Unsafe","launchTemplate":{"command":"unsafe","arguments":["--api-key=secret"]}}'
expect_status 400 "credential argument rejection"
api "$OWNER_TOKEN" POST "$PROFILE_PATH" \
  '{"toolKey":"unsafe","displayName":"Unsafe","launchTemplate":{"command":"unsafe","arguments":[]},"envPolicy":{"passthrough":["GH_TOKEN=secret"]}}'
expect_status 400 "environment value rejection"
api "$OWNER_TOKEN" POST "$PROFILE_PATH" \
  '{"toolKey":"unsafe","displayName":"Unsafe","launchTemplate":{"command":"unsafe","arguments":[]},"envPolicy":{"passthrough":["MOMO_WORKD_SERVER_URL"]}}'
expect_status 400 "workd control environment rejection"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-hosts" \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
    '{scope:"member",type:"app",displayName:"MOMO-533 host",publicKey:$key,capabilities:{}}')"
expect_status 201 "work host registration"
HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase')"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-533 verifier"}'
expect_status 201 "agent bearer create"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"

spawn() {
  local run_id="$1" tool="$2"
  api "$AGENT_TOKEN" POST "/v1/workspaces/$WS_ID/work-controls" \
    "$(jq -cn --arg channel "$CHANNEL_ID" --arg run "$run_id" --arg host "$HOST_ID" \
      --arg tool "$tool" '{channelId:$channel,runId:$run,targetHostId:$host,kind:"spawn",payload:{tool:$tool,label:"MOMO-533"}}')"
}

spawn "$RUN_SEED_ID" codex
expect_status 201 "seed profile spawn"
spawn "$RUN_NEW_ID" kimi
expect_status 201 "custom profile spawn"

api "$OWNER_TOKEN" PUT "$PROFILE_PATH/kimi" '{"enabled":false}'
expect_status 200 "custom profile disable"
spawn "$RUN_DISABLED_ID" kimi
expect_status 400 "disabled profile spawn rejection"
spawn "$RUN_MISSING_ID" missing
expect_status 400 "missing profile spawn rejection"

# Start the actual workd bootstrap against the signed host-only GET projection.
# Successful exit proves registration, signed GET authentication, DTO decoding,
# and host-local command resolution without executing a provider CLI.
if [ ! -x "$REPO_ROOT/workers/WorkHostDaemon/.build/debug/momo-workd" ]; then
  (cd workers/WorkHostDaemon && swift build --disable-sandbox)
fi
MOMO_WORKD_SERVER_URL="$BASE_URL" \
MOMO_WORKD_ALLOW_INSECURE_HTTP=1 \
MOMO_WORKD_WORKSPACE_ID="$WS_ID" \
MOMO_WORKD_REGISTRATION_TOKEN="$OWNER_TOKEN" \
MOMO_WORKD_KEY_PATH="$TMP_DIR/workd.key" \
MOMO_WORKD_HOST_ID_PATH="$TMP_DIR/workd.host-id" \
MOMO_WORKD_OUTPUT_DIR="$TMP_DIR/workd-output" \
  "$REPO_ROOT/workers/WorkHostDaemon/.build/debug/momo-workd" --bootstrap-only \
  >"$TMP_DIR/workd.log" 2>&1
[ -s "$TMP_DIR/workd.host-id" ] || {
  sed -n '1,120p' "$TMP_DIR/workd.log" >&2
  echo "[work-tool-profile] FAIL workd signed projection bootstrap" >&2
  exit 1
}

got="$(sql_value <<SQL
BEGIN;
SET LOCAL app.workspace_id='$WS_ID';
SELECT
  (SELECT count(*) FROM work_tool_profile WHERE workspace_id='$WS_ID' AND tool_key IN ('claude','codex','opencode','shell'))
  || ':' ||
  (SELECT count(*) FROM work_tool_profile WHERE workspace_id='$WS_ID' AND tool_key='kimi' AND NOT enabled)
  || ':' ||
  (SELECT count(*) FROM audit_log WHERE workspace_id='$WS_ID' AND target_type='work_tool_profile'
     AND action IN ('work.tool_profile.created','work.tool_profile.updated'));
ROLLBACK;
SQL
)"
[ "$got" = "4:1:2" ] || {
  echo "[work-tool-profile] FAIL seed/disable/audit evidence: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO workspace (id, slug, name) VALUES ('$CROSS_WS_ID', 'momo-533-cross-$RUN_TAG', 'Cross Tenant');
INSERT INTO member (workspace_id, kind, status, display_name, handle)
VALUES ('$CROSS_WS_ID', 'human', 'active', 'Cross Owner', 'cross-$RUN_TAG');
INSERT INTO workspace_membership (workspace_id, member_id, role)
SELECT '$CROSS_WS_ID', id, 'owner' FROM member WHERE workspace_id='$CROSS_WS_ID';
SET LOCAL row_security = on;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$WS_ID';
SELECT
  (SELECT count(*) FROM work_tool_profile WHERE workspace_id='$CROSS_WS_ID')
  || ':' ||
  (SELECT count(*) FROM pg_class WHERE relname='work_tool_profile' AND relrowsecurity AND relforcerowsecurity)
  || ':' ||
  (SELECT count(*) FROM pg_policies WHERE tablename='work_tool_profile' AND policyname='ws_isolation');
ROLLBACK;
SQL
)"
[ "$got" = "0:1:1" ] || {
  echo "[work-tool-profile] FAIL cross-workspace RLS/FORCE/policy evidence: $got" >&2
  exit 1
}

echo "MOMO-533 work_tool_profile seed/custom/disabled/missing + workd projection + audit/RLS PASS"
