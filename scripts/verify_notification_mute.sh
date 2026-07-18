#!/usr/bin/env bash
# MOMO-477 / ADR-0124 channel notification mute runtime-db verifier.
#
# Uses the push-notifier isolated compose + mock relay pattern. It proves the
# REST preference, channel-list projection, judgment-time suppression (with
# mentions), immediate unmute, member-pair isolation, log cleanliness, audit,
# and FORCE RLS without touching unread/read-state.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[notification-mute] missing required command: $1" >&2
    exit 1
  }
}
for command_name in docker curl jq uuidgen; do need "$command_name"; done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
OVERLAY_FILE="$REPO_ROOT/infra/e2e/push-notifier.overlay.yml"
PROJECT="${NOTIFICATION_MUTE_PROJECT:-momo477mute}"
API_PORT="${NOTIFICATION_MUTE_PORT:-20100}"
PG_PORT="${NOTIFICATION_MUTE_POSTGRES_PORT:-20101}"
CENT_PORT_HOST="${NOTIFICATION_MUTE_CENT_PORT:-20102}"
HERMES_PORT_HOST="${NOTIFICATION_MUTE_HERMES_PORT:-20103}"
RELAY_PORT_HOST="${NOTIFICATION_MUTE_RELAY_PORT:-20104}"
BOOT_TIMEOUT="${NOTIFICATION_MUTE_BOOT_TIMEOUT:-2400}"
WAIT_TIMEOUT="${NOTIFICATION_MUTE_WAIT_TIMEOUT:-120}"

RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-notification-mute-$RUN_ID"
mkdir -p "$TMP_DIR"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"

SENDER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MUTED_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
PEER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
SENDER_EMAIL="mute-sender-$RUN_ID@momo.local"
MUTED_EMAIL="mute-target-$RUN_ID@momo.local"
PEER_EMAIL="mute-peer-$RUN_ID@momo.local"
SENDER_PASSWORD="mute-$(uuidgen | tr '[:upper:]' '[:lower:]')"
MUTED_PASSWORD="mute-$(uuidgen | tr '[:upper:]' '[:lower:]')"
PEER_PASSWORD="mute-$(uuidgen | tr '[:upper:]' '[:lower:]')"
SENDER_HANDLE="mute-send-$RUN_EPOCH"
MUTED_HANDLE="mute-target-$RUN_EPOCH"
PEER_HANDLE="mute-peer-$RUN_EPOCH"

MUTED_DEVICE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
PEER_DEVICE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
hex64() { printf '%s%s' "$(uuidgen | tr -d '-')" "$(uuidgen | tr -d '-')" | tr '[:upper:]' '[:lower:]'; }
MUTED_TOKEN="$(hex64)"
PEER_TOKEN="$(hex64)"
TOPIC="kim.dawn.momo.e2e"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
  HERMES_PORT="$HERMES_PORT_HOST" PUSH_RELAY_PORT="$RELAY_PORT_HOST" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" --profile push "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${NOTIFICATION_MUTE_KEEP:-0}" = "1" ]; then
    echo "[notification-mute] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
PUSH_RELAY_URL="http://127.0.0.1:$RELAY_PORT_HOST"

echo "[notification-mute] booting isolated api stack"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[notification-mute] api boot timed out" >&2
    exit 1
  fi
  sleep 3
done

echo "[notification-mute] starting notifier + mock relay"
compose up -d notifier
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until compose logs --no-log-prefix notifier 2>/dev/null | grep -q "push notifier starting"; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 notifier >&2 || true
    echo "[notification-mute] notifier boot timed out" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

