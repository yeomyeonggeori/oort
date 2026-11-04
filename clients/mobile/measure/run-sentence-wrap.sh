#!/usr/bin/env bash
# 줄바꿈 전략별 「잰 줄 수 ↔ 그린 줄 수」 측정의 구동기 (#5288). 앱을 띄워 `measure/sentenceWrap.tsx` 가 낸 숫자를 받고
# `sentence-wrap-check.mjs check` 로 단정한다. 단정 옵션은 환경 변수 WRAP_CHECK_FLAGS 로 준다(예: "--clean sentence --no-orphans sentence").
#
#   measure/run-sentence-wrap.sh <udid> <태그> <SURFACE 예: SENTENCE-WRAP> <Metro 포트> <결과 폴더> [content_size] [appearance] [앱 인자 …]
#
#   content_size  simctl ui 글자 크기(기본 large). 예: extra-extra-extra-large, accessibility-medium
#   appearance    dark | light (기본 light)
#   앱 인자       예: -momoWrapWidths 300-402/1 -momoWrapStrategies hangul-word,none -momoWrapSet en
#
# 시뮬레이터를 쓰므로 **반드시** `~/.cache/momo-scratch/bin/sim-locked.sh measure/run-sentence-wrap.sh …` 로 감싸 부른다.
# 앱이 끝까지 돌지 못하면(done 기록이 없으면) 검사기가 실패로 센다 — 못 잰 것은 통과가 아니다.
set -u
UDID="$1"; TAG="$2"; SURFACE="$3"; METRO="$4"; OUT="$5"; CS="${6:-large}"; APPEAR="${7:-light}"
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
[ -s "$PORTFILE" ] || { echo "[run-sentence-wrap] sink did not start" >&2; exit 2; }

xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
xcrun simctl ui "$UDID" appearance "$APPEAR"
xcrun simctl ui "$UDID" content_size "$CS"
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
sleep 1
xcrun simctl launch "$UDID" app.momo.ios --args -momoMeasure "$SURFACE" \
  -RCT_jsLocation "127.0.0.1:$METRO" -momoGapSink "127.0.0.1:$(cat "$PORTFILE")" "$@" >/dev/null

# 첫 기록이 5분 안에 안 오면(Metro 연결 실패·알 수 없는 표면·빨간 화면) 기다리지 않고 화면을 남기고 멈춘다.
for _ in $(seq 1 150); do
  [ -s "$JSONL" ] && break
  sleep 2
done
if [ ! -s "$JSONL" ]; then
  xcrun simctl io "$UDID" screenshot "$OUT/$TAG-nostart.png" >/dev/null 2>&1
  xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
  echo "[run-sentence-wrap] $TAG: 5분 안에 첫 기록이 오지 않았다 — $OUT/$TAG-nostart.png" >&2
  exit 3
fi
# 하네스가 `done` 을 적을 때까지(쪽마다 1초 안팎) 기다린다. 최대 20분.
for _ in $(seq 1 600); do
  grep -q '"kind":"done"' "$JSONL" 2>/dev/null && break
  sleep 2
done
sleep 1
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
echo "[run-sentence-wrap] $TAG size=$CS appearance=$APPEAR surface=$SURFACE"
# shellcheck disable=SC2086
node "$HERE/sentence-wrap-check.mjs" check "$JSONL" --min-cases 1 ${WRAP_CHECK_FLAGS:-}
