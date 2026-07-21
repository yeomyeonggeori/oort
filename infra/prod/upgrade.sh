#!/usr/bin/env bash
# Upgrade pinned momo app images with forward-only migrations and app rollback.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/prod/deploy-lib.sh
. "$SCRIPT_DIR/deploy-lib.sh"

ENV_FILE=""
FROM_ENV=0
DEPLOY_MODE="prod"
STATE_DIR="${MOMO_STATE_DIR:-/var/lib/momo}"
EVIDENCE_DIR=""
BACKUP_EVIDENCE=""
ROLLBACK_STATE=""
DRY_RUN=0
ROLLBACK_ONLY=0

usage() {
  cat <<'EOF'
Usage: infra/prod/upgrade.sh (--env-file FILE | --from-env) [options]

Options:
  --backup-evidence FILE    Required PASS evidence for a real upgrade
  --mode staging|prod       Strict preflight mode (default: prod)
  --state-dir DIR           Host-local image state (default: /var/lib/momo)
  --evidence-dir DIR        Write redacted preflight evidence
  --dry-run                 Validate and print upgrade/rollback plans only
  --rollback-only           Restore app images from deploy-state.env.previous
  --rollback-state FILE     Override the state used by --rollback-only
  -h, --help                Show this help

Migrations are forward-only. Automatic/manual rollback restores api/relay/worker
images only; it never reverses database migrations. The script prints no secrets.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --from-env) FROM_ENV=1; shift ;;
    --mode) DEPLOY_MODE="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
    --backup-evidence) BACKUP_EVIDENCE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback-only) ROLLBACK_ONLY=1; shift ;;
    --rollback-state) ROLLBACK_STATE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; deploy_usage_fail "unknown argument: $1" ;;
  esac
done

case "$DEPLOY_MODE" in staging|prod|production) ;; *) deploy_usage_fail "--mode must be staging, prod, or production" ;; esac
configure_env_source
run_prod_preflight
load_deploy_env
validate_momo_image_digests
configure_compose
render_compose_contract

CURRENT_STATE="$(state_file_path)"
if [ "$ROLLBACK_ONLY" = "1" ]; then
  ROLLBACK_STATE="${ROLLBACK_STATE:-${CURRENT_STATE}.previous}"
  require_file "$ROLLBACK_STATE"
else
  require_file "$CURRENT_STATE"
  if [ "$DRY_RUN" != "1" ]; then
    require_file "$BACKUP_EVIDENCE"
    grep -Eq '(^|["[:space:]])(Result:|result["[:space:]]*:)["`[:space:]]*PASS' "$BACKUP_EVIDENCE" ||
      deploy_fail "backup evidence must contain a PASS result"
    deploy_log "accepted pre-upgrade backup PASS evidence"
  fi
fi

STATE_TO_READ="$CURRENT_STATE"
[ "$ROLLBACK_ONLY" = "1" ] && STATE_TO_READ="$ROLLBACK_STATE"
OLD_API="$(read_state_value "$STATE_TO_READ" MOMO_API_IMAGE)"
OLD_RELAY="$(read_state_value "$STATE_TO_READ" MOMO_RELAY_IMAGE)"
OLD_WORKER="$(read_state_value "$STATE_TO_READ" MOMO_WORKER_IMAGE)"
OLD_WEB="$(read_state_value "$STATE_TO_READ" MOMO_WEB_IMAGE)"

rollback_apps() {
  deploy_log "ROLLBACK: restoring previous api/relay/worker/web image digests"
  deploy_log "ROLLBACK: database migrations remain forward-only; stop for operator review if an old image is not forward-compatible"
  MOMO_API_IMAGE="$OLD_API" MOMO_RELAY_IMAGE="$OLD_RELAY" MOMO_WORKER_IMAGE="$OLD_WORKER" \
    "${COMPOSE[@]}" up -d --no-deps --force-recreate api || return 1
  MOMO_API_IMAGE="$OLD_API" MOMO_RELAY_IMAGE="$OLD_RELAY" MOMO_WORKER_IMAGE="$OLD_WORKER" \
    "${COMPOSE[@]}" up -d --no-deps --force-recreate relay || return 1
  MOMO_API_IMAGE="$OLD_API" MOMO_RELAY_IMAGE="$OLD_RELAY" MOMO_WORKER_IMAGE="$OLD_WORKER" \
    "${COMPOSE[@]}" up -d --no-deps --force-recreate worker || return 1
  MOMO_WEB_IMAGE="$OLD_WEB" "${COMPOSE[@]}" run --rm --no-deps web-init || return 1
  "${COMPOSE[@]}" up -d --no-deps --force-recreate caddy || return 1
  wait_service_running api && wait_service_running relay && wait_service_running worker && wait_service_running caddy
}