wait_sql_eq() {
  local expected="$1" label="$2" query got
  query="$(cat)"
  local wait_deadline=$(( $(date -u +%s) + WAIT_TIMEOUT ))
  while :; do
    got="$(printf '%s\n' "$query" | sql_scalar)"
    if [ "$got" = "$expected" ]; then
      echo "[notification-mute] ok: $label"
      return 0
    fi
    if [ "$(date -u +%s)" -ge "$wait_deadline" ]; then
      echo "[notification-mute] FAIL $label: expected '$expected', got '$got'" >&2
      compose logs --tail 80 notifier >&2 || true
      exit 1
    fi
    sleep 1
  done
}

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  if [ "$RESPONSE_STATUS" != "$1" ]; then
    echo "[notification-mute] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  echo "[notification-mute] ok: $2"
}
login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$1" --arg p "$2" '{email:$e,password:$p}')" | jq -r '.accessToken'
}
send_message() {
  local body="$1" token="$2" out="$TMP_DIR/send.json"
  curl -fsS -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token" \
    -d "$(jq -cn --arg c "$(uuidgen)" --arg b "$body" '{clientMsgId:$c,body:$b}')" >"$out"
  jq -r '.id | ascii_downcase' "$out"
}
relay_count_for() {
  curl -fsS "$PUSH_RELAY_URL/received" | jq -r --arg m "$1" '[.received[] | select(.message_id == $m)] | length'
}

echo "[notification-mute] installing three active channel-member fixtures"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$SENDER_ID', '$WORKSPACE_ID', 'human', 'active', 'Mute Sender', '$SENDER_HANDLE'),
  ('$MUTED_ID', '$WORKSPACE_ID', 'human', 'active', 'Mute Target', '$MUTED_HANDLE'),
  ('$PEER_ID', '$WORKSPACE_ID', 'human', 'active', 'Mute Peer', '$PEER_HANDLE');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$SENDER_ID', '$WORKSPACE_ID', '$SENDER_EMAIL', true, momo_password_hash('$SENDER_PASSWORD'), 'UTC'),
  ('$MUTED_ID', '$WORKSPACE_ID', '$MUTED_EMAIL', true, momo_password_hash('$MUTED_PASSWORD'), 'UTC'),
  ('$PEER_ID', '$WORKSPACE_ID', '$PEER_EMAIL', true, momo_password_hash('$PEER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$SENDER_ID', 'member'),
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$MUTED_ID', 'member'),
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$PEER_ID', 'member');
COMMIT;
SQL

SENDER_ACCESS="$(login "$SENDER_EMAIL" "$SENDER_PASSWORD")"
MUTED_ACCESS="$(login "$MUTED_EMAIL" "$MUTED_PASSWORD")"
PEER_ACCESS="$(login "$PEER_EMAIL" "$PEER_PASSWORD")"
for access in "$SENDER_ACCESS" "$MUTED_ACCESS" "$PEER_ACCESS"; do
  [ -n "$access" ] && [ "$access" != "null" ] || { echo "[notification-mute] login failed" >&2; exit 1; }
done

DEVICE_PATH="/v1/workspaces/$WORKSPACE_ID/devices"
api POST "$DEVICE_PATH" "$(jq -cn --arg d "$MUTED_DEVICE_ID" --arg t "$MUTED_TOKEN" --arg to "$TOPIC" '{deviceId:$d,platform:"ios",apnsToken:$t,env:"sandbox",topic:$to}')" "$MUTED_ACCESS"
expect_status 201 "mute target device registered"
api POST "$DEVICE_PATH" "$(jq -cn --arg d "$PEER_DEVICE_ID" --arg t "$PEER_TOKEN" --arg to "$TOPIC" '{deviceId:$d,platform:"ios",apnsToken:$t,env:"sandbox",topic:$to}')" "$PEER_ACCESS"
expect_status 201 "peer device registered"

PREF_PATH="/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/notification-pref"

MSG_BEFORE="$(send_message "before @$MUTED_HANDLE" "$SENDER_ACCESS")"
wait_sql_eq "1" "dispatch occurs before mute" <<SQL
SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_BEFORE' AND member_id = '$MUTED_ID' AND apns_status = 200;
SQL
[ "$(relay_count_for "$MSG_BEFORE")" = "1" ] || { echo "[notification-mute] pre-mute relay dispatch missing" >&2; exit 1; }

api PUT "$PREF_PATH" '{"muted":true}' "$MUTED_ACCESS"
expect_status 200 "active channel member mutes"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.muted')" = "true" ] || { echo "[notification-mute] mute response mismatch" >&2; exit 1; }
api GET "/v1/workspaces/$WORKSPACE_ID/channels" "" "$MUTED_ACCESS"
expect_status 200 "channel list reflects mute"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r --arg c "$CHANNEL_ID" '.channels[] | select((.id | ascii_downcase) == $c) | .muted')" = "true" ] || { echo "[notification-mute] channel muted projection mismatch" >&2; exit 1; }

