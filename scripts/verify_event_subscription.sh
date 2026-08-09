#!/usr/bin/env bash
# MOMO-535 outbound event subscription runtime verifier.
# Docker execution belongs to the orchestrator; workers run `bash -n` only.
#
# 이슈 #1204 (2026-08-09) — egress 감사 폐곡선이 여기 붙는다. 이 판은 이미
# 「본문이 서명돼 외부 주소로 나간다」를 실제 수신기로 재고 있었고, 지금까지
# 없었던 것은 **그 사실이 워크스페이스에 남는가**였다. 아래 두 red proof 는
# 제품 소스를 한 줄도 건드리지 않는다 — 둘 다 DB 쪽 이음매다.
#
#   EVENT_SUBSCRIPTION_GATE_PROVE_RED_AUDIT=1  (expected FAIL)
#     063 의 감사 함수를 no-op 으로 바꿔 두고 같은 배달을 시킨다. 수신기는
#     본문을 그대로 받는데 audit_log 에는 아무것도 없다 — #1204 이전의 상태를
#     그대로 재현한다.
#   EVENT_SUBSCRIPTION_GATE_PROVE_RED_BODY=1   (expected FAIL)
#     감사 행 하나에 본문을 손으로 실어 둔다. 본문 부재 단정이 그것을 잡아야
#     한다 — 안 잡으면 그 단정은 아무것도 안 재고 있었다는 뜻이다.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[event-subscription] missing $1" >&2
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
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
      >/dev/null 2>&1 || continue
    printf '%s\n' "$candidate"
    return 0
  done
  echo "[event-subscription] Python 3.10+ not found" >&2
  return 1
}
PYTHON_BIN="$(find_python)"

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
# A fixed project name can reuse stale source/build caches after a failed run.
# Isolate every invocation with a run-tag (MOMO-536 measured failure mode).
PROJECT="${EVENT_SUBSCRIPTION_GATE_PROJECT:-momo535event-$$-$(date +%s)}"
API_PORT="${EVENT_SUBSCRIPTION_GATE_API_PORT:-28130}"
CENT_PORT_HOST="${EVENT_SUBSCRIPTION_GATE_CENTRIFUGO_PORT:-28131}"
# 28132 is intentionally skipped: scripts/momo owns it as its default PG port.
PG_PORT="${EVENT_SUBSCRIPTION_GATE_POSTGRES_PORT:-28133}"
HERMES_PORT_HOST="${EVENT_SUBSCRIPTION_GATE_HERMES_PORT:-28134}"
BOOT_TIMEOUT="${EVENT_SUBSCRIPTION_GATE_BOOT_TIMEOUT:-2400}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-event-subscription.XXXXXX")"
OVERRIDE_FILE="$TMP_DIR/event-subscription.override.yml"
RECEIVER_ROOT="$TMP_DIR/receiver"
mkdir -p "$RECEIVER_ROOT"
printf 'success\n' >"$RECEIVER_ROOT/mode"
: >"$RECEIVER_ROOT/requests.jsonl"

