#!/usr/bin/env bash
# Isolated proofs for scripts/planning_session.py. Temporary git repos and
# worktrees only; no network and no writes inside the source checkout.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
HELPER_SRC="$REPO_ROOT/scripts/planning_session.py"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-planning-session.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

fail() {
  echo "[planning-session-test] FAIL: $*" >&2
  exit 1
}
pass() { echo "[planning-session-test] ok: $*"; }

init_repo() {
  local dir="$1"
  mkdir -p "$dir/scripts"
  git init -q "$dir"
  git -C "$dir" config user.name "Oort Planning Fixture"
  git -C "$dir" config user.email "planning-fixture@oort.invalid"
  cp "$HELPER_SRC" "$dir/scripts/planning_session.py"
  chmod +x "$dir/scripts/planning_session.py"
  printf 'fixture\n' >"$dir/README"
  git -C "$dir" add README scripts/planning_session.py
  git -C "$dir" commit -qm init
  git -C "$dir" branch -M main
}

helper() {
  local repo="$1"
  shift
  python3 "$repo/scripts/planning_session.py" "$@"
}

A="$SANDBOX/clone-a"
B="$SANDBOX/unrelated"
init_repo "$A"
init_repo "$B"

# --- sibling worktrees share the board ---
git -C "$A" worktree add -q "$SANDBOX/clone-a-wt" -b other
BOARD_A="$(helper "$A" path)"
BOARD_WT="$(
  CDPATH='' cd -- "$SANDBOX/clone-a-wt"
  python3 "$SANDBOX/clone-a-wt/scripts/planning_session.py" path
)"
[ "$BOARD_A" = "$BOARD_WT" ] || fail "sibling worktrees must share board: $BOARD_A vs $BOARD_WT"
case "$BOARD_A" in
  */oort-coordination) ;;
  *) fail "board path must end with oort-coordination: $BOARD_A" ;;
esac
pass "sibling worktrees share $BOARD_A"

# --- claim / separate scopes / checkpoint notes / release retains notes ---
helper "$A" claim integration --session astra-1 --owner 'Astra/Codex' >/dev/null
helper "$A" claim worker-2501 --session grok-1 --owner 'Grok4.6' >/dev/null

printf 'plain markdown checkpoint for #2501\n' >"$SANDBOX/note.md"
helper "$A" checkpoint integration --session astra-1 --note-file "$SANDBOX/note.md" >/dev/null

jq -n '{issue:"#2501", pr:"#9", run:"docs77", result:"PASS", next:"review", text:"json note"}' \
  >"$SANDBOX/note.json"
helper "$A" checkpoint worker-2501 --session grok-1 --note-file "$SANDBOX/note.json" >/dev/null

STATUS="$(helper "$A" status 2>"$SANDBOX/status.err")"
printf '%s\n' "$STATUS" | grep -q $'integration\tclaimed\t' || fail "integration not claimed\n$STATUS"
printf '%s\n' "$STATUS" | grep -q $'worker-2501\tclaimed\t' || fail "worker-2501 not claimed\n$STATUS"
printf '%s\n' "$STATUS" | grep -q 'text=plain markdown checkpoint for #2501' \
  || fail "markdown note.text missing from status\n$STATUS"
printf '%s\n' "$STATUS" | grep -q 'text=json note' || fail "json note.text missing\n$STATUS"
printf '%s\n' "$STATUS" | grep -q 'result=PASS' || fail "result missing\n$STATUS"
printf '%s\n' "$STATUS" | grep -q 'run=docs77' || fail "run missing\n$STATUS"
printf '%s\n' "$STATUS" | grep -q 'pr=#9' || fail "pr missing\n$STATUS"
printf '%s\n' "$STATUS" | grep -q 'note.head=' || fail "checkpoint provenance note.head missing\n$STATUS"
pass "status displays stored note fields including text"

helper "$A" release integration --session astra-1 >/dev/null
STATUS="$(helper "$A" status 2>/dev/null)"
printf '%s\n' "$STATUS" | grep -q $'integration\treleased\t' || fail "integration not released\n$STATUS"
printf '%s\n' "$STATUS" | grep -q 'text=plain markdown checkpoint for #2501' \
  || fail "note dropped after release\n$STATUS"
pass "release retains notes"

# --- wrong session denied ---
set +e
helper "$A" checkpoint worker-2501 --session wrong --note-file "$SANDBOX/note.md" \
  >"$SANDBOX/out" 2>"$SANDBOX/err"
