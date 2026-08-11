#!/usr/bin/env bash
# Offline trust-anchor fixtures for verify_policy_integrity_from_base.sh.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
WRAPPER="$REPO_ROOT/scripts/verify_policy_integrity_from_base.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-trusted-policy-runner-test.XXXXXX")"
SOURCE_REPO="$SANDBOX/source"
FAKE_GH="$SANDBOX/gh"

cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

fail() {
  echo "[trusted-policy-runner-test] FAIL: $*" >&2
  exit 1
}

[ -x "$WRAPPER" ] || fail "trusted-base wrapper is not executable"

mkdir -p "$SOURCE_REPO/scripts"
git -C "$SOURCE_REPO" init -q -b track/engine
cp "$WRAPPER" "$SOURCE_REPO/scripts/verify_policy_integrity_from_base.sh"
chmod +x "$SOURCE_REPO/scripts/verify_policy_integrity_from_base.sh"
cat >"$SOURCE_REPO/scripts/verify_policy_integrity.sh" <<'TRUSTED_VERIFIER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" | grep -F -- '--verify-run' >/dev/null
printf '%s\n' "$*" | grep -F -- '--expected-base track/engine' >/dev/null
echo "TRUSTED_BASE_SENTINEL"
TRUSTED_VERIFIER
chmod +x "$SOURCE_REPO/scripts/verify_policy_integrity.sh"
git -C "$SOURCE_REPO" add scripts
git -C "$SOURCE_REPO" \
  -c user.name=fixture -c user.email=fixture@example.invalid \
  commit -q -m "fixture trusted base"
BASE_SHA="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OTHER_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

mode="$(git -C "$SOURCE_REPO" ls-files -s scripts/verify_policy_integrity_from_base.sh | awk '{print $1}')"
[ "$mode" = "100755" ] || fail "trusted-base wrapper lost executable git mode"

cat >"$FAKE_GH" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
STATE="${FAKE_RUNNER_STATE:?}"
printf '%s\n' "$*" >>"$STATE/calls.log"
if [ "${1:-}" = "--version" ]; then
  echo "gh version fake"
  exit 0
fi
[ "${1:-}" = "api" ] || { echo "unexpected gh command: $*" >&2; exit 64; }
endpoint="${!#}"
[ "$endpoint" = "repos/example/oort/pulls/42" ] \
  || { echo "unexpected endpoint: $endpoint" >&2; exit 64; }
reads=0
[ ! -f "$STATE/reads" ] || reads="$(cat "$STATE/reads")"
reads=$((reads + 1))
printf '%s\n' "$reads" >"$STATE/reads"
if [ "$reads" -ge 2 ] && [ -f "$STATE/pr.after.json" ]; then
  cat "$STATE/pr.after.json"
else
  cat "$STATE/pr.json"
fi
FAKE_GH
chmod +x "$FAKE_GH"

write_pr() {
  local state="$1"
  local base_sha="$2"
  local base_ref="${3:-track/engine}"
  mkdir -p "$state"
  rm -f "$state/reads" "$state/pr.after.json" "$state/calls.log"
  jq -n \
    --arg head "$HEAD_SHA" --arg base "$base_ref" --arg base_sha "$base_sha" '{
      number: 42, state: "open", head: {sha: $head},
      base: {ref: $base, sha: $base_sha}
    }' >"$state/pr.json"
}

clone_case() {
  local name="$1"
  local destination="$SANDBOX/$name"
  git clone -q --branch track/engine "$SOURCE_REPO" "$destination"
  printf '%s\n' "$destination"
}

run_red() {
  local name="$1"
  local repo="$2"
  local state="$3"
  local expected="$4"
  if FAKE_RUNNER_STATE="$state" MOMO_GH_BIN="$FAKE_GH" \
    MOMO_POLICY_RUNNER_FIXTURE=offline-fixture-v1 \
    "$repo/scripts/verify_policy_integrity_from_base.sh" \
      --repo example/oort --pr 42 >"$SANDBOX/out" 2>&1; then
    fail "$name passed instead of failing closed"
  fi
  grep -Fq "$expected" "$SANDBOX/out" \
    || fail "$name did not name '$expected': $(cat "$SANDBOX/out")"
}

# The candidate/worktree verifier may be arbitrary; only the exact committed
# base object is executed.
case_repo="$(clone_case green)"
state="$SANDBOX/state-green"
write_pr "$state" "$BASE_SHA"
printf '%s\n' '#!/usr/bin/env bash' 'echo CANDIDATE_VERIFIER_EXECUTED' 'exit 91' \
  >"$case_repo/scripts/verify_policy_integrity.sh"
