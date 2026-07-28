#!/usr/bin/env bash
# =============================================================================
# scripts/verify_auth_hardening.sh — MOMO-300 auth hardening runtime gate
#
# Runs after make up && make migrate (dev compose Postgres). Boots a host
# MomoServer with the momo_app role and verifies the three MOMO-300 axes:
#
#   1. Centrifugo subscribe proxy shared-secret auth:
#        - callback without X-Centrifugo-Proxy-Secret        -> HTTP 401
#        - callback with a wrong secret                      -> HTTP 401
#        - connection JWT meta binds the exact credential    -> allow
#        - refresh/missing/arbitrary/mismatched binding      -> deny
#
# This verifier derives callback metadata from a server-minted connection JWT
# and proves the server-side credential binding. It does not independently
# prove that Centrifugo accepted the JWT signature at its websocket boundary.
#   2. Token revocation:
#        - login persists access/refresh rows in `token`
#        - POST /v1/auth/logout revokes them (idempotent) + audit_log row
#        - revoked access token on a protected route         -> HTTP 401
#        - subscribe proxy denies a member with no active session
#        - POST /v1/auth/refresh rotates; the old refresh replay -> HTTP 401
#   3. Rate limiting (per-member, in-memory sliding window):
#        - low RATE_LIMIT_PER_MEMBER trips 429 + Retry-After
#        - audit_log records rate_limit.exceeded (once per burst)
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

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
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[auth-hardening] missing required command: $1" >&2
    exit 1
  }
}

need curl
need jq
need python3
need swift

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[auth-hardening] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

PSQL_FLAGS=(-v ON_ERROR_STOP=1 --no-psqlrc -At)
psql_run() {
  if [ "${DATABASE_URL:-}" != "" ]; then
    "$PSQL_BIN" "$DATABASE_URL" "${PSQL_FLAGS[@]}" "$@"
  else
    "$PSQL_BIN" "${PSQL_FLAGS[@]}" "$@"
  fi
}

PORT="${PORT:-8080}"
BASE_URL="http://127.0.0.1:$PORT"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-momo}"
APP_DATABASE_URL="postgres://momo_app:momo_app_dev_pw@$POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
DEMO_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
# Dedicated fixture member: other verifiers in the same gate run log in the
# seeded demo member and leave ACTIVE session tokens behind, which would defeat
# the "subscribe denied after logout" assertion. This member's sessions exist
# only inside this verifier.
FIXTURE_MEMBER_ID="00000000-0000-7000-8000-000000300101"
FIXTURE_MEMBERSHIP_ID="00000000-0000-7000-8000-000000300301"
FIXTURE_EMAIL="momo-300-auth-hardening@momo.local"
PROXY_TEST_SECRET="momo-300-proxy-secret-$$"
MEMBER_RATE_LIMIT=10
# MOMO-300 gate-hang hardening: every curl must be bounded so a dead or
# unresponsive server converts a would-be infinite wait into a clear FAIL.
# --connect-timeout bounds the TCP handshake; --max-time bounds the whole
# request (a server that accepts the socket but never answers under memory
# pressure is the exact hang this verifier used to exhibit). Overridable via
# env for slower machines.
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-5}"
CURL_MAX_TIME="${CURL_MAX_TIME:-15}"
HEALTH_CONNECT_TIMEOUT="${HEALTH_CONNECT_TIMEOUT:-3}"
HEALTH_MAX_TIME="${HEALTH_MAX_TIME:-5}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-auth-hardening.XXXXXX")"
SERVER_LOG="$TMP_DIR/momo-server.log"
SERVER_PID=""
CURRENT_PLATFORM_ADMIN_EMAILS=""
CURRENT_PLATFORM_ADMIN_SECRET=""

cleanup() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    terminate_tree "$SERVER_PID"
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 10); do
    if ! curl -fsS --connect-timeout "$HEALTH_CONNECT_TIMEOUT" --max-time "$HEALTH_MAX_TIME" "$BASE_URL/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT INT TERM

terminate_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

