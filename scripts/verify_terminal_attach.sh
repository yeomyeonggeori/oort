#!/usr/bin/env bash
# MOMO-511 / ADR-0125 D10 terminal attach capability and direct-stream gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[terminal-attach] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq

# macOS /usr/bin/openssl is LibreSSL and cannot sign Ed25519 request payloads.
# Resolve the first OpenSSL that proves the exact algorithm before continuing.
find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-openssl-probe.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" genpkey -algorithm ED25519 -out "$probe" >/dev/null 2>&1; then
      rm -f "$probe"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  rm -f "$probe"
  echo "[terminal-attach] no OpenSSL with Ed25519 support found" >&2
  exit 1
}
OPENSSL_BIN="$(find_openssl)"

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
  echo "[terminal-attach] Python 3.10+ not found" >&2
  exit 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }
now_ms() { "$PYTHON_BIN" -c 'import time; print(time.time_ns() // 1_000_000)'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${TERMINAL_ATTACH_GATE_PROJECT:-momo511terminalattach}"
API_PORT="${TERMINAL_ATTACH_GATE_API_PORT:-27980}"
CENT_PORT_HOST="${TERMINAL_ATTACH_GATE_CENTRIFUGO_PORT:-27981}"
PG_PORT="${TERMINAL_ATTACH_GATE_POSTGRES_PORT:-27982}"
HERMES_PORT_HOST="${TERMINAL_ATTACH_GATE_HERMES_PORT:-27983}"
BOOT_TIMEOUT="${TERMINAL_ATTACH_GATE_BOOT_TIMEOUT:-2400}"
RUN_TAG="$(date -u +%s)-$$"

check_reserved_ports() {
  "$PYTHON_BIN" - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket
import sys

for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
    except OSError as exc:
        raise SystemExit(f"[terminal-attach] reserved port {port} is unavailable: {exc}")
    finally:
        sock.close()
PY
}
check_reserved_ports
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-terminal-attach.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
OWNER_ID="$(new_uuid)"
OTHER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
RUN_ID="$(new_uuid)"
OTHER_WS_ID="$(new_uuid)"
OWNER_EMAIL="terminal-owner-$RUN_TAG@momo.local"
OTHER_EMAIL="terminal-other-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
OTHER_PASSWORD="other-$(new_uuid)"
PTY_ID="pty-511-$RUN_TAG"
ATTACH_ENDPOINT="wss://workd.momo.test/v1/terminal"
RAW_MARKER="MOMO511_REMOTE_PTY_RAW_$RUN_TAG"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${TERMINAL_ATTACH_GATE_KEEP:-0}" = "1" ]; then
    echo "[terminal-attach] leaving compose project '$PROJECT' up"
    echo "[terminal-attach] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-terminal-attach.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[terminal-attach] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PRIVATE_KEY="$TMP_DIR/work-host-private.pem"
PUBLIC_DER="$TMP_DIR/work-host-public.der"
"$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$PRIVATE_KEY" >/dev/null 2>&1
"$OPENSSL_BIN" pkey -in "$PRIVATE_KEY" -pubout -outform DER \
  -out "$PUBLIC_DER" >/dev/null 2>&1
PUBLIC_KEY="$(tail -c 32 "$PUBLIC_DER" | "$OPENSSL_BIN" base64 -A)"

BASE_URL="http://127.0.0.1:$API_PORT"

echo "[terminal-attach] booting isolated api/relay stack '$PROJECT' on ports $API_PORT, $CENT_PORT_HOST, $PG_PORT, $HERMES_PORT_HOST"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[terminal-attach] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[terminal-attach] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql \
    -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Terminal Owner', 'tao-$RUN_TAG'),
  ('$OTHER_ID', '$WS_ID', 'human', 'active', 'Terminal Other', 'tax-$RUN_TAG'),
  ('$AGENT_ID', '$WS_ID', 'agent', 'active', 'Terminal Agent', 'taa-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true,
   momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$OTHER_ID', '$WS_ID', '$OTHER_EMAIL', true,
   momo_password_hash('$OTHER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ID', '$WS_ID', 'hermes-agent', 'http://localhost:8088/v1',
   'MOMO-511 verifier', '$OWNER_ID');
-- fffe303b(#564) 이후 라우트 authz는 workspace_membership을 읽는다. 이 픽스처는
-- SQL 지름길로 멤버를 심으므로(실 REST join이면 자동 생성) 직접 넣어야 한다.
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WS_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$OTHER_ID', 'member'),
  ('$WS_ID', '$AGENT_ID', 'member');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$OTHER_ID', 'member'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"remote PTY attach"}'::jsonb, 1, 50, 0,
   'momo-511-$RUN_TAG');
COMMIT;
SQL

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
host_api() {
  local method="$1" path="$2" host_id="$3" body="${4:-}"
  local sent_at request_id body_hash payload signature out="$TMP_DIR/response.json"
  sent_at="$(now_ms)"
  request_id="$(new_uuid | tr '[:upper:]' '[:lower:]')"
  body_hash="$(printf '%s' "$body" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $NF}')"
  payload="$TMP_DIR/work-host-request-$sent_at.txt"
  printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
    "$method" "$path" \
    "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" "$body_hash" "$request_id" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$PRIVATE_KEY" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json'
    -H "Authorization: MomoHost $host_id"
    -H "X-Momo-Work-Host-Sent-At: $sent_at"
    -H "X-Momo-Work-Host-Signature: $signature"
    -H "X-Momo-Work-Host-Request-ID: $request_id")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[terminal-attach] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    printf '%s' "$RESPONSE_BODY" | jq \
      'del(.token,.accessToken,.refreshToken,.capability_token)' \
      >&2 2>/dev/null || echo "[terminal-attach] non-JSON body redacted" >&2
    exit 1
  }
}
login() {
  local email="$1" password="$2"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$password" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}

OWNER_TOKEN="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
OTHER_TOKEN="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")"
HOSTS_PATH="/v1/workspaces/$WS_ID/work-hosts"

