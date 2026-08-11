#!/usr/bin/env bash
# Idempotently check/apply the GitHub protection policy for the three canonical
# branches. Default is read-only check. Apply is deliberately locked behind the
# post-main sequence: all branch heads equal, the latest PR CI gate is green,
# and one trusted Policy integrity gate bootstrap PR is verified per branch.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
MODE="check"
REPO=""
REQUIRED_CONTEXT="PR CI gate"
POLICY_CONTEXT="Policy integrity gate"
REQUIRED_APP_SLUG="github-actions"
PR_CI_WORKFLOW_NAME="pr-ci"
PR_CI_WORKFLOW_PATH=".github/workflows/pr-ci.yml"
POLICY_WORKFLOW_NAME="policy-integrity"
POLICY_WORKFLOW_PATH=".github/workflows/policy-integrity.yml"
GH_BIN="${MOMO_GH_BIN:-gh}"
GIT_BIN="git"
BRANCHES=(main track/engine track/uxui)
TRACK_BRANCHES=(track/engine track/uxui)
CANONICAL_SHA=""
REQUIRED_APP_ID=""
ACTIONS_PERMISSIONS_JSON=""
POLICY_PR_SPEC=""
POLICY_PR_MAIN=""
POLICY_PR_ENGINE=""
POLICY_PR_UXUI=""
MUTATED_TARGETS=()
ATTEMPTED_TARGETS=()

