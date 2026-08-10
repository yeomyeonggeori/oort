#!/usr/bin/env bash
# =============================================================================
# scripts/verify_relay.sh — MOMO-115 OutboxRelay runtime gate
#
# Prereq:
#   make up
#   make migrate
#
# Verifies the canonical relay write path:
#   server send -> outbox pending -> OutboxRelay claim -> Centrifugo publish
#   -> outbox done -> version=message.seq evidence.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "[relay] FAIL: $*" >&2
  if [ "${SERVER_LOG:-}" != "" ] && [ -f "$SERVER_LOG" ]; then
    echo "[relay] server log: $SERVER_LOG" >&2
    tail -120 "$SERVER_LOG" >&2 || true
  fi
  if [ "${RELAY_LOG:-}" != "" ] && [ -f "$RELAY_LOG" ]; then
    echo "[relay] relay log: $RELAY_LOG" >&2
    tail -160 "$RELAY_LOG" >&2 || true
  fi
  if [ "${HISTORY_FILE:-}" != "" ] && [ -f "$HISTORY_FILE" ]; then
    echo "[relay] centrifugo history evidence: $HISTORY_FILE" >&2
    cat "$HISTORY_FILE" >&2 || true
  fi
  exit 1
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

ENV_FILE="${ENV_FILE:-}"
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE="$candidate"
      break
    fi
  done
fi

if [ "$ENV_FILE" != "" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

require_bin curl
require_bin jq
require_bin swift
require_bin uuidgen

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  fail "psql not found; install PostgreSQL client/libpq and retry"
fi

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-momo}"
POSTGRES_USER="${POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-momo}"
PORT="${PORT:-8080}"
CENT_PORT="${CENT_PORT:-8000}"
CENT_API_KEY="${CENT_API_KEY:-dev-insecure-cent-api-key}"
CENT_API_URL="${CENT_API_URL:-http://localhost:${CENT_PORT}/api}"
JWT_HMAC="${JWT_HMAC:-dev-insecure-jwt-hmac-change-me}"
CENT_TOKEN_HMAC="${CENT_TOKEN_HMAC:-dev-insecure-cent-token-hmac}"
RELAY_POLL_INTERVAL_MS="${RELAY_POLL_INTERVAL_MS:-100}"

ADMIN_DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}}"
APP_DATABASE_URL="postgres://momo_app:momo_app_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
RELAY_DATABASE_URL="postgres://momo_relay:momo_relay_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
HUMAN_EMAIL="demo@momo.local"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CENT_CHANNEL="ch:ws${WORKSPACE_ID}.${CHANNEL_ID}"
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MESSAGE_BODY="MOMO-115 relay runtime gate ${RUN_SUFFIX}"

TMP_ROOT="${TMPDIR:-/tmp}"
SERVER_LOG="${TMP_ROOT}/momo-relay-gate-server-${RUN_SUFFIX}.log"
RELAY_LOG="${TMP_ROOT}/momo-relay-gate-relay-${RUN_SUFFIX}.log"
HISTORY_FILE="${TMP_ROOT}/momo-relay-gate-history-${RUN_SUFFIX}.json"
EVIDENCE_FILE="${TMP_ROOT}/momo-relay-gate-evidence-${RUN_SUFFIX}.md"
SERVER_PID=""
RELAY_PID=""

