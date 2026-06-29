#!/usr/bin/env bash
# =============================================================================
# scripts/verify_approval_decision.sh — MOMO-167 approval decision runtime gate
#
# Prereq:
#   make up
#   make migrate
#
# Verifies:
#   - POST /v1/workspaces/{ws}/approvals/{approval}/decision approve/reject
#   - client_decision_id retry/idempotency conflict handling
#   - same-workspace channel membership enforcement
#   - expired approval click handling
#   - durable audit + approval_decision + outbox resume/broadcast records
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "[approval-decision] FAIL: $*" >&2
  if [ "${SERVER_LOG:-}" != "" ] && [ -f "$SERVER_LOG" ]; then
    echo "[approval-decision] server log: $SERVER_LOG" >&2
    tail -160 "$SERVER_LOG" >&2 || true
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
case "$CENT_API_URL" in
  *centrifugo*) CENT_API_URL="http://localhost:${CENT_PORT}/api" ;;
esac
JWT_HMAC="${JWT_HMAC:-dev-insecure-jwt-hmac-change-me}"
CENT_TOKEN_HMAC="${CENT_TOKEN_HMAC:-dev-insecure-cent-token-hmac}"

ADMIN_DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}}"
APP_DATABASE_URL="postgres://momo_app:momo_app_dev_pw@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
HUMAN_EMAIL="demo@momo.local"
NONMEMBER_EMAIL="approval-nonmember@momo.local"
HUMAN_ID="00000000-0000-7000-8000-000000000101"
AGENT_ID="00000000-0000-7000-8000-000000000102"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
NONMEMBER_ID="00000000-0000-7000-8000-000000167501"

APPROVE_RUN_ID="00000000-0000-7000-8000-000000167101"
APPROVE_MSG_ID="00000000-0000-7000-8000-000000167201"
APPROVE_ID="00000000-0000-7000-8000-000000167301"
APPROVE_DECISION_ID="00000000-0000-7000-8000-000000167401"

REJECT_RUN_ID="00000000-0000-7000-8000-000000167102"
REJECT_MSG_ID="00000000-0000-7000-8000-000000167202"
REJECT_ID="00000000-0000-7000-8000-000000167302"
REJECT_DECISION_ID="00000000-0000-7000-8000-000000167402"

EXPIRED_RUN_ID="00000000-0000-7000-8000-000000167103"
EXPIRED_MSG_ID="00000000-0000-7000-8000-000000167203"
EXPIRED_ID="00000000-0000-7000-8000-000000167303"
EXPIRED_DECISION_ID="00000000-0000-7000-8000-000000167403"

NONMEMBER_RUN_ID="00000000-0000-7000-8000-000000167104"
NONMEMBER_MSG_ID="00000000-0000-7000-8000-000000167204"
NONMEMBER_APPROVAL_ID="00000000-0000-7000-8000-000000167304"
NONMEMBER_DECISION_ID="00000000-0000-7000-8000-000000167404"

RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TMP_ROOT="${TMPDIR:-/tmp}"
SERVER_LOG="${TMP_ROOT}/momo-approval-decision-server-${RUN_SUFFIX}.log"
RESP_FILE="${TMP_ROOT}/momo-approval-decision-response-${RUN_SUFFIX}.json"
SERVER_PID=""

cleanup() {
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
  local deadline
  deadline=$(($(date +%s) + 45))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[approval-decision] MomoServer ready: ${url}"
      return 0
    fi
    sleep 1
  done
  fail "MomoServer did not become ready: ${url}"
}

post_decision() {
  local token="$1"
  local approval_id="$2"
  local approve="$3"
  local reason="$4"
  local client_decision_id="$5"
  curl -sS \
    -o "$RESP_FILE" \
    -w "%{http_code}" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "{\"approval_id\":\"${approval_id}\",\"approve\":${approve},\"reason\":\"${reason}\",\"client_decision_id\":\"${client_decision_id}\"}" \
    "http://127.0.0.1:${PORT}/v1/workspaces/${WORKSPACE_ID}/approvals/${approval_id}/decision"
}

