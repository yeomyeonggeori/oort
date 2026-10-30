#!/usr/bin/env bash
# 말풍선 글 잘림 회귀 시험의 구동기 (#4894). 앱을 띄워 `measure/bubbleClip.tsx` 가 낸 틀 숫자를 받고
# `bubble-clip-check.mjs check` 로 단정한다. 하나라도 어기면 종료 코드 1.
#
#   measure/run-bubble-clip.sh <udid> <태그> <SURFACE 예: BUBBLE-CLIP> <Metro 포트> <결과 폴더> [content_size] [appearance] [앱 인자 …]
#
#   content_size  simctl ui 글자 크기(기본 large). 예: extra-extra-extra-large, accessibility-medium
#   appearance    dark | light (기본 dark)
#   앱 인자       예: -momoClipWidths 375,390,430 -momoClipSet ko
#
# 시뮬레이터를 쓰므로 **반드시** `~/.cache/momo-scratch/bin/sim-locked.sh measure/run-bubble-clip.sh …` 로 감싸 부른다.
# 앱이 끝까지 돌지 못하면(done 기록이 없으면) 검사기가 실패로 센다 — 못 잰 것은 통과가 아니다.
set -u
UDID="$1"; TAG="$2"; SURFACE="$3"; METRO="$4"; OUT="$5"; CS="${6:-large}"; APPEAR="${7:-dark}"
shift 7 2>/dev/null || shift $#
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
JSONL="$OUT/$TAG.jsonl"; PORTFILE="$OUT/$TAG.port"
rm -f "$JSONL" "$PORTFILE"

node "$HERE/bubble-clip-check.mjs" serve "$JSONL" "$PORTFILE" &
SINK_PID=$!
cleanup() {
  kill "$SINK_PID" 2>/dev/null || true
  xcrun simctl ui "$UDID" content_size large >/dev/null 2>&1 || true
}
trap cleanup EXIT
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.2; done
[ -s "$PORTFILE" ] || { echo "[run-bubble-clip] sink did not start" >&2; exit 2; }

xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
xcrun simctl ui "$UDID" appearance "$APPEAR"
xcrun simctl ui "$UDID" content_size "$CS"
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
sleep 1
xcrun simctl launch "$UDID" app.momo.ios --args -momoMeasure "$SURFACE" \
  -RCT_jsLocation "127.0.0.1:$METRO" -momoGapSink "127.0.0.1:$(cat "$PORTFILE")" "$@" >/dev/null

# 하네스가 `done` 을 적을 때까지(쪽마다 1.4초) 기다린다. 600초면 칸 2000개쯤이다.
for _ in $(seq 1 300); do
  grep -q '"kind":"done"' "$JSONL" 2>/dev/null && break
  sleep 2
done
sleep 1
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
echo "[run-bubble-clip] $TAG size=$CS appearance=$APPEAR surface=$SURFACE"
node "$HERE/bubble-clip-check.mjs" check "$JSONL" --min-cases 1
