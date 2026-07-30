#!/usr/bin/env bash
# MOMO-678: clients/web-legacy generated API types vs docs/api/openapi.yaml.
#
# clients/web-legacy is frozen as a UI (ADR-0133 moved canonical development to
# clients/web) but it is NOT dead: infra/prod/Dockerfile.web builds it,
# infra/docker-compose.e2e.yml `web-init` copies its dist, and
# scripts/verify_web_login_smoke.sh / scripts/verify_web_serving.sh drive that
# dist in a browser. It is still the client the alpha serves, so its compiled
# view of the REST contract still has to match the spec.
#
# What this asserts:
#   1. openapi-typescript re-renders src/api/schema.d.ts from the spec.
#   2. The committed file is byte-identical to that output.
#
# Why it is a script and not an inline gate one-liner (this is the MOMO-678
# repair): the previous inline step collapsed BOTH failure modes into one
# "schema.d.ts is stale" message, so a broken generator or an unparseable spec
# was reported as client staleness. It also left the regenerated file in the
# working tree on failure, which made the NEXT gate run die at the unrelated
# "worktree clean" step — a real drift signal laundered into a confusing one.
# The step was red for every run before MOMO-678 (64 documented paths committed
# vs 101 in the spec), i.e. it proved nothing at all.
#
# Failure names (each exits 1 with its own message):
#   generator-failed  — openapi-typescript did not produce output
#   spec-missing / client-missing — inputs are not where the contract says
#   types-stale       — generated output differs from the committed file
#
# Safety: src/api/schema.d.ts is snapshotted before generation and restored on
# every exit path, so a failing run never leaves the repo dirty. No Docker, no
# network beyond whatever `npm ci` already installed.
set -euo pipefail

# Not configurable on purpose: clients/web-legacy/package.json hardcodes the
# spec path in `gen:api`, so an env override here would only fake a second
# input that the generator never reads.
WEB_DIR_REL="clients/web-legacy"
SPEC_REL="docs/api/openapi.yaml"
GENERATED_REL="src/api/schema.d.ts"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "must run inside a git repository"
fi
cd "$REPO_ROOT"

WEB_DIR="$REPO_ROOT/$WEB_DIR_REL"
SPEC="$REPO_ROOT/$SPEC_REL"
GENERATED="$WEB_DIR/$GENERATED_REL"

[ -f "$SPEC" ] || fail "spec-missing: $SPEC_REL not found"
[ -d "$WEB_DIR" ] || fail "client-missing: $WEB_DIR_REL not found"
[ -f "$GENERATED" ] || fail "client-missing: $WEB_DIR_REL/$GENERATED_REL is not committed"
[ -d "$WEB_DIR/node_modules" ] ||
  fail "client-missing: $WEB_DIR_REL/node_modules absent — run (cd $WEB_DIR_REL && npm ci) first"

BASELINE="$(mktemp "${TMPDIR:-/tmp}/momo-web-types.XXXXXX")"
cp "$GENERATED" "$BASELINE"

restore() {
  # Always put the pre-run bytes back, whether we passed, drifted, or the
  # generator crashed halfway through writing the file. The gate runs the
  # worktree-clean guard first, so those bytes are HEAD's.
  cp "$BASELINE" "$GENERATED"
  rm -f "$BASELINE"
}
trap restore EXIT INT TERM

# Run the exact command the README and the fix hint tell developers to run, so
# the gate cannot verify a different invocation than the one people use.
GEN_LOG="$(mktemp "${TMPDIR:-/tmp}/momo-web-types-log.XXXXXX")"
if ! (cd "$WEB_DIR" && npm run generate:types) >"$GEN_LOG" 2>&1; then
  echo "--- npm run generate:types output ---" >&2
  cat "$GEN_LOG" >&2
  rm -f "$GEN_LOG"
  fail "generator-failed: (cd $WEB_DIR_REL && npm run generate:types) exited non-zero. This is NOT a staleness failure — the spec is unparseable or openapi-typescript is missing/broken. Fix the generator or the spec first."
fi
rm -f "$GEN_LOG"

if [ ! -s "$GENERATED" ]; then
  fail "generator-failed: openapi-typescript exited 0 but wrote an empty $WEB_DIR_REL/$GENERATED_REL"
fi

if ! diff -q "$BASELINE" "$GENERATED" >/dev/null 2>&1; then
  echo "committed $WEB_DIR_REL/$GENERATED_REL no longer matches $SPEC_REL." >&2
  echo "--- first 60 diff lines (committed -> regenerated) ---" >&2
  diff -u "$BASELINE" "$GENERATED" | head -n 60 >&2 || true
  echo "--- documented top-level paths ---" >&2
  printf 'committed:   %s\n' "$(grep -cE '^ +"/' "$BASELINE" || true)" >&2
  printf 'regenerated: %s\n' "$(grep -cE '^ +"/' "$GENERATED" || true)" >&2
  fail "types-stale: run (cd $WEB_DIR_REL && npm run generate:types) and commit $GENERATED_REL in the same PR as the spec change."
fi

pass "generated types match $SPEC_REL ($(grep -cE '^ +"/' "$GENERATED" || true) documented paths in $WEB_DIR_REL/$GENERATED_REL)"