wrong_cp=$?
helper "$A" release worker-2501 --session wrong >"$SANDBOX/out" 2>"$SANDBOX/err"
wrong_rel=$?
set -e
[ "$wrong_cp" -eq 4 ] || fail "wrong-session checkpoint exit $wrong_cp, expected 4"
[ "$wrong_rel" -eq 4 ] || fail "wrong-session release exit $wrong_rel, expected 4"
pass "wrong session checkpoint/release denied"

# --- simultaneous same-scope claim: only one wins ---
helper "$A" release worker-2501 --session grok-1 >/dev/null
python3 - "$A/scripts/planning_session.py" <<'PY'
import subprocess
import sys

helper = sys.argv[1]
procs = [
    subprocess.Popen(
        [sys.executable, helper, "claim", "same-scope", "--session", sess, "--owner", owner],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for sess, owner in (("alpha", "A"), ("beta", "B"))
]
codes = sorted(p.wait() for p in procs)
if codes != [0, 3]:
    details = []
    for p in procs:
        out, err = p.communicate()
        details.append(f"code={p.returncode} out={out!r} err={err!r}")
    raise SystemExit("expected one winner (0) and one conflict (3), got "
                     f"{codes}: {details}")
PY
pass "simultaneous same-scope claim: one winner"

# --- malformed records: status warns, mutation refused ---
mkdir -p "$BOARD_A/scopes"
printf '{}\n' >"$BOARD_A/scopes/empty-object.json"
python3 - "$BOARD_A/scopes/claimd.json" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({
    "version": 1,
    "scope": "claimd",
    "state": "claimd",
    "session": "s",
    "owner": "o",
    "source": {"worktree": "/tmp", "head": "abc"},
    "note": {},
}) + "\n", encoding="utf-8")
PY
python3 - "$BOARD_A/scopes/bad-types.json" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({
    "version": 1,
    "state": 1,
    "session": ["not-a-string"],
    "owner": {"x": 1},
    "source": "nope",
    "note": ["nope"],
}) + "\n", encoding="utf-8")
PY

set +e
helper "$A" status >"$SANDBOX/malformed.out" 2>"$SANDBOX/malformed.err"
malformed_status=$?
helper "$A" claim empty-object --session s --owner o >"$SANDBOX/out" 2>"$SANDBOX/err"
empty_claim=$?
helper "$A" claim claimd --session s --owner o >"$SANDBOX/out" 2>"$SANDBOX/err"
claimd_claim=$?
helper "$A" checkpoint empty-object --session s --note-file "$SANDBOX/note.md" \
  >"$SANDBOX/out" 2>"$SANDBOX/err"
empty_cp=$?
set -e
[ "$malformed_status" -eq 0 ] || fail "status must not crash on malformed records"
grep -q 'malformed' "$SANDBOX/malformed.err" || grep -q 'malformed' "$SANDBOX/malformed.out" \
  || fail "status must warn about malformed records"
[ "$empty_claim" -ne 0 ] || fail "claim must refuse {} record"
[ "$claimd_claim" -ne 0 ] || fail "claim must refuse state=claimd"
[ "$empty_cp" -ne 0 ] || fail "checkpoint must refuse malformed record"
pass "malformed records warn on status and refuse mutation"

# --- invalid scope / missing identity ---
set +e
helper "$A" claim '../escape' --session s --owner o >"$SANDBOX/out" 2>"$SANDBOX/err"
bad_scope=$?
helper "$A" claim 'has/slash' --session s --owner o >"$SANDBOX/out" 2>"$SANDBOX/err"
slash_scope=$?
helper "$A" claim ok --session '' --owner o >"$SANDBOX/out" 2>"$SANDBOX/err"
empty_session=$?
set -e
[ "$bad_scope" -eq 5 ] || fail "path-traversal scope exit $bad_scope, expected 5"
[ "$slash_scope" -eq 5 ] || fail "slash scope exit $slash_scope, expected 5"
[ "$empty_session" -ne 0 ] || fail "empty --session must be rejected"
pass "invalid scope and empty session rejected"