chmod +x "$case_repo/scripts/verify_policy_integrity.sh"
FAKE_RUNNER_STATE="$state" MOMO_GH_BIN="$FAKE_GH" \
  MOMO_POLICY_RUNNER_FIXTURE=offline-fixture-v1 \
  "$case_repo/scripts/verify_policy_integrity_from_base.sh" \
    --repo example/oort --pr 42 >"$SANDBOX/out" 2>&1 \
  || fail "clean exact-base wrapper did not execute the committed verifier: $(cat "$SANDBOX/out")"
grep -Fq 'TRUSTED_BASE_SENTINEL' "$SANDBOX/out" \
  || fail "committed base verifier did not run"
if grep -Fq 'CANDIDATE_VERIFIER_EXECUTED' "$SANDBOX/out"; then
  fail "candidate/worktree verifier executed"
fi

: >"$state/calls.log"
if FAKE_RUNNER_STATE="$state" MOMO_GH_BIN="$FAKE_GH" \
  "$case_repo/scripts/verify_policy_integrity_from_base.sh" \
  --repo yeomyeonggeori/oort --pr 42 >"$SANDBOX/out" 2>&1; then
  fail "production transport override was accepted"
fi
grep -Fq 'MOMO_GH_BIN override is forbidden outside the offline fixture' "$SANDBOX/out" \
  || fail "production transport override failure was not explicit"
[ ! -s "$state/calls.log" ] || fail "forbidden production transport override executed before rejection"

case_repo="$(clone_case wrong-branch)"
git -C "$case_repo" switch -q -c main
state="$SANDBOX/state-wrong-branch"
write_pr "$state" "$BASE_SHA"
run_red wrong-branch "$case_repo" "$state" "current branch 'main' is not PR base 'track/engine'"

case_repo="$(clone_case wrong-head)"
printf '%s\n' moved >"$case_repo/head-marker"
git -C "$case_repo" add head-marker
git -C "$case_repo" -c user.name=fixture -c user.email=fixture@example.invalid \
  commit -q -m "move local base"
state="$SANDBOX/state-wrong-head"
write_pr "$state" "$BASE_SHA"
run_red wrong-head "$case_repo" "$state" 'current HEAD is not the PR API exact base SHA'

case_repo="$(clone_case dirty-wrapper)"
printf '%s\n' '# local tamper' >>"$case_repo/scripts/verify_policy_integrity_from_base.sh"
state="$SANDBOX/state-dirty-wrapper"
write_pr "$state" "$BASE_SHA"
run_red dirty-wrapper "$case_repo" "$state" 'running wrapper bytes differ from the PR exact base SHA'

case_repo="$(clone_case replacement-ref)"
printf '%s\n' '#!/usr/bin/env bash' 'echo REPLACEMENT_VERIFIER_EXECUTED' 'exit 0' \
  >"$case_repo/scripts/verify_policy_integrity.sh"
git -C "$case_repo" add scripts/verify_policy_integrity.sh
replacement_tree="$(git -C "$case_repo" write-tree)"
replacement_commit="$(printf '%s\n' 'replacement attack fixture' \
  | git -C "$case_repo" -c user.name=fixture -c user.email=fixture@example.invalid \
      commit-tree "$replacement_tree" -p "$BASE_SHA")"
git -C "$case_repo" replace "$BASE_SHA" "$replacement_commit"
state="$SANDBOX/state-replacement-ref"
write_pr "$state" "$BASE_SHA"
run_red replacement-ref "$case_repo" "$state" 'git replacement refs are forbidden during trusted verification'

case_repo="$(clone_case missing-verifier)"
git -C "$case_repo" rm -q scripts/verify_policy_integrity.sh
git -C "$case_repo" -c user.name=fixture -c user.email=fixture@example.invalid \
  commit -q -m "remove verifier"
missing_base="$(git -C "$case_repo" rev-parse HEAD)"
state="$SANDBOX/state-missing-verifier"
write_pr "$state" "$missing_base"
run_red missing-verifier "$case_repo" "$state" 'trusted verifier is missing from the PR exact base SHA'

case_repo="$(clone_case base-move)"
state="$SANDBOX/state-base-move"
write_pr "$state" "$BASE_SHA"
jq --arg other "$OTHER_SHA" '.base.sha = $other' "$state/pr.json" >"$state/pr.after.json"
run_red base-move "$case_repo" "$state" 'PR head/base changed while extracting the trusted verifier'

echo "[trusted-policy-runner-test] PASS exact-base extraction and wrapper/base tamper fixtures"