assert_db_equals() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  local actual
  actual="$(psql_admin -t -A -c "$sql")"
  if [ "$actual" != "$expected" ]; then
    fail "${label}: expected '${expected}', got '${actual}'"
  fi
}

echo "[approval-decision] using env file: ${ENV_FILE:-<none>}"
echo "[approval-decision] api port=${PORT} postgres port=${POSTGRES_PORT}"
echo "[approval-decision] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null

echo "[approval-decision] seeding approval fixtures"
psql_admin <<SQL
BEGIN;
SET LOCAL row_security = off;

DELETE FROM approval_decision WHERE approval_id IN (
  '${APPROVE_ID}', '${REJECT_ID}', '${EXPIRED_ID}', '${NONMEMBER_APPROVAL_ID}'
);
DELETE FROM audit_log WHERE target_id IN (
  '${APPROVE_ID}', '${REJECT_ID}', '${EXPIRED_ID}', '${NONMEMBER_APPROVAL_ID}'
) OR run_id IN (
  '${APPROVE_RUN_ID}', '${REJECT_RUN_ID}', '${EXPIRED_RUN_ID}', '${NONMEMBER_RUN_ID}'
);
DELETE FROM outbox
 WHERE payload @> jsonb_build_object('approval_id', '${APPROVE_ID}')
    OR payload @> jsonb_build_object('approval_id', '${REJECT_ID}')
    OR payload @> jsonb_build_object('approval_id', '${EXPIRED_ID}')
    OR payload @> jsonb_build_object('approval_id', '${NONMEMBER_APPROVAL_ID}')
    OR payload @> jsonb_build_object('run_id', '${APPROVE_RUN_ID}')
    OR payload @> jsonb_build_object('run_id', '${REJECT_RUN_ID}')
    OR payload @> jsonb_build_object('run_id', '${EXPIRED_RUN_ID}')
    OR payload @> jsonb_build_object('run_id', '${NONMEMBER_RUN_ID}');
DELETE FROM approval WHERE id IN (
  '${APPROVE_ID}', '${REJECT_ID}', '${EXPIRED_ID}', '${NONMEMBER_APPROVAL_ID}'
);
DELETE FROM message
 WHERE run_id IN (
   '${APPROVE_RUN_ID}', '${REJECT_RUN_ID}', '${EXPIRED_RUN_ID}', '${NONMEMBER_RUN_ID}'
 )
    OR props->>'approval_id' IN (
      '${APPROVE_ID}', '${REJECT_ID}', '${EXPIRED_ID}', '${NONMEMBER_APPROVAL_ID}'
    );
DELETE FROM message WHERE id IN (
  '${APPROVE_MSG_ID}', '${REJECT_MSG_ID}', '${EXPIRED_MSG_ID}', '${NONMEMBER_MSG_ID}'
);
DELETE FROM agent_run WHERE id IN (
  '${APPROVE_RUN_ID}', '${REJECT_RUN_ID}', '${EXPIRED_RUN_ID}', '${NONMEMBER_RUN_ID}'
);
DELETE FROM human WHERE member_id = '${NONMEMBER_ID}';
DELETE FROM member WHERE id = '${NONMEMBER_ID}';

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('${NONMEMBER_ID}', '${WORKSPACE_ID}', 'human', 'active', 'Approval Nonmember', 'approval-nonmember')
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    display_name = EXCLUDED.display_name,
    handle = EXCLUDED.handle,
    updated_at = now();

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('${NONMEMBER_ID}', '${WORKSPACE_ID}', '${NONMEMBER_EMAIL}', true, 'dev-password-stub', 'UTC')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    password_hash = EXCLUDED.password_hash,
    tz = EXCLUDED.tz;