stop_server() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    terminate_tree "$SERVER_PID"
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  SERVER_PID=""
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local token="${4:-}"
  local extra_header="${5:-}"
  local out="$TMP_DIR/response.json"
  local status
  local -a args=(-sS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" -o "$out" -w "%{http_code}" -X "$method")
  args+=(-H "Content-Type: application/json")
  if [ "$token" != "" ]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [ "$extra_header" != "" ]; then
    args+=(-H "$extra_header")
  fi
  if [ "$body" != "" ]; then
    args+=(--data "$body")
  fi
  # On connect failure / --max-time timeout curl still emits the %{http_code}
  # write-out (000) but exits non-zero; the `|| status=000` keeps set -e from
  # aborting mid-assertion so expect_status can report a clean mismatch + log.
  status="$(curl "${args[@]}" "$BASE_URL$path")" || status="000"
  RESPONSE_BODY="$(cat "$out" 2>/dev/null || true)"
  RESPONSE_STATUS="$status"
}

expect_status() {
  local expected="$1"
  local label="$2"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    echo "[auth-hardening] FAIL $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "[auth-hardening] response body withheld because auth responses may contain credentials" >&2
    echo "[auth-hardening] server log: $SERVER_LOG" >&2
    tail -80 "$SERVER_LOG" >&2 || true
    exit 1
  fi
  echo "[auth-hardening] PASS $label ($expected)" >&2
}

expect_jq() {
  local label="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  if ! printf '%s' "$RESPONSE_BODY" | jq -e "$@" >/dev/null; then
    echo "[auth-hardening] FAIL $label" >&2
    echo "[auth-hardening] response body withheld because auth responses may contain credentials" >&2
    exit 1
  fi
  echo "[auth-hardening] PASS $label" >&2
}

prepare_app_role() {
  echo "[auth-hardening] ensuring momo_app runtime role and fixture member exist"
  psql_run <<SQL >/dev/null
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    CREATE ROLE momo_app LOGIN PASSWORD 'momo_app_dev_pw';
  END IF;
END \$\$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';

DO \$\$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO momo_app', current_database());
END \$\$;
GRANT USAGE ON SCHEMA public TO momo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO momo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO momo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO momo_app;

BEGIN;
SET LOCAL row_security = off;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$FIXTURE_MEMBER_ID', '$DEMO_WORKSPACE_ID',
        'human', 'active', 'Auth Hardening 300', 'auth-hardening-300')
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    display_name = EXCLUDED.display_name,
    handle = EXCLUDED.handle,
    updated_at = now();

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$FIXTURE_MEMBER_ID', '$DEMO_WORKSPACE_ID',
        '$FIXTURE_EMAIL', true, momo_password_hash('dev-password'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    password_hash = EXCLUDED.password_hash,
    tz = EXCLUDED.tz;

-- 07-21 fffe303b(#564) 이후 라우트 authz는 workspace_membership을 읽는다. 이
-- 픽스처는 SQL 지름길로 멤버를 심으므로(실 REST join이면 자동 생성) 직접
-- 넣어야 한다. 없으면 첫 roster 호출부터 403이다(base에서도 재현 — 선존재).
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$FIXTURE_MEMBER_ID', 'member')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = EXCLUDED.role;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('$FIXTURE_MEMBERSHIP_ID', '$DEMO_WORKSPACE_ID',
        '$DEMO_CHANNEL_ID', '$FIXTURE_MEMBER_ID', 'member')
ON CONFLICT (id) DO UPDATE
SET role = EXCLUDED.role,
    left_at = NULL;

-- Re-runs of this verifier must start from a clean session slate.
UPDATE token
   SET revoked_at = now()
 WHERE workspace_id = '$DEMO_WORKSPACE_ID'
   AND actor_member_id = '$FIXTURE_MEMBER_ID'
   AND revoked_at IS NULL;

COMMIT;
SQL
}

# Known issue (execution-tracker MOMO-316 follow-up note): earlier verify_*.sh
# in the same gate profile can leak their child MomoServer binary (`swift run`
# parent is trap-killed, the spawned server survives). Reclaim the port before
# booting — but only ever kill a process that actually looks like MomoServer.
reclaim_leaked_server_port() {
  command -v lsof >/dev/null 2>&1 || return 0
  local pids pid cmd
  pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ "$pids" = "" ] && return 0
  for pid in $pids; do
    cmd="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *MomoServer*)
        echo "[auth-hardening] killing leaked MomoServer (pid $pid) holding port $PORT"
        kill "$pid" >/dev/null 2>&1 || true
        ;;
      *)
        echo "[auth-hardening] port $PORT is held by non-MomoServer process '${cmd:-unknown}' (pid $pid); refusing to kill it." >&2
        exit 1
        ;;
    esac
  done
  for _ in $(seq 1 20); do
    if [ "$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)" = "" ]; then
      return 0
    fi
    sleep 1
  done
  echo "[auth-hardening] port $PORT did not free after killing the leaked server" >&2
  exit 1
}

