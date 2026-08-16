#!/usr/bin/env bash
# Isolated proofs for the base-branch resolution in scripts/goal_claim.sh.
# A local bare repository stands in for origin and a fake gh serves the issue,
# so no GitHub state is read or written and no network is used.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
CLAIM="$REPO_ROOT/scripts/goal_claim.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-goal-claim-base.XXXXXX")"
FIXTURE="$SANDBOX/repo"
STATE="$SANDBOX/state"
BIN="$SANDBOX/bin"
REAL_GIT="$(command -v git)"
ISSUE_NUMBER=4242
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
mkdir -p "$STATE" "$BIN"

fail() {
  echo "[goal-claim-base-test] FAIL: $*" >&2
  if [ -f "$SANDBOX/out" ]; then cat "$SANDBOX/out" >&2; fi
  exit 1
}

# The only faked git surface is the origin identity assertion; everything else
# runs against the real git and the local bare origin.
cat >"$BIN/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "remote" ] && [ "\$2" = "get-url" ]; then
  echo "https://github.com/yeomyeonggeori/oort.git"
  exit 0
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$BIN/git"

cat >"$BIN/gh" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "issue" ] && [ "\$2" = "view" ]; then
  cat "$STATE/issue.json"
  exit 0
fi
echo "unexpected gh call: \$*" >&2
exit 1
EOF
chmod +x "$BIN/gh"

git init -q --bare "$SANDBOX/origin.git"
git init -q "$FIXTURE"
git -C "$FIXTURE" config user.name "Oort Goal Fixture"
git -C "$FIXTURE" config user.email "goal-fixture@oort.invalid"
git -C "$FIXTURE" remote add origin "$SANDBOX/origin.git"
mkdir -p "$FIXTURE/docs"
cat >"$FIXTURE/docs/TRACKS.md" <<'EOF'
# fixture tracks

| 트랙 | 소유 파일군 | 트랙 브랜치 |
|---|---|---|
| **UXUI** | `clients/web/**`, `clients/mobile/**` | `track/uxui` |
| **엔진** | `server-rust/**`, `scripts/**` | `track/engine` |
EOF
printf 'base\n' >"$FIXTURE/state.txt"
git -C "$FIXTURE" add state.txt docs/TRACKS.md
git -C "$FIXTURE" commit -qm base
git -C "$FIXTURE" branch -M main
git -C "$FIXTURE" push -q origin main
git -C "$FIXTURE" push -q origin main:refs/heads/track/engine
git -C "$FIXTURE" push -q origin main:refs/heads/track/uxui
git -C "$FIXTURE" checkout -q -b work

write_issue() {
  local title="$1" body="$2" labels_csv="$3"
  jq -n \
    --arg t "$title" \
    --arg b "$body" \
    --arg l "$labels_csv" \
    --argjson n "$ISSUE_NUMBER" \
    '{
      number: $n,
      title: $t,
      body: $b,
      state: "OPEN",
      assignees: [],
      url: ("https://github.com/yeomyeonggeori/oort/issues/" + ($n | tostring)),
      labels: ($l | split(",") | map(select(length > 0) | {name: .}))
    }' >"$STATE/issue.json"
}

run_claim() {
  (cd "$FIXTURE" && PATH="$BIN:$PATH" bash "$CLAIM" --dry-run "$ISSUE_NUMBER" "$@") \
    >"$SANDBOX/out" 2>&1
}

expect_base() {
  local label="$1" expected="$2"
  shift 2
  run_claim "$@" || fail "$label: claim exited non-zero"
  grep -Fq "base:     $expected" "$SANDBOX/out" \
    || fail "$label: expected base '$expected'"
  grep -Fq "[dry-run] would fetch origin/${expected%% *}" "$SANDBOX/out" \
    || fail "$label: dry-run did not name the resolved base in the fetch line"
}

expect_red() {
  local label="$1" needle="$2"
  shift 2
  if run_claim "$@"; then
    fail "$label: claim should have failed"
  fi
  grep -Fq "$needle" "$SANDBOX/out" || fail "$label: missing '$needle'"
}

