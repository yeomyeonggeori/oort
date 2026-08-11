#!/usr/bin/env bash
# Trusted policy-change evaluator and merge-time workflow provenance verifier.
#
# --evaluate is called only from the base-controlled pull_request_target
# workflow. It reads PR metadata through the GitHub API; it never fetches or
# executes the candidate tree.
#
# --verify-run is the local momo-main merge gate. A same-name status produced
# by the GitHub Actions App is not sufficient: the status target must resolve
# to this exact trusted workflow, event, run attempt, PR head/base binding, and
# successful evaluator job.
set -euo pipefail

MODE=""
REPO=""
PR_NUMBER=""
EXPECTED_HEAD_SHA=""
EXPECTED_BASE_REF=""
EXPECTED_BASE_SHA=""
PROVENANCE_OUTPUT=""
GH_BIN="${MOMO_GH_BIN:-gh}"

POLICY_CONTEXT="Policy integrity gate"
POLICY_WORKFLOW_PATH=".github/workflows/policy-integrity.yml"
POLICY_WORKFLOW_API_NAME="policy-integrity.yml"
POLICY_WORKFLOW_NAME="policy-integrity"
POLICY_JOB_NAME="Trusted policy integrity evaluator"
POLICY_LABEL="policy-change-approved"
POLICY_AUTHOR="kwakseongjae"
POLICY_AUTHOR_ID=87296259
AUDIT_PREFIX="Policy-Integrity-Audit:"
CANONICAL_BASES=(main track/engine track/uxui)

usage() {
  cat <<'EOF'
Usage:
  scripts/verify_policy_integrity.sh --evaluate --repo OWNER/REPO --pr N \
    --expected-head SHA --expected-base BRANCH --expected-base-sha SHA

  scripts/verify_policy_integrity.sh --verify-run --repo OWNER/REPO --pr N \
    [--expected-base BRANCH] [--expected-base-sha SHA] [--output FILE]

`--evaluate` is for the base-controlled pull_request_target workflow only.
`--verify-run` is the required local pre-merge provenance check. It does not
trust a same-name GitHub Actions status by itself.
EOF
}

fail() {
  echo "[policy-integrity] FAIL: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --evaluate)
      [ -z "$MODE" ] || fail "choose exactly one mode"
      MODE="evaluate"
      shift
      ;;
    --verify-run)
      [ -z "$MODE" ] || fail "choose exactly one mode"
      MODE="verify-run"
      shift
      ;;
    --repo)
      [ "$#" -ge 2 ] || fail "--repo needs OWNER/REPO"
      REPO="$2"
      shift 2
      ;;
    --pr)
      [ "$#" -ge 2 ] || fail "--pr needs a pull request number"
      PR_NUMBER="$2"
      shift 2
      ;;
    --expected-head)
      [ "$#" -ge 2 ] || fail "--expected-head needs a SHA"
      EXPECTED_HEAD_SHA="$2"
      shift 2
      ;;
    --expected-base)
      [ "$#" -ge 2 ] || fail "--expected-base needs a branch"
      EXPECTED_BASE_REF="$2"
      shift 2
      ;;
    --expected-base-sha)
      [ "$#" -ge 2 ] || fail "--expected-base-sha needs a SHA"
      EXPECTED_BASE_SHA="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || fail "--output needs a file"
      PROVENANCE_OUTPUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$MODE" ] || { usage >&2; exit 2; }
printf '%s\n' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' \
  || fail "invalid repository slug: ${REPO:-<empty>}"
printf '%s\n' "$PR_NUMBER" | grep -Eq '^[1-9][0-9]*$' \
  || fail "invalid pull request number: ${PR_NUMBER:-<empty>}"
command -v "$GH_BIN" >/dev/null 2>&1 || fail "gh CLI is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
"$GH_BIN" --version >/dev/null 2>&1 || fail "gh CLI is unavailable"

if [ -n "$EXPECTED_HEAD_SHA" ]; then
  printf '%s\n' "$EXPECTED_HEAD_SHA" | grep -Eq '^[0-9a-f]{40}$' \
    || fail "--expected-head must be a lowercase 40-character SHA"
