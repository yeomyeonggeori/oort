#!/usr/bin/env bash
# MOMO-488 / ADR-0125 D2 outbound workd registration, dispatch, and RLS gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[workd] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq

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
  echo "[workd] Python 3.10+ not found (tried python3.13 through python3)" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }
now_ms() { "$PYTHON_BIN" -c 'import time; print(time.time_ns() // 1_000_000)'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORKD_GATE_PROJECT:-momo488workd}"
API_PORT="${WORKD_GATE_API_PORT:-27950}"
CENT_PORT_HOST="${WORKD_GATE_CENTRIFUGO_PORT:-27951}"
PG_PORT="${WORKD_GATE_POSTGRES_PORT:-27952}"
HERMES_PORT_HOST="${WORKD_GATE_HERMES_PORT:-27953}"
BOOT_TIMEOUT="${WORKD_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${WORKD_GATE_ASSERT_TIMEOUT:-240}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-workd.XXXXXX")"
WORKD_PID=""

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_WS_ID="48800000-0000-7000-8000-000000000099"
OWNER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
RUN_ID="$(new_uuid)"
OWNER_EMAIL="workd-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
RAW_MARKER="MOMO_WORKD_RAW_${RUN_TAG//-/_}"
WORKD_BIN="$REPO_ROOT/workers/WorkHostDaemon/.build/debug/momo-workd"
ACP_MODE="${WORKD_GATE_ACP:-0}"
TOOL_KEY="shell"
TOOL_LABEL="MOMO-488 mock echo"
if [ "$ACP_MODE" = "1" ]; then
  # Reuse the seeded opencode ledger key so this verifier does not widen the
  # pre-029 work_session DB check while still exercising ACP transport.
  TOOL_KEY="opencode"
  TOOL_LABEL="MOMO-546 ACP relay"
  RAW_MARKER="vendorExtension"
fi

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "$WORKD_PID" ] && kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    kill "$WORKD_PID" >/dev/null 2>&1 || true
    wait "$WORKD_PID" >/dev/null 2>&1 || true
  fi
  if [ "${WORKD_GATE_KEEP:-0}" = "1" ]; then
    echo "[workd] leaving compose project '$PROJECT' up"
    echo "[workd] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-workd.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[workd] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -x "$WORKD_BIN" ]; then
  echo "[workd] building momo-workd (normally already built by runtime-db swift gate)"
  swift build --disable-sandbox --package-path workers/WorkHostDaemon
fi
[ -x "$WORKD_BIN" ] || {
  echo "[workd] momo-workd executable unavailable after build" >&2
  exit 1
}

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[workd] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[workd] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[workd] api exited" >&2
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
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Workd Owner', 'workd-owner-$RUN_TAG'),
  ('$AGENT_ID', '$WS_ID', 'agent', 'active', 'Workd Agent', 'workd-agent-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ID', '$WS_ID', 'hermes-agent', 'http://localhost:8088/v1',
   'MOMO-488 verifier', '$OWNER_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WS_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$AGENT_ID', 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"MOMO-488 workd spawn"}'::jsonb, 1, 50, 0,
   'momo-488-workd-$RUN_TAG');
UPDATE work_tool_profile
   SET tier_defaults='{"transport":"acp"}'::jsonb,
       updated_by='$OWNER_ID'
 WHERE '$ACP_MODE' = '1'
   AND workspace_id='$WS_ID'
   AND tool_key='opencode';
COMMIT;
SQL

curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" >"$TMP_DIR/login.json"
OWNER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/login.json")"
printf '%s\n' "$OWNER_TOKEN" >"$TMP_DIR/registration.token"
chmod 600 "$TMP_DIR/registration.token"

SHELL_ARGS_JSON="$(jq -cn --arg command "printf '$RAW_MARKER\\n'" '["-c",$command]')"
if [ "$ACP_MODE" = "1" ]; then
  PROFILE_EXECUTABLE_KEY="MOMO_WORKD_PROFILE_OPENCODE_EXECUTABLE=/usr/bin/python3"
  PROFILE_ARGUMENTS_KEY="MOMO_WORKD_PROFILE_OPENCODE_ARGUMENTS_JSON=$(jq -cn --arg script "$REPO_ROOT/scripts/mock_acp_agent.py" '[$script]')"
else
  PROFILE_EXECUTABLE_KEY="MOMO_WORKD_PROFILE_SHELL_EXECUTABLE=/bin/sh"
  PROFILE_ARGUMENTS_KEY="MOMO_WORKD_PROFILE_SHELL_ARGUMENTS_JSON=$SHELL_ARGS_JSON"
