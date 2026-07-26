#!/usr/bin/env bash
# =============================================================================
# scripts/verify_ios_wire.sh — MOMO-631 iOS message live-wire gate
#
# Boots an isolated PG18 + MomoServer stack, creates one disposable human
# fixture, then runs the public MomoiOSKit login -> send -> history -> replay
# path. The test sends the bytes encoded by IOSSendMessageRequest itself; no
# shell-built message JSON can make this gate pass.
#
# Reserved ports: 28320 (API), 28321 (mock Hermes), 28322 (Postgres),
#                 28323 (Centrifugo). schema_v0.sql is never modified.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[ios-wire] $*"; }
need() { command -v "$1" >/dev/null 2>&1 || { log "missing $1"; exit 1; }; }

need docker
need curl
need python3
need swift

API_PORT="${IOS_WIRE_API_PORT:-28320}"
HERMES_PORT="${IOS_WIRE_HERMES_PORT:-28321}"
PG_PORT="${IOS_WIRE_POSTGRES_PORT:-28322}"
CENTRIFUGO_PORT="${IOS_WIRE_CENTRIFUGO_PORT:-28323}"

python3 - "$API_PORT" "$HERMES_PORT" "$PG_PORT" "$CENTRIFUGO_PORT" <<'PY'
import socket
import sys

ports = [int(value) for value in sys.argv[1:]]
if len(set(ports)) != len(ports):
    raise SystemExit(f"[ios-wire] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[ios-wire] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

if git diff --name-only HEAD | grep -qx 'schema_v0.sql'; then
  log 'schema_v0.sql must not be modified'
  exit 1
fi

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${IOS_WIRE_PROJECT:-momo631ioswire}"
BOOT_TIMEOUT="${IOS_WIRE_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
WORKSPACE_ID='00000000-0000-7000-8000-000000000001'
CHANNEL_ID='00000000-0000-7000-8000-000000000201'
MEMBER_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
EMAIL="ios-wire-${RUN_ID}@momo.local"
PASSWORD="ios-wire-$(python3 -c 'import uuid; print(uuid.uuid4())')"
HANDLE="ios-wire-${RUN_ID}"

compose() {
  PORT="$API_PORT" \
  HERMES_PORT="$HERMES_PORT" \
  POSTGRES_PORT="$PG_PORT" \
  CENT_PORT="$CENTRIFUGO_PORT" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${IOS_WIRE_KEEP:-0}" = '1' ]; then
    log "IOS_WIRE_KEEP=1 — leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The API container copies these packages from the read-only source mount.
# Host SwiftPM symlinks are not readable by Linux cp, while the container has
# its own scratch build volumes, so discard only reproducible local artifacts.
for build_dir in \
  "$REPO_ROOT/server/.build" \
  "$REPO_ROOT/services/OutboundHTTPPolicy/.build" \
  "$REPO_ROOT/services/MomoMetrics/.build"; do
  rm -rf -- "$build_dir"
done

BASE_URL="http://127.0.0.1:$API_PORT"
log "booting isolated compose project '$PROJECT' on ${API_PORT}/${HERMES_PORT}/${PG_PORT}/${CENTRIFUGO_PORT}"
compose up -d api

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    log 'api health timeout'
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    log 'api exited before health'
    exit 1
  fi
  sleep 3
done
log 'api health green'

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}

# This fixture is created per run. No existing email, password hash, or login
# credential is read or reused by this gate.
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$MEMBER_ID', '$WORKSPACE_ID', 'human', 'active', 'iOS Wire Smoke', '$HANDLE');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$MEMBER_ID', '$WORKSPACE_ID', '$EMAIL', true,
        momo_password_hash('$PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WORKSPACE_ID', '$CHANNEL_ID', '$MEMBER_ID', 'member');
COMMIT;
SQL

log 'running public MomoiOSKit login -> send -> history -> idempotent replay test'
MOMO_IOS_WIRE_BASE_URL="$BASE_URL" \
MOMO_IOS_WIRE_EMAIL="$EMAIL" \
MOMO_IOS_WIRE_PASSWORD="$PASSWORD" \
MOMO_IOS_WIRE_CHANNEL_ID="$CHANNEL_ID" \
swift test --package-path clients/iOS/MomoiOSKit --filter IOSMessageLiveWireTests

log 'PASS: actual iOS request bytes accepted; persisted seq/history and idempotency verified'
