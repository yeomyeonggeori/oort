#!/usr/bin/env bash
# Ensure generated local runtime env files match the current Docker/runtime contract.
set -euo pipefail

env_file="${ENV_FILE:-.env.worktree}"
if [ -z "$env_file" ]; then
  env_file=".env.worktree"
fi

can_regenerate=0
case "${ENV_FILE:-}" in
  "")
    can_regenerate=1
    ;;
esac
case "$env_file" in
  .env.worktree|./.env.worktree)
    can_regenerate=1
    ;;
esac

required_keys="
COMPOSE_PROJECT_NAME
PORT
CENT_PORT
POSTGRES_PORT
HERMES_PORT
DATABASE_URL
CENT_TOKEN_HMAC
CENT_API_KEY
CENT_PROXY_SECRET
CENT_API_URL
JWT_HMAC
HERMES_BASE_URL
HERMES_API_KEY
"

centrifugo_config_digest() {
  local config_file="${1:-infra/centrifugo.json}"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$config_file" | awk '{ print $1 }'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$config_file" | awk '{ print $1 }'
  else
    echo "sha256 tool unavailable; install shasum or sha256sum" >&2
    return 1
  fi
}

centrifugo_container_digest() {
  local container_id="$1"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" \
    | sed -n 's/^MOMO_CENTRIFUGO_CONFIG_SHA256=//p' \
    | sed -n '1p'
}

centrifugo_container_id() {
  docker compose --env-file "$env_file" -f infra/docker-compose.yml ps -q centrifugo
}

validate_centrifugo_running_config() {
  local desired_digest container_id running_digest
  if ! command -v docker >/dev/null 2>&1; then
    echo "Centrifugo running-config check deferred: docker CLI unavailable"
    return 0
  fi
  if [ ! -f infra/centrifugo.json ] || [ ! -f infra/docker-compose.yml ]; then
    echo "Centrifugo running-config check requires repo infra files; run from the repo root" >&2
    return 1
  fi

  desired_digest="$(centrifugo_config_digest infra/centrifugo.json)"
  if ! container_id="$(centrifugo_container_id 2>/dev/null)"; then
    echo "failed to inspect the local compose Centrifugo service" >&2
    return 1
  fi
  if [ -z "$container_id" ]; then
    echo "Centrifugo running-config check deferred: no running compose container"
    return 0
  fi

  running_digest="$(centrifugo_container_digest "$container_id")"
  if [ "$running_digest" = "$desired_digest" ]; then
    echo "Centrifugo running-config ready: repo fingerprint ${desired_digest:0:16}"
    return 0
  fi

  if [ "${MOMO_CENTRIFUGO_AUTO_RECREATE:-0}" = "1" ]; then
    echo "Centrifugo running-config drift detected; recreating opted-in service"
    MOMO_CENTRIFUGO_CONFIG_SHA256="$desired_digest" \
      docker compose --env-file "$env_file" -f infra/docker-compose.yml \
      up -d --wait --force-recreate centrifugo
    container_id="$(centrifugo_container_id)"
    running_digest="$(centrifugo_container_digest "$container_id")"
    if [ "$running_digest" = "$desired_digest" ]; then
      echo "Centrifugo running-config recreated: repo fingerprint ${desired_digest:0:16}"
      return 0
    fi
    echo "Centrifugo recreate completed but running fingerprint still differs" >&2
    return 1
  fi

  cat >&2 <<EOF
Centrifugo running-config drift detected.
The running container was created from a different infra/centrifugo.json
fingerprint (or predates MOMO-353), so namespace/regex/proxy changes are not
proven active.

Fix (opt-in service recreate, PostgreSQL is not recreated):
  MOMO_CENTRIFUGO_AUTO_RECREATE=1 ENV_FILE=${env_file} bash scripts/ensure_runtime_env.sh

Values and secrets are not printed. The gate will not continue with stale
Centrifugo configuration.
EOF
  return 1
}

