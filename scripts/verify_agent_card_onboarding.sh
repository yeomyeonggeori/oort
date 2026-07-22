#!/usr/bin/env bash
# MOMO-536 / ADR-0130 D4 A2A Agent Card onboarding runtime verifier.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[agent-card] missing $1" >&2
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
  echo "[agent-card] Python 3.10+ not found" >&2
  return 1
}
PYTHON_BIN="$(find_python)"

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
# 고정 프로젝트명은 이전 실패 런의 컨테이너/캐시를 재사용해 stale 소스 컴파일
# 오류를 만든다(2026-07-22 실측) — run-tag로 격리한다.
PROJECT="${AGENT_CARD_GATE_PROJECT:-momo536agentcard-$$-$(date +%s)}"
API_PORT="${AGENT_CARD_GATE_API_PORT:-28124}"
CENT_PORT_HOST="${AGENT_CARD_GATE_CENTRIFUGO_PORT:-28125}"
PG_PORT="${AGENT_CARD_GATE_POSTGRES_PORT:-28126}"
HERMES_PORT_HOST="${AGENT_CARD_GATE_HERMES_PORT:-28127}"
CARD_PORT_HOST="${AGENT_CARD_GATE_MOCK_PORT:-28128}"
BOOT_TIMEOUT="${AGENT_CARD_GATE_BOOT_TIMEOUT:-2400}"
RUN_TAG="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-card.XXXXXX")"
OVERRIDE_FILE="$TMP_DIR/agent-card.override.yml"
CARD_ROOT="$TMP_DIR/cards"
mkdir -p "$CARD_ROOT/.well-known"

# The mock occupies an isolated test-only public-shaped subnet. This keeps the
# production SSRF validator fully active: no loopback/private bypass exists.
"$PYTHON_BIN" - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" "$CARD_PORT_HOST" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(set(ports)) != len(ports):
    raise SystemExit(f"[agent-card] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as exc:
    raise SystemExit(f"[agent-card] port preflight failed: {exc}")
finally:
    for sock in sockets:
        sock.close()
PY

"$PYTHON_BIN" - "$CARD_ROOT/.well-known/agent-card.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "name": "MOMO Card Agent",
    "description": "A2A v0.3 verifier agent",
    "url": "http://11.24.0.2:8089/a2a",
    "capabilities": {"streaming": True, "pushNotifications": False},
    "securitySchemes": {
        "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
    },
    "security": [{"bearer": []}],
    "skills": [{"id": "summarize", "name": "Summarize"}],
}), encoding="utf-8")
PY

cat >"$OVERRIDE_FILE" <<YAML
services:
  api:
    environment:
      MOMO_ENV: local
      MOMO_AGENT_CARD_ALLOW_HTTP: "1"
    networks:
      - default
      - agent-card-public-test
  mock-agent-card:
    image: python:3.12-slim
    restart: "no"
    working_dir: /cards
    command: ["python3", "-m", "http.server", "8089", "--bind", "0.0.0.0"]
    ports:
      - "${CARD_PORT_HOST}:8089"
    volumes:
      - "${CARD_ROOT}:/cards:ro"
    networks:
      agent-card-public-test:
        ipv4_address: 11.24.0.2
networks:
  agent-card-public-test:
    ipam:
      config:
        - subnet: 11.24.0.0/24
YAML

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${AGENT_CARD_GATE_KEEP:-0}" = "1" ]; then
    echo "[agent-card] leaving compose project '$PROJECT' up"
    echo "[agent-card] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-agent-card.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[agent-card] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "[agent-card] FAIL $*" >&2; exit 1; }
pass() { echo "[agent-card] PASS $*"; }

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
PASSWORD="agent-card-$RUN_TAG"

echo "[agent-card] booting isolated API + Python Agent Card mock '$PROJECT'"
compose up -d api mock-agent-card
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api migrate db-roles mock-agent-card >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done
curl -fsS "http://127.0.0.1:$CARD_PORT_HOST/.well-known/agent-card.json" >/dev/null

run_sql() {
  compose exec -T postgres psql \
    -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

# Inherited verifier discipline: assert the demo row before replacing its
# development password, rather than assuming seed shape.
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

REGISTER_PATH="/v1/workspaces/$WS_ID/agents/from-card"
before_count="$(sql_value <<SQL
SELECT count(*) FROM agent_card_registration WHERE workspace_id='$WS_ID';
SQL
)"
api POST "$REGISTER_PATH" '{"url":"http://127.0.0.1:28128"}'
expect_status 400 "loopback SSRF rejection"
after_denial_count="$(sql_value <<SQL
SELECT count(*) FROM agent_card_registration WHERE workspace_id='$WS_ID';
SQL
)"
[ "$before_count" = "$after_denial_count" ] || fail "SSRF denial persisted a registration"

