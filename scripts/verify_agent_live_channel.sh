#!/usr/bin/env bash
# =============================================================================
# scripts/verify_agent_live_channel.sh — MOMO-212 agent: live subscription gate
#
# Prereq:
#   make up
#   make migrate
#
# Verifies the agent realtime boundary against the Docker Desktop dev stack,
# while owning an isolated migrated database and marker-bound runtime roles:
#   realtime-token -> Centrifugo WebSocket subscribe(agent:)
#   -> AgentWorker/mock-Hermes direct server publish -> live agent.status/partial
#   publication received by the authorized subscriber.
#
# Negative evidence:
#   - invalid Centrifugo connection token is rejected
#   - same-workspace member with no shared channel cannot subscribe
#   - different-workspace member/token cannot subscribe
#   - client direct publish to agent: is rejected
#
# The source dogfood database is read only: its agent queue/run/approval/message
# digest must match before and after both successful and failed verifier runs.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/runtime_process_guard.sh
. "$REPO_ROOT/scripts/runtime_process_guard.sh"

fail() {
  echo "[agent-live] FAIL: $*" >&2
  for log in "${SERVER_LOG:-}" "${WORKER_LOG:-}" "${RELAY_LOG:-}" "${MOCK_LOG:-}" "${PROXY_LOG:-}" "${PY_LOG:-}"; do
    if [ "$log" != "" ] && [ -f "$log" ]; then
      echo "[agent-live] log: $log" >&2
      tail -160 "$log" >&2 || true
    fi
  done
  exit 1
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

ENV_FILE="${ENV_FILE:-}"
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE="$candidate"
      break
    fi
  done
fi

if [ "$ENV_FILE" != "" ] && [ -f "$ENV_FILE" ]; then
  ENV_FILE="$ENV_FILE" bash "$REPO_ROOT/scripts/ensure_runtime_env.sh" >/dev/null
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

require_bin curl
require_bin docker
require_bin jq
require_bin python3
require_bin swift
require_bin uuidgen

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  fail "psql not found; install PostgreSQL client/libpq and retry"
fi

PORT="${PORT:-8080}"
CENT_PORT="${CENT_PORT:-8000}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_USER="${POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-momo_dev_pw}"
SOURCE_POSTGRES_DB="${POSTGRES_DB:-momo}"
POSTGRES_DB="${AGENT_LIVE_VERIFIER_DB:-momo_agent_live_verify_${POSTGRES_PORT}_$$}"
VERIFIER_DB_MARKER_PREFIX="momo:agent-live-verifier:v1:"
VERIFIER_DB_MARKER="${VERIFIER_DB_MARKER_PREFIX}$(python3 -c 'import uuid; print(uuid.uuid4())')"
VERIFIER_DB_CREATED_OID=""
VERIFIER_DB_OWNED=0
SOURCE_DIGEST_ARMED=0
ROLE_SUFFIX="$(printf '%s' "$VERIFIER_DB_MARKER" | shasum -a 256 | cut -c 1-12)"
VERIFIER_APP_ROLE="momo_live_${ROLE_SUFFIX}_app"
VERIFIER_WORKER_ROLE="momo_live_${ROLE_SUFFIX}_worker"
VERIFIER_RELAY_ROLE="momo_live_${ROLE_SUFFIX}_relay"
VERIFIER_APP_PASSWORD="momo_live_verify_app_pw"
VERIFIER_WORKER_PASSWORD="momo_live_verify_worker_pw"
VERIFIER_RELAY_PASSWORD="momo_live_verify_relay_pw"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-momo}"
COMPOSE_NETWORK="${COMPOSE_PROJECT_NAME}_default"
CENT_API_KEY="${CENT_API_KEY:-dev-insecure-cent-api-key}"
CENT_API_URL="${CENT_API_URL:-http://localhost:${CENT_PORT}/api}"
case "$CENT_API_URL" in
  *centrifugo*) CENT_API_URL="http://localhost:${CENT_PORT}/api" ;;
esac
JWT_HMAC="${JWT_HMAC:-dev-insecure-jwt-hmac-change-me}"
CENT_TOKEN_HMAC="${CENT_TOKEN_HMAC:-dev-insecure-cent-token-hmac}"
# MOMO-300: must match the dev compose Centrifugo static proxy header.
CENT_PROXY_SECRET="${CENT_PROXY_SECRET:-dev-insecure-cent-proxy-secret}"
HERMES_PORT="${HERMES_PORT:-8088}"
HERMES_API_KEY="${HERMES_API_KEY:-dev-insecure-hermes-bearer}"
HERMES_BASE_URL="${HERMES_BASE_URL:-http://localhost:${HERMES_PORT}/v1}"
WORKER_POLL_INTERVAL_MS="${WORKER_POLL_INTERVAL_MS:-100}"

SOURCE_DATABASE_URL="${DATABASE_URL:-}"
ADMIN_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
APP_DATABASE_URL="postgres://${VERIFIER_APP_ROLE}:${VERIFIER_APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
WORKER_DATABASE_URL="postgres://${VERIFIER_WORKER_ROLE}:${VERIFIER_WORKER_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
RELAY_DATABASE_URL="postgres://${VERIFIER_RELAY_ROLE}:${VERIFIER_RELAY_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
RELAY_POLL_INTERVAL_MS="${RELAY_POLL_INTERVAL_MS:-100}"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
CROSS_CHANNEL_ID="00000000-0000-7212-8000-000000000299"
HUMAN_ID="00000000-0000-7000-8000-000000000101"
HUMAN_EMAIL="demo@momo.local"
AGENT_ID="00000000-0000-7000-8000-000000000102"
NO_SHARED_MEMBER_ID="00000000-0000-7000-8000-000000212101"
NO_SHARED_EMAIL="momo-212-no-shared@momo.local"
OTHER_WORKSPACE_ID="00000000-0000-7000-8000-000000212201"
OTHER_MEMBER_ID="00000000-0000-7000-8000-000000212202"
OTHER_EMAIL="momo-212-other@momo.local"
AGENT_CHANNEL="agent:ws${WORKSPACE_ID}.${CHANNEL_ID}.${AGENT_ID}"
AGENT_WORK_CHANNEL="agentwork:ws${WORKSPACE_ID}.${AGENT_ID}"
RUN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MESSAGE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
CROSS_RUN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"

