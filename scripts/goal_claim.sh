#!/usr/bin/env bash
# Claim one GitHub Issue as a momo Codex goal and create an isolated worktree.
set -euo pipefail

ORG_REPO="${ORG_REPO:-yeomyeonggeori/oort}"
BASE_BRANCH_ENV="${BASE_BRANCH:-}"
BASE_BRANCH_FLAG=""
BASE_BRANCH=""
BASE_SOURCE=""
WORKTREE_ROOT="${WORKTREE_ROOT:-}"
DRY_RUN=0
FORCE=0
ISSUE=""

usage() {
  cat <<'EOF'
Usage: scripts/goal_claim.sh [--dry-run] [--force] [--repo ORG/REPO] [--base main] [--worktree-root DIR] <issue-number>

Claims an issue by:
  1. verifying it is open, unassigned, and status:ready unless --force is set
  2. resolving the base branch this goal branches from (see below)
  3. creating a canonical branch and worktree
  4. pushing the new remote branch as the collision-resistant lock
  5. marking the issue status:in-progress and assigning @me

Base branch resolution (first hit wins; the chosen source is printed):
  flag        --base <branch>
  env         BASE_BRANCH=<branch>
  label       issue label `track:<name>` -> branch `track/<name>`
  issue-body  a line in the issue body reading `Base: <main|track/...>`
  title-tag   an issue title tag `[<name>]` naming an existing `track/<name>`
  worktree    this checkout is already on a `track/*` branch
  default     main

Only explicit, authored signals move the base off main. docs/TRACKS.md file
ownership is used as a printed hint, never as the decision: engine-track waves
routinely land clients/web and clients/mobile fixes, so path ownership does not
imply the integration branch.

Default worktree root: ../momo-worktrees
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --repo) ORG_REPO="$2"; shift 2 ;;
    --base) BASE_BRANCH_FLAG="$2"; shift 2 ;;
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

issue_json="$(gh issue view "$ISSUE" --repo "$ORG_REPO" --json number,title,body,state,assignees,labels,url)"
number="$(printf '%s' "$issue_json" | jq -r '.number')"
title="$(printf '%s' "$issue_json" | jq -r '.title')"
body="$(printf '%s' "$issue_json" | jq -r '.body // ""')"
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

remote_branch_exists() {
  git ls-remote --exit-code --heads origin "$1" >/dev/null 2>&1
}

# A track:<name> label is the orchestrator's machine-readable declaration of the
# integration branch. Unknown or unpushed tracks are ignored, never invented.
base_from_label() {
  local name
  for name in $(printf '%s\n' "$labels" \
    | sed -n -E 's#^track:[[:space:]]*([A-Za-z0-9._-]+)[[:space:]]*$#\1#p'); do
    if remote_branch_exists "track/$name"; then
      printf 'track/%s\n' "$name"
      return 0
    fi
  done
  return 1
}

# An issue body may state its base explicitly on its own line ("Base: track/engine").
# Prose that merely mentions a branch mid-sentence must not match.
base_from_issue_body() {
  local candidate
  candidate="$(printf '%s\n' "$body" \
    | sed -n -E 's#^[[:space:]]*([-*+][[:space:]]+)?[Bb]ase([[:space:]]+[Bb]ranch)?[[:space:]]*:[[:space:]]*`?(main|track/[A-Za-z0-9._-]+)`?[[:space:]]*$#\3#p')"
  candidate="${candidate%%$'\n'*}"
  [ -n "$candidate" ] || return 1
  remote_branch_exists "$candidate" || return 1
  printf '%s\n' "$candidate"
}

# Titles carry an authored `[engine]`/`[uxui]` tag in the repo's own backlog
# convention. Only tags that name an existing canonical track branch count, and
# a title naming two tracks is ambiguous rather than a guess.
base_from_title_tag() {
  local tag resolved=""
  for tag in $(printf '%s' "$title" \
    | grep -oE '\[[A-Za-z0-9._-]+\]' 2>/dev/null | tr -d '[]' || true); do
    remote_branch_exists "track/$tag" || continue
    if [ -n "$resolved" ] && [ "$resolved" != "track/$tag" ]; then
      return 1
    fi
    resolved="track/$tag"
  done
  [ -n "$resolved" ] || return 1
  printf '%s\n' "$resolved"
}

# Claiming from inside a track checkout is itself a track declaration
# (docs/TRACKS.md §0). Claiming from the main root keeps branching from main.
base_from_current_checkout() {
  local current
  current="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  case "$current" in
    track/*)
      remote_branch_exists "$current" || return 1
      printf '%s\n' "$current"
      ;;
    *) return 1 ;;
  esac
}

# Advisory only. docs/TRACKS.md owns file trees, not integration branches, so a
# path match is printed as a question for the operator and never acted on.
tracks_md_hint() {
  local tracks_file="$repo_root/docs/TRACKS.md"
  [ -f "$tracks_file" ] || return 0
  local text row row_branch prefix
  text="$title
$body"
  while IFS= read -r row; do
    case "$row" in
      \|*) ;;
      *) continue ;;
    esac
    row_branch="$(printf '%s' "$row" | sed -n -E 's#.*`(track/[A-Za-z0-9._-]+)`.*#\1#p')"
    [ -n "$row_branch" ] || continue
    for prefix in $(printf '%s' "$row" \
      | grep -oE '`[A-Za-z0-9._/-]+/\*\*`' 2>/dev/null | tr -d '`*' || true); do
      case "$text" in
        *"$prefix"*)
          printf '%s %s\n' "$row_branch" "$prefix"
          return 0
          ;;
      esac
    done
  done <"$tracks_file"
  return 0
}

resolve_base_branch() {
  local resolved=""
  if [ -n "$BASE_BRANCH_FLAG" ]; then
    BASE_BRANCH="$BASE_BRANCH_FLAG"
    BASE_SOURCE="flag"
    return 0
  fi
  if [ -n "$BASE_BRANCH_ENV" ]; then
    BASE_BRANCH="$BASE_BRANCH_ENV"
    BASE_SOURCE="env"
    return 0
  fi
  if resolved="$(base_from_label)"; then
    BASE_BRANCH="$resolved"
    BASE_SOURCE="label"
    return 0
  fi
  if resolved="$(base_from_issue_body)"; then
    BASE_BRANCH="$resolved"
    BASE_SOURCE="issue-body"
    return 0
  fi
  if resolved="$(base_from_title_tag)"; then
    BASE_BRANCH="$resolved"
    BASE_SOURCE="title-tag"
    return 0
  fi
  if resolved="$(base_from_current_checkout)"; then
    BASE_BRANCH="$resolved"
    BASE_SOURCE="worktree"
    return 0
  fi
  BASE_BRANCH="main"
  BASE_SOURCE="default"
}

resolve_base_branch

if ! remote_branch_exists "$BASE_BRANCH"; then
  echo "base branch does not exist on origin: $BASE_BRANCH (source: $BASE_SOURCE)" >&2
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
echo "base:     $BASE_BRANCH (source: $BASE_SOURCE)"
echo "branch:   $branch"
echo "worktree: $worktree_path"

if [ "$BASE_SOURCE" = "default" ]; then
  hint="$(tracks_md_hint 2>/dev/null || true)"
  if [ -n "$hint" ]; then
    echo "hint:     docs/TRACKS.md ownership mentions ${hint#* } (${hint%% *}); pass --base ${hint%% *} if this goal lands on that track" >&2
  fi
  echo "hint:     no track signal (no track:* label, no 'Base:' line, not on a track branch) — branching from main" >&2
fi

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
