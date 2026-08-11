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

extract_change_filter() {
  local workflow="$1"
  awk '
    $0 == "      - id: filter" { saw_filter = 1; next }
    saw_filter && $0 == "        run: |" { in_script = 1; next }
    in_script && $0 == "" { print; next }
    in_script && substr($0, 1, 10) == "          " {
      print substr($0, 11)
      next
    }
    in_script { exit }
  ' "$workflow"
}

workflow_compliant() {
  local workflow="$1"
  local changes alignment rust node contract gate license_line install_line verify_line
  changes="$(job_block "$workflow" changes)"
  alignment="$(job_block "$workflow" alignment)"
  rust="$(job_block "$workflow" rust)"
  node="$(job_block "$workflow" node)"
  contract="$(job_block "$workflow" contract)"
  gate="$(job_block "$workflow" gate)"

  [ -n "$changes" ] && [ -n "$alignment" ] && [ -n "$rust" ] \
    && [ -n "$node" ] && [ -n "$contract" ] && [ -n "$gate" ] || return 1
  grep -Fq "gh api \"repos/\$REPO/pulls/\$PR\"" <<<"$changes" || return 1
  grep -Fq 'gh api --paginate --slurp' <<<"$changes" || return 1
  grep -Fq "\"repos/\$REPO/pulls/\$PR/files?per_page=100\"" <<<"$changes" || return 1
  grep -Fq '.changed_files' <<<"$changes" || return 1
  grep -Fq '3,000-file API cap is ambiguous' <<<"$changes" || return 1
  grep -Fq 'unique_count=' <<<"$changes" || return 1
  grep -Fq 'incomplete or duplicate changed-files response:' <<<"$changes" || return 1
  grep -Fq '(.filename, (.previous_filename // empty))' <<<"$changes" || return 1
  grep -Fq 'scripts/check_npm_licenses\.mjs$' <<<"$changes" || return 1
  grep -Fq 'git show "origin/main:scripts/check_track_alignment.sh"' <<<"$alignment" || return 1
  grep -Fq 'scripts/tests/test_track_alignment_guard.sh' <<<"$alignment" || return 1
  grep -Fq 'scripts/tests/test_pr_ci_guardrails.sh' <<<"$alignment" || return 1
  grep -Fq 'scripts/tests/test_github_track_guardrails.sh' <<<"$alignment" || return 1
  grep -Fq 'scripts/tests/test_policy_integrity_gate.sh' <<<"$alignment" || return 1
  grep -Fq 'scripts/tests/test_trusted_policy_runner.sh' <<<"$alignment" || return 1
  grep -Fq "if: needs.changes.outputs.rust == 'true'" <<<"$rust" || return 1
  grep -Fq "if: needs.changes.outputs.node == 'true'" <<<"$node" || return 1
  grep -Fq "if: needs.changes.outputs.contract == 'true'" <<<"$contract" || return 1
  grep -Fq 'run: node scripts/check_npm_licenses.mjs --root clients/web-legacy' <<<"$contract" || return 1
  grep -Fq 'run: npm ci --ignore-scripts --prefix clients/web-legacy' <<<"$contract" || return 1
  grep -Fq 'run: scripts/verify_web_generated_types.sh' <<<"$contract" || return 1
  license_line="$(grep -Fn 'run: node scripts/check_npm_licenses.mjs --root clients/web-legacy' <<<"$contract" | cut -d: -f1)"
  install_line="$(grep -Fn 'run: npm ci --ignore-scripts --prefix clients/web-legacy' <<<"$contract" | cut -d: -f1)"
  verify_line="$(grep -Fn 'run: scripts/verify_web_generated_types.sh' <<<"$contract" | cut -d: -f1)"
  [ "$license_line" -lt "$install_line" ] && [ "$install_line" -lt "$verify_line" ] || return 1

  for dependency in changes alignment rust node contract; do
    grep -Fq "      - $dependency" <<<"$gate" || return 1
  done
  for result in CHANGES_RESULT ALIGNMENT_RESULT RUST_RESULT NODE_RESULT CONTRACT_RESULT; do
    grep -Fq "      ${result}: \${{ needs." <<<"$gate" || return 1
  done
  for selected in RUST_SELECTED NODE_SELECTED CONTRACT_SELECTED; do
    grep -Fq "      ${selected}: \${{ needs.changes.outputs." <<<"$gate" || return 1
  done
  grep -Fq "      RUST_SELECTED: \${{ needs.changes.outputs.rust }}" <<<"$gate" || return 1
  grep -Fq "      NODE_SELECTED: \${{ needs.changes.outputs.node }}" <<<"$gate" || return 1
  grep -Fq "      CONTRACT_SELECTED: \${{ needs.changes.outputs.contract }}" <<<"$gate" || return 1
  grep -Fq '    if: always()' <<<"$gate" || return 1
  # shellcheck disable=SC2016 # These are literal workflow shell contracts.
  grep -Fq 'test "$CHANGES_RESULT" = success' <<<"$gate" || return 1
  # shellcheck disable=SC2016 # These are literal workflow shell contracts.
  grep -Fq 'test "$ALIGNMENT_RESULT" = success' <<<"$gate" || return 1
  grep -Fq 'true:success|false:skipped) ;;' <<<"$gate" || return 1
  grep -Fq 'lane selection/result mismatch:' <<<"$gate" || return 1

  # Every third-party action in the required workflow is immutable.
  if grep -E '^[[:space:]]*(- )?uses:' "$workflow" \
    | grep -Ev '@[0-9a-f]{40}([[:space:]]|$)' >/dev/null; then
    return 1
  fi
}

