#!/usr/bin/env bash
# MOMO-478 message edit/delete/reaction + realtime runtime-db verifier.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[interaction] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${INTERACTION_GATE_PROJECT:-momo478interaction}"
API_PORT="${INTERACTION_GATE_PORT:-19880}"
PG_PORT="${INTERACTION_GATE_POSTGRES_PORT:-19881}"
CENT_PORT_HOST="${INTERACTION_GATE_CENT_PORT:-19882}"
HERMES_PORT_HOST="${INTERACTION_GATE_HERMES_PORT:-19883}"
BOOT_TIMEOUT="${INTERACTION_GATE_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-interaction-$RUN_ID"
mkdir -p "$TMP_DIR"

WS_A="00000000-0000-7000-8000-000000000001"
CH_A="00000000-0000-7000-8000-000000000201"
AUTHOR_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OUTSIDER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
AUTHOR_EMAIL="interaction-author-$RUN_ID@momo.local"
OTHER_EMAIL="interaction-other-$RUN_ID@momo.local"
OUTSIDER_EMAIL="interaction-outsider-$RUN_ID@momo.local"
AUTHOR_PASSWORD="author-$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_PASSWORD="other-$(uuidgen | tr '[:upper:]' '[:lower:]')"
OUTSIDER_PASSWORD="outsider-$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${INTERACTION_GATE_KEEP:-0}" = "1" ]; then
    echo "[interaction] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[interaction] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[interaction] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[interaction] api exited" >&2
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
VALUES
  ('$AUTHOR_ID', '$WS_A', 'human', 'active', 'Interaction Author', 'ia-$RUN_ID'),
  ('$OTHER_ID', '$WS_A', 'human', 'active', 'Interaction Other', 'io-$RUN_ID'),
  ('$OUTSIDER_ID', '$WS_A', 'human', 'active', 'Interaction Outsider', 'ix-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$AUTHOR_ID', '$WS_A', '$AUTHOR_EMAIL', true, momo_password_hash('$AUTHOR_PASSWORD'), 'UTC'),
  ('$OTHER_ID', '$WS_A', '$OTHER_EMAIL', true, momo_password_hash('$OTHER_PASSWORD'), 'UTC'),
  ('$OUTSIDER_ID', '$WS_A', '$OUTSIDER_EMAIL', true, momo_password_hash('$OUTSIDER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_A', '$CH_A', '$AUTHOR_ID', 'member'),
  ('$WS_A', '$CH_A', '$OTHER_ID', 'member');
COMMIT;
SQL

login() {
  local email="$1" password="$2"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$password" --arg w "$WS_A" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
AUTHOR_TOKEN="$(login "$AUTHOR_EMAIL" "$AUTHOR_PASSWORD")"
OTHER_TOKEN="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")"
OUTSIDER_TOKEN="$(login "$OUTSIDER_EMAIL" "$OUTSIDER_PASSWORD")"

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}" out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[interaction] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}
send_message() {
  local body="$1"
  api "$AUTHOR_TOKEN" POST "/v1/workspaces/$WS_A/channels/$CH_A/messages" \
    "$(jq -cn --arg c "$(uuidgen)" --arg b "$body" '{clientMsgId:$c,body:$b}')"
  expect_status 201 "message fixture send"
}

send_message "private original body"
MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"
MESSAGE_SEQ="$(printf '%s' "$RESPONSE_BODY" | jq -er '.seq')"
MESSAGE_PATH="/v1/workspaces/$WS_A/messages/$MESSAGE_ID"
REACTION_PATH="$MESSAGE_PATH/reactions/%F0%9F%91%8D"

api "$AUTHOR_TOKEN" PATCH "$MESSAGE_PATH" '{"body":"   "}'
expect_status 400 "empty edit rejection"
api "$OTHER_TOKEN" PATCH "$MESSAGE_PATH" '{"body":"other edit"}'
expect_status 403 "non-author edit"
api "$AUTHOR_TOKEN" PATCH "$MESSAGE_PATH" '{"body":"edited private body"}'
expect_status 200 "author edit"
printf '%s' "$RESPONSE_BODY" | jq -e --argjson seq "$MESSAGE_SEQ" \
  '.body == "edited private body" and .state == "edited" and .seq == $seq and (.editedAtMs > 0)' >/dev/null

api "$AUTHOR_TOKEN" PUT "$REACTION_PATH"
expect_status 200 "reaction add"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.action == "added" and .emoji == "👍"' >/dev/null
api "$AUTHOR_TOKEN" PUT "$REACTION_PATH"
expect_status 200 "reaction add idempotent retry"
got="$(sql_value <<SQL
SELECT count(*) FROM reaction
 WHERE message_id='$MESSAGE_ID' AND member_id='$AUTHOR_ID' AND emoji='👍';