TMP_ROOT="${TMPDIR:-/tmp}"
SERVER_LOG="${TMP_ROOT}/momo-agent-live-server-${RUN_SUFFIX}.log"
WORKER_LOG="${TMP_ROOT}/momo-agent-live-worker-${RUN_SUFFIX}.log"
RELAY_LOG="${TMP_ROOT}/momo-agent-live-relay-${RUN_SUFFIX}.log"
MOCK_LOG="${TMP_ROOT}/momo-agent-live-mock-hermes-${RUN_SUFFIX}.log"
PROXY_LOG="${TMP_ROOT}/momo-agent-live-api-proxy-${RUN_SUFFIX}.log"
PY_LOG="${TMP_ROOT}/momo-agent-live-ws-${RUN_SUFFIX}.log"
LIVE_JSON="${TMP_ROOT}/momo-agent-live-publication-${RUN_SUFFIX}.json"
EVIDENCE_FILE="${TMP_ROOT}/momo-agent-live-evidence-${RUN_SUFFIX}.md"
SERVER_PID=""
WORKER_PID=""
RELAY_PID=""
MOCK_PID=""
PROXY_CONTAINER="momo-agent-live-api-proxy-${RUN_SUFFIX}"

admin_scalar() {
  local output
  output="$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc -c "$1")" || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

source_digest() {
  local output
  output="$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$SOURCE_POSTGRES_DB" \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
SELECT encode(digest(concat_ws('|',
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM outbox t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM agent_run t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM approval t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM approval_decision t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM usage_ledger t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM budget_window t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM audit_log t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM message t)
), 'sha256'), 'hex');
SQL
  )" || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

validate_admin_target() {
  case "$POSTGRES_HOST" in
    localhost|127.0.0.1|::1) ;;
    *) fail "destructive verifier DB target must be loopback: $POSTGRES_HOST" ;;
  esac
  if [ "$SOURCE_DATABASE_URL" != "" ]; then
    python3 - "$SOURCE_DATABASE_URL" "$POSTGRES_HOST" "$POSTGRES_PORT" "$SOURCE_POSTGRES_DB" <<'PY'
import sys
from urllib.parse import urlparse

url, expected_host, expected_port, expected_db = sys.argv[1:]
parsed = urlparse(url)
host = parsed.hostname or ""
port = parsed.port or 5432
database = parsed.path.lstrip("/")
loopback = {"localhost", "127.0.0.1", "::1"}
if host not in loopback or expected_host not in loopback:
    raise SystemExit("[agent-live] DATABASE_URL and admin target must both be loopback")
if port != int(expected_port) or database != expected_db:
    raise SystemExit("[agent-live] DATABASE_URL source does not match admin port/database")
PY
  fi
}

provision_verifier_database() {
  local exists
  case "$POSTGRES_DB" in
    ''|*[!a-zA-Z0-9_]*|"$SOURCE_POSTGRES_DB"|postgres|template0|template1)
      fail "refusing unsafe verifier database target: $POSTGRES_DB"
      ;;
  esac
  exists="$(admin_scalar "SELECT count(*) FROM pg_database WHERE datname = '$POSTGRES_DB';")"
  [ "$exists" = "0" ] || fail "refusing pre-existing verifier database: $POSTGRES_DB"

  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -v ON_ERROR_STOP=1 --no-psqlrc -c "CREATE DATABASE \"$POSTGRES_DB\";"
  VERIFIER_DB_OWNED=1
  VERIFIER_DB_CREATED_OID="$(admin_scalar "SELECT oid FROM pg_database WHERE datname = '$POSTGRES_DB';")"
  [ "$VERIFIER_DB_CREATED_OID" != "" ] || fail "failed to capture verifier DB OID"
  if [ "${AGENT_LIVE_VERIFIER_TEST_FAIL_COMMENT:-0}" = "1" ]; then
    echo "[agent-live] intentional verifier COMMENT failure (test only)" >&2
    exit 96
  fi
  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -v ON_ERROR_STOP=1 -v marker="$VERIFIER_DB_MARKER" --no-psqlrc <<SQL
COMMENT ON DATABASE "$POSTGRES_DB" IS :'marker';
SQL

  ENV_FILE=/dev/null DATABASE_URL= \
    PGHOST="$POSTGRES_HOST" PGPORT="$POSTGRES_PORT" PGDATABASE="$POSTGRES_DB" \
    PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
    "$REPO_ROOT/scripts/migrate.sh" >/dev/null

  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -v ON_ERROR_STOP=1 -v marker="$VERIFIER_DB_MARKER" --no-psqlrc <<SQL
BEGIN;
CREATE ROLE $VERIFIER_APP_ROLE LOGIN PASSWORD '$VERIFIER_APP_PASSWORD';
CREATE ROLE $VERIFIER_WORKER_ROLE LOGIN PASSWORD '$VERIFIER_WORKER_PASSWORD';
CREATE ROLE $VERIFIER_RELAY_ROLE LOGIN PASSWORD '$VERIFIER_RELAY_PASSWORD';
COMMENT ON ROLE $VERIFIER_APP_ROLE IS :'marker';
COMMENT ON ROLE $VERIFIER_WORKER_ROLE IS :'marker';
COMMENT ON ROLE $VERIFIER_RELAY_ROLE IS :'marker';
ALTER ROLE $VERIFIER_APP_ROLE WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE $VERIFIER_WORKER_ROLE WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
ALTER ROLE $VERIFIER_RELAY_ROLE WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO $VERIFIER_APP_ROLE, $VERIFIER_WORKER_ROLE, $VERIFIER_RELAY_ROLE;
COMMIT;
SQL

  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc <<SQL
GRANT USAGE ON SCHEMA public TO $VERIFIER_APP_ROLE, $VERIFIER_WORKER_ROLE, $VERIFIER_RELAY_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $VERIFIER_APP_ROLE, $VERIFIER_WORKER_ROLE, $VERIFIER_RELAY_ROLE;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $VERIFIER_APP_ROLE, $VERIFIER_WORKER_ROLE, $VERIFIER_RELAY_ROLE;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO $VERIFIER_APP_ROLE, $VERIFIER_WORKER_ROLE, $VERIFIER_RELAY_ROLE;
SQL
}

cleanup_verifier_database() {
  local current_oid current_marker role role_marker
  [ "$VERIFIER_DB_OWNED" = "1" ] || return 0
  current_oid="$(admin_scalar "SELECT COALESCE(oid::text, '') FROM pg_database WHERE datname = '$POSTGRES_DB';")" || return 1
  current_marker="$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$POSTGRES_DB';")" || return 1
  if [ "$current_oid" != "$VERIFIER_DB_CREATED_OID" ] \
    || { [ "$current_marker" != "$VERIFIER_DB_MARKER" ] && [ "$current_marker" != "" ]; }; then
    echo "[agent-live] refusing verifier cleanup: DB identity changed" >&2
    return 1
  fi
  for role in "$VERIFIER_APP_ROLE" "$VERIFIER_WORKER_ROLE" "$VERIFIER_RELAY_ROLE"; do
    role_marker="$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '$role';")" || return 1
    if [ "$role_marker" = "$VERIFIER_DB_MARKER" ]; then
      PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
        -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 --no-psqlrc \
        -c "ALTER ROLE \"$role\" NOLOGIN;" >/dev/null || return 1
    fi
  done
  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE);" >/dev/null || return 1
  for role in "$VERIFIER_APP_ROLE" "$VERIFIER_WORKER_ROLE" "$VERIFIER_RELAY_ROLE"; do
    role_marker="$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '$role';")" || return 1
    if [ "$role_marker" = "$VERIFIER_DB_MARKER" ]; then
      PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
        -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 --no-psqlrc \
        -c "DROP ROLE \"$role\";" >/dev/null || return 1
    fi
  done
  VERIFIER_DB_OWNED=0
}

