#!/usr/bin/env bash
# =============================================================================
# scripts/verify_realtime_live.sh — MOMO-196 realtime WebSocket live gate
#
# Prereq:
#   make up
#   make migrate
#
# Verifies the live subscribe path against the Docker Desktop dev stack:
#   realtime-token -> Centrifugo WebSocket subscribe -> REST send
#   -> OutboxRelay publish -> live publication received by the subscriber.
#
# The dev Centrifugo config sends subscribe-proxy callbacks to `api:8080`.
# This verifier attaches a tiny Python TCP proxy container to the compose network
# with network alias `api`, forwarding those callbacks to the host MomoServer.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "[realtime-live] FAIL: $*" >&2
  if [ "${SERVER_LOG:-}" != "" ] && [ -f "$SERVER_LOG" ]; then
    echo "[realtime-live] server log: $SERVER_LOG" >&2
    tail -160 "$SERVER_LOG" >&2 || true
  fi
  if [ "${RELAY_LOG:-}" != "" ] && [ -f "$RELAY_LOG" ]; then
    echo "[realtime-live] relay log: $RELAY_LOG" >&2
    tail -160 "$RELAY_LOG" >&2 || true
  fi
  if [ "${PROXY_LOG:-}" != "" ] && [ -f "$PROXY_LOG" ]; then
    echo "[realtime-live] api proxy log: $PROXY_LOG" >&2
    cat "$PROXY_LOG" >&2 || true
  fi
  if [ "${PY_LOG:-}" != "" ] && [ -f "$PY_LOG" ]; then
    echo "[realtime-live] websocket log: $PY_LOG" >&2
    cat "$PY_LOG" >&2 || true
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
require_bin docker
require_bin jq
require_bin python3
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

PORT="${PORT:-8080}"
CENT_PORT="${CENT_PORT:-8000}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-momo}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-momo}"
POSTGRES_USER="${POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-momo}"
CENT_API_KEY="${CENT_API_KEY:-dev-insecure-cent-api-key}"
CENT_API_URL="${CENT_API_URL:-http://localhost:${CENT_PORT}/api}"
case "$CENT_API_URL" in
  *centrifugo*) CENT_API_URL="http://localhost:${CENT_PORT}/api" ;;
esac
JWT_HMAC="${JWT_HMAC:-dev-insecure-jwt-hmac-change-me}"
CENT_TOKEN_HMAC="${CENT_TOKEN_HMAC:-dev-insecure-cent-token-hmac}"
RELAY_POLL_INTERVAL_MS="${RELAY_POLL_INTERVAL_MS:-100}"

ADMIN_DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}}"
APP_DATABASE_URL="postgres://momo_app:momo_app_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
RELAY_DATABASE_URL="postgres://momo_relay:momo_relay_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
COMPOSE_NETWORK="${COMPOSE_PROJECT_NAME}_default"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
HUMAN_EMAIL="demo@momo.local"
CENT_CHANNEL="ch:ws${WORKSPACE_ID}.${CHANNEL_ID}"
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MESSAGE_BODY="MOMO-196 realtime live gate ${RUN_SUFFIX}"

TMP_ROOT="${TMPDIR:-/tmp}"
SERVER_LOG="${TMP_ROOT}/momo-realtime-live-server-${RUN_SUFFIX}.log"
RELAY_LOG="${TMP_ROOT}/momo-realtime-live-relay-${RUN_SUFFIX}.log"
PROXY_LOG="${TMP_ROOT}/momo-realtime-live-api-proxy-${RUN_SUFFIX}.log"
PY_LOG="${TMP_ROOT}/momo-realtime-live-ws-${RUN_SUFFIX}.log"
EVIDENCE_FILE="${TMP_ROOT}/momo-realtime-live-evidence-${RUN_SUFFIX}.md"
LIVE_JSON="${TMP_ROOT}/momo-realtime-live-publication-${RUN_SUFFIX}.json"
SERVER_PID=""
RELAY_PID=""
PROXY_CONTAINER="momo-realtime-live-api-proxy-${RUN_SUFFIX}"

cleanup() {
  if [ "${RELAY_PID:-}" != "" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
  fi
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  docker rm -f "$PROXY_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1"
  local name="$2"
  local deadline
  deadline=$(($(date +%s) + 600))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl --max-time 2 -fsS "$url" >/dev/null 2>&1; then
      echo "[realtime-live] ${name} ready: ${url}"
      return 0
    fi
    sleep 2
  done
  fail "${name} did not become ready: ${url}"
}

wait_tcp() {
  local host="$1"
  local port="$2"
  local name="$3"
  local deadline
  deadline=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys
with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=2):
    pass
PY
    then
      echo "[realtime-live] ${name} ready: ${host}:${port}"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not open TCP port: ${host}:${port}"
}

