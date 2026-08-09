#!/usr/bin/env bash
# Show the issue/branch/worktree/PR board used by momo-main orchestration.
set -euo pipefail

ORG_REPO="${ORG_REPO:-yeomyeonggeori/momo}"
LIMIT="${LIMIT:-120}"
WORKTREE_ROOT="${WORKTREE_ROOT:-}"

usage() {
  cat <<'EOF'
Usage: scripts/goal_status.sh [--repo ORG/REPO] [--limit N] [--worktree-root DIR]

Prints a status board for Codex goal orchestration:
  - ready / in-progress / needs-review / blocked issues
  - internal alpha feedback issues waiting in needs-triage
  - issue number, title, assignee, labels
  - matching branch, PR, and local worktree path
  - the local gate profile/evidence expected before worker handoff and momo-main merge
  - read-only stale/done worktree audit with copy-paste cleanup commands

The board is read-only. It does not claim, release, merge, close, or delete anything.
Workers stop after PR + status:needs-review. momo-main owns merge, close, post-merge main gate, and roadmap/backlog updates.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      ORG_REPO="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --worktree-root)
      WORKTREE_ROOT="${2:-}"
      shift 2
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
      echo "Branch/PR/worktree matching would be unreliable; run inside the matching checkout or pass the matching --repo." >&2
      exit 1
      ;;
  esac
}

assert_origin_matches_repo

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
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

issues_json="$tmp_dir/issues.json"
prs_json="$tmp_dir/prs.json"
issues_tsv="$tmp_dir/issues.tsv"
prs_tsv="$tmp_dir/prs.tsv"
worktrees_tsv="$tmp_dir/worktrees.tsv"
branches_txt="$tmp_dir/branches.txt"

gh issue list \
  --repo "$ORG_REPO" \
  --state all \
  --limit "$LIMIT" \
  --json number,title,state,assignees,labels,url,closedAt \
  > "$issues_json"

gh pr list \
  --repo "$ORG_REPO" \
  --state all \
  --limit "$LIMIT" \
  --json number,title,headRefName,url,isDraft,reviewDecision,state,mergedAt,closedAt \
  > "$prs_json"

jq -r '
  .[]
  | [
      (.number | tostring),
      (.title | gsub("[\t\r\n]"; " ")),
      .state,
      (if ([.assignees[].login] | length) == 0 then "-" else ([.assignees[].login] | join(",")) end),
      (if ([.labels[].name] | length) == 0 then "-" else ([.labels[].name] | join(",")) end),
      .url,
      (.closedAt // "-")
    ]
  | @tsv
' "$issues_json" > "$issues_tsv"

jq -r '
  .[]
  | [
      (.number | tostring),
      .url,
      .headRefName,
      .state,
      (if .isDraft then "draft" else "ready" end),
      (.reviewDecision // "-"),
      (.mergedAt // "-"),
      (.closedAt // "-"),
      (.title | gsub("[\t\r\n]"; " "))
    ]
  | @tsv
' "$prs_json" > "$prs_tsv"

git worktree list --porcelain |
  awk '
    /^worktree / { path = substr($0, 10) }
    /^branch / {
      branch = $2
      sub(/^refs\/heads\//, "", branch)
      print branch "\t" path
    }
  ' > "$worktrees_tsv"

if git ls-remote --heads origin >/dev/null 2>&1; then
  git ls-remote --heads origin |
    awk '{ print $2 }' |
    sed 's#^refs/heads/##' > "$branches_txt"
else
  : > "$branches_txt"
fi

has_label() {
  local labels="$1"
  local label="$2"
  case ",$labels," in
    *",$label,"*) return 0 ;;
    *) return 1 ;;
  esac
}

gate_for_labels() {
  local labels="$1"
  case ",$labels," in
    *",area:relay,"*) echo "runtime-relay" ;;
    *",area:worker,"*) echo "runtime-agent" ;;
    *",area:server,"*|*",area:schema,"*|*",area:tenancy,"*) echo "runtime-db" ;;
    *",area:macos,"*) echo "macos-ui" ;;
    *",type:docs,"*|*",type:spec,"*|*",area:ci,"*) echo "docs+swift-before-merge" ;;
    *) echo "swift" ;;
  esac
}

branch_for_issue() {
  local issue="$1"
  local branch

  branch="$(awk -F '\t' -v issue="$issue" '$3 ~ "(^|/)" issue "-" { print $3; exit }' "$prs_tsv")"
  if [ -n "$branch" ]; then
    printf '%s\n' "$branch"
    return 0
  fi

  branch="$(awk -F '\t' -v issue="$issue" '$1 ~ "(^|/)" issue "-" { print $1; exit }' "$worktrees_tsv")"
  if [ -n "$branch" ]; then
    printf '%s\n' "$branch"
    return 0
  fi

  branch="$(awk -v issue="$issue" '$0 ~ "(^|/)" issue "-" { print; exit }' "$branches_txt")"
  if [ -n "$branch" ]; then
    printf '%s\n' "$branch"
    return 0
  fi

  printf -- '-\n'
}