cleanup() {
  local original_rc=$?
  local cleanup_failed=0
  local source_after
  trap - EXIT
  if [ "${ACCESS_TOKEN:-}" != "" ] && [ "${AGENT_CREDENTIAL_ID:-}" != "" ]; then
    api_request POST \
      "/v1/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/credentials/${AGENT_CREDENTIAL_ID}/revoke" \
      "$ACCESS_TOKEN" '{"reason":"MOMO-338 agentwork websocket verifier"}' \
      >/dev/null 2>&1 || true
  fi
  momo_cleanup_tracked_pids "agent-live verifier" "${WORKER_PID:-}" "${RELAY_PID:-}" "${SERVER_PID:-}" "${MOCK_PID:-}"
  docker rm -f "$PROXY_CONTAINER" >/dev/null 2>&1 || true
  if [ "$SOURCE_DIGEST_ARMED" = "1" ]; then
    source_after="$(source_digest)" || cleanup_failed=1
    if [ "$cleanup_failed" = "0" ] && [ "$source_after" != "$SOURCE_DIGEST_BEFORE" ]; then
      echo "[agent-live] source dogfood DB changed while isolated verifier ran" >&2
      cleanup_failed=1
    elif [ "$cleanup_failed" = "0" ]; then
      echo "[agent-live] source dogfood DB digest preserved"
    fi
  fi
  cleanup_verifier_database || {
    echo "[agent-live] exact verifier DB cleanup failed" >&2
    cleanup_failed=1
  }
  if [ "$original_rc" = "0" ] && [ "$cleanup_failed" = "1" ]; then
    original_rc=1
  fi
  exit "$original_rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_http() {
  local url="$1"
  local name="$2"
  local deadline
  deadline=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl --max-time 2 -fsS "$url" >/dev/null 2>&1; then
      echo "[agent-live] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not become ready: ${url}"
}

wait_tcp() {
  local host="$1"
  local port="$2"
  local name="$3"
  local deadline
  deadline=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys
with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=2):
    pass
PY
    then
      echo "[agent-live] ${name} ready: ${host}:${port}"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not open TCP port: ${host}:${port}"
}

wait_log_pattern() {
  local file="$1"
  local pattern="$2"
  local name="$3"
  local pid="${4:-}"
  local deadline
  deadline=$(($(date +%s) + 180))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$pid" != "" ] && ! kill -0 "$pid" 2>/dev/null; then
      fail "${name} exited before readiness pattern: ${pattern}"
    fi
    if [ -f "$file" ] && grep -Eq "$pattern" "$file"; then
      echo "[agent-live] ${name} ready"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not log readiness pattern: ${pattern}"
}

wait_container_log_pattern() {
  local container="$1"
  local file="$2"
  local pattern="$3"
  local name="$4"
  local deadline
  deadline=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    docker logs "$container" >"$file" 2>&1 || true
    if grep -Eq "$pattern" "$file"; then
      echo "[agent-live] ${name} ready"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not log readiness pattern: ${pattern}"
}

psql_admin() {
  "$PSQL_BIN" "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

# Request metadata and credentials travel through stdin, never process argv.
api_request() {
  local method="$1"
  local path="$2"
  local bearer="${3:-}"
  local body="${4:-}"
  printf '%s\0%s\0%s\0%s' \
    "http://127.0.0.1:${PORT}${path}" "$method" "$bearer" "$body" | python3 -c '
import sys
import urllib.error
import urllib.request

parts = sys.stdin.buffer.read().split(b"\0", 3)
if len(parts) != 4:
    raise SystemExit(2)
url, method, bearer, body = (part.decode("utf-8") for part in parts)
headers = {"Accept": "application/json"}
if bearer:
    headers["Authorization"] = "Bearer " + bearer
data = None
if body:
    headers["Content-Type"] = "application/json"
    data = body.encode("utf-8")
request = urllib.request.Request(url, data=data, headers=headers, method=method)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        sys.stdout.buffer.write(response.read())
except urllib.error.HTTPError as exc:
    sys.stderr.write(f"momo API request failed: HTTP {exc.code}\n")
    raise SystemExit(22)
'
}

api_status() {
  local method="$1"
  local path="$2"
  local bearer="${3:-}"
  local body="${4:-}"
  printf '%s\0%s\0%s\0%s' \
    "http://127.0.0.1:${PORT}${path}" "$method" "$bearer" "$body" | python3 -c '
import sys
import urllib.error
import urllib.request
url, method, bearer, body = (
    part.decode("utf-8") for part in sys.stdin.buffer.read().split(b"\0", 3)
)
headers = {"Accept": "application/json"}
if bearer:
    headers["Authorization"] = "Bearer " + bearer
data = None
if body:
    headers["Content-Type"] = "application/json"
    data = body.encode("utf-8")
request = urllib.request.Request(url, data=data, headers=headers, method=method)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        print(response.status)
except urllib.error.HTTPError as exc:
    print(exc.code)
'
}

login() {
  local email="$1"
  local workspace="$2"
  api_request POST /v1/auth/login "" \
    "{\"email\":\"${email}\",\"password\":\"dev-password\",\"workspace\":\"${workspace}\"}"
}

realtime_token() {
  local access_token="$1"
  api_request POST /v1/auth/realtime-token "$access_token" '{}'
}

echo "[agent-live] using env file: ${ENV_FILE:-<none>}"
echo "[agent-live] compose project=${COMPOSE_PROJECT_NAME} api port=${PORT} centrifugo port=${CENT_PORT} postgres port=${POSTGRES_PORT}"
momo_cleanup_runtime_ports "agent-live verifier preflight" "$PORT" "$HERMES_PORT" || {
  fail "agent-live verifier ports are occupied by non-momo processes; stop them or choose PORT/HERMES_PORT overrides"
}
wait_tcp "127.0.0.1" "$CENT_PORT" "Centrifugo"

validate_admin_target
SOURCE_DIGEST_BEFORE="$(source_digest)"
SOURCE_DIGEST_ARMED=1
echo "[agent-live] provisioning isolated verifier database: $POSTGRES_DB"
provision_verifier_database

echo "[agent-live] seeding deterministic authorized and unauthorized fixtures"
psql_admin <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

INSERT INTO workspace (id, slug, name)
VALUES ('$WORKSPACE_ID', 'agent-live-verifier', 'Agent Live Verifier Workspace')
ON CONFLICT (id) DO UPDATE
  SET deleted_at = NULL,
      name = EXCLUDED.name;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$HUMAN_ID', '$WORKSPACE_ID', 'human', 'active',
   'Agent Live Human', 'agent-live-human'),
  ('$AGENT_ID', '$WORKSPACE_ID', 'agent', 'active',
   'Agent Live Agent', 'agent-live-agent')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle,
      deleted_at = NULL;

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$HUMAN_ID', '$WORKSPACE_ID', '$HUMAN_EMAIL', true,
        momo_password_hash('dev-password'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
  SET email = EXCLUDED.email,
      email_verified = true,
      password_hash = EXCLUDED.password_hash,
      tz = EXCLUDED.tz;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('$AGENT_ID', '$WORKSPACE_ID', 'hermes-agent', '$HERMES_BASE_URL',
        'Agent live channel verifier fixture', '$HUMAN_ID', 1, 12)
ON CONFLICT (member_id) DO UPDATE
  SET model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      system_prompt = EXCLUDED.system_prompt,
      owner_human_id = EXCLUDED.owner_human_id,
      max_concurrent_runs = EXCLUDED.max_concurrent_runs,
      max_run_steps = EXCLUDED.max_run_steps;

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, archived_at)
VALUES ('$CHANNEL_ID', '$WORKSPACE_ID', 'public', 'agent-live-verifier',
        'Exact-channel agent progress verifier fixture', '$HUMAN_ID', NULL)
