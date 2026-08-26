#!/usr/bin/env bash
# #1777 — workd closed loop against a Rust API (not Swift e2e compose).
#
# `scripts/verify_workd.sh` boots `infra/docker-compose.e2e.yml` (Swift server).
# This file is the Rust twin: same spawn scenario (:340-359 of that script),
# but the API is either the already-running rust league or a server built from
# this worktree. The daemon is a Mac-local `momo-workd` process — rust compose
# has no Swift toolchain, a real PTY is native, and the machine under test is
# the maintainer Mac. See docs/runbooks/workd-rust-session.md.
#
# Usage:
#   scripts/verify_workd_rust.sh
#     Target http://127.0.0.1:8080 (league). Expect GREEN (session + attach).
#   WORKD_RUST_EXPECT_RED=1 scripts/verify_workd_rust.sh
#     Same league target; pass only if the daemon's signed create/bind dies at
#     HTTP 400/401/403. That is the pre-#1777 proof.
#   WORKD_RUST_BOOT_LOCAL=1 scripts/verify_workd_rust.sh
#     Throwaway pgvector + `cargo run -p momo-server` from this tree. GREEN.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[workd-rust] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq
if [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PATH="/opt/homebrew/opt/libpq/bin:${PATH}"
  export PATH
fi

find_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
      >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "[workd-rust] Python 3.10+ not found" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
need openssl
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

EXPECT_RED="${WORKD_RUST_EXPECT_RED:-0}"
BOOT_LOCAL="${WORKD_RUST_BOOT_LOCAL:-0}"
ASSERT_TIMEOUT="${WORKD_GATE_ASSERT_TIMEOUT:-240}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-workd-rust.XXXXXX")"
WORKD_PID=""
SERVER_PID=""
PG_CID=""
ATTACH_PROXY_PID=""

WORKD_BIN="${WORKD_GATE_BIN:-$REPO_ROOT/workers/WorkHostDaemon/.build/debug/momo-workd}"
TOOL_KEY="shell"
TOOL_LABEL="MOMO-1777 rust workd"
WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="$(new_uuid)"
OWNER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
RUN_ID="$(new_uuid)"
OWNER_EMAIL="workd-rust-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
RAW_MARKER="MOMO_WORKD_RUST_RAW_${RUN_TAG//-/_}"
ATTACH_LIVE_MARKER="MOMO_WORKD_RUST_LIVE_${RUN_TAG//-/_}"
ATTACH_LIVE_INPUT="echo MOMO_WORKD_RUST_LIVE_''${RUN_TAG//-/_}"

if [ "$BOOT_LOCAL" = "1" ]; then
  API_PORT="${WORKD_RUST_API_PORT:-18770}"
  PG_PORT="${WORKD_RUST_PG_PORT:-18772}"
  BASE_URL="http://127.0.0.1:$API_PORT"
  DATABASE_URL="postgres://momo:momo@127.0.0.1:$PG_PORT/momo"
  SQL_VIA="url"
else
  API_PORT="${WORKD_RUST_API_PORT:-8080}"
  BASE_URL="${WORKD_RUST_API_URL:-http://127.0.0.1:$API_PORT}"
  PG_CONTAINER="${WORKD_RUST_PG_CONTAINER:-oort-postgres-1}"
  SQL_VIA="compose"
fi

ATTACH_MODE="${WORKD_GATE_ATTACH:-}"
if [ -z "$ATTACH_MODE" ]; then
  if [ "$EXPECT_RED" = "1" ]; then
    ATTACH_MODE=0
  else
    ATTACH_MODE=1
  fi
fi
ATTACH_TLS_PORT=$((API_PORT + 71))
ATTACH_PLAIN_PORT=$((API_PORT + 72))
ATTACH_ENDPOINT="wss://127.0.0.1:$ATTACH_TLS_PORT/v1/terminal-attach"
ATTACH_REVALIDATE_MS="${WORKD_GATE_ATTACH_REVALIDATE_MS:-2000}"

note() { printf '[workd-rust] %s\n' "$*"; }
fail() { printf '[workd-rust] FAIL: %s\n' "$*" >&2; exit 1; }

