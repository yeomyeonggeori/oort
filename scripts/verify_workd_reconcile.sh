#!/usr/bin/env bash
# MOMO-656 / #870 — daemon restart reconciliation runtime gate.
#
# Proves the fast-restart hole is closed *through the real restart path*:
#   1. a real momo-workd registers and spawns a real long-lived PTY session,
#   2. the daemon is SIGKILLed and restarted with the same identity files,
#   3. the restarted daemon's own signed reconciliation report is the ONLY
#      thing that makes the session eligible for the orphan sweep, and
#   4. the session joins the existing orphaned path (status + resume_offer
#      card + lineage) with no new UX.
#
# The host-offline grace is set to one hour, far longer than the whole run, so
# the ADR-0125 D11 heartbeat-age branch provably cannot be what fires. The
# session status is never written by this script — no SQL shortcuts.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for command_name in docker curl jq; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[reconcile] missing $command_name" >&2
    exit 1
  }
done

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
  echo "[reconcile] Python 3.10+ not found" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }
now_ms() { "$PYTHON_BIN" -c 'import time; print(time.time_ns() // 1_000_000)'; }
lower_uuid() {
  "$PYTHON_BIN" - "$1" <<'PY'
import sys
import uuid
print(str(uuid.UUID(sys.argv[1])).lower())
PY
}

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${RECONCILE_GATE_PROJECT:-momo656reconcile}"
API_PORT="${RECONCILE_GATE_API_PORT:-28060}"
PG_PORT="${RECONCILE_GATE_POSTGRES_PORT:-28061}"
CENT_PORT_HOST="${RECONCILE_GATE_CENTRIFUGO_PORT:-28062}"
PUSH_PORT="${RECONCILE_GATE_PUSH_PORT:-28063}"
HERMES_PORT_HOST="${RECONCILE_GATE_HERMES_PORT:-28064}"
BOOT_TIMEOUT="${RECONCILE_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${RECONCILE_GATE_ASSERT_TIMEOUT:-240}"
# One hour: longer than this entire run. If the sweep still orphans the
# session, it can only be because of the host's explicit report.
GRACE_SECONDS="${RECONCILE_GATE_GRACE_S:-3600}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-reconcile.XXXXXX")"
WORKD_PID=""

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
OWNER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
RUN_ID="$(new_uuid)"
OWNER_EMAIL="reconcile-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
WORKD_BIN="$REPO_ROOT/workers/WorkHostDaemon/.build/debug/momo-workd"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" PUSH_RELAY_PORT="$PUSH_PORT" \
    MOMO_HOST_OFFLINE_GRACE_S="$GRACE_SECONDS" NOTIFIER_POLL_INTERVAL_MS=100 \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --profile push "$@"
}

kill_workd() {
  [ -n "$WORKD_PID" ] || return 0
  kill -0 "$WORKD_PID" >/dev/null 2>&1 || return 0
  kill -KILL "$WORKD_PID" >/dev/null 2>&1 || true
  wait "$WORKD_PID" >/dev/null 2>&1 || true
}

