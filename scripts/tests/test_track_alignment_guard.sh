#!/usr/bin/env bash
# Isolated red/green proofs for scripts/check_track_alignment.sh. No network.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
CHECKER="$REPO_ROOT/scripts/check_track_alignment.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-track-alignment.XXXXXX")"
FIXTURE="$SANDBOX/repo"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

fail() {
  echo "[track-alignment-test] FAIL: $*" >&2
  exit 1
}

git init -q "$FIXTURE"
git -C "$FIXTURE" config user.name "Oort Track Fixture"
git -C "$FIXTURE" config user.email "track-fixture@oort.invalid"
git -C "$FIXTURE" remote add origin "$SANDBOX/origin.git"
git init -q --bare "$SANDBOX/origin.git"
printf 'base\n' >"$FIXTURE/state.txt"
git -C "$FIXTURE" add state.txt
git -C "$FIXTURE" commit -qm base
git -C "$FIXTURE" branch -M main
BASE_SHA="$(git -C "$FIXTURE" rev-parse HEAD)"

git -C "$FIXTURE" branch track/engine "$BASE_SHA"
git -C "$FIXTURE" branch track/uxui "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/engine "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/uxui "$BASE_SHA"
git -C "$FIXTURE" branch --set-upstream-to=origin/main main >/dev/null
git -C "$FIXTURE" branch --set-upstream-to=origin/track/engine track/engine >/dev/null
git -C "$FIXTURE" branch --set-upstream-to=origin/track/uxui track/uxui >/dev/null

run_ok() {
  local label="$1"
  shift
  (cd "$FIXTURE" && "$CHECKER" "$@") >"$SANDBOX/out" 2>&1 \
    || fail "$label should pass: $(cat "$SANDBOX/out")"
}

run_red() {
  local label="$1"
  local needle="$2"
  shift 2
  if (cd "$FIXTURE" && "$CHECKER" "$@") >"$SANDBOX/out" 2>&1; then
    fail "$label should fail"
  fi
  grep -Fq "$needle" "$SANDBOX/out" \
    || fail "$label omitted '$needle': $(cat "$SANDBOX/out")"
}

run_ok "aligned remote and local" --all

# A track may be ahead of main: this is pending integration, not drift.
git -C "$FIXTURE" checkout -q track/uxui
printf 'uxui ahead\n' >"$FIXTURE/uxui.txt"
git -C "$FIXTURE" add uxui.txt
git -C "$FIXTURE" commit -qm 'uxui ahead'
UXUI_AHEAD="$(git -C "$FIXTURE" rev-parse HEAD)"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/uxui "$UXUI_AHEAD"
run_ok "remote track ahead" --remote
run_ok "local track ahead" --local

# Main moving without a track creates a behind edge; an independent track commit
# creates divergence. Both must be named, even when changed files are disjoint.
git -C "$FIXTURE" checkout -q main
printf 'main ahead\n' >"$FIXTURE/main.txt"
git -C "$FIXTURE" add main.txt
git -C "$FIXTURE" commit -qm 'main ahead'
MAIN_AHEAD="$(git -C "$FIXTURE" rev-parse HEAD)"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$MAIN_AHEAD"
run_red "engine behind main" "origin/track/engine is behind origin/main" --remote
run_red "uxui diverged from main" "origin/track/uxui diverged from origin/main" --remote
run_ok "local wiring stays usable for the repair PR" --local

# Restore remote topology for local wiring proofs.
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/engine "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/uxui "$BASE_SHA"
git -C "$FIXTURE" branch -f track/uxui "$BASE_SHA"

git -C "$FIXTURE" branch -f track/uxui "$UXUI_AHEAD"
run_ok "local ahead of its remote" --local
git -C "$FIXTURE" branch -f track/uxui "$BASE_SHA"

