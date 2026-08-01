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
INVITE_SERVER_URL=""
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
  workspace-create               Create a workspace + initial owner (env-only)

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
  --server-url URL               API base URL embedded in the oort://join deep
                                 link (default: PUBLIC_BASE_URL from the env)

workspace-create environment (via --env-file or --from-env only):
  MOMO_OPS_WORKSPACE_NAME        Display name, 1..200 chars
  MOMO_OPS_WORKSPACE_SLUG        1..63 chars [a-z0-9-], no leading/trailing hyphen
  MOMO_OPS_OWNER_EMAIL           Initial owner login email
  MOMO_OPS_OWNER_PASSWORD        Initial owner password (never accepted as an arg)
  Re-running with an existing slug is refused (no partial workspace).

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

# A base URL that the macOS/iOS client can re-validate: a scheme, "://", and a
# non-empty host authority. Mirrors the client's validatedBaseURL() acceptance
# (scheme + host) so the deep link and the app agree on what is accepted.
valid_base_url() {
  [[ "$1" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#[:space:]]+ ]]
}

# RFC 3986 percent-encoding of a query-parameter value. Everything outside the
# unreserved set (ALPHA / DIGIT / "-" / "." / "_" / "~") is percent-encoded, so
# the ":" and "/" of the base URL survive transport and the client decodes the
# exact original value. Inputs here are ASCII (URLs and base64url invite codes).
percent_encode() {
  local raw="$1" out="" i char
  for (( i = 0; i < ${#raw}; i++ )); do
    char="${raw:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) out+="$char" ;;
      *) printf -v char '%%%02X' "'$char"; out+="$char" ;;
    esac
  done
  printf '%s' "$out"
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
      --server-url) INVITE_SERVER_URL="${2:-}"; shift 2 ;;
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
  if [ -n "$INVITE_SERVER_URL" ]; then
    valid_base_url "$INVITE_SERVER_URL" ||
      deploy_usage_fail "--server-url must be an absolute URL like https://api.example.com"
  fi

  prepare_compose 1

  # Resolve the API base URL for the deep link now that the operator env is
  # loaded: an explicit --server-url wins, otherwise the required prod contract
  # value PUBLIC_BASE_URL. Fail closed here — before reserving the output file or
  # creating the durable DB row — so a missing/invalid base URL never leaves a
  # created invite with no way to hand it to the new member.
  local server_url="${INVITE_SERVER_URL:-${PUBLIC_BASE_URL:-}}"
  [ -n "$server_url" ] ||
    deploy_fail "invite-create needs a base URL: pass --server-url or set PUBLIC_BASE_URL in the env"
  valid_base_url "$server_url" ||
    deploy_fail "resolved base URL is not an absolute URL (check PUBLIC_BASE_URL or --server-url)"

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

  # Build the operator delivery deep link while the code is still in scope, then
  # scrub the code from the environment. Contract (shared verbatim with the macOS
  # client, MOMO-585): oort://join?server=<percent-encoded base URL>&code=<code>.
  # goal B13: minted as oort:// since the rebrand; every client still accepts a
  # momo:// link so invites already sent keep working.
  # Unlike the bare code — which stays file-only and never reaches argv, stdout,
  # or the container — this link is what the operator hands to the new member so
  # the client prefills the server URL and code (the member types only
  # name/password). Emitting it on stdout is the whole point of this command, so
  # the code is intentionally present inside the link. It never touches the DB
  # path argv (the code travels to the container only via -e MOMO_OPS_INVITE_CODE).
  local deeplink
  deeplink="oort://join?server=$(percent_encode "$server_url")&code=$(percent_encode "$invite_code")"

  unset MOMO_OPS_INVITE_CODE
  invite_code=""
  deploy_log "invite created; the one-time code was written to a mode-0600 file: $INVITE_OUTPUT"
  deploy_log "share this deep link with the new member (the client prefills server URL and code):"
  printf '%s\n' "$deeplink"
}

run_workspace_create() {
  [ "${#POSITIONAL[@]}" -eq 0 ] ||
    deploy_usage_fail "workspace-create does not accept positional arguments"

  # All four inputs arrive only through the operator env source (--env-file or
  # --from-env). The password is never accepted as an argument (ADR-0004).
  # Source the env and fail closed BEFORE any Docker/preflight side effect.
  case "$DEPLOY_MODE" in
    staging|prod|production) ;;
    *) deploy_usage_fail "--mode must be staging, prod, or production" ;;
  esac
  configure_env_source
  load_deploy_env

  [ -n "${MOMO_OPS_WORKSPACE_NAME:-}" ] ||
    deploy_fail "workspace-create requires MOMO_OPS_WORKSPACE_NAME in the environment"
  [ -n "${MOMO_OPS_WORKSPACE_SLUG:-}" ] ||
    deploy_fail "workspace-create requires MOMO_OPS_WORKSPACE_SLUG in the environment"
  [ -n "${MOMO_OPS_OWNER_EMAIL:-}" ] ||
    deploy_fail "workspace-create requires MOMO_OPS_OWNER_EMAIL in the environment"
  [ -n "${MOMO_OPS_OWNER_PASSWORD:-}" ] ||
    deploy_fail "workspace-create requires MOMO_OPS_OWNER_PASSWORD in the environment"

  # Fail closed on obvious shell-layer violations before touching the database.
  # The SQL re-validates authoritatively.
  [ "${#MOMO_OPS_WORKSPACE_NAME}" -le 200 ] ||
    deploy_fail "MOMO_OPS_WORKSPACE_NAME must be at most 200 characters"
  [[ "$MOMO_OPS_WORKSPACE_SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
    deploy_fail "MOMO_OPS_WORKSPACE_SLUG must be 1..63 chars of lowercase letters, digits, or hyphens (no leading/trailing hyphen)"
  case "$MOMO_OPS_OWNER_EMAIL" in
    *@*) ;;
    *) deploy_fail "MOMO_OPS_OWNER_EMAIL must be a valid email address" ;;
  esac
  case "$MOMO_OPS_WORKSPACE_SLUG:$MOMO_OPS_OWNER_EMAIL:$MOMO_OPS_OWNER_PASSWORD" in
    *change-me*|*__BASE_DOMAIN__*|*__INITIAL_OWNER_PASSWORD__*|*example.com*)
      deploy_fail "workspace-create inputs must replace template placeholders" ;;
  esac

  # Inputs are valid — now run the strict preflight and render the compose
  # contract before dispatching the one-shot workspace-create through migrate.
  run_prod_preflight
  configure_compose
  render_compose_contract

  export MOMO_OPS_WORKSPACE_NAME
  export MOMO_OPS_WORKSPACE_SLUG
  export MOMO_OPS_OWNER_EMAIL
  export MOMO_OPS_OWNER_PASSWORD

  deploy_log "creating workspace '$MOMO_OPS_WORKSPACE_SLUG' with its initial owner (credentials redacted)"
  "${COMPOSE[@]}" run --rm --no-deps \
    -e MOMO_OPS_WORKSPACE_NAME \
    -e MOMO_OPS_WORKSPACE_SLUG \
    -e MOMO_OPS_OWNER_EMAIL \
    -e MOMO_OPS_OWNER_PASSWORD \
    migrate workspace-create
}

case "$ACTION" in
  help|-h|--help)
    usage
    ;;
  upgrade)
    exec "$SCRIPT_DIR/upgrade.sh" "$@"
    ;;
  status|logs|backup-hint|member|invite-create|workspace-create)
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
      workspace-create) run_workspace_create ;;
    esac
    ;;
  *)
    usage >&2
    deploy_usage_fail "unknown command: $ACTION"
    ;;
esac
