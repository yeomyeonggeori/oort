#!/usr/bin/env bash
# Compile MomoBackgroundTaskLedger.swift + main.swift for the iOS simulator and
# run it inside a booted simulator (#3098). Checks that a background task is
# ended exactly once whether the work finishes first or iOS's expiration
# handler does. Compiler warnings fail the run.
#
#   bash modules/momo-background-task-native/sim-check/run.sh <simulator-udid>
#
# The caller owns the simulator (boot/lock/delete); this script only spawns.
set -euo pipefail
UDID="${1:?usage: run.sh <booted-simulator-udid>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t momo-background-task-sim-check)"
trap 'rm -rf "$OUT"' EXIT
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
ARCH="$(uname -m)"
xcrun --sdk iphonesimulator swiftc -O -warnings-as-errors \
  -target "${ARCH}-apple-ios16.4-simulator" -sdk "$SDK" \
  -o "$OUT/background-task-sim-check" \
  "$HERE/../ios/MomoBackgroundTaskLedger.swift" "$HERE/main.swift"
[ -x "$OUT/background-task-sim-check" ] || { echo "error: compile failed" >&2; exit 1; }
xcrun simctl spawn "$UDID" "$OUT/background-task-sim-check"