api POST "$REGISTER_PATH" '{"url":"http://11.24.0.2:8089"}'
expect_status 201 "Agent Card fetch and pending consent"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .registration.status == "pending_consent"
  and .registration.name == "MOMO Card Agent"
  and .registration.capabilities.streaming == true
  and .registration.securitySchemes.schemes.bearer.scheme == "bearer"
  and .registration.agentMemberId == null
' >/dev/null
REGISTRATION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.registration.id | ascii_downcase')"

pending_rows="$(sql_value <<SQL
SELECT count(*) FROM agent_card_registration
 WHERE workspace_id='$WS_ID' AND id='$REGISTRATION_ID'
   AND status='pending_consent' AND agent_member_id IS NULL
   AND raw_card->>'name'='MOMO Card Agent'
   AND raw_card->'securitySchemes'->'bearer'->>'scheme'='bearer';
SQL
)"
[ "$pending_rows" = "1" ] || fail "pending ledger/raw JSON assertion"

api POST "$REGISTER_PATH/$REGISTRATION_ID/confirm" '{}'
expect_status 201 "pending consent confirmation"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .status == "confirmed" and .agent.id != null
  and .credential.agentMemberId == .agent.id
  and .credential.status == "active"
  and .tokenType == "Bearer" and (.token | length) > 20
' >/dev/null
AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.agent.id | ascii_downcase')"
CREDENTIAL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential.id | ascii_downcase')"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"

confirmed_rows="$(run_sql -v raw_token="$AGENT_TOKEN" -tA <<SQL
SELECT
  (SELECT count(*) FROM agent_card_registration
    WHERE workspace_id='$WS_ID' AND id='$REGISTRATION_ID' AND status='confirmed'
      AND lower(agent_member_id::text)=lower('$AGENT_ID') AND confirmed_at IS NOT NULL)
  * (SELECT count(*) FROM member
      WHERE workspace_id='$WS_ID' AND lower(id::text)=lower('$AGENT_ID')
        AND kind='agent' AND status='active')
  * (SELECT count(*) FROM agent
      WHERE workspace_id='$WS_ID' AND lower(member_id::text)=lower('$AGENT_ID')
        AND model='a2a-remote' AND base_url='http://11.24.0.2:8089/a2a')
  * (SELECT count(*) FROM workspace_membership
      WHERE workspace_id='$WS_ID' AND lower(member_id::text)=lower('$AGENT_ID'))
  * (SELECT count(*) FROM token
      WHERE workspace_id='$WS_ID' AND lower(id::text)=lower('$CREDENTIAL_ID')
        AND lower(actor_member_id::text)=lower('$AGENT_ID')
        AND kind='agent_bearer' AND token_hash=digest(:'raw_token','sha256'))
  * (SELECT count(*) FROM audit_log
      WHERE workspace_id='$WS_ID' AND action='agent.card.confirmed'
        AND lower(target_id::text)=lower('$REGISTRATION_ID'))
  * (SELECT count(*) FROM audit_log
      WHERE workspace_id='$WS_ID' AND action='agent.credential.issued'
        AND lower(target_id::text)=lower('$CREDENTIAL_ID'));
SQL
)"
confirmed_rows="$(printf '%s' "$confirmed_rows" | tr -d '[:space:]')"
[ "$confirmed_rows" = "1" ] || fail "member/credential/audit atomic confirmation assertion"

roster_json="$(curl -fsS "$BASE_URL/v1/workspaces/$WS_ID/roster?kind=agent" \
  -H "Authorization: Bearer $TOKEN")"
printf '%s' "$roster_json" | jq -e --arg agent "$AGENT_ID" '
  any(.members[]; ((.id | ascii_downcase) == $agent and .origin == "card"))
' >/dev/null || fail "roster card origin projection"

rls_rows="$(compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres psql \
  -h 127.0.0.1 -U momo_app -d "${POSTGRES_DB:-momo}" \
  -v ON_ERROR_STOP=1 --no-psqlrc -qtA <<SQL
BEGIN;
SET LOCAL app.workspace_id = '53600000-0000-7000-8000-000000000099';
SELECT count(*) FROM agent_card_registration WHERE id='$REGISTRATION_ID';
ROLLBACK;
SQL
)"
rls_rows="$(printf '%s' "$rls_rows" | tr -d '[:space:]')"
[ "$rls_rows" = "0" ] || fail "FORCE RLS exposed registration cross-workspace"

# The one-time bearer must exist only as a digest; neither card raw JSON nor
# audit metadata may retain it.
secret_leaks="$(run_sql -v raw_token="$AGENT_TOKEN" -tA <<SQL
SELECT
  (SELECT count(*) FROM agent_card_registration WHERE position(:'raw_token' in raw_card::text) > 0)
  + (SELECT count(*) FROM audit_log WHERE position(:'raw_token' in detail::text) > 0);
SQL
)"
secret_leaks="$(printf '%s' "$secret_leaks" | tr -d '[:space:]')"
[ "$secret_leaks" = "0" ] || fail "raw credential leaked into card/audit ledger"

pass "from-card -> pending -> confirm, credential, audit, roster origin, SSRF, and RLS"