# --- unrelated cwd must not claim the third-party repo ---
BOARD_B="$(helper "$B" path)"
[ "$BOARD_A" != "$BOARD_B" ] || fail "separate clones must not share a board"
CDPATH='' cd -- "$B"
FROM_B="$(python3 "$A/scripts/planning_session.py" path)"
[ "$FROM_B" = "$BOARD_A" ] || fail "absolute helper from other repo must bind to its checkout ($FROM_B vs $BOARD_A)"
python3 "$A/scripts/planning_session.py" claim from-b --session abs-1 --owner Abs >/dev/null
[ -d "$BOARD_B" ] && [ -n "$(find "$BOARD_B/scopes" -name 'from-b.json' 2>/dev/null)" ] \
  && fail "third-party board was mutated"
[ -f "$BOARD_A/scopes/from-b.json" ] || fail "claim via absolute path did not land on helper checkout board"
# source worktree must stay the helper clone, not the unrelated cwd
python3 - "$BOARD_A/scopes/from-b.json" "$A" "$B" <<'PY'
import json, sys
from pathlib import Path
rec = json.loads(Path(sys.argv[1]).read_text())
worktree = rec["source"]["worktree"]
clone_a = str(Path(sys.argv[2]).resolve())
clone_b = str(Path(sys.argv[3]).resolve())
if Path(worktree).resolve() != Path(clone_a).resolve():
    raise SystemExit(f"source.worktree {worktree} is not helper checkout {clone_a}")
if Path(clone_b).resolve() in Path(worktree).resolve().parents or worktree.startswith(clone_b):
    raise SystemExit(f"unrelated repo leaked into source: {worktree}")
PY
pass "unrelated cwd does not claim or mutate the third-party repo"

# --- inherited Git location env must not redirect helper A onto clone B ---
CDPATH='' cd -- "$A"
GIT_DIR="$B/.git" GIT_WORK_TREE="$B" GIT_COMMON_DIR="$B/.git" \
  GIT_INDEX_FILE="$B/.git/index" GIT_OBJECT_DIRECTORY="$B/.git/objects" \
  python3 "$A/scripts/planning_session.py" path >"$SANDBOX/gitenv.path" 2>"$SANDBOX/gitenv.err" \
  || fail "path under GIT_DIR=B failed"
PATH_UNDER_ENV="$(cat "$SANDBOX/gitenv.path")"
[ "$PATH_UNDER_ENV" = "$BOARD_A" ] || fail "GIT_DIR redirected board to $PATH_UNDER_ENV (want $BOARD_A)"
GIT_DIR="$B/.git" GIT_WORK_TREE="$B" GIT_COMMON_DIR="$B/.git" \
  GIT_INDEX_FILE="$B/.git/index" \
  python3 "$A/scripts/planning_session.py" claim env-bind --session env-1 --owner Env \
  >/dev/null 2>"$SANDBOX/gitenv.claim.err" \
  || fail "claim under GIT_DIR=B failed: $(cat "$SANDBOX/gitenv.claim.err")"
[ -f "$BOARD_A/scopes/env-bind.json" ] || fail "GIT_DIR claim did not write helper A's board"
if [ -e "$B/.git/oort-coordination/scopes/env-bind.json" ]; then
  fail "GIT_DIR claim mutated clone B"
fi
python3 - "$BOARD_A/scopes/env-bind.json" "$A" "$B" <<'PY'
import json, sys
from pathlib import Path
rec = json.loads(Path(sys.argv[1]).read_text())
wt = Path(rec["source"]["worktree"]).resolve()
clone_a = Path(sys.argv[2]).resolve()
clone_b = Path(sys.argv[3]).resolve()
if wt != clone_a:
    raise SystemExit(f"GIT_DIR redirected source to {wt}")
if clone_b == wt or clone_b in wt.parents:
    raise SystemExit(f"clone B leaked into source {wt}")
PY
pass "GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR do not steal helper A's board"

# --- cwd that is a sibling worktree may be recorded as source ---
CDPATH='' cd -- "$SANDBOX/clone-a-wt"
python3 "$SANDBOX/clone-a-wt/scripts/planning_session.py" \
  claim wt-source --session wt-1 --owner WT >/dev/null
python3 - "$BOARD_A/scopes/wt-source.json" "$SANDBOX/clone-a-wt" <<'PY'
import json, sys
from pathlib import Path
rec = json.loads(Path(sys.argv[1]).read_text())
got = Path(rec["source"]["worktree"]).resolve()
want = Path(sys.argv[2]).resolve()
if got != want:
    raise SystemExit(f"expected source {want}, got {got}")
PY
pass "same-clone worktree cwd is recorded as source"

