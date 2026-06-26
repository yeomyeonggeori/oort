#!/usr/bin/env bash
# =============================================================================
# scripts/verify_join.sh — MOMO-014 public /v1/join runtime gate
#
# Runs after make up && make migrate. It starts MomoServer on the worktree port,
# creates real invites via the authenticated invite API, exercises public join,
# verifies login/bootstrap/read access, and checks deterministic failure modes.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

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
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[join] missing required command: $1" >&2
    exit 1
  }
}

need curl
need jq

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[join] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

PSQL_FLAGS=(-v ON_ERROR_STOP=1 --no-psqlrc -At)
psql_run() {
  if [ "${DATABASE_URL:-}" != "" ]; then
    "$PSQL_BIN" "$DATABASE_URL" "${PSQL_FLAGS[@]}" "$@"
  else
    "$PSQL_BIN" "${PSQL_FLAGS[@]}" "$@"
  fi
}

PORT="${PORT:-8080}"
BASE_URL="http://127.0.0.1:$PORT"
WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
DEMO_EMAIL="demo@momo.local"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-join-$RUN_ID"
SERVER_LOG="$TMP_DIR/momo-server.log"
SERVER_PID=""

mkdir -p "$TMP_DIR"

cleanup() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local token="${4:-}"
  local out="$TMP_DIR/response.json"
  local status
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$method")
  args+=(-H "Content-Type: application/json")
  if [ "$token" != "" ]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [ "$body" != "" ]; then
    args+=(--data "$body")
  fi
  status="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
  RESPONSE_STATUS="$status"
}

