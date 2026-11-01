#!/usr/bin/env bash
# 「입력 중 대화 목록을 누르면 자판이 내려가고 입력창이 쉰다」(#4614)의 Maestro 시험(`maestro/115-list-tap-dismiss.yaml`)과 캡처(`maestro/117-list-tap-capture.yaml`)를 한 CASE 씩 돌리는 구동기.
# 표면을 CASE 에 맞춰 띄우고, 선택하면 녹화하고, 종료 코드로 통과·실패를 알린다.
#
#   measure/run-list-tap.sh <udid> <CASE> <Metro 포트> [rec.mp4] [light] [shots 폴더 사진이름접두]
#
#   CASE  body reopen-edge empty send link chip author avatar replymark rollup drag drag-short drag-up hold long autocorrect hangul   (115 의 단정)
#         shot-typed  shot-long                                                                  (117 의 사진: 한 줄 초안 · 여러 줄 초안)
#   light 를 주면 라이트 스킴(`LIGHT-` 표면)이다. `shots 폴더`와 `사진이름접두`를 주면 117 이 찍은 사진을 그 폴더에 `<접두>-….png` 로 복사한다.
#   `LIST_POINT=50%,15% measure/run-list-tap.sh …` — 목록을 누르는 자리(기본 `50%,25%`, 사진 CASE 만). 접근성 큰 글씨에서는 목록이 위쪽 뼘밖에 안 남는다.
#
# 이 구동기는 `-momoGapSink` 를 주지 않는다 — 단정은 화면(`tap-probe` 한 줄·도구 줄)에서 읽고 싱크는 쓰지 않는다.
set -u
UDID="$1"; CASE="$2"; METRO="$3"; REC="${4:-}"; SCHEME="${5:-}"; SHOTS="${6:-}"; PREFIX="${7:-$CASE}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.maestro/bin:$PATH"
case "$CASE" in
  body|reopen-edge)             SURFACE="TAP-UP+TYPED+PROBE" ;;
  empty|hold)                   SURFACE="TAP-UP+ONE+TYPED+PROBE" ;;
  send|autocorrect|hangul)      SURFACE="TAP-UP+PROBE" ;;
  link|author|avatar|replymark) SURFACE="TAP-UP+LINK+TYPED+PROBE" ;;
  chip)                         SURFACE="TAP-UP+CHIP+TYPED+PROBE" ;;
  rollup)                       SURFACE="TAP-UP+ROLL+TYPED+PROBE" ;;
  drag|drag-short|drag-up|long) SURFACE="TAP-UP+TYPED+PROBE" ;;
  shot-typed)                   SURFACE="TAP-UP+TYPED" ;;
  shot-long)                    SURFACE="TAP-UP+LONG" ;;
  *) echo "[run-list-tap] 모르는 CASE: $CASE" >&2; exit 2 ;;
esac
[ "$SCHEME" = "light" ] && SURFACE="LIGHT-$SURFACE"
LOG="$(mktemp -t run-list-tap)"

xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
sleep 1
RECPID=""
if [ -n "$REC" ]; then
  rm -f "$REC"
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$REC" >/dev/null 2>&1 &
  RECPID=$!
fi
xcrun simctl launch "$UDID" app.momo.ios --args -momoMeasure "$SURFACE" -RCT_jsLocation "127.0.0.1:$METRO" >/dev/null
START=$(date +%s)
case "$CASE" in
  shot-*) timeout 240 maestro --udid "$UDID" test -e SHOT="$PREFIX" -e LIST_POINT="${LIST_POINT:-50%,25%}" "$HERE/../maestro/117-list-tap-capture.yaml" > "$LOG" 2>&1 ;;
  *)      timeout 300 maestro --udid "$UDID" test -e CASE="$CASE" "$HERE/../maestro/115-list-tap-dismiss.yaml" > "$LOG" 2>&1 ;;
esac
RC=$?
sleep 1
if [ -n "$RECPID" ]; then kill -INT "$RECPID" 2>/dev/null; wait "$RECPID" 2>/dev/null; fi
if [ -n "$SHOTS" ]; then
  mkdir -p "$SHOTS"
  # 가장 새 결과 폴더만 보면 이어 도는 다음 실행의 폴더에 밀려 사진을 놓치는 일이 있었다 — 방금 5분 안의 모든 결과 폴더에서 찾는다(이름 접두가 같은 사진은 가장 새 것이 남는다).
  find "$HOME"/.maestro/tests -name "${PREFIX}-*.png" -mmin -5 2>/dev/null | sort | while read -r shot; do cp "$shot" "$SHOTS"/; done
fi
echo "[run-list-tap] $CASE ($SURFACE) rc=$RC in $(( $(date +%s) - START ))s"
grep -E "COMPLETED|FAILED|Assertion|Element not found|ERROR|Error" "$LOG" | tail -8
rm -f "$LOG"
exit $RC
