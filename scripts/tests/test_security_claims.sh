#!/usr/bin/env bash
# Red-proof regression for scripts/check_security_claims.py (SEC-02, #4224).
# Part 1 builds a tiny fixture repo, proves it green, then breaks it one way at a time
# (every red must carry its own code, so a red for another reason fails the case).
# Part 2 runs the real tree: green, the no-PyYAML fallback parser, and two sabotages of
# the real files. Part 1 also records the one thing the lint cannot see (a gutted test body).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$ROOT/scripts/check_security_claims.py"
T="$(mktemp -d "${TMPDIR:-/tmp}/security-claims.XXXXXX")"
trap 'rm -rf "$T"' EXIT
fail=0

fresh() {
  rm -rf "$T/f"; local f="$T/f"
  mkdir -p "$f/scripts/tests" "$f/docs/security" "$f/infra/security-pack" "$f/.github/workflows" "$f/scripts" \
    "$f/server-rust/crates/foo/src" "$f/server-rust/crates/foo/tests" "$f/packages/momo-core/src"
  printf '[package]\nname = "foo"\nversion = "0.0.0"\n' > "$f/server-rust/crates/foo/Cargo.toml"
  cat > "$f/server-rust/crates/foo/src/lib.rs" <<'RS'
// the_commented_test_name_is_not_a_test
fn a_helper_that_is_not_a_test() {}

#[cfg(test)]
mod tests {
    #[test]
    fn a_unit_test() { assert_eq!(1 + 1, 2); }
}
RS
  cat > "$f/server-rust/crates/foo/tests/iso_pg.rs" <<'RS'
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn an_ignored_pg_test() { assert!(true); }
RS
  cat > "$f/packages/momo-core/src/x.test.ts" <<'TS'
describe('x', () => {
  it("refuses the bad thing", () => { expect(1).toBe(1); });
  it.skip("a skipped one", () => {});
});
TS
  printf '#!/bin/sh\nexit 0\n' > "$f/scripts/gate.sh"
  printf '#!/bin/sh\nexit 0\n' > "$f/scripts/tests/test_control.sh"
  printf 'tenant-isolation foo iso_pg\n' > "$f/infra/security-pack/selection.txt"
  printf 'name: pr-ci\njobs:\n  x:\n    steps:\n      - run: scripts/gate.sh\n      - run: scripts/tests/test_control.sh\n      # scripts/only_in_comment.sh\n' > "$f/.github/workflows/pr-ci.yml"
  printf 'name: nightly\n' > "$f/.github/workflows/security-nightly.yml"
  printf '#!/bin/sh\nscripts/local_only.sh\n' > "$f/scripts/local_gate.sh"
  printf '#!/bin/sh\n' > "$f/scripts/local_only.sh"; printf '#!/bin/sh\n' > "$f/scripts/only_in_comment.sh"
  printf -- '- <!-- limit:LIM-1 -->**Not end-to-end encrypted.** The server reads message content.\n' > "$f/SECURITY.md"
  cat > "$f/docs/security/claims.yaml" <<'Y'
version: 1
claims:
  - id: T-1
    claim: "A unit test proves this claim in PR CI."
    scope: "Fixture claim, unit test, pr-ci lane."
    priority: P0
    runs: pr-ci
    proofs:
      - "server-rust/crates/foo/src/lib.rs#a_unit_test"
    sabotage:
      how: "Break the assertion and the unit test goes red."
      evidence: "scripts/tests/test_control.sh"
  - id: T-2
    claim: "An ignored PG test in the Security pack selection proves this."
    scope: "Fixture claim, selected PG target, pr-ci lane."
    priority: P1
    runs: pr-ci
    proofs:
      - "server-rust/crates/foo/tests/iso_pg.rs#an_ignored_pg_test"
  - id: T-3
    claim: "A vitest title and a wired script prove this claim."
    scope: "Fixture claim, TS test and script, pr-ci lane."
    priority: P1
    runs: pr-ci
    proofs:
      - "packages/momo-core/src/x.test.ts::refuses the bad thing"
      - "script:scripts/gate.sh"
  - id: T-4
    claim: "A local-only script proves this claim, honestly labelled local."
    scope: "Fixture claim, local lane."
    priority: P1
    runs: local
    proofs:
      - "script:scripts/local_only.sh"
limits:
  - id: LIM-1
    text: "Not end-to-end encrypted."
    docs:
      - "SECURITY.md"
Y
}
expect() { # name want needle [extra gate args...]
  local name="$1" want="$2" needle="$3"; shift 3
  local out rc
  out="$(python3 "$GATE" --root "$T/f" --require-limits LIM-1 "$@" 2>&1)"; rc=$?
  if [ "$rc" -ne "$want" ] || { [ -n "$needle" ] && ! grep -qF -- "$needle" <<<"$out"; }; then
    echo "FAIL $name (rc=$rc, wanted $want, needle: ${needle:-none})"; echo "$out" | sed 's/^/    /'; fail=1
  else echo "ok   $name"; fi
}
ed() { python3 - "$@" <<'P'
import sys
f,old,new=sys.argv[1:4]
s=open(f).read()
assert old in s,(f,old)
open(f,'w').write(s.replace(old,new,1))
P
}
C() { echo "$T/f/docs/security/claims.yaml"; }

