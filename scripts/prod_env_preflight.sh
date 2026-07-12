#!/usr/bin/env bash
# Fail-fast guard for momo staging/prod/internal-host bootstrap env files.
set -euo pipefail

ENV_FILE=""
MODE="auto"
FROM_ENV=0
EVIDENCE_DIR=""
CHECK_RESULTS=()

usage() {
  cat <<'EOF'
Usage: scripts/prod_env_preflight.sh (--env-file FILE | --from-env) [--mode auto|staging|prod|production|internal-host|internal-smoke|local] [--evidence-dir DIR]

Validates the env boundary before running prod/internal-host compose:
  - staging/prod/internal-host: required env must be present and must not use
    placeholder, dev-insecure, localhost, mock, or default secrets.
  - internal-smoke/local: only the documented repo-local placeholder values are
    allowed, with localhost domains, mock Hermes, and internal-smoke image tags.

This script does not decrypt SOPS files. Use it after `sops exec-env` or against
the env file rendered by the operator.

When --evidence-dir is set, the script writes redacted Markdown and JSON
preflight evidence suitable for a PR body or host handoff.
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
    --evidence-dir)
      EVIDENCE_DIR="${2:-}"
      shift 2
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
  CHECK_RESULTS+=("fail|$*")
}

pass() {
  echo "PASS: $*"
  CHECK_RESULTS+=("pass|$*")
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
  if [ "$value" = "" ]; then
    fail "missing required env: $key"
  else
    pass "required env present: $key"
  fi
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

display_value() {
  local key="$1"
  local value="$2"
  if is_sensitive_key "$key"; then
    printf '[REDACTED]'
  else
    printf '%s' "$value"
  fi
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
      fail "$key uses a placeholder/dev/local value: $(display_value "$key" "$value")"
      return 0
      ;;
  esac

  if is_sensitive_key "$key"; then
    case "$lowered" in
      password|secret|token|default|dev|test|staging|prod|production|admin|momo)
        fail "$key uses an unsafe default-looking secret value"
        return 0
        ;;
    esac
  fi

  pass "$key is non-placeholder for strict mode"
}

assert_not_latest_or_smoke_image() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    *:internal-smoke|*:internal-smoke-*|*:latest|momo-api:*|momo-outbox-relay:*|momo-agent-worker:*)
      fail "$key must be a pinned registry image for staging/prod/internal-host: $value"
      return 0
      ;;
  esac
  pass "$key is a pinned non-local registry image"
}

assert_exact() {
  local key="$1"
  local expected="$2"
  local value
  value="$(get_var "$key")"
  if [ "$value" = "$expected" ]; then
    pass "$key has expected mode-specific value"
  else
    fail "$key must be '$expected' for this mode (got '$value')"
  fi
}

assert_contains() {
  local key="$1"
  local needle="$2"
  local value
  value="$(get_var "$key")"
  case "$value" in
    *"$needle"*) pass "$key contains expected internal-smoke marker '$needle'" ;;
    *) fail "$key must contain '$needle' in internal-smoke/local mode (got '$value')" ;;
  esac
}

assert_http_url() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    https://*) pass "$key uses public HTTPS" ;;
    *) fail "$key must use https:// outside internal-smoke/local mode" ;;
  esac
}

assert_public_https_url() {
  local key="$1"
  local value
  local host
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  assert_http_url "$key"
  host="${value#https://}"
  host="${host%%/*}"
  host="${host%%:*}"
  assert_public_domain_value "$key host" "$host"
}

assert_realtime_websocket_url() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    wss://*/connection/websocket) pass "$key uses the secure Centrifugo websocket endpoint" ;;
    *) fail "$key must use wss:// and end with /connection/websocket outside local development" ;;
  esac
}

assert_email() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    *@*.*) pass "$key looks like a routable email address" ;;
    *) fail "$key must be a real email address for public ACME/TLS" ;;
  esac
}

assert_public_domain() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  assert_public_domain_value "$key" "$value"
}

assert_public_domain_value() {
  local label="$1"
  local value="$2"
  local lowered
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    localhost|*.localhost|*.local|*.localdomain|*.test|*.invalid|*.example|example.com|*.example.com|*.internal)
      fail "$label must use a public DNS name, not a reserved/local domain"
      return 0
      ;;
  esac
  case "$value" in
    *.*) pass "$label looks like a public DNS name" ;;
    *) fail "$label must look like a public DNS name" ;;
  esac
}

assert_db_url_host() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    postgres://*@postgres:*/*|postgresql://*@postgres:*/*)
      pass "$key uses compose-internal postgres host"
      ;;
    *)
      fail "$key must use compose-internal postgres host for image-based public/staging deploy"
      ;;
  esac
}

