#!/usr/bin/env bash
# #1376 ambient-toolchain hardening fixtures for scripts/local_gate.sh.
#
# Two gate steps shell out to toolchains this repo does not version, and both
# failed in ways that were worse than having no check: actionlint 1.7.12 spun at
# 800% CPU forever inside its shellcheck integration layer (holding the whole
# gate hostage before anything downstream ran), and the YAML parse steps trusted
# whatever `ruby` the ambient PATH resolved — macOS system Ruby 2.6 in a
# worker-spawned shell — so valid YAML 1.2 produced a Psych::SyntaxError that
# read as a repo RED.
#
# The fragments under test are extracted straight out of local_gate.sh and run
# against stub toolchains, so this fixture measures the string the gate actually
# executes rather than a copy of it. No network, Docker, DB, or real linter.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
LOCAL_GATE="$REPO_ROOT/scripts/local_gate.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-gate-lint-timeout.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

fail() {
  echo "[gate-lint-timeout-test] FAIL: $*" >&2
  exit 1
}

pass() {
  echo "[gate-lint-timeout-test] PASS $*"
}

# Extract a single-line GATE_*_CMD='...' fragment. The fragments are deliberately
# single-quoted with no embedded single quotes (write_evidence renders each
# command inside an inline backtick span, so they must also stay single-line).
extract_fragment() {
  local name="$1" line
  line="$(grep -c "^${name}='" "$LOCAL_GATE")"
  [ "$line" = 1 ] || fail "$name must be defined exactly once as a single-quoted one-liner (found $line)"
  line="$(grep -m1 "^${name}='" "$LOCAL_GATE")"
  line="${line#${name}=\'}"
  line="${line%\'}"
  case "$line" in
    *\'*) fail "$name contains a single quote; the fragment can no longer be extracted or safely embedded" ;;
  esac
  [ -n "$line" ] || fail "$name extracted empty"
  printf '%s' "$line"
}

WORKFLOW_LINT_CMD="$(extract_fragment GATE_WORKFLOW_LINT_CMD)"
RUBY_SELECT_CMD="$(extract_fragment GATE_RUBY_SELECT_CMD)"

# ---------------------------------------------------------------------------
# Static wiring: the hardened fragments must be what the gate steps actually
# run. Inlining a bare `actionlint ...` or `ruby -e ...` again would restore the
# exact defects this fixture exists to hold shut, so the wiring is measured, not
# assumed.
# ---------------------------------------------------------------------------
grep -Fq 'add_cmd_once "workflow lint" "$GATE_WORKFLOW_LINT_CMD"' "$LOCAL_GATE" \
  || fail "workflow lint step no longer runs the timeout-guarded fragment"
grep -Fq 'add_cmd_once "workflow yaml parse" "$GATE_WORKFLOW_YAML_PARSE_CMD"' "$LOCAL_GATE" \
  || fail "workflow yaml parse step no longer runs the ruby-capability fragment"
grep -Fq 'add_cmd_once "openapi contract spec parse" "$GATE_OPENAPI_YAML_PARSE_CMD"' "$LOCAL_GATE" \
  || fail "openapi spec parse step no longer runs the ruby-capability fragment"
for composed in GATE_WORKFLOW_YAML_PARSE_CMD GATE_OPENAPI_YAML_PARSE_CMD; do
  grep -Fq "$composed=\"\$GATE_RUBY_SELECT_CMD\"" "$LOCAL_GATE" \
    || fail "$composed no longer prefixes the shared Ruby capability probe"
done
# Any surviving `ruby -e` that is not routed through the resolved interpreter is
# the #1376 defect back in place.
if grep -nE '(^|[^_"$[:alnum:]])ruby -e' "$LOCAL_GATE" >"$SANDBOX/bare-ruby" 2>/dev/null; then
  cat "$SANDBOX/bare-ruby" >&2
  fail "local_gate.sh calls ambient \`ruby -e\` directly again instead of the resolved \$ruby_bin"
fi
case "$WORKFLOW_LINT_CMD" in
  *MOMO_GATE_ACTIONLINT_TIMEOUT*) : ;;
  *) fail "actionlint fragment has no timeout knob" ;;
esac
pass "hardened fragments are the strings the gate steps execute"

