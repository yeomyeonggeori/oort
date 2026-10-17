#!/usr/bin/env bash
# Compile the UIKit-free half of MomoPushActionNative (#3931) with main.swift and
# run it. Checks the idempotency key (against vectors computed independently),
# the payload and credential readers, the request, the answer's reading, the
# sentences, the whole decision with a faked keychain and network, and the
# background-time job (begin before the request, one result line, one end of the
# task) with a recorded UIApplication and notification centre. Compiler warnings
# fail the run.
#
#   bash modules/momo-push-action-native/sim-check/run.sh                # on this Mac
#   bash modules/momo-push-action-native/sim-check/run.sh <simulator-udid>   # in a booted simulator
#
# With a UDID the caller owns the simulator (boot/delete); this script only
# spawns. Nothing here needs the simulator, so the Mac run is the everyday one
# and the simulator run is the proof that the same code behaves the same on the
# iOS SDK.
set -euo pipefail
UDID="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t momo-push-action-sim-check)"
trap 'rm -rf "$OUT"' EXIT
SOURCES=(
  "$HERE/../ios/MomoPushActionCore.swift"
  "$HERE/../ios/MomoPushActionDecisionKey.swift"
  "$HERE/../ios/MomoPushActionKeychain.swift"
  "$HERE/../ios/MomoPushActionJob.swift"
  "$HERE/../../../ios/MomoPushKit/PushNotification.swift"
  "$HERE/main.swift"
)
if [ -z "$UDID" ]; then
  xcrun --sdk macosx swiftc -O -warnings-as-errors -o "$OUT/push-action-sim-check" "${SOURCES[@]}"
  [ -x "$OUT/push-action-sim-check" ] || { echo "error: compile failed" >&2; exit 1; }
  "$OUT/push-action-sim-check"
else
  SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
  ARCH="$(uname -m)"
  xcrun --sdk iphonesimulator swiftc -O -warnings-as-errors \
    -target "${ARCH}-apple-ios16.4-simulator" -sdk "$SDK" \
    -o "$OUT/push-action-sim-check" "${SOURCES[@]}"
  [ -x "$OUT/push-action-sim-check" ] || { echo "error: compile failed" >&2; exit 1; }
  xcrun simctl spawn "$UDID" "$OUT/push-action-sim-check"
fi
