#!/usr/bin/env bash
# =============================================================================
# scripts/verify_platform_admin.sh — MOMO-013 platform admin runtime gate
#
# Runs after make up && make migrate. It starts MomoServer with:
#   - DATABASE_URL=momo_app (NOBYPASSRLS normal tenant path)
#   - PLATFORM_ADMIN_DATABASE_URL=momo_platform_admin (BYPASSRLS, SELECT-only)
# and verifies ordinary tenant tokens are denied while platform:read tokens can
# inspect workspace/member/invite state across at least two workspaces.
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
    echo "[platform] missing required command: $1" >&2
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
  echo "[platform] psql not found; install PostgreSQL client/libpq and retry." >&2
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
PLATFORM_ADMIN_DATABASE_URL="postgres://momo_platform_admin:momo_platform_admin_dev_pw@$POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
PLATFORM_ADMIN_EMAILS="${PLATFORM_ADMIN_EMAILS:-demo@momo.local}"
PLATFORM_ADMIN_LOGIN_SECRET="${PLATFORM_ADMIN_LOGIN_SECRET:-platform-admin-dev-secret}"
DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
WORKSPACE_A="10000000-0000-7000-8000-000000000001"
WORKSPACE_B="20000000-0000-7000-8000-000000000001"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-platform-admin-$RUN_ID"
SERVER_LOG="$TMP_DIR/momo-server.log"
SERVER_PID=""

mkdir -p "$TMP_DIR"

cleanup() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    terminate_tree "$SERVER_PID"
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 10); do
    if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
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
    echo "[platform] FAIL $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    echo "[platform] server log: $SERVER_LOG" >&2
    exit 1
  fi
  echo "[platform] PASS $label ($expected)" >&2
}

expect_jq() {
  local label="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  if ! printf '%s' "$RESPONSE_BODY" | jq -e "$@" >/dev/null; then
    echo "[platform] FAIL $label" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  echo "[platform] PASS $label" >&2
}

prepare_roles_and_fixture() {
  echo "[platform] preparing app/platform roles and two-workspace fixture"
  psql_run <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    CREATE ROLE momo_app LOGIN PASSWORD 'momo_app_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_platform_admin') THEN
    CREATE ROLE momo_platform_admin LOGIN PASSWORD 'momo_platform_admin_dev_pw';
  END IF;
END $$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';
ALTER ROLE momo_platform_admin
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_platform_admin_dev_pw';

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO momo_app, momo_platform_admin',
    current_database()
  );
END $$;
GRANT USAGE ON SCHEMA public TO momo_app, momo_platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO momo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO momo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO momo_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO momo_platform_admin;

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'momo_app') THEN
    RAISE EXCEPTION 'momo_app must be non-superuser/NOBYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_platform_admin') THEN
    RAISE EXCEPTION 'momo_platform_admin must be BYPASSRLS';
  END IF;
  IF has_table_privilege('momo_platform_admin', 'workspace', 'INSERT')
     OR has_table_privilege('momo_platform_admin', 'member', 'UPDATE')
     OR has_table_privilege('momo_platform_admin', 'invite_code', 'DELETE') THEN
    RAISE EXCEPTION 'momo_platform_admin must be SELECT-only';
  END IF;
END $$;

BEGIN;
SET LOCAL row_security = off;

INSERT INTO workspace (id, slug, name)
VALUES
  ('10000000-0000-7000-8000-000000000001', 'momo-platform-a', 'MOMO Platform Workspace A'),
  ('20000000-0000-7000-8000-000000000001', 'momo-platform-b', 'MOMO Platform Workspace B')
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    updated_at = now();

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('10000000-0000-7000-8000-000000000101', '10000000-0000-7000-8000-000000000001',
   'human', 'active', 'Platform Human A', 'platform-a-human'),
  ('10000000-0000-7000-8000-000000000103', '10000000-0000-7000-8000-000000000001',
   'agent', 'active', 'Platform Agent A', 'platform-a-agent-momo013'),
  ('20000000-0000-7000-8000-000000000101', '20000000-0000-7000-8000-000000000001',
   'human', 'active', 'Platform Human B', 'platform-b-human')
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    display_name = EXCLUDED.display_name,
    handle = EXCLUDED.handle,
    updated_at = now();

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('10000000-0000-7000-8000-000000000101', '10000000-0000-7000-8000-000000000001',
   'platform-a@momo.local', true, 'dev-password-stub', 'Asia/Seoul'),
  ('20000000-0000-7000-8000-000000000101', '20000000-0000-7000-8000-000000000001',
   'platform-b@momo.local', true, 'dev-password-stub', 'Asia/Seoul')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    password_hash = EXCLUDED.password_hash,
    tz = EXCLUDED.tz;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('10000000-0000-7000-8000-000000000103', '10000000-0000-7000-8000-000000000001',
   'hermes-agent', 'http://localhost:8088/v1', 'platform admin verifier agent',
   '10000000-0000-7000-8000-000000000101')
