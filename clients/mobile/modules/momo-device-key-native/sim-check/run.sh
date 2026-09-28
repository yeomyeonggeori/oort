#!/usr/bin/env bash
# Compile MomoDeviceKeyStore.swift + main.swift for the iOS simulator and run it
# inside a booted simulator (#3026). Proves at runtime that a device without a
# Secure Enclave takes the explicit "unsupported" path with no software key.
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
xcrun --sdk iphonesimulator swiftc -O \
  -target "${ARCH}-apple-ios16.4-simulator" -sdk "$SDK" \
  -o "$OUT/device-key-sim-check" \
  "$HERE/../ios/MomoDeviceKeyStore.swift" "$HERE/main.swift" 2>&1 | grep -v 'warning:' || true
[ -x "$OUT/device-key-sim-check" ] || { echo "error: compile failed" >&2; exit 1; }
xcrun simctl spawn "$UDID" "$OUT/device-key-sim-check"
