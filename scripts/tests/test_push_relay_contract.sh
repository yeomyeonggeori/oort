#!/usr/bin/env bash
# SH-10 / #1255 red proof: cargo conformance + byte-exact wire sabotage.
# Never contacts Apple. Fixtures are synthetic Ed25519 keys.
set -euo pipefail

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)"
cd "$REPO_ROOT"

fail() {
  printf '[test-push-relay-contract] FAIL %s\n' "$*" >&2
  exit 1
}

echo "[test-push-relay-contract] cargo test -p momo-push-relay"
cargo test --manifest-path server-rust/Cargo.toml -p momo-push-relay \
  -- --nocapture || fail "cargo test -p momo-push-relay"

echo "[test-push-relay-contract] scripts/verify_push_relay.sh (401 / 400 / 429 / replay / stub / boot)"
PUSH_RELAY_VERIFY_PORT="${PUSH_RELAY_VERIFY_PORT:-28197}" \
  scripts/verify_push_relay.sh || fail "verify_push_relay.sh"

echo "PASS: momo-push-relay contract (cargo + signed stub verifier; Apple never contacted)"