start_server() {
  reclaim_leaked_server_port
  if curl -fsS --connect-timeout "$HEALTH_CONNECT_TIMEOUT" --max-time "$HEALTH_MAX_TIME" "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[auth-hardening] $BASE_URL is already serving /health; stop the existing server before running this verifier." >&2
    exit 1
  fi

  echo "[auth-hardening] starting MomoServer on $BASE_URL (proxy secret set, RATE_LIMIT_PER_MEMBER=$MEMBER_RATE_LIMIT)"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="$APP_DATABASE_URL" \
    HOST="127.0.0.1" \
    PORT="$PORT" \
    CENT_PROXY_SECRET="$PROXY_TEST_SECRET" \
    PLATFORM_ADMIN_EMAILS="$CURRENT_PLATFORM_ADMIN_EMAILS" \
    PLATFORM_ADMIN_LOGIN_SECRET="$CURRENT_PLATFORM_ADMIN_SECRET" \
    MOMO_T3_ENABLED=1 \
    RATE_LIMIT_WINDOW_SECONDS=60 \
    RATE_LIMIT_PER_MEMBER="$MEMBER_RATE_LIMIT" \
    RATE_LIMIT_PER_IP=1200 \
    swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"

  for _ in $(seq 1 90); do
    if curl -fsS --connect-timeout "$HEALTH_CONNECT_TIMEOUT" --max-time "$HEALTH_MAX_TIME" "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[auth-hardening] server health is green"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[auth-hardening] server exited before health became green" >&2
      tail -200 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done

  echo "[auth-hardening] timed out waiting for server health" >&2
  tail -200 "$SERVER_LOG" >&2 || true
  exit 1
}

login_json() {
  local body
  body="$(jq -cn \
    --arg email "$FIXTURE_EMAIL" \
    --arg workspace "$DEMO_WORKSPACE_ID" \
    '{email:$email,password:"dev-password",workspace:$workspace}')"
  api POST /v1/auth/login "$body"
  expect_status 200 "login $FIXTURE_EMAIL"
  printf '%s' "$RESPONSE_BODY"
}

realtime_connection_meta() {
  local token="$1"
  local expected_member_id="$2"
  local expected_workspace_id="$3"
  # The JWT comes directly from the authenticated realtime-token response.
  # Decode its payload to synthesize Centrifugo callback metadata, then verify
  # the claims relevant to this fixture. Signature acceptance belongs to the
  # real Centrifugo websocket boundary and is not claimed by this verifier.
  # Never print the JWT.
  printf '%s' "$token" | python3 -c '
import base64
import binascii
import json
import sys
import time
import uuid

try:
    expected_member_id = sys.argv[1]
    expected_workspace_id = sys.argv[2]
    token = sys.stdin.read().strip()
    parts = token.split(".")
    if len(parts) != 3 or not parts[1]:
        raise ValueError
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    decoded = json.loads(base64.b64decode(
        payload.encode("ascii"), altchars=b"-_", validate=True
    ))
    if decoded.get("sub") != expected_member_id:
        raise ValueError
    workspace_id = decoded.get("ws")
    if workspace_id is not None and workspace_id != expected_workspace_id:
        raise ValueError

    now = time.time()
    exp = decoded.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise ValueError
    if exp <= now - 5 or exp > now + 600:
        raise ValueError
    nbf = decoded.get("nbf")
    if nbf is not None:
        if isinstance(nbf, bool) or not isinstance(nbf, (int, float)):
            raise ValueError
        if nbf > now + 5 or nbf >= exp:
            raise ValueError
    iat = decoded.get("iat")
    if iat is not None:
        if isinstance(iat, bool) or not isinstance(iat, (int, float)):
            raise ValueError
        if iat > now + 5 or iat >= exp or exp - iat > 600:
            raise ValueError

    meta = decoded.get("meta")
    if not isinstance(meta, dict):
        raise ValueError
    if meta.get("schema") != "momo.realtime.credential.v1":
        raise ValueError
    token_id = meta.get("token_id")
    if not isinstance(token_id, str):
        raise ValueError
    parsed_token_id = uuid.UUID(token_id)
    if str(parsed_token_id) != token_id.lower():
        raise ValueError
except (UnicodeError, ValueError, TypeError, json.JSONDecodeError, binascii.Error):
    raise SystemExit("invalid realtime credential metadata")

print(json.dumps(meta, separators=(",", ":"), sort_keys=True))
' "$expected_member_id" "$expected_workspace_id"
}