reap_leaked_children() {
  [ -n "${CHILD_MARKER:-}" ] || return 0
  pkill -f "$CHILD_MARKER" >/dev/null 2>&1 || true
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  kill_workd
  reap_leaked_children
  if [ "${RECONCILE_GATE_KEEP:-0}" = "1" ]; then
    echo "[reconcile] leaving '$PROJECT' up; evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-reconcile.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[reconcile] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -x "$WORKD_BIN" ]; then
  echo "[reconcile] building momo-workd"
  swift build --disable-sandbox --package-path workers/WorkHostDaemon
fi
[ -x "$WORKD_BIN" ] || {
  echo "[reconcile] momo-workd executable unavailable after build" >&2
  exit 1
}

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[reconcile] booting isolated api stack '$PROJECT'"
compose up -d api mock-push-relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[reconcile] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[reconcile] api exited" >&2
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

# Seed identities only. Work sessions and their lifecycle are produced by the
# real daemon and the real server; this verifier never writes work_session.
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID'::uuid, '$WS_ID'::uuid, 'human', 'active',
   'Reconcile Owner', 'reconcile-owner-$RUN_TAG'),
  ('$AGENT_ID'::uuid, '$WS_ID'::uuid, 'agent', 'active',
   'Reconcile Agent', 'reconcile-agent-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID'::uuid, '$WS_ID'::uuid, '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ID'::uuid, '$WS_ID'::uuid, 'hermes-agent', 'http://localhost:8088/v1',
   'MOMO-656 verifier', '$OWNER_ID'::uuid);
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID'::uuid, '$CHANNEL_ID'::uuid, '$OWNER_ID'::uuid, 'owner'),
  ('$WS_ID'::uuid, '$CHANNEL_ID'::uuid, '$AGENT_ID'::uuid, 'member');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WS_ID'::uuid, '$OWNER_ID'::uuid, 'owner'),
  ('$WS_ID'::uuid, '$AGENT_ID'::uuid, 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_ID'::uuid, '$WS_ID'::uuid, '$AGENT_ID'::uuid, '$CHANNEL_ID'::uuid,
   'running', '{"prompt":"MOMO-656 reconcile"}'::jsonb, 1, 50, 0,
   'momo-656-reconcile-$RUN_TAG');
INSERT INTO work_tier_policy (workspace_id, member_id, mode)
VALUES ('$WS_ID'::uuid, '$OWNER_ID'::uuid, 'ask')
ON CONFLICT (workspace_id, member_id) WHERE member_id IS NOT NULL
DO UPDATE SET mode='ask', auto_target=NULL, updated_at=clock_timestamp();
COMMIT;
SQL

curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" >"$TMP_DIR/login.json"
OWNER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/login.json")"
printf '%s\n' "$OWNER_TOKEN" >"$TMP_DIR/registration.token"
chmod 600 "$TMP_DIR/registration.token"

# A long-lived tool: the session must still be alive when the daemon dies, or
# there would be nothing for the restart to fail to revive.
# The marker makes any process this run leaks greppable for cleanup. Closing
# the daemon's PTY master should SIGHUP the whole child tree on its own; the
# pkill in cleanup is belt and braces, not the primary mechanism.
CHILD_MARKER="MOMO656_CHILD_${RUN_TAG//-/_}"
SHELL_ARGS_JSON="$(jq -cn --arg command "sleep 900 # $CHILD_MARKER" '["-c",$command]')"

start_workd() {
  local log="$1"
  env \
    MOMO_WORKD_PROFILE_SHELL_EXECUTABLE=/bin/sh \
    MOMO_WORKD_PROFILE_SHELL_ARGUMENTS_JSON="$SHELL_ARGS_JSON" \
    MOMO_WORKD_SERVER_URL="$BASE_URL" \
    MOMO_WORKD_ALLOW_INSECURE_HTTP=1 \
    MOMO_WORKD_WORKSPACE_ID="$WS_ID" \
    MOMO_WORKD_SCOPE=workspace \
    MOMO_WORKD_DISPLAY_NAME="MOMO-656 reconcile host" \
    MOMO_WORKD_KEY_PATH="$TMP_DIR/workd.key" \
    MOMO_WORKD_HOST_ID_PATH="$TMP_DIR/workd.host-id" \
    MOMO_WORKD_OUTPUT_DIR="$TMP_DIR/output" \
    MOMO_WORKD_POLL_INTERVAL_MS=100 \
    MOMO_WORKD_HEARTBEAT_INTERVAL_MS=1000 \
    "${@:2}" \
    "$WORKD_BIN" >"$log" 2>&1 &
  WORKD_PID=$!
}