ON CONFLICT (id) DO UPDATE
  SET archived_at = NULL,
      topic = EXCLUDED.topic,
      updated_at = now();

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('$CHANNEL_ID', '$WORKSPACE_ID', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role, left_at)
VALUES
  ('00000000-0000-7000-8000-000000000303', '$WORKSPACE_ID',
   '$CHANNEL_ID', '$HUMAN_ID', 'owner', NULL),
  ('00000000-0000-7000-8000-000000000304', '$WORKSPACE_ID',
   '$CHANNEL_ID', '$AGENT_ID', 'member', NULL)
ON CONFLICT (channel_id, member_id)
DO UPDATE SET role = EXCLUDED.role, left_at = NULL;

INSERT INTO workspace (id, slug, name)
VALUES ('$OTHER_WORKSPACE_ID', 'momo-212-other', 'MOMO-212 Other Workspace')
ON CONFLICT (id) DO NOTHING;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$NO_SHARED_MEMBER_ID', '$WORKSPACE_ID', 'human', 'active',
   'MOMO-212 No Shared Channel', 'momo-212-no-shared'),
  ('$OTHER_MEMBER_ID', '$OTHER_WORKSPACE_ID', 'human', 'active',
   'MOMO-212 Other Workspace', 'momo-212-other')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle,
      deleted_at = NULL;

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$NO_SHARED_MEMBER_ID', '$WORKSPACE_ID', '$NO_SHARED_EMAIL', true, momo_password_hash('dev-password'), 'UTC'),
  ('$OTHER_MEMBER_ID', '$OTHER_WORKSPACE_ID', '$OTHER_EMAIL', true, momo_password_hash('dev-password'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
  SET email = EXCLUDED.email,
      email_verified = EXCLUDED.email_verified,
      password_hash = EXCLUDED.password_hash,
      tz = EXCLUDED.tz;

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, archived_at)
VALUES
  ('$CROSS_CHANNEL_ID', '$WORKSPACE_ID', 'private',
   'momo-212-cross-channel', 'Exact-channel progress isolation fixture',
   '00000000-0000-7000-8000-000000000101', NULL)
ON CONFLICT (id) DO UPDATE
  SET archived_at = NULL,
      topic = EXCLUDED.topic,
      updated_at = now();

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('$CROSS_CHANNEL_ID', '$WORKSPACE_ID', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role, left_at)
VALUES
  ('00000000-0000-7212-8000-000000000399', '$WORKSPACE_ID',
   '$CROSS_CHANNEL_ID', '$NO_SHARED_MEMBER_ID', 'member', NULL),
  ('00000000-0000-7212-8000-000000000400', '$WORKSPACE_ID',
   '$CROSS_CHANNEL_ID', '$AGENT_ID', 'member', NULL)
ON CONFLICT (channel_id, member_id)
DO UPDATE SET left_at = NULL;

COMMIT;
SQL

echo "[agent-live] starting MomoServer on host"
(
  cd "$REPO_ROOT"
  DATABASE_URL="$APP_DATABASE_URL" \
  HOST="127.0.0.1" \
  PORT="$PORT" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  JWT_HMAC="$JWT_HMAC" \
  CENT_TOKEN_HMAC="$CENT_TOKEN_HMAC" \
  CENT_PROXY_SECRET="$CENT_PROXY_SECRET" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  swift run --package-path server MomoServer
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_http "http://127.0.0.1:${PORT}/health" "MomoServer"

echo "[agent-live] attaching api network proxy for Centrifugo subscribe callbacks"
docker rm -f "$PROXY_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm \
  --name "$PROXY_CONTAINER" \
  --network "$COMPOSE_NETWORK" \
  --network-alias api \
  -e TARGET_HOST=host.docker.internal \
  -e TARGET_PORT="$PORT" \
  python:3.12-slim \
  python3 -u -c '
import os, socket, threading
target = (os.environ["TARGET_HOST"], int(os.environ["TARGET_PORT"]))
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("0.0.0.0", 8080))
listener.listen(64)
print(f"proxy listening on 0.0.0.0:8080 -> {target[0]}:{target[1]}", flush=True)
def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass
while True:
    client, _ = listener.accept()
    upstream = socket.create_connection(target, timeout=10)
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()
' >/dev/null
wait_container_log_pattern "$PROXY_CONTAINER" "$PROXY_LOG" "proxy listening" "api proxy"

echo "[agent-live] starting mock hermes on ${HERMES_BASE_URL}"
python3 "$REPO_ROOT/scripts/mock_hermes.py" --host 127.0.0.1 --port "$HERMES_PORT" \
  >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
wait_http "http://127.0.0.1:${HERMES_PORT}/health" "mock hermes"

echo "[agent-live] starting AgentWorker"
(
  cd "$REPO_ROOT"
  RELAY_DATABASE_URL="$WORKER_DATABASE_URL" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  HERMES_BASE_URL="$HERMES_BASE_URL" \
  HERMES_API_KEY="$HERMES_API_KEY" \
  WORKER_POLL_INTERVAL_MS="$WORKER_POLL_INTERVAL_MS" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  swift run --package-path workers/AgentWorker AgentWorker
) >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
wait_log_pattern "$WORKER_LOG" "agent worker starting" "AgentWorker" "$WORKER_PID"

echo "[agent-live] starting OutboxRelay for private agentwork WebSocket evidence"
(
  cd "$REPO_ROOT"
  RELAY_DATABASE_URL="$RELAY_DATABASE_URL" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  RELAY_POLL_INTERVAL_MS="$RELAY_POLL_INTERVAL_MS" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  swift run --package-path relay/OutboxRelay OutboxRelay
) >"$RELAY_LOG" 2>&1 &
RELAY_PID=$!
wait_log_pattern "$RELAY_LOG" "outbox relay starting" "OutboxRelay" "$RELAY_PID"

echo "[agent-live] logging in authorized and unauthorized users"
LOGIN_JSON="$(login "$HUMAN_EMAIL" "$WORKSPACE_ID")"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken // empty')"
MEMBER_ID="$(printf '%s' "$LOGIN_JSON" | jq -r '.member.id // empty')"
NO_SHARED_LOGIN_JSON="$(login "$NO_SHARED_EMAIL" "$WORKSPACE_ID")"
NO_SHARED_ACCESS_TOKEN="$(printf '%s' "$NO_SHARED_LOGIN_JSON" | jq -r '.accessToken // empty')"
OTHER_LOGIN_JSON="$(login "$OTHER_EMAIL" "$OTHER_WORKSPACE_ID")"
OTHER_ACCESS_TOKEN="$(printf '%s' "$OTHER_LOGIN_JSON" | jq -r '.accessToken // empty')"
if [ "$ACCESS_TOKEN" = "" ] || [ "$NO_SHARED_ACCESS_TOKEN" = "" ] || [ "$OTHER_ACCESS_TOKEN" = "" ]; then
  fail "login did not return all access tokens"
fi
[ "$(printf '%s' "$MEMBER_ID" | tr '[:upper:]' '[:lower:]')" = "$HUMAN_ID" ] \
  || fail "authorized login actor mismatch: expected $HUMAN_ID got ${MEMBER_ID:-<empty>}"

AGENT_CREDENTIAL_JSON="$(
  api_request POST \
    "/v1/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/credentials" \
    "$ACCESS_TOKEN" '{"label":"MOMO-338 agentwork websocket"}'
)"
AGENT_BEARER="$(printf '%s' "$AGENT_CREDENTIAL_JSON" | jq -r '.token // empty')"
REVOKED_AGENT_CREDENTIAL_ID="$(printf '%s' "$AGENT_CREDENTIAL_JSON" | jq -r '.credential.id // empty')"
if [ "$AGENT_BEARER" = "" ] || [ "$REVOKED_AGENT_CREDENTIAL_ID" = "" ]; then
  fail "agent bearer mint failed for private work stream"
