#!/usr/bin/env bash
# Isolated proofs for scripts/planning_context.sh. Temporary git repos only;
# no network. The helper is copied so SessionStart-style absolute invocation
# still binds to that checkout.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-planning-context.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

fail() {
  echo "[planning-context-test] FAIL: $*" >&2
  if [ -f "$SANDBOX/out" ]; then
    echo "----- output -----" >&2
    cat "$SANDBOX/out" >&2
  fi
  exit 1
}
pass() { echo "[planning-context-test] ok: $*"; }

FIXTURE="$(CDPATH='' cd -- "$SANDBOX" && mkdir -p clone && CDPATH='' cd -- clone && pwd -P)"
mkdir -p "$FIXTURE/scripts" "$FIXTURE/docs/planning" "$FIXTURE/docs/adr" "$FIXTURE/.claude"
git init -q "$FIXTURE"
git -C "$FIXTURE" config user.name "Oort Planning Fixture"
git -C "$FIXTURE" config user.email "planning-fixture@oort.invalid"

cp "$REPO_ROOT/scripts/planning_context.sh" "$FIXTURE/scripts/planning_context.sh"
cp "$REPO_ROOT/scripts/planning_session.py" "$FIXTURE/scripts/planning_session.py"
chmod +x "$FIXTURE/scripts/planning_context.sh" "$FIXTURE/scripts/planning_session.py"

# Real snapshot from the source checkout (short, multi-paragraph).
cp "$REPO_ROOT/docs/planning/CURRENT_STATE.md" "$FIXTURE/docs/planning/CURRENT_STATE.md"

cat >"$FIXTURE/docs/adr/0001-proposed.md" <<'EOF'
# ADR-0001 proposed fixture
> Status: Proposed
Body.
EOF
cat >"$FIXTURE/docs/adr/0002-accepted.md" <<'EOF'
# ADR-0002 accepted fixture
> Status: Accepted
EOF
cat >"$FIXTURE/docs/planning/DEVIATION_LOG.md" <<'EOF'
| id | status | note |
|---|---|---|
| D-1 | pending | fixture pending row |
| D-2 | closed | ignore |
EOF
cat >"$FIXTURE/docs/planning/JOURNAL.md" <<'EOF'
## Latest fixture entry

First journal body.

## Older entry

Must not appear without reading the rest of the file as latest.
EOF

cat >"$FIXTURE/scripts/goal_status.sh" <<'EOF'
#!/usr/bin/env bash
printf 'FAKE_GOAL_STATUS_SENTINEL\n'
EOF
chmod +x "$FIXTURE/scripts/goal_status.sh"

printf 'fixture\n' >"$FIXTURE/README"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -qm init
git -C "$FIXTURE" branch -M main

CTX="$FIXTURE/scripts/planning_context.sh"

# --- full snapshot, status once, no Next step reparse ---
CDPATH='' cd -- "$SANDBOX"
"$CTX" >"$SANDBOX/out" 2>"$SANDBOX/err" || fail "default planning_context exited $?"

grep -q '^# oort planning context (offline)$' "$SANDBOX/out" \
  || fail "missing offline header"
python3 - "$SANDBOX/out" "$FIXTURE" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1]).read_text()
want = Path(sys.argv[2]).resolve()
repo_line = next((ln for ln in out.splitlines() if ln.startswith("repo: ")), "")
if not repo_line:
    raise SystemExit("missing repo: line")
got = Path(repo_line[len("repo: "):]).resolve()
if got != want:
    raise SystemExit(f"script-directory resolution bound to {got}, expected {want}")
PY

python3 - "$SANDBOX/out" "$FIXTURE/docs/planning/CURRENT_STATE.md" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1]).read_text()
snapshot = Path(sys.argv[2]).read_text()
if snapshot not in out:
    raise SystemExit("full CURRENT_STATE.md is not present as a contiguous block")
# Title-only regression: first paragraph is the heading, then a blank line.
first_para = snapshot.split("\n\n", 1)[0]
if out.count(first_para) < 1:
    raise SystemExit("snapshot heading missing")
if snapshot.strip() == first_para.strip():
    raise SystemExit("fixture snapshot unexpectedly single-paragraph")
PY
pass "full real CURRENT_STATE snapshot restored"

coord_count="$(grep -c '^## Shared coordination$' "$SANDBOX/out" || true)"
[ "$coord_count" -eq 1 ] || fail "shared coordination must appear once, got $coord_count"
if grep -q '^## Next step$' "$SANDBOX/out"; then
  fail "Next step section must not be re-derived"
fi
if grep -q 'FAKE_GOAL_STATUS_SENTINEL' "$SANDBOX/out"; then
  fail "default path must stay offline (goal_status was invoked)"
fi
if grep -q 'Proposed ADRs' "$SANDBOX/out"; then
  fail "default path must not scan ADRs"
fi
if grep -q 'Pending deviations' "$SANDBOX/out"; then
  fail "default path must not scan deviations"