# --- checkpoint is a complete snapshot; partial file does not keep old result ---
jq -n '{result:"PASS", text:"full snapshot"}' >"$SANDBOX/full-note.json"
helper "$A" claim snap --session snap-1 --owner Snap >/dev/null
helper "$A" checkpoint snap --session snap-1 --note-file "$SANDBOX/full-note.json" >/dev/null
jq -n '{next:"only-next"}' >"$SANDBOX/partial-note.json"
helper "$A" checkpoint snap --session snap-1 --note-file "$SANDBOX/partial-note.json" >/dev/null
SNAP_STATUS="$(helper "$A" status 2>/dev/null)"
printf '%s\n' "$SNAP_STATUS" | grep -q 'next=only-next' || fail "replacement snapshot missing next\n$SNAP_STATUS"
if printf '%s\n' "$SNAP_STATUS" | grep 'snap' | grep -q 'result=PASS'; then
  fail "partial checkpoint must replace, not merge, old result\n$SNAP_STATUS"
fi
pass "checkpoint replaces the previous note snapshot"

# --- provenance stays on the snapshot across release and new-session reclaim ---
CDPATH='' cd -- "$A"
HEAD_A="$(git -C "$A" rev-parse HEAD)"
helper "$A" claim provenance --session s1 --owner Main >/dev/null
CLAIMED_AT_A="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["claimed_at"])' "$BOARD_A/scopes/provenance.json")"
jq -n '{result:"PASS", text:"gate at A"}' >"$SANDBOX/pass-a.json"
helper "$A" checkpoint provenance --session s1 --note-file "$SANDBOX/pass-a.json" >/dev/null
python3 - "$BOARD_A/scopes/provenance.json" "$HEAD_A" "$A" <<'PY'
import json, sys
from pathlib import Path
rec = json.loads(Path(sys.argv[1]).read_text())
head_a = sys.argv[2]
note_src = rec["note"]["source"]
if rec["note"].get("result") != "PASS":
    raise SystemExit("checkpoint lost result")
if note_src.get("head") != head_a:
    raise SystemExit(f"note.source.head {note_src.get('head')} != {head_a}")
if Path(note_src["worktree"]).resolve() != Path(sys.argv[3]).resolve():
    raise SystemExit(f"note.source.worktree {note_src.get('worktree')}")
PY
printf 'commit-b\n' >>"$A/README"
git -C "$A" add README
git -C "$A" commit -qm commit-b
HEAD_B="$(git -C "$A" rev-parse HEAD)"
[ "$HEAD_A" != "$HEAD_B" ] || fail "expected a new commit after checkpoint"
helper "$A" release provenance --session s1 >/dev/null
python3 - "$BOARD_A/scopes/provenance.json" "$HEAD_A" "$HEAD_B" "$A" <<'PY'
import json, sys
from pathlib import Path
rec = json.loads(Path(sys.argv[1]).read_text())
head_a, head_b = sys.argv[2], sys.argv[3]
if rec["state"] != "released":
    raise SystemExit("expected released")
if rec["note"].get("result") != "PASS":
    raise SystemExit("release dropped result")
if rec["note"]["source"].get("head") != head_a:
    raise SystemExit(
        f"release reattributed note to {rec['note']['source'].get('head')}, want {head_a}"
    )
if rec["source"].get("head") != head_b:
    raise SystemExit(f"live source.head {rec['source'].get('head')} != {head_b}")
if Path(rec["note"]["source"]["worktree"]).resolve() != Path(sys.argv[4]).resolve():
    raise SystemExit("release changed note.source.worktree")
PY
sleep 1
CDPATH='' cd -- "$SANDBOX/clone-a-wt"
python3 "$SANDBOX/clone-a-wt/scripts/planning_session.py" \
  claim provenance --session s2 --owner WT >/dev/null
python3 - "$BOARD_A/scopes/provenance.json" "$HEAD_A" "$SANDBOX/clone-a-wt" "$CLAIMED_AT_A" <<'PY'
import json, sys
from pathlib import Path
rec = json.loads(Path(sys.argv[1]).read_text())
head_a = sys.argv[2]
wt = Path(sys.argv[3]).resolve()
old_claimed = sys.argv[4]
if rec["state"] != "claimed" or rec.get("session") != "s2":
    raise SystemExit("new-session claim did not take the scope")
if rec["note"].get("result") != "PASS":
    raise SystemExit("reclaim dropped PASS note")
if rec["note"]["source"].get("head") != head_a:
    raise SystemExit(
        f"reclaim reattributed evidence to {rec['note']['source'].get('head')}"
    )