if [ "$DRY_RUN" = "1" ]; then
  if [ "$ROLLBACK_ONLY" = "1" ]; then
    deploy_log "DRY RUN rollback plan: restore previous api/relay/worker/web digests; do not reverse migrations; verify health"
  else
    deploy_log "DRY RUN upgrade plan: preserve current image state -> pull new digests -> run forward migration and web-init -> restart api/relay/worker/caddy -> health check"
    deploy_log "DRY RUN failure plan: automatically restore previous api/relay/worker/web digests; database remains forward-only"
  fi
  deploy_log "DRY RUN complete; no containers or state were changed"
  exit 0
fi

check_host_contract
if [ "$ROLLBACK_ONLY" = "1" ]; then
  rollback_apps || { print_failure_diagnostics; deploy_fail "manual app rollback failed; operator intervention required"; }
  wait_public_health || { print_failure_diagnostics; deploy_fail "manual app rollback health check failed; operator intervention required"; }
  cp "$ROLLBACK_STATE" "$CURRENT_STATE"
  chmod 600 "$CURRENT_STATE"
  deploy_log "manual app rollback complete; database migration state was not changed"
  exit 0
fi

# review #429 L4: a re-run with the SAME image set must not overwrite the
# rollback target (that would erase the real previous set).
if [ -f "$CURRENT_STATE" ] \
  && grep -Fq "MOMO_API_IMAGE=$MOMO_API_IMAGE" "$CURRENT_STATE" \
  && grep -Fq "MOMO_RELAY_IMAGE=$MOMO_RELAY_IMAGE" "$CURRENT_STATE" \
  && grep -Fq "MOMO_WORKER_IMAGE=$MOMO_WORKER_IMAGE" "$CURRENT_STATE" \
  && grep -Fq "MOMO_WEB_IMAGE=$MOMO_WEB_IMAGE" "$CURRENT_STATE"; then
  deploy_log "requested image set matches the current deploy state; keeping the existing rollback target"
else
cp "$CURRENT_STATE" "${CURRENT_STATE}.previous"
chmod 600 "${CURRENT_STATE}.previous"
fi
deploy_log "preserved the current image set for rollback"

upgrade_failed=0
deploy_log "pulling new pinned images"
"${COMPOSE[@]}" pull api relay worker migrate web-init || upgrade_failed=1
if [ "$upgrade_failed" = "0" ]; then
  deploy_log "running forward-only migrations before app restart"
  "${COMPOSE[@]}" run --rm --no-deps migrate || upgrade_failed=1
fi
if [ "$upgrade_failed" = "0" ]; then
  deploy_log "installing the new pinned web assets"
  "${COMPOSE[@]}" run --rm --no-deps web-init || upgrade_failed=1
fi
if [ "$upgrade_failed" = "0" ]; then
  for service in api relay worker; do
    deploy_log "restarting $service with the new digest"
    "${COMPOSE[@]}" up -d --no-deps --force-recreate "$service" || { upgrade_failed=1; break; }
    wait_service_running "$service" || { upgrade_failed=1; break; }
  done
fi
if [ "$upgrade_failed" = "0" ]; then
  deploy_log "restarting caddy after the web asset swap"
  "${COMPOSE[@]}" up -d --no-deps --force-recreate caddy || upgrade_failed=1
  wait_service_running caddy || upgrade_failed=1
fi
if [ "$upgrade_failed" = "0" ]; then
  wait_public_health || upgrade_failed=1
fi

if [ "$upgrade_failed" != "0" ]; then
  print_failure_diagnostics
  rollback_apps || deploy_fail "upgrade and automatic app rollback failed; operator intervention required"
  wait_public_health || deploy_fail "previous app images were restored but health still fails; operator intervention required"
  deploy_fail "upgrade failed; previous app images restored, database migrations remain forward-only"
fi

write_deploy_state
deploy_log "upgrade complete; previous app image state is retained at deploy-state.env.previous"
