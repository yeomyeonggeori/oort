#!/usr/bin/env bash
# `enter` 장면(#4613)을 한 번 돌린다: 앱을 띄우고, 단계별 Maestro 호출(`maestro/112-enter-steady.yaml`)을 **셸 sleep 으로 정확히 띄워** 친 뒤,
# 싱크가 장면 결과를 받을 때까지 기다린다. 한 흐름 안의 Maestro 대기는 앱이 바쁘면 일찍 반환하므로(112 머리말) 시간은 여기서 정한다.
#
#   measure/run-enter.sh <udid> <태그> <SURFACE 예: DM-STEADY-ENTER+T85+label> <Metro 포트> <싱크 포트 파일> <싱크 태그 파일> <싱크 jsonl> [rec.mp4]
#
# 타임라인(앱이 뜬 시각 0 기준, 근사): 9s 누름 → +3s 글자 1 → +2s 글자 4 → 가만히 → (T−13)s 보내기. T 는 SURFACE 의 `+T<초>`(기본 75).
set -u
UDID="$1"; TAG="$2"; SURFACE="$3"; METRO="$4"; SINK_PORT_FILE="$5"; SINK_TAG_FILE="$6"; SINK_JSONL="$7"; REC="${8:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FLOW="$HERE/../maestro/112-enter-steady.yaml"
export PATH="$HOME/.maestro/bin:$PATH"
T=$(echo "$SURFACE" | sed -n 's/.*+[Tt]\([0-9][0-9]*\).*/\1/p'); T="${T:-75}"

echo -n "$TAG" > "$SINK_TAG_FILE"
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
sleep 1
RECPID=""
if [ -n "$REC" ]; then
  rm -f "$REC"
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$REC" >/dev/null 2>&1 &
  RECPID=$!
fi
START=$(date +%s)
xcrun simctl launch "$UDID" app.momo.ios --args -momoMeasure "$SURFACE" -RCT_jsLocation "127.0.0.1:$METRO" -momoGapSink "127.0.0.1:$(cat "$SINK_PORT_FILE")" >/dev/null
at() { # <앱이 뜬 뒤 초> — 그 시각까지 잔다
  local target=$((START + $1)) now
  now=$(date +%s)
  [ "$target" -gt "$now" ] && sleep $((target - now))
}
step() { # <STEP>
  timeout 90 maestro --udid "$UDID" test -e STEP="$1" "$FLOW" > "$SINK_JSONL.maestro-$TAG-$1.log" 2>&1
  echo "[run-enter] $TAG step=$1 rc=$? at +$(( $(date +%s) - START ))s"
}
at 5
step press
sleep 3
step type1
sleep 2
step type2
at $((T - 13))
step send
for _ in $(seq 1 60); do
  if [ -f "$SINK_JSONL" ] && grep -q "\"tag\":\"$TAG\"" "$SINK_JSONL" 2>/dev/null; then echo "[run-enter] $TAG sink record found"; break; fi
  sleep 2
done
sleep 1
if [ -n "$RECPID" ]; then kill -INT "$RECPID" 2>/dev/null; wait "$RECPID" 2>/dev/null; fi
echo "[run-enter] $TAG done at +$(( $(date +%s) - START ))s"
