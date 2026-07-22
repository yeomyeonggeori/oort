#!/usr/bin/env bash
# =============================================================================
# scripts/verify_macos_real_backend_ui.sh — MOMO-205 real-backend macOS smoke gate
#
# Verifies the SwiftPM MomoMacDevApp REST backend path against a per-run,
# marker/OID-owned database on local Docker + host MomoServer. GUI launch is
# opt-in with LOCAL_GATE_LAUNCH_UI=1 so headless runners can still PASS the
# deterministic REST/evidence portion without touching source dogfood data.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/runtime_process_guard.sh
. "$REPO_ROOT/scripts/runtime_process_guard.sh"

fail() {
  echo "[macos-real-backend] FAIL: $*" >&2
  if [ "${SERVER_LOG:-}" != "" ] && [ -f "$SERVER_LOG" ]; then
    echo "[macos-real-backend] server log: $SERVER_LOG" >&2
    tail -160 "$SERVER_LOG" >&2 || true
  fi
  if [ "${UI_LOG:-}" != "" ] && [ -f "$UI_LOG" ]; then
    echo "[macos-real-backend] UI log: $UI_LOG" >&2
    tail -160 "$UI_LOG" >&2 || true
  fi
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
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

require_bin curl
require_bin jq
require_bin python3
require_bin shasum
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

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_USER="${POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-momo_dev_pw}"
SOURCE_POSTGRES_DB="${POSTGRES_DB:-momo}"
SOURCE_DATABASE_URL="${DATABASE_URL:-}"
POSTGRES_DB="${MACOS_REAL_BACKEND_VERIFIER_DB:-momo_macos_ui_verify_${POSTGRES_PORT}_$$}"
VERIFIER_DB_MARKER_PREFIX="momo:macos-real-backend-verifier:v1:"
VERIFIER_DB_MARKER="${VERIFIER_DB_MARKER_PREFIX}$(python3 -c 'import uuid; print(uuid.uuid4())')"
VERIFIER_DB_CREATED_OID=""
VERIFIER_DB_OWNED=0
SOURCE_DIGEST_ARMED=0
ROLE_SUFFIX="$(printf '%s' "$VERIFIER_DB_MARKER" | shasum -a 256 | cut -c 1-12)"
VERIFIER_APP_ROLE="momo_mac_${ROLE_SUFFIX}_app"
VERIFIER_WORKER_ROLE="momo_mac_${ROLE_SUFFIX}_worker"
VERIFIER_RELAY_ROLE="momo_mac_${ROLE_SUFFIX}_relay"
VERIFIER_APP_PASSWORD="momo_macos_verify_app_pw"
VERIFIER_WORKER_PASSWORD="momo_macos_verify_worker_pw"
VERIFIER_RELAY_PASSWORD="momo_macos_verify_relay_pw"
PORT="${PORT:-8080}"
CENT_PORT="${CENT_PORT:-8000}"
CENT_API_KEY="${CENT_API_KEY:-dev-insecure-cent-api-key}"
CENT_API_URL="${CENT_API_URL:-http://localhost:${CENT_PORT}/api}"
JWT_HMAC="${JWT_HMAC:-dev-insecure-jwt-hmac-change-me}"
CENT_TOKEN_HMAC="${CENT_TOKEN_HMAC:-dev-insecure-cent-token-hmac}"

APP_DATABASE_URL="postgres://${VERIFIER_APP_ROLE}:${VERIFIER_APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
BASE_URL="http://127.0.0.1:${PORT}"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
HUMAN_EMAIL="demo@momo.local"
HUMAN_ID="00000000-0000-7000-8000-000000000101"
AGENT_ID="00000000-0000-7000-8000-000000000103"
AGENT_HANDLE="hermes"
CHANNEL_ID="$(python3 -c 'import sys, uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1] + ":agent-lab-channel"))' "$VERIFIER_DB_MARKER")"
# Centrifugo channel strings are case-sensitive while Swift UUID rendering is
# uppercase. Keep the verifier-side spelling aligned if history checks are added.
CENT_CHANNEL="ch:ws$(printf '%s' "${WORKSPACE_ID}.${CHANNEL_ID}" | tr '[:lower:]' '[:upper:]')"
RUN_ID_FIXTURE="00000000-0000-7000-8000-000000205101"
APPROVAL_MSG_ID="00000000-0000-7000-8000-000000205201"
APPROVAL_ID="00000000-0000-7000-8000-000000205301"
USAGE_ID="00000000-0000-7000-8000-000000205401"
CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MENTION_CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
MESSAGE_BODY="MOMO-205 real-backend GUI smoke ${RUN_SUFFIX}"
MENTION_BODY="@${AGENT_HANDLE} MOMO-256 macOS Hermes mention smoke ${RUN_SUFFIX}"

OUT_DIR="${MACOS_REAL_BACKEND_OUT_DIR:-${TMPDIR:-/tmp}/momo-macos-real-backend}"
mkdir -p "$OUT_DIR"
SERVER_LOG="$OUT_DIR/momo-server-${RUN_SUFFIX}.log"
UI_LOG="$OUT_DIR/macos-dev-app-${RUN_SUFFIX}.log"
REST_LOGIN_FILE="$OUT_DIR/login-${RUN_SUFFIX}.json"
REST_CHANNELS_FILE="$OUT_DIR/channels-${RUN_SUFFIX}.json"
REST_ROSTER_FILE="$OUT_DIR/roster-${RUN_SUFFIX}.json"
REST_INVITE_CREATE_FILE="$OUT_DIR/invite-create-${RUN_SUFFIX}.json"
REST_INVITE_LIST_FILE="$OUT_DIR/invite-list-${RUN_SUFFIX}.json"
REST_INVITE_REVOKE_FILE="$OUT_DIR/invite-revoke-${RUN_SUFFIX}.json"
REST_JOIN_INVITE_CREATE_FILE="$OUT_DIR/invite-create-join-${RUN_SUFFIX}.json"
REST_JOIN_FILE="$OUT_DIR/join-${RUN_SUFFIX}.json"
REST_JOIN_INVITE_LIST_FILE="$OUT_DIR/invite-list-after-join-${RUN_SUFFIX}.json"
REST_SECOND_CHANNELS_FILE="$OUT_DIR/second-user-channels-${RUN_SUFFIX}.json"
REST_SECOND_MEMBERS_FILE="$OUT_DIR/second-user-members-${RUN_SUFFIX}.json"
REST_CHANNEL_CREATE_FILE="$OUT_DIR/channel-create-${RUN_SUFFIX}.json"
REST_MEMBER_ADD_FILE="$OUT_DIR/member-add-${RUN_SUFFIX}.json"
REST_MEMBER_REMOVE_FILE="$OUT_DIR/member-remove-${RUN_SUFFIX}.json"
REST_SEND_FILE="$OUT_DIR/send-${RUN_SUFFIX}.json"
REST_MENTION_SEND_FILE="$OUT_DIR/mention-send-${RUN_SUFFIX}.json"
REST_HISTORY_FILE="$OUT_DIR/history-${RUN_SUFFIX}.json"
EVIDENCE_FILE="$OUT_DIR/evidence-${RUN_SUFFIX}.md"
SERVER_PID=""
UI_RESULT="skipped"
LAUNCHCTL_ENV_KEYS=()

set_launchctl_env() {
  local key="$1"
  local value="$2"
  /bin/launchctl setenv "$key" "$value"
  LAUNCHCTL_ENV_KEYS+=("$key")
}

unset_launchctl_env() {
  local key
  for key in "${LAUNCHCTL_ENV_KEYS[@]:-}"; do
    /bin/launchctl unsetenv "$key" >/dev/null 2>&1 || true
  done
  LAUNCHCTL_ENV_KEYS=()
}

cleanup() {
  local original_rc=$?
  local cleanup_failed=0
  local source_after
  trap - EXIT
  unset_launchctl_env
  momo_cleanup_tracked_pids "macos real-backend verifier" "${SERVER_PID:-}"
  if [ "${SOURCE_DIGEST_ARMED:-0}" = "1" ]; then
    source_after="$(source_digest)" || cleanup_failed=1
    if [ "$cleanup_failed" = "0" ] && [ "$source_after" != "$SOURCE_DIGEST_BEFORE" ]; then
      echo "[macos-real-backend] source dogfood DB changed while isolated verifier ran" >&2
      cleanup_failed=1
    elif [ "$cleanup_failed" = "0" ]; then
      echo "[macos-real-backend] source dogfood DB digest preserved"
    fi
  fi
  cleanup_verifier_database || {
    echo "[macos-real-backend] exact verifier DB cleanup failed" >&2
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

psql_admin() {
  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

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
SELECT md5(COALESCE(string_agg(
  format('%I.%I:%s:%s',
         n.nspname,
         c.relname,
         table_to_xmlschema(c.oid::regclass, true, false, ''),
         table_to_xml(c.oid::regclass, true, false, '')),
  '|' ORDER BY n.nspname, c.relname), ''))
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p');
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
    raise SystemExit("[macos-real-backend] DATABASE_URL and admin target must both be loopback")
if port != int(expected_port) or database != expected_db:
    raise SystemExit("[macos-real-backend] DATABASE_URL source does not match admin port/database")
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
  if [ "${MACOS_REAL_BACKEND_VERIFIER_TEST_FAIL_COMMENT:-0}" = "1" ]; then
    echo "[macos-real-backend] intentional verifier COMMENT failure (test only)" >&2
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
    MOMO_AGENT_SEED_MODE=none "$REPO_ROOT/scripts/migrate.sh" >/dev/null

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
GRANT USAGE ON SCHEMA momo_join_private TO $VERIFIER_APP_ROLE;
GRANT EXECUTE ON FUNCTION momo_join_private.invite_workspace_id(text) TO $VERIFIER_APP_ROLE;
SQL
}

cleanup_verifier_database() {
  local current_oid current_marker role role_marker
  [ "${VERIFIER_DB_OWNED:-0}" = "1" ] || return 0
  current_oid="$(admin_scalar "SELECT COALESCE(oid::text, '') FROM pg_database WHERE datname = '$POSTGRES_DB';")" || return 1
  current_marker="$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$POSTGRES_DB';")" || return 1
  if [ "$current_oid" != "$VERIFIER_DB_CREATED_OID" ] \
    || { [ "$current_marker" != "$VERIFIER_DB_MARKER" ] && [ "$current_marker" != "" ]; }; then
    echo "[macos-real-backend] refusing verifier cleanup: DB identity changed" >&2
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

wait_http() {
  local url="$1"
  local name="$2"
  local deadline
  local wait_seconds="${MACOS_REAL_BACKEND_WAIT_SECONDS:-240}"
  if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]] || [ "$wait_seconds" -lt 1 ]; then
    fail "MACOS_REAL_BACKEND_WAIT_SECONDS must be a positive integer"
  fi
  deadline=$(($(date +%s) + wait_seconds))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[macos-real-backend] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not become ready: ${url}"
}

echo "[macos-real-backend] using env file: ${ENV_FILE:-<none>}"
echo "[macos-real-backend] api=${BASE_URL} postgres_port=${POSTGRES_PORT} source_db=${SOURCE_POSTGRES_DB} launch_ui=${LOCAL_GATE_LAUNCH_UI:-0}"

echo "[macos-real-backend] ensuring local PostgreSQL/Centrifugo services are running"
(cd "$REPO_ROOT" && POSTGRES_DB="$SOURCE_POSTGRES_DB" make ENV_FILE="$ENV_FILE" up)
validate_admin_target
SOURCE_DIGEST_BEFORE="$(source_digest)"
SOURCE_DIGEST_ARMED=1
echo "[macos-real-backend] provisioning isolated verifier database: $POSTGRES_DB"
provision_verifier_database

echo "[macos-real-backend] seeding isolated demo/Hermes and approval/cost fixtures"
psql_admin <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '${WORKSPACE_ID}';

INSERT INTO workspace (id, slug, name)
VALUES ('${WORKSPACE_ID}', 'macos-ui-verifier', 'macOS UI Verifier Workspace')
ON CONFLICT (id) DO UPDATE
  SET deleted_at = NULL,
      name = EXCLUDED.name;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('${HUMAN_ID}', '${WORKSPACE_ID}', 'human', 'active', 'macOS UI Verifier Human', 'demo'),
  ('${AGENT_ID}', '${WORKSPACE_ID}', 'agent', 'active', 'Hermes', '${AGENT_HANDLE}')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle,
      deleted_at = NULL;

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('${HUMAN_ID}', '${WORKSPACE_ID}', '${HUMAN_EMAIL}', true,
        momo_password_hash('dev-password'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
  SET email = EXCLUDED.email,
      email_verified = true,
      password_hash = EXCLUDED.password_hash,
      tz = EXCLUDED.tz;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('${AGENT_ID}', '${WORKSPACE_ID}', 'hermes-agent', 'http://localhost:8088/v1',
        'macOS real-backend verifier Hermes fixture', '${HUMAN_ID}', 1, 12)
ON CONFLICT (member_id) DO UPDATE
  SET model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      system_prompt = EXCLUDED.system_prompt,
      owner_human_id = EXCLUDED.owner_human_id,
      max_concurrent_runs = EXCLUDED.max_concurrent_runs,
      max_run_steps = EXCLUDED.max_run_steps;

-- Migration 002 owns a fixed #agent-lab UUID. Replace it inside this isolated
-- DB so every verifier generation uses a distinct Centrifugo version stream.
DELETE FROM channel
 WHERE workspace_id = '${WORKSPACE_ID}'
   AND id <> '${CHANNEL_ID}'
   AND lower(name) = 'agent-lab';

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, archived_at)
VALUES ('${CHANNEL_ID}', '${WORKSPACE_ID}', 'public', 'agent-lab',
        'macOS real-backend verifier channel', '${HUMAN_ID}', NULL)
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
   '${CHANNEL_ID}', '${HUMAN_ID}', 'owner', NULL),
  ('00000000-0000-7000-8000-000000000306', '${WORKSPACE_ID}',
   '${CHANNEL_ID}', '${AGENT_ID}', 'member', NULL)
ON CONFLICT (channel_id, member_id)
DO UPDATE SET role = EXCLUDED.role, left_at = NULL;

-- 수명주기 랜딩(#564) 이후 roster는 workspace_membership JOIN을 요구한다 —
-- 채널 membership만으로는 로스터에 나타나지 않는다(verify_agent_worker 동일 처방).
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('${WORKSPACE_ID}', '${HUMAN_ID}', 'owner'),
  ('${WORKSPACE_ID}', '${AGENT_ID}', 'member')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = EXCLUDED.role;

DELETE FROM usage_ledger WHERE id = '${USAGE_ID}' OR run_id = '${RUN_ID_FIXTURE}';
DELETE FROM approval_decision WHERE approval_id = '${APPROVAL_ID}';
DELETE FROM audit_log WHERE target_id = '${APPROVAL_ID}' OR run_id = '${RUN_ID_FIXTURE}';
DELETE FROM outbox
 WHERE payload @> jsonb_build_object('approval_id', '${APPROVAL_ID}')
    OR payload @> jsonb_build_object('run_id', '${RUN_ID_FIXTURE}');
DELETE FROM approval WHERE id = '${APPROVAL_ID}';
DELETE FROM message WHERE id = '${APPROVAL_MSG_ID}' OR run_id = '${RUN_ID_FIXTURE}';
DELETE FROM agent_run WHERE id = '${RUN_ID_FIXTURE}';

CREATE TEMP TABLE macos_smoke_fixture_seq(seq bigint) ON COMMIT DROP;

WITH current_seq AS (
  SELECT GREATEST(
           205900,
           COALESCE((SELECT last_seq FROM channel_seq WHERE channel_id = '${CHANNEL_ID}'), 0),
           COALESCE((SELECT max(seq) FROM message WHERE channel_id = '${CHANNEL_ID}'), 0)
         ) AS last_seen_seq
),
bumped AS (
  UPDATE channel_seq
     SET last_seq = current_seq.last_seen_seq + 1
    FROM current_seq
   WHERE channel_seq.channel_id = '${CHANNEL_ID}'
   RETURNING channel_seq.last_seq
)
INSERT INTO macos_smoke_fixture_seq(seq)
SELECT last_seq FROM bumped;

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, step_count, max_steps, depth, input, started_at)
VALUES
  ('${RUN_ID_FIXTURE}', '${WORKSPACE_ID}', '${AGENT_ID}', '${CHANNEL_ID}', 'awaiting_approval', 1, 12, 0,
   '{"prompt":"MOMO-205 macOS REST backend smoke approval/cost fixture"}'::jsonb, now());

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props, run_id)
VALUES
  ('${APPROVAL_MSG_ID}', '${WORKSPACE_ID}', '${CHANNEL_ID}', (SELECT seq FROM macos_smoke_fixture_seq), 1782864000000, 0, '${AGENT_ID}',
   'approval_request', 'MOMO-205 approval/cost fixture',
   jsonb_build_object(
     'approval_id', '${APPROVAL_ID}',
     'approval_status', 'pending',
     'action_type', 'github.create_issue',
     'tool_name', 'github.create_issue',
     'title', 'Create rollout checklist issue',
     'summary', 'Real-backend fixture for MomoMacDevApp approval and cost surfaces.',
     'estimated_micro_usd', 820000,
     'reserved_micro_usd', 820000,
     'spent_micro_usd', 340000,
     'is_reversible', true
   ),
   '${RUN_ID_FIXTURE}');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, request_message_id, requested_by,
   action_type, payload, status, expires_at)
