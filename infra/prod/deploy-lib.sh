#!/usr/bin/env bash
# Shared, non-interactive helpers for the production install/upgrade wrappers.
# This file never prints environment values; image refs are persisted only in
# the mode-0600 deployment state needed for rollback.

set -euo pipefail

PROD_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$PROD_DIR/../.." && pwd)"
COMPOSE_FILE="$PROD_DIR/docker-compose.prod.yml"
PREFLIGHT="$REPO_ROOT/scripts/prod_env_preflight.sh"
DEPLOY_STATE_NAME="deploy-state.env"

deploy_log() {
  printf '[momo-deploy] %s\n' "$*"
}

deploy_fail() {
  printf '[momo-deploy] FAIL: %s\n' "$*" >&2
  exit 1
}

deploy_usage_fail() {
  printf '[momo-deploy] %s\n' "$*" >&2
  exit 2
}

require_file() {
  [ -f "$1" ] || deploy_fail "required file is missing: $1"
}

configure_env_source() {
  if [ -n "${ENV_FILE:-}" ] && [ "${FROM_ENV:-0}" = "1" ]; then
    deploy_usage_fail "choose exactly one of --env-file or --from-env"
  fi
  if [ -z "${ENV_FILE:-}" ] && [ "${FROM_ENV:-0}" != "1" ]; then
    deploy_usage_fail "missing --env-file FILE or --from-env"
  fi
  if [ -n "${ENV_FILE:-}" ]; then
    require_file "$ENV_FILE"
    ENV_FILE="$(CDPATH='' cd -- "$(dirname -- "$ENV_FILE")" && pwd)/$(basename -- "$ENV_FILE")"
  fi
}

run_prod_preflight() {
  local args=(--mode "${DEPLOY_MODE:-prod}")
  if [ -n "${ENV_FILE:-}" ]; then
    args+=(--env-file "$ENV_FILE")
  else
    args+=(--from-env)
  fi
  if [ -n "${EVIDENCE_DIR:-}" ]; then
    args+=(--evidence-dir "$EVIDENCE_DIR")
  fi
  deploy_log "validating the redacted production environment contract"
  "$PREFLIGHT" "${args[@]}"
}

load_deploy_env() {
  if [ -n "${ENV_FILE:-}" ]; then
    set -a
    # shellcheck disable=SC1090 # operator-selected host-local env file
    . "$ENV_FILE"
    set +a
  fi
}

validate_initial_owner_credentials() {
  [ -n "${MOMO_INITIAL_OWNER_EMAIL:-}" ] || deploy_fail "MOMO_INITIAL_OWNER_EMAIL is required for installation"
  [ -n "${MOMO_INITIAL_OWNER_PASSWORD:-}" ] || deploy_fail "MOMO_INITIAL_OWNER_PASSWORD is required for installation"
  case "$MOMO_INITIAL_OWNER_EMAIL" in
    *@*) ;;
    *) deploy_fail "MOMO_INITIAL_OWNER_EMAIL must be a valid email address" ;;
  esac
  case "$MOMO_INITIAL_OWNER_EMAIL:$MOMO_INITIAL_OWNER_PASSWORD" in
    *change-me*|*__BASE_DOMAIN__*|*__INITIAL_OWNER_PASSWORD__*)
      deploy_fail "initial owner credentials must replace template placeholders"
      ;;
  esac
  deploy_log "validated initial owner credential input (values redacted)"
}

validate_digest_ref() {
  local key="$1"
  local value="${!key:-}"
  if [[ ! "$value" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]]; then
    deploy_fail "$key must be an immutable image ref ending in @sha256:<64 lowercase hex>"
  fi
}