# ---- boot 1: register, then spawn a real session -----------------------------
start_workd "$TMP_DIR/workd-1.log" \
  MOMO_WORKD_REGISTRATION_TOKEN_FILE="$TMP_DIR/registration.token"

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ ! -s "$TMP_DIR/workd.host-id" ] && [ "$(date -u +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    sed -n '1,120p' "$TMP_DIR/workd-1.log" >&2
    echo "[reconcile] daemon exited before registration" >&2
    exit 1
  fi
  sleep 1
done
[ -s "$TMP_DIR/workd.host-id" ] || {
  sed -n '1,120p' "$TMP_DIR/workd-1.log" >&2
  echo "[reconcile] host registration timeout" >&2
  exit 1
}
HOST_ID="$(lower_uuid "$(tr -d '[:space:]' <"$TMP_DIR/workd.host-id")")"

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
    echo "[reconcile] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    printf '%s' "$RESPONSE_BODY" | jq 'del(.token,.accessToken,.refreshToken)' \
      >&2 2>/dev/null || echo "[reconcile] non-JSON body redacted" >&2
    exit 1
  }
}

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-656 reconcile verifier"}'
expect_status 201 "agent bearer create"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"

api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/shell"
expect_status 200 "enable shell auto approval"

api "$AGENT_TOKEN" POST "/v1/workspaces/$WS_ID/work-controls" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg run "$RUN_ID" --arg host "$HOST_ID" \
    '{channelId:$channel,runId:$run,targetHostId:$host,kind:"spawn",
      payload:{tool:"shell",label:"MOMO-656 long session"}}')"
expect_status 201 "dispatched spawn"
CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
SESSION_ID=""
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  row="$(sql_value <<SQL
SELECT coalesce(wc.session_id::text,'') || ':' || coalesce(ws.status,'')
  FROM work_control wc
  LEFT JOIN work_session ws ON ws.id=wc.session_id
 WHERE wc.id='$CONTROL_ID'::uuid;
SQL
)"
  case "$row" in
    *:running|*:idle)
      SESSION_ID="${row%%:*}"
      break
      ;;
  esac
  if ! kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    sed -n '1,160p' "$TMP_DIR/workd-1.log" >&2
    echo "[reconcile] daemon exited during dispatch" >&2
    exit 1
  fi
  sleep 1
done
[ -n "$SESSION_ID" ] || {
  sed -n '1,160p' "$TMP_DIR/workd-1.log" >&2
  echo "[reconcile] live session never appeared" >&2
  exit 1
}
SESSION_ID="$(lower_uuid "$SESSION_ID")"
ROOT_ID="$(sql_value <<SQL
SELECT root_message_id FROM work_session WHERE id='$SESSION_ID'::uuid;
SQL
)"

# ---- the fast restart --------------------------------------------------------
# SIGKILL, not SIGTERM: nothing gets a chance to report an orderly end, which
# is precisely the #870 condition. Heartbeats stop for well under the grace.
kill_workd
WORKD_PID=""

got="$(sql_value <<SQL
SELECT status || ':' || (host_lost_at IS NULL)::text
  FROM work_session WHERE id='$SESSION_ID'::uuid;
SQL
)"
case "$got" in
  running:true|idle:true) ;;
  *)
    echo "[reconcile] FAIL ledger should still hold a live, unmarked session: $got" >&2
    exit 1
    ;;
esac

# Notifier is up before the restart so a heartbeat-age sweep would have every
# chance to fire first. With a one-hour grace it cannot.
compose up -d notifier
sleep 3
got="$(sql_value <<SQL
SELECT status FROM work_session WHERE id='$SESSION_ID'::uuid;
SQL
)"
case "$got" in
  running|idle) ;;
  *)
    echo "[reconcile] FAIL sweep transitioned before any host report: $got" >&2
    exit 1
    ;;
esac

# ---- boot 2: the restarted daemon reports what it cannot revive ---------------
start_workd "$TMP_DIR/workd-2.log"

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID'::uuid
   AND action='work.session.host_lost'
   AND lower(target_id::text)=lower('$SESSION_ID')
   AND detail->>'schema'='momo.work_session.host_lost.v1'
   AND lower(detail->>'source_host_id')=lower('$HOST_ID');
SQL
)"
  [ "$got" = "1" ] && break
  if ! kill -0 "$WORKD_PID" >/dev/null 2>&1; then
    sed -n '1,160p' "$TMP_DIR/workd-2.log" >&2
    echo "[reconcile] restarted daemon exited" >&2
    exit 1
  fi
  sleep 1
done
[ "${got:-0}" = "1" ] || {
  sed -n '1,160p' "$TMP_DIR/workd-2.log" >&2
  echo "[reconcile] FAIL restart reconciliation was never reported" >&2
  exit 1
}

