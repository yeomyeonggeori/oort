#!/usr/bin/env bash
# MOMO-516 / ADR-0126 D1 observer terminal attach capability gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[observer-attach] missing $1" >&2
    exit 1
  }
}
need docker
need curl
need jq

find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-openssl-probe.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" genpkey -algorithm ED25519 -out "$probe" >/dev/null 2>&1; then
      rm -f "$probe"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  rm -f "$probe"
  echo "[observer-attach] no OpenSSL with Ed25519 support found" >&2
  exit 1
}
OPENSSL_BIN="$(find_openssl)"

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
  echo "[observer-attach] Python 3.10+ not found" >&2
  exit 1
}
PYTHON_BIN="$(find_python)"
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }
now_ms() { "$PYTHON_BIN" -c 'import time; print(time.time_ns() // 1_000_000)'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${OBSERVER_ATTACH_GATE_PROJECT:-momo516observerattach}"
API_PORT="${OBSERVER_ATTACH_GATE_API_PORT:-28010}"
CENT_PORT_HOST="${OBSERVER_ATTACH_GATE_CENTRIFUGO_PORT:-28011}"
PG_PORT="${OBSERVER_ATTACH_GATE_POSTGRES_PORT:-28012}"
HERMES_PORT_HOST="${OBSERVER_ATTACH_GATE_HERMES_PORT:-28013}"
BOOT_TIMEOUT="${OBSERVER_ATTACH_GATE_BOOT_TIMEOUT:-2400}"
RUN_TAG="$(date -u +%s)-$$"

check_reserved_ports() {
  "$PYTHON_BIN" - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket
import sys

for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
    except OSError as exc:
        raise SystemExit(f"[observer-attach] reserved port {port} is unavailable: {exc}")
    finally:
        sock.close()
PY
}
check_reserved_ports
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-observer-attach.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
OWNER_ID="$(new_uuid)"
OBSERVER_ID="$(new_uuid)"
OUTSIDER_ID="$(new_uuid)"
AGENT_ID="$(new_uuid)"
RUN_ID="$(new_uuid)"
OTHER_WS_ID="$(new_uuid)"
OWNER_EMAIL="observer-owner-$RUN_TAG@momo.local"
OBSERVER_EMAIL="observer-member-$RUN_TAG@momo.local"
OUTSIDER_EMAIL="observer-outsider-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-$(new_uuid)"
OBSERVER_PASSWORD="observer-$(new_uuid)"
OUTSIDER_PASSWORD="outsider-$(new_uuid)"
PTY_ID="pty-516-$RUN_TAG"
ATTACH_ENDPOINT="wss://workd.momo.test/v1/observer-terminal"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${OBSERVER_ATTACH_GATE_KEEP:-0}" = "1" ]; then
    echo "[observer-attach] leaving compose project '$PROJECT' up"
    echo "[observer-attach] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-observer-attach.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[observer-attach] refusing unexpected temp path: $TMP_DIR" >&2 ;;
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
BASE_URL="http://127.0.0.1:$API_PORT"

echo "[observer-attach] booting isolated api/relay stack '$PROJECT' on ports $API_PORT, $CENT_PORT_HOST, $PG_PORT, $HERMES_PORT_HOST"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[observer-attach] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    echo "[observer-attach] api exited" >&2
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
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Observer Owner', 'obo-$RUN_TAG'),
  ('$OBSERVER_ID', '$WS_ID', 'human', 'active', 'Observer Member', 'obm-$RUN_TAG'),
  ('$OUTSIDER_ID', '$WS_ID', 'human', 'active', 'Observer Outsider', 'obx-$RUN_TAG'),
  ('$AGENT_ID', '$WS_ID', 'agent', 'active', 'Observer Agent', 'oba-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$OBSERVER_ID', '$WS_ID', '$OBSERVER_EMAIL', true, momo_password_hash('$OBSERVER_PASSWORD'), 'UTC'),
  ('$OUTSIDER_ID', '$WS_ID', '$OUTSIDER_EMAIL', true, momo_password_hash('$OUTSIDER_PASSWORD'), 'UTC');
INSERT INTO agent
  (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES
  ('$AGENT_ID', '$WS_ID', 'hermes-agent', 'http://localhost:8088/v1',
   'MOMO-516 verifier', '$OWNER_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$OBSERVER_ID', 'member'),
  ('$WS_ID', '$CHANNEL_ID', '$AGENT_ID', 'member');
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input,
   step_count, max_steps, depth, idempotency_key)
VALUES
  ('$RUN_ID', '$WS_ID', '$AGENT_ID', '$CHANNEL_ID', 'running',
   '{"prompt":"observer attach"}'::jsonb, 1, 50, 0,
   'momo-516-$RUN_TAG');
COMMIT;
SQL

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
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
    "$method" "$path" \
    "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" >"$payload"
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
    echo "[observer-attach] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    printf '%s' "$RESPONSE_BODY" | jq \
      'del(.token,.accessToken,.refreshToken,.capability_token)' \
      >&2 2>/dev/null || echo "[observer-attach] non-JSON body redacted" >&2
    exit 1
  }
}
login() {
  local email="$1" password="$2"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$password" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}

OWNER_TOKEN="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
OBSERVER_TOKEN="$(login "$OBSERVER_EMAIL" "$OBSERVER_PASSWORD")"
OUTSIDER_TOKEN="$(login "$OUTSIDER_EMAIL" "$OUTSIDER_PASSWORD")"
HOSTS_PATH="/v1/workspaces/$WS_ID/work-hosts"

api "$OWNER_TOKEN" POST "$HOSTS_PATH" \
  "$(jq -cn --arg key "$PUBLIC_KEY" \
    '{scope:"member",type:"workd",displayName:"MOMO-516 observer PTY host",
      publicKey:$key,capabilities:{"tool.codex":true,"terminal_attach":true}}')"
