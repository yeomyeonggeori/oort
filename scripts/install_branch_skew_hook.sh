#!/usr/bin/env bash
# Explicit opt-in installer for alignment + branch-skew pre-push checks. It only
# owns pre-push and never edits post-checkout.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the momo repository" >&2
  exit 1
}
SOURCE="$REPO_ROOT/scripts/hooks/pre-push"
TARGET="$(git rev-parse --path-format=absolute --git-path hooks/pre-push)"
PREVIOUS_MANAGED_SHA256="773e243237b822c5ee4af1d7a7b0160f0608e453f306c03614b8cbbcf812daf7"
CANONICAL_REPO="yeomyeonggeori/oort"

normalize_github_repo_url() {
  local input="${1:-}"
  local path

  case "$input" in
    git@github.com:*) path="${input#git@github.com:}" ;;
    ssh://git@github.com/*) path="${input#ssh://git@github.com/}" ;;
    https://github.com/*) path="${input#https://github.com/}" ;;
    *) return 1 ;;
  esac

  case "$path" in
    *.git) path="${path%.git}" ;;
  esac
  [[ "$path" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  printf '%s\n' "$path" | tr '[:upper:]' '[:lower:]'
}

origin_url="$(git remote get-url origin 2>/dev/null)" || {
  echo "refusing install: origin URL could not be verified" >&2
  exit 1
}
origin_repo="$(normalize_github_repo_url "$origin_url")" || {
  echo "refusing install: origin is not the exact canonical GitHub repository" >&2
  exit 1
}
if [ "$origin_repo" != "$CANONICAL_REPO" ]; then
  echo "refusing install: origin is not the exact canonical GitHub repository" >&2
  exit 1
fi

remote_refs="$(git ls-remote --heads origin \
  refs/heads/main refs/heads/track/engine refs/heads/track/uxui 2>/dev/null)" || {
  echo "refusing install: origin is not reachable as the canonical maintainer remote" >&2
  exit 1
}
for required_ref in refs/heads/main refs/heads/track/engine refs/heads/track/uxui; do
  printf '%s\n' "$remote_refs" | awk '{ print $2 }' | grep -Fxq "$required_ref" || {
    echo "refusing install: origin lacks canonical ref $required_ref (OSS forks should use local gates without this maintainer hook)" >&2
    exit 1
  }
done

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    sha256sum "$1" | awk '{ print $1 }'
  fi
}

if [ -e "$TARGET" ] && ! cmp -s "$SOURCE" "$TARGET"; then
  target_sha256="$(sha256_file "$TARGET")"
  if [ "$target_sha256" = "$PREVIOUS_MANAGED_SHA256" ]; then
    backup="$TARGET.pre-1297.bak"
    if [ ! -e "$backup" ]; then
      cp -p "$TARGET" "$backup"
    fi
    echo "upgrading previous oort-managed pre-push hook (backup: $backup)"
  else
    echo "refusing to overwrite non-managed pre-push hook: $TARGET" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$TARGET")"
install -m 0755 "$SOURCE" "$TARGET"
echo "installed oort track-alignment + branch-skew pre-push hook: $TARGET"
echo "existing post-checkout hook was not modified"
