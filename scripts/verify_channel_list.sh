#!/usr/bin/env bash
# =============================================================================
# scripts/verify_channel_list.sh — MOMO-197 workspace channel list runtime gate
#
# Runs after make up && make migrate. It starts MomoServer with the normal
# NOBYPASSRLS app role, then verifies workspace channel reads, active channel
# membership filtering, archived filtering, and cross-workspace denial.
# =============================================================================
set -euo pipefail

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
    echo "[channels] missing required command: $1" >&2
    exit 1
  }
}

need curl
need jq

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[channels] psql not found; install PostgreSQL client/libpq and retry." >&2
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
WORKSPACE_B="22000000-0000-7000-8000-000000000001"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-channel-list-$RUN_ID"
SERVER_LOG="$TMP_DIR/momo-server.log"
SERVER_PID=""

mkdir -p "$TMP_DIR"

terminate_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    terminate_tree "$SERVER_PID"
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local token="${4:-}"
  local out="$TMP_DIR/response.json"
  local status
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$method")
  args+=(-H "Content-Type: application/json")
  if [ "$token" != "" ]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [ "$body" != "" ]; then
    args+=(--data "$body")
  fi
  status="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
  RESPONSE_STATUS="$status"
}

expect_status() {
  local expected="$1"
  local label="$2"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    echo "[channels] FAIL $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    echo "[channels] server log: $SERVER_LOG" >&2
    exit 1
  fi
  echo "[channels] PASS $label ($expected)" >&2
}

expect_jq() {
  local label="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  if ! printf '%s' "$RESPONSE_BODY" | jq -e "$@" >/dev/null; then
    echo "[channels] FAIL $label" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  echo "[channels] PASS $label" >&2
}

prepare_roles_and_fixture() {
  echo "[channels] preparing app role and channel-list fixture"
  psql_run <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    CREATE ROLE momo_app LOGIN PASSWORD 'momo_app_dev_pw';
  END IF;
END $$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO momo_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO momo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO momo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO momo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO momo_app;

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'momo_app') THEN
    RAISE EXCEPTION 'momo_app must be non-superuser/NOBYPASSRLS';
  END IF;
END $$;

BEGIN;
SET LOCAL row_security = off;

INSERT INTO workspace (id, slug, name)
VALUES ('22000000-0000-7000-8000-000000000001', 'momo-channels-b', 'MOMO Channels Workspace B')
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    updated_at = now();

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('00000000-0000-7000-8000-000000000198', '00000000-0000-7000-8000-000000000001',
   'human', 'active', 'Channel Nonmember', 'channel-nonmember'),
  ('22000000-0000-7000-8000-000000000101', '22000000-0000-7000-8000-000000000001',
   'human', 'active', 'Channels Human B', 'channels-b-human')
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    display_name = EXCLUDED.display_name,
    handle = EXCLUDED.handle,
    updated_at = now();

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('00000000-0000-7000-8000-000000000198', '00000000-0000-7000-8000-000000000001',
   'channel-nonmember@momo.local', true, 'dev-password-stub', 'Asia/Seoul'),
  ('22000000-0000-7000-8000-000000000101', '22000000-0000-7000-8000-000000000001',
   'channels-b@momo.local', true, 'dev-password-stub', 'Asia/Seoul')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    password_hash = EXCLUDED.password_hash,
    tz = EXCLUDED.tz;

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, archived_at)
VALUES
  ('00000000-0000-7000-8000-000000000298', '00000000-0000-7000-8000-000000000001',
   'public', 'left-channel', 'Should be hidden because membership left_at is set',
   '00000000-0000-7000-8000-000000000101', NULL),
  ('00000000-0000-7000-8000-000000000299', '00000000-0000-7000-8000-000000000001',
   'public', 'archived-channel', 'Hidden unless include_archived=true',
   '00000000-0000-7000-8000-000000000101', now()),
  ('22000000-0000-7000-8000-000000000201', '22000000-0000-7000-8000-000000000001',
   'public', 'channels-general-b', 'Channels fixture B',
   '22000000-0000-7000-8000-000000000101', NULL)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    topic = EXCLUDED.topic,
    archived_at = EXCLUDED.archived_at,
    updated_at = now();

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES
  ('00000000-0000-7000-8000-000000000298', '00000000-0000-7000-8000-000000000001', 0),
  ('00000000-0000-7000-8000-000000000299', '00000000-0000-7000-8000-000000000001', 0),
  ('22000000-0000-7000-8000-000000000201', '22000000-0000-7000-8000-000000000001', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role, left_at)
