#!/usr/bin/env bash
# scripts/verify_hermes_gateway_adapter.sh — MOMO-325/337 Hermes gateway path
#
# Verifies the product direction where Hermes treats momo as a messaging
# platform, while momo keeps the execution ledger SoT:
#   REST @hermes mention -> agent_run + outbox(agent_job, method=gateway)
#   -> per-agent bearer pending/status/complete REST -> durable timeline message
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
POSTGRES_DB=${POSTGRES_DB:-momo}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo}
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
CHANNEL_ID=00000000-0000-7000-8000-000000000202
CLIENT_MSG_ID=00000000-0000-7000-8000-000000325001
BODY='@hermes MOMO-325 gateway native platform smoke'
FINAL_BODY='Hermes gateway mock completed MOMO-325 through momo REST.'
AGENT_CLIENT_MSG_ID=00000000-0000-7337-8000-000000337001
AGENT_BODY='MOMO-337 agent bearer authored this message.'
OTHER_CLIENT_MSG_ID=00000000-0000-7337-8000-000000337002
OTHER_BODY='@momo337-other MOMO-337 actor binding smoke'

TMP_ROOT=${TMPDIR:-/tmp}
SERVER_LOG=${TMP_ROOT}/momo-hermes-gateway-server-$$.log
CREDENTIAL_HEADERS=${TMP_ROOT}/momo-hermes-gateway-credential-headers-$$.txt
PGPASS_FILE=${TMP_ROOT}/momo-hermes-gateway-pgpass-$$
SERVER_PID=
ACCESS_TOKEN=
REFRESH_TOKEN=
AGENT_TOKEN_ID=
RESTRICTED_TOKEN_ID=

cleanup() {
  if [ "$ACCESS_TOKEN" != "" ]; then
    [ "$AGENT_TOKEN_ID" = "" ] || revoke_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" "$AGENT_TOKEN_ID" >/dev/null 2>&1 || true
    [ "$RESTRICTED_TOKEN_ID" = "" ] || revoke_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" "$RESTRICTED_TOKEN_ID" >/dev/null 2>&1 || true
    logout_human_session >/dev/null 2>&1 || true
  fi
  momo_cleanup_tracked_pids "hermes-gateway verifier" "$SERVER_PID"
  rm -f "$CREDENTIAL_HEADERS" "$PGPASS_FILE"
}
trap cleanup EXIT INT TERM

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
    DATABASE_URL="postgres://momo_app:momo_app_dev_pw@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
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
    '{"status":"running","detail":"mock gateway accepted agent.job"}' >/dev/null
}

post_legacy_gateway_event() {
  run_id=$1
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/events" \
    "$AGENT_GATEWAY_SECRET" '{"status":"running","detail":"mock gateway accepted agent.job"}' \
    X-Momo-Agent-Gateway-Secret >/dev/null
}

post_gateway_complete() {
  token=$1
  run_id=$2
  api_request POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${run_id}/gateway/complete" "$token" \
    "{\"status\":\"succeeded\",\"body\":$(json_escape "$FINAL_BODY"),\"usage\":{\"model\":\"hermes-agent\",\"prompt_tokens\":11,\"completion_tokens\":7,\"cached_tokens\":0,\"reasoning_tokens\":0,\"cost_micro_usd\":0,\"was_estimated\":true}}"
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
            client_msg_id IN ('${CLIENT_MSG_ID}', '${OTHER_CLIENT_MSG_ID}')
            OR body IN ('${BODY}', '${OTHER_BODY}')
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
     OR body = '${BODY}'
     OR body = '${FINAL_BODY}'
     OR body = '${AGENT_BODY}'
     OR body = '${OTHER_BODY}'
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

prepare_app_role() {
  psql_run >/dev/null <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    CREATE ROLE momo_app LOGIN PASSWORD 'momo_app_dev_pw';
  END IF;
END $$;
ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'momo_app_dev_pw';
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO momo_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO momo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO momo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO momo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO momo_app;
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

echo "[hermes-gateway] ensuring docker compose + migrations"
( cd "$REPO_ROOT" && make up >/dev/null && MIGRATE_IDEMPOTENCY_CHECK=1 make migrate >/dev/null )

cleanup_fixture_rows
prepare_app_role
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
PENDING_JSON=$(fetch_pending_jobs "$AGENT_TOKEN" "$AGENT_ID")
PENDING_COUNT=$(printf '%s' "$PENDING_JSON" | jq --arg run "$RUN_ID" '[.jobs[] | select((.runId | ascii_downcase) == ($run | ascii_downcase))] | length')
assert_equals "1" "$PENDING_COUNT" "agent bearer pending-job fallback"

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

post_gateway_event "$AGENT_TOKEN" "$RUN_ID"
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
assert_equals "2" "$AUDIT_COUNT" "gateway audit rows"
AUDIT_VIA_COUNT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${RUN_ID}' AND action IN ('agent.gateway.status','agent.gateway.completed') AND via_token_id='${AGENT_TOKEN_ID}'")
assert_equals "2" "$AUDIT_VIA_COUNT" "gateway audit rows via agent credential"

FINAL_BROADCAST_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('${RUN_ID}')")
assert_equals "1" "$FINAL_BROADCAST_COUNT" "durable final message broadcast idempotency"

JOB_DONE=$(psql_scalar "SELECT status FROM outbox WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id')=lower('${RUN_ID}') LIMIT 1")
assert_equals "done" "$JOB_DONE" "agent_job settled"

FULL_REVOKE_JSON=$(revoke_agent_credential "$ACCESS_TOKEN" "$AGENT_ID" "$AGENT_TOKEN_ID")
assert_equals "true" "$(printf '%s' "$FULL_REVOKE_JSON" | jq -r '.revokedNow')" "full credential revoke"
REVOKED_CALLBACK_CODE=$(api_status POST "/v1/workspaces/${WORKSPACE_ID}/agent-runs/${RUN_ID}/gateway/events" "$AGENT_TOKEN" '{"status":"running"}')
assert_equals "401" "$REVOKED_CALLBACK_CODE" "revoked token cannot callback"

stop_server
start_server 1
post_legacy_gateway_event "$OTHER_RUN_ID"
LEGACY_AUDIT_COUNT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='${WORKSPACE_ID}' AND run_id='${OTHER_RUN_ID}' AND action='agent.gateway.status' AND via_token_id IS NULL")
assert_equals "1" "$LEGACY_AUDIT_COUNT" "legacy flag migration case has no bearer provenance"

logout_human_session
stop_server
cleanup_fixture_rows

echo "[hermes-gateway] PASS: bearer_run=${RUN_ID} final_seq=${FINAL_SEQ} legacy_run=${OTHER_RUN_ID}"
echo "[hermes-gateway] real Hermes gateway CLI/plugin load remains runtime-unverified(real hermes gateway missing) unless a user-provided Hermes runtime is present."