UPDATE channel_seq
   SET last_seq = GREATEST(
         last_seq,
         167900,
         COALESCE((SELECT max(seq) FROM message WHERE channel_id = '${CHANNEL_ID}'), 0)
       )
 WHERE channel_id = '${CHANNEL_ID}';

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, step_count, max_steps, depth, input, started_at)
VALUES
  ('${APPROVE_RUN_ID}', '${WORKSPACE_ID}', '${AGENT_ID}', '${CHANNEL_ID}', 'awaiting_approval', 1, 12, 0,
   '{"prompt":"MOMO-167 approve fixture"}'::jsonb, now()),
  ('${REJECT_RUN_ID}', '${WORKSPACE_ID}', '${AGENT_ID}', '${CHANNEL_ID}', 'awaiting_approval', 1, 12, 0,
   '{"prompt":"MOMO-167 reject fixture"}'::jsonb, now()),
  ('${EXPIRED_RUN_ID}', '${WORKSPACE_ID}', '${AGENT_ID}', '${CHANNEL_ID}', 'awaiting_approval', 1, 12, 0,
   '{"prompt":"MOMO-167 expired fixture"}'::jsonb, now()),
  ('${NONMEMBER_RUN_ID}', '${WORKSPACE_ID}', '${AGENT_ID}', '${CHANNEL_ID}', 'awaiting_approval', 1, 12, 0,
   '{"prompt":"MOMO-167 nonmember fixture"}'::jsonb, now());

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props, run_id)
VALUES
  ('${APPROVE_MSG_ID}', '${WORKSPACE_ID}', '${CHANNEL_ID}', 167901, 1782463200000, 0, '${AGENT_ID}',
   'approval_request', 'Approve fixture', '{"approval_id":"${APPROVE_ID}","status":"pending"}'::jsonb, '${APPROVE_RUN_ID}'),
  ('${REJECT_MSG_ID}', '${WORKSPACE_ID}', '${CHANNEL_ID}', 167902, 1782463200000, 0, '${AGENT_ID}',
   'approval_request', 'Reject fixture', '{"approval_id":"${REJECT_ID}","status":"pending"}'::jsonb, '${REJECT_RUN_ID}'),
  ('${EXPIRED_MSG_ID}', '${WORKSPACE_ID}', '${CHANNEL_ID}', 167903, 1782463200000, 0, '${AGENT_ID}',
   'approval_request', 'Expired fixture', '{"approval_id":"${EXPIRED_ID}","status":"pending"}'::jsonb, '${EXPIRED_RUN_ID}'),
  ('${NONMEMBER_MSG_ID}', '${WORKSPACE_ID}', '${CHANNEL_ID}', 167904, 1782463200000, 0, '${AGENT_ID}',
   'approval_request', 'Nonmember fixture', '{"approval_id":"${NONMEMBER_APPROVAL_ID}","status":"pending"}'::jsonb, '${NONMEMBER_RUN_ID}');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, request_message_id, requested_by,
   action_type, payload, status, expires_at)
VALUES
  ('${APPROVE_ID}', '${WORKSPACE_ID}', '${APPROVE_RUN_ID}', '${CHANNEL_ID}', '${APPROVE_MSG_ID}', '${AGENT_ID}',
   'tool_call',
   '{"run_id":"${APPROVE_RUN_ID}","action_type":"tool_call","tool_call":{"call_id":"call_momo_167_approve","name":"github.create_issue","arguments":{"title":"MOMO-167 approve"},"tool_grant":{"tool_name":"github.create_issue","approval_policy":"always","capability_version":"runtime-gate","policy_version":"momo-167"}},"resume_model":"same_run_new_agent_job"}'::jsonb,
   'pending', now() + interval '1 hour'),
  ('${REJECT_ID}', '${WORKSPACE_ID}', '${REJECT_RUN_ID}', '${CHANNEL_ID}', '${REJECT_MSG_ID}', '${AGENT_ID}',
   'tool_call',
   '{"run_id":"${REJECT_RUN_ID}","action_type":"tool_call","tool_call":{"call_id":"call_momo_167_reject","name":"github.create_issue","arguments":{"title":"MOMO-167 reject"},"tool_grant":{"tool_name":"github.create_issue","approval_policy":"always"}},"resume_model":"same_run_new_agent_job"}'::jsonb,
   'pending', now() + interval '1 hour'),
  ('${EXPIRED_ID}', '${WORKSPACE_ID}', '${EXPIRED_RUN_ID}', '${CHANNEL_ID}', '${EXPIRED_MSG_ID}', '${AGENT_ID}',
   'tool_call',
   '{"run_id":"${EXPIRED_RUN_ID}","action_type":"tool_call","tool_call":{"call_id":"call_momo_167_expired","name":"github.create_issue","arguments":{"title":"MOMO-167 expired"}},"resume_model":"same_run_new_agent_job"}'::jsonb,
   'pending', now() - interval '1 minute'),
  ('${NONMEMBER_APPROVAL_ID}', '${WORKSPACE_ID}', '${NONMEMBER_RUN_ID}', '${CHANNEL_ID}', '${NONMEMBER_MSG_ID}', '${AGENT_ID}',
   'tool_call',
   '{"run_id":"${NONMEMBER_RUN_ID}","action_type":"tool_call","tool_call":{"call_id":"call_momo_167_nonmember","name":"github.create_issue","arguments":{"title":"MOMO-167 nonmember"}},"resume_model":"same_run_new_agent_job"}'::jsonb,
   'pending', now() + interval '1 hour');