fresh; expect "fixture green baseline" 0 "green: 4 claims"

# --- the four required reds, one sabotage each ---
fresh; ed "$(C)" $'    proofs:\n      - "server-rust/crates/foo/tests/iso_pg.rs#an_ignored_pg_test"\n' $'    proofs: []\n'
expect "E1 claim without any proof" 1 "E1 T-2"
fresh; ed "$(C)" "#a_unit_test" "#a_test_that_does_not_exist"
expect "E2 selector matches no test" 1 "E2 T-1"
fresh; printf '' > "$T/f/infra/security-pack/selection.txt"
expect "E3 pr-ci claim whose ignored PG test left the selection" 1 "E3 T-2"
fresh; ed "$(C)" $'    sabotage:\n      how: "Break the assertion and the unit test goes red."\n      evidence: "scripts/tests/test_control.sh"\n' ''
expect "E4 P0 claim without sabotage evidence" 1 "E4 T-1"

# --- spoofs the lint must not accept ---
fresh; ed "$(C)" "#a_unit_test" "#the_commented_test_name_is_not_a_test"
expect "E2 a comment that only names the test" 1 "E2 T-1"
fresh; ed "$(C)" "#a_unit_test" "#a_helper_that_is_not_a_test"
expect "E2 a real fn that is not a #[test]" 1 "E2 T-1"
fresh; ed "$(C)" "::refuses the bad thing" "::refuses the bad"
expect "E2 a title that is only a substring" 1 "E2 T-3"
fresh; ed "$(C)" "::refuses the bad thing" "::a skipped one"
expect "E2 a skipped TS test" 1 "E2 T-3"
fresh; ed "$(C)" "script:scripts/gate.sh" "script:scripts/only_in_comment.sh"
expect "E2 a script named only in a pr-ci.yml comment" 1 "E2 T-3"
fresh; ed "$(C)" $'runs: pr-ci\n    proofs:\n      - "script:scripts/gate.sh"' $'runs: pr-ci\n    proofs:\n      - "script:scripts/local_only.sh"' 2>/dev/null || ed "$(C)" '"script:scripts/gate.sh"' '"script:scripts/local_only.sh"'
expect "E3 runs: pr-ci but the script is local_gate only" 1 "E3 T-3"
fresh; ed "$(C)" "scripts/tests/test_control.sh" "scripts/tests/no_such_control.sh"
expect "E4 sabotage evidence path does not exist" 1 "E4 T-1"
fresh; printf 'nothing here\n' > "$T/f/SECURITY.md"
expect "E5 limit marker missing from the document" 1 "E5 LIM-1"
fresh; ed "$(C)" "id: T-2" "id: T-1"
expect "E0 duplicate id" 1 "E0 T-1: duplicate id"
fresh; ed "$(C)" "priority: P1
    runs: pr-ci
    proofs:
      - \"server-rust/crates/foo/tests" "priority: P2
    runs: pr-ci
    proofs:
      - \"server-rust/crates/foo/tests"
