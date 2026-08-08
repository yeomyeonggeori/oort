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

# ---- Metro, and WHOSE -------------------------------------------------------
# A Metro from ANOTHER worktree answers on 8081 exactly like ours and serves that
# worktree's JavaScript. This script used to take whatever was listening, so a
# run could measure a different checkout and print the numbers as if they were
# this one's — which is how a measurement quietly becomes an anecdote. It is not
# hypothetical: goal RN-P2 hit it, with `momo-tracks/engine` holding the port.
#
# `gate/run.mjs` already guards this and says why; the harness whose numbers go
# into a PR has more reason to, not less. The question is answered exactly rather
# than by inference — `@react-native-community/cli`'s status middleware puts the
# project root in a response header — and the app is pointed at ours with
# `RCT_jsLocation` (read by `RCTBundleURLProvider.mm` out of NSUserDefaults), so
# nobody else's dev loop is ended to run a measurement.
PROJECT_ROOT="$(pwd)"
METRO_PORT=8081
OWN_METRO_PID=""

metro_root() {
  curl -s -D - -o /dev/null "http://127.0.0.1:$1/status" 2>/dev/null \
    | awk 'tolower($1) == "x-react-native-project-root:" {print $2}' \
    | tr -d '\r'
}

if [ "$(metro_root "$METRO_PORT")" = "$PROJECT_ROOT" ]; then
  echo "==> metro :$METRO_PORT (already serving this checkout)"
else
  METRO_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  echo "==> metro :$METRO_PORT (started for this run — :8081 is not this checkout)"
  node node_modules/react-native/cli.js start --port "$METRO_PORT" \
    > "$OUT_DIR/metro.log" 2>&1 &
  OWN_METRO_PID=$!
  trap 'kill "$STUB_PID" 2>/dev/null || true; [ -n "$OWN_METRO_PID" ] && kill "$OWN_METRO_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 90); do
    [ "$(metro_root "$METRO_PORT")" = "$PROJECT_ROOT" ] && break
    sleep 1
  done
  if [ "$(metro_root "$METRO_PORT")" != "$PROJECT_ROOT" ]; then
    echo "error: metro did not come up on :$METRO_PORT — see $OUT_DIR/metro.log" >&2
    exit 1
  fi
fi

echo "==> launching with -momoMeasure YES"
xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch booted "$BUNDLE_ID" --args \
  -momoMeasure YES -RCT_jsLocation "127.0.0.1:$METRO_PORT"

echo "==> waiting for the harness to finish (it runs itself)"
# The keyboard travel is measured three times (idle / busy JS / blocked JS), each
# raise followed by a hide so the next one starts from the floor — ~11s of
# keyboard on top of what the scroll claims need. goal RN-P3 added a SECOND
# self-send probe (three screens back, the ordinary distance) which costs ~6s
# more, and a screenshot taken before the harness finishes prints 측정 중… for
# rows that were about to answer.
#
# goal RN-U1 adds two more claims at the end: a keyboard raise+dismiss on the
# channel stage (~3s), then a stage swap to a SHORT thread, another raise, and a
# reply probe with its own retry loop (~8s). The stage swap is the reason this is
# a wall clock rather than a poll — the second `ConversationLayout` has to mount
# and lay out before anything about it is true.
sleep 95

echo "==> capturing"
xcrun simctl io booted screenshot "$OUT_DIR/measure.png"

echo "==> capturing the states that a live server never shows"
xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch booted "$BUNDLE_ID" --args \
  -momoMeasure STATES -RCT_jsLocation "127.0.0.1:$METRO_PORT"
sleep 6
xcrun simctl io booted screenshot "$OUT_DIR/states.png"

echo
echo "---- Origin stub ----"
cat "$OUT_DIR/origin-stub.log"
echo
echo "screenshot: $OUT_DIR/measure.png"
echo "the numbers are also on the Metro log, one line prefixed MOMO_MEASURE"
