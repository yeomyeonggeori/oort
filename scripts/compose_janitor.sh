#!/usr/bin/env bash
# List and optionally remove stale Docker Compose resources from momo worktrees.
set -euo pipefail

WORKTREE_ROOT="${WORKTREE_ROOT:-}"
MODE="dry-run"
VERBOSE=0

usage() {
  cat <<'EOF'
Usage: scripts/compose_janitor.sh [--dry-run] [--cleanup] [--worktree-root DIR] [--verbose]

Lists stale Docker Compose projects/containers/networks created by momo worktree
local gates. The default is dry-run. Resources are removed only with --cleanup.

Safety rules:
  - Only Compose-labeled projects whose name starts with momo_ or momo240_ are candidates.
  - Active git worktree projects are protected.
  - Project momo, network momo_default, project supabase, and non-momo resources
    are protected.
  - Volumes are not removed by this janitor.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    --cleanup)
      MODE="cleanup"
      shift
      ;;
    --worktree-root)
      WORKTREE_ROOT="${2:-}"
      shift 2
      ;;
    --verbose)
      VERBOSE=1
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

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need docker
need git

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [ -z "$WORKTREE_ROOT" ]; then
  repo_parent="$(cd "$repo_root/.." && pwd)"
  if [ "$(basename "$repo_parent")" = "momo-worktrees" ]; then
    WORKTREE_ROOT="$repo_parent"
  else
    WORKTREE_ROOT="$repo_parent/momo-worktrees"
  fi
fi

tmp_dir="$(mktemp -d)"
cleanup_tmp() {
  rm -rf "$tmp_dir"
}
trap cleanup_tmp EXIT

active_projects_file="$tmp_dir/active-projects.txt"
containers_file="$tmp_dir/containers.tsv"
networks_file="$tmp_dir/networks.tsv"
stale_projects_file="$tmp_dir/stale-projects.txt"
protected_file="$tmp_dir/protected.tsv"
stale_containers_file="$tmp_dir/stale-containers.tsv"
stale_networks_file="$tmp_dir/stale-networks.tsv"

: > "$active_projects_file"
: > "$containers_file"
: > "$networks_file"
: > "$stale_projects_file"
: > "$protected_file"
: > "$stale_containers_file"
: > "$stale_networks_file"

safe_project_from_branch() {
  local branch="$1"
  local safe_name

  safe_name="$(
    printf '%s' "$branch" |
      tr '[:upper:]' '[:lower:]' |
      sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
  )"
  if [ -n "$safe_name" ]; then
    printf 'momo_%s\n' "$safe_name"
  fi
}

project_from_env_file() {
  local env_file="$1"
  awk -F '=' '
    $1 == "COMPOSE_PROJECT_NAME" {
      value = $0
      sub(/^COMPOSE_PROJECT_NAME=/, "", value)
      gsub(/^"|"$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      print value
      exit
    }
  ' "$env_file"
}

git worktree list --porcelain |
  awk '
    function flush() {
      if (path != "") {
        print path "\t" branch
      }
      path = ""
      branch = ""
    }
    /^worktree / {
      flush()
      path = substr($0, 10)
      next
    }
    /^branch / {
      branch = $2
      sub(/^refs\/heads\//, "", branch)
      next
    }
    /^detached$/ {
      branch = ""
      next
    }
    END { flush() }
  ' |
  while IFS=$'\t' read -r path branch; do
    [ -d "$path" ] || continue
    if [ -f "$path/.env.worktree" ]; then
      project="$(project_from_env_file "$path/.env.worktree" || true)"
      if [ -n "$project" ]; then
        printf '%s\n' "$project"
        continue
      fi
    fi
    if [ -n "$branch" ]; then
      safe_project_from_branch "$branch"
    fi
  done |
  sort -u > "$active_projects_file"

container_ids="$(docker container ls -aq --filter label=com.docker.compose.project 2>/dev/null || true)"
if [ -n "$container_ids" ]; then
  for id in $container_ids; do
    docker container inspect "$id" \
      --format '{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{"\t"}}{{.State.Status}}' |
      awk -F '\t' 'BEGIN { OFS = "\t" } { sub("^/", "", $2); print }'
  done > "$containers_file"
fi

network_ids="$(docker network ls -q --filter label=com.docker.compose.project 2>/dev/null || true)"
if [ -n "$network_ids" ]; then
  for id in $network_ids; do
    docker network inspect "$id" \
      --format '{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{index .Labels "com.docker.compose.project"}}'
  done > "$networks_file"
fi

is_active_project() {
  local project="$1"
  grep -Fxq "$project" "$active_projects_file"
}

is_candidate_project() {
  local project="$1"
  case "$project" in
    momo_*|momo240_*)
      is_active_project "$project" && return 1
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

protect_reason_for_project() {
  local project="$1"
  local name="${2:-}"

  if [ "$name" = "momo_default" ]; then
    printf 'protected:momo_default\n'
    return 0
  fi

  case "$project" in
    "")
      printf 'protected:non-momo\n'
      ;;
    momo)
      printf 'protected:root-momo-project\n'
      ;;
    supabase|supabase_*)
      printf 'protected:supabase\n'
      ;;
    momo_*|momo240_*)
      if is_active_project "$project"; then
        printf 'protected:active-worktree\n'
      else
        printf 'candidate\n'
      fi
      ;;
    *)
      printf 'protected:non-momo\n'
      ;;
  esac
}