api "$OWNER_TOKEN" POST "$HOSTS_PATH" \
  "$(jq -cn --arg key "$PUBLIC_KEY" \
    '{scope:"member",type:"workd",displayName:"MOMO-511 remote PTY host",
      publicKey:$key,capabilities:{"tool.codex":true,"terminal_attach":true}}')"
expect_status 201 "terminal-capable host registration"
HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase')"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-511 verifier"}'
expect_status 201 "agent bearer create"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"

api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/codex"
expect_status 200 "enable auto approve"
api "$AGENT_TOKEN" POST "/v1/workspaces/$WS_ID/work-controls" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg run "$RUN_ID" --arg host "$HOST_ID" \
    '{channelId:$channel,runId:$run,targetHostId:$host,kind:"spawn",
      payload:{tool:"codex",label:"MOMO-511 remote PTY"}}')"
expect_status 201 "remote PTY spawn dispatch"
CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"
printf '%s' "$RESPONSE_BODY" | jq -e '.workControl.status == "dispatched"' >/dev/null

SESSION_PATH="/v1/workspaces/$WS_ID/work-sessions"
host_api POST "$SESSION_PATH" "$HOST_ID" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$HOST_ID" \
    --arg control "$CONTROL_ID" --arg pty "$PTY_ID" --arg endpoint "$ATTACH_ENDPOINT" \
    '{channelId:$channel,hostId:$host,tool:"codex",label:"MOMO-511 remote PTY",
      controlId:$control,ptyId:$pty,attachEndpoint:$endpoint}')"
expect_status 201 "MomoHost remote PTY binding"
SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
ATTACH_PATH="$SESSION_PATH/$SESSION_ID/terminal-attach"
VALIDATE_PATH="$HOSTS_PATH/$HOST_ID/terminal-attach/validate"

api "$OTHER_TOKEN" POST "$ATTACH_PATH"
expect_status 403 "non-owner attach"
api "$AGENT_TOKEN" POST "$ATTACH_PATH"
expect_status 403 "agent bearer attach"

api "$OWNER_TOKEN" POST "$ATTACH_PATH"
expect_status 200 "owner attach capability issue"
CAPABILITY_ONE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"
printf '%s' "$RESPONSE_BODY" | jq -e --arg endpoint "$ATTACH_ENDPOINT" \
  --arg pty "$PTY_ID" --arg token "$CAPABILITY_ONE" '
  .attach_endpoint == $endpoint
  and .pty_id == $pty
  and ((keys | sort) == ["attach_endpoint","capability_token","pty_id"])
  and (.attach_endpoint | contains($token) | not)
' >/dev/null

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM terminal_attach_capability c
    WHERE c.work_session_id='$SESSION_ID'
      AND c.owner_member_id='$OWNER_ID'
      AND c.mode='controller'
      AND octet_length(c.token_hash)=32
      AND c.expires_at > c.issued_at)
  || ':' ||
  (SELECT count(*) FROM audit_log a
    WHERE a.action='work.terminal_attach.issued'
      AND a.target_type='work_session'
      AND a.target_id='$SESSION_ID'
      AND a.actor_member_id='$OWNER_ID'
      AND a.subject_member_id='$OWNER_ID'
      AND a.detail->>'owner_member_id'='$OWNER_ID'
      AND a.detail->>'mode'='controller'
      AND (a.detail->>'expires_at')::timestamptz
          > (a.detail->>'issued_at')::timestamptz
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a.detail) k)
          = ARRAY['expires_at','issued_at','mode','owner_member_id','schema']::text[])
  || ':' ||
  (SELECT count(*) FROM terminal_attach_capability c
    WHERE encode(c.token_hash, 'escape')='$CAPABILITY_ONE')
  || ':' ||
  (SELECT count(*) FROM audit_log a
    WHERE a.detail::text LIKE '%' || '$CAPABILITY_ONE' || '%');