# ---------------------------------------------------------------------------
# actionlint stubs. `spin` burns wall time and forks a grandchild so the reaping
# path is exercised the way the real linter forks shellcheck.
# ---------------------------------------------------------------------------
STUB_BIN="$SANDBOX/bin"
mkdir -p "$STUB_BIN"

write_actionlint_stub() {
  # $1 = behaviour with shellcheck integration on, $2 = behaviour with
  # -shellcheck= passed. Behaviours: spin | ok | finding
  cat >"$STUB_BIN/actionlint" <<STUB
#!/usr/bin/env bash
mode="$1"
for a in "\$@"; do
  [ "\$a" = "-shellcheck=" ] && mode="$2"
done
: >>"\$STUB_INVOCATIONS"
printf '%s\n' "\$mode \$*" >>"\$STUB_INVOCATIONS"
case "\$mode" in
  spin)
    echo "stub actionlint: spinning"
    sleep 600 &
    echo \$! >>"\$STUB_SPINNERS"
    sleep 600
    ;;
  finding)
    echo ".github/workflows/pr-ci.yml:1:1: stub finding [syntax-check]"
    exit 1
    ;;
  *)
    echo "stub actionlint: clean"
    exit 0
    ;;
esac
STUB
  chmod +x "$STUB_BIN/actionlint"
}

run_workflow_lint() {
  # Runs the extracted fragment the same way run_cmd does (bash -lc), with the
  # stub first on PATH and a short timeout so the fixture stays cheap.
  local limit="$1"
  set +e
  ( cd "$REPO_ROOT" \
    && PATH="$STUB_BIN:$PATH" \
       MOMO_GATE_ACTIONLINT_TIMEOUT="$limit" \
       STUB_INVOCATIONS="$SANDBOX/invocations" \
       STUB_SPINNERS="$SANDBOX/spinners" \
       bash -lc "$WORKFLOW_LINT_CMD" ) >"$SANDBOX/lint.out" 2>&1
  LINT_RC=$?
  set -e
}

reset_stub_state() {
  : >"$SANDBOX/invocations"
  : >"$SANDBOX/spinners"
}

# --- spin with shellcheck, clean without: timeout must degrade, not hang ---
write_actionlint_stub spin ok
reset_stub_state
START="$(date +%s)"
run_workflow_lint 3
ELAPSED=$(( $(date +%s) - START ))
[ "$LINT_RC" -eq 0 ] || fail "timeout+degraded retry did not end green (exit $LINT_RC): $(cat "$SANDBOX/lint.out")"
grep -Fq 'DEGRADED (#1376)' "$SANDBOX/lint.out" \
  || fail "timeout was absorbed silently — no degradation notice in gate output"
grep -Fq 'are NOT covered by this run' "$SANDBOX/lint.out" \
  || fail "degradation notice does not say what the reduced run stopped covering"
grep -Fq 'DEGRADED mode' "$SANDBOX/lint.out" \
  || fail "final PASS line does not record that the run was degraded"
grep -Fq -- '-shellcheck=' "$SANDBOX/invocations" \
  || fail "retry did not disable the shellcheck integration"
[ "$(grep -c . "$SANDBOX/invocations")" -eq 2 ] \
  || fail "expected exactly one retry, saw $(grep -c . "$SANDBOX/invocations") invocations"
# 3s limit + 2s SIGKILL grace + the clean retry; a hang or a missing watchdog
# blows straight past this, and the real defect ran unbounded.
[ "$ELAPSED" -lt 20 ] || fail "hard timeout did not bound the step (${ELAPSED}s)"
pass "actionlint spin is killed at the hard timeout and degrades to one -shellcheck= retry (${ELAPSED}s)"

# The spinner and its grandchild must be gone: a leaked 800% CPU process is the
# incident even when the gate itself returned.
sleep 1
LEAKED=0
while read -r spinner; do
  [ -n "$spinner" ] || continue
  kill -0 "$spinner" 2>/dev/null && LEAKED=$((LEAKED + 1))
done <"$SANDBOX/spinners"
[ "$LEAKED" -eq 0 ] || fail "$LEAKED stub grandchild process(es) survived the timeout kill"
pass "timeout reaps the linter grandchildren, not just the direct child"

