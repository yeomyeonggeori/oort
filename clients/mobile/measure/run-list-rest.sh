#!/usr/bin/env bash
# 「대화 목록을 눌러 입력창을 쉬게 한다」(#4614)의 이동을 한 번 재는 구동기. 앱을 띄우고 단계별 Maestro 호출(`maestro/116-list-tap-rest.yaml`)을 **셸 sleep 으로 정확히 띄워** 친 뒤,
# 싱크가 장면 결과를 받을 때까지 기다린다(한 흐름 안의 Maestro 대기는 앱이 바쁘면 일찍 반환한다 — 116 머리말).
#
#   measure/run-list-rest.sh <udid> <태그> <SURFACE 예: DM-STEADY-FOCUS+actions+T220> <Metro 포트> <싱크 포트 파일> <싱크 태그 파일> <싱크 jsonl> [rec.mp4] [plan: typed|restored]
#
# plan `typed`(기본) — 타자로 친다. 순서(앱이 뜬 시각 0 기준 근사). 사건마다 앞뒤 2.5~3초를 비워 `focus-windows.mjs` 의 창(앞 0.15초·뒤 0.9초)이 겹치지 않는다.
#   A  빈 펼침에서 목록을 누른다     focus → list                 (글 없음: 접힘은 포커스를 잃는 `onBlur` 가 맡는다 — 기존 길의 기준선)
#   B  한 줄 초안에서 누른다         focus → line1 → list          (글이 있다: 쉬는 알약으로 접힌다 — 이 이슈의 길)
#   B' 다시 눌러 펼친다              focus                         (한 줄 쉬는 초안이 같은 자리에서 펼쳐진다)
#   C  세 줄 초안에서 누른다         line2 → line3 → list          (여러 줄: 이 빌드의 타자 줄은 입력창을 못 키우므로 높이 변화는 없다 — #4615)
#   C' 다시 눌러 펼친다              focus                         (여러 줄 쉬는 초안이 펼쳐진다)
#   D  보낸 직후(포커스 남음)에 누른다  clear → line1 → send → list   (보낸 뒤 빈 펼침 → 접힘)
# plan `restored` — SURFACE 에 `+draft<N>` 을 붙여 N줄 초안을 들고 시작한다(키가 큰 입력창). 쉬러 가고(list) 다시 펼치는(focus) 왕복을 세 번 한다:
#   focus → tips → list(쉼 #1) → focus(펼침 #1) → list(쉼 #2) → focus(펼침 #2) → list(쉼 #3)
# plan `sent` — 보낸 직후(포커스가 남은 빈 펼침)에 누른다: focus → tips → line1 → send → list (typed 의 D 만 따로, 짧은 장면으로)
set -u
UDID="$1"; TAG="$2"; SURFACE="$3"; METRO="$4"; SINK_PORT_FILE="$5"; SINK_TAG_FILE="$6"; SINK_JSONL="$7"; REC="${8:-}"; PLAN="${9:-typed}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FLOW="$HERE/../maestro/116-list-tap-rest.yaml"
# 목록을 누르는 자리(화면 비율). 키 큰 초안이 올라온 작은 화면은 목록이 위쪽 뼘밖에 안 남는다 — `LIST_POINT=50%,16% measure/run-list-rest.sh …`.
LIST_POINT="${LIST_POINT:-50%,25%}"
export PATH="$HOME/.maestro/bin:$PATH"

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
step() { # <STEP> <그 뒤 가만히 초>
  timeout 90 maestro --udid "$UDID" test -e STEP="$1" -e LIST_POINT="$LIST_POINT" "$FLOW" > "$SINK_JSONL.maestro-$TAG-$1.log" 2>&1
  echo "[run-list-rest] $TAG step=$1 rc=$? at +$(( $(date +%s) - START ))s"
  sleep "${2:-2}"
}
# 장면이 재기 시작할 때까지(목록 수렴 4초 + 0.8초 + 앱이 뜨는 시간)
sleep 13
step focus 1
step tips 1.5       # 받아쓰기 안내가 떠 있으면 닫는다(이 눌림은 첫 「포커스」다)
if [ "$PLAN" = "sent" ]; then
  step line1 1.5
  step send 2.5
  step list 3
  step focus 2.5
  step line1 1.5
  step send 2.5
  step list 3
elif [ "$PLAN" = "restored" ]; then
  step list 3       # 쉼 #1
  step focus 3      # 펼침 #1
  step list 3       # 쉼 #2
  step focus 3      # 펼침 #2
  step list 3       # 쉼 #3
else
  step list 3       # A
  step focus 2.5    # B
  step line1 1.5
  step list 3
  step focus 2.5    # B'
  step line2 1
  step line3 1.5    # C
  step list 3
  step focus 3      # C'
  step clear 1.5    # D
  step line1 1.5
  step send 2.5
  step list 3
fi
for _ in $(seq 1 90); do
  if [ -f "$SINK_JSONL" ] && grep -q "\"tag\":\"$TAG\"" "$SINK_JSONL" 2>/dev/null; then echo "[run-list-rest] $TAG sink record found"; break; fi
  sleep 2
done
sleep 1
if [ -n "$RECPID" ]; then kill -INT "$RECPID" 2>/dev/null; wait "$RECPID" 2>/dev/null; fi
echo "[run-list-rest] $TAG done at +$(( $(date +%s) - START ))s"
