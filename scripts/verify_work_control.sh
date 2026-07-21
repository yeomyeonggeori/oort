#!/usr/bin/env bash
# MOMO-484/MOMO-493 / ADR-0114 work-control approval, dispatch, ack, snapshot, and RLS gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[work-control] missing $1" >&2
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
  echo "[work-control] Python 3.10+ not found (tried python3.13 through python3)" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORK_CONTROL_GATE_PROJECT:-momo484workcontrol}"
API_PORT="${WORK_CONTROL_GATE_API_PORT:-27920}"
CENT_PORT_HOST="${WORK_CONTROL_GATE_CENTRIFUGO_PORT:-27921}"
PG_PORT="${WORK_CONTROL_GATE_POSTGRES_PORT:-27922}"
HERMES_PORT_HOST="${WORK_CONTROL_GATE_HERMES_PORT:-27923}"
BOOT_TIMEOUT="${WORK_CONTROL_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${WORK_CONTROL_GATE_ASSERT_TIMEOUT:-240}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-control.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_TENANT_ID="48400000-0000-7000-8000-000000000099"
CENT_CHANNEL="ch:ws${WS_ID}.${CHANNEL_ID}"
CENT_API_KEY="${CENT_API_KEY:-change-me-cent-api-key}"
OWNER_ID="$(new_uuid)"
OTHER_OWNER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
HOST_ID="$(new_uuid)"
HOST_PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="
RUN_APPROVE_ID="$(new_uuid)"
RUN_AUTO_ID="$(new_uuid)"
RUN_DENY2_ID="$(new_uuid)"
RUN_DENY_ID="$(new_uuid)"
OWNER_EMAIL="work-control-owner-$RUN_ID@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
OTHER_OWNER_EMAIL="work-control-other-$RUN_ID@momo.local"
OTHER_OWNER_PASSWORD="other-$(new_uuid)"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORK_CONTROL_GATE_KEEP:-0}" = "1" ]; then
    echo "[work-control] leaving compose project '$PROJECT' up"
    echo "[work-control] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-work-control.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[work-control] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
CENT_API_URL="http://127.0.0.1:$CENT_PORT_HOST/api"

echo "[work-control] booting isolated api/relay stack '$PROJECT'"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[work-control] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-control] api exited" >&2
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
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Work Control Owner', 'wco-$RUN_ID'),
  ('$OTHER_OWNER_ID', '$WS_ID', 'human', 'active', 'Other Work Control Owner', 'wco-other-$RUN_ID'),
  ('$AGENT_ID', '$WS_ID', 'agent', 'active', 'Work Control Agent', 'wca-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true,
   momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$OTHER_OWNER_ID', '$WS_ID', '$OTHER_OWNER_EMAIL', true,
   momo_password_hash('$OTHER_OWNER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ID', '$WS_ID', 'hermes-agent', 'http://localhost:8088/v1',
   'MOMO-484 verifier', '$OWNER_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$OTHER_OWNER_ID', 'member'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WS_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$OTHER_OWNER_ID', 'member'),
  ('$WS_ID', '$AGENT_ID', 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_APPROVE_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"MOMO-484 approve flow"}'::jsonb, 1, 50, 0,
   'momo-484-approve-$RUN_ID'),
  ('$RUN_AUTO_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"MOMO-484 auto flow"}'::jsonb, 1, 50, 0,
   'momo-484-auto-$RUN_ID'),
  ('$RUN_DENY2_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"MOMO-484 deny2 flow"}'::jsonb, 1, 50, 0,
   'momo-484-deny2-$RUN_ID'),
  ('$RUN_DENY_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"MOMO-484 deny flow"}'::jsonb, 1, 50, 0,
   'momo-484-deny-$RUN_ID');
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
    echo "[work-control] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" >"$TMP_DIR/login.json"
OWNER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/login.json")"

curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OTHER_OWNER_EMAIL" --arg p "$OTHER_OWNER_PASSWORD" \
    --arg w "$WS_ID" '{email:$e,password:$p,workspace:$w}')" \
  >"$TMP_DIR/other-login.json"
OTHER_OWNER_TOKEN="$(jq -er '.accessToken' "$TMP_DIR/other-login.json")"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-hosts" \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
    '{scope:"member",type:"app",displayName:"MOMO-484 host",publicKey:$key,
      capabilities:{"tool.codex":true}}')"
expect_status 201 "work host registration"
HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase')"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-484 work control verifier"}'
expect_status 201 "agent bearer create"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.credential.scopes | index("work:control") != null' >/dev/null

