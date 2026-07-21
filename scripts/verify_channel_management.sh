#!/usr/bin/env bash
# =============================================================================
# scripts/verify_channel_management.sh — MOMO-214/385 channel and DM runtime gate
#
# Runs after make up && make migrate. It starts MomoServer with the normal
# NOBYPASSRLS app role, then verifies owner/admin channel create, human/agent
# membership add/remove, canonical human/agent DMs, persisted workspace identity
# rename/read authorization, cross-workspace denial, channel_seq provisioning,
# and message send through managed and direct-message channels.
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
    echo "[channel-management] missing required command: $1" >&2
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
  echo "[channel-management] psql not found; install PostgreSQL client/libpq and retry." >&2
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
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-momo}"
APP_DATABASE_URL="postgres://momo_app:momo_app_dev_pw@$POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
WORKSPACE_B="23000000-0000-7000-8000-000000000001"
DEMO_OWNER_EMAIL="demo@momo.local"
DEMO_ADMIN_EMAIL="channel-admin@momo.local"
DEMO_MEMBER_EMAIL="channel-member@momo.local"
B_OWNER_EMAIL="channel-b-owner@momo.local"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
RUN_SAFE="$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
TMP_DIR="${TMPDIR:-/tmp}/momo-channel-management-$RUN_ID"
SERVER_LOG="$TMP_DIR/momo-server.log"
SERVER_PID=""
ORIGINAL_WORKSPACE_NAME=""
WORKSPACE_RENAMED=0

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
  psql_run -c "BEGIN; SET LOCAL row_security = off; UPDATE member SET status = 'active', deleted_at = NULL, updated_at = clock_timestamp() WHERE id = '00000000-0000-7000-8000-000000000196'; COMMIT;" >/dev/null 2>&1 || true
  if [ "$WORKSPACE_RENAMED" = "1" ] && [ "$ORIGINAL_WORKSPACE_NAME" != "" ]; then
    printf '%s\n' "BEGIN; SET LOCAL row_security = off; UPDATE workspace SET name = :'restore_workspace_name', updated_at = clock_timestamp() WHERE id = '$DEMO_WORKSPACE_ID'; COMMIT;" \
      | psql_run -v restore_workspace_name="$ORIGINAL_WORKSPACE_NAME" >/dev/null 2>&1 || true
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
    echo "[channel-management] FAIL $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    echo "[channel-management] server log: $SERVER_LOG" >&2
    exit 1
  fi
  echo "[channel-management] PASS $label ($expected)" >&2
}

expect_status_one_of() {
  local first="$1"
  local second="$2"
  local label="$3"
  if [ "$RESPONSE_STATUS" != "$first" ] && [ "$RESPONSE_STATUS" != "$second" ]; then
    echo "[channel-management] FAIL $label: expected HTTP $first or $second, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    echo "[channel-management] server log: $SERVER_LOG" >&2
    exit 1
  fi
  echo "[channel-management] PASS $label ($RESPONSE_STATUS)" >&2
}

expect_jq() {
  local label="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  if ! printf '%s' "$RESPONSE_BODY" | jq -e "$@" >/dev/null; then
    echo "[channel-management] FAIL $label" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  echo "[channel-management] PASS $label" >&2
}

sql_scalar() {
  local sql="$1"
  shift
  printf '%s\n' "$sql" | psql_run "$@" | grep -E '^[0-9]+$' | tail -n 1
}

assert_sql_equals() {
  local expected="$1"
  local sql="$2"
  local label="$3"
  shift 3
  local got
  got="$(sql_scalar "$sql" "$@")"
  if [ "$got" != "$expected" ]; then
    echo "[channel-management] FAIL $label: expected $expected, got $got" >&2
    exit 1
  fi
  echo "[channel-management] PASS $label" >&2
}

prepare_roles_and_fixture() {
  echo "[channel-management] preparing app role and two-workspace fixture"
  psql_run <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    CREATE ROLE momo_app LOGIN PASSWORD 'momo_app_dev_pw';
  END IF;
END $$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO momo_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO momo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO momo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO momo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO momo_app;

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'momo_app') THEN
    RAISE EXCEPTION 'momo_app must be non-superuser/NOBYPASSRLS';
  END IF;
END $$;

BEGIN;
SET LOCAL row_security = off;

