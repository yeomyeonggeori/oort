#!/usr/bin/env bash
# MOMO-559 / ADR-0132 D3-D5 isolated wrapper around the final AgentWorker gate.
# Docker execution belongs to the orchestrator; workers run syntax/build/unit gates.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "[agent-interaction-safety] missing $tool" >&2
    exit 1
  }
done

API_PORT="${AGENT_INTERACTION_API_PORT:-28191}"
HERMES_PORT="${AGENT_INTERACTION_HERMES_PORT:-28192}"
PG_PORT="${AGENT_INTERACTION_POSTGRES_PORT:-28193}"
CENTRIFUGO_PORT="${AGENT_INTERACTION_CENTRIFUGO_PORT:-28194}"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${AGENT_INTERACTION_PROJECT:-momo559-safety-$RUN_TAG}"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"

python3 - "$API_PORT" "$HERMES_PORT" "$PG_PORT" "$CENTRIFUGO_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[agent-interaction-safety] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[agent-interaction-safety] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

compose() {
  POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENTRIFUGO_PORT" \
    POSTGRES_PASSWORD=momo_dev_pw \
    CENT_API_KEY=dev-insecure-cent-api-key \
    CENT_TOKEN_HMAC=dev-insecure-cent-token-hmac \
    CENT_PROXY_SECRET=dev-insecure-cent-proxy-secret \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[agent-interaction-safety] booting isolated Postgres/Centrifugo on $PG_PORT/$CENTRIFUGO_PORT"
compose up -d --wait postgres centrifugo

ENV_FILE=/dev/null \
POSTGRES_HOST=127.0.0.1 \
POSTGRES_PORT="$PG_PORT" \
POSTGRES_USER=momo \
POSTGRES_PASSWORD=momo_dev_pw \
POSTGRES_DB=momo \
PORT="$API_PORT" \
HERMES_PORT="$HERMES_PORT" \
CENT_PORT="$CENTRIFUGO_PORT" \
CENT_API_KEY=dev-insecure-cent-api-key \
CENT_API_URL="http://127.0.0.1:$CENTRIFUGO_PORT/api" \
AGENT_WORKER_VERIFIER_DB="momo_agent_safety_${RUN_TAG//-/_}" \
AGENT_WORKER_VERIFIER_TEST_CLEANUP_ON_EXIT=1 \
scripts/verify_agent_worker.sh

echo "[agent-interaction-safety] PASS depth propagation, G2 durable notice, D4 final consumption"