expect_status() {
  local expected="$1"
  local label="$2"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    echo "[join] FAIL $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    echo "[join] server log: $SERVER_LOG" >&2
    exit 1
  fi
  echo "[join] PASS $label ($expected)"
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[join] $BASE_URL is already serving /health; stop the existing server before running this verifier." >&2
    exit 1
  fi

  echo "[join] starting MomoServer on $BASE_URL"
  (
    cd "$REPO_ROOT"
    swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"

  for _ in $(seq 1 90); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[join] server health is green"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[join] server exited before health became green" >&2
      tail -200 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done

  echo "[join] timed out waiting for server health" >&2
  tail -200 "$SERVER_LOG" >&2 || true
  exit 1
}

login_demo_owner() {
  local body
  body="$(jq -cn \
    --arg email "$DEMO_EMAIL" \
    --arg workspace "$WORKSPACE_ID" \
    '{email:$email,password:"dev-password",workspace:$workspace}')"
  api POST /v1/auth/login "$body"
  expect_status 200 "demo owner login"
  OWNER_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken')"
}

create_invite() {
  local role="$1"
  local max_uses="$2"
  local body
  local expires_at_ms
  expires_at_ms="$(( ($(date +%s) + 86400) * 1000 ))"
  body="$(jq -cn \
    --arg role "$role" \
    --argjson maxUses "$max_uses" \
    --argjson expiresAtMs "$expires_at_ms" \
    '{role:$role,maxUses:$maxUses,expiresAtMs:$expiresAtMs}')"
  api POST "/v1/workspaces/$WORKSPACE_ID/invites" "$body" "$OWNER_TOKEN"
  expect_status 201 "create $role invite maxUses=$max_uses"
  INVITE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.invite.id')"
  INVITE_CODE="$(printf '%s' "$RESPONSE_BODY" | jq -r '.code')"
}

revoke_invite() {
  local invite_id="$1"
  api POST "/v1/workspaces/$WORKSPACE_ID/invites/$invite_id/revoke" \
    '{"reason":"MOMO-014 verifier"}' "$OWNER_TOKEN"
  expect_status 200 "revoke invite"
}

expire_invite() {
  local invite_id="$1"
  psql_run -c "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; UPDATE invite_code SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day', updated_at = now() WHERE id = '$invite_id'; COMMIT;" >/dev/null
}

join_with_code() {
  local code="$1"
  local email="$2"
  local handle="$3"
  local expected="$4"
  local body
  body="$(jq -cn \
    --arg code "$code" \
    --arg email "$email" \
    --arg displayName "Join User $handle" \
    --arg handle "$handle" \
    '{code:$code,email:$email,displayName:$displayName,handle:$handle,password:"dev-password",timeZone:"Asia/Seoul"}')"
  api POST /v1/join "$body"
  expect_status "$expected" "join $email"
}

assert_sql_equals() {
  local expected="$1"
  local sql="$2"
  local label="$3"
  local got
  got="$(psql_run -c "$sql" | grep -E '^[0-9]+$' | tail -n 1)"
  if [ "$got" != "$expected" ]; then
    echo "[join] FAIL $label: expected $expected, got $got" >&2
    exit 1
  fi
  echo "[join] PASS $label"
}

start_server
login_demo_owner

echo "[join] valid public join -> login/bootstrap/read path"
create_invite member 3
VALID_INVITE_ID="$INVITE_ID"
VALID_CODE="$INVITE_CODE"
VALID_EMAIL="join-$RUN_ID@momo.local"
VALID_HANDLE="join-$RUN_ID"
join_with_code "$VALID_CODE" "$VALID_EMAIL" "$VALID_HANDLE" 201
JOIN_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken')"
JOIN_MEMBER_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.member.id')"
JOIN_CHANNEL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.memberships[0].channelId')"
JOIN_REDEMPTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.redemptionId')"

api POST /v1/auth/login "$(jq -cn --arg email "$VALID_EMAIL" --arg workspace "$WORKSPACE_ID" '{email:$email,password:"anything",workspace:$workspace}')"
expect_status 200 "joined human can authenticate"

api GET "/v1/workspaces/$WORKSPACE_ID/channels/$JOIN_CHANNEL_ID/messages" "" "$JOIN_TOKEN"
expect_status 200 "joined human can read joined channel"

assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT count(*) FROM human WHERE email = '$VALID_EMAIL'; COMMIT;" "human row created"
assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT count(*) FROM invite_code_redemption WHERE id = '$JOIN_REDEMPTION_ID' AND invite_code_id = '$VALID_INVITE_ID' AND member_id = '$JOIN_MEMBER_ID'; COMMIT;" "redemption row created"
assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT count(*) FROM audit_log WHERE action = 'invite.join' AND target_id = '$VALID_INVITE_ID' AND subject_member_id = '$JOIN_MEMBER_ID'; COMMIT;" "audit_log row created"

echo "[join] deterministic failure modes"
join_with_code "not-a-real-code-$RUN_ID" "invalid-$RUN_ID@momo.local" "invalid-$RUN_ID" 404

create_invite member 1
EXPIRED_ID="$INVITE_ID"
EXPIRED_CODE="$INVITE_CODE"
expire_invite "$EXPIRED_ID"
join_with_code "$EXPIRED_CODE" "expired-$RUN_ID@momo.local" "expired-$RUN_ID" 410

create_invite member 1
REVOKED_ID="$INVITE_ID"
REVOKED_CODE="$INVITE_CODE"
revoke_invite "$REVOKED_ID"
join_with_code "$REVOKED_CODE" "revoked-$RUN_ID@momo.local" "revoked-$RUN_ID" 410

create_invite member 1
EXHAUSTED_CODE="$INVITE_CODE"
join_with_code "$EXHAUSTED_CODE" "exhausted-a-$RUN_ID@momo.local" "exhaust-a-$RUN_ID" 201
join_with_code "$EXHAUSTED_CODE" "exhausted-b-$RUN_ID@momo.local" "exhaust-b-$RUN_ID" 409

create_invite member 2
DUP_CODE="$INVITE_CODE"
join_with_code "$DUP_CODE" "duplicate-$RUN_ID@momo.local" "dupe-$RUN_ID" 201
join_with_code "$DUP_CODE" "duplicate-$RUN_ID@momo.local" "dupe-$RUN_ID" 409

create_invite guest 2
GUEST_CODE="$INVITE_CODE"
ESCALATE_EMAIL="escalate-$RUN_ID@momo.local"
join_with_code "$GUEST_CODE" "$ESCALATE_EMAIL" "escalate-$RUN_ID" 201
create_invite admin 2
ADMIN_CODE="$INVITE_CODE"
join_with_code "$ADMIN_CODE" "$ESCALATE_EMAIL" "escalate-$RUN_ID" 403

echo "[join] PASS public join runtime verifier"