for required in \
  '      - main' \
  '      - track/engine' \
  '      - track/uxui' \
  '    name: PR CI gate' \
  'docs/api/openapi\.yaml' \
  'clients/web-legacy/' \
  'scripts/check_npm_licenses\.mjs$' \
  'scripts/verify_web_generated_types\.sh' \
  'run: npm ci --ignore-scripts --prefix clients/web-legacy' \
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
sed -i.bak 's/true:success|false:skipped) ;;/true:success|true:skipped|false:skipped) ;;/' "$TMP_DIR/failure-softened.yml"
if workflow_compliant "$TMP_DIR/failure-softened.yml"; then
  fail "selected skipped lane was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/missing-always.yml"
sed -i.bak '/^    if: always()$/d' "$TMP_DIR/missing-always.yml"
if workflow_compliant "$TMP_DIR/missing-always.yml"; then
  fail "gate without always() was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/wrong-selection.yml"
sed -i.bak 's/CONTRACT_SELECTED: \${{ needs.changes.outputs.contract }}/CONTRACT_SELECTED: ${{ needs.changes.outputs.node }}/' "$TMP_DIR/wrong-selection.yml"
if workflow_compliant "$TMP_DIR/wrong-selection.yml"; then
  fail "wrong selected-output mapping was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/mutable-action.yml"
sed -i.bak 's#actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1#actions/checkout@v7#g' "$TMP_DIR/mutable-action.yml"
if workflow_compliant "$TMP_DIR/mutable-action.yml"; then
  fail "mutable action tag was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/rename-source-dropped.yml"
sed -i.bak 's/(.filename, (.previous_filename \/\/ empty))/.filename/' "$TMP_DIR/rename-source-dropped.yml"
if workflow_compliant "$TMP_DIR/rename-source-dropped.yml"; then
  fail "classifier without rename source path was accepted"
fi

# Execute the exact embedded classifier with a fake GitHub API. These fixtures
# prove behavior, rather than only asserting that policy-looking strings exist.
FILTER_SCRIPT="$TMP_DIR/change-filter.sh"
extract_change_filter "$WORKFLOW" > "$FILTER_SCRIPT"
[ -s "$FILTER_SCRIPT" ] || fail "could not extract changed-files classifier"

