#!/usr/bin/env bash
# MOMO-470 / ADR-0122 V-2: prove a V-1 join JWT is accepted by real LiveKit.
# Intentionally excluded from local_gate/runtime-db: LiveKit is a heavy opt-in
# profile. Gate inclusion is reconsidered in V-3 when a client consumes media.
# Docker execution belongs to momo-main; workers run static checks and bash -n.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[huddle-livekit] missing $1" >&2; exit 1; }; }
need docker
need curl
need uuidgen

PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"
    break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "[huddle-livekit] missing python >= 3.10" >&2; exit 1; }

RUNTIME_COMPOSE="$REPO_ROOT/infra/docker-compose.yml"
E2E_COMPOSE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_ID="$(date -u +%s)-$$"
LIVEKIT_PROJECT="${HUDDLE_LIVEKIT_PROJECT:-momo470livekit}"
API_PROJECT="${HUDDLE_LIVEKIT_API_PROJECT:-momo470api}"
API_PORT="${HUDDLE_LIVEKIT_API_PORT:-19870}"
PG_PORT="${HUDDLE_LIVEKIT_POSTGRES_PORT:-19871}"
CENT_PORT_HOST="${HUDDLE_LIVEKIT_CENT_PORT:-19872}"
HERMES_PORT_HOST="${HUDDLE_LIVEKIT_HERMES_PORT:-19873}"
LIVEKIT_PORT_HOST="${HUDDLE_LIVEKIT_PORT:-19874}"
LIVEKIT_TCP_PORT_HOST="${HUDDLE_LIVEKIT_TCP_PORT:-19875}"
LIVEKIT_UDP_START="${HUDDLE_LIVEKIT_UDP_START:-50100}"
LIVEKIT_UDP_END="${HUDDLE_LIVEKIT_UDP_END:-50200}"
BOOT_TIMEOUT="${HUDDLE_LIVEKIT_BOOT_TIMEOUT:-2400}"
TMP_DIR="${TMPDIR:-/tmp}/momo-huddle-livekit-$RUN_ID"
mkdir -p "$TMP_DIR"

LIVEKIT_API_KEY="huddle-livekit-key"
LIVEKIT_API_SECRET="huddle-livekit-secret-$RUN_ID"
LIVEKIT_URL="ws://127.0.0.1:$LIVEKIT_PORT_HOST"
API_OVERRIDE="$TMP_DIR/api-livekit-env.yml"
cat >"$API_OVERRIDE" <<YAML
services:
  api:
    environment:
      MOMO_LIVEKIT_API_KEY: "$LIVEKIT_API_KEY"
      MOMO_LIVEKIT_API_SECRET: "$LIVEKIT_API_SECRET"
      MOMO_LIVEKIT_URL: "$LIVEKIT_URL"
YAML

livekit_compose() {
  MOMO_LIVEKIT_API_KEY="$LIVEKIT_API_KEY" MOMO_LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
  LIVEKIT_PORT="$LIVEKIT_PORT_HOST" LIVEKIT_RTC_TCP_PORT="$LIVEKIT_TCP_PORT_HOST" \
  LIVEKIT_RTC_UDP_START="$LIVEKIT_UDP_START" LIVEKIT_RTC_UDP_END="$LIVEKIT_UDP_END" \
    docker compose -p "$LIVEKIT_PROJECT" -f "$RUNTIME_COMPOSE" --profile huddle "$@"
}

api_compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$API_PROJECT" -f "$E2E_COMPOSE" -f "$API_OVERRIDE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${HUDDLE_LIVEKIT_KEEP:-0}" = "1" ]; then
    echo "[huddle-livekit] leaving compose projects '$LIVEKIT_PROJECT' and '$API_PROJECT' up"
  else
    api_compose down -v --remove-orphans >/dev/null 2>&1 || true
    livekit_compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[huddle-livekit] booting opt-in LiveKit profile '$LIVEKIT_PROJECT'"
livekit_compose up -d livekit
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -sS -o /dev/null "http://127.0.0.1:$LIVEKIT_PORT_HOST/"; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    livekit_compose logs --tail 120 livekit >&2 || true
    echo "[huddle-livekit] LiveKit readiness timeout" >&2
    exit 1
  fi
  if [ -n "$(livekit_compose ps -aq --status exited livekit 2>/dev/null)" ]; then
    livekit_compose logs --tail 120 livekit >&2 || true
    echo "[huddle-livekit] LiveKit exited" >&2
    exit 1
  fi
  sleep 2
done

echo "[huddle-livekit] booting isolated V-1 API stack '$API_PROJECT'"
api_compose up -d api
BASE_URL="http://127.0.0.1:$API_PORT"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    api_compose logs --tail 120 api >&2 || true
    echo "[huddle-livekit] API health timeout" >&2
    exit 1
  fi
  if [ -n "$(api_compose ps -aq --status exited api 2>/dev/null)" ]; then
    api_compose logs --tail 120 api >&2 || true
    echo "[huddle-livekit] API exited" >&2
    exit 1
  fi
  sleep 3
done

WS_ID="00000000-0000-7000-8000-000000000001"
CH_ID="00000000-0000-7000-8000-000000000201"
MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
EMAIL="huddle-livekit-$RUN_ID@momo.local"
PASSWORD="huddle-livekit-$(uuidgen | tr '[:upper:]' '[:lower:]')"

api_compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
  -v ON_ERROR_STOP=1 --no-psqlrc -q <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$MEMBER_ID', '$WS_ID', 'human', 'active', 'LiveKit Verify', 'livekit-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$MEMBER_ID', '$WS_ID', '$EMAIL', true, momo_password_hash('$PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID', '$CH_ID', '$MEMBER_ID', 'member');
COMMIT;
SQL

LOGIN_JSON="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
  --data "$("$PYTHON_BIN" -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2],"workspace":sys.argv[3]}))' "$EMAIL" "$PASSWORD" "$WS_ID")")"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')"

START_JSON="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/channels/$CH_ID/huddles" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ACCESS_TOKEN")"
HUDDLE_ID="$(printf '%s' "$START_JSON" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["huddle"]["id"])')"
JOIN_JSON="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/huddles/$HUDDLE_ID/join" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ACCESS_TOKEN")"
LIVEKIT_TOKEN="$(printf '%s' "$JOIN_JSON" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["token"])')"

VALID_STATUS="$(curl -sS -o "$TMP_DIR/valid.out" -w '%{http_code}' --get \
  --data-urlencode "access_token=$LIVEKIT_TOKEN" "http://127.0.0.1:$LIVEKIT_PORT_HOST/rtc/validate")"
[ "$VALID_STATUS" = "200" ] || {
  echo "[huddle-livekit] FAIL valid V-1 JWT: expected HTTP 200, got $VALID_STATUS" >&2
  exit 1
}

INVALID_STATUS="$(curl -sS -o "$TMP_DIR/invalid.out" -w '%{http_code}' --get \
  --data-urlencode 'access_token=invalid.jwt.token' "http://127.0.0.1:$LIVEKIT_PORT_HOST/rtc/validate")"
case "$INVALID_STATUS" in
  401|403) ;;
  *)
    echo "[huddle-livekit] FAIL invalid JWT: expected HTTP 401/403, got $INVALID_STATUS" >&2
    exit 1
    ;;
esac

echo "MOMO-470 V-1 JWT accepted by LiveKit (200); invalid JWT rejected ($INVALID_STATUS) PASS"