expect_status 201 "terminal-capable host registration"
HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id | ascii_downcase')"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  '{"label":"MOMO-516 verifier"}'
expect_status 201 "agent bearer create"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"

api "$OWNER_TOKEN" PUT "/v1/workspaces/$WS_ID/work-auto-approvals/codex"
expect_status 200 "enable auto approve"
api "$AGENT_TOKEN" POST "/v1/workspaces/$WS_ID/work-controls" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg run "$RUN_ID" --arg host "$HOST_ID" \
    '{channelId:$channel,runId:$run,targetHostId:$host,kind:"spawn",
      payload:{tool:"codex",label:"MOMO-516 observer PTY"}}')"
expect_status 201 "remote PTY spawn dispatch"
CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id | ascii_downcase')"

SESSION_PATH="/v1/workspaces/$WS_ID/work-sessions"
host_api POST "$SESSION_PATH" "$HOST_ID" \
  "$(jq -cn --arg channel "$CHANNEL_ID" --arg host "$HOST_ID" \
    --arg control "$CONTROL_ID" --arg pty "$PTY_ID" --arg endpoint "$ATTACH_ENDPOINT" \
    '{channelId:$channel,hostId:$host,tool:"codex",label:"MOMO-516 observer PTY",
      controlId:$control,ptyId:$pty,attachEndpoint:$endpoint}')"
expect_status 201 "MomoHost remote PTY binding"
SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .workSession.observation == "open"
  and .workSession.observerGrantCount == 0
  and .workSession.remoteAttachAvailable == true
  and (.workSession.attachEndpoint == null)
  and (.workSession.capabilityToken == null)
' >/dev/null

ATTACH_PATH="$SESSION_PATH/$SESSION_ID/terminal-attach"
VALIDATE_PATH="$HOSTS_PATH/$HOST_ID/terminal-attach/validate"

api "$OWNER_TOKEN" POST "$ATTACH_PATH"
expect_status 200 "default controller capability issue"
CONTROLLER_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"
host_api POST "$VALIDATE_PATH" "$HOST_ID" \
  "$(jq -cn --arg token "$CONTROLLER_TOKEN" '{capability_token:$token}')"
expect_status 200 "controller validation"
printf '%s' "$RESPONSE_BODY" | jq -e '.mode == "controller"' >/dev/null

api "$OBSERVER_TOKEN" POST "$ATTACH_PATH" '{"mode":"observer"}'
expect_status 200 "channel member observer capability issue"
OBSERVER_CAPABILITY="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"
host_api POST "$VALIDATE_PATH" "$HOST_ID" \
  "$(jq -cn --arg token "$OBSERVER_CAPABILITY" '{capability_token:$token}')"
expect_status 200 "observer validation"
printf '%s' "$RESPONSE_BODY" | jq -e '.mode == "observer"' >/dev/null