VALUES
  ('${APPROVAL_ID}', '${WORKSPACE_ID}', '${RUN_ID_FIXTURE}', '${CHANNEL_ID}', '${APPROVAL_MSG_ID}', '${AGENT_ID}',
   'tool_call',
   jsonb_build_object(
     'run_id', '${RUN_ID_FIXTURE}',
     'action_type', 'github.create_issue',
     'tool_call', jsonb_build_object(
       'call_id', 'call_momo_205_smoke',
       'name', 'github.create_issue',
       'arguments', jsonb_build_object('title', 'Create rollout checklist issue')
     )
   ),
   'pending', now() + interval '1 hour');

INSERT INTO usage_ledger
  (id, workspace_id, run_id, agent_member_id, channel_id, model,
   prompt_tokens, completion_tokens, cost_micro_usd, was_estimated)
VALUES
  ('${USAGE_ID}', '${WORKSPACE_ID}', '${RUN_ID_FIXTURE}', '${AGENT_ID}', '${CHANNEL_ID}', 'hermes-agent',
   1200, 480, 340000, false);

UPDATE channel_seq
   SET last_seq = GREATEST(last_seq, (SELECT seq FROM macos_smoke_fixture_seq))
 WHERE channel_id = '${CHANNEL_ID}';

COMMIT;
SQL