INSERT INTO workspace (id, slug, name)
VALUES ('23000000-0000-7000-8000-000000000001', 'momo-channel-management-b', 'MOMO Channel Management Workspace B')
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    updated_at = now();

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('00000000-0000-7000-8000-000000000196', '00000000-0000-7000-8000-000000000001',
   'human', 'active', 'Channel Admin', 'channel-admin'),
  ('00000000-0000-7000-8000-000000000197', '00000000-0000-7000-8000-000000000001',
   'human', 'active', 'Channel Member', 'channel-member'),
  ('23000000-0000-7000-8000-000000000101', '23000000-0000-7000-8000-000000000001',
   'human', 'active', 'Channel B Owner', 'channel-b-owner'),
  ('23000000-0000-7000-8000-000000000102', '23000000-0000-7000-8000-000000000001',
   'human', 'active', 'Channel B Member', 'channel-b-member')
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    deleted_at = NULL,
    display_name = EXCLUDED.display_name,
    handle = EXCLUDED.handle,
    updated_at = now();

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('00000000-0000-7000-8000-000000000196', '00000000-0000-7000-8000-000000000001',
   'channel-admin@momo.local', true, momo_password_hash('dev-password'), 'Asia/Seoul'),
  ('00000000-0000-7000-8000-000000000197', '00000000-0000-7000-8000-000000000001',
   'channel-member@momo.local', true, momo_password_hash('dev-password'), 'Asia/Seoul'),
  ('23000000-0000-7000-8000-000000000101', '23000000-0000-7000-8000-000000000001',
   'channel-b-owner@momo.local', true, momo_password_hash('dev-password'), 'Asia/Seoul'),
  ('23000000-0000-7000-8000-000000000102', '23000000-0000-7000-8000-000000000001',
   'channel-b-member@momo.local', true, momo_password_hash('dev-password'), 'Asia/Seoul')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    password_hash = EXCLUDED.password_hash,
    tz = EXCLUDED.tz;

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
VALUES ('23000000-0000-7000-8000-000000000201', '23000000-0000-7000-8000-000000000001',
        'public', 'channel-management-b', 'Channel management fixture B',
        '23000000-0000-7000-8000-000000000101')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    topic = EXCLUDED.topic,
    archived_at = NULL,
    updated_at = now();

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES ('23000000-0000-7000-8000-000000000201',
        '23000000-0000-7000-8000-000000000001', 0)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO membership (id, workspace_id, channel_id, member_id, role, left_at)
VALUES
  ('00000000-0000-7000-8000-000000000396', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000201',
   '00000000-0000-7000-8000-000000000196', 'admin', NULL),
  ('00000000-0000-7000-8000-000000000397', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000201',
   '00000000-0000-7000-8000-000000000197', 'member', NULL),
  ('23000000-0000-7000-8000-000000000301', '23000000-0000-7000-8000-000000000001',
   '23000000-0000-7000-8000-000000000201',
   '23000000-0000-7000-8000-000000000101', 'owner', NULL)
ON CONFLICT (id) DO UPDATE
SET role = EXCLUDED.role,
    left_at = NULL;

INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000196', 'admin'),
  ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000197', 'member'),
  ('23000000-0000-7000-8000-000000000001', '23000000-0000-7000-8000-000000000101', 'owner'),
  ('23000000-0000-7000-8000-000000000001', '23000000-0000-7000-8000-000000000102', 'member')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = EXCLUDED.role;

COMMIT;
SQL
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[channel-management] $BASE_URL is already serving /health; stop the existing server before running this verifier." >&2
    exit 1
  fi

  echo "[channel-management] starting MomoServer on $BASE_URL with momo_app"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="$APP_DATABASE_URL" swift run --package-path server MomoServer
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"

  for _ in $(seq 1 90); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[channel-management] server health is green"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[channel-management] server exited before health became green" >&2
      tail -200 "$SERVER_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done

  echo "[channel-management] timed out waiting for server health" >&2
  tail -200 "$SERVER_LOG" >&2 || true
  exit 1
}

login() {
  local email="$1"
  local workspace="$2"
  local body
  body="$(jq -cn \
    --arg email "$email" \
    --arg workspace "$workspace" \
    '{email:$email,password:"dev-password",workspace:$workspace}')"
  api POST /v1/auth/login "$body"
  expect_status 200 "login $email"
  printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken'
}

