#!/usr/bin/env bash
# ADR-0124 증보 1 (W-B2-3) member-global notification rules runtime-db verifier.
#
# Mirrors verify_notification_mute.sh (same push-notifier isolated compose + mock
# relay). It proves the two new switches END TO END through the real REST and the
# real notifier drain:
#
#   * DND suppresses every reason, and outranks both a channel mute and a mention
#     exception on the same member (pause-everything means everything);
#   * mention_overrides_mute lets a mention through a channel the member muted in
#     018, while a member with no rule is unaffected (control);
#   * turning DND off resumes delivery immediately;
#   * GET reflects the stored rule, PUT writes an audit row, unknown fields 400,
#     and notification_rule is FORCE-RLS isolated by tenant.
#
# Docker project name carries the b2-3- prefix and is torn down with `down -v`.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[notif-rules] missing required command: $1" >&2
    exit 1
  }
}
for command_name in docker curl jq uuidgen; do need "$command_name"; done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
OVERLAY_FILE="$REPO_ROOT/infra/e2e/push-notifier.overlay.yml"
PROJECT="${NOTIF_RULES_PROJECT:-b2-3-notif-rules}"
API_PORT="${NOTIF_RULES_PORT:-20200}"
PG_PORT="${NOTIF_RULES_POSTGRES_PORT:-20201}"
CENT_PORT_HOST="${NOTIF_RULES_CENT_PORT:-20202}"
HERMES_PORT_HOST="${NOTIF_RULES_HERMES_PORT:-20203}"
RELAY_PORT_HOST="${NOTIF_RULES_RELAY_PORT:-20204}"
BOOT_TIMEOUT="${NOTIF_RULES_BOOT_TIMEOUT:-2400}"
WAIT_TIMEOUT="${NOTIF_RULES_WAIT_TIMEOUT:-120}"

RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-notif-rules-$RUN_ID"
mkdir -p "$TMP_DIR"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"

SENDER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
DND_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MENTION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
PEER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
SENDER_EMAIL="nr-sender-$RUN_ID@momo.local"
DND_EMAIL="nr-dnd-$RUN_ID@momo.local"
MENTION_EMAIL="nr-mention-$RUN_ID@momo.local"
PEER_EMAIL="nr-peer-$RUN_ID@momo.local"
SENDER_PASSWORD="nr-$(uuidgen | tr '[:upper:]' '[:lower:]')"
DND_PASSWORD="nr-$(uuidgen | tr '[:upper:]' '[:lower:]')"
MENTION_PASSWORD="nr-$(uuidgen | tr '[:upper:]' '[:lower:]')"
PEER_PASSWORD="nr-$(uuidgen | tr '[:upper:]' '[:lower:]')"
SENDER_HANDLE="nr-send-$RUN_EPOCH"
DND_HANDLE="nr-dnd-$RUN_EPOCH"
MENTION_HANDLE="nr-mention-$RUN_EPOCH"
PEER_HANDLE="nr-peer-$RUN_EPOCH"

DND_DEVICE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MENTION_DEVICE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
PEER_DEVICE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
hex64() { printf '%s%s' "$(uuidgen | tr -d '-')" "$(uuidgen | tr -d '-')" | tr '[:upper:]' '[:lower:]'; }
DND_TOKEN="$(hex64)"
MENTION_TOKEN="$(hex64)"
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
  if [ "${NOTIF_RULES_KEEP:-0}" = "1" ]; then
    echo "[notif-rules] leaving compose project '$PROJECT' up"
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

echo "[notif-rules] booting isolated api stack"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[notif-rules] api boot timed out" >&2
    exit 1
  fi
  sleep 3
done

echo "[notif-rules] starting notifier + mock relay"
compose up -d notifier
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until compose logs --no-log-prefix notifier 2>/dev/null | grep -q "push notifier starting"; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 notifier >&2 || true
    echo "[notif-rules] notifier boot timed out" >&2
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
      echo "[notif-rules] ok: $label"
      return 0
    fi
    if [ "$(date -u +%s)" -ge "$wait_deadline" ]; then
      echo "[notif-rules] FAIL $label: expected '$expected', got '$got'" >&2
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
    echo "[notif-rules] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  echo "[notif-rules] ok: $2"
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
dispatch_count_for() {
  # apns_status 200 dispatch rows for one (message, member)
  printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '%s' AND member_id = '%s' AND apns_status = 200;\n" "$1" "$2" | sql_scalar
}