wait_log_pattern() {
  local file="$1"
  local pattern="$2"
  local name="$3"
  local pid="${4:-}"
  local deadline
  deadline=$(($(date +%s) + 300))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$pid" != "" ] && ! kill -0 "$pid" 2>/dev/null; then
      fail "${name} exited before readiness pattern: ${pattern}"
    fi
    if [ -f "$file" ] && grep -Eq "$pattern" "$file"; then
      echo "[realtime-live] ${name} ready"
      return 0
    fi
    sleep 1
  done
  fail "${name} did not log readiness pattern: ${pattern}"
}

psql_admin() {
  "$PSQL_BIN" "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

echo "[realtime-live] using env file: ${ENV_FILE:-<none>}"
echo "[realtime-live] compose project=${COMPOSE_PROJECT_NAME} api port=${PORT} centrifugo port=${CENT_PORT} postgres port=${POSTGRES_PORT}"
wait_tcp "127.0.0.1" "$CENT_PORT" "Centrifugo"

echo "[realtime-live] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null

echo "[realtime-live] starting MomoServer on host"
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

echo "[realtime-live] attaching api network proxy for Centrifugo subscribe callbacks"
docker rm -f "$PROXY_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm \
  --name "$PROXY_CONTAINER" \
  --network "$COMPOSE_NETWORK" \
  --network-alias api \
  -e TARGET_HOST=host.docker.internal \
  -e TARGET_PORT="$PORT" \
  python:3.12-slim \
  python3 -u -c '
import os, socket, threading
target = (os.environ["TARGET_HOST"], int(os.environ["TARGET_PORT"]))
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("0.0.0.0", 8080))
listener.listen(64)
print(f"proxy listening on 0.0.0.0:8080 -> {target[0]}:{target[1]}", flush=True)
def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass
while True:
    client, _ = listener.accept()
    upstream = socket.create_connection(target, timeout=10)
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()
' >"$PROXY_LOG"

echo "[realtime-live] starting OutboxRelay on host"
(
  cd "$REPO_ROOT"
  RELAY_DATABASE_URL="$RELAY_DATABASE_URL" \
  CENT_API_URL="$CENT_API_URL" \
  CENT_API_KEY="$CENT_API_KEY" \
  RELAY_POLL_INTERVAL_MS="$RELAY_POLL_INTERVAL_MS" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  swift run --package-path relay/OutboxRelay OutboxRelay
) >"$RELAY_LOG" 2>&1 &
RELAY_PID=$!
wait_log_pattern "$RELAY_LOG" "outbox relay starting" "OutboxRelay" "$RELAY_PID"

echo "[realtime-live] logging in seeded demo user"
LOGIN_JSON="$(
  curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${HUMAN_EMAIL}\",\"password\":\"dev-password\",\"workspace\":\"${WORKSPACE_ID}\"}" \
    "http://127.0.0.1:${PORT}/v1/auth/login"
)"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken // empty')"
MEMBER_ID="$(printf '%s' "$LOGIN_JSON" | jq -r '.member.id // empty')"
if [ "$ACCESS_TOKEN" = "" ] || [ "$MEMBER_ID" = "" ]; then
  fail "login did not return access token/member id: ${LOGIN_JSON}"
fi

echo "[realtime-live] requesting Centrifugo connection JWT"
REALTIME_JSON="$(
  curl -fsS \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "http://127.0.0.1:${PORT}/v1/auth/realtime-token"
)"
REALTIME_TOKEN="$(printf '%s' "$REALTIME_JSON" | jq -r '.token // empty')"
TOKEN_TYPE="$(printf '%s' "$REALTIME_JSON" | jq -r '.tokenType // empty')"
TTL_SECONDS="$(printf '%s' "$REALTIME_JSON" | jq -r '.ttlSeconds // empty')"
if [ "$REALTIME_TOKEN" = "" ] || [ "$TOKEN_TYPE" != "centrifugo.connection.jwt" ]; then
  fail "realtime-token response missing Centrifugo token: ${REALTIME_JSON}"
fi

echo "[realtime-live] opening WebSocket subscriber and sending REST message"
set +e
PY_OUT="$(
  REALTIME_TOKEN="$REALTIME_TOKEN" \
  ACCESS_TOKEN="$ACCESS_TOKEN" \
  API_BASE_URL="http://127.0.0.1:${PORT}" \
  CENT_WS_URL="ws://127.0.0.1:${CENT_PORT}/connection/websocket?format=json" \
  CHANNEL="$CENT_CHANNEL" \
  WORKSPACE_ID="$WORKSPACE_ID" \
  CHANNEL_ID="$CHANNEL_ID" \
  CLIENT_MSG_ID="$CLIENT_MSG_ID" \
  MESSAGE_BODY="$MESSAGE_BODY" \
  python3 - <<'PY' 2>"$PY_LOG"
