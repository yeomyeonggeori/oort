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
SHA_C="cccccccccccccccccccccccccccccccccccccccc"
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
  : >"$STATE/put_attempts.log"
  : >"$STATE/actions_puts.log"
}

assert_put_zero() {
  [ ! -s "$STATE/puts.log" ] || fail "$1 wrote branch protection"
  [ ! -s "$STATE/actions_puts.log" ] || fail "$1 wrote Actions permissions"
}

make_all_branches_need_put() {
  local branch_key
  for branch_key in main track_engine track_uxui; do
    jq '.allow_force_pushes = true' "$STATE/$branch_key.json" >"$STATE/tmp.json"
    mv "$STATE/tmp.json" "$STATE/$branch_key.json"
  done
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
printf '{"id":%s,"slug":"github-actions"}\n' "$APP_ID" >"$STATE/app.json"
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

if [ "$endpoint" = 'apps/github-actions' ]; then
  mode="$(cat "$state/app.mode" 2>/dev/null || echo ok)"
  case "$mode" in
    ok) cat "$state/app.json"; exit 0 ;;
    network) exit 1 ;;
    500) echo 'fixture HTTP 500' >&2; exit 1 ;;
    invalid) echo 'not-json'; exit 0 ;;
    *) exit 2 ;;
  esac
fi

