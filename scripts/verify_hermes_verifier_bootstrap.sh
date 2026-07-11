#!/usr/bin/env bash
# MOMO-346: force both Hermes verifier pre-marker COMMENT failures and prove
# exact-OID rollback without contacting either provider path.
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
  echo "[hermes-bootstrap] psql not found" >&2
  exit 1
fi

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo_dev_pw}
EXTERNAL_TEST_DB=momo_external_agent_bootstrap_${POSTGRES_PORT}_$$
GATEWAY_TEST_DB=momo_hermes_gateway_bootstrap_${POSTGRES_PORT}_$$

database_count() {
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT count(*) FROM pg_database WHERE datname = '$1';") || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

assert_absent() {
  count=$(database_count "$1") || exit 1
  [ "$count" = "0" ] || { echo "[hermes-bootstrap] verifier DB leaked or pre-existed: $1" >&2; exit 1; }
}

assert_absent "$EXTERNAL_TEST_DB"
set +e
MOMO_ENV=local \
AGENT_PROVIDER_MODE=external-hermes \
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 \
HERMES_BASE_URL=http://127.0.0.1:1/v1 \
HERMES_API_KEY=momo-bootstrap-regression-key \
AGENT_MODEL=hermes-agent \
EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS=1 \
EXTERNAL_AGENT_PROVIDER_VERIFIER_DB="$EXTERNAL_TEST_DB" \
EXTERNAL_AGENT_PROVIDER_VERIFIER_TEST_FAIL_COMMENT=1 \
  "$REPO_ROOT/scripts/verify_external_agent_provider.sh" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "96" ] || { echo "[hermes-bootstrap] external verifier expected exit 96, got $rc" >&2; exit 1; }
assert_absent "$EXTERNAL_TEST_DB"

assert_absent "$GATEWAY_TEST_DB"
set +e
HERMES_GATEWAY_VERIFIER_DB="$GATEWAY_TEST_DB" \
HERMES_GATEWAY_VERIFIER_TEST_FAIL_COMMENT=1 \
  "$REPO_ROOT/scripts/verify_hermes_gateway_adapter.sh" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "96" ] || { echo "[hermes-bootstrap] gateway verifier expected exit 96, got $rc" >&2; exit 1; }
assert_absent "$GATEWAY_TEST_DB"

echo "[hermes-bootstrap] PASS: external-provider + gateway COMMENT failure exact-OID rollback"
