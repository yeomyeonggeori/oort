#!/usr/bin/env bash
# Secret scan gate (#1236).
#
# #1224 landed `.gitleaksignore` — 61 hand-triaged false positives pinned by
# fingerprint so that one real leak stops being buried in noise. What it did not
# land was an executor: gitleaks appeared in three planning documents and in no
# gate, so the baseline guarded nothing. This script is that executor.
#
# What it runs is exactly the command `.gitleaksignore` documents as the range it
# guarantees:
#
#   gitleaks detect --source <root> --log-opts "--all" --redact=90
#
# Two properties of that command matter and neither is cosmetic:
#
#   1. It is the git-history mode. gitleaks fingerprints are <commit>:<file>:
#      <rule>:<line>, so the baseline only applies where commits exist.
#      `--no-git` and `gitleaks protect` compute commit-less fingerprints and the
#      same 49 false positives come straight back (#1224 measured this). Running
#      either of those here would produce a red that says nothing.
#   2. `--log-opts "--all"` walks every ref, not just this branch. A secret
#      committed on any local branch is a secret in the repository.
#
# Uncommitted work is deliberately out of scope: it has no commit, so it has no
# fingerprint, so the baseline cannot speak about it. scripts/local_gate.sh
# already requires a clean worktree in the same static block, which is what
# closes that gap — the two checks are complementary, not redundant.
#
# Missing gitleaks is a FAILURE, not a skip. A secret gate that passes quietly on
# a machine without the scanner is the exact failure mode #1236 exists to fix,
# and there is no reviewed-override env here on purpose (unlike the branch-skew
# guard): "skip the secret scan" is not a reviewable exception.
#
# No findings report file is written even when the gate runs inside local_gate's
# artifact directory. A gitleaks JSON report carries the matched secret values,
# and `--redact` only covers logs and stdout — writing that to an evidence
# directory would turn a leak detector into a leak.
#
# Usage: scripts/check_secrets.sh
#
# Environment (test/fixture use only):
#   SECRETS_GATE_REPO_ROOT   Repository root override.
#   SECRETS_GATE_BASELINE    .gitleaksignore path override.
#   SECRETS_GATE_LOG_OPTS    git log options override (default: --all).
set -uo pipefail

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "${SECRETS_GATE_REPO_ROOT:-}" ]; then
  REPO_ROOT="$SECRETS_GATE_REPO_ROOT"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "SECRET SCAN FAIL: run inside a git repository" >&2
    exit 1
  }
fi
cd "$REPO_ROOT" || {
  echo "SECRET SCAN FAIL: cannot enter repository root: $REPO_ROOT" >&2
  exit 1
}

BASELINE="${SECRETS_GATE_BASELINE:-$REPO_ROOT/.gitleaksignore}"
LOG_OPTS="${SECRETS_GATE_LOG_OPTS:---all}"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "SECRET SCAN FAIL: gitleaks is not installed." >&2
  echo "  macOS:  brew install gitleaks" >&2
  echo "  other:  https://github.com/gitleaks/gitleaks#installing" >&2
  echo "This gate fails closed on purpose: without the scanner it cannot tell a" >&2
  echo "clean history from an unscanned one." >&2
  exit 1
fi

# The baseline is what makes a green here mean something. Without it the scan
# still runs and still turns red, but on 61 known-benign findings — a red nobody
# can act on. Name the real problem instead.
if [ ! -f "$BASELINE" ]; then
  echo "SECRET SCAN FAIL: missing triage baseline: $BASELINE" >&2
  echo "It pins the reviewed false positives (#1224). Restore it rather than" >&2
  echo "re-triaging 61 findings by hand." >&2
  exit 1
fi

echo "[secret-scan] gitleaks $(gitleaks version 2>/dev/null || echo '(version unknown)') over all refs, baseline $(basename "$BASELINE")"

gitleaks detect \
  --source "$REPO_ROOT" \
  --gitleaks-ignore-path "$BASELINE" \
  --log-opts "$LOG_OPTS" \
  --redact=90
status=$?

if [ "$status" -ne 0 ]; then
  echo "SECRET SCAN FAIL: gitleaks reported findings (exit $status)." >&2
  echo "Each line above is a commit that still carries the value. Rotate first," >&2
  echo "then decide: a true positive needs history surgery, a false positive needs" >&2
  echo "a fingerprint line in $(basename "$BASELINE") with a reason that describes" >&2
  echo "the value instead of quoting it (quoting it creates a new finding)." >&2
  exit 1
fi

echo "[secret-scan] PASS: no unreviewed findings across all refs"
