#!/usr/bin/env bash
# Offline check/apply/idempotency and fail-closed proofs using a fake gh
# transport. No GitHub state is touched.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/github_track_guardrails.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-github-guardrails.XXXXXX")"
STATE="$SANDBOX/state"
FAKE_GH="$SANDBOX/gh"
SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
APP_ID=15368
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
mkdir -p "$STATE"

fail() {
  echo "[github-guardrails-test] FAIL: $*" >&2
  exit 1
}

reset_mutations() {
  : >"$STATE/puts.log"
  : >"$STATE/actions_puts.log"
}

assert_put_zero() {
  [ ! -s "$STATE/puts.log" ] || fail "$1 wrote branch protection"
  [ ! -s "$STATE/actions_puts.log" ] || fail "$1 wrote Actions permissions"
}

write_valid_checks() {
  jq -n --arg sha "$SHA_A" --argjson app_id "$APP_ID" '{
    total_count: 101,
    check_runs: [range(1; 101) | {
      id: ., name: "PR CI gate", head_sha: $sha,
      status: "completed", conclusion: "success",
      started_at: "2026-08-11T00:00:00Z",
      app: {id: $app_id, slug: "github-actions"}
    }]
  }' >"$STATE/checks.before.page1.json"
  jq -n --arg sha "$SHA_A" --argjson app_id "$APP_ID" '{
    total_count: 101,
    check_runs: [{
      id: 1001, name: "PR CI gate", head_sha: $sha,
      status: "completed", conclusion: "success",
      started_at: "2026-08-12T00:00:00Z",
      app: {id: $app_id, slug: "github-actions"}
    }]
  }' >"$STATE/checks.before.page2.json"
}

for branch_key in main track_engine track_uxui; do
  printf '%s\n' "$SHA_A" >"$STATE/$branch_key.sha"
done
printf '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}\n' \
  >"$STATE/actions.json"
reset_mutations
: >"$STATE/check_calls.log"
write_valid_checks

cat >"$FAKE_GH" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_GH_STATE:?}"

case "${1:-}" in
  --version) echo 'gh version fixture'; exit 0 ;;
  auth) [ "${2:-}" = status ] && exit 0 ;;
  repo)
    [ "${2:-}" = view ] || exit 2
    echo 'yeomyeonggeori/oort'
    exit 0
    ;;
  api) ;;
  *) exit 2 ;;
esac
shift
method=GET
input=""
endpoint=""
include=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --method) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --include|-i) include=1; shift ;;
    -H) shift 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done

respond() {
  local status="$1"
  local reason="$2"
  local body="$3"
  local rc="$4"
  if [ "$include" -eq 1 ]; then
    printf 'HTTP/2.0 %s %s\nContent-Type: application/json\n\n' "$status" "$reason"
  fi
  [ -z "$body" ] || printf '%s\n' "$body"
  exit "$rc"
}

if [ "$endpoint" = 'repos/yeomyeonggeori/oort/actions/workflows/pr-ci.yml' ]; then
  echo '{"state":"active"}'
  exit 0
fi

if [ "$endpoint" = 'repos/yeomyeonggeori/oort/actions/permissions/workflow' ]; then
  if [ "$method" = PUT ]; then
    cp "$input" "$state/actions.json"
    echo actions >>"$state/actions_puts.log"
    exit 0
  fi
  mode="$(cat "$state/actions.mode" 2>/dev/null || echo ok)"
  case "$mode" in
    ok) cat "$state/actions.json"; exit 0 ;;
    network) exit 1 ;;
    500) echo 'fixture HTTP 500' >&2; exit 1 ;;
    invalid) echo 'not-json'; exit 0 ;;
    *) exit 2 ;;
  esac
fi