if Path(rec["source"]["worktree"]).resolve() != wt:
    raise SystemExit(f"live source.worktree {rec['source'].get('worktree')} != {wt}")
if rec.get("claimed_at") == old_claimed:
    raise SystemExit("fresh claim retained previous claimed_at")
PY
CLAIMED_AT_S2="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["claimed_at"])' "$BOARD_A/scopes/provenance.json")"
python3 "$SANDBOX/clone-a-wt/scripts/planning_session.py" \
  claim provenance --session s2 --owner WT >/dev/null
CLAIMED_AT_S2_AGAIN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["claimed_at"])' "$BOARD_A/scopes/provenance.json")"
[ "$CLAIMED_AT_S2" = "$CLAIMED_AT_S2_AGAIN" ] \
  || fail "idempotent same-session claim must keep claimed_at"
pass "checkpoint provenance stays on A across release and sibling reclaim"

# --- scope must equal filename stem; mismatch is malformed and not mutated ---
python3 - "$BOARD_A/scopes/worker.json" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({
    "version": 1,
    "scope": "integration",
    "state": "claimed",
    "session": "fake-int",
    "owner": "Fake",
    "source": {"worktree": "/tmp", "head": "abc"},
    "note": {},
}) + "\n", encoding="utf-8")
PY
helper "$A" status >"$SANDBOX/scope-mismatch.out" 2>"$SANDBOX/scope-mismatch.err"
grep -q 'malformed' "$SANDBOX/scope-mismatch.err" \
  || grep -q 'malformed' "$SANDBOX/scope-mismatch.out" \
  || fail "scope/filename mismatch must warn"
if grep $'integration\tclaimed\t' "$SANDBOX/scope-mismatch.out" | grep -q 'fake-int'; then
  fail "worker.json scope=integration displayed as an integration owner"
fi
if grep $'worker\tclaimed\t' "$SANDBOX/scope-mismatch.out" | grep -q 'session=fake-int'; then
  fail "mismatched worker.json accepted as scope worker"
fi
BEFORE="$(cat "$BOARD_A/scopes/worker.json")"
set +e
helper "$A" checkpoint worker --session fake-int --note-file "$SANDBOX/note.md" \
  >"$SANDBOX/out" 2>"$SANDBOX/err"
mismatch_cp=$?
helper "$A" claim worker --session other --owner X >"$SANDBOX/out" 2>"$SANDBOX/err"
mismatch_claim=$?
set -e
[ "$mismatch_cp" -ne 0 ] || fail "checkpoint worker must refuse scope/filename mismatch"
[ "$mismatch_claim" -ne 0 ] || fail "claim worker must refuse scope/filename mismatch"
AFTER="$(cat "$BOARD_A/scopes/worker.json")"
[ "$BEFORE" = "$AFTER" ] || fail "malformed worker.json was rewritten"
pass "scope/filename mismatch is malformed and left unchanged"

# --- scopes path that is a regular file is malformed, not an empty board ---
C="$SANDBOX/clone-c"
init_repo "$C"
helper "$C" claim file-board --session c1 --owner C >/dev/null
BOARD_C="$(helper "$C" path)"
rm -rf "$BOARD_C/scopes"
printf 'not-a-directory\n' >"$BOARD_C/scopes"
helper "$C" status >"$SANDBOX/scopes-file.out" 2>"$SANDBOX/scopes-file.err"
if grep -q 'no local registrations' "$SANDBOX/scopes-file.out"; then
  fail "scopes file must not be reported as an empty board"
fi
grep -q 'malformed' "$SANDBOX/scopes-file.err" \
  || grep -q 'malformed' "$SANDBOX/scopes-file.out" \
  || fail "scopes file must warn malformed"
set +e
helper "$C" claim other --session c2 --owner C >"$SANDBOX/out" 2>"$SANDBOX/scopes-file-claim.err"
scopes_claim=$?
set -e
[ "$scopes_claim" -ne 0 ] || fail "claim must fail when scopes is a file"
if grep -qi 'traceback' "$SANDBOX/scopes-file-claim.err"; then
  fail "mutation against scopes file printed a traceback"
fi
grep -q 'malformed' "$SANDBOX/scopes-file-claim.err" \
  || fail "mutation error should mention malformed scopes path"
pass "scopes regular file is malformed, not empty"

echo "[planning-session-test] all cases passed"