fi
grep -q 'Offline snapshot only' "$SANDBOX/out" || fail "missing offline notice"
pass "offline default: board once, no Next step, no github/details"

# --- --details opt-in ---
"$CTX" --details >"$SANDBOX/out" 2>"$SANDBOX/err" || fail "--details exited $?"
grep -q '0001-proposed.md' "$SANDBOX/out" || fail "--details missed Proposed ADR"
if grep -q '0002-accepted.md' "$SANDBOX/out"; then
  fail "--details listed an Accepted ADR"
fi
grep -q 'fixture pending row' "$SANDBOX/out" || fail "--details missed pending deviation"
grep -q 'First journal body' "$SANDBOX/out" || fail "--details missed latest journal"
if grep -q 'Must not appear' "$SANDBOX/out"; then
  fail "--details printed older journal entry"
fi
if grep -q 'FAKE_GOAL_STATUS_SENTINEL' "$SANDBOX/out"; then
  fail "--details must not imply --github"
fi
pass "--details opt-in"

# --- --github opt-in ---
"$CTX" --github >"$SANDBOX/out" 2>"$SANDBOX/err" || fail "--github exited $?"
grep -q 'FAKE_GOAL_STATUS_SENTINEL' "$SANDBOX/out" || fail "--github did not append goal_status"
if grep -q 'Proposed ADRs' "$SANDBOX/out"; then
  fail "--github must not imply --details"
fi
pass "--github opt-in"

# --- unrelated cwd still restores this checkout ---
UNRELATED="$SANDBOX/elsewhere"
mkdir -p "$UNRELATED"
git init -q "$UNRELATED"
CDPATH='' cd -- "$UNRELATED"
"$CTX" >"$SANDBOX/from-elsewhere.out" 2>"$SANDBOX/from-elsewhere.err" \
  || fail "absolute planning_context from unrelated cwd failed"
python3 - "$SANDBOX/from-elsewhere.out" "$FIXTURE" "$UNRELATED" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1]).read_text()
want = Path(sys.argv[2]).resolve()
other = Path(sys.argv[3]).resolve()
repo_line = next((ln for ln in out.splitlines() if ln.startswith("repo: ")), "")
got = Path(repo_line[len("repo: "):]).resolve()
if got != want:
    raise SystemExit(f"unrelated cwd leaked into repo: {got}")
if got == other:
    raise SystemExit("bound to the unrelated repo")
PY
python3 - "$SANDBOX/from-elsewhere.out" "$FIXTURE/docs/planning/CURRENT_STATE.md" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1]).read_text()
snapshot = Path(sys.argv[2]).read_text()
if snapshot not in out:
    raise SystemExit("unrelated cwd restore lost the snapshot")
PY
pass "absolute invocation from unrelated cwd binds to script checkout"

# --- actual tracked SessionStart hook from unrelated cwd ---
HOOK_CMD="$(python3 - "$REPO_ROOT/.claude/settings.json" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
print(data["hooks"]["SessionStart"][0]["hooks"][0]["command"])
PY
)"
[ -n "$HOOK_CMD" ] || fail "could not read SessionStart command from tracked JSON"
python3 -m json.tool "$REPO_ROOT/.claude/settings.json" >/dev/null \
  || fail "tracked .claude/settings.json is not valid JSON"

HOOK_CWD="$SANDBOX/hook-cwd"
mkdir -p "$HOOK_CWD"
set +e
CDPATH='' cd -- "$HOOK_CWD"
CLAUDE_PROJECT_DIR="$REPO_ROOT" bash -c "$HOOK_CMD" \
  >"$SANDBOX/hook.out" 2>"$SANDBOX/hook.err"
HOOK_STATUS=$?
set -e
if [ "$HOOK_STATUS" -ne 0 ]; then
  echo "actual SessionStart command failed from unrelated cwd (exit $HOOK_STATUS): $HOOK_CMD" >&2
  sed -n '1,40p' "$SANDBOX/hook.err" >&2 || true
  fail "actual configured hook exited $HOOK_STATUS"
fi
python3 - "$SANDBOX/hook.out" "$REPO_ROOT/docs/planning/CURRENT_STATE.md" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1]).read_text()
snapshot = Path(sys.argv[2]).read_text()
if snapshot not in out:
    raise SystemExit("hook did not restore the full CURRENT_STATE snapshot")
PY
pass "actual SessionStart hook restored full snapshot from unrelated cwd"

# --- actual SessionStart command must not retarget A onto B via GIT_DIR ---
CLONE_A="$(CDPATH='' cd -- "$SANDBOX" && mkdir -p clone-a && CDPATH='' cd -- clone-a && pwd -P)"
CLONE_B="$(CDPATH='' cd -- "$SANDBOX" && mkdir -p clone-b && CDPATH='' cd -- clone-b && pwd -P)"
mkdir -p "$CLONE_A/scripts" "$CLONE_A/docs/planning" \
  "$CLONE_B/scripts" "$CLONE_B/docs/planning"
