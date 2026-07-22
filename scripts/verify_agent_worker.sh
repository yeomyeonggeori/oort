#!/usr/bin/env bash
# =============================================================================
# scripts/verify_agent_worker.sh — MOMO-004 AgentWorker runtime gate
#
# Prereq:
#   make up
#   make migrate
#
# Verifies:
#   1) REST channel send to a verifier-owned agent creates exactly one agent_job
#   2) duplicate client_msg_id REST retry does not create a duplicate job
#   3) AgentWorker claims it with SKIP LOCKED and calls an OpenAI-compatible
#      SSE gateway (scripts/mock_hermes.py by default)
#   4) Centrifugo agent: history receives agent.partial/tool_call progress
#   5) OutboxRelay publishes the final durable channel message.new response
#   6) cost reserve/reconcile writes budget_window + usage_ledger
#   7) MomoServer cost-snapshots endpoint exposes the server-owned projection
#   8) a low-limit budget trips before spending
# =============================================================================
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
    echo "[agent-worker] missing required command: $1" >&2
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
  echo "[agent-worker] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

psql_run() {
  if [ "${DATABASE_URL:-}" != "" ]; then
    "$PSQL_BIN" "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  else
    "$PSQL_BIN" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  fi
}

psql_scalar() {
  psql_run -t -A -c "$1" | tr -d '[:space:]'
}

admin_scalar() {
  local output
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc -c "$1") || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo_dev_pw}
SOURCE_POSTGRES_DB=${POSTGRES_DB:-momo}
POSTGRES_DB=${AGENT_WORKER_VERIFIER_DB:-momo_agent_worker_verify_v2_${POSTGRES_PORT}}
PORT=${PORT:-8080}
BASE_URL=${BASE_URL:-http://127.0.0.1:${PORT}}
CENT_PORT=${CENT_PORT:-8000}
CENT_API_KEY=${CENT_API_KEY:-dev-insecure-cent-api-key}
HERMES_PORT=${HERMES_PORT:-8088}
HERMES_API_KEY=${HERMES_API_KEY:-dev-insecure-hermes-bearer}
WORKER_POLL_INTERVAL_MS=${WORKER_POLL_INTERVAL_MS:-100}

CENT_API_URL=${CENT_API_URL:-http://localhost:${CENT_PORT}/api}
case "$CENT_API_URL" in
  *centrifugo*) CENT_API_URL="http://localhost:${CENT_PORT}/api" ;;
esac

HERMES_BASE_URL=${HERMES_BASE_URL:-http://localhost:${HERMES_PORT}/v1}

HUMAN_EMAIL=agent-worker-verifier@momo.local
AGENT_HANDLE=agent-worker-verifier
HERMES_AGENT_ID=00000000-0000-7000-8000-000000000103
# MOMO-301 review round: gate thresholds are lowered via env so the trip
# scenarios stay compatible with the 007 SoT CHECKs (depth <= 4): the
# a2a_depth trip seeds depth=2 with MAX_DEPTH=1 (gate blocks depth > MAX_DEPTH),
# and the G2 trip seeds 2 consecutive agent text messages with
# MAX_CONSECUTIVE_AUTO=2. All other fixtures sit at depth=0 / streak=0.
GUARD_MAX_DEPTH=${GUARD_MAX_DEPTH:-1}
GUARD_MAX_CONSECUTIVE_AUTO=${GUARD_MAX_CONSECUTIVE_AUTO:-2}
SENTINEL_OUTBOX_ID=-343
VERIFIER_SYSTEM_PROMPT='Verifier-owned AgentWorker fixture. Do not use for local dogfood.'
NON_MEMBER_SYSTEM_PROMPT='This agent is intentionally not a channel member for MOMO-215.'
VERIFIER_DB_MARKER_PREFIX='momo:agent-worker-verifier:v1:'
VERIFIER_APP_PASSWORD=momo_aw_verify_app_pw
VERIFIER_RELAY_PASSWORD=momo_aw_verify_relay_pw
VERIFIER_WORKER_PASSWORD=momo_aw_verify_worker_pw

configure_verifier_identity() {
  FIXTURE_NAMESPACE=$(printf '%s' "$VERIFIER_DB_MARKER" | shasum -a 256 | cut -c 1-6)
  ROLE_SUFFIX=$(printf '%s' "$VERIFIER_DB_MARKER" | shasum -a 256 | cut -c 1-12)
  WORKSPACE_SLUG=agent-worker-verifier-${FIXTURE_NAMESPACE}
  VERIFIER_APP_ROLE=momo_aw_${ROLE_SUFFIX}_app
  VERIFIER_RELAY_ROLE=momo_aw_${ROLE_SUFFIX}_relay
  VERIFIER_WORKER_ROLE=momo_aw_${ROLE_SUFFIX}_worker

  WORKSPACE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343001
  HUMAN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343101
  HUMAN_MEMBERSHIP_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343301
  AGENT_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343113
  AGENT_MEMBERSHIP_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343316
  CHANNEL_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343202
  RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343904
  RESUME_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343924
  RESUME_APPROVAL_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343925
  EQUIV_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}34394b
  EQUIV_DECISION_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}34394c
  TRIP_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343914
  BUDGET_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343905
  TRIP_BUDGET_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343915
  MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343906
  TRIP_MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343916
  CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343907
  TRIP_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343917
  GUARD_DEPTH_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343934
  GUARD_DEPTH_MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343935
  GUARD_DEPTH_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343936
  GUARD_STEP_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343937
  GUARD_STEP_MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343938
  GUARD_STEP_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343939
  GUARD_G1_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343940
  GUARD_G1_DECOY_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343941
  GUARD_G1_MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343942
  GUARD_G1_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343943
  GUARD_G2_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343944
  GUARD_G2_MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343945
  GUARD_G2_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343946
  GUARD_G2_AGENT_MSG1_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343947
  GUARD_G2_AGENT_MSG2_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343948
  GUARD_G2_RESET_MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343949
  GUARD_G2_RESET_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}34394a
  NON_MEMBER_AGENT_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343102
  NON_MEMBER_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343107
  SENTINEL_MESSAGE_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343390
  SENTINEL_CLIENT_MSG_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343391
  SENTINEL_RUN_ID=00000000-0000-7000-8000-${FIXTURE_NAMESPACE}343392
  TRANSPORT_WORKSPACE_ID=$(printf '%s' "$WORKSPACE_ID" | tr '[:lower:]' '[:upper:]')
  TRANSPORT_CHANNEL_ID=$(printf '%s' "$CHANNEL_ID" | tr '[:lower:]' '[:upper:]')
  TRANSPORT_AGENT_ID=$(printf '%s' "$AGENT_ID" | tr '[:lower:]' '[:upper:]')
  AGENT_CHANNEL=agent:ws${TRANSPORT_WORKSPACE_ID}.${TRANSPORT_CHANNEL_ID}.${TRANSPORT_AGENT_ID}
  CENT_CHANNEL=ch:ws${TRANSPORT_WORKSPACE_ID}.${TRANSPORT_CHANNEL_ID}
}

case "$POSTGRES_DB" in
  ''|*[!a-zA-Z0-9_]*)
    echo "[agent-worker] invalid verifier database name: $POSTGRES_DB" >&2
    exit 1
    ;;
esac

case "$POSTGRES_DB" in
  "$SOURCE_POSTGRES_DB"|postgres|template0|template1)
    echo "[agent-worker] refusing unsafe verifier database target: $POSTGRES_DB" >&2
    exit 1
    ;;
esac

