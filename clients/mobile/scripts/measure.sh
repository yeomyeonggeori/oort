#!/usr/bin/env bash
#
# Run the measurement harness on a booted simulator and capture the answers.
#
# What it measures (see `measure/harness.tsx`):
#   1. anchor movement when a message arrives while the reader is scrolled back
#   2. anchor movement when older messages are prepended
#   3. the gap between the composer's bottom edge and the keyboard's top edge
#   4. the `Origin` header React Native's WebSocket sends
#   5. Work Console/detail in both schemes and an accessibility text size
#   6. the composer's growth cap under Dynamic Type (#1443)
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
ORIGINAL_CONTENT_SIZE=""

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
  trap 'kill "$STUB_PID" 2>/dev/null || true; [ -n "$OWN_METRO_PID" ] && kill "$OWN_METRO_PID" 2>/dev/null || true; [ -n "$ORIGINAL_CONTENT_SIZE" ] && xcrun simctl ui booted content_size "$ORIGINAL_CONTENT_SIZE" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 90); do
    [ "$(metro_root "$METRO_PORT")" = "$PROJECT_ROOT" ] && break
    sleep 1
  done
  if [ "$(metro_root "$METRO_PORT")" != "$PROJECT_ROOT" ]; then
    echo "error: metro did not come up on :$METRO_PORT — see $OUT_DIR/metro.log" >&2
    exit 1
  fi
fi

# From here on a failure must also restore the simulator's Dynamic Type setting.
# `OWN_METRO_PID` is empty when this checkout was already being served.
trap 'kill "$STUB_PID" 2>/dev/null || true; [ -n "$OWN_METRO_PID" ] && kill "$OWN_METRO_PID" 2>/dev/null || true; [ -n "$ORIGINAL_CONTENT_SIZE" ] && xcrun simctl ui booted content_size "$ORIGINAL_CONTENT_SIZE" >/dev/null 2>&1 || true' EXIT

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

# #1292 Work Console surfaces. Both schemes are explicit and the seeded rows
# contain long Korean project/host/channel/plan copy so narrow-width wrapping is
# reviewed on the exact shipping components rather than inferred from styles.
capture_surface() {
  local mode="$1"
  local file="$2"
  xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch booted "$BUNDLE_ID" --args \
    -momoMeasure "$mode" -RCT_jsLocation "127.0.0.1:$METRO_PORT"
  sleep 6
  xcrun simctl io booted screenshot "$OUT_DIR/$file"
}

capture_surface WORK-CONSOLE work-console-dark.png
capture_surface WORK-DETAIL work-detail-dark.png
capture_surface LIGHT-WORK-CONSOLE work-console-light.png
capture_surface LIGHT-WORK-DETAIL work-detail-light.png

# #1422 컴포저 플레이스홀더. 폰에는 웹의 `composer-placeholder` 대응물이 없고
# 예산은 더 빡빡하다 — 이 두 장이 그 예산을 사진으로 든다: 배송되는 `Composer` 를
# 세 이름으로 세우고, 위의 계측 줄이 같은 문장을 **이 기기의 입력창**과 **문서된
# 390pt 예산 상자** 둘에서 재서 줄 수를 적는다.
capture_surface COMPOSER-PLACEHOLDER composer-placeholder-dark.png
capture_surface LIGHT-COMPOSER-PLACEHOLDER composer-placeholder-light.png

# #1443 성장 상한. 기본 크기에서 이 장이 하는 일은 「안 변했다」를 보이는 것이다 —
# 상한 128pt 는 그대로이고, 다섯 줄짜리 글이 그 안에 그대로 든다. 이 장이 값을
# 내는 크기는 아래 접근성 블록의 같은 줄이다.
capture_surface COMPOSER-GROWTH composer-growth-dark.png