validate_momo_image_digests() {
  if [ -n "${MOMO_IMAGE:-}" ]; then
    validate_digest_ref MOMO_IMAGE
    local alias
    for alias in \
      MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE MOMO_MIGRATE_IMAGE \
      MOMO_WEB_IMAGE MOMO_LINKSHORT_IMAGE; do
      [ "${!alias:-}" = "$MOMO_IMAGE" ] ||
        deploy_fail "$alias must equal MOMO_IMAGE for a unified-image deployment"
    done
    deploy_log "validated one immutable momo image digest and six compatible aliases"
    return 0
  fi

  # Backward compatibility for pre-MOMO-565 env/state files. New templates
  # always set MOMO_IMAGE and converge all aliases to it.
  validate_digest_ref MOMO_API_IMAGE
  validate_digest_ref MOMO_RELAY_IMAGE
  validate_digest_ref MOMO_WORKER_IMAGE
  validate_digest_ref MOMO_MIGRATE_IMAGE
  validate_digest_ref MOMO_WEB_IMAGE
  validate_digest_ref MOMO_LINKSHORT_IMAGE
  deploy_log "validated legacy six-image digest set"
}

verify_momo_image_attestations() {
  local policy="${MOMO_ATTESTATION_POLICY:-warn}"
  local image_key image_ref

  case "$policy" in
    warn|required) ;;
    *) deploy_fail "MOMO_ATTESTATION_POLICY must be warn or required" ;;
  esac

  if ! command -v gh >/dev/null 2>&1; then
    if [ "$policy" = "required" ]; then
      deploy_fail "GitHub CLI is required by MOMO_ATTESTATION_POLICY=required"
    fi
    deploy_log "WARNING: GitHub CLI is unavailable; skipping provenance attestation verification"
    return 0
  fi

  local image_keys
  if [ -n "${MOMO_IMAGE:-}" ]; then
    image_keys="MOMO_IMAGE"
  else
    image_keys="MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE MOMO_MIGRATE_IMAGE MOMO_WEB_IMAGE MOMO_LINKSHORT_IMAGE"
  fi

  for image_key in $image_keys; do
    image_ref="${!image_key}"
    if gh attestation verify "oci://$image_ref" \
      --repo yeomyeonggeori/oort \
      --predicate-type https://slsa.dev/provenance/v1 >/dev/null 2>&1; then
      deploy_log "verified SLSA provenance attestation for $image_key"
      continue
    fi

    if [ "$policy" = "required" ]; then
      deploy_fail "provenance attestation verification failed for $image_key"
    fi
    deploy_log "WARNING: no verifiable provenance attestation for $image_key; continuing under warn policy"
  done
}

configure_compose() {
  COMPOSE=(docker compose)
  if [ -n "${ENV_FILE:-}" ]; then
    COMPOSE+=(--env-file "$ENV_FILE")
  fi
  COMPOSE+=(-f "$COMPOSE_FILE")
}

render_compose_contract() {
  deploy_log "rendering the production compose contract"
  "${COMPOSE[@]}" config --quiet
}

check_required_commands() {
  local command_name
  for command_name in docker curl; do
    command -v "$command_name" >/dev/null 2>&1 || deploy_fail "missing required command: $command_name"
  done
  docker compose version >/dev/null 2>&1 || deploy_fail "Docker Compose v2 is required"
  docker info >/dev/null 2>&1 || deploy_fail "Docker daemon is unavailable"
}

check_dns_name() {
  local name="$1"
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$name" >/dev/null 2>&1 || deploy_fail "DNS does not resolve for public hostname: $name"
  elif command -v dig >/dev/null 2>&1; then
    [ -n "$(dig +short "$name" | head -n 1)" ] || deploy_fail "DNS does not resolve for public hostname: $name"
  else
    deploy_fail "getent or dig is required for DNS preflight"
  fi
}

