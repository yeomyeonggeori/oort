#!/usr/bin/env bash
# MOMO-671 / ADR-0143 workstream continuity gate.
#
# What this proves, end to end, over real REST logins against an isolated stack:
#   1. A starts a session in a thread -> the workstream is created implicitly
#      (no declaration step) and the Run is attached to it.
#   2. B, another member of the anchor channel, continues the orphaned Run ->
#      the new Run lands in the SAME workstream and the execution history lists
#      A and B side by side. work_session.member_id is never transferred.
#   3. C, a workspace member who is NOT in the anchor channel, is refused with
#      403 on resume and 404 on every workstream read. The refusal is taken from
#      a real bearer through the real route, not from an SQL predicate.
#   4. The trigger, not one REST handler, is what attaches Runs: a Run inserted
#      directly into the ledger still gets its thread's workstream.
#
# Red proof (must be re-run whenever the eligibility predicate is touched):
#   In WorkSessionRoutes.resume, replace
#       try await Self.requireChannelMember(...)
#   with the pre-ADR-0143 owner guard
#       guard source.3 == principal.memberID else { throw HTTPError(.forbidden, ...) }
#   and re-run. The gate must fail by name at
#       [workstream] FAIL channel-member takeover: expected HTTP 201, got 403
#   which is the assertion that would silently pass if the predicate were absent.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[workstream] missing $1" >&2
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
  echo "[workstream] Python 3.10+ not found (tried python3.13 through python3)" >&2
  return 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORKSTREAM_GATE_PROJECT:-momo671workstream}"
API_PORT="${WORKSTREAM_GATE_API_PORT:-28410}"
CENT_PORT_HOST="${WORKSTREAM_GATE_CENTRIFUGO_PORT:-28411}"
PG_PORT="${WORKSTREAM_GATE_POSTGRES_PORT:-28412}"
HERMES_PORT_HOST="${WORKSTREAM_GATE_HERMES_PORT:-28413}"
BOOT_TIMEOUT="${WORKSTREAM_GATE_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-workstream.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_TENANT_ID="67100000-0000-7000-8000-000000000099"
A_ID="$(new_uuid)"
B_ID="$(new_uuid)"
C_ID="$(new_uuid)"
HOST_PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="
A_EMAIL="workstream-a-$RUN_ID@momo.local"
B_EMAIL="workstream-b-$RUN_ID@momo.local"
C_EMAIL="workstream-c-$RUN_ID@momo.local"
A_PASSWORD="a-$(new_uuid)"
B_PASSWORD="b-$(new_uuid)"
C_PASSWORD="c-$(new_uuid)"
GOAL_LABEL="MOMO-671 ship the workstream layer"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORKSTREAM_GATE_KEEP:-0}" = "1" ]; then
    echo "[workstream] leaving compose project '$PROJECT' up"
    echo "[workstream] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-workstream.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[workstream] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"

echo "[workstream] booting isolated api/relay stack '$PROJECT'"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[workstream] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[workstream] api exited" >&2
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

