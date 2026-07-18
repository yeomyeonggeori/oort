#!/usr/bin/env bash
# MOMO-476 thread reply + rollup runtime-db verifier.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[thread] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${THREAD_GATE_PROJECT:-momo476thread}"
API_PORT="${THREAD_GATE_PORT:-19870}"
PG_PORT="${THREAD_GATE_POSTGRES_PORT:-19871}"
CENT_PORT_HOST="${THREAD_GATE_CENT_PORT:-19872}"
HERMES_PORT_HOST="${THREAD_GATE_HERMES_PORT:-19873}"
BOOT_TIMEOUT="${THREAD_GATE_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-thread-$RUN_ID"
mkdir -p "$TMP_DIR"

WS_A="00000000-0000-7000-8000-000000000001"
CH_A="00000000-0000-7000-8000-000000000201"
CH_B="47600000-0000-7000-8000-000000000202"
MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MEMBER_EMAIL="thread-$RUN_ID@momo.local"
MEMBER_PASSWORD="thread-$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${THREAD_GATE_KEEP:-0}" = "1" ]; then
    echo "[thread] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[thread] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[thread] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[thread] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$MEMBER_ID', '$WS_A', 'human', 'active', 'Thread Gate', 'thread-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$MEMBER_ID', '$WS_A', '$MEMBER_EMAIL', true,
        momo_password_hash('$MEMBER_PASSWORD'), 'UTC');
INSERT INTO channel (id, workspace_id, kind, name, created_by)
VALUES ('$CH_B', '$WS_A', 'public', 'thread-other-$RUN_ID', '$MEMBER_ID');
INSERT INTO channel_seq (workspace_id, channel_id, last_seq)
VALUES ('$WS_A', '$CH_B', 0);
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_A', '$CH_A', '$MEMBER_ID', 'member'),
  ('$WS_A', '$CH_B', '$MEMBER_ID', 'owner');
COMMIT;
SQL

TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$MEMBER_EMAIL" --arg p "$MEMBER_PASSWORD" --arg w "$WS_A" \
    '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken')"

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" body="${3:-}" out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[thread] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}
send_message() {
  local channel="$1" client_id="$2" body="$3" root_id="${4:-}"
  local payload
  if [ -n "$root_id" ]; then
    payload="$(jq -cn --arg c "$client_id" --arg b "$body" --arg r "$root_id" \
      '{clientMsgId:$c,body:$b,rootId:$r}')"
  else
    payload="$(jq -cn --arg c "$client_id" --arg b "$body" '{clientMsgId:$c,body:$b}')"
  fi
  api POST "/v1/workspaces/$WS_A/channels/$channel/messages" "$payload"
}

send_message "$CH_A" "$(uuidgen)" "thread root"
expect_status 201 "root send"
ROOT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"

REPLY_CLIENT_ID="$(uuidgen)"
send_message "$CH_A" "$REPLY_CLIENT_ID" "normal reply" "$ROOT_ID"
expect_status 201 "normal reply"
REPLY_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"
REPLY_SEQ="$(printf '%s' "$RESPONSE_BODY" | jq -er '.seq')"
printf '%s' "$RESPONSE_BODY" | jq -e --arg root "$ROOT_ID" \
  '(.rootId | ascii_downcase) == $root' >/dev/null

got="$(sql_value <<SQL
SELECT reply_count || ':' || last_reply_seq || ':' || (last_reply_at IS NOT NULL)::int || ':' || (participant_ids = ARRAY['$MEMBER_ID'::uuid])::int FROM thread WHERE root_id='$ROOT_ID';
SQL
)"
[ "$got" = "1:$REPLY_SEQ:1:1" ] || { echo "[thread] FAIL initial rollup: $got" >&2; exit 1; }

got="$(sql_value <<SQL
SELECT count(*) FROM outbox WHERE workspace_id='$WS_A' AND payload->'data'->'payload'->>'id' ILIKE '$REPLY_ID' AND payload->'data'->'payload'->>'root_id' ILIKE '$ROOT_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[thread] FAIL realtime root_id: $got" >&2; exit 1; }