# ---- the report joins the existing orphaned path ------------------------------
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM work_session
 WHERE id='$SESSION_ID'::uuid AND status='orphaned' AND host_lost_at IS NULL;
SQL
)"
  [ "$got" = "1" ] && break
  sleep 1
done
[ "${got:-0}" = "1" ] || {
  compose logs --tail 160 notifier >&2
  echo "[reconcile] FAIL session never joined the orphaned path" >&2
  exit 1
}

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM message
 WHERE root_id='$ROOT_ID'::uuid AND type='approval_request'
   AND props->>'kind'='resume_offer'
   AND lower(props->>'session_id')=lower('$SESSION_ID');
SQL
)"
  [ "$got" = "1" ] && break
  sleep 1
done
[ "${got:-0}" = "1" ] || {
  compose logs --tail 160 notifier >&2
  echo "[reconcile] FAIL missing resume_offer card" >&2
  exit 1
}

# The reused path in full: root card status, realtime orphan event, audit
# provenance that names reconciliation rather than the heartbeat sweep.
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM message
    WHERE id='$ROOT_ID'::uuid AND props->>'status'='orphaned') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE workspace_id='$WS_ID'::uuid
      AND payload->'data'->>'type'='work.session.orphaned'
      AND lower(payload->'data'->'payload'->>'session_id')=lower('$SESSION_ID')) || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID'::uuid
      AND action='work.session.orphaned'
      AND lower(target_id::text)=lower('$SESSION_ID')
      AND detail->>'orphan_source'='host_reconciliation') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID'::uuid
      AND action='work.session.resume_offered'
      AND lower(target_id::text)=lower('$SESSION_ID'));
SQL
)"
[ "$got" = "1:1:1:1" ] || {
  echo "[reconcile] FAIL orphaned path evidence: $got" >&2
  exit 1
}

# No new lifecycle vocabulary was invented for the host-reported case.
got="$(sql_value <<SQL
SELECT count(*) FROM work_session
 WHERE id='$SESSION_ID'::uuid AND end_reason IS NOT NULL;
SQL
)"
[ "$got" = "0" ] || {
  echo "[reconcile] FAIL orphaned session must not carry an end_reason: $got" >&2
  exit 1
}

# ---- the report is host-signed, and only for the host's own sessions ----------
FORGED_SIGNATURE="$($PYTHON_BIN -c \
  'import base64; print(base64.b64encode(bytes(64)).decode("ascii"))')"
FORGED_STATUS="$(curl -sS -o "$TMP_DIR/forged.json" -w '%{http_code}' \
  -X POST "$BASE_URL/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/reconcile" \
  -H 'Content-Type: application/json' \
  -H "Authorization: MomoHost $HOST_ID" \
  -H "X-Momo-Work-Host-Sent-At: $(now_ms)" \
  -H "X-Momo-Work-Host-Request-ID: $(new_uuid)" \
  -H "X-Momo-Work-Host-Signature: $FORGED_SIGNATURE" \
  --data '{"lostSessionIds":[]}')"
[ "$FORGED_STATUS" = "401" ] || {
  echo "[reconcile] FAIL forged reconcile expected HTTP 401, got $FORGED_STATUS" >&2
  exit 1
}
BEARER_STATUS="$(curl -sS -o "$TMP_DIR/bearer.json" -w '%{http_code}' \
  -X POST "$BASE_URL/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/reconcile" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  --data '{"lostSessionIds":[]}')"
case "$BEARER_STATUS" in
  401|403) ;;
  *)
    echo "[reconcile] FAIL human bearer must not reconcile a host: $BEARER_STATUS" >&2
    exit 1
    ;;
esac

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='65600000-0000-7000-8000-000000000099';
SELECT count(*) FROM work_session WHERE workspace_id='$WS_ID'::uuid;
COMMIT;
SQL
)"
[ "$got" = "0" ] || {
  echo "[reconcile] FAIL cross-tenant RLS isolation: $got" >&2
  exit 1
}

echo "MOMO-656 daemon restart reconciliation -> orphaned + resume_offer via real restart PASS"
