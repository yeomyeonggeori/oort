#!/usr/bin/env bash
# 게이트 3 — 스파이크용 Centrifugo + 브로커 기동/정리
#
#   ./run.sh up          Centrifugo + 브로커 기동 (allowed_origins = 레포와 동일)
#   ./run.sh up open     같은 것을 allowed_origins="*" 로 기동
#   ./run.sh down        둘 다 정리 (컨테이너 rm 까지)
#   ./run.sh ip          실기기에서 쓸 LAN 주소 출력
#
# `up` 과 `up open` 의 차이가 게이트 3의 핵심 실측이다:
#   RN 의 WebSocket 은 **Origin 헤더를 보낸다**(= ws URL 자신의 origin).
#   레포의 infra/centrifugo.json `client.allowed_origins` 에는 그 값이 없으므로
#   기본(`up`)에서는 Centrifugo 가 핸드셰이크를 거절하고
#   "request Origin is not authorized" 를 남긴다.
#   `up open` 으로 열면 같은 코드가 그대로 붙는다.
#
# 시크릿은 **매 기동마다 새로 생성**하고 파일에 쓰지 않는다.
# 레포의 .env 나 실서버 자격증명을 읽지 않는다 — 읽을 이유가 없다.
#
# 컨테이너 이름을 못박아 두는 이유: 이 레포는 로컬 게이트 런이 도커 자원을
# 회수 없이 쌓아 온 전례가 있다. `down` 을 반드시 실행해라.
set -euo pipefail

CONTAINER="momo-rn-spike-centrifugo"
CENT_PORT="${SPIKE_CENT_PORT:-18901}"
BROKER_PORT="${SPIKE_BROKER_PORT:-18902}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-up}" in
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "removed $CONTAINER" || echo "$CONTAINER 없음"
    pkill -f "centrifugo-spike/broker.mjs" >/dev/null 2>&1 && echo "broker 종료" || echo "broker 없음"
    exit 0
    ;;
  ip)
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "LAN IP 못 찾음"
    exit 0
    ;;
esac

# 이번 기동 전용 시크릿
SPIKE_CENT_HMAC="$(openssl rand -hex 32)"
SPIKE_CENT_API_KEY="$(openssl rand -hex 32)"
export SPIKE_CENT_HMAC SPIKE_CENT_API_KEY

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

ORIGIN_MODE="${2:-strict}"
ORIGIN_ENV=()
if [ "$ORIGIN_MODE" = "open" ]; then
  ORIGIN_ENV=(-e 'CENTRIFUGO_CLIENT_ALLOWED_ORIGINS=*')
fi

docker run -d --name "$CONTAINER" \
  -p "${CENT_PORT}:8000" \
  -e CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY="$SPIKE_CENT_HMAC" \
  -e CENTRIFUGO_HTTP_API_KEY="$SPIKE_CENT_API_KEY" \
  "${ORIGIN_ENV[@]}" \
  -v "${HERE}/centrifugo.json:/centrifugo/centrifugo.json:ro" \
  centrifugo/centrifugo:v6 \
  centrifugo --config=/centrifugo/centrifugo.json >/dev/null

echo "centrifugo 기동 (allowed_origins=${ORIGIN_MODE}) — ws://127.0.0.1:${CENT_PORT}/connection/websocket"

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${CENT_PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

SPIKE_CENT_HTTP="http://127.0.0.1:${CENT_PORT}" \
SPIKE_BROKER_PORT="${BROKER_PORT}" \
  node "${HERE}/broker.mjs" &

sleep 1
LAN="$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1)"
cat <<EOF

── 게이트 3 준비 완료 ──────────────────────────────
 시뮬레이터에서 쓸 호스트 : 127.0.0.1
 실기기에서 쓸 호스트     : ${LAN}
 Centrifugo WS           : ws://<호스트>:${CENT_PORT}/connection/websocket
 브로커                  : http://<호스트>:${BROKER_PORT}
 끝나면 반드시           : ./run.sh down
────────────────────────────────────────────────
EOF
wait
