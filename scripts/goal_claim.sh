#!/usr/bin/env bash
# Claim one GitHub Issue as a momo Codex goal and create an isolated worktree.
set -euo pipefail

ORG_REPO="${ORG_REPO:-Dawn-kim-official/momo}"
BASE_BRANCH="${BASE_BRANCH:-main}"
WORKTREE_ROOT="${WORKTREE_ROOT:-}"
DRY_RUN=0
FORCE=0
ISSUE=""

usage() {
  cat <<'EOF'
Usage: scripts/goal_claim.sh [--dry-run] [--force] [--repo ORG/REPO] [--base main] [--worktree-root DIR] <issue-number>

Claims an issue by:
  1. verifying it is open, unassigned, and status:ready unless --force is set
  2. creating a canonical branch and worktree
  3. pushing the new remote branch as the collision-resistant lock
  4. marking the issue status:in-progress and assigning @me

Default worktree root: ../momo-worktrees
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --repo) ORG_REPO="$2"; shift 2 ;;
    --base) BASE_BRANCH="$2"; shift 2 ;;
    --worktree-root) WORKTREE_ROOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      ISSUE="$1"
      shift
      ;;
  esac
done

if [ -z "$ISSUE" ]; then
  usage >&2
  exit 2
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need gh
need git
need jq

assert_origin_matches_repo() {
  local origin_url repo_pattern
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  repo_pattern="${ORG_REPO%.git}"
  case "$origin_url" in
    *"github.com:$repo_pattern.git"|*"github.com:$repo_pattern"|*"github.com/$repo_pattern.git"|*"github.com/$repo_pattern") ;;
    *)
      echo "origin remote does not match --repo $ORG_REPO: ${origin_url:-<missing>}" >&2
      echo "Refusing to mix GitHub issue state with branches from another remote." >&2
      exit 1
      ;;
  esac
}

assert_origin_matches_repo

repo_root="$(git rev-parse --show-toplevel)"
if [ -z "$WORKTREE_ROOT" ]; then
  repo_parent="$(cd "$repo_root/.." && pwd)"
  if [ "$(basename "$repo_parent")" = "momo-worktrees" ]; then
    WORKTREE_ROOT="$repo_parent"
  else
    WORKTREE_ROOT="$repo_parent/momo-worktrees"
  fi
fi

issue_json="$(gh issue view "$ISSUE" --repo "$ORG_REPO" --json number,title,state,assignees,labels,url)"
number="$(printf '%s' "$issue_json" | jq -r '.number')"
title="$(printf '%s' "$issue_json" | jq -r '.title')"
state="$(printf '%s' "$issue_json" | jq -r '.state')"
url="$(printf '%s' "$issue_json" | jq -r '.url')"
assignee_count="$(printf '%s' "$issue_json" | jq '.assignees | length')"
labels="$(printf '%s' "$issue_json" | jq -r '.labels[].name')"

has_label() {
  printf '%s\n' "$labels" | grep -Fxq "$1"
}

if [ "$state" != "OPEN" ]; then
  echo "issue #$number is not open: $state" >&2
  exit 1
fi

if [ "$assignee_count" != "0" ] && [ "$FORCE" != "1" ]; then
  echo "issue #$number already has assignee(s). Use --force only after checking ownership." >&2
  exit 1
fi

if { has_label "status:in-progress" || has_label "status:needs-review"; } && [ "$FORCE" != "1" ]; then
  echo "issue #$number is already claimed or in review. Use --force only after checking ownership." >&2
  exit 1
fi

if ! has_label "status:ready" && [ "$FORCE" != "1" ]; then
  echo "issue #$number is not status:ready. Use --force for deliberate exceptions." >&2
  exit 1
fi

prefix="feat"
if has_label "type:docs"; then
  prefix="docs"
elif has_label "type:bug"; then
  prefix="fix"
elif has_label "type:chore" || has_label "type:infra"; then
  prefix="chore"
fi

slug="$(
  printf '%s' "$title" \
    | sed -E 's/^[^:]+:[[:space:]]*//' \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
)"
if [ -z "$slug" ]; then
  slug="issue-$number"
fi

branch="$prefix/$number-$slug"
worktree_path="$WORKTREE_ROOT/$number-$slug"

echo "issue:    #$number $title"
echo "url:      $url"
echo "branch:   $branch"
echo "worktree: $worktree_path"

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  echo "remote branch already exists: $branch" >&2
  exit 1
fi

if [ -e "$worktree_path" ]; then
  echo "worktree path already exists: $worktree_path" >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would fetch origin/$BASE_BRANCH"
  echo "[dry-run] would create worktree and branch"
  echo "[dry-run] would push remote branch as lock"
  echo "[dry-run] would assign @me and set status:in-progress"
  exit 0
fi

git fetch origin "$BASE_BRANCH"
mkdir -p "$WORKTREE_ROOT"
git worktree add -b "$branch" "$worktree_path" "origin/$BASE_BRANCH"
git -C "$worktree_path" push -u origin "$branch"

me="$(gh api user -q .login)"
gh issue edit "$number" --repo "$ORG_REPO" \
  --add-assignee "@me" \
  --add-label "status:in-progress" \
  --remove-label "status:ready,status:blocked,status:needs-review"

comment_file="$(mktemp)"
cat > "$comment_file" <<EOF
Claimed by @$me.

- Branch: \`$branch\`
- Worktree: \`$worktree_path\`
- Base: \`$BASE_BRANCH\`

Lease rule: this issue should have exactly one active branch/worktree/PR.
EOF
gh issue comment "$number" --repo "$ORG_REPO" --body-file "$comment_file"
rm -f "$comment_file"

if [ -x "$worktree_path/.conductor/setup.sh" ]; then
  (cd "$worktree_path" && bash .conductor/setup.sh)
fi

echo "claimed #$number on $branch"
