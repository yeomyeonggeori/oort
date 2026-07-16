#!/usr/bin/env bash
# MOMO-412 / ADR-0115 signed native + Slack-compatible webhook verifier.
# Docker execution belongs to momo-main; workers run bash -n only.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[webhook] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need openssl
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WEBHOOK_GATE_PROJECT:-momo412webhook}"
API_PORT="${WEBHOOK_GATE_PORT:-19900}"
PG_PORT="${WEBHOOK_GATE_POSTGRES_PORT:-19901}"
CENT_PORT_HOST="${WEBHOOK_GATE_CENT_PORT:-19902}"
HERMES_PORT_HOST="${WEBHOOK_GATE_HERMES_PORT:-19903}"
BOOT_TIMEOUT="${WEBHOOK_GATE_BOOT_TIMEOUT:-2400}"
RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-webhook-$RUN_ID"
mkdir -p "$TMP_DIR"

DEMO_WS="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL="00000000-0000-7000-8000-000000000201"
WS_B="41200000-0000-7000-8000-000000000099"
OWNER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
OWNER_EMAIL="webhook-owner-$RUN_ID@momo.local"
MEMBER_EMAIL="webhook-member-$RUN_ID@momo.local"
OTHER_EMAIL="webhook-other-$RUN_ID@momo.local"
OWNER_PASSWORD="webhook-$(uuidgen | tr '[:upper:]' '[:lower:]')"
MEMBER_PASSWORD="webhook-$(uuidgen | tr '[:upper:]' '[:lower:]')"
OTHER_PASSWORD="webhook-$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WEBHOOK_GATE_KEEP:-0}" = "1" ]; then
    echo "[webhook] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[webhook] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[webhook] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[webhook] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$DEMO_WS', 'human', 'active', 'Webhook Owner', 'webhook-owner-$RUN_EPOCH'),
  ('$MEMBER_ID', '$DEMO_WS', 'human', 'active', 'Webhook Member', 'webhook-member-$RUN_EPOCH');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$DEMO_WS', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$MEMBER_ID', '$DEMO_WS', '$MEMBER_EMAIL', true, momo_password_hash('$MEMBER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$DEMO_WS', '$GENERAL_CHANNEL', '$OWNER_ID', 'owner'),
  ('$DEMO_WS', '$GENERAL_CHANNEL', '$MEMBER_ID', 'member');

INSERT INTO workspace (id, slug, name)
VALUES ('$WS_B', 'momo-webhook-b-$RUN_EPOCH', 'Webhook Gate B');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$OTHER_ID', '$WS_B', 'human', 'active', 'Webhook Other', 'webhook-other-$RUN_EPOCH');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OTHER_ID', '$WS_B', '$OTHER_EMAIL', true, momo_password_hash('$OTHER_PASSWORD'), 'UTC');
COMMIT;
SQL

RESPONSE_STATUS=""
RESPONSE_BODY=""
api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data-binary "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[webhook] FAIL $2: expected $1 got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
  echo "[webhook] ok: $2 (HTTP $1)"
}
login() {
  local body
  body="$(jq -cn --arg e "$1" --arg p "$2" --arg w "${3:-}" \
    'if $w == "" then {email:$e,password:$p} else {email:$e,password:$p,workspace:$w} end')"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' -d "$body" |
    jq -r '.accessToken'
}
sha256_hex() { printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'; }
hmac_hex() { local secret="$1" base="$2"; printf '%s' "$base" | openssl dgst -sha256 -hmac "$secret" | awk '{print $NF}'; }

OWNER_ACCESS="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
MEMBER_ACCESS="$(login "$MEMBER_EMAIL" "$MEMBER_PASSWORD")"
OTHER_ACCESS="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD" "$WS_B")"
MANAGE="/v1/workspaces/$DEMO_WS/webhooks"

api GET "$MANAGE" "" "$MEMBER_ACCESS"
expect_status 403 "read-path non-admin HTTPError is unwrapped"
api GET "/v1/workspaces/$WS_B/webhooks" "" "$OWNER_ACCESS"
expect_status 403 "management path cannot cross workspace"

