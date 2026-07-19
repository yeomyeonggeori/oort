#!/usr/bin/env bash
# MOMO-487 / ADR-0125 D1/D8 work-host registry and control-routing gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[work-host] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq

# Resolve an OpenSSL that actually supports Ed25519. macOS ships LibreSSL at
# /usr/bin/openssl (no ED25519 genpkey), and a login shell (gate uses `bash -lc`)
# can resolve it ahead of Homebrew's OpenSSL 3.x — a bare `openssl` therefore
# fails silently under set -e. Pick the first candidate that can genpkey Ed25519.
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
  echo "[work-host] no OpenSSL with Ed25519 genpkey support found" >&2
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
  echo "[work-host] Python 3.10+ not found (tried python3.13 through python3)" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }
now_ms() { "$PYTHON_BIN" -c 'import time; print(time.time_ns() // 1_000_000)'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORK_HOST_GATE_PROJECT:-momo487workhost}"
API_PORT="${WORK_HOST_GATE_API_PORT:-27940}"
CENT_PORT_HOST="${WORK_HOST_GATE_CENTRIFUGO_PORT:-27941}"
PG_PORT="${WORK_HOST_GATE_POSTGRES_PORT:-27942}"
HERMES_PORT_HOST="${WORK_HOST_GATE_HERMES_PORT:-27943}"
BOOT_TIMEOUT="${WORK_HOST_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${WORK_HOST_GATE_ASSERT_TIMEOUT:-240}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-host.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_WS_ID="48700000-0000-7000-8000-000000000099"
CROSS_MEMBER_ID="$(new_uuid)"
CROSS_HOST_ID="$(new_uuid)"
CENT_CHANNEL="ch:ws${WS_ID}.${CHANNEL_ID}"
CENT_API_KEY="${CENT_API_KEY:-change-me-cent-api-key}"
OWNER_ID="$(new_uuid)"
OTHER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
MISSING_HOST_ID="$(new_uuid)"
RUN_MISSING_ID="$(new_uuid)"
RUN_CROSS_ID="$(new_uuid)"
RUN_SCOPE_ID="$(new_uuid)"
RUN_DISPATCH_ID="$(new_uuid)"
RUN_PENDING_ID="$(new_uuid)"
RUN_REVOKED_ID="$(new_uuid)"
OWNER_EMAIL="work-host-owner-$RUN_TAG@momo.local"
OTHER_EMAIL="work-host-member-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
OTHER_PASSWORD="member-$(new_uuid)"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORK_HOST_GATE_KEEP:-0}" = "1" ]; then
    echo "[work-host] leaving compose project '$PROJECT' up"
    echo "[work-host] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-work-host.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[work-host] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
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
"$OPENSSL_BIN" pkey -in "$PRIVATE_KEY" -pubout -outform DER -out "$PUBLIC_DER" >/dev/null 2>&1
PUBLIC_KEY="$(tail -c 32 "$PUBLIC_DER" | "$OPENSSL_BIN" base64 -A)"
FORGED_SIGNATURE="$($PYTHON_BIN -c \
  'import base64; print(base64.b64encode(bytes(64)).decode("ascii"))')"

sign_heartbeat() {
  local host_id="$1" sent_at_ms="$2"
  local payload="$TMP_DIR/heartbeat-$host_id.txt"
  printf 'momo.work_host.heartbeat.v1\n%s\n%s\n%s' \
    "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at_ms" >"$payload"
  "$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$PRIVATE_KEY" -in "$payload" \
    | "$OPENSSL_BIN" base64 -A
}

BASE_URL="http://127.0.0.1:$API_PORT"
CENT_API_URL="http://127.0.0.1:$CENT_PORT_HOST/api"