run_sql() {
  if [ "$SQL_VIA" = "url" ]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
  else
    docker exec -i "$PG_CONTAINER" psql -U momo -d momo \
      -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
  fi
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "${ATTACH_PROXY_PID:-}" ] && kill -0 "$ATTACH_PROXY_PID" >/dev/null 2>&1; then
    kill "$ATTACH_PROXY_PID" >/dev/null 2>&1 || true
    wait "$ATTACH_PROXY_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$WORKD_PID" ] && kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    kill "$WORKD_PID" >/dev/null 2>&1 || true
    wait "$WORKD_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$PG_CID" ]; then
    docker rm -f "$PG_CID" >/dev/null 2>&1 || true
  fi
  if [ "${WORKD_GATE_KEEP:-0}" = "1" ]; then
    echo "[workd-rust] leaving evidence: $TMP_DIR"
  else
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-workd-rust.*) rm -rf -- "$TMP_DIR" ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$ATTACH_MODE" = "1" ]; then
  need openssl
  ATTACH_CERT="$TMP_DIR/attach-proxy.crt"
  ATTACH_KEY="$TMP_DIR/attach-proxy.key"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$ATTACH_KEY" -out "$ATTACH_CERT" -days 1 \
    -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1 ||
    fail "openssl could not mint an attach-proxy certificate"
  chmod 600 "$ATTACH_KEY"
fi

if [ ! -x "$WORKD_BIN" ]; then
  need swift
  note "building momo-workd"
  swift build --disable-sandbox --package-path workers/WorkHostDaemon
fi
[ -x "$WORKD_BIN" ] || fail "momo-workd executable unavailable after build"

if [ "$BOOT_LOCAL" = "1" ]; then
  need psql
  note "booting throwaway pgvector + this-tree momo-server on $BASE_URL"
  PG_CID="$(docker run -d --name "momo-1777-pg-$RUN_TAG" \
    -e POSTGRES_USER=momo -e POSTGRES_PASSWORD=momo -e POSTGRES_DB=momo \
    -p "127.0.0.1:$PG_PORT:5432" \
    pgvector/pgvector:pg18)"
  deadline=$(( $(date -u +%s) + 90 ))
  until psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; do
    [ "$(date -u +%s)" -lt "$deadline" ] || fail "throwaway postgres did not become ready"
    sleep 1
  done
  MOMO_AGENT_SEED_MODE=none DATABASE_URL="$DATABASE_URL" sh scripts/migrate.sh \
    >"$TMP_DIR/migrate.log" 2>&1 || {
    tail -40 "$TMP_DIR/migrate.log" >&2
    fail "migrate.sh failed"
  }
  JWT_HMAC="$(openssl rand -hex 32)"
  HOST=127.0.0.1 PORT="$API_PORT" \
    DATABASE_URL="$DATABASE_URL" \
    JWT_HMAC="$JWT_HMAC" \
    MOMO_ENV=local \
    MOMO_CENTRIFUGO_WS_URL="ws://127.0.0.1:8000/connection/websocket" \
    cargo run --manifest-path server-rust/Cargo.toml -p momo-server --quiet \
    >"$TMP_DIR/server.log" 2>&1 &
  SERVER_PID=$!
fi

deadline=$(( $(date -u +%s) + 90 ))
until curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1 || curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    [ -f "$TMP_DIR/server.log" ] && tail -40 "$TMP_DIR/server.log" >&2
    fail "API $BASE_URL never became healthy"
  fi
  if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    tail -40 "$TMP_DIR/server.log" >&2
    fail "local momo-server exited"
  fi
  sleep 1
done
note "API ready at $BASE_URL (expect_red=$EXPECT_RED attach=$ATTACH_MODE boot_local=$BOOT_LOCAL)"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Workd Rust Owner', 'workd-rust-owner-$RUN_TAG'),
  ('$AGENT_ID', '$WS_ID', 'agent', 'active', 'Workd Rust Agent', 'workd-rust-agent-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ID', '$WS_ID', 'hermes-agent', 'http://localhost:8088/v1',
   '#1777 rust workd verifier', '$OWNER_ID');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WS_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$AGENT_ID', 'member');
INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
VALUES ('$CHANNEL_ID', '$WS_ID', 'public', 'hss-1777-$RUN_TAG', '', '$OWNER_ID');
INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('$CHANNEL_ID', '$WS_ID', 0);
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"#1777 rust workd spawn"}'::jsonb, 1, 50, 0,
   'momo-1777-workd-$RUN_TAG');
INSERT INTO work_tool_profile
  (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by)
VALUES
  ('$WS_ID', '$TOOL_KEY', '$TOOL_KEY',
   '{"command":"sh","arguments":[]}'::jsonb, true, '$OWNER_ID', '$OWNER_ID')
ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true;
COMMIT;
SQL

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[workd-rust] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    printf '%s' "$RESPONSE_BODY" | jq 'del(.token,.accessToken,.refreshToken)' \
      >&2 2>/dev/null || echo "[workd-rust] non-JSON response body redacted" >&2
    exit 1
  }
}