cleanup() {
  if [ "${RELAY_PID:-}" != "" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
  fi
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

psql_admin() {
  "$PSQL_BIN" "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

wait_http() {
  local url="$1"
  local name="$2"
  local deadline
  deadline=$(($(date +%s) + 45))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[relay] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not become ready: ${url}"
}

echo "[relay] using env file: ${ENV_FILE:-<none>}"
echo "[relay] api port=${PORT} centrifugo port=${CENT_PORT} postgres port=${POSTGRES_PORT}"
echo "[relay] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null

echo "[relay] starting MomoServer"
(
  cd "$REPO_ROOT"
  DATABASE_URL="$APP_DATABASE_URL" \
  HOST="127.0.0.1" \
  PORT="$PORT" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  JWT_HMAC="$JWT_HMAC" \
  CENT_TOKEN_HMAC="$CENT_TOKEN_HMAC" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  swift run --package-path server MomoServer
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_http "http://127.0.0.1:${PORT}/health" "MomoServer"

echo "[relay] logging in seeded demo user"
LOGIN_JSON="$(
  curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${HUMAN_EMAIL}\",\"password\":\"dev-password\",\"workspace\":\"${WORKSPACE_ID}\"}" \
    "http://127.0.0.1:${PORT}/v1/auth/login"
)"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken // empty')"
if [ "$ACCESS_TOKEN" = "" ]; then
  fail "login did not return an access token"
fi

echo "[relay] sending message through REST write path"
SEND_JSON="$(
  curl -fsS \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"clientMsgId\":\"${CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":\"${MESSAGE_BODY}\",\"props\":{\"gate\":\"MOMO-115\"}}" \
    "http://127.0.0.1:${PORT}/v1/workspaces/${WORKSPACE_ID}/channels/${CHANNEL_ID}/messages"
)"
MESSAGE_ID="$(printf '%s' "$SEND_JSON" | jq -r '.id // empty')"
MESSAGE_SEQ="$(printf '%s' "$SEND_JSON" | jq -r '.seq // empty')"
if [ "$MESSAGE_ID" = "" ] || [ "$MESSAGE_SEQ" = "" ] || [ "$MESSAGE_SEQ" = "null" ]; then
  fail "message send response missing id/seq: ${SEND_JSON}"
fi
echo "[relay] send returned message_id=${MESSAGE_ID} seq=${MESSAGE_SEQ}"

echo "[relay] verifying outbox pending before relay starts"
OUTBOX_ROW="$(
  psql_admin -t -A -F $'\t' -c "
    SELECT id, status, payload->>'version', payload->>'channel'
      FROM outbox
     WHERE kind='broadcast'
       AND payload->'data'->'payload'->>'id'='${MESSAGE_ID}'
     ORDER BY id DESC
     LIMIT 1;
  "
)"
if [ "$OUTBOX_ROW" = "" ]; then
  fail "REST send did not insert a broadcast outbox row for message ${MESSAGE_ID}"
fi
IFS=$'\t' read -r OUTBOX_ID OUTBOX_STATUS OUTBOX_VERSION OUTBOX_CHANNEL <<<"$OUTBOX_ROW"
if [ "$OUTBOX_STATUS" != "pending" ]; then
  fail "expected outbox status pending before relay, got ${OUTBOX_STATUS}"
fi
if [ "$OUTBOX_VERSION" != "$MESSAGE_SEQ" ]; then
  fail "expected outbox payload version=${MESSAGE_SEQ}, got ${OUTBOX_VERSION}"
fi
if [ "$OUTBOX_CHANNEL" != "$CENT_CHANNEL" ]; then
  fail "expected outbox channel ${CENT_CHANNEL}, got ${OUTBOX_CHANNEL}"
fi
echo "[relay] outbox pending id=${OUTBOX_ID} version=${OUTBOX_VERSION} channel=${OUTBOX_CHANNEL}"

echo "[relay] starting OutboxRelay"
(
  cd "$REPO_ROOT"
  RELAY_DATABASE_URL="$RELAY_DATABASE_URL" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  RELAY_POLL_INTERVAL_MS="$RELAY_POLL_INTERVAL_MS" \
  LOG_LEVEL="${LOG_LEVEL:-debug}" \
  swift run --package-path relay/OutboxRelay OutboxRelay
) >"$RELAY_LOG" 2>&1 &
RELAY_PID=$!

echo "[relay] polling relay claim/done and Centrifugo history"
DONE_OK=0
HISTORY_OK=0
deadline=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    fail "OutboxRelay exited before publishing message ${MESSAGE_ID}"
  fi

  OUTBOX_DONE_ROW="$(
    psql_admin -t -A -F $'\t' -c "
      SELECT status, attempts, payload->>'version', processed_at IS NOT NULL
        FROM outbox
       WHERE id=${OUTBOX_ID};
    "
  )"
  IFS=$'\t' read -r DONE_STATUS DONE_ATTEMPTS DONE_VERSION DONE_PROCESSED <<<"$OUTBOX_DONE_ROW"
  if [ "$DONE_STATUS" = "done" ] \
    && [ "${DONE_ATTEMPTS:-0}" -ge 1 ] \
    && [ "$DONE_VERSION" = "$MESSAGE_SEQ" ] \
    && [ "$DONE_PROCESSED" = "t" ]; then
    DONE_OK=1
  fi

  curl -fsS \
    -H "X-API-Key: ${CENT_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"${CENT_CHANNEL}\",\"limit\":20}" \
    "${CENT_API_URL}/history" >"$HISTORY_FILE" 2>/dev/null || true
  HISTORY_MATCHES="$(
    jq -r --arg id "$MESSAGE_ID" --argjson seq "$MESSAGE_SEQ" '
      [.result.publications[]?.data
       | select(.type == "message.new")
       | select(.seq == $seq)
       | select(.payload.id == $id)
       | select(.payload.seq == $seq)]
      | length
    ' "$HISTORY_FILE" 2>/dev/null || printf '0'
  )"
  if [ "$HISTORY_MATCHES" != "0" ]; then
    HISTORY_OK=1
  fi

  if [ "$DONE_OK" = "1" ] && [ "$HISTORY_OK" = "1" ]; then
    break
  fi
  sleep 1