if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  fail "${BASE_URL}/health is already serving; stop the existing MomoServer before running this verifier"
fi

echo "[macos-real-backend] starting MomoServer"
(
  cd "$REPO_ROOT"
  DATABASE_URL="$APP_DATABASE_URL" \
  HOST="127.0.0.1" \
  PORT="$PORT" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  MOMO_CENTRIFUGO_WS_URL="ws://127.0.0.1:${CENT_PORT}/connection/websocket" \
  JWT_HMAC="$JWT_HMAC" \
  CENT_TOKEN_HMAC="$CENT_TOKEN_HMAC" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  swift run --package-path server MomoServer
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_http "$BASE_URL/health" "MomoServer"

echo "[macos-real-backend] REST login"
curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${HUMAN_EMAIL}\",\"password\":\"dev-password\",\"workspace\":\"${WORKSPACE_ID}\"}" \
  "$BASE_URL/v1/auth/login" >"$REST_LOGIN_FILE"
ACCESS_TOKEN="$(jq -r '.accessToken // empty' "$REST_LOGIN_FILE")"
[ "$ACCESS_TOKEN" != "" ] || fail "login did not return accessToken"
jq -e --arg member "$HUMAN_ID" '.member.id == $member and (.accessToken | length) > 20' "$REST_LOGIN_FILE" >/dev/null \
  || fail "login response missing expected seeded member"
jq -e --arg url "ws://127.0.0.1:${CENT_PORT}/connection/websocket" '.realtimeWebSocketUrl == $url' "$REST_LOGIN_FILE" >/dev/null \
  || fail "login response missing server-advertised realtime WebSocket URL"

echo "[macos-real-backend] REST channel list"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels" >"$REST_CHANNELS_FILE"
jq -e --arg channel "$CHANNEL_ID" '.channels[] | select(.id == $channel and .name == "agent-lab")' "$REST_CHANNELS_FILE" >/dev/null \
  || fail "channel list did not include agent-lab"

echo "[macos-real-backend] REST server-owned roster"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/roster" >"$REST_ROSTER_FILE"
jq -e --arg human "$HUMAN_ID" --arg agent "$AGENT_ID" --arg channel "$CHANNEL_ID" '
  any(.members[]; .id == $human and .kind == "human" and (.channelIds | index($channel) != null))
  and any(.members[]; .id == $agent and .kind == "agent" and .status == "active" and (.channelIds | index($channel) != null))
' "$REST_ROSTER_FILE" >/dev/null \
  || fail "roster did not include active human/agent memberships for agent-lab"

INVITE_EXPIRES_AT_MS="$(( ($(date +%s) + 7 * 24 * 60 * 60) * 1000 ))"
echo "[macos-real-backend] REST invite create/list/revoke"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"role\":\"member\",\"maxUses\":1,\"expiresAtMs\":${INVITE_EXPIRES_AT_MS},\"metadata\":{\"gate\":\"MOMO-226\",\"purpose\":\"revoke-smoke\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites" >"$REST_INVITE_CREATE_FILE"
INVITE_REVOKE_ID="$(jq -r '.invite.id // empty' "$REST_INVITE_CREATE_FILE")"
INVITE_REVOKE_CODE="$(jq -r '.code // empty' "$REST_INVITE_CREATE_FILE")"
[ "$INVITE_REVOKE_ID" != "" ] && [ "$INVITE_REVOKE_CODE" != "" ] \
  || fail "invite create response missing id/code: $(cat "$REST_INVITE_CREATE_FILE")"
jq -e '.invite.role == "member" and .invite.maxUses == 1 and .invite.usedCount == 0 and (.code | length) > 20' "$REST_INVITE_CREATE_FILE" >/dev/null \
  || fail "invite create response missing expected member invite"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites?include_revoked=true&limit=20" >"$REST_INVITE_LIST_FILE"
jq -e --arg invite "$INVITE_REVOKE_ID" '.invites[] | select(.id == $invite and .revokedAtMs == null)' "$REST_INVITE_LIST_FILE" >/dev/null \
  || fail "invite list did not include fresh active invite"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"MOMO-226 revoke smoke"}' \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites/${INVITE_REVOKE_ID}/revoke" >"$REST_INVITE_REVOKE_FILE"
