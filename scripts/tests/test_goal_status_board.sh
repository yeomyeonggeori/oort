#!/usr/bin/env bash
# Isolated proofs for scripts/goal_status.sh gate hints and cleanup
# suppression. Fake gh + local bare origin; no GitHub and no network.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
STATUS_SRC="$REPO_ROOT/scripts/goal_status.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-goal-status-board.XXXXXX")"
FIXTURE="$SANDBOX/repo"
STATE="$SANDBOX/state"
BIN="$SANDBOX/bin"
REAL_GIT="$(command -v git)"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
mkdir -p "$STATE" "$BIN"

fail() {
  echo "[goal-status-board-test] FAIL: $*" >&2
  if [ -f "$SANDBOX/out" ]; then
    echo "----- output -----" >&2
    cat "$SANDBOX/out" >&2
  fi
  exit 1
}
pass() { echo "[goal-status-board-test] ok: $*"; }

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
set -euo pipefail
if [ "\$1" = "issue" ] && [ "\$2" = "list" ]; then
  cat "$STATE/issues.json"
  exit 0
fi
if [ "\$1" = "pr" ] && [ "\$2" = "list" ]; then
  cat "$STATE/prs.json"
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
printf 'base\n' >"$FIXTURE/state.txt"
git -C "$FIXTURE" add state.txt
git -C "$FIXTURE" commit -qm base
git -C "$FIXTURE" branch -M main
git -C "$FIXTURE" push -q origin main
git -C "$FIXTURE" push -q origin main:refs/heads/track/engine
git -C "$FIXTURE" push -q origin main:refs/heads/track/2501-looks-like-issue
git -C "$FIXTURE" push -q origin main:refs/heads/feat/42-closed
git -C "$FIXTURE" push -q origin main:refs/heads/wip-not-an-issue
git -C "$FIXTURE" push -q origin main:refs/heads/feat/99-open

git -C "$FIXTURE" branch track/engine origin/track/engine
git -C "$FIXTURE" branch track/2501-looks-like-issue origin/track/2501-looks-like-issue
git -C "$FIXTURE" branch feat/42-closed origin/feat/42-closed
git -C "$FIXTURE" branch wip-not-an-issue origin/wip-not-an-issue
git -C "$FIXTURE" branch feat/99-open origin/feat/99-open

git -C "$FIXTURE" worktree add -q "$SANDBOX/wt-track" track/engine
git -C "$FIXTURE" worktree add -q "$SANDBOX/wt-track-issue" track/2501-looks-like-issue
git -C "$FIXTURE" worktree add -q "$SANDBOX/wt-42" feat/42-closed
git -C "$FIXTURE" worktree add -q "$SANDBOX/wt-misc" wip-not-an-issue
git -C "$FIXTURE" worktree add -q "$SANDBOX/wt-open" feat/99-open

git -C "$SANDBOX/wt-42" branch -u origin/feat/42-closed >/dev/null

python3 - "$STATE/issues.json" "$STATE/prs.json" <<'PY'
import json, sys

def labels(*names):
    return [{"name": n} for n in names]

issues = [
    {
        "number": 11,
        "title": "server-issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("area:server", "status:in-progress"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/11",
        "closedAt": None,
    },
    {
        "number": 12,
        "title": "docs-issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("type:docs", "status:in-progress"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/12",
        "closedAt": None,
    },
    {
        "number": 13,
        "title": "web-issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("area:web", "status:in-progress"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/13",
        "closedAt": None,
    },
    {
        "number": 14,
        "title": "macos-issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("area:macos", "status:in-progress"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/14",
        "closedAt": None,
    },
    {
        "number": 15,
        "title": "unknown-issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("area:ios", "status:in-progress"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/15",
        "closedAt": None,
    },
    {
        "number": 16,
        "title": "relay-issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("area:relay", "status:in-progress"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/16",
        "closedAt": None,
    },
    {
        "number": 17,
        "title": "worker-issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("area:worker", "status:in-progress"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/17",
        "closedAt": None,
    },
    {
        "number": 42,
        "title": "closed done issue",
        "state": "CLOSED",
        "assignees": [],
        "labels": labels("status:needs-review"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/42",
        "closedAt": "2026-09-01T00:00:00Z",
    },
    {
        "number": 99,
        "title": "still open issue",
        "state": "OPEN",
        "assignees": [],
        "labels": labels("status:in-progress", "area:server"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/99",
        "closedAt": None,
    },
    {
        "number": 2501,
        "title": "track-looking issue",
        "state": "CLOSED",
        "assignees": [],
        "labels": labels("status:needs-review"),
        "url": "https://github.com/yeomyeonggeori/oort/issues/2501",
        "closedAt": "2026-09-01T00:00:00Z",
    },
]
prs = [
    {
        "number": 100,
        "title": "track engine merge",
        "headRefName": "track/engine",
        "url": "https://github.com/yeomyeonggeori/oort/pull/100",
        "isDraft": False,
        "reviewDecision": "APPROVED",
        "state": "MERGED",
        "mergedAt": "2026-09-01T00:00:00Z",
        "closedAt": "2026-09-01T00:00:00Z",
    },
    {
        "number": 101,
        "title": "closed issue pr",
        "headRefName": "feat/42-closed",
        "url": "https://github.com/yeomyeonggeori/oort/pull/101",
        "isDraft": False,
        "reviewDecision": "APPROVED",
        "state": "MERGED",
        "mergedAt": "2026-09-01T00:00:00Z",
        "closedAt": "2026-09-01T00:00:00Z",
    },
    {
        "number": 102,
        "title": "open work",
        "headRefName": "feat/99-open",
        "url": "https://github.com/yeomyeonggeori/oort/pull/102",
        "isDraft": False,
        "reviewDecision": None,
        "state": "OPEN",
        "mergedAt": None,
        "closedAt": None,
    },
    {
        "number": 103,
        "title": "track issue-like merge",
        "headRefName": "track/2501-looks-like-issue",
        "url": "https://github.com/yeomyeonggeori/oort/pull/103",
        "isDraft": False,
        "reviewDecision": "APPROVED",
        "state": "MERGED",
        "mergedAt": "2026-09-01T00:00:00Z",
        "closedAt": "2026-09-01T00:00:00Z",
    },
]
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(issues))
open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(prs))
PY