provision_verifier_database() {
  local exists marker marker_uuid_override
  exists=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB';" | tr -d '[:space:]')
  if [ "$exists" != "1" ]; then
    echo "[agent-worker] creating isolated verifier database: $POSTGRES_DB"
    marker_uuid_override=${AGENT_WORKER_VERIFIER_TEST_MARKER_UUID:-}
    if [ "$marker_uuid_override" != "" ]; then
      if ! [[ "$marker_uuid_override" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
        echo "[agent-worker] invalid test verifier marker UUID" >&2
        exit 1
      fi
      marker="${VERIFIER_DB_MARKER_PREFIX}${marker_uuid_override}"
    else
      marker="${VERIFIER_DB_MARKER_PREFIX}$(python3 -c 'import uuid; print(uuid.uuid4())')"
    fi
    VERIFIER_DB_MARKER=$marker
    PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
      -v ON_ERROR_STOP=1 --no-psqlrc -c "CREATE DATABASE \"$POSTGRES_DB\";"
    VERIFIER_DB_CREATED_THIS_RUN=1
    VERIFIER_DB_CREATED_OID=$(admin_scalar "SELECT oid FROM pg_database WHERE datname = '$POSTGRES_DB';")
    if [ "$VERIFIER_DB_CREATED_OID" = "" ]; then
      echo "[agent-worker] failed to capture newly created verifier database identity" >&2
      exit 1
    fi
    if [ "${AGENT_WORKER_VERIFIER_TEST_FAIL_COMMENT:-0}" = "1" ]; then
      if PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
        -v ON_ERROR_STOP=1 --no-psqlrc -c "SELECT momo_verifier_forced_comment_failure();" >/dev/null 2>&1; then
        echo "[agent-worker] forced COMMENT failure unexpectedly succeeded" >&2
        exit 1
      fi
      echo "[agent-worker] intentional database COMMENT failure (test only)" >&2
      exit 96
    elif ! PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
      -v ON_ERROR_STOP=1 -v marker="$marker" --no-psqlrc <<SQL
COMMENT ON DATABASE "$POSTGRES_DB" IS :'marker';
SQL
    then
      echo "[agent-worker] failed to mark newly created verifier database: $POSTGRES_DB" >&2
      exit 1
    fi
    if [ "${AGENT_WORKER_VERIFIER_TEST_FAIL_AFTER_MARKER:-0}" = "1" ]; then
      echo "[agent-worker] intentional bootstrap failure after marker (test only)" >&2
      exit 97
    fi
  fi

  marker=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$POSTGRES_DB';" | tr -d '[:space:]')
  marker_uuid=${marker#"$VERIFIER_DB_MARKER_PREFIX"}
  if [ "$marker_uuid" = "$marker" ] \
    || ! [[ "$marker_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "[agent-worker] refusing unowned verifier database: $POSTGRES_DB (invalid verifier marker)" >&2
    exit 1
  fi
  VERIFIER_DB_MARKER=${VERIFIER_DB_MARKER_PREFIX}${marker_uuid}
  configure_verifier_identity

  export PGHOST="$POSTGRES_HOST"
  export PGPORT="$POSTGRES_PORT"
  export PGDATABASE="$POSTGRES_DB"
  export PGUSER="$POSTGRES_USER"
  export PGPASSWORD="$POSTGRES_PASSWORD"
  DATABASE_URL=
  export DATABASE_URL

  ENV_FILE=/dev/null DATABASE_URL= \
    PGHOST="$PGHOST" PGPORT="$PGPORT" PGDATABASE="$PGDATABASE" \
    PGUSER="$PGUSER" PGPASSWORD="$PGPASSWORD" \
    MOMO_AGENT_SEED_MODE=none "$REPO_ROOT/scripts/migrate.sh" >/dev/null
}

provision_verifier_roles() {
  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -v ON_ERROR_STOP=1 -v marker="$VERIFIER_DB_MARKER" --no-psqlrc <<SQL
SELECT set_config('momo.verifier_marker', :'marker', false) AS verifier_marker_setting \gset
BEGIN;
DO \$roles\$
DECLARE
  role_name text;
  role_marker text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['$VERIFIER_APP_ROLE', '$VERIFIER_RELAY_ROLE', '$VERIFIER_WORKER_ROLE']
  LOOP
    SELECT shobj_description(oid, 'pg_authid')
      INTO role_marker
      FROM pg_roles
     WHERE rolname = role_name;
    IF FOUND AND role_marker IS DISTINCT FROM current_setting('momo.verifier_marker') THEN
      RAISE EXCEPTION 'AgentWorker verifier role identity collision: %', role_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$VERIFIER_APP_ROLE') THEN
    CREATE ROLE $VERIFIER_APP_ROLE LOGIN PASSWORD '$VERIFIER_APP_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$VERIFIER_RELAY_ROLE') THEN
    CREATE ROLE $VERIFIER_RELAY_ROLE LOGIN PASSWORD '$VERIFIER_RELAY_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$VERIFIER_WORKER_ROLE') THEN
    CREATE ROLE $VERIFIER_WORKER_ROLE LOGIN PASSWORD '$VERIFIER_WORKER_PASSWORD';
  END IF;
END \$roles\$;

COMMENT ON ROLE $VERIFIER_APP_ROLE IS :'marker';
COMMENT ON ROLE $VERIFIER_RELAY_ROLE IS :'marker';
COMMENT ON ROLE $VERIFIER_WORKER_ROLE IS :'marker';
ALTER ROLE $VERIFIER_APP_ROLE
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$VERIFIER_APP_PASSWORD';
ALTER ROLE $VERIFIER_RELAY_ROLE
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD '$VERIFIER_RELAY_PASSWORD';
ALTER ROLE $VERIFIER_WORKER_ROLE
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD '$VERIFIER_WORKER_PASSWORD';
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO $VERIFIER_APP_ROLE, $VERIFIER_RELAY_ROLE, $VERIFIER_WORKER_ROLE;
COMMIT;
SQL

  psql_run <<SQL
GRANT USAGE ON SCHEMA public TO $VERIFIER_APP_ROLE, $VERIFIER_RELAY_ROLE, $VERIFIER_WORKER_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO $VERIFIER_APP_ROLE, $VERIFIER_RELAY_ROLE, $VERIFIER_WORKER_ROLE;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO $VERIFIER_APP_ROLE, $VERIFIER_RELAY_ROLE, $VERIFIER_WORKER_ROLE;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO $VERIFIER_APP_ROLE, $VERIFIER_RELAY_ROLE, $VERIFIER_WORKER_ROLE;
SQL
}

TMP_ROOT=${TMPDIR:-/tmp}
MOCK_LOG=${TMP_ROOT}/momo-mock-hermes-$$.log
WORKER_LOG=${TMP_ROOT}/momo-agent-worker-$$.log
SERVER_LOG=${TMP_ROOT}/momo-cost-projection-server-$$.log
RELAY_LOG=${TMP_ROOT}/momo-agent-worker-relay-$$.log
COST_PROJECTION_JSON=${TMP_ROOT}/momo-cost-projection-$$.json
MOCK_PID=
WORKER_PID=
SERVER_PID=
RELAY_PID=
SERVER_BIN=
RELAY_BIN=
WORKER_BIN=
SENTINELS_ARMED=0
VERIFIER_DB_CREATED_THIS_RUN=0
VERIFIER_DB_CREATED_OID=

cleanup_incomplete_verifier_database() {
  local current_marker current_oid role role_marker drop_succeeded
  current_marker=$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$POSTGRES_DB';") || return 1
  current_oid=$(admin_scalar "SELECT COALESCE(oid::text, '') FROM pg_database WHERE datname = '$POSTGRES_DB';") || return 1
  if ! { [ "${VERIFIER_DB_MARKER:-}" != "" ] && [ "$current_marker" = "$VERIFIER_DB_MARKER" ]; } \
    && ! { [ "$current_marker" = "" ] && [ "${VERIFIER_DB_CREATED_OID:-}" != "" ] && [ "$current_oid" = "$VERIFIER_DB_CREATED_OID" ]; }; then
    echo "[agent-worker] refusing incomplete bootstrap cleanup: database marker changed or is absent" >&2
    return 1
  fi

  for role in "${VERIFIER_APP_ROLE:-}" "${VERIFIER_RELAY_ROLE:-}" "${VERIFIER_WORKER_ROLE:-}"; do
    [ "$role" != "" ] || continue
    role_marker=$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '$role';") || return 1
    if [ "$role_marker" = "$VERIFIER_DB_MARKER" ]; then
      PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
        -v ON_ERROR_STOP=1 --no-psqlrc -c "ALTER ROLE \"$role\" NOLOGIN;" >/dev/null || return 1
    fi
  done

  drop_succeeded=0
  PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE);" >/dev/null && drop_succeeded=1
  [ "$drop_succeeded" = "1" ] || return 1

  for role in "${VERIFIER_APP_ROLE:-}" "${VERIFIER_RELAY_ROLE:-}" "${VERIFIER_WORKER_ROLE:-}"; do
    [ "$role" != "" ] || continue
    role_marker=$(admin_scalar "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '$role';") || return 1
    if [ "$role_marker" = "$VERIFIER_DB_MARKER" ]; then
      PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
        -v ON_ERROR_STOP=1 --no-psqlrc -c "DROP ROLE \"$role\";" >/dev/null || return 1
    fi
  done
}

cleanup() {
  if [ "$SENTINELS_ARMED" = "1" ]; then
    psql_run >/dev/null 2>&1 <<SQL || true
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
DELETE FROM outbox
 WHERE id = $SENTINEL_OUTBOX_ID
   AND payload->>'fixture' = 'momo-342-preserve';
DELETE FROM message
 WHERE id = '$SENTINEL_MESSAGE_ID'
   AND client_msg_id = '$SENTINEL_CLIENT_MSG_ID';
COMMIT;
SQL
  fi
  momo_cleanup_tracked_pids "agent-worker verifier" "$SERVER_PID" "$WORKER_PID" "$RELAY_PID" "$MOCK_PID"
  if [ "$VERIFIER_DB_CREATED_THIS_RUN" = "1" ] \
    || [ "${AGENT_WORKER_VERIFIER_TEST_CLEANUP_ON_EXIT:-0}" = "1" ]; then
    echo "[agent-worker] removing verifier-owned database lifecycle target: $POSTGRES_DB" >&2
    cleanup_incomplete_verifier_database || \
      echo "[agent-worker] incomplete bootstrap cleanup refused or failed; inspect marker before manual cleanup" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_http() {
  url=$1
  name=$2
  deadline=$(($(date +%s) + 30))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[agent-worker] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "[agent-worker] ${name} did not become ready: ${url}" >&2
  return 1
}

reset_verifier_transport_history() {
  local channel response
  for channel in "$AGENT_CHANNEL" "$CENT_CHANNEL"; do
    response=$(curl -fsS \
      -H "X-API-Key: $CENT_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$channel\"}" \
      "$CENT_API_URL/history_remove")
    if ! printf '%s' "$response" | jq -e '.error == null' >/dev/null; then
      echo "[agent-worker] failed to reset verifier-owned Centrifugo history: $channel" >&2
      printf '%s\n' "$response" >&2
      exit 1
    fi
  done
  echo "[agent-worker] reset verifier-owned Centrifugo history"
}

build_verifier_binaries() {
  echo "[agent-worker] building verifier runtime binaries before process timeouts"
  swift build --package-path "$REPO_ROOT/server" --product MomoServer >/dev/null
  SERVER_BIN="$(swift build --package-path "$REPO_ROOT/server" --show-bin-path)/MomoServer"
  swift build --package-path "$REPO_ROOT/relay/OutboxRelay" --product OutboxRelay >/dev/null
  RELAY_BIN="$(swift build --package-path "$REPO_ROOT/relay/OutboxRelay" --show-bin-path)/OutboxRelay"
  swift build --package-path "$REPO_ROOT/workers/AgentWorker" --product AgentWorker >/dev/null
  WORKER_BIN="$(swift build --package-path "$REPO_ROOT/workers/AgentWorker" --show-bin-path)/AgentWorker"
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[agent-worker] MomoServer already started by verifier"
      return 0
    fi
    echo "[agent-worker] $BASE_URL is already serving /health; stop the existing server before running this verifier." >&2
    exit 1
  fi

  echo "[agent-worker] starting MomoServer for cost projection endpoint"
  (
    exec env \
      DATABASE_URL="postgres://${VERIFIER_APP_ROLE}:${VERIFIER_APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
      PORT="$PORT" \
      AGENT_GATEWAY_MODE=worker \
      "$SERVER_BIN"
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  deadline=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[agent-worker] MomoServer exited before health became green" >&2
      tail -120 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[agent-worker] MomoServer health is green"
      return 0
    fi
    sleep 1
  done
  echo "[agent-worker] timed out waiting for MomoServer health" >&2
  tail -120 "$SERVER_LOG" >&2 || true
  exit 1
}

start_relay() {
  if [ "${RELAY_PID:-}" != "" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
    return 0
  fi

  echo "[agent-worker] starting OutboxRelay for final channel message.new evidence"
  (
    exec env \
      RELAY_DATABASE_URL="postgres://${VERIFIER_RELAY_ROLE}:${VERIFIER_RELAY_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
      CENT_API_URL="$CENT_API_URL" \
      CENT_API_KEY="$CENT_API_KEY" \
      RELAY_POLL_INTERVAL_MS=100 \
      "$RELAY_BIN"
  ) >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
}

start_worker() {
  if [ "${WORKER_PID:-}" != "" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    return 0
  fi
  echo "[agent-worker] starting AgentWorker"
  (
    exec env \
      RELAY_DATABASE_URL="postgres://${VERIFIER_WORKER_ROLE}:${VERIFIER_WORKER_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
      CENT_API_URL="$CENT_API_URL" \
      CENT_API_KEY="$CENT_API_KEY" \
      HERMES_BASE_URL="$HERMES_BASE_URL" \
      HERMES_API_KEY="$HERMES_API_KEY" \
      WORKER_POLL_INTERVAL_MS="$WORKER_POLL_INTERVAL_MS" \
      MAX_DEPTH="$GUARD_MAX_DEPTH" \
      MAX_CONSECUTIVE_AUTO="$GUARD_MAX_CONSECUTIVE_AUTO" \
      "$WORKER_BIN"
  ) >>"$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
}

stop_worker() {
  momo_cleanup_tracked_pids "agent-worker verifier restart" "$WORKER_PID"
  WORKER_PID=
}

verify_cost_projection_endpoint() {
  start_server
  LOGIN_JSON=$(curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$HUMAN_EMAIL\",\"password\":\"dev-password\",\"workspace\":\"$WORKSPACE_ID\"}" \
    "$BASE_URL/v1/auth/login")
  ACCESS_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken')
  if [ "$ACCESS_TOKEN" = "" ] || [ "$ACCESS_TOKEN" = "null" ]; then
    echo "[agent-worker] failed to obtain access token for cost projection endpoint" >&2
    printf '%s\n' "$LOGIN_JSON" >&2
    exit 1
  fi

  curl -fsS \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/cost-snapshots?limit=10" \
    > "$COST_PROJECTION_JSON"

  if ! jq -e --arg run "$RUN_ID" '
      .schema == "momo.cost_snapshot.channel.v0"
      and ((.channel_id | ascii_downcase) == ("'"$CHANNEL_ID"'" | ascii_downcase))
      and any(.snapshots[]?;
        ((.run_id | ascii_downcase) == ($run | ascii_downcase))
        and .reserved_micro_usd == 0
        and .spent_micro_usd == 6
        and .is_reconciled == true
        and .was_estimated == false
        and .limit_state == "normal"
      )
    ' "$COST_PROJECTION_JSON" >/dev/null; then
    echo "[agent-worker] cost projection endpoint contract did not verify" >&2
    cat "$COST_PROJECTION_JSON" >&2
    echo "[agent-worker] server log: $SERVER_LOG" >&2
    exit 1
  fi

  echo "[agent-worker] cost projection endpoint verified: $COST_PROJECTION_JSON"
}

echo "[agent-worker] using env file: ${ENV_FILE:-<none>}"
momo_cleanup_runtime_ports "agent-worker verifier preflight" "$PORT" "$HERMES_PORT" || {
  echo "[agent-worker] verifier ports are occupied by non-momo processes; stop them or choose PORT/HERMES_PORT overrides." >&2
  exit 1
}
provision_verifier_database
echo "[agent-worker] isolated database ready: $POSTGRES_DB (source database untouched: $SOURCE_POSTGRES_DB)"
echo "[agent-worker] ensuring verifier-owned runtime DB roles exist"
provision_verifier_roles
VERIFIER_DB_CREATED_THIS_RUN=0
build_verifier_binaries

start_server
start_relay

echo "[agent-worker] starting mock hermes on ${HERMES_BASE_URL}"
python3 "$REPO_ROOT/scripts/mock_hermes.py" --host 127.0.0.1 --port "$HERMES_PORT" \
  >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
wait_http "http://127.0.0.1:${HERMES_PORT}/health" "mock hermes"

echo "[agent-worker] ensuring dedicated verifier workspace"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

DO \$workspace_fixture\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace
     WHERE id = '$WORKSPACE_ID'
       AND (slug IS DISTINCT FROM '$WORKSPACE_SLUG'
            OR name IS DISTINCT FROM 'AgentWorker Verifier Workspace')
  ) OR EXISTS (
    SELECT 1 FROM workspace
     WHERE slug = '$WORKSPACE_SLUG' AND id <> '$WORKSPACE_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier workspace identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM member
     WHERE id = '$HUMAN_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR kind IS DISTINCT FROM 'human'
            OR handle IS DISTINCT FROM 'agent-worker-human'
            OR display_name IS DISTINCT FROM 'AgentWorker Human')
  ) OR EXISTS (
    SELECT 1 FROM member
     WHERE workspace_id = '$WORKSPACE_ID'
       AND lower(btrim(handle)) = lower('agent-worker-human') AND id <> '$HUMAN_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier human member identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM human
     WHERE member_id = '$HUMAN_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR email IS DISTINCT FROM '$HUMAN_EMAIL')
  ) OR EXISTS (
    SELECT 1 FROM human
     WHERE workspace_id = '$WORKSPACE_ID' AND email = '$HUMAN_EMAIL'
       AND member_id <> '$HUMAN_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier human identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM channel
     WHERE id = '$CHANNEL_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR kind IS DISTINCT FROM 'public'
            OR name IS DISTINCT FROM 'agent-worker-verifier'
            OR created_by IS DISTINCT FROM '$HUMAN_ID')
  ) OR EXISTS (
    SELECT 1 FROM channel
     WHERE workspace_id = '$WORKSPACE_ID' AND lower(name) = 'agent-worker-verifier'
       AND id <> '$CHANNEL_ID' AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier channel identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM membership
     WHERE id = '$HUMAN_MEMBERSHIP_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR channel_id IS DISTINCT FROM '$CHANNEL_ID'
            OR member_id IS DISTINCT FROM '$HUMAN_ID')
  ) OR EXISTS (
    SELECT 1 FROM membership
     WHERE channel_id = '$CHANNEL_ID' AND member_id = '$HUMAN_ID'
       AND id <> '$HUMAN_MEMBERSHIP_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier human membership identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM channel_seq
     WHERE channel_id = '$CHANNEL_ID' AND workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier channel sequence identity collision';
  END IF;
END
\$workspace_fixture\$;

INSERT INTO workspace (id, slug, name)
VALUES ('$WORKSPACE_ID', '$WORKSPACE_SLUG', 'AgentWorker Verifier Workspace')
ON CONFLICT (id) DO UPDATE SET deleted_at = NULL;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$HUMAN_ID', '$WORKSPACE_ID', 'human', 'active',
        'AgentWorker Human', 'agent-worker-human')
ON CONFLICT (id) DO UPDATE
  SET status = 'active', deleted_at = NULL;

INSERT INTO human
  (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$HUMAN_ID', '$WORKSPACE_ID', '$HUMAN_EMAIL', true,
        momo_password_hash('dev-password'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
  SET password_hash = momo_password_hash('dev-password'),
      email_verified = true;

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
VALUES ('$CHANNEL_ID', '$WORKSPACE_ID', 'public', 'agent-worker-verifier',
        'Isolated AgentWorker runtime verifier channel', '$HUMAN_ID')
ON CONFLICT (id) DO UPDATE SET archived_at = NULL;

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('$CHANNEL_ID', '$WORKSPACE_ID', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('$HUMAN_MEMBERSHIP_ID', '$WORKSPACE_ID', '$CHANNEL_ID', '$HUMAN_ID', 'owner')
ON CONFLICT (channel_id, member_id) DO UPDATE
  SET role = 'owner', left_at = NULL;

COMMIT;
SQL

PRESERVED_MEMBERSHIP_STATE_BEFORE=$(psql_scalar "SELECT md5(coalesce(jsonb_agg(jsonb_build_object('id', id, 'workspace_id', workspace_id, 'channel_id', channel_id, 'member_id', member_id, 'role', role, 'muted', muted, 'left_at', left_at) ORDER BY id)::text, '[]')) FROM membership WHERE workspace_id='$WORKSPACE_ID' AND member_id <> '$AGENT_ID' AND id <> '$AGENT_MEMBERSHIP_ID';")
PRESERVED_HERMES_STATE_BEFORE=$(psql_scalar "SELECT md5(jsonb_build_object('member', (SELECT to_jsonb(m) FROM member m WHERE m.id='$HERMES_AGENT_ID'), 'agent', (SELECT to_jsonb(a) FROM agent a WHERE a.member_id='$HERMES_AGENT_ID'), 'memberships', (SELECT coalesce(jsonb_agg(to_jsonb(ms) ORDER BY ms.id), '[]'::jsonb) FROM membership ms WHERE ms.member_id='$HERMES_AGENT_ID'))::text);")

echo "[agent-worker] preparing REST mention-routing fixture"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

-- Fixed IDs are safe only when an existing row is already owned by this
-- verifier. Never mutate a user row merely because it collides with a fixture
-- ID or handle in a persistent dogfood database.
DO \$fixture\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM member
     WHERE id = '$AGENT_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID' OR kind IS DISTINCT FROM 'agent'
            OR handle IS DISTINCT FROM '$AGENT_HANDLE'
            OR display_name IS DISTINCT FROM 'AgentWorker Verifier')
  ) OR EXISTS (
    SELECT 1 FROM member
     WHERE workspace_id = '$WORKSPACE_ID'
       AND lower(btrim(handle)) = lower('$AGENT_HANDLE') AND id <> '$AGENT_ID'
  ) OR EXISTS (
    SELECT 1 FROM member
     WHERE workspace_id = '$WORKSPACE_ID' AND kind = 'agent'
       AND btrim(display_name) = '$AGENT_HANDLE' AND id <> '$AGENT_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier member identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent
     WHERE member_id = '$AGENT_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR owner_human_id IS DISTINCT FROM '$HUMAN_ID'
            OR system_prompt IS DISTINCT FROM '$VERIFIER_SYSTEM_PROMPT')
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier agent identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM membership
     WHERE id = '$AGENT_MEMBERSHIP_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR channel_id IS DISTINCT FROM '$CHANNEL_ID'
            OR member_id IS DISTINCT FROM '$AGENT_ID')
  ) OR EXISTS (
    SELECT 1 FROM membership
     WHERE channel_id = '$CHANNEL_ID' AND member_id = '$AGENT_ID'
       AND id <> '$AGENT_MEMBERSHIP_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker verifier membership identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM member
     WHERE id = '$NON_MEMBER_AGENT_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID' OR kind IS DISTINCT FROM 'agent'
            OR handle IS DISTINCT FROM 'no-channel-agent'
            OR display_name IS DISTINCT FROM 'No Channel Agent')
  ) OR EXISTS (
    SELECT 1 FROM member
     WHERE workspace_id = '$WORKSPACE_ID'
       AND lower(btrim(handle)) = lower('no-channel-agent')
       AND id <> '$NON_MEMBER_AGENT_ID'
  ) OR EXISTS (
    SELECT 1 FROM member
     WHERE workspace_id = '$WORKSPACE_ID' AND kind = 'agent'
       AND btrim(display_name) = 'no-channel-agent' AND id <> '$NON_MEMBER_AGENT_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker non-member verifier identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent
     WHERE member_id = '$NON_MEMBER_AGENT_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR owner_human_id IS DISTINCT FROM '$HUMAN_ID'
            OR system_prompt IS DISTINCT FROM '$NON_MEMBER_SYSTEM_PROMPT')
  ) THEN
    RAISE EXCEPTION 'AgentWorker non-member agent identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM membership
     WHERE workspace_id = '$WORKSPACE_ID' AND channel_id = '$CHANNEL_ID'
       AND member_id = '$NON_MEMBER_AGENT_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker non-member fixture unexpectedly has channel membership';
  END IF;

  IF EXISTS (
    SELECT 1 FROM message
     WHERE id = '$SENTINEL_MESSAGE_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR channel_id IS DISTINCT FROM '$CHANNEL_ID'
            OR author_member_id IS DISTINCT FROM '$HUMAN_ID'
            OR client_msg_id IS DISTINCT FROM '$SENTINEL_CLIENT_MSG_ID'
            OR body IS DISTINCT FROM '@$AGENT_HANDLE MOMO-004 AgentWorker 검증해줘')
  ) OR EXISTS (
    SELECT 1 FROM message
     WHERE channel_id = '$CHANNEL_ID' AND author_member_id = '$HUMAN_ID'
       AND client_msg_id = '$SENTINEL_CLIENT_MSG_ID' AND id <> '$SENTINEL_MESSAGE_ID'
  ) OR EXISTS (
    SELECT 1 FROM message
     WHERE channel_id = '$CHANNEL_ID' AND seq = -343 AND id <> '$SENTINEL_MESSAGE_ID'
  ) THEN
    RAISE EXCEPTION 'AgentWorker preservation sentinel message collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM outbox
     WHERE id = $SENTINEL_OUTBOX_ID
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR kind IS DISTINCT FROM 'agent_job'
            OR status IS DISTINCT FROM 'pending'
            OR method IS DISTINCT FROM 'publish'
            OR available_at IS DISTINCT FROM 'infinity'::timestamptz
            OR payload->>'fixture' IS DISTINCT FROM 'momo-342-preserve'
            OR lower(payload->>'run_id') IS DISTINCT FROM lower('$SENTINEL_RUN_ID')
            OR lower(payload->>'agent_member_id') IS DISTINCT FROM lower('$HERMES_AGENT_ID')
            OR lower(payload->>'trigger_message_id') IS DISTINCT FROM lower('$SENTINEL_MESSAGE_ID'))
  ) THEN
    RAISE EXCEPTION 'AgentWorker preservation sentinel outbox collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM message
     WHERE id = '$GUARD_G2_AGENT_MSG1_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID' OR channel_id IS DISTINCT FROM '$CHANNEL_ID'
            OR author_member_id NOT IN ('$AGENT_ID', '$HERMES_AGENT_ID')
            OR body IS DISTINCT FROM 'MOMO-301 G2 auto reply 1')
  ) OR EXISTS (
    SELECT 1 FROM message
     WHERE id = '$GUARD_G2_AGENT_MSG2_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID' OR channel_id IS DISTINCT FROM '$CHANNEL_ID'
            OR author_member_id NOT IN ('$AGENT_ID', '$HERMES_AGENT_ID')
            OR body IS DISTINCT FROM 'MOMO-301 G2 auto reply 2')
  ) THEN
    RAISE EXCEPTION 'AgentWorker G2 verifier message identity collision';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agent_run ar
      JOIN (VALUES
        ('$RESUME_RUN_ID'::uuid, 'momo-178-approved-resume'),
        ('$TRIP_RUN_ID'::uuid, 'momo-004-trip'),
        ('$GUARD_DEPTH_RUN_ID'::uuid, 'momo-301-guard-depth'),
        ('$GUARD_STEP_RUN_ID'::uuid, 'momo-301-guard-step'),
        ('$GUARD_G1_RUN_ID'::uuid, 'momo-301-guard-g1'),
        ('$GUARD_G1_DECOY_RUN_ID'::uuid, 'momo-301-guard-g1-decoy'),
        ('$GUARD_G2_RUN_ID'::uuid, 'momo-301-guard-g2')
      ) expected(id, idempotency_key) ON expected.id = ar.id
     WHERE ar.workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
        OR ar.channel_id IS DISTINCT FROM '$CHANNEL_ID'
        OR ar.agent_member_id NOT IN ('$AGENT_ID', '$HERMES_AGENT_ID')
        OR ar.idempotency_key IS DISTINCT FROM expected.idempotency_key
  ) THEN
    RAISE EXCEPTION 'AgentWorker fixed run identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM approval
     WHERE id = '$RESUME_APPROVAL_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR run_id IS DISTINCT FROM '$RESUME_RUN_ID'
            OR channel_id IS DISTINCT FROM '$CHANNEL_ID'
            OR requested_by NOT IN ('$AGENT_ID', '$HERMES_AGENT_ID')
            OR action_type IS DISTINCT FROM 'tool_call')
  ) THEN
    RAISE EXCEPTION 'AgentWorker approval fixture identity collision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM budget
     WHERE id = '$BUDGET_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR grain IS DISTINCT FROM 'workspace'
            OR agent_member_id IS NOT NULL OR channel_id IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM budget
     WHERE id = '$TRIP_BUDGET_ID'
       AND (workspace_id IS DISTINCT FROM '$WORKSPACE_ID'
            OR grain IS DISTINCT FROM 'agent_channel'
            OR agent_member_id NOT IN ('$AGENT_ID', '$HERMES_AGENT_ID')
            OR channel_id IS DISTINCT FROM '$CHANNEL_ID')
  ) THEN
    RAISE EXCEPTION 'AgentWorker budget fixture identity collision';
  END IF;