create_native="$(jq -cn --arg ch "$GENERAL_CHANNEL" '{channelId:$ch,mode:"native",label:"CI Native Webhook"}')"
api POST "$MANAGE" "$create_native" "$OWNER_ACCESS"
expect_status 201 "owner issues native webhook"
NATIVE_RESPONSE="$RESPONSE_BODY"
NATIVE_INSTALL="$(printf '%s' "$NATIVE_RESPONSE" | jq -r '.installation.id' | tr '[:upper:]' '[:lower:]')"
NATIVE_KEY="$(printf '%s' "$NATIVE_RESPONSE" | jq -r '.keyId' | tr '[:upper:]' '[:lower:]')"
NATIVE_SECRET="$(printf '%s' "$NATIVE_RESPONSE" | jq -r '.secret')"
NATIVE_URL="$(printf '%s' "$NATIVE_RESPONSE" | jq -r '.url')"
[ "$(printf '%s' "$NATIVE_RESPONSE" | jq -r '.signatureVersion')" = "v1" ] || exit 1
[ "$(printf '%s' "$NATIVE_RESPONSE" | jq -r '.algorithm')" = "HMAC-SHA256" ] || exit 1
[ "$NATIVE_URL" = "/v1/webhooks/$DEMO_WS/$NATIVE_INSTALL" ] || exit 1

native_call() {
  local body="$1" delivery="$2" secret="$3" key="$4" ws="${5:-$DEMO_WS}" install="${6:-$NATIVE_INSTALL}" timestamp="${7:-$(date -u +%s)}" forced_signature="${8:-}"
  local hash base signature out="$TMP_DIR/native.json"
  hash="$(sha256_hex "$body")"
  base="$(printf 'v1\nPOST\n/v1/webhooks/%s/%s\n%s\n%s\n%s\n%s' "$ws" "$install" "$install" "$timestamp" "$delivery" "$hash")"
  signature="${forced_signature:-$(hmac_hex "$secret" "$base")}"
  RESPONSE_STATUS="$(curl -sS -o "$out" -w "%{http_code}" -X POST "$BASE_URL/v1/webhooks/$ws/$install" \
    -H 'Content-Type: application/json' \
    -H 'X-Momo-Signature-Version: v1' \
    -H "X-Momo-Key-Id: $key" \
    -H "X-Momo-Timestamp: $timestamp" \
    -H "X-Momo-Delivery-Id: $delivery" \
    -H "X-Momo-Signature: v1=$signature" \
    --data-binary "$body")"
  RESPONSE_BODY="$(cat "$out")"
}

NATIVE_BODY='{"text":"native deploy complete","event_type":"deploy","metadata":{"region":"ap-northeast-2"}}'
native_call "$NATIVE_BODY" "delivery-forged" "$NATIVE_SECRET" "$NATIVE_KEY" "$DEMO_WS" "$NATIVE_INSTALL" "$(date -u +%s)" "$(printf '0%.0s' {1..64})"
expect_status 401 "forged native signature rejected"

native_call "$NATIVE_BODY" "delivery-1" "$NATIVE_SECRET" "$NATIVE_KEY"
expect_status 201 "valid native delivery committed"
NATIVE_MESSAGE="$(printf '%s' "$RESPONSE_BODY" | jq -r '.messageId' | tr '[:upper:]' '[:lower:]')"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.duplicate')" = "false" ] || exit 1
native_call "$NATIVE_BODY" "delivery-1" "$NATIVE_SECRET" "$NATIVE_KEY"
expect_status 200 "native delivery replay is idempotent"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.duplicate')" = "true" ] || exit 1
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.messageId' | tr '[:upper:]' '[:lower:]')" = "$NATIVE_MESSAGE" ] || exit 1

