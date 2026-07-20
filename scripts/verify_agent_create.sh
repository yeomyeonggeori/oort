#!/usr/bin/env bash
# MOMO-509 / X-7 fresh-database admin agent creation verifier.
# Docker execution belongs to the orchestrator; workers run static checks only.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[agent-create] missing $1" >&2
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
  echo "[agent-create] Python 3.10+ not found" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
# A unique default project gives every invocation a new named volume, so the
# seed-none assertion always starts from a genuinely fresh PostgreSQL cluster.
PROJECT="${AGENT_CREATE_GATE_PROJECT:-momo509agentcreate-$RUN_TAG}"
API_PORT="${AGENT_CREATE_GATE_API_PORT:-27970}"
CENT_PORT_HOST="${AGENT_CREATE_GATE_CENTRIFUGO_PORT:-27971}"
PG_PORT="${AGENT_CREATE_GATE_POSTGRES_PORT:-27972}"
HERMES_PORT_HOST="${AGENT_CREATE_GATE_HERMES_PORT:-27973}"
BOOT_TIMEOUT="${AGENT_CREATE_GATE_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-create.XXXXXX")"
OVERRIDE_FILE="$TMP_DIR/agent-create.override.yml"

cat >"$OVERRIDE_FILE" <<'YAML'
services:
  migrate:
    environment:
      MOMO_AGENT_SEED_MODE: none
  api:
    environment:
      MOMO_ENV: local
      AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK: "1"
YAML

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
}

# Refuse a dirty/stale project and reserve all host ports before any compose
# mutation. This makes concurrent runtime-db gates fail closed, not collide.
if [ -n "$(compose ps -aq 2>/dev/null)" ]; then
  echo "[agent-create] compose project '$PROJECT' already exists; choose AGENT_CREATE_GATE_PROJECT" >&2
  exit 1
fi
"$PYTHON_BIN" - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket
import sys

ports = [int(value) for value in sys.argv[1:]]
if len(set(ports)) != len(ports):
    raise SystemExit(f"[agent-create] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[agent-create] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${AGENT_CREATE_GATE_KEEP:-0}" = "1" ]; then
    echo "[agent-create] leaving compose project '$PROJECT' up"
    echo "[agent-create] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-agent-create.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[agent-create] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[agent-create] booting isolated seed-none API stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api migrate db-roles >&2 || true
    echo "[agent-create] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[agent-create] api exited" >&2
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

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_WS_ID="$(new_uuid)"
ADMIN_ID="$(new_uuid)"
MEMBER_ID="$(new_uuid)"
ADMIN_EMAIL="agent-create-admin-$RUN_TAG@momo.local"
MEMBER_EMAIL="agent-create-member-$RUN_TAG@momo.local"
ADMIN_PASSWORD="admin-$(new_uuid)"
MEMBER_PASSWORD="member-$(new_uuid)"
AGENT_HANDLE="fresh-agent-$RUN_TAG"

fresh_agents="$(sql_value <<SQL
SELECT count(*) FROM member WHERE kind='agent';
SQL
)"
[ "$fresh_agents" = "0" ] || {
  echo "[agent-create] FAIL seed-none database contains $fresh_agents agent members" >&2
  exit 1
}

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$ADMIN_ID', '$WS_ID', 'human', 'active', 'Agent Create Admin', 'aca-$RUN_TAG'),
  ('$MEMBER_ID', '$WS_ID', 'human', 'active', 'Agent Create Member', 'acm-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$ADMIN_ID', '$WS_ID', '$ADMIN_EMAIL', true,
   momo_password_hash('$ADMIN_PASSWORD'), 'UTC'),
  ('$MEMBER_ID', '$WS_ID', '$MEMBER_EMAIL', true,
   momo_password_hash('$MEMBER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$ADMIN_ID', 'admin'),
  ('$WS_ID', '$CHANNEL_ID', '$MEMBER_ID', 'member');
COMMIT;
SQL

login() {
  local email="$1" password="$2"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$password" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
MEMBER_TOKEN="$(login "$MEMBER_EMAIL" "$MEMBER_PASSWORD")"

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
    echo "[agent-create] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
  echo "[agent-create] PASS $2 ($1)"
}

AGENTS_PATH="/v1/workspaces/$WS_ID/agents"
VALID_BODY="$(jq -cn \
  --arg display 'Fresh Hermes' \
  --arg handle "$AGENT_HANDLE" \
  --arg model 'hermes-agent' \
  --arg base "http://127.0.0.1:$HERMES_PORT_HOST/v1" \
  --arg prompt 'MOMO-509 fresh database verifier' \
  --arg owner "$ADMIN_ID" \
  '{displayName:$display,handle:$handle,model:$model,baseUrl:$base,
    systemPrompt:$prompt,config:{temperature:0.2,max_tokens:2048},ownerHumanId:$owner}')"