END
\$fixture\$;

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count,
   author_member_id, type, body, client_msg_id)
VALUES
  ('$SENTINEL_MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', -343, 0, 0,
   '$HUMAN_ID', 'text', '@$AGENT_HANDLE MOMO-004 AgentWorker 검증해줘',
   '$SENTINEL_CLIENT_MSG_ID')
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbox
  (id, workspace_id, kind, status, method, payload, partition_key, available_at)
VALUES
  ($SENTINEL_OUTBOX_ID, '$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'fixture', 'momo-342-preserve',
     'run_id', '$SENTINEL_RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$HERMES_AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'trigger_message_id', '$SENTINEL_MESSAGE_ID',
     'model', 'hermes-agent',
     'prompt', '@$AGENT_HANDLE MOMO-004 AgentWorker 검증해줘',
     'step_count', 0,
     'depth', 0
   ), '$HERMES_AGENT_ID', 'infinity'::timestamptz)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE _momo_agent_worker_fixture_runs (
  id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO _momo_agent_worker_fixture_runs (id)
VALUES ('$RESUME_RUN_ID'), ('$TRIP_RUN_ID'),
       ('$GUARD_DEPTH_RUN_ID'), ('$GUARD_STEP_RUN_ID'),
       ('$GUARD_G1_RUN_ID'), ('$GUARD_G1_DECOY_RUN_ID'), ('$GUARD_G2_RUN_ID')
ON CONFLICT DO NOTHING;

-- Capture both current verifier runs and legacy runs created by the old
-- @hermes fixture, but only through the exact verifier trigger messages.
INSERT INTO _momo_agent_worker_fixture_runs (id)
SELECT ar.id
  FROM agent_run ar
  JOIN message trigger_message ON trigger_message.id = ar.trigger_message_id
 WHERE ar.workspace_id = '$WORKSPACE_ID'
   AND trigger_message.workspace_id = '$WORKSPACE_ID'
   AND trigger_message.channel_id = '$CHANNEL_ID'
   AND trigger_message.author_member_id = '$HUMAN_ID'
   AND trigger_message.client_msg_id IN (
     '$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID', '$EQUIV_CLIENT_MSG_ID', '$TRIP_CLIENT_MSG_ID',
     '$GUARD_DEPTH_CLIENT_MSG_ID', '$GUARD_STEP_CLIENT_MSG_ID',
     '$GUARD_G1_CLIENT_MSG_ID', '$GUARD_G2_CLIENT_MSG_ID', '$GUARD_G2_RESET_CLIENT_MSG_ID'
   )
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE _momo_agent_worker_fixture_messages (
  id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO _momo_agent_worker_fixture_messages (id)
SELECT id FROM message
 WHERE id IN ('$GUARD_G2_AGENT_MSG1_ID', '$GUARD_G2_AGENT_MSG2_ID')
ON CONFLICT DO NOTHING;

INSERT INTO _momo_agent_worker_fixture_messages (id)
SELECT id FROM message
 WHERE workspace_id = '$WORKSPACE_ID'
   AND channel_id = '$CHANNEL_ID'
   AND author_member_id IN ('$HUMAN_ID', '$AGENT_ID', '$HERMES_AGENT_ID')
   AND client_msg_id IN (
     '$CLIENT_MSG_ID', '$NON_MEMBER_CLIENT_MSG_ID', '$EQUIV_CLIENT_MSG_ID', '$TRIP_CLIENT_MSG_ID',
     '$GUARD_DEPTH_CLIENT_MSG_ID', '$GUARD_STEP_CLIENT_MSG_ID',
     '$GUARD_G1_CLIENT_MSG_ID', '$GUARD_G2_CLIENT_MSG_ID', '$GUARD_G2_RESET_CLIENT_MSG_ID'
   )
ON CONFLICT DO NOTHING;

INSERT INTO _momo_agent_worker_fixture_messages (id)
SELECT id FROM message WHERE run_id IN (SELECT id FROM _momo_agent_worker_fixture_runs)
ON CONFLICT DO NOTHING;

DELETE FROM usage_ledger
 WHERE run_id IN (SELECT id FROM _momo_agent_worker_fixture_runs);
DELETE FROM audit_log
 WHERE workspace_id = '$WORKSPACE_ID'
   AND (
     run_id IN (SELECT id FROM _momo_agent_worker_fixture_runs)
     OR (
       target_type = 'message'
       AND action IN ('agent.mention.queued', 'agent.mention.skipped')
       AND target_id IN (SELECT id FROM _momo_agent_worker_fixture_messages)
     )
   );
DELETE FROM outbox
 WHERE workspace_id = '$WORKSPACE_ID'
   AND (
     lower(payload->>'run_id') IN (SELECT lower(id::text) FROM _momo_agent_worker_fixture_runs)
     OR lower(payload->'data'->'payload'->>'run_id') IN (SELECT lower(id::text) FROM _momo_agent_worker_fixture_runs)
     OR lower(payload->>'trigger_message_id') IN (SELECT lower(id::text) FROM _momo_agent_worker_fixture_messages)
     OR lower(payload->'data'->'payload'->>'id') IN (SELECT lower(id::text) FROM _momo_agent_worker_fixture_messages)
     OR lower(payload->>'resume_from_approval_id') = lower('$RESUME_APPROVAL_ID')
   );
DELETE FROM approval_decision
 WHERE workspace_id = '$WORKSPACE_ID'
   AND approval_id IN (
     SELECT id FROM approval
      WHERE run_id IN (SELECT id FROM _momo_agent_worker_fixture_runs)
   );
DELETE FROM approval
 WHERE workspace_id = '$WORKSPACE_ID'
   AND (
     id = '$RESUME_APPROVAL_ID'
     OR run_id IN (SELECT id FROM _momo_agent_worker_fixture_runs)
   );
DELETE FROM budget_window
 WHERE workspace_id = '$WORKSPACE_ID' AND budget_id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');
DELETE FROM budget
 WHERE workspace_id = '$WORKSPACE_ID' AND id IN ('$BUDGET_ID', '$TRIP_BUDGET_ID');

-- Break the circular trigger-message/run references in dependency order.
DELETE FROM message
 WHERE id IN (SELECT id FROM _momo_agent_worker_fixture_messages)
   AND id NOT IN (
     SELECT trigger_message_id FROM agent_run
      WHERE id IN (SELECT id FROM _momo_agent_worker_fixture_runs)
        AND trigger_message_id IS NOT NULL
   );
DELETE FROM agent_run
 WHERE id IN (SELECT id FROM _momo_agent_worker_fixture_runs);
DELETE FROM message
 WHERE id IN (SELECT id FROM _momo_agent_worker_fixture_messages);

-- The positive route uses a verifier-owned agent. Never restore or mutate the
-- user-owned Hermes seed: local dogfood may have intentionally removed,
-- renamed, or re-paired it between gate runs.
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$AGENT_ID', '$WORKSPACE_ID', 'agent', 'active',
        'AgentWorker Verifier', '$AGENT_HANDLE')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle,
      deleted_at = NULL;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('$AGENT_ID', '$WORKSPACE_ID', 'hermes-agent',
        'http://localhost:$HERMES_PORT/v1',
        '$VERIFIER_SYSTEM_PROMPT',
        '$HUMAN_ID', 1, 12)
ON CONFLICT (member_id) DO UPDATE
  SET model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      system_prompt = EXCLUDED.system_prompt,
      max_concurrent_runs = EXCLUDED.max_concurrent_runs,
      max_run_steps = EXCLUDED.max_run_steps;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES ('$AGENT_MEMBERSHIP_ID', '$WORKSPACE_ID', '$CHANNEL_ID', '$AGENT_ID', 'member')
ON CONFLICT (channel_id, member_id) DO UPDATE
  SET left_at = NULL,
      role = EXCLUDED.role;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$NON_MEMBER_AGENT_ID', '$WORKSPACE_ID', 'agent', 'active',
        'No Channel Agent', 'no-channel-agent')
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      display_name = EXCLUDED.display_name,
      handle = EXCLUDED.handle,
      deleted_at = NULL;

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt,
                   owner_human_id, max_concurrent_runs, max_run_steps)