# --- spin in both modes: must fail closed, never hang and never pass ---
write_actionlint_stub spin spin
reset_stub_state
START="$(date +%s)"
run_workflow_lint 3
ELAPSED=$(( $(date +%s) - START ))
[ "$LINT_RC" -ne 0 ] || fail "actionlint that spins even with -shellcheck= was reported green"
grep -Fq 'timed out again' "$SANDBOX/lint.out" \
  || fail "second timeout was not named in gate output"
[ "$ELAPSED" -lt 30 ] || fail "double timeout was not bounded (${ELAPSED}s)"
pass "an actionlint that spins in both modes fails closed and stays bounded (${ELAPSED}s)"

# --- genuine finding: hard failure, never laundered through the retry ---
write_actionlint_stub finding ok
reset_stub_state
run_workflow_lint 30
[ "$LINT_RC" -ne 0 ] || fail "a real actionlint finding was retried into green"
grep -Fq 'stub finding' "$SANDBOX/lint.out" || fail "actionlint findings are no longer surfaced"
grep -Fq 'DEGRADED' "$SANDBOX/lint.out" \
  && fail "a real finding triggered the degraded retry; only timeouts may degrade"
[ "$(grep -c . "$SANDBOX/invocations")" -eq 1 ] \
  || fail "a real finding must not be retried"
pass "a genuine actionlint finding stays a hard failure with no retry"

# --- not-installed fallback (both branches) must survive the rewrite ---
EMPTY_BIN="$SANDBOX/empty-bin"
mkdir -p "$EMPTY_BIN"
FAKE_REPO="$SANDBOX/no-actionlint-repo"
mkdir -p "$FAKE_REPO/.github/workflows"
git -C "$FAKE_REPO" init -q
git -C "$FAKE_REPO" config user.name "Momo Gate Test"
git -C "$FAKE_REPO" config user.email "gate-test@momo.invalid"
printf 'name: stub\non: push\njobs: {}\n' >"$FAKE_REPO/.github/workflows/stub.yml"
git -C "$FAKE_REPO" add -A
git -C "$FAKE_REPO" commit -qm base

run_without_actionlint() {
  set +e
  ( cd "$FAKE_REPO" \
    && PATH="$EMPTY_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
       LOCAL_GATE_BASE_REF="refs/heads/does-not-exist" \
       bash -lc "$WORKFLOW_LINT_CMD" ) >"$SANDBOX/lint.out" 2>&1
  LINT_RC=$?
  set -e
}

run_without_actionlint
[ "$LINT_RC" -eq 0 ] || fail "absent actionlint with unchanged workflows should skip, not fail (exit $LINT_RC)"
grep -Fq 'actionlint not installed; workflow files unchanged; skipped' "$SANDBOX/lint.out" \
  || fail "the skip message of the not-installed branch was lost"

printf 'name: stub\non: push\njobs: {}\n# changed\n' >"$FAKE_REPO/.github/workflows/stub.yml"
run_without_actionlint
[ "$LINT_RC" -ne 0 ] || fail "absent actionlint with CHANGED workflows must fail closed"
grep -Fq 'actionlint is not installed and workflow files changed' "$SANDBOX/lint.out" \
  || fail "the fail-closed message of the not-installed branch was lost"
grep -Fq '.github/workflows/stub.yml' "$SANDBOX/lint.out" \
  || fail "the fail-closed branch no longer names the changed workflow"
pass "not-installed fallback keeps both branches: skip when unchanged, fail closed when changed"

# ---------------------------------------------------------------------------
# Ruby capability selection.
# ---------------------------------------------------------------------------
RUBY_BIN_DIR="$SANDBOX/ruby"
mkdir -p "$RUBY_BIN_DIR"

# Stand-in for macOS system Ruby 2.6: everything works except colon-bearing
# plain scalars in a flow sequence — the exact HAP scope enum shape.
cat >"$RUBY_BIN_DIR/ruby26" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"[a:b:c]"*)
    echo "psych.rb:456:in \`parse': (<unknown>): found unexpected ':' while scanning a plain scalar (Psych::SyntaxError)" >&2
    exit 1
    ;;
esac
[ "${1:-}" = "-e" ] && case "$2" in *RUBY_VERSION*) printf '2.6.10'; exit 0 ;; esac
exit 0
STUB
cat >"$RUBY_BIN_DIR/ruby34" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-e" ] && case "$2" in *RUBY_VERSION*) printf '3.4.0'; exit 0 ;; esac
exit 0
STUB
chmod +x "$RUBY_BIN_DIR/ruby26" "$RUBY_BIN_DIR/ruby34"

