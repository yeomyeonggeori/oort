#!/usr/bin/env bash
# MOMO-483 / ADR-0114 work-session ledger, card/thread, and realtime gate.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[work-session] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORK_SESSION_GATE_PROJECT:-momo483worksession}"
API_PORT="${WORK_SESSION_GATE_API_PORT:-27910}"
CENT_PORT_HOST="${WORK_SESSION_GATE_CENTRIFUGO_PORT:-27911}"
PG_PORT="${WORK_SESSION_GATE_POSTGRES_PORT:-27912}"
HERMES_PORT_HOST="${WORK_SESSION_GATE_HERMES_PORT:-27913}"
BOOT_TIMEOUT="${WORK_SESSION_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${WORK_SESSION_GATE_ASSERT_TIMEOUT:-240}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-session.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_TENANT_ID="48300000-0000-7000-8000-000000000099"
CENT_CHANNEL="ch:ws${WS_ID}.${CHANNEL_ID}"
CENT_API_KEY="${CENT_API_KEY:-change-me-cent-api-key}"
OWNER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
HOST_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OWNER_EMAIL="work-session-owner-$RUN_ID@momo.local"
OTHER_EMAIL="work-session-other-$RUN_ID@momo.local"
OWNER_PASSWORD="owner-$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_PASSWORD="other-$(uuidgen | tr '[:upper:]' '[:lower:]')"
LABEL="MOMO-483 interactive work console"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORK_SESSION_GATE_KEEP:-0}" = "1" ]; then
    echo "[work-session] leaving compose project '$PROJECT' up"
    echo "[work-session] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-work-session.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[work-session] refusing to remove unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
CENT_API_URL="http://127.0.0.1:$CENT_PORT_HOST/api"