prepare_roles_and_fixture
start_server

OWNER_TOKEN="$(login "$DEMO_OWNER_EMAIL" "$DEMO_WORKSPACE_ID")"
ADMIN_TOKEN="$(login "$DEMO_ADMIN_EMAIL" "$DEMO_WORKSPACE_ID")"
MEMBER_TOKEN="$(login "$DEMO_MEMBER_EMAIL" "$DEMO_WORKSPACE_ID")"
B_OWNER_TOKEN="$(login "$B_OWNER_EMAIL" "$WORKSPACE_B")"

OWNER_CHANNEL_NAME="runtime-${RUN_SAFE}"
ADMIN_CHANNEL_NAME="admin-${RUN_SAFE}"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" \
  '{"memberId":"00000000-0000-7000-8000-000000000197"}' \
  "$OWNER_TOKEN"
expect_status_one_of 200 201 "owner opens canonical human DM"
expect_jq '.channel.kind == "dm" and (.channel.memberIds | index("00000000-0000-7000-8000-000000000101") != null) and (.channel.memberIds | index("00000000-0000-7000-8000-000000000197") != null)' "human DM response contains the exact pair"
HUMAN_DM_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.channel.id')"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" \
  '{"memberId":"00000000-0000-7000-8000-000000000197"}' \
  "$OWNER_TOKEN"
expect_status 200 "repeated human DM open returns the existing channel"
expect_jq --arg expected "$HUMAN_DM_ID" '(.channel.id | ascii_downcase) == ($expected | ascii_downcase) and .created == false' "repeated human DM open preserves canonical identity"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$HUMAN_DM_ID/messages" \
  "$(jq -cn --arg id "$(uuidgen)" '{clientMsgId:$id,type:"text",body:"MOMO-385 canonical DM identity runtime"}')" \
  "$OWNER_TOKEN"
expect_status 201 "canonical human DM accepts its first verifier message"
expect_jq --arg expected "$HUMAN_DM_ID" '(.channelId | ascii_downcase) == ($expected | ascii_downcase) and .seq >= 1' "DM message remains on the opened channel identity"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" \
  '{"memberId":"00000000-0000-7000-8000-000000000197"}' \
  "$OWNER_TOKEN"
expect_status 200 "human DM remains canonical after message send"
expect_jq --arg expected "$HUMAN_DM_ID" '(.channel.id | ascii_downcase) == ($expected | ascii_downcase) and .created == false' "post-message DM open preserves channel identity"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" \
  '{"memberId":"00000000-0000-7000-8000-000000000102"}' \
  "$OWNER_TOKEN"
expect_status_one_of 200 201 "owner opens canonical agent DM"
expect_jq '.channel.kind == "dm" and (.channel.memberIds | index("00000000-0000-7000-8000-000000000101") != null) and (.channel.memberIds | index("00000000-0000-7000-8000-000000000102") != null)' "agent follows the same canonical DM path"
AGENT_DM_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.channel.id')"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" "" "$OWNER_TOKEN"
expect_status 200 "owner lists direct messages"
expect_jq --arg human "$HUMAN_DM_ID" --arg agent "$AGENT_DM_ID" '([.channels[].id | ascii_downcase] | index($human | ascii_downcase) != null) and ([.channels[].id | ascii_downcase] | index($agent | ascii_downcase) != null)' "human and agent DMs appear immediately in the canonical list"

assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT count(*) FROM channel WHERE workspace_id = '$DEMO_WORKSPACE_ID' AND kind = 'dm' AND dm_key = encode(digest('00000000-0000-7000-8000-000000000101:00000000-0000-7000-8000-000000000197', 'sha256'), 'hex'); COMMIT;" "human pair has exactly one canonical DM row"
assert_sql_equals 2 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT count(*) FROM membership WHERE channel_id = '$AGENT_DM_ID' AND member_id IN ('00000000-0000-7000-8000-000000000101', '00000000-0000-7000-8000-000000000102') AND left_at IS NULL; COMMIT;" "agent DM memberships remain tenant-scoped and active"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" \
  '{"memberId":"00000000-0000-7000-8000-000000000101"}' \
  "$OWNER_TOKEN"