session_token_id() {
  local raw_token="$1"
  local expected_label="$2"
  local token_digest
  local token_id

  # Mirror TokenStore's digest(rawToken, 'sha256') contract locally. Only the
  # digest crosses the psql boundary; the raw bearer is never put in argv, SQL,
  # logs, or evidence.
  token_digest="$(printf '%s' "$raw_token" | python3 -c \
    'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
  token_id="$(psql_run <<SQL
SELECT id::text
  FROM token
 WHERE workspace_id = '$DEMO_WORKSPACE_ID'
   AND actor_member_id = '$MEMBER_ID'
   AND kind = 'session'
   AND label = '$expected_label'
   AND token_hash = decode('$token_digest', 'hex')
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now());
SQL
)"
  unset token_digest

  if ! printf '%s' "$token_id" | grep -Eq \
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
    echo "[auth-hardening] FAIL could not resolve exact active $expected_label token row" >&2
    exit 1
  fi
  printf '%s' "$token_id"
}

subscribe_proxy_body() {
  local member_id="$1"
  local connection_meta="$2"
  jq -cn \
    --arg user "$member_id" \
    --arg channel "ch:ws${DEMO_WORKSPACE_ID}.${DEMO_CHANNEL_ID}" \
    --argjson meta "$connection_meta" \
    '{client:"auth-hardening-verifier",user:$user,channel:$channel,meta:$meta}'
}

subscribe_proxy_body_without_meta() {
  local member_id="$1"
  jq -cn \
    --arg user "$member_id" \
    --arg channel "ch:ws${DEMO_WORKSPACE_ID}.${DEMO_CHANNEL_ID}" \
    '{client:"auth-hardening-verifier",user:$user,channel:$channel}'
}

prepare_app_role
start_server

# --------------------------------------------------------------------------
# 1. Subscribe proxy shared-secret authentication
# --------------------------------------------------------------------------
LOGIN1="$(login_json)"
ACCESS1="$(printf '%s' "$LOGIN1" | jq -r '.accessToken')"
REFRESH1="$(printf '%s' "$LOGIN1" | jq -r '.refreshToken')"
MEMBER_ID="$(printf '%s' "$LOGIN1" | jq -r '.member.id')"
if ! printf '%s' "$MEMBER_ID" | grep -Eq \
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  echo "[auth-hardening] FAIL login response member id is not a UUID" >&2
  exit 1
fi
ACCESS_TOKEN_ID="$(session_token_id "$ACCESS1" access)"
REFRESH_TOKEN_ID="$(session_token_id "$REFRESH1" refresh)"
if [ "$ACCESS_TOKEN_ID" = "$REFRESH_TOKEN_ID" ]; then
  echo "[auth-hardening] FAIL access and refresh tokens resolved to the same DB row" >&2
  exit 1
fi
echo "[auth-hardening] PASS access and refresh tokens resolve to distinct exact DB rows" >&2

api POST /v1/auth/realtime-token '{}' "$ACCESS1"
expect_status 200 "active access token mints realtime connection token"
REALTIME_TOKEN_RESPONSE="$RESPONSE_BODY"
if ! printf '%s' "$REALTIME_TOKEN_RESPONSE" | jq -e \
  --arg workspace "$DEMO_WORKSPACE_ID" \
  --arg member "$MEMBER_ID" \
  '.tokenType == "centrifugo.connection.jwt"
   and .workspaceId == $workspace
   and .memberId == $member
   and (.token | type == "string" and length > 0)' >/dev/null; then
  echo "[auth-hardening] FAIL realtime-token response contract is invalid" >&2
  exit 1
fi
REALTIME_CONNECTION_TOKEN="$(printf '%s' "$REALTIME_TOKEN_RESPONSE" | jq -er '.token')"
if ! CONNECTION_META="$(realtime_connection_meta \
  "$REALTIME_CONNECTION_TOKEN" "$MEMBER_ID" "$DEMO_WORKSPACE_ID" 2>/dev/null)"; then
  echo "[auth-hardening] FAIL realtime connection JWT metadata is invalid" >&2
  exit 1