check_host_contract() {
  check_required_commands
  # shellcheck disable=SC2153 # populated by the validated operator env source
  check_dns_name "$API_DOMAIN"
  check_dns_name "$REALTIME_DOMAIN"
  if [ -n "${APP_DOMAIN:-}" ]; then
    check_dns_name "$APP_DOMAIN"
  fi

  local disk_root available_kb
  disk_root="$(dirname -- "$STATE_DIR")"
  while [ ! -d "$disk_root" ] && [ "$disk_root" != "/" ]; do
    disk_root="$(dirname -- "$disk_root")"
  done
  available_kb="$(df -Pk "$disk_root" | awk 'NR == 2 {print $4}')"
  [ "${available_kb:-0}" -ge 10485760 ] || deploy_fail "at least 10 GiB free disk is required"

  # Re-running an existing deployment is intentionally safe, so occupied edge
  # ports are diagnostic rather than fatal. Docker/compose will give the final,
  # actionable bind error if another process owns them.
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"${HTTP_PORT:-80}" -sTCP:LISTEN >/dev/null 2>&1 ||
       lsof -nP -iTCP:"${HTTPS_PORT:-443}" -sTCP:LISTEN >/dev/null 2>&1; then
      deploy_log "edge port already has a listener; continuing for idempotent re-run"
    else
      deploy_log "edge ports are available"
    fi
  fi
  deploy_log "host checks passed (Docker, DNS, disk, edge ports)"
}

state_file_path() {
  printf '%s/%s' "$STATE_DIR" "$DEPLOY_STATE_NAME"
}

write_deploy_state() {
  local state_file temp_file
  state_file="$(state_file_path)"
  mkdir -p "$STATE_DIR"
  umask 077
  temp_file="$(mktemp "$STATE_DIR/.deploy-state.XXXXXX")"
  {
    printf 'MOMO_IMAGE_TAG=%s\n' "$MOMO_IMAGE_TAG"
    if [ -n "${MOMO_IMAGE:-}" ]; then
      printf 'MOMO_IMAGE=%s\n' "$MOMO_IMAGE"
    fi
    printf 'MOMO_API_IMAGE=%s\n' "$MOMO_API_IMAGE"
    printf 'MOMO_RELAY_IMAGE=%s\n' "$MOMO_RELAY_IMAGE"
    printf 'MOMO_WORKER_IMAGE=%s\n' "$MOMO_WORKER_IMAGE"
    printf 'MOMO_MIGRATE_IMAGE=%s\n' "$MOMO_MIGRATE_IMAGE"
    printf 'MOMO_WEB_IMAGE=%s\n' "$MOMO_WEB_IMAGE"
    printf 'MOMO_LINKSHORT_IMAGE=%s\n' "$MOMO_LINKSHORT_IMAGE"
  } > "$temp_file"
  chmod 600 "$temp_file"
  mv -f "$temp_file" "$state_file"
  deploy_log "recorded the immutable deployment image set in mode-0600 state"
}

read_state_value() {
  local state_file="$1"
  local key="$2"
  local value
  value="$(awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$state_file")"
  if [[ ! "$value" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]]; then
    deploy_fail "rollback state has an invalid or missing $key"
  fi
  printf '%s' "$value"
}

wait_service_running() {
  local service="$1"
  local _attempt
  for _attempt in $(seq 1 30); do
    if "${COMPOSE[@]}" ps --status running --services | grep -Fxq "$service"; then
      return 0
    fi
    sleep 2
  done
  deploy_log "service did not reach running state: $service"
  "${COMPOSE[@]}" ps "$service" >&2 || true
  return 1
}

wait_public_health() {
  local _attempt
  for _attempt in $(seq 1 45); do
    if curl --fail --silent --show-error --max-time 5 "https://${API_DOMAIN}/health" >/dev/null 2>&1; then
      deploy_log "public API health check passed"
      return 0
    fi
    sleep 2
  done
  deploy_log "public API health check failed; inspect caddy and api logs"
  "${COMPOSE[@]}" ps >&2 || true
  return 1
}

print_failure_diagnostics() {
  deploy_log "diagnostics: docker compose ps"
  "${COMPOSE[@]}" ps >&2 || true
  deploy_log "diagnostics: inspect redacted service logs locally; do not paste secrets"
  deploy_log "run: docker compose -f infra/prod/docker-compose.prod.yml logs --tail=200 caddy api migrate web-init linkshort relay worker"
}