expect "E0 unknown priority" 1 "E0 T-2: priority"

# --- review r1 (#4224): spoofs and holes the first lint let through ---
RS="$T/f/server-rust/crates/foo/src/lib.rs"
TSF="$T/f/packages/momo-core/src/x.test.ts"
fresh; printf '/* #[test]\nfn ghost() {} */\n' >> "$RS"; ed "$(C)" "#a_unit_test" "#ghost"
expect "E2 a test that exists only in a block comment" 1 "E2 T-1"
fresh; printf 'const S: &str = r#"\n#[test]\nfn ghost() {}\n"#;\n' >> "$RS"; ed "$(C)" "#a_unit_test" "#ghost"
expect "E2 a test that exists only inside a raw string" 1 "E2 T-1"
fresh; printf '#[cfg(any())]\n#[test]\nfn ghost() {}\n' >> "$RS"; ed "$(C)" "#a_unit_test" "#ghost"
expect "E2 a test compiled out by cfg(any())" 1 "E2 T-1"
fresh; printf '#[cfg(feature = "never")]\n#[test]\nfn ghost() {}\n' >> "$RS"; ed "$(C)" "#a_unit_test" "#ghost"
expect "E2 a test behind a never-enabled feature" 1 "E2 T-1"
fresh; printf '// it("ghost", () => {});\n' >> "$TSF"; ed "$(C)" "::refuses the bad thing" "::ghost"
expect "E2 a TS test that is only a // comment" 1 "E2 T-3"
fresh; printf '/* it("ghost", () => {}); */\n' >> "$TSF"; ed "$(C)" "::refuses the bad thing" "::ghost"
expect "E2 a TS test that is only a block comment" 1 "E2 T-3"
fresh; printf 'const s = `it("ghost", () => {})`;\n' >> "$TSF"; ed "$(C)" "::refuses the bad thing" "::ghost"
expect "E2 a TS test that is only inside a string" 1 "E2 T-3"
fresh; printf 'describe.skip("off", () => { it("ghost", () => {}); });\n' >> "$TSF"; ed "$(C)" "::refuses the bad thing" "::ghost"
expect "E2 a TS test inside describe.skip" 1 "E2 T-3"
fresh; ed "$(C)" "scripts/tests/test_control.sh" "SECURITY.md"
expect "E4 sabotage evidence that is just any file" 1 "E4 T-1"
fresh; ed "$(C)" "scripts/tests/test_control.sh" "server-rust/crates/foo/src/lib.rs#a_unit_test"
expect "E4 sabotage evidence selector not named like a negative control" 1 "E4 T-1"
fresh; printf 'name: pr-ci\njobs:\n  x:\n    steps:\n      - run: scripts/gate.sh\n' > "$T/f/.github/workflows/pr-ci.yml"; printf '#!/bin/sh\nscripts/tests/test_control.sh\n' >> "$T/f/scripts/local_gate.sh"
expect "E4 sabotage evidence weaker than the claim's lane" 1 "only runs in the local lane"
fresh; ed "$(C)" "script:scripts/gate.sh" "script:scripts/gate.sh.bak"; printf '#!/bin/sh\n' > "$T/f/scripts/gate.sh.bak"
expect "E2 a suffix of an invoked script name is not an invocation" 1 "E2 T-3"
fresh; python3 - "$(C)" <<'P'
import sys
p=sys.argv[1]; s=open(p).read(); i=s.index("limits:")
open(p,"w").write(s[:i])
P
expect "E5 the limits section deleted" 1 "E5 required limit LIM-1"
fresh; ed "$(C)" "limits:" "limitz:"
expect "E0 a typo'd top-level key" 1 "E0 unknown top-level key"
fresh; printf -- '- <!-- limit:LIM-1 -->\n' > "$T/f/SECURITY.md"
expect "E5 the marker left behind without its sentence" 1 "without a sentence"
fresh; printf '```\n<!-- limit:LIM-1 -->\n```\n' > "$T/f/SECURITY.md"
expect "E5 the marker only inside a code block" 1 "code block"
fresh; ed "$(C)" "priority: P1
    runs: local" "priority: P1
    priority: P0
    runs: local"
