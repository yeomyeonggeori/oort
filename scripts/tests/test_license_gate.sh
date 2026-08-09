#!/usr/bin/env bash
# Isolated regression for the #1225 dependency license gate.
#
# Green alone proves nothing about a gate: a gate that always passes is also
# green. Every case here either shows the gate turning RED for a reason we can
# name, or shows it reading the tree we think it reads. No Docker, no network
# (cargo runs --offline), no writes inside the repository.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-license-gate-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[license-gate-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[license-gate-test] ok: $*"; }

have_cargo_deny=0
if command -v cargo >/dev/null 2>&1 && cargo deny --version >/dev/null 2>&1; then
  have_cargo_deny=1
fi

# =============================================================================
# cargo side
# =============================================================================

# Case 1 — the missing-tool path is FAIL, not skip. A gate that quietly passes
# when its tool is absent is the failure mode this whole ticket exists to fix.
mkdir -p "$SANDBOX/nodeny"
real_cargo="$(command -v cargo || true)"
if [ -n "$real_cargo" ]; then
  cat >"$SANDBOX/nodeny/cargo" <<EOF
#!/bin/sh
if [ "\$1" = "deny" ]; then exit 127; fi
exec "$real_cargo" "\$@"
EOF
  chmod +x "$SANDBOX/nodeny/cargo"
  set +e
  out="$(PATH="$SANDBOX/nodeny:$PATH" scripts/check_cargo_licenses.sh --offline 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "cargo gate passed with cargo-deny unavailable"
  case "$out" in
    *"cargo-deny is not installed"*) ;;
    *) fail "missing cargo-deny did not print install guidance: $out" ;;
  esac
  pass "cargo gate fails closed with install guidance when cargo-deny is absent"
else
  echo "[license-gate-test] skip: cargo is not installed on this host"
fi

if [ "$have_cargo_deny" -eq 1 ]; then
  # Case 2 — green over both cargo workspaces with the real policy.
  scripts/check_cargo_licenses.sh --offline >"$SANDBOX/cargo-green.log" 2>&1 ||
    fail "cargo gate is red on the current tree: $(cat "$SANDBOX/cargo-green.log")"
  grep -q "clients/desktop/src-tauri" "$SANDBOX/cargo-green.log" ||
    fail "cargo gate did not check the desktop workspace"
  pass "cargo gate is green over server-rust and clients/desktop/src-tauri"

  # Case 3 — RED PROOF: inject a forbidden license onto a real crate. The
  # override is cargo-deny's own [[licenses.clarify]], so this exercises the
  # same code path a genuinely AGPL dependency would.
  cp deny.toml "$SANDBOX/deny-agpl.toml"
  cat >>"$SANDBOX/deny-agpl.toml" <<'EOF'

[[licenses.clarify]]
crate = "serde"
expression = "AGPL-3.0-only"
license-files = []
EOF
  set +e
  out="$(CARGO_LICENSE_CONFIG="$SANDBOX/deny-agpl.toml" \
    CARGO_LICENSE_WORKSPACES="server-rust" \
    scripts/check_cargo_licenses.sh --offline 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "cargo gate stayed green with an AGPL-3.0 crate injected"
  case "$out" in
    *"AGPL-3.0-only"*) ;;
    *) fail "cargo gate red output does not name the forbidden license: $out" ;;
  esac
  pass "cargo gate turns red on an injected AGPL-3.0-only crate (serde)"

  # Case 4 — RED PROOF: the MPL-2.0 allowance is load-bearing, and deleting it
  # is the documented way to reverse the policy decision. Removing that one line
  # must fail the desktop graph on the Servo CSS crates and nothing else.
  grep -v '^  "MPL-2.0",$' deny.toml >"$SANDBOX/deny-nompl.toml"
  cmp -s deny.toml "$SANDBOX/deny-nompl.toml" &&
    fail "could not remove the MPL-2.0 allowance from deny.toml (format changed?)"
  set +e
  out="$(CARGO_LICENSE_CONFIG="$SANDBOX/deny-nompl.toml" \
    CARGO_LICENSE_WORKSPACES="clients/desktop/src-tauri" \
    scripts/check_cargo_licenses.sh --offline 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "desktop workspace stayed green without the MPL-2.0 allowance"
  case "$out" in
    *cssparser*) ;;
    *) fail "MPL red proof did not name a known MPL crate: $out" ;;
  esac
  set +e
  CARGO_LICENSE_CONFIG="$SANDBOX/deny-nompl.toml" \
    CARGO_LICENSE_WORKSPACES="server-rust" \
    scripts/check_cargo_licenses.sh --offline >/dev/null 2>&1
  server_status=$?
  set -e
  [ "$server_status" -eq 0 ] ||
    fail "server-rust needs the MPL-2.0 allowance; the backbone is supposed to have zero MPL crates"
  pass "MPL-2.0 allowance is load-bearing for the desktop graph only (backbone has none)"