"$PYTHON_BIN" - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(set(ports)) != len(ports):
    raise SystemExit(f"[event-subscription] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as exc:
    raise SystemExit(f"[event-subscription] port preflight failed: {exc}")
finally:
    for sock in sockets:
        sock.close()
PY

"$PYTHON_BIN" - "$RECEIVER_ROOT/server.py" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(r'''from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path

ROOT = Path("/state")

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        record = {
            "path": self.path,
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": body.decode("utf-8"),
        }
        with (ROOT / "requests.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
        mode = (ROOT / "mode").read_text(encoding="utf-8").strip()
        self.send_response(503 if mode == "fail" else 204)
        self.end_headers()

    def log_message(self, format, *args):
        return

ThreadingHTTPServer(("0.0.0.0", 8099), Handler).serve_forever()
''', encoding="utf-8")
PY

cat >"$OVERRIDE_FILE" <<YAML
services:
  api:
    environment:
      MOMO_ENV: local
      MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP: "1"
    networks:
      - default
      - event-webhook-public-test
  relay:
    environment:
      MOMO_ENV: local
      MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP: "1"
      WEBHOOK_DISABLE_AFTER_5XX: "3"
      RELAY_MAX_ATTEMPTS: "8"
    networks:
      - default
      - event-webhook-public-test
  webhook-receiver:
    image: python:3.12-slim
    restart: "no"
    command: ["python3", "/state/server.py"]
    volumes:
      - "${RECEIVER_ROOT}:/state"
    networks:
      event-webhook-public-test:
        ipv4_address: 11.30.0.2
networks:
  event-webhook-public-test:
    ipam:
      config:
        - subnet: 11.30.0.0/24
YAML

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${EVENT_SUBSCRIPTION_GATE_KEEP:-0}" = "1" ]; then
    echo "[event-subscription] leaving compose project '$PROJECT' up"
    echo "[event-subscription] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-event-subscription.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[event-subscription] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "[event-subscription] FAIL $*" >&2; exit 1; }
pass() { echo "[event-subscription] PASS $*"; }

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
PASSWORD="event-subscription-$RUN_TAG"
SUBSCRIPTION_PATH="/v1/workspaces/$WS_ID/event-subscriptions"

echo "[event-subscription] booting isolated API + relay + Python receiver '$PROJECT'"
compose up -d api relay webhook-receiver
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api relay migrate db-roles webhook-receiver >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql \
    -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

demo_rows="$(sql_value <<SQL
SELECT count(*) FROM human WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
[ "$demo_rows" = "1" ] || fail "unexpected demo account seed state"
run_sql <<SQL
UPDATE human SET password_hash=momo_password_hash('$PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL

LOGIN_JSON="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e demo@momo.local --arg p "$PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')")"
TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -er '.accessToken')"

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" body="${3:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "$RESPONSE_BODY" >&2
    fail "$2 expected HTTP $1, got $RESPONSE_STATUS"
  }
  pass "$2 ($1)"
}

api POST "$SUBSCRIPTION_PATH" \
  '{"url":"http://127.0.0.1:8099/events","eventKinds":["mention"]}'
expect_status 400 "loopback SSRF rejection"

CREATE_BODY='{"url":"http://11.30.0.2:8099/events","eventKinds":["mention","approval_request","work.status_changed"]}'
api POST "$SUBSCRIPTION_PATH" "$CREATE_BODY"
expect_status 201 "subscription create and one-time secret issue"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .eventSubscription.enabled == true
  and .eventSubscription.eventKinds == ["approval_request","mention","work.status_changed"]
  and (.secret | startswith("momo_evtsec_v1."))
  and .algorithm == "HMAC-SHA256" and .signatureVersion == "v1"
' >/dev/null || fail "create response contract"
SUBSCRIPTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.eventSubscription.id | ascii_downcase')"
SIGNING_SECRET="$(printf '%s' "$RESPONSE_BODY" | jq -er '.secret')"

api GET "$SUBSCRIPTION_PATH"
expect_status 200 "subscription list"
printf '%s' "$RESPONSE_BODY" | jq -e --arg id "$SUBSCRIPTION_ID" '
  any(.eventSubscriptions[]; ((.id | ascii_downcase) == $id))
  and all(.eventSubscriptions[]; (has("secret") | not) and (has("secretRef") | not))
' >/dev/null || fail "list leaked signing material or missed subscription"

api PUT "$SUBSCRIPTION_PATH/$SUBSCRIPTION_ID" '{"enabled":false}'
expect_status 200 "subscription disable"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .eventSubscription.enabled == false
  and .eventSubscription.disabledReason == "disabled_by_admin"
  and (has("secret") | not)
' >/dev/null || fail "disable projection"
api PUT "$SUBSCRIPTION_PATH/$SUBSCRIPTION_ID" '{"enabled":true}'
expect_status 200 "subscription re-enable"

SECOND_BODY='{"url":"http://11.30.0.2:8099/delete-me","eventKinds":["mention"],"enabled":false}'
api POST "$SUBSCRIPTION_PATH" "$SECOND_BODY"
expect_status 201 "second subscription create"
SECOND_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.eventSubscription.id | ascii_downcase')"
api DELETE "$SUBSCRIPTION_PATH/$SECOND_ID"
expect_status 200 "subscription delete"

db_secret_check="$(run_sql -v raw_secret="$SIGNING_SECRET" -tA <<SQL
SELECT count(*)::text || '|' ||
       count(*) FILTER (WHERE secret_ref = :'raw_secret')::text || '|' ||
       count(*) FILTER (WHERE position(:'raw_secret' in url) > 0)::text
  FROM event_subscription
 WHERE workspace_id='$WS_ID' AND id='$SUBSCRIPTION_ID';