UPDATE channel_seq
   SET last_seq = GREATEST(
         last_seq,
         COALESCE((SELECT max(seq) FROM message WHERE channel_id = '${CHANNEL_ID}'), 0)
       )
 WHERE channel_id = '${CHANNEL_ID}';

COMMIT;
SQL

echo "[approval-decision] starting MomoServer"
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
wait_http "http://127.0.0.1:${PORT}/health"

echo "[approval-decision] logging in seeded demo user"
LOGIN_JSON="$(
  curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${HUMAN_EMAIL}\",\"password\":\"momo-runtime-gate\",\"workspace\":\"${WORKSPACE_ID}\"}" \
    "http://127.0.0.1:${PORT}/v1/auth/login"
)"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken // empty')"
[ "$ACCESS_TOKEN" != "" ] || fail "demo login did not return accessToken"

echo "[approval-decision] approve path"
HTTP_CODE="$(post_decision "$ACCESS_TOKEN" "$APPROVE_ID" "true" "safe to run" "$APPROVE_DECISION_ID")"
[ "$HTTP_CODE" = "200" ] || fail "approve returned HTTP ${HTTP_CODE}: $(cat "$RESP_FILE")"
jq -e --arg id "$APPROVE_ID" '.approval_id == $id and .status == "approved" and (.decided_by | length) > 0' "$RESP_FILE" >/dev/null \
  || fail "approve receipt invalid: $(cat "$RESP_FILE")"
assert_db_equals "approve durable effects" "approved|queued|1|1|1" "
  SELECT a.status::text || '|' || r.status::text || '|' ||
         (SELECT count(*) FROM approval_decision WHERE approval_id='${APPROVE_ID}') || '|' ||
         (SELECT count(*) FROM audit_log WHERE target_id='${APPROVE_ID}' AND action='approval.approved') || '|' ||
         (SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'resume_from_approval_id'='${APPROVE_ID}')
    FROM approval a
    JOIN agent_run r ON r.id = a.run_id
   WHERE a.id='${APPROVE_ID}';
"

echo "[approval-decision] idempotent retry path"
HTTP_CODE="$(post_decision "$ACCESS_TOKEN" "$APPROVE_ID" "true" "safe to run" "$APPROVE_DECISION_ID")"
[ "$HTTP_CODE" = "200" ] || fail "approve retry returned HTTP ${HTTP_CODE}: $(cat "$RESP_FILE")"
assert_db_equals "approve retry did not duplicate resume" "1|1" "
  SELECT
    (SELECT count(*) FROM approval_decision WHERE approval_id='${APPROVE_ID}') || '|' ||
    (SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'resume_from_approval_id'='${APPROVE_ID}');
"

echo "[approval-decision] idempotency conflict path"
HTTP_CODE="$(post_decision "$ACCESS_TOKEN" "$APPROVE_ID" "false" "contradict retry" "$APPROVE_DECISION_ID")"
[ "$HTTP_CODE" = "409" ] || fail "idempotency conflict returned HTTP ${HTTP_CODE}: $(cat "$RESP_FILE")"

