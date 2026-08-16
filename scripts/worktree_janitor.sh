#!/usr/bin/env bash
# List and optionally remove stale git worktrees left behind by momo goals.
#
# Companion to scripts/compose_janitor.sh (Docker compose stacks) and
# ~/.local/bin/momo-docker-reclaim.sh (machine-level Docker safety net).
# Runbook: docs/runbooks/local-resource-reclaim.md
#
# Classification per worktree:
#   KEEP     — protected: primary worktree, track/* branches, deploy*, keep-list.
#   RECLAIM  — landed (HEAD is ancestor of main/track/engine, or its PR merged)
#              and the tree is clean. Removed by --cleanup.
#   JUNK     — landed, dirty ONLY with junk (node_modules, .DS_Store, target/,
#              dist/, *.log). Removed only with --cleanup --include-junk-dirty.
#   HOLD     — landed but carries real uncommitted work, or goal still open,
#              or state unknown. Never removed; listed for human triage.
#
# Removal uses `git worktree remove` (never raw rm -rf), so the branch ref
# always survives; only the checkout and its build artifacts are reclaimed.
set -euo pipefail

MODE="dry-run"
INCLUDE_JUNK=0
KEEP_GLOBS="${WORKTREE_JANITOR_KEEP:-deploy*}"

usage() {
  cat <<'EOF'
Usage: scripts/worktree_janitor.sh [--dry-run] [--cleanup] [--include-junk-dirty]

Default is a dry-run report. --cleanup removes RECLAIM worktrees.
--include-junk-dirty also removes JUNK worktrees (untracked junk only).
WORKTREE_JANITOR_KEEP: colon-separated dir-basename globs to protect (default: deploy*).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --cleanup) MODE="cleanup"; shift ;;
    --include-junk-dirty) INCLUDE_JUNK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "missing git" >&2; exit 1; }
HAVE_GH=0
command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && HAVE_GH=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
PRIMARY="$(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree /{if (!seen++) print $2}')"

is_kept() { # $1 = worktree dir
  local base glob
  base="$(basename "$1")"
  IFS=':' read -ra globs <<<"$KEEP_GLOBS"
  for glob in "${globs[@]}"; do
    [ -n "$glob" ] || continue
    # shellcheck disable=SC2254
    case "$base" in $glob) return 0 ;; esac
  done
  return 1
}

is_junk_path() { # untracked path considered disposable build/junk output
  case "$1" in
    *node_modules/*|*/node_modules|node_modules|*.DS_Store|target/*|*/target/*|dist/*|*/dist/*|*.log)
      return 0 ;;
    *) return 1 ;;
  esac
}

landed() { # $1 = head sha, $2 = branch name; 0 if content is on main/track/engine
  local head="$1" branch="$2"
  if git -C "$REPO_ROOT" merge-base --is-ancestor "$head" main 2>/dev/null \
     || git -C "$REPO_ROOT" merge-base --is-ancestor "$head" track/engine 2>/dev/null; then
    return 0
  fi
  # Squash-merge case: the branch head is not an ancestor, but its PR merged.
  if [ "$HAVE_GH" -eq 1 ] && [ -n "$branch" ]; then
    local merged
    merged="$(gh pr list --state merged --head "$branch" --json number --jq 'length' 2>/dev/null || echo 0)"
    [ "${merged:-0}" -gt 0 ] && return 0
  fi
  return 1
}

goal_open() { # $1 = branch name; 0 if the branch's leading issue number is an OPEN issue
  local branch="$1" num state
  [ "$HAVE_GH" -eq 1 ] || return 1
  num="$(printf '%s' "$branch" | sed -n 's|^[a-z-]*/\([0-9][0-9]*\)-.*|\1|p')"
  [ -n "$num" ] || return 1
  state="$(gh issue view "$num" --json state --jq .state 2>/dev/null || true)"
  [ "$state" = "OPEN" ]
}

printf '%-8s %-7s %-6s %s\n' CLASS SIZE DIRTY WORKTREE
removed=0 held=0
while read -r dir; do
  [ "$dir" = "$PRIMARY" ] && continue
  [ -d "$dir" ] || continue
  branch="$(git -C "$dir" branch --show-current 2>/dev/null || true)"
  head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
  size="$(du -sh "$dir" 2>/dev/null | cut -f1)"

  # Dirty split: tracked modifications/staged vs untracked, junk vs real.
  tracked_dirty=0 real_untracked=0 junk_untracked=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    status="${line:0:2}" path="${line:3}"
    if [ "$status" = "??" ]; then
      if is_junk_path "$path"; then junk_untracked=$((junk_untracked+1)); else real_untracked=$((real_untracked+1)); fi
    else
      tracked_dirty=$((tracked_dirty+1))
    fi
  done < <(git -C "$dir" status --porcelain 2>/dev/null)

  class="HOLD" reason=""
  case "$branch" in track/*) class="KEEP" reason="track branch" ;; esac
  if [ "$class" = "HOLD" ] && is_kept "$dir"; then class="KEEP" reason="keep-list"; fi
  if [ "$class" = "HOLD" ]; then
    if goal_open "$branch"; then
      reason="goal issue still OPEN"
    elif landed "$head" "$branch"; then
      if [ "$tracked_dirty" -eq 0 ] && [ "$real_untracked" -eq 0 ]; then
        if [ "$junk_untracked" -eq 0 ]; then class="RECLAIM" reason="landed, clean"
        else class="JUNK" reason="landed, junk-only dirt"; fi
      else
        reason="landed but has real uncommitted work — triage by hand"
      fi
    else
      reason="not landed (no merged PR / not ancestor) — triage by hand"
    fi
  fi

  dirty_desc="$tracked_dirty/$real_untracked/$junk_untracked"
  printf '%-8s %-7s %-6s %s  [%s] %s\n' "$class" "$size" "$dirty_desc" "$dir" "${branch:-detached}" "$reason"

  if [ "$MODE" = "cleanup" ]; then
    if [ "$class" = "RECLAIM" ]; then
      git -C "$REPO_ROOT" worktree remove "$dir" && removed=$((removed+1))
    elif [ "$class" = "JUNK" ] && [ "$INCLUDE_JUNK" -eq 1 ]; then
      git -C "$REPO_ROOT" worktree remove --force "$dir" && removed=$((removed+1))
    elif [ "$class" = "HOLD" ]; then
      held=$((held+1))
    fi
  fi
done < <(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree /{print $2}')

if [ "$MODE" = "cleanup" ]; then
  git -C "$REPO_ROOT" worktree prune
  echo "removed=$removed held=$held (DIRTY column = tracked/real-untracked/junk-untracked)"
else
  echo "dry-run only. Re-run with --cleanup to remove RECLAIM (add --include-junk-dirty for JUNK)."
fi