fi
CONNECTION_TOKEN_ID="$(printf '%s' "$CONNECTION_META" | jq -er '.token_id')"
CONNECTION_TOKEN_ID_CANONICAL="$(printf '%s' "$CONNECTION_TOKEN_ID" | tr '[:upper:]' '[:lower:]')"
if [ "$CONNECTION_TOKEN_ID_CANONICAL" != "$ACCESS_TOKEN_ID" ]; then
  echo "[auth-hardening] FAIL realtime credential is not bound to the presented access-token row" >&2
  exit 1
fi
echo "[auth-hardening] PASS server-minted callback metadata binds the exact access-token DB row" >&2

PROXY_BODY="$(subscribe_proxy_body "$MEMBER_ID" "$CONNECTION_META")"
PROXY_BODY_WITHOUT_META="$(subscribe_proxy_body_without_meta "$MEMBER_ID")"
ARBITRARY_META="$(printf '%s' "$CONNECTION_META" | jq -c \
  '.token_id = "00000000-0000-7000-8000-000000388999"')"
ARBITRARY_PROXY_BODY="$(subscribe_proxy_body "$MEMBER_ID" "$ARBITRARY_META")"
REFRESH_META="$(printf '%s' "$CONNECTION_META" | jq -c \
  --arg token_id "$REFRESH_TOKEN_ID" '.token_id = $token_id')"
REFRESH_PROXY_BODY="$(subscribe_proxy_body "$MEMBER_ID" "$REFRESH_META")"
MISMATCH_MEMBER_ID="00000000-0000-7000-8000-000000000101"
MISMATCH_PROXY_BODY="$(subscribe_proxy_body "$MISMATCH_MEMBER_ID" "$CONNECTION_META")"

# Do not retain the raw connection JWT or the response that carried it after
# deriving the bounded proxy metadata fixture.
unset REALTIME_CONNECTION_TOKEN REALTIME_TOKEN_RESPONSE
RESPONSE_BODY=""

api POST /v1/centrifugo/subscribe "$PROXY_BODY"
expect_status 401 "subscribe proxy without shared secret rejected"

api POST /v1/centrifugo/subscribe "$PROXY_BODY" "" "X-Centrifugo-Proxy-Secret: wrong-secret"
expect_status 401 "subscribe proxy with wrong shared secret rejected"

api POST /v1/centrifugo/subscribe "$PROXY_BODY" "" "X-Centrifugo-Proxy-Secret: $PROXY_TEST_SECRET"
expect_status 200 "subscribe proxy with correct shared secret accepted"
expect_jq '.result != null and .error == null' "authorized member subscribe allowed"

api POST /v1/centrifugo/subscribe "$REFRESH_PROXY_BODY" "" "X-Centrifugo-Proxy-Secret: $PROXY_TEST_SECRET"
expect_status 200 "subscribe proxy answers for refresh-row credential binding"
expect_jq '.result == null and .error.code == 403' "refresh-token row cannot authorize realtime subscribe"

api POST /v1/centrifugo/subscribe "$PROXY_BODY_WITHOUT_META" "" "X-Centrifugo-Proxy-Secret: $PROXY_TEST_SECRET"
expect_status 200 "subscribe proxy answers for missing credential binding"
expect_jq '.result == null and .error.code == 403' "missing credential binding denied"

api POST /v1/centrifugo/subscribe "$ARBITRARY_PROXY_BODY" "" "X-Centrifugo-Proxy-Secret: $PROXY_TEST_SECRET"
expect_status 200 "subscribe proxy answers for arbitrary credential binding"
expect_jq '.result == null and .error.code == 403' "arbitrary credential binding denied"

api POST /v1/centrifugo/subscribe "$MISMATCH_PROXY_BODY" "" "X-Centrifugo-Proxy-Secret: $PROXY_TEST_SECRET"
expect_status 200 "subscribe proxy answers for mismatched credential binding"
expect_jq '.result == null and .error.code == 403' "credential binding for another member denied"

