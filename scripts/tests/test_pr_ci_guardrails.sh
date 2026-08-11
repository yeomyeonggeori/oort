#!/usr/bin/env bash
# Static contract for the PR trigger, #1295 generated lane, and stable required
# context. actionlint is the semantic YAML validator; these checks name the
# exact policy strings that must not quietly disappear in a later refactor.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/pr-ci.yml"
MONITOR="$REPO_ROOT/.github/workflows/track-alignment.yml"

fail() {
  echo "[pr-ci-guard-test] FAIL: $*" >&2
  exit 1
}

job_block() {
  local workflow="$1"
  local job="$2"
  awk -v marker="  ${job}:" '
    $0 == marker { active = 1 }
    active && $0 ~ /^  [[:alnum:]_-]+:$/ && $0 != marker { exit }
    active { print }
  ' "$workflow"
}

workflow_compliant() {
  local workflow="$1"
  local contract gate
  contract="$(job_block "$workflow" contract)"
  gate="$(job_block "$workflow" gate)"

  [ -n "$contract" ] && [ -n "$gate" ] || return 1
  grep -Fq 'run: npm ci --prefix clients/web-legacy' <<<"$contract" || return 1
  grep -Fq 'run: node scripts/check_npm_licenses.mjs --root clients/web-legacy' <<<"$contract" || return 1
  grep -Fq 'run: scripts/verify_web_generated_types.sh' <<<"$contract" || return 1

  for dependency in changes alignment rust node contract; do
    grep -Fq "      - $dependency" <<<"$gate" || return 1
  done
  for result in CHANGES_RESULT ALIGNMENT_RESULT RUST_RESULT NODE_RESULT CONTRACT_RESULT; do
    grep -Fq "      ${result}: \${{ needs." <<<"$gate" || return 1
  done
  # shellcheck disable=SC2016 # These are literal workflow shell contracts.
  grep -Fq 'test "$CHANGES_RESULT" = success' <<<"$gate" || return 1
  # shellcheck disable=SC2016 # These are literal workflow shell contracts.
  grep -Fq 'test "$ALIGNMENT_RESULT" = success' <<<"$gate" || return 1
  grep -Fq 'success|skipped) ;;' <<<"$gate" || return 1
  grep -Fq '*) echo "selected PR CI lane is not green:' <<<"$gate" || return 1
}

for required in \
  '      - main' \
  '      - track/engine' \
  '      - track/uxui' \
  '    name: PR CI gate' \
  'docs/api/openapi\.yaml' \
  'clients/web-legacy/' \
  'scripts/verify_web_generated_types\.sh' \
  'run: npm ci --prefix clients/web-legacy' \
  'run: node scripts/check_npm_licenses.mjs --root clients/web-legacy' \
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' \
  'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444'; do
  grep -Fq "$required" "$WORKFLOW" || fail "pr-ci missing: $required"
done

workflow_compliant "$WORKFLOW" || fail "contract/gate dependency or failure propagation drift"

# Mutation proofs: the static contract must turn red when a later refactor
# drops a selected lane, the legacy license check, or failure propagation.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp "$WORKFLOW" "$TMP_DIR/missing-alignment.yml"
sed -i.bak '/^      - alignment$/d' "$TMP_DIR/missing-alignment.yml"
if workflow_compliant "$TMP_DIR/missing-alignment.yml"; then
  fail "missing alignment dependency was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/missing-license.yml"
sed -i.bak '/check_npm_licenses\.mjs --root clients\/web-legacy/d' "$TMP_DIR/missing-license.yml"
if workflow_compliant "$TMP_DIR/missing-license.yml"; then
  fail "missing legacy license gate was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/failure-softened.yml"
sed -i.bak 's/success|skipped) ;;/success|skipped|failure) ;;/' "$TMP_DIR/failure-softened.yml"
if workflow_compliant "$TMP_DIR/failure-softened.yml"; then
  fail "failed selected lane was accepted"
fi

for required in \
  '  push:' \
  '  schedule:' \
  '  workflow_dispatch:' \
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' \
  'run: scripts/check_track_alignment.sh --remote'; do
  grep -Fq "$required" "$MONITOR" || fail "track monitor missing: $required"
done

echo "[pr-ci-guard-test] PASS targets, generated+license contract, stable fail-closed gate, mutation proofs, and monitor triggers"
