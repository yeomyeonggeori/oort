#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MOMO_LINKSHORT_PORT:-28190}"
TARGET_BASE_URL="${MOMO_LINKSHORT_TARGET_BASE_URL:-http://127.0.0.1:39090}"
LOG_FILE="${TMPDIR:-/tmp}/momo-linkshort-${PORT}.log"
HEADER_FILE="${TMPDIR:-/tmp}/momo-linkshort-${PORT}.headers"
LINKSHORT_PID=""
BIN_PATH="$(cd "$REPO_ROOT/services/LinkShort" && swift build --disable-sandbox --show-bin-path)"

cleanup() {
  if [ -n "$LINKSHORT_PID" ] && kill -0 "$LINKSHORT_PID" 2>/dev/null; then
    kill "$LINKSHORT_PID" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$LINKSHORT_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$LINKSHORT_PID" 2>/dev/null; then
      kill -KILL "$LINKSHORT_PID" 2>/dev/null || true
    fi
    wait "$LINKSHORT_PID" 2>/dev/null || true
  fi
  LINKSHORT_PID=""
  rm -f "$HEADER_FILE"
}
trap cleanup EXIT INT TERM HUP

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "verify_linkshort: port $PORT is already in use" >&2
  exit 1
fi

MOMO_LINKSHORT_TARGET_BASE_URL="$TARGET_BASE_URL" \
  MOMO_LINKSHORT_PORT="$PORT" \
  "$BIN_PATH/LinkShort" >"$LOG_FILE" 2>&1 &
LINKSHORT_PID=$!

health_status=""
for _ in {1..300}; do
  if ! kill -0 "$LINKSHORT_PID" 2>/dev/null; then
    echo "verify_linkshort: service exited before becoming ready" >&2
    tail -80 "$LOG_FILE" >&2 || true
    exit 1
  fi
  health_status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
  [ "$health_status" = "200" ] && break
  sleep 0.1
done
[ "$health_status" = "200" ] || {
  echo "verify_linkshort: /healthz did not return 200" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
}

redirect_status="$(curl -sS -o /dev/null -D "$HEADER_FILE" -w '%{http_code}' "http://127.0.0.1:${PORT}/i/abc")"
[ "$redirect_status" = "302" ] || {
  echo "verify_linkshort: /i/abc returned $redirect_status, expected 302" >&2
  exit 1
}
tr -d '\r' <"$HEADER_FILE" | grep -Fqi "location: ${TARGET_BASE_URL}/join/abc" || {
  echo "verify_linkshort: redirect Location mismatch" >&2
  exit 1
}

invalid_status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/i/bad!code")"
[ "$invalid_status" = "400" ] || {
  echo "verify_linkshort: invalid code returned $invalid_status, expected 400" >&2
  exit 1
}

cleanup
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "verify_linkshort: port $PORT was not released" >&2
  exit 1
fi

echo "verify_linkshort: PASS (healthz=200 redirect=302 invalid=400 port=$PORT released)"