ON CONFLICT (member_id) DO UPDATE
SET model = EXCLUDED.model,
    base_url = EXCLUDED.base_url,
    system_prompt = EXCLUDED.system_prompt,
    owner_human_id = EXCLUDED.owner_human_id,
    updated_at = now();

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
VALUES
  ('10000000-0000-7000-8000-000000000201', '10000000-0000-7000-8000-000000000001',
   'public', 'platform-general-a', 'Platform fixture A', '10000000-0000-7000-8000-000000000101'),
  ('20000000-0000-7000-8000-000000000201', '20000000-0000-7000-8000-000000000001',
   'public', 'platform-general-b', 'Platform fixture B', '20000000-0000-7000-8000-000000000101')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    topic = EXCLUDED.topic,
    updated_at = now();

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES
  ('10000000-0000-7000-8000-000000000201', '10000000-0000-7000-8000-000000000001', 0),
  ('20000000-0000-7000-8000-000000000201', '20000000-0000-7000-8000-000000000001', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES
  ('10000000-0000-7000-8000-000000000301', '10000000-0000-7000-8000-000000000001',
   '10000000-0000-7000-8000-000000000201', '10000000-0000-7000-8000-000000000101', 'owner'),
  ('10000000-0000-7000-8000-000000000303', '10000000-0000-7000-8000-000000000001',
   '10000000-0000-7000-8000-000000000201', '10000000-0000-7000-8000-000000000103', 'member'),
  ('20000000-0000-7000-8000-000000000301', '20000000-0000-7000-8000-000000000001',
   '20000000-0000-7000-8000-000000000201', '20000000-0000-7000-8000-000000000101', 'owner')
ON CONFLICT (id) DO UPDATE
SET role = EXCLUDED.role,
    left_at = NULL;

INSERT INTO invite_code
  (id, workspace_id, code_hash, code_preview, role, max_uses, used_count,
   expires_at, created_by, last_used_at)
VALUES
  ('10000000-0000-7000-8000-000000000601', '10000000-0000-7000-8000-000000000001',
   momo_invite_code_hash('platform-a-invite-code'), 'de-A', 'member', 5, 1,
   now() + interval '1 day', '10000000-0000-7000-8000-000000000101', now()),
  ('20000000-0000-7000-8000-000000000601', '20000000-0000-7000-8000-000000000001',
   momo_invite_code_hash('platform-b-invite-code'), 'de-B', 'member', 5, 1,
   now() + interval '1 day', '20000000-0000-7000-8000-000000000101', now())
ON CONFLICT (id) DO UPDATE
SET code_hash = EXCLUDED.code_hash,
    code_preview = EXCLUDED.code_preview,
    role = EXCLUDED.role,
    max_uses = EXCLUDED.max_uses,
    used_count = EXCLUDED.used_count,
    expires_at = EXCLUDED.expires_at,
    revoked_at = NULL,
    revoked_by = NULL,
    revocation_reason = NULL,
    last_used_at = EXCLUDED.last_used_at,
    updated_at = now();

INSERT INTO invite_code_redemption (id, workspace_id, invite_code_id, member_id, email)
VALUES
  ('10000000-0000-7000-8000-000000000701', '10000000-0000-7000-8000-000000000001',
   '10000000-0000-7000-8000-000000000601', '10000000-0000-7000-8000-000000000101',
   'platform-a@momo.local'),
  ('20000000-0000-7000-8000-000000000701', '20000000-0000-7000-8000-000000000001',
   '20000000-0000-7000-8000-000000000601', '20000000-0000-7000-8000-000000000101',
   'platform-b@momo.local')
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email;

COMMIT;
SQL
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[platform] $BASE_URL is still serving /health; waiting for prior verifier server to exit"
    for _ in $(seq 1 10); do
      sleep 1
      if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
        break
      fi
    done
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[platform] $BASE_URL is already serving /health; stop the existing server before running this verifier." >&2
      exit 1
    fi
  fi

  echo "[platform] starting MomoServer on $BASE_URL"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="$APP_DATABASE_URL" \
    PLATFORM_ADMIN_DATABASE_URL="$PLATFORM_ADMIN_DATABASE_URL" \
    PLATFORM_ADMIN_EMAILS="$PLATFORM_ADMIN_EMAILS" \
    PLATFORM_ADMIN_LOGIN_SECRET="$PLATFORM_ADMIN_LOGIN_SECRET" \
    swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"

  for _ in $(seq 1 90); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[platform] server health is green"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[platform] server exited before health became green" >&2
      tail -200 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done

  echo "[platform] timed out waiting for server health" >&2
  tail -200 "$SERVER_LOG" >&2 || true
  exit 1
}