fi
env "$PROFILE_EXECUTABLE_KEY" "$PROFILE_ARGUMENTS_KEY" \
MOMO_WORKD_SERVER_URL="$BASE_URL" \
MOMO_WORKD_ALLOW_INSECURE_HTTP=1 \
MOMO_WORKD_WORKSPACE_ID="$WS_ID" \
MOMO_WORKD_SCOPE=workspace \
MOMO_WORKD_DISPLAY_NAME="MOMO-488 verifier host" \
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
    sed -n '1,120p' "$TMP_DIR/workd.log" >&2
    echo "[workd] daemon exited before registration" >&2
    exit 1
  fi
  sleep 1
done
[ -s "$TMP_DIR/workd.host-id" ] || {
  sed -n '1,120p' "$TMP_DIR/workd.log" >&2
  echo "[workd] host registration timeout" >&2
  exit 1
}
HOST_ID="$(tr -d '[:space:]' <"$TMP_DIR/workd.host-id")"
HOST_ID="$($PYTHON_BIN - "$HOST_ID" <<'PY'
import sys
import uuid
print(str(uuid.UUID(sys.argv[1])).lower())
PY
)"

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while :; do
  got="$(sql_value <<SQL
SELECT count(*) FROM work_host
 WHERE id='$HOST_ID' AND workspace_id='$WS_ID' AND owner_member_id='$OWNER_ID'
   AND type='workd' AND scope='workspace' AND revoked_at IS NULL
   AND last_seen_at IS NOT NULL;
SQL
)"
  [ "$got" = "1" ] && break
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    sed -n '1,120p' "$TMP_DIR/workd.log" >&2
    echo "[workd] registration/heartbeat assertion timeout" >&2
    exit 1
  fi
  sleep 1
done

[ ! -e "$TMP_DIR/registration.token" ] || {
  echo "[workd] consumed registration token file still exists" >&2
  exit 1
}
for private_file in "$TMP_DIR/workd.key" "$TMP_DIR/workd.host-id"; do
  mode="$(stat -f '%Lp' "$private_file" 2>/dev/null || stat -c '%a' "$private_file" 2>/dev/null || true)"
  [ "$mode" = "600" ] || {
    echo "[workd] private identity file mode is not 0600" >&2
    exit 1
  }
done

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
    echo "[workd] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    printf '%s' "$RESPONSE_BODY" | jq 'del(.token,.accessToken,.refreshToken)' \
      >&2 2>/dev/null || echo "[workd] non-JSON response body redacted" >&2
    exit 1
  }
}

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-488 workd verifier"}'
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

# MOMO-672: #857 (68d6ca91) turned the `pty` transport into a persistent login
# shell that wraps the tool in a shell function, so a finished tool no longer
# exits the child process — the host reports `idle`, and `ended` became the
# operator/idle-timeout transition. Settle on either terminal-for-the-host
# status here and drive the remaining idle -> ended leg explicitly below, so the
# full running -> ended ledger stays covered instead of hanging on a transition
# the daemon stopped making.
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
SESSION_ID=""
SESSION_STATUS=""
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  row="$(sql_value <<SQL
SELECT coalesce(wc.session_id::text,'') || ':' || wc.status || ':' ||
       coalesce(ws.status,'') || ':' || coalesce(ws.exit_code::text,'')
  FROM work_control wc
  LEFT JOIN work_session ws ON ws.id=wc.session_id
 WHERE wc.id='$CONTROL_ID';
SQL
)"
  case "$row" in
    *:acked:idle:*|*:acked:ended:*)
      SESSION_ID="${row%%:*}"
      SESSION_STATUS="$(printf '%s' "$row" | cut -d: -f3)"
      break
      ;;
  esac
  if ! kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    sed -n '1,160p' "$TMP_DIR/workd.log" >&2
    echo "[workd] daemon exited during dispatch" >&2
    exit 1
  fi
  sleep 1
done
[ -n "$SESSION_ID" ] || {
  sed -n '1,160p' "$TMP_DIR/workd.log" >&2
  echo "[workd] spawn ack/session settle timeout" >&2
  exit 1
}

if [ "$ACP_MODE" = "1" ]; then
  OUTPUT_FILE="$TMP_DIR/output/$SESSION_ID.acp-events.jsonl"
else
  OUTPUT_FILE="$TMP_DIR/output/$SESSION_ID.log"
fi
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
until [ -f "$OUTPUT_FILE" ] && grep -Fq "$RAW_MARKER" "$OUTPUT_FILE"; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[workd] local raw output assertion timeout" >&2
    exit 1
  fi
  sleep 1
done
mode="$(stat -f '%Lp' "$OUTPUT_FILE" 2>/dev/null || stat -c '%a' "$OUTPUT_FILE" 2>/dev/null || true)"
[ "$mode" = "600" ] || {
  echo "[workd] raw output file mode is not 0600" >&2
  exit 1
}

# MOMO-672: pin the host-reported running -> idle fact that #857 introduced,
# then take the idle -> ended leg as the owner. `kill` controls require a
# running session, so the owner PATCH is the only non-notifier path out of idle;
# it keeps the exit code the host already reported (COALESCE on the server).
if [ "$SESSION_STATUS" = "idle" ]; then
  got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='work.session.idle'
   AND payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID';