VALUES
  ('00000000-0000-7000-8000-000000000398', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000298',
   '00000000-0000-7000-8000-000000000101', 'member', now()),
  ('00000000-0000-7000-8000-000000000399', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000299',
   '00000000-0000-7000-8000-000000000101', 'member', NULL),
  ('22000000-0000-7000-8000-000000000301', '22000000-0000-7000-8000-000000000001',
   '22000000-0000-7000-8000-000000000201',
   '22000000-0000-7000-8000-000000000101', 'owner', NULL)
ON CONFLICT (id) DO UPDATE
SET role = EXCLUDED.role,
    left_at = EXCLUDED.left_at;

COMMIT;
SQL
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[channels] $BASE_URL is already serving /health; stop the existing server before running this verifier." >&2
    exit 1
  fi

  echo "[channels] starting MomoServer on $BASE_URL with momo_app"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="$APP_DATABASE_URL" swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"

  for _ in $(seq 1 90); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[channels] server health is green"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[channels] server exited before health became green" >&2
      tail -200 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done

  echo "[channels] timed out waiting for server health" >&2
  tail -200 "$SERVER_LOG" >&2 || true
  exit 1
}

login() {
  local email="$1"
  local workspace="$2"
  local body
  body="$(jq -cn \
    --arg email "$email" \
    --arg workspace "$workspace" \
    '{email:$email,password:"dev-password",workspace:$workspace}')"
  api POST /v1/auth/login "$body"
  expect_status 200 "login $email"
  printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken'
}

prepare_roles_and_fixture
start_server

DEMO_TOKEN="$(login demo@momo.local "$DEMO_WORKSPACE_ID")"
B_TOKEN="$(login channels-b@momo.local "$WORKSPACE_B")"
NONMEMBER_TOKEN="$(login channel-nonmember@momo.local "$DEMO_WORKSPACE_ID")"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/channels" "" "$DEMO_TOKEN"
expect_status 200 "demo channel list"
expect_jq '.channels | length == 2' "demo sees seeded active channels only"
expect_jq '.channels[] | select(.name == "general" and .kind == "public")' "general channel returned"
expect_jq '.channels[] | select(.name == "agent-lab" and .topic != null)' "agent-lab channel returned"
expect_jq 'all(.channels[]; .workspaceId == "'"$DEMO_WORKSPACE_ID"'")' "demo channels are workspace scoped"
expect_jq 'all(.channels[]; .name != "left-channel" and .name != "archived-channel")' "left and archived channels excluded by default"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/channels?include_archived=true" "" "$DEMO_TOKEN"
expect_status 200 "include archived channel list"
expect_jq '.channels[] | select(.name == "archived-channel" and .archivedAtMs != null)' "archived channel can be explicitly included"
expect_jq 'all(.channels[]; .name != "left-channel")' "left membership remains excluded with include_archived"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/channels" "" "$NONMEMBER_TOKEN"
expect_status 403 "workspace active membership required"

api GET "/v1/workspaces/$WORKSPACE_B/channels" "" "$DEMO_TOKEN"
expect_status 403 "demo token cannot read workspace B path"

api GET "/v1/workspaces/$WORKSPACE_B/channels" "" "$B_TOKEN"
expect_status 200 "workspace B channel list"
expect_jq '.channels | length == 1' "workspace B sees exactly its channel"
expect_jq '.channels[0].workspaceId == "'"$WORKSPACE_B"'" and .channels[0].name == "channels-general-b"' "workspace B channel is isolated"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/channels" "" "$B_TOKEN"
expect_status 403 "workspace B token cannot read demo path"

echo "[channels] PASS workspace channel list runtime verifier"