api "$OWNER_TOKEN" GET "$SESSION_PATH?active=1"
expect_status 200 "observer count and remote attach projection"
printf '%s' "$RESPONSE_BODY" | jq -e --arg session "$SESSION_ID" '
  .workSessions[]
  | select((.id | ascii_downcase) == $session)
  | .observation == "open"
    and .observerGrantCount == 1
    and .remoteAttachAvailable == true
    and (.attachEndpoint == null)
    and (.capabilityToken == null)
' >/dev/null

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM terminal_attach_capability
    WHERE work_session_id='$SESSION_ID' AND mode='controller')
  || ':' ||
  (SELECT count(*) FROM terminal_attach_capability
    WHERE work_session_id='$SESSION_ID' AND mode='observer'
      AND owner_member_id='$OBSERVER_ID' AND expires_at > clock_timestamp())
  || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.observer'
      AND lower(payload->'data'->'payload'->>'session_id')='$SESSION_ID'
      AND payload->'data'->'payload'->>'observer_count'='1'
      AND (SELECT array_agg(k ORDER BY k)
             FROM jsonb_object_keys(payload->'data'->'payload') k)
          = ARRAY['observer_count','session_id']::text[]);
SQL
)"
[ "$got" = "1:1:1" ] || {
  echo "[observer-attach] FAIL mode ledger/count-only outbox: $got" >&2
  exit 1
}

api "$OUTSIDER_TOKEN" POST "$ATTACH_PATH" '{"mode":"observer"}'
expect_status 403 "non-channel member observer rejection"
api "$AGENT_TOKEN" POST "$ATTACH_PATH" '{"mode":"observer"}'
expect_status 403 "agent observer rejection"

api "$OWNER_TOKEN" PATCH "$SESSION_PATH/$SESSION_ID" '{"observation":"owner_only"}'
expect_status 200 "owner-only observation toggle"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .workSession.observation == "owner_only"
  and .workSession.observerGrantCount == 0
  and .workSession.remoteAttachAvailable == true
' >/dev/null
api "$OBSERVER_TOKEN" POST "$ATTACH_PATH" '{"mode":"observer"}'
expect_status 403 "owner-only blocks observer issue"
host_api POST "$VALIDATE_PATH" "$HOST_ID" \
  "$(jq -cn --arg token "$OBSERVER_CAPABILITY" '{capability_token:$token}')"
expect_status 401 "owner-only invalidates observer capability"

api "$OWNER_TOKEN" PATCH "$SESSION_PATH/$SESSION_ID" '{"observation":"open"}'
expect_status 200 "reopen observation"
api "$OBSERVER_TOKEN" POST "$ATTACH_PATH" '{"mode":"observer"}'
expect_status 200 "observer reissue after reopen"
REOPENED_CAPABILITY="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"

api "$OWNER_TOKEN" DELETE "$HOSTS_PATH/$HOST_ID"
expect_status 200 "host revoke"
host_api POST "$VALIDATE_PATH" "$HOST_ID" \
  "$(jq -cn --arg token "$REOPENED_CAPABILITY" '{capability_token:$token}')"
expect_status 401 "revoke immediately invalidates observer capability"

got="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM pg_class
    WHERE relname='terminal_attach_capability'
      AND relrowsecurity AND relforcerowsecurity)
  || ':' ||
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='work_session'
      AND column_name='observation')
  || ':' ||
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='terminal_attach_capability'
      AND column_name='mode');
SQL
)"
[ "$got" = "1:1:1" ] || {
  echo "[observer-attach] FAIL migration/RLS columns: $got" >&2
  exit 1
}

got="$(sql_value <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$OTHER_WS_ID';
SELECT count(*) FROM terminal_attach_capability WHERE workspace_id='$WS_ID';
COMMIT;
SQL
)"
[ "$got" = "0" ] || {
  echo "[observer-attach] FAIL cross-tenant capability RLS: $got" >&2
  exit 1
}

compose logs --no-color api relay >"$TMP_DIR/server-relay.log"
if grep -Fq "$CONTROLLER_TOKEN" "$TMP_DIR/server-relay.log" \
    || grep -Fq "$OBSERVER_CAPABILITY" "$TMP_DIR/server-relay.log" \
    || grep -Fq "$REOPENED_CAPABILITY" "$TMP_DIR/server-relay.log"; then
  echo "[observer-attach] FAIL raw capability entered logs" >&2
  exit 1
fi

echo "MOMO-516 observer attach controller/member/owner-only/mode/revoke/count/RLS PASS"
