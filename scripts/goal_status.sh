#!/usr/bin/env bash
# Show the issue/branch/worktree/PR board used by momo-main orchestration.
set -euo pipefail

ORG_REPO="${ORG_REPO:-Dawn-kim-official/momo}"
LIMIT="${LIMIT:-120}"
WORKTREE_ROOT="${WORKTREE_ROOT:-}"

usage() {
  cat <<'EOF'
Usage: scripts/goal_status.sh [--repo ORG/REPO] [--limit N] [--worktree-root DIR]

Prints a status board for Codex goal orchestration:
  - ready / in-progress / needs-review / blocked issues
  - issue number, title, assignee, labels
  - matching branch, PR, and local worktree path
  - the local gate profile/evidence expected before merge

The board is read-only. It does not claim, release, merge, or delete anything.
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
  --state open \
  --limit "$LIMIT" \
  --json number,title,assignees,labels,url \
  > "$issues_json"

gh pr list \
  --repo "$ORG_REPO" \
  --state open \
  --limit "$LIMIT" \
  --json number,title,headRefName,url,isDraft,reviewDecision \
  > "$prs_json"

jq -r '
  .[]
  | [
      (.number | tostring),
      (.title | gsub("[\t\r\n]"; " ")),
      (if ([.assignees[].login] | length) == 0 then "-" else ([.assignees[].login] | join(",")) end),
      (if ([.labels[].name] | length) == 0 then "-" else ([.labels[].name] | join(",")) end),
      .url
    ]
  | @tsv
' "$issues_json" > "$issues_tsv"

jq -r '
  .[]
  | [
      (.number | tostring),
      .url,
      .headRefName,
      (if .isDraft then "draft" else "ready" end),
      (.reviewDecision // "-"),
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
    $3 == branch {
      printf("#%s %s %s %s", $1, $4, $5, $2)
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
    ready)
      echo "claim-first"
      ;;
    in-progress)
      echo "run:$gate"
      ;;
    needs-review)
      if [ -n "$pr" ] && [ "$pr" != "-" ]; then
        echo "PR-Local-Gate"
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
  local number title assignees labels url gate branch pr worktree evidence status_label

  while IFS=$'\t' read -r number title assignees labels url; do
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

echo "momo goal status"
echo "repo: $ORG_REPO"
echo "worktree root: $WORKTREE_ROOT"
echo "generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo

{
  printf 'status\tissue\tassignee\tgate\tevidence\tbranch\tpr\tworktree\ttitle\n'
  print_rows_for_status ready
  print_rows_for_status in-progress
  print_rows_for_status needs-review
  print_rows_for_status blocked
} | if command -v column >/dev/null 2>&1; then
  column -t -s $'\t'
else
  cat
fi

echo
echo "Legend:"
echo "- gate: local gate profile expected before PR/merge; docs+swift-before-merge means docs profile is enough for early draft evidence, but swift profile is rerun before merge."
echo "- evidence: claim-first=not started, run:<profile>=worker should run that local gate, PR-Local-Gate=PR body must contain ## Local Gate, blocker-comment=issue comment must explain the blocker."
echo "- branch/PR/worktree are matched by the canonical '<type>/<issue>-<slug>' convention. If a field is '-', check for non-canonical names before starting duplicate work."