import base64
import hashlib
import json
import os
import secrets
import socket
import struct
import time
import urllib.parse
import urllib.request


class WS:
    def __init__(self, url, timeout=10):
        self.url = urllib.parse.urlparse(url)
        self.timeout = timeout
        port = self.url.port or (443 if self.url.scheme == "wss" else 80)
        if self.url.scheme == "wss":
            raise RuntimeError("wss is not supported by this stdlib verifier")
        self.sock = socket.create_connection((self.url.hostname, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        path = self.url.path or "/"
        if self.url.query:
            path += "?" + self.url.query
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {self.url.hostname}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).encode()
        self.sock.sendall(req)
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake closed")
            response += chunk
        status = response.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise RuntimeError(f"websocket handshake failed: {status.decode(errors='replace')}")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def send_json(self, obj):
        data = (json.dumps(obj, separators=(",", ":")) + "\n").encode()
        mask = secrets.token_bytes(4)
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", n))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def recv_text(self, deadline):
        while time.time() < deadline:
            self.sock.settimeout(max(0.1, min(self.timeout, deadline - time.time())))
            first = self.sock.recv(2)
            if not first:
                raise RuntimeError("websocket closed")
            b1, b2 = first
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length) if length else b""
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("websocket close frame")
            if opcode == 0x9:
                self._send_control(0xA, payload)
                continue
            if opcode == 0x1:
                return payload.decode()
        raise TimeoutError("timed out waiting for websocket text frame")

    def _send_control(self, opcode, payload):
        if len(payload) > 125:
            payload = payload[:125]
        mask = secrets.token_bytes(4)
        header = bytearray([0x80 | opcode, 0x80 | len(payload)])
        header.extend(mask)
        header.extend(bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        self.sock.sendall(bytes(header))

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("websocket closed while reading frame")
            buf += chunk
        return buf


def iter_json_messages(text):
    for line in text.splitlines():
        line = line.strip()
        if line:
            yield json.loads(line)


def wait_for(ws, predicate, timeout=20):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        for msg in iter_json_messages(ws.recv_text(deadline)):
            print("ws:", json.dumps(msg, sort_keys=True), file=os.sys.stderr)
            seen.append(msg)
            if predicate(msg):
                return msg
    raise TimeoutError("condition not met; seen=" + json.dumps(seen[-8:], sort_keys=True))


def command_error(msg, command_id):
    return msg.get("id") == command_id and msg.get("error")


def command_ok(msg, command_id, key):
    return msg.get("id") == command_id and key in msg and not msg.get("error")


def publication_for(msg, channel, message_id, seq):
    push = msg.get("push") or {}
    pub = push.get("pub") or {}
    data = pub.get("data") or {}
    payload = data.get("payload") or {}
    return (
        push.get("channel") == channel
        and data.get("type") == "message.new"
        and payload.get("id") == message_id
        and payload.get("seq") == seq
    )


def verify_invalid_token(ws_url):
    ws = WS(ws_url)
    try:
        ws.send_json({"id": 1, "connect": {"token": "invalid.jwt.for.momo.live.gate"}})
        msg = wait_for(ws, lambda m: msg_for_invalid_connect(m), timeout=8)
        if command_error(msg, 1):
            return {"ok": True, "error": msg.get("error")}
        return {
            "ok": False,
            "error": {
                "message": "invalid token was accepted or did not return an error",
                "message_seen": msg,
            },
        }
    except TimeoutError as exc:
        return {"ok": False, "error": {"message": f"timed out waiting for invalid token rejection: {exc}"}}
    except Exception as exc:
        message = str(exc)
        if "websocket close" in message or "websocket closed" in message or "handshake failed" in message:
            return {"ok": True, "error": {"message": message}}
        return {"ok": False, "error": {"message": message}}
    finally:
        ws.close()


def msg_for_invalid_connect(msg):
    return msg.get("id") == 1 and (msg.get("error") or msg.get("connect"))


def post_json(url, token, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode())


ws_url = os.environ["CENT_WS_URL"]
channel = os.environ["CHANNEL"]
token = os.environ["REALTIME_TOKEN"]
access_token = os.environ["ACCESS_TOKEN"]
api_base = os.environ["API_BASE_URL"]
workspace_id = os.environ["WORKSPACE_ID"]
channel_id = os.environ["CHANNEL_ID"]
client_msg_id = os.environ["CLIENT_MSG_ID"]
body = os.environ["MESSAGE_BODY"]

invalid = verify_invalid_token(ws_url)

ws = WS(ws_url)
try:
    ws.send_json({
        "id": 1,
        "connect": {
            "token": token,
            "name": "momo-realtime-live-verifier",
            "version": "0.0.1",
        },
    })
    connect_msg = wait_for(ws, lambda m: command_ok(m, 1, "connect"), timeout=20)
    ws.send_json({"id": 2, "subscribe": {"channel": channel, "recover": False}})
    subscribe_msg = wait_for(ws, lambda m: command_ok(m, 2, "subscribe"), timeout=20)

    send = post_json(
        f"{api_base}/v1/workspaces/{workspace_id}/channels/{channel_id}/messages",
        access_token,
        {
            "clientMsgId": client_msg_id,
            "type": "text",
            "body": body,
            "props": {"gate": "MOMO-196"},
        },
    )
    message_id = send["id"]
    seq = send["seq"]
    live = wait_for(ws, lambda m: publication_for(m, channel, message_id, seq), timeout=60)
    pub = live["push"]["pub"]
    data = pub["data"]
    result = {
        "invalid_token": invalid,
        "connect": connect_msg.get("connect", {}),
        "subscribe": subscribe_msg.get("subscribe", {}),
        "send": send,
        "publication": {
            "channel": live["push"]["channel"],
            "offset": pub.get("offset"),
            "data": data,
        },
        "version_equivalent": {
            "message_seq": seq,
            "payload_message_seq": data["payload"]["seq"],
            "publication_offset": pub.get("offset"),
        },
    }
    print(json.dumps(result, sort_keys=True))
finally:
    ws.close()
PY
)"
PY_CODE=$?
set -e
if [ "$PY_CODE" -ne 0 ]; then
  fail "websocket live verifier failed (exit ${PY_CODE})"
