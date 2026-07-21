#!/usr/bin/env bash
# Install/reconcile the single-node momo production compose stack.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/prod/deploy-lib.sh
. "$SCRIPT_DIR/deploy-lib.sh"

ENV_FILE=""
FROM_ENV=0
DEPLOY_MODE="prod"
STATE_DIR="${MOMO_STATE_DIR:-/var/lib/momo}"
EVIDENCE_DIR=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: infra/prod/install.sh (--env-file FILE | --from-env) [options]

Options:
  --mode staging|prod       Strict preflight mode (default: prod)
  --state-dir DIR           Host-local image state (default: /var/lib/momo)
  --evidence-dir DIR        Write redacted preflight evidence
  --dry-run                 Validate env/digests/compose and print the plan only
  -h, --help                Show this help

For SOPS, use: sops exec-env secrets.sops.env 'infra/prod/install.sh --from-env ...'
The script is non-interactive, safe to re-run, and never prints secret values.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --from-env) FROM_ENV=1; shift ;;
    --mode) DEPLOY_MODE="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
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

if [ "$DRY_RUN" = "1" ]; then
  deploy_log "DRY RUN plan: pull five pinned images -> start postgres/redis/centrifugo -> run migrate and web-init once -> start api/relay/worker/caddy -> check health -> record rollback state"
  deploy_log "DRY RUN complete; no containers or state were changed"
  exit 0
fi

check_host_contract
deploy_log "pulling pinned production images"
"${COMPOSE[@]}" pull || { print_failure_diagnostics; exit 1; }

deploy_log "starting stateful dependencies"
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 postgres redis centrifugo || { print_failure_diagnostics; exit 1; }

deploy_log "running the pinned migration image once"
"${COMPOSE[@]}" run --rm --no-deps migrate || { print_failure_diagnostics; exit 1; }

deploy_log "installing the pinned web assets"
"${COMPOSE[@]}" run --rm --no-deps web-init || { print_failure_diagnostics; exit 1; }

for service in api relay worker caddy; do
  deploy_log "starting $service"
  "${COMPOSE[@]}" up -d --no-deps "$service" || { print_failure_diagnostics; exit 1; }
  wait_service_running "$service" || { print_failure_diagnostics; exit 1; }
done

wait_public_health || { print_failure_diagnostics; exit 1; }
write_deploy_state
deploy_log "install complete; TLS, backup/PITR, and external Hermes still require host evidence"
# ADR-0120 P-3 / ADR-0121 S-5 placeholder: optional Dawn relay registration
# belongs here later. Its failure must never make an otherwise healthy install fail.
# ADR-0125 D2 placeholder: a future `--with-workd` option will invoke the
# infra/workd bootstrap/install contract after the server is healthy. MOMO-488
# reserves the hook only; production binary distribution is not enabled here.