collect_project() {
  local project="$1"
  if [ -n "$project" ] && is_candidate_project "$project"; then
    printf '%s\n' "$project" >> "$stale_projects_file"
  fi
}

while IFS=$'\t' read -r id name project working_dir status; do
  [ -n "${id:-}" ] || continue
  reason="$(protect_reason_for_project "$project" "$name")"
  if [ "$reason" = "candidate" ]; then
    printf '%s\t%s\t%s\t%s\t%s\n' "$project" "$id" "$name" "$status" "${working_dir:-}" >> "$stale_containers_file"
    collect_project "$project"
  else
    printf 'container\t%s\t%s\t%s\t%s\n' "$project" "$name" "$id" "$reason" >> "$protected_file"
  fi
done < "$containers_file"

while IFS=$'\t' read -r id name project; do
  [ -n "${id:-}" ] || continue
  reason="$(protect_reason_for_project "$project" "$name")"
  if [ "$reason" = "candidate" ]; then
    printf '%s\t%s\t%s\n' "$project" "$id" "$name" >> "$stale_networks_file"
    collect_project "$project"
  else
    printf 'network\t%s\t%s\t%s\t%s\n' "$project" "$name" "$id" "$reason" >> "$protected_file"
  fi
done < "$networks_file"

sort -u "$stale_projects_file" -o "$stale_projects_file"

echo "momo compose janitor"
echo "mode: $MODE"
echo "worktree root: $WORKTREE_ROOT"
echo "active worktree projects:"
if [ -s "$active_projects_file" ]; then
  sed 's/^/- /' "$active_projects_file"
else
  echo "- (none detected)"
fi
echo
echo "protected by policy: project=momo, network=momo_default, project=supabase, non-momo Compose resources, and active worktree projects."

echo
echo "Stale momo worktree Compose projects"
if [ -s "$stale_projects_file" ]; then
  while IFS= read -r project; do
    container_count="$(awk -F '\t' -v project="$project" '$1 == project { count++ } END { print count + 0 }' "$stale_containers_file")"
    network_count="$(awk -F '\t' -v project="$project" '$1 == project { count++ } END { print count + 0 }' "$stale_networks_file")"
    printf -- '- %s containers=%s networks=%s reason=no-active-git-worktree\n' "$project" "$container_count" "$network_count"
  done < "$stale_projects_file"
else
  echo "- (none)"
fi

echo
echo "Stale containers"
if [ -s "$stale_containers_file" ]; then
  {
    printf 'project\tcontainer\tid\tstatus\tworking_dir\n'
    awk -F '\t' '{ printf "%s\t%s\t%s\t%s\t%s\n", $1, $3, substr($2, 1, 12), $4, ($5 == "" ? "-" : $5) }' "$stale_containers_file"
  } | if command -v column >/dev/null 2>&1; then column -t -s $'\t'; else cat; fi
else
  echo "(none)"
fi

echo
echo "Stale networks"
if [ -s "$stale_networks_file" ]; then
  {
    printf 'project\tnetwork\tid\n'
    awk -F '\t' '{ printf "%s\t%s\t%s\n", $1, $3, substr($2, 1, 12) }' "$stale_networks_file"
  } | if command -v column >/dev/null 2>&1; then column -t -s $'\t'; else cat; fi
else
  echo "(none)"
fi

if [ "$VERBOSE" -eq 1 ]; then
  echo
  echo "Protected resources"
  if [ -s "$protected_file" ]; then
    {
      printf 'kind\tproject\tname\tid\treason\n'
      awk -F '\t' '{ printf "%s\t%s\t%s\t%s\t%s\n", $1, ($2 == "" ? "-" : $2), $3, substr($4, 1, 12), $5 }' "$protected_file"
    } | if command -v column >/dev/null 2>&1; then column -t -s $'\t'; else cat; fi
  else
    echo "(none)"
  fi
fi

if [ ! -s "$stale_containers_file" ] && [ ! -s "$stale_networks_file" ]; then
  echo
  echo "No cleanup needed."
  exit 0
fi

echo
if [ "$MODE" = "dry-run" ]; then
  echo "Dry-run only. Re-run with --cleanup to remove the stale containers and networks listed above."
  echo "Volumes are intentionally left untouched."
  exit 0
fi

echo "Cleanup requested. Removing stale containers first, then stale networks."
cleanup_failed=0
while IFS=$'\t' read -r project id name status working_dir; do
  [ -n "${id:-}" ] || continue
  echo "removing container $name ($id) project=$project"
  docker container rm -f "$id" || cleanup_failed=1
done < "$stale_containers_file"

while IFS=$'\t' read -r project id name; do
  [ -n "${id:-}" ] || continue
  echo "removing network $name ($id) project=$project"
  docker network rm "$id" || cleanup_failed=1
done < "$stale_networks_file"

if [ "$cleanup_failed" -ne 0 ]; then
  echo "cleanup finished with errors; inspect Docker output above" >&2
  exit 1
fi

echo "cleanup complete"
