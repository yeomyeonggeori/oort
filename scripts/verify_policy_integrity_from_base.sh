#!/usr/bin/env bash
# Local merge entrypoint for policy-integrity provenance verification.
#
# Trust boundary: invoke this tracked file only from the clean canonical branch
# that is the PR's current base. The wrapper refuses candidate/topic checkouts,
# verifies its own bytes against that exact base commit, and executes an
# extracted verifier from the same commit. It never executes the worktree copy
# of verify_policy_integrity.sh.
set -euo pipefail

REPO=""
PR_NUMBER=""
PROVENANCE_OUTPUT=""
GH_BIN="${MOMO_GH_BIN:-gh}"
VERIFIER_PATH="scripts/verify_policy_integrity.sh"
SELF_PATH="scripts/verify_policy_integrity_from_base.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/verify_policy_integrity_from_base.sh --repo OWNER/REPO --pr N \
    [--output FILE]

Run only from the clean, checked-out canonical base branch of the PR. The
candidate checkout's verifier is never used.
EOF
}

fail() {
  echo "[trusted-policy-runner] FAIL: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    --output)
      [ "$#" -ge 2 ] || fail "--output needs a file"
      PROVENANCE_OUTPUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

printf '%s\n' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' \
  || fail "invalid repository slug: ${REPO:-<empty>}"
printf '%s\n' "$PR_NUMBER" | grep -Eq '^[1-9][0-9]*$' \
  || fail "invalid pull request number: ${PR_NUMBER:-<empty>}"
if [ -n "${MOMO_GH_BIN:-}" ]; then
  if [ "$REPO" != "example/oort" ] \
    || [ "${MOMO_POLICY_RUNNER_FIXTURE:-}" != "offline-fixture-v1" ]; then
    fail "MOMO_GH_BIN override is forbidden outside the offline fixture"
  fi
fi
command -v "$GH_BIN" >/dev/null 2>&1 || fail "gh CLI is required"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
"$GH_BIN" --version >/dev/null 2>&1 || fail "gh CLI is unavailable"

GIT_CMD=(
  env
  -u GIT_DIR
  -u GIT_WORK_TREE
  -u GIT_INDEX_FILE
  -u GIT_COMMON_DIR
  -u GIT_OBJECT_DIRECTORY
  -u GIT_ALTERNATE_OBJECT_DIRECTORIES
  -u GIT_REPLACE_REF_BASE
  git --no-replace-objects
)

SCRIPT_DIR="$(CDPATH='' cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_FILE="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
REPO_ROOT_RAW="$("${GIT_CMD[@]}" -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "wrapper is not inside a git worktree"
REPO_ROOT="$(CDPATH='' cd -P -- "$REPO_ROOT_RAW" && pwd -P)"
[ "$SCRIPT_FILE" = "$REPO_ROOT/$SELF_PATH" ] \
  || fail "wrapper must be invoked from its canonical tracked path"
replacement_refs="$("${GIT_CMD[@]}" -C "$REPO_ROOT" replace -l 2>/dev/null)" \
  || fail "could not inspect git replacement refs"
[ -z "$replacement_refs" ] \
  || fail "git replacement refs are forbidden during trusted verification"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-trusted-policy-runner.XXXXXX")"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT INT TERM

read_pr() {
  local output="$1"
  if ! "$GH_BIN" api "repos/$REPO/pulls/$PR_NUMBER" >"$output"; then
    fail "pull request metadata is unavailable"
  fi
  if ! jq -e --argjson pr "$PR_NUMBER" '
    type == "object" and .number == $pr and .state == "open" and
    (.head.sha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.base.ref == "main" or .base.ref == "track/engine" or .base.ref == "track/uxui") and
    (.base.sha | type == "string" and test("^[0-9a-f]{40}$"))
  ' "$output" >/dev/null 2>&1; then
    fail "pull request metadata is malformed, closed, or has a non-canonical base"
  fi
}

initial="$TEMP_ROOT/pr-initial.json"
final="$TEMP_ROOT/pr-final.json"
trusted_self="$TEMP_ROOT/trusted-runner.sh"
trusted_verifier="$TEMP_ROOT/trusted-verifier.sh"
read_pr "$initial"
head_sha="$(jq -r '.head.sha' "$initial")"
base_ref="$(jq -r '.base.ref' "$initial")"
base_sha="$(jq -r '.base.sha' "$initial")"

current_branch="$("${GIT_CMD[@]}" -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null)" \
  || fail "wrapper must run from a checked-out canonical branch, not detached HEAD"
[ "$current_branch" = "$base_ref" ] \
  || fail "current branch '$current_branch' is not PR base '$base_ref'"
current_head="$("${GIT_CMD[@]}" -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" \
  || fail "could not resolve current HEAD"
[ "$current_head" = "$base_sha" ] \
  || fail "current HEAD is not the PR API exact base SHA"

"${GIT_CMD[@]}" -C "$REPO_ROOT" ls-files --error-unmatch "$SELF_PATH" >/dev/null 2>&1 \
  || fail "trusted runner is not tracked"
"${GIT_CMD[@]}" -C "$REPO_ROOT" show "$base_sha:$SELF_PATH" >"$trusted_self" 2>/dev/null \
  || fail "trusted runner is missing from the PR exact base SHA"
cmp -s "$SCRIPT_FILE" "$trusted_self" \
  || fail "running wrapper bytes differ from the PR exact base SHA"

"${GIT_CMD[@]}" -C "$REPO_ROOT" show "$base_sha:$VERIFIER_PATH" >"$trusted_verifier" 2>/dev/null \
  || fail "trusted verifier is missing from the PR exact base SHA"
chmod 0700 "$trusted_verifier"

# Close the extraction window before executing the base object. The extracted
# verifier performs its own repeated PR/evidence reads and final binding.
read_pr "$final"
jq -e \
  --arg head "$head_sha" --arg base "$base_ref" --arg base_sha "$base_sha" '
  .head.sha == $head and .base.ref == $base and .base.sha == $base_sha
' "$final" >/dev/null || fail "PR head/base changed while extracting the trusted verifier"

verifier_args=(
  --verify-run
  --repo "$REPO"
  --pr "$PR_NUMBER"
  --expected-base "$base_ref"
  --expected-base-sha "$base_sha"
)
if [ -n "$PROVENANCE_OUTPUT" ]; then
  verifier_args+=(--output "$PROVENANCE_OUTPUT")
fi

echo "[trusted-policy-runner] executing $VERIFIER_PATH from $base_ref@$base_sha for PR #$PR_NUMBER"
bash "$trusted_verifier" "${verifier_args[@]}"

# The verifier closes its own read window. This wrapper adds a final external
# read so extraction/execution cannot return green for a PR that moved after it.
read_pr "$final"
jq -e \
  --arg head "$head_sha" --arg base "$base_ref" --arg base_sha "$base_sha" '
  .head.sha == $head and .base.ref == $base and .base.sha == $base_sha
' "$final" >/dev/null || fail "PR head/base changed after trusted verification"
echo "[trusted-policy-runner] PASS exact-base verifier execution"
