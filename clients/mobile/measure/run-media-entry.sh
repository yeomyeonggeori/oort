#!/usr/bin/env bash
# 큰 이모티콘·GIF·이미지·링크 카드가 섞인 진짜 대화의 「들어올 때 흔들림」과 「누르기」를 시뮬레이터 녹화로 잰다 (#5451, #5456 폰 몫).
#
#   measure/run-media-entry.sh --udid <udid> --mode entry|taps --channel <채널 id> --server <서버 주소> --email <이메일> [--runs 3] [--out <폴더>] \
#                              [--window 3] [--settle 3] [--static 2 --gif 1]
#
# 비밀번호는 환경 변수 `MEDIA_ENTRY_PASSWORD` 로 건넨다(프로세스 목록에 남지 않게). 흐름은 `maestro/5451-media-entry.yaml`(진입)·`5451-media-taps.yaml`(누르기)이고,
# 녹화한 영상을 `measure/media-rows.mjs` 가 잰다. 종료 코드는 모든 회차가 문턱 안이면 0, 아니면 1 이다(RED/GREEN 은 이 코드로 가른다).
#
# 시뮬레이터를 쓰는 무거운 명령이라 부르는 쪽이 `~/.cache/momo-scratch/bin/sim-locked.sh` 안에서 돌린다. 시드는 `measure/seed-media-lab.py`.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
UDID=""; MODE="entry"; CHANNEL=""; SERVER=""; EMAIL=""; RUNS=1; OUT="${TMPDIR:-/tmp}/media-entry-$$"; WINDOW=3; SETTLE=3; STATIC=2; GIF=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    --settle) SETTLE="$2"; shift 2 ;;
    --static) STATIC="$2"; shift 2 ;;
    --gif) GIF="$2"; shift 2 ;;
    *) echo "[media-entry] 모르는 인자: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$UDID" ] || [ -z "$CHANNEL" ] || [ -z "$SERVER" ] || [ -z "$EMAIL" ] || [ -z "${MEDIA_ENTRY_PASSWORD:-}" ]; then
  echo "[media-entry] --udid --channel --server --email 와 환경 변수 MEDIA_ENTRY_PASSWORD 가 필요해요" >&2
  exit 2
fi
case "$MODE" in
  entry) FLOW="$HERE/../maestro/5451-media-entry.yaml"; TAIL=4 ;;
  taps) FLOW="$HERE/../maestro/5451-media-taps.yaml"; TAIL=3 ;;
  *) echo "[media-entry] --mode 는 entry 나 taps" >&2; exit 2 ;;
esac
export PATH="$HOME/.maestro/bin:$PATH"
mkdir -p "$OUT"
pass=0
for run in $(seq 1 "$RUNS"); do
  video="$OUT/$MODE-$run.mp4"
  rm -f "$video"
  # 앱을 끄고 다시 켠 뒤(흐름의 launchApp) 들어간다 — 같은 앱 프로세스의 메모리 캐시가 회차를 서로 닮게 하지 않는다.
  xcrun simctl terminate "$UDID" app.momo.ios >/dev/null 2>&1
  sleep 1
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$video" >/dev/null 2>&1 &
  recorder=$!
  sleep 1
  maestro --udid "$UDID" test \
    -e SERVER_URL="$SERVER" -e EMAIL="$EMAIL" -e PASSWORD="$MEDIA_ENTRY_PASSWORD" -e CHANNEL_ID="$CHANNEL" \
    "$FLOW" > "$OUT/$MODE-$run.maestro.log" 2>&1
  flow_rc=$?
  sleep "$TAIL"
  kill -INT "$recorder" 2>/dev/null
  wait "$recorder" 2>/dev/null
  if [ "$MODE" = "entry" ]; then
    node "$HERE/media-rows.mjs" "$video" --mode entry --window "$WINDOW" | tee "$OUT/$MODE-$run.json"
  else
    node "$HERE/media-rows.mjs" "$video" --mode taps --static "$STATIC" --gif "$GIF" --settle "$SETTLE" | tee "$OUT/$MODE-$run.json"
  fi
  analysis_rc=${PIPESTATUS[0]}
  echo "[media-entry] 회차 $run/$RUNS: 흐름 rc=$flow_rc 분석 rc=$analysis_rc (0 = 문턱 안)"
  if [ "$flow_rc" -eq 0 ] && [ "$analysis_rc" -eq 0 ]; then pass=$((pass + 1)); fi
done
echo "[media-entry] $MODE: $pass/$RUNS 통과 (영상·로그: $OUT)"
[ "$pass" -eq "$RUNS" ]