fi
REVOKED_AGENT_REALTIME_JSON="$(realtime_token "$AGENT_BEARER")"
REVOKED_AGENT_REALTIME_TOKEN="$(printf '%s' "$REVOKED_AGENT_REALTIME_JSON" | jq -r '.token // empty')"

# Keep another credential active, then revoke the credential which minted the
# first connection JWT. Exact-token metadata must prevent that old JWT from
# borrowing the new credential's liveness.
AGENT_CREDENTIAL_JSON="$(
  api_request POST \
    "/v1/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/credentials" \
    "$ACCESS_TOKEN" '{"label":"MOMO-338 active agentwork websocket"}'
)"
AGENT_BEARER="$(printf '%s' "$AGENT_CREDENTIAL_JSON" | jq -r '.token // empty')"
AGENT_CREDENTIAL_ID="$(printf '%s' "$AGENT_CREDENTIAL_JSON" | jq -r '.credential.id // empty')"
api_request POST \
  "/v1/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/credentials/${REVOKED_AGENT_CREDENTIAL_ID}/revoke" \
  "$ACCESS_TOKEN" '{"reason":"MOMO-338 exact realtime credential binding"}' >/dev/null

AGENT_REALTIME_JSON="$(realtime_token "$AGENT_BEARER")"
AGENT_REALTIME_TOKEN="$(printf '%s' "$AGENT_REALTIME_JSON" | jq -r '.token // empty')"
if [ "$REVOKED_AGENT_REALTIME_TOKEN" = "" ] || [ "$AGENT_BEARER" = "" ] \
  || [ "$AGENT_CREDENTIAL_ID" = "" ] || [ "$AGENT_REALTIME_TOKEN" = "" ]; then
  fail "agent realtime token mint failed"
fi

psql_admin <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
DELETE FROM agent_run WHERE id = '$CROSS_RUN_ID';
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key,
   finished_at)
VALUES
  ('$CROSS_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CROSS_CHANNEL_ID',
   'succeeded', '{}'::jsonb, 'momo-338-cross-channel-' || '$CROSS_RUN_ID', now());
COMMIT;
SQL
CROSS_RUN_MESSAGE_STATUS="$(
  api_status POST \
    "/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" \
    "$AGENT_BEARER" \
    "{\"clientMsgId\":\"$(uuidgen | tr '[:upper:]' '[:lower:]')\",\"type\":\"text\",\"body\":\"must be denied\",\"runId\":\"${CROSS_RUN_ID}\"}"
)"
[ "$CROSS_RUN_MESSAGE_STATUS" = "403" ] \
  || fail "agent cross-channel run association was not denied (HTTP ${CROSS_RUN_MESSAGE_STATUS})"

REALTIME_JSON="$(realtime_token "$ACCESS_TOKEN")"
REALTIME_TOKEN="$(printf '%s' "$REALTIME_JSON" | jq -r '.token // empty')"
TOKEN_TYPE="$(printf '%s' "$REALTIME_JSON" | jq -r '.tokenType // empty')"
TTL_SECONDS="$(printf '%s' "$REALTIME_JSON" | jq -r '.ttlSeconds // empty')"
NO_SHARED_REALTIME_JSON="$(realtime_token "$NO_SHARED_ACCESS_TOKEN")"
NO_SHARED_REALTIME_TOKEN="$(printf '%s' "$NO_SHARED_REALTIME_JSON" | jq -r '.token // empty')"
OTHER_REALTIME_JSON="$(realtime_token "$OTHER_ACCESS_TOKEN")"
OTHER_REALTIME_TOKEN="$(printf '%s' "$OTHER_REALTIME_JSON" | jq -r '.token // empty')"
if [ "$REALTIME_TOKEN" = "" ] || [ "$TOKEN_TYPE" != "centrifugo.connection.jwt" ] \
  || [ "$NO_SHARED_REALTIME_TOKEN" = "" ] || [ "$OTHER_REALTIME_TOKEN" = "" ]; then
  fail "realtime-token response missing Centrifugo token"