echo "[work-session] booting isolated api/relay stack '$PROJECT'"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[work-session] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[work-session] api exited" >&2
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
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Work Session Owner', 'wso-$RUN_ID'),
  ('$OTHER_ID', '$WS_ID', 'human', 'active', 'Work Session Other', 'wsx-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$OTHER_ID', '$WS_ID', '$OTHER_EMAIL', true, momo_password_hash('$OTHER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'member'),
  ('$WS_ID', '$CHANNEL_ID', '$OTHER_ID', 'member');
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
    echo "[work-session] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

WORK_SESSION_PATH="/v1/workspaces/$WS_ID/work-sessions"
api "$OWNER_TOKEN" POST "$WORK_SESSION_PATH" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$HOST_ID" --arg label "$LABEL" \
    '{channelId:$channel,hostId:$host,tool:"codex",label:$label}')"
expect_status 201 "session create"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg workspace "$WS_ID" --arg channel "$CHANNEL_ID" --arg owner "$OWNER_ID" \
  --arg host "$HOST_ID" --arg label "$LABEL" '
  .workSession as $s
  | ($s.workspaceId | ascii_downcase) == $workspace
    and ($s.channelId | ascii_downcase) == $channel
    and ($s.memberId | ascii_downcase) == $owner
    and ($s.hostId | ascii_downcase) == $host
    and $s.tool == "codex"
    and $s.label == $label
    and $s.status == "running"
    and $s.startedAtMs > 0
    and $s.endedAtMs == null
    and $s.exitCode == null
  ' >/dev/null
SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
ROOT_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.rootMessageId | ascii_downcase')"
STARTED_AT_MS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.startedAtMs')"
CARD_SEQ="$(sql_value <<SQL
SELECT seq FROM message WHERE id='$ROOT_MESSAGE_ID';
SQL
)"

api "$OWNER_TOKEN" GET "$WORK_SESSION_PATH?active=1"
expect_status 200 "owner active list"
printf '%s' "$RESPONSE_BODY" | jq -e --arg session "$SESSION_ID" \
  '[.workSessions[] | select((.id | ascii_downcase) == $session and .status == "running")] | length == 1' \
  >/dev/null
api "$OTHER_TOKEN" GET "$WORK_SESSION_PATH?active=1"
expect_status 200 "channel member active list"
printf '%s' "$RESPONSE_BODY" | jq -e --arg session "$SESSION_ID" \
  '[.workSessions[] | select((.id | ascii_downcase) == $session)] | length == 1' >/dev/null

HISTORY_PATH="/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages?after=0&limit=200"
api "$OWNER_TOKEN" GET "$HISTORY_PATH"
expect_status 200 "running card history"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg root "$ROOT_MESSAGE_ID" --arg session "$SESSION_ID" --arg label "$LABEL" \
  --argjson seq "$CARD_SEQ" '
  [.messages[]
   | select((.id | ascii_downcase) == $root)
   | select(.seq == $seq and .type == "system" and .body == null)
   | select((.props.session_id | ascii_downcase) == $session)
   | select(.props.kind == "work_session" and .props.tool == "codex")
   | select(.props.label == $label and .props.status == "running")
   | select((.props | keys) == ["kind","label","session_id","status","tool"])]
  | length == 1
  ' >/dev/null

got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='work.session.started'
   AND payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID'
   AND jsonb_object_length(payload)=3
   AND NOT (payload ? 'version')
   AND jsonb_object_length(payload->'data')=5
   AND payload->'data'->>'v'='1'
   AND (payload->'data'->>'seq')::bigint=$CARD_SEQ
   AND (payload->'data'->>'ts')::bigint=$STARTED_AT_MS
   AND jsonb_object_length(payload->'data'->'payload')=8
   AND payload->'data'->'payload'->>'channel_id' ILIKE '$CHANNEL_ID'
   AND payload->'data'->'payload'->>'root_message_id' ILIKE '$ROOT_MESSAGE_ID'
   AND payload->'data'->'payload'->>'member_id' ILIKE '$OWNER_ID'
   AND payload->'data'->'payload'->>'host_id' ILIKE '$HOST_ID'
   AND payload->'data'->'payload'->>'tool'='codex'
   AND payload->'data'->'payload'->>'label'='$LABEL'
   AND (payload->'data'->'payload'->>'started_at')::bigint=$STARTED_AT_MS
   AND lower(payload->>'idempotency_key') =
       lower('$CENT_CHANNEL:work.session.started:$SESSION_ID');
SQL
)"
[ "$got" = "1" ] || {
  echo "[work-session] FAIL started outbox exact payload/no-version/idempotency: $got" >&2
  exit 1
}

wait_for_lifecycle() {
  local kind="$1" time_key="$2" expected_time="$3" expected_exit="${4:-null}"
  local delivered=0 history matches
  deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    history="$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
      -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg ch "$CENT_CHANNEL" '{channel:$ch,limit:100,reverse:true}')" \
      "$CENT_API_URL/history" 2>/dev/null || printf '{}')"
    matches="$(printf '%s' "$history" | jq -r \
      --arg kind "$kind" --arg session "$SESSION_ID" --arg channel "$CHANNEL_ID" \
      --arg root "$ROOT_MESSAGE_ID" --arg owner "$OWNER_ID" --arg host "$HOST_ID" \
      --arg label "$LABEL" --arg timeKey "$time_key" --argjson at "$expected_time" \
      --argjson seq "$CARD_SEQ" --argjson exit "$expected_exit" '
      [.result.publications[]?.data
       | select(.type == $kind and .seq == $seq)
       | select((.payload.session_id | ascii_downcase) == $session)
       | select((.payload.channel_id | ascii_downcase) == $channel)
       | select((.payload.root_message_id | ascii_downcase) == $root)
       | select((.payload.member_id | ascii_downcase) == $owner)
       | select((.payload.host_id | ascii_downcase) == $host)
       | select(.payload.tool == "codex" and .payload.label == $label)
       | select(.payload[$timeKey] == $at)
       | select(if $kind == "work.session.ended"
                then .payload.exit_code == $exit
                else (.payload | has("exit_code") | not)
                end)] | length
      ' 2>/dev/null || printf '0')"
    if [ "$matches" != "0" ]; then
      delivered=1
      break
    fi
    sleep 1
  done
  [ "$delivered" = "1" ] || {
    compose logs --tail 120 relay >&2 || true
    echo "[work-session] FAIL $kind was not delivered to Centrifugo history" >&2
    exit 1
  }
}

