#!/usr/bin/env bash
# Compile MomoDeviceKeyStore.swift + main.swift for the iOS simulator and run it
# inside a booted simulator (#3026). Proves at runtime that a device without a
# Secure Enclave takes the explicit "unsupported" path with no software key,
# and runs the payload allowlist against the E1 signing vectors (fixture copy
# under __tests__/fixtures) plus the invalidated/biometry classification.
# Compiler warnings fail the run (review N-5): a deprecated-API warning must
# not hide behind a filter.
#
#   bash modules/momo-device-key-native/sim-check/run.sh <simulator-udid>
#
# The caller owns the simulator (boot/lock/delete); this script only spawns.
set -euo pipefail
UDID="${1:?usage: run.sh <booted-simulator-udid>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t momo-device-key-sim-check)"
trap 'rm -rf "$OUT"' EXIT
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
ARCH="$(uname -m)"
VECTORS="$HERE/../../../__tests__/fixtures/human-control-signing.vectors.json"
[ -f "$VECTORS" ] || { echo "error: missing $VECTORS" >&2; exit 1; }
REBIND="$HERE/../../../__tests__/fixtures/device-rebind.vector.json"
[ -f "$REBIND" ] || { echo "error: missing $REBIND" >&2; exit 1; }
xcrun --sdk iphonesimulator swiftc -O -warnings-as-errors \
  -target "${ARCH}-apple-ios16.4-simulator" -sdk "$SDK" \
  -o "$OUT/device-key-sim-check" \
  "$HERE/../ios/MomoDeviceKeyStore.swift" "$HERE/main.swift"
[ -x "$OUT/device-key-sim-check" ] || { echo "error: compile failed" >&2; exit 1; }
xcrun simctl spawn "$UDID" "$OUT/device-key-sim-check" "$VECTORS" "$REBIND"