expect "E0 a duplicate yaml key (PyYAML would keep the last silently)" 1 "duplicate key"
fresh; ed "$(C)" "server-rust/crates/foo/src/lib.rs#a_unit_test" "server-rust/crates/foo/../foo/src/lib.rs#a_unit_test"
expect "green: a ../ path is normalised, not misjudged" 0 "green"

# --- the honest limit: the lint checks that a test exists and where it runs, not what it asserts ---
fresh; ed "$T/f/server-rust/crates/foo/src/lib.rs" "assert_eq!(1 + 1, 2);" ""
expect "LIMIT gutted test body stays green (P0 sabotage evidence, not this lint, covers it)" 0 "green"
# but deleting the proving fn itself is red
fresh; ed "$T/f/server-rust/crates/foo/src/lib.rs" "fn a_unit_test() { assert_eq!(1 + 1, 2); }" ""
expect "E2 the proving fn deleted" 1 "E2 T-1"
# the no-PyYAML fallback parser reads the same fixture
fresh
out="$(python3 -c "
import sys, runpy
sys.modules['yaml'] = None
sys.argv = ['$GATE', '--root', '$T/f', '--require-limits', 'LIM-1']
runpy.run_path('$GATE', run_name='__main__')" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -qF "green: 4 claims" <<<"$out"; then echo "ok   fallback parser (no PyYAML) green"; else echo "FAIL fallback parser rc=$rc"; echo "$out"; fail=1; fi

# --- the real tree ---
out="$(python3 "$GATE" --root "$ROOT" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "green:" <<<"$out"; then echo "ok   real tree green"; else echo "FAIL real tree rc=$rc"; echo "$out"|tail -5; fail=1; fi
cp "$ROOT/infra/security-pack/selection.txt" "$T/sel.txt"; sed -i.bak '/momo-db tenant_catalog_pg/d' "$T/sel.txt"
out="$(python3 "$GATE" --root "$ROOT" --selection "$T/sel.txt" 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && grep -qF "E3 TEN-1" <<<"$out"; then echo "ok   real tree: tenant_catalog_pg out of the Security pack -> TEN-1 red"; else echo "FAIL real selection sabotage rc=$rc"; echo "$out"|tail -3; fail=1; fi
cp "$ROOT/docs/security/claims.yaml" "$T/claims.yaml"
python3 - "$T/claims.yaml" <<'P'
import sys
p=sys.argv[1]; s=open(p).read()
old='      evidence: "server-rust/crates/momo-db/tests/tenant_catalog_pg.rs#control_force_missing_is_red"'
assert old in s
open(p,'w').write(s.replace(old,'      evidence: "server-rust/crates/momo-db/tests/tenant_catalog_pg.rs#control_renamed_away"',1))
P
out="$(python3 "$GATE" --root "$ROOT" --claims "$T/claims.yaml" 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && grep -qF "E4 TEN-1" <<<"$out"; then echo "ok   real tree: TEN-1 sabotage control renamed away -> red"; else echo "FAIL real claims sabotage rc=$rc"; echo "$out"|tail -3; fail=1; fi

python3 - "$T/claims.yaml" "$ROOT/docs/security/claims.yaml" <<'P'
import sys
s=open(sys.argv[2]).read(); i=s.index("\nlimits:")
open(sys.argv[1],'w').write(s[:i]+"\n")
P
out="$(python3 "$GATE" --root "$ROOT" --claims "$T/claims.yaml" 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && grep -qF "E5 required limit LIM-1" <<<"$out"; then echo "ok   real tree: limits section deleted -> red"; else echo "FAIL real limits sabotage rc=$rc"; echo "$out"|tail -3; fail=1; fi

[ "$fail" -eq 0 ] && echo "security claims lint: all red proofs hold" || { echo "security claims lint regression FAILED"; exit 1; }
