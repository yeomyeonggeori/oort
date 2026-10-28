#!/usr/bin/env bash
# Compile the communication-notification presentation (#4316, ADR-0204 증보 5) with main.swift and run it:
# the App Group state (the two switches, the face cache, the channel names, the forgetting), the REST read's
# author and picture, the plan (what a notification says and whether it is dressed), the photo order
# (cache, one bounded read, a drawn initial) and the assembly of all of it. The files compiled are the very
# ones the notification extension and the app build:
#
#   modules/momo-push-native/ios/MomoPushPresentationStore.swift   (app pod AND extension)
#   ios/MomoPushKit/PushNotification.swift                         (extension)
#   ios/MomoPushKit/PushCommunication.swift                        (extension)
#
# Compiler warnings fail the run. The system's half (Intents, UserNotifications) cannot be built for macOS
# (`setImage(_:forParameterNamed:)` is unavailable there), so it is checked only in a simulator:
#
#   bash modules/momo-push-native/sim-check/run.sh                    # on this Mac (everything but Intents)
#   bash modules/momo-push-native/sim-check/run.sh <simulator-udid>   # inside a booted simulator: all of it
#
# With a UDID the caller owns the simulator (boot/delete); this script only spawns. The Mac run is the
# everyday one (`__tests__/pushContract.test.ts` runs it); the simulator run proves the intent itself.
set -euo pipefail
UDID="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t momo-push-presentation-sim-check)"
trap 'rm -rf "$OUT"' EXIT
SOURCES=(
  "$HERE/../ios/MomoPushPresentationStore.swift"
  "$HERE/../../../ios/MomoPushKit/PushNotification.swift"
  "$HERE/../../../ios/MomoPushKit/PushCommunication.swift"
  "$HERE/main.swift"
)
if [ -z "$UDID" ]; then
  xcrun --sdk macosx swiftc -O -warnings-as-errors -o "$OUT/push-presentation-sim-check" "${SOURCES[@]}"
  [ -x "$OUT/push-presentation-sim-check" ] || { echo "error: compile failed" >&2; exit 1; }
  "$OUT/push-presentation-sim-check"
else
  SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
  ARCH="$(uname -m)"
  xcrun --sdk iphonesimulator swiftc -O -warnings-as-errors \
    -target "${ARCH}-apple-ios16.4-simulator" -sdk "$SDK" \
    -o "$OUT/push-presentation-sim-check" "${SOURCES[@]}"
  [ -x "$OUT/push-presentation-sim-check" ] || { echo "error: compile failed" >&2; exit 1; }
  xcrun simctl spawn "$UDID" "$OUT/push-presentation-sim-check"
fi
