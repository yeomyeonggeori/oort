#!/usr/bin/env bash
# MOMO-344: force the pre-marker COMMENT failure and prove exact-OID rollback.
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
else
  echo "[agent-context-bootstrap] psql not found" >&2
  exit 1
fi

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo_dev_pw}
TEST_DB=momo_agent_context_bootstrap_${POSTGRES_PORT}_$$

database_count() {
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$TEST_DB';") || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

before=$(database_count) || exit 1
[ "$before" = "0" ] || { echo "[agent-context-bootstrap] refusing pre-existing DB: $TEST_DB" >&2; exit 1; }

set +e
AGENT_CONTEXT_VERIFIER_DB="$TEST_DB" AGENT_CONTEXT_VERIFIER_TEST_FAIL_COMMENT=1 \
  "$REPO_ROOT/scripts/verify_agent_context.sh" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "96" ] || { echo "[agent-context-bootstrap] expected exit 96, got $rc" >&2; exit 1; }
after=$(database_count) || exit 1
[ "$after" = "0" ] || { echo "[agent-context-bootstrap] pre-marker DB leaked: $TEST_DB" >&2; exit 1; }

echo "[agent-context-bootstrap] PASS: COMMENT failure exact-OID rollback"