fi
if [ -n "$EXPECTED_BASE_SHA" ]; then
  printf '%s\n' "$EXPECTED_BASE_SHA" | grep -Eq '^[0-9a-f]{40}$' \
    || fail "--expected-base-sha must be a lowercase 40-character SHA"
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-policy-integrity.XXXXXX")"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT INT TERM

api_object() {
  local endpoint="$1"
  local output="$2"
  if ! "$GH_BIN" api "$endpoint" >"$output"; then
    echo "[policy-integrity] API GET failed: $endpoint" >&2
    return 1
  fi
  if ! jq -e 'type == "object"' "$output" >/dev/null 2>&1; then
    echo "[policy-integrity] API returned malformed object: $endpoint" >&2
    return 1
  fi
}

api_pages() {
  local endpoint="$1"
  local output="$2"
  if ! "$GH_BIN" api --paginate --slurp "$endpoint" >"$output"; then
    echo "[policy-integrity] paginated API GET failed: $endpoint" >&2
    return 1
  fi
  if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "array")' \
    "$output" >/dev/null 2>&1; then
    echo "[policy-integrity] paginated API returned malformed pages: $endpoint" >&2
    return 1
  fi
}

api_job_pages() {
  local endpoint="$1"
  local output="$2"
  local total_count row_count unique_count
  if ! "$GH_BIN" api --paginate --slurp "$endpoint" >"$output"; then
    echo "[policy-integrity] paginated API GET failed: $endpoint" >&2
    return 1
  fi
  if ! jq -e '
    type == "array" and length > 0 and
    all(.[];
      type == "object" and
      (.total_count | type == "number" and floor == . and . >= 0) and
      (.jobs | type == "array")) and
    ([.[].total_count] | unique | length) == 1
  ' "$output" >/dev/null 2>&1; then
    echo "[policy-integrity] paginated jobs API returned malformed pages: $endpoint" >&2
    return 1
  fi
  total_count="$(jq -r '.[0].total_count' "$output")"
  row_count="$(jq -r '[.[].jobs[]] | length' "$output")"
  unique_count="$(jq -r '[.[].jobs[].id] | unique | length' "$output")"
  if [ "$row_count" -ne "$total_count" ] || [ "$unique_count" -ne "$total_count" ]; then
    echo "[policy-integrity] jobs pagination is incomplete or duplicated: expected=$total_count rows=$row_count unique=$unique_count" >&2
    return 1
  fi
}

canonical_base() {
  local candidate="$1"
  local base
  for base in "${CANONICAL_BASES[@]}"; do
    [ "$candidate" = "$base" ] && return 0
  done
  return 1
}

validate_pr() {
  local json="$1"
  jq -e '
    type == "object" and
    (.number | type == "number" and floor == . and . > 0) and
    (.state == "open") and
    (.user.login | type == "string" and length > 0) and
    (.user.id | type == "number" and floor == . and . > 0) and
    (.head.ref | type == "string" and length > 0) and
    (.head.sha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.base.ref | type == "string" and length > 0) and
    (.base.sha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.changed_files | type == "number" and floor == . and . >= 0) and
    (.labels | type == "array") and
    all(.labels[]; (.name | type == "string" and length > 0))
  ' "$json" >/dev/null 2>&1
}

read_pr() {
  local output="$1"
  api_object "repos/$REPO/pulls/$PR_NUMBER" "$output" \
    || fail "pull request metadata is unavailable"
  validate_pr "$output" || fail "pull request metadata has an invalid shape or PR is not open"
  [ "$(jq -r '.number' "$output")" = "$PR_NUMBER" ] \
    || fail "pull request number mismatch"
}