# Identity bootstrap only. Channel membership for B is granted through the real
# REST route below, and C is deliberately left out of the channel so that the
# 403/404 assertions exercise the production predicate.
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$A_ID'::uuid, '$WS_ID'::uuid, 'human', 'active', 'Workstream A', 'wsa-$RUN_ID'),
  ('$B_ID'::uuid, '$WS_ID'::uuid, 'human', 'active', 'Workstream B', 'wsb-$RUN_ID'),
  ('$C_ID'::uuid, '$WS_ID'::uuid, 'human', 'active', 'Workstream C', 'wsc-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$A_ID'::uuid, '$WS_ID'::uuid, '$A_EMAIL', true, momo_password_hash('$A_PASSWORD'), 'UTC'),
  ('$B_ID'::uuid, '$WS_ID'::uuid, '$B_EMAIL', true, momo_password_hash('$B_PASSWORD'), 'UTC'),
  ('$C_ID'::uuid, '$WS_ID'::uuid, '$C_EMAIL', true, momo_password_hash('$C_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WS_ID'::uuid, '$A_ID'::uuid, 'owner'),
  ('$WS_ID'::uuid, '$B_ID'::uuid, 'member'),
  ('$WS_ID'::uuid, '$C_ID'::uuid, 'member');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID'::uuid, '$CHANNEL_ID'::uuid, '$A_ID'::uuid, 'owner');
COMMIT;
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
A_TOKEN="$(login "$A_EMAIL" "$A_PASSWORD")"
B_TOKEN="$(login "$B_EMAIL" "$B_PASSWORD")"
C_TOKEN="$(login "$C_EMAIL" "$C_PASSWORD")"

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
    echo "[workstream] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}
fail() {
  echo "[workstream] FAIL $1" >&2
  exit 1
}

# B joins the anchor channel through the production route.
api "$A_TOKEN" POST "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/members" \
  "$(jq -cn --arg member "$B_ID" '{memberId:$member,role:"member"}')"
expect_status 200 "channel member add (B)"

# ---------------------------------------------------------------------------
# 1. A starts a session -> workstream implicit creation.
# ---------------------------------------------------------------------------
api "$A_TOKEN" POST "/v1/workspaces/$WS_ID/work-hosts" \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
    '{scope:"member",type:"app",displayName:"MOMO-671 host A",publicKey:$key,
      capabilities:{"tool.codex":true}}')"
expect_status 201 "work host registration (A)"
HOST_A_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase')"

api "$B_TOKEN" POST "/v1/workspaces/$WS_ID/work-hosts" \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
    '{scope:"member",type:"app",displayName:"MOMO-671 host B",publicKey:$key,
      capabilities:{"tool.codex":true}}')"
expect_status 201 "work host registration (B)"
HOST_B_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase')"

api "$A_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$HOST_A_ID" --arg label "$GOAL_LABEL" \
    '{channelId:$channel,hostId:$host,tool:"codex",label:$label}')"
expect_status 201 "session create (A)"
RUN_A_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
ROOT_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.rootMessageId | ascii_downcase')"

api "$A_TOKEN" GET "/v1/workspaces/$WS_ID/workstreams?sessionId=$RUN_A_ID"
expect_status 200 "workstream lookup by session"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg root "$ROOT_MESSAGE_ID" --arg channel "$CHANNEL_ID" --arg a "$A_ID" \
  --arg goal "$GOAL_LABEL" '
  (.workstreams | length) == 1
  and (.workstreams[0].rootMessageId | ascii_downcase) == $root
  and (.workstreams[0].channelId | ascii_downcase) == $channel
  and (.workstreams[0].createdByMemberId | ascii_downcase) == $a
  and .workstreams[0].goal == $goal
  and .workstreams[0].status == "active"
  and .workstreams[0].runCount == 1
  and .workstreams[0].activeRunCount == 1
  ' >/dev/null || fail "implicit workstream creation projection"
WORKSTREAM_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workstreams[0].id | ascii_downcase')"

got="$(sql_value <<SQL
SELECT count(*) FROM work_session ws
  JOIN workstream w ON w.id = ws.workstream_id AND w.workspace_id = ws.workspace_id
 WHERE lower(ws.id::text) = lower('$RUN_A_ID')
   AND lower(w.id::text) = lower('$WORKSTREAM_ID')
   AND lower(w.root_message_id::text) = lower('$ROOT_MESSAGE_ID');
SQL
)"
[ "$got" = "1" ] || fail "ledger did not attach the first Run to its thread workstream: $got"

# ---------------------------------------------------------------------------
# 2. Host loss. The orphaning sweep itself is covered by verify_tier_fallback;
#    here it is only the precondition for the takeover.
# ---------------------------------------------------------------------------
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE work_session SET status='orphaned'
 WHERE lower(id::text) = lower('$RUN_A_ID');
COMMIT;
SQL