echo "[work-host] booting isolated api/relay stack '$PROJECT'"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[work-host] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-host] api exited" >&2
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
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Work Host Owner', 'who-$RUN_TAG'),
  ('$OTHER_ID', '$WS_ID', 'human', 'active', 'Work Host Member', 'whm-$RUN_TAG'),
  ('$AGENT_ID', '$WS_ID', 'agent', 'active', 'Work Host Agent', 'wha-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$OTHER_ID', '$WS_ID', '$OTHER_EMAIL', true, momo_password_hash('$OTHER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ID', '$WS_ID', 'hermes-agent', 'http://localhost:8088/v1',
   'MOMO-487 verifier', '$OWNER_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$OTHER_ID', 'member'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_MISSING_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"missing host"}'::jsonb, 1, 50, 0, 'momo-487-missing-$RUN_TAG'),
  ('$RUN_CROSS_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"cross host"}'::jsonb, 1, 50, 0, 'momo-487-cross-$RUN_TAG'),
  ('$RUN_SCOPE_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"scope host"}'::jsonb, 1, 50, 0, 'momo-487-scope-$RUN_TAG'),
  ('$RUN_DISPATCH_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"dispatch host"}'::jsonb, 1, 50, 0, 'momo-487-dispatch-$RUN_TAG'),
  ('$RUN_PENDING_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"revoke host"}'::jsonb, 1, 50, 0, 'momo-487-pending-$RUN_TAG'),
  ('$RUN_REVOKED_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"revoked host"}'::jsonb, 1, 50, 0, 'momo-487-revoked-$RUN_TAG');

INSERT INTO workspace (id, slug, name)
VALUES ('$CROSS_WS_ID', 'momo-487-cross-$RUN_TAG', 'MOMO-487 Cross Workspace');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$CROSS_MEMBER_ID', '$CROSS_WS_ID', 'human', 'active',
        'Cross Host Owner', 'whx-$RUN_TAG');
INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name, public_key)
VALUES
  ('$CROSS_HOST_ID', '$CROSS_WS_ID', 'workspace', '$CROSS_MEMBER_ID',
   'workd', 'Cross Workspace Host', '$PUBLIC_KEY');
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
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[work-host] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    printf '%s' "$RESPONSE_BODY" | jq 'del(.token,.accessToken,.refreshToken)' \
      >&2 2>/dev/null || echo "[work-host] non-JSON response body redacted" >&2
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

register_host() {
  local token="$1" scope="$2" name="$3"
  api "$token" POST "$HOSTS_PATH" \
    "$(jq -cn --arg scope "$scope" --arg name "$name" --arg key "$PUBLIC_KEY" \
      '{scope:$scope,type:"workd",displayName:$name,publicKey:$key,
        capabilities:{"tool.codex":true,"tool.shell":false}}')"
  expect_status 201 "register $name"
  printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase'
}

OWNER_HOST_ID="$(register_host "$OWNER_TOKEN" workspace 'Owner Workspace Host')"
MEMBER_HOST_ID="$(register_host "$OTHER_TOKEN" member 'Member Private Host')"
MEMBER_WORKSPACE_HOST_ID="$(register_host "$OTHER_TOKEN" workspace 'Member Workspace Host')"

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_host
    WHERE id IN ('$OWNER_HOST_ID','$MEMBER_HOST_ID','$MEMBER_WORKSPACE_HOST_ID'))
  || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.host.registered'
      AND target_id IN ('$OWNER_HOST_ID','$MEMBER_HOST_ID','$MEMBER_WORKSPACE_HOST_ID'));
SQL
)"
[ "$got" = "3:3" ] || {
  echo "[work-host] FAIL registration/audit transaction evidence: $got" >&2
  exit 1
}

api "$OWNER_TOKEN" POST "$HOSTS_PATH" \
  "$(jq -cn --arg key "$PUBLIC_KEY" \
    '{scope:"member",type:"app",displayName:"unsafe",publicKey:$key,
      capabilities:{cwd:"/tmp/repo"}}')"
expect_status 400 "capability path value rejected"

api "$OWNER_TOKEN" GET "$HOSTS_PATH"
expect_status 200 "host list"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg owner "$OWNER_HOST_ID" --arg member "$MEMBER_HOST_ID" \
  --arg shared "$MEMBER_WORKSPACE_HOST_ID" '
  (.workHosts | length) == 3
  and any(.workHosts[]; (.id | ascii_downcase) == $owner and .scope == "workspace"
      and .ownerMemberId != null and .online == false)
  and any(.workHosts[]; (.id | ascii_downcase) == $member and .scope == "member")
  and any(.workHosts[]; (.id | ascii_downcase) == $shared and .scope == "workspace")
  ' >/dev/null

SENT_AT_MS="$(now_ms)"
HEARTBEAT_PATH="$HOSTS_PATH/$OWNER_HOST_ID/heartbeat"
api "" POST "$HEARTBEAT_PATH" \
  "$(jq -cn --argjson sent "$SENT_AT_MS" --arg signature "$FORGED_SIGNATURE" \
    '{sentAtMs:$sent,signature:$signature}')"