run_ruby_select() {
  set +e
  ( cd "$REPO_ROOT" \
    && MOMO_GATE_RUBY_CANDIDATES="$1" \
       bash -lc "$RUBY_SELECT_CMD" ) >"$SANDBOX/ruby.out" 2>&1
  RUBY_RC=$?
  set -e
}

run_ruby_select "$RUBY_BIN_DIR/ruby26"
[ "$RUBY_RC" -ne 0 ] || fail "a psych-incapable Ruby was accepted as the gate interpreter"
grep -Fq 'Psych::SyntaxError' "$SANDBOX/ruby.out" \
  && fail "the gate leaked a bare parser stack trace instead of an actionable message"
grep -Fq '/opt/homebrew/opt/ruby/bin/ruby' "$SANDBOX/ruby.out" \
  || fail "the failure message does not name the Homebrew ruby path"
grep -Fq 'brew install ruby' "$SANDBOX/ruby.out" \
  || fail "the failure message is not actionable (no install command)"
grep -Fq 'generator-owned' "$SANDBOX/ruby.out" \
  || fail "the failure message does not warn against quote-fixing the generated enum values"
grep -Fq 'NOT a repo defect' "$SANDBOX/ruby.out" \
  || fail "the failure message does not distinguish a host gap from a repo defect"
pass "a 2.6-only host fails with the Homebrew path, not a Psych error on valid YAML"

run_ruby_select "$RUBY_BIN_DIR/ruby26 $RUBY_BIN_DIR/ruby34"
[ "$RUBY_RC" -eq 0 ] || fail "a capable Ruby behind an incapable one was not selected (exit $RUBY_RC)"
grep -Fq "gate ruby: $RUBY_BIN_DIR/ruby34" "$SANDBOX/ruby.out" \
  || fail "selection is not by capability, or the chosen interpreter is not recorded in evidence"
grep -Fq '3.4.0' "$SANDBOX/ruby.out" \
  || fail "the chosen interpreter version is not recorded in evidence"
pass "selection skips the incapable interpreter and records which Ruby the gate used"

# MOMO_GATE_RUBY must win the ordering so an operator can pin an interpreter.
set +e
( cd "$REPO_ROOT" \
  && MOMO_GATE_RUBY="$RUBY_BIN_DIR/ruby34" \
     MOMO_GATE_RUBY_CANDIDATES="$RUBY_BIN_DIR/ruby26" \
     bash -lc "$RUBY_SELECT_CMD" ) >"$SANDBOX/ruby.out" 2>&1
RUBY_RC=$?
set -e
[ "$RUBY_RC" -eq 0 ] && grep -Fq "gate ruby: $RUBY_BIN_DIR/ruby34" "$SANDBOX/ruby.out" \
  || fail "MOMO_GATE_RUBY did not take precedence over the candidate list"
pass "MOMO_GATE_RUBY pins the interpreter ahead of the default candidate list"

# End-to-end on the real spec: whichever Ruby this host resolves, the openapi
# parse step must be green or explicitly actionable — never a bare Psych error.
set +e
( cd "$REPO_ROOT" && bash -lc "$RUBY_SELECT_CMD"'; "$ruby_bin" -e "require %q(yaml); YAML.load_file(%q(docs/api/openapi.yaml)); puts %q(docs/api/openapi.yaml)"' ) \
  >"$SANDBOX/openapi.out" 2>&1
OPENAPI_RC=$?
set -e
if [ "$OPENAPI_RC" -eq 0 ]; then
  grep -Fq 'docs/api/openapi.yaml' "$SANDBOX/openapi.out" \
    || fail "openapi parse returned green without naming the file it parsed"
  pass "docs/api/openapi.yaml parses green through the resolved Ruby (colon-scoped HAP enums intact, unquoted)"
else
  grep -Fq 'brew install ruby' "$SANDBOX/openapi.out" \
    || fail "openapi parse failed without the actionable Homebrew message: $(cat "$SANDBOX/openapi.out")"
  pass "no capable Ruby on this host; the step fails with the actionable message rather than a Psych error"
fi

echo "[gate-lint-timeout-test] ALL PASS"
