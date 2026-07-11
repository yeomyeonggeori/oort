#!/usr/bin/env bash
# =============================================================================
# scripts/verify_local_hermes_bridge.sh — MOMO-256 Local Hermes Agent Bridge gate
#
# Starts a repo-local OpenAI-compatible SSE mock on loopback, then runs the
# external provider verifier in `external-hermes` mode with `@hermes`. The
# engine owns a fresh marker/OID-bound DB, so this wrapper never writes to the
# source dogfood #agent-lab timeline.
# =============================================================================
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=scripts/runtime_process_guard.sh
. "$REPO_ROOT/scripts/runtime_process_guard.sh"

ENV_FILE="${ENV_FILE:-}"
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE="$candidate"
      break
    fi
  done
fi

if [ "${ENV_FILE:-}" != "" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

HERMES_PORT="${LOCAL_HERMES_BRIDGE_PORT:-${HERMES_PORT:-8088}}"
HERMES_BASE_URL="http://127.0.0.1:${HERMES_PORT}/v1"
HERMES_API_KEY="${LOCAL_HERMES_BRIDGE_API_KEY:-local-hermes-bridge-key}"
BASE_API_PORT="${PORT:-8080}"
case "$BASE_API_PORT" in
  ""|*[!0-9]*) BASE_API_PORT=8080 ;;
esac
# Run the bridge smoke on its own host API port so it can be chained after
# other runtime-agent verifier scripts that may still be releasing PORT.
API_PORT="${LOCAL_HERMES_BRIDGE_API_PORT:-$((BASE_API_PORT + 6))}"
API_BASE_URL="http://127.0.0.1:${API_PORT}"
MOCK_LOG="${TMPDIR:-/tmp}/momo-local-hermes-bridge-mock-$$.log"
MOCK_PID=""

cleanup() {
  momo_cleanup_tracked_pids "local-hermes-bridge verifier" "${MOCK_PID:-}"
}
trap cleanup EXIT INT TERM

momo_cleanup_port_listener "$API_PORT" "local-hermes-bridge API preflight" || {
  echo "[local-hermes-bridge] API port ${API_PORT} is occupied by a non-momo process; choose LOCAL_HERMES_BRIDGE_API_PORT." >&2
  exit 1
}

if ! momo_cleanup_port_listener "$HERMES_PORT" "local-hermes-bridge mock provider preflight"; then
  if [ "${LOCAL_HERMES_BRIDGE_REUSE_EXISTING_PROVIDER:-0}" = "1" ]; then
    echo "[local-hermes-bridge] preserving user-owned loopback provider at ${HERMES_BASE_URL}"
  else
    echo "[local-hermes-bridge] Hermes port ${HERMES_PORT} is occupied by a non-verifier process." >&2
    echo "[local-hermes-bridge] Stop it, choose HERMES_PORT, or set LOCAL_HERMES_BRIDGE_REUSE_EXISTING_PROVIDER=1." >&2
    exit 1
  fi
fi

if curl -fsS "http://127.0.0.1:${HERMES_PORT}/health" >/dev/null 2>&1; then
  echo "[local-hermes-bridge] using existing loopback provider at ${HERMES_BASE_URL}"
else
  echo "[local-hermes-bridge] starting Hermes-compatible SSE mock at ${HERMES_BASE_URL}"
  python3 "$REPO_ROOT/scripts/mock_hermes.py" --host 127.0.0.1 --port "$HERMES_PORT" \
    >"$MOCK_LOG" 2>&1 &
  MOCK_PID=$!
  deadline=$(($(date +%s) + 30))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "http://127.0.0.1:${HERMES_PORT}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:${HERMES_PORT}/health" >/dev/null 2>&1 || {
    echo "[local-hermes-bridge] provider mock did not become ready" >&2
    tail -80 "$MOCK_LOG" >&2 || true
    exit 1
  }
fi

echo "[local-hermes-bridge] running isolated external-hermes verifier against @hermes"
ENV_FILE="$ENV_FILE" \
MOMO_ENV=local \
PORT="$API_PORT" \
BASE_URL="$API_BASE_URL" \
AGENT_PROVIDER_MODE=external-hermes \
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 \
AGENT_MODEL="${AGENT_MODEL:-hermes-agent}" \
AGENT_HANDLE=hermes \
AGENT_DISPLAY_NAME=Hermes \
HERMES_BASE_URL="$HERMES_BASE_URL" \
HERMES_API_KEY="$HERMES_API_KEY" \
EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS=1 \
EXTERNAL_AGENT_PROVIDER_OUT_DIR="${EXTERNAL_AGENT_PROVIDER_OUT_DIR:-${TMPDIR:-/tmp}/momo-local-hermes-bridge}" \
"$REPO_ROOT/scripts/verify_external_agent_provider.sh"