CONTROL_PATH="/v1/workspaces/$WS_ID/work-controls"
spawn_body() {
  local run_id="$1" label="$2"
  jq -cn --arg channel "$CHANNEL_ID" --arg run "$run_id" --arg host "$HOST_ID" \
    --arg label "$label" \
    '{channelId:$channel,runId:$run,targetHostId:$host,kind:"spawn",
      payload:{tool:"codex",label:$label}}'
}

# Human access tokens can reach the protected group but can never create an
# agent control, even when the request otherwise names a valid run.
api "$OWNER_TOKEN" POST "$CONTROL_PATH" "$(spawn_body "$RUN_APPROVE_ID" human-bypass)"
expect_status 403 "human work control create"

# Whitelist miss: durable pending control + existing approval_request card.
api "$AGENT_TOKEN" POST "$CONTROL_PATH" "$(spawn_body "$RUN_APPROVE_ID" approval-required)"
expect_status 201 "spawn whitelist miss"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.workControl.kind == "spawn" and .workControl.status == "pending_approval"
   and .workControl.approvalMessageId != null and .workControl.sessionId == null' >/dev/null
CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"
APPROVAL_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er \
  '.workControl.approvalMessageId | ascii_downcase')"

HISTORY_PATH="/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages?after=0&limit=200"
api "$OWNER_TOKEN" GET "$HISTORY_PATH"
expect_status 200 "approval card history"
APPROVAL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er \
  --arg control "$CONTROL_ID" --arg message "$APPROVAL_MESSAGE_ID" '
  [.messages[]
   | select((.id | ascii_downcase) == $message)
   | select(.type == "approval_request")
   | select(.props.kind == "work_control_approval")
   | select((.props.control_id | ascii_downcase) == $control)
   | select(.props.action_type == "work.spawn" and .props.approval_status == "pending")]
  | if length == 1 then .[0].props.approval_id else error("approval card mismatch") end
  | ascii_downcase')"

# Security invariant: pending controls are not executable or acknowledgeable.
api "$OWNER_TOKEN" POST "$CONTROL_PATH/$CONTROL_ID/ack" '{"ok":false,"errorLabel":"pending"}'
expect_status 409 "pending ack bypass"

DECISION_ID="$(new_uuid)"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/approvals/$APPROVAL_ID/decision" \
  "$(jq -cn --arg approval "$APPROVAL_ID" --arg decision "$DECISION_ID" \
    '{approval_id:$approval,approve:true,reason:"MOMO-484 approved",client_decision_id:$decision}')"
expect_status 200 "spawn approval"
printf '%s' "$RESPONSE_BODY" | jq -e '.status == "approved"' >/dev/null

got="$(sql_value <<SQL
SELECT count(*) FROM work_control
 WHERE id='$CONTROL_ID' AND status='dispatched'
   AND approval_message_id='$APPROVAL_MESSAGE_ID';
SQL
)"
[ "$got" = "1" ] || {
  echo "[work-control] FAIL approved control did not dispatch: $got" >&2
  exit 1
}

wait_for_control_event() {
  local event_type="$1" control_id="$2" expected_session="${3:-}"
  local delivered=0 history matches
  deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    history="$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
      -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg ch "$CENT_CHANNEL" '{channel:$ch,limit:200,reverse:true}')" \
      "$CENT_API_URL/history" 2>/dev/null || printf '{}')"
    matches="$(printf '%s' "$history" | jq -r \
      --arg event "$event_type" --arg control "$control_id" --arg host "$HOST_ID" \
      --arg session "$expected_session" '
      [.result.publications[]?.data
       | select(.type == $event)
       | select((.payload.control_id | ascii_downcase) == $control)
       | select((.payload.target_host_id | ascii_downcase) == $host)
       | select(.payload.kind == "spawn")
       | select(.payload.payload.tool == "codex")
       | select(if $session == "" then .payload.session_id == null
                else (.payload.session_id | ascii_downcase) == $session end)]
      | length' 2>/dev/null || printf '0')"
    if [ "$matches" != "0" ]; then
      delivered=1
      break
    fi
    sleep 1
  done
  [ "$delivered" = "1" ] || {
    compose logs --tail 120 relay >&2 || true
    echo "[work-control] FAIL $event_type was not delivered for $control_id" >&2
    exit 1
  }
}
wait_for_control_event "work.control.dispatched" "$CONTROL_ID"

# Host executes spawn by creating the existing MOMO-483 session ledger, then
# acknowledges with that exact session. The server validates the FK/binding.
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$HOST_ID" \
    '{channelId:$channel,hostId:$host,tool:"codex",label:"MOMO-484 spawned session"}')"
