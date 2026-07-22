#!/usr/bin/env bash
# MOMO-534: real momo gateway + mock eve runtime roundtrip.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT_NAME="momo534$$"
API_CONTAINER="momo-534-api-$$"
API_PORT=${MOMO_CHANNEL_API_PORT:-28120}
POSTGRES_PORT=${MOMO_CHANNEL_POSTGRES_PORT:-28121}
CENT_PORT=${MOMO_CHANNEL_CENT_PORT:-28122}
HERMES_PORT=${MOMO_CHANNEL_HERMES_PORT:-28123}
BASE_URL="http://127.0.0.1:${API_PORT}"
POSTGRES_PASSWORD="momo-534-postgres-verifier"

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[momo-channel] missing required command: $1" >&2
    exit 1
  }
}

require_bin docker
require_bin node
require_bin npm
require_bin curl
require_bin lsof

compose() {
  POSTGRES_PORT="$POSTGRES_PORT" \
  CENT_PORT="$CENT_PORT" \
  HERMES_PORT="$HERMES_PORT" \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  docker rm -f "$API_CONTAINER" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for port in "$API_PORT" "$POSTGRES_PORT" "$CENT_PORT" "$HERMES_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[momo-channel] port already in use: $port" >&2
    exit 1
  fi
done

echo "[momo-channel] starting isolated e2e dependencies on ${API_PORT}-${HERMES_PORT}"
compose up -d postgres centrifugo mock-hermes
compose run --rm migrate
compose run --rm db-roles

compose run -d --no-deps \
  --name "$API_CONTAINER" \
  -p "${API_PORT}:8080" \
  -e AGENT_GATEWAY_MODE=gateway \
  -e AGENT_GATEWAY_SECRET=momo-534-legacy-disabled-placeholder \
  -e RATE_LIMIT_PER_MEMBER=0 \
  -e RATE_LIMIT_PER_IP=0 \
  api >/dev/null

deadline=$(($(date +%s) + 180))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  echo "[momo-channel] MomoServer did not become ready" >&2
  docker logs --tail 120 "$API_CONTAINER" >&2 || true
  exit 1
fi

(
  cd "$REPO_ROOT/examples/eve-momo-channel"
  npm run build >/dev/null
  MOMO_BASE_URL="$BASE_URL" node dist/verify/mock-eve-runtime.js
)