# ---------------------------------------------------------------------------
# 3. Non-member refusal, through the real route with a real bearer.
# ---------------------------------------------------------------------------
api "$C_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions/$RUN_A_ID/resume" \
  "$(jq -cn --arg host "$HOST_B_ID" '{targetHostId:$host}')"
expect_status 403 "non-member resume"
printf '%s' "$RESPONSE_BODY" | jq -e '.error.message == "active channel membership required"' \
  >/dev/null || fail "non-member resume was refused for the wrong reason"

api "$C_TOKEN" GET "/v1/workspaces/$WS_ID/workstreams/$WORKSTREAM_ID"
expect_status 404 "non-member workstream detail"
api "$C_TOKEN" GET "/v1/workspaces/$WS_ID/workstreams/$WORKSTREAM_ID/runs"
expect_status 404 "non-member workstream runs"
api "$C_TOKEN" GET "/v1/workspaces/$WS_ID/workstreams"
expect_status 200 "non-member workstream list"
printf '%s' "$RESPONSE_BODY" | jq -e '(.workstreams | length) == 0' >/dev/null \
  || fail "non-member saw a workstream in the list projection"

got="$(sql_value <<SQL
SELECT count(*) FROM work_session
 WHERE lower(workstream_id::text) = lower('$WORKSTREAM_ID');
SQL
)"
[ "$got" = "1" ] || fail "refused resume still created a Run: $got"

# ---------------------------------------------------------------------------
# 4. Channel-member takeover. This is the assertion the red proof must break.
# ---------------------------------------------------------------------------
api "$B_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions/$RUN_A_ID/resume" \
  "$(jq -cn --arg host "$HOST_B_ID" '{targetHostId:$host}')"
expect_status 201 "channel-member takeover"
RUN_B_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
printf '%s' "$RESPONSE_BODY" | jq -e --arg source "$RUN_A_ID" --arg b "$B_ID" \
  --arg root "$ROOT_MESSAGE_ID" '
  .workSession.status == "running"
  and (.workSession.memberId | ascii_downcase) == $b
  and (.workSession.rootMessageId | ascii_downcase) == $root
  and (.workSession.resumedFromSessionId | ascii_downcase) == $source
  ' >/dev/null || fail "takeover Run lineage projection"

# The first Run keeps its actor: continuity moved, ownership did not.
got="$(sql_value <<SQL
SELECT count(*) FROM work_session
 WHERE lower(id::text) = lower('$RUN_A_ID')
   AND lower(member_id::text) = lower('$A_ID')
   AND status = 'ended' AND end_reason = 'resumed';
SQL
)"
[ "$got" = "1" ] || fail "the first Run's member_id was mutated by the takeover: $got"

got="$(sql_value <<SQL
SELECT count(DISTINCT workstream_id) || ':' || count(*)
  FROM work_session
 WHERE lower(id::text) IN (lower('$RUN_A_ID'), lower('$RUN_B_ID'));
SQL
)"
[ "$got" = "1:2" ] || fail "the two Runs are not in one workstream: $got"

# ---------------------------------------------------------------------------
# 5. Execution history lists A and B side by side, for both members.
# ---------------------------------------------------------------------------
for actor in A B; do
  case "$actor" in
    A) token="$A_TOKEN" ;;
    B) token="$B_TOKEN" ;;
  esac
  api "$token" GET "/v1/workspaces/$WS_ID/workstreams/$WORKSTREAM_ID/runs"
  expect_status 200 "workstream runs ($actor)"
  printf '%s' "$RESPONSE_BODY" | jq -e \
    --arg ws "$WORKSTREAM_ID" --arg runA "$RUN_A_ID" --arg runB "$RUN_B_ID" \
    --arg a "$A_ID" --arg b "$B_ID" '
    (.workstreamId | ascii_downcase) == $ws
    and (.runs | length) == 2
    and (.runs[0].id | ascii_downcase) == $runA
    and (.runs[0].memberId | ascii_downcase) == $a
    and .runs[0].status == "ended"
    and .runs[0].endReason == "resumed"
    and (.runs[1].id | ascii_downcase) == $runB
    and (.runs[1].memberId | ascii_downcase) == $b
    and .runs[1].status == "running"
    and (.runs[1].resumedFromSessionId | ascii_downcase) == $runA
    and (([.runs[] | keys] | flatten | unique) -
      ["endReason","endedAtMs","exitCode","hostId","id","label","memberId",
       "resumedFromSessionId","startedAtMs","status","tool"]) == []
    ' >/dev/null || fail "execution history does not list A and B side by side ($actor)"