api GET "/v1/workspaces/$WS_A/channels/$CH_A/messages?after=0&limit=200"
expect_status 200 "history rootId"
printf '%s' "$RESPONSE_BODY" | jq -e --arg id "$REPLY_ID" --arg root "$ROOT_ID" \
  '.messages[] | select((.id | ascii_downcase) == $id) | (.rootId | ascii_downcase) == $root' >/dev/null

# An idempotent retry returns the original reply without incrementing the rollup.
send_message "$CH_A" "$REPLY_CLIENT_ID" "normal reply retry" "$ROOT_ID"
expect_status 201 "idempotent reply retry"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.id' | tr '[:upper:]' '[:lower:]')" = "$REPLY_ID" ] || {
  echo "[thread] FAIL idempotent retry returned another message" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT reply_count FROM thread WHERE root_id='$ROOT_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[thread] FAIL retry changed reply_count: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM outbox WHERE workspace_id='$WS_A' AND payload->'data'->'payload'->>'id' ILIKE '$REPLY_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[thread] FAIL retry duplicated outbox: $got" >&2; exit 1; }

send_message "$CH_B" "$(uuidgen)" "other channel root"
expect_status 201 "other-channel root send"
CROSS_ROOT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"
send_message "$CH_A" "$(uuidgen)" "cross-channel reply" "$CROSS_ROOT_ID"
expect_status 404 "cross-channel root non-disclosure"

send_message "$CH_A" "$(uuidgen)" "deleted root"
expect_status 201 "deleted root fixture"
DELETED_ROOT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"
run_sql <<SQL
BEGIN;
SET LOCAL row_security=off;
UPDATE message SET state='deleted', deleted_at=clock_timestamp() WHERE id='$DELETED_ROOT_ID';
COMMIT;
SQL
send_message "$CH_A" "$(uuidgen)" "reply to deleted" "$DELETED_ROOT_ID"
expect_status 400 "deleted root"

send_message "$CH_A" "$(uuidgen)" "nested reply" "$REPLY_ID"
expect_status 400 "nested reply rejection"

# Two simultaneous replies must both survive the atomic reply_count increment.
send_message "$CH_A" "$(uuidgen)" "concurrent root"
expect_status 201 "concurrent root fixture"
CONCURRENT_ROOT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"
for index in 1 2; do
  jq -cn --arg c "$(uuidgen)" --arg r "$CONCURRENT_ROOT_ID" --arg b "reply $index" \
    '{clientMsgId:$c,body:$b,rootId:$r}' >"$TMP_DIR/concurrent-$index-request.json"
done
parallel_reply() {
  local index="$1"
  curl -sS -o "$TMP_DIR/concurrent-$index-response.json" \
    -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    --data-binary "@$TMP_DIR/concurrent-$index-request.json" \
    "$BASE_URL/v1/workspaces/$WS_A/channels/$CH_A/messages" \
    >"$TMP_DIR/concurrent-$index-status"
}
parallel_reply 1 &
pid_1=$!
parallel_reply 2 &
pid_2=$!
wait "$pid_1"
wait "$pid_2"
for index in 1 2; do
  [ "$(cat "$TMP_DIR/concurrent-$index-status")" = "201" ] || {
    echo "[thread] FAIL concurrent reply $index" >&2
    cat "$TMP_DIR/concurrent-$index-response.json" >&2
    exit 1
  }
done
MAX_SEQ="$(jq -s 'map(.seq) | max' "$TMP_DIR/concurrent-1-response.json" "$TMP_DIR/concurrent-2-response.json")"
got="$(sql_value <<SQL
SELECT reply_count || ':' || last_reply_seq || ':' || (participant_ids = ARRAY['$MEMBER_ID'::uuid])::int FROM thread WHERE root_id='$CONCURRENT_ROOT_ID';
SQL
)"
[ "$got" = "2:$MAX_SEQ:1" ] || { echo "[thread] FAIL concurrent rollup: $got" >&2; exit 1; }

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='47600000-0000-7000-8000-000000000099';
SELECT count(*) FROM thread WHERE root_id='$ROOT_ID';
COMMIT;
SQL
)"
[ "$got" = "0" ] || { echo "[thread] FAIL thread RLS isolation: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM pg_class WHERE relname IN ('message','thread') AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$got" = "2" ] || { echo "[thread] FAIL FORCE RLS metadata: $got" >&2; exit 1; }

echo "MOMO-476 thread reply + atomic rollup + realtime/history + RLS PASS"