login_token() {
  local email="$1"
  local workspace="$2"
  local password="$3"
  local label="$4"
  local body
  body="$(jq -cn \
    --arg email "$email" \
    --arg workspace "$workspace" \
    --arg password "$password" \
    '{email:$email,password:$password,workspace:$workspace}')"
  api POST /v1/auth/login "$body"
  expect_status 200 "$label login"
  printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken'
}

prepare_roles_and_fixture
start_server

PLATFORM_EMAIL_NO_SECRET_TOKEN="$(login_token demo@momo.local "$DEMO_WORKSPACE_ID" "dev-password" "platform email without secret")"
PLATFORM_TOKEN="$(login_token demo@momo.local "$DEMO_WORKSPACE_ID" "$PLATFORM_ADMIN_LOGIN_SECRET" "platform admin")"
TENANT_TOKEN="$(login_token platform-a@momo.local "$WORKSPACE_A" "dev-password" "ordinary tenant")"

api GET /v1/platform/workspaces "" "$TENANT_TOKEN"
expect_status 403 "ordinary tenant denied platform workspace list"

api GET /v1/platform/workspaces "" "$PLATFORM_EMAIL_NO_SECRET_TOKEN"
expect_status 403 "platform allowlisted email without secret denied platform workspace list"

api GET /v1/platform/workspaces "" "$PLATFORM_TOKEN"
expect_status 200 "platform workspace list"
expect_jq --arg a "$WORKSPACE_A" --arg b "$WORKSPACE_B" \
  '.workspaces | (map(.id) | index($a)) and (map(.id) | index($b))' \
  "platform sees both fixture workspaces"
expect_jq --arg a "$WORKSPACE_A" \
  '.workspaces[] | select(.id == $a) | .inviteCodeCount >= 1 and .inviteRedemptionCount >= 1' \
  "workspace invite usage fields"

api GET /v1/platform/members "" "$PLATFORM_TOKEN"
expect_status 200 "platform member list"
expect_jq --arg a "$WORKSPACE_A" --arg b "$WORKSPACE_B" \
  '.members | (map(.workspaceId) | index($a)) and (map(.workspaceId) | index($b))' \
  "platform sees members across tenants"
expect_jq '.members[] | select(.handle == "platform-a-agent-momo013") | .kind == "agent" and .agentModel == "hermes-agent"' \
  "platform member list includes agent metadata"

api GET /v1/platform/invites "" "$PLATFORM_TOKEN"
expect_status 200 "platform invite list"
expect_jq --arg a "$WORKSPACE_A" --arg b "$WORKSPACE_B" \
  '.invites | (map(.workspaceId) | index($a)) and (map(.workspaceId) | index($b))' \
  "platform sees invite usage across tenants"
expect_jq '.invites | all(has("codeHash") | not) and all(has("code") | not)' \
  "platform invite list does not expose raw/hash secrets"

echo "[platform] PASS"
