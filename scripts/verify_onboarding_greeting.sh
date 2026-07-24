#!/usr/bin/env bash
# =============================================================================
# scripts/verify_onboarding_greeting.sh — MOMO-588 (W-O3) onboarding greeting gate
#
# Runs after make up && make migrate. It starts MomoServer on the worktree port
# and proves the join success path posts one agent greeting through the canonical
# write path (channel_seq bump + message INSERT + outbox INSERT), that the
# greeting mentions the new member and carries the deterministic props marker,
# that it is idempotent per (workspace, member) across a re-join, and that the
# join silently succeeds with zero greetings when the workspace has no agent.
#
# Contract checked:
#   * greeting authored by an active agent member (member.kind='agent')
#   * greeting mentions the new member (props.mention_member_ids)
#   * greeting body is the fixed Korean template (환영 / 멘션 / @handle)
#   * exactly one broadcast outbox row references the greeting message
#   * re-entry (member reused) does NOT mint a second greeting
#   * no active agent -> join succeeds, zero greetings (silent skip)
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
    echo "[greeting] missing required command: $1" >&2
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
  echo "[greeting] psql not found; install PostgreSQL client/libpq and retry." >&2
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

# Return the single scalar produced by a tenant-scoped query, stripping the
# BEGIN/SET/COMMIT status tags psql prints alongside tuples.
psql_scalar() {
  psql_run -c "$1" | grep -vE '^(BEGIN|SET|COMMIT|ROLLBACK)$' | grep -v '^$' | tail -n 1
}

PORT="${PORT:-8080}"
BASE_URL="http://127.0.0.1:$PORT"
WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
DEMO_EMAIL="demo@momo.local"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
# A deterministic fallback agent used only when the seed provisioned none. Its
# handle sorts last so it never displaces a real seed agent as the greeter.
FALLBACK_AGENT_ID="00000000-0000-7000-8000-000000005880"
TMP_DIR="${TMPDIR:-/tmp}/momo-greeting-$RUN_ID"
SERVER_LOG="$TMP_DIR/momo-server.log"
SERVER_PID=""

mkdir -p "$TMP_DIR"

terminate_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  if [ "${SERVER_PID:-}" != "" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    terminate_tree "$SERVER_PID"
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 10); do
    if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
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
    echo "[greeting] FAIL $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    echo "[greeting] server log: $SERVER_LOG" >&2
    exit 1
  fi
  echo "[greeting] PASS $label ($expected)"
}

