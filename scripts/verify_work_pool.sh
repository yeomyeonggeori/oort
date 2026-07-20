#!/usr/bin/env bash
# MOMO-489 / ADR-0125 D5 workspace-shared work-pool quota gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[work-pool] missing $1" >&2
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
  echo "[work-pool] Python 3.10+ not found (tried python3.13 through python3)" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORK_POOL_GATE_PROJECT:-momo489workpool}"
API_PORT="${WORK_POOL_GATE_API_PORT:-27960}"
CENT_PORT_HOST="${WORK_POOL_GATE_CENTRIFUGO_PORT:-27961}"
PG_PORT="${WORK_POOL_GATE_POSTGRES_PORT:-27962}"
HERMES_PORT_HOST="${WORK_POOL_GATE_HERMES_PORT:-27963}"
BOOT_TIMEOUT="${WORK_POOL_GATE_BOOT_TIMEOUT:-2400}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-pool.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_WS_ID="48900000-0000-7000-8000-000000000099"
OWNER_ID="$(new_uuid)"
ADMIN_ID="$(new_uuid)"
OTHER_ID="$(new_uuid)"
OWNER_EMAIL="work-pool-owner-$RUN_TAG@momo.local"
ADMIN_EMAIL="work-pool-admin-$RUN_TAG@momo.local"
OTHER_EMAIL="work-pool-member-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
ADMIN_PASSWORD="admin-$(new_uuid)"
OTHER_PASSWORD="member-$(new_uuid)"
HOST_PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORK_POOL_GATE_KEEP:-0}" = "1" ]; then
    echo "[work-pool] leaving compose project '$PROJECT' up"
    echo "[work-pool] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-work-pool.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[work-pool] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"

echo "[work-pool] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-pool] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-pool] api exited" >&2
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
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Work Pool Owner', 'wpo-$RUN_TAG'),
  ('$ADMIN_ID', '$WS_ID', 'human', 'active', 'Work Pool Admin', 'wpa-$RUN_TAG'),
  ('$OTHER_ID', '$WS_ID', 'human', 'active', 'Work Pool Member', 'wpm-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$ADMIN_ID', '$WS_ID', '$ADMIN_EMAIL', true, momo_password_hash('$ADMIN_PASSWORD'), 'UTC'),
  ('$OTHER_ID', '$WS_ID', '$OTHER_EMAIL', true, momo_password_hash('$OTHER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$ADMIN_ID', 'admin'),
  ('$WS_ID', '$CHANNEL_ID', '$OTHER_ID', 'member');
INSERT INTO workspace (id, slug, name)
VALUES ('$CROSS_WS_ID', 'momo-489-cross-$RUN_TAG', 'MOMO-489 Cross Workspace');
INSERT INTO work_pool
  (workspace_id, max_active, included_active_hours, per_member_soft_limit)
VALUES ('$CROSS_WS_ID', 7, 200, 4);
COMMIT;
SQL

login() {
  local email="$1" password="$2"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$password" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
OWNER_TOKEN="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
OTHER_TOKEN="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")"

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
    echo "[work-pool] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

POOL_PATH="/v1/workspaces/$WS_ID/work-pool"
SESSION_PATH="/v1/workspaces/$WS_ID/work-sessions"

# Migration backfills the existing workspace with the v0 settings and stores
# no active counter. Delete/re-read also proves the tenant upsert-on-read path.
got="$(sql_value <<SQL
SELECT max_active || ':' || coalesce(included_active_hours::text, 'NULL') || ':' ||
       per_member_soft_limit
  FROM work_pool WHERE workspace_id='$WS_ID';
SQL
)"
[ "$got" = "5:NULL:5" ] || {
  echo "[work-pool] FAIL migration default row: $got" >&2
  exit 1
}
run_sql <<SQL
DELETE FROM work_pool WHERE workspace_id='$WS_ID';
SQL
api "$OWNER_TOKEN" GET "$POOL_PATH"
expect_status 200 "default upsert-on-read"
printf '%s' "$RESPONSE_BODY" | jq -e --arg workspace "$WS_ID" '
  .workPool
  | (.workspaceId | ascii_downcase) == $workspace
    and .maxActive == 5
    and .perMemberSoftLimit == 5
    and .activeSessions == 0
    and .memberActiveSessions == 0
    and (.includedActiveHours == null)
  ' >/dev/null

register_host() {
  local token="$1" name="$2"
  api "$token" POST "/v1/workspaces/$WS_ID/work-hosts" \
    "$(jq -cn --arg key "$HOST_PUBLIC_KEY" --arg name "$name" \
      '{scope:"member",type:"app",displayName:$name,publicKey:$key,
        capabilities:{"tool.codex":true}}')"
  expect_status 201 "work host registration ($name)"
  printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase'
}
OWNER_HOST_ID="$(register_host "$OWNER_TOKEN" "MOMO-489 owner host")"
OTHER_HOST_ID="$(register_host "$OTHER_TOKEN" "MOMO-489 member host")"

