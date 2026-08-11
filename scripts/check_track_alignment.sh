#!/usr/bin/env bash
# Keep main, track/engine, and track/uxui in a topology that can be integrated
# without rewriting history. The checker never fetches or mutates refs; callers
# that need fresh remote state (pre-push/CI) must fetch explicitly first.
set -euo pipefail

CHECK_REMOTE=0
CHECK_LOCAL=0
LOCAL_OPTIONAL=0
CANDIDATE_TARGET=""
CANDIDATE_HEAD=""
CONTAINS_MAIN_REF=""

usage() {
  cat <<'EOF'
Usage: scripts/check_track_alignment.sh [OPTIONS]

Checks:
  --remote                   Require origin/main to be an ancestor of both
                             origin/track/* refs. Track-ahead is allowed.
  --local                    Require all three local canonical branches, their
                             exact upstreams, and no local behind/divergence.
  --local-existing           Apply --local checks only to canonical branches
                             that exist (for public clones without track refs).
  --candidate TARGET HEAD    Validate a proposed canonical branch update. The
                             update must be fast-forward and track targets must
                             contain origin/main.
  --contains-main REF        Require REF to contain origin/main. Used when a
                             merge-tree base may be local or remote.
  --all                      Equivalent to --remote --local.

With no options, --all is used. This command performs no fetch and no writes.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote)
      CHECK_REMOTE=1
      shift
      ;;
    --local)
      CHECK_LOCAL=1
      LOCAL_OPTIONAL=0
      shift
      ;;
    --local-existing)
      CHECK_LOCAL=1
      LOCAL_OPTIONAL=1
      shift
      ;;
    --candidate)
      [ "$#" -ge 3 ] || { echo "[track-alignment] --candidate needs TARGET and HEAD" >&2; exit 2; }
      CANDIDATE_TARGET="$2"
      CANDIDATE_HEAD="$3"
      shift 3
      ;;
    --contains-main)
      [ "$#" -ge 2 ] || { echo "[track-alignment] --contains-main needs REF" >&2; exit 2; }
      CONTAINS_MAIN_REF="$2"
      shift 2
      ;;
    --all)
      CHECK_REMOTE=1
      CHECK_LOCAL=1
      LOCAL_OPTIONAL=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[track-alignment] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$CHECK_REMOTE" -eq 0 ] && [ "$CHECK_LOCAL" -eq 0 ] && [ -z "$CANDIDATE_TARGET" ] && [ -z "$CONTAINS_MAIN_REF" ]; then
  CHECK_REMOTE=1
  CHECK_LOCAL=1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[track-alignment] must run inside a git repository" >&2
  exit 1
}
cd "$REPO_ROOT"

FAILED=0

fail() {
  echo "[track-alignment] FAIL: $*" >&2
  FAILED=1
}

require_commit() {
  local ref="$1"
  if ! git rev-parse --verify "$ref^{commit}" >/dev/null 2>&1; then
    fail "required ref is unavailable: $ref (fetch canonical refs first)"
    return 1
  fi
}

relation_counts() {
  local left_ref="$1"
  local right_ref="$2"
  git rev-list --left-right --count "$left_ref...$right_ref"
}

check_remote_track() {
  local track_ref="$1"
  local counts main_only track_only

  require_commit "$track_ref" || return
  counts="$(relation_counts origin/main "$track_ref")" || {
    fail "cannot compare origin/main with $track_ref"
    return
  }
  read -r main_only track_only <<EOF
$counts
EOF
  if [ "$main_only" -gt 0 ]; then
    if [ "$track_only" -gt 0 ]; then
      fail "$track_ref diverged from origin/main (main-only=$main_only, track-only=$track_only)"
    else
      fail "$track_ref is behind origin/main by $main_only commit(s)"
    fi
    return
  fi
  echo "[track-alignment] PASS remote: $track_ref contains origin/main (ahead=$track_only)"
}

check_local_branch() {
  local branch="$1"
  local expected_upstream="$2"
  local local_ref="refs/heads/$branch"
  local actual_upstream counts remote_only local_only

  if ! git rev-parse --verify "$local_ref^{commit}" >/dev/null 2>&1; then
    if [ "$LOCAL_OPTIONAL" -eq 1 ]; then
      echo "[track-alignment] SKIP local: $branch is not installed in this clone"
      return
    fi
    fail "required local ref is unavailable: $local_ref"
    return
  fi
  require_commit "$expected_upstream" || return

  actual_upstream="$(git for-each-ref --format='%(upstream:short)' "$local_ref")"
  if [ "$actual_upstream" != "$expected_upstream" ]; then
    if [ -z "$actual_upstream" ]; then
      fail "$branch has no upstream; expected $expected_upstream"
    else
      fail "$branch upstream is $actual_upstream; expected $expected_upstream"
    fi
  fi

  counts="$(relation_counts "$expected_upstream" "$local_ref")" || {
    fail "cannot compare $branch with $expected_upstream"
    return
  }
  read -r remote_only local_only <<EOF
$counts
EOF
  if [ "$remote_only" -gt 0 ]; then
    if [ "$local_only" -gt 0 ]; then
      fail "$branch diverged from $expected_upstream (remote-only=$remote_only, local-only=$local_only)"
    else
      fail "$branch is behind $expected_upstream by $remote_only commit(s)"
    fi
    return
  fi

  echo "[track-alignment] PASS local: $branch -> $expected_upstream (ahead=$local_only)"
}

normalize_target() {
  case "$1" in
    refs/heads/*) printf '%s\n' "${1#refs/heads/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

check_candidate() {
  local target head target_remote
  target="$(normalize_target "$CANDIDATE_TARGET")"
  head="$CANDIDATE_HEAD"

  case "$target" in
    main|track/engine|track/uxui) ;;
    *)
      fail "candidate target must be main, track/engine, or track/uxui (got $target)"
      return
      ;;
  esac

  require_commit "$head" || return
  target_remote="origin/$target"
  require_commit "$target_remote" || return

  if ! git merge-base --is-ancestor "$target_remote" "$head"; then
    fail "candidate $head is not a fast-forward of $target_remote"
  fi
  if [ "$target" != "main" ]; then
    require_commit origin/main || return
    if ! git merge-base --is-ancestor origin/main "$head"; then
      fail "candidate $head for $target does not contain origin/main"
    fi
  fi
  if [ "$FAILED" -eq 0 ]; then
    echo "[track-alignment] PASS candidate: $head may update $target"
  fi
}

if [ "$CHECK_REMOTE" -eq 1 ]; then
  if require_commit origin/main; then
    check_remote_track origin/track/engine
    check_remote_track origin/track/uxui
  fi
fi

if [ "$CHECK_LOCAL" -eq 1 ]; then
  check_local_branch main origin/main
  check_local_branch track/engine origin/track/engine
  check_local_branch track/uxui origin/track/uxui
fi

if [ -n "$CANDIDATE_TARGET" ]; then
  check_candidate
fi

if [ -n "$CONTAINS_MAIN_REF" ]; then
  if require_commit origin/main && require_commit "$CONTAINS_MAIN_REF"; then
    if git merge-base --is-ancestor origin/main "$CONTAINS_MAIN_REF"; then
      echo "[track-alignment] PASS base: $CONTAINS_MAIN_REF contains origin/main"
    else
      fail "$CONTAINS_MAIN_REF does not contain origin/main"
    fi
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "[track-alignment] PASS: requested alignment checks are green"