jq -e --arg invite "$INVITE_REVOKE_ID" '.id == $invite and .revokedAtMs != null and .revocationReason == "MOMO-226 revoke smoke"' "$REST_INVITE_REVOKE_FILE" >/dev/null \
  || fail "invite revoke response did not reflect revoked state"

SECOND_EMAIL="momo226-second-${RUN_SUFFIX}@momo.local"
SECOND_HANDLE="momo226-$$"
SECOND_PASSWORD="dev-password"
echo "[macos-real-backend] REST invite create + second user join"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"role\":\"member\",\"maxUses\":1,\"expiresAtMs\":${INVITE_EXPIRES_AT_MS},\"metadata\":{\"gate\":\"MOMO-226\",\"purpose\":\"join-smoke\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites" >"$REST_JOIN_INVITE_CREATE_FILE"
JOIN_INVITE_ID="$(jq -r '.invite.id // empty' "$REST_JOIN_INVITE_CREATE_FILE")"
JOIN_INVITE_CODE="$(jq -r '.code // empty' "$REST_JOIN_INVITE_CREATE_FILE")"
[ "$JOIN_INVITE_ID" != "" ] && [ "$JOIN_INVITE_CODE" != "" ] \
  || fail "join invite create response missing id/code"

curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"${JOIN_INVITE_CODE}\",\"email\":\"${SECOND_EMAIL}\",\"displayName\":\"MOMO 226 Second User\",\"handle\":\"${SECOND_HANDLE}\",\"password\":\"${SECOND_PASSWORD}\",\"timeZone\":\"UTC\"}" \
  "$BASE_URL/v1/join" >"$REST_JOIN_FILE"