# --------------------------------------------------------------------------
# 2. Token persistence + logout revocation + revoked-token 401
# --------------------------------------------------------------------------
TOKEN_ROWS="$(psql_run <<SQL
SELECT count(*) FROM token
 WHERE workspace_id = '$DEMO_WORKSPACE_ID'
   AND actor_member_id = '$MEMBER_ID'
   AND kind = 'session'
   AND revoked_at IS NULL;
SQL
)"
if [ "${TOKEN_ROWS:-0}" -lt 2 ]; then
  echo "[auth-hardening] FAIL login must persist access+refresh token rows (got $TOKEN_ROWS)" >&2
  exit 1
fi
echo "[auth-hardening] PASS login persisted $TOKEN_ROWS active session token rows" >&2

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/roster" "" "$ACCESS1"
expect_status 200 "active access token reads roster"

LOGOUT_BODY="$(jq -cn --arg refreshToken "$REFRESH1" '{refreshToken:$refreshToken}')"
api POST /v1/auth/logout "$LOGOUT_BODY" "$ACCESS1"
expect_status 200 "logout revokes session"
expect_jq '.revokedAccess == true and .revokedRefresh == true and .alreadyRevoked == false' "logout revoked access+refresh"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/roster" "" "$ACCESS1"
expect_status 401 "revoked access token rejected with 401"

api POST /v1/auth/logout "$LOGOUT_BODY" "$ACCESS1"
expect_status 200 "repeated logout is idempotent"
expect_jq '.alreadyRevoked == true' "repeated logout reports alreadyRevoked"

api POST /v1/centrifugo/subscribe "$PROXY_BODY" "" "X-Centrifugo-Proxy-Secret: $PROXY_TEST_SECRET"
expect_status 200 "subscribe proxy answers after logout"
expect_jq '.result == null and .error.code == 403' "revoked exact access-token binding denied"

LOGOUT_AUDIT="$(psql_run <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id = '$DEMO_WORKSPACE_ID'
   AND actor_member_id = '$MEMBER_ID'
   AND action = 'auth.logout';
SQL
)"
if [ "${LOGOUT_AUDIT:-0}" -lt 1 ]; then
  echo "[auth-hardening] FAIL logout must write an auth.logout audit_log row" >&2
  exit 1
fi
echo "[auth-hardening] PASS auth.logout audit_log rows: $LOGOUT_AUDIT" >&2

# --------------------------------------------------------------------------
# 3. Refresh rotation: old refresh dies, new pair works
# --------------------------------------------------------------------------
LOGIN2="$(login_json)"
REFRESH2="$(printf '%s' "$LOGIN2" | jq -r '.refreshToken')"

REFRESH_BODY="$(jq -cn --arg refreshToken "$REFRESH2" '{refreshToken:$refreshToken}')"
api POST /v1/auth/refresh "$REFRESH_BODY"
expect_status 200 "refresh rotates the session"
NEW_ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken')"
expect_jq '.accessToken != null and .refreshToken != null' "refresh returns a new pair"

api POST /v1/auth/refresh "$REFRESH_BODY"
expect_status 401 "rotated (revoked) refresh token replay rejected"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/roster" "" "$NEW_ACCESS"
expect_status 200 "rotated access token works"

# --------------------------------------------------------------------------
# 3b. Refresh rotation is atomic under concurrency (MOMO-300 review fix)
#     N parallel refreshes with ONE token: exactly one may win (200), every
#     loser must get 401 — the atomic gate is TokenStore.revoke's
#     `UPDATE … WHERE revoked_at IS NULL RETURNING`, not the pre-check.
# --------------------------------------------------------------------------
LOGIN3="$(login_json)"
REFRESH3="$(printf '%s' "$LOGIN3" | jq -r '.refreshToken')"
RACE_BODY="$(jq -cn --arg refreshToken "$REFRESH3" '{refreshToken:$refreshToken}')"
RACE_N=6
RACE_DIR="$TMP_DIR/refresh-race"
mkdir -p "$RACE_DIR"
echo "[auth-hardening] firing $RACE_N concurrent refresh requests with one refresh token"
# ROOT CAUSE of the MOMO-300 gate hang: a bare `wait` here waits for EVERY
# background job of this shell — which includes the long-lived MomoServer
# started with `&` in start_server (SERVER_PID). When the server stays healthy
# through the burst (the normal path), that `wait` never returns and the gate
# hangs forever. Collect only the curl PIDs and wait on exactly those.
RACE_PIDS=()
for i in $(seq 1 "$RACE_N"); do
  # Bounded so a slow/dead server (memory pressure) makes each background curl
  # emit http_code 000 and exit instead of stalling. 000 is caught by the
  # status classifier below.
  curl -sS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    -o "$RACE_DIR/body-$i.json" -w '%{http_code}' \
    -H "Content-Type: application/json" \
    --data "$RACE_BODY" \
    "$BASE_URL/v1/auth/refresh" > "$RACE_DIR/status-$i" &
  RACE_PIDS+=("$!")
