#!/usr/bin/env bash
# Red-proof regression for scripts/check_unsafe_policy.py (SEC-08, #4246).
# Works on a copy of the Cargo.toml tree + allowlist, so it needs no compiler.
# Every red case is a one-line sabotage of a green tree; the green baseline runs
# first so a red can only come from the sabotage. The compiler half of the policy
# (an `unsafe` block in an inheriting crate fails the build) is proven by
# scripts/tests/test_unsafe_policy_gate.sh --compile, which needs cargo.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$ROOT/scripts/check_unsafe_policy.py"
T="$(mktemp -d "${TMPDIR:-/tmp}/unsafe-policy.XXXXXX")"
trap 'rm -rf "$T"' EXIT
fail=0

fresh() {
  rm -rf "$T/t"; mkdir -p "$T/t/server-rust"
  (cd "$ROOT" && git ls-files 'server-rust/Cargo.toml' 'server-rust/crates/*/Cargo.toml' 'server-rust/bins/*/Cargo.toml' 'server-rust/unsafe-allowlist.tsv' 'clients/desktop/src-tauri/Cargo.toml' \
    | while read -r f; do mkdir -p "$T/t/$(dirname "$f")"; cp "$f" "$T/t/$f"; done)
}
expect() { # name want(0|1) needle
  local out rc
  out="$(python3 "$GATE" --root "$T/t" 2>&1)"; rc=$?
  if [ "$rc" -ne "$2" ] || { [ -n "${3:-}" ] && ! grep -qF -- "$3" <<<"$out"; }; then
    echo "FAIL $1 (rc=$rc, wanted $2, needle: ${3:-none})"; echo "$out" | sed 's/^/    /'; fail=1
  else echo "ok   $1"; fi
}
ed() { python3 - "$@" <<'P'
import sys
f,old,new=sys.argv[1:4]
s=open(f).read()
assert old in s,(f,old)
open(f,'w').write(s.replace(old,new,1))
P
}

fresh; expect "green baseline" 0 "green"
fresh; ed "$T/t/server-rust/crates/momo-wire/Cargo.toml" $'[lints]\nworkspace = true\n' ''; expect "crate drops [lints] workspace" 1 "momo-wire: no [lints] workspace = true"
fresh; ed "$T/t/server-rust/Cargo.toml" 'unsafe_code = "forbid"' 'unsafe_code = "deny"'; expect "workspace forbid weakened to deny" 1 'must be "forbid"'
fresh; ed "$T/t/server-rust/crates/momo-wire/Cargo.toml" $'[lints]\nworkspace = true\n' $'[lints.rust]\nunsafe_code = "allow"\n'; expect "crate self-allows without allowlist row" 1 "momo-wire: sets unsafe_code = 'allow'"
fresh; ed "$T/t/server-rust/bins/momo-workd/Cargo.toml" 'unsafe_code = "allow"' 'unsafe_code = "forbid"'; expect "allowlisted crate actually forbids (stale row)" 1 "momo-workd: allowlisted but"
fresh; sed -i.bak '/momo-embed/d' "$T/t/server-rust/unsafe-allowlist.tsv"; expect "allowlist row removed while crate still allows" 1 "momo-embed: sets unsafe_code = 'allow'"
fresh; printf 'server-rust/crates/momo-wire\tshort\n' >> "$T/t/server-rust/unsafe-allowlist.tsv"; expect "allowlist row with empty-ish reason" 1 "needs a real reason"
fresh; printf 'server-rust/crates/momo-nope\tthis crate does not exist but has a long reason\n' >> "$T/t/server-rust/unsafe-allowlist.tsv"; expect "allowlist row for missing crate" 1 "momo-nope has no Cargo.toml"
fresh; mkdir -p "$T/t/server-rust/crates/momo-newcrate"; printf '[package]\nname = "momo-newcrate"\nversion = "0.0.0"\n' > "$T/t/server-rust/crates/momo-newcrate/Cargo.toml"; expect "new crate without lints" 1 "momo-newcrate: no [lints] workspace = true"
fresh; ed "$T/t/server-rust/Cargo.toml" 'members = ["crates/*", "bins/*"]' 'members = ["crates/*", "bins/*", "tools/*"]'; expect "workspace gains a member dir the gate cannot see" 1 "workspace members must be exactly"
fresh; rm "$T/t/server-rust/unsafe-allowlist.tsv"; expect "allowlist file deleted" 1 "unsafe-allowlist.tsv is missing"

if [ "${1:-}" = "--compile" ]; then
  # Real compiler proof against a scratch copy of the workspace: an `unsafe` block in an
  # inheriting crate must not build, and `#![allow(unsafe_code)]` must not rescue it.
  command -v cargo >/dev/null || { echo "FAIL --compile needs cargo"; exit 1; }
  rm -rf "$T/ws"; mkdir -p "$T/ws"; (cd "$ROOT" && git ls-files server-rust | tar -cf - -T -) | tar -xf - -C "$T/ws"
  cp "$ROOT/server-rust/Cargo.lock" "$T/ws/server-rust/" 2>/dev/null || true
  cd "$T/ws/server-rust" || exit 1
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$T/target}" CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
  printf '\npub fn sabotage() -> u8 { unsafe { std::mem::zeroed() } }\n' >> crates/momo-wire/src/lib.rs
  if cargo check -p momo-wire --offline >"$T/c1.log" 2>&1; then echo "FAIL unsafe block compiled in an inheriting crate"; fail=1
  elif grep -q 'usage of an `unsafe` block' "$T/c1.log"; then echo "ok   compiler rejects unsafe in inheriting crate"
  else echo "FAIL cargo failed for another reason"; tail -5 "$T/c1.log"; fail=1; fi
  python3 -c "p='crates/momo-wire/src/lib.rs';s=open(p).read();open(p,'w').write('#![allow(unsafe_code)]\\n'+s)"
  if cargo check -p momo-wire --offline >"$T/c2.log" 2>&1; then echo "FAIL #![allow(unsafe_code)] rescued a forbidden crate"; fail=1
  elif grep -q 'incompatible with previous forbid' "$T/c2.log"; then echo "ok   #![allow(unsafe_code)] cannot override forbid"
  else echo "FAIL cargo failed for another reason"; tail -5 "$T/c2.log"; fail=1; fi
fi
[ "$fail" -eq 0 ] && echo "unsafe policy gate regression: all red proofs hold"
exit "$fail"