SECOND_ACCESS_TOKEN="$(jq -r '.accessToken // empty' "$REST_JOIN_FILE")"
SECOND_MEMBER_ID="$(jq -r '.member.id // empty' "$REST_JOIN_FILE" | tr '[:upper:]' '[:lower:]')"
[ "$SECOND_ACCESS_TOKEN" != "" ] && [ "$SECOND_MEMBER_ID" != "" ] \
  || fail "second user join response missing token/member: $(cat "$REST_JOIN_FILE")"
jq -e --arg ws "$WORKSPACE_ID" --arg url "ws://127.0.0.1:${CENT_PORT}/connection/websocket" '
  .workspaceId == $ws
  and .createdMember == true
  and (.memberships | length) >= 1
  and .realtimeWebSocketUrl == $url
' "$REST_JOIN_FILE" >/dev/null \
  || fail "second user join response missing workspace/memberships"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/invites?include_revoked=true&limit=20" >"$REST_JOIN_INVITE_LIST_FILE"
jq -e --arg invite "$JOIN_INVITE_ID" '.invites[] | select(.id == $invite and .usedCount == 1)' "$REST_JOIN_INVITE_LIST_FILE" >/dev/null \
  || fail "invite list after join did not show usedCount=1"

curl -fsS \
  -H "Authorization: Bearer ${SECOND_ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels" >"$REST_SECOND_CHANNELS_FILE"