expect_status 401 "forged heartbeat"

SIGNATURE="$(sign_heartbeat "$OWNER_HOST_ID" "$SENT_AT_MS")"
api "" POST "$HEARTBEAT_PATH" \
  "$(jq -cn --argjson sent "$SENT_AT_MS" --arg signature "$SIGNATURE" \
    '{sentAtMs:$sent,signature:$signature}')"
expect_status 200 "signed heartbeat"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.workHost.online == true and (.workHost.lastSeenAtMs | type == "number")' >/dev/null

run_sql -c "UPDATE work_host SET last_seen_at=now()-interval '5 minutes' WHERE id='$OWNER_HOST_ID';"
api "$OWNER_TOKEN" GET "$HOSTS_PATH"
expect_status 200 "online window list"
printf '%s' "$RESPONSE_BODY" | jq -e --arg host "$OWNER_HOST_ID" \
  'any(.workHosts[]; (.id | ascii_downcase) == $host and .online == false)' >/dev/null

SENT_AT_MS="$(now_ms)"
SIGNATURE="$(sign_heartbeat "$OWNER_HOST_ID" "$SENT_AT_MS")"
api "" POST "$HEARTBEAT_PATH" \
  "$(jq -cn --argjson sent "$SENT_AT_MS" --arg signature "$SIGNATURE" \
    '{sentAtMs:$sent,signature:$signature}')"
expect_status 200 "signed heartbeat restores online state"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-487 verifier"}'
expect_status 201 "agent bearer create"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"
CONTROL_PATH="/v1/workspaces/$WS_ID/work-controls"
spawn_body() {
  local run_id="$1" host_id="$2" label="$3"
  jq -cn --arg channel "$CHANNEL_ID" --arg run "$run_id" --arg host "$host_id" \
    --arg label "$label" \
    '{channelId:$channel,runId:$run,targetHostId:$host,kind:"spawn",
      payload:{tool:"codex",label:$label}}'
}

api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(spawn_body "$RUN_MISSING_ID" "$MISSING_HOST_ID" missing-host)"
expect_status 404 "unregistered target host"
api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(spawn_body "$RUN_CROSS_ID" "$CROSS_HOST_ID" cross-workspace-host)"
expect_status 404 "cross-workspace target host"
api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(spawn_body "$RUN_SCOPE_ID" "$MEMBER_HOST_ID" foreign-member-host)"
expect_status 403 "member-scoped host belongs to another session owner"

api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/codex"
expect_status 200 "enable auto approve"
api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(spawn_body "$RUN_DISPATCH_ID" "$OWNER_HOST_ID" registered-host-dispatch)"
expect_status 201 "registered host dispatch"
DISPATCH_CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"
printf '%s' "$RESPONSE_BODY" | jq -e '.workControl.status == "dispatched"' >/dev/null
got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='work.control.dispatched'
   AND payload->'data'->'payload'->>'control_id' ILIKE '$DISPATCH_CONTROL_ID';
SQL
)"
[ "$got" = "1" ] || {
  echo "[work-host] FAIL registered host did not dispatch: $got" >&2
  exit 1
}

api "$OWNER_TOKEN" DELETE "/v1/workspaces/$WS_ID/work-auto-approvals/codex"
expect_status 200 "disable auto approve"
api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(spawn_body "$RUN_PENDING_ID" "$OWNER_HOST_ID" revoke-before-approval)"
expect_status 201 "pending control before revoke"
PENDING_CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"
APPROVAL_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er \
  '.workControl.approvalMessageId | ascii_downcase')"
APPROVAL_ID="$(sql_value <<SQL
SELECT id FROM approval WHERE request_message_id='$APPROVAL_MESSAGE_ID';
SQL
)"

api "$OTHER_TOKEN" DELETE "$HOSTS_PATH/$OWNER_HOST_ID"
expect_status 403 "non-owner non-admin revoke"
api "$OWNER_TOKEN" DELETE "$HOSTS_PATH/$OWNER_HOST_ID"
expect_status 200 "owner revoke"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.workHost.online == false and (.workHost.revokedAtMs | type == "number")' >/dev/null
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_host WHERE id='$OWNER_HOST_ID' AND revoked_at IS NOT NULL)
  || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.host.revoked' AND target_id='$OWNER_HOST_ID'
      AND actor_member_id='$OWNER_ID');
SQL
)"
[ "$got" = "1:1" ] || {
  echo "[work-host] FAIL revoke/audit transaction evidence: $got" >&2
  exit 1
}

