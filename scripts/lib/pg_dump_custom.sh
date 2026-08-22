#!/usr/bin/env bash
# Unique implementation of custom-format pg_dump / pg_restore for oort.
#
# Sourced by:
#   scripts/self_host_pg_dump.sh
#   scripts/self_host_pg_restore.sh
#   scripts/verify_backup_restore_rehearsal.sh
#   scripts/verify_self_host_pg_dump_restore.sh
#
# Do not add a second `pg_dump -Fc` / `pg_restore` call site. Operators and
# gates must go through these functions so the dump contract cannot drift.
#
# This file is sourced; callers already set -euo pipefail. Do not `exit` here.

momo_pg_dump_custom() {
  local container="$1"
  local user="$2"
  local db="$3"
  local outfile="$4"
  if [ "$#" -ne 4 ] || [ -z "$container" ] || [ -z "$user" ] || [ -z "$db" ] || [ -z "$outfile" ]; then
    echo "momo_pg_dump_custom: usage: container user db outfile" >&2
    return 2
  fi
  docker exec "$container" pg_dump -U "$user" -d "$db" -Fc >"$outfile"
  if [ ! -s "$outfile" ]; then
    echo "momo_pg_dump_custom: dump file is empty: $outfile" >&2
    return 1
  fi
}

momo_pg_restore_custom() {
  local container="$1"
  local user="$2"
  local db="$3"
  local infile="$4"
  if [ "$#" -lt 4 ] || [ -z "$container" ] || [ -z "$user" ] || [ -z "$db" ] || [ -z "$infile" ]; then
    echo "momo_pg_restore_custom: usage: container user db infile [pg_restore args...]" >&2
    return 2
  fi
  shift 4
  if [ ! -s "$infile" ]; then
    echo "momo_pg_restore_custom: dump file missing or empty: $infile" >&2
    return 1
  fi
  docker exec -i "$container" pg_restore -U "$user" -d "$db" --no-owner "$@" <"$infile"
}

# Read KEY=value from a Docker env file. Comments and blank lines are skipped.
# Prints the value only; callers must not log password-bearing keys.
momo_pg_env_get() {
  local file="$1" key="$2" line value
  [ -n "$file" ] && [ -n "$key" ] && [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | '#'*) continue ;;
    esac
    if [ "${line%%=*}" = "$key" ]; then
      value="${line#*=}"
      value="${value%$'\r'}"
      printf '%s\n' "$value"
      return 0
    fi
  done <"$file"
  return 1
}

# Resolve the running postgres container. Flags via globals set by callers:
#   MOMO_PG_CONTAINER, MOMO_PG_COMPOSE_PROJECT, MOMO_PG_ENV_FILE
momo_pg_resolve_postgres_container() {
  local container project ids count
  container="${MOMO_PG_CONTAINER:-}"
  if [ -n "$container" ]; then
    if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
      echo "momo_pg_resolve_postgres_container: not running: $container" >&2
      return 1
    fi
    printf '%s\n' "$container"
    return 0
  fi
  project="${MOMO_PG_COMPOSE_PROJECT:-}"
  if [ -z "$project" ] && [ -n "${MOMO_PG_ENV_FILE:-}" ] && [ -f "$MOMO_PG_ENV_FILE" ]; then
    project="$(momo_pg_env_get "$MOMO_PG_ENV_FILE" COMPOSE_PROJECT_NAME || true)"
  fi
  if [ -z "$project" ]; then
    echo "momo_pg_resolve_postgres_container: set --container, --compose-project, or --env-file with COMPOSE_PROJECT_NAME" >&2
    return 1
  fi
  ids="$(docker ps -q --filter "label=com.docker.compose.project=${project}" --filter "label=com.docker.compose.service=postgres")"
  count="$(printf '%s\n' "$ids" | awk 'NF { n++ } END { print n + 0 }')"
  if [ "$count" -ne 1 ]; then
    echo "momo_pg_resolve_postgres_container: expected 1 postgres container for project ${project}, found ${count}" >&2
    return 1
  fi
  printf '%s\n' "$ids"
}