policy_path() {
  case "$1" in
    AGENTS.md|\
    CODEX.md|\
    CONTRIBUTING.md|\
    .github/workflows/*|\
    .github/labels.json|\
    deny.toml|\
    scripts/check_branch_skew.sh|\
    scripts/check_track_alignment.sh|\
    scripts/github_track_guardrails.sh|\
    scripts/hooks/pre-push|\
    scripts/install_branch_skew_hook.sh|\
    scripts/local_gate.sh|\
    scripts/verify_merge_tree.sh|\
    scripts/check_npm_licenses.mjs|\
    scripts/check_cargo_licenses.sh|\
    scripts/github_bootstrap.sh|\
    scripts/verify_web_generated_types.sh|\
    scripts/verify_policy_integrity.sh|\
    scripts/verify_policy_integrity_from_base.sh|\
    docs/GITHUB_OPS.md|\
    docs/LOCAL_PR_GATE.md|\
    docs/TRACKS.md|\
    docs/adr/0153-ci-stack-selfhosted-runners.md|\
    scripts/tests/test_track_alignment_guard.sh|\
    scripts/tests/test_github_track_guardrails.sh|\
    scripts/tests/test_pr_ci_guardrails.sh|\
    scripts/tests/test_local_gate_hardening.sh|\
    scripts/tests/test_license_gate.sh|\
    scripts/tests/test_policy_integrity_gate.sh|\
    scripts/tests/test_trusted_policy_runner.sh|\
    scripts/tests/fixtures/policy-integrity/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

select_audit_evidence() {
  local comments="$1"
  local events="$2"
  local head="$3"
  local approval_output="$4"
  local label_output="$5"
  local approval_actor approval_actor_id approval_epoch

  if ! jq -e '
    all(.[][];
      type == "object" and
      (.id | type == "number" and floor == . and . > 0) and
      (.user.login | type == "string" and length > 0) and
      (.user.id | type == "number" and floor == . and . > 0) and
      (.author_association | type == "string") and
      (.body | type == "string") and
      (.created_at | type == "string") and
      (.updated_at | type == "string"))
  ' "$comments" >/dev/null 2>&1; then
    fail "policy audit comments response is malformed"
  fi
  if ! jq -e \
    --arg marker "$AUDIT_PREFIX $head" \
    --arg owner "$POLICY_AUTHOR" \
    --argjson owner_id "$POLICY_AUTHOR_ID" '
    [.[][]
      | select(.user.login == $owner and .user.id == $owner_id)
      | select((.body | gsub("\\r"; "") | split("\n") | index($marker)) != null)
      | {
          id,
          actor: .user.login,
          actor_id: .user.id,
          association: .author_association,
          body,
          created_at,
          updated_at,
          audit_epoch: (try (.updated_at | fromdateiso8601) catch null)
        }
      | select(.audit_epoch != null)]
    | sort_by([.audit_epoch, .id])
    | last
    | select(type == "object")
  ' "$comments" >"$approval_output"; then
    fail "missing designated policy-owner audit comment for exact current head: $AUDIT_PREFIX $head"
  fi
  approval_actor="$(jq -r '.actor' "$approval_output")"
  approval_actor_id="$(jq -r '.actor_id' "$approval_output")"
  approval_epoch="$(jq -r '.audit_epoch' "$approval_output")"

  if ! jq -e '
    all(.[][];
      type == "object" and
      (.id | type == "number" and floor == . and . > 0) and
      (.event | type == "string") and
      (.created_at | type == "string") and
      ((.actor == null) or (
        (.actor.login | type == "string" and length > 0) and
        (.actor.id | type == "number" and floor == . and . > 0))) and
      ((.label == null) or (.label.name | type == "string")))
  ' "$events" >/dev/null 2>&1; then
    fail "policy label audit events response is malformed"
  fi

  # Current-label provenance is the final transition for this exact label, not
  # any historical designated-owner event. This rejects owner label ->
  # non-owner unlabel/relabel and owner label -> later unlabel histories.
  if ! jq -e \
    --arg label "$POLICY_LABEL" \
    --arg actor "$approval_actor" \
    --argjson actor_id "$approval_actor_id" \
    --argjson approval_epoch "$approval_epoch" '
    [.[][]
      | select((.event == "labeled" or .event == "unlabeled") and .label.name == $label)
      | {
          id,
          event,
          actor: (.actor.login // null),
          actor_id: (.actor.id // null),
          label: .label.name,
          created_at,
          label_epoch: (try (.created_at | fromdateiso8601) catch null)
        }
      | select(.label_epoch != null)]
    | sort_by([.label_epoch, .id])
    | last
    | select(
        type == "object" and
        .event == "labeled" and
        .actor == $actor and
        .actor_id == $actor_id and
        .label_epoch > $approval_epoch)
  ' "$events" >"$label_output"; then
    fail "latest $POLICY_LABEL transition was not applied by the same designated policy owner after the exact-head audit comment"
  fi
}

assert_expected_binding() {
  local json="$1"
  local head base base_sha
  head="$(jq -r '.head.sha' "$json")"
  base="$(jq -r '.base.ref' "$json")"
  base_sha="$(jq -r '.base.sha' "$json")"
  canonical_base "$base" || fail "PR base is not canonical: $base"
  [ -z "$EXPECTED_HEAD_SHA" ] || [ "$head" = "$EXPECTED_HEAD_SHA" ] \
    || fail "PR head does not match the trusted event head"
  [ -z "$EXPECTED_BASE_REF" ] || [ "$base" = "$EXPECTED_BASE_REF" ] \
    || fail "PR base does not match the expected canonical branch"
  [ -z "$EXPECTED_BASE_SHA" ] || [ "$base_sha" = "$EXPECTED_BASE_SHA" ] \
    || fail "PR base SHA does not match the trusted event/base snapshot"
}

evaluate_policy_change() {
  [ -n "$EXPECTED_HEAD_SHA" ] || fail "--evaluate requires --expected-head"
  [ -n "$EXPECTED_BASE_REF" ] || fail "--evaluate requires --expected-base"
  [ -n "$EXPECTED_BASE_SHA" ] || fail "--evaluate requires --expected-base-sha"

  local initial="$TEMP_ROOT/pr-initial.json"
  local mid="$TEMP_ROOT/pr-mid.json"
  local final="$TEMP_ROOT/pr-final.json"
  local pages="$TEMP_ROOT/files-pages.json"
  local paths="$TEMP_ROOT/changed-paths.txt"
  local policy_paths="$TEMP_ROOT/policy-paths.txt"
  local comments="$TEMP_ROOT/comments-pages.json"
  local events="$TEMP_ROOT/events-pages.json"
  local approval="$TEMP_ROOT/approval.json"
  local label_event="$TEMP_ROOT/label-event.json"
  local comments_final="$TEMP_ROOT/comments-pages-final.json"
  local events_final="$TEMP_ROOT/events-pages-final.json"
  local approval_final="$TEMP_ROOT/approval-final.json"
  local label_event_final="$TEMP_ROOT/label-event-final.json"
  local expected_count row_count unique_count initial_head initial_head_ref initial_base initial_base_sha
  local initial_author initial_author_id initial_changed path

  read_pr "$initial"
  assert_expected_binding "$initial"
  initial_head="$(jq -r '.head.sha' "$initial")"
  initial_head_ref="$(jq -r '.head.ref' "$initial")"
  initial_base="$(jq -r '.base.ref' "$initial")"
  initial_base_sha="$(jq -r '.base.sha' "$initial")"
  initial_author="$(jq -r '.user.login' "$initial")"
  initial_author_id="$(jq -r '.user.id' "$initial")"
  initial_changed="$(jq -r '.changed_files' "$initial")"
  expected_count="$initial_changed"
  [ "$expected_count" -lt 3000 ] \
    || fail "3,000-file GitHub API cap makes changed-file classification ambiguous"

  api_pages "repos/$REPO/pulls/$PR_NUMBER/files?per_page=100" "$pages" \
    || fail "changed-file classification is unavailable"
  if ! jq -e '
    all(.[][];
      type == "object" and
      (.filename | type == "string" and length > 0 and (contains("\n") | not) and (contains("\r") | not)) and
      (.status | type == "string" and length > 0) and
      ((has("previous_filename") | not) or .previous_filename == null or
        (.previous_filename | type == "string" and length > 0 and
          (contains("\n") | not) and (contains("\r") | not))) and
      ((.status != "renamed") or
        (.previous_filename | type == "string" and length > 0))
    )
  ' "$pages" >/dev/null 2>&1; then
    fail "changed-files response has an invalid or ambiguous shape"
  fi
  row_count="$(jq -r '[.[][]] | length' "$pages")"
  unique_count="$(jq -r '[.[][] | .filename] | unique | length' "$pages")"
  if [ "$row_count" -ne "$expected_count" ] || [ "$unique_count" -ne "$expected_count" ]; then
    fail "incomplete or duplicate changed-files response: expected=$expected_count rows=$row_count unique=$unique_count"
  fi
  [ "$row_count" -lt 3000 ] \
    || fail "3,000-file GitHub API cap makes changed-file retrieval ambiguous"

  jq -r '[.[][] | (.filename, (.previous_filename // empty))] | unique[]' \
    "$pages" >"$paths"
  : >"$policy_paths"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if policy_path "$path"; then
      printf '%s\n' "$path" >>"$policy_paths"
    fi
  done <"$paths"

  if [ -s "$policy_paths" ]; then
    echo "[policy-integrity] protected policy paths changed:"
    sed 's/^/[policy-integrity]   /' "$policy_paths"
    if [ "$initial_author" != "$POLICY_AUTHOR" ] \
      || [ "$initial_author_id" != "$POLICY_AUTHOR_ID" ]; then
      fail "protected policy changes require designated policy-owner author $POLICY_AUTHOR/$POLICY_AUTHOR_ID"
    fi

    api_pages "repos/$REPO/issues/$PR_NUMBER/comments?per_page=100" "$comments" \
      || fail "policy audit comments are unavailable"
    api_pages "repos/$REPO/issues/$PR_NUMBER/events?per_page=100" "$events" \
      || fail "policy label audit events are unavailable"
    select_audit_evidence "$comments" "$events" "$initial_head" \
      "$approval" "$label_event"
  else
    echo "[policy-integrity] no protected policy path changed"
  fi

  # Bind the first evidence read to the unchanged PR before collecting it a
  # second time. The last PR read below closes the second evidence window.
  read_pr "$mid"
  assert_expected_binding "$mid"
  jq -e \
    --arg head "$initial_head" \
    --arg head_ref "$initial_head_ref" \
    --arg base "$initial_base" \
    --arg base_sha "$initial_base_sha" \
    --arg author "$initial_author" \
    --argjson author_id "$initial_author_id" \
    --argjson changed "$initial_changed" '
    .head.sha == $head and
    .head.ref == $head_ref and
    .base.ref == $base and
    .base.sha == $base_sha and
    .user.login == $author and
    .user.id == $author_id and
    .changed_files == $changed
  ' "$mid" >/dev/null || fail "PR head/base/metadata changed during policy evaluation"
  if [ -s "$policy_paths" ]; then
    jq -e --arg label "$POLICY_LABEL" 'any(.labels[]; .name == $label)' \
      "$mid" >/dev/null \
      || fail "required current label is missing: $POLICY_LABEL"

    api_pages "repos/$REPO/issues/$PR_NUMBER/comments?per_page=100" "$comments_final" \
      || fail "final policy audit comments are unavailable"
    api_pages "repos/$REPO/issues/$PR_NUMBER/events?per_page=100" "$events_final" \
      || fail "final policy label audit events are unavailable"
    select_audit_evidence "$comments_final" "$events_final" "$initial_head" \
      "$approval_final" "$label_event_final"
    cmp -s "$approval" "$approval_final" \
      || fail "selected policy audit comment changed during evaluation"
    cmp -s "$label_event" "$label_event_final" \
      || fail "latest policy label transition changed during evaluation"
  fi

  read_pr "$final"
  assert_expected_binding "$final"
  jq -e \
    --arg head "$initial_head" \
    --arg head_ref "$initial_head_ref" \
    --arg base "$initial_base" \
    --arg base_sha "$initial_base_sha" \
    --arg author "$initial_author" \
    --argjson author_id "$initial_author_id" \
    --argjson changed "$initial_changed" '
    .head.sha == $head and
    .head.ref == $head_ref and
    .base.ref == $base and
    .base.sha == $base_sha and
    .user.login == $author and
    .user.id == $author_id and
    .changed_files == $changed
  ' "$final" >/dev/null || fail "PR head/base/metadata changed during final policy evaluation"
  if [ -s "$policy_paths" ]; then
    jq -e --arg label "$POLICY_LABEL" 'any(.labels[]; .name == $label)' \
      "$final" >/dev/null \
      || fail "required current label is missing at final read: $POLICY_LABEL"
  fi

  echo "[policy-integrity] PASS evaluation: pr=$PR_NUMBER head=$initial_head base=$initial_base@$initial_base_sha"
}

verify_run_provenance() {
  local initial="$TEMP_ROOT/verify-pr-initial.json"
  local final="$TEMP_ROOT/verify-pr-final.json"
  local workflow="$TEMP_ROOT/workflow.json"
  local workflow_final="$TEMP_ROOT/workflow-final.json"
  local repo_metadata="$TEMP_ROOT/repository.json"
  local repo_metadata_final="$TEMP_ROOT/repository-final.json"
  local authority_branch="$TEMP_ROOT/authority-branch.json"
  local authority_branch_final="$TEMP_ROOT/authority-branch-final.json"
  local statuses="$TEMP_ROOT/status-pages.json"
  local status="$TEMP_ROOT/status.json"
  local run="$TEMP_ROOT/run.json"
  local suite="$TEMP_ROOT/check-suite.json"
  local jobs="$TEMP_ROOT/jobs-pages.json"
  local head head_ref base base_sha authority_ref authority_sha workflow_id workflow_run_path run_workflow_path
  local target_url target_prefix target_rest
  local run_id attempt expected_url
  local expected_title check_suite_id app_id run_execution_sha run_execution_branch

  read_pr "$initial"
  assert_expected_binding "$initial"
  head="$(jq -r '.head.sha' "$initial")"
  head_ref="$(jq -r '.head.ref' "$initial")"
  base="$(jq -r '.base.ref' "$initial")"
  base_sha="$(jq -r '.base.sha' "$initial")"

  api_object "repos/$REPO" "$repo_metadata" \
    || fail "repository default-branch metadata is unavailable"
  if ! authority_ref="$(jq -er '
    .default_branch
    | select(type == "string" and . == "main")
  ' "$repo_metadata")"; then
    fail "repository default branch is not canonical main"
  fi
  workflow_run_path="$POLICY_WORKFLOW_PATH@$authority_ref"
  api_object "repos/$REPO/branches/$authority_ref" "$authority_branch" \
    || fail "current default-branch authority is unavailable"
  if ! authority_sha="$(jq -er --arg branch "$authority_ref" '
    select(.name == $branch)
    | .commit.sha
    | select(type == "string" and test("^[0-9a-f]{40}$"))
  ' "$authority_branch")"; then
    fail "current default-branch authority has an invalid shape"
  fi

  api_object "repos/$REPO/actions/workflows/$POLICY_WORKFLOW_API_NAME" "$workflow" \
    || fail "trusted policy workflow is unavailable"
  if ! workflow_id="$(jq -er --arg path "$POLICY_WORKFLOW_PATH" --arg name "$POLICY_WORKFLOW_NAME" '
    select(.path == $path and .name == $name and .state == "active")
    | .id | select(type == "number" and floor == . and . > 0)
  ' "$workflow")"; then
    fail "trusted policy workflow identity/path/state is invalid"
  fi

  api_pages "repos/$REPO/commits/$head/statuses?per_page=100" "$statuses" \
    || fail "PR-head commit statuses are unavailable"
  if ! jq -e '
    all(.[][];
      type == "object" and
      (.id | type == "number" and floor == . and . > 0) and
      (.context | type == "string" and length > 0) and
      (.state | type == "string" and length > 0) and
      ((.target_url == null) or (.target_url | type == "string")) and
      (.created_at | type == "string") and
      (.creator.login | type == "string" and length > 0))
  ' "$statuses" >/dev/null 2>&1; then
    fail "PR-head commit statuses response is malformed"
  fi
  if ! jq -e --arg context "$POLICY_CONTEXT" '
    [.[][] | select(.context == $context)]
    | sort_by([.created_at, .id])
    | last
    | select(type == "object")
  ' "$statuses" >"$status"; then
    fail "latest '$POLICY_CONTEXT' status is missing on current PR head"
  fi
  jq -e --arg head "$head" '
    .state == "success" and
    .sha == $head and
    .creator.login == "github-actions[bot]" and
    (.target_url | type == "string")
  ' "$status" >/dev/null \
    || fail "latest '$POLICY_CONTEXT' status is not a successful GitHub Actions status for the current head"
  target_url="$(jq -r '.target_url' "$status")"
  case "$target_url" in
    "https://github.com/$REPO/actions/runs/"*"/attempts/"*) ;;
    *) fail "policy status target_url is not an exact GitHub Actions run attempt URL" ;;
  esac
  target_prefix="https://github.com/$REPO/actions/runs/"
  target_rest="${target_url#"$target_prefix"}"
  [ "$target_rest" != "$target_url" ] \
    || fail "policy status target_url has an invalid run prefix"
  run_id="${target_rest%%/attempts/*}"
  attempt="${target_rest#*/attempts/}"
  [ "$target_rest" = "$run_id/attempts/$attempt" ] \
    || fail "policy status target_url has an invalid run/attempt shape"
  printf '%s\n' "$run_id" | grep -Eq '^[1-9][0-9]*$' \
    || fail "policy status target_url has an invalid run id"
  printf '%s\n' "$attempt" | grep -Eq '^[1-9][0-9]*$' \
    || fail "policy status target_url has an invalid run attempt"
  expected_url="https://github.com/$REPO/actions/runs/$run_id/attempts/$attempt"
  [ "$target_url" = "$expected_url" ] || fail "policy status target_url is not canonical"

  api_object "repos/$REPO/actions/runs/$run_id/attempts/$attempt" "$run" \
    || fail "trusted workflow run attempt is unavailable"
  expected_title="policy-integrity authority=$authority_sha pr=$PR_NUMBER head=$head base=$base@$base_sha"
  # GitHub's event execution SHA and the Actions REST run head fields have
  # distinct documented/observed semantics for pull_request_target. Until the
  # first live bootstrap capture, do not guess whether these fields represent
  # PR-head or workflow authority. Require a valid internal run/suite/job
  # binding; the exact PR head/base and workflow authority are bound separately
  # by the status SHA and immutable base-controlled run-name.
  if ! jq -e \
    --argjson run_id "$run_id" \
    --argjson attempt "$attempt" \
    --argjson workflow_id "$workflow_id" \
    --arg bare_path "$POLICY_WORKFLOW_PATH" \
    --arg authority_path "$workflow_run_path" \
    --arg event "pull_request_target" \
    --arg title "$expected_title" '
    .id == $run_id and
    .run_attempt == $attempt and
    .workflow_id == $workflow_id and
    (.path == $bare_path or .path == $authority_path) and
    .event == $event and
    (.head_branch | type == "string" and length > 0) and
    (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
    .display_title == $title and
    .status == "completed" and
    .conclusion == "success" and
    (.check_suite_id | type == "number" and floor == . and . > 0)
  ' "$run" >/dev/null; then
    fail "status target does not match the exact trusted workflow/event/attempt/current head-base binding"
  fi
  check_suite_id="$(jq -r '.check_suite_id' "$run")"
  run_workflow_path="$(jq -r '.path' "$run")"
  run_execution_sha="$(jq -r '.head_sha' "$run")"
  run_execution_branch="$(jq -r '.head_branch' "$run")"

  api_object "repos/$REPO/check-suites/$check_suite_id" "$suite" \
    || fail "trusted workflow check suite is unavailable"
  if ! app_id="$(jq -er \
    --argjson suite_id "$check_suite_id" \
    --arg run_execution_sha "$run_execution_sha" '
    select(.id == $suite_id and .head_sha == $run_execution_sha)
    | select(.app.slug == "github-actions")
    | .app.id
    | select(type == "number" and floor == . and . > 0)
  ' "$suite")"; then
    fail "trusted workflow check suite GitHub Actions provenance is invalid"
  fi

  api_job_pages "repos/$REPO/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100" "$jobs" \
    || fail "trusted workflow run-attempt jobs are unavailable"
  if ! jq -e '
    all(.[].jobs[];
      type == "object" and
      (.id | type == "number" and floor == . and . > 0) and
      (.run_id | type == "number" and floor == . and . > 0) and
      (.name | type == "string" and length > 0) and
      (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
      (.status | type == "string") and
      ((.conclusion == null) or (.conclusion | type == "string")))
  ' "$jobs" >/dev/null 2>&1; then
    fail "trusted workflow jobs response is malformed"
  fi
  if ! jq -e \
    --argjson run_id "$run_id" \
    --arg job "$POLICY_JOB_NAME" \
    --arg run_execution_sha "$run_execution_sha" '
    [.[].jobs[] | select(.run_id == $run_id and .name == $job and .head_sha == $run_execution_sha)] as $matches
    | ($matches | length) == 1 and
      $matches[0].status == "completed" and
      $matches[0].conclusion == "success"
  ' "$jobs" >/dev/null; then
    fail "exact trusted evaluator job is missing, duplicated, or not successful"
  fi

  # A successful historical run is not enough: comments can be edited/deleted
  # without triggering pull_request_target, and labels can be cycled. Re-run
  # the same trusted metadata evaluator against the live head immediately
  # before the final provenance reads.
  EXPECTED_HEAD_SHA="$head"
  EXPECTED_BASE_REF="$base"
  EXPECTED_BASE_SHA="$base_sha"
  evaluate_policy_change

  # Close both PR and workflow-identity races after every provenance and live
  # policy-evidence query.
  read_pr "$final"
  jq -e \
    --arg head "$head" --arg head_ref "$head_ref" \
    --arg base "$base" --arg base_sha "$base_sha" '
    .head.sha == $head and .head.ref == $head_ref and
    .base.ref == $base and .base.sha == $base_sha
  ' "$final" >/dev/null || fail "PR head/base changed during provenance verification"
  api_object "repos/$REPO/actions/workflows/$POLICY_WORKFLOW_API_NAME" "$workflow_final" \
    || fail "trusted policy workflow disappeared during provenance verification"
  jq -e \
    --argjson id "$workflow_id" --arg path "$POLICY_WORKFLOW_PATH" \
    --arg name "$POLICY_WORKFLOW_NAME" '
    .id == $id and .path == $path and .name == $name and .state == "active"
  ' "$workflow_final" >/dev/null \
    || fail "trusted policy workflow identity changed during provenance verification"
  api_object "repos/$REPO" "$repo_metadata_final" \
    || fail "repository default-branch metadata disappeared during provenance verification"
  jq -e --arg authority_ref "$authority_ref" \
    '.default_branch == $authority_ref' "$repo_metadata_final" >/dev/null \
    || fail "repository default branch changed during provenance verification"
  api_object "repos/$REPO/branches/$authority_ref" "$authority_branch_final" \
    || fail "default-branch authority disappeared during provenance verification"
  jq -e --arg branch "$authority_ref" --arg sha "$authority_sha" '
    .name == $branch and .commit.sha == $sha
  ' "$authority_branch_final" >/dev/null \
    || fail "default-branch authority moved during provenance verification; require a fresh policy run"

  if [ -n "$PROVENANCE_OUTPUT" ]; then
    jq -n \
      --arg repo "$REPO" \
      --argjson pr "$PR_NUMBER" \
      --arg head "$head" \
      --arg base "$base" \
      --arg base_sha "$base_sha" \
      --arg authority_ref "$authority_ref" \
      --arg authority_sha "$authority_sha" \
      --arg context "$POLICY_CONTEXT" \
      --argjson workflow_id "$workflow_id" \
      --arg workflow_path "$POLICY_WORKFLOW_PATH" \
      --arg workflow_run_path "$run_workflow_path" \
      --arg event "pull_request_target" \
      --argjson run_id "$run_id" \
      --argjson run_attempt "$attempt" \
      --arg run_execution_branch "$run_execution_branch" \
      --arg run_execution_sha "$run_execution_sha" \
      --argjson app_id "$app_id" '{
        repo: $repo, pr: $pr, head_sha: $head, base_ref: $base,
        base_sha: $base_sha, authority_ref: $authority_ref,
        authority_sha: $authority_sha, context: $context,
        workflow_id: $workflow_id, workflow_path: $workflow_path,
        workflow_run_path: $workflow_run_path,
        event: $event, run_id: $run_id, run_attempt: $run_attempt,
        run_execution_branch: $run_execution_branch,
        run_execution_sha: $run_execution_sha,
        app_id: $app_id
      }' >"$PROVENANCE_OUTPUT"
  fi
  echo "[policy-integrity] PASS provenance: pr=$PR_NUMBER head=$head base=$base@$base_sha workflow_id=$workflow_id run=$run_id attempt=$attempt app_id=$app_id"
}

case "$MODE" in
  evaluate) evaluate_policy_change ;;
  verify-run) verify_run_provenance ;;
  *) fail "internal mode error" ;;
esac
