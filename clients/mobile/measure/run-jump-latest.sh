#!/usr/bin/env bash
# `jump-latest` 장면(#4689)을 한 번 돌린다: 앱을 띄우고(`measure/jumpLatest.tsx`), Maestro 흐름(`maestro/119-jump-latest.yaml`)이 표식 `ARMED` 마다 알약을 누르고,
# 싱크가 시험 수만큼 기록을 받을 때까지 기다린 뒤 **앱을 끈다**.
#
#   measure/run-jump-latest.sh <udid> <태그> <SURFACE 예: JUMP-LATEST+n300> <Metro 포트> <싱크 포트 파일> <싱크 태그 파일> <싱크 jsonl> [rec.mp4]
#
#   SURFACE   `JUMP-LATEST[+n120|+n300|+r1|+dnear|+d3scr|+dhalf|+dtop|+paged|+arrive|+fast]` (라이트는 `LIGHT-` 접두사). 플래그는 `measure/jumpLatest.tsx` 머리말.
#   시험 수   (거리 수 × 반복) — SURFACE 의 `+r<횟수>`(기본 3)·`+d<거리>`(기본 네 거리)에서 읽는다. 기본 12.
#   <싱크 jsonl>  싱크(`measure/gap-sink.mjs`)를 띄울 때 준 **그 출력 파일**이어야 한다 — 싱크는 자기가 받은 파일에만 쓰고, 이 스크립트는 그 파일에서 기록 수를 센다(다르면 0/N 으로 보인다).
#   환경변수  JLAT_QUIET_MS=<ms>  누른 뒤 그 시간 동안 Maestro 가 앱 계층을 읽지 않고 기다린다(`119` 머리말). 기본 0(DONE 을 기다린다).
#
# **끝에서 앱을 반드시 끈다**: 이 표면은 Metro 번들이 바뀌면 리로드되어 장면을 처음부터 다시 돌고, 싱크의 태그 파일에 남은 (다른 실행의) 태그로 유령 기록을 보낸다
# (`enter-windows.mjs` 가 같은 사고를 적어 두었다).
set -u
UDID="$1"; TAG="$2"; SURFACE="$3"; METRO="$4"; SINK_PORT_FILE="$5"; SINK_TAG_FILE="$6"; SINK_JSONL="$7"; REC="${8:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FLOW="$HERE/../maestro/119-jump-latest.yaml"
export PATH="$HOME/.maestro/bin:$PATH"
QUIET_MS="${JLAT_QUIET_MS:-0}"

# 시험 수 = (+d<거리> 개수, 없으면 4) × (+r<횟수>, 없으면 3)
LOWER="$(printf '%s' "$SURFACE" | tr '[:upper:]' '[:lower:]')"
R=3; D=0
IFS='+' read -r -a PARTS <<< "$LOWER"
for part in "${PARTS[@]}"; do
  case "$part" in
    r[0-9]*) R="${part#r}" ;;
    dnear|d3scr|dhalf|dtop) D=$((D + 1)) ;;
  esac
done
[ "$D" -eq 0 ] && D=4
TRIALS=$((R * D))

count_records() { # 이 태그로 받은 jump-latest 기록 수
  if [ -f "$SINK_JSONL" ]; then
    grep -c "\"tag\":\"$TAG\"" "$SINK_JSONL" 2>/dev/null || true
  else
    echo 0
  fi
}

echo -n "$TAG" > "$SINK_TAG_FILE"
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
sleep 1
RECPID=""
if [ -n "$REC" ]; then
  rm -f "$REC"
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$REC" >/dev/null 2>&1 &
  RECPID=$!
fi
BEFORE="$(count_records)"; BEFORE="${BEFORE:-0}"
START=$(date +%s)
xcrun simctl launch "$UDID" app.momo.ios --args -momoMeasure "$SURFACE" -RCT_jsLocation "127.0.0.1:$METRO" -momoGapSink "127.0.0.1:$(cat "$SINK_PORT_FILE")" >/dev/null
echo "[run-jump-latest] $TAG surface=$SURFACE trials=$TRIALS quiet=${QUIET_MS}ms launched"
echo "[run-jump-latest] $TAG load(시작) $(uptime | sed 's/.*load averages*: //')"

# 시험 하나가 길어야 (가장 긴 거리) 올림 90초 + 진입 30초 + 기록 8초. 여유를 두고 넘으면 Maestro 를 끊는다.
LIMIT=$((TRIALS * 150 + 300))
# Maestro 의 산출물(마지막 `takeScreenshot` 포함)은 이 실행의 전용 폴더로 — 다른 실행의 최신 폴더를 집지 않게.
OUTDIR="$SINK_JSONL.maestro-$TAG.out"
rm -rf "$OUTDIR"; mkdir -p "$OUTDIR"
timeout "$LIMIT" maestro --udid "$UDID" test --test-output-dir "$OUTDIR" -e TRIALS="$TRIALS" -e QUIET_MS="$QUIET_MS" "$FLOW" > "$SINK_JSONL.maestro-$TAG.log" 2>&1
echo "[run-jump-latest] $TAG maestro rc=$? at +$(( $(date +%s) - START ))s"
SHOT="$(find "$OUTDIR" -name 'jump-latest-final*.png' 2>/dev/null | head -1)"
[ -n "$SHOT" ] && cp "$SHOT" "$SINK_JSONL.$TAG.final.png" && echo "[run-jump-latest] $TAG final screenshot: $SINK_JSONL.$TAG.final.png"

# 마지막 기록이 도착하는 것까지 (Maestro 가 일찍 끝났거나 실패했어도 앱이 아직 돌고 있을 수 있다).
for _ in $(seq 1 90); do
  GOT=$(( $(count_records) - BEFORE ))
  if [ "$GOT" -ge "$TRIALS" ]; then echo "[run-jump-latest] $TAG sink records=$GOT/$TRIALS"; break; fi
  sleep 2
done
GOT=$(( $(count_records) - BEFORE ))
[ "$GOT" -lt "$TRIALS" ] && echo "[run-jump-latest] $TAG WARNING sink records=$GOT/$TRIALS"
sleep 1
if [ -n "$RECPID" ]; then kill -INT "$RECPID" 2>/dev/null; wait "$RECPID" 2>/dev/null; fi
# 앱을 끈다 — 이후 Metro 번들이 바뀌어도 장면이 다시 돌며 유령 기록을 만들지 않게.
xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
echo "[run-jump-latest] $TAG load(끝) $(uptime | sed 's/.*load averages*: //')"
echo "[run-jump-latest] $TAG done at +$(( $(date +%s) - START ))s (app terminated)"