VALUES ('$NON_MEMBER_AGENT_ID', '$WORKSPACE_ID', 'hermes-agent',
        'http://localhost:8088/v1',
        '$NON_MEMBER_SYSTEM_PROMPT',
        '$HUMAN_ID', 1, 12)
ON CONFLICT (member_id) DO UPDATE
  SET model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      system_prompt = EXCLUDED.system_prompt;

INSERT INTO budget
  (id, workspace_id, grain, limit_micro_usd, period_seconds)
VALUES
  ('$BUDGET_ID', '$WORKSPACE_ID', 'workspace', 1000000, 3600);

COMMIT;
SQL
SENTINELS_ARMED=1

PRESERVED_MEMBERSHIP_STATE_AFTER=$(psql_scalar "SELECT md5(coalesce(jsonb_agg(jsonb_build_object('id', id, 'workspace_id', workspace_id, 'channel_id', channel_id, 'member_id', member_id, 'role', role, 'muted', muted, 'left_at', left_at) ORDER BY id)::text, '[]')) FROM membership WHERE workspace_id='$WORKSPACE_ID' AND member_id <> '$AGENT_ID' AND id <> '$AGENT_MEMBERSHIP_ID';")
PRESERVED_HERMES_STATE_AFTER=$(psql_scalar "SELECT md5(jsonb_build_object('member', (SELECT to_jsonb(m) FROM member m WHERE m.id='$HERMES_AGENT_ID'), 'agent', (SELECT to_jsonb(a) FROM agent a WHERE a.member_id='$HERMES_AGENT_ID'), 'memberships', (SELECT coalesce(jsonb_agg(to_jsonb(ms) ORDER BY ms.id), '[]'::jsonb) FROM membership ms WHERE ms.member_id='$HERMES_AGENT_ID'))::text);")
SENTINEL_MESSAGE_PRESERVED=$(psql_scalar "SELECT count(*) FROM message WHERE id='$SENTINEL_MESSAGE_ID' AND workspace_id='$WORKSPACE_ID' AND channel_id='$CHANNEL_ID' AND author_member_id='$HUMAN_ID' AND client_msg_id='$SENTINEL_CLIENT_MSG_ID' AND body='@$AGENT_HANDLE MOMO-004 AgentWorker 검증해줘';")
SENTINEL_JOB_PRESERVED=$(psql_scalar "SELECT count(*) FROM outbox WHERE id=$SENTINEL_OUTBOX_ID AND workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND status='pending' AND method='publish' AND available_at='infinity'::timestamptz AND payload->>'fixture'='momo-342-preserve' AND lower(payload->>'run_id')=lower('$SENTINEL_RUN_ID') AND lower(payload->>'agent_member_id')=lower('$HERMES_AGENT_ID') AND lower(payload->>'trigger_message_id')=lower('$SENTINEL_MESSAGE_ID');")
if [ "$PRESERVED_MEMBERSHIP_STATE_BEFORE" != "$PRESERVED_MEMBERSHIP_STATE_AFTER" ] \
  || [ "$PRESERVED_HERMES_STATE_BEFORE" != "$PRESERVED_HERMES_STATE_AFTER" ] \
  || [ "$SENTINEL_MESSAGE_PRESERVED" != "1" ] || [ "$SENTINEL_JOB_PRESERVED" != "1" ]; then
  echo "[agent-worker] verifier cleanup changed data outside its owned fixture" >&2
  printf 'memberships=%s/%s hermes=%s/%s sentinel_message=%s sentinel_job=%s\n' \
    "$PRESERVED_MEMBERSHIP_STATE_BEFORE" "$PRESERVED_MEMBERSHIP_STATE_AFTER" \
    "$PRESERVED_HERMES_STATE_BEFORE" "$PRESERVED_HERMES_STATE_AFTER" \
    "$SENTINEL_MESSAGE_PRESERVED" "$SENTINEL_JOB_PRESERVED" >&2
  exit 1