expect_status 201 "spawned work session ledger"
SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"

api "$OWNER_TOKEN" POST "$CONTROL_PATH/$CONTROL_ID/ack" \
  "$(jq -cn --arg session "$SESSION_ID" '{ok:true,sessionId:$session}')"
expect_status 200 "spawn ack"
printf '%s' "$RESPONSE_BODY" | jq -e --arg session "$SESSION_ID" \
  '.workControl.status == "acked" and
   ((.workControl.sessionId | ascii_downcase) == $session)' >/dev/null
wait_for_control_event "work.control.acked" "$CONTROL_ID" "$SESSION_ID"

got="$(sql_value <<SQL
SELECT count(*) FROM work_control wc
JOIN work_session ws ON ws.id=wc.session_id
 WHERE wc.id='$CONTROL_ID' AND wc.status='acked'
   AND ws.id='$SESSION_ID' AND ws.host_id='$HOST_ID' AND ws.status='running';
SQL
)"
[ "$got" = "1" ] || {
  echo "[work-control] FAIL spawn ack did not bind work_session: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type' IN ('work.control.dispatched','work.control.acked')
   AND payload->'data'->'payload'->>'control_id' ILIKE '$CONTROL_ID'
   AND NOT (payload ? 'version')
   AND NOT (payload->'data' ? 'seq')
   AND (SELECT count(*) FROM jsonb_object_keys(payload))=3;
SQL
)"
[ "$got" = "2" ] || {
  echo "[work-control] FAIL control events are not exact no-version envelopes: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT count(DISTINCT payload->>'idempotency_key') FROM outbox
 WHERE payload->'data'->>'type' IN ('work.control.dispatched','work.control.acked')
   AND payload->'data'->'payload'->>'control_id' ILIKE '$CONTROL_ID';
SQL
)"
[ "$got" = "2" ] || {
  echo "[work-control] FAIL control idempotency keys are not unique: $got" >&2
  exit 1
}

# Auto-approve snapshots are human-only even when the agent bearer has the
# work:control scope used for control creation.
api "$AGENT_TOKEN" GET "/v1/workspaces/$WS_ID/work-auto-approvals"
expect_status 403 "agent auto-approve snapshot"

# Self-owned auto-approve configuration and its audit row commit together.
api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/codex"
expect_status 200 "enable auto approve"
printf '%s' "$RESPONSE_BODY" | jq -e '.tool == "codex" and .enabled == true' >/dev/null
api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/shell"
expect_status 200 "enable shell auto approve"
api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/claude"
expect_status 200 "enable claude auto approve"

api "$OWNER_TOKEN" GET "/v1/workspaces/$WS_ID/work-auto-approvals"
expect_status 200 "list auto approvals after enable"
printf '%s' "$RESPONSE_BODY" | jq -e '
  keys == ["tools"] and
  .tools == ["claude", "codex", "shell"] and
  all(.tools[]; type == "string")
' >/dev/null
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_auto_approve
    WHERE workspace_id='$WS_ID' AND host_owner_member_id='$OWNER_ID' AND tool='codex')
  || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND actor_member_id='$OWNER_ID'
      AND action='work.auto_approve.enabled'
      AND detail->>'tool'='codex' AND detail->>'enabled'='true');
SQL
)"
[ "$got" = "1:1" ] || {
  echo "[work-control] FAIL auto-approve row/audit transaction evidence: $got" >&2
  exit 1
}

# MOMO-486 liveness: approval decisions close the bound run, so reuse would 409.
api "$AGENT_TOKEN" POST "$CONTROL_PATH" "$(spawn_body "$RUN_AUTO_ID" auto-approved)"
expect_status 201 "auto-approved spawn"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.workControl.status == "dispatched" and .workControl.approvalMessageId == null' >/dev/null
AUTO_CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"
wait_for_control_event "work.control.dispatched" "$AUTO_CONTROL_ID"

# A second human has an independent setting. The caller-owned GET must not
# expose it before or after the first owner's DELETE.
api "$OTHER_OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/opencode"
expect_status 200 "enable other member auto approve"

# Remove the codex whitelist before the denial scenario; DELETE is audited too.
api "$OWNER_TOKEN" DELETE "/v1/workspaces/$WS_ID/work-auto-approvals/codex"
expect_status 200 "disable auto approve"
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_auto_approve
    WHERE workspace_id='$WS_ID' AND host_owner_member_id='$OWNER_ID' AND tool='codex')
  || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND actor_member_id='$OWNER_ID'
      AND action='work.auto_approve.disabled' AND detail->>'tool'='codex');