missing_keys() {
  local file="$1"
  local key value missing
  missing=""

  if [ ! -f "$file" ]; then
    printf '%s\n' "<missing-file:$file>"
    return 0
  fi

  for key in $required_keys; do
    value="$(
      awk -F= -v key="$key" '
        {
          line = $0
          sub(/^[[:space:]]*/, "", line)
          if (line == "" || line ~ /^#/) {
            next
          }
          sub(/^export[[:space:]]+/, "", line)
          lhs = line
          sub(/=.*/, "", lhs)
          gsub(/[[:space:]]/, "", lhs)
        }
        lhs == key {
          sub(/^[^=]*=/, "", line)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          print line
          found = 1
          exit
        }
      ' "$file"
    )"
    if [ -z "$value" ]; then
      missing="$missing $key"
    fi
  done

  printf '%s\n' "$missing" | sed 's/^ *//; s/ *$//'
}

env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (line == "" || line ~ /^#/) {
        next
      }
      sub(/^export[[:space:]]+/, "", line)
      lhs = line
      sub(/=.*/, "", lhs)
      gsub(/[[:space:]]/, "", lhs)
    }
    lhs == key {
      sub(/^[^=]*=/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      print line
      exit
    }
  ' "$file"
}

validate_safe_shell_env() {
  local file="$1"
  local unsafe

  unsafe="$(
    awk '
      {
        line = $0
        sub(/^[[:space:]]*/, "", line)
        if (line == "" || line ~ /^#/) {
          next
        }
        check = line
        sub(/^export[[:space:]]+/, "", check)
        if (check !~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) {
          print NR ": unsupported env syntax"
          next
        }
        value = check
        sub(/^[^=]*=/, "", value)
        if (value ~ /\$\(/ || value ~ /`/ || value ~ /\$\{/ || value ~ /[;&|<>]/) {
          print NR ": unsafe shell metacharacter in value"
        }
      }
    ' "$file"
  )"

  if [ -n "$unsafe" ]; then
    cat >&2 <<EOF
runtime env ${file} contains unsupported or unsafe shell syntax:
${unsafe}

Use simple KEY=value or export KEY=value lines only. Values are not printed here
because they may be secrets.
EOF
    exit 1
  fi
}

validate_local_database_url() {
  local file="$1"
  local database_url host
  database_url="$(env_value "$file" DATABASE_URL)"

  case "$database_url" in
    postgres://*@localhost:*/*|postgresql://*@localhost:*/*|postgres://localhost:*/*|postgresql://localhost:*/*|\
postgres://*@127.0.0.1:*/*|postgresql://*@127.0.0.1:*/*|postgres://127.0.0.1:*/*|postgresql://127.0.0.1:*/*|\
postgres://*@\[::1\]:*/*|postgresql://*@\[::1\]:*/*|postgres://\[::1\]:*/*|postgresql://\[::1\]:*/*)
      return 0
      ;;
  esac

  host="$(
    printf '%s' "$database_url" \
      | sed -nE 's#^[a-z]+://([^@/]+@)?([^/:]+|\[[^]]+\]).*#\2#p'
  )"
  cat >&2 <<EOF
runtime env ${file} DATABASE_URL must point at local Docker Postgres for local gates.
Detected host: ${host:-<unparseable>}

Refusing to run verifier SQL against a non-loopback database. For generated
local/worktree env, run: bash .conductor/setup.sh
EOF
  exit 1
}

missing="$(missing_keys "$env_file")"
if [ -n "$missing" ] && [ "$can_regenerate" -eq 1 ]; then
  echo "runtime env ${env_file} is missing required generated keys: ${missing}"
  echo "regenerating local worktree env via .conductor/setup.sh"
  if [ ! -f ".conductor/setup.sh" ]; then
    echo "missing .conductor/setup.sh; run from the repo root or provide a complete ENV_FILE" >&2
    exit 1
  fi
  bash .conductor/setup.sh
  env_file=".env.worktree"
  missing="$(missing_keys "$env_file")"
fi

if [ -n "$missing" ]; then
  cat >&2 <<EOF
runtime env ${env_file} is missing required keys: ${missing}

Fix:
  - For generated local/worktree env, run: bash .conductor/setup.sh
  - Or provide a complete ENV_FILE with CENT_TOKEN_HMAC, CENT_API_KEY,
    CENT_PROXY_SECRET, JWT_HMAC, ports, DATABASE_URL, and HERMES_* values.

Values are not printed here because they may be secrets.
EOF
  exit 1
fi

validate_safe_shell_env "$env_file"
validate_local_database_url "$env_file"
validate_centrifugo_running_config

echo "runtime env ready: ${env_file} (required keys present; values redacted; running config checked when present)"