# message.new establishes the channel version first; the same-seq lifecycle
# projection must still be visible because its publish request has no version.
wait_for_lifecycle "work.session.started" "started_at" "$STARTED_AT_MS"

REPLY_CLIENT_ID="$(uuidgen)"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" \
  "$(jq -cn --arg client "$REPLY_CLIENT_ID" --arg root "$ROOT_MESSAGE_ID" \
    '{clientMsgId:$client,body:"MOMO-483 collaboration reply",rootId:$root}')"
expect_status 201 "card thread reply"
REPLY_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id | ascii_downcase')"
REPLY_SEQ="$(printf '%s' "$RESPONSE_BODY" | jq -er '.seq')"
printf '%s' "$RESPONSE_BODY" | jq -e --arg root "$ROOT_MESSAGE_ID" \
  '(.rootId | ascii_downcase) == $root' >/dev/null
api "$OWNER_TOKEN" GET "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages/$ROOT_MESSAGE_ID/replies?limit=50"
expect_status 200 "card thread reply history"
printf '%s' "$RESPONSE_BODY" | jq -e --arg reply "$REPLY_ID" --arg root "$ROOT_MESSAGE_ID" '
  [.messages[]
   | select((.id | ascii_downcase) == $reply)
   | select((.rootId | ascii_downcase) == $root)
   | select(.body == "MOMO-483 collaboration reply")] | length == 1
  ' >/dev/null

HEAD_BEFORE_END="$(sql_value <<SQL
SELECT last_seq FROM channel_seq WHERE channel_id='$CHANNEL_ID';
SQL
)"
[ "$HEAD_BEFORE_END" = "$REPLY_SEQ" ] || {
  echo "[work-session] FAIL unexpected channel head before end: $HEAD_BEFORE_END" >&2
  exit 1
}

api "$OTHER_TOKEN" PATCH "$WORK_SESSION_PATH/$SESSION_ID" '{"status":"ended","exitCode":9}'
expect_status 403 "non-owner end"

api "$OWNER_TOKEN" PATCH "$WORK_SESSION_PATH/$SESSION_ID" '{"status":"ended","exitCode":0}'
expect_status 200 "owner end"
printf '%s' "$RESPONSE_BODY" | jq -e --arg session "$SESSION_ID" --arg root "$ROOT_MESSAGE_ID" '
  (.workSession.id | ascii_downcase) == $session
  and (.workSession.rootMessageId | ascii_downcase) == $root
  and .workSession.status == "ended"
  and .workSession.endedAtMs > 0
  and .workSession.exitCode == 0
  ' >/dev/null
ENDED_AT_MS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.endedAtMs')"

got="$(sql_value <<SQL
SELECT cs.last_seq || ':' || m.seq || ':' || m.state::text || ':' ||
       (m.edited_at IS NULL)::int || ':' || (m.body IS NULL)::int
  FROM channel_seq cs
  JOIN message m ON m.channel_id=cs.channel_id
 WHERE cs.channel_id='$CHANNEL_ID' AND m.id='$ROOT_MESSAGE_ID';
SQL
)"
[ "$got" = "$HEAD_BEFORE_END:$CARD_SEQ:sent:1:1" ] || {
  echo "[work-session] FAIL end changed message/channel seq or edited card body/state: $got" >&2
  exit 1
}

