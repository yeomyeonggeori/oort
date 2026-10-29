#!/usr/bin/env bash
# `enter` 장면에서 「접속 후 첫 보내기 → 두 번째 보내기」를 한 번 돌린다 (#4749): 앱을 띄우고(= 접속 직후), 입력창을 누르고, 글을 쳐서 보내고, 한 번 더 쳐서 보낸다.
# 단계마다 Maestro 한 번(`maestro/112-enter-steady.yaml` 의 `-e STEP=`), 사이는 셸 sleep 이다(한 흐름 안의 Maestro 대기는 앱이 바쁘면 일찍 반환한다 — 112 머리말).
#
#   measure/run-first-send.sh <udid> <태그> <SURFACE 예: DM-STEADY-ENTER+T50+human+newday> <Metro 포트> <싱크 포트 파일> <싱크 태그 파일> <싱크 jsonl> [rec.mp4]
#
# 타임라인(앱이 뜬 시각 0 기준, 근사): 5s 누름 → +2s 글 → +2s 첫 보내기 → +6s 글 → +2s 두 번째 보내기 → 장면 끝(`+T<초>`, 기본 75)까지 가만히.
# 분석은 `measure/first-send-windows.mjs`. 장면 끝(T)이 마지막 보내기 뒤 5초 이상 남도록 T 를 준다(예: `+T50`).
set -u
UDID="$1"; TAG="$2"; SURFACE="$3"; METRO="$4"; SINK_PORT_FILE="$5"; SINK_TAG_FILE="$6"; SINK_JSONL="$7"; REC="${8:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FLOW="$HERE/../maestro/112-enter-steady.yaml"
export PATH="$HOME/.maestro/bin:$PATH"

echo -n "$TAG" > "$SINK_TAG_FILE"
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
sleep 1
RECPID=""
if [ -n "$REC" ]; then
  rm -f "$REC"
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$REC" >/dev/null 2>&1 &
  RECPID=$!
  # 녹화가 시작된 시각(epoch ms) — 장면의 표식(`beginMs + t`)을 영상 위 시각으로 옮길 때 쓴다(`ffmpeg -ss <(표식 − 이 값)/1000`). 근사: 녹화기가 첫 프레임을 쓰기까지 0.1~0.5초 늦을 수 있다.
  python3 -c 'import time; print(int(time.time()*1000))' > "$REC.start"
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
  echo "[run-first-send] $TAG step=$1 rc=$? at +$(( $(date +%s) - START ))s"
}
at 5
step press
sleep 2
step typeA
sleep 2
step send
sleep 6
step typeB
sleep 2
step send
for _ in $(seq 1 60); do
  if [ -f "$SINK_JSONL" ] && grep -q "\"tag\":\"$TAG\"" "$SINK_JSONL" 2>/dev/null; then echo "[run-first-send] $TAG sink record found"; break; fi
  sleep 2
done
sleep 1
if [ -n "$RECPID" ]; then kill -INT "$RECPID" 2>/dev/null; wait "$RECPID" 2>/dev/null; fi
echo "[run-first-send] $TAG done at +$(( $(date +%s) - START ))s"