echo "[approval-decision] reject path"
HTTP_CODE="$(post_decision "$ACCESS_TOKEN" "$REJECT_ID" "false" "do not create external state" "$REJECT_DECISION_ID")"
[ "$HTTP_CODE" = "200" ] || fail "reject returned HTTP ${HTTP_CODE}: $(cat "$RESP_FILE")"
jq -e --arg id "$REJECT_ID" '.approval_id == $id and .status == "rejected"' "$RESP_FILE" >/dev/null \
  || fail "reject receipt invalid: $(cat "$RESP_FILE")"
assert_db_equals "reject durable effects" "rejected|cancelled|1|1|0|1" "
  SELECT a.status::text || '|' || r.status::text || '|' ||
         (SELECT count(*) FROM approval_decision WHERE approval_id='${REJECT_ID}') || '|' ||
         (SELECT count(*) FROM audit_log WHERE target_id='${REJECT_ID}' AND action='approval.rejected') || '|' ||
         (SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'resume_from_approval_id'='${REJECT_ID}') || '|' ||
         (SELECT count(*) FROM message WHERE run_id='${REJECT_RUN_ID}' AND type='tool_result')
    FROM approval a
    JOIN agent_run r ON r.id = a.run_id
   WHERE a.id='${REJECT_ID}';
"

echo "[approval-decision] expired click path"
HTTP_CODE="$(post_decision "$ACCESS_TOKEN" "$EXPIRED_ID" "true" "too late" "$EXPIRED_DECISION_ID")"
[ "$HTTP_CODE" = "409" ] || fail "expired click returned HTTP ${HTTP_CODE}: $(cat "$RESP_FILE")"
jq -e --arg id "$EXPIRED_ID" '.approval_id == $id and .status == "expired"' "$RESP_FILE" >/dev/null \
  || fail "expired receipt invalid: $(cat "$RESP_FILE")"
assert_db_equals "expired durable effects" "expired|timed_out|1|1|0" "
  SELECT a.status::text || '|' || r.status::text || '|' ||
         (SELECT count(*) FROM approval_decision WHERE approval_id='${EXPIRED_ID}' AND status='expired') || '|' ||
         (SELECT count(*) FROM audit_log WHERE target_id='${EXPIRED_ID}' AND action='approval.expired') || '|' ||
         (SELECT count(*) FROM outbox WHERE kind='agent_job' AND payload->>'resume_from_approval_id'='${EXPIRED_ID}')
    FROM approval a
    JOIN agent_run r ON r.id = a.run_id
   WHERE a.id='${EXPIRED_ID}';
"

echo "[approval-decision] channel membership enforcement"
NONMEMBER_LOGIN_JSON="$(
  curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${NONMEMBER_EMAIL}\",\"password\":\"momo-runtime-gate\",\"workspace\":\"${WORKSPACE_ID}\"}" \
    "http://127.0.0.1:${PORT}/v1/auth/login"
)"
NONMEMBER_TOKEN="$(printf '%s' "$NONMEMBER_LOGIN_JSON" | jq -r '.accessToken // empty')"
[ "$NONMEMBER_TOKEN" != "" ] || fail "nonmember login did not return accessToken"
HTTP_CODE="$(post_decision "$NONMEMBER_TOKEN" "$NONMEMBER_APPROVAL_ID" "true" "not a channel member" "$NONMEMBER_DECISION_ID")"
[ "$HTTP_CODE" = "403" ] || fail "nonmember decision returned HTTP ${HTTP_CODE}: $(cat "$RESP_FILE")"
assert_db_equals "nonmember did not mutate approval" "pending|0" "
  SELECT a.status::text || '|' ||
         (SELECT count(*) FROM approval_decision WHERE approval_id='${NONMEMBER_APPROVAL_ID}')
    FROM approval a
   WHERE a.id='${NONMEMBER_APPROVAL_ID}';
"

echo "[approval-decision] PASS approval decision endpoint runtime verifier"