expect_status 400 "self DM is rejected"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" \
  '{"memberId":"23000000-0000-7000-8000-000000000102"}' \
  "$OWNER_TOKEN"
expect_status 404 "workspace A cannot open a DM with workspace B member"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" "" "$B_OWNER_TOKEN"
expect_status 403 "workspace B token cannot list workspace A DMs"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID" "" "$OWNER_TOKEN"
expect_status 200 "owner reads workspace identity"
expect_jq '.workspace.id == "'"$DEMO_WORKSPACE_ID"'" and (.workspace.name | length) > 0' "workspace identity response is durable"
ORIGINAL_WORKSPACE_NAME="$(printf '%s' "$RESPONSE_BODY" | jq -r '.workspace.name')"
ORIGINAL_WORKSPACE_UPDATED_AT_MS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.workspace.updatedAtMs')"
RENAMED_WORKSPACE_NAME="MOMO Runtime's ${RUN_SAFE}"

api PATCH "/v1/workspaces/$DEMO_WORKSPACE_ID" \
  "$(jq -cn --arg name "$RENAMED_WORKSPACE_NAME" --argjson expected "$ORIGINAL_WORKSPACE_UPDATED_AT_MS" '{name:$name,expectedUpdatedAtMs:$expected}')" \
  "$ADMIN_TOKEN"
expect_status 200 "admin renames workspace"
WORKSPACE_RENAMED=1
expect_jq '.workspace.name == "'"$RENAMED_WORKSPACE_NAME"'"' "rename response carries persisted name"
RENAMED_WORKSPACE_UPDATED_AT_MS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.workspace.updatedAtMs')"

api PATCH "/v1/workspaces/$DEMO_WORKSPACE_ID" \
  "$(jq -cn --arg name "stale rename must fail" --argjson expected "$ORIGINAL_WORKSPACE_UPDATED_AT_MS" '{name:$name,expectedUpdatedAtMs:$expected}')" \
  "$OWNER_TOKEN"
expect_status 409 "stale workspace rename is rejected"

api GET "/v1/workspaces/$DEMO_WORKSPACE_ID" "" "$OWNER_TOKEN"
expect_status 200 "second authorized client reloads workspace identity"
expect_jq '.workspace.name == "'"$RENAMED_WORKSPACE_NAME"'"' "second client observes persisted rename"

api PATCH "/v1/workspaces/$DEMO_WORKSPACE_ID" \
  "$(jq -cn --arg name "member must not rename" --argjson expected "$RENAMED_WORKSPACE_UPDATED_AT_MS" '{name:$name,expectedUpdatedAtMs:$expected}')" \
  "$MEMBER_TOKEN"
expect_status 403 "ordinary member cannot rename workspace"

psql_run -c "BEGIN; SET LOCAL row_security = off; UPDATE member SET status = 'suspended', updated_at = clock_timestamp() WHERE id = '00000000-0000-7000-8000-000000000196'; COMMIT;" >/dev/null
api GET "/v1/workspaces/$DEMO_WORKSPACE_ID" "" "$ADMIN_TOKEN"
expect_status 403 "suspended admin cannot read workspace identity"
api PATCH "/v1/workspaces/$DEMO_WORKSPACE_ID" \
  "$(jq -cn --arg name "suspended admin must not rename" --argjson expected "$RENAMED_WORKSPACE_UPDATED_AT_MS" '{name:$name,expectedUpdatedAtMs:$expected}')" \
  "$ADMIN_TOKEN"
expect_status 403 "suspended admin cannot rename workspace"

psql_run -c "BEGIN; SET LOCAL row_security = off; UPDATE member SET status = 'deleted', deleted_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = '00000000-0000-7000-8000-000000000196'; COMMIT;" >/dev/null
api GET "/v1/workspaces/$DEMO_WORKSPACE_ID" "" "$ADMIN_TOKEN"
expect_status 403 "deleted admin cannot read workspace identity"
api PATCH "/v1/workspaces/$DEMO_WORKSPACE_ID" \
  "$(jq -cn --arg name "deleted admin must not rename" --argjson expected "$RENAMED_WORKSPACE_UPDATED_AT_MS" '{name:$name,expectedUpdatedAtMs:$expected}')" \
  "$ADMIN_TOKEN"
