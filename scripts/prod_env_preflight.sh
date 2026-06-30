#!/usr/bin/env bash
# Fail-fast guard for momo staging/prod/internal-host bootstrap env files.
set -euo pipefail

ENV_FILE=""
MODE="auto"
FROM_ENV=0

usage() {
  cat <<'EOF'
Usage: scripts/prod_env_preflight.sh (--env-file FILE | --from-env) [--mode auto|staging|prod|production|internal-host|internal-smoke|local]

Validates the env boundary before running prod/internal-host compose:
  - staging/prod/internal-host: required env must be present and must not use
    placeholder, dev-insecure, localhost, mock, or default secrets.
  - internal-smoke/local: only the documented repo-local placeholder values are
    allowed, with localhost domains, mock Hermes, and internal-smoke image tags.

This script does not decrypt SOPS files. Use it after `sops exec-env` or against
the env file rendered by the operator.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --from-env)
      FROM_ENV=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$ENV_FILE" = "" ] && [ "$FROM_ENV" != "1" ]; then
  echo "missing --env-file or --from-env" >&2
  usage >&2
  exit 2
fi

if [ "$ENV_FILE" != "" ]; then
  [ -f "$ENV_FILE" ] || {
    echo "missing env file: $ENV_FILE" >&2
    exit 1
  }
fi

failures=0

fail() {
  failures=$((failures + 1))
  echo "FAIL: $*" >&2
}

pass() {
  echo "PASS: $*"
}

load_env() {
  [ "$ENV_FILE" != "" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

get_var() {
  eval "printf '%s' \"\${$1-}\""
}

require_var() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || fail "missing required env: $key"
}

require_vars() {
  local key
  for key in "$@"; do
    require_var "$key"
  done
}

is_sensitive_key() {
  case "$1" in
    *PASSWORD*|*HMAC*|*API_KEY*|*TOKEN*|*SECRET*|*CIPHER_PASS*|DATABASE_URL|RELAY_DATABASE_URL|WORKER_DATABASE_URL|MOMO_APP_DATABASE_URL|MIGRATE_DATABASE_URL|CENTRIFUGO_REDIS_ADDRESS|HERMES_BASE_URL)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

assert_no_prod_placeholder() {
  local key="$1"
  local value
  local lowered
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  case "$lowered" in
    *change-me*|*changeme*|*dev-insecure*|*placeholder*|*'__'*|*example.com*|*mock-hermes*|*localhost*|*127.0.0.1*|*0.0.0.0*|*momo_app_dev_pw*|*momo_relay_dev_pw*|*momo_worker_dev_pw*)
      fail "$key uses a placeholder/dev/local value: $value"
      return 0
      ;;
  esac

  if is_sensitive_key "$key"; then
    case "$lowered" in
      password|secret|token|default|dev|test|staging|prod|production|admin|momo)
        fail "$key uses an unsafe default-looking secret value"
        ;;
    esac
  fi
}

assert_not_latest_or_smoke_image() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    *:internal-smoke|*:internal-smoke-*|*:latest|momo-api:*|momo-outbox-relay:*|momo-agent-worker:*)
      fail "$key must be a pinned registry image for staging/prod/internal-host: $value"
      ;;
  esac
}

assert_exact() {
  local key="$1"
  local expected="$2"
  local value
  value="$(get_var "$key")"
  [ "$value" = "$expected" ] || fail "$key must be '$expected' in internal-smoke/local mode (got '$value')"
}

assert_contains() {
  local key="$1"
  local needle="$2"
  local value
  value="$(get_var "$key")"
  case "$value" in
    *"$needle"*) ;;
    *) fail "$key must contain '$needle' in internal-smoke/local mode (got '$value')" ;;
  esac
}

load_env

env_mode="$MODE"
if [ "$env_mode" = "auto" ]; then
  env_mode="${MOMO_ENV:-}"
fi

case "$env_mode" in
  prod|production|staging|internal-host)
    runtime_mode="strict"
    ;;
  internal-smoke|local|dev|development)
    runtime_mode="internal-smoke"
    ;;
  *)
    fail "unknown or missing MOMO_ENV/mode: ${env_mode:-<empty>}"
    runtime_mode="unknown"
    ;;
esac