if [[ "$endpoint" == repos/yeomyeonggeori/oort/commits/*/check-runs\?* ]]; then
  echo "$endpoint" >>"$state/check_calls.log"
  query="${endpoint#*\?}"
  page="$(printf '%s\n' "$query" | tr '&' '\n' | sed -n 's/^page=//p')"
  [ -n "$page" ] || page=1
  phase=before
  if [ -s "$state/puts.log" ] || [ -s "$state/actions_puts.log" ]; then
    phase=after
  fi
  fixture="$state/checks.$phase.page$page.json"
  [ -f "$fixture" ] || fixture="$state/checks.before.page$page.json"
  [ -f "$fixture" ] || { echo '{"total_count":0,"check_runs":[]}'; exit 0; }
  cat "$fixture"
  exit 0
fi

if [[ "$endpoint" == repos/yeomyeonggeori/oort/branches/*/protection ]]; then
  encoded="${endpoint#repos/yeomyeonggeori/oort/branches/}"
  encoded="${encoded%/protection}"
  branch="$(printf '%s' "$encoded" | sed 's/%2F/\//g')"
  key="$(printf '%s' "$branch" | tr '/' '_')"
  policy="$state/$key.json"
  if [ "$method" = PUT ]; then
    cp "$input" "$policy"
    echo "$branch" >>"$state/puts.log"
    echo '{}'
    exit 0
  fi
  protection_reads_file="$state/$key.protection.reads"
  protection_reads="$(cat "$protection_reads_file" 2>/dev/null || echo 0)"
  protection_reads=$((protection_reads + 1))
  printf '%s\n' "$protection_reads" >"$protection_reads_file"
  mode="$(cat "$state/$key.mode" 2>/dev/null || echo ok)"
  case "$mode" in
    network) exit 1 ;;
    403) respond 403 Forbidden '{}' 1 ;;
    500) respond 500 ServerError '{}' 1 ;;
    invalid) respond 200 OK 'not-json' 0 ;;
    ok) ;;
    *) exit 2 ;;
  esac
  [ -f "$policy" ] || respond 404 NotFound '{}' 1
  if [ "$protection_reads" -gt 1 ] && [ -f "$state/$key.json_after_first_get" ]; then
    policy="$state/$key.json_after_first_get"
  fi
  body="$(jq '
    def actors($kind): map(
      if type != "string" then .
      elif $kind == "user" then {login: .}
      else {slug: .}
      end
    );
    . as $policy
    | {
        required_status_checks: $policy.required_status_checks,
        required_pull_request_reviews: (
          if $policy.required_pull_request_reviews == null then null
          else $policy.required_pull_request_reviews
            | .dismissal_restrictions.users = ((.dismissal_restrictions.users // []) | actors("user"))
            | .dismissal_restrictions.teams = ((.dismissal_restrictions.teams // []) | actors("team"))
            | .dismissal_restrictions.apps = ((.dismissal_restrictions.apps // []) | actors("app"))
            | .bypass_pull_request_allowances.users = ((.bypass_pull_request_allowances.users // []) | actors("user"))
            | .bypass_pull_request_allowances.teams = ((.bypass_pull_request_allowances.teams // []) | actors("team"))
            | .bypass_pull_request_allowances.apps = ((.bypass_pull_request_allowances.apps // []) | actors("app"))
          end
        ),
        restrictions: (
          if $policy.restrictions == null then null
          else $policy.restrictions
            | .users = ((.users // []) | actors("user"))
            | .teams = ((.teams // []) | actors("team"))
            | .apps = ((.apps // []) | actors("app"))
          end
        ),
        enforce_admins: {enabled: $policy.enforce_admins},
        required_linear_history: {enabled: $policy.required_linear_history},
        required_conversation_resolution: {enabled: $policy.required_conversation_resolution},
        allow_force_pushes: {enabled: $policy.allow_force_pushes},
        allow_deletions: {enabled: $policy.allow_deletions},
        block_creations: {enabled: $policy.block_creations},
        lock_branch: {enabled: $policy.lock_branch},
        allow_fork_syncing: {enabled: $policy.allow_fork_syncing}
      }
  ' "$policy")"
  respond 200 OK "$body" 0
fi

if [[ "$endpoint" == repos/yeomyeonggeori/oort/branches/* ]]; then
  encoded="${endpoint#repos/yeomyeonggeori/oort/branches/}"
  branch="$(printf '%s' "$encoded" | sed 's/%2F/\//g')"
  key="$(printf '%s' "$branch" | tr '/' '_')"
  reads_file="$state/$key.reads"
  reads="$(cat "$reads_file" 2>/dev/null || echo 0)"
  reads=$((reads + 1))
  printf '%s\n' "$reads" >"$reads_file"
  sha="$(cat "$state/$key.sha")"
  if [ -s "$state/puts.log" ] || [ -s "$state/actions_puts.log" ]; then
    [ ! -f "$state/$key.sha_after_put" ] || sha="$(cat "$state/$key.sha_after_put")"
  elif [ "$reads" -gt 1 ] && [ -f "$state/$key.sha_after_first" ]; then
    sha="$(cat "$state/$key.sha_after_first")"
  fi
  printf '{"commit":{"sha":"%s"}}\n' "$sha"
  exit 0
fi
exit 2
FAKE
chmod +x "$FAKE_GH"

run_guard() {
  rm -f "$STATE"/*.reads
  : >"$STATE/check_calls.log"
  FAKE_GH_STATE="$STATE" MOMO_GH_BIN="$FAKE_GH" "$GUARD" --repo yeomyeonggeori/oort "$@"
}

# Default mode is read-only. Explicit 404 alone means unprotected; it is still
# red in check mode and produces no remote write.
reset_mutations
if run_guard --check >"$SANDBOX/out" 2>&1; then
  fail "default check passed with unprotected branches"
fi
grep -Fq 'branch is unprotected' "$SANDBOX/out" || fail "check did not name explicit 404 as unprotected"
assert_put_zero "default check"

# Apply is fail-closed until all canonical refs share one SHA.
printf '%s\n' "$SHA_B" >"$STATE/track_uxui.sha"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply passed while canonical branch heads differed"
fi
grep -Fq 'canonical branches are not at one SHA' "$SANDBOX/out" || fail "SHA mismatch was not named"
assert_put_zero "SHA mismatch"
printf '%s\n' "$SHA_A" >"$STATE/track_uxui.sha"

# An older success must not mask the latest failure, and a same-named check from
# another App must never become the branch-protection source.
jq '.check_runs[0].conclusion = "failure"' "$STATE/checks.before.page2.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/checks.before.page2.json"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply accepted an older success after the latest failure"
fi
grep -Fq "latest 'PR CI gate' is not successful" "$SANDBOX/out" || fail "latest failure was not named"
assert_put_zero "latest failure"
write_valid_checks

jq '.check_runs[0].app = {id: 999, slug: "untrusted-ci"}' \
  "$STATE/checks.before.page2.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/checks.before.page2.json"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply accepted a same-named check from the wrong App"
fi
grep -Fq "came from app 'untrusted-ci'" "$SANDBOX/out" || fail "wrong App was not named"
assert_put_zero "wrong App"
write_valid_checks

printf '{"total_count":0,"check_runs":[]}\n' >"$STATE/checks.before.page1.json"
printf '{"total_count":0,"check_runs":[]}\n' >"$STATE/checks.before.page2.json"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply passed without a latest required check"
fi
grep -Fq "latest 'PR CI gate' missing" "$SANDBOX/out" || fail "missing latest check was not named"
assert_put_zero "missing latest check"
write_valid_checks

# Protection discovery may treat only an explicit 404 as absent. Auth, server,
# transport and malformed-body failures all abort before the first PUT.
for mode in 403 500 network invalid; do
  printf '%s\n' "$mode" >"$STATE/main.mode"
  reset_mutations
  if run_guard --apply >"$SANDBOX/out" 2>&1; then
    fail "protection GET mode $mode passed"
  fi
  assert_put_zero "protection GET $mode"
done
rm -f "$STATE/main.mode"

# Repository Actions permissions are part of the same fail-closed read set.
for mode in 500 network invalid; do
  printf '%s\n' "$mode" >"$STATE/actions.mode"
  reset_mutations
  if run_guard --apply >"$SANDBOX/out" 2>&1; then
    fail "Actions permissions GET mode $mode passed"
  fi
  assert_put_zero "Actions permissions GET $mode"
done
rm -f "$STATE/actions.mode"

# A branch moving between preflight and the pre-mutation recheck is a PUT-zero
# TOCTOU failure.
printf '%s\n' "$SHA_B" >"$STATE/track_uxui.sha_after_first"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply ignored a pre-PUT canonical SHA change"
fi
grep -Fq 'canonical branch SHA changed during apply' "$SANDBOX/out" || fail "pre-PUT TOCTOU was not named"
assert_put_zero "pre-PUT TOCTOU"
rm -f "$STATE/track_uxui.sha_after_first"

# Seed a stronger, noncompliant main policy. Apply must add the pinned context
# and baseline without weakening extra checks, reviews, restrictions, or linear
# history. The other explicit 404s are safe to create.
jq -n '{
  required_status_checks: {
    strict: true, contexts: [],
    checks: [{context: "security gate", app_id: 99}]
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    dismissal_restrictions: {users: ["review-admin"], teams: [], apps: []},
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 2,
    require_last_push_approval: true,
    bypass_pull_request_allowances: {users: [], teams: [], apps: []}
  },
  restrictions: {users: ["deploy-admin"], teams: ["release"], apps: ["deploy-app"]},
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: true,
  required_conversation_resolution: false,
  lock_branch: false,
  allow_fork_syncing: false
}' >"$STATE/main.json"

reset_mutations
run_guard --apply >"$SANDBOX/out" 2>&1 || fail "first apply failed: $(cat "$SANDBOX/out")"
[ "$(wc -l <"$STATE/puts.log" | tr -d ' ')" = 3 ] || fail "first apply did not update exactly three branches"
[ ! -s "$STATE/actions_puts.log" ] || fail "compliant Actions permissions were rewritten"
jq -e --argjson app_id "$APP_ID" '
  any(.required_status_checks.checks[]; .context == "PR CI gate" and .app_id == $app_id) and
  any(.required_status_checks.checks[]; .context == "security gate" and .app_id == 99) and
  (.required_pull_request_reviews.required_approving_review_count == 2) and
  (.required_pull_request_reviews.require_code_owner_reviews == true) and
  (.required_pull_request_reviews.require_last_push_approval == true) and
  (.required_pull_request_reviews.dismissal_restrictions.users == ["review-admin"]) and
  (.restrictions.users == ["deploy-admin"]) and
  (.restrictions.teams == ["release"]) and
  (.restrictions.apps == ["deploy-app"]) and
  (.required_linear_history == true) and
  (.block_creations == true)
' "$STATE/main.json" >/dev/null || fail "apply weakened the existing stronger main policy"

# The latest check lived on page 2, and the request must pin exact endpoint
# filters rather than accepting a broad commit check list.
grep -Fq 'check_name=PR%20CI%20gate&filter=latest&per_page=100&page=2' \
  "$STATE/check_calls.log" || fail "latest check query did not paginate/filter by exact name"

# An administrator adding a stronger policy after the first read must not have
# that change silently overwritten by a stale payload. The second protection
# snapshot is compared before any repository mutation.
jq '
  .required_status_checks.checks += [{context: "concurrent security gate", app_id: 314}] |
  .required_linear_history = true
' "$STATE/track_engine.json" >"$STATE/track_engine.json_after_first_get"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply overwrote a concurrent stronger protection change"
fi
grep -Fq 'track/engine protection changed during apply' "$SANDBOX/out" \
  || fail "concurrent protection drift was not named"
assert_put_zero "concurrent protection drift"
rm -f "$STATE/track_engine.json_after_first_get"

reset_mutations
run_guard --check >/dev/null || fail "check failed after apply"
reset_mutations
run_guard --apply >"$SANDBOX/out" 2>&1 || fail "idempotent apply failed: $(cat "$SANDBOX/out")"
assert_put_zero "idempotent apply"
grep -Fq 'unchanged: track/uxui already compliant' "$SANDBOX/out" || fail "idempotency was not reported"

# Any PR bypass actor makes compliance red; apply removes exactly that bypass
# while retaining all unrelated settings.
jq '.required_pull_request_reviews.bypass_pull_request_allowances.users = ["octocat"]' \
  "$STATE/track_uxui.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/track_uxui.json"
reset_mutations
if run_guard --check >"$SANDBOX/out" 2>&1; then
  fail "non-empty PR bypass users passed check"
fi
grep -Fq 'PR bypass users must be empty' "$SANDBOX/out" || fail "PR bypass drift was not named"
assert_put_zero "bypass check"
reset_mutations
run_guard --apply >/dev/null || fail "bypass repair apply failed"
[ "$(wc -l <"$STATE/puts.log" | tr -d ' ')" = 1 ] || fail "bypass repair did not update exactly one branch"
jq -e '
  (.required_pull_request_reviews.bypass_pull_request_allowances.users | length) == 0 and
  (.required_pull_request_reviews.bypass_pull_request_allowances.teams | length) == 0 and
  (.required_pull_request_reviews.bypass_pull_request_allowances.apps | length) == 0
' "$STATE/track_uxui.json" >/dev/null || fail "bypass repair did not empty all actor classes"

# Repository-wide GITHUB_TOKEN defaults must be read-only and unable to approve
# PRs. Check is read-only; apply narrowly repairs and rechecks this endpoint.
printf '{"default_workflow_permissions":"write","can_approve_pull_request_reviews":true}\n' \
  >"$STATE/actions.json"
reset_mutations
if run_guard --check >"$SANDBOX/out" 2>&1; then
  fail "write/approve Actions defaults passed check"
fi
grep -Fq 'default workflow permission must be read' "$SANDBOX/out" || fail "Actions write default was not named"
grep -Fq 'must not approve pull requests' "$SANDBOX/out" || fail "Actions PR approval was not named"
assert_put_zero "Actions permissions check"
reset_mutations
run_guard --apply >/dev/null || fail "Actions permissions repair failed"
[ "$(wc -l <"$STATE/actions_puts.log" | tr -d ' ')" = 1 ] || fail "Actions permissions were not narrowly updated once"
[ ! -s "$STATE/puts.log" ] || fail "Actions-only repair rewrote branch protection"
jq -e '.default_workflow_permissions == "read" and .can_approve_pull_request_reviews == false' \
  "$STATE/actions.json" >/dev/null || fail "Actions permissions repair payload is unsafe"

# Post-apply branch and context reads are mandatory. These fixtures move the
# branch or replace the latest context only after a repair PUT and must turn the
# overall operation red instead of reporting a stale success.
jq '.allow_force_pushes = true' "$STATE/main.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/main.json"
printf '%s\n' "$SHA_B" >"$STATE/main.sha_after_put"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply reported success after a post-PUT SHA change"
fi
grep -Fq 'canonical branch SHA changed during apply' "$SANDBOX/out" || fail "post-PUT SHA recheck was not enforced"
[ -s "$STATE/puts.log" ] || fail "post-PUT SHA fixture never reached mutation"
rm -f "$STATE/main.sha_after_put"

jq '.allow_force_pushes = true' "$STATE/main.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/main.json"
cp "$STATE/checks.before.page1.json" "$STATE/checks.after.page1.json"
jq '.check_runs[0].conclusion = "failure"' "$STATE/checks.before.page2.json" \
  >"$STATE/checks.after.page2.json"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply reported success after the post-PUT latest context failed"
fi
grep -Fq "latest 'PR CI gate' is not successful" "$SANDBOX/out" || fail "post-PUT context recheck was not enforced"
[ -s "$STATE/puts.log" ] || fail "post-PUT context fixture never reached mutation"
rm -f "$STATE/checks.after.page1.json" "$STATE/checks.after.page2.json"

echo "[github-guardrails-test] PASS fail-closed reads, latest app pin, preservation, permissions, TOCTOU, and idempotency"