fi
printf '%s\n' "$PY_OUT" >"$LIVE_JSON"

MESSAGE_ID="$(jq -r '.send.id' "$LIVE_JSON")"
MESSAGE_SEQ="$(jq -r '.send.seq' "$LIVE_JSON")"
PAYLOAD_SEQ="$(jq -r '.publication.data.payload.seq' "$LIVE_JSON")"
EVENT_TYPE="$(jq -r '.publication.data.type' "$LIVE_JSON")"
PUB_OFFSET="$(jq -r '.publication.offset // empty' "$LIVE_JSON")"
INVALID_OK="$(jq -r '.invalid_token.ok' "$LIVE_JSON")"
if [ "$EVENT_TYPE" != "message.new" ]; then
  fail "expected live event type message.new, got ${EVENT_TYPE}"
fi
if [ "$MESSAGE_SEQ" = "" ] || [ "$MESSAGE_SEQ" != "$PAYLOAD_SEQ" ]; then
  fail "message seq and payload seq mismatch: message=${MESSAGE_SEQ} payload=${PAYLOAD_SEQ}"
fi
if [ "$INVALID_OK" != "true" ]; then
  fail "invalid token path did not fail as expected"
fi

{
  echo "## MOMO-196 Realtime Live Evidence"
  echo "- Result: PASS"
  echo "- Stack: dev compose project \`${COMPOSE_PROJECT_NAME}\`, host api=\`http://127.0.0.1:${PORT}\`, centrifugo=\`ws://127.0.0.1:${CENT_PORT}\`, subscribe proxy alias=\`api:8080\`"
  echo "- Login: member_id=\`${MEMBER_ID}\`, workspace_id=\`${WORKSPACE_ID}\`"
  echo "- Realtime token: type=\`${TOKEN_TYPE}\`, ttl_seconds=\`${TTL_SECONDS}\`, token_len=\`${#REALTIME_TOKEN}\`"
  echo "- Subscribe: channel=\`${CENT_CHANNEL}\`"
  echo "- REST send: message_id=\`${MESSAGE_ID}\`, seq=\`${MESSAGE_SEQ}\`, client_msg_id=\`${CLIENT_MSG_ID}\`"
  echo "- Live publication: type=\`${EVENT_TYPE}\`, payload.message.seq=\`${PAYLOAD_SEQ}\`, publication_offset=\`${PUB_OFFSET:-n/a}\`"
  echo "- Version evidence: \`message.seq=${MESSAGE_SEQ}\` equals \`payload.message.seq=${PAYLOAD_SEQ}\`; Centrifugo publication offset \`${PUB_OFFSET:-n/a}\` captured as transport position."
  echo "- Negative path: invalid Centrifugo connection token rejected before subscribe."
  echo "- Evidence files: publication=\`${LIVE_JSON}\`, websocket_log=\`${PY_LOG}\`, server_log=\`${SERVER_LOG}\`, relay_log=\`${RELAY_LOG}\`, api_proxy_log=\`${PROXY_LOG}\`"
} >"$EVIDENCE_FILE"

cat "$EVIDENCE_FILE"
echo "[realtime-live] MOMO-196 realtime live gate PASS"