jq -e --arg channel "$CHANNEL_ID" '.channels[] | select(.id == $channel and .name == "agent-lab")' "$REST_SECOND_CHANNELS_FILE" >/dev/null \
  || fail "second user channel load did not include agent-lab"

curl -fsS \
  -H "Authorization: Bearer ${SECOND_ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/roster" >"$REST_SECOND_MEMBERS_FILE"
jq -e --arg member "$SECOND_MEMBER_ID" '.members[] | select((.id | ascii_downcase) == $member and .kind == "human")' "$REST_SECOND_MEMBERS_FILE" >/dev/null \
  || fail "second user member roster did not include joined member"

CHANNEL_MANAGEMENT_NAME="momo218-$(date +%s)-$$"
echo "[macos-real-backend] REST channel create/member add/remove"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"kind\":\"private\",\"name\":\"${CHANNEL_MANAGEMENT_NAME}\",\"topic\":\"MOMO-218 macOS channel management smoke\"}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels" >"$REST_CHANNEL_CREATE_FILE"
CHANNEL_MANAGEMENT_ID="$(jq -r '.channel.id // empty' "$REST_CHANNEL_CREATE_FILE")"
[ "$CHANNEL_MANAGEMENT_ID" != "" ] || fail "channel create response missing channel id"
jq -e --arg name "$CHANNEL_MANAGEMENT_NAME" '
  .channel.kind == "private"
  and .channel.name == $name
  and .creatorMembership.memberId == "'"${HUMAN_ID}"'"
  and .creatorMembership.role == "owner"
  and .creatorMembership.leftAtMs == null
' "$REST_CHANNEL_CREATE_FILE" >/dev/null \
  || fail "channel create response missing private channel/owner membership"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"memberId\":\"${AGENT_ID}\",\"role\":\"member\"}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_MANAGEMENT_ID}/members" >"$REST_MEMBER_ADD_FILE"
jq -e --arg agent "$AGENT_ID" --arg channel "$CHANNEL_MANAGEMENT_ID" '
  .membership.memberId == $agent
  and .membership.channelId == $channel
  and .membership.role == "member"
  and .membership.leftAtMs == null
' "$REST_MEMBER_ADD_FILE" >/dev/null \
  || fail "agent add response missing active membership"

curl -fsS \
  -X DELETE \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_MANAGEMENT_ID}/members/${AGENT_ID}" >"$REST_MEMBER_REMOVE_FILE"
jq -e --arg agent "$AGENT_ID" --arg channel "$CHANNEL_MANAGEMENT_ID" '
  .membership.memberId == $agent
  and .membership.channelId == $channel
  and .membership.leftAtMs != null
