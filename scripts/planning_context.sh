#!/usr/bin/env bash
# Offline planning restore for planner and worker handoff.
# Resolves the repo from this script's location so SessionStart hooks and
# nested cwd still work. Default path is local files only: no fetch, no
# launch, no network. --github is opt-in. --details is opt-in.
set -euo pipefail

include_github=0
include_details=0

usage() {
  cat <<'EOF'
Usage: scripts/planning_context.sh [--details] [--github]

Print a compact offline restore:
  checkout / HEAD / dirty, the full CURRENT_STATE snapshot, and the
  shared coordination board (once). Next actions live in those sources.

--details   Scan Proposed ADRs, pending deviations, latest journal entry.
--github    Append scripts/goal_status.sh (network). Default stays offline.

A missing or malformed live board means this clone has no readable local
registrations, not that no other processes exist. This script never
launches workers or fetches remotes on the default path.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --github)
      include_github=1
      shift
      ;;
    --details)
      include_details=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Inherited GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR (hooks, --git-dir) would
# retarget `git -C` and later discovery onto another clone. Drop only Git's
# repository-local variables in this process. The invoking shell is unchanged.
# Names come from `git rev-parse --local-env-vars`, with the same fallback as
# scripts/planning_session.py.
clear_inherited_git_repo_env() {
  local names name
  names="$(
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
      -u GIT_OBJECT_DIRECTORY -u GIT_PREFIX \
      git rev-parse --local-env-vars 2>/dev/null || true
  )"
  if [ -z "$names" ]; then
    names="$(printf '%s\n' \
      GIT_ALTERNATE_OBJECT_DIRECTORIES \
      GIT_CONFIG \
      GIT_CONFIG_PARAMETERS \
      GIT_CONFIG_COUNT \
      GIT_OBJECT_DIRECTORY \
      GIT_DIR \
      GIT_WORK_TREE \
      GIT_IMPLICIT_WORK_TREE \
      GIT_GRAFT_FILE \
      GIT_INDEX_FILE \
      GIT_NO_REPLACE_OBJECTS \
      GIT_REPLACE_REF_BASE \
      GIT_PREFIX \
      GIT_SHALLOW_FILE \
      GIT_COMMON_DIR)"
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    unset "$name" 2>/dev/null || true
  done <<EOF
$names
EOF
}

clear_inherited_git_repo_env

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd)"

if git -C "$repo_root" rev-parse --show-toplevel >/dev/null 2>&1; then
  repo_root="$(git -C "$repo_root" rev-parse --show-toplevel)"
fi

cd "$repo_root"

printf '%s\n' '# oort planning context (offline)'
printf 'repo: %s\n' "$repo_root"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'head: %s\n' "$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  printf 'branch: %s\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
else
  printf 'head: unknown\n'
  printf 'branch: unknown\n'
fi

printf '\n%s\n' '## Worktree'
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git status --short --branch | sed -n '1,80p'
else
  printf '%s\n' '(not a git worktree)'
fi

printf '\n%s\n' '## Current snapshot'
if [ -f docs/planning/CURRENT_STATE.md ]; then
  cat docs/planning/CURRENT_STATE.md
else
  printf '%s\n' '(docs/planning/CURRENT_STATE.md missing)'
fi

printf '\n%s\n' '## Shared coordination'
if [ -f scripts/planning_session.py ]; then
  python3 scripts/planning_session.py status || true
else
  printf '%s\n' '(scripts/planning_session.py missing)'
fi

if [ "$include_details" -eq 1 ]; then
  printf '\n%s\n' '## Proposed ADRs (--details)'
  found_proposed=0
  if [ -d docs/adr ]; then
    while IFS= read -r adr; do
      [ -n "$adr" ] || continue
      if grep -qE '^> Status: Proposed|^Status: Proposed' "$adr" 2>/dev/null; then
        found_proposed=1
        heading="$(sed -n '1p' "$adr")"
        status="$(grep -E '^> Status:|^Status:' "$adr" | head -1 || true)"
        printf '%s: %s | %s\n' "$adr" "$heading" "$status"
      fi
    done < <(find docs/adr -name '*.md' -print 2>/dev/null || true)
  fi
  if [ "$found_proposed" -eq 0 ]; then
    printf '%s\n' '(none)'
  fi

  printf '\n%s\n' '## Pending deviations (--details)'
  if [ -f docs/planning/DEVIATION_LOG.md ]; then
    pending="$(awk -F '|' '/^\|/ && /\|[[:space:]]*pending[[:space:]]*\|/ { print }' docs/planning/DEVIATION_LOG.md)"
    if [ -n "$pending" ]; then
      printf '%s\n' "$pending"
    else
      printf '%s\n' '(none)'
    fi
  else
    printf '%s\n' '(none)'
  fi

  printf '\n%s\n' '## Latest planning journal entry (--details)'
  if [ -f docs/planning/JOURNAL.md ]; then
    awk '
      /^## / {
        section += 1
        if (section > 1) exit
      }
      section == 1 { print }
    ' docs/planning/JOURNAL.md
  else
    printf '%s\n' '(none)'
  fi
fi

printf '\n%s\n' '## Dynamic implementation state'
if [ "$include_github" -eq 1 ]; then
  scripts/goal_status.sh
else
  printf '%s\n' 'Offline snapshot only. Run scripts/planning_context.sh --github for the live issue/PR/worktree board.'
fi