# Non-admin writes are forbidden and do not audit. Admin settings + audit commit
# together; the GET response always derives usage from running sessions.
api "$OTHER_TOKEN" PUT "$POOL_PATH" \
  '{"maxActive":2,"includedActiveHours":100,"perMemberSoftLimit":2}'
expect_status 403 "non-admin pool update"
got="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID' AND action='work.pool.updated';
SQL
)"
[ "$got" = "0" ] || {
  echo "[work-pool] FAIL forbidden PUT wrote audit: $got" >&2
  exit 1
}

api "$ADMIN_TOKEN" PUT "$POOL_PATH" \
  '{"maxActive":2,"includedActiveHours":100,"perMemberSoftLimit":2}'
expect_status 200 "admin pool update"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .workPool.maxActive == 2
  and .workPool.includedActiveHours == 100
  and .workPool.perMemberSoftLimit == 2
  and .workPool.activeSessions == 0
  ' >/dev/null
got="$(sql_value <<SQL
SELECT
  (SELECT max_active || ':' || included_active_hours || ':' || per_member_soft_limit
     FROM work_pool WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND actor_member_id='$ADMIN_ID'
      AND action='work.pool.updated'
      AND target_type='work_pool' AND target_id='$WS_ID'
      AND detail->>'schema'='momo.work_pool.updated.v1'
      AND (detail->'new'->>'max_active')::int=2
      AND (detail->'new'->>'included_active_hours')::int=100
      AND (detail->'new'->>'per_member_soft_limit')::int=2);
SQL
)"
[ "$got" = "2:100:2:1" ] || {
  echo "[work-pool] FAIL admin update/audit transaction evidence: $got" >&2
  exit 1
}

create_session() {
  local token="$1" host_id="$2" label="$3"
  api "$token" POST "$SESSION_PATH" \
    "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$host_id" --arg label "$label" \
      '{channelId:$channel,hostId:$host,tool:"codex",label:$label}')"
}
end_session() {
  local token="$1" session_id="$2"
  api "$token" PATCH "$SESSION_PATH/$session_id" '{"status":"ended","exitCode":0}'
  expect_status 200 "session end $session_id"
}
ledger_counts() {
  sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_session WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM message
    WHERE workspace_id='$WS_ID' AND props->>'kind'='work_session') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE workspace_id='$WS_ID'
      AND payload->'data'->>'type' LIKE 'work.session.%');
SQL
}

# Workspace hard cap: two different members share the same two slots. The third
# create is a code-only 409 and cannot create a session, card, or outbox event.
create_session "$OWNER_TOKEN" "$OWNER_HOST_ID" "MOMO-489 hard owner"
expect_status 201 "owner hard-cap acquire"
HARD_OWNER_SESSION="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
create_session "$OTHER_TOKEN" "$OTHER_HOST_ID" "MOMO-489 hard member"
expect_status 201 "member hard-cap acquire"
HARD_OTHER_SESSION="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
api "$OWNER_TOKEN" GET "$POOL_PATH"
expect_status 200 "hard-cap usage GET"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .workPool.activeSessions == 2 and .workPool.memberActiveSessions == 1
  ' >/dev/null
before="$(ledger_counts)"
create_session "$OWNER_TOKEN" "$OWNER_HOST_ID" "MOMO-489 hard rejected"
expect_status 409 "workspace hard cap"
printf '%s' "$RESPONSE_BODY" | jq -e '.error.message == "pool_exhausted"' >/dev/null
after="$(ledger_counts)"
[ "$before" = "$after" ] || {
  echo "[work-pool] FAIL pool_exhausted created ledger rows: $before -> $after" >&2
  exit 1
}

# Ending a session changes the authoritative aggregate immediately; no release
# counter mutation exists. The reclaimed slot can be acquired in the next tx.
end_session "$OWNER_TOKEN" "$HARD_OWNER_SESSION"
api "$OWNER_TOKEN" GET "$POOL_PATH"
expect_status 200 "usage after end"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .workPool.activeSessions == 1 and .workPool.memberActiveSessions == 0
  ' >/dev/null
create_session "$OWNER_TOKEN" "$OWNER_HOST_ID" "MOMO-489 recovered slot"
expect_status 201 "acquire after end"
RECOVERED_SESSION="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
end_session "$OTHER_TOKEN" "$HARD_OTHER_SESSION"
end_session "$OWNER_TOKEN" "$RECOVERED_SESSION"