SQL
)"
[ "$got" = "1" ] || { echo "[interaction] FAIL duplicate reaction rows: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='reaction.added'
   AND payload->'data'->'payload'->>'message_id' ILIKE '$MESSAGE_ID'
   AND payload->'data'->'payload'->>'member_id' ILIKE '$AUTHOR_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[interaction] FAIL duplicate reaction outbox: $got" >&2; exit 1; }

api "$OTHER_TOKEN" PUT "$REACTION_PATH"
expect_status 200 "second member reaction"
api "$OUTSIDER_TOKEN" PUT "$REACTION_PATH"
expect_status 403 "non-member reaction"
api "$AUTHOR_TOKEN" PUT "$MESSAGE_PATH/reactions/123456789012345678901234567890123"
expect_status 400 "emoji length bound"

api "$AUTHOR_TOKEN" GET "/v1/workspaces/$WS_A/channels/$CH_A/reactions"
expect_status 200 "reaction snapshot"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg message "$MESSAGE_ID" --arg author "$AUTHOR_ID" --arg other "$OTHER_ID" '
  [to_entries[] | select((.key | ascii_downcase) == $message) | .value["👍"][] | ascii_downcase]
    | sort == ([$author, $other] | sort)' >/dev/null

# The message row lock in PUT serializes this count check with competing adds.
send_message "reaction cap fixture"
CAP_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id' | tr '[:upper:]' '[:lower:]')"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO reaction (workspace_id, message_id, member_id, emoji)
SELECT '$WS_A', '$CAP_MESSAGE_ID', '$AUTHOR_ID', 'cap-' || value
  FROM generate_series(1, 200) value;
COMMIT;
SQL
api "$AUTHOR_TOKEN" PUT "/v1/workspaces/$WS_A/messages/$CAP_MESSAGE_ID/reactions/overflow"
expect_status 409 "reaction row cap"
HEAD_SEQ="$(sql_value <<SQL
SELECT last_seq FROM channel_seq WHERE channel_id='$CH_A';
SQL
)"

api "$AUTHOR_TOKEN" DELETE "$REACTION_PATH"
expect_status 200 "reaction removal"
api "$AUTHOR_TOKEN" DELETE "$REACTION_PATH"
expect_status 200 "reaction removal idempotent retry"
got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='reaction.removed'
   AND payload->'data'->'payload'->>'message_id' ILIKE '$MESSAGE_ID'
   AND payload->'data'->'payload'->>'member_id' ILIKE '$AUTHOR_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[interaction] FAIL duplicate removal outbox: $got" >&2; exit 1; }

api "$OTHER_TOKEN" DELETE "$MESSAGE_PATH"
expect_status 403 "non-author delete"
api "$AUTHOR_TOKEN" DELETE "$MESSAGE_PATH"
expect_status 200 "author delete"
printf '%s' "$RESPONSE_BODY" | jq -e --argjson seq "$MESSAGE_SEQ" \
  '.state == "deleted" and .seq == $seq and (.deletedAtMs > 0) and (has("body") | not)' >/dev/null
api "$AUTHOR_TOKEN" PATCH "$MESSAGE_PATH" '{"body":"resurrect"}'
expect_status 400 "edit after delete"
api "$AUTHOR_TOKEN" DELETE "$MESSAGE_PATH"
expect_status 200 "delete idempotent retry"

got="$(sql_value <<SQL
SELECT (body IS NULL)::int || ':' || (state='deleted')::int || ':' || seq || ':' ||
       (SELECT count(*) FROM reaction WHERE message_id='$MESSAGE_ID')
  FROM message WHERE id='$MESSAGE_ID';
SQL
)"
[ "$got" = "1:1:$MESSAGE_SEQ:0" ] || { echo "[interaction] FAIL tombstone: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='message.deleted'
   AND payload->'data'->'payload'->>'message_id' ILIKE '$MESSAGE_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[interaction] FAIL duplicate delete outbox: $got" >&2; exit 1; }

# Four event kinds use the exact Core decoder payload keys; message seq is never reassigned.
got="$(sql_value <<SQL
SELECT count(DISTINCT payload->'data'->>'type') FROM outbox
 WHERE payload->'data'->>'type' IN
   ('message.edited','message.deleted','reaction.added','reaction.removed')
   AND (
     payload->'data'->'payload'->>'message_id' ILIKE '$MESSAGE_ID'
     OR payload->'data'->'payload'->>'id' ILIKE '$MESSAGE_ID'
   );
SQL
)"
[ "$got" = "4" ] || { echo "[interaction] FAIL four event kinds: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE payload->'data'->>'type'='message.edited'
   AND payload->'data'->'payload'->>'id' ILIKE '$MESSAGE_ID'
   AND (payload->'data'->>'seq')::bigint=$MESSAGE_SEQ
   AND payload->'data'->'payload'->>'state'='edited'
   AND payload->'data'->'payload'->>'body'='edited private body';
SQL
)"
[ "$got" = "1" ] || { echo "[interaction] FAIL edited payload shape: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT last_seq FROM channel_seq WHERE channel_id='$CH_A';
SQL
)"
[ "$got" = "$HEAD_SEQ" ] || { echo "[interaction] FAIL interaction changed channel seq: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE target_id='$MESSAGE_ID' AND detail::text LIKE '%private original body%';
SQL
)"
[ "$got" = "0" ] || { echo "[interaction] FAIL original body leaked to audit: $got" >&2; exit 1; }

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='47800000-0000-7000-8000-000000000099';
SELECT (SELECT count(*) FROM message WHERE id='$MESSAGE_ID') || ':' ||
       (SELECT count(*) FROM reaction WHERE message_id='$CAP_MESSAGE_ID') || ':' ||
       (SELECT count(*) FROM outbox WHERE workspace_id='$WS_A') || ':' ||
       (SELECT count(*) FROM audit_log WHERE target_id='$MESSAGE_ID');
COMMIT;
SQL
)"
[ "$got" = "0:0:0:0" ] || { echo "[interaction] FAIL RLS isolation: $got" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM pg_class
 WHERE relname IN ('message','reaction','outbox','audit_log')
   AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$got" = "4" ] || { echo "[interaction] FAIL FORCE RLS metadata: $got" >&2; exit 1; }

echo "MOMO-478 message edit/delete/reaction + realtime payload + snapshot + RLS PASS"