done
for race_pid in "${RACE_PIDS[@]}"; do
  wait "$race_pid" || true
done
RACE_WINS=0
RACE_401=0
for i in $(seq 1 "$RACE_N"); do
  RACE_STATUS="$(cat "$RACE_DIR/status-$i" 2>/dev/null || true)"
  case "$RACE_STATUS" in
    200) RACE_WINS=$((RACE_WINS + 1)) ;;
    401) RACE_401=$((RACE_401 + 1)) ;;
    *)
      echo "[auth-hardening] FAIL concurrent refresh $i returned unexpected HTTP '${RACE_STATUS:-none}'" >&2
      echo "[auth-hardening] response body withheld because refresh responses may contain credentials" >&2
      exit 1
      ;;
  esac
done
if [ "$RACE_WINS" != "1" ]; then
  echo "[auth-hardening] FAIL refresh rotation must be single-use under concurrency (got ${RACE_WINS}x200 / ${RACE_401}x401 of $RACE_N)" >&2
  exit 1
fi
echo "[auth-hardening] PASS refresh rotation atomic under concurrency (1x200, ${RACE_401}x401 of $RACE_N)" >&2

# --------------------------------------------------------------------------
# 4. Per-member rate limit: 429 + Retry-After + audit_log
# --------------------------------------------------------------------------
echo "[auth-hardening] hammering roster with $((MEMBER_RATE_LIMIT + 8)) requests to trip the member limit"
SAW_429=0
RETRY_AFTER=""
for _ in $(seq 1 $((MEMBER_RATE_LIMIT + 8))); do
  HDRS="$TMP_DIR/hammer-headers.txt"
  STATUS="$(curl -sS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    -o /dev/null -D "$HDRS" -w '%{http_code}' \
    -H "Authorization: Bearer $NEW_ACCESS" \
    "$BASE_URL/v1/workspaces/$DEMO_WORKSPACE_ID/roster")" || STATUS="000"
  # A dead/unresponsive server (the historical hang point) now surfaces as a
  # bounded 000 here; fail fast and loudly instead of looping into a wall.
  if [ "$STATUS" = "000" ]; then
    echo "[auth-hardening] FAIL roster hammer could not reach $BASE_URL (curl connect/timeout, http_code=000); the server likely died mid-burst" >&2
    echo "[auth-hardening] server log: $SERVER_LOG" >&2
    tail -80 "$SERVER_LOG" >&2 || true
    exit 1
  fi
  if [ "$STATUS" = "429" ]; then
    SAW_429=1
    RETRY_AFTER="$(awk 'tolower($1) == "retry-after:" {print $2}' "$HDRS" | tr -d '\r')"
    break
  fi
done
if [ "$SAW_429" != "1" ]; then
  echo "[auth-hardening] FAIL member rate limit did not return 429" >&2
  exit 1
fi
if [ "${RETRY_AFTER:-}" = "" ]; then
  echo "[auth-hardening] FAIL 429 response must carry Retry-After" >&2
  exit 1
fi
echo "[auth-hardening] PASS member rate limit tripped (429, Retry-After: ${RETRY_AFTER}s)" >&2

RATE_AUDIT="$(psql_run <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id = '$DEMO_WORKSPACE_ID'
   AND actor_member_id = '$MEMBER_ID'
   AND action = 'rate_limit.exceeded';
SQL
)"
if [ "${RATE_AUDIT:-0}" -lt 1 ]; then
  echo "[auth-hardening] FAIL rate_limit.exceeded audit_log row missing" >&2
  exit 1
fi
echo "[auth-hardening] PASS rate_limit.exceeded audit_log rows: $RATE_AUDIT" >&2

# Health stays reachable during/after the burst (excluded path).
api GET /health
expect_status 200 "/health is excluded from rate limiting"

