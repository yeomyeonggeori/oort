#!/usr/bin/env bash
# Drift gate for the committed release manifest (SH-1 / #1954).
#
# 1. releases/latest.json schema + sha256 digest regex + list ≠ arch
# 2. docs/SELF_HOST*.md and README.md contain zero `@sha256:` literals
# 3. manifest version matches the newest Keep-a-Changelog version heading
#
# This script is not wired into scripts/local_gate.sh (policy file). The
# orchestrator lands that separately.
set -euo pipefail

ROOT=""
MANIFEST=""
SCHEMA_ONLY=0

usage() {
  cat <<'EOF'
Usage: scripts/check_release_manifest.sh [--root DIR] [--manifest PATH] [--schema-only]

  --root DIR       Tree to check. Default: the enclosing git worktree root.
  --manifest PATH  Manifest JSON. Default: <root>/releases/latest.json
  --schema-only    Validate the JSON only (skip docs grep and CHANGELOG).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      ROOT="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST="${2:-}"
      shift 2
      ;;
    --schema-only)
      SCHEMA_ONLY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "[release-manifest] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "[release-manifest] not inside a git worktree; pass --root DIR" >&2
    exit 1
  }
fi
ROOT="$(CDPATH='' cd -- "$ROOT" && pwd)"

if [ -z "$MANIFEST" ]; then
  MANIFEST="$ROOT/releases/latest.json"
fi

need_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "[release-manifest] jq is required (not found on PATH)" >&2
    exit 1
  fi
}

fail() {
  echo "[release-manifest] FAIL: $*" >&2
  exit 1
}

DIGEST_RE='^sha256:[0-9a-f]{64}$'
APP_REF_EXPECTED='ghcr.io/yeomyeonggeori/oort'
PG_REF_EXPECTED='ghcr.io/yeomyeonggeori/oort-postgres'

validate_digest() {
  local label="$1"
  local value="$2"
  case "$value" in
    sha256:*) ;;
    *) fail "$label is not a sha256 digest: $value" ;;
  esac
  if ! printf '%s\n' "$value" | grep -Eq "$DIGEST_RE"; then
    fail "$label does not match $DIGEST_RE: $value"
  fi
}