echo "[notif-rules] installing four active channel-member fixtures"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$SENDER_ID', '$WORKSPACE_ID', 'human', 'active', 'NR Sender', '$SENDER_HANDLE'),
  ('$DND_ID', '$WORKSPACE_ID', 'human', 'active', 'NR Dnd', '$DND_HANDLE'),
  ('$MENTION_ID', '$WORKSPACE_ID', 'human', 'active', 'NR Mention', '$MENTION_HANDLE'),
  ('$PEER_ID', '$WORKSPACE_ID', 'human', 'active', 'NR Peer', '$PEER_HANDLE');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$SENDER_ID', '$WORKSPACE_ID', '$SENDER_EMAIL', true, momo_password_hash('$SENDER_PASSWORD'), 'UTC'),
  ('$DND_ID', '$WORKSPACE_ID', '$DND_EMAIL', true, momo_password_hash('$DND_PASSWORD'), 'UTC'),
  ('$MENTION_ID', '$WORKSPACE_ID', '$MENTION_EMAIL', true, momo_password_hash('$MENTION_PASSWORD'), 'UTC'),
  ('$PEER_ID', '$WORKSPACE_ID', '$PEER_EMAIL', true, momo_password_hash('$PEER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$SENDER_ID', 'member'),
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$DND_ID', 'member'),
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$MENTION_ID', 'member'),
  ('$WORKSPACE_ID', '$CHANNEL_ID', '$PEER_ID', 'member');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES
  ('$WORKSPACE_ID', '$SENDER_ID', 'member'),
  ('$WORKSPACE_ID', '$DND_ID', 'member'),
  ('$WORKSPACE_ID', '$MENTION_ID', 'member'),
  ('$WORKSPACE_ID', '$PEER_ID', 'member');
COMMIT;
SQL

SENDER_ACCESS="$(login "$SENDER_EMAIL" "$SENDER_PASSWORD")"
DND_ACCESS="$(login "$DND_EMAIL" "$DND_PASSWORD")"
MENTION_ACCESS="$(login "$MENTION_EMAIL" "$MENTION_PASSWORD")"
PEER_ACCESS="$(login "$PEER_EMAIL" "$PEER_PASSWORD")"
for access in "$SENDER_ACCESS" "$DND_ACCESS" "$MENTION_ACCESS" "$PEER_ACCESS"; do
  [ -n "$access" ] && [ "$access" != "null" ] || { echo "[notif-rules] login failed" >&2; exit 1; }
done

DEVICE_PATH="/v1/workspaces/$WORKSPACE_ID/devices"
api POST "$DEVICE_PATH" "$(jq -cn --arg d "$DND_DEVICE_ID" --arg t "$DND_TOKEN" --arg to "$TOPIC" '{deviceId:$d,platform:"ios",apnsToken:$t,env:"sandbox",topic:$to}')" "$DND_ACCESS"
expect_status 201 "dnd device registered"
api POST "$DEVICE_PATH" "$(jq -cn --arg d "$MENTION_DEVICE_ID" --arg t "$MENTION_TOKEN" --arg to "$TOPIC" '{deviceId:$d,platform:"ios",apnsToken:$t,env:"sandbox",topic:$to}')" "$MENTION_ACCESS"
expect_status 201 "mention device registered"
api POST "$DEVICE_PATH" "$(jq -cn --arg d "$PEER_DEVICE_ID" --arg t "$PEER_TOKEN" --arg to "$TOPIC" '{deviceId:$d,platform:"ios",apnsToken:$t,env:"sandbox",topic:$to}')" "$PEER_ACCESS"
expect_status 201 "peer device registered"

RULES_PATH="/v1/workspaces/$WORKSPACE_ID/notification-rules"
PREF_PATH="/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/notification-pref"

# A member who never wrote a rule reads both switches off (row absence default).
api GET "$RULES_PATH" "" "$PEER_ACCESS"
expect_status 200 "GET returns default rules for an untouched member"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.dnd')" = "false" ] && \
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.mentionOverridesMute')" = "false" ] || {
  echo "[notif-rules] default rules mismatch" >&2; echo "$RESPONSE_BODY" >&2; exit 1; }