RESPONSE_STATUS="$(curl -sS -o "$TMP_DIR/login.json" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" \
  "$BASE_URL/v1/auth/login")"
RESPONSE_BODY="$(<"$TMP_DIR/login.json")"
expect_status 200 "owner login"
OWNER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/login.json")"
printf '%s\n' "$OWNER_TOKEN" >"$TMP_DIR/registration.token"
chmod 600 "$TMP_DIR/registration.token"

SHELL_ARGS_JSON="$(jq -cn --arg command "printf '$RAW_MARKER\\n'" '["-c",$command]')"
ATTACH_ENV=()
if [ "$ATTACH_MODE" = "1" ]; then
  ATTACH_ENV=(
    "MOMO_WORKD_ATTACH_PUBLIC_URL=$ATTACH_ENDPOINT"
    "MOMO_WORKD_ATTACH_BIND=127.0.0.1"
    "MOMO_WORKD_ATTACH_PORT=$ATTACH_PLAIN_PORT"
    "MOMO_WORKD_ATTACH_REVALIDATE_INTERVAL_MS=$ATTACH_REVALIDATE_MS"
  )
fi
env MOMO_WORKD_PROFILE_SHELL_EXECUTABLE=/bin/sh \
  "MOMO_WORKD_PROFILE_SHELL_ARGUMENTS_JSON=$SHELL_ARGS_JSON" \
  ${ATTACH_ENV[@]+"${ATTACH_ENV[@]}"} \
  MOMO_WORKD_SERVER_URL="$BASE_URL" \
  MOMO_WORKD_ALLOW_INSECURE_HTTP=1 \
  MOMO_WORKD_WORKSPACE_ID="$WS_ID" \
  MOMO_WORKD_SCOPE=workspace \
  MOMO_WORKD_DISPLAY_NAME="#1777 rust verifier host" \
  MOMO_WORKD_KEY_PATH="$TMP_DIR/workd.key" \
  MOMO_WORKD_HOST_ID_PATH="$TMP_DIR/workd.host-id" \
  MOMO_WORKD_OUTPUT_DIR="$TMP_DIR/output" \
  MOMO_WORKD_REGISTRATION_TOKEN_FILE="$TMP_DIR/registration.token" \
  MOMO_WORKD_POLL_INTERVAL_MS=100 \
  MOMO_WORKD_HEARTBEAT_INTERVAL_MS=1000 \
  "$WORKD_BIN" >"$TMP_DIR/workd.log" 2>&1 &
WORKD_PID=$!

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ ! -s "$TMP_DIR/workd.host-id" ] && [ "$(date -u +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    sed -n '1,160p' "$TMP_DIR/workd.log" >&2
    fail "daemon exited before registration"
  fi
  sleep 1
done
[ -s "$TMP_DIR/workd.host-id" ] || {
  sed -n '1,160p' "$TMP_DIR/workd.log" >&2
  fail "host registration timeout"
}
HOST_ID="$(tr -d '[:space:]' <"$TMP_DIR/workd.host-id")"
HOST_ID="$($PYTHON_BIN - "$HOST_ID" <<'PY'
import sys, uuid
print(str(uuid.UUID(sys.argv[1])).lower())
PY
)"

# Same REST sequence as verify_workd.sh:340-359.
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"#1777 rust workd verifier"}'
expect_status 201 "agent bearer create"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.credential.scopes | index("work:control") != null' >/dev/null

api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/$TOOL_KEY"
expect_status 200 "enable $TOOL_KEY auto approval"

CONTROL_PATH="/v1/workspaces/$WS_ID/work-controls"
api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg run "$RUN_ID" --arg host "$HOST_ID" \
    --arg tool "$TOOL_KEY" --arg label "$TOOL_LABEL" \
    '{channelId:$channel,runId:$run,targetHostId:$host,kind:"spawn",
      payload:{tool:$tool,label:$label}}')"
expect_status 201 "approved/dispatched spawn"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.workControl.status == "dispatched" and .workControl.kind == "spawn"' >/dev/null
CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"
note "dispatched spawn $CONTROL_ID → host $HOST_ID"