SQL
)"
db_secret_check="$(printf '%s' "$db_secret_check" | tr -d '[:space:]')"
[ "$db_secret_check" = "1|0|0" ] || fail "plaintext signing secret persisted"

HUMAN_ID="$(sql_value <<SQL
SELECT member_id FROM human WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
CHANNEL_ID="$(sql_value <<SQL
SELECT id FROM channel WHERE workspace_id='$WS_ID' ORDER BY created_at, id LIMIT 1;
SQL
)"
MENTION_BODY='MOMO-535 signed mention'
APPROVAL_BODY='MOMO-535 retry fixture'

# red proof ① — 감사를 들어내고 같은 배달을 시킨다. 함수 시그니처는 그대로라
# relay 는 아무것도 모르고 호출하며, 본문은 여전히 밖으로 나간다.
if [ "${EVENT_SUBSCRIPTION_GATE_PROVE_RED_AUDIT:-0}" = "1" ]; then
  run_sql <<'SQL'
CREATE OR REPLACE FUNCTION record_event_subscription_delivery(
  delivery_workspace_id uuid, delivery_subscription_id uuid,
  delivery_event_kind text, delivery_event_id uuid,
  delivery_target_host text, delivery_outbox_id bigint,
  delivery_attempt integer, delivery_http_status integer
) RETURNS uuid AS $$
BEGIN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
SQL
  echo "[event-subscription] RED PROOF: delivery audit removed for this run"
fi

MENTION_MESSAGE_ID="$(run_sql -tA <<SQL
WITH bumped AS (
  UPDATE channel_seq SET last_seq=last_seq+1
   WHERE workspace_id='$WS_ID' AND channel_id='$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props)
SELECT '$WS_ID', '$CHANNEL_ID', last_seq,
       (extract(epoch FROM clock_timestamp())*1000)::bigint, 0,
       '$HUMAN_ID', 'text', 'MOMO-535 signed mention',
       jsonb_build_object('mention_member_ids', jsonb_build_array('$HUMAN_ID'))
  FROM bumped
RETURNING id;
SQL
)"
MENTION_MESSAGE_ID="$(printf '%s' "$MENTION_MESSAGE_ID" | tr -d '[:space:]')"
[ -n "$MENTION_MESSAGE_ID" ] || fail "mention fixture insert"

wait_delivery_count() {
  local expected="$1" end count
  end=$(( $(date -u +%s) + 90 ))
  while :; do
    count="$(wc -l <"$RECEIVER_ROOT/requests.jsonl" | tr -d '[:space:]')"
    [ "$count" -ge "$expected" ] && return 0
    [ "$(date -u +%s)" -ge "$end" ] && return 1
    sleep 1
  done
}
wait_delivery_count 1 || fail "signed mention delivery timeout"

"$PYTHON_BIN" - "$RECEIVER_ROOT/requests.jsonl" "$SIGNING_SECRET" "$MENTION_MESSAGE_ID" <<'PY'
import hashlib, hmac, json, pathlib, sys
record = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()[0])
headers = record["headers"]
body = record["body"]
secret = sys.argv[2].encode()
expected_id = sys.argv[3].lower()
assert headers["x-momo-event"] == "mention"
assert headers["x-momo-delivery"].isdigit()
timestamp = headers["x-momo-timestamp"]
expected = hmac.new(secret, (timestamp + "." + body).encode(), hashlib.sha256).hexdigest()
assert hmac.compare_digest(headers["x-momo-signature"], "v1=" + expected)
event = json.loads(body)
assert event["schema"] == "momo.event.v0"
assert event["kind"] == "mention"
assert event["id"].lower() == expected_id
PY
pass "mention event -> exact-body HMAC-SHA256 POST"