got="$(printf "SELECT count(*) FROM webhook_receipt WHERE installation_id='$NATIVE_INSTALL' AND delivery_id='delivery-1';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[webhook] duplicate native receipt count=$got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM message WHERE id='$NATIVE_MESSAGE'; SELECT count(*) FROM outbox WHERE payload->'data'->'payload'->>'id'=upper('$NATIVE_MESSAGE') OR lower(payload->'data'->'payload'->>'id')='$NATIVE_MESSAGE';\n" | run_sql -tA | tr '\n' ':')"
[ "$got" = "1:1:" ] || { echo "[webhook] receipt/message/outbox atomic evidence missing: $got" >&2; exit 1; }

stale_ts="$(( $(date -u +%s) - 301 ))"
native_call "$NATIVE_BODY" "delivery-stale" "$NATIVE_SECRET" "$NATIVE_KEY" "$DEMO_WS" "$NATIVE_INSTALL" "$stale_ts"
expect_status 401 "stale native timestamp rejected"
native_call "$NATIVE_BODY" "delivery-cross-ws" "$NATIVE_SECRET" "$NATIVE_KEY" "$WS_B" "$NATIVE_INSTALL"
expect_status 401 "native installation cannot cross workspace"

api POST "$MANAGE/$NATIVE_INSTALL/rotate" '{"overlapSeconds":300}' "$OWNER_ACCESS"
expect_status 200 "native key rotates with overlap"
ROTATED_KEY="$(printf '%s' "$RESPONSE_BODY" | jq -r '.keyId' | tr '[:upper:]' '[:lower:]')"
ROTATED_SECRET="$(printf '%s' "$RESPONSE_BODY" | jq -r '.secret')"
native_call "$NATIVE_BODY" "delivery-old-overlap" "$NATIVE_SECRET" "$NATIVE_KEY"
expect_status 201 "old native key remains valid inside overlap"
native_call "$NATIVE_BODY" "delivery-new-overlap" "$ROTATED_SECRET" "$ROTATED_KEY"
expect_status 201 "new native key is valid during overlap"

api POST "$MANAGE/$NATIVE_INSTALL/rotate" '{"overlapSeconds":0}' "$OWNER_ACCESS"
expect_status 200 "native key rotates with zero overlap"
CURRENT_KEY="$(printf '%s' "$RESPONSE_BODY" | jq -r '.keyId' | tr '[:upper:]' '[:lower:]')"
CURRENT_SECRET="$(printf '%s' "$RESPONSE_BODY" | jq -r '.secret')"
native_call "$NATIVE_BODY" "delivery-expired-key" "$ROTATED_SECRET" "$ROTATED_KEY"
expect_status 401 "prior native key is rejected after overlap closes"

api GET "$MANAGE" "" "$OWNER_ACCESS"
expect_status 200 "management list omits one-time secrets"
case "$RESPONSE_BODY" in *"$NATIVE_SECRET"*|*"$ROTATED_SECRET"*|*"$CURRENT_SECRET"*)
  echo "[webhook] native secret leaked through list response" >&2; exit 1;;
esac

api DELETE "$MANAGE/$NATIVE_INSTALL" "" "$OWNER_ACCESS"
expect_status 200 "native installation revoked"
case "$RESPONSE_BODY" in *"$CURRENT_SECRET"*) echo "[webhook] secret leaked through revoke response" >&2; exit 1;; esac
native_call "$NATIVE_BODY" "delivery-after-revoke" "$CURRENT_SECRET" "$CURRENT_KEY"
expect_status 401 "native delivery rejected after revoke"

create_slack="$(jq -cn --arg ch "$GENERAL_CHANNEL" '{channelId:$ch,mode:"slack_compatible",label:"Jenkins Webhook"}')"
api POST "$MANAGE" "$create_slack" "$OWNER_ACCESS"
expect_status 201 "owner issues Slack-compatible webhook"
SLACK_RESPONSE="$RESPONSE_BODY"
SLACK_INSTALL="$(printf '%s' "$SLACK_RESPONSE" | jq -r '.installation.id' | tr '[:upper:]' '[:lower:]')"
SLACK_URL="$(printf '%s' "$SLACK_RESPONSE" | jq -r '.url')"
SLACK_TOKEN="${SLACK_URL#/hooks/}"
[ "$(printf '%s' "$SLACK_RESPONSE" | jq -r '.secret')" = "null" ] || exit 1

