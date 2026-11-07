#!/usr/bin/env bash
# 키보드 ↔ 이모티콘 창을 오가는 동안 입력창(보내기 원)의 세로 자리가 1pt 안에서 같은지 시뮬레이터 녹화로 잰다 (#5452).
#
#   measure/run-panel-steady.sh --udid <udid> --channel <채널 id> --server <서버 주소> --email <이메일> [--out <폴더>] [--runs 1]
#
# 비밀번호는 환경 변수 `PANEL_STEADY_PASSWORD` 로 건넨다(프로세스 목록에 남지 않게). 흐름은 `maestro/5452-panel-steady.yaml`, 분석은 `measure/panel-steady.py`
# (캡처 다섯 장의 자리 + 녹화의 모든 프레임). 종료 코드는 모든 회차가 문턱(1pt) 안이면 0, 아니면 1 이다(RED/GREEN 은 이 코드로 가른다).
# 시뮬레이터를 쓰는 무거운 명령이라 부르는 쪽이 `~/.cache/momo-scratch/bin/sim-locked.sh` 안에서 돌린다. 시드는 `measure/seed-expression-panel.py`.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
UDID=""; CHANNEL=""; SERVER=""; EMAIL=""; RUNS=1; OUT="${TMPDIR:-/tmp}/panel-steady-$$"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    *) echo "[panel-steady] 모르는 인자: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$UDID" ] || [ -z "$CHANNEL" ] || [ -z "$SERVER" ] || [ -z "$EMAIL" ] || [ -z "${PANEL_STEADY_PASSWORD:-}" ]; then
  echo "[panel-steady] --udid --channel --server --email 와 환경 변수 PANEL_STEADY_PASSWORD 가 필요해요" >&2
  exit 2
fi
export PATH="$HOME/.maestro/bin:$PATH"
mkdir -p "$OUT"
pass=0
for run in $(seq 1 "$RUNS"); do
  dir="$OUT/run-$run"; mkdir -p "$dir"
  xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
  sleep 1
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$dir/steady.mp4" >/dev/null 2>&1 &
  recorder=$!
  sleep 1
  maestro --udid "$UDID" test --test-output-dir "$dir/maestro" \
    -e SERVER_URL="$SERVER" -e EMAIL="$EMAIL" -e PASSWORD="$PANEL_STEADY_PASSWORD" -e CHANNEL_ID="$CHANNEL" \
    "$HERE/../maestro/5452-panel-steady.yaml" > "$dir/maestro.log" 2>&1
  flow_rc=$?
  sleep 2
  kill -INT "$recorder" 2>/dev/null
  wait "$recorder" 2>/dev/null
  python3 "$HERE/panel-steady.py" shots "$dir/maestro" | tee "$dir/shots.txt"
  shots_rc=${PIPESTATUS[0]}
  python3 "$HERE/panel-steady.py" video "$dir/steady.mp4" 2>&1 | grep -v "non monotonically\|Last message" | tee "$dir/video.txt"
  video_rc=${PIPESTATUS[0]}
  echo "[panel-steady] 회차 $run/$RUNS: 흐름 rc=$flow_rc 캡처 rc=$shots_rc 녹화 rc=$video_rc (0 = 문턱 안)"
  if [ "$flow_rc" -eq 0 ] && [ "$shots_rc" -eq 0 ] && [ "$video_rc" -eq 0 ]; then pass=$((pass + 1)); fi
done
echo "[panel-steady] $pass/$RUNS 통과 (영상·로그: $OUT)"
[ "$pass" -eq "$RUNS" ]
