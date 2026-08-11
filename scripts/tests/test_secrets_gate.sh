#!/usr/bin/env bash
# Isolated regression for the #1236 secret scan gate (scripts/check_secrets.sh).
#
# A green secret scan is the least informative signal in the repository: a gate
# that never fires is also green, and so is a gate whose scanner is missing.
# Every case below either shows the gate turning RED for a reason we can name, or
# shows the triage baseline actually being honoured.
#
# The fake secret is generated at run time and never appears as a literal in this
# file. That is not style: this file is committed, the production gate scans all
# of history, and a hard-coded high-entropy string here would make the gate red
# on itself the moment it lands (#1224 hit the same trap with baseline comments
# that quoted their own findings).
#
# No Docker, no network, no writes inside the repository.
set -uo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check_secrets.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-secrets-gate-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

CASES=0
fail() { echo "[secrets-gate-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[secrets-gate-test] ok: $*"; }

[ -x "$GATE" ] || fail "missing executable gate: $GATE"

# Resolved before any PATH override below: the empty-PATH case has to lose
# gitleaks without losing the interpreter that runs the gate.
BASH_BIN="${BASH:-$(command -v bash)}"
[ -x "$BASH_BIN" ] || fail "could not resolve an absolute bash path"

# =============================================================================
# Case 1 — an absent scanner is a failure, not a skip.
# =============================================================================
mkdir -p "$SANDBOX/emptybin" "$SANDBOX/noop-root"
out="$(PATH="$SANDBOX/emptybin" SECRETS_GATE_REPO_ROOT="$SANDBOX/noop-root" \
  SECRETS_GATE_BASELINE="$SANDBOX/noop-root/.gitleaksignore" "$BASH_BIN" "$GATE" 2>&1)"
status=$?
[ "$status" -ne 0 ] || fail "gate passed with gitleaks unavailable"
case "$out" in
  *"gitleaks is not installed"*) ;;
  *) fail "missing gitleaks did not print install guidance: $out" ;;
esac
pass "gate fails closed with install guidance when gitleaks is absent"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[secrets-gate-test] skip: gitleaks is not installed on this host"
  echo "[secrets-gate-test] PASS: $CASES case(s)"
  exit 0
fi

# =============================================================================
# Build a throwaway repository carrying one committed fake credential. The real
# repository's history is never touched.
# =============================================================================
FIXTURE="$SANDBOX/fixture"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email "secrets-gate-test@example.invalid"
git -C "$FIXTURE" config user.name "secrets gate test"
git -C "$FIXTURE" config commit.gpgsign false

# Build a provider-shaped credential only at runtime. The former random hex
# fixture depended on the stock generic-api-key rule's entropy threshold: a
# perfectly random sample can still have low *observed* entropy and make this
# RED proof flaky. This shape targets gitleaks' built-in aws-access-token rule,
# whose alphabet/length contract is deterministic. Keep the prefix split so no
# complete credential-shaped literal ever enters this repository's history.
FAKE_PREFIX="AK"
FAKE_PREFIX="${FAKE_PREFIX}IA"
FAKE_SUFFIX="234567ABCDEFGHJK"
FAKE_VALUE="${FAKE_PREFIX}${FAKE_SUFFIX}"
[ "${#FAKE_VALUE}" -eq 20 ] || fail "could not build the deterministic credential fixture"

printf 'HERMES_API_KEY=%s\n' "$FAKE_VALUE" > "$FIXTURE/service.env"
git -C "$FIXTURE" add service.env
git -C "$FIXTURE" commit -q -m "fixture: committed credential"

BASELINE="$SANDBOX/fixture-gitleaksignore"
: > "$BASELINE"

run_gate() {
  SECRETS_GATE_REPO_ROOT="$FIXTURE" SECRETS_GATE_BASELINE="$BASELINE" bash "$GATE" 2>&1
}

# =============================================================================
# Case 2 — a missing baseline is named, not swallowed.
# =============================================================================
out="$(SECRETS_GATE_REPO_ROOT="$FIXTURE" SECRETS_GATE_BASELINE="$SANDBOX/absent-baseline" \
  bash "$GATE" 2>&1)"
status=$?
[ "$status" -ne 0 ] || fail "gate passed with no triage baseline"
case "$out" in
  *"missing triage baseline"*) ;;
  *) fail "absent baseline produced an unrecognisable error: $out" ;;
esac
pass "gate fails closed and names the baseline when it is missing"

# =============================================================================
# Case 3 — RED PROOF: a committed credential is caught.
# =============================================================================
out="$(run_gate)"
status=$?
[ "$status" -ne 0 ] || fail "gate stayed green over a committed fake credential"
case "$out" in
  *"gitleaks reported findings"*) ;;
  *) fail "finding did not surface through the gate's own failure path: $out" ;;
esac
case "$out" in
  *"$FAKE_VALUE"*) fail "gate printed the unredacted secret value" ;;
esac
pass "gate turns red on a committed credential and does not echo it in full"

# =============================================================================
# Case 4 — the baseline is actually honoured (and only for that fingerprint).
# =============================================================================
gitleaks detect --source "$FIXTURE" --log-opts "--all" --no-banner \
  --report-format json --report-path "$SANDBOX/report.json" >/dev/null 2>&1
FINGERPRINT="$(python3 - "$SANDBOX/report.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    findings = json.load(fh)
if not findings:
    raise SystemExit("")
print(findings[0].get("Fingerprint", ""))
PY
)"
[ -n "$FINGERPRINT" ] || fail "could not read a fingerprint out of the gitleaks report"
RULE_ID="$(python3 - "$SANDBOX/report.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    findings = json.load(fh)
if not findings:
    raise SystemExit("")
print(findings[0].get("RuleID", ""))
PY
)"
[ "$RULE_ID" = "aws-access-token" ] ||
  fail "deterministic credential fixture hit an unexpected gitleaks rule: ${RULE_ID:-none}"
printf '%s\n' "$FINGERPRINT" > "$BASELINE"

out="$(run_gate)"
status=$?
[ "$status" -eq 0 ] || fail "gate stayed red after the finding was pinned in the baseline: $out"
pass "gate goes green once the finding is pinned by fingerprint"

printf '%s\n' "${FINGERPRINT%:*}:999999" > "$BASELINE"
out="$(run_gate)"
status=$?
[ "$status" -ne 0 ] || fail "gate accepted a baseline entry that does not match the finding"
pass "a non-matching baseline entry does not silence the finding"

printf '%s\n' "$FINGERPRINT" > "$BASELINE"

# =============================================================================
# Case 5 — why the gate must stay in git mode.
#
# .gitleaksignore fingerprints are <commit>:<file>:<rule>:<line>. --no-git has no
# commit, so the same baseline that makes Case 4 green does not apply. This is
# the measurement behind the design note in check_secrets.sh: anyone "optimising"
# the gate to --no-git would resurrect the whole triaged false-positive set.
# =============================================================================
gitleaks detect --source "$FIXTURE" --no-git --no-banner \
  --gitleaks-ignore-path "$BASELINE" >/dev/null 2>&1
status=$?
[ "$status" -ne 0 ] ||
  fail "--no-git honoured the commit-scoped baseline; the git-mode rationale needs re-measuring"
pass "--no-git ignores the commit-scoped baseline (git mode is load-bearing)"

echo "[secrets-gate-test] PASS: $CASES case(s)"