# Per-member fairness is checked after the workspace hard cap, returning its own
# stable reason while spare workspace capacity remains.
api "$ADMIN_TOKEN" PUT "$POOL_PATH" \
  '{"maxActive":3,"includedActiveHours":100,"perMemberSoftLimit":1}'
expect_status 200 "soft-limit settings"
create_session "$OWNER_TOKEN" "$OWNER_HOST_ID" "MOMO-489 soft owner"
expect_status 201 "soft-limit first acquire"
SOFT_SESSION="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
before="$(ledger_counts)"
create_session "$OWNER_TOKEN" "$OWNER_HOST_ID" "MOMO-489 soft rejected"
expect_status 409 "per-member soft limit"
printf '%s' "$RESPONSE_BODY" | jq -e '.error.message == "member_limit"' >/dev/null
after="$(ledger_counts)"
[ "$before" = "$after" ] || {
  echo "[work-pool] FAIL member_limit created ledger rows: $before -> $after" >&2
  exit 1
}
end_session "$OWNER_TOKEN" "$SOFT_SESSION"

# Eight overlapping creates compete for two slots. No request ends during the
# race, so a final running count of exactly two proves no transient over-acquire
# could commit past the work_pool FOR UPDATE lock.
api "$ADMIN_TOKEN" PUT "$POOL_PATH" \
  '{"maxActive":2,"includedActiveHours":100,"perMemberSoftLimit":2}'
expect_status 200 "concurrency settings"
pids=()
for i in 1 2 3 4 5 6 7 8; do
  if [ $((i % 2)) -eq 0 ]; then
    token="$OTHER_TOKEN"
    host="$OTHER_HOST_ID"
  else
    token="$OWNER_TOKEN"
    host="$OWNER_HOST_ID"
  fi
  body="$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$host" --arg label "MOMO-489 race $i" \
    '{channelId:$channel,hostId:$host,tool:"codex",label:$label}')"
  curl -sS -o "$TMP_DIR/concurrent-$i.json" -w '%{http_code}' \
    -X POST "$BASE_URL$SESSION_PATH" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $token" \
    --data "$body" >"$TMP_DIR/concurrent-$i.status" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "$pid"
done

created=0
conflicts=0
for i in 1 2 3 4 5 6 7 8; do
  status="$(<"$TMP_DIR/concurrent-$i.status")"
  case "$status" in
    201)
      jq -e '.workSession.status == "running"' "$TMP_DIR/concurrent-$i.json" >/dev/null
      created=$((created + 1))
      ;;
    409)
      jq -e '.error.message == "pool_exhausted"' "$TMP_DIR/concurrent-$i.json" >/dev/null
      conflicts=$((conflicts + 1))
      ;;
    *)
      echo "[work-pool] FAIL concurrent request $i returned HTTP $status" >&2
      cat "$TMP_DIR/concurrent-$i.json" >&2
      exit 1
      ;;
  esac
done
[ "$created:$conflicts" = "2:6" ] || {
  echo "[work-pool] FAIL concurrent acquire results: created=$created conflicts=$conflicts" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_session
    WHERE workspace_id='$WS_ID' AND status='running') || ':' ||
  (SELECT max_active FROM work_pool WHERE workspace_id='$WS_ID');
SQL
)"
[ "$got" = "2:2" ] || {
  echo "[work-pool] FAIL concurrent acquire exceeded max: $got" >&2
  exit 1
}

# The cap increase used for the soft-limit phase is explicitly represented in
# the audit detail. All three successful admin PUTs produced one audit row each.
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND action='work.pool.updated') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND action='work.pool.updated'
      AND detail->>'max_active_increased'='true');
SQL
)"
[ "$got" = "3:1" ] || {
  echo "[work-pool] FAIL pool audit count/cap increase marker: $got" >&2
  exit 1
}

# FORCE RLS hides the main workspace pool and its audit rows when the tenant GUC
# is switched to the cross workspace. The settings table has exactly four data
# columns; active usage exists only in work_session.
got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_WS_ID';
SELECT
  (SELECT count(*) FROM work_pool WHERE workspace_id='$WS_ID') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE workspace_id='$WS_ID' AND action='work.pool.updated');
COMMIT;
SQL
)"
[ "$got" = "0:0" ] || {
  echo "[work-pool] FAIL cross-tenant RLS isolation: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM pg_class
    WHERE relname='work_pool' AND relrowsecurity AND relforcerowsecurity) || ':' ||
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='work_pool') || ':' ||
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='work_pool'
      AND column_name IN
        ('workspace_id','max_active','included_active_hours','per_member_soft_limit'));
SQL
)"
[ "$got" = "1:4:4" ] || {
  echo "[work-pool] FAIL FORCE RLS/derived-only schema metadata: $got" >&2
  exit 1
}

echo "MOMO-489 work-pool default/acquire/limits/concurrency/release/admin-audit/RLS PASS"