SQL
)"
[ "$got" = "0:1" ] || {
  echo "[work-control] FAIL auto-approve delete/audit transaction evidence: $got" >&2
  exit 1
}

api "$OWNER_TOKEN" GET "/v1/workspaces/$WS_ID/work-auto-approvals"
expect_status 200 "list auto approvals after delete"
printf '%s' "$RESPONSE_BODY" | jq -e '
  keys == ["tools"] and
  .tools == ["claude", "shell"] and
  (.tools | index("codex")) == null and
  (.tools | index("opencode")) == null
' >/dev/null

api "$OTHER_OWNER_TOKEN" GET "/v1/workspaces/$WS_ID/work-auto-approvals"
expect_status 200 "other member auto-approve isolation"
printf '%s' "$RESPONSE_BODY" | jq -e \
  'keys == ["tools"] and .tools == ["opencode"]' >/dev/null

api "$AGENT_TOKEN" POST "$CONTROL_PATH" "$(spawn_body "$RUN_DENY2_ID" denied-spawn)"
expect_status 201 "denied scenario pending spawn"
DENIED_CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"
DENIED_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er \
  '.workControl.approvalMessageId | ascii_downcase')"
DENIED_APPROVAL_ID="$(sql_value <<SQL
SELECT id FROM approval WHERE request_message_id='$DENIED_MESSAGE_ID';
SQL
)"

api "$OWNER_TOKEN" POST "$CONTROL_PATH/$DENIED_CONTROL_ID/ack" \
  '{"ok":false,"errorLabel":"pending"}'
expect_status 409 "second pending ack bypass"

DENY_DECISION_ID="$(new_uuid)"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/approvals/$DENIED_APPROVAL_ID/decision" \
  "$(jq -cn --arg approval "$DENIED_APPROVAL_ID" --arg decision "$DENY_DECISION_ID" \
    '{approval_id:$approval,approve:false,reason:"MOMO-484 denied",client_decision_id:$decision}')"
expect_status 200 "deny spawn"
printf '%s' "$RESPONSE_BODY" | jq -e '.status == "rejected"' >/dev/null

sleep 2
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_control
    WHERE id='$DENIED_CONTROL_ID' AND status='denied')
  || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.control.dispatched'
      AND payload->'data'->'payload'->>'control_id' ILIKE '$DENIED_CONTROL_ID');
SQL
)"
[ "$got" = "1:0" ] || {
  echo "[work-control] FAIL denied control dispatched or failed to settle: $got" >&2
  exit 1
}

# input/kill are approval-free only while the approved session is running.
api "$OWNER_TOKEN" PATCH "/v1/workspaces/$WS_ID/work-sessions/$SESSION_ID" \
  '{"status":"ended","exitCode":0}'
expect_status 200 "end approved session"
api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg run "$RUN_APPROVE_ID" \
    --arg host "$HOST_ID" --arg session "$SESSION_ID" \
    '{channelId:$channel,runId:$run,targetHostId:$host,sessionId:$session,
      kind:"input",payload:{text:"must not reach ended session"}}')"
expect_status 409 "input to nonrunning session"

# The database payload CHECK is closed over allowed keys, independently of API
# validation. This block must observe a check violation for an injected cwd.
run_sql <<SQL
DO \$guard\$
BEGIN
  BEGIN
    INSERT INTO work_control
      (workspace_id, channel_id, requester_member_id, target_host_id,
       kind, payload, status)
    VALUES
      ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', '$HOST_ID', 'spawn',
       '{"tool":"codex","label":"bad","cwd":"/tmp/repo"}'::jsonb,
       'approved');
    RAISE EXCEPTION 'work_control payload CHECK accepted cwd';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
\$guard\$;
SQL

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_TENANT_ID';
SELECT
  (SELECT count(*) FROM work_control WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM work_auto_approve WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM approval WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type' IN ('work.control.dispatched','work.control.acked'));
COMMIT;
SQL
)"
[ "$got" = "0:0:0:0" ] || {
  echo "[work-control] FAIL cross-tenant RLS isolation: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT count(*) FROM pg_class
 WHERE relname IN ('work_control','work_auto_approve')
   AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$got" = "2" ] || {
  echo "[work-control] FAIL FORCE RLS metadata: $got" >&2
  exit 1
}

echo "MOMO-484/493 work-control approval/auto-approve snapshot + no-version dispatch/ack + bypass/RLS PASS"