api "$MEMBER_TOKEN" POST "$AGENTS_PATH" "$VALID_BODY"
expect_status 403 "non-admin creation denial"

api "$ADMIN_TOKEN" POST "$AGENTS_PATH" \
  "$(printf '%s' "$VALID_BODY" | jq '.baseUrl="https://user:secret@provider.example/v1"')"
expect_status 400 "baseUrl userinfo credential rejection"

api "$ADMIN_TOKEN" POST "$AGENTS_PATH" \
  "$(printf '%s' "$VALID_BODY" | jq '.config.provider.apiKey="must-not-enter"')"
expect_status 400 "camelCase config credential field rejection"

api "$ADMIN_TOKEN" POST "$AGENTS_PATH" \
  "$(printf '%s' "$VALID_BODY" | jq '.baseUrl="http://provider.example/v1"')"
expect_status 400 "non-loopback plaintext provider rejection"

partial_count="$(sql_value <<SQL
SELECT (SELECT count(*) FROM member WHERE workspace_id='$WS_ID' AND handle='$AGENT_HANDLE')
     + (SELECT count(*) FROM agent WHERE workspace_id='$WS_ID' AND member_id IN
         (SELECT id FROM member WHERE workspace_id='$WS_ID' AND handle='$AGENT_HANDLE'))
     + (SELECT count(*) FROM audit_log WHERE workspace_id='$WS_ID'
          AND action='agent.created' AND detail->>'handle'='$AGENT_HANDLE');
SQL
)"
[ "$partial_count" = "0" ] || {
  echo "[agent-create] FAIL denied requests left $partial_count partial rows" >&2
  exit 1
}

api "$ADMIN_TOKEN" POST "$AGENTS_PATH" "$VALID_BODY"
expect_status 201 "admin agent creation"
printf '%s' "$RESPONSE_BODY" | jq -e --arg handle "$AGENT_HANDLE" '
  (keys == ["agent"])
  and (.agent | keys == ["displayName","handle","id"])
  and .agent.handle == $handle
  and .agent.displayName == "Fresh Hermes"
' >/dev/null
AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.agent.id | ascii_downcase')"

created_rows="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM member
    WHERE id='$AGENT_ID' AND workspace_id='$WS_ID' AND kind='agent'
      AND status='active' AND handle='$AGENT_HANDLE' AND display_name='Fresh Hermes')
  * (SELECT count(*) FROM agent
      WHERE member_id='$AGENT_ID' AND workspace_id='$WS_ID'
        AND model='hermes-agent'
        AND base_url='http://127.0.0.1:$HERMES_PORT_HOST/v1'
        AND system_prompt='MOMO-509 fresh database verifier'
        AND tool_schema='[]'::jsonb
        AND config='{"temperature":0.2,"max_tokens":2048}'::jsonb
        AND owner_human_id='$ADMIN_ID')
  * (SELECT count(*) FROM audit_log
      WHERE workspace_id='$WS_ID' AND actor_member_id='$ADMIN_ID'
        AND subject_member_id='$AGENT_ID' AND action='agent.created'
        AND target_type='agent' AND target_id='$AGENT_ID'
        AND detail->>'schema'='momo.agent.created.v1'
        AND detail->>'handle'='$AGENT_HANDLE'
        AND detail->>'channel_memberships_created'='0');
SQL
)"
[ "$created_rows" = "1" ] || {
  echo "[agent-create] FAIL atomic member/agent/audit assertion: $created_rows" >&2
  exit 1
}

automatic_memberships="$(sql_value <<SQL
SELECT count(*) FROM membership
 WHERE workspace_id='$WS_ID' AND member_id='$AGENT_ID' AND left_at IS NULL;