assert_secret_source() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    sops://*|age://*|host-env|host-local|tmpfs|process-env|exec-env|*/secrets.sops.env)
      pass "$key declares an operator-controlled SOPS/age or host secret source"
      ;;
    *)
      fail "$key must declare a SOPS/age or host-local secret source, not a repo placeholder"
      ;;
  esac
}

assert_named_volume() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  case "$value" in
    /*|./*|../*)
      fail "$key must be a named Docker volume in public/staging mode, not a host path"
      ;;
    *[!A-Za-z0-9_.-]*|"")
      fail "$key must be a simple named Docker volume"
      ;;
    *)
      pass "$key is a named Docker volume"
      ;;
  esac
}

assert_required_literal() {
  local key="$1"
  local expected="$2"
  local value
  value="$(get_var "$key")"
  [ "$value" = "$expected" ] && pass "$key is explicitly required" || fail "$key must be '$expected'"
}

write_evidence() {
  [ "$EVIDENCE_DIR" != "" ] || return 0
  mkdir -p "$EVIDENCE_DIR"
  local stamp
  local markdown
  local json
  stamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  markdown="$EVIDENCE_DIR/prod-env-preflight-${env_mode}.md"
  json="$EVIDENCE_DIR/prod-env-preflight-${env_mode}.json"

  {
    echo "## Public Host Preflight"
    echo "- Result: $([ "$failures" -eq 0 ] && echo PASS || echo FAIL)"
    echo "- Mode: \`$env_mode\`"
    echo "- Runtime boundary: \`$runtime_mode\`"
    echo "- Source: \`${ENV_FILE:-process environment}\`"
    echo "- Generated: $stamp"
    echo "- Secrets: values redacted; evidence records only presence and shape."
    echo "- Checks:"
    local entry status message marker
    for entry in "${CHECK_RESULTS[@]:-}"; do
      status="${entry%%|*}"
      message="${entry#*|}"
      marker="[ ]"
      [ "$status" = "pass" ] && marker="[x]"
      echo "  - $marker $message"
    done
    echo "- Public/staging coverage:"
    echo "  - DNS/TLS env shape, ACME email, registry image pins, SOPS/age secret source, DB/Redis volume intent, pgBackRest stanza/check/full backup/WAL/PITR required env."
    echo "- Not covered:"
    echo "  - Actual DNS change, ACME certificate issuance, production host login/deploy, registry pull, SOPS decrypt, pgBackRest backup/PITR execution."
  } > "$markdown"

  python3 - "$json" "$env_mode" "$runtime_mode" "${ENV_FILE:-process environment}" "$failures" "$stamp" "${CHECK_RESULTS[@]:-}" <<'PY'
import json
import sys

out, mode, runtime, source, failures, stamp, *entries = sys.argv[1:]
checks = []
for entry in entries:
    status, _, message = entry.partition("|")
    checks.append({"status": status, "message": message})
payload = {
    "result": "PASS" if int(failures) == 0 else "FAIL",
    "mode": mode,
    "runtime_boundary": runtime,
    "source": source,
    "generated_at_utc": stamp,
    "secret_values": "redacted",
    "checks": checks,
    "coverage": [
        "public_base_url",
        "caddy_email",
        "dns_tls_env_shape",
        "acme_email",
        "registry_image_pins",
        "sops_age_secret_source",
        "db_redis_volume_intent",
        "pgbackrest_wal_pitr_required_env",
    ],
    "not_covered": [
        "actual_dns_change",
        "actual_tls_certificate_issuance",
        "production_host_deploy",
        "registry_pull",
        "sops_decrypt",
        "pgbackrest_backup_or_pitr_execution",
    ],
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

  echo "wrote preflight evidence markdown: $markdown"
  echo "wrote preflight evidence json: $json"
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
    COMPOSE_PROJECT_NAME MOMO_ENV PUBLIC_BASE_URL API_DOMAIN REALTIME_DOMAIN MOMO_CENTRIFUGO_WS_URL CADDY_EMAIL ACME_EMAIL HTTP_PORT HTTPS_PORT \
    MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE \
    POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL RELAY_DATABASE_URL \
    REDIS_PASSWORD CENTRIFUGO_REDIS_ADDRESS CENT_TOKEN_HMAC CENT_API_KEY CENT_PROXY_SECRET JWT_HMAC \
    AGENT_PROVIDER_MODE AGENT_MODEL HERMES_BASE_URL HERMES_API_KEY \
    SECRET_SOURCE DB_VOLUME_NAME REDIS_VOLUME_NAME PGBACKREST_STANZA \
    PGBACKREST_REPO1_PATH PGBACKREST_REPO1_CIPHER_PASS PGBACKREST_WAL_ARCHIVE_REQUIRED \
    PGBACKREST_STANZA_CHECK_REQUIRED PGBACKREST_FULL_BACKUP_REQUIRED PGBACKREST_PITR_REHEARSAL_REQUIRED

  for key in \
    API_DOMAIN REALTIME_DOMAIN MOMO_CENTRIFUGO_WS_URL ACME_EMAIL MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE \
    PUBLIC_BASE_URL CADDY_EMAIL \
    POSTGRES_PASSWORD DATABASE_URL RELAY_DATABASE_URL REDIS_PASSWORD CENTRIFUGO_REDIS_ADDRESS \
    CENT_TOKEN_HMAC CENT_API_KEY CENT_PROXY_SECRET JWT_HMAC HERMES_BASE_URL HERMES_API_KEY SECRET_SOURCE \
    DB_VOLUME_NAME REDIS_VOLUME_NAME PGBACKREST_STANZA PGBACKREST_REPO1_PATH \
    PGBACKREST_REPO1_CIPHER_PASS; do
    assert_no_prod_placeholder "$key"
  done

  assert_public_domain API_DOMAIN
  assert_public_domain REALTIME_DOMAIN
  assert_realtime_websocket_url MOMO_CENTRIFUGO_WS_URL
  assert_public_https_url PUBLIC_BASE_URL
  assert_email CADDY_EMAIL
  assert_email ACME_EMAIL

  assert_not_latest_or_smoke_image MOMO_API_IMAGE
  assert_not_latest_or_smoke_image MOMO_RELAY_IMAGE
  assert_not_latest_or_smoke_image MOMO_WORKER_IMAGE

  assert_exact AGENT_PROVIDER_MODE external-hermes
  assert_http_url HERMES_BASE_URL
  assert_secret_source SECRET_SOURCE
  assert_named_volume DB_VOLUME_NAME
  assert_named_volume REDIS_VOLUME_NAME
  assert_db_url_host DATABASE_URL
  assert_db_url_host RELAY_DATABASE_URL
  assert_required_literal PGBACKREST_WAL_ARCHIVE_REQUIRED 1
  assert_required_literal PGBACKREST_STANZA_CHECK_REQUIRED 1
  assert_required_literal PGBACKREST_FULL_BACKUP_REQUIRED 1
  assert_required_literal PGBACKREST_PITR_REHEARSAL_REQUIRED 1

  case "$(get_var CENTRIFUGO_REDIS_ADDRESS)" in
    redis://:*@redis:*|rediss://:*@redis:*) pass "CENTRIFUGO_REDIS_ADDRESS uses passworded compose-internal Redis" ;;
    *) fail "CENTRIFUGO_REDIS_ADDRESS must include an explicit Redis password outside internal-smoke/local mode" ;;
  esac
elif [ "$runtime_mode" = "internal-smoke" ]; then
  require_vars \
    COMPOSE_PROJECT_NAME MOMO_ENV API_DOMAIN REALTIME_DOMAIN MOMO_CENTRIFUGO_WS_URL ACME_EMAIL HTTP_PORT HTTPS_PORT \
    MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE MOMO_MIGRATE_IMAGE MOMO_MOCK_HERMES_IMAGE \
    POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD MIGRATE_DATABASE_URL MOMO_APP_DATABASE_URL \
    DATABASE_URL RELAY_DATABASE_URL WORKER_DATABASE_URL MOMO_BOOTSTRAP_RUNTIME_ROLES \
    REDIS_PASSWORD CENTRIFUGO_REDIS_ADDRESS CENT_TOKEN_HMAC CENT_API_KEY CENT_PROXY_SECRET JWT_HMAC \
    AGENT_PROVIDER_MODE AGENT_MODEL HERMES_BASE_URL HERMES_API_KEY

  case "${MOMO_ENV:-}" in
    internal-smoke|local|dev|development) ;;
    *) fail "internal-smoke/local mode requires MOMO_ENV=internal-smoke/local/dev/development" ;;
  esac

  assert_exact API_DOMAIN localhost
  assert_exact REALTIME_DOMAIN rt.localhost
  assert_exact MOMO_CENTRIFUGO_WS_URL wss://rt.localhost/connection/websocket
  assert_exact POSTGRES_PASSWORD change-me-postgres
  assert_exact REDIS_PASSWORD change-me-redis
  assert_exact CENT_TOKEN_HMAC change-me-cent-token-hmac
  assert_exact CENT_API_KEY change-me-cent-api-key
  assert_exact CENT_PROXY_SECRET change-me-cent-proxy-secret
  assert_exact JWT_HMAC change-me-jwt-hmac
  assert_exact AGENT_PROVIDER_MODE internal-host-mock
  assert_exact AGENT_MODEL hermes-agent
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
  write_evidence
  echo "prod env preflight failed ($failures issue(s)): ${ENV_FILE:-process environment}" >&2
  exit 1
fi

write_evidence
pass "prod env preflight passed for $env_mode: ${ENV_FILE:-process environment}"