fi

echo "[agent-live] opening WebSocket agent subscriber and injecting agent_job"
set +e
PY_OUT="$(
  REALTIME_TOKEN="$REALTIME_TOKEN" \
  NO_SHARED_REALTIME_TOKEN="$NO_SHARED_REALTIME_TOKEN" \
  OTHER_REALTIME_TOKEN="$OTHER_REALTIME_TOKEN" \
  AGENT_REALTIME_TOKEN="$AGENT_REALTIME_TOKEN" \
  REVOKED_AGENT_REALTIME_TOKEN="$REVOKED_AGENT_REALTIME_TOKEN" \
  CENT_WS_URL="ws://127.0.0.1:${CENT_PORT}/connection/websocket?format=json" \
  AGENT_CHANNEL="$AGENT_CHANNEL" \
  AGENT_WORK_CHANNEL="$AGENT_WORK_CHANNEL" \
  RUN_ID="$RUN_ID" \
  WORKSPACE_ID="$WORKSPACE_ID" \
  CHANNEL_ID="$CHANNEL_ID" \
  AGENT_ID="$AGENT_ID" \
  HUMAN_ID="$MEMBER_ID" \
  MESSAGE_ID="$MESSAGE_ID" \
  CLIENT_MSG_ID="$CLIENT_MSG_ID" \
  PSQL_BIN="$PSQL_BIN" \
  ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL" \
  python3 - <<'PY' 2>"$PY_LOG"
import base64
import json
import os
import secrets
import socket
import struct
import subprocess
import time
import urllib.parse


