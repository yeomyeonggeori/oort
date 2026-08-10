#!/usr/bin/env bash
# cargo dependency license gate (#1225).
#
# Runs `cargo deny check licenses` against every cargo workspace in the repo with
# the single root policy file (deny.toml). Bash 3.2 compatible.
#
# Why a wrapper instead of calling cargo-deny directly from the gate:
#   1. deny.toml lives at the repository root and covers two workspaces, so every
#      invocation needs --manifest-path + --config. Encoding that once here keeps
#      the two callers (scripts/local_gate.sh, CONTRIBUTING) from drifting.
#   2. cargo-deny is not part of a default Rust toolchain. Without an explicit
#      check, a missing binary reads as "command not found" and the honest
#      failure ("this machine cannot run the license gate") is lost.
#
# Usage: scripts/check_cargo_licenses.sh [--offline]
#
#   --offline   Pass --offline to cargo-deny. Fails instead of downloading a
#               crate that is missing from the local registry cache.
#
# Environment (test/fixture use only):
#   CARGO_LICENSE_REPO_ROOT    Repository root override.
#   CARGO_LICENSE_CONFIG       deny.toml path override (default: <root>/deny.toml).
#   CARGO_LICENSE_WORKSPACES   Space-separated workspace dirs to check.
set -euo pipefail

OFFLINE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE="--offline"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "${CARGO_LICENSE_REPO_ROOT:-}" ]; then
  REPO_ROOT="$CARGO_LICENSE_REPO_ROOT"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "CARGO LICENSE FAIL: run inside a git repository" >&2
    exit 1
  }
fi
cd "$REPO_ROOT"

CONFIG="${CARGO_LICENSE_CONFIG:-deny.toml}"
# server-rust is the live backbone; the Tauri shell is the second cargo graph
# that ships to users (ADR-0133) and is where every MPL-2.0 crate actually is,
# so leaving it out would gate the half that has no policy question in it.
WORKSPACES="${CARGO_LICENSE_WORKSPACES:-server-rust clients/desktop/src-tauri}"

[ -f "$CONFIG" ] || {
  echo "CARGO LICENSE FAIL: missing license policy: $CONFIG" >&2
  exit 1
}

if ! command -v cargo >/dev/null 2>&1; then
  echo "CARGO LICENSE FAIL: cargo is not installed (https://rustup.rs)" >&2
  exit 1
fi

if ! cargo deny --version >/dev/null 2>&1; then
  cat >&2 <<'EOF'
CARGO LICENSE FAIL: cargo-deny is not installed.

  Install it, then re-run this gate:

    cargo install --locked cargo-deny      # ~2-4 min from source
    # or: brew install cargo-deny
    # or: cargo binstall cargo-deny        # prebuilt, seconds

  The gate is fail-closed on purpose: skipping it when the tool is absent would
  print a green that proves nothing about dependency licenses.
EOF
  exit 1
fi

echo "cargo license gate: $(cargo deny --version) · policy $CONFIG"

failed=0
for workspace in $WORKSPACES; do
  manifest="$workspace/Cargo.toml"
  if [ ! -f "$manifest" ]; then
    echo "CARGO LICENSE FAIL: missing cargo workspace manifest: $manifest" >&2
    exit 1
  fi
  echo "==> cargo deny check licenses ($workspace)"
  # shellcheck disable=SC2086
  if ! cargo deny --manifest-path "$manifest" --config "$CONFIG" $OFFLINE check licenses; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "CARGO LICENSE FAIL: see the cargo-deny output above. Add the SPDX id to" >&2
  echo "  $CONFIG with a comment naming the crate and why it is compatible," >&2
  echo "  or replace the dependency. Do not widen the allowlist silently." >&2
  exit 1
fi

echo "CARGO LICENSE PASS: all cargo workspaces satisfy $CONFIG"