# --------------------------------------------------------------------------
# 5. Privileged refresh revalidation + bulk sibling revocation (#884)
# --------------------------------------------------------------------------
stop_server
CURRENT_PLATFORM_ADMIN_EMAILS="$FIXTURE_EMAIL"
CURRENT_PLATFORM_ADMIN_SECRET="auth-hardening-admin-secret"
start_server

ADMIN_LOGIN_BODY="$(jq -cn \
  --arg email "$FIXTURE_EMAIL" \
  --arg workspace "$DEMO_WORKSPACE_ID" \
  --arg secret "$CURRENT_PLATFORM_ADMIN_SECRET" \
  '{email:$email,password:"dev-password",workspace:$workspace,platformAdminSecret:$secret}')"
api POST /v1/auth/login "$ADMIN_LOGIN_BODY"
expect_status 200 "operator login before allowlist removal"
PRIVILEGED_ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.accessToken')"
PRIVILEGED_REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -er '.refreshToken')"
printf '%s' "$PRIVILEGED_ACCESS" | python3 -c '
import base64, json, sys
parts = sys.stdin.read().strip().split(".")
payload = parts[1] + "=" * (-len(parts[1]) % 4)
scopes = json.loads(base64.urlsafe_b64decode(payload))["scopes"]
required = {"platform:read", "platform:credits:write"}
raise SystemExit(0 if required.issubset(scopes) else 1)
' || {
  echo "[auth-hardening] FAIL operator login did not mint both privileged scopes" >&2
  exit 1
}

stop_server
if [ "${AUTH_GATE_PROVE_RED_PRIVILEGED_REFRESH:-0}" = "1" ]; then
  # Behavioral red proof: keep the operator eligible across the restart,
  # simulating the pre-fix refresh behavior. The named scope-removal assertion
  # below must turn red.
  CURRENT_PLATFORM_ADMIN_EMAILS="$FIXTURE_EMAIL"
else
  CURRENT_PLATFORM_ADMIN_EMAILS=""
fi
start_server

PRIVILEGED_REFRESH_BODY="$(jq -cn \
  --arg refreshToken "$PRIVILEGED_REFRESH" \
  '{refreshToken:$refreshToken}')"
api POST /v1/auth/refresh "$PRIVILEGED_REFRESH_BODY"
expect_status 200 "allowlist removal preserves ordinary refresh"
DOWNGRADED_ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.accessToken')"
printf '%s' "$DOWNGRADED_ACCESS" | python3 -c '
import base64, json, sys
parts = sys.stdin.read().strip().split(".")
payload = parts[1] + "=" * (-len(parts[1]) % 4)
scopes = set(json.loads(base64.urlsafe_b64decode(payload))["scopes"])
forbidden = {"platform:read", "platform:credits:write"}
raise SystemExit(0 if scopes.isdisjoint(forbidden) else 1)
' || {
  echo "[auth-hardening] FAIL named privileged-refresh-revalidation: refreshed token retained a privileged scope" >&2
  exit 1
}
echo "[auth-hardening] PASS named privileged-refresh-revalidation stripped both privileged scopes" >&2

api GET /v1/platform/workspaces "" "$DOWNGRADED_ACCESS"
expect_status 403 "downgraded refresh cannot read cross-tenant platform workspaces"
api POST "/v1/admin/workspaces/$DEMO_WORKSPACE_ID/credits/topups" \
  "$(jq -cn --arg ref "$(python3 -c 'import uuid; print(uuid.uuid4())')" \
    '{amountMicroUsd:1,idempotencyRef:$ref}')" \
  "$DOWNGRADED_ACCESS"
expect_status 403 "downgraded refresh cannot top up T3 credit"
api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$DEMO_CHANNEL_ID/messages" \
  "" "$DOWNGRADED_ACCESS"
expect_status 200 "downgraded refresh keeps messages read path"
api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/roster" "" "$PRIVILEGED_ACCESS"
expect_status 401 "allowlist loss bulk-revokes sibling privileged access tokens"

echo "[auth-hardening] MOMO-300 auth hardening gate PASS"
echo "[auth-hardening] evidence: proxy-secret 401, server-minted exact access-row binding allow, refresh/missing/arbitrary/mismatched/revoked binding deny, revoked-token 401, logout idempotent + audit, refresh rotation replay 401, privileged refresh downgrade (platform read/topup 403 + messages 200 + sibling revoke), member 429 + Retry-After + audit"
