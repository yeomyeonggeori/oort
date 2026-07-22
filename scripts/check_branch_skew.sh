#!/usr/bin/env bash
# Fail when upstream changed a file that this branch also changed after their
# merge-base. Shared by local_gate and the optional pre-push hook.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[branch-skew] must run inside a git repository" >&2
  exit 1
}
cd "$REPO_ROOT"

UPSTREAM_REF="${MOMO_GATE_SKEW_REF:-origin/main}"
HEAD_REF="${MOMO_GATE_HEAD_REF:-HEAD}"
OVERRIDE_REASON="${MOMO_GATE_SKIP_SKEW:-}"

if [ -n "$OVERRIDE_REASON" ]; then
  compact_reason="$(printf '%s' "$OVERRIDE_REASON" | tr '\r\n' '  ' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$compact_reason" ]; then
    echo "[branch-skew] MOMO_GATE_SKIP_SKEW must contain a non-blank reason" >&2
    exit 2
  fi
  echo "[branch-skew] OVERRIDE: $compact_reason"
  exit 0
fi

if ! git rev-parse --verify "$UPSTREAM_REF^{commit}" >/dev/null 2>&1; then
  echo "[branch-skew] upstream ref unavailable: $UPSTREAM_REF" >&2
  echo "Fetch it first, or set MOMO_GATE_SKIP_SKEW='reason' for a reviewed exception." >&2
  exit 1
fi

if ! git rev-parse --verify "$HEAD_REF^{commit}" >/dev/null 2>&1; then
  echo "[branch-skew] head ref unavailable: $HEAD_REF" >&2
  exit 1
fi

if ! MERGE_BASE="$(git merge-base "$HEAD_REF" "$UPSTREAM_REF")"; then
  echo "[branch-skew] no merge-base between $HEAD_REF and $UPSTREAM_REF" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-branch-skew.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM

git diff --name-only "$MERGE_BASE".."$HEAD_REF" | LANG=C sort -u >"$TMP_ROOT/branch-files"
git diff --name-only "$MERGE_BASE".."$UPSTREAM_REF" | LANG=C sort -u >"$TMP_ROOT/upstream-files"
comm -12 "$TMP_ROOT/branch-files" "$TMP_ROOT/upstream-files" >"$TMP_ROOT/overlap"

if [ -s "$TMP_ROOT/overlap" ]; then
  echo "[branch-skew] FAIL: $UPSTREAM_REF changed files also changed by this branch after merge-base $MERGE_BASE:" >&2
  sed 's/^/  - /' "$TMP_ROOT/overlap" >&2
  echo "Rebase onto the current target/upstream state, resolve the overlap, and rerun the gate." >&2
  echo "Reviewed exception only: MOMO_GATE_SKIP_SKEW='reason' scripts/local_gate.sh ..." >&2
  exit 1
fi

echo "[branch-skew] PASS: $HEAD_REF has no overlapping files since merge-base $MERGE_BASE against $UPSTREAM_REF"