if [ "$runtime_mode" = "strict" ]; then
  require_vars \
    COMPOSE_PROJECT_NAME MOMO_ENV API_DOMAIN REALTIME_DOMAIN ACME_EMAIL HTTP_PORT HTTPS_PORT \
    MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE \
    POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL RELAY_DATABASE_URL \
    REDIS_PASSWORD CENTRIFUGO_REDIS_ADDRESS CENT_TOKEN_HMAC CENT_API_KEY JWT_HMAC \
    HERMES_BASE_URL HERMES_API_KEY

  for key in \
    API_DOMAIN REALTIME_DOMAIN ACME_EMAIL MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE \
    POSTGRES_PASSWORD DATABASE_URL RELAY_DATABASE_URL REDIS_PASSWORD CENTRIFUGO_REDIS_ADDRESS \
    CENT_TOKEN_HMAC CENT_API_KEY JWT_HMAC HERMES_BASE_URL HERMES_API_KEY; do
    assert_no_prod_placeholder "$key"
  done

  assert_not_latest_or_smoke_image MOMO_API_IMAGE
  assert_not_latest_or_smoke_image MOMO_RELAY_IMAGE
  assert_not_latest_or_smoke_image MOMO_WORKER_IMAGE

  case "$(get_var HERMES_BASE_URL)" in
    https://*) ;;
    *) fail "HERMES_BASE_URL must use https:// outside internal-smoke/local mode" ;;
  esac

  case "$(get_var CENTRIFUGO_REDIS_ADDRESS)" in
    redis://:*) ;;
    rediss://:*) ;;
    *) fail "CENTRIFUGO_REDIS_ADDRESS must include an explicit Redis password outside internal-smoke/local mode" ;;
  esac
elif [ "$runtime_mode" = "internal-smoke" ]; then
  require_vars \
    COMPOSE_PROJECT_NAME MOMO_ENV API_DOMAIN REALTIME_DOMAIN ACME_EMAIL HTTP_PORT HTTPS_PORT \
    MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE MOMO_MIGRATE_IMAGE MOMO_MOCK_HERMES_IMAGE \
    POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD MIGRATE_DATABASE_URL MOMO_APP_DATABASE_URL \
    DATABASE_URL RELAY_DATABASE_URL WORKER_DATABASE_URL MOMO_BOOTSTRAP_RUNTIME_ROLES \
    REDIS_PASSWORD CENTRIFUGO_REDIS_ADDRESS CENT_TOKEN_HMAC CENT_API_KEY JWT_HMAC \
    HERMES_BASE_URL HERMES_API_KEY

  case "${MOMO_ENV:-}" in
    internal-smoke|local|dev|development) ;;
    *) fail "internal-smoke/local mode requires MOMO_ENV=internal-smoke/local/dev/development" ;;
  esac

  assert_exact API_DOMAIN localhost
  assert_exact REALTIME_DOMAIN rt.localhost
  assert_exact POSTGRES_PASSWORD change-me-postgres
  assert_exact REDIS_PASSWORD change-me-redis
  assert_exact CENT_TOKEN_HMAC change-me-cent-token-hmac
  assert_exact CENT_API_KEY change-me-cent-api-key
  assert_exact JWT_HMAC change-me-jwt-hmac
  assert_exact HERMES_BASE_URL http://mock-hermes:8088/v1
  assert_exact HERMES_API_KEY change-me-hermes-bearer
  assert_exact MOMO_BOOTSTRAP_RUNTIME_ROLES 1

  assert_contains MOMO_API_IMAGE internal-smoke
  assert_contains MOMO_RELAY_IMAGE internal-smoke
  assert_contains MOMO_WORKER_IMAGE internal-smoke
  assert_contains MOMO_MIGRATE_IMAGE internal-smoke
  assert_contains MOMO_MOCK_HERMES_IMAGE internal-smoke
  assert_contains MIGRATE_DATABASE_URL change-me-postgres
  assert_contains MOMO_APP_DATABASE_URL momo_app_dev_pw
  assert_contains RELAY_DATABASE_URL momo_relay_dev_pw
  assert_contains WORKER_DATABASE_URL momo_worker_dev_pw
  assert_contains CENTRIFUGO_REDIS_ADDRESS change-me-redis
fi

if [ "$failures" -ne 0 ]; then
  echo "prod env preflight failed ($failures issue(s)): ${ENV_FILE:-process environment}" >&2
  exit 1
fi

pass "prod env preflight passed for $env_mode: ${ENV_FILE:-process environment}"