else
  echo "[license-gate-test] skip: cargo-deny is not installed; cargo cases not run"
fi

# =============================================================================
# npm side
# =============================================================================

# Case 5 — green over the canonical three roots.
node scripts/check_npm_licenses.mjs --report "$SANDBOX/npm-canonical.md" \
  >"$SANDBOX/npm-canonical.log" 2>&1 ||
  fail "npm gate is red on the canonical roots: $(cat "$SANDBOX/npm-canonical.log")"
pass "npm gate is green over . + clients/web + clients/mobile"

# Case 6 — RED PROOF (aim): the re-aimed gate reads the canonical trees, not
# clients/web-legacy. Sentinels are packages that exist in exactly one side:
#   lightningcss  — clients/web + clients/mobile only (and MPL-2.0, so it also
#                   proves the reviewed allowance is exercised)
#   @swc/core     — clients/web-legacy only (@vitejs/plugin-react-swc)
grep -q '| lightningcss |' "$SANDBOX/npm-canonical.md" ||
  fail "canonical inventory is missing lightningcss; the gate is not reading clients/web|mobile"
grep -q '| @swc/core |' "$SANDBOX/npm-canonical.md" &&
  fail "canonical inventory contains @swc/core; the gate is still reading clients/web-legacy"
node scripts/check_npm_licenses.mjs --root clients/web-legacy \
  --report "$SANDBOX/npm-legacy.md" >/dev/null 2>&1 ||
  fail "npm gate is red on clients/web-legacy"
grep -q '| @swc/core |' "$SANDBOX/npm-legacy.md" ||
  fail "clients/web-legacy inventory is missing its own @swc/core"
pass "npm gate reads the canonical trees (lightningcss present, web-legacy-only @swc/core absent)"

# Case 7 — RED PROOF: a forbidden license in a synthetic lockfile fails, and an
# OR expression with one allowed branch passes. The second half is the shape
# audit A predicted a name-matching gate would kill (node-forge:
# "(BSD-3-Clause OR GPL-2.0)", r-efi: "MIT OR Apache-2.0 OR LGPL-2.1-or-later").
make_lock() { # <dir> <license>
  mkdir -p "$1"
  cat >"$1/package-lock.json" <<EOF
{
  "name": "license-gate-fixture",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "license-gate-fixture", "version": "0.0.0" },
    "node_modules/fixture-pkg": { "version": "1.0.0", "license": "$2" }
  }
}
EOF
}

make_lock "$SANDBOX/agpl" "AGPL-3.0-only"
set +e
out="$(node scripts/check_npm_licenses.mjs --root "$SANDBOX/agpl" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "npm gate stayed green on an AGPL-3.0-only package"
case "$out" in
  *fixture-pkg*) ;;
  *) fail "npm red output does not name the offending package: $out" ;;
esac
pass "npm gate turns red on an AGPL-3.0-only package"

make_lock "$SANDBOX/dual" "(BSD-3-Clause OR GPL-2.0)"
node scripts/check_npm_licenses.mjs --root "$SANDBOX/dual" >/dev/null 2>&1 ||
  fail "npm gate rejected a dual license with a permissive branch (BSD-3-Clause OR GPL-2.0)"
pass "npm gate accepts an OR expression with a permissive branch, rejecting nothing usable"

make_lock "$SANDBOX/andexpr" "(MIT AND GPL-2.0)"
set +e
node scripts/check_npm_licenses.mjs --root "$SANDBOX/andexpr" >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 0 ] && fail "npm gate accepted an AND expression containing GPL-2.0"
pass "npm gate rejects an AND expression whose second half is copyleft"

# Case 8 — a first-party workspace package that loses its `license` field is a
# violation, not an invisible row. This is exactly what packages/momo-core
# looked like before this ticket.
mkdir -p "$SANDBOX/firstparty/packages/thing"
cat >"$SANDBOX/firstparty/packages/thing/package.json" <<'EOF'
{ "name": "@fixture/thing", "version": "0.0.0", "private": true }
EOF
cat >"$SANDBOX/firstparty/package-lock.json" <<'EOF'
{
  "name": "fixture-workspace",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "fixture-workspace", "version": "0.0.0" },
    "node_modules/@fixture/thing": { "resolved": "packages/thing", "link": true },
    "packages/thing": { "name": "@fixture/thing", "version": "0.0.0" }
  }
}
EOF
set +e
out="$(node scripts/check_npm_licenses.mjs --root "$SANDBOX/firstparty" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "npm gate ignored an unlicensed first-party workspace package"
case "$out" in
  *first-party*) ;;
  *) fail "npm gate did not report the offender as first-party: $out" ;;
esac
pass "npm gate reports an unlicensed first-party workspace package"

echo "[license-gate-test] PASS: $CASES cases"
