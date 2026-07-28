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

if [ "${WORK_HOST_SIGNING_GATE_PROVE_RED_BODY_DIGEST:-0}" = "1" ] \
  && [ "${WORK_HOST_SIGNING_GATE_RED_CHILD:-0}" != "1" ]; then
  RED_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-work-host-signing-red.XXXXXX")"
  RED_LOG="$RED_ROOT/red-proof.log"
  python3 - "$REPO_ROOT" "$RED_ROOT/repo" <<'PY'
import os
import shutil
import sys

source, destination = sys.argv[1:]
ignored = {".git", ".build", ".swiftpm", "DerivedData", "node_modules"}

def ignore(directory, names):
    return {
        name for name in names
        if name in ignored or name == ".env" or name.startswith(".env.")
    }

shutil.copytree(source, destination, ignore=ignore)
PY
  python3 - "$RED_ROOT/repo/server/Sources/MomoServer/Auth/WorkHostAuthenticator.swift" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
needle = """                .appending(bodyDigest)
                .appending("\\n")
"""
if source.count(needle) != 1:
    raise SystemExit("[work-session-idle] red proof mutation marker drifted")
path.write_text(source.replace(needle, "", 1))
PY
  set +e
  WORK_HOST_SIGNING_GATE_RED_CHILD=1 \
    bash "$RED_ROOT/repo/scripts/verify_work_session_idle.sh" >"$RED_LOG" 2>&1
  RED_STATUS=$?
  set -e
  if [ "$RED_STATUS" -eq 0 ] \
    || ! grep -q "FAIL body substitution with captured valid signature" "$RED_LOG"; then
    cat "$RED_LOG" >&2
    case "$RED_ROOT" in
      "${TMPDIR:-/tmp}"/momo-work-host-signing-red.*) rm -r -- "$RED_ROOT" ;;
    esac
    echo "[work-session-idle] FAIL body-digest red proof did not fail by name" >&2
    exit 1
  fi
  case "$RED_ROOT" in
    "${TMPDIR:-/tmp}"/momo-work-host-signing-red.*) rm -r -- "$RED_ROOT" ;;
  esac
  echo "[work-session-idle] PASS red proof: omitting body digest fails the named substitution assertion"
  exit 0
fi

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
prepare_host_request() {
  local method="$1" path="$2" host_id="$3" body="${4:-}"
  local body_hash payload
  SIGNED_METHOD="$method"
  SIGNED_PATH="$path"
  SIGNED_HOST_ID="$host_id"
  SIGNED_SENT_AT="$(now_ms)"
  SIGNED_REQUEST_ID="$(new_uuid | tr '[:upper:]' '[:lower:]')"
  body_hash="$(printf '%s' "$body" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $NF}')"
  payload="$TMP_DIR/work-host-request-$SIGNED_REQUEST_ID.txt"
  if [ "${WORK_HOST_SIGNING_GATE_RED_CHILD:-0}" = "1" ]; then
    printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s' \
      "$method" "$path" \
      "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
      "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
      "$SIGNED_SENT_AT" "$SIGNED_REQUEST_ID" >"$payload"
  else
    printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
    "$method" "$path" \
    "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
      "$SIGNED_SENT_AT" "$body_hash" "$SIGNED_REQUEST_ID" >"$payload"
  fi
  SIGNED_SIGNATURE="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$PRIVATE_KEY" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
}
send_prepared_host_request() {
  local body="${1:-}" out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$SIGNED_METHOD"
    -H 'Content-Type: application/json'
    -H "Authorization: MomoHost $SIGNED_HOST_ID"
    -H "X-Momo-Work-Host-Sent-At: $SIGNED_SENT_AT"
    -H "X-Momo-Work-Host-Signature: $SIGNED_SIGNATURE"
    -H "X-Momo-Work-Host-Request-ID: $SIGNED_REQUEST_ID")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$SIGNED_PATH")"
  RESPONSE_BODY="$(<"$out")"
}
host_api() {
  local method="$1" path="$2" host_id="$3" body="${4:-}"
  prepare_host_request "$method" "$path" "$host_id" "$body"
  send_prepared_host_request "$body"
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
      AND lower(payload->'data'->'payload'->>'session_id')
          IN (lower('$ROUNDTRIP_SESSION'),lower('$TIMEOUT_SESSION'),lower('$OFFLINE_SESSION'))) || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.resumed-to-running'
      AND lower(payload->'data'->'payload'->>'session_id')=lower('$ROUNDTRIP_SESSION')) || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.ended'
      AND lower(payload->'data'->'payload'->>'session_id')=lower('$TIMEOUT_SESSION')
      AND payload->'data'->'payload'->>'end_reason'='idle_timeout') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.orphaned'
      AND lower(payload->'data'->'payload'->>'session_id')=lower('$OFFLINE_SESSION')) || ':' ||
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
   AND lower(props->>'session_id') IN (lower('$ROUNDTRIP_SESSION'),lower('$TIMEOUT_SESSION'),lower('$OFFLINE_SESSION'))
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
  AND lower(m.props->>'session_id') IN (lower('$ROUNDTRIP_SESSION'),lower('$TIMEOUT_SESSION'),lower('$OFFLINE_SESSION'))
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
         "message_id", "device_id", "member_id",
         "schema", "server_id", "workspace_id", "device_platform"
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

# 서명 v2 보안 검사는 맨 끝에 둔다. 이 블록이 roundtrip 세션에 idle·running
# 전이를 한 번 더 얹으므로 위의 "세션당 정확히 1건" 개수 단정보다 먼저 돌면
# 그 단정의 의미가 흐려진다(실측: 3:1 기대에 4:2가 왔다).

SECURITY_PATH="/v1/workspaces/$WS_ID/work-sessions/$ROUNDTRIP_SESSION"
SECURITY_SIGNED_BODY='{"status":"idle","exitCode":7}'
prepare_host_request PATCH "$SECURITY_PATH" "$ROUNDTRIP_HOST" "$SECURITY_SIGNED_BODY"
SECURITY_REQUEST_ID="$SIGNED_REQUEST_ID"
send_prepared_host_request '{"status":"ended"}'
expect_status 401 "body substitution with captured valid signature"
send_prepared_host_request "$SECURITY_SIGNED_BODY"
expect_status 200 "normal v2 signed request"
send_prepared_host_request "$SECURITY_SIGNED_BODY"
expect_status 401 "same request ID replay"

run_sql <<SQL
UPDATE work_host_request
   SET consumed_at=clock_timestamp()-interval '11 minutes',
       expires_at=clock_timestamp()-interval '1 minute'
 WHERE workspace_id='$WS_ID'
   AND request_id=lower('$SECURITY_REQUEST_ID')::uuid;
SQL
transition "$ROUNDTRIP_HOST" "$ROUNDTRIP_SESSION" \
  '{"status":"running"}' "fresh request ID after replay rejection"
got="$(sql_value <<SQL
SELECT count(*) FROM work_host_request
 WHERE workspace_id='$WS_ID'
   AND request_id=lower('$SECURITY_REQUEST_ID')::uuid;
SQL
)"
[ "$got" = "0" ] || {
  echo "[work-session-idle] FAIL expired request ID cleanup: $got" >&2
  exit 1
}

echo "[work-session-idle] PASS body substitution / one-time request ID / cleanup / REST roundtrip / offline-before-timeout / idle timeout / events / audit / id-only push"