class WS:
    def __init__(self, url, timeout=10):
        self.url = urllib.parse.urlparse(url)
        self.timeout = timeout
        port = self.url.port or (443 if self.url.scheme == "wss" else 80)
        if self.url.scheme == "wss":
            raise RuntimeError("wss is not supported by this stdlib verifier")
        self.sock = socket.create_connection((self.url.hostname, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        path = self.url.path or "/"
        if self.url.query:
            path += "?" + self.url.query
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {self.url.hostname}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).encode()
        self.sock.sendall(req)
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake closed")
            response += chunk
        status = response.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise RuntimeError(f"websocket handshake failed: {status.decode(errors='replace')}")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def send_json(self, obj):
        data = (json.dumps(obj, separators=(",", ":")) + "\n").encode()
        mask = secrets.token_bytes(4)
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", n))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def recv_text(self, deadline):
        while time.time() < deadline:
            self.sock.settimeout(max(0.1, min(self.timeout, deadline - time.time())))
            first = self.sock.recv(2)
            if not first:
                raise RuntimeError("websocket closed")
            b1, b2 = first
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length) if length else b""
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("websocket close frame")
            if opcode == 0x9:
                self._send_control(0xA, payload)
                continue
            if opcode == 0x1:
                return payload.decode()
        raise TimeoutError("timed out waiting for websocket text frame")

    def _send_control(self, opcode, payload):
        if len(payload) > 125:
            payload = payload[:125]
        mask = secrets.token_bytes(4)
        header = bytearray([0x80 | opcode, 0x80 | len(payload)])
        header.extend(mask)
        header.extend(bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        self.sock.sendall(bytes(header))

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("websocket closed while reading frame")
            buf += chunk
        return buf


def iter_json_messages(text):
    for line in text.splitlines():
        line = line.strip()
        if line:
            yield json.loads(line)


def wait_for(ws, predicate, timeout=20):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        for msg in iter_json_messages(ws.recv_text(deadline)):
            print("ws:", json.dumps(msg, sort_keys=True), file=os.sys.stderr)
            seen.append(msg)
            if predicate(msg):
                return msg
    raise TimeoutError("condition not met; seen=" + json.dumps(seen[-8:], sort_keys=True))


def command_ok(msg, command_id, key):
    return msg.get("id") == command_id and key in msg and not msg.get("error")


def command_error(msg, command_id):
    return msg.get("id") == command_id and msg.get("error")


def invalid_connect_result(ws_url):
    ws = WS(ws_url)
    try:
        ws.send_json({"id": 1, "connect": {"token": "invalid.jwt.for.momo.agent.live"}})
        msg = wait_for(ws, lambda m: m.get("id") == 1 and (m.get("error") or m.get("connect")), timeout=8)
        return {"ok": bool(msg.get("error")), "message": msg}
    except Exception as exc:
        message = str(exc)
        if "websocket close" in message or "websocket closed" in message or "handshake failed" in message:
            return {"ok": True, "message": {"transport_closed": message}}
        return {"ok": False, "message": {"exception": message}}
    finally:
        ws.close()


def subscribe_denied(ws_url, token, channel, label):
    ws = WS(ws_url)
    try:
        ws.send_json({"id": 1, "connect": {"token": token, "name": label, "version": "0.0.1"}})
        wait_for(ws, lambda m: command_ok(m, 1, "connect"), timeout=12)
        ws.send_json({"id": 2, "subscribe": {"channel": channel, "recover": False}})
        msg = wait_for(ws, lambda m: m.get("id") == 2 and (m.get("error") or m.get("subscribe")), timeout=12)
        return {"ok": bool(msg.get("error")), "message": msg}
    finally:
        ws.close()


def agent_publication_for(msg, channel, run_id, channel_id):
    push = msg.get("push") or {}
    pub = push.get("pub") or {}
    data = pub.get("data") or {}
    payload = data.get("payload") or {}
    return (
        push.get("channel") == channel
        and data.get("type") in ("agent.status", "agent.partial")
        and str(payload.get("run_id") or payload.get("runId") or "").lower() == run_id.lower()
        and str(payload.get("channel_id") or payload.get("channelId") or "").lower() == channel_id.lower()
    )


def seed_private_agentwork_broadcast():
    workspace_id = os.environ["WORKSPACE_ID"]
    channel_id = os.environ["CHANNEL_ID"]
    agent_id = os.environ["AGENT_ID"]
    run_id = os.environ["RUN_ID"]
    work_channel = os.environ["AGENT_WORK_CHANNEL"]
    # Centrifugo suppresses a publication whose version does not advance for a
    # channel.  Use a monotonic wall-clock value here instead of a constant so
    # repeated verifier runs exercise the live path rather than dedup recovery.
    publication_version = time.time_ns() // 1_000
    sql = f"""
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '{workspace_id}';
DELETE FROM outbox
 WHERE kind = 'broadcast'
   AND payload->>'idempotency_key' = 'momo-338-agentwork-ws:{run_id}';
INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('{workspace_id}', 'broadcast', 'pending', 'publish',
   jsonb_build_object(
     'channel', '{work_channel}',
     'data', jsonb_build_object(
       'type', 'agent.job',
       'v', 1,
       'payload', jsonb_build_object(
         'run_id', '{run_id}',
         'workspace_id', '{workspace_id}',
         'channel_id', '{channel_id}',
         'agent_member_id', '{agent_id}',
         'prompt', 'MOMO-338 private work stream websocket evidence'
       )
     ),
     'version', {publication_version},
     'idempotency_key', 'momo-338-agentwork-ws:{run_id}'
   ),
   '{agent_id}');
COMMIT;
"""
    subprocess.run(
        [os.environ["PSQL_BIN"], os.environ["ADMIN_DATABASE_URL"], "-v", "ON_ERROR_STOP=1", "--no-psqlrc"],
        input=sql,
        text=True,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def seed_agent_job():
    workspace_id = os.environ["WORKSPACE_ID"]
    channel_id = os.environ["CHANNEL_ID"]
    agent_id = os.environ["AGENT_ID"]
    human_id = os.environ["HUMAN_ID"]
    run_id = os.environ["RUN_ID"]
    message_id = os.environ["MESSAGE_ID"]
    client_msg_id = os.environ["CLIENT_MSG_ID"]
    sql = f"""
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '{workspace_id}';

DELETE FROM usage_ledger WHERE run_id = '{run_id}';
DELETE FROM outbox WHERE payload->>'run_id' = '{run_id}'
   OR payload->'data'->'payload'->>'run_id' = '{run_id}';
DELETE FROM agent_run WHERE id = '{run_id}';
DELETE FROM message WHERE id = '{message_id}' OR run_id = '{run_id}';

-- MOMO-301: this verifier owns its own live-run semaphore (G1) while it runs.
-- Neutralize only prior MOMO-212 verifier runs; do not cancel arbitrary active
-- Hermes runs because local dogfood may be using the deterministic demo agent.
UPDATE agent_run
   SET status = 'cancelled', finished_at = now(), updated_at = now()
 WHERE workspace_id = '{workspace_id}'
   AND agent_member_id = '{agent_id}'
   AND idempotency_key LIKE 'momo-212-%'
   AND status IN ('running', 'awaiting_approval', 'paused');

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '{channel_id}'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '{message_id}', '{workspace_id}', '{channel_id}', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '{human_id}', 'text', '@김인턴 MOMO-212 agent live 검증해줘', '{client_msg_id}'
  FROM bumped;

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('{run_id}', '{workspace_id}', '{agent_id}', '{channel_id}', '{message_id}',
   'queued', 0, 12, 0,
   jsonb_build_object('prompt', '@김인턴 MOMO-212 agent live 검증해줘'),
   'momo-212-' || '{run_id}');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('{workspace_id}', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '{run_id}',
     'workspace_id', '{workspace_id}',
     'agent_member_id', '{agent_id}',
     'channel_id', '{channel_id}',
     'model', 'hermes-agent',
     'prompt', '@김인턴 MOMO-212 agent live 검증해줘',
     'max_output_tokens', 64,
     'tool_grants', jsonb_build_array(jsonb_build_object(
       'tool_name', 'github.search_issues',
       'provider', 'github',
       'grant', 'read',
       'risk', 'read',
       'approval_policy', 'none',
       'resource_scope_summary', 'repo:Dawn-kim-official/momo',
       'capability_version', 'mock-github@0.1.0',
       'policy_version', 'capability-policy@2026-06-30'
     )),
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '{agent_id}');
COMMIT;
"""
    subprocess.run(
        [os.environ["PSQL_BIN"], os.environ["ADMIN_DATABASE_URL"], "-v", "ON_ERROR_STOP=1", "--no-psqlrc"],
        input=sql,
        text=True,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


ws_url = os.environ["CENT_WS_URL"]
channel = os.environ["AGENT_CHANNEL"]
token = os.environ["REALTIME_TOKEN"]
run_id = os.environ["RUN_ID"]
channel_id = os.environ["CHANNEL_ID"]

invalid = invalid_connect_result(ws_url)
different_channel = subscribe_denied(
    ws_url,
    os.environ["NO_SHARED_REALTIME_TOKEN"],
    channel,
    "momo-agent-live-different-channel",
)
other_workspace = subscribe_denied(ws_url, os.environ["OTHER_REALTIME_TOKEN"], channel, "momo-agent-live-other-workspace")

work_channel = os.environ["AGENT_WORK_CHANNEL"]
revoked_agent_credential = subscribe_denied(
    ws_url,
    os.environ["REVOKED_AGENT_REALTIME_TOKEN"],
    work_channel,
    "momo-agentwork-revoked-credential",
)
private_ws = WS(ws_url)
try:
    private_ws.send_json({
        "id": 1,
        "connect": {
            "token": os.environ["AGENT_REALTIME_TOKEN"],
            "name": "momo-agentwork-live-verifier",
            "version": "0.0.1",
        },
    })
    wait_for(private_ws, lambda m: command_ok(m, 1, "connect"), timeout=20)
    private_ws.send_json({
        "id": 2,
        "subscribe": {"channel": work_channel, "recover": False},
    })
    private_subscribe = wait_for(
        private_ws, lambda m: command_ok(m, 2, "subscribe"), timeout=20
    )
    seed_private_agentwork_broadcast()
    private_live = wait_for(
        private_ws,
        lambda m: (
            (m.get("push") or {}).get("channel") == work_channel
            and (((m.get("push") or {}).get("pub") or {}).get("data") or {}).get("type")
            == "agent.job"
            and str(
                (
                    (((m.get("push") or {}).get("pub") or {}).get("data") or {}).get(
                        "payload"
                    )
                    or {}
                ).get("run_id")
                or ""
            ).lower()
            == run_id.lower()
        ),
        timeout=30,
    )
finally:
    private_ws.close()

ws = WS(ws_url)
try:
    ws.send_json({
        "id": 1,
        "connect": {
            "token": token,
            "name": "momo-agent-live-verifier",
            "version": "0.0.1",
        },
    })
    connect_msg = wait_for(ws, lambda m: command_ok(m, 1, "connect"), timeout=20)
    ws.send_json({"id": 2, "subscribe": {"channel": channel, "recover": False}})
    subscribe_msg = wait_for(ws, lambda m: command_ok(m, 2, "subscribe"), timeout=20)

    ws.send_json({
        "id": 3,
        "publish": {
            "channel": channel,
            "data": {
                "type": "agent.partial",
                "v": 1,
                "payload": {"run_id": run_id, "channel_id": channel_id, "text_delta": "client-forbidden"},
            },
        },
    })
    direct_publish = wait_for(ws, lambda m: m.get("id") == 3 and (m.get("error") or m.get("publish")), timeout=12)

    seed_agent_job()
    live = wait_for(ws, lambda m: agent_publication_for(m, channel, run_id, channel_id), timeout=90)
    pub = live["push"]["pub"]
    data = pub["data"]
    payload = data["payload"]
    result = {
        "invalid_token": invalid,
        "unauthorized_different_channel": different_channel,
        "unauthorized_other_workspace": other_workspace,
        "revoked_agent_credential": revoked_agent_credential,
        "direct_publish": {"ok": bool(direct_publish.get("error")), "message": direct_publish},
        "private_agentwork": {
            "ok": bool(private_live),
            "channel": work_channel,
            "subscribe": private_subscribe.get("subscribe", {}),
        },
        "connect": connect_msg.get("connect", {}),
        "subscribe": subscribe_msg.get("subscribe", {}),
        "publication": {
            "channel": live["push"]["channel"],
            "offset": pub.get("offset"),
            "data": data,
        },
        "runtime_relation": {
            "event_type": data.get("type"),
            "run_id": payload.get("run_id") or payload.get("runId"),
            "channel_id": payload.get("channel_id") or payload.get("channelId"),
            "message_seq_authority": "agent progress events have no seq; final durable messages keep message.seq via channel outbox",
        },
    }
    print(json.dumps(result, sort_keys=True))
finally:
    ws.close()
PY
)"
PY_CODE=$?
set -e
if [ "$PY_CODE" -ne 0 ]; then
  fail "agent live websocket verifier failed (exit ${PY_CODE})"
fi
printf '%s\n' "$PY_OUT" >"$LIVE_JSON"

EVENT_TYPE="$(jq -r '.publication.data.type' "$LIVE_JSON")"
PUB_RUN_ID="$(jq -r '(.publication.data.payload.run_id // .publication.data.payload.runId // empty) | ascii_downcase' "$LIVE_JSON")"
PUB_CHANNEL_ID="$(jq -r '(.publication.data.payload.channel_id // .publication.data.payload.channelId // empty) | ascii_downcase' "$LIVE_JSON")"
INVALID_OK="$(jq -r '.invalid_token.ok' "$LIVE_JSON")"
NO_SHARED_OK="$(jq -r '.unauthorized_different_channel.ok' "$LIVE_JSON")"
OTHER_WS_OK="$(jq -r '.unauthorized_other_workspace.ok' "$LIVE_JSON")"
REVOKED_AGENT_OK="$(jq -r '.revoked_agent_credential.ok' "$LIVE_JSON")"
DIRECT_PUBLISH_OK="$(jq -r '.direct_publish.ok' "$LIVE_JSON")"
PRIVATE_AGENTWORK_OK="$(jq -r '.private_agentwork.ok' "$LIVE_JSON")"
PUB_OFFSET="$(jq -r '.publication.offset // empty' "$LIVE_JSON")"
for check in "$INVALID_OK" "$NO_SHARED_OK" "$OTHER_WS_OK" "$REVOKED_AGENT_OK" "$DIRECT_PUBLISH_OK" "$PRIVATE_AGENTWORK_OK"; do
  [ "$check" = "true" ] || fail "one or more negative authorization checks did not fail closed"
done
case "$EVENT_TYPE" in
  agent.status|agent.partial) ;;
  *) fail "expected agent.status or agent.partial, got ${EVENT_TYPE}" ;;