' "$REST_MEMBER_REMOVE_FILE" >/dev/null \
  || fail "agent remove response missing leftAtMs"

echo "[macos-real-backend] REST send"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"clientMsgId\":\"${CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":\"${MESSAGE_BODY}\",\"props\":{\"gate\":\"MOMO-205\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" >"$REST_SEND_FILE"
MESSAGE_ID="$(jq -r '.id // empty' "$REST_SEND_FILE")"
MESSAGE_SEQ="$(jq -r '.seq // empty' "$REST_SEND_FILE")"
[ "$MESSAGE_ID" != "" ] && [ "$MESSAGE_SEQ" != "" ] && [ "$MESSAGE_SEQ" != "null" ] \
  || fail "send response missing id/seq: $(cat "$REST_SEND_FILE")"

echo "[macos-real-backend] REST agent mention send"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"clientMsgId\":\"${MENTION_CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":\"${MENTION_BODY}\",\"props\":{\"gate\":\"MOMO-256\",\"agent_handle\":\"${AGENT_HANDLE}\"}}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages" >"$REST_MENTION_SEND_FILE"
MENTION_MESSAGE_ID="$(jq -r '.id // empty' "$REST_MENTION_SEND_FILE")"
MENTION_MESSAGE_SEQ="$(jq -r '.seq // empty' "$REST_MENTION_SEND_FILE")"
[ "$MENTION_MESSAGE_ID" != "" ] && [ "$MENTION_MESSAGE_SEQ" != "" ] && [ "$MENTION_MESSAGE_SEQ" != "null" ] \
  || fail "mention send response missing id/seq: $(cat "$REST_MENTION_SEND_FILE")"

MENTION_JOB_COUNT="$(psql_admin -Atc "SELECT count(*) FROM outbox WHERE workspace_id='${WORKSPACE_ID}' AND kind='agent_job' AND payload->>'trigger_message_id'='${MENTION_MESSAGE_ID}' AND payload->>'agent_member_id'='${AGENT_ID}';")"
[ "$MENTION_JOB_COUNT" = "1" ] || fail "mention send did not create exactly one agent_job for @${AGENT_HANDLE}; count=${MENTION_JOB_COUNT}"

echo "[macos-real-backend] REST history"
curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$BASE_URL/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages?limit=20" >"$REST_HISTORY_FILE"
jq -e --arg id "$MESSAGE_ID" --arg body "$MESSAGE_BODY" '.messages[] | select(.id == $id and .body == $body and .type == "text")' "$REST_HISTORY_FILE" >/dev/null \
  || fail "history did not include sent text message"
jq -e --arg id "$MENTION_MESSAGE_ID" --arg body "$MENTION_BODY" '.messages[] | select(.id == $id and .body == $body and .type == "text")' "$REST_HISTORY_FILE" >/dev/null \
  || fail "history did not include sent agent mention message"
jq -e --arg id "$APPROVAL_MSG_ID" --arg approval "$APPROVAL_ID" '
  .messages[]
  | select(.id == $id and .type == "approval_request")
  | select(.props.approval_id == $approval)
  | select(.props.approval_status == "pending")
  | select(.props.estimated_micro_usd == 820000)
  | select(.runId == "'"${RUN_ID_FIXTURE}"'")
' "$REST_HISTORY_FILE" >/dev/null \
  || fail "history did not include approval/cost structured props"

if [ "${LOCAL_GATE_LAUNCH_UI:-0}" = "1" ]; then
  echo "[macos-real-backend] launching MomoMacDevApp against ${BASE_URL}"
  set_launchctl_env MOMO_SERVER_BASE_URL "$BASE_URL"
  set_launchctl_env MOMO_WORKSPACE_ID "$WORKSPACE_ID"
  set_launchctl_env MOMO_CHANNEL_ID "$CHANNEL_ID"
  set_launchctl_env MOMO_LOGIN_EMAIL "$HUMAN_EMAIL"
  set_launchctl_env MOMO_LOGIN_PASSWORD "dev-password"
  set +e
  "$REPO_ROOT/scripts/macos_dev_run.sh" --verify --logs --terminate 2>&1 | tee "$UI_LOG"
  UI_CODE=${PIPESTATUS[0]}
  set -e
  unset_launchctl_env
  [ "$UI_CODE" -eq 0 ] || fail "MomoMacDevApp launch verifier failed with exit ${UI_CODE}"
  grep -q "process is running" "$UI_LOG" || fail "UI launch log missing process evidence"
  grep -q "window smoke passed" "$UI_LOG" || fail "UI launch log missing window_count evidence"
  UI_RESULT="pass"
else
  echo "[macos-real-backend] UI launch skipped; set LOCAL_GATE_LAUNCH_UI=1 to require process/window evidence"
fi

