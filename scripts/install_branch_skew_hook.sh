#!/usr/bin/env bash
# Explicit opt-in installer. It only owns pre-push and never edits post-checkout.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the momo repository" >&2
  exit 1
}
SOURCE="$REPO_ROOT/scripts/hooks/pre-push"
TARGET="$(git rev-parse --path-format=absolute --git-path hooks/pre-push)"

if [ -e "$TARGET" ] && ! cmp -s "$SOURCE" "$TARGET"; then
  echo "refusing to overwrite existing pre-push hook: $TARGET" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
install -m 0755 "$SOURCE" "$TARGET"
echo "installed momo branch-skew pre-push hook: $TARGET"
echo "existing post-checkout hook was not modified"
