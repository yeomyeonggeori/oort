#!/usr/bin/env bash
# MOMO-648 / ADR-0139 D1 work-session idle lifecycle runtime gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for command_name in docker curl jq python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[work-session-idle] missing $command_name" >&2
    exit 1
  }
done

find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-idle-openssl.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" genpkey -algorithm ED25519 -out "$probe" >/dev/null 2>&1; then
      rm -f "$probe"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  rm -f "$probe"
  echo "[work-session-idle] no OpenSSL with Ed25519 support found" >&2
  exit 1
}
OPENSSL_BIN="$(find_openssl)"
new_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
now_ms() { python3 -c 'import time; print(time.time_ns() // 1_000_000)'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORK_SESSION_IDLE_GATE_PROJECT:-momo648worksessionidle}"
API_PORT="${WORK_SESSION_IDLE_GATE_API_PORT:-28230}"
CENT_PORT="${WORK_SESSION_IDLE_GATE_CENTRIFUGO_PORT:-28231}"
PG_PORT="${WORK_SESSION_IDLE_GATE_POSTGRES_PORT:-28232}"
PUSH_PORT="${WORK_SESSION_IDLE_GATE_PUSH_PORT:-28233}"
HERMES_PORT="${WORK_SESSION_IDLE_GATE_HERMES_PORT:-28234}"
BOOT_TIMEOUT="${WORK_SESSION_IDLE_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${WORK_SESSION_IDLE_GATE_ASSERT_TIMEOUT:-120}"
HOST_GRACE_SECONDS="${MOMO_HOST_OFFLINE_GRACE_S:-30}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-session-idle.XXXXXX")"

python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$PUSH_PORT" "$HERMES_PORT" <<'PY'
import socket
import sys
for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError as exc:
        raise SystemExit(f"[work-session-idle] reserved port {port} unavailable: {exc}")
    finally:
        sock.close()
PY

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
OWNER_ID="$(new_uuid)"
DEVICE_ID="$(new_uuid)"
OWNER_EMAIL="idle-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT" \
    PUSH_RELAY_PORT="$PUSH_PORT" HERMES_PORT="$HERMES_PORT" \
    MOMO_HOST_OFFLINE_GRACE_S="$HOST_GRACE_SECONDS" \
    NOTIFIER_POLL_INTERVAL_MS=100 \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --profile push "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORK_SESSION_IDLE_GATE_KEEP:-0}" = "1" ]; then
    echo "[work-session-idle] leaving '$PROJECT' up; evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-work-session-idle.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[work-session-idle] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PRIVATE_KEY="$TMP_DIR/work-host-private.pem"
PUBLIC_DER="$TMP_DIR/work-host-public.der"
"$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$PRIVATE_KEY" >/dev/null 2>&1
"$OPENSSL_BIN" pkey -in "$PRIVATE_KEY" -pubout -outform DER \
  -out "$PUBLIC_DER" >/dev/null 2>&1
PUBLIC_KEY="$(tail -c 32 "$PUBLIC_DER" | "$OPENSSL_BIN" base64 -A)"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" \
    -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[work-session-idle] booting isolated API/relay/push stack on 28230-28234"
compose up -d api relay mock-push-relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[work-session-idle] API health timeout" >&2
    exit 1
  fi
  sleep 2
done

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE workspace
   SET settings = jsonb_set(settings, '{work_session_idle_timeout_seconds}', '5'::jsonb)
 WHERE id='$WS_ID';
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Idle Owner', 'idle-owner-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID', '$OWNER_ID', 'owner');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner');
COMMIT;
SQL

OWNER_TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken')"

RESPONSE_STATUS=""
RESPONSE_BODY=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
host_api() {
  local method="$1" path="$2" host_id="$3" body="${4:-}"
  local sent_at payload signature out="$TMP_DIR/response.json"
  sent_at="$(now_ms)"
  payload="$TMP_DIR/work-host-request-$sent_at.txt"
  printf 'momo.work_host.request.v1\n%s\n%s\n%s\n%s\n%s' \
    "$method" "$path" "$WS_ID" "$host_id" "$sent_at" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$PRIVATE_KEY" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json'
    -H "Authorization: MomoHost $host_id"
    -H "X-Momo-Work-Host-Sent-At: $sent_at"
    -H "X-Momo-Work-Host-Signature: $signature")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[work-session-idle] FAIL $2: expected $1, got $RESPONSE_STATUS" >&2
    printf '%s\n' "$RESPONSE_BODY" >&2
    exit 1
  }
}

register_host() {
  local name="$1"
  api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-hosts" \
    "$(jq -cn --arg name "$name" --arg key "$PUBLIC_KEY" \
      '{scope:"member",type:"workd",displayName:$name,publicKey:$key,
        capabilities:{"tool.codex":true}}')"
  expect_status 201 "register $name"
  printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase'
}
create_session() {
  local host_id="$1" label="$2"
  api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions" \
    "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$host_id" --arg label "$label" \
      '{channelId:$channel,hostId:$host,tool:"codex",label:$label}')"
  expect_status 201 "create $label"
  printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase'
}
transition() {
  local host_id="$1" session_id="$2" body="$3" label="$4"
  local path="/v1/workspaces/$WS_ID/work-sessions/$session_id"
  host_api PATCH "$path" "$host_id" "$body"
  expect_status 200 "$label"
}