# 1. No signal at all keeps the historical behaviour: branch from main.
write_issue "plain hygiene goal" "## Goal
nothing track-shaped here" "status:ready"
expect_base "no signal" "main (source: default)"
grep -Fq "no track signal" "$SANDBOX/out" \
  || fail "no signal: the main fallback must announce itself"

# 2. Explicit flag and env keep winning, unchanged.
expect_base "explicit --base" "track/uxui (source: flag)" --base track/uxui
(cd "$FIXTURE" && PATH="$BIN:$PATH" BASE_BRANCH=track/uxui bash "$CLAIM" --dry-run "$ISSUE_NUMBER") \
  >"$SANDBOX/out" 2>&1 || fail "env base: claim exited non-zero"
grep -Fq "base:     track/uxui (source: env)" "$SANDBOX/out" \
  || fail "env base: BASE_BRANCH must still be honoured"

# 3. A track:<name> label is the machine-readable declaration.
write_issue "labelled goal" "body" "status:ready,track:engine"
expect_base "track label" "track/engine (source: label)"
expect_base "flag beats label" "track/uxui (source: flag)" --base track/uxui

# 4. A label naming a track that does not exist is ignored, never invented.
write_issue "bogus label goal" "body" "status:ready,track:nope"
expect_base "unknown track label" "main (source: default)"

# 5. An explicit Base: line in the body, including as a list item.
write_issue "body marked goal" "## Goal
work

Base: track/engine" "status:ready"
expect_base "body Base line" "track/engine (source: issue-body)"
write_issue "body marked goal" "- Base: \`track/uxui\`" "status:ready"
run_claim || fail "body Base list item: claim exited non-zero"
grep -Fq "base:     track/uxui (source: issue-body)" "$SANDBOX/out" \
  || fail "body Base list item: expected issue-body source"

# 6. Prose that merely mentions a branch is not a declaration.
write_issue "prose goal" "워커가 origin/main 기반으로 생성돼 수동 재지정이 필요했다(패킷 기준은 track/engine)." "status:ready"
expect_base "prose mention" "main (source: default)"

# 7. The repo's own [engine]/[uxui] title tag counts; unknown tags do not.
write_issue "[uxui] tagged goal" "body" "status:ready"
expect_base "title tag" "track/uxui (source: title-tag)"
write_issue "[parity] tagged goal" "body" "status:ready"
expect_base "unknown title tag" "main (source: default)"
write_issue "[engine][uxui] two tracks" "body" "status:ready"
expect_base "ambiguous title tag" "main (source: default)"

# 8. Claiming from a track checkout is itself a declaration; claiming from main
#    keeps branching from main.
write_issue "plain goal from a track checkout" "body" "status:ready"
git -C "$FIXTURE" checkout -q -B track/engine origin/track/engine
expect_base "track checkout" "track/engine (source: worktree)"
git -C "$FIXTURE" checkout -q main
expect_base "main checkout" "main (source: default)"
git -C "$FIXTURE" checkout -q work

# 9. docs/TRACKS.md is a printed hint on the main fallback, never a decision.
write_issue "web fix" "clients/web/src/features/timeline/MessageRow.tsx renders an empty paragraph" "status:ready"
expect_base "TRACKS.md ownership stays advisory" "main (source: default)"
grep -Fq "docs/TRACKS.md ownership mentions clients/web/" "$SANDBOX/out" \
  || fail "TRACKS.md hint: ownership match must be surfaced"
grep -Fq "pass --base track/uxui" "$SANDBOX/out" \
  || fail "TRACKS.md hint: must name the branch to pass"

# 10. A base that does not exist on origin fails before any mutation.
write_issue "typo base" "body" "status:ready"
expect_red "typo base" "base branch does not exist on origin: track/enginee" --base track/enginee

echo "[goal-claim-base-test] PASS: base resolution proofs are green"
