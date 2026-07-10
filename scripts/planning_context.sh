#!/usr/bin/env bash
set -euo pipefail

include_github=0

usage() {
  cat <<'EOF'
Usage: scripts/planning_context.sh [--github]

Prints the compaction-safe planning snapshot from repository files.
Use --github to append the live issue/PR/worktree board from goal_status.sh.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --github)
      include_github=1
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

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$repo_root"

printf '%s\n' '# momo planning context'
printf 'repo: %s\n' "$repo_root"
printf 'head: %s\n' "$(git rev-parse --short=12 HEAD)"

printf '\n%s\n' '## Worktree'
git status --short --branch | sed -n '1,80p'

printf '\n%s\n' '## Current semantic state'
cat docs/planning/CURRENT_STATE.md

printf '\n%s\n' '## Proposed ADRs'
found_proposed=0
while IFS= read -r adr; do
  [ -n "$adr" ] || continue
  found_proposed=1
  heading="$(sed -n '1p' "$adr")"
  status="$(rg -m1 '^> Status:|^Status:' "$adr" || true)"
  printf '%s: %s | %s\n' "$adr" "$heading" "$status"
done < <(rg -l '^> Status: Proposed|^Status: Proposed' docs/adr 2>/dev/null || true)
if [ "$found_proposed" -eq 0 ]; then
  printf '%s\n' '(none)'
fi

printf '\n%s\n' '## Pending deviations'
pending="$(awk -F '|' '/^\|/ && /\|[[:space:]]*pending[[:space:]]*\|/ { print }' docs/planning/DEVIATION_LOG.md)"
if [ -n "$pending" ]; then
  printf '%s\n' "$pending"
else
  printf '%s\n' '(none)'
fi

printf '\n%s\n' '## Latest planning journal entry'
awk '
  /^## / {
    section += 1
    if (section > 1) exit
  }
  section == 1 { print }
' docs/planning/JOURNAL.md

printf '\n%s\n' '## Dynamic implementation state'
if [ "$include_github" -eq 1 ]; then
  scripts/goal_status.sh
else
  printf '%s\n' 'Offline snapshot only. Run scripts/planning_context.sh --github for the live issue/PR/worktree board.'
fi