fi

psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
DELETE FROM outbox WHERE id = $SENTINEL_OUTBOX_ID AND payload->>'fixture' = 'momo-342-preserve';
DELETE FROM message WHERE id = '$SENTINEL_MESSAGE_ID' AND client_msg_id = '$SENTINEL_CLIENT_MSG_ID';
COMMIT;
SQL
SENTINELS_ARMED=0
echo "[agent-worker] persistent DB preservation verified: unrelated message/job/membership and user-owned Hermes unchanged"
reset_verifier_transport_history

LOGIN_JSON=$(curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$HUMAN_EMAIL\",\"password\":\"dev-password\",\"workspace\":\"$WORKSPACE_ID\"}" \
  "$BASE_URL/v1/auth/login")
ACCESS_TOKEN=$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken')
if [ "$ACCESS_TOKEN" = "" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  echo "[agent-worker] failed to obtain access token for mention send" >&2
  printf '%s\n' "$LOGIN_JSON" >&2
  exit 1
fi

MENTION_BODY="@$AGENT_HANDLE MOMO-004 AgentWorker 검증해줘"
SEND_PAYLOAD=$(jq -cn --arg client "$CLIENT_MSG_ID" --arg body "$MENTION_BODY" \
  '{clientMsgId:$client,type:"text",body:$body}')
SEND_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$SEND_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")
DUP_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$SEND_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")

MESSAGE_ID=$(printf '%s' "$SEND_JSON" | jq -r '.id')
MESSAGE_SEQ=$(printf '%s' "$SEND_JSON" | jq -r '.seq')
DUP_MESSAGE_ID=$(printf '%s' "$DUP_JSON" | jq -r '.id')
DUP_MESSAGE_SEQ=$(printf '%s' "$DUP_JSON" | jq -r '.seq')
if [ "$MESSAGE_ID" = "" ] || [ "$MESSAGE_ID" = "null" ] || [ "$MESSAGE_ID" != "$DUP_MESSAGE_ID" ] || [ "$MESSAGE_SEQ" != "$DUP_MESSAGE_SEQ" ]; then
  echo "[agent-worker] REST message idempotency did not return the same message" >&2
  printf 'send=%s\ndup=%s\n' "$SEND_JSON" "$DUP_JSON" >&2
  exit 1
fi

# message.new must carry the same server-owned mention projection as the REST
# response. Live clients cannot wait for a history reload to recover props.
MENTION_PROJECTION_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'id')=lower('$MESSAGE_ID') AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(payload->'data'->'payload'->'props'->'mention_member_ids') AS mm(v) WHERE lower(mm.v)=lower('$AGENT_ID'));")
REST_MENTION_OK=$(printf '%s' "$SEND_JSON" | jq -r --arg agent "$(printf '%s' "$AGENT_ID" | tr '[:upper:]' '[:lower:]')" '[.props.mention_member_ids[]? | ascii_downcase] | index($agent) != null')
if [ "$MENTION_PROJECTION_OK" != "1" ] || [ "$REST_MENTION_OK" != "true" ]; then
  echo "[agent-worker] message.new realtime props diverged from REST mention projection" >&2
  printf 'message=%s realtime=%s rest=%s\n' \
    "$MESSAGE_ID" "$MENTION_PROJECTION_OK" "$REST_MENTION_OK" >&2
  exit 1
fi

RUN_ID=$(psql_scalar "SELECT upper(id::text) FROM agent_run WHERE workspace_id='$WORKSPACE_ID' AND trigger_message_id='$MESSAGE_ID' AND agent_member_id='$AGENT_ID' AND lower(idempotency_key)=lower('mention:${MESSAGE_ID}:${AGENT_ID}');")
JOB_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND lower(payload->>'trigger_message_id')=lower('$MESSAGE_ID') AND lower(payload->>'agent_member_id')=lower('$AGENT_ID');")
TOTAL_RUN_COUNT=$(psql_scalar "SELECT count(*) FROM agent_run WHERE workspace_id='$WORKSPACE_ID' AND trigger_message_id='$MESSAGE_ID';")
TOTAL_JOB_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND lower(payload->>'trigger_message_id')=lower('$MESSAGE_ID');")
if [ "$RUN_ID" = "" ]; then
  SKIP_REASON=$(psql_scalar "SELECT coalesce(string_agg(coalesce(detail->>'reason', 'unknown'), ','), '') FROM audit_log WHERE workspace_id='$WORKSPACE_ID' AND action='agent.mention.skipped' AND target_id='$MESSAGE_ID';")
  echo "[agent-worker] verifier-owned agent mention did not create an agent_run" >&2
  printf 'message=%s agent=%s handle=%s jobs=%s skip_reason=%s\n' \
    "$MESSAGE_ID" "$AGENT_ID" "$AGENT_HANDLE" "$JOB_COUNT" "${SKIP_REASON:-none}" >&2
  exit 1
fi
CONTEXT_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND lower(payload->>'run_id')=lower('$RUN_ID') AND payload->'context_packet_projection'->>'schema' IN ('momo.context_packet.mention_projection.v0','momo.context_packet.v0') AND lower(payload->'source_attribution'->>'message_id')=lower('$MESSAGE_ID') AND lower(payload->>'author_member_id')=lower('$HUMAN_ID');")
AUDIT_QUEUED=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='$WORKSPACE_ID' AND action='agent.mention.queued' AND target_id='$MESSAGE_ID' AND run_id='$RUN_ID';")
if [ "$RUN_ID" = "" ] || [ "$JOB_COUNT" != "1" ] \
  || [ "$TOTAL_RUN_COUNT" != "1" ] || [ "$TOTAL_JOB_COUNT" != "1" ] \
  || [ "$CONTEXT_OK" != "1" ] || [ "$AUDIT_QUEUED" != "1" ]; then
  echo "[agent-worker] REST mention routing did not create exactly one contextual agent_job" >&2
  printf 'message=%s run=%s verifier_jobs=%s total_runs=%s total_jobs=%s context=%s audit=%s\n' \
    "$MESSAGE_ID" "$RUN_ID" "$JOB_COUNT" "$TOTAL_RUN_COUNT" "$TOTAL_JOB_COUNT" \
    "$CONTEXT_OK" "$AUDIT_QUEUED" >&2
  exit 1