printf 'fail\n' >"$RECEIVER_ROOT/mode"
APPROVAL_MESSAGE_ID="$(run_sql -tA <<SQL
WITH bumped AS (
  UPDATE channel_seq SET last_seq=last_seq+1
   WHERE workspace_id='$WS_ID' AND channel_id='$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props)
SELECT '$WS_ID', '$CHANNEL_ID', last_seq,
       (extract(epoch FROM clock_timestamp())*1000)::bigint, 0,
       '$HUMAN_ID', 'approval_request', 'MOMO-535 retry fixture',
       jsonb_build_object('kind','momo535_verifier')
  FROM bumped
RETURNING id;
SQL
)"
APPROVAL_MESSAGE_ID="$(printf '%s' "$APPROVAL_MESSAGE_ID" | tr -d '[:space:]')"
[ -n "$APPROVAL_MESSAGE_ID" ] || fail "approval fixture insert"

deadline=$(( $(date -u +%s) + 90 ))
while :; do
  disable_state="$(run_sql -tA <<SQL
SELECT enabled::text || '|' || delivery_failure_count::text || '|' ||
       COALESCE(disabled_reason,'') || '|' ||
       (SELECT count(*) FROM audit_log
         WHERE workspace_id='$WS_ID'
           AND action='event_subscription.auto_disabled'
           AND target_id='$SUBSCRIPTION_ID')::text
  FROM event_subscription
 WHERE workspace_id='$WS_ID' AND id='$SUBSCRIPTION_ID';
SQL
)"
  disable_state="$(printf '%s' "$disable_state" | tr -d '[:space:]')"
  [ "$disable_state" = "false|3|server_5xx_threshold|1" ] && break
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 relay webhook-receiver >&2 || true
    fail "5xx automatic disable timeout (state=$disable_state)"
  fi
  sleep 1
done
wait_delivery_count 4 || fail "expected one success plus three 5xx attempts"

retry_state="$(run_sql -tA <<SQL
SELECT attempts::text || '|' || status::text
  FROM outbox
 WHERE kind='webhook_delivery'
   AND lower(payload->'event'->>'id')=lower('$APPROVAL_MESSAGE_ID')
 ORDER BY id DESC LIMIT 1;
SQL
)"
retry_state="$(printf '%s' "$retry_state" | tr -d '[:space:]')"
[ "$retry_state" = "3|failed" ] || fail "retry/outbox terminal assertion (got=$retry_state)"
pass "exponential retry and accumulated 5xx auto-disable + audit"

# ---------------------------------------------------------------------------
# 이슈 #1204 — 나간 사실의 폐곡선, 그리고 본문의 부재
#
# 지금까지 일어난 egress 는 넷이다: 멘션 1건(수신기 204)과 승인요청 3건(503,
# 재시도마다 별개의 전송). 목적지가 답한 전송마다 감사 행이 하나씩 서야 하고,
# 그 넷 중 어느 것도 본문을 담아서는 안 된다.
# ---------------------------------------------------------------------------
if [ "${EVENT_SUBSCRIPTION_GATE_PROVE_RED_BODY:-0}" = "1" ]; then
  # red proof ② — 본문을 손으로 실어 둔다. 아래 부재 단정이 이것을 잡아야 한다.
  run_sql <<SQL
INSERT INTO audit_log (workspace_id, action, target_type, target_id, detail)
VALUES ('$WS_ID', 'event_subscription.delivered', 'event_subscription',
        '$SUBSCRIPTION_ID',
        jsonb_build_object(
          'schema', 'momo.event_subscription.delivered.v1',
          'event_kind', 'mention',
          'target_host', '11.30.0.2',
          'body', '$MENTION_BODY'));
SQL
  echo "[event-subscription] RED PROOF: a delivery audit row was given the message body"
fi

deadline=$(( $(date -u +%s) + 60 ))
while :; do
  delivery_audits="$(run_sql -tA <<SQL
SELECT
  count(*) FILTER (WHERE detail->>'http_status' = '204')::text || '|' ||
  count(*) FILTER (WHERE detail->>'http_status' = '503')::text || '|' ||
  count(*) FILTER (WHERE detail->>'target_host' = '11.30.0.2')::text || '|' ||
  count(*) FILTER (WHERE actor_member_id IS NOT NULL)::text
  FROM audit_log
 WHERE workspace_id='$WS_ID'
   AND action='event_subscription.delivered'
   AND target_type='event_subscription'
   AND target_id='$SUBSCRIPTION_ID';
