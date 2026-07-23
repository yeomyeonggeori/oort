#!/usr/bin/env bash
# Day-2 operator entrypoint for the single-node production compose stack.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/prod/deploy-lib.sh
. "$SCRIPT_DIR/deploy-lib.sh"

ACTION="${1:-}"
[ -n "$ACTION" ] || ACTION="help"
[ "$#" -eq 0 ] || shift

# These globals are the interface consumed by sourced deploy-lib.sh helpers.
# shellcheck disable=SC2034
ENV_FILE=""
# shellcheck disable=SC2034
FROM_ENV=0
DEPLOY_MODE="prod"
# shellcheck disable=SC2034
EVIDENCE_DIR=""
TAIL_LINES=200
WORKSPACE_ID=""
CREATED_BY=""
INVITE_ROLE="member"
INVITE_MAX_USES=1
INVITE_EXPIRES_DAYS=7
INVITE_OUTPUT=""
POSITIONAL=()

usage() {
  cat <<'EOF'
Usage: infra/prod/momo-ops.sh COMMAND (--env-file FILE | --from-env) [options]

Commands:
  status                         Show compose service state (placeholder-safe)
  logs [SERVICE ...]             Show redacted-local service logs
  upgrade [upgrade.sh options]   Run the guarded install/upgrade pipeline
  backup-hint                    Print backup/PITR and upgrade evidence hints
  member list --workspace-id ID  List active workspace members via migrate image
  invite-create --workspace-id ID --output FILE
                                 Create an invite; raw code goes only to FILE

Common options:
  --env-file FILE                Host-local environment file
  --from-env                     Read values from the process environment
  --mode staging|prod            Strict preflight mode (default: prod)
  --evidence-dir DIR             Write redacted preflight evidence

logs options:
  --tail N                       Lines per service (default: 200)

invite-create options:
  --created-by MEMBER_ID         Active owner/admin actor (default: oldest owner)
  --role admin|member|guest      Granted workspace role (default: member)
  --max-uses N                   Redemption limit, 1..10000 (default: 1)
  --expires-days N               Expiry, 1..365 days (default: 7)
  --output FILE                  New mode-0600 file for the one-time raw code

For SOPS:
  sops exec-env infra/prod/secrets.sops.env \
    'infra/prod/momo-ops.sh status --from-env'

Only status may inspect a template/placeholder environment. Every other command
reuses prod_env_preflight.sh and fails closed before Docker or database changes.
Passwords and database URLs are never accepted as command arguments or printed.
EOF
}

valid_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
}

parse_common_and_action_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file) ENV_FILE="${2:-}"; shift 2 ;;
      --from-env) FROM_ENV=1; shift ;;
      --mode) DEPLOY_MODE="${2:-}"; shift 2 ;;
      --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
      --tail) TAIL_LINES="${2:-}"; shift 2 ;;
      --workspace-id) WORKSPACE_ID="${2:-}"; shift 2 ;;
      --created-by) CREATED_BY="${2:-}"; shift 2 ;;
      --role) INVITE_ROLE="${2:-}"; shift 2 ;;
      --max-uses) INVITE_MAX_USES="${2:-}"; shift 2 ;;
      --expires-days) INVITE_EXPIRES_DAYS="${2:-}"; shift 2 ;;
      --output) INVITE_OUTPUT="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      --) shift; POSITIONAL+=("$@"); break ;;
      -*) deploy_usage_fail "unknown option for $ACTION: $1" ;;
      *) POSITIONAL+=("$1"); shift ;;
    esac
  done
}

prepare_compose() {
  local require_preflight="$1"
  case "$DEPLOY_MODE" in
    staging|prod|production) ;;
    *) deploy_usage_fail "--mode must be staging, prod, or production" ;;
  esac
  configure_env_source
  if [ "$require_preflight" = "1" ]; then
    run_prod_preflight
  fi
  load_deploy_env
  configure_compose
  if [ "$require_preflight" = "1" ]; then
    render_compose_contract
  fi
}

run_member_list() {
  [ "${POSITIONAL[*]:-}" = "list" ] ||
    deploy_usage_fail "member supports exactly: member list"
  valid_uuid "$WORKSPACE_ID" ||
    deploy_usage_fail "member list requires --workspace-id UUID"
  prepare_compose 1
  export MOMO_OPS_WORKSPACE_ID="$WORKSPACE_ID"
  deploy_log "listing members for workspace $WORKSPACE_ID"
  "${COMPOSE[@]}" run --rm --no-deps \
    -e MOMO_OPS_WORKSPACE_ID migrate member-list
}

