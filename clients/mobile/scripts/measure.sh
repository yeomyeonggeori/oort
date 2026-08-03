#!/usr/bin/env bash
#
# Run the measurement harness on a booted simulator and capture the answers.
#
# What it measures (see `measure/harness.tsx`):
#   1. anchor movement when a message arrives while the reader is scrolled back
#   2. anchor movement when older messages are prepended
#   3. the gap between the composer's bottom edge and the keyboard's top edge
#   4. the `Origin` header React Native's WebSocket sends
#
# Simulator, deliberately. Spike #837 established that this is the one property
# where the simulator does NOT lie: the reversed-list numbers came out the same
# on the simulator and on 성재's iPhone (FlashList 67.3 = 67.3, Legend 92.3 ≈
# 91.3). IME and push are the ones that need a device, and neither is measured
# here.
#
# The hardware keyboard is disconnected first: with the Mac's keyboard attached
# the software keyboard never appears and step 3 measures nothing.
set -euo pipefail

cd "$(dirname "$0")/.."

BUNDLE_ID="app.momo.ios"
OUT_DIR="${1:-measure/out}"
mkdir -p "$OUT_DIR"

echo "==> disconnecting the simulator's hardware keyboard"
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false || true

echo "==> starting the Origin stub"
node measure/origin-stub.mjs > "$OUT_DIR/origin-stub.log" 2>&1 &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT
sleep 1

echo "==> bringing the simulator window to the front"
# A background simulator window is not key, so the app cannot become first
# responder and the software keyboard never appears — step 3 then measures
# nothing while steps 1 and 2 still pass, which reads as a partial run.
osascript -e 'tell application "Simulator" to activate' || true
sleep 2

echo "==> launching with -momoMeasure YES"
xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch booted "$BUNDLE_ID" --args -momoMeasure YES

echo "==> waiting for the harness to finish (it runs itself)"
sleep 14

echo "==> capturing"
xcrun simctl io booted screenshot "$OUT_DIR/measure.png"

echo "==> capturing the states that a live server never shows"
xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch booted "$BUNDLE_ID" --args -momoMeasure STATES
sleep 6
xcrun simctl io booted screenshot "$OUT_DIR/states.png"

echo
echo "---- Origin stub ----"
cat "$OUT_DIR/origin-stub.log"
echo
echo "screenshot: $OUT_DIR/measure.png"
echo "the numbers are also on the Metro log, one line prefixed MOMO_MEASURE"
