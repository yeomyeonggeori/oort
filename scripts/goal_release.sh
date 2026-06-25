#!/usr/bin/env bash
# Move a claimed issue to review, blocked, or ready after a worktree session.
set -euo pipefail

ORG_REPO="${ORG_REPO:-Dawn-kim-official/momo}"
DRY_RUN=0
ISSUE=""
MODE=""
MESSAGE=""
PR_URL=""

usage() {
  cat <<'EOF'
Usage:
  scripts/goal_release.sh [--dry-run] [--repo ORG/REPO] <issue> --review [--pr URL]
  scripts/goal_release.sh [--dry-run] [--repo ORG/REPO] <issue> --blocked "reason"
  scripts/goal_release.sh [--dry-run] [--repo ORG/REPO] <issue> --ready "reason"

Updates only GitHub issue labels/comments. It does not delete worktrees or branches.
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

issue_title="$(gh issue view "$ISSUE" --repo "$ORG_REPO" --json title -q .title)"
echo "issue: #$ISSUE $issue_title"
echo "mode:  $MODE"

case "$MODE" in
  review)
    add_label="status:needs-review"
    remove_label="status:ready,status:in-progress,status:blocked"
    body="Moved to review."
    if [ -n "$PR_URL" ]; then
      body="$body\n\nPR: $PR_URL"
    fi
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
  printf '[dry-run] would comment:\n%b\n' "$body"
  exit 0
fi

gh issue edit "$ISSUE" --repo "$ORG_REPO" --add-label "$add_label" --remove-label "$remove_label"
comment_file="$(mktemp)"
printf '%b\n' "$body" > "$comment_file"
gh issue comment "$ISSUE" --repo "$ORG_REPO" --body-file "$comment_file"
rm -f "$comment_file"

echo "updated #$ISSUE -> $MODE"