assert_eq() {
  local expected="$1"
  local got="$2"
  local label="$3"
  if [ "$got" != "$expected" ]; then
    echo "[greeting] FAIL $label: expected '$expected', got '$got'" >&2
    exit 1
  fi
  echo "[greeting] PASS $label"
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[greeting] $BASE_URL is already serving /health; stop the existing server first." >&2
    exit 1
  fi
  echo "[greeting] starting MomoServer on $BASE_URL"
  (
    cd "$REPO_ROOT"
    swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"
  for _ in $(seq 1 90); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[greeting] server health is green"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[greeting] server exited before health became green" >&2
      tail -200 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "[greeting] timed out waiting for server health" >&2
  tail -200 "$SERVER_LOG" >&2 || true
  exit 1
}

login_demo_owner() {
  local body
  body="$(jq -cn --arg email "$DEMO_EMAIL" --arg workspace "$WORKSPACE_ID" \
    '{email:$email,password:"dev-password",workspace:$workspace}')"
  api POST /v1/auth/login "$body"
  expect_status 200 "demo owner login"
  OWNER_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken')"
}

create_invite() {
  local role="$1"
  local max_uses="$2"
  local body
  body="$(jq -cn --arg role "$role" --argjson maxUses "$max_uses" '{role:$role,maxUses:$maxUses}')"
  api POST "/v1/workspaces/$WORKSPACE_ID/invites" "$body" "$OWNER_TOKEN"
  expect_status 201 "create $role invite (maxUses=$max_uses)"
  INVITE_CODE="$(printf '%s' "$RESPONSE_BODY" | jq -r '.code')"
}

join_with_code() {
  local code="$1"
  local email="$2"
  local handle="$3"
  local expected="$4"
  local body
  body="$(jq -cn --arg code "$code" --arg email "$email" \
    --arg displayName "Greeting User $handle" --arg handle "$handle" \
    '{code:$code,email:$email,displayName:$displayName,handle:$handle,password:"dev-password",timeZone:"Asia/Seoul"}')"
  api POST /v1/join "$body"
  expect_status "$expected" "join $email"
}

general_channel_id() {
  psql_scalar "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT id FROM channel WHERE workspace_id = '$WORKSPACE_ID' AND kind = 'public' AND lower(name) = 'general' AND archived_at IS NULL LIMIT 1; COMMIT;"
}

active_agent_count() {
  psql_scalar "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT count(*) FROM member WHERE workspace_id = '$WORKSPACE_ID' AND kind = 'agent' AND status = 'active' AND deleted_at IS NULL; COMMIT;"
}

# Greetings authored by any active agent, mentioning the given member, carrying
# the server-owned marker, in #general.
greeting_count_for() {
  local channel="$1"
  local member="$2"
  psql_scalar "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT count(*) FROM message m JOIN member a ON a.id = m.author_member_id AND a.kind = 'agent' WHERE m.channel_id = '$channel' AND m.workspace_id = '$WORKSPACE_ID' AND m.type = 'text' AND m.props->>'onboarding_greeting' = 'v1' AND m.props->'mention_member_ids' ? '$member'; COMMIT;"
}

greeting_id_for() {
  local channel="$1"
  local member="$2"
  psql_scalar "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT m.id FROM message m JOIN member a ON a.id = m.author_member_id AND a.kind = 'agent' WHERE m.channel_id = '$channel' AND m.workspace_id = '$WORKSPACE_ID' AND m.type = 'text' AND m.props->>'onboarding_greeting' = 'v1' AND m.props->'mention_member_ids' ? '$member' ORDER BY m.seq ASC LIMIT 1; COMMIT;"
}

greeting_body_ok_for() {
  local channel="$1"
  local member="$2"
  local handle="$3"
  psql_scalar "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT count(*) FROM message m JOIN member a ON a.id = m.author_member_id AND a.kind = 'agent' WHERE m.channel_id = '$channel' AND m.workspace_id = '$WORKSPACE_ID' AND m.props->>'onboarding_greeting' = 'v1' AND m.props->'mention_member_ids' ? '$member' AND m.body LIKE '%환영%' AND m.body LIKE '%멘션%' AND m.body LIKE '%@${handle}%'; COMMIT;"
}

outbox_count_for_message() {
  local message="$1"
  psql_scalar "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; SELECT count(*) FROM outbox WHERE workspace_id = '$WORKSPACE_ID' AND kind = 'broadcast' AND method = 'publish' AND payload->'data'->'payload'->>'id' = '$message'; COMMIT;"
}

provision_fallback_agent() {
  echo "[greeting] no seed agent present; provisioning a deterministic fallback agent"
  psql_run -c "BEGIN; SET LOCAL app.workspace_id = '$WORKSPACE_ID'; INSERT INTO member (id, workspace_id, kind, status, display_name, handle) VALUES ('$FALLBACK_AGENT_ID', '$WORKSPACE_ID', 'agent', 'active', 'Greeting Verifier Bot', 'zzz-greeting-verifier') ON CONFLICT (id) DO NOTHING; INSERT INTO agent (member_id, workspace_id, model, base_url) VALUES ('$FALLBACK_AGENT_ID', '$WORKSPACE_ID', 'hermes-agent', 'http://127.0.0.1:1/v1') ON CONFLICT (member_id) DO NOTHING; COMMIT;" >/dev/null
}

start_server
login_demo_owner

GENERAL_CHANNEL="$(general_channel_id)"
if [ "$GENERAL_CHANNEL" = "" ]; then
  echo "[greeting] FAIL could not resolve #general channel for the demo workspace" >&2
  exit 1
fi
echo "[greeting] #general channel = $GENERAL_CHANNEL"

AGENTS_BEFORE="$(active_agent_count)"
echo "[greeting] active agents in workspace before provisioning: $AGENTS_BEFORE"

# ---- silent-skip path (only exercisable when the seed provisioned no agent) ----
if [ "$AGENTS_BEFORE" = "0" ]; then
  echo "[greeting] no agent present -> exercising the silent-skip contract"
  create_invite member 3
  SKIP_EMAIL="greet-skip-$RUN_ID@momo.local"
  SKIP_HANDLE="grt-skip-$RUN_ID"
  join_with_code "$INVITE_CODE" "$SKIP_EMAIL" "$SKIP_HANDLE" 201
  SKIP_MEMBER_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.member.id')"
  assert_eq 0 "$(greeting_count_for "$GENERAL_CHANNEL" "$SKIP_MEMBER_ID")" \
    "no-agent join succeeds with zero greetings (silent skip)"
  provision_fallback_agent
else
  echo "[greeting] seed agent present -> greeting will use the handle-sorted first agent"
fi

# ---- happy path: join -> one agent greeting via the canonical write path -------
echo "[greeting] happy path: agent greets the new member"
create_invite member 3
HAPPY_EMAIL="greet-happy-$RUN_ID@momo.local"
HAPPY_HANDLE="grt-happy-$RUN_ID"
join_with_code "$INVITE_CODE" "$HAPPY_EMAIL" "$HAPPY_HANDLE" 201
HAPPY_MEMBER_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.member.id')"

assert_eq 1 "$(greeting_count_for "$GENERAL_CHANNEL" "$HAPPY_MEMBER_ID")" \
  "exactly one agent greeting mentions the new member"
assert_eq 1 "$(greeting_body_ok_for "$GENERAL_CHANNEL" "$HAPPY_MEMBER_ID" "$HAPPY_HANDLE")" \
  "greeting body is the fixed Korean template (환영 / 멘션 / @handle)"

GREETING_ID="$(greeting_id_for "$GENERAL_CHANNEL" "$HAPPY_MEMBER_ID")"
if [ "$GREETING_ID" = "" ]; then
  echo "[greeting] FAIL could not resolve greeting message id" >&2
  exit 1
fi
assert_eq 1 "$(outbox_count_for_message "$GREETING_ID")" \
  "greeting emitted exactly one broadcast outbox row (single write path)"

# ---- idempotency: re-entry with a fresh invite does not double-greet ----------
echo "[greeting] idempotency: re-join the same member -> no second greeting"
create_invite member 3
join_with_code "$INVITE_CODE" "$HAPPY_EMAIL" "$HAPPY_HANDLE" 200
REJOIN_MEMBER_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.member.id')"
assert_eq "$HAPPY_MEMBER_ID" "$REJOIN_MEMBER_ID" "re-join reuses the same member row"
assert_eq 1 "$(greeting_count_for "$GENERAL_CHANNEL" "$HAPPY_MEMBER_ID")" \
  "re-join is idempotent: still exactly one greeting"

echo "[greeting] PASS onboarding greeting runtime verifier"