done

if [ "$DONE_OK" != "1" ]; then
  fail "outbox row ${OUTBOX_ID} did not reach done with attempts>=1 and version=${MESSAGE_SEQ}"
fi
if [ "$HISTORY_OK" != "1" ]; then
  fail "Centrifugo history did not contain message ${MESSAGE_ID} seq=${MESSAGE_SEQ}"
fi

if ! grep -Eq "version=${MESSAGE_SEQ}|version: ${MESSAGE_SEQ}|version\":${MESSAGE_SEQ}|version=${MESSAGE_SEQ}," "$RELAY_LOG"; then
  echo "[relay] relay log did not expose the version metadata; DB payload/version and Centrifugo history still matched." >&2
fi

{
  echo "## MOMO-115 Relay Runtime Evidence"
  echo "- Result: PASS"
  echo "- Server send: message_id=\`${MESSAGE_ID}\`, seq=\`${MESSAGE_SEQ}\`, client_msg_id=\`${CLIENT_MSG_ID}\`"
  echo "- Outbox pending: id=\`${OUTBOX_ID}\`, channel=\`${OUTBOX_CHANNEL}\`, version=\`${OUTBOX_VERSION}\`"
  echo "- Relay claim: attempts=\`${DONE_ATTEMPTS}\`"
  echo "- Outbox done: status=\`${DONE_STATUS}\`, processed_at_set=\`${DONE_PROCESSED}\`, version=\`${DONE_VERSION}\`"
  echo "- Centrifugo history: channel=\`${CENT_CHANNEL}\`, message_id=\`${MESSAGE_ID}\`, seq=\`${MESSAGE_SEQ}\`"
  echo "- Version evidence: \`message.seq=${MESSAGE_SEQ}\` equals \`outbox.payload.version=${OUTBOX_VERSION}\` and the relayed history publication carries the same message id/seq."
  echo "- Logs: server=\`${SERVER_LOG}\`, relay=\`${RELAY_LOG}\`, history=\`${HISTORY_FILE}\`"
} >"$EVIDENCE_FILE"

cat "$EVIDENCE_FILE"
echo "[relay] MOMO-115 relay runtime gate PASS"