git -C "$FIXTURE" update-ref refs/remotes/origin/track/engine "$MAIN_AHEAD"
run_red "local behind" "track/engine is behind origin/track/engine" --local
LOCAL_DIVERGED="$(printf 'local diverged\n' | git -C "$FIXTURE" commit-tree "$BASE_SHA^{tree}" -p "$BASE_SHA")"
git -C "$FIXTURE" branch -f track/engine "$LOCAL_DIVERGED"
run_red "local divergence" "track/engine diverged from origin/track/engine" --local
git -C "$FIXTURE" branch -f track/engine "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/engine "$BASE_SHA"

git -C "$FIXTURE" branch --set-upstream-to=origin/main track/engine >/dev/null
run_red "wrong upstream" "track/engine upstream is origin/main; expected origin/track/engine" --local
git -C "$FIXTURE" branch --set-upstream-to=origin/track/engine track/engine >/dev/null
git -C "$FIXTURE" branch --unset-upstream track/uxui
run_red "missing upstream" "track/uxui has no upstream" --local
git -C "$FIXTURE" branch --set-upstream-to=origin/track/uxui track/uxui >/dev/null

git -C "$FIXTURE" update-ref -d refs/remotes/origin/track/uxui
run_red "missing remote ref" "required ref is unavailable: origin/track/uxui" --remote
git -C "$FIXTURE" update-ref refs/remotes/origin/track/uxui "$BASE_SHA"

git -C "$FIXTURE" branch -D track/uxui >/dev/null
run_red "missing local ref" "required local ref is unavailable: refs/heads/track/uxui" --local
run_ok "public clone can omit local track branches" --remote --local-existing
git -C "$FIXTURE" branch track/uxui "$BASE_SHA"
git -C "$FIXTURE" branch --set-upstream-to=origin/track/uxui track/uxui >/dev/null

# Candidate checks make canonical pushes/PR merge commits fast-forward-only and
# require track repairs to contain the current main.
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$MAIN_AHEAD"
run_red "stale track candidate" "does not contain origin/main" \
  --candidate track/engine "$BASE_SHA"
run_ok "main-containing track candidate" --candidate refs/heads/track/engine "$MAIN_AHEAD"
run_red "non-fast-forward main candidate" "not a fast-forward of origin/main" \
  --candidate main "$BASE_SHA"
run_red "stale merge-tree base" "does not contain origin/main" \
  --contains-main "$BASE_SHA"
run_ok "fresh merge-tree base" --contains-main "$MAIN_AHEAD"

# Final-consumer proof: verify_merge_tree must fetch rather than trusting stale
# local remote-tracking refs. The bare origin has a newer main while the track
# base remains old, so a real fetch must make the gate name the stale base.
git -C "$FIXTURE" push -q origin \
  "$MAIN_AHEAD:refs/heads/main" \
  "$BASE_SHA:refs/heads/track/engine" \
  "$MAIN_AHEAD:refs/heads/track/uxui"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/engine "$BASE_SHA"
git -C "$FIXTURE" update-ref refs/remotes/origin/track/uxui "$BASE_SHA"
mkdir -p "$FIXTURE/scripts"
cp "$CHECKER" "$REPO_ROOT/scripts/verify_merge_tree.sh" "$FIXTURE/scripts/"
if (cd "$FIXTURE" && scripts/verify_merge_tree.sh \
  --base origin/track/engine --head main --typecheck-only) >"$SANDBOX/merge-tree.out" 2>&1; then
  fail "merge-tree final consumer trusted stale origin/main"
fi
grep -Fq 'does not contain origin/main' "$SANDBOX/merge-tree.out" \
  || fail "merge-tree stale-base failure omitted ancestry reason: $(cat "$SANDBOX/merge-tree.out")"
[ "$(git -C "$FIXTURE" rev-parse origin/main)" = "$MAIN_AHEAD" ] \
  || fail "merge-tree final consumer did not refresh origin/main"

echo "[track-alignment-test] PASS ahead/behind/diverge/upstream/missing-ref/candidate/stale-merge-tree fixtures"