export PATH="$BIN:$PATH"
CDPATH='' cd -- "$FIXTURE"
"$STATUS_SRC" --repo yeomyeonggeori/oort >"$SANDBOX/out" 2>"$SANDBOX/err" \
  || fail "goal_status.sh exited $?"

python3 - "$SANDBOX/out" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text()
if "macos-ui" in text:
    raise SystemExit("retired macos-ui gate hint emitted")
if "docs+swift-before-merge" in text:
    raise SystemExit("retired docs+swift-before-merge gate hint emitted")

def row_for(title: str) -> list[str]:
    for line in text.splitlines():
        if title in line and "in-progress" in line:
            parts = line.split()
            if len(parts) >= 5:
                return parts
    raise SystemExit(f"missing in-progress row for {title}")


def gate_for(title: str) -> str:
    return row_for(title)[3]


def evidence_for(title: str) -> str:
    return row_for(title)[4]

expected = {
    "server-issue": "runtime-db",
    "docs-issue": "docs",
    "web-issue": "web",
    "macos-issue": "verify-scope",
    "unknown-issue": "verify-scope",
    "relay-issue": "runtime-relay",
    "worker-issue": "runtime-agent",
}
for title, gate in expected.items():
    got = gate_for(title)
    if got != gate:
        raise SystemExit(f"{title}: expected gate {gate}, got {got}")

evidence_expected = {
    "server-issue": "run:runtime-db",
    "docs-issue": "run:docs",
    "web-issue": "run:web",
    "macos-issue": "inspect-scope",
    "unknown-issue": "inspect-scope",
    "relay-issue": "run:runtime-relay",
    "worker-issue": "run:runtime-agent",
}
for title, evidence in evidence_expected.items():
    got = evidence_for(title)
    if got != evidence:
        raise SystemExit(f"{title}: expected evidence {evidence}, got {got}")
if "run:verify-scope" in text:
    raise SystemExit("invalid run:verify-scope evidence hint emitted")

# A bare gate token "swift" as its own field (not the legend sentence).
for line in text.splitlines():
    if line.startswith("in-progress") and re.search(r"\bswift\b", line):
        raise SystemExit(f"swift used as a gate profile: {line}")

cleanup_lines = [
    line for line in text.splitlines() if "git worktree remove" in line
]
if not cleanup_lines:
    raise SystemExit("expected a cleanup command for feat/42-closed")
joined = "\n".join(cleanup_lines)
if "feat/42-closed" not in joined and "wt-42" not in joined:
    raise SystemExit(f"cleanup did not target the closed issue worktree:\n{joined}")

forbidden_needles = (
    "track/engine",
    "track/2501-looks-like-issue",
    "wt-track",
    "wip-not-an-issue",
    "wt-misc",
    "/main'",
)
for line in cleanup_lines:
    for needle in forbidden_needles:
        if needle in line:
            raise SystemExit(f"cleanup command targeted a protected branch: {line}")
    # Never clean the fixture main checkout.
    if line.endswith("repo'") or "/repo'" in line:
        # allow only if path is the done worktree
        if "wt-42" not in line and "feat/42-closed" not in line:
            raise SystemExit(f"unexpected cleanup path: {line}")
PY
pass "live profile / verify-scope hints"
pass "canonical and non-issue branches never get cleanup commands"
pass "closed issue-branch worktree may be a done-candidate"

echo "[goal-status-board-test] all cases passed"