SLACK_FIXTURE='{"text":"Build <https://ci.example/run/7|passed> <!channel> <@U123>","attachments":[{"fallback":"deploy result","color":"#36a64f","pretext":"Production deploy","author_name":"CI Bot","author_link":"https://ci.example/","author_icon":"https://ci.example/icon.png","title":"Release 7","title_link":"https://ci.example/run/7","text":"Completed <https://ci.example/log|logs>","fields":[{"title":"Status","value":"green","short":true}],"image_url":"https://ci.example/result.png","thumb_url":"https://ci.example/thumb.png","footer":"Jenkins","footer_icon":"https://ci.example/footer.png"}]}'
api POST "$SLACK_URL" "$SLACK_FIXTURE"
expect_status 201 "Slack text and legacy attachment fixture committed"
SLACK_MESSAGE="$(printf '%s' "$RESPONSE_BODY" | jq -r '.messageId' | tr '[:upper:]' '[:lower:]')"
api POST "$SLACK_URL" "$SLACK_FIXTURE"
expect_status 200 "Slack body-hash/time-window retry is idempotent"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.duplicate')" = "true" ] || exit 1
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.messageId' | tr '[:upper:]' '[:lower:]')" = "$SLACK_MESSAGE" ] || exit 1

EXPECTED_SLACK="$(printf 'Build [passed](https://ci.example/run/7) @channel @U123\n\nProduction deploy\n[CI Bot](https://ci.example/)\n[Release 7](https://ci.example/run/7)\nCompleted [logs](https://ci.example/log)\nStatus: green\nhttps://ci.example/result.png\nhttps://ci.example/thumb.png\nJenkins')"
expected_hash="$(sha256_hex "$EXPECTED_SLACK")"
got="$(printf "SELECT encode(digest(convert_to(body,'UTF8'),'sha256'),'hex') FROM message WHERE id='$SLACK_MESSAGE';\n" | sql_scalar)"
[ "$got" = "$expected_hash" ] || { echo "[webhook] Slack rendered message mismatch" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM webhook_receipt WHERE installation_id='$SLACK_INSTALL';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[webhook] Slack receipt dedupe count=$got" >&2; exit 1; }
got="$(printf "SELECT props->>'source', props->>'webhook_mode', props->>'slack_compatible' FROM message WHERE id='$SLACK_MESSAGE';\n" | run_sql -tA -F ':')"
[ "$got" = "external_webhook:slack_compatible:true" ] || { echo "[webhook] dedicated author props missing: $got" >&2; exit 1; }

api POST "$SLACK_URL" '{"text":"x","blocks":[]}'
expect_status 400 "Slack blocks rejected with explicit error"
printf '%s' "$RESPONSE_BODY" | jq -e '.error.message | contains("blocks")' >/dev/null
# Review #443 H1: Mattermost-unsupported fields are IGNORED (rendered), not
# rejected — the whole point of "swap only the URL". Grafana/Alertmanager-shaped
# payload (username/icon_emoji/*bold*/attachment ts+mrkdwn_in) must 202, drop
# the identity override, and render the text.
api POST "$SLACK_URL" '{"text":"*Alerting* fired","username":"grafana","icon_emoji":":fire:","attachments":[{"text":"cpu high","ts":1,"mrkdwn_in":["text"]}]}'
expect_status 202 "Mattermost-unsupported fields ignored (tool works by URL swap)"
IGNORE_MSG="$(printf "SELECT id FROM message WHERE channel_id='$GENERAL_CHANNEL' ORDER BY seq DESC LIMIT 1;\n" | sql_scalar)"
got="$(printf "SELECT body FROM message WHERE id='$IGNORE_MSG';\n" | sql_scalar)"
case "$got" in
  *"*Alerting* fired"*|*"cpu high"*) : ;;
  *) echo "[webhook] ignored-field payload did not render expected text: $got" >&2; exit 1 ;;
