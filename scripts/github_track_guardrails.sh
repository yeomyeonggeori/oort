#!/usr/bin/env bash
# Idempotently check/apply the GitHub protection policy for the three canonical
# branches. Default is read-only check. Apply is deliberately locked behind the
# post-main sequence: all branch heads equal and the latest PR CI gate is green.
set -euo pipefail

MODE="check"
REPO=""
REQUIRED_CONTEXT="PR CI gate"
REQUIRED_APP_SLUG="github-actions"
GH_BIN="${MOMO_GH_BIN:-gh}"
BRANCHES=(main track/engine track/uxui)
CANONICAL_SHA=""
REQUIRED_APP_ID=""
ACTIONS_PERMISSIONS_JSON=""

usage() {
  cat <<'EOF'
Usage: scripts/github_track_guardrails.sh [--check|--apply] [--repo OWNER/REPO]

Default --check performs no remote mutation. --apply is accepted only after:
  1. main, track/engine, and track/uxui point to the same commit; and
  2. the latest `PR CI gate` check on that commit succeeded from GitHub Actions.

The managed policy requires PRs and the GitHub-Actions-pinned stable context,
includes administrators, requires conversation resolution, and forbids force
pushes/deletion. Existing stricter checks, review rules, push restrictions, and
linear-history rules are preserved rather than overwritten.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --apply) MODE="apply"; shift ;;
    --repo)
      [ "$#" -ge 2 ] || { echo "[github-guardrails] --repo needs OWNER/REPO" >&2; exit 2; }
      REPO="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[github-guardrails] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v "$GH_BIN" >/dev/null 2>&1 || {
  echo "[github-guardrails] gh CLI is required" >&2
  exit 1
}
"$GH_BIN" --version >/dev/null
"$GH_BIN" auth status >/dev/null 2>&1 || {
  echo "[github-guardrails] gh auth login is required" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "[github-guardrails] jq is required" >&2
  exit 1
}

if [ -z "$REPO" ]; then
  REPO="$("$GH_BIN" repo view --json nameWithOwner -q .nameWithOwner)" || {
    echo "[github-guardrails] could not resolve repository; pass --repo OWNER/REPO" >&2
    exit 1
  }