if [ "$EXPECT_RED" = "1" ]; then
  # Pre-#1777 APIs die before the daemon can even POST create (work-tool-profiles
  # 401, then transport_failed). Waiting on workd.log for a 400 is how the
  # first RED attempt failed. The durable proof is the same signed POST the
  # daemon would send, using the key it just wrote.
  [ -s "$TMP_DIR/workd.key" ] || fail "RED expected workd.key after registration"
  CREATE_BODY="$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$HOST_ID" \
    --arg tool "$TOOL_KEY" --arg label "$TOOL_LABEL" --arg control "$CONTROL_ID" \
    '{channelId:$channel,hostId:$host,tool:$tool,label:$label,controlId:$control}')"
  CREATE_PATH="/v1/workspaces/$WS_ID/work-sessions"
  # workd.key is CryptoKit raw 32-byte seed. Wrap it as PKCS#8 so openssl
  # pkeyutl can sign the same v2 payload the daemon uses — no extra Python
  # dependency (homebrew python3.13 has no cryptography).
  "$PYTHON_BIN" - "$TMP_DIR/workd.key" "$TMP_DIR/workd.pkcs8.pem" <<'PY'
import base64, pathlib, sys
seed = pathlib.Path(sys.argv[1]).read_bytes()
if len(seed) != 32:
    raise SystemExit(f"workd.key is {len(seed)} bytes, want 32")
der = bytes.fromhex("302e020100300506032b657004220420") + seed
b64 = base64.b64encode(der).decode("ascii")
pathlib.Path(sys.argv[2]).write_text(
    "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n",
    encoding="ascii",
)
PY
  chmod 600 "$TMP_DIR/workd.pkcs8.pem"
  SENT_AT_MS="$("$PYTHON_BIN" -c 'import time; print(int(time.time()*1000))')"
  REQUEST_ID="$(new_uuid | tr '[:upper:]' '[:lower:]')"
  BODY_HASH="$(printf '%s' "$CREATE_BODY" | openssl dgst -sha256 | awk '{print $NF}')"
  PAYLOAD="$TMP_DIR/signed-create.payload"
  printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
    POST "$CREATE_PATH" \
    "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$HOST_ID" | tr '[:upper:]' '[:lower:]')" \
    "$SENT_AT_MS" "$BODY_HASH" "$REQUEST_ID" >"$PAYLOAD"
  SIGNATURE="$(openssl pkeyutl -sign -rawin -inkey "$TMP_DIR/workd.pkcs8.pem" \
    -in "$PAYLOAD" | openssl base64 -A)"
  RESPONSE_STATUS="$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    -H "Authorization: MomoHost $HOST_ID" \
    -H "X-Momo-Work-Host-Sent-At: $SENT_AT_MS" \
    -H "X-Momo-Work-Host-Signature: $SIGNATURE" \
    -H "X-Momo-Work-Host-Request-ID: $REQUEST_ID" \
    --data "$CREATE_BODY" \
    "$BASE_URL$CREATE_PATH")"
  RESPONSE_BODY="$(<"$TMP_DIR/response.json")"
  case "$RESPONSE_STATUS" in
    400|401|403) ;;
    *)
      echo "[workd-rust] FAIL RED signed create: expected 400/401/403, got $RESPONSE_STATUS" >&2
      printf '%s\n' "$RESPONSE_BODY" >&2
      exit 1
      ;;
  esac
  note "RED: signed POST $CREATE_PATH → HTTP $RESPONSE_STATUS"
  printf '%s\n' "$RESPONSE_BODY"
  if [ -f "$TMP_DIR/workd.log" ]; then
    note "daemon log (may die at work-tool-profiles on a pre-#1777 API):"
    sed -n '1,160p' "$TMP_DIR/workd.log"
  fi
  got="$(sql_value <<SQL
SELECT count(*) FROM work_session
 WHERE workspace_id='$WS_ID' AND host_id='$HOST_ID' AND label='$TOOL_LABEL';
SQL
)"
  [ "$got" = "0" ] || fail "RED expected no session row, found $got"
  note "RED PASS — signed create HTTP $RESPONSE_STATUS, work_session count=0"
  exit 0
fi

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
SESSION_ID=""
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  row="$(sql_value <<SQL
SELECT coalesce(ws.id::text,'') || ':' || coalesce(ws.status,'') || ':' ||
       coalesce((ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL)::int::text,'0')
  FROM work_control wc
  LEFT JOIN work_session ws ON ws.id=wc.session_id
 WHERE wc.id='$CONTROL_ID';
SQL
)"
  case "$row" in
    *:running:*|*:idle:*)
      SESSION_ID="${row%%:*}"
      BIND_FLAG="$(printf '%s' "$row" | awk -F: '{print $NF}')"
      [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "" ] && break
      ;;
  esac
  if ! kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    sed -n '1,200p' "$TMP_DIR/workd.log" >&2
    fail "daemon exited during dispatch"
  fi
  sleep 1