# An unknown field is a 400, never silently swallowed (deny_unknown_fields).
api PUT "$RULES_PATH" '{"dnd":false,"mentionOverridesMute":false,"keyword":"x"}' "$PEER_ACCESS"
expect_status 400 "unknown rule field is rejected"

# DND member: mute the channel AND turn on both switches. DND must win over both.
api PUT "$PREF_PATH" '{"muted":true}' "$DND_ACCESS"
expect_status 200 "dnd member mutes the channel"
api PUT "$RULES_PATH" '{"dnd":true,"mentionOverridesMute":true}' "$DND_ACCESS"
expect_status 200 "dnd member turns on DND + mention exception"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.dnd')" = "true" ] || { echo "[notif-rules] dnd write mismatch" >&2; exit 1; }
api GET "$RULES_PATH" "" "$DND_ACCESS"
expect_status 200 "GET reflects the stored DND rule"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.dnd')" = "true" ] || { echo "[notif-rules] dnd read mismatch" >&2; exit 1; }

# Mention member: mute the channel and let mentions through it.
api PUT "$PREF_PATH" '{"muted":true}' "$MENTION_ACCESS"
expect_status 200 "mention member mutes the channel"
api PUT "$RULES_PATH" '{"dnd":false,"mentionOverridesMute":true}' "$MENTION_ACCESS"
expect_status 200 "mention member turns on the mention exception"

# One message mentioning all three. Expected: DND=0 (DND outranks mute+exception),
# MENTION=1 (mention pierces mute), PEER=1 (no rule).
MSG="$(send_message "review @$DND_HANDLE @$MENTION_HANDLE @$PEER_HANDLE" "$SENDER_ACCESS")"
wait_sql_eq "1" "peer (no rule) receives the mention" <<SQL
SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG' AND member_id = '$PEER_ID' AND apns_status = 200;
SQL
wait_sql_eq "1" "mention exception pierces the channel mute" <<SQL
SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG' AND member_id = '$MENTION_ID' AND apns_status = 200;
SQL
[ "$(printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG' AND member_id = '$DND_ID';\n" | sql_scalar)" = "0" ] || {
  echo "[notif-rules] DND leaked a dispatch (should outrank mute+exception)" >&2; exit 1; }
echo "[notif-rules] ok: DND suppresses with no dispatch-log row while others notify"

# Turn DND off (keep the mention exception): delivery resumes on the next mention.
api PUT "$RULES_PATH" '{"dnd":false,"mentionOverridesMute":true}' "$DND_ACCESS"
expect_status 200 "dnd member turns DND off"
MSG_AFTER="$(send_message "again @$DND_HANDLE" "$SENDER_ACCESS")"
wait_sql_eq "1" "dispatch resumes immediately after DND off" <<SQL
SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_AFTER' AND member_id = '$DND_ID' AND apns_status = 200;
SQL

# The two PUTs by the DND member (on, then off) each wrote one audit row.
got="$(printf "SELECT count(*) FROM audit_log WHERE action = 'notification_rule.updated' AND actor_member_id = '$DND_ID';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[notif-rules] expected 2 DND audit rows, got $got" >&2; exit 1; }
echo "[notif-rules] ok: each rule write is a same-tx audit row"

# FORCE RLS: notification_rule is invisible without app.workspace_id, and scoped
# to exactly the tenant's rows with it.
run_sql <<SQL
SET ROLE momo_app;
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM notification_rule;
  IF got <> 0 THEN RAISE EXCEPTION 'notification_rule leaked without app.workspace_id: %', got; END IF;
END \$\$;
BEGIN;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM notification_rule;
  IF got < 2 THEN RAISE EXCEPTION 'notification_rule tenant rows unavailable: %', got; END IF;
END \$\$;
ROLLBACK;
RESET ROLE;
SQL
echo "[notif-rules] ok: notification_rule FORCE RLS isolates tenant rows"

echo
echo "ADR-0124 증보 1 notification rules verification PASS"
echo "- verified: default GET; unknown-field 400; DND outranks mute+mention exception; mention exception pierces mute; control member unaffected; DND-off resumes; same-tx audit; FORCE RLS"