SQL
)"
[ "$automatic_memberships" = "0" ] || {
  echo "[agent-create] FAIL creation added $automatic_memberships channel memberships" >&2
  exit 1
}

api "$ADMIN_TOKEN" POST "$AGENTS_PATH" "$VALID_BODY"
expect_status 409 "workspace handle duplicate"
duplicate_rows="$(sql_value <<SQL
SELECT (SELECT count(*) FROM member WHERE workspace_id='$WS_ID' AND handle='$AGENT_HANDLE')
  || ':' || (SELECT count(*) FROM agent WHERE workspace_id='$WS_ID' AND member_id='$AGENT_ID')
  || ':' || (SELECT count(*) FROM audit_log WHERE workspace_id='$WS_ID'
               AND action='agent.created' AND subject_member_id='$AGENT_ID');
SQL
)"
[ "$duplicate_rows" = "1:1:1" ] || {
  echo "[agent-create] FAIL duplicate request changed atomic rows: $duplicate_rows" >&2
  exit 1
}

# Pairing stays explicit: reuse the existing channel-membership route, then the
# existing one-time credential issuance route. Agent creation does neither.
api "$ADMIN_TOKEN" POST "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/members" \
  "$(jq -cn --arg member "$AGENT_ID" '{memberId:$member,role:"member"}')"
expect_status 200 "existing channel membership path"
printf '%s' "$RESPONSE_BODY" | jq -e --arg member "$AGENT_ID" --arg channel "$CHANNEL_ID" '
  .membership.memberId == $member and .membership.channelId == $channel
  and .membership.role == "member" and .membership.leftAtMs == null
' >/dev/null

api "$ADMIN_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-509 verifier"}'
expect_status 201 "existing credential issuance path"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"
CREDENTIAL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential.id | ascii_downcase')"
printf '%s' "$RESPONSE_BODY" | jq -e --arg agent "$AGENT_ID" '
  .tokenType == "Bearer" and (.credential.agentMemberId | ascii_downcase) == $agent
  and .credential.status == "active"
' >/dev/null

pairing_rows="$(run_sql -v raw_token="$AGENT_TOKEN" -tA <<SQL
SELECT
  (SELECT count(*) FROM membership
    WHERE workspace_id='$WS_ID' AND channel_id='$CHANNEL_ID'
      AND member_id='$AGENT_ID' AND role='member' AND left_at IS NULL)
  * (SELECT count(*) FROM token
      WHERE id='$CREDENTIAL_ID' AND workspace_id='$WS_ID'
        AND actor_member_id='$AGENT_ID' AND kind='agent_bearer'
        AND token_hash=digest(:'raw_token', 'sha256') AND revoked_at IS NULL)
  * (SELECT count(*) FROM audit_log
      WHERE workspace_id='$WS_ID' AND action='agent.credential.issued'
        AND subject_member_id='$AGENT_ID' AND target_id='$CREDENTIAL_ID'
        AND position(:'raw_token' in detail::text)=0);
SQL
)"
pairing_rows="$(printf '%s' "$pairing_rows" | tr -d '[:space:]')"
[ "$pairing_rows" = "1" ] || {
  echo "[agent-create] FAIL explicit membership/credential/audit assertion: $pairing_rows" >&2
  exit 1
}

rls_rows="$(compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres psql \
  -h 127.0.0.1 -U momo_app -d "${POSTGRES_DB:-momo}" \
  -v ON_ERROR_STOP=1 --no-psqlrc -qtA <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$CROSS_WS_ID';
SELECT
  (SELECT count(*) FROM member WHERE id='$AGENT_ID')
  + (SELECT count(*) FROM agent WHERE member_id='$AGENT_ID')
  + (SELECT count(*) FROM membership WHERE member_id='$AGENT_ID')
  + (SELECT count(*) FROM token WHERE id='$CREDENTIAL_ID')
  + (SELECT count(*) FROM audit_log WHERE subject_member_id='$AGENT_ID');
ROLLBACK;
SQL
)"
rls_rows="$(printf '%s' "$rls_rows" | tr -d '[:space:]')"
[ "$rls_rows" = "0" ] || {
  echo "[agent-create] FAIL FORCE RLS exposed $rls_rows cross-workspace rows" >&2
  exit 1
}

echo "[agent-create] PASS fresh DB admin create, 409/403, pairing, credential, audit, and RLS"