FAKE_BIN="$TMP_DIR/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'/files?per_page=100'*) cat "$FAKE_GH_FILES" ;;
  *'/pulls/'*) cat "$FAKE_GH_METADATA" ;;
  *) echo "unexpected fake gh invocation: $*" >&2; exit 64 ;;
esac
FAKE_GH
chmod +x "$FAKE_BIN/gh"

assert_filter_fixture() {
  local name="$1"
  local metadata_json="$2"
  local pages_json="$3"
  local expected_rust="$4"
  local expected_node="$5"
  local expected_contract="$6"
  local fixture_dir="$TMP_DIR/fixture-$name"
  local key actual expected

  mkdir -p "$fixture_dir/runner"
  printf '%s\n' "$metadata_json" > "$fixture_dir/metadata.json"
  printf '%s\n' "$pages_json" > "$fixture_dir/pages.json"
  : > "$fixture_dir/output"

  if ! PATH="$FAKE_BIN:$PATH" \
    FAKE_GH_METADATA="$fixture_dir/metadata.json" \
    FAKE_GH_FILES="$fixture_dir/pages.json" \
    GITHUB_OUTPUT="$fixture_dir/output" \
    RUNNER_TEMP="$fixture_dir/runner" \
    GH_TOKEN=test REPO=example/oort PR=42 \
    bash "$FILTER_SCRIPT" > "$fixture_dir/log" 2>&1; then
    sed 's/^/[classifier] /' "$fixture_dir/log" >&2
    fail "$name classifier fixture exited non-zero"
  fi

  for key in rust node contract; do
    actual="$(awk -F= -v key="$key" '$1 == key { value = $2 } END { print value }' "$fixture_dir/output")"
    case "$key" in
      rust) expected="$expected_rust" ;;
      node) expected="$expected_node" ;;
      contract) expected="$expected_contract" ;;
    esac
    [ "$actual" = "$expected" ] \
      || fail "$name expected $key=$expected, got ${actual:-<empty>}"
  done
}

# A rename out of server-rust must still select Rust from previous_filename.
assert_filter_fixture rename-source \
  '{"changed_files":1}' \
  '[[{"filename":"docs/renamed.md","previous_filename":"server-rust/Cargo.toml","status":"renamed"}]]' \
  true false false

# Metadata says two files but pagination returned one: uncertainty runs all.
assert_filter_fixture incomplete-pages \
  '{"changed_files":2}' \
  '[[{"filename":"docs/only-one.md","status":"modified"}]]' \
  true true true

# Duplicate rows cannot masquerade as a complete two-file response.
assert_filter_fixture duplicate-pages \
  '{"changed_files":2}' \
  '[[{"filename":"docs/same.md"},{"filename":"docs/same.md"}]]' \
  true true true

# The API's documented maximum is ambiguous even before listing pages.
assert_filter_fixture api-cap \
  '{"changed_files":3000}' \
  '[[{"filename":"docs/not-consulted.md"}]]' \
  true true true
grep -Fq '3,000-file API cap is ambiguous' "$TMP_DIR/fixture-api-cap/log" \
  || fail "3,000-file fixture did not take the explicit cap fallback"

# A successful HTTP response with the wrong schema is still unknown, not empty.
assert_filter_fixture malformed-metadata \
  '{"changed_files":"2"}' \
  '[[{"filename":"docs/not-consulted.md"}]]' \
  true true true

assert_filter_fixture malformed-pages \
  '{"changed_files":1}' \
  '[[{"filename":17,"status":"modified"}]]' \
  true true true

for required in \
  '  push:' \
  '  schedule:' \
  '  workflow_dispatch:' \
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' \
  'git show origin/main:scripts/check_track_alignment.sh'; do
  grep -Fq "$required" "$MONITOR" || fail "track monitor missing: $required"
done

echo "[pr-ci-guard-test] PASS targets, complete rename-aware classifier fixtures, generated+license contract, stable fail-closed gate, mutation proofs, and monitor triggers"