SQL
)"
  [ "$got" = "1" ] || {
    echo "[workd] FAIL host-reported running-to-idle evidence: $got" >&2
    exit 1
  }
  api "$OWNER_TOKEN" PATCH "/v1/workspaces/$WS_ID/work-sessions/$SESSION_ID" \
    '{"status":"ended"}'
  expect_status 200 "owner ends idle work session"
fi

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_control
    WHERE id='$CONTROL_ID' AND target_host_id='$HOST_ID' AND status='acked') || ':' ||
  (SELECT count(*) FROM work_session
    WHERE id='$SESSION_ID' AND host_id='$HOST_ID' AND member_id='$OWNER_ID'
      AND status='ended' AND ended_at IS NOT NULL AND exit_code=0) || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.started'
      AND payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.ended'
      AND payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID');
SQL
)"
[ "$got" = "1:1:1:1" ] || {
  echo "[workd] FAIL ack or running-to-ended ledger evidence: $got" >&2
  exit 1
}

if [ "$ACP_MODE" = "1" ]; then
  got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM message
    WHERE workspace_id='$WS_ID' AND root_id=(
      SELECT root_message_id FROM work_session WHERE id='$SESSION_ID')
      AND props->>'kind'='work_session_event') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE workspace_id='$WS_ID'
      AND payload->'data'->'payload'->>'work_session_id' ILIKE '$SESSION_ID'
      AND payload->'data'->>'type' IN
        ('agent.partial','agent.status','approval.requested','approval.decided')) || ':' ||
  (SELECT count(*) FROM message
    WHERE workspace_id='$WS_ID' AND root_id=(
      SELECT root_message_id FROM work_session WHERE id='$SESSION_ID')
      AND props ? '_meta');
SQL
)"
  case "$got" in
    5:5:0|6:6:0|7:7:0) ;;
    *)
      echo "[workd] FAIL ACP message ledger/outbox projection evidence: $got" >&2
      exit 1
      ;;
  esac
fi

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM message
    WHERE workspace_id='$WS_ID'
      AND (coalesce(body,'') LIKE '%$RAW_MARKER%' OR props::text LIKE '%$RAW_MARKER%')) +
  (SELECT count(*) FROM work_control
    WHERE workspace_id='$WS_ID' AND payload::text LIKE '%$RAW_MARKER%') +
  (SELECT count(*) FROM work_session
    WHERE workspace_id='$WS_ID'
      AND (tool LIKE '%$RAW_MARKER%' OR label LIKE '%$RAW_MARKER%')) +
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND detail::text LIKE '%$RAW_MARKER%') +
  (SELECT count(*) FROM outbox
    WHERE workspace_id='$WS_ID' AND payload::text LIKE '%$RAW_MARKER%') +
  (SELECT count(*) FROM agent_run
    WHERE workspace_id='$WS_ID' AND input::text LIKE '%$RAW_MARKER%');
SQL
)"
[ "$got" = "0" ] || {
  echo "[workd] FAIL raw process output entered the server ledger" >&2
  exit 1
}

FORGED_SIGNATURE="$($PYTHON_BIN -c \
  'import base64; print(base64.b64encode(bytes(64)).decode("ascii"))')"
POLL_PATH="/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/pending-controls"
FORGED_STATUS="$(curl -sS -o "$TMP_DIR/forged.json" -w '%{http_code}' \
  -X GET "$BASE_URL$POLL_PATH" \
  -H "Authorization: MomoHost $HOST_ID" \
  -H "X-Momo-Work-Host-Sent-At: $(now_ms)" \
  -H "X-Momo-Work-Host-Signature: $FORGED_SIGNATURE")"
[ "$FORGED_STATUS" = "401" ] || {
  echo "[workd] FAIL forged host poll expected HTTP 401, got $FORGED_STATUS" >&2
  exit 1
}

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_WS_ID';
SELECT
  (SELECT count(*) FROM work_host WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM work_control WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM work_session WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM message WHERE workspace_id='$WS_ID' AND id IN
    (SELECT root_message_id FROM work_session WHERE workspace_id='$WS_ID'));
COMMIT;
SQL
)"
[ "$got" = "0:0:0:0" ] || {
  echo "[workd] FAIL cross-tenant RLS isolation: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT count(*) FROM pg_class
 WHERE relname IN ('work_host','work_control','work_session')
   AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$got" = "3" ] || {
  echo "[workd] FAIL FORCE RLS metadata: $got" >&2
  exit 1
}

if [ "$ACP_MODE" = "1" ]; then
  echo "MOMO-546 ACP local JSONL + server message ledger/outbox relay + session lifecycle/RLS PASS"
else
  echo "MOMO-488 workd registration/heartbeat + signed polling + local-only raw output + session lifecycle/RLS PASS"
fi