pr_for_branch() {
  local branch="$1"
  if [ "$branch" = "-" ]; then
    printf -- '-\n'
    return 0
  fi

  awk -F '\t' -v branch="$branch" '
    $3 == branch && $4 == "OPEN" {
      printf("#%s %s %s %s", $1, $5, $6, $2)
      exit
    }
  ' "$prs_tsv"
}

worktree_for_branch() {
  local branch="$1"
  local path
  if [ "$branch" = "-" ]; then
    printf -- '-\n'
    return 0
  fi

  path="$(awk -F '\t' -v branch="$branch" '$1 == branch { print $2; exit }' "$worktrees_tsv")"
  if [ -n "$path" ]; then
    printf '%s\n' "$path"
  else
    printf -- '-\n'
  fi
}

evidence_for_status() {
  local status="$1"
  local gate="$2"
  local pr="$3"

  case "$status" in
    needs-triage)
      echo "triage-feedback"
      ;;
    ready)
      echo "claim-first"
      ;;
    in-progress)
      echo "run:$gate"
      ;;
    needs-review)
      if [ -n "$pr" ] && [ "$pr" != "-" ]; then
        echo "momo-main-review"
      else
        echo "PR-missing"
      fi
      ;;
    blocked)
      echo "blocker-comment"
      ;;
    *)
      echo "check-labels"
      ;;
  esac
}

print_rows_for_status() {
  local status="$1"
  local emitted=0
  local number title state assignees labels url closed_at gate branch pr worktree evidence status_label

  while IFS=$'\t' read -r number title state assignees labels url closed_at; do
    if [ "$state" != "OPEN" ]; then
      continue
    fi

    status_label="status:$status"
    if ! has_label "$labels" "$status_label"; then
      continue
    fi

    gate="$(gate_for_labels "$labels")"
    branch="$(branch_for_issue "$number")"
    pr="$(pr_for_branch "$branch")"
    if [ -z "$pr" ]; then
      pr="-"
    fi
    worktree="$(worktree_for_branch "$branch")"
    evidence="$(evidence_for_status "$status" "$gate" "$pr")"
    if [ -z "$assignees" ]; then
      assignees="-"
    fi

    printf '%s\t#%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$status" "$number" "$assignees" "$gate" "$evidence" "$branch" "$pr" "$worktree" "$title"
    emitted=1
  done < "$issues_tsv"

  if [ "$emitted" -eq 0 ]; then
    printf '%s\t-\t-\t-\t-\t-\t-\t-\t(no open issues)\n' "$status"
  fi
}

issue_for_branch() {
  local branch="$1"
  local candidate

  case "$branch" in
    */[0-9]*-*) candidate="${branch#*/}"; candidate="${candidate%%-*}" ;;
    [0-9]*-*) candidate="${branch%%-*}" ;;
    *) candidate="" ;;
  esac

  case "$candidate" in
    ""|*[!0-9]*) printf -- '-\n' ;;
    *) printf '%s\n' "$candidate" ;;
  esac
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