done
[ -n "$SESSION_ID" ] || {
  sed -n '1,200p' "$TMP_DIR/workd.log" >&2
  fail "spawn ack/session settle timeout (server still refusing host-signed create?)"
}

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM work_session
 WHERE id='$SESSION_ID' AND pty_id IS NOT NULL AND attach_endpoint IS NOT NULL;
SQL
)"
  [ "$got" = "1" ] && break
  sleep 1
done
[ "$got" = "1" ] || {
  sed -n '1,200p' "$TMP_DIR/workd.log" >&2
  fail "daemon never published pty_id/attach_endpoint"
}

api "$OWNER_TOKEN" GET "/v1/workspaces/$WS_ID/work-sessions?active=1"
expect_status 200 "list active sessions"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg id "$SESSION_ID" \
  '.workSessions[] | select((.id|ascii_downcase)==$id) | .remoteAttachAvailable == true' \
  >/dev/null || fail "remoteAttachAvailable did not flip to true"

OUTPUT_FILE="$TMP_DIR/output/$SESSION_ID.log"
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
until [ -f "$OUTPUT_FILE" ] && grep -Fq "$RAW_MARKER" "$OUTPUT_FILE"; do
  [ "$(date -u +%s)" -lt "$deadline" ] || fail "local raw PTY output timeout"
  sleep 1
done
note "GREEN session $SESSION_ID — remote_attach_available=true, local PTY printed $RAW_MARKER"

if [ "$ATTACH_MODE" = "1" ]; then
  grep -q 'terminal attach listener ready' "$TMP_DIR/workd.log" ||
    fail "daemon did not open an attach listener"
  "$PYTHON_BIN" "$REPO_ROOT/scripts/terminal_attach_tls_proxy.py" \
    --listen-port "$ATTACH_TLS_PORT" --target-port "$ATTACH_PLAIN_PORT" \
    --cert "$ATTACH_CERT" --key "$ATTACH_KEY" \
    --ready-file "$TMP_DIR/attach-proxy.ready" \
    >"$TMP_DIR/attach-proxy.log" 2>&1 &
  ATTACH_PROXY_PID=$!
  deadline=$(( $(date -u +%s) + 30 ))
  until [ -f "$TMP_DIR/attach-proxy.ready" ]; do
    if [ "$(date -u +%s)" -ge "$deadline" ] \
      || ! kill -0 "$ATTACH_PROXY_PID" >/dev/null 2>&1; then
      cat "$TMP_DIR/attach-proxy.log" >&2 || true
      fail "attach TLS proxy never bound"
    fi
    sleep 1
  done
  # Same split as verify_workd.sh: controller proves the real PTY accepts
  # stdin; observer is the dock surface (no stdin — 1008 if you send it).
  api "$OWNER_TOKEN" POST \
    "/v1/workspaces/$WS_ID/work-sessions/$SESSION_ID/terminal-attach" \
    '{"mode":"controller"}'
  expect_status 200 "controller terminal attach capability"
  CONTROLLER_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"
  "$PYTHON_BIN" "$REPO_ROOT/scripts/terminal_attach_probe.py" \
    --url "$ATTACH_ENDPOINT" \
    --token "$CONTROLLER_TOKEN" \
    --pty-id "$SESSION_ID" \
    --expect-replay "$RAW_MARKER" \
    --live-input "$ATTACH_LIVE_INPUT"$'\n' \
    --expect-live "$ATTACH_LIVE_MARKER" \
    --timeout "$ASSERT_TIMEOUT" ||
    fail "controller attach-round-trip: real PTY stdin/stdout did not close"
  note "GREEN controller — replay marker + live stdin reached the host PTY"

  api "$OWNER_TOKEN" POST \
    "/v1/workspaces/$WS_ID/work-sessions/$SESSION_ID/terminal-attach" \
    '{"mode":"observer"}'
  expect_status 200 "observer terminal attach capability"
  OBSERVER_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"
  "$PYTHON_BIN" "$REPO_ROOT/scripts/terminal_attach_probe.py" \
    --url "$ATTACH_ENDPOINT" \
    --token "$OBSERVER_TOKEN" \
    --pty-id "$SESSION_ID" \
    --expect-replay "$RAW_MARKER" \
    --timeout "$ASSERT_TIMEOUT" ||
    fail "dock observer attach: real PTY bytes did not reach the attach WS"
  note "GREEN dock observer — replay marker reached the observer socket"
fi

note "PASS"