MSG_MUTED="$(send_message "muted mention @$MUTED_HANDLE" "$SENDER_ACCESS")"
wait_sql_eq "done" "muted mention candidate judged" <<SQL
SELECT status::text FROM outbox WHERE kind = 'push_candidate' AND lower(payload->>'message_id') = '$MSG_MUTED';
SQL
[ "$(printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_MUTED';\n" | sql_scalar)" = "0" ] || { echo "[notification-mute] suppressed dispatch polluted push_dispatch_log" >&2; exit 1; }
[ "$(relay_count_for "$MSG_MUTED")" = "0" ] || { echo "[notification-mute] muted mention reached relay" >&2; exit 1; }
echo "[notification-mute] ok: mute suppresses mention with no dispatch log row"

MSG_PAIR="$(send_message "pair @$MUTED_HANDLE @$PEER_HANDLE" "$SENDER_ACCESS")"
wait_sql_eq "1" "unmuted peer still receives while pair is muted" <<SQL
SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_PAIR' AND member_id = '$PEER_ID' AND apns_status = 200;
SQL
[ "$(printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_PAIR' AND member_id = '$MUTED_ID';\n" | sql_scalar)" = "0" ] || { echo "[notification-mute] pair isolation failed for muted member" >&2; exit 1; }
[ "$(relay_count_for "$MSG_PAIR")" = "1" ] || { echo "[notification-mute] pair isolation relay count mismatch" >&2; exit 1; }

api PUT "$PREF_PATH" '{"muted":false}' "$MUTED_ACCESS"
expect_status 200 "channel member unmutes"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.muted')" = "false" ] || { echo "[notification-mute] unmute response mismatch" >&2; exit 1; }
MSG_AFTER="$(send_message "after @$MUTED_HANDLE" "$SENDER_ACCESS")"
wait_sql_eq "1" "dispatch resumes immediately after unmute" <<SQL
SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_AFTER' AND member_id = '$MUTED_ID' AND apns_status = 200;
SQL

api PUT "$PREF_PATH" '{"muted":true}' "$SENDER_ACCESS"
expect_status 200 "second member preference is independent"
got="$(printf "SELECT count(*) FROM notification_pref WHERE workspace_id = '$WORKSPACE_ID' AND channel_id = '$CHANNEL_ID';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[notification-mute] expected exactly sender pref row after target unmute, got $got" >&2; exit 1; }

got="$(printf "SELECT count(*) FROM audit_log WHERE action = 'notification_pref.updated' AND actor_member_id = '$MUTED_ID' AND target_id = '$CHANNEL_ID';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[notification-mute] expected mute+unmute audit rows, got $got" >&2; exit 1; }

run_sql <<SQL
SET ROLE momo_app;
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM notification_pref;
  IF got <> 0 THEN RAISE EXCEPTION 'notification_pref leaked without app.workspace_id: %', got; END IF;
END \$\$;
BEGIN;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM notification_pref;
  IF got <> 1 THEN RAISE EXCEPTION 'notification_pref tenant row unavailable: %', got; END IF;
END \$\$;
ROLLBACK;
RESET ROLE;
SQL
echo "[notification-mute] ok: notification_pref FORCE RLS isolates tenant rows"

echo
echo "MOMO-477 notification mute verification PASS"
echo "- verified: pre-mute dispatch; REST mute/list projection; mention suppression; pair isolation; no suppressed dispatch_log row; immediate unmute; same-tx audit; FORCE RLS"