expect_status 403 "deleted admin cannot rename workspace"
psql_run -c "BEGIN; SET LOCAL row_security = off; UPDATE member SET status = 'active', deleted_at = NULL, updated_at = clock_timestamp() WHERE id = '00000000-0000-7000-8000-000000000196'; COMMIT;" >/dev/null

api GET "/v1/workspaces/$WORKSPACE_B" "" "$OWNER_TOKEN"
expect_status 403 "workspace A token cannot read workspace B identity"

api PATCH "/v1/workspaces/$WORKSPACE_B" \
  '{"name":"cross workspace rename must fail","expectedUpdatedAtMs":0}' \
  "$OWNER_TOKEN"
expect_status 403 "workspace A token cannot rename workspace B"

api GET "/v1/workspaces/$WORKSPACE_B" "" "$B_OWNER_TOKEN"
expect_status 200 "workspace B owner reads own workspace identity"
expect_jq '.workspace.id == "'"$WORKSPACE_B"'"' "workspace B identity remains tenant scoped"

assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT count(*) FROM audit_log WHERE workspace_id = '$DEMO_WORKSPACE_ID' AND actor_member_id = '00000000-0000-7000-8000-000000000196' AND action = 'workspace.name.updated' AND target_type = 'workspace' AND target_id = '$DEMO_WORKSPACE_ID' AND via_token_id IS NOT NULL AND detail->>'schema' = 'momo.workspace.name.updated.v1' AND detail->>'previous_name' = :'original_workspace_name' AND detail->>'new_name' = :'renamed_workspace_name' AND detail->>'changed' = 'true'; COMMIT;" "workspace rename audit metadata persisted" -v original_workspace_name="$ORIGINAL_WORKSPACE_NAME" -v renamed_workspace_name="$RENAMED_WORKSPACE_NAME"
assert_sql_equals 0 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT count(*) FROM audit_log WHERE action = 'workspace.name.updated' AND detail->>'new_name' IN ('member must not rename', 'suspended admin must not rename', 'deleted admin must not rename', 'stale rename must fail'); COMMIT;" "denied and stale renames create no audit row"

api PATCH "/v1/workspaces/$DEMO_WORKSPACE_ID" \
  "$(jq -cn --arg name "$ORIGINAL_WORKSPACE_NAME" --argjson expected "$RENAMED_WORKSPACE_UPDATED_AT_MS" '{name:$name,expectedUpdatedAtMs:$expected}')" \
  "$OWNER_TOKEN"
expect_status 200 "owner restores workspace identity fixture"
WORKSPACE_RENAMED=0
api GET "/v1/workspaces/$DEMO_WORKSPACE_ID" "" "$OWNER_TOKEN"
expect_status 200 "owner reloads restored workspace identity"
expect_jq --arg expected "$ORIGINAL_WORKSPACE_NAME" '.workspace.name == $expected' "apostrophe workspace name is safely restored"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels" \
  "$(jq -cn --arg name "$OWNER_CHANNEL_NAME" '{kind:"public",name:$name,topic:"MOMO-214 runtime channel"}')" \
  "$OWNER_TOKEN"
expect_status 201 "owner creates public channel"
expect_jq '.channel.kind == "public" and .creatorMembership.role == "owner"' "owner create response includes creator membership"
OWNER_CHANNEL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.channel.id')"

assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT count(*) FROM channel_seq WHERE channel_id = '$OWNER_CHANNEL_ID' AND last_seq = 0; COMMIT;" "channel_seq initialized"
assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT count(*) FROM membership WHERE channel_id = '$OWNER_CHANNEL_ID' AND member_id = '00000000-0000-7000-8000-000000000101' AND role = 'owner' AND left_at IS NULL; COMMIT;" "creator membership inserted"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels" \
  "$(jq -cn --arg name "$ADMIN_CHANNEL_NAME" '{kind:"private",name:$name}')" \
  "$ADMIN_TOKEN"
expect_status 201 "admin creates private channel"
expect_jq '.channel.kind == "private" and .creatorMembership.role == "owner"' "admin-created channel is private"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels" \
  "$(jq -cn --arg name "member-$RUN_SAFE" '{kind:"public",name:$name}')" \
  "$MEMBER_TOKEN"