git init -q "$CLONE_A"
git init -q "$CLONE_B"
git -C "$CLONE_A" config user.name "Oort Planning Fixture"
git -C "$CLONE_A" config user.email "planning-fixture@oort.invalid"
git -C "$CLONE_B" config user.name "Oort Planning Fixture"
git -C "$CLONE_B" config user.email "planning-fixture@oort.invalid"
cp "$REPO_ROOT/scripts/planning_context.sh" "$CLONE_A/scripts/planning_context.sh"
cp "$REPO_ROOT/scripts/planning_session.py" "$CLONE_A/scripts/planning_session.py"
chmod +x "$CLONE_A/scripts/planning_context.sh" "$CLONE_A/scripts/planning_session.py"
printf 'A_SNAPSHOT_UNIQUE\nfull A snapshot line two\n' >"$CLONE_A/docs/planning/CURRENT_STATE.md"
printf 'B_MARKER_MUST_BE_ABSENT\n' >"$CLONE_B/docs/planning/CURRENT_STATE.md"
printf 'a-only\n' >"$CLONE_A/README"
printf 'b-only\n' >"$CLONE_B/README"
git -C "$CLONE_A" add -A
git -C "$CLONE_A" commit -qm a
git -C "$CLONE_B" add -A
git -C "$CLONE_B" commit -qm b
git -C "$CLONE_A" branch -M main
git -C "$CLONE_B" branch -M main
HEAD_A="$(git -C "$CLONE_A" rev-parse HEAD)"
python3 "$CLONE_A/scripts/planning_session.py" \
  claim integration --session a-sess --owner CloneA >/dev/null
BOARD_A="$(python3 "$CLONE_A/scripts/planning_session.py" path)"

HOOK_CWD_GIT="$SANDBOX/hook-cwd-gitdir"
mkdir -p "$HOOK_CWD_GIT"
CDPATH='' cd -- "$HOOK_CWD_GIT"
set +e
CLAUDE_PROJECT_DIR="$CLONE_A" \
  GIT_DIR="$CLONE_B/.git" \
  GIT_WORK_TREE="$CLONE_B" \
  GIT_COMMON_DIR="$CLONE_B/.git" \
  bash -c "$HOOK_CMD" >"$SANDBOX/hook-gitdir.out" 2>"$SANDBOX/hook-gitdir.err"
HOOK_GITDIR_STATUS=$?
set -e
if [ "$HOOK_GITDIR_STATUS" -ne 0 ]; then
  echo "SessionStart under GIT_DIR=B exited $HOOK_GITDIR_STATUS" >&2
  sed -n '1,40p' "$SANDBOX/hook-gitdir.err" >&2 || true
  fail "configured hook under GIT_DIR=B exited $HOOK_GITDIR_STATUS"
fi
python3 - "$SANDBOX/hook-gitdir.out" "$CLONE_A" "$CLONE_B" "$HEAD_A" "$BOARD_A" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1]).read_text()
clone_a = Path(sys.argv[2]).resolve()
clone_b = Path(sys.argv[3]).resolve()
head_a = sys.argv[4]
board_a = str(Path(sys.argv[5]).resolve())
if "A_SNAPSHOT_UNIQUE" not in out:
    raise SystemExit("A snapshot missing under GIT_DIR=B")
if "B_MARKER_MUST_BE_ABSENT" in out:
    raise SystemExit("B marker leaked into restore")
if "full A snapshot line two" not in out:
    raise SystemExit("A snapshot truncated")
repo_line = next((ln for ln in out.splitlines() if ln.startswith("repo: ")), "")
got = Path(repo_line[len("repo: "):]).resolve()
if got != clone_a:
    raise SystemExit(f"repo bound to {got}, expected {clone_a}")
if got == clone_b:
    raise SystemExit("repo retargeted to clone B")
head_line = next((ln for ln in out.splitlines() if ln.startswith("head: ")), "")
if head_a not in head_line:
    raise SystemExit(f"HEAD was {head_line!r}, expected {head_a}")
if board_a not in out and Path(board_a).as_posix() not in out:
    raise SystemExit(f"A board path missing: {board_a}")
if "session=a-sess" not in out:
    raise SystemExit("A board claim missing from restore")
if str(clone_b) in out and "B_MARKER" not in out:
    # board/repo paths of B must not appear; incidental substring of tmp root is ok
    for line in out.splitlines():
        if str(clone_b) in line or str(clone_b.resolve()) in line:
            raise SystemExit(f"clone B path leaked: {line}")
PY
if [ -e "$CLONE_B/.git/oort-coordination" ]; then
  fail "hook under GIT_DIR=B mutated clone B board"
fi
pass "actual SessionStart command keeps A under inherited GIT_DIR=B"

echo "[planning-context-test] all cases passed"
