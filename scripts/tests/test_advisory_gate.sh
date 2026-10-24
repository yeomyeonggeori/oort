#!/usr/bin/env bash
# Sabotage proof for the dependency advisory gate (#4243, SEC-05).
#
# A gate that cannot fail is worse than no gate, so every assertion below feeds the gate
# input that MUST turn it red and checks the failure reason, and each green case has a red
# twin:
#   default      offline ledger cases: expired / undated / too-far / reasonless exceptions.
#   --online     scanner negative controls against fixture lockfiles pinned to versions with
#                permanent advisories (smallvec 1.6.0 = RUSTSEC-2021-0003, lodash 4.17.20,
#                jsonwebtoken 9.3.1 = GHSA-h395-gr6q-cpjc). Needs cargo-deny, osv-scanner, npm
#                and network; CI runs this inside the `advisories` lane right after the real
#                scan, so a scanner that went blind (empty database, wrong path) fails the lane.
# The fixtures are stored as `*.fixture` so GitHub's dependency graph / Dependabot never
# parse them as real manifests; the test copies them to temp dirs under their real names.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check_advisories.py"
FX="$SCRIPT_DIR/fixtures/advisories"
ONLINE=0
[ "${1:-}" = "--online" ] && ONLINE=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASSED=0

fail() { echo "[advisory-gate-test] FAIL: $*" >&2; exit 1; }

# expect <pass|fail> <name> <pattern-in-output> -- <gate args...>
expect() {
  local want="$1" name="$2" pattern="$3"
  shift 4
  local rc=0
  python3 "$GATE" "$@" >"$TMP/out" 2>&1 || rc=$?
  if [ "$want" = pass ] && [ "$rc" -ne 0 ]; then
    cat "$TMP/out" >&2; fail "$name: gate went red (exit $rc), expected green"
  fi
  if [ "$want" = fail ] && [ "$rc" -ne 1 ]; then
    cat "$TMP/out" >&2; fail "$name: gate exit $rc, expected 1 (accepted the sabotage)"
  fi
  if [ -n "$pattern" ] && ! grep -Fq -- "$pattern" "$TMP/out"; then
    cat "$TMP/out" >&2; fail "$name: output lacks '$pattern'"
  fi
  PASSED=$((PASSED + 1))
  echo "ok   $name"
}

write_deny() { printf '[advisories]\nignore = [\n  %s\n]\n' "$1" >"$TMP/deny.toml"; }
write_osv() { printf '%s\n' "$1" >"$TMP/osv.toml"; }
LEDGER=(--only ledger --today 2026-10-24 --deny-config "$TMP/deny.toml" --osv-config "$TMP/osv.toml")
OK_DENY='{ id = "RUSTSEC-2099-0001", reason = "fixture exception for the ledger test; expires=2026-12-31" },'
OK_OSV=$'[[IgnoredVulns]]\nid = "GHSA-xxxx-xxxx-xxxx"\nignoreUntil = 2026-12-31\nreason = "fixture exception for the ledger test"'

# ---- the real ledger -------------------------------------------------------
expect pass "real ledger is valid today" "ADVISORY GATE PASS" -- --only ledger
expect fail "real ledger: paste exception expires 2026-12-31 -> red that day" "EXPIRED 2026-12-31" -- --only ledger --today 2026-12-31
expect fail "real ledger: every OSV exception is red on 2027-01-22" "osv-scanner.toml GHSA-5xrq-8626-4rwp: EXPIRED 2027-01-22" -- --only ledger --today 2027-01-22

# ---- ledger rules, each with a green control --------------------------------
write_deny "$OK_DENY"; write_osv "$OK_OSV"
expect pass "control: dated exception with reason" "2 exceptions" -- "${LEDGER[@]}"

write_deny '{ id = "RUSTSEC-2099-0001", reason = "fixture exception for the ledger test; expires=2026-10-24" },'
expect fail "deny.toml exception on its first red day" "EXPIRED 2026-10-24" -- "${LEDGER[@]}"

write_deny '{ id = "RUSTSEC-2099-0001", reason = "fixture exception for the ledger test; expires=2028-01-01" },'
expect fail "deny.toml exception more than 180 days out" "more than 180 days out" -- "${LEDGER[@]}"

write_deny '{ id = "RUSTSEC-2099-0001", reason = "fixture exception for the ledger test, no date given" },'
expect fail "deny.toml exception without expires=" "expiry missing" -- "${LEDGER[@]}"

write_deny '{ id = "RUSTSEC-2099-0001", reason = "x expires=2026-12-31" },'
expect fail "deny.toml exception with a token reason" "needs a real reason" -- "${LEDGER[@]}"

write_deny '"RUSTSEC-2099-0001",'
expect fail "deny.toml bare-string exception" "bare string has no reason or expiry" -- "${LEDGER[@]}"

write_deny "$OK_DENY"$'\n  '"$OK_DENY"
expect fail "deny.toml duplicate id" "listed twice" -- "${LEDGER[@]}"