expect_status 403 "ordinary member cannot create channel"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/members" \
  '{"member_id":"00000000-0000-7000-8000-000000000197","role":"member"}' \
  "$OWNER_TOKEN"
expect_status 200 "owner adds human member"
expect_jq '.membership.memberId == "00000000-0000-7000-8000-000000000197" and .membership.leftAtMs == null' "human membership active"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/members" \
  '{"member_id":"00000000-0000-7000-8000-000000000102","role":"member"}' \
  "$OWNER_TOKEN"
expect_status 200 "owner adds agent member"
expect_jq '.membership.memberId == "00000000-0000-7000-8000-000000000102" and .membership.leftAtMs == null' "agent membership active"

assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT count(*) FROM membership WHERE channel_id = '$OWNER_CHANNEL_ID' AND member_id = '00000000-0000-7000-8000-000000000102' AND left_at IS NULL; COMMIT;" "agent membership persisted"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/members" \
  '{"member_id":"00000000-0000-7000-8000-000000000196","role":"member"}' \
  "$MEMBER_TOKEN"
expect_status 403 "ordinary member cannot add channel members"

api DELETE "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/members/00000000-0000-7000-8000-000000000197" \
  "" "$ADMIN_TOKEN"
expect_status 200 "admin removes human member"
expect_jq '.membership.memberId == "00000000-0000-7000-8000-000000000197" and .membership.leftAtMs != null' "removed membership has leftAtMs"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/messages" \
  "$(jq -cn --arg id "$(uuidgen)" '{clientMsgId:$id,type:"text",body:"should be denied after removal"}')" \
  "$MEMBER_TOKEN"
expect_status 403 "removed member cannot write channel"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/members" \
  '{"member_id":"00000000-0000-7000-8000-000000000197","role":"member"}' \
  "$ADMIN_TOKEN"
expect_status 200 "admin re-adds human member"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/messages" \
  "$(jq -cn --arg id "$(uuidgen)" '{clientMsgId:$id,type:"text",body:"MOMO-214 managed channel message"}')" \
  "$MEMBER_TOKEN"
expect_status 201 "re-added human can write channel"
OWNER_CHANNEL_ID_LOWER="$(printf '%s' "$OWNER_CHANNEL_ID" | tr '[:upper:]' '[:lower:]')"
expect_jq '.seq == 1 and (.channelId | ascii_downcase) == "'"$OWNER_CHANNEL_ID_LOWER"'"' "message send uses initialized channel_seq"

assert_sql_equals 1 "BEGIN; SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID'; SELECT last_seq FROM channel_seq WHERE channel_id = '$OWNER_CHANNEL_ID'; COMMIT;" "channel_seq advanced after message send"

api DELETE "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/members/00000000-0000-7000-8000-000000000102" \
  "" "$MEMBER_TOKEN"
expect_status 403 "ordinary member cannot remove channel members"

api POST "/v1/workspaces/$WORKSPACE_B/channels" \
  "$(jq -cn --arg name "cross-$RUN_SAFE" '{kind:"public",name:$name}')" \
  "$OWNER_TOKEN"
expect_status 403 "workspace A token cannot create in workspace B path"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$OWNER_CHANNEL_ID/members" \
  '{"member_id":"23000000-0000-7000-8000-000000000102","role":"member"}' \
  "$OWNER_TOKEN"
expect_status 404 "workspace A token cannot add workspace B member"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/channels/23000000-0000-7000-8000-000000000201/members" \
  '{"member_id":"00000000-0000-7000-8000-000000000197","role":"member"}' \
  "$OWNER_TOKEN"
expect_status 404 "workspace A token cannot add member to workspace B channel"

api DELETE "/v1/workspaces/$WORKSPACE_B/channels/23000000-0000-7000-8000-000000000201/members/23000000-0000-7000-8000-000000000102" \
  "" "$OWNER_TOKEN"
expect_status 403 "workspace A token cannot remove in workspace B path"

api GET "/v1/workspaces/$WORKSPACE_B/channels" "" "$B_OWNER_TOKEN"
expect_status 200 "workspace B owner can still read own channels"
expect_jq 'all(.channels[]; .workspaceId == "'"$WORKSPACE_B"'")' "workspace B read remains tenant scoped"

echo "[channel-management] PASS channel/member/canonical-DM runtime verifier"