SQL
)"
[ "$got" = "1:1:0:0" ] || {
  echo "[terminal-attach] FAIL digest/expiry/audit/raw-token ledger: $got" >&2
  exit 1
}

host_api POST "$VALIDATE_PATH" "$HOST_ID" \
  "$(jq -cn --arg token "$CAPABILITY_ONE" '{capability_token:$token}')"
expect_status 200 "live capability validation"
printf '%s' "$RESPONSE_BODY" | jq -e --arg session "$SESSION_ID" --arg pty "$PTY_ID" '
  (.work_session_id | ascii_downcase) == $session
  and .pty_id == $pty
  and .mode == "controller"
  and (.expires_at | type == "string")
' >/dev/null

host_api POST "$VALIDATE_PATH" "$HOST_ID" '{"capability_token":"invalid"}'
expect_status 401 "malformed capability"

run_sql -c "UPDATE terminal_attach_capability
  SET issued_at=clock_timestamp()-interval '2 minutes',
      expires_at=clock_timestamp()-interval '1 minute'
  WHERE work_session_id='$SESSION_ID';"
host_api POST "$VALIDATE_PATH" "$HOST_ID" \
  "$(jq -cn --arg token "$CAPABILITY_ONE" '{capability_token:$token}')"
expect_status 401 "expired capability"

api "$OWNER_TOKEN" POST "$ATTACH_PATH"
expect_status 200 "second capability issue"
CAPABILITY_TWO="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"
[ "$CAPABILITY_TWO" != "$CAPABILITY_ONE" ] || {
  echo "[terminal-attach] FAIL capability reuse" >&2
  exit 1
}

api "$OWNER_TOKEN" DELETE "$HOSTS_PATH/$HOST_ID"
expect_status 200 "host revoke"
host_api POST "$VALIDATE_PATH" "$HOST_ID" \
  "$(jq -cn --arg token "$CAPABILITY_TWO" '{capability_token:$token}')"
expect_status 401 "revoked host invalidates issued capability"
api "$OWNER_TOKEN" POST "$ATTACH_PATH"
expect_status 409 "revoked host blocks capability issue"

# A host-local marker models PTY stdout. It must stay outside every server and
# relay request, ledger, and log surface; only capability validation crosses.
printf '%s\n' "$RAW_MARKER" >"$TMP_DIR/remote-pty.raw"
api "$OWNER_TOKEN" POST "$SESSION_PATH/$SESSION_ID/terminal-stream"
expect_status 404 "no momo terminal stream route"

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM pg_class
    WHERE relname='terminal_attach_capability'
      AND relrowsecurity AND relforcerowsecurity)
  || ':' ||
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name IN ('work_session','terminal_attach_capability')
      AND column_name IN ('raw','stdin','stdout','stderr','terminal_bytes'))
  || ':' ||
  (SELECT count(*) FROM work_session
    WHERE coalesce(label,'') LIKE '%' || '$RAW_MARKER' || '%'
       OR coalesce(pty_id,'') LIKE '%' || '$RAW_MARKER' || '%'
       OR coalesce(attach_endpoint,'') LIKE '%' || '$RAW_MARKER' || '%')
  || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE detail::text LIKE '%' || '$RAW_MARKER' || '%')
  || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload::text LIKE '%' || '$RAW_MARKER' || '%');
SQL
)"
[ "$got" = "1:0:0:0:0" ] || {
  echo "[terminal-attach] FAIL RLS/raw-byte ledger boundary: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$OTHER_WS_ID';
SELECT count(*) FROM terminal_attach_capability WHERE workspace_id='$WS_ID';
COMMIT;
SQL
)"
[ "$got" = "0" ] || {
  echo "[terminal-attach] FAIL cross-tenant capability RLS: $got" >&2
  exit 1
}

compose logs --no-color api relay >"$TMP_DIR/server-relay.log"
if grep -Fq "$RAW_MARKER" "$TMP_DIR/server-relay.log" \
    || grep -Fq "$CAPABILITY_ONE" "$TMP_DIR/server-relay.log" \
    || grep -Fq "$CAPABILITY_TWO" "$TMP_DIR/server-relay.log"; then
  echo "[terminal-attach] FAIL raw terminal bytes or capability token entered logs" >&2
  exit 1
fi

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM terminal_attach_capability
    WHERE work_session_id='$SESSION_ID')
  || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.terminal_attach.issued' AND target_id='$SESSION_ID');
SQL
)"
[ "$got" = "2:2" ] || {
  echo "[terminal-attach] FAIL rejected requests mutated capability/audit counts: $got" >&2
  exit 1
}

echo "MOMO-511 terminal attach issue/expiry/owner/revoke + direct raw bypass + audit/RLS PASS"