done

api "$B_TOKEN" GET "/v1/workspaces/$WS_ID/workstreams/$WORKSTREAM_ID"
expect_status 200 "workstream detail (B)"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .workstream.runCount == 2 and .workstream.activeRunCount == 1
  and .workstream.status == "active"
  ' >/dev/null || fail "workstream detail counters"

# ---------------------------------------------------------------------------
# 6. Attachment is a ledger property, not a handler property: a Run written
#    straight into the table still joins its thread's workstream, and a brand
#    new thread still gets one.
# ---------------------------------------------------------------------------
DIRECT_ROOT_ID="$(new_uuid)"
DIRECT_RUN_ID="$(new_uuid)"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
WITH bumped AS (
  UPDATE channel_seq SET last_seq = last_seq + 1
   WHERE workspace_id = '$WS_ID'::uuid AND channel_id = '$CHANNEL_ID'::uuid
  RETURNING last_seq AS seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count,
   author_member_id, type, props)
SELECT '$DIRECT_ROOT_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, b.seq,
       1::bigint, 0, '$A_ID'::uuid, 'system'::message_type,
       '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped b;
INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id,
   tool, label, status)
VALUES
  ('$DIRECT_RUN_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, '$A_ID'::uuid,
   '$HOST_A_ID'::uuid, '$DIRECT_ROOT_ID'::uuid, 'codex',
   'MOMO-671 ledger-level attachment', 'running');
COMMIT;
SQL
got="$(sql_value <<SQL
SELECT count(*) FROM work_session ws
  JOIN workstream w ON w.id = ws.workstream_id
 WHERE lower(ws.id::text) = lower('$DIRECT_RUN_ID')
   AND lower(w.root_message_id::text) = lower('$DIRECT_ROOT_ID')
   AND w.goal = 'MOMO-671 ledger-level attachment'
   AND lower(w.id::text) <> lower('$WORKSTREAM_ID');
SQL
)"
[ "$got" = "1" ] || fail "ledger-level implicit creation did not fire: $got"

got="$(sql_value <<SQL
SELECT count(*) FROM work_session WHERE workstream_id IS NULL;
SQL
)"
[ "$got" = "0" ] || fail "unattached Runs exist in the ledger: $got"

# ---------------------------------------------------------------------------
# 7. Tenant isolation and the ADR-0143 exposure boundary.
# ---------------------------------------------------------------------------
got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_TENANT_ID';
SELECT count(*) FROM workstream;
COMMIT;
SQL
)"
[ "$got" = "0" ] || fail "cross-tenant workstream RLS isolation: $got"

got="$(sql_value <<SQL
SELECT count(*) FROM pg_class
 WHERE relname = 'workstream' AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$got" = "1" ] || fail "workstream FORCE RLS metadata: $got"

got="$(sql_value <<SQL
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='workstream'
   AND column_name IN
     ('cwd','path','worktree','worktree_path','process_id','pid',
      'pty_id','attach_endpoint','provider_credential','provider_token');
SQL
)"
[ "$got" = "0" ] || fail "host-local or credential data entered the workstream table: $got"

got="$(sql_value <<SQL
SELECT count(*) FROM pg_trigger
 WHERE tgname = 'work_session_attach_workstream_trg' AND NOT tgisinternal;
SQL
)"
[ "$got" = "1" ] || fail "implicit-creation trigger is missing: $got"

echo "MOMO-671 workstream implicit creation + A/B takeover lineage + non-member 403/404 + FORCE RLS PASS"