run_invite_create() {
  [ "${#POSITIONAL[@]}" -eq 0 ] ||
    deploy_usage_fail "invite-create does not accept positional arguments"
  valid_uuid "$WORKSPACE_ID" ||
    deploy_usage_fail "invite-create requires --workspace-id UUID"
  if [ -n "$CREATED_BY" ]; then
    valid_uuid "$CREATED_BY" || deploy_usage_fail "--created-by must be a UUID"
  fi
  case "$INVITE_ROLE" in admin|member|guest) ;; *)
    deploy_usage_fail "--role must be admin, member, or guest" ;;
  esac
  [[ "$INVITE_MAX_USES" =~ ^[0-9]+$ ]] &&
    [ "$INVITE_MAX_USES" -ge 1 ] && [ "$INVITE_MAX_USES" -le 10000 ] ||
    deploy_usage_fail "--max-uses must be an integer from 1 through 10000"
  [[ "$INVITE_EXPIRES_DAYS" =~ ^[0-9]+$ ]] &&
    [ "$INVITE_EXPIRES_DAYS" -ge 1 ] && [ "$INVITE_EXPIRES_DAYS" -le 365 ] ||
    deploy_usage_fail "--expires-days must be an integer from 1 through 365"
  [ -n "$INVITE_OUTPUT" ] || deploy_usage_fail "invite-create requires --output FILE"
  [ ! -e "$INVITE_OUTPUT" ] || deploy_fail "refusing to overwrite invite output: $INVITE_OUTPUT"
  [ -d "$(dirname -- "$INVITE_OUTPUT")" ] ||
    deploy_fail "invite output parent directory does not exist"

  prepare_compose 1
  command -v openssl >/dev/null 2>&1 || deploy_fail "openssl is required to generate an invite"

  local invite_code temp_output
  invite_code="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  [ "${#invite_code}" -ge 32 ] || deploy_fail "secure invite generation failed"

  # Prove the host destination is writable and reserve it atomically before
  # creating the durable DB row. A failed DB command removes only this file.
  umask 077
  temp_output="$(mktemp "$(dirname -- "$INVITE_OUTPUT")/.momo-invite.XXXXXX")"
  printf '%s\n' "$invite_code" > "$temp_output"
  chmod 600 "$temp_output"
  if ! ln "$temp_output" "$INVITE_OUTPUT"; then
    rm -f -- "$temp_output"
    deploy_fail "could not reserve new invite output without overwrite"
  fi
  rm -f -- "$temp_output"

  export MOMO_OPS_WORKSPACE_ID="$WORKSPACE_ID"
  export MOMO_OPS_CREATED_BY="$CREATED_BY"
  export MOMO_OPS_INVITE_ROLE="$INVITE_ROLE"
  export MOMO_OPS_INVITE_MAX_USES="$INVITE_MAX_USES"
  export MOMO_OPS_INVITE_EXPIRES_DAYS="$INVITE_EXPIRES_DAYS"
  export MOMO_OPS_INVITE_CODE="$invite_code"

  deploy_log "creating a one-time invite through the migration-owner database path"
  if ! "${COMPOSE[@]}" run --rm --no-deps \
      -e MOMO_OPS_WORKSPACE_ID \
      -e MOMO_OPS_CREATED_BY \
      -e MOMO_OPS_INVITE_ROLE \
      -e MOMO_OPS_INVITE_MAX_USES \
      -e MOMO_OPS_INVITE_EXPIRES_DAYS \
      -e MOMO_OPS_INVITE_CODE \
      migrate invite-create; then
    rm -f -- "$INVITE_OUTPUT"
    unset MOMO_OPS_INVITE_CODE
    invite_code=""
    deploy_fail "invite creation failed; reserved output was removed"
  fi

  unset MOMO_OPS_INVITE_CODE
  invite_code=""
  deploy_log "invite created; the one-time code was written to a mode-0600 file: $INVITE_OUTPUT"
}

case "$ACTION" in
  help|-h|--help)
    usage
    ;;
  upgrade)
    exec "$SCRIPT_DIR/upgrade.sh" "$@"
    ;;
  status|logs|backup-hint|member|invite-create)
    parse_common_and_action_options "$@"
    case "$ACTION" in
      status)
        [ "${#POSITIONAL[@]}" -eq 0 ] || deploy_usage_fail "status does not accept positional arguments"
        prepare_compose 0
        deploy_log "status is read-only and intentionally skips placeholder preflight"
        "${COMPOSE[@]}" ps
        ;;
      logs)
        [[ "$TAIL_LINES" =~ ^[0-9]+$ ]] && [ "$TAIL_LINES" -ge 1 ] && [ "$TAIL_LINES" -le 10000 ] ||
          deploy_usage_fail "--tail must be an integer from 1 through 10000"
        prepare_compose 1
        if [ "${#POSITIONAL[@]}" -eq 0 ]; then
          POSITIONAL=(caddy api relay worker linkshort migrate)
        fi
        for service in "${POSITIONAL[@]}"; do
          [[ "$service" =~ ^[a-z0-9][a-z0-9-]*$ ]] ||
            deploy_usage_fail "invalid compose service name: $service"
        done
        "${COMPOSE[@]}" logs --tail "$TAIL_LINES" "${POSITIONAL[@]}"
        ;;
      backup-hint)
        [ "${#POSITIONAL[@]}" -eq 0 ] || deploy_usage_fail "backup-hint does not accept positional arguments"
        prepare_compose 1
        cat <<'EOF'
[momo-deploy] Backup/PITR checklist:
  1. pgbackrest --stanza=momo check
  2. pgbackrest --stanza=momo --type=full backup
  3. perform a time-target PITR restore rehearsal on a non-primary target
  4. record redacted evidence containing `Result: PASS`
  5. pass that file to: momo-ops.sh upgrade ... --backup-evidence FILE
See docs/SECRETS_BACKUP_RUNBOOK.md and docs/DEPLOY.md §7.
EOF
        ;;
      member) run_member_list ;;
      invite-create) run_invite_create ;;
    esac
    ;;
  *)
    usage >&2
    deploy_usage_fail "unknown command: $ACTION"
    ;;
esac
