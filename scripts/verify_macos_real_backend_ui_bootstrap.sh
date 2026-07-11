#!/usr/bin/env bash
# MOMO-348: force the macOS verifier pre-marker COMMENT failure and prove
# exact-OID rollback without starting MomoServer or mutating the source DB.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-}
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    [ -f "$candidate" ] || continue
    ENV_FILE=$candidate
    break
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
  echo "[macos-real-backend-bootstrap] psql not found" >&2
  exit 1
fi

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo_dev_pw}
TEST_DB=momo_macos_ui_bootstrap_${POSTGRES_PORT}_$$

database_count() {
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$TEST_DB';") || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

before=$(database_count) || exit 1
[ "$before" = "0" ] || { echo "[macos-real-backend-bootstrap] refusing pre-existing DB: $TEST_DB" >&2; exit 1; }

set +e
MACOS_REAL_BACKEND_VERIFIER_DB="$TEST_DB" \
MACOS_REAL_BACKEND_VERIFIER_TEST_FAIL_COMMENT=1 \
  "$REPO_ROOT/scripts/verify_macos_real_backend_ui.sh" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "96" ] || { echo "[macos-real-backend-bootstrap] expected exit 96, got $rc" >&2; exit 1; }
after=$(database_count) || exit 1
[ "$after" = "0" ] || { echo "[macos-real-backend-bootstrap] pre-marker DB leaked: $TEST_DB" >&2; exit 1; }

echo "[macos-real-backend-bootstrap] PASS: COMMENT failure exact-OID rollback"