validate_schema() {
  local path="$1"
  [ -f "$path" ] || fail "manifest missing: $path"

  local version released_at app_ref pg_ref
  local app_list app_amd64 app_arm64
  local pg_list pg_amd64 pg_arm64
  local verify_cmd release_url

  version="$(jq -er '.version | strings | select(length > 0)' "$path")" ||
    fail "version missing or not a non-empty string"
  released_at="$(jq -er '.released_at | strings | select(length > 0)' "$path")" ||
    fail "released_at missing or not a non-empty string"
  printf '%s\n' "$released_at" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}' ||
    fail "released_at is not YYYY-MM-DD…: $released_at"

  app_ref="$(jq -er '.images.app.ref | strings | select(length > 0)' "$path")" ||
    fail "images.app.ref missing"
  pg_ref="$(jq -er '.images.postgres.ref | strings | select(length > 0)' "$path")" ||
    fail "images.postgres.ref missing"
  [ "$app_ref" = "$APP_REF_EXPECTED" ] ||
    fail "images.app.ref expected $APP_REF_EXPECTED, got $app_ref"
  [ "$pg_ref" = "$PG_REF_EXPECTED" ] ||
    fail "images.postgres.ref expected $PG_REF_EXPECTED, got $pg_ref"

  app_list="$(jq -er '.images.app.digest_list | strings' "$path")" ||
    fail "images.app.digest_list missing"
  app_amd64="$(jq -er '.images.app.digests.amd64 | strings' "$path")" ||
    fail "images.app.digests.amd64 missing"
  app_arm64="$(jq -er '.images.app.digests.arm64 | strings' "$path")" ||
    fail "images.app.digests.arm64 missing"
  pg_list="$(jq -er '.images.postgres.digest_list | strings' "$path")" ||
    fail "images.postgres.digest_list missing"
  pg_amd64="$(jq -er '.images.postgres.digests.amd64 | strings' "$path")" ||
    fail "images.postgres.digests.amd64 missing"
  pg_arm64="$(jq -er '.images.postgres.digests.arm64 | strings' "$path")" ||
    fail "images.postgres.digests.arm64 missing"

  validate_digest "images.app.digest_list" "$app_list"
  validate_digest "images.app.digests.amd64" "$app_amd64"
  validate_digest "images.app.digests.arm64" "$app_arm64"
  validate_digest "images.postgres.digest_list" "$pg_list"
  validate_digest "images.postgres.digests.amd64" "$pg_amd64"
  validate_digest "images.postgres.digests.arm64" "$pg_arm64"

  [ "$app_list" != "$app_amd64" ] || fail "images.app list digest equals amd64 digest"
  [ "$app_list" != "$app_arm64" ] || fail "images.app list digest equals arm64 digest"
  [ "$app_amd64" != "$app_arm64" ] || fail "images.app amd64 digest equals arm64 digest"
  [ "$pg_list" != "$pg_amd64" ] || fail "images.postgres list digest equals amd64 digest"
  [ "$pg_list" != "$pg_arm64" ] || fail "images.postgres list digest equals arm64 digest"
  [ "$pg_amd64" != "$pg_arm64" ] || fail "images.postgres amd64 digest equals arm64 digest"
  [ "$app_list" != "$pg_list" ] || fail "app and postgres list digests are identical"

  verify_cmd="$(jq -er '.attestation.verify_cmd | strings | select(length > 0)' "$path")" ||
    fail "attestation.verify_cmd missing"
  printf '%s\n' "$verify_cmd" | grep -Fq 'gh attestation verify' ||
    fail "attestation.verify_cmd does not invoke gh attestation verify"
  printf '%s\n' "$verify_cmd" | grep -Fq "$app_list" ||
    fail "attestation.verify_cmd does not pin images.app.digest_list"

  release_url="$(jq -er '.sources.release_url | strings | select(length > 0)' "$path")" ||
    fail "sources.release_url missing"
  printf '%s\n' "$release_url" | grep -Eq '^https://github.com/.+/releases/tag/' ||
    fail "sources.release_url is not a GitHub Release tag URL: $release_url"

  echo "$version"
}

changelog_newest_version() {
  local changelog="$1"
  [ -f "$changelog" ] || fail "CHANGELOG.md missing: $changelog"
  # Skip [Unreleased]; take the first Keep-a-Changelog version heading.
  sed -n 's/^## \[\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\)].*/\1/p' "$changelog" | head -n 1
}

strip_v() {
  local v="$1"
  case "$v" in
    v*) printf '%s\n' "${v#v}" ;;
    *) printf '%s\n' "$v" ;;
  esac
}

check_docs_have_no_sha_literal() {
  local f
  local hits
  hits=0
  for f in "$ROOT"/docs/SELF_HOST*.md "$ROOT"/README.md; do
    [ -f "$f" ] || continue
    if grep -nF '@sha256:' "$f" >/dev/null 2>&1; then
      echo "[release-manifest] @sha256: literal in ${f#"$ROOT"/}:" >&2
      grep -nF '@sha256:' "$f" >&2
      hits=1
    fi
  done
  [ "$hits" -eq 0 ] || fail "docs/SELF_HOST*.md and README.md must contain 0 @sha256: literals"
}

need_jq
version="$(validate_schema "$MANIFEST")"

if [ "$SCHEMA_ONLY" -eq 1 ]; then
  echo "[release-manifest] schema ok: $MANIFEST ($version)"
  exit 0
fi

check_docs_have_no_sha_literal

changelog_ver="$(changelog_newest_version "$ROOT/CHANGELOG.md")"
[ -n "$changelog_ver" ] || fail "CHANGELOG.md has no ## [X.Y.Z] version heading"
manifest_ver="$(strip_v "$version")"
[ "$manifest_ver" = "$changelog_ver" ] ||
  fail "manifest version $version (normalized $manifest_ver) != CHANGELOG newest $changelog_ver"

echo "[release-manifest] ok: $version matches CHANGELOG $changelog_ver; prose @sha256: literals = 0"