{
  echo "## MOMO-205/MOMO-348 macOS Real-Backend Smoke Evidence"
  echo "- Result: PASS"
  echo "- Base URL: \`${BASE_URL}\`"
  echo "- Database boundary: isolated migrated DB \`${POSTGRES_DB}\`; app=NOBYPASSRLS, worker/relay=BYPASSRLS marker-bound roles; source \`${SOURCE_POSTGRES_DB}\` digest is enforced unchanged on exit."
  echo "- Workspace: \`${WORKSPACE_ID}\`"
  echo "- Channel: \`agent-lab\` / \`${CHANNEL_ID}\`"
  echo "- Centrifugo channel spelling: \`${CENT_CHANNEL}\` (Swift UUID uppercase normalization)"
  echo "- REST login: member=\`${HUMAN_ID}\`, access_token_len=\`$(jq -r '.accessToken | length' "$REST_LOGIN_FILE")\`"
  echo "- Realtime discovery: login advertised \`$(jq -r '.realtimeWebSocketUrl' "$REST_LOGIN_FILE")\`; UI launch does not inject a WebSocket env override."
  echo "- REST channel list: count=\`$(jq -r '.channels | length' "$REST_CHANNELS_FILE")\`, includes \`agent-lab\`"
  echo "- REST roster SoT: active human \`${HUMAN_ID}\` and agent \`${AGENT_ID}\` both carry selected channel membership \`${CHANNEL_ID}\`."
  echo "- REST invite admin: created invite \`${INVITE_REVOKE_ID}\`, listed active state, revoked with reason \`MOMO-226 revoke smoke\`"
  echo "- REST invite join: second_user=\`${SECOND_EMAIL}\`, member_id=\`${SECOND_MEMBER_ID}\`, invite=\`${JOIN_INVITE_ID}\`, used_count=\`1\`"
  echo "- REST second-user state load: channels include \`agent-lab\`, members include joined human"
  echo "- REST channel management: created private channel \`${CHANNEL_MANAGEMENT_NAME}\` / \`${CHANNEL_MANAGEMENT_ID}\`, agent add/remove membership PASS"
  echo "- REST send: message_id=\`${MESSAGE_ID}\`, seq=\`${MESSAGE_SEQ}\`, client_msg_id=\`${CLIENT_MSG_ID}\`"
  echo "- REST agent mention: body=\`${MENTION_BODY}\`, message_id=\`${MENTION_MESSAGE_ID}\`, seq=\`${MENTION_MESSAGE_SEQ}\`, agent_job_count=\`${MENTION_JOB_COUNT}\`"
  echo "- REST history: includes sent text, agent mention source message, plus approval_request \`${APPROVAL_MSG_ID}\` with approval_id \`${APPROVAL_ID}\`"
  echo "- Approval surface data: status=\`pending\`, action=\`github.create_issue\`, estimated_micro_usd=\`820000\`"
  echo "- Cost surface data: reserved_micro_usd=\`820000\`, spent_micro_usd=\`340000\`, usage_ledger_id=\`${USAGE_ID}\`"
  echo "- UI launch: \`${UI_RESULT}\`"
  if [ "$UI_RESULT" = "skipped" ]; then
    echo "- UI skip criterion: \`LOCAL_GATE_LAUNCH_UI\` was not \`1\`; REST/backend smoke is PASS and process/window evidence is intentionally not required."
  else
    echo "- UI process/window evidence: \`${UI_LOG}\`"
  fi
  echo "- Evidence files: login=\`${REST_LOGIN_FILE}\`, channels=\`${REST_CHANNELS_FILE}\`, roster=\`${REST_ROSTER_FILE}\`, invite_create=\`${REST_INVITE_CREATE_FILE}\`, invite_list=\`${REST_INVITE_LIST_FILE}\`, invite_revoke=\`${REST_INVITE_REVOKE_FILE}\`, join_invite_create=\`${REST_JOIN_INVITE_CREATE_FILE}\`, join=\`${REST_JOIN_FILE}\`, join_invite_list=\`${REST_JOIN_INVITE_LIST_FILE}\`, second_channels=\`${REST_SECOND_CHANNELS_FILE}\`, second_roster=\`${REST_SECOND_MEMBERS_FILE}\`, channel_create=\`${REST_CHANNEL_CREATE_FILE}\`, member_add=\`${REST_MEMBER_ADD_FILE}\`, member_remove=\`${REST_MEMBER_REMOVE_FILE}\`, send=\`${REST_SEND_FILE}\`, mention_send=\`${REST_MENTION_SEND_FILE}\`, history=\`${REST_HISTORY_FILE}\`, server_log=\`${SERVER_LOG}\`"
} >"$EVIDENCE_FILE"

cat "$EVIDENCE_FILE"
echo "[macos-real-backend] evidence: $EVIDENCE_FILE"
echo "[macos-real-backend] PASS macOS real-backend smoke gate"
