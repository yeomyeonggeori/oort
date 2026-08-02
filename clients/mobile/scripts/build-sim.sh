#!/usr/bin/env bash
#
# Build the app for the iOS Simulator.
#
# Simulator only, deliberately: installing on a device is the orchestrator's
# step, and a device build additionally needs provisioning this batch has not
# set up (see `src/storage/secureSession.ts` on the keychain access group).
#
# `CODE_SIGNING_ALLOWED=NO` because a simulator build does not need a signature
# and asking for one turns "does this compile" into "is this machine's keychain
# set up", which is a different question with a much worse error message.
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEME="MomoMobile"
WORKSPACE="ios/MomoMobile.xcworkspace"
DESTINATION="${1:-platform=iOS Simulator,name=iPhone 17 Pro}"

if [ ! -d "$WORKSPACE" ]; then
  echo "error: $WORKSPACE is missing. Run 'pod install' in ios/ first." >&2
  exit 1
fi

exec xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "$DESTINATION" \
  -derivedDataPath build/sim \
  CODE_SIGNING_ALLOWED=NO \
  build