usage() {
  cat <<'EOF'
Usage:
  scripts/github_track_guardrails.sh [--check] [--repo OWNER/REPO]

  scripts/github_track_guardrails.sh --apply [--repo OWNER/REPO] \
    --policy-pr main=N,track/engine=N,track/uxui=N

Default --check performs no remote mutation and accepts tracks ahead of main
when main remains their ancestor. It resolves the official GitHub Actions App
and checks that both `PR CI gate` and `Policy integrity gate` are pinned to it;
it does not depend on a recent policy PR or workflow run.

Bootstrap-only --apply is accepted only after:
  1. main, track/engine, and track/uxui point to the same commit; and
  2. the latest `PR CI gate` check on that commit succeeded from GitHub Actions;
  3. --policy-pr provides exactly one distinct open trusted bootstrap PR for
     each canonical target; and
  4. every PR passes verify_policy_integrity.sh for its exact target/base SHA.

The apply process itself must run from that exact remote-main commit with a
clean tracked guard file. The verifier is extracted from the exact canonical
commit object for every provenance cycle; a worktree verifier is never run.

The managed policy requires PRs and both GitHub-Actions-pinned stable contexts,
includes administrators, requires conversation resolution, and forbids force
pushes/deletion. Existing stricter checks, review rules, push restrictions, and
linear-history rules are preserved rather than overwritten.

`--apply` is an attended, non-transactional bootstrap. Keep it running through
the final verification. If a later write or recheck fails, the script prints an
APPLY_INCOMPLETE recovery marker and the targets already updated; repair the
reported prerequisite, run `--check`, and then safely retry `--apply`.
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
    --policy-pr)
      [ "$#" -ge 2 ] || { echo "[github-guardrails] --policy-pr needs branch=PR mappings" >&2; exit 2; }
      [ -z "$POLICY_PR_SPEC" ] || {
        echo "[github-guardrails] --policy-pr may be provided only once" >&2
        exit 2
      }
      POLICY_PR_SPEC="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[github-guardrails] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "apply" ]; then
  resolved_gh=""
  if [ -n "${MOMO_POLICY_INTEGRITY_VERIFIER:-}" ]; then
    echo "[github-guardrails] MOMO_POLICY_INTEGRITY_VERIFIER is forbidden for --apply; verifier trust comes from the exact canonical Git blob" >&2
    exit 1
  fi
  case "${MOMO_GITHUB_GUARDRAILS_TEST_MODE:-}" in
    "")
      if [ -n "${MOMO_GITHUB_GUARDRAILS_TEST_GIT:-}" ] || [ -n "${MOMO_GH_BIN:-}" ]; then
        echo "[github-guardrails] transport overrides are forbidden for production --apply" >&2
        exit 1
      fi
      GH_BIN="gh"
      GIT_BIN="git"
      ;;
    offline-fixture-v1)
      [ -n "${MOMO_GH_BIN:-}" ] && [ -n "${MOMO_GITHUB_GUARDRAILS_TEST_GIT:-}" ] || {
        echo "[github-guardrails] invalid offline guardrails test configuration" >&2
        exit 1
      }
      GIT_BIN="$MOMO_GITHUB_GUARDRAILS_TEST_GIT"
      ;;
    *)
      echo "[github-guardrails] invalid offline guardrails test configuration" >&2
      exit 1
      ;;
  esac
  if ! resolved_gh="$(command -v "$GH_BIN")"; then
    echo "[github-guardrails] gh CLI is required" >&2
    exit 1
  fi
  case "$resolved_gh" in
    /*) GH_BIN="$resolved_gh" ;;
    *)
      echo "[github-guardrails] apply requires an external absolute gh executable, not a shell override" >&2
      exit 1
      ;;
  esac
fi

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

parse_policy_pr_mapping() {
  local remaining="$POLICY_PR_SPEC"
  local entry branch pr

  [ -n "$remaining" ] || {
    echo "[github-guardrails] --apply requires --policy-pr main=N,track/engine=N,track/uxui=N" >&2
    return 1
  }
  case "$remaining" in
    ,*|*,|*,,*)
      echo "[github-guardrails] invalid empty --policy-pr mapping" >&2
      return 1
      ;;
  esac

  while :; do
    entry="${remaining%%,*}"
    if [ "$entry" = "$remaining" ]; then
      remaining=""
    else
      remaining="${remaining#*,}"
    fi
    [ -n "$entry" ] || {
      echo "[github-guardrails] invalid empty --policy-pr mapping" >&2
      return 1
    }
    case "$entry" in
      *=*) ;;
      *)
        echo "[github-guardrails] invalid --policy-pr mapping: $entry" >&2
        return 1
        ;;
    esac
    branch="${entry%%=*}"
    pr="${entry#*=}"
    printf '%s\n' "$pr" | grep -Eq '^[1-9][0-9]*$' || {
      echo "[github-guardrails] invalid policy PR number for $branch: $pr" >&2
      return 1
    }
    case "$branch" in
      main)
        [ -z "$POLICY_PR_MAIN" ] || {
          echo "[github-guardrails] duplicate --policy-pr mapping for main" >&2
          return 1
        }
        POLICY_PR_MAIN="$pr"
        ;;
      track/engine)
        [ -z "$POLICY_PR_ENGINE" ] || {
          echo "[github-guardrails] duplicate --policy-pr mapping for track/engine" >&2
          return 1
        }
        POLICY_PR_ENGINE="$pr"
        ;;
      track/uxui)
        [ -z "$POLICY_PR_UXUI" ] || {
          echo "[github-guardrails] duplicate --policy-pr mapping for track/uxui" >&2
          return 1
        }
        POLICY_PR_UXUI="$pr"
        ;;
      *)
        echo "[github-guardrails] unknown --policy-pr target: $branch" >&2
        return 1
        ;;
    esac
    [ -z "$remaining" ] && break
  done

  if [ -z "$POLICY_PR_MAIN" ] || [ -z "$POLICY_PR_ENGINE" ] || [ -z "$POLICY_PR_UXUI" ]; then
    echo "[github-guardrails] --policy-pr must map main, track/engine, and track/uxui exactly once" >&2
    return 1
  fi
  if [ "$POLICY_PR_MAIN" = "$POLICY_PR_ENGINE" ] \
    || [ "$POLICY_PR_MAIN" = "$POLICY_PR_UXUI" ] \
    || [ "$POLICY_PR_ENGINE" = "$POLICY_PR_UXUI" ]; then
    echo "[github-guardrails] --policy-pr must use a distinct PR for each canonical target" >&2
    return 1
  fi
}

if [ "$MODE" = "apply" ]; then
  resolved_git=""
  parse_policy_pr_mapping || exit 2
  if [ -n "${MOMO_GITHUB_GUARDRAILS_TEST_MODE:-}" ]; then
    [ "$REPO" = "fixture/oort" ] || {
      echo "[github-guardrails] invalid offline guardrails test configuration" >&2
      exit 1
    }
  fi
  if ! resolved_git="$(command -v "$GIT_BIN")"; then
    echo "[github-guardrails] git executable is unavailable: $GIT_BIN" >&2
    exit 1
  fi
  case "$resolved_git" in
    /*) GIT_BIN="$resolved_git" ;;
    *)
      echo "[github-guardrails] apply requires an external absolute git executable, not a shell override" >&2
      exit 1
      ;;
  esac
  "$GIT_BIN" --version >/dev/null 2>&1 || {
    echo "[github-guardrails] git executable is unusable: $GIT_BIN" >&2
    exit 1
  }
elif [ -n "$POLICY_PR_SPEC" ]; then
  echo "[github-guardrails] --policy-pr is valid only with --apply" >&2
  exit 2
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-github-guardrails.XXXXXX")"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT INT TERM

trusted_git() {
  env \
    -u GIT_DIR \
    -u GIT_WORK_TREE \
    -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    -u GIT_COMMON_DIR \
    -u GIT_NAMESPACE \
    -u GIT_REPLACE_REF_BASE \
    "$GIT_BIN" --no-replace-objects \
      -c core.fsmonitor=false \
      -c core.hooksPath=/dev/null \
      "$@"
}

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

extract_exact_git_blob() {
  local sha="$1"
  local path="$2"
  local output="$3"
  local error="$TEMP_ROOT/git-show.$$.err"

  rm -f "$output"
  if ! trusted_git -C "$REPO_ROOT" show "$sha:$path" >"$output" 2>"$error"; then
    echo "[github-guardrails] apply blocked: exact canonical blob is unavailable: $sha:$path" >&2
    sed -n '1,4p' "$error" >&2 || true
    rm -f "$output"
    return 1
  fi
  if [ ! -s "$output" ]; then
    echo "[github-guardrails] apply blocked: exact canonical blob is empty: $sha:$path" >&2
    rm -f "$output"
    return 1
  fi
}

ensure_apply_guard_trusted() {
  local expected_sha="$1"
  local top head status trusted_guard

  if ! top="$(trusted_git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null)" \
    || [ "$top" != "$REPO_ROOT" ]; then
    echo "[github-guardrails] apply blocked: guard is not running from its repository root" >&2
    return 1
  fi
  if ! head="$(trusted_git -C "$REPO_ROOT" rev-parse --verify HEAD 2>/dev/null)"; then
    echo "[github-guardrails] apply blocked: current HEAD is unavailable" >&2
    return 1
  fi
  if [ "$head" != "$expected_sha" ]; then
    echo "[github-guardrails] apply blocked: current HEAD $head is not exact remote main $expected_sha" >&2
    return 1
  fi
  if ! status="$(trusted_git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=no -- scripts/github_track_guardrails.sh)"; then
    echo "[github-guardrails] apply blocked: could not inspect tracked guard cleanliness" >&2
    return 1
  fi
  if [ -n "$status" ]; then
    echo "[github-guardrails] apply blocked: tracked guard file is dirty in the index or worktree" >&2
    return 1
  fi

  trusted_guard="$TEMP_ROOT/trusted-guard-$expected_sha.sh"
  extract_exact_git_blob "$expected_sha" scripts/github_track_guardrails.sh "$trusted_guard" \
    || return 1
  if ! cmp -s "$SCRIPT_DIR/github_track_guardrails.sh" "$trusted_guard"; then
    echo "[github-guardrails] apply blocked: executing guard bytes do not match exact remote main" >&2
    return 1
  fi
  echo "[github-guardrails] PASS guard trust: HEAD=$expected_sha tracked-clean exact-main bytes"
}

extract_trusted_policy_verifier() {
  local expected_sha="$1"
  local output="$2"
  extract_exact_git_blob "$expected_sha" scripts/verify_policy_integrity.sh "$output" \
    || return 1
  chmod 0500 "$output"
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

check_repository_identity() {
  local json="$TEMP_ROOT/repository-identity.json"

  api_get_json "repos/$REPO" "$json" || {
    echo "[github-guardrails] FAIL: repository identity/default branch is unavailable" >&2
    return 1
  }
  if ! jq -e \
    --arg repo "$REPO" '
      .full_name == $repo and .default_branch == "main"
    ' "$json" >/dev/null 2>&1; then
    echo "[github-guardrails] FAIL: repository full_name/default branch must be exactly $REPO/main" >&2
    return 1
  fi
  echo "[github-guardrails] PASS repository: full_name=$REPO default_branch=main"
}

check_workflows_active() {
  local api_name expected_name expected_path json

  for api_name in pr-ci.yml policy-integrity.yml; do
    case "$api_name" in
      pr-ci.yml)
        expected_name="$PR_CI_WORKFLOW_NAME"
        expected_path="$PR_CI_WORKFLOW_PATH"
        ;;
      policy-integrity.yml)
        expected_name="$POLICY_WORKFLOW_NAME"
        expected_path="$POLICY_WORKFLOW_PATH"
        ;;
      *)
        echo "[github-guardrails] internal error: unknown required workflow $api_name" >&2
        return 1
        ;;
    esac
    json="$TEMP_ROOT/workflow-$expected_name.json"
    api_get_json "repos/$REPO/actions/workflows/$api_name" "$json" || {
      echo "[github-guardrails] FAIL: $expected_name workflow is unavailable" >&2
      return 1
    }
    if ! jq -e \
      --arg name "$expected_name" \
      --arg path "$expected_path" '
        .name == $name and .path == $path
      ' "$json" >/dev/null 2>&1; then
      echo "[github-guardrails] FAIL: $expected_name workflow identity/path is invalid" >&2
      return 1
    fi
    if [ "$(jq -r '.state // ""' "$json")" != "active" ]; then
      echo "[github-guardrails] FAIL: $expected_name workflow is not active" >&2
      return 1
    fi
    echo "[github-guardrails] PASS workflow: $expected_name path=$expected_path state=active"
  done
}

resolve_required_app() {
  local expected_id="${1:-}"
  local json="$TEMP_ROOT/required-app.json"
  local app_id
  api_get_json "apps/$REQUIRED_APP_SLUG" "$json" || {
    echo "[github-guardrails] FAIL: could not resolve GitHub Actions app identity" >&2
    return 1
  }
  if ! app_id="$(jq -er --arg slug "$REQUIRED_APP_SLUG" '
    select(.slug == $slug)
    | .id
    | select(type == "number" and . > 0 and floor == .)
  ' "$json")"; then
    echo "[github-guardrails] FAIL: GitHub Actions app identity is invalid" >&2
    return 1
  fi
  if [ -n "$expected_id" ] && [ "$app_id" != "$expected_id" ]; then
    echo "[github-guardrails] apply blocked: GitHub Actions app id changed during apply" >&2
    return 1
  fi
  REQUIRED_APP_ID="$app_id"
}

policy_pr_for_branch() {
  case "$1" in
    main) printf '%s\n' "$POLICY_PR_MAIN" ;;
    track/engine) printf '%s\n' "$POLICY_PR_ENGINE" ;;
    track/uxui) printf '%s\n' "$POLICY_PR_UXUI" ;;
    *)
      echo "[github-guardrails] internal error: no policy PR slot for $1" >&2
      return 1
      ;;
  esac
}

verify_policy_pr_base_bindings() {
  local expected_sha="$1"
  local head_snapshot_dir="$2"
  local snapshot_mode="$3"
  local branch pr key json head_sha snapshot expected_head

  case "$snapshot_mode" in
    capture|assert) ;;
    *)
      echo "[github-guardrails] internal error: invalid bootstrap PR snapshot mode: $snapshot_mode" >&2
      return 1
      ;;
  esac

  for branch in "${BRANCHES[@]}"; do
    pr="$(policy_pr_for_branch "$branch")" || return 1
    key="$(printf '%s' "$branch" | tr '/' '_')"
    json="$TEMP_ROOT/policy-pr-base-$key.json"
    api_get_json "repos/$REPO/pulls/$pr" "$json" || {
      echo "[github-guardrails] apply blocked: bootstrap PR #$pr metadata is unavailable" >&2
      return 1
    }
    if ! jq -e \
      --argjson pr "$pr" \
      --arg repo "$REPO" \
      --arg branch "$branch" \
      --arg sha "$expected_sha" '
        .number == $pr and
        .state == "open" and
        .base.ref == $branch and
        .base.sha == $sha and
        .base.repo.full_name == $repo and
        (.head.sha | type == "string" and test("^[0-9a-f]{40}$"))
      ' "$json" >/dev/null 2>&1; then
      echo "[github-guardrails] apply blocked: bootstrap PR #$pr does not have exact open base $branch@$expected_sha" >&2
      return 1
    fi
    if ! head_sha="$(jq -er '.head.sha' "$json")"; then
      echo "[github-guardrails] apply blocked: bootstrap PR #$pr head SHA is unavailable" >&2
      return 1
    fi
    snapshot="$head_snapshot_dir/$key.sha"
    if [ "$snapshot_mode" = "capture" ]; then
      printf '%s\n' "$head_sha" >"$snapshot"
    else
      if [ ! -f "$snapshot" ]; then
        echo "[github-guardrails] apply blocked: bootstrap PR #$pr head snapshot is unavailable" >&2
        return 1
      fi
      expected_head="$(cat "$snapshot")"
      if [ "$head_sha" != "$expected_head" ]; then
        echo "[github-guardrails] apply blocked: bootstrap PR #$pr head moved during provenance verification" >&2
        return 1
      fi
    fi
  done
  echo "[github-guardrails] PASS bootstrap PR bindings: exact open bases at $expected_sha with $snapshot_mode heads"
}

verify_policy_pr_mappings() {
  local expected_sha="$1"
  local expected_app_id="$2"
  local branch pr key output trusted_verifier stable_verifier head_snapshot_dir expected_head

  trusted_verifier="$TEMP_ROOT/policy-verifier-$expected_sha.sh"
  stable_verifier="$TEMP_ROOT/policy-verifier-$expected_sha.stable.sh"
  head_snapshot_dir="$TEMP_ROOT/policy-pr-heads-$expected_sha"
  mkdir -p "$head_snapshot_dir"
  verify_policy_pr_base_bindings "$expected_sha" "$head_snapshot_dir" capture || return 1
  extract_trusted_policy_verifier "$expected_sha" "$trusted_verifier" || return 1

  for branch in "${BRANCHES[@]}"; do
    pr="$(policy_pr_for_branch "$branch")" || return 1
    key="$(printf '%s' "$branch" | tr '/' '_')"
    output="$TEMP_ROOT/policy-provenance-$key.json"
    expected_head="$(cat "$head_snapshot_dir/$key.sha")"
    rm -f "$output"
    if ! MOMO_GH_BIN="$GH_BIN" "$trusted_verifier" \
      --verify-run \
      --repo "$REPO" \
      --pr "$pr" \
      --expected-base "$branch" \
      --expected-base-sha "$expected_sha" \
      --output "$output"; then
      echo "[github-guardrails] apply blocked: Policy integrity gate provenance failed for $branch PR #$pr" >&2
      return 1
    fi
    if ! jq -e \
      --arg repo "$REPO" \
      --argjson pr "$pr" \
      --arg head "$expected_head" \
      --arg branch "$branch" \
      --arg sha "$expected_sha" \
      --arg context "$POLICY_CONTEXT" \
      --argjson app_id "$expected_app_id" '
        type == "object" and
        .repo == $repo and
        .pr == $pr and
        .head_sha == $head and
        .base_ref == $branch and
        .base_sha == $sha and
        .context == $context and
        .app_id == $app_id
      ' "$output" >/dev/null 2>&1; then
      echo "[github-guardrails] apply blocked: Policy integrity gate provenance output mismatched for $branch PR #$pr" >&2
      return 1
    fi
    echo "[github-guardrails] PASS policy provenance: $branch PR #$pr context=$POLICY_CONTEXT app=$REQUIRED_APP_SLUG/$expected_app_id"
  done

  # Re-extract the immutable exact-SHA object instead of assuming the first
  # local read stayed stable throughout all three potentially long API checks.
  extract_trusted_policy_verifier "$expected_sha" "$stable_verifier" || return 1
  if ! cmp -s "$trusted_verifier" "$stable_verifier"; then
    echo "[github-guardrails] apply blocked: exact-base policy verifier bytes changed during provenance cycle" >&2
    return 1
  fi
  verify_policy_pr_base_bindings "$expected_sha" "$head_snapshot_dir" assert || return 1
}

read_branch_sha() {
  local branch="$1"
  local json
  json="$TEMP_ROOT/branch-$(printf '%s' "$branch" | tr '/' '_').json"
  api_get_json "$(branch_endpoint "$branch")" "$json" || return 1
  if ! CANONICAL_SHA_READ="$(jq -er '.commit.sha | select(type == "string" and test("^[0-9a-f]{40}$"))' "$json")"; then
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

load_check_topology() {
  local main_sha track track_sha compare_json expected_file
  read_branch_sha main || return 1
  main_sha="$CANONICAL_SHA_READ"
  printf '%s\n' "$main_sha" >"$TEMP_ROOT/topology-main.sha"
  for track in "${TRACK_BRANCHES[@]}"; do
    read_branch_sha "$track" || return 1
    track_sha="$CANONICAL_SHA_READ"
    expected_file="$TEMP_ROOT/topology-$(printf '%s' "$track" | tr '/' '_').sha"
    printf '%s\n' "$track_sha" >"$expected_file"
    if [ "$track_sha" = "$main_sha" ]; then
      continue
    fi
    compare_json="$TEMP_ROOT/compare-$(printf '%s' "$track" | tr '/' '_').json"
    api_get_json "repos/$REPO/compare/$main_sha...$track_sha" "$compare_json" || {
      echo "[github-guardrails] FAIL $track: could not verify main ancestry" >&2
      return 1
    }
    if ! jq -e --arg base "$main_sha" '
      .base_commit.sha == $base and
      .merge_base_commit.sha == $base and
      .status == "ahead" and
      .behind_by == 0 and
      ((.ahead_by | type) == "number") and .ahead_by > 0
    ' "$compare_json" >/dev/null; then
      echo "[github-guardrails] FAIL $track: main is not an ancestor of the track head" >&2
      return 1
    fi

    # The compare response is not a ref lock, and its commits array is capped
    # for long histories. Re-read both refs instead of treating commits[-1] as
    # the live head.
    read_branch_sha main || return 1
    if [ "$CANONICAL_SHA_READ" != "$main_sha" ]; then
      echo "[github-guardrails] FAIL: main moved while track ancestry was checked" >&2
      return 1
    fi
    read_branch_sha "$track" || return 1
    if [ "$CANONICAL_SHA_READ" != "$track_sha" ]; then
      echo "[github-guardrails] FAIL $track: branch moved while ancestry was checked" >&2
      return 1
    fi
  done

  # Close movement of the first track while the second comparison was in
  # flight. A check never succeeds from a mixed ref snapshot.
  for track in main "${TRACK_BRANCHES[@]}"; do
    expected_file="$TEMP_ROOT/topology-$(printf '%s' "$track" | tr '/' '_').sha"
    read_branch_sha "$track" || return 1
    if [ "$CANONICAL_SHA_READ" != "$(cat "$expected_file")" ]; then
      echo "[github-guardrails] FAIL $track: branch moved while topology was checked" >&2
      return 1
    fi
  done
  CANONICAL_SHA="$main_sha"
  echo "[github-guardrails] PASS topology: main is the base of both canonical tracks"
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
  jq -e \
    --arg pr_context "$REQUIRED_CONTEXT" \
    --arg policy_context "$POLICY_CONTEXT" \
    --argjson app_id "$REQUIRED_APP_ID" '
    (.required_status_checks.strict == true) and
    any(.required_status_checks.checks[]?;
      .context == $pr_context and .app_id == $app_id
    ) and
    any(.required_status_checks.checks[]?;
      .context == $policy_context and .app_id == $app_id
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
    (.allow_deletions.enabled == false) and
    (.allow_fork_syncing.enabled == false)
  ' "$json" >/dev/null
}

report_noncompliance() {
  local branch="$1"
  local json="$2"
  local failed=0
  check_expr() {
    local label="$1"
    local expr="$2"
    if ! jq -e \
      --arg pr_context "$REQUIRED_CONTEXT" \
      --arg policy_context "$POLICY_CONTEXT" \
      --argjson app_id "$REQUIRED_APP_ID" \
      "$expr" "$json" >/dev/null; then
      echo "[github-guardrails] FAIL $branch: $label" >&2
      failed=1
    fi
  }
  check_expr "required status checks are not strict" '.required_status_checks.strict == true'
  # shellcheck disable=SC2016 # context/app_id names are jq variables.
  check_expr "GitHub-Actions-pinned required check missing: $REQUIRED_CONTEXT/$REQUIRED_APP_ID" \
    'any(.required_status_checks.checks[]?; .context == $pr_context and .app_id == $app_id)'
  # shellcheck disable=SC2016 # context/app_id names are jq variables.
  check_expr "GitHub-Actions-pinned required check missing: $POLICY_CONTEXT/$REQUIRED_APP_ID" \
    'any(.required_status_checks.checks[]?; .context == $policy_context and .app_id == $app_id)'
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
  check_expr "fork syncing is allowed" '.allow_fork_syncing.enabled == false'
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
  local observed="$1"
  local retained="$2"
  local output="$3"

  # The second input is the accumulated preservation contract from every state
  # this invocation has observed. This makes a retry-safe monotonic merge:
  # concurrent stronger checks/settings are carried into the next PUT instead
  # of being overwritten by a payload built from the initial read.
  jq -s \
    --arg pr_context "$REQUIRED_CONTEXT" \
    --arg policy_context "$POLICY_CONTEXT" \
    --argjson app_id "$REQUIRED_APP_ID" '
    def enabled($value):
      if ($value | type) == "object" then
        (if ($value.enabled | type) == "boolean" then $value.enabled else false end)
      elif ($value | type) == "boolean" then $value
      else false end;
    def actor_names($kind):
      map(
        if type == "string" then .
        elif $kind == "user" then (.login // .name // empty)
        else (.slug // .name // empty)
        end
      ) | map(select(type == "string" and length > 0)) | unique | sort;
    def normalized_checks:
      (((.required_status_checks.checks // []) | map(
        select((.context | type) == "string" and (.context | length) > 0)
        | {context: .context,
           app_id: (if (.app_id | type) == "number" then .app_id else -1 end)}
      )) +
      ((.required_status_checks.contexts // []) | map(
        select(type == "string" and length > 0)
        | {context: ., app_id: -1}
      )));

    . as $sources
    | (([$sources[] | normalized_checks[]]
        + [
            {context: $pr_context, app_id: $app_id},
            {context: $policy_context, app_id: $app_id}
          ])
       | unique_by([.context, .app_id])
       | sort_by([.context, .app_id])) as $required_checks
    | ([$sources[]
        | (.required_pull_request_reviews.required_approving_review_count // 0)
        | if type == "number" then . else 0 end] | max) as $review_count
    | {
        # The live GitHub PUT schema treats legacy `contexts` and app-pinned
        # `checks` as mutually exclusive oneOf shapes. Legacy contexts were
        # normalized above; never emit the `contexts` field alongside checks.
        required_status_checks: {
          strict: true,
          checks: $required_checks
        },
        enforce_admins: true,
        required_pull_request_reviews: {
          dismissal_restrictions: {
            users: ([$sources[]
              | ((.required_pull_request_reviews.dismissal_restrictions.users // [])
                 | actor_names("user"))[]] | unique | sort),
            teams: ([$sources[]
              | ((.required_pull_request_reviews.dismissal_restrictions.teams // [])
                 | actor_names("team"))[]] | unique | sort),
            apps: ([$sources[]
              | ((.required_pull_request_reviews.dismissal_restrictions.apps // [])
                 | actor_names("app"))[]] | unique | sort)
          },
          dismiss_stale_reviews: true,
          require_code_owner_reviews: any($sources[];
            .required_pull_request_reviews.require_code_owner_reviews == true),
          required_approving_review_count: $review_count,
          require_last_push_approval: any($sources[];
            .required_pull_request_reviews.require_last_push_approval == true),
          bypass_pull_request_allowances: {users: [], teams: [], apps: []}
        },
        restrictions: (
          if any($sources[]; .restrictions != null) then {
            users: ([$sources[]
              | ((.restrictions.users // []) | actor_names("user"))[]]
              | unique | sort),
            teams: ([$sources[]
              | ((.restrictions.teams // []) | actor_names("team"))[]]
              | unique | sort),
            apps: ([$sources[]
              | ((.restrictions.apps // []) | actor_names("app"))[]]
              | unique | sort)
          } else null end
        ),
        required_linear_history: any($sources[]; enabled(.required_linear_history)),
        allow_force_pushes: false,
        allow_deletions: false,
        block_creations: any($sources[]; enabled(.block_creations)),
        required_conversation_resolution: true,
        lock_branch: any($sources[]; enabled(.lock_branch)),
        # Fork-sync permission is an allow switch, so false is the restrictive
        # lattice bottom. Never resurrect true from an older observation.
        allow_fork_syncing: false
      }
  ' "$observed" "$retained" >"$output"
}

protection_preserves_contract() {
  local actual="$1"
  local contract="$2"
  jq -e --slurpfile expected "$contract" '
    def enabled($value):
      if ($value | type) == "object" then
        (if ($value.enabled | type) == "boolean" then $value.enabled else false end)
      elif ($value | type) == "boolean" then $value
      else false end;
    def actor_names($kind):
      map(
        if type == "string" then .
        elif $kind == "user" then (.login // .name // empty)
        else (.slug // .name // empty)
        end
      ) | map(select(type == "string" and length > 0)) | unique | sort;
    def normalized_checks:
      (((.required_status_checks.checks // []) | map(
        select((.context | type) == "string" and (.context | length) > 0)
        | {context: .context,
           app_id: (if (.app_id | type) == "number" then .app_id else -1 end)}
      )) +
      ((.required_status_checks.contexts // []) | map(
        select(type == "string" and length > 0)
        | {context: ., app_id: -1}
      ))) | unique_by([.context, .app_id]);
    def contains_all($actual; $wanted):
      all($wanted[]; . as $item | ($actual | index($item)) != null);

    . as $actual
    | $expected[0] as $wanted
    | ($actual | normalized_checks) as $actual_checks
    | ($wanted | normalized_checks) as $wanted_checks
    | (($actual.required_pull_request_reviews // {}) as $actual_reviews
      | ($wanted.required_pull_request_reviews // {}) as $wanted_reviews
      | ($actual.restrictions // null) as $actual_restrictions
      | ($wanted.restrictions // null) as $wanted_restrictions
      | contains_all($actual_checks; $wanted_checks)
      and ($actual.required_status_checks.strict == true)
      and ($actual.required_pull_request_reviews != null)
      and (($actual_reviews.required_approving_review_count // -1)
        >= ($wanted_reviews.required_approving_review_count // 0))
      and (($wanted_reviews.require_code_owner_reviews != true)
        or ($actual_reviews.require_code_owner_reviews == true))
      and (($wanted_reviews.require_last_push_approval != true)
        or ($actual_reviews.require_last_push_approval == true))
      and (($wanted_reviews.dismiss_stale_reviews != true)
        or ($actual_reviews.dismiss_stale_reviews == true))
      and ((($actual_reviews.dismissal_restrictions.users // []) | actor_names("user"))
        == (($wanted_reviews.dismissal_restrictions.users // []) | actor_names("user")))
      and ((($actual_reviews.dismissal_restrictions.teams // []) | actor_names("team"))
        == (($wanted_reviews.dismissal_restrictions.teams // []) | actor_names("team")))
      and ((($actual_reviews.dismissal_restrictions.apps // []) | actor_names("app"))
        == (($wanted_reviews.dismissal_restrictions.apps // []) | actor_names("app")))
      and (((($actual_reviews.bypass_pull_request_allowances.users // []) | length) == 0)
        and ((($actual_reviews.bypass_pull_request_allowances.teams // []) | length) == 0)
        and ((($actual_reviews.bypass_pull_request_allowances.apps // []) | length) == 0))
      and ((($wanted_restrictions == null) and ($actual_restrictions == null)) or (
        ($wanted_restrictions != null)
        and ($actual_restrictions != null)
        and ((($actual_restrictions.users // []) | actor_names("user"))
          == (($wanted_restrictions.users // []) | actor_names("user")))
        and ((($actual_restrictions.teams // []) | actor_names("team"))
          == (($wanted_restrictions.teams // []) | actor_names("team")))
        and ((($actual_restrictions.apps // []) | actor_names("app"))
          == (($wanted_restrictions.apps // []) | actor_names("app")))
      ))
      and (enabled($actual.enforce_admins))
      and (($wanted.required_linear_history != true)
        or enabled($actual.required_linear_history))
      and (($wanted.block_creations != true) or enabled($actual.block_creations))
      and (enabled($actual.required_conversation_resolution))
      and (($wanted.lock_branch != true) or enabled($actual.lock_branch))
      and (enabled($actual.allow_fork_syncing) == false)
      and (enabled($actual.allow_force_pushes) == false)
      and (enabled($actual.allow_deletions) == false))
  ' "$actual" >/dev/null
}

load_runtime_basis() {
  local expected_sha expected_app_id
  check_repository_identity || return 1
  check_workflows_active || return 1
  load_canonical_heads || return 1
  expected_sha="$CANONICAL_SHA"
  ensure_apply_guard_trusted "$expected_sha" || return 1
  resolve_required_app || return 1
  expected_app_id="$REQUIRED_APP_ID"
  load_latest_required_check "$expected_sha" "$expected_app_id" || return 1
  read_actions_permissions || return 1
  verify_policy_pr_mappings "$expected_sha" "$expected_app_id" || return 1

  # Provenance verification performs several API reads. Close that window so
  # the bootstrap snapshot cannot move underneath a successful verifier call.
  load_canonical_heads "$expected_sha" || return 1
  resolve_required_app "$expected_app_id" || return 1
  load_latest_required_check "$expected_sha" "$expected_app_id" || return 1
  read_actions_permissions || return 1
  check_repository_identity || return 1
  CANONICAL_SHA="$expected_sha"
}

load_check_basis() {
  check_repository_identity || return 1
  check_workflows_active || return 1
  load_check_topology || return 1
  resolve_required_app || return 1
  read_actions_permissions || return 1
}

revalidate_runtime_basis() {
  local expected_sha="$1"
  local expected_app_id="$2"
  check_repository_identity || return 1
  check_workflows_active || return 1
  load_canonical_heads "$expected_sha" || return 1
  ensure_apply_guard_trusted "$expected_sha" || return 1
  resolve_required_app "$expected_app_id" || return 1
  load_latest_required_check "$expected_sha" "$expected_app_id" || return 1
  read_actions_permissions || return 1
  verify_policy_pr_mappings "$expected_sha" "$expected_app_id" || return 1

  # Each verifier closes its own PR/workflow races. Re-read the canonical
  # runtime basis as well so a branch/App/check change during the three-PR
  # verification cannot precede a mutation or final success.
  load_canonical_heads "$expected_sha" || return 1
  resolve_required_app "$expected_app_id" || return 1
  load_latest_required_check "$expected_sha" "$expected_app_id" || return 1
  read_actions_permissions || return 1
  # Close default-branch/repository identity movement across the long three-PR
  # provenance pass. Callers perform only local checks and the final protection
  # refresh before a branch PUT.
  check_repository_identity || return 1
  CANONICAL_SHA="$expected_sha"
}

revalidate_runtime_snapshot() {
  local expected_sha="$1"
  local expected_app_id="$2"
  check_workflows_active || return 1
  load_canonical_heads "$expected_sha" || return 1
  resolve_required_app "$expected_app_id" || return 1
  load_latest_required_check "$expected_sha" "$expected_app_id" || return 1
  read_actions_permissions || return 1
  check_repository_identity || return 1
  CANONICAL_SHA="$expected_sha"
}

record_mutation() {
  MUTATED_TARGETS+=("$1")
}

record_attempt() {
  ATTEMPTED_TARGETS+=("$1")
}

report_apply_incomplete() {
  local reason="$1"
  local completed="none"
  local attempted="none"
  if [ "${#MUTATED_TARGETS[@]}" -gt 0 ]; then
    completed="$(IFS=,; printf '%s' "${MUTATED_TARGETS[*]}")"
  fi
  if [ "${#ATTEMPTED_TARGETS[@]}" -gt 0 ]; then
    attempted="$(IFS=,; printf '%s' "${ATTEMPTED_TARGETS[*]}")"
  fi
  if [ "${#ATTEMPTED_TARGETS[@]}" -gt 0 ] || [ "${#MUTATED_TARGETS[@]}" -gt 0 ]; then
    echo "[github-guardrails] APPLY_INCOMPLETE recovery_required=true completed=$completed attempted=$attempted" >&2
    echo "[github-guardrails] remote writes are non-transactional; some targets may already be compliant" >&2
  else
    echo "[github-guardrails] APPLY_ABORTED remote_mutations=0" >&2
  fi
  echo "[github-guardrails] recovery: fix '$reason', run --check, then retry the attended --apply bootstrap" >&2
}

read_protection_observation() {
  local branch="$1"
  local output="$2"
  local presence_output="$3"
  local rc
  if get_protection "$branch" "$output"; then
    printf 'protected\n' >"$presence_output"
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -eq 4 ]; then
    printf '{}\n' >"$output"
    printf 'unprotected\n' >"$presence_output"
    return 0
  fi
  return 1
}

write_actor_allowlist_snapshot() {
  local policy="$1"
  local output="$2"
  jq -S '
    def enabled($value):
      if ($value | type) == "object" then
        (if ($value.enabled | type) == "boolean" then $value.enabled else false end)
      elif ($value | type) == "boolean" then $value
      else false end;
    def actor_names($kind):
      map(
        if type == "string" then .
        elif $kind == "user" then (.login // .name // empty)
        else (.slug // .name // empty)
        end
      ) | map(select(type == "string" and length > 0)) | unique | sort;
    {
      dismissal: {
        users: ((.required_pull_request_reviews.dismissal_restrictions.users // [])
          | actor_names("user")),
        teams: ((.required_pull_request_reviews.dismissal_restrictions.teams // [])
          | actor_names("team")),
        apps: ((.required_pull_request_reviews.dismissal_restrictions.apps // [])
          | actor_names("app"))
      },
      push: {
        enabled: (.restrictions != null),
        users: ((.restrictions.users // []) | actor_names("user")),
        teams: ((.restrictions.teams // []) | actor_names("team")),
        apps: ((.restrictions.apps // []) | actor_names("app"))
      },
      fork_sync_allowed: enabled(.allow_fork_syncing)
    }
  ' "$policy" >"$output"
}

actor_allowlists_match() {
  local left="$1"
  local right="$2"
  local left_snapshot="$TEMP_ROOT/allowlists-left.json"
  local right_snapshot="$TEMP_ROOT/allowlists-right.json"
  write_actor_allowlist_snapshot "$left" "$left_snapshot" || return 1
  write_actor_allowlist_snapshot "$right" "$right_snapshot" || return 1
  cmp -s "$left_snapshot" "$right_snapshot"
}

refresh_preservation_contract() {
  local branch="$1"
  local key="$2"
  local observation="$TEMP_ROOT/fresh-$key.json"
  local presence="$TEMP_ROOT/fresh-$key.presence"
  local contract="$TEMP_ROOT/contract-$key.json"
  local merged="$TEMP_ROOT/contract-$key.merged.json"
  local initial="$TEMP_ROOT/existing-$key.json"

  read_protection_observation "$branch" "$observation" "$presence" || {
    echo "[github-guardrails] apply blocked: could not safely refresh $branch protection" >&2
    return 1
  }
  if ! actor_allowlists_match "$observation" "$initial"; then
    echo "[github-guardrails] apply blocked: $branch authorization allowlist changed during apply" >&2
    return 1
  fi
  build_policy_payload "$observation" "$contract" "$merged" || return 1
  mv "$merged" "$contract"

  if ! jq -e --slurpfile initial "$initial" '. == $initial[0]' "$observation" >/dev/null 2>&1; then
    echo "[github-guardrails] observed concurrent $branch protection change; rebuilt a monotonic payload"
  fi
}

verify_preservation_contracts() {
  local branch key actual presence contract
  for branch in "${BRANCHES[@]}"; do
    key="$(printf '%s' "$branch" | tr '/' '_')"
    actual="$TEMP_ROOT/final-$key.json"
    presence="$TEMP_ROOT/final-$key.presence"
    contract="$TEMP_ROOT/contract-$key.json"
    if ! read_protection_observation "$branch" "$actual" "$presence"; then
      echo "[github-guardrails] FAIL $branch: final protection read failed" >&2
      return 1
    fi
    if [ "$(cat "$presence")" != "protected" ]; then
      echo "[github-guardrails] FAIL $branch: protection disappeared during apply" >&2
      return 1
    fi
    if ! protection_is_compliant "$actual"; then
      report_noncompliance "$branch" "$actual" || true
      return 1
    fi
    if ! actor_allowlists_match "$actual" "$contract"; then
      echo "[github-guardrails] FAIL $branch: final authorization allowlist differs from the exact fresh payload" >&2
      return 1
    fi
    if ! protection_preserves_contract "$actual" "$contract"; then
      echo "[github-guardrails] FAIL $branch: an observed stronger protection requirement was lost" >&2
      return 1
    fi
    echo "[github-guardrails] PASS preservation: $branch"
  done
}

apply_policy() {
  local branch key existing contract empty endpoint fresh presence
  local pre_provenance pre_provenance_presence
  local actions_payload="$TEMP_ROOT/actions-permissions-payload.json"
  empty="$TEMP_ROOT/empty-policy.json"
  printf '{}\n' >"$empty"

  # Read every branch before the first PUT. A 404 is the only absence that may
  # be repaired; auth/network/5xx/protocol/JSON failures abort with PUT 0.
  for branch in "${BRANCHES[@]}"; do
    key="$(printf '%s' "$branch" | tr '/' '_')"
    existing="$TEMP_ROOT/existing-$key.json"
    if ! read_protection_observation \
      "$branch" "$existing" "$TEMP_ROOT/existing-$key.presence"; then
      echo "[github-guardrails] apply blocked: could not safely read all protections" >&2
      return 1
    fi
    contract="$TEMP_ROOT/contract-$key.json"
    if ! build_policy_payload "$existing" "$empty" "$contract"; then
      echo "[github-guardrails] apply blocked: could not build $branch preservation contract" >&2
      return 1
    fi
  done

  # Close the initial read/build race before any mutation.
  if ! revalidate_runtime_basis "$CANONICAL_SHA" "$REQUIRED_APP_ID"; then
    report_apply_incomplete "runtime preflight changed"
    return 1
  fi

  if ! actions_permissions_are_compliant; then
    if ! jq -n '{
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false
    }' >"$actions_payload"; then
      report_apply_incomplete "Actions permission payload build failed"
      return 1
    fi
    record_attempt "actions-permissions"
    if ! api_put_no_content "repos/$REPO/actions/permissions/workflow" "$actions_payload"; then
      report_apply_incomplete "Actions permission write failed"
      return 1
    fi
    record_mutation "actions-permissions"
    echo "[github-guardrails] applied: repository Actions workflow permissions"
  else
    echo "[github-guardrails] unchanged: repository Actions workflow permissions already compliant"
  fi

  for branch in "${BRANCHES[@]}"; do
    key="$(printf '%s' "$branch" | tr '/' '_')"
    contract="$TEMP_ROOT/contract-$key.json"

    # Every whole-document branch-protection PUT gets a fresh runtime basis and
    # a fresh branch policy. This cannot make GitHub's API transactional, but it
    # prevents stale initial payloads from erasing changes made between PUTs.
    if ! revalidate_runtime_snapshot "$CANONICAL_SHA" "$REQUIRED_APP_ID"; then
      report_apply_incomplete "workflow, branch SHA, or required check changed"
      return 1
    fi
    if ! check_actions_permissions; then
      report_apply_incomplete "Actions permissions drifted"
      return 1
    fi
    if ! refresh_preservation_contract "$branch" "$key"; then
      report_apply_incomplete "$branch protection refresh failed"
      return 1
    fi
    fresh="$TEMP_ROOT/fresh-$key.json"
    presence="$TEMP_ROOT/fresh-$key.presence"
    if [ "$(cat "$presence")" = "protected" ] \
      && protection_is_compliant "$fresh" \
      && protection_preserves_contract "$fresh" "$contract"; then
      echo "[github-guardrails] unchanged: $branch already compliant"
      continue
    fi

    # A mutation is now known to be necessary. Re-run both halves once more so
    # neither the runtime basis nor the protection snapshot used by the PUT is
    # merely the loop-entry read. GitHub exposes no conditional ETag for this
    # whole-document endpoint, so the final preservation read remains the last
    # line of defense against an unavoidable in-flight race.
    if ! revalidate_runtime_snapshot "$CANONICAL_SHA" "$REQUIRED_APP_ID"; then
      report_apply_incomplete "workflow, branch SHA, or required check changed immediately before $branch PUT"
      return 1
    fi
    if ! check_actions_permissions; then
      report_apply_incomplete "Actions permissions drifted immediately before $branch PUT"
      return 1
    fi
    if ! refresh_preservation_contract "$branch" "$key"; then
      report_apply_incomplete "$branch final protection refresh failed"
      return 1
    fi
    fresh="$TEMP_ROOT/fresh-$key.json"
    presence="$TEMP_ROOT/fresh-$key.presence"
    if [ "$(cat "$presence")" = "protected" ] \
      && protection_is_compliant "$fresh" \
      && protection_preserves_contract "$fresh" "$contract"; then
      echo "[github-guardrails] unchanged: $branch became compliant before PUT"
      continue
    fi
    pre_provenance="$TEMP_ROOT/pre-provenance-$key.json"
    pre_provenance_presence="$TEMP_ROOT/pre-provenance-$key.presence"
    cp "$fresh" "$pre_provenance"
    cp "$presence" "$pre_provenance_presence"

    # The policy refresh above is another remote read window. Verify all three
    # base-trusted bootstrap PRs and the exact-equal canonical refs once more as
    # the last remote prerequisite before this whole-document mutation.
    if ! revalidate_runtime_basis "$CANONICAL_SHA" "$REQUIRED_APP_ID"; then
      report_apply_incomplete "trusted policy provenance or runtime basis changed immediately before $branch PUT"
      return 1
    fi
    if ! check_actions_permissions; then
      report_apply_incomplete "Actions permissions drifted immediately before $branch PUT"
      return 1
    fi
    # Provenance verification is deliberately thorough and can take long enough
    # for an administrator to strengthen protection after the payload snapshot.
    # Re-read immediately before PUT and abort on any semantic change instead of
    # overwriting concurrent policy with a payload from the earlier snapshot.
    if ! refresh_preservation_contract "$branch" "$key"; then
      report_apply_incomplete "$branch post-provenance protection refresh failed"
      return 1
    fi
    fresh="$TEMP_ROOT/fresh-$key.json"
    presence="$TEMP_ROOT/fresh-$key.presence"
    if ! cmp -s "$pre_provenance_presence" "$presence" \
      || ! jq -s -e '.[0] == .[1]' "$pre_provenance" "$fresh" >/dev/null 2>&1; then
      echo "[github-guardrails] apply blocked: $branch protection changed during trusted provenance revalidation" >&2
      report_apply_incomplete "$branch protection changed immediately before PUT"
      return 1
    fi
    endpoint="$(protection_endpoint "$branch")"
    record_attempt "$branch"
    if ! api_put_json "$endpoint" "$contract"; then
      report_apply_incomplete "$branch protection write failed"
      return 1
    fi
    record_mutation "$branch"
    echo "[github-guardrails] applied: $branch"
  done

  # Remote state may change while PUTs are in flight. Never report success
  # until both the canonical SHA and the exact app-pinned latest check survive
  # a post-apply read.
  if ! revalidate_runtime_snapshot "$CANONICAL_SHA" "$REQUIRED_APP_ID"; then
    report_apply_incomplete "final workflow, branch SHA, or required check changed"
    return 1
  fi
  if ! check_actions_permissions; then
    report_apply_incomplete "final Actions permissions drifted"
    return 1
  fi
  if ! verify_preservation_contracts; then
    report_apply_incomplete "final protection preservation check failed"
    return 1
  fi

  # Final success is itself security-sensitive evidence. Make the trusted PR
  # provenance and exact canonical SHA the last remote basis we accept.
  if ! revalidate_runtime_basis "$CANONICAL_SHA" "$REQUIRED_APP_ID"; then
    report_apply_incomplete "final trusted policy provenance or runtime basis changed"
    return 1
  fi
  if ! check_actions_permissions; then
    report_apply_incomplete "final Actions permissions drifted after preservation check"
    return 1
  fi
}

if [ "$MODE" = "check" ]; then
  load_check_basis
  check_failed=0
  check_actions_permissions || check_failed=1
  check_protections || check_failed=1
  if [ "$check_failed" -ne 0 ]; then
    echo "[github-guardrails] FAIL: canonical GitHub track guardrails drifted" >&2
    exit 1
  fi
  echo "[github-guardrails] PASS: canonical GitHub track guardrails are compliant"
  exit 0
fi

load_runtime_basis
echo "[github-guardrails] PASS apply preflight: all branches=$CANONICAL_SHA and both required gates are trusted"
echo "[github-guardrails] attended bootstrap: keep this process running through final verification"
if ! apply_policy; then
  exit 1
fi
echo "[github-guardrails] PASS: canonical GitHub track guardrails are compliant"
