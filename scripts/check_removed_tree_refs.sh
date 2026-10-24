#!/usr/bin/env bash
# =============================================================================
# scripts/check_removed_tree_refs.sh — SEC-07 (#4245) dead-verifier lint.
#
# A script that launches the deleted Swift server (`swift run … MomoServer`)
# cannot run, so its green/red says nothing — yet it still looks like evidence
# in the gate and in docs. This lint turns "a script invokes a removed tree"
# into a red check:
#   - `swift run|build|test` as a command
#   - `--package-path server|workers/…|clients/macOS|clients/iOS|clients/Core`
#     (`server/Migrations` is live DDL and is NOT matched: no --package-path)
# Scope: executable shell under scripts/ (top level, lib/, hooks/) plus
# scripts/momo and scripts/oort. Comment lines are ignored. scripts/tests/ is out
# of scope: fixtures there quote these strings on purpose (negative cases).
#
# Usage: scripts/check_removed_tree_refs.sh [ROOT]   (ROOT defaults to repo root)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
ROOT="${1:-$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)}"

# file (relative to ROOT) -> reason it may still mention the pattern.
ALLOW_FILES=(
  # This file's own allowlist/pattern text.
  "scripts/check_removed_tree_refs.sh"
  # Historical MOMO-0xx issue seed table: prose in issue bodies, never executed.
  "scripts/github_bootstrap.sh"
)

# "file::literal substring" -> a line that only *matches a process name* (stale
# listener cleanup), never launches the tree.
ALLOW_LINES=(
  'scripts/momo::*"swift run --package-path server MomoServer"*)'
)

PATTERN='(^|[^[:alnum:]_-])swift[[:space:]]+(run|build|test)([[:space:]]|$)|--package-path[[:space:]]+(server|workers|clients/(macOS|iOS|Core))([/[:space:]"]|$)'

cd "$ROOT"
fail=0
while IFS= read -r f; do
  rel="${f#./}"
  skip=0
  for a in "${ALLOW_FILES[@]}"; do [ "$rel" = "$a" ] && skip=1; done
  [ "$skip" = 1 ] && continue
  skip_lines=()
  for a in "${ALLOW_LINES[@]}"; do [ "${a%%::*}" = "$rel" ] && skip_lines+=("${a#*::}"); done
  while IFS= read -r hit; do
    drop=0
    for sub in ${skip_lines[@]+"${skip_lines[@]}"}; do
      case "$hit" in *"$sub"*) drop=1 ;; esac
    done
    [ "$drop" = 1 ] && continue
    echo "[removed-tree-refs] $rel:$hit" >&2
    fail=1
  done < <(grep -nE "$PATTERN" "$f" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
done < <(find ./scripts -maxdepth 2 -type f \( -name '*.sh' -o -name momo -o -name oort \) -not -path './scripts/tests/*' | sort)

if [ "$fail" != 0 ]; then
  echo "[removed-tree-refs] FAIL: script invokes a removed tree (Swift server/workers/macOS client). Port the claim to a Rust test and delete the script (SEC-07)." >&2
  exit 1
fi
echo "[removed-tree-refs] PASS: no script invokes a removed tree"