esac
[ "$PUB_RUN_ID" = "$RUN_ID" ] || fail "run_id mismatch: expected $RUN_ID got $PUB_RUN_ID"
[ "$PUB_CHANNEL_ID" = "$CHANNEL_ID" ] || fail "channel_id mismatch: expected $CHANNEL_ID got $PUB_CHANNEL_ID"

psql_admin <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
-- This verifier only waits for the first live progress event, then stops the
-- worker. Do not leave its own run occupying the G1 concurrency semaphore for
-- later runtime-agent profile steps.
UPDATE agent_run
   SET status = 'cancelled', finished_at = now(), updated_at = now()
 WHERE workspace_id = '$WORKSPACE_ID'
   AND id = '$RUN_ID'
   AND status IN ('queued', 'running', 'awaiting_approval', 'paused');
DELETE FROM agent_run WHERE id = '$CROSS_RUN_ID';
COMMIT;
SQL

{
  echo "## MOMO-212 Agent Live Channel Evidence"
  echo "- Result: PASS"
  echo "- Stack: dev compose project \`${COMPOSE_PROJECT_NAME}\`, host api=\`http://127.0.0.1:${PORT}\`, centrifugo=\`ws://127.0.0.1:${CENT_PORT}\`, mock hermes=\`${HERMES_BASE_URL}\`, subscribe proxy alias=\`api:8080\`"
  echo "- Database boundary: isolated migrated DB \`${POSTGRES_DB}\`; app=NOBYPASSRLS, worker/relay=BYPASSRLS marker-bound roles; source \`${SOURCE_POSTGRES_DB}\` digest enforced unchanged on exit."
  echo "- Authorized member: member_id=\`${MEMBER_ID}\`, workspace_id=\`${WORKSPACE_ID}\`"
  echo "- Agent channel: \`${AGENT_CHANNEL}\`"
  echo "- Private agent work channel: \`${AGENT_WORK_CHANNEL}\` (agent bearer WebSocket subscribe + OutboxRelay publication received)"
  echo "- Realtime token: type=\`${TOKEN_TYPE}\`, ttl_seconds=\`${TTL_SECONDS}\`, token_len=\`${#REALTIME_TOKEN}\`"
  echo "- Live publication: type=\`${EVENT_TYPE}\`, run_id=\`${PUB_RUN_ID}\`, channel_id=\`${PUB_CHANNEL_ID}\`, publication_offset=\`${PUB_OFFSET:-n/a}\`"
  echo "- Negative paths: invalid connection token rejected; same-workspace member who shares only a different channel with the agent denied; other-workspace member/token denied; revoked credential-bound realtime JWT denied while another bearer stayed active; agent cross-channel run association denied; client direct publish denied."
  echo "- Ordering note: \`agent.status\`/\`agent.partial\` are ephemeral progress events without \`message.seq\`; final durable output remains on channel timeline through Postgres message/outbox/relay with \`message.seq\` as SoT."
  echo "- Evidence files: publication=\`${LIVE_JSON}\`, websocket_log=\`${PY_LOG}\`, server_log=\`${SERVER_LOG}\`, worker_log=\`${WORKER_LOG}\`, relay_log=\`${RELAY_LOG}\`, mock_log=\`${MOCK_LOG}\`, api_proxy_log=\`${PROXY_LOG}\`"
} >"$EVIDENCE_FILE"

cat "$EVIDENCE_FILE"
echo "[agent-live] MOMO-212 agent live channel gate PASS"
