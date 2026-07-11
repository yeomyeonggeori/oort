#!/usr/bin/env bash
# MOMO-343: prove failed bootstrap rollback, successful fresh bootstrap, and
# persistent reuse against unique verifier-owned databases.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

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

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN=$(command -v psql)
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[agent-worker-bootstrap] psql not found" >&2
  exit 1
fi

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo_dev_pw}
MARKER_PREFIX=momo:agent-worker-verifier:v1:
ROLLBACK_DB=momo_agent_worker_bootstrap_rollback_${POSTGRES_PORT}_$$
SUCCESS_DB=momo_agent_worker_bootstrap_success_${POSTGRES_PORT}_$$
ROLLBACK_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
SUCCESS_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
ROLLBACK_MARKER=${MARKER_PREFIX}${ROLLBACK_UUID}
SUCCESS_MARKER=${MARKER_PREFIX}${SUCCESS_UUID}
CLEANUP_DB=
CLEANUP_MARKER=

database_exists() {
  db_name=$1
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$db_name';") || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

database_marker() {
  db_name=$1
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$db_name';" \
    2>/dev/null) || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

role_marker() {
  role_name=$1
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT COALESCE(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '$role_name';" \
    2>/dev/null) || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

roles_for_marker() {
  marker=$1
  suffix=$(printf '%s' "$marker" | shasum -a 256 | cut -c 1-12)
  printf '%s\n' "momo_aw_${suffix}_app" "momo_aw_${suffix}_relay" "momo_aw_${suffix}_worker"
}

cleanup() {
  if [ "$CLEANUP_DB" = "" ]; then
    return
  fi
  db_exists=$(database_exists "$CLEANUP_DB" 2>/dev/null) || return
  if [ "$db_exists" = "1" ]; then
    current_marker=$(database_marker "$CLEANUP_DB") || return
    if [ "$current_marker" != "$CLEANUP_MARKER" ]; then
      echo "[agent-worker-bootstrap] refusing fallback cleanup: marker mismatch for $CLEANUP_DB" >&2
      return
    fi
  fi
  while IFS= read -r role_name; do
    current_role_marker=$(role_marker "$role_name") || return
    if [ "$current_role_marker" = "$CLEANUP_MARKER" ]; then
      PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
        -v ON_ERROR_STOP=1 --no-psqlrc \
        -c "ALTER ROLE \"$role_name\" NOLOGIN;" >/dev/null 2>&1 || return
    fi
  done < <(roles_for_marker "$CLEANUP_MARKER")
  if [ "$db_exists" = "1" ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
      -v ON_ERROR_STOP=1 --no-psqlrc \
      -c "DROP DATABASE \"$CLEANUP_DB\" WITH (FORCE);" >/dev/null 2>&1 || return
  fi
  while IFS= read -r role_name; do
    current_role_marker=$(role_marker "$role_name") || return
    if [ "$current_role_marker" = "$CLEANUP_MARKER" ]; then
      PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
        -v ON_ERROR_STOP=1 --no-psqlrc \
        -c "DROP ROLE \"$role_name\";" >/dev/null 2>&1 || return
    fi
  done < <(roles_for_marker "$CLEANUP_MARKER")
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for db_name in "$ROLLBACK_DB" "$SUCCESS_DB"; do
  existing_count=$(database_exists "$db_name") || exit 1
  if [ "$existing_count" != "0" ]; then
    echo "[agent-worker-bootstrap] refusing pre-existing test database: $db_name" >&2
    exit 1
  fi
done

CLEANUP_DB=$ROLLBACK_DB
CLEANUP_MARKER=$ROLLBACK_MARKER
set +e
AGENT_WORKER_VERIFIER_DB="$ROLLBACK_DB" \
AGENT_WORKER_VERIFIER_TEST_MARKER_UUID="$ROLLBACK_UUID" \
AGENT_WORKER_VERIFIER_TEST_FAIL_COMMENT=1 \
  "$REPO_ROOT/scripts/verify_agent_worker.sh" >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" != "96" ]; then
  echo "[agent-worker-bootstrap] expected forced COMMENT exit 96, got $rc" >&2
  exit 1
fi
rollback_count=$(database_exists "$ROLLBACK_DB") || exit 1
if [ "$rollback_count" != "0" ]; then
  echo "[agent-worker-bootstrap] COMMENT failure left verifier DB behind: $ROLLBACK_DB" >&2
  exit 1
fi
echo "[agent-worker-bootstrap] pre-marker rollback PASS: removed exact created OID"

set +e
AGENT_WORKER_VERIFIER_DB="$ROLLBACK_DB" \
AGENT_WORKER_VERIFIER_TEST_MARKER_UUID="$ROLLBACK_UUID" \
AGENT_WORKER_VERIFIER_TEST_FAIL_AFTER_MARKER=1 \
  "$REPO_ROOT/scripts/verify_agent_worker.sh" >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" != "97" ]; then
  echo "[agent-worker-bootstrap] expected injected exit 97, got $rc" >&2
  exit 1
fi
rollback_count=$(database_exists "$ROLLBACK_DB") || exit 1
if [ "$rollback_count" != "0" ]; then
  echo "[agent-worker-bootstrap] failed bootstrap left verifier DB behind: $ROLLBACK_DB" >&2
  exit 1
fi
echo "[agent-worker-bootstrap] rollback PASS: removed only $ROLLBACK_DB"

CLEANUP_DB=$SUCCESS_DB
CLEANUP_MARKER=$SUCCESS_MARKER
AGENT_WORKER_VERIFIER_DB="$SUCCESS_DB" \
AGENT_WORKER_VERIFIER_TEST_MARKER_UUID="$SUCCESS_UUID" \
  "$REPO_ROOT/scripts/verify_agent_worker.sh"
success_marker=$(database_marker "$SUCCESS_DB") || exit 1
if [ "$success_marker" != "$SUCCESS_MARKER" ]; then
  echo "[agent-worker-bootstrap] successful fresh bootstrap marker mismatch" >&2
  exit 1
fi

AGENT_WORKER_VERIFIER_DB="$SUCCESS_DB" \
AGENT_WORKER_VERIFIER_TEST_MARKER_UUID="$SUCCESS_UUID" \
AGENT_WORKER_VERIFIER_TEST_CLEANUP_ON_EXIT=1 \
  "$REPO_ROOT/scripts/verify_agent_worker.sh"
success_count=$(database_exists "$SUCCESS_DB") || exit 1
if [ "$success_count" != "0" ]; then
  echo "[agent-worker-bootstrap] successful verifier lifecycle did not clean up: $SUCCESS_DB" >&2
  exit 1
fi
while IFS= read -r role_name; do
  remaining_role_marker=$(role_marker "$role_name") || {
    echo "[agent-worker-bootstrap] failed to verify role cleanup: $role_name" >&2
    exit 1
  }
  if [ "$remaining_role_marker" != "" ]; then
    echo "[agent-worker-bootstrap] verifier role remained after exact cleanup: $role_name" >&2
    exit 1
  fi
done < <(roles_for_marker "$SUCCESS_MARKER")

CLEANUP_DB=
CLEANUP_MARKER=
trap - EXIT INT TERM
echo "[agent-worker-bootstrap] PASS: fresh bootstrap + persistent reuse + exact cleanup"