# #1479 절 예산. 이 크기(a11y-large, 배수 2.143)가 규칙이 **값을 내는** 띠다:
# 상자가 3.2줄이라 `release-2026-08` 의 문장(4줄)은 안 들고 머리 절(3줄)은 든다.
# 위 XXL 블록만 있으면 두 절 다 안 드는 띠라 「고쳐진 것이 무엇인지」가 안 찍힌다
# (그 띠도 아래에서 함께 찍고, 셋의 산수가 `Composer.tsx` 의 「절 예산」 절에 있다).
ORIGINAL_CONTENT_SIZE="$(xcrun simctl ui booted content_size)"
xcrun simctl ui booted content_size accessibility-large
capture_surface COMPOSER-PLACEHOLDER composer-placeholder-a11y-large.png
capture_surface LIGHT-COMPOSER-PLACEHOLDER composer-placeholder-a11y-large-light.png
xcrun simctl ui booted content_size accessibility-extra-extra-large
capture_surface WORK-CONSOLE work-console-accessibility-text.png
capture_surface WORK-DETAIL work-detail-accessibility-text.png
# #1422 design-review H2. 기본 크기에서 폰이 플레이스홀더를 **안 자른다**는 것이
# 웹과 폰이 다른 처리를 하는 근거인데, 그 근거가 이 크기에서도 참인지는 아무도
# 안 봤었다. 참이 아니다 — 실측은 `composerCopy.ts` 머리말에 적혀 있고, 이 두 줄이
# 그 실측을 다음 배치에서도 다시 낸다.
capture_surface COMPOSER-PLACEHOLDER composer-placeholder-accessibility-text.png
capture_surface LIGHT-COMPOSER-PLACEHOLDER composer-placeholder-accessibility-text-light.png
# #1443. 위 두 줄이 남긴 실측(이 크기에서 상자가 한 줄만 보여 준다)의 수리를 재는
# 자리다. 사진 위의 계측 줄이 글자 배수·창 높이·상한·**실제 상자 높이**를 적으므로,
# 「상한이 커졌다」가 산수가 아니라 화면에서 확인된다.
capture_surface COMPOSER-GROWTH composer-growth-accessibility-text.png
capture_surface LIGHT-COMPOSER-GROWTH composer-growth-accessibility-text-light.png
xcrun simctl ui booted content_size "$ORIGINAL_CONTENT_SIZE"
ORIGINAL_CONTENT_SIZE=""

# #1480 멘션 시트는 이 스크립트가 못 찍는다 — 시트를 여는 것은 `@` 한 글자이고
# 그 글자는 사람이 친다(초안으로 심는 길은 `measure/surfaces.tsx` 의
# `mention-sheet` 절이 실측으로 기각한다). 캡처는 Maestro 레인이 진다:
#
#   xcrun simctl ui booted content_size <large|accessibility-large|accessibility-extra-extra-large>
#   xcrun simctl launch booted app.momo.ios --args \
#     -momoMeasure MENTION-SHEET -RCT_jsLocation 127.0.0.1:$METRO_PORT
#   maestro test maestro/90-mention-sheet-capture.yaml
#   # 사진: ~/.maestro/tests/<타임스탬프>/90-mention-sheet-capture/takeScreenshot/
#
# 라이트는 `LIGHT-MENTION-SHEET`(스킴 접두사 — `measure/root.ts`). 오늘 있는 판:
#
#   dock1480-mention-sheet-{dark,light}.png        기본 크기 — 4행 그대로(무회귀).
#                                                  라이트는 회전 2 에서 붙었다: 기본
#                                                  크기가 다크 한 장뿐이면 이 티켓이
#                                                  **안 바꾼** 화면을 한 스킴에서만
#                                                  드는 것이 된다.
#   dock1480-mention-sheet-ax-{dark,light}.png     a11y-large(2.143) — 3행
#   dock1480-mention-sheet-axxl-{dark,light}.png   AX-XXL(3.143) — 행이 44 를 넘어
#                                                  47.1pt 가 되는 첫 띠(회전 1 M3)
#   dock1480-mention-sheet-{ax,axxl}-before-*.png  같은 두 크기의 옛 판
#
# 접근성 두 크기의 **첫 행**이 회전 2 의 답을 든다 — 세 조각이 각자 앞을 남긴다:
#
#   2.143   「프로덕트…」  「@product-…」  「에이전트」
#   3.143   「프로…」      「@pro…」       「에이전트」
#
# 회전 1 의 같은 사진에서는 핸들이 2.143 에서 맨 「@」 한 글자였고 3.143 에서는
# 아예 없었다(`flex: 1` = basis 0 이라 압력 전부터 자기 폭이 없는 조각이었다).
#
# 여기 안 넣는 이유: 캡처 하나를 위해 계측 레인 전체가 Maestro 를 요구하게 되고,
# 이 스크립트는 오늘 그 의존이 없다.

echo
echo "---- Origin stub ----"
cat "$OUT_DIR/origin-stub.log"
echo
echo "screenshot: $OUT_DIR/measure.png"
echo "work console screenshots: $OUT_DIR/work-console-{dark,light}.png"
echo "work detail screenshots: $OUT_DIR/work-detail-{dark,light}.png"
echo "accessibility text screenshots: $OUT_DIR/work-{console,detail}-accessibility-text.png"
echo "the numbers are also on the Metro log, one line prefixed MOMO_MEASURE"