ROUNDTRIP_HOST="$(register_host 'Idle roundtrip host')"
TIMEOUT_HOST="$(register_host 'Idle timeout host')"
OFFLINE_HOST="$(register_host 'Idle offline host')"
ROUNDTRIP_SESSION="$(create_session "$ROUNDTRIP_HOST" 'Idle roundtrip')"
TIMEOUT_SESSION="$(create_session "$TIMEOUT_HOST" 'Idle timeout')"
OFFLINE_SESSION="$(create_session "$OFFLINE_HOST" 'Idle offline')"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/devices" \
  "$(jq -cn --arg id "$DEVICE_ID" \
    '{deviceId:$id,platform:"macos",appBuild:"648",apnsToken:("cd"*32),
      env:"sandbox",topic:"kim.dawn.momo.e2e"}')"
expect_status 201 "register push device"

run_sql <<SQL
UPDATE work_host SET last_seen_at=clock_timestamp()+interval '1 hour'
 WHERE id IN ('$ROUNDTRIP_HOST','$TIMEOUT_HOST','$OFFLINE_HOST');
SQL
compose up -d notifier

transition "$ROUNDTRIP_HOST" "$ROUNDTRIP_SESSION" \
  '{"status":"idle","exitCode":7}' "roundtrip running-to-idle"
transition "$ROUNDTRIP_HOST" "$ROUNDTRIP_SESSION" \
  '{"status":"running"}' "roundtrip idle-to-running"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.workSession.status == "running" and .workSession.exitCode == 7' >/dev/null

transition "$TIMEOUT_HOST" "$TIMEOUT_SESSION" \
  '{"status":"idle","exitCode":0}' "timeout running-to-idle"
transition "$OFFLINE_HOST" "$OFFLINE_SESSION" \
  '{"status":"idle","exitCode":2}' "offline running-to-idle"
run_sql <<SQL
UPDATE work_host SET last_seen_at=clock_timestamp()-interval '1 hour'
 WHERE id='$OFFLINE_HOST';
SQL

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_session
    WHERE id='$TIMEOUT_SESSION' AND status='ended'
      AND end_reason='idle_timeout' AND exit_code=0) || ':' ||
  (SELECT count(*) FROM work_session
    WHERE id='$OFFLINE_SESSION' AND status='orphaned' AND exit_code=2);
SQL
)"
  [ "$got" = "1:1" ] && break
  sleep 1
done
[ "${got:-0:0}" = "1:1" ] || {
  compose logs --tail 160 notifier >&2 || true
  echo "[work-session-idle] FAIL timeout/orphan transitions: ${got:-missing}" >&2
  exit 1
}

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.idle'
      AND payload->'data'->'payload'->>'session_id'
          IN ('$ROUNDTRIP_SESSION','$TIMEOUT_SESSION','$OFFLINE_SESSION')) || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.resumed-to-running'
      AND payload->'data'->'payload'->>'session_id'='$ROUNDTRIP_SESSION') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.ended'
      AND payload->'data'->'payload'->>'session_id'='$TIMEOUT_SESSION'
      AND payload->'data'->'payload'->>'end_reason'='idle_timeout') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.orphaned'
      AND payload->'data'->'payload'->>'session_id'='$OFFLINE_SESSION') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.session.idle'
      AND target_id IN ('$ROUNDTRIP_SESSION','$TIMEOUT_SESSION','$OFFLINE_SESSION')) || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.session.resumed-to-running'
      AND target_id='$ROUNDTRIP_SESSION') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.session.idle_timeout'
      AND target_id='$TIMEOUT_SESSION') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.session.orphaned'
      AND target_id='$OFFLINE_SESSION');
SQL
)"
[ "$got" = "3:1:1:1:3:1:1:1" ] || {
  echo "[work-session-idle] FAIL event/audit exact counts: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
SELECT count(*) FROM message
 WHERE props->>'kind'='work_session_idle'
   AND props->>'session_id' IN ('$ROUNDTRIP_SESSION','$TIMEOUT_SESSION','$OFFLINE_SESSION')
   AND body='작업 완료 — idle 대기'
   AND (props - ARRAY['kind','session_id','owner_member_id'])='{}'::jsonb;
SQL
)"
[ "$got" = "3" ] || {
  echo "[work-session-idle] FAIL completion messages or closed props: $got" >&2
  exit 1
}

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM push_dispatch_log l
JOIN message m ON m.id=l.message_id
WHERE m.props->>'kind'='work_session_idle'
  AND m.props->>'session_id' IN ('$ROUNDTRIP_SESSION','$TIMEOUT_SESSION','$OFFLINE_SESSION')
  AND l.member_id='$OWNER_ID' AND l.apns_status=200;
SQL
)"
  [ "$got" = "3" ] && break
  sleep 1
done
[ "${got:-0}" = "3" ] || {
  compose logs --tail 120 notifier mock-push-relay >&2 || true
  echo "[work-session-idle] FAIL completion push count: ${got:-0}" >&2
  exit 1
}
curl -fsS "http://127.0.0.1:$PUSH_PORT/received" | jq -e '
  [.received[]
   | select(.reason == "work_session_idle" and .category == "momo.work")
   | select(
       (keys - [
         "apns_token", "apns_env", "apns_topic", "collapse_id", "badge",
         "reason", "thread_id", "category", "approval_id", "channel_id",
         "message_id", "device_id", "member_id"
       ]) == []
     )
   | select(
       (has("body") or has("label") or has("session_id")
        or has("tool") or has("exit_code")) | not
     )]
  | length == 3' >/dev/null || {
  echo "[work-session-idle] FAIL id-only completion push envelope" >&2
  exit 1
}

echo "[work-session-idle] PASS REST roundtrip / offline-before-timeout / idle timeout / events / audit / id-only push"
