#!/usr/bin/env bash
# Write a sha256 checksum manifest for explicit files/directories. The manifest
# itself is excluded so every listed digest remains independently verifiable.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: scripts/write_sha256_manifest.sh MANIFEST FILE_OR_DIR..." >&2
  exit 2
fi

MANIFEST="$1"
shift
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-sha256-manifest.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM

: >"$TMP_ROOT/files"
for target in "$@"; do
  if [ -f "$target" ]; then
    printf '%s\n' "$target" >>"$TMP_ROOT/files"
  elif [ -d "$target" ]; then
    find "$target" -type f -print >>"$TMP_ROOT/files"
  else
    echo "[sha256-manifest] missing artifact target: $target" >&2
    exit 1
  fi
done

LANG=C sort -u "$TMP_ROOT/files" | grep -Fvx "$MANIFEST" >"$TMP_ROOT/files.sorted" || true
if [ ! -s "$TMP_ROOT/files.sorted" ]; then
  echo "[sha256-manifest] no artifact files to hash" >&2
  exit 1
fi

: >"$TMP_ROOT/manifest"
while IFS= read -r file; do
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" >>"$TMP_ROOT/manifest"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" >>"$TMP_ROOT/manifest"
  else
    echo "[sha256-manifest] shasum or sha256sum is required" >&2
    exit 1
  fi
done <"$TMP_ROOT/files.sorted"

mkdir -p "$(dirname "$MANIFEST")"
mv "$TMP_ROOT/manifest" "$MANIFEST"
echo "[sha256-manifest] wrote $MANIFEST ($(wc -l <"$MANIFEST" | tr -d '[:space:]') files)"