write_osv $'[[IgnoredVulns]]\nid = "GHSA-xxxx-xxxx-xxxx"\nignoreUntil = 2026-10-24\nreason = "fixture exception for the ledger test"'
expect fail "osv exception on its first red day" "EXPIRED 2026-10-24" -- "${LEDGER[@]}"

write_osv $'[[IgnoredVulns]]\nid = "GHSA-xxxx-xxxx-xxxx"\nreason = "fixture exception for the ledger test"'
expect fail "osv exception without ignoreUntil" "expiry missing" -- "${LEDGER[@]}"

write_osv $'[[IgnoredVulns]]\nid = "GHSA-xxxx-xxxx-xxxx"\nignoreUntil = 2026-12-31'
expect fail "osv exception without reason" "needs a real reason" -- "${LEDGER[@]}"

write_osv $'[[PackageOverrides]]\nname = "vitest"\necosystem = "npm"\nignore = true\neffectiveUntil = 2026-12-31\nreason = "package-wide ignore must be refused"'
expect fail "osv package-wide ignore" "package-wide ignore" -- "${LEDGER[@]}"

if [ "$ONLINE" -ne 1 ]; then
  echo "advisory-gate-test: $PASSED offline assertions passed (run with --online for the scanner negative controls)"
  exit 0
fi

# ---- scanner negative controls (network) -----------------------------------
mkdir -p "$TMP/cargo/src" "$TMP/npm" "$TMP/lock-jwt" "$TMP/lock-smallvec"
cp "$FX/smallvec-1.6.0.Cargo.toml.fixture" "$TMP/cargo/Cargo.toml"
cp "$FX/smallvec-1.6.0.Cargo.lock.fixture" "$TMP/cargo/Cargo.lock"
: >"$TMP/cargo/src/lib.rs"
cp "$FX/lodash-4.17.20.package.json.fixture" "$TMP/npm/package.json"
cp "$FX/lodash-4.17.20.package-lock.json.fixture" "$TMP/npm/package-lock.json"
# OSV recognises a lockfile by its exact base name, so each one gets its own directory.
cp "$FX/jsonwebtoken-9.3.1.Cargo.lock.fixture" "$TMP/lock-jwt/Cargo.lock"
cp "$FX/smallvec-1.6.0.Cargo.lock.fixture" "$TMP/lock-smallvec/Cargo.lock"
printf '[advisories]\nignore = []\n' >"$TMP/deny-empty.toml"
printf '# no exceptions\n' >"$TMP/osv-empty.toml"

expect fail "cargo deny: smallvec 1.6.0 fixture is red" "RUSTSEC-2021-0003" -- \
  --only cargo --root "$TMP/cargo" --cargo-workspace . --deny-config "$TMP/deny-empty.toml"
write_deny '{ id = "RUSTSEC-2021-0003", reason = "fixture: proves a dated exception is honoured; expires=2026-12-31" },'
expect pass "cargo deny: the same fixture is green with a dated exception" "PASS ." -- \
  --only cargo --root "$TMP/cargo" --cargo-workspace . --deny-config "$TMP/deny.toml"

expect fail "npm audit: lodash 4.17.20 fixture is red" "FAIL ." -- --only npm --root "$TMP/npm" --npm-tree .
expect fail "osv: lodash 4.17.20 fixture is red" "lodash@4.17.20" -- \
  --only osv --root "$TMP/npm" --osv-lockfile package-lock.json --osv-config "$TMP/osv-empty.toml"
expect pass "osv: a RUSTSEC-only crates.io finding is delegated to cargo deny" "judged by cargo deny" -- \
  --only osv --root "$TMP/lock-smallvec" --osv-lockfile Cargo.lock --osv-config "$TMP/osv-empty.toml"
expect fail "osv: a GHSA-only crates.io finding (jsonwebtoken 9.3.1) is red" "jsonwebtoken@9.3.1" -- \
  --only osv --root "$TMP/lock-jwt" --osv-lockfile Cargo.lock --osv-config "$TMP/osv-empty.toml"

write_osv $'[[IgnoredVulns]]\nid = "GHSA-h395-gr6q-cpjc"\nignoreUntil = 2020-01-01\nreason = "expired fixture exception, OSV must stop honouring it"'
expect fail "osv: an EXPIRED exception stops hiding the advisory" "jsonwebtoken@9.3.1" -- \
  --only osv --root "$TMP/lock-jwt" --osv-lockfile Cargo.lock --osv-config "$TMP/osv.toml"
write_osv $'[[IgnoredVulns]]\nid = "GHSA-h395-gr6q-cpjc"\nignoreUntil = 2099-01-01\nreason = "live fixture exception, OSV must honour it"'
expect pass "osv: a live exception hides exactly that advisory" "PASS" -- \
  --only osv --root "$TMP/lock-jwt" --osv-lockfile Cargo.lock --osv-config "$TMP/osv.toml"

echo "advisory-gate-test: $PASSED assertions passed (offline + online)"