SQL
)"
  delivery_audits="$(printf '%s' "$delivery_audits" | tr -d '[:space:]')"
  [ "$delivery_audits" = "1|3|4|0" ] && break
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 relay >&2 || true
    fail "webhook delivery audit closure (want 1x204|3x503|4 host rows|0 actor, got=$delivery_audits)"
  fi
  sleep 1
done
pass "each answered webhook egress left exactly one audit row (1x204 + 3x503, system actor)"

# 감사가 이벤트를 **이름으로** 부르되 인용하지는 않는다.
audit_shape="$(run_sql -tA <<SQL
SELECT count(*)::text || '|' ||
       count(*) FILTER (
         WHERE detail ? 'event_kind' AND detail ? 'event_id'
           AND detail ? 'target_host' AND detail ? 'outbox_id'
           AND detail ? 'attempt' AND detail ? 'http_status'
           AND detail->>'schema' = 'momo.event_subscription.delivered.v1'
       )::text
  FROM audit_log
 WHERE workspace_id='$WS_ID' AND action='event_subscription.delivered';
SQL
)"
audit_shape="$(printf '%s' "$audit_shape" | tr -d '[:space:]')"
[ "$audit_shape" = "4|4" ] || fail "delivery audit detail shape (got=$audit_shape)"

# **본문 부재.** 두 갈래로 잰다: ①금지된 키가 하나도 없다 ②실제로 나간 두
# 본문 문자열이 감사 어디에도 없다. 키만 보면 다른 이름으로 실린 본문을 놓치고,
# 문자열만 보면 다음 픽스처에서 눈이 먼다.
body_leak="$(run_sql -tA <<SQL
SELECT count(*) FILTER (
         WHERE detail ?| array['body','payload','data','event','text','content']
       )::text || '|' ||
       count(*) FILTER (
         WHERE position('$MENTION_BODY' in detail::text) > 0
            OR position('$APPROVAL_BODY' in detail::text) > 0
       )::text
  FROM audit_log
 WHERE workspace_id='$WS_ID' AND action='event_subscription.delivered';
SQL
)"
body_leak="$(printf '%s' "$body_leak" | tr -d '[:space:]')"
[ "$body_leak" = "0|0" ] \
  || fail "감사가 두 번째 유출 경로가 됐다 — 전송 감사에 본문이 실렸다 (got=$body_leak)"

# 그리고 그 본문은 **정말로 나갔다**. 부재 단정이 「아무것도 안 나갔으니 감사도
# 비었다」로 초록이 되는 길을 막는다.
"$PYTHON_BIN" - "$RECEIVER_ROOT/requests.jsonl" "$MENTION_BODY" <<'PY'
import json, pathlib, sys
lines = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
bodies = [json.loads(line)["body"] for line in lines if line.strip()]
assert any(sys.argv[2] in body for body in bodies), (
    "수신기가 본문을 못 받았다 — 본문 부재 단정이 공회전한다"
)
PY
pass "the body reached the subscriber and the audit named the egress without quoting it"

trigger_count="$(sql_value <<SQL
SELECT count(*) FROM pg_trigger
 WHERE tgrelid='work_session'::regclass
   AND tgname='work_status_event_subscription_trg'
   AND NOT tgisinternal;
SQL
)"
[ "$trigger_count" = "1" ] || fail "work status transition trigger missing"

rls_rows="$(compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres psql \
  -h 127.0.0.1 -U momo_app -d "${POSTGRES_DB:-momo}" \
  -v ON_ERROR_STOP=1 --no-psqlrc -qtA <<SQL
BEGIN;
SET LOCAL app.workspace_id = '53500000-0000-7000-8000-000000000099';
SELECT count(*) FROM event_subscription WHERE id='$SUBSCRIPTION_ID';
ROLLBACK;
SQL
)"
rls_rows="$(printf '%s' "$rls_rows" | tr -d '[:space:]')"
[ "$rls_rows" = "0" ] || fail "FORCE RLS exposed subscription cross-workspace"

crud_audits="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID' AND target_type='event_subscription'
   AND action IN (
     'event_subscription.created','event_subscription.updated',
     'event_subscription.deleted','event_subscription.auto_disabled'
   );
SQL
)"
[ "$crud_audits" -ge "6" ] || fail "CRUD/automatic audit coverage"

pass "CRUD, one-time secret, SSRF, mention/approval delivery, retry, disable, audit, and RLS"