fi

NON_MEMBER_BODY='@no-channel-agent should not be invoked'
NON_MEMBER_PAYLOAD=$(jq -cn --arg client "$NON_MEMBER_CLIENT_MSG_ID" --arg body "$NON_MEMBER_BODY" \
  '{clientMsgId:$client,type:"text",body:$body}')
NON_MEMBER_SEND_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$NON_MEMBER_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")
NON_MEMBER_MESSAGE_ID=$(printf '%s' "$NON_MEMBER_SEND_JSON" | jq -r '.id')
NON_MEMBER_JOB_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND lower(payload->>'trigger_message_id')=lower('$NON_MEMBER_MESSAGE_ID') AND lower(payload->>'agent_member_id')=lower('$NON_MEMBER_AGENT_ID');")
NON_MEMBER_AUDIT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE workspace_id='$WORKSPACE_ID' AND action='agent.mention.skipped' AND target_id='$NON_MEMBER_MESSAGE_ID' AND subject_member_id='$NON_MEMBER_AGENT_ID' AND detail->>'reason'='agent_not_channel_member';")
NON_MEMBER_TOTAL_RUN_COUNT=$(psql_scalar "SELECT count(*) FROM agent_run WHERE workspace_id='$WORKSPACE_ID' AND trigger_message_id='$NON_MEMBER_MESSAGE_ID';")
NON_MEMBER_TOTAL_JOB_COUNT=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='agent_job' AND lower(payload->>'trigger_message_id')=lower('$NON_MEMBER_MESSAGE_ID');")
if [ "$NON_MEMBER_JOB_COUNT" != "0" ] || [ "$NON_MEMBER_AUDIT" != "1" ] \
  || [ "$NON_MEMBER_TOTAL_RUN_COUNT" != "0" ] || [ "$NON_MEMBER_TOTAL_JOB_COUNT" != "0" ]; then
  echo "[agent-worker] non-channel agent mention did not fail closed as no-op + audit" >&2
  printf 'message=%s verifier_jobs=%s total_runs=%s total_jobs=%s audit=%s\n' \
    "$NON_MEMBER_MESSAGE_ID" "$NON_MEMBER_JOB_COUNT" "$NON_MEMBER_TOTAL_RUN_COUNT" \
    "$NON_MEMBER_TOTAL_JOB_COUNT" "$NON_MEMBER_AUDIT" >&2
  exit 1
fi

echo "[agent-worker] REST @$AGENT_HANDLE mention routing verified: message=$MESSAGE_ID seq=$MESSAGE_SEQ run=$RUN_ID duplicate_jobs=$JOB_COUNT non_member_noop=ok"

: >"$WORKER_LOG"
start_worker

