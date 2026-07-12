#!/usr/bin/env bash
# scripts/verify_hermes_gateway_adapter.sh — MOMO-325/337/349/350 Hermes gateway path
#
# Verifies the product direction where Hermes treats momo as a messaging
# platform, while momo keeps the execution ledger SoT:
#   REST @hermes mention -> agent_run + outbox(agent_job, method=gateway)
#   -> per-agent bearer pending/status/partial/approval/complete REST -> durable timeline message
#   + usage_ledger + audit_log.via_token_id. The legacy shared secret is tested
#   only after an explicit migration-flag restart.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=scripts/runtime_process_guard.sh
. "$REPO_ROOT/scripts/runtime_process_guard.sh"

ENV_FILE=${ENV_FILE:-}
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE=$candidate
      break
    fi
  done
fi

if [ "$ENV_FILE" != "" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[hermes-gateway] missing required command: $1" >&2
    exit 1
  fi
}

require_bin curl
require_bin jq
require_bin python3
require_bin swift

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN=$(command -v psql)
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[hermes-gateway] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo_dev_pw}
SOURCE_POSTGRES_DB=${POSTGRES_DB:-momo}
SOURCE_DATABASE_URL=${DATABASE_URL:-}
POSTGRES_DB=${HERMES_GATEWAY_VERIFIER_DB:-momo_hermes_gateway_verify_${POSTGRES_PORT}_$$}
VERIFIER_DB_MARKER_PREFIX=momo:hermes-gateway-verifier:v1:
VERIFIER_MARKER_UUID=${HERMES_GATEWAY_VERIFIER_TEST_MARKER_UUID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}
if ! [[ "$VERIFIER_MARKER_UUID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  echo "[hermes-gateway] invalid verifier marker UUID" >&2
  exit 1
fi
VERIFIER_DB_MARKER=${VERIFIER_DB_MARKER_PREFIX}${VERIFIER_MARKER_UUID}
VERIFIER_DB_CREATED_OID=
VERIFIER_DB_OWNED=0
SOURCE_DIGEST_ARMED=0
ROLE_SUFFIX=$(printf '%s' "$VERIFIER_DB_MARKER" | shasum -a 256 | cut -c 1-12)
VERIFIER_APP_ROLE=momo_gw_${ROLE_SUFFIX}_app
VERIFIER_APP_PASSWORD=momo_gateway_verify_app_pw
APP_DATABASE_URL=postgres://${VERIFIER_APP_ROLE}:${VERIFIER_APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}
PORT=${PORT:-8080}
BASE_URL=${BASE_URL:-http://127.0.0.1:${PORT}}
AGENT_GATEWAY_SECRET=${AGENT_GATEWAY_SECRET:-momo-325-local-gateway-secret-00000000000000000000000000000000}
CENT_PROXY_SECRET=${CENT_PROXY_SECRET:-momo-338-local-cent-proxy-secret-000000000000000000000000000000}

WORKSPACE_ID=00000000-0000-7000-8000-000000000001
HUMAN_EMAIL=demo@momo.local
HUMAN_PASSWORD=dev-password
HUMAN_MEMBER_ID=00000000-0000-7000-8000-000000000101
AGENT_ID=00000000-0000-7000-8000-000000000103
OTHER_AGENT_ID=00000000-0000-7337-8000-000000000104
CHANNEL_ID=$(python3 -c 'import sys, uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1] + ":agent-lab-channel"))' "$VERIFIER_DB_MARKER")
CENT_CHANNEL=$(python3 -c 'import sys; print("agent:ws" + sys.argv[1].upper() + "." + sys.argv[2].upper() + "." + sys.argv[3].upper())' "$WORKSPACE_ID" "$CHANNEL_ID" "$AGENT_ID")
CLIENT_MSG_ID=00000000-0000-7000-8000-000000325001
BODY='@hermes MOMO-325 gateway native platform smoke'
FINAL_BODY='Hermes gateway mock completed MOMO-325 through momo REST.'
AGENT_CLIENT_MSG_ID=00000000-0000-7337-8000-000000337001
AGENT_BODY='MOMO-337 agent bearer authored this message.'
OTHER_CLIENT_MSG_ID=00000000-0000-7337-8000-000000337002
OTHER_BODY='@momo337-other MOMO-337 actor binding smoke'
APPROVAL_CLIENT_MSG_ID=00000000-0000-7349-8000-000000349001
APPROVAL_BODY='@hermes MOMO-349 approval resume smoke'
APPROVAL_FINAL_BODY='Hermes gateway resumed MOMO-349 after approval.'
APPROVAL_DECISION_ID=00000000-0000-7349-8000-000000349101
REJECTION_CLIENT_MSG_ID=00000000-0000-7349-8000-000000349002
REJECTION_BODY='@hermes MOMO-349 approval rejection smoke'
REJECTION_DECISION_ID=00000000-0000-7349-8000-000000349102
TAKEOVER_CLIENT_MSG_ID=00000000-0000-7341-8000-000000341001
TAKEOVER_BODY='@hermes MOMO-341 crash lease takeover smoke'

TMP_ROOT=${TMPDIR:-/tmp}
SERVER_LOG=${TMP_ROOT}/momo-hermes-gateway-server-$$.log
CREDENTIAL_HEADERS=${TMP_ROOT}/momo-hermes-gateway-credential-headers-$$.txt
CLAIM_A_FILE=${TMP_ROOT}/momo-hermes-gateway-claim-a-$$.json
CLAIM_B_FILE=${TMP_ROOT}/momo-hermes-gateway-claim-b-$$.json
PGPASS_FILE=${TMP_ROOT}/momo-hermes-gateway-pgpass-$$
SERVER_PID=
ACCESS_TOKEN=
REFRESH_TOKEN=
AGENT_TOKEN_ID=
RESTRICTED_TOKEN_ID=
CURRENT_JOB_ID=
CURRENT_LEASE_ID=

cleanup() {
  original_rc=$?
  cleanup_failed=0
  trap - EXIT
  if [ "$ACCESS_TOKEN" != "" ]; then
    [ "$AGENT_TOKEN_ID" = "" ] || revoke_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" "$AGENT_TOKEN_ID" >/dev/null 2>&1 || true
    [ "$RESTRICTED_TOKEN_ID" = "" ] || revoke_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" "$RESTRICTED_TOKEN_ID" >/dev/null 2>&1 || true
    logout_human_session >/dev/null 2>&1 || true
  fi
  momo_cleanup_tracked_pids "hermes-gateway verifier" "$SERVER_PID"
  rm -f "$CREDENTIAL_HEADERS" "$CLAIM_A_FILE" "$CLAIM_B_FILE" "$PGPASS_FILE"
  if [ "$SOURCE_DIGEST_ARMED" = "1" ]; then
    source_after=$(source_digest) || cleanup_failed=1
    if [ "$cleanup_failed" = "0" ] && [ "$source_after" != "$SOURCE_DIGEST_BEFORE" ]; then
      echo "[hermes-gateway] source dogfood DB changed while isolated verifier ran" >&2
      cleanup_failed=1
    elif [ "$cleanup_failed" = "0" ]; then
      echo "[hermes-gateway] source dogfood DB digest preserved"
    fi
  fi
  cleanup_verifier_database || {
    echo "[hermes-gateway] exact verifier DB cleanup failed" >&2
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

(umask 077; printf '%s:%s:%s:%s:%s\n' \
  "$POSTGRES_HOST" "$POSTGRES_PORT" "$POSTGRES_DB" \
  "$POSTGRES_USER" "$POSTGRES_PASSWORD" >"$PGPASS_FILE")

psql_url() {
  printf 'postgres://%s@%s:%s/%s' \
    "$POSTGRES_USER" "$POSTGRES_HOST" "$POSTGRES_PORT" "$POSTGRES_DB"
}

psql_run() {
  PGPASSFILE="$PGPASS_FILE" "$PSQL_BIN" "$(psql_url)" \
    -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

psql_scalar() {
  printf '%s\n' "$1" | psql_run -t -A | tr -d '[:space:]'
}

admin_scalar() {
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc -c "$1") || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

source_digest() {
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
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
  ) || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

validate_admin_target() {
  case "$POSTGRES_HOST" in
    localhost|127.0.0.1|::1) ;;
    *) echo "[hermes-gateway] destructive verifier DB target must be loopback: $POSTGRES_HOST" >&2; exit 1 ;;
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
    raise SystemExit("[hermes-gateway] DATABASE_URL and admin target must both be loopback")
if port != int(expected_port) or database != expected_db:
    raise SystemExit("[hermes-gateway] DATABASE_URL source does not match admin port/database")
PY
  fi
}

provision_verifier_database() {
  case "$POSTGRES_DB" in
    ''|*[!a-zA-Z0-9_]*|"$SOURCE_POSTGRES_DB"|postgres|template0|template1)
      echo "[hermes-gateway] refusing unsafe verifier database target: $POSTGRES_DB" >&2
      exit 1
      ;;
  esac
  exists=$(admin_scalar "SELECT count(*) FROM pg_database WHERE datname = '$POSTGRES_DB';")
  [ "$exists" = "0" ] || { echo "[hermes-gateway] refusing pre-existing verifier database: $POSTGRES_DB" >&2; exit 1; }

  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -v ON_ERROR_STOP=1 --no-psqlrc -c "CREATE DATABASE \"$POSTGRES_DB\";"
  VERIFIER_DB_OWNED=1
  VERIFIER_DB_CREATED_OID=$(admin_scalar "SELECT oid FROM pg_database WHERE datname = '$POSTGRES_DB';")
  [ "$VERIFIER_DB_CREATED_OID" != "" ] || { echo "[hermes-gateway] failed to capture verifier DB OID" >&2; exit 1; }
  if [ "${HERMES_GATEWAY_VERIFIER_TEST_FAIL_COMMENT:-0}" = "1" ]; then
    echo "[hermes-gateway] intentional verifier COMMENT failure (test only)" >&2
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
COMMENT ON ROLE $VERIFIER_APP_ROLE IS :'marker';
ALTER ROLE $VERIFIER_APP_ROLE WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO $VERIFIER_APP_ROLE;
COMMIT;
SQL

  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc <<SQL
GRANT USAGE ON SCHEMA public TO $VERIFIER_APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $VERIFIER_APP_ROLE;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $VERIFIER_APP_ROLE;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO $VERIFIER_APP_ROLE;
SQL
}

cleanup_verifier_database() {
  [ "$VERIFIER_DB_OWNED" = "1" ] || return 0
  current_oid=$(admin_scalar "SELECT COALESCE(oid::text, '') FROM pg_database WHERE datname = '$POSTGRES_DB';") || return 1
  current_marker=$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$POSTGRES_DB';") || return 1
  if [ "$current_oid" != "$VERIFIER_DB_CREATED_OID" ] \
    || { [ "$current_marker" != "$VERIFIER_DB_MARKER" ] && [ "$current_marker" != "" ]; }; then
    echo "[hermes-gateway] refusing verifier cleanup: DB identity changed" >&2
    return 1
  fi
  role_marker=$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '$VERIFIER_APP_ROLE';") || return 1
  if [ "$role_marker" = "$VERIFIER_DB_MARKER" ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 --no-psqlrc \
      -c "ALTER ROLE \"$VERIFIER_APP_ROLE\" NOLOGIN;" >/dev/null || return 1
  fi
  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE);" >/dev/null || return 1
  role_marker=$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '$VERIFIER_APP_ROLE';") || return 1
  if [ "$role_marker" = "$VERIFIER_DB_MARKER" ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 --no-psqlrc \
      -c "DROP ROLE \"$VERIFIER_APP_ROLE\";" >/dev/null || return 1
  fi
  VERIFIER_DB_OWNED=0
}

json_escape() {
  printf '%s' "$1" | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'
}

# Request metadata and credentials travel through stdin, never process argv.
api_request() {
  method=$1
  path=$2
  bearer=${3:-}
  body=${4:-}
  auth_header=${5:-Authorization}
  headers_file=${6:-}
  printf '%s\0%s\0%s\0%s\0%s\0%s' \
    "$BASE_URL$path" "$method" "$bearer" "$body" "$auth_header" "$headers_file" | python3 -c '
import pathlib
import sys
import urllib.error
import urllib.request

parts = sys.stdin.buffer.read().split(b"\0", 5)
if len(parts) != 6:
    raise SystemExit(2)
url, method, secret, body, auth_header, headers_file = (
    part.decode("utf-8") for part in parts
)
headers = {"Accept": "application/json"}
if secret:
    headers[auth_header] = ("Bearer " + secret) if auth_header == "Authorization" else secret
data = None
if body:
    headers["Content-Type"] = "application/json"
    data = body.encode("utf-8")
request = urllib.request.Request(url, data=data, headers=headers, method=method)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        if headers_file:
            pathlib.Path(headers_file).write_text(str(response.headers), encoding="utf-8")
        sys.stdout.buffer.write(response.read())
except urllib.error.HTTPError as exc:
    if headers_file:
        pathlib.Path(headers_file).write_text(str(exc.headers), encoding="utf-8")
    sys.stderr.write(f"momo API request failed: HTTP {exc.code}\n")
    raise SystemExit(22)
'
}

api_status() {
  method=$1
  path=$2
  bearer=${3:-}
  body=${4:-}
  auth_header=${5:-Authorization}
  printf '%s\0%s\0%s\0%s\0%s' \
    "$BASE_URL$path" "$method" "$bearer" "$body" "$auth_header" | python3 -c '
import sys
import urllib.error
import urllib.request

parts = sys.stdin.buffer.read().split(b"\0", 4)
if len(parts) != 5:
    raise SystemExit(2)
url, method, secret, body, auth_header = (part.decode("utf-8") for part in parts)
headers = {"Accept": "application/json"}
if secret:
    headers[auth_header] = ("Bearer " + secret) if auth_header == "Authorization" else secret
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

logout_human_session() {
  if [ "$ACCESS_TOKEN" != "" ] && [ "$REFRESH_TOKEN" != "" ]; then
    api_request POST /v1/auth/logout "$ACCESS_TOKEN" \
      "{\"refreshToken\":$(json_escape "$REFRESH_TOKEN")}" >/dev/null
  fi
  ACCESS_TOKEN=
  REFRESH_TOKEN=
}

wait_http() {
  url=$1
  name=$2
  deadline=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[hermes-gateway] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "[hermes-gateway] ${name} did not become ready: ${url}" >&2
  return 1
}

start_server() {
  allow_legacy=${1:-0}
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[hermes-gateway] $BASE_URL is already serving /health; stop it before this isolated verifier." >&2
    exit 1
  fi
  echo "[hermes-gateway] starting MomoServer in AGENT_GATEWAY_MODE=gateway"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="$APP_DATABASE_URL" \
    PORT="$PORT" \
    AGENT_GATEWAY_MODE=gateway \
    AGENT_GATEWAY_SECRET="$AGENT_GATEWAY_SECRET" \
    CENT_PROXY_SECRET="$CENT_PROXY_SECRET" \
    MOMO_ALLOW_LEGACY_GATEWAY_SECRET="$allow_legacy" \
    RATE_LIMIT_PER_MEMBER=0 \
    RATE_LIMIT_PER_IP=0 \
    swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  wait_http "$BASE_URL/health" "MomoServer"
}

stop_server() {
  momo_cleanup_tracked_pids "hermes-gateway verifier restart" "$SERVER_PID"
  SERVER_PID=
}

login() {
  login_body="{\"email\":$(json_escape "$HUMAN_EMAIL"),\"password\":$(json_escape "$HUMAN_PASSWORD"),\"workspace\":$(json_escape "$WORKSPACE_ID")}";
  api_request POST /v1/auth/login "" "$login_body"
}

send_message() {
  token=$1
  client_msg_id=$2
  body=$3
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" "$token" \
    "{\"clientMsgId\":\"${client_msg_id}\",\"type\":\"text\",\"body\":$(json_escape "$body"),\"props\":{\"gate\":\"MOMO-337\",\"path\":\"hermes-gateway\"}}"
}

post_gateway_event() {
  token=$1
  run_id=$2
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" "$token" \
    "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"status\":\"running\",\"detail\":\"mock gateway accepted agent.job\"}" >/dev/null
}

post_gateway_thinking() {
  token=$1
  run_id=$2
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" "$token" \
    "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"event_id\":\"00000000-0000-7350-8000-000000350001\",\"status\":\"thinking\",\"detail\":\"reading gateway context\"}" >/dev/null
}

post_gateway_streaming() {
  token=$1
  run_id=$2
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" "$token" \
    "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"event_id\":\"00000000-0000-7350-8000-000000350002\",\"status\":\"streaming\",\"detail\":\"provider text delta\",\"text_delta\":\"MOMO-350 gateway streaming preview\"}" >/dev/null
}

post_gateway_approval_request() {
  token=$1
  run_id=$2
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" "$token" \
    "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"status\":\"approval_request\",\"approval_request\":{\"action_type\":\"tool_call\",\"title\":\"Create release issue\",\"summary\":\"Review the issue before Hermes creates it.\",\"tool_call\":{\"call_id\":\"call-momo-349\",\"name\":\"create_github_issue\",\"arguments\":{\"title\":\"MOMO-349 release checklist\"},\"tool_grant\":{\"tool_name\":\"create_github_issue\",\"approval_policy\":\"require_approval\"}},\"estimated_micro_usd\":1200,\"is_reversible\":false}}" >/dev/null
}

post_gateway_cancelled() {
  token=$1
  run_id=$2
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" "$token" \
    "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"status\":\"cancelled\",\"detail\":\"approval rejected; provider execution stopped\"}" >/dev/null
}

post_legacy_gateway_event() {
  run_id=$1
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" \
    "$AGENT_GATEWAY_SECRET" "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"status\":\"running\",\"detail\":\"mock gateway accepted agent.job\"}" \
    X-Momo-Agent-Gateway-Secret >/dev/null
}

post_gateway_complete() {
  token=$1
  run_id=$2
  final_body=${3:-$FINAL_BODY}
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/complete" "$token" \
    "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"status\":\"succeeded\",\"body\":$(json_escape "$final_body"),\"usage\":{\"model\":\"hermes-agent\",\"prompt_tokens\":11,\"completion_tokens\":7,\"cached_tokens\":0,\"reasoning_tokens\":0,\"cost_micro_usd\":0,\"was_estimated\":true}}"
}

decide_approval() {
  token=$1
  approval_id=$2
  approve=$3
  client_decision_id=$4
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/approvals/${approval_id}/decision" "$token" \
    "{\"approval_id\":\"${approval_id}\",\"approve\":${approve},\"reason\":\"MOMO-349 gateway verifier\",\"client_decision_id\":\"${client_decision_id}\"}"
}

create_agent_credential() {
  human_token=$1
  agent_id=$2
  payload=$3
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agents/${agent_id}/credentials" \
    "$human_token" "$payload" Authorization "$CREDENTIAL_HEADERS"
}

revoke_agent_credential() {
  human_token=$1
  agent_id=$2
  credential_id=$3
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agents/${agent_id}/credentials/${credential_id}/revoke" \
    "$human_token" '{"reason":"MOMO-337 runtime verifier"}'
}

fetch_pending_jobs() {
  token=$1
  agent_id=$2
  api_request GET "/v1/workspaces/${WORKSPACE_ID}/agents/${agent_id}/gateway/jobs/pending" "$token" ""
}

set_current_claim() {
  claim_json=$1
  run_id=$2
  CURRENT_JOB_ID=$(printf '%s' "$claim_json" | jq -r --arg run "$run_id" '.jobs[] | select((.runId | ascii_downcase) == ($run | ascii_downcase)) | .id' | head -1)
  CURRENT_LEASE_ID=$(printf '%s' "$claim_json" | jq -r --arg run "$run_id" '.jobs[] | select((.runId | ascii_downcase) == ($run | ascii_downcase)) | .leaseId' | head -1)
  [ "$CURRENT_JOB_ID" != "" ] && [ "$CURRENT_JOB_ID" != "null" ] \
    || fail "claimed gateway job is missing id for run ${run_id}"
  [ "$CURRENT_LEASE_ID" != "" ] && [ "$CURRENT_LEASE_ID" != "null" ] \
    || fail "claimed gateway job is missing leaseId for run ${run_id}"
}

renew_gateway_lease_status() {
  token=$1
  agent_id=$2
  job_id=$3
  lease_id=$4
  api_status POST "/v1/workspaces/${WORKSPACE_ID}/agents/${agent_id}/gateway/jobs/${job_id}/lease/renew" "$token" \
    "{\"job_id\":${job_id},\"lease_id\":\"${lease_id}\"}"
}

release_gateway_lease_status() {
  token=$1
  agent_id=$2
  job_id=$3
  lease_id=$4
  api_status POST "/v1/workspaces/${WORKSPACE_ID}/agents/${agent_id}/gateway/jobs/${job_id}/lease/release" "$token" \
    "{\"job_id\":${job_id},\"lease_id\":\"${lease_id}\"}"
}

fetch_realtime_token() {
  token=$1
  api_request POST /v1/auth/realtime-token "$token" '{}'
}

subscribe_agent_stream() {
  user_member_id=$1
  target_agent_id=$2
  connection_meta=$3
  api_request POST /v1/centrifugo/subscribe "$CENT_PROXY_SECRET" \
    "{\"client\":\"momo-338-verifier\",\"user\":\"${user_member_id}\",\"channel\":\"agentwork:ws${WORKSPACE_ID}.${target_agent_id}\",\"meta\":${connection_meta}}" \
    X-Centrifugo-Proxy-Secret
}

realtime_connection_meta() {
  printf '%s' "$1" | python3 -c '
import base64
import json
import sys

token = sys.stdin.read().strip()
parts = token.split(".")
if len(parts) != 3:
    raise SystemExit("invalid realtime JWT")
payload = parts[1] + "=" * (-len(parts[1]) % 4)
decoded = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
print(json.dumps(decoded.get("meta") or {}, separators=(",", ":")))
'
}

cleanup_fixture_rows() {
  psql_run >/dev/null <<SQL
SELECT set_config('app.workspace_id', '${WORKSPACE_ID}', false);
CREATE TEMP TABLE momo337_tokens AS
SELECT id
  FROM token
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND kind = 'agent_bearer'
   AND label LIKE 'MOMO-337%';
CREATE TEMP TABLE momo325_runs AS
SELECT id
  FROM agent_run
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     input::text LIKE '%MOMO-325%'
     OR trigger_message_id IN (
       SELECT id
         FROM message
        WHERE workspace_id = '${WORKSPACE_ID}'
          AND (
            client_msg_id IN (
              '${CLIENT_MSG_ID}', '${OTHER_CLIENT_MSG_ID}',
              '${APPROVAL_CLIENT_MSG_ID}', '${REJECTION_CLIENT_MSG_ID}'
            )
            OR body IN ('${BODY}', '${OTHER_BODY}', '${APPROVAL_BODY}', '${REJECTION_BODY}')
          )
     )
   );
DELETE FROM outbox
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     payload->>'idempotency_key' LIKE '%MOMO-325%'
     OR payload::text LIKE '%${CLIENT_MSG_ID}%'
     OR payload::text LIKE '%${BODY}%'
     OR payload::text LIKE '%${FINAL_BODY}%'
     OR payload::text LIKE '%${AGENT_BODY}%'
     OR payload::text LIKE '%${OTHER_BODY}%'
     OR payload::text LIKE '%${APPROVAL_BODY}%'
     OR payload::text LIKE '%${APPROVAL_FINAL_BODY}%'
     OR payload::text LIKE '%${REJECTION_BODY}%'
     OR payload->'data'->'payload'->>'run_id' IN (
       SELECT id::text FROM momo325_runs
     )
   );
DELETE FROM usage_ledger
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND run_id IN (
     SELECT id FROM momo325_runs
   );
DELETE FROM audit_log
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     detail::text LIKE '%${CLIENT_MSG_ID}%'
     OR detail::text LIKE '%MOMO-325%'
     OR detail::text LIKE '%MOMO-337%'
     OR detail::text LIKE '%MOMO-349%'
     OR action LIKE 'agent.gateway.%'
     OR via_token_id IN (SELECT id FROM momo337_tokens)
     OR (
       actor_member_id IN ('${AGENT_ID}', '${OTHER_AGENT_ID}')
       AND action IN ('auth.agent_bearer.used', 'auth.agent_bearer.scope_denied', 'message.sent')
     )
     OR run_id IN (
       SELECT id FROM momo325_runs
     )
   );
DELETE FROM agent_run
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND id IN (SELECT id FROM momo325_runs);
DELETE FROM message
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND (
     client_msg_id = '${CLIENT_MSG_ID}'
     OR client_msg_id = '${AGENT_CLIENT_MSG_ID}'
     OR client_msg_id = '${OTHER_CLIENT_MSG_ID}'
     OR client_msg_id = '${APPROVAL_CLIENT_MSG_ID}'
     OR client_msg_id = '${REJECTION_CLIENT_MSG_ID}'
     OR body = '${BODY}'
     OR body = '${FINAL_BODY}'
     OR body = '${AGENT_BODY}'
     OR body = '${OTHER_BODY}'
     OR body = '${APPROVAL_BODY}'
     OR body = '${APPROVAL_FINAL_BODY}'
     OR body = '${REJECTION_BODY}'
     OR props->>'source' = 'hermes_gateway'
   );
DELETE FROM token
 WHERE id IN (SELECT id FROM momo337_tokens);
DELETE FROM membership
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND member_id = '${OTHER_AGENT_ID}';
DELETE FROM agent
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND member_id = '${OTHER_AGENT_ID}';
DELETE FROM member
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND id = '${OTHER_AGENT_ID}';
DROP TABLE momo325_runs;
DROP TABLE momo337_tokens;
SQL
}

seed_isolated_fixture() {
  psql_run >/dev/null <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '${WORKSPACE_ID}';

INSERT INTO workspace (id, slug, name)
VALUES ('${WORKSPACE_ID}', 'hermes-gateway-verifier', 'Hermes Gateway Verifier Workspace')
ON CONFLICT (id) DO UPDATE
  SET deleted_at = NULL,
      name = EXCLUDED.name;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('${HUMAN_MEMBER_ID}', '${WORKSPACE_ID}', 'human', 'active', 'Gateway Human', 'demo'),
  ('${AGENT_ID}', '${WORKSPACE_ID}', 'agent', 'active', 'Hermes', 'hermes')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle,
      deleted_at = NULL;

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('${HUMAN_MEMBER_ID}', '${WORKSPACE_ID}', '${HUMAN_EMAIL}', true,
        momo_password_hash('${HUMAN_PASSWORD}'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
  SET email = EXCLUDED.email,
      email_verified = true,
      password_hash = EXCLUDED.password_hash,
      tz = EXCLUDED.tz;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('${AGENT_ID}', '${WORKSPACE_ID}', 'hermes-agent', 'http://localhost:8088/v1',
        'Hermes gateway verifier fixture', '${HUMAN_MEMBER_ID}', 1, 12)
ON CONFLICT (member_id) DO UPDATE
  SET model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      system_prompt = EXCLUDED.system_prompt,
      owner_human_id = EXCLUDED.owner_human_id,
      max_concurrent_runs = EXCLUDED.max_concurrent_runs,
      max_run_steps = EXCLUDED.max_run_steps;

-- Migration 002 owns a fixed #agent-lab UUID. Replace it inside this isolated
-- DB so each verifier generation has a distinct channel/idempotency namespace.
DELETE FROM channel
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND id <> '${CHANNEL_ID}'
   AND lower(name) = 'agent-lab';

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, archived_at)
VALUES ('${CHANNEL_ID}', '${WORKSPACE_ID}', 'public', 'agent-lab',
        'Hermes gateway verifier channel', '${HUMAN_MEMBER_ID}', NULL)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      topic = EXCLUDED.topic,
      archived_at = NULL,
      updated_at = now();

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('${CHANNEL_ID}', '${WORKSPACE_ID}', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role, left_at)
VALUES
  ('00000000-0000-7000-8000-000000000303', '${WORKSPACE_ID}',
   '${CHANNEL_ID}', '${HUMAN_MEMBER_ID}', 'owner', NULL),
  ('00000000-0000-7000-8000-000000000306', '${WORKSPACE_ID}',
   '${CHANNEL_ID}', '${AGENT_ID}', 'member', NULL)
ON CONFLICT (channel_id, member_id)
DO UPDATE SET role = EXCLUDED.role, left_at = NULL;

COMMIT;
SQL
}

seed_other_agent() {
  psql_run >/dev/null <<SQL
SELECT set_config('app.workspace_id', '${WORKSPACE_ID}', false);
INSERT INTO member
  (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('${OTHER_AGENT_ID}', '${WORKSPACE_ID}', 'agent', 'active',
   'MOMO-337 Other Agent', 'momo337-other')
ON CONFLICT (id) DO NOTHING;
INSERT INTO agent
  (member_id, workspace_id, model, base_url, owner_human_id)
VALUES
  ('${OTHER_AGENT_ID}', '${WORKSPACE_ID}', 'hermes-agent',
   'http://localhost:8088/v1', '00000000-0000-7000-8000-000000000101')
ON CONFLICT (member_id) DO NOTHING;
INSERT INTO membership
  (workspace_id, channel_id, member_id, role)
VALUES
  ('${WORKSPACE_ID}', '${CHANNEL_ID}', '${OTHER_AGENT_ID}', 'member')
ON CONFLICT (channel_id, member_id)
DO UPDATE SET left_at = NULL;
SQL
}

assert_equals() {
  expected=$1
  actual=$2
  label=$3
  if [ "$expected" != "$actual" ]; then
    echo "[hermes-gateway] assertion failed: ${label}: expected=${expected} actual=${actual}" >&2
    tail -120 "$SERVER_LOG" >&2 || true
    exit 1
  fi
}

assert_between() {
  minimum=$1
  actual=$2
  maximum=$3
  label=$4
  if [ "$actual" -lt "$minimum" ] || [ "$actual" -gt "$maximum" ]; then
    echo "[hermes-gateway] assertion failed: ${label}: expected ${minimum}..${maximum}, actual=${actual}" >&2
    tail -120 "$SERVER_LOG" >&2 || true
    exit 1
  fi
}

echo "[hermes-gateway] ensuring docker compose services"
( cd "$REPO_ROOT" && POSTGRES_DB="$SOURCE_POSTGRES_DB" make up >/dev/null )
validate_admin_target
SOURCE_DIGEST_BEFORE=$(source_digest)
SOURCE_DIGEST_ARMED=1
echo "[hermes-gateway] provisioning isolated verifier database: $POSTGRES_DB"
provision_verifier_database
echo "[hermes-gateway] seeding isolated Hermes/#agent-lab fixture"
seed_isolated_fixture
seed_other_agent
momo_cleanup_port_listener "$PORT" "hermes-gateway verifier API" || {
  echo "[hermes-gateway] API port ${PORT} is occupied by a non-momo process" >&2
  exit 1
}

start_server 0
LOGIN_JSON=$(login)
ACCESS_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken')
REFRESH_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.refreshToken // empty')
if [ "$ACCESS_TOKEN" = "" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  echo "[hermes-gateway] login failed" >&2
  printf '%s\n' "$LOGIN_JSON" >&2
  exit 1
fi

FULL_CREDENTIAL_JSON=$(create_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" '{"label":"MOMO-337 full"}')
AGENT_TOKEN=$(printf '%s' "$FULL_CREDENTIAL_JSON" | jq -r '.token')
AGENT_TOKEN_ID=$(printf '%s' "$FULL_CREDENTIAL_JSON" | jq -r '.credential.id')
if [ "$AGENT_TOKEN" = "" ] || [ "$AGENT_TOKEN" = "null" ] || [ "$AGENT_TOKEN_ID" = "null" ]; then
  echo "[hermes-gateway] agent credential mint failed" >&2
  exit 1
fi
HASH_MATCH=$(psql_scalar "SELECT count(*) FROM token WHERE id='${AGENT_TOKEN_ID}' AND token_hash=digest('${AGENT_TOKEN}','sha256') AND kind='agent_bearer'")
assert_equals "1" "$HASH_MATCH" "agent bearer stored as sha256"
CREATOR_MATCH=$(psql_scalar "SELECT count(*) FROM token WHERE id='${AGENT_TOKEN_ID}' AND created_by='${HUMAN_MEMBER_ID}'")
assert_equals "1" "$CREATOR_MATCH" "agent bearer records issuing admin"
RAW_LEAK_COUNT=$(psql_scalar "SELECT count(*) FROM token WHERE id='${AGENT_TOKEN_ID}' AND coalesce(label,'') LIKE '%${AGENT_TOKEN}%'")
assert_equals "0" "$RAW_LEAK_COUNT" "raw agent bearer is not stored in text columns"
if ! grep -Eiq '^cache-control:[[:space:]]*no-store' "$CREDENTIAL_HEADERS"; then
  echo "[hermes-gateway] assertion failed: one-time credential response must be no-store" >&2
  exit 1
fi
if ! grep -Eiq '^pragma:[[:space:]]*no-cache' "$CREDENTIAL_HEADERS"; then
  echo "[hermes-gateway] assertion failed: one-time credential response must be no-cache" >&2
  exit 1
fi

# Hermes calls a platform adapter's generic send() for session lifecycle,
# home-channel setup, slash-command, and model/provider notices. momo accepts
# only run-bound agent responses as durable messages; exercise the real adapter
# against this run's isolated server and assert those sends do not change the
# per-run channel ledger. The HTTP override makes a regression write for real,
# so the DB count assertion below catches it without relying on a mock.
OPERATIONAL_MESSAGE_COUNT_BEFORE=$(psql_scalar "SELECT count(*) FROM message WHERE workspace_id='${WORKSPACE_ID}' AND channel_id='${CHANNEL_ID}' AND author_member_id='${AGENT_ID}'")
PYTHONPATH="$REPO_ROOT/adapters/hermes" \
  MOMO_API_URL="$BASE_URL" \
  MOMO_WORKSPACE_ID="$WORKSPACE_ID" \
  MOMO_AGENT_MEMBER_ID="$AGENT_ID" \
  MOMO_AGENT_TOKEN="$AGENT_TOKEN" \
  MOMO_VERIFIER_CHANNEL_ID="$CHANNEL_ID" \
  python3 <<'PY'
import asyncio
import json
import os
import urllib.request

from momo_adapter import MomoAdapter, MomoConfig


class VerifierAdapter(MomoAdapter):
    async def _post(self, path, body):
        request = urllib.request.Request(
            self.cfg.api_base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Accept": "application/json",
                "Authorization": "Bearer " + self.cfg.agent_token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())


async def verify():
    adapter = VerifierAdapter(MomoConfig())
    notices = (
        "◐ Session automatically reset (inactive for 24h). Use /resume.\n\n"
        "◆ Model: `hermes-agent`\n◆ Provider: openrouter\n"
        "◆ Context: 128K tokens (detected)",
        "📬 No home channel is set for Momo. Type /sethome to configure it.",
        "Session restored by /resume.",
        "Home channel updated by /sethome.",
    )
    for notice in notices:
        result = await adapter.send(
            os.environ["MOMO_VERIFIER_CHANNEL_ID"],
            notice,
            metadata={"notify": True},
        )
        if not getattr(result, "success", False):
            raise AssertionError("operational notice suppression reported failure")
        if getattr(result, "message_id", None) is not None:
            raise AssertionError("operational notice received a durable message id")
        raw = getattr(result, "raw_response", None)
        if not isinstance(raw, dict) or raw.get("suppressed") is not True:
            raise AssertionError("operational notice was not explicitly suppressed")


asyncio.run(verify())
PY
OPERATIONAL_MESSAGE_COUNT_AFTER=$(psql_scalar "SELECT count(*) FROM message WHERE workspace_id='${WORKSPACE_ID}' AND channel_id='${CHANNEL_ID}' AND author_member_id='${AGENT_ID}'")
assert_equals "$OPERATIONAL_MESSAGE_COUNT_BEFORE" "$OPERATIONAL_MESSAGE_COUNT_AFTER" "Hermes operational notices never become durable messages"

REALTIME_JSON=$(fetch_realtime_token "$AGENT_TOKEN")
REALTIME_MEMBER=$(printf '%s' "$REALTIME_JSON" | jq -r '.memberId')
REALTIME_TOKEN=$(printf '%s' "$REALTIME_JSON" | jq -r '.token')
REALTIME_META=$(realtime_connection_meta "$REALTIME_TOKEN")
assert_equals "$AGENT_ID" "$REALTIME_MEMBER" "agent realtime token subject"
SELF_STREAM_JSON=$(subscribe_agent_stream "$AGENT_ID" "$AGENT_ID" "$REALTIME_META")
assert_equals "true" "$(printf '%s' "$SELF_STREAM_JSON" | jq -r '.result != null')" "agent can subscribe its own work stream"
CROSS_STREAM_JSON=$(subscribe_agent_stream "$AGENT_ID" "$OTHER_AGENT_ID" "$REALTIME_META")
assert_equals "403" "$(printf '%s' "$CROSS_STREAM_JSON" | jq -r '.error.code')" "agent cannot subscribe another agent work stream"

AGENT_MESSAGE_JSON=$(send_message "$AGENT_TOKEN" "$AGENT_CLIENT_MSG_ID" "$AGENT_BODY")
AGENT_MESSAGE_AUTHOR=$(printf '%s' "$AGENT_MESSAGE_JSON" | jq -r '.authorMemberId')
assert_equals "$AGENT_ID" "$AGENT_MESSAGE_AUTHOR" "agent bearer message author"
MESSAGE_AUDIT_VIA=$(psql_scalar "SELECT count(*) FROM audit_log WHERE action='message.sent' AND target_id=(SELECT id FROM message WHERE client_msg_id='${AGENT_CLIENT_MSG_ID}' LIMIT 1) AND via_token_id='${AGENT_TOKEN_ID}'")
assert_equals "1" "$MESSAGE_AUDIT_VIA" "agent message audit via_token_id"

RESTRICTED_JSON=$(create_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" '{"label":"MOMO-337 restricted","scopes":["realtime:subscribe"],"rotationGraceSeconds":86400}')
RESTRICTED_TOKEN=$(printf '%s' "$RESTRICTED_JSON" | jq -r '.token')
RESTRICTED_TOKEN_ID=$(printf '%s' "$RESTRICTED_JSON" | jq -r '.credential.id')
ROTATED_COUNT=$(printf '%s' "$RESTRICTED_JSON" | jq -r '.rotatedCredentialCount')
assert_equals "1" "$ROTATED_COUNT" "rotation schedules prior credential grace"
GRACE_SECONDS=$(psql_scalar "SELECT floor(extract(epoch FROM (expires_at-now())))::int FROM token WHERE id='${AGENT_TOKEN_ID}'")
assert_between 82800 "$GRACE_SECONDS" 90000 "default 24h rotation grace"

SCOPE_DENIED_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" "$RESTRICTED_TOKEN" '{"clientMsgId":"00000000-0000-7337-8000-000000337003","type":"text","body":"scope denied"}')
assert_equals "403" "$SCOPE_DENIED_CODE" "agent bearer missing messages:write"
SCOPE_DENIED_AUDIT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE action='auth.agent_bearer.scope_denied' AND via_token_id='${RESTRICTED_TOKEN_ID}'")
assert_equals "1" "$SCOPE_DENIED_AUDIT" "scope denial audit via_token_id"

REVOKE_JSON=$(revoke_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" "$RESTRICTED_TOKEN_ID")
assert_equals "true" "$(printf '%s' "$REVOKE_JSON" | jq -r '.revokedNow')" "credential revoke"
REVOKED_CODE=$(api_status POST /v1/auth/realtime-token "$RESTRICTED_TOKEN" '{}')
assert_equals "401" "$REVOKED_CODE" "revoked agent bearer fails closed"

SEND_JSON=$(send_message "$ACCESS_TOKEN" "$CLIENT_MSG_ID" "$BODY")
RUN_ID=$(psql_scalar "SELECT id FROM agent_run WHERE workspace_id='${WORKSPACE_ID}' AND trigger_message_id=(SELECT id FROM message WHERE client_msg_id='${CLIENT_MSG_ID}' LIMIT 1) LIMIT 1")
if [ "$RUN_ID" = "" ]; then
  echo "[hermes-gateway] @hermes mention did not create agent_run" >&2
  printf '%s\n' "$SEND_JSON" >&2
  tail -120 "$SERVER_LOG" >&2 || true
  exit 1
fi

JOB_METHOD=$(psql_scalar "SELECT method FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "gateway" "$JOB_METHOD" "agent_job method"

JOB_STATUS=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "pending" "$JOB_STATUS" "agent_job initial status"

AGENT_JOB_BROADCAST=$(psql_scalar "SELECT payload->'data'->>'type' FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='agent.job' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "agent.job" "$AGENT_JOB_BROADCAST" "agentwork: realtime job broadcast"
AGENT_JOB_CHANNEL=$(psql_scalar "SELECT payload->>'channel' FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='agent.job' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "agentwork:ws${WORKSPACE_ID}.${AGENT_ID}" "$AGENT_JOB_CHANNEL" "private agentwork channel"

psql_scalar "UPDATE outbox SET available_at=now()+interval '10 minutes' WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${RUN_ID}') RETURNING id" >/dev/null
DELAYED_PENDING_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
DELAYED_PENDING_COUNT=$(printf '%s' "$DELAYED_PENDING_JSON" | jq --arg run "$RUN_ID" '[.jobs[] | select((.runId | ascii_downcase) == ($run | ascii_downcase))] | length')
assert_equals "0" "$DELAYED_PENDING_COUNT" "future retry is not delivered before available_at"
psql_scalar "UPDATE outbox SET available_at=now() WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${RUN_ID}') RETURNING id" >/dev/null
fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID" >"$CLAIM_A_FILE" &
CLAIM_A_PID=$!
fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID" >"$CLAIM_B_FILE" &
CLAIM_B_PID=$!
wait "$CLAIM_A_PID"
wait "$CLAIM_B_PID"
PENDING_JSON=$(jq -s '{jobs: ([.[].jobs[]])}' "$CLAIM_A_FILE" "$CLAIM_B_FILE")
PENDING_COUNT=$(printf '%s' "$PENDING_JSON" | jq --arg run "$RUN_ID" '[.jobs[] | select((.runId | ascii_downcase) == ($run | ascii_downcase))] | length')
assert_equals "1" "$PENDING_COUNT" "two gateway consumers receive one provider-start capability"
set_current_claim "$PENDING_JSON" "$RUN_ID"
LEASE_SHAPE_COUNT=$(printf '%s' "$PENDING_JSON" | jq '[.jobs[] | select((.leaseId | type) == "string" and (.leaseExpiresAtMs | type) == "number")] | length')
assert_equals "1" "$LEASE_SHAPE_COUNT" "claimed job carries bounded lease capability"

UNAUTHORIZED_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${RUN_ID}/gateway/events" "" '{"status":"running"}')
assert_equals "401" "$UNAUTHORIZED_CODE" "gateway callback without bearer"
LEGACY_DISABLED_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${RUN_ID}/gateway/events" "$AGENT_GATEWAY_SECRET" '{"status":"running"}' X-Momo-Agent-Gateway-Secret)
assert_equals "401" "$LEGACY_DISABLED_CODE" "legacy gateway secret disabled by default"

OTHER_SEND_JSON=$(send_message "$ACCESS_TOKEN" "$OTHER_CLIENT_MSG_ID" "$OTHER_BODY")
OTHER_RUN_ID=$(psql_scalar "SELECT id FROM agent_run WHERE workspace_id='${WORKSPACE_ID}' AND trigger_message_id=(SELECT id FROM message WHERE client_msg_id='${OTHER_CLIENT_MSG_ID}' LIMIT 1) AND agent_member_id='${OTHER_AGENT_ID}' LIMIT 1")
if [ "$OTHER_RUN_ID" = "" ]; then
  echo "[hermes-gateway] other-agent mention did not create agent_run" >&2
  printf '%s\n' "$OTHER_SEND_JSON" >&2
  exit 1
fi
CROSS_AGENT_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${OTHER_RUN_ID}/gateway/events" "$AGENT_TOKEN" '{"status":"running"}')
assert_equals "403" "$CROSS_AGENT_CODE" "agent bearer cannot callback another agent run"
CROSS_PARTIAL_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${OTHER_RUN_ID}/gateway/events" "$AGENT_TOKEN" '{"status":"streaming","text_delta":"forged delta"}')
assert_equals "403" "$CROSS_PARTIAL_CODE" "agent bearer cannot stream into another agent run"
CROSS_APPROVAL_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${OTHER_RUN_ID}/gateway/events" "$AGENT_TOKEN" '{"status":"approval_request","approval_request":{"tool_call":{"call_id":"cross-agent","name":"forbidden_tool","arguments":{}}}}')
assert_equals "403" "$CROSS_APPROVAL_CODE" "approval callback preserves run actor binding"

post_gateway_event "$AGENT_TOKEN" "$RUN_ID"
post_gateway_thinking "$AGENT_TOKEN" "$RUN_ID"
post_gateway_streaming "$AGENT_TOKEN" "$RUN_ID"
post_gateway_streaming "$AGENT_TOKEN" "$RUN_ID"
OVERSIZED_EVENT_BODY=$(python3 -c 'import json, sys; print(json.dumps({"job_id":int(sys.argv[1]),"lease_id":sys.argv[2],"status":"streaming","text_delta":"x" * 8193}))' "$CURRENT_JOB_ID" "$CURRENT_LEASE_ID")
OVERSIZED_DELTA_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${RUN_ID}/gateway/events" "$AGENT_TOKEN" "$OVERSIZED_EVENT_BODY")
assert_equals "400" "$OVERSIZED_DELTA_CODE" "gateway streaming delta size cap"
STATUS_BROADCAST_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='broadcast' AND payload->>'channel'='${CENT_CHANNEL}' AND payload->'data'->>'type'='agent.status' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}') AND payload->'data'->'payload'->>'phase' IN ('thinking','streaming') AND payload->'data'->'payload'->>'run_status'='running' AND payload->'data'->'payload'->>'detail' IN ('reading gateway context','provider text delta')")
assert_equals "2" "$STATUS_BROADCAST_COUNT" "thinking/streaming status uses observable agent namespace"
PARTIAL_BROADCAST_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='broadcast' AND payload->>'channel'='${CENT_CHANNEL}' AND payload->'data'->>'type'='agent.partial' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}') AND lower(payload->'data'->'payload'->>'channel_id')=lower('${CHANNEL_ID}') AND payload->'data'->'payload'->>'text_delta'='MOMO-350 gateway streaming preview'")
assert_equals "1" "$PARTIAL_BROADCAST_COUNT" "gateway text delta broadcasts idempotently as agent.partial"
PRIVATE_PROGRESS_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND payload->'data'->>'type' IN ('agent.status','agent.partial') AND payload->>'channel' LIKE 'agentwork:%' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}')")
assert_equals "0" "$PRIVATE_PROGRESS_COUNT" "observable progress never enters private agentwork namespace"
COMPLETE_JSON=$(post_gateway_complete "$AGENT_TOKEN" "$RUN_ID")
FINAL_SEQ=$(printf '%s' "$COMPLETE_JSON" | jq -r '.seq')
if [ "$FINAL_SEQ" = "" ] || [ "$FINAL_SEQ" = "null" ]; then
  echo "[hermes-gateway] completion response missing seq" >&2
  printf '%s\n' "$COMPLETE_JSON" >&2
  exit 1
fi
RETRY_COMPLETE_JSON=$(post_gateway_complete "$AGENT_TOKEN" "$RUN_ID")
RETRY_FINAL_SEQ=$(printf '%s' "$RETRY_COMPLETE_JSON" | jq -r '.seq')
assert_equals "$FINAL_SEQ" "$RETRY_FINAL_SEQ" "gateway complete idempotent retry seq"

RUN_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${RUN_ID}'")
assert_equals "succeeded" "$RUN_STATUS" "agent_run status"

FINAL_MESSAGE_COUNT=$(psql_scalar "SELECT count(*) FROM message WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND author_member_id='${AGENT_ID}' AND body='${FINAL_BODY}'")
assert_equals "1" "$FINAL_MESSAGE_COUNT" "durable final timeline message"

USAGE_COUNT=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND agent_member_id='${AGENT_ID}'")
assert_equals "1" "$USAGE_COUNT" "usage ledger row"

AUDIT_COUNT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND action IN ('agent.gateway.status','agent.gateway.completed')")
assert_equals "4" "$AUDIT_COUNT" "gateway audit rows"
AUDIT_VIA_COUNT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND action IN ('agent.gateway.status','agent.gateway.completed') AND via_token_id='${AGENT_TOKEN_ID}'")
assert_equals "4" "$AUDIT_VIA_COUNT" "gateway audit rows via agent credential"

FINAL_BROADCAST_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}')")
assert_equals "1" "$FINAL_BROADCAST_COUNT" "durable final message broadcast idempotency"

JOB_DONE=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "done" "$JOB_DONE" "agent_job settled"

APPROVAL_SEND_JSON=$(send_message "$ACCESS_TOKEN" "$APPROVAL_CLIENT_MSG_ID" "$APPROVAL_BODY")
APPROVAL_RUN_ID=$(psql_scalar "SELECT id FROM agent_run WHERE workspace_id='${WORKSPACE_ID}' AND trigger_message_id=(SELECT id FROM message WHERE client_msg_id='${APPROVAL_CLIENT_MSG_ID}' LIMIT 1) LIMIT 1")
if [ "$APPROVAL_RUN_ID" = "" ]; then
  echo "[hermes-gateway] approval mention did not create agent_run" >&2
  printf '%s\n' "$APPROVAL_SEND_JSON" >&2
  exit 1
fi
APPROVAL_QUEUED_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${APPROVAL_RUN_ID}'")
assert_equals "queued" "$APPROVAL_QUEUED_STATUS" "gateway approval run starts queued"
APPROVAL_INITIAL_PENDING_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
set_current_claim "$APPROVAL_INITIAL_PENDING_JSON" "$APPROVAL_RUN_ID"
post_gateway_event "$AGENT_TOKEN" "$APPROVAL_RUN_ID"
APPROVAL_RUNNING_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${APPROVAL_RUN_ID}'")
assert_equals "running" "$APPROVAL_RUNNING_STATUS" "gateway approval run enters running"
post_gateway_approval_request "$AGENT_TOKEN" "$APPROVAL_RUN_ID"
post_gateway_approval_request "$AGENT_TOKEN" "$APPROVAL_RUN_ID"

APPROVAL_ID=$(psql_scalar "SELECT id FROM approval WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${APPROVAL_RUN_ID}' AND status='pending' LIMIT 1")
if [ "$APPROVAL_ID" = "" ]; then
  echo "[hermes-gateway] approval_request callback did not create approval" >&2
  exit 1
fi
APPROVAL_COUNT=$(psql_scalar "SELECT count(*) FROM approval WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${APPROVAL_RUN_ID}'")
assert_equals "1" "$APPROVAL_COUNT" "approval callback idempotent retry"
APPROVAL_RUN_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${APPROVAL_RUN_ID}'")
assert_equals "awaiting_approval" "$APPROVAL_RUN_STATUS" "gateway run pauses awaiting approval"
APPROVAL_BYPASS_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${APPROVAL_RUN_ID}/gateway/complete" "$AGENT_TOKEN" "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"status\":\"succeeded\",\"body\":\"must wait for human approval\"}")
assert_equals "409" "$APPROVAL_BYPASS_CODE" "gateway completion cannot bypass pending human approval"
APPROVAL_MESSAGE_TYPE=$(psql_scalar "SELECT type FROM message WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${APPROVAL_RUN_ID}' AND lower(props->>'approval_id')=lower('${APPROVAL_ID}') LIMIT 1")
assert_equals "approval_request" "$APPROVAL_MESSAGE_TYPE" "approval request appears on durable timeline"
APPROVAL_INITIAL_JOB_STATUS=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${APPROVAL_RUN_ID}') AND NOT (payload ? 'resume_from_approval_id') LIMIT 1")
assert_equals "done" "$APPROVAL_INITIAL_JOB_STATUS" "approval callback settles initial gateway job"
APPROVAL_AUDIT_VIA=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${APPROVAL_RUN_ID}' AND action='approval.requested' AND via_token_id='${AGENT_TOKEN_ID}'")
assert_equals "1" "$APPROVAL_AUDIT_VIA" "approval request audit binds agent credential"

APPROVAL_INBOX_JSON=$(api_request GET "/v1/workspaces/${WORKSPACE_ID}/approvals?status=pending" "$ACCESS_TOKEN" "")
APPROVAL_INBOX_COUNT=$(printf '%s' "$APPROVAL_INBOX_JSON" | jq --arg id "$APPROVAL_ID" '[.approvals[] | select((.id | ascii_downcase) == ($id | ascii_downcase) and .status == "pending")] | length')
assert_equals "1" "$APPROVAL_INBOX_COUNT" "macOS approval inbox REST projection exposes gateway approval"

APPROVAL_DECISION_JSON=$(decide_approval "$ACCESS_TOKEN" "$APPROVAL_ID" true "$APPROVAL_DECISION_ID")
assert_equals "approved" "$(printf '%s' "$APPROVAL_DECISION_JSON" | jq -r '.status')" "human approves gateway request"
APPROVAL_RESUME_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${APPROVAL_RUN_ID}'")
assert_equals "queued" "$APPROVAL_RESUME_STATUS" "approved gateway run requeues"
APPROVAL_RESUME_METHOD=$(psql_scalar "SELECT method FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('${APPROVAL_RUN_ID}') AND lower(payload->>'resume_from_approval_id')=lower('${APPROVAL_ID}') LIMIT 1")
assert_equals "gateway" "$APPROVAL_RESUME_METHOD" "approved resume stays on gateway delivery"
APPROVAL_RESUME_DECISION=$(psql_scalar "SELECT payload #>> '{approval_decision,status}' FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('${APPROVAL_RUN_ID}') AND lower(payload->>'resume_from_approval_id')=lower('${APPROVAL_ID}') LIMIT 1")
assert_equals "approved" "$APPROVAL_RESUME_DECISION" "resume payload carries approved decision"
APPROVAL_RESUME_BROADCAST=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='agent.job' AND lower(payload->'data'->'payload'->>'run_id')=lower('${APPROVAL_RUN_ID}') AND lower(payload->'data'->'payload'->>'resume_from_approval_id')=lower('${APPROVAL_ID}') AND payload->>'channel'='agentwork:ws${WORKSPACE_ID}.${AGENT_ID}'")
assert_equals "1" "$APPROVAL_RESUME_BROADCAST" "approved resume publishes private agent.job"
APPROVAL_PENDING_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
APPROVAL_PENDING_COUNT=$(printf '%s' "$APPROVAL_PENDING_JSON" | jq --arg run "$APPROVAL_RUN_ID" --arg approval "$APPROVAL_ID" '[.jobs[] | select((.runId | ascii_downcase) == ($run | ascii_downcase) and (.payload.resume_from_approval_id | ascii_downcase) == ($approval | ascii_downcase))] | length')
assert_equals "1" "$APPROVAL_PENDING_COUNT" "adapter recovery can fetch approved resume"
set_current_claim "$APPROVAL_PENDING_JSON" "$APPROVAL_RUN_ID"

post_gateway_event "$AGENT_TOKEN" "$APPROVAL_RUN_ID"
APPROVAL_RESUMED_RUNNING_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${APPROVAL_RUN_ID}'")
assert_equals "running" "$APPROVAL_RESUMED_RUNNING_STATUS" "approved gateway resume re-enters running"
APPROVAL_COMPLETE_JSON=$(post_gateway_complete "$AGENT_TOKEN" "$APPROVAL_RUN_ID" "$APPROVAL_FINAL_BODY")
APPROVAL_FINAL_SEQ=$(printf '%s' "$APPROVAL_COMPLETE_JSON" | jq -r '.seq')
APPROVAL_FINAL_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${APPROVAL_RUN_ID}'")
assert_equals "succeeded" "$APPROVAL_FINAL_STATUS" "approved gateway resume completes same run"
APPROVAL_RESUME_DONE=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${APPROVAL_RUN_ID}') AND lower(payload->>'resume_from_approval_id')=lower('${APPROVAL_ID}') LIMIT 1")
assert_equals "done" "$APPROVAL_RESUME_DONE" "approved resume gateway job settled"
APPROVAL_DECISION_COUNT=$(psql_scalar "SELECT count(*) FROM approval_decision WHERE workspace_id='${WORKSPACE_ID}' AND approval_id='${APPROVAL_ID}' AND client_decision_id='${APPROVAL_DECISION_ID}' AND approve=true AND status='approved'")
assert_equals "1" "$APPROVAL_DECISION_COUNT" "approved decision ledger row"
APPROVAL_USAGE_COUNT=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${APPROVAL_RUN_ID}' AND agent_member_id='${AGENT_ID}'")
assert_equals "1" "$APPROVAL_USAGE_COUNT" "approved run usage ledger row"
APPROVAL_AUDIT_COUNT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${APPROVAL_RUN_ID}' AND action IN ('approval.requested','approval.approved','agent.gateway.status','agent.gateway.completed')")
assert_between "4" "$APPROVAL_AUDIT_COUNT" "8" "approved run audit trail"
APPROVAL_FINAL_MESSAGE_COUNT=$(psql_scalar "SELECT count(*) FROM message WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${APPROVAL_RUN_ID}' AND author_member_id='${AGENT_ID}' AND body='${APPROVAL_FINAL_BODY}'")
assert_equals "1" "$APPROVAL_FINAL_MESSAGE_COUNT" "approved run durable final message"
APPROVAL_FINAL_BROADCAST_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('${APPROVAL_RUN_ID}') AND payload->'data'->'payload'->>'body'='${APPROVAL_FINAL_BODY}' AND (payload->>'version')::bigint=(payload->'data'->>'seq')::bigint AND last_error IS NULL")
assert_equals "1" "$APPROVAL_FINAL_BROADCAST_COUNT" "approved run realtime publication outbox"

REJECTION_SEND_JSON=$(send_message "$ACCESS_TOKEN" "$REJECTION_CLIENT_MSG_ID" "$REJECTION_BODY")
REJECTION_RUN_ID=$(psql_scalar "SELECT id FROM agent_run WHERE workspace_id='${WORKSPACE_ID}' AND trigger_message_id=(SELECT id FROM message WHERE client_msg_id='${REJECTION_CLIENT_MSG_ID}' LIMIT 1) LIMIT 1")
if [ "$REJECTION_RUN_ID" = "" ]; then
  echo "[hermes-gateway] rejection mention did not create agent_run" >&2
  printf '%s\n' "$REJECTION_SEND_JSON" >&2
  exit 1
fi
REJECTION_INITIAL_PENDING_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
set_current_claim "$REJECTION_INITIAL_PENDING_JSON" "$REJECTION_RUN_ID"
post_gateway_event "$AGENT_TOKEN" "$REJECTION_RUN_ID"
post_gateway_approval_request "$AGENT_TOKEN" "$REJECTION_RUN_ID"
REJECTION_APPROVAL_ID=$(psql_scalar "SELECT id FROM approval WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${REJECTION_RUN_ID}' AND status='pending' LIMIT 1")
REJECTION_DECISION_JSON=$(decide_approval "$ACCESS_TOKEN" "$REJECTION_APPROVAL_ID" false "$REJECTION_DECISION_ID")
assert_equals "rejected" "$(printf '%s' "$REJECTION_DECISION_JSON" | jq -r '.status')" "human rejects gateway request"
REJECTION_RUN_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${REJECTION_RUN_ID}'")
assert_equals "cancelled" "$REJECTION_RUN_STATUS" "rejected gateway run stays cancelled"
REJECTION_RESUME_STATUS=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${REJECTION_RUN_ID}') AND lower(payload->>'resume_from_approval_id')=lower('${REJECTION_APPROVAL_ID}') LIMIT 1")
assert_equals "pending" "$REJECTION_RESUME_STATUS" "rejection publishes gateway stop job"
REJECTION_RESUME_DECISION=$(psql_scalar "SELECT payload #>> '{approval_decision,status}' FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('${REJECTION_RUN_ID}') AND lower(payload->>'resume_from_approval_id')=lower('${REJECTION_APPROVAL_ID}') LIMIT 1")
assert_equals "rejected" "$REJECTION_RESUME_DECISION" "stop payload carries rejected decision"
REJECTION_PENDING_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
set_current_claim "$REJECTION_PENDING_JSON" "$REJECTION_RUN_ID"
post_gateway_cancelled "$AGENT_TOKEN" "$REJECTION_RUN_ID"
REJECTION_RESUME_DONE=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${REJECTION_RUN_ID}') AND lower(payload->>'resume_from_approval_id')=lower('${REJECTION_APPROVAL_ID}') LIMIT 1")
assert_equals "done" "$REJECTION_RESUME_DONE" "adapter cancellation acknowledgement settles stop job"
REJECTION_FINAL_STATUS=$(psql_scalar "SELECT status FROM agent_run WHERE id='${REJECTION_RUN_ID}'")
assert_equals "cancelled" "$REJECTION_FINAL_STATUS" "cancellation acknowledgement cannot revive rejected run"
REJECTION_LATE_COMPLETE_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${REJECTION_RUN_ID}/gateway/complete" "$AGENT_TOKEN" "{\"job_id\":${CURRENT_JOB_ID},\"lease_id\":\"${CURRENT_LEASE_ID}\",\"status\":\"succeeded\",\"body\":\"must not revive rejected run\"}")
assert_equals "409" "$REJECTION_LATE_COMPLETE_CODE" "late gateway completion cannot override human rejection"

TAKEOVER_SEND_JSON=$(send_message "$ACCESS_TOKEN" "$TAKEOVER_CLIENT_MSG_ID" "$TAKEOVER_BODY")
TAKEOVER_RUN_ID=$(psql_scalar "SELECT id FROM agent_run WHERE workspace_id='${WORKSPACE_ID}' AND trigger_message_id=(SELECT id FROM message WHERE client_msg_id='${TAKEOVER_CLIENT_MSG_ID}' LIMIT 1) LIMIT 1")
if [ "$TAKEOVER_RUN_ID" = "" ]; then
  echo "[hermes-gateway] takeover mention did not create agent_run" >&2
  printf '%s\n' "$TAKEOVER_SEND_JSON" >&2
  exit 1
fi
TAKEOVER_FIRST_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
set_current_claim "$TAKEOVER_FIRST_JSON" "$TAKEOVER_RUN_ID"
TAKEOVER_JOB_ID=$CURRENT_JOB_ID
CRASHED_LEASE_ID=$CURRENT_LEASE_ID
TAKEOVER_BLOCKED_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
TAKEOVER_BLOCKED_COUNT=$(printf '%s' "$TAKEOVER_BLOCKED_JSON" | jq --arg run "$TAKEOVER_RUN_ID" '[.jobs[] | select((.runId | ascii_downcase) == ($run | ascii_downcase))] | length')
assert_equals "0" "$TAKEOVER_BLOCKED_COUNT" "active lease hides job from a second consumer"

psql_scalar "UPDATE outbox SET lease_acquired_at=now()-interval '2 minutes', lease_expires_at=now()-interval '1 minute' WHERE id=${TAKEOVER_JOB_ID} AND lease_owner='${CRASHED_LEASE_ID}' RETURNING id" >/dev/null
TAKEOVER_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
set_current_claim "$TAKEOVER_JSON" "$TAKEOVER_RUN_ID"
assert_equals "$TAKEOVER_JOB_ID" "$CURRENT_JOB_ID" "expired crash lease takes over the same durable job"
[ "$CURRENT_LEASE_ID" != "$CRASHED_LEASE_ID" ] || fail "takeover reused crashed lease owner"

STALE_CALLBACK_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${TAKEOVER_RUN_ID}/gateway/events" "$AGENT_TOKEN" "{\"job_id\":${TAKEOVER_JOB_ID},\"lease_id\":\"${CRASHED_LEASE_ID}\",\"status\":\"running\"}")
assert_equals "409" "$STALE_CALLBACK_CODE" "crashed lease owner callback fails closed after takeover"
FORGED_LEASE_ID=00000000-0000-7341-8000-000000000999
FORGED_RENEW_CODE=$(renew_gateway_lease_status "$AGENT_TOKEN" "$AGENT_ID" "$CURRENT_JOB_ID" "$FORGED_LEASE_ID")
assert_equals "409" "$FORGED_RENEW_CODE" "non-owner lease renew fails closed"
FORGED_RELEASE_CODE=$(release_gateway_lease_status "$AGENT_TOKEN" "$AGENT_ID" "$CURRENT_JOB_ID" "$FORGED_LEASE_ID")
assert_equals "409" "$FORGED_RELEASE_CODE" "non-owner lease release fails closed"
OWNED_RENEW_CODE=$(renew_gateway_lease_status "$AGENT_TOKEN" "$AGENT_ID" "$CURRENT_JOB_ID" "$CURRENT_LEASE_ID")
assert_equals "200" "$OWNED_RENEW_CODE" "lease owner can renew bounded provider work"
OWNED_RELEASE_CODE=$(release_gateway_lease_status "$AGENT_TOKEN" "$AGENT_ID" "$CURRENT_JOB_ID" "$CURRENT_LEASE_ID")
assert_equals "200" "$OWNED_RELEASE_CODE" "lease owner can release unstarted work"
RECLAIMED_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
set_current_claim "$RECLAIMED_JSON" "$TAKEOVER_RUN_ID"
[ "$CURRENT_LEASE_ID" != "$CRASHED_LEASE_ID" ] || fail "released job reclaimed crashed lease owner"
post_gateway_event "$AGENT_TOKEN" "$TAKEOVER_RUN_ID"
TAKEOVER_COMPLETE_JSON=$(post_gateway_complete "$AGENT_TOKEN" "$TAKEOVER_RUN_ID" "MOMO-341 takeover completed after simulated crash.")
assert_equals "succeeded" "$(printf '%s' "$TAKEOVER_COMPLETE_JSON" | jq -r '.status')" "takeover consumer completes durable job"
TAKEOVER_JOB_STATUS=$(psql_scalar "SELECT status FROM outbox WHERE id=${TAKEOVER_JOB_ID}")
assert_equals "done" "$TAKEOVER_JOB_STATUS" "takeover prevents permanently pending gateway job"

FULL_REVOKE_JSON=$(revoke_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" "$AGENT_TOKEN_ID")
assert_equals "true" "$(printf '%s' "$FULL_REVOKE_JSON" | jq -r '.revokedNow')" "full credential revoke"
REVOKED_CALLBACK_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${RUN_ID}/gateway/events" "$AGENT_TOKEN" '{"status":"running"}')
assert_equals "401" "$REVOKED_CALLBACK_CODE" "revoked token cannot callback"

stop_server
start_server 1
LEGACY_PENDING_JSON=$(api_request GET "/v1/workspaces/${WORKSPACE_ID}/agents/${OTHER_AGENT_ID}/gateway/jobs/pending?limit=1" \
  "$AGENT_GATEWAY_SECRET" "" X-Momo-Agent-Gateway-Secret)
set_current_claim "$LEGACY_PENDING_JSON" "$OTHER_RUN_ID"
post_legacy_gateway_event "$OTHER_RUN_ID"
LEGACY_AUDIT_COUNT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${OTHER_RUN_ID}' AND action='agent.gateway.status' AND via_token_id IS NULL")
assert_equals "1" "$LEGACY_AUDIT_COUNT" "legacy flag migration case has no bearer provenance"

if [ "${HERMES_GATEWAY_EQUIVALENCE_EVIDENCE_FILE:-}" != "" ]; then
  umask 077
  jq -n \
    --arg channel "$CENT_CHANNEL" \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {
      schema: "momo.agent_path_equivalence.v1",
      scenario: "trigger-approval-resume-final",
      run_status_sequence: ["queued", "running", "awaiting_approval", "queued", "running", "succeeded"],
      approval: {created: true, decision: "approved", resumed: true},
      ledgers: {usage_ledger: true, audit_log: true},
      final_message: {durable: true, realtime_publication: true},
      observational: {
        path: "gateway",
        completed_at: $completed_at,
        provider_metadata: "byoa-callback",
        lease_model: "gateway-bounded-lease",
        cent_channel: $channel
      }
    }' >"$HERMES_GATEWAY_EQUIVALENCE_EVIDENCE_FILE"
  echo "[hermes-gateway] MOMO-352 evidence: $HERMES_GATEWAY_EQUIVALENCE_EVIDENCE_FILE"
fi

logout_human_session
stop_server
cleanup_fixture_rows

echo "[hermes-gateway] PASS: bearer_run=${RUN_ID} final_seq=${FINAL_SEQ} approval_run=${APPROVAL_RUN_ID} approval_seq=${APPROVAL_FINAL_SEQ} rejection_run=${REJECTION_RUN_ID} takeover_run=${TAKEOVER_RUN_ID} legacy_run=${OTHER_RUN_ID}"
echo "[hermes-gateway] database boundary: isolated=${POSTGRES_DB} app=NOBYPASSRLS source=${SOURCE_POSTGRES_DB} digest-enforced"
echo "[hermes-gateway] real Hermes gateway CLI/plugin load remains runtime-unverified(real hermes gateway missing) unless a user-provided Hermes runtime is present."