if [[ "$endpoint" == repos/yeomyeonggeori/oort/compare/* ]]; then
  mode="$(cat "$state/compare.mode" 2>/dev/null || echo ahead)"
  case "$mode" in
    network) exit 1 ;;
    500) echo 'fixture HTTP 500' >&2; exit 1 ;;
    invalid) echo 'not-json'; exit 0 ;;
    ahead) ;;
    long_ahead) ;;
    diverged) ;;
    *) exit 2 ;;
  esac
  pair="${endpoint#repos/yeomyeonggeori/oort/compare/}"
  base="${pair%%...*}"
  head="${pair#*...}"
  if [ "$mode" = ahead ]; then
    printf '{"status":"ahead","ahead_by":1,"behind_by":0,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
      "$base" "$base" "$head"
  elif [ "$mode" = long_ahead ]; then
    # GitHub truncates the commits array on long comparisons. The ancestry
    # metadata remains authoritative and refs are re-read by the guard.
    printf '{"status":"ahead","ahead_by":501,"behind_by":0,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
      "$base" "$base" cccccccccccccccccccccccccccccccccccccccc
  else
    printf '{"status":"diverged","ahead_by":1,"behind_by":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
      "$base" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "$head"
  fi
  exit 0
fi

if [ "$endpoint" = 'repos/yeomyeonggeori/oort/actions/workflows/pr-ci.yml' ]; then
  workflow_state="$(cat "$state/workflow.state" 2>/dev/null || echo active)"
  disable_after="$(cat "$state/workflow.disable_after_put" 2>/dev/null || echo 0)"
  successful_puts="$(wc -l <"$state/puts.log" | tr -d ' ')"
  if [ "$disable_after" -gt 0 ] && [ "$successful_puts" -ge "$disable_after" ]; then
    workflow_state=disabled_manually
  fi
  printf '{"state":"%s"}\n' "$workflow_state"
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
    echo "$branch" >>"$state/put_attempts.log"
    attempt="$(wc -l <"$state/put_attempts.log" | tr -d ' ')"
    fail_at="$(cat "$state/fail_branch_put_at" 2>/dev/null || echo 0)"
    if [ "$fail_at" -gt 0 ] && [ "$attempt" -eq "$fail_at" ]; then
      echo "fixture branch PUT $attempt failed" >&2
      exit 1
    fi
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
  successful_puts="$(wc -l <"$state/puts.log" | tr -d ' ')"
  if [ "$successful_puts" -gt 0 ] && [ -f "$state/$key.json_after_put_$successful_puts" ]; then
    cp "$state/$key.json_after_put_$successful_puts" "$state/$key.json"
    rm -f "$state/$key.json_after_put_$successful_puts"
    policy="$state/$key.json"
  fi
  if [ "$protection_reads" -gt 1 ] && [ -f "$state/$key.json_after_first_get" ]; then
    cp "$state/$key.json_after_first_get" "$state/$key.json"
    rm -f "$state/$key.json_after_first_get"
    policy="$state/$key.json"
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

jq '.check_runs[0].app.id = 999' \
  "$STATE/checks.before.page2.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/checks.before.page2.json"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply accepted the GitHub Actions slug with the wrong App id"
fi
grep -Fq 'required check app id changed during apply' "$SANDBOX/out" \
  || fail "wrong GitHub Actions App id was not named"
assert_put_zero "wrong GitHub Actions App id"
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

# The read-only drift check resolves the official GitHub Actions App directly;
# it must fail closed without depending on a recent successful workflow run.
for mode in 500 network invalid; do
  printf '%s\n' "$mode" >"$STATE/app.mode"
  reset_mutations
  if run_guard --check >"$SANDBOX/out" 2>&1; then
    fail "GitHub Actions App lookup mode $mode passed"
  fi
  assert_put_zero "GitHub Actions App lookup $mode"
done
rm -f "$STATE/app.mode"

# A branch moving between preflight and the pre-mutation recheck is a PUT-zero
# TOCTOU failure.
printf '%s\n' "$SHA_B" >"$STATE/track_uxui.sha_after_first"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply ignored a pre-PUT canonical SHA change: $(cat "$SANDBOX/out")"
fi
grep -Eq 'canonical branch SHA changed during apply|canonical branches are not at one SHA' "$SANDBOX/out" \
  || fail "pre-PUT TOCTOU was not named: $(cat "$SANDBOX/out")"
assert_put_zero "pre-PUT TOCTOU"
rm -f "$STATE/track_uxui.sha_after_first"

# Seed a stronger, noncompliant main policy. Apply must add the pinned context
# and baseline without weakening extra checks, reviews, restrictions, or linear
# history. The other explicit 404s are safe to create.
jq -n '{
  required_status_checks: {
    strict: true, contexts: ["legacy context", "PR CI gate"],
    checks: [
      {context: "security gate", app_id: 99},
      {context: "PR CI gate", app_id: -1},
      {context: "PR CI gate", app_id: 777}
    ]
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
  any(.required_status_checks.checks[]; .context == "PR CI gate" and .app_id == -1) and
  any(.required_status_checks.checks[]; .context == "PR CI gate" and .app_id == 777) and
  any(.required_status_checks.checks[]; .context == "legacy context" and .app_id == -1) and
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

# Normal steady state permits tracks to advance from main. Read-only policy
# drift checks stay green, while --apply remains a bootstrap-only exact-SHA gate.
printf '%s\n' "$SHA_B" >"$STATE/track_uxui.sha"
reset_mutations
run_guard --check >"$SANDBOX/out" 2>&1 || fail "track-ahead read-only check failed: $(cat "$SANDBOX/out")"
[ ! -s "$STATE/check_calls.log" ] || fail "read-only check depended on a recent PR CI run"
assert_put_zero "track-ahead check"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "bootstrap apply accepted track-ahead heads"
fi
grep -Fq 'canonical branches are not at one SHA' "$SANDBOX/out" || fail "track-ahead apply was not blocked"
assert_put_zero "track-ahead apply"
printf '%s\n' "$SHA_A" >"$STATE/track_uxui.sha"

# Long-ahead compares truncate `.commits`; ancestry metadata plus live ref
# re-reads must still accept the healthy topology.
printf '%s\n' "$SHA_B" >"$STATE/track_uxui.sha"
printf 'long_ahead\n' >"$STATE/compare.mode"
reset_mutations
run_guard --check >"$SANDBOX/out" 2>&1 \
  || fail "long-ahead truncated compare failed: $(cat "$SANDBOX/out")"
assert_put_zero "long-ahead topology check"
printf '%s\n' "$SHA_A" >"$STATE/track_uxui.sha"
rm -f "$STATE/compare.mode"

printf '%s\n' "$SHA_B" >"$STATE/track_engine.sha"
printf '%s\n' "$SHA_C" >"$STATE/track_engine.sha_after_first"
reset_mutations
if run_guard --check >"$SANDBOX/out" 2>&1; then
  fail "read-only check accepted a track ref that moved after compare"
fi
grep -Fq 'branch moved while ancestry was checked' "$SANDBOX/out" \
  || fail "post-compare ref re-read was not enforced"
assert_put_zero "moving track topology check"
printf '%s\n' "$SHA_A" >"$STATE/track_engine.sha"
rm -f "$STATE/track_engine.sha_after_first"

printf '%s\n' "$SHA_B" >"$STATE/track_engine.sha"
printf 'diverged\n' >"$STATE/compare.mode"
reset_mutations
if run_guard --check >"$SANDBOX/out" 2>&1; then
  fail "read-only check accepted a diverged track"
fi
grep -Fq 'main is not an ancestor of the track head' "$SANDBOX/out" \
  || fail "diverged track topology was not named"
assert_put_zero "diverged topology check"
printf '%s\n' "$SHA_A" >"$STATE/track_engine.sha"
rm -f "$STATE/compare.mode"

# An administrator adding a stronger policy after the first read must not have
# that change silently overwritten by a stale payload. A fresh read folds it
# into the monotonic preservation contract.
jq '
  .required_status_checks.checks += [{context: "concurrent security gate", app_id: 314}] |
  .required_linear_history = true
' "$STATE/track_engine.json" >"$STATE/track_engine.json_after_first_get"
reset_mutations
run_guard --apply >"$SANDBOX/out" 2>&1 \
  || fail "concurrent stronger protection merge failed: $(cat "$SANDBOX/out")"
jq -e '
  any(.required_status_checks.checks[];
    .context == "concurrent security gate" and .app_id == 314) and
  .required_linear_history == true
' "$STATE/track_engine.json" >/dev/null \
  || fail "concurrent stronger protection was not retained"
rm -f "$STATE/track_engine.json_after_first_get"

reset_mutations
run_guard --check >/dev/null || fail "check failed after apply"
reset_mutations
run_guard --apply >"$SANDBOX/out" 2>&1 || fail "idempotent apply failed: $(cat "$SANDBOX/out")"
assert_put_zero "idempotent apply"
grep -Fq 'unchanged: track/uxui already compliant' "$SANDBOX/out" || fail "idempotency was not reported"

# Dismissal and push restrictions are authorization allowlists, so neither a
# union nor a subset heuristic is safe. Removal, replacement, and addition
# between the initial read and fresh pre-PUT read all abort before mutation.
cp "$STATE/main.json" "$STATE/main.actor_baseline.json"
for actor_change in removal replacement addition; do
  cp "$STATE/main.actor_baseline.json" "$STATE/main.json"
  case "$actor_change" in
    removal)
      jq '.required_pull_request_reviews.dismissal_restrictions.users = []' \
        "$STATE/main.json" >"$STATE/main.json_after_first_get"
      ;;
    replacement)
      jq '.restrictions.users = ["replacement-admin"]' \
        "$STATE/main.json" >"$STATE/main.json_after_first_get"
      ;;
    addition)
      jq '.restrictions.teams += ["intruder-team"]' \
        "$STATE/main.json" >"$STATE/main.json_after_first_get"
      ;;
  esac
  reset_mutations
  if run_guard --apply >"$SANDBOX/out" 2>&1; then
    fail "actor allowlist $actor_change passed instead of failing closed"
  fi
  grep -Fq 'main authorization allowlist changed during apply' "$SANDBOX/out" \
    || fail "actor allowlist $actor_change was not named"
  assert_put_zero "actor allowlist $actor_change"
done
cp "$STATE/main.actor_baseline.json" "$STATE/main.json"
rm -f "$STATE/main.actor_baseline.json" "$STATE/main.json_after_first_get"

# `allow_fork_syncing` is also an allow switch: false is stricter. Any
# initial→fresh direction change is concurrent authority drift, so both
# true→false and false→true fail before a branch PUT rather than guessing.
jq '.allow_fork_syncing = true' "$STATE/main.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/main.json"
jq '.allow_fork_syncing = false' "$STATE/main.json" >"$STATE/main.json_after_first_get"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "allow_fork_syncing true-to-false drift passed"
fi
grep -Fq 'main authorization allowlist changed during apply' "$SANDBOX/out" \
  || fail "allow_fork_syncing true-to-false drift was not named"
assert_put_zero "allow_fork_syncing true-to-false"
rm -f "$STATE/main.json_after_first_get"
jq '.allow_fork_syncing = false' "$STATE/main.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/main.json"

jq '.allow_fork_syncing = true' "$STATE/main.json" >"$STATE/main.json_after_first_get"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "allow_fork_syncing false-to-true drift passed"
fi
grep -Fq 'main authorization allowlist changed during apply' "$SANDBOX/out" \
  || fail "allow_fork_syncing false-to-true drift was not named"
assert_put_zero "allow_fork_syncing false-to-true"
rm -f "$STATE/main.json_after_first_get"
jq '.allow_fork_syncing = false' "$STATE/main.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/main.json"

# A stronger track/engine change landing after main's PUT is folded into the
# next fresh payload, including same-context/different-App pairs and higher
# review requirements. This is the lost-update boundary for sequential PUTs.
make_all_branches_need_put
jq '
  .required_status_checks.checks += [
    {context: "between-put security", app_id: 2718},
    {context: "PR CI gate", app_id: 4242}
  ] |
  .required_pull_request_reviews.required_approving_review_count = 4 |
  .required_pull_request_reviews.require_code_owner_reviews = true |
  .lock_branch = true
' "$STATE/track_engine.json" >"$STATE/track_engine.json_after_put_1"
reset_mutations
run_guard --apply >"$SANDBOX/out" 2>&1 \
  || fail "between-PUT stronger mutation failed: $(cat "$SANDBOX/out")"
[ "$(wc -l <"$STATE/puts.log" | tr -d ' ')" = 3 ] \
  || fail "between-PUT fixture did not exercise all three branch PUTs"
jq -e '
  any(.required_status_checks.checks[];
    .context == "between-put security" and .app_id == 2718) and
  any(.required_status_checks.checks[];
    .context == "PR CI gate" and .app_id == 4242) and
  (.required_pull_request_reviews.required_approving_review_count == 4) and
  (.required_pull_request_reviews.require_code_owner_reviews == true) and
  (.lock_branch == true)
' "$STATE/track_engine.json" >/dev/null \
  || fail "between-PUT stronger requirements were lost"

# Workflow activity is part of every pre-PUT basis. A disable after main's
# successful write stops the next branch and emits an actionable partial-apply
# marker instead of a false success.
make_all_branches_need_put
printf '1\n' >"$STATE/workflow.disable_after_put"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply continued after pr-ci was disabled between branch PUTs"
fi
grep -Fq 'pr-ci workflow is not active' "$SANDBOX/out" \
  || fail "between-PUT workflow disable was not named"
grep -Fq 'APPLY_INCOMPLETE recovery_required=true completed=main' "$SANDBOX/out" \
  || fail "workflow disable did not report partial-apply recovery"
[ "$(wc -l <"$STATE/puts.log" | tr -d ' ')" = 1 ] \
  || fail "workflow disable did not stop before the second branch PUT"
rm -f "$STATE/workflow.disable_after_put"
reset_mutations
run_guard --apply >/dev/null || fail "workflow-disable recovery apply failed"

# GitHub protection writes are not atomic across branches. Failures on the
# second and third attempted PUT must stop immediately, identify completed
# targets, and remain safely retryable.
for fail_at in 2 3; do
  make_all_branches_need_put
  printf '%s\n' "$fail_at" >"$STATE/fail_branch_put_at"
  reset_mutations
  if run_guard --apply >"$SANDBOX/out" 2>&1; then
    fail "apply succeeded when branch PUT $fail_at failed"
  fi
  expected_successes=$((fail_at - 1))
  [ "$(wc -l <"$STATE/put_attempts.log" | tr -d ' ')" = "$fail_at" ] \
    || fail "branch PUT $fail_at failure did not stop at the expected attempt"
  [ "$(wc -l <"$STATE/puts.log" | tr -d ' ')" = "$expected_successes" ] \
    || fail "branch PUT $fail_at failure reported the wrong successful write count"
  grep -Fq 'APPLY_INCOMPLETE recovery_required=true' "$SANDBOX/out" \
    || fail "branch PUT $fail_at failure lacked the partial-apply marker"
  grep -Fq 'recovery: fix' "$SANDBOX/out" \
    || fail "branch PUT $fail_at failure lacked retry guidance"
  rm -f "$STATE/fail_branch_put_at"
  reset_mutations
  run_guard --apply >/dev/null || fail "branch PUT $fail_at recovery apply failed"
done

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

# A late authorization expansion after main's PUT must fail the exact-payload
# assertion. Superset acceptance would silently authorize the new actor.
cp "$STATE/main.json" "$STATE/main.before_actor_expansion.json"
jq '.allow_force_pushes = true' "$STATE/main.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/main.json"
jq '
  .allow_force_pushes = false |
  .restrictions.users += ["late-intruder"]
' "$STATE/main.json" >"$STATE/main.json_after_put_1"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply accepted a final unauthorized actor expansion"
fi
grep -Fq 'final authorization allowlist differs from the exact fresh payload' "$SANDBOX/out" \
  || fail "final unauthorized actor expansion was not named"
grep -Fq 'APPLY_INCOMPLETE recovery_required=true' "$SANDBOX/out" \
  || fail "final unauthorized actor expansion lacked recovery signal"
cp "$STATE/main.before_actor_expansion.json" "$STATE/main.json"
rm -f "$STATE/main.before_actor_expansion.json" "$STATE/main.json_after_put_1"

# The final verification must compare against the accumulated contract, not
# just today's baseline. Simulate a late actor removing an initially observed
# custom check after this invocation wrote main.
cp "$STATE/main.json" "$STATE/main.before_lost_update.json"
jq '.allow_force_pushes = true' "$STATE/main.json" >"$STATE/tmp.json"
mv "$STATE/tmp.json" "$STATE/main.json"
jq '
  .allow_force_pushes = false |
  .required_status_checks.checks |= map(select(.context != "security gate"))
' "$STATE/main.json" >"$STATE/main.json_after_put_1"
reset_mutations
if run_guard --apply >"$SANDBOX/out" 2>&1; then
  fail "apply reported success after an observed stronger check was lost"
fi
grep -Fq 'an observed stronger protection requirement was lost' "$SANDBOX/out" \
  || fail "post-apply preservation loss was not named"
grep -Fq 'APPLY_INCOMPLETE recovery_required=true' "$SANDBOX/out" \
  || fail "post-apply preservation loss lacked recovery signal"
cp "$STATE/main.before_lost_update.json" "$STATE/main.json"
rm -f "$STATE/main.before_lost_update.json" "$STATE/main.json_after_put_1"

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

echo "[github-guardrails-test] PASS topology, app pin, fail-closed reads, preservation, TOCTOU, and idempotency"