SENT_AT_MS="$(now_ms)"
SIGNATURE="$(sign_heartbeat "$OWNER_HOST_ID" "$SENT_AT_MS")"
api "" POST "$HEARTBEAT_PATH" \
  "$(jq -cn --argjson sent "$SENT_AT_MS" --arg signature "$SIGNATURE" \
    '{sentAtMs:$sent,signature:$signature}')"
expect_status 401 "revoked host heartbeat"

DECISION_ID="$(new_uuid)"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/approvals/$APPROVAL_ID/decision" \
  "$(jq -cn --arg approval "$APPROVAL_ID" --arg decision "$DECISION_ID" \
    '{approval_id:$approval,approve:true,reason:"host revoked",client_decision_id:$decision}')"
expect_status 200 "approve after host revoke"
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_control
    WHERE id='$PENDING_CONTROL_ID' AND status='failed')
  || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.control.dispatched'
      AND payload->'data'->'payload'->>'control_id' ILIKE '$PENDING_CONTROL_ID')
  || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.control.acked'
      AND payload->'data'->'payload'->>'control_id' ILIKE '$PENDING_CONTROL_ID'
      AND payload->'data'->'payload'->>'status'='failed'
      AND payload->'data'->'payload'->>'ok'='false'
      AND payload->'data'->'payload'->>'error_label'='host_revoked'
      AND NOT (payload ? 'version'));
SQL
)"
[ "$got" = "1:0:1" ] || {
  echo "[work-host] FAIL revoked dispatch did not fail closed: $got" >&2
  exit 1
}

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
delivered=0
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  history="$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg ch "$CENT_CHANNEL" '{channel:$ch,limit:200,reverse:true}')" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')"
  matches="$(printf '%s' "$history" | jq -r --arg control "$PENDING_CONTROL_ID" '
    [.result.publications[]?.data
     | select(.type == "work.control.acked")
     | select((.payload.control_id | ascii_downcase) == $control)
     | select(.payload.status == "failed" and .payload.ok == false
              and .payload.error_label == "host_revoked")]
    | length' 2>/dev/null || printf '0')"
  if [ "$matches" != "0" ]; then delivered=1; break; fi
  sleep 1
done
[ "$delivered" = "1" ] || {
  compose logs --tail 120 relay >&2 || true
  echo "[work-host] FAIL failed ack event was not delivered" >&2
  exit 1
}

api "$AGENT_TOKEN" POST "$CONTROL_PATH" \
  "$(spawn_body "$RUN_REVOKED_ID" "$OWNER_HOST_ID" revoked-host-request)"
expect_status 404 "revoked target host"

api "$OWNER_TOKEN" DELETE "$HOSTS_PATH/$MEMBER_WORKSPACE_HOST_ID"
expect_status 200 "workspace admin revokes member-registered host"

run_sql <<SQL
DO \$guard\$
BEGIN
  BEGIN
    INSERT INTO work_host
      (workspace_id, scope, owner_member_id, type, display_name, public_key, capabilities)
    VALUES
      ('$WS_ID', 'member', '$OWNER_ID', 'app', 'bad capabilities', '$PUBLIC_KEY', '[]'::jsonb);
    RAISE EXCEPTION 'work_host capabilities CHECK accepted an array';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
\$guard\$;
SQL

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_WS_ID';
SELECT
  (SELECT count(*) FROM work_host WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM work_control WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND action LIKE 'work.host.%');
COMMIT;
SQL
)"
[ "$got" = "0:0:0" ] || {
  echo "[work-host] FAIL cross-tenant RLS isolation: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM pg_class
    WHERE relname='work_host' AND relrowsecurity AND relforcerowsecurity)
  || ':' ||
  (SELECT count(*) FROM pg_constraint
    WHERE conname IN ('work_session_host_fk','work_control_target_host_fk')
      AND convalidated)
  || ':' ||
  (SELECT count(*) FROM work_host h
    WHERE EXISTS (
      SELECT 1 FROM jsonb_each(h.capabilities) c
       WHERE jsonb_typeof(c.value) <> 'boolean'));
SQL
)"
[ "$got" = "1:2:0" ] || {
  echo "[work-host] FAIL RLS/FK/capability metadata: $got" >&2
  exit 1
}

echo "MOMO-487 work-host register/list/signed-heartbeat/revoke + control routing/failure + audit/RLS PASS"