remote_state_for_branch() {
  local branch="$1"
  if grep -Fxq "$branch" "$branches_txt"; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

ahead_count_for_worktree() {
  local path="$1"
  local upstream

  upstream="$(git -C "$path" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -z "$upstream" ]; then
    if git -C "$path" rev-parse --verify origin/main >/dev/null 2>&1 &&
      git -C "$path" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
      printf '0\n'
      return 0
    fi
    printf 'unknown\n'
    return 0
  fi

  git -C "$path" rev-list --count "${upstream}..HEAD" 2>/dev/null || {
    if git -C "$path" rev-parse --verify origin/main >/dev/null 2>&1 &&
      git -C "$path" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
      printf '0\n'
    else
      printf 'unknown\n'
    fi
  }
}

print_stale_worktree_audit() {
  local current_worktree emitted branch path issue issue_line issue_title issue_state issue_url issue_closed_at
  local pr_line pr_number pr_url pr_branch pr_state pr_draft pr_review pr_merged_at pr_closed_at pr_title
  local dirty_count ahead_count remote_state reason blockers cleanup_command local_state pr_ref audit_status

  current_worktree="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  emitted=0

  echo
  echo "Stale/done local worktree audit (read-only)"
  {
    printf 'audit\tissue\tpr\tbranch\tworktree\tremote\tlocal_state\tcleanup_command\n'

    while IFS=$'\t' read -r branch path; do
      issue="$(issue_for_branch "$branch")"
      issue_title="-"
      issue_state="-"
      issue_url="-"
      issue_closed_at="-"
      if [ "$issue" != "-" ]; then
        issue_line="$(awk -F '\t' -v issue="$issue" '$1 == issue { print; exit }' "$issues_tsv")"
        if [ -n "$issue_line" ]; then
          IFS=$'\t' read -r _ issue_title issue_state _ _ issue_url issue_closed_at <<EOF
$issue_line
EOF
        fi
      fi

      pr_number="-"
      pr_url="-"
      pr_state="-"
      pr_merged_at="-"
      pr_closed_at="-"
      pr_line="$(awk -F '\t' -v branch="$branch" '$3 == branch { print; exit }' "$prs_tsv")"
      if [ -n "$pr_line" ]; then
        IFS=$'\t' read -r pr_number pr_url pr_branch pr_state pr_draft pr_review pr_merged_at pr_closed_at pr_title <<EOF
$pr_line
EOF
      fi

      if [ "$issue_state" != "CLOSED" ] && [ "$pr_state" != "MERGED" ] && [ "$pr_state" != "CLOSED" ]; then
        continue
      fi

      dirty_count="$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d '[:space:]')"
      if [ -z "$dirty_count" ]; then
        dirty_count="unknown"
      fi
      ahead_count="$(ahead_count_for_worktree "$path")"
      remote_state="$(remote_state_for_branch "$branch")"

      reason=""
      if [ "$issue_state" = "CLOSED" ]; then
        reason="issue:CLOSED"
        if [ "$issue_closed_at" != "-" ]; then
          reason="$reason@$issue_closed_at"
        fi
      fi
      if [ "$pr_state" = "MERGED" ] || [ "$pr_state" = "CLOSED" ]; then
        [ -n "$reason" ] && reason="$reason,"
        reason="${reason}pr:$pr_state"
        if [ "$pr_merged_at" != "-" ]; then
          reason="$reason@$pr_merged_at"
        elif [ "$pr_closed_at" != "-" ]; then
          reason="$reason@$pr_closed_at"
        fi
      fi

      blockers=""
      if [ "$path" = "$current_worktree" ]; then
        blockers="current-worktree"
      fi
      if [ "$dirty_count" != "0" ]; then
        [ -n "$blockers" ] && blockers="$blockers,"
        blockers="${blockers}dirty:$dirty_count"
      fi
      if [ "$ahead_count" = "unknown" ]; then
        [ -n "$blockers" ] && blockers="$blockers,"
        blockers="${blockers}upstream-unknown"
      elif [ "$ahead_count" != "0" ]; then
        [ -n "$blockers" ] && blockers="$blockers,"
        blockers="${blockers}unpushed:$ahead_count"
      fi

      if [ -n "$blockers" ]; then
        local_state="$reason; warn:$blockers"
        cleanup_command="-"
        audit_status="stale-warning"
      else
        local_state="$reason; clean;pushed"
        cleanup_command="git worktree remove $(shell_quote "$path")"
        audit_status="done-candidate"
      fi

      if [ "$pr_number" != "-" ]; then
        pr_ref="#$pr_number $pr_state $pr_url"
      else
        pr_ref="-"
      fi

      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$audit_status" "#$issue" "$pr_ref" "$branch" "$path" "$remote_state" "$local_state" "$cleanup_command"
      emitted=1
    done < "$worktrees_tsv"

    if [ "$emitted" -eq 0 ]; then
      printf 'clean\t-\t-\t-\t-\t-\t(no stale/done local worktrees detected within --limit %s)\t-\n' "$LIMIT"
    fi
  } | if command -v column >/dev/null 2>&1; then
    column -t -s $'\t'
  else
    cat
  fi
}

echo "momo goal status"
echo "repo: $ORG_REPO"
echo "worktree root: $WORKTREE_ROOT"
echo "generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo

{
  printf 'status\tissue\tassignee\tgate\tevidence\tbranch\tpr\tworktree\ttitle\n'
  print_rows_for_status needs-triage
  print_rows_for_status ready
  print_rows_for_status in-progress
  print_rows_for_status needs-review
  print_rows_for_status blocked
} | if command -v column >/dev/null 2>&1; then
  column -t -s $'\t'
else
  cat
fi

print_stale_worktree_audit

echo
echo "Legend:"
echo "- gate: local gate profile expected before PR handoff or momo-main merge; docs+swift-before-merge means docs profile is enough for worker PR evidence, but swift profile is rerun by momo-main before merge."
echo "- evidence: triage-feedback=alpha feedback needs severity/evidence/labels/milestone and a buildable goal before claim, claim-first=not started, run:<profile>=worker should run that local gate then open PR, momo-main-review=needs-review PR is in momo-main's review/merge queue, PR-missing=handoff label without an open PR, blocker-comment=issue comment must explain the blocker."
echo "- branch/PR/worktree are matched by the canonical '<type>/<issue>-<slug>' convention. If a field is '-', check for non-canonical names before starting duplicate work."
echo "- stale/done audit is read-only. A cleanup command appears only for a closed issue or merged/closed PR whose local worktree is not current, has no dirty files, and has no unpushed/divergent commits."
echo "- stale-warning rows need human review first; dirty, current-worktree, upstream-unknown, or unpushed warnings intentionally suppress cleanup commands."
echo "- worker stop line: after PR + scripts/goal_release.sh --review, workers do not merge, close issues, run the post-merge main gate, or adjust roadmap/backlog state."