api "$OWNER_TOKEN" GET "$HISTORY_PATH"
expect_status 200 "ended card history"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg root "$ROOT_MESSAGE_ID" --arg session "$SESSION_ID" --arg label "$LABEL" \
  --argjson seq "$CARD_SEQ" --argjson ended "$ENDED_AT_MS" '
  [.messages[]
   | select((.id | ascii_downcase) == $root and .seq == $seq)
   | select(.type == "system" and .body == null and .state == "sent")
   | select((.props.session_id | ascii_downcase) == $session)
   | select(.props.kind == "work_session" and .props.tool == "codex")
   | select(.props.label == $label and .props.status == "ended")
   | select(.props.ended_at == $ended and .props.exit_code == 0)
   | select((.props | keys) ==
       ["ended_at","exit_code","kind","label","session_id","status","tool"])]
  | length == 1
  ' >/dev/null

got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='work.session.ended'
   AND payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID'
   AND jsonb_object_length(payload)=3
   AND NOT (payload ? 'version')
   AND jsonb_object_length(payload->'data')=5
   AND payload->'data'->>'v'='1'
   AND (payload->'data'->>'seq')::bigint=$CARD_SEQ
   AND (payload->'data'->>'ts')::bigint=$ENDED_AT_MS
   AND jsonb_object_length(payload->'data'->'payload')=9
   AND payload->'data'->'payload'->>'channel_id' ILIKE '$CHANNEL_ID'
   AND payload->'data'->'payload'->>'root_message_id' ILIKE '$ROOT_MESSAGE_ID'
   AND payload->'data'->'payload'->>'member_id' ILIKE '$OWNER_ID'
   AND payload->'data'->'payload'->>'host_id' ILIKE '$HOST_ID'
   AND payload->'data'->'payload'->>'tool'='codex'
   AND payload->'data'->'payload'->>'label'='$LABEL'
   AND (payload->'data'->'payload'->>'ended_at')::bigint=$ENDED_AT_MS
   AND (payload->'data'->'payload'->>'exit_code')::int=0
   AND lower(payload->>'idempotency_key') =
       lower('$CENT_CHANNEL:work.session.ended:$SESSION_ID');
SQL
)"
[ "$got" = "1" ] || {
  echo "[work-session] FAIL ended outbox exact payload/no-version/idempotency: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT count(DISTINCT payload->>'idempotency_key') FROM outbox
 WHERE payload->'data'->>'type' IN ('work.session.started','work.session.ended')
   AND payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID';
SQL
)"
[ "$got" = "2" ] || {
  echo "[work-session] FAIL lifecycle idempotency keys are not unique: $got" >&2
  exit 1
}
wait_for_lifecycle "work.session.ended" "ended_at" "$ENDED_AT_MS" 0

api "$OWNER_TOKEN" GET "$WORK_SESSION_PATH?active=1"
expect_status 200 "ended session excluded from active list"
printf '%s' "$RESPONSE_BODY" | jq -e --arg session "$SESSION_ID" \
  '[.workSessions[] | select((.id | ascii_downcase) == $session)] | length == 0' >/dev/null

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_TENANT_ID';
SELECT (SELECT count(*) FROM work_session WHERE id='$SESSION_ID') || ':' ||
       (SELECT count(*) FROM message WHERE id='$ROOT_MESSAGE_ID') || ':' ||
       (SELECT count(*) FROM outbox
         WHERE payload->'data'->'payload'->>'session_id' ILIKE '$SESSION_ID');
COMMIT;
SQL
)"
[ "$got" = "0:0:0" ] || {
  echo "[work-session] FAIL cross-tenant RLS isolation: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT count(*) FROM pg_class
 WHERE relname IN ('work_session','message','outbox')
   AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$got" = "3" ] || {
  echo "[work-session] FAIL FORCE RLS metadata: $got" >&2
  exit 1
}
got="$(sql_value <<SQL
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='work_session'
   AND column_name IN
     ('cwd','path','worktree','worktree_path','process_id','pid',
      'provider_credential','provider_token');
SQL
)"
[ "$got" = "0" ] || {
  echo "[work-session] FAIL host-local cwd/path/process/provider data entered schema: $got" >&2
  exit 1
}

echo "MOMO-483 work-session ledger + card/thread + no-version realtime + RLS PASS"