fi
case "$REPO" in
  */*) ;;
  *) echo "[github-guardrails] invalid repository slug: $REPO" >&2; exit 2 ;;
esac

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-github-guardrails.XXXXXX")"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT INT TERM

urlencode() {
  jq -rn --arg value "$1" '$value | @uri'
}

protection_endpoint() {
  local encoded
  encoded="$(urlencode "$1")"
  printf 'repos/%s/branches/%s/protection\n' "$REPO" "$encoded"
}

branch_endpoint() {
  local encoded
  encoded="$(urlencode "$1")"
  printf 'repos/%s/branches/%s\n' "$REPO" "$encoded"
}

api_get_json() {
  local endpoint="$1"
  local output="$2"
  local raw="$TEMP_ROOT/api-get.$$.json"
  local error="$TEMP_ROOT/api-get.$$.err"

  if ! "$GH_BIN" api "$endpoint" >"$raw" 2>"$error"; then
    echo "[github-guardrails] API GET failed: $endpoint" >&2
    sed -n '1,4p' "$error" >&2 || true
    return 1
  fi
  if ! jq -e 'type == "object"' "$raw" >/dev/null 2>&1; then
    echo "[github-guardrails] API GET returned invalid JSON: $endpoint" >&2
    return 1
  fi
  cp "$raw" "$output"
}

# Return codes: 0 = protected JSON, 4 = explicit HTTP 404 (unprotected),
# 1 = transport/auth/server/protocol/JSON failure. Only 404 is safe to create.
get_protection() {
  local branch="$1"
  local output="$2"
  local key raw error body status rc
  key="$(printf '%s' "$branch" | tr '/' '_')"
  raw="$TEMP_ROOT/protection-$key.raw"
  error="$TEMP_ROOT/protection-$key.err"
  body="$TEMP_ROOT/protection-$key.body"

  set +e
  "$GH_BIN" api --include "$(protection_endpoint "$branch")" >"$raw" 2>"$error"
  rc=$?
  set -e

  status="$(awk 'toupper($1) ~ /^HTTP\// { status=$2 } END { print status }' "$raw")"
  if ! printf '%s\n' "$status" | grep -Eq '^[0-9]{3}$'; then
    echo "[github-guardrails] FAIL $branch: protection GET had no HTTP status" >&2
    sed -n '1,4p' "$error" >&2 || true
    return 1
  fi

  case "$status" in
    200)
      if [ "$rc" -ne 0 ]; then
        echo "[github-guardrails] FAIL $branch: protection GET exited $rc despite HTTP 200" >&2
        return 1
      fi
      awk '
        BEGIN { in_body=0 }
        { sub(/\r$/, "") }
        in_body { print; next }
        /^$/ { in_body=1 }
      ' "$raw" >"$body"
      if ! jq -e 'type == "object"' "$body" >/dev/null 2>&1; then
        echo "[github-guardrails] FAIL $branch: protection GET returned invalid JSON" >&2
        return 1
      fi
      cp "$body" "$output"
      return 0
      ;;
    404)
      return 4
      ;;
    *)
      echo "[github-guardrails] FAIL $branch: protection GET returned HTTP $status" >&2
      sed -n '1,4p' "$error" >&2 || true
      return 1
      ;;
  esac
}

api_put_json() {
  local endpoint="$1"
  local input="$2"
  local output="$TEMP_ROOT/api-put.$$.json"
  if ! "$GH_BIN" api --method PUT "$endpoint" --input "$input" >"$output"; then
    echo "[github-guardrails] API PUT failed: $endpoint" >&2
    return 1
  fi
  if ! jq -e 'type == "object"' "$output" >/dev/null 2>&1; then
    echo "[github-guardrails] API PUT returned invalid JSON: $endpoint" >&2
    return 1
  fi
}

api_put_no_content() {
  local endpoint="$1"
  local input="$2"
  if ! "$GH_BIN" api --method PUT "$endpoint" --input "$input" >/dev/null; then
    echo "[github-guardrails] API PUT failed: $endpoint" >&2
    return 1
  fi
}

read_actions_permissions() {
  local output="$TEMP_ROOT/actions-permissions.json"
  api_get_json "repos/$REPO/actions/permissions/workflow" "$output" || {
    echo "[github-guardrails] FAIL: repository Actions workflow permissions are unavailable" >&2
    return 1
  }
  if ! jq -e '
    (.default_workflow_permissions == "read" or .default_workflow_permissions == "write") and
    ((.can_approve_pull_request_reviews | type) == "boolean")
  ' "$output" >/dev/null; then
    echo "[github-guardrails] FAIL: repository Actions workflow permissions have an invalid shape" >&2
    return 1
  fi
  ACTIONS_PERMISSIONS_JSON="$output"
}

actions_permissions_are_compliant() {
  jq -e '
    .default_workflow_permissions == "read" and
    .can_approve_pull_request_reviews == false
  ' "$ACTIONS_PERMISSIONS_JSON" >/dev/null
}

check_actions_permissions() {
  if actions_permissions_are_compliant; then
    echo "[github-guardrails] PASS Actions permissions: default=read, PR approvals=false"
    return 0
  fi
  if [ "$(jq -r '.default_workflow_permissions' "$ACTIONS_PERMISSIONS_JSON")" != "read" ]; then
    echo "[github-guardrails] FAIL Actions permissions: default workflow permission must be read" >&2
  fi
  if [ "$(jq -r '.can_approve_pull_request_reviews' "$ACTIONS_PERMISSIONS_JSON")" != "false" ]; then
    echo "[github-guardrails] FAIL Actions permissions: workflows must not approve pull requests" >&2
  fi
  return 1
}

check_workflow_active() {
  local json="$TEMP_ROOT/workflow.json"
  api_get_json "repos/$REPO/actions/workflows/pr-ci.yml" "$json" || {
    echo "[github-guardrails] FAIL: pr-ci workflow is unavailable" >&2
    return 1
  }
  if [ "$(jq -r '.state // ""' "$json")" != "active" ]; then
    echo "[github-guardrails] FAIL: pr-ci workflow is not active" >&2
    return 1
  fi
  echo "[github-guardrails] PASS workflow: pr-ci is active"
}

read_branch_sha() {
  local branch="$1"
  local json
  json="$TEMP_ROOT/branch-$(printf '%s' "$branch" | tr '/' '_').json"
  api_get_json "$(branch_endpoint "$branch")" "$json" || return 1
  if ! CANONICAL_SHA_READ="$(jq -er '.commit.sha | select(type == "string" and test("^[0-9a-fA-F]{40}$"))' "$json")"; then
    echo "[github-guardrails] FAIL $branch: branch head SHA is missing or invalid" >&2
    return 1
  fi
}

load_canonical_heads() {
  local expected="${1:-}"
  local branch first=""
  for branch in "${BRANCHES[@]}"; do
    read_branch_sha "$branch" || return 1
    if [ -n "$expected" ] && [ "$CANONICAL_SHA_READ" != "$expected" ]; then
      echo "[github-guardrails] apply blocked: canonical branch SHA changed during apply" >&2
      return 1
    fi
    if [ -z "$first" ]; then
      first="$CANONICAL_SHA_READ"
    elif [ "$CANONICAL_SHA_READ" != "$first" ]; then
      echo "[github-guardrails] apply blocked: canonical branches are not at one SHA" >&2
      return 1
    fi
  done
  CANONICAL_SHA="$first"
}

load_latest_required_check() {
  local sha="$1"
  local expected_app_id="${2:-}"
  local encoded_context endpoint page=1 page_count total_count collected=0
  local response="$TEMP_ROOT/check-runs-page.json"
  local runs="$TEMP_ROOT/check-runs.ndjson"
  local latest="$TEMP_ROOT/check-run-latest.json"
  local name head_sha status conclusion app_slug app_id
  encoded_context="$(urlencode "$REQUIRED_CONTEXT")"
  : >"$runs"

  while [ "$page" -le 10 ]; do
    endpoint="repos/$REPO/commits/$sha/check-runs?check_name=$encoded_context&filter=latest&per_page=100&page=$page"
    api_get_json "$endpoint" "$response" || return 1
    if ! jq -e '(.total_count | type == "number") and (.check_runs | type == "array")' "$response" >/dev/null; then
      echo "[github-guardrails] FAIL: check-runs response shape is invalid" >&2
      return 1
    fi
    page_count="$(jq -r '.check_runs | length' "$response")"
    total_count="$(jq -r '.total_count' "$response")"
    jq -c '.check_runs[]' "$response" >>"$runs"
    collected=$((collected + page_count))
    if [ "$collected" -ge "$total_count" ] || [ "$page_count" -lt 100 ]; then
      break
    fi
    page=$((page + 1))
  done
  if [ "$collected" -lt "$total_count" ]; then
    echo "[github-guardrails] FAIL: check-runs pagination exceeded the 1000-run API window" >&2
    return 1
  fi

  if ! jq -s -e --arg context "$REQUIRED_CONTEXT" --arg sha "$sha" '
    map(select(.name == $context and .head_sha == $sha))
    | sort_by([(.started_at // .created_at // .completed_at // ""), (.id // 0)])
    | last
    | select(type == "object")
  ' "$runs" >"$latest"; then
    echo "[github-guardrails] apply blocked: latest '$REQUIRED_CONTEXT' missing on $sha" >&2
    return 1
  fi

  name="$(jq -r '.name // ""' "$latest")"
  head_sha="$(jq -r '.head_sha // ""' "$latest")"
  status="$(jq -r '.status // ""' "$latest")"
  conclusion="$(jq -r '.conclusion // ""' "$latest")"
  app_slug="$(jq -r '.app.slug // ""' "$latest")"
  app_id="$(jq -r '.app.id // ""' "$latest")"
  if [ "$name" != "$REQUIRED_CONTEXT" ] || [ "$head_sha" != "$sha" ]; then
    echo "[github-guardrails] apply blocked: latest required check does not match canonical SHA" >&2
    return 1
  fi
  if [ "$app_slug" != "$REQUIRED_APP_SLUG" ]; then
    echo "[github-guardrails] apply blocked: latest '$REQUIRED_CONTEXT' came from app '$app_slug', not '$REQUIRED_APP_SLUG'" >&2
    return 1
  fi
  if [ "$status" != "completed" ] || [ "$conclusion" != "success" ]; then
    echo "[github-guardrails] apply blocked: latest '$REQUIRED_CONTEXT' is not successful" >&2
    return 1
  fi
  if ! printf '%s\n' "$app_id" | grep -Eq '^[1-9][0-9]*$'; then
    echo "[github-guardrails] apply blocked: latest '$REQUIRED_CONTEXT' has no valid app id" >&2
    return 1
  fi
  if [ -n "$expected_app_id" ] && [ "$app_id" != "$expected_app_id" ]; then
    echo "[github-guardrails] apply blocked: required check app id changed during apply" >&2
    return 1
  fi
  REQUIRED_APP_ID="$app_id"
  echo "[github-guardrails] PASS context: $REQUIRED_CONTEXT@$sha app=$REQUIRED_APP_SLUG/$app_id"
}

protection_is_compliant() {
  local json="$1"
  jq -e --arg context "$REQUIRED_CONTEXT" --argjson app_id "$REQUIRED_APP_ID" '
    (.required_status_checks.strict == true) and
    any(.required_status_checks.checks[]?;
      .context == $context and .app_id == $app_id
    ) and
    (.required_pull_request_reviews != null) and
    ((.required_pull_request_reviews.required_approving_review_count | type) == "number") and
    (.required_pull_request_reviews.required_approving_review_count >= 0) and
    (((.required_pull_request_reviews.bypass_pull_request_allowances.users // []) | type) == "array") and
    (((.required_pull_request_reviews.bypass_pull_request_allowances.users // []) | length) == 0) and
    (((.required_pull_request_reviews.bypass_pull_request_allowances.teams // []) | type) == "array") and
    (((.required_pull_request_reviews.bypass_pull_request_allowances.teams // []) | length) == 0) and
    (((.required_pull_request_reviews.bypass_pull_request_allowances.apps // []) | type) == "array") and
    (((.required_pull_request_reviews.bypass_pull_request_allowances.apps // []) | length) == 0) and
    (.enforce_admins.enabled == true) and
    (.required_conversation_resolution.enabled == true) and
    (.allow_force_pushes.enabled == false) and
    (.allow_deletions.enabled == false)
  ' "$json" >/dev/null
}

report_noncompliance() {
  local branch="$1"
  local json="$2"
  local failed=0
  check_expr() {
    local label="$1"
    local expr="$2"
    if ! jq -e --arg context "$REQUIRED_CONTEXT" --argjson app_id "$REQUIRED_APP_ID" "$expr" "$json" >/dev/null; then
      echo "[github-guardrails] FAIL $branch: $label" >&2
      failed=1
    fi
  }
  check_expr "required status checks are not strict" '.required_status_checks.strict == true'
  # shellcheck disable=SC2016 # $context/$app_id are jq variables.
  check_expr "GitHub-Actions-pinned required check missing: $REQUIRED_CONTEXT/$REQUIRED_APP_ID" \
    'any(.required_status_checks.checks[]?; .context == $context and .app_id == $app_id)'
  check_expr "PR-only rule missing" '.required_pull_request_reviews != null'
  check_expr "approval count is missing or invalid" \
    '((.required_pull_request_reviews.required_approving_review_count | type) == "number") and (.required_pull_request_reviews.required_approving_review_count >= 0)'
  check_expr "PR bypass users must be empty" \
    '(((.required_pull_request_reviews.bypass_pull_request_allowances.users // []) | type) == "array") and (((.required_pull_request_reviews.bypass_pull_request_allowances.users // []) | length) == 0)'
  check_expr "PR bypass teams must be empty" \
    '(((.required_pull_request_reviews.bypass_pull_request_allowances.teams // []) | type) == "array") and (((.required_pull_request_reviews.bypass_pull_request_allowances.teams // []) | length) == 0)'
  check_expr "PR bypass apps must be empty" \
    '(((.required_pull_request_reviews.bypass_pull_request_allowances.apps // []) | type) == "array") and (((.required_pull_request_reviews.bypass_pull_request_allowances.apps // []) | length) == 0)'
  check_expr "administrators are not enforced" '.enforce_admins.enabled == true'
  check_expr "conversation resolution is not required" '.required_conversation_resolution.enabled == true'
  check_expr "force-pushes are allowed" '.allow_force_pushes.enabled == false'
  check_expr "branch deletion is allowed" '.allow_deletions.enabled == false'
  return "$failed"
}

check_protections() {
  local failed=0 branch json rc
  for branch in "${BRANCHES[@]}"; do
    json="$TEMP_ROOT/check-$(printf '%s' "$branch" | tr '/' '_').json"
    if get_protection "$branch" "$json"; then
      if protection_is_compliant "$json"; then
        echo "[github-guardrails] PASS protection: $branch"
      else
        report_noncompliance "$branch" "$json" || true
        failed=1
      fi
    else
      rc=$?
      if [ "$rc" -eq 4 ]; then
        echo "[github-guardrails] FAIL $branch: branch is unprotected" >&2
      fi
      failed=1
    fi
  done
  return "$failed"
}

build_policy_payload() {
  local existing="$1"
  local output="$2"
  jq --arg context "$REQUIRED_CONTEXT" --argjson app_id "$REQUIRED_APP_ID" '
    def bool_or($value; $fallback):
      if ($value | type) == "boolean" then $value else $fallback end;
    def enabled_or($value; $fallback):
      if ($value.enabled | type) == "boolean" then $value.enabled
      elif ($value | type) == "boolean" then $value
      else $fallback end;
    def actor_names($kind):
      map(
        if type == "string" then .
        elif $kind == "user" then (.login // .name // empty)
        else (.slug // .name // empty)
        end
      ) | map(select(type == "string" and length > 0));

    . as $existing
    | ($existing.required_status_checks // {}) as $status
    | ($existing.required_pull_request_reviews // {}) as $reviews
    | (($status.checks // []) | map(
        select((.context | type) == "string")
        | {context: .context}
          + (if (.app_id | type) == "number" then {app_id: .app_id} else {} end)
      )) as $checks
    | (reduce (($status.contexts // [])[]? | select(type == "string")) as $legacy
        ($checks; if any(.[]; .context == $legacy) then . else . + [{context: $legacy}] end)) as $all_checks
    | (($all_checks | map(select(.context != $context))) + [{context: $context, app_id: $app_id}]) as $required_checks
    | {
        required_status_checks: {
          strict: true,
          contexts: [],
          checks: $required_checks
        },
        enforce_admins: true,
        required_pull_request_reviews: {
          dismissal_restrictions: {
            users: (($reviews.dismissal_restrictions.users // []) | actor_names("user")),
            teams: (($reviews.dismissal_restrictions.teams // []) | actor_names("team")),
            apps: (($reviews.dismissal_restrictions.apps // []) | actor_names("app"))
          },
          dismiss_stale_reviews: true,
          require_code_owner_reviews: bool_or($reviews.require_code_owner_reviews; false),
          required_approving_review_count: (
            if ($reviews.required_approving_review_count | type) == "number"
            then $reviews.required_approving_review_count else 0 end
          ),
          require_last_push_approval: bool_or($reviews.require_last_push_approval; false),
          bypass_pull_request_allowances: {users: [], teams: [], apps: []}
        },
        restrictions: (
          if $existing.restrictions == null then null else {
            users: (($existing.restrictions.users // []) | actor_names("user")),
            teams: (($existing.restrictions.teams // []) | actor_names("team")),
            apps: (($existing.restrictions.apps // []) | actor_names("app"))
          } end
        ),
        required_linear_history: enabled_or($existing.required_linear_history; false),
        allow_force_pushes: false,
        allow_deletions: false,
        block_creations: enabled_or($existing.block_creations; false),
        required_conversation_resolution: true,
        lock_branch: enabled_or($existing.lock_branch; false),
        allow_fork_syncing: enabled_or($existing.allow_fork_syncing; false)
      }
  ' "$existing" >"$output"
}

load_runtime_basis() {
  check_workflow_active
  load_canonical_heads
  load_latest_required_check "$CANONICAL_SHA"
  read_actions_permissions
}

revalidate_runtime_basis() {
  local expected_sha="$1"
  local expected_app_id="$2"
  load_canonical_heads "$expected_sha"
  load_latest_required_check "$expected_sha" "$expected_app_id"
  read_actions_permissions
}

revalidate_protection_snapshots() {
  local branch key initial presence fresh rc
  local initial_sorted fresh_sorted
  for branch in "${BRANCHES[@]}"; do
    key="$(printf '%s' "$branch" | tr '/' '_')"
    initial="$TEMP_ROOT/existing-$key.json"
    presence="$TEMP_ROOT/existing-$key.presence"
    fresh="$TEMP_ROOT/recheck-$key.json"
    initial_sorted="$TEMP_ROOT/existing-$key.sorted.json"
    fresh_sorted="$TEMP_ROOT/recheck-$key.sorted.json"

    if get_protection "$branch" "$fresh"; then
      if [ "$(cat "$presence")" != "protected" ]; then
        echo "[github-guardrails] apply blocked: $branch protection changed during apply" >&2
        return 1
      fi
      jq -S . "$initial" >"$initial_sorted"
      jq -S . "$fresh" >"$fresh_sorted"
      if ! cmp -s "$initial_sorted" "$fresh_sorted"; then
        echo "[github-guardrails] apply blocked: $branch protection changed during apply" >&2
        return 1
      fi
    else
      rc=$?
      if [ "$rc" -eq 4 ] && [ "$(cat "$presence")" = "unprotected" ]; then
        continue
      fi
      if [ "$rc" -eq 4 ]; then
        echo "[github-guardrails] apply blocked: $branch protection changed during apply" >&2
      else
        echo "[github-guardrails] apply blocked: could not safely re-read all protections" >&2
      fi
      return 1
    fi
  done
}

apply_policy() {
  local branch key existing payload endpoint rc
  local actions_payload="$TEMP_ROOT/actions-permissions-payload.json"

  # Read every branch before the first PUT. A 404 is the only absence that may
  # be repaired; auth/network/5xx/protocol/JSON failures abort with PUT 0.
  for branch in "${BRANCHES[@]}"; do
    key="$(printf '%s' "$branch" | tr '/' '_')"
    existing="$TEMP_ROOT/existing-$key.json"
    if get_protection "$branch" "$existing"; then
      printf 'protected\n' >"$TEMP_ROOT/existing-$key.presence"
    else
      rc=$?
      if [ "$rc" -eq 4 ]; then
        printf '{}\n' >"$existing"
        printf 'unprotected\n' >"$TEMP_ROOT/existing-$key.presence"
      else
        echo "[github-guardrails] apply blocked: could not safely read all protections" >&2
        return 1
      fi
    fi
    payload="$TEMP_ROOT/payload-$key.json"
    build_policy_payload "$existing" "$payload"
  done

  # Close the read/build race before any mutation.
  revalidate_runtime_basis "$CANONICAL_SHA" "$REQUIRED_APP_ID"
  revalidate_protection_snapshots

  if ! actions_permissions_are_compliant; then
    jq -n '{
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false
    }' >"$actions_payload"
    api_put_no_content "repos/$REPO/actions/permissions/workflow" "$actions_payload"
    echo "[github-guardrails] applied: repository Actions workflow permissions"
  else
    echo "[github-guardrails] unchanged: repository Actions workflow permissions already compliant"
  fi

  for branch in "${BRANCHES[@]}"; do
    key="$(printf '%s' "$branch" | tr '/' '_')"
    existing="$TEMP_ROOT/existing-$key.json"
    payload="$TEMP_ROOT/payload-$key.json"
    if [ "$(jq -r 'length' "$existing")" -gt 0 ] && protection_is_compliant "$existing"; then
      echo "[github-guardrails] unchanged: $branch already compliant"
      continue
    fi
    endpoint="$(protection_endpoint "$branch")"
    api_put_json "$endpoint" "$payload"
    echo "[github-guardrails] applied: $branch"
  done

  # Remote state may change while PUTs are in flight. Never report success
  # until both the canonical SHA and the exact app-pinned latest check survive
  # a post-apply read.
  revalidate_runtime_basis "$CANONICAL_SHA" "$REQUIRED_APP_ID"
  check_actions_permissions
  check_protections
}

if [ "$MODE" = "check" ]; then
  load_runtime_basis
  check_actions_permissions
  check_protections
  echo "[github-guardrails] PASS: canonical branch protection is compliant"
  exit 0
fi

load_runtime_basis
echo "[github-guardrails] PASS apply preflight: all branches=$CANONICAL_SHA and context green"
apply_policy
echo "[github-guardrails] PASS: canonical branch protection is compliant"