echo "[agent-worker] polling success path"
SUCCESS_OK=0
deadline=$(($(date +%s) + 180))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[agent-worker] AgentWorker exited early" >&2
    tail -80 "$WORKER_LOG" >&2 || true
    exit 1
  fi

  RUN_OK=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$RUN_ID' AND status='succeeded';")
  OUTBOX_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('$RUN_ID') AND status='done';")
  USAGE_OK=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE run_id='$RUN_ID' AND prompt_tokens=11 AND completion_tokens=7 AND cost_micro_usd=6 AND was_estimated=false;")
  PROJECTION_OK=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$RUN_ID' AND input #>> '{cost_projection,source}' = 'agent_worker' AND (input #>> '{cost_projection,reserved_micro_usd}')::bigint = 0;")
  FINAL_MESSAGE_OK=$(psql_scalar "SELECT count(*) FROM message WHERE workspace_id='$WORKSPACE_ID' AND channel_id='$CHANNEL_ID' AND run_id='$RUN_ID' AND author_member_id='$AGENT_ID' AND type='text' AND body LIKE '%MOMO-004 SSE path verified%';")
  FINAL_BROADCAST_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE workspace_id='$WORKSPACE_ID' AND kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('$RUN_ID') AND payload->'data'->'payload'->>'type'='text' AND (payload->>'version')::bigint = (payload->'data'->>'seq')::bigint AND status IN ('pending', 'processing', 'done') AND last_error IS NULL;")
  # In the full local gate, approval-decision verification can leave a valid
  # same-run resume agent_job that the worker processes before this fixture.
  # The immutable usage_ledger assertion above proves this run's exact cost;
  # the shared workspace budget window only needs to show that reservations
  # were released and at least this run's spend was reconciled.
  WINDOW_OK=$(psql_scalar "SELECT count(*) FROM budget_window WHERE budget_id='$BUDGET_ID' AND reserved_micro_usd=0 AND spent_micro_usd>=6;")

  HISTORY_JSON=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$AGENT_CHANNEL\",\"limit\":100,\"reverse\":true}" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')
  PARTIAL_OK=$(printf '%s' "$HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "agent.partial")
      | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
      | select((.payload.text // "") | contains("MOMO-004 SSE path verified"))
    ] | length
  ')
  TOOL_PARTIAL_OK=$(printf '%s' "$HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "agent.partial")
      | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
      | select(.payload.tool_call_name == "github.search_issues")
      | select((.payload.tool_call_args | type) == "object")
      | select(.payload.tool_call_args.query == "MOMO-201 live tool-call fixture")
      | select(.payload.tool_call_args.limit == 2)
      | select(.payload.tool_call_args_truncated == false)
    ] | length
  ')
  CHANNEL_HISTORY_JSON=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$CENT_CHANNEL\",\"limit\":100,\"reverse\":true}" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')
  FINAL_LIVE_OK=$(printf '%s' "$CHANNEL_HISTORY_JSON" | jq -r --arg run "$RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "message.new")
      | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
      | select(.payload.type == "text")
      | select((.payload.body // "") | contains("MOMO-004 SSE path verified"))
      | select(.seq == .payload.seq)
    ] | length
  ')

  if [ "$RUN_OK" = "1" ] && [ "$OUTBOX_OK" = "1" ] \
    && [ "$USAGE_OK" = "1" ] && [ "$WINDOW_OK" = "1" ] \
    && [ "$PROJECTION_OK" = "1" ] \
    && [ "$FINAL_MESSAGE_OK" = "1" ] && [ "$FINAL_BROADCAST_OK" != "0" ] \
    && [ "$PARTIAL_OK" != "0" ] && [ "$TOOL_PARTIAL_OK" != "0" ] \
    && [ "$FINAL_LIVE_OK" != "0" ]; then
    SUCCESS_OK=1
    break
  fi
  sleep 1
done

if [ "$SUCCESS_OK" != "1" ]; then
  echo "[agent-worker] success path did not verify" >&2
  printf 'run=%s outbox=%s usage=%s window=%s projection=%s final_message=%s final_broadcast=%s partial=%s tool_partial=%s final_live=%s\n' \
    "${RUN_OK:-unset}" "${OUTBOX_OK:-unset}" "${USAGE_OK:-unset}" "${WINDOW_OK:-unset}" \
    "${PROJECTION_OK:-unset}" "${FINAL_MESSAGE_OK:-unset}" "${FINAL_BROADCAST_OK:-unset}" \
    "${PARTIAL_OK:-unset}" "${TOOL_PARTIAL_OK:-unset}" "${FINAL_LIVE_OK:-unset}" >&2
  echo "[agent-worker] worker log:" >&2
  tail -120 "$WORKER_LOG" >&2 || true
  echo "[agent-worker] mock hermes log:" >&2
  tail -120 "$MOCK_LOG" >&2 || true
  echo "[agent-worker] relay log:" >&2
  tail -120 "$RELAY_LOG" >&2 || true
  exit 1
fi

echo "[agent-worker] success path verified: REST mention -> agent_job -> agent.partial/tool_call + final channel message.new + usage_ledger + budget_window + cost_projection"
verify_cost_projection_endpoint

echo "[agent-worker] seeding approved deterministic resume fixture"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$RESUME_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID',
   'queued', 1, 12, 0,
   jsonb_build_object('prompt', 'MOMO-178 approved mock resume'),
   'momo-178-approved-resume');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, requested_by,
   action_type, payload, status, decided_by, decided_at, decision_reason)
VALUES
  ('$RESUME_APPROVAL_ID', '$WORKSPACE_ID', '$RESUME_RUN_ID', '$CHANNEL_ID', '$AGENT_ID',
   'tool_call',
   jsonb_build_object(
     'run_id', '$RESUME_RUN_ID',
     'action_type', 'tool_call',
     'tool_call', jsonb_build_object(
       'call_id', 'call_momo_178_echo',
       'name', 'momo.mock.echo',
       'arguments', jsonb_build_object('message', 'approved hello'),
       'tool_grant', jsonb_build_object(
         'tool_name', 'momo.mock.echo',
         'approval_policy', 'always',
         'capability_version', 'mock-tool@0.1.0',
         'policy_version', 'capability-policy@2026-06-29'
       )
     ),
     'resume_model', 'same_run_new_agent_job'
   ),
   'approved', '$HUMAN_ID', now(), 'runtime smoke approval');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'resume_approval',
   jsonb_build_object(
     'run_id', '$RESUME_RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '',
     'resume_from_approval_id', '$RESUME_APPROVAL_ID',
     'approved_tool_call', jsonb_build_object(
       'call_id', 'call_momo_178_echo',
       'name', 'momo.mock.echo',
       'arguments', jsonb_build_object('message', 'approved hello'),
       'payload_sha256', 'sha256:${RESUME_APPROVAL_ID}'
     ),
     'policy_evidence', jsonb_build_object(
       'tool_name', 'momo.mock.echo',
       'approval_policy', 'always',
       'capability_version', 'mock-tool@0.1.0',
       'policy_version', 'capability-policy@2026-06-29'
     ),
     'approval_decision', jsonb_build_object(
       'approval_id', '$RESUME_APPROVAL_ID',
       'status', 'approved'
     ),
     'step_count', 1,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL

RESUME_OK=0
deadline=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  RUN_DONE=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$RESUME_RUN_ID' AND status='succeeded' AND output->>'ok'='true';")
  JOB_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND method='resume_approval' AND lower(payload->>'resume_from_approval_id')=lower('$RESUME_APPROVAL_ID') AND status='done' AND last_error IS NULL;")
  RESULT_MSG=$(psql_scalar "SELECT count(*) FROM message WHERE run_id='$RESUME_RUN_ID' AND type='tool_result' AND lower(props->>'approval_id')=lower('$RESUME_APPROVAL_ID') AND props->>'call_id'='call_momo_178_echo' AND props->>'is_error'='false';")
  AUDIT_OK=$(psql_scalar "SELECT count(*) FROM audit_log WHERE run_id='$RESUME_RUN_ID' AND action IN ('approval.resume','tool.executed');")
  # In the all-profile gate, a relay process from the previous verifier can
  # consume this broadcast quickly. The invariant is that AgentWorker created a
  # non-failed broadcast outbox row for the tool_result, not that it remains
  # pending at the exact polling instant.
  BROADCAST_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('$RESUME_RUN_ID') AND payload->'data'->'payload'->>'type'='tool_result' AND (payload->>'version')::bigint = (payload->'data'->>'seq')::bigint AND status IN ('pending', 'done') AND last_error IS NULL;")

  if [ "$RUN_DONE" = "1" ] && [ "$JOB_DONE" = "1" ] \
    && [ "$RESULT_MSG" = "1" ] && [ "$AUDIT_OK" = "2" ] \
    && [ "$BROADCAST_OK" = "1" ]; then
    RESUME_OK=1
    break
  fi
  sleep 1
done

if [ "$RESUME_OK" != "1" ]; then
  echo "[agent-worker] approved resume path did not verify" >&2
  tail -160 "$WORKER_LOG" >&2 || true
  exit 1
fi

echo "[agent-worker] approved resume path verified: final tool_result/message.new + audit + resume job done"

echo "[agent-worker] running MOMO-352 trigger -> approval -> human decision -> resume scenario"
stop_worker
EQUIV_BODY="@$AGENT_HANDLE MOMO-352 approval equivalence smoke"
EQUIV_SEND_PAYLOAD=$(jq -cn --arg client "$EQUIV_CLIENT_MSG_ID" --arg body "$EQUIV_BODY" \
  '{clientMsgId:$client,type:"text",body:$body}')
EQUIV_SEND_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$EQUIV_SEND_PAYLOAD" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")
EQUIV_MESSAGE_ID=$(printf '%s' "$EQUIV_SEND_JSON" | jq -r '.id')
EQUIV_RUN_ID=$(psql_scalar "SELECT upper(id::text) FROM agent_run WHERE workspace_id='$WORKSPACE_ID' AND trigger_message_id='$EQUIV_MESSAGE_ID' AND agent_member_id='$AGENT_ID';")
EQUIV_QUEUED=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$EQUIV_RUN_ID' AND status='queued';")
if [ "$EQUIV_RUN_ID" = "" ] || [ "$EQUIV_QUEUED" != "1" ]; then
  echo "[agent-worker] MOMO-352 trigger did not create a queued run" >&2
  exit 1
fi

# The production mention projection intentionally grants the read-only search
# tool without approval. This fixture narrows only its own pending job to the
# deterministic momo.mock.echo tool and marks that grant approval-required so
# AgentWorker's real pause machinery creates the approval checkpoint.
psql_run >/dev/null <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
WITH grant_fixture AS (
  SELECT jsonb_build_array(jsonb_build_object(
    'tool_name', 'momo.mock.echo',
    'provider', 'momo',
    'grant', 'write',
    'risk', 'write',
    'approval_policy', 'always',
    'capability_version', 'mock-tool@0.1.0',
    'policy_version', 'capability-policy@2026-07-12'
  )) AS grants
)
UPDATE outbox
   SET payload = jsonb_set(
                   jsonb_set(payload, '{tool_grants}', grant_fixture.grants, true),
                   '{context_packet_projection,tool_grants}', grant_fixture.grants, true
                 )
  FROM grant_fixture
 WHERE workspace_id = '$WORKSPACE_ID'
   AND kind = 'agent_job'
   AND status = 'pending'
   AND lower(payload->>'run_id') = lower('$EQUIV_RUN_ID');
COMMIT;
SQL

start_worker
EQUIV_PAUSED=0
deadline=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  EQUIV_APPROVAL_ID=$(psql_scalar "SELECT upper(id::text) FROM approval WHERE workspace_id='$WORKSPACE_ID' AND run_id='$EQUIV_RUN_ID' AND status='pending' LIMIT 1;")
  EQUIV_AWAITING=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$EQUIV_RUN_ID' AND status='awaiting_approval';")
  EQUIV_REQUEST_MSG=$(psql_scalar "SELECT count(*) FROM message WHERE run_id='$EQUIV_RUN_ID' AND type='approval_request' AND props->>'call_id'='call_momo_352_echo';")
  EQUIV_REQUEST_AUDIT=$(psql_scalar "SELECT count(*) FROM audit_log WHERE run_id='$EQUIV_RUN_ID' AND action='approval.requested';")
  EQUIV_INITIAL_JOB_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('$EQUIV_RUN_ID') AND method='publish' AND status='done';")
  EQUIV_REQUEST_BROADCAST=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('$EQUIV_RUN_ID') AND payload->'data'->'payload'->>'type'='approval_request' AND last_error IS NULL;")
  if [ "$EQUIV_APPROVAL_ID" != "" ] && [ "$EQUIV_AWAITING" = "1" ] \
    && [ "$EQUIV_REQUEST_MSG" = "1" ] && [ "$EQUIV_REQUEST_AUDIT" = "1" ] \
    && [ "$EQUIV_INITIAL_JOB_DONE" = "1" ] && [ "$EQUIV_REQUEST_BROADCAST" = "1" ]; then
    EQUIV_PAUSED=1
    break
  fi
  sleep 1
done
if [ "$EQUIV_PAUSED" != "1" ]; then
  echo "[agent-worker] MOMO-352 approval checkpoint did not verify" >&2
  tail -160 "$WORKER_LOG" >&2 || true
  exit 1
fi

stop_worker
EQUIV_DECISION_JSON=$(curl -fsS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"approval_id\":\"$EQUIV_APPROVAL_ID\",\"approve\":true,\"reason\":\"MOMO-352 worker equivalence verifier\",\"client_decision_id\":\"$EQUIV_DECISION_ID\"}" \
  "$BASE_URL/v1/workspaces/$WORKSPACE_ID/approvals/$EQUIV_APPROVAL_ID/decision")
if [ "$(printf '%s' "$EQUIV_DECISION_JSON" | jq -r '.status')" != "approved" ]; then
  echo "[agent-worker] MOMO-352 human approval decision failed" >&2
  printf '%s\n' "$EQUIV_DECISION_JSON" >&2
  exit 1
fi
EQUIV_DECISION_RECORDED=$(psql_scalar "SELECT count(*) FROM approval_decision WHERE workspace_id='$WORKSPACE_ID' AND approval_id='$EQUIV_APPROVAL_ID' AND client_decision_id='$EQUIV_DECISION_ID' AND approve=true AND status='approved';")
EQUIV_REQUEUED=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$EQUIV_RUN_ID' AND status='queued';")
EQUIV_RESUME_PENDING=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND method='resume_approval' AND lower(payload->>'run_id')=lower('$EQUIV_RUN_ID') AND lower(payload->>'resume_from_approval_id')=lower('$EQUIV_APPROVAL_ID') AND status='pending';")
if [ "$EQUIV_DECISION_RECORDED" != "1" ] || [ "$EQUIV_REQUEUED" != "1" ] \
  || [ "$EQUIV_RESUME_PENDING" != "1" ]; then
  echo "[agent-worker] MOMO-352 approval decision did not enqueue exact resume" >&2
  exit 1
fi

start_worker
EQUIV_FINAL=0
deadline=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  EQUIV_SUCCEEDED=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$EQUIV_RUN_ID' AND status='succeeded' AND output->>'ok'='true';")
  EQUIV_RESUME_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND method='resume_approval' AND lower(payload->>'run_id')=lower('$EQUIV_RUN_ID') AND lower(payload->>'resume_from_approval_id')=lower('$EQUIV_APPROVAL_ID') AND status='done' AND last_error IS NULL;")
  EQUIV_RESULT_MSG=$(psql_scalar "SELECT count(*) FROM message WHERE run_id='$EQUIV_RUN_ID' AND type='tool_result' AND lower(props->>'approval_id')=lower('$EQUIV_APPROVAL_ID') AND props->>'call_id'='call_momo_352_echo' AND props->>'is_error'='false';")
  EQUIV_AUDITS=$(psql_scalar "SELECT count(*) FROM audit_log WHERE run_id='$EQUIV_RUN_ID' AND action IN ('approval.requested','approval.approved','approval.resume','tool.executed');")
  EQUIV_FINAL_BROADCAST=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('$EQUIV_RUN_ID') AND payload->'data'->'payload'->>'type'='tool_result' AND status IN ('pending','processing','done') AND last_error IS NULL;")
  EQUIV_CHANNEL_HISTORY=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$CENT_CHANNEL\",\"limit\":100,\"reverse\":true}" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')
  EQUIV_FINAL_LIVE=$(printf '%s' "$EQUIV_CHANNEL_HISTORY" | jq -r --arg run "$EQUIV_RUN_ID" '
    [.result.publications[]?.data
      | select(.type == "message.new")
      | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
      | select(.payload.type == "tool_result")
      | select(.seq == .payload.seq)
    ] | length
  ')
  if [ "$EQUIV_SUCCEEDED" = "1" ] && [ "$EQUIV_RESUME_DONE" = "1" ] \
    && [ "$EQUIV_RESULT_MSG" = "1" ] && [ "$EQUIV_AUDITS" = "4" ] \
    && [ "$EQUIV_FINAL_BROADCAST" = "1" ] && [ "$EQUIV_FINAL_LIVE" != "0" ]; then
    EQUIV_FINAL=1
    break
  fi
  sleep 1
done
if [ "$EQUIV_FINAL" != "1" ]; then
  echo "[agent-worker] MOMO-352 approved resume finalization did not verify" >&2
  tail -160 "$WORKER_LOG" >&2 || true
  exit 1
fi

EQUIV_STATUS_HISTORY=$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"$AGENT_CHANNEL\",\"limit\":100,\"reverse\":true}" \
  "$CENT_API_URL/history")
EQUIV_RUNNING_STATUSES=$(printf '%s' "$EQUIV_STATUS_HISTORY" | jq -r --arg run "$EQUIV_RUN_ID" '
  [.result.publications[]?.data
    | select(.type == "agent.status")
    | select(((.payload.run_id // "") | ascii_downcase) == ($run | ascii_downcase))
    | select(.payload.run_status == "running")
  ] | length
')
EQUIV_AWAITING_STATUSES=$(printf '%s' "$EQUIV_STATUS_HISTORY" | jq -r --arg run "$EQUIV_RUN_ID" '
  [.result.publications[]?.data
    | select(.type == "agent.status")
    | select(((.payload.run_id // "") | ascii_downcase) == ($run | ascii_downcase))
    | select(.payload.run_status == "awaiting_approval")
  ] | length
')
if [ "$EQUIV_RUNNING_STATUSES" -lt 2 ] || [ "$EQUIV_AWAITING_STATUSES" -lt 1 ]; then
  echo "[agent-worker] MOMO-352 realtime status transitions were incomplete" >&2
  exit 1
fi
echo "[agent-worker] MOMO-352 equivalence scenario verified: queued -> running -> awaiting_approval -> queued -> running -> succeeded"

echo "[agent-worker] seeding low-limit circuit-breaker fixture"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$TRIP_MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', '@hermes 예산 초과 테스트', '$TRIP_CLIENT_MSG_ID'
  FROM bumped;

INSERT INTO budget
  (id, workspace_id, grain, agent_member_id, channel_id, limit_micro_usd, period_seconds)
VALUES
  ('$TRIP_BUDGET_ID', '$WORKSPACE_ID', 'agent_channel',
   '$AGENT_ID', '$CHANNEL_ID', 1, 3600);

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$TRIP_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', '$TRIP_MESSAGE_ID',
   'queued', 0, 12, 0,
   jsonb_build_object('prompt', '@hermes 예산 초과 테스트'),
   'momo-004-trip');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$TRIP_RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '@hermes 예산 초과 테스트',
     'max_output_tokens', 64,
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL

TRIP_OK=0
deadline=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  RUN_FAILED=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$TRIP_RUN_ID' AND status='failed' AND error #>> '{}' = 'G5 budget trip (agent_channel)';")
  OUTBOX_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('$TRIP_RUN_ID') AND status='done';")
  NO_SPEND=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE run_id='$TRIP_RUN_ID';")

  if [ "$RUN_FAILED" = "1" ] && [ "$OUTBOX_DONE" = "1" ] && [ "$NO_SPEND" = "0" ]; then
    TRIP_OK=1
    break
  fi
  sleep 1
done

if [ "$TRIP_OK" != "1" ]; then
  echo "[agent-worker] circuit-breaker path did not verify" >&2
  tail -120 "$WORKER_LOG" >&2 || true
  exit 1
fi

echo "[agent-worker] circuit-breaker path verified: low-limit budget trips before spend"

# =============================================================================
# MOMO-301 deterministic loop-guard trip scenarios (a2a_depth/G3/G1/G2, DB SoT).
# Payload gate seeds are intentionally 0 so a trip proves the worker read the
# authoritative agent_run/agent/message state from Postgres, not the outbox
# payload. The §3.4 depth cap is labeled a2a_depth in durable records (audit
# detail/props/agent_run.error) — the canonical L4 §3.3 G4 is SimHash.
# =============================================================================

seed_guard_fixture() {
  guard_run_id=$1
  guard_message_id=$2
  guard_client_msg_id=$3
  guard_body=$4
  guard_step_count=$5
  guard_depth=$6
  guard_idem_key=$7

  psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$guard_message_id', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', '$guard_body', '$guard_client_msg_id'
  FROM bumped;

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$guard_run_id', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', '$guard_message_id',
   'queued', $guard_step_count, 12, $guard_depth,
   jsonb_build_object('prompt', '$guard_body'),
   '$guard_idem_key');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$guard_run_id',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '$guard_body',
     'max_output_tokens', 64,
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL
}

wait_guard_trip() {
  guard_run_id=$1
  guard_gate=$2
  guard_label=$3

  guard_ok=0
  deadline=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    RUN_FAILED=$(psql_scalar "SELECT count(*) FROM agent_run WHERE id='$guard_run_id' AND status='failed' AND error->>'code'='loop_guard_tripped' AND error->>'gate'='$guard_gate';")
    AUDIT_OK=$(psql_scalar "SELECT count(*) FROM audit_log WHERE run_id='$guard_run_id' AND action='agent.guard.tripped' AND target_type='agent_run' AND detail->>'gate'='$guard_gate';")
    DEGRADED_OK=$(psql_scalar "SELECT count(*) FROM message WHERE run_id='$guard_run_id' AND type='system' AND author_member_id='$AGENT_ID' AND body LIKE '%loop-safety guard $guard_gate%' AND props->>'gate'='$guard_gate';")
    BROADCAST_OK=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='broadcast' AND payload->'data'->>'type'='message.new' AND lower(payload->'data'->'payload'->>'run_id')=lower('$guard_run_id') AND payload->'data'->'payload'->>'type'='system' AND (payload->>'version')::bigint = (payload->'data'->>'seq')::bigint AND status IN ('pending','processing','done') AND last_error IS NULL;")
    JOB_DONE=$(psql_scalar "SELECT count(*) FROM outbox WHERE kind='agent_job' AND lower(payload->>'run_id')=lower('$guard_run_id') AND status='done';")
    NO_SPEND=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE run_id='$guard_run_id';")

    if [ "$RUN_FAILED" = "1" ] && [ "$AUDIT_OK" = "1" ] && [ "$DEGRADED_OK" = "1" ] \
      && [ "$BROADCAST_OK" = "1" ] && [ "$JOB_DONE" = "1" ] && [ "$NO_SPEND" = "0" ]; then
      guard_ok=1
      break
    fi
    sleep 1
  done

  if [ "$guard_ok" != "1" ]; then
    echo "[agent-worker] loop-guard $guard_label trip did not verify" >&2
    printf 'run_failed=%s audit=%s degraded=%s broadcast=%s job_done=%s no_spend=%s\n' \
      "${RUN_FAILED:-}" "${AUDIT_OK:-}" "${DEGRADED_OK:-}" "${BROADCAST_OK:-}" "${JOB_DONE:-}" "${NO_SPEND:-}" >&2
    tail -120 "$WORKER_LOG" >&2 || true
    exit 1
  fi
  echo "[agent-worker] loop-guard $guard_label trip verified: failed run + audit_log + degraded system message + no spend"
}

echo "[agent-worker] seeding a2a_depth trip fixture (agent_run.depth=2 > MAX_DEPTH=$GUARD_MAX_DEPTH env, payload depth=0, CHECK depth<=4 respected)"
seed_guard_fixture "$GUARD_DEPTH_RUN_ID" "$GUARD_DEPTH_MESSAGE_ID" "$GUARD_DEPTH_CLIENT_MSG_ID" \
  '@hermes MOMO-301 depth cap trip' 0 2 'momo-301-guard-depth'
wait_guard_trip "$GUARD_DEPTH_RUN_ID" "a2a_depth" "a2a_depth(hop-depth)"

echo "[agent-worker] seeding G3 step-cap trip fixture (agent_run.step_count=12, payload step_count=0)"
seed_guard_fixture "$GUARD_STEP_RUN_ID" "$GUARD_STEP_MESSAGE_ID" "$GUARD_STEP_CLIENT_MSG_ID" \
  '@hermes MOMO-301 step cap trip' 12 0 'momo-301-guard-step'
wait_guard_trip "$GUARD_STEP_RUN_ID" "G3" "G3(step)"

echo "[agent-worker] seeding G1 concurrency trip fixture (decoy running run for the same agent)"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id,
   status, step_count, max_steps, depth, input, idempotency_key, started_at)
VALUES
  ('$GUARD_G1_DECOY_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID',
   'running', 1, 12, 0,
   jsonb_build_object('prompt', 'MOMO-301 G1 decoy live run'),
   'momo-301-guard-g1-decoy', now());
COMMIT;
SQL
seed_guard_fixture "$GUARD_G1_RUN_ID" "$GUARD_G1_MESSAGE_ID" "$GUARD_G1_CLIENT_MSG_ID" \
  '@hermes MOMO-301 concurrency trip' 0 0 'momo-301-guard-g1'
wait_guard_trip "$GUARD_G1_RUN_ID" "G1" "G1(concurrency)"

# Release the decoy semaphore so later verifiers (live-channel/hermes-bridge/
# m3-dbc reruns) are not G1-blocked by a synthetic live run.
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
UPDATE agent_run
   SET status = 'cancelled', finished_at = now(), updated_at = now()
 WHERE id = '$GUARD_G1_DECOY_RUN_ID';
COMMIT;
SQL

# G2 per-agent consecutive-auto trip: seed a human message followed by 2 agent
# text messages by the demo agent (no run_id -> each counts once), so the demo
# agent's counter since the last human message is 2 = MAX_CONSECUTIVE_AUTO env.
# The next run for this agent must trip G2 before any provider call.
echo "[agent-worker] seeding G2 consecutive-auto trip fixture (2 trailing agent text messages, MAX_CONSECUTIVE_AUTO=$GUARD_MAX_CONSECUTIVE_AUTO env)"
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$GUARD_G2_MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', '@hermes MOMO-301 consecutive auto trip', '$GUARD_G2_CLIENT_MSG_ID'
  FROM bumped;

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body)
SELECT '$GUARD_G2_AGENT_MSG1_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$AGENT_ID', 'text', 'MOMO-301 G2 auto reply 1'
  FROM bumped;

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body)
SELECT '$GUARD_G2_AGENT_MSG2_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$AGENT_ID', 'text', 'MOMO-301 G2 auto reply 2'
  FROM bumped;

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, trigger_message_id,
   status, step_count, max_steps, depth, input, idempotency_key)
VALUES
  ('$GUARD_G2_RUN_ID', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', '$GUARD_G2_MESSAGE_ID',
   'queued', 0, 12, 0,
   jsonb_build_object('prompt', '@hermes MOMO-301 consecutive auto trip'),
   'momo-301-guard-g2');

INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$GUARD_G2_RUN_ID',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '@hermes MOMO-301 consecutive auto trip',
     'max_output_tokens', 64,
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');

COMMIT;
SQL
wait_guard_trip "$GUARD_G2_RUN_ID" "G2" "G2(consecutive-auto)"

# Reset the demo agent's auto-reply counter with a human message so later
# verifiers in the same profile do not inherit the seeded streak.
psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
   type, body, client_msg_id)
SELECT '$GUARD_G2_RESET_MESSAGE_ID', '$WORKSPACE_ID', '$CHANNEL_ID', bumped.last_seq,
       (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
       '$HUMAN_ID', 'text', 'MOMO-301 G2 counter reset', '$GUARD_G2_RESET_CLIENT_MSG_ID'
  FROM bumped;
COMMIT;
SQL

echo "[agent-worker] loop-guard trip scenarios verified: a2a_depth(hop-depth) G3(step) G1(concurrency) G2(consecutive-auto)"
if [ "${AGENT_WORKER_EQUIVALENCE_EVIDENCE_FILE:-}" != "" ]; then
  EQUIV_USAGE_LEDGER=$(psql_scalar "SELECT count(*) FROM usage_ledger WHERE run_id='$RUN_ID';")
  [ "$EQUIV_USAGE_LEDGER" = "1" ] || { echo "[agent-worker] MOMO-352 usage guarantee disappeared" >&2; exit 1; }
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
        path: "worker",
        completed_at: $completed_at,
        provider_metadata: "openai-compatible-sse",
        lease_model: "worker-skip-locked",
        cent_channel: $channel
      }
    }' >"$AGENT_WORKER_EQUIVALENCE_EVIDENCE_FILE"
  echo "[agent-worker] MOMO-352 evidence: $AGENT_WORKER_EQUIVALENCE_EVIDENCE_FILE"
fi
echo "[agent-worker] logs: worker=$WORKER_LOG mock=$MOCK_LOG server=$SERVER_LOG cost_projection=$COST_PROJECTION_JSON"
