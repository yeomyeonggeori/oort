#!/usr/bin/env bash
# Move a claimed issue to review, blocked, or ready after a worktree session.
# Review mode is a worker -> momo-main handoff, not merge permission.
set -euo pipefail

ORG_REPO="${ORG_REPO:-yeomyeonggeori/oort}"
DRY_RUN=0
ISSUE=""
MODE=""
MESSAGE=""
PR_URL=""

usage() {
  cat <<'EOF'
Usage:
  scripts/goal_release.sh [--dry-run] [--repo ORG/REPO] <issue> --review --pr URL_OR_NUMBER
  scripts/goal_release.sh [--dry-run] [--repo ORG/REPO] <issue> --blocked "reason"
  scripts/goal_release.sh [--dry-run] [--repo ORG/REPO] <issue> --ready "reason"

Updates only GitHub issue labels/comments. It does not delete worktrees or branches.

Review mode is the worker stop line:
  PR created -> status:needs-review -> handoff to momo-main.
  Workers must not merge, close issues, run the post-merge main gate, or adjust roadmap/backlog state.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo) ORG_REPO="$2"; shift 2 ;;
    --review) MODE="review"; shift ;;
    --blocked) MODE="blocked"; MESSAGE="${2:-}"; shift 2 ;;
    --ready) MODE="ready"; MESSAGE="${2:-}"; shift 2 ;;
    --pr) PR_URL="$2"; shift 2 ;;
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

if [ -z "$ISSUE" ] || [ -z "$MODE" ]; then
  usage >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "missing gh" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "missing jq" >&2; exit 1; }

issue_json="$(gh issue view "$ISSUE" --repo "$ORG_REPO" --json title,assignees)"
issue_title="$(printf '%s' "$issue_json" | jq -r '.title')"
assignees="$(printf '%s' "$issue_json" | jq -r '[.assignees[].login] | join(",")')"
echo "issue: #$ISSUE $issue_title"
echo "mode:  $MODE"

pr_ref_from_url() {
  printf '%s' "$1" | sed -E 's#^https://github.com/[^/]+/[^/]+/pull/([0-9]+).*$#\1#'
}

validate_review_pr() {
  local pr_ref pr_json pr_state pr_url pr_branch closes_issue branch_matches

  if [ -z "$PR_URL" ]; then
    echo "--review requires --pr URL_OR_NUMBER" >&2
    exit 2
  fi

  pr_ref="$(pr_ref_from_url "$PR_URL")"
  pr_json="$(gh pr view "$pr_ref" --repo "$ORG_REPO" --json number,url,state,headRefName,closingIssuesReferences)"
  pr_state="$(printf '%s' "$pr_json" | jq -r '.state')"
  pr_url="$(printf '%s' "$pr_json" | jq -r '.url')"
  pr_branch="$(printf '%s' "$pr_json" | jq -r '.headRefName')"

  if [ "$pr_state" != "OPEN" ]; then
    echo "PR is not open: $pr_url ($pr_state)" >&2
    exit 1
  fi

  if printf '%s' "$pr_json" | jq -e --argjson issue "$ISSUE" 'any(.closingIssuesReferences[]?; .number == $issue)' >/dev/null; then
    closes_issue=1
  else
    closes_issue=0
  fi

  case "$pr_branch" in
    "$ISSUE"-*|*/"$ISSUE"-*) branch_matches=1 ;;
    *) branch_matches=0 ;;
  esac

  if [ "$closes_issue" != "1" ] && [ "$branch_matches" != "1" ]; then
    echo "PR must close issue #$ISSUE or use canonical issue branch '<type>/$ISSUE-<slug>': $pr_url ($pr_branch)" >&2
    exit 1
  fi

  PR_URL="$pr_url"
}

case "$MODE" in
  review)
    validate_review_pr
    add_label="status:needs-review"
    remove_label="status:ready,status:in-progress,status:blocked"
    body="Moved to review for momo-main handoff.\n\nPR: $PR_URL\n\nWorker stop line: do not merge, close the issue, run the post-merge main gate, or adjust roadmap/backlog state from the worker thread."
    ;;
  blocked)
    if [ -z "$MESSAGE" ]; then
      echo "--blocked requires a reason" >&2
      exit 2
    fi
    add_label="status:blocked"
    remove_label="status:ready,status:in-progress,status:needs-review"
    body="Blocked.\n\nReason: $MESSAGE"
    ;;
  ready)
    if [ -z "$MESSAGE" ]; then
      echo "--ready requires a reason" >&2
      exit 2
    fi
    add_label="status:ready"
    remove_label="status:blocked,status:in-progress,status:needs-review"
    body="Returned to ready.\n\nReason: $MESSAGE"
    ;;
  *)
    echo "unsupported mode: $MODE" >&2
    exit 2
    ;;
esac

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would add label: $add_label"
  echo "[dry-run] would remove labels: $remove_label"
  if [ "$MODE" = "ready" ] && [ -n "$assignees" ]; then
    echo "[dry-run] would remove assignees: $assignees"
  fi
  printf '[dry-run] would comment:\n%b\n' "$body"
  exit 0
fi

edit_args=(issue edit "$ISSUE" --repo "$ORG_REPO" --add-label "$add_label" --remove-label "$remove_label")
if [ "$MODE" = "ready" ] && [ -n "$assignees" ]; then
  edit_args+=(--remove-assignee "$assignees")
fi
gh "${edit_args[@]}"
comment_file="$(mktemp)"
printf '%b\n' "$body" > "$comment_file"
gh issue comment "$ISSUE" --repo "$ORG_REPO" --body-file "$comment_file"
rm -f "$comment_file"

echo "updated #$ISSUE -> $MODE"
if [ "$MODE" = "review" ]; then
  echo "handoff: #$ISSUE is status:needs-review; momo-main owns review, merge, issue close, main gate, and roadmap/backlog updates."
fi