esac
printf '%s' "$got" | grep -q 'grafana' && { echo "[webhook] identity override leaked into message" >&2; exit 1; }
printf "SELECT display_name FROM member WHERE id=(SELECT author_member_id FROM message WHERE id='$IGNORE_MSG');\n" | sql_scalar | grep -q 'grafana' && { echo "[webhook] username spoofed the author" >&2; exit 1; } || true

# Raw native secret and Slack URL token may appear only in their one-time
# issuance response held in this process. They must not be persisted, audited,
# listed, returned by ingress/revoke, or emitted by the request logger.
got="$(run_sql -tA <<SQL | tr '\n' ':'
SELECT count(*) FROM webhook_secret_key WHERE row_to_json(webhook_secret_key)::text LIKE '%$NATIVE_SECRET%' OR row_to_json(webhook_secret_key)::text LIKE '%$SLACK_TOKEN%';
SELECT count(*) FROM webhook_installation WHERE row_to_json(webhook_installation)::text LIKE '%$NATIVE_SECRET%' OR row_to_json(webhook_installation)::text LIKE '%$SLACK_TOKEN%';
SELECT count(*) FROM webhook_receipt WHERE row_to_json(webhook_receipt)::text LIKE '%$NATIVE_SECRET%' OR row_to_json(webhook_receipt)::text LIKE '%$SLACK_TOKEN%';
SELECT count(*) FROM audit_log WHERE detail::text LIKE '%$NATIVE_SECRET%' OR detail::text LIKE '%$SLACK_TOKEN%';
SQL
)"
[ "$got" = "0:0:0:0:" ] || { echo "[webhook] raw secret persisted or audited: $got" >&2; exit 1; }
if compose logs api 2>&1 | grep -F "$SLACK_TOKEN" >/dev/null; then
  echo "[webhook] Slack URL token leaked into API logs" >&2
  exit 1
fi
compose logs api 2>&1 | grep -F '/hooks/[REDACTED]' >/dev/null || {
  echo "[webhook] redacted Slack request log evidence missing" >&2; exit 1; }

got="$(printf "SELECT count(*) FROM pg_class WHERE relname IN ('webhook_installation','webhook_secret_key','webhook_receipt') AND relrowsecurity AND relforcerowsecurity;\n" | sql_scalar)"
[ "$got" = "3" ] || { echo "[webhook] webhook tables must FORCE RLS" >&2; exit 1; }
run_sql <<SQL
SET ROLE momo_app;
BEGIN;
SELECT set_config('app.workspace_id', '$WS_B', true);
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM webhook_installation WHERE workspace_id = '$DEMO_WS';
  IF got <> 0 THEN RAISE EXCEPTION 'webhook installation leaked across RLS: %', got; END IF;
  SELECT count(*) INTO got FROM webhook_secret_key WHERE workspace_id = '$DEMO_WS';
  IF got <> 0 THEN RAISE EXCEPTION 'webhook key metadata leaked across RLS: %', got; END IF;
  SELECT count(*) INTO got FROM webhook_receipt WHERE workspace_id = '$DEMO_WS';
  IF got <> 0 THEN RAISE EXCEPTION 'webhook receipt leaked across RLS: %', got; END IF;
END \$\$;
COMMIT;
RESET ROLE;
SQL

echo
echo "MOMO-412 signed webhook ingress verification PASS"
echo "- native: forged/replay/stale/cross-workspace/overlap rotation/revoke"
echo "- Slack-compatible: text + Mattermost legacy attachments + links/mentions, blocks/ts rejection"
echo "- ledger: receipt + deterministic client_msg_id + message.seq + outbox one tenant transaction"
echo "- custody: one-time reveal only, request-log redaction, audit/DB/response non-persistence, FORCE RLS"
