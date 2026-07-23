#!/usr/bin/env bash
# =============================================================================
# scripts/verify_internal_host_runtime.sh — MOMO-220 host-runtime smoke
#
# Builds local image substitutes, boots prod + internal-smoke compose, and
# verifies the source-checkout-free single-node runtime path:
#   migrate idempotency -> /health -> REST send -> relay publish
#   -> @agent mention -> mock Hermes -> final channel message.new.
# =============================================================================
set -euo pipefail

fail() {
  echo "[host-runtime] FAIL: $*" >&2
  if [ "${COMPOSE_LOG:-}" != "" ] && [ -f "$COMPOSE_LOG" ]; then
    if [ "${ENV_FILE:-}" != "" ] && [ -f "${ENV_FILE:-}" ] && [ "${PROD_COMPOSE:-}" != "" ] && [ "${SMOKE_COMPOSE:-}" != "" ]; then
      docker compose --env-file "$ENV_FILE" -f "$PROD_COMPOSE" -f "$SMOKE_COMPOSE" logs --no-color > "$COMPOSE_LOG" 2>&1 || true
    fi
    echo "[host-runtime] compose ps:" >&2
    docker compose --env-file "$ENV_FILE" -f "$PROD_COMPOSE" -f "$SMOKE_COMPOSE" ps >&2 || true
    echo "[host-runtime] recent compose logs: $COMPOSE_LOG" >&2
    tail -240 "$COMPOSE_LOG" >&2 || true
  fi
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

wait_http() {
  local url="$1"
  local host_header="$2"
  local name="$3"
  local deadline
  deadline=$(($(date +%s) + 90))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -H "Host: ${host_header}" "$url" >/dev/null 2>&1; then
      echo "[host-runtime] ${name} ready: ${url}"
      return 0
    fi
    sleep 1
  done
  return 1
}

json_escape() {
  jq -Rn --arg v "$1" '$v'
}

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "must run inside a git repository"
fi
cd "$REPO_ROOT"

need curl
need docker
need jq
need python3
need uuidgen

PROD_COMPOSE="infra/prod/docker-compose.prod.yml"
SMOKE_COMPOSE="infra/prod/docker-compose.internal-smoke.yml"
ENV_TEMPLATE="infra/prod/internal-smoke.env.example"
MOMO_DOCKERFILE="infra/prod/docker/momo.Dockerfile"
MOCK_DOCKERFILE="infra/prod/docker/mock-hermes.Dockerfile"

for path in "$PROD_COMPOSE" "$SMOKE_COMPOSE" "$ENV_TEMPLATE" "$MOMO_DOCKERFILE" "$MOCK_DOCKERFILE"; do
  [ -f "$path" ] || fail "missing required file: $path"
done
[ -f "scripts/prod_env_preflight.sh" ] || fail "missing required file: scripts/prod_env_preflight.sh"

RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_SLUG="$(printf '%s' "$RUN_SUFFIX" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
PROJECT="momo-host-runtime-${RUN_SLUG}"
TAG_SUFFIX="$RUN_SLUG"
TMP_ROOT="${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo-host-runtime}"
mkdir -p "$TMP_ROOT"

ENV_FILE="$TMP_ROOT/internal-host-runtime-${RUN_SLUG}.env"
CONFIG_FILE="$TMP_ROOT/internal-host-runtime-compose-${RUN_SLUG}.yml"
COMPOSE_LOG="$TMP_ROOT/internal-host-runtime-compose-${RUN_SLUG}.log"
EVIDENCE_FILE="$TMP_ROOT/internal-host-runtime-evidence-${RUN_SLUG}.md"
MESSAGE_HISTORY_FILE="$TMP_ROOT/internal-host-runtime-history-message-${RUN_SLUG}.json"
AGENT_HISTORY_FILE="$TMP_ROOT/internal-host-runtime-history-agent-${RUN_SLUG}.json"
AGENT_STATUS_FILE="$TMP_ROOT/internal-host-runtime-agent-status-${RUN_SLUG}.json"

HTTP_PORT="$(
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
HTTPS_PORT="$(
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"

MOMO_IMAGE="momo:internal-smoke-${TAG_SUFFIX}"
MOCK_IMAGE="momo-mock-hermes:internal-smoke-${TAG_SUFFIX}"

cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=${PROJECT}
MOMO_ENV=internal-smoke
API_DOMAIN=localhost
REALTIME_DOMAIN=rt.localhost
MOMO_CENTRIFUGO_WS_URL=wss://rt.localhost/connection/websocket
ACME_EMAIL=ops@example.com
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
MOMO_IMAGE_TAG=internal-smoke-${TAG_SUFFIX}
MOMO_IMAGE=${MOMO_IMAGE}
MOMO_API_IMAGE=${MOMO_IMAGE}
MOMO_RELAY_IMAGE=${MOMO_IMAGE}
MOMO_WORKER_IMAGE=${MOMO_IMAGE}
MOMO_MIGRATE_IMAGE=${MOMO_IMAGE}
MOMO_WEB_IMAGE=${MOMO_IMAGE}
MOMO_LINKSHORT_IMAGE=${MOMO_IMAGE}
MOMO_MOCK_HERMES_IMAGE=${MOCK_IMAGE}
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=change-me-postgres
MIGRATE_DATABASE_URL=postgres://momo:change-me-postgres@postgres:5432/momo
MOMO_APP_POSTGRES_PASSWORD=momo_app_dev_pw
MOMO_APP_DATABASE_URL=postgres://momo_app:momo_app_dev_pw@postgres:5432/momo
DATABASE_URL=postgres://momo_app:momo_app_dev_pw@postgres:5432/momo
RELAY_POSTGRES_PASSWORD=momo_relay_dev_pw
RELAY_DATABASE_URL=postgres://momo_relay:momo_relay_dev_pw@postgres:5432/momo
WORKER_POSTGRES_PASSWORD=momo_worker_dev_pw
WORKER_DATABASE_URL=postgres://momo_worker:momo_worker_dev_pw@postgres:5432/momo
MOMO_BOOTSTRAP_RUNTIME_ROLES=1
REDIS_PASSWORD=change-me-redis
CENTRIFUGO_REDIS_ADDRESS=redis://:change-me-redis@redis:6379/0
CENT_TOKEN_HMAC=change-me-cent-token-hmac
CENT_API_KEY=change-me-cent-api-key
CENT_PROXY_SECRET=change-me-cent-proxy-secret
CENTRIFUGO_LOG_LEVEL=debug
JWT_HMAC=change-me-jwt-hmac
OUTBOUND_WEBHOOK_MASTER_KEY=change-me-outbound-webhook-master-key
LOG_LEVEL=debug
AGENT_PROVIDER_MODE=internal-host-mock
AGENT_MODEL=hermes-agent
AGENT_HANDLE=kim-intern
AGENT_DISPLAY_NAME=김인턴
HERMES_BASE_URL=http://mock-hermes:8088/v1
HERMES_API_KEY=change-me-hermes-bearer
RELAY_POLL_INTERVAL_MS=100
RELAY_CLAIM_BATCH=16
RELAY_MAX_ATTEMPTS=3
WORKER_POLL_INTERVAL_MS=100
WORKER_MAX_ATTEMPTS=3
MAX_CONSECUTIVE_AUTO=3
MAX_STEPS=12
MAX_DEPTH=4
MAX_CONCURRENT_RUNS=1
EOF

echo "[host-runtime] preflighting generated internal-smoke env"
scripts/prod_env_preflight.sh --env-file "$ENV_FILE" --mode internal-smoke

compose() {
  docker compose --env-file "$ENV_FILE" -f "$PROD_COMPOSE" -f "$SMOKE_COMPOSE" "$@"
}

cleanup() {
  compose down --remove-orphans --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "[host-runtime] evidence dir: $TMP_ROOT"
echo "[host-runtime] env file: $ENV_FILE"
echo "[host-runtime] compose project: $PROJECT"

echo "[host-runtime] rendering compose config"
compose config > "$CONFIG_FILE"

if grep -Fq "target: /workspace" "$CONFIG_FILE"; then
  fail "rendered internal host-runtime config must not bind-mount the source checkout"
fi
for image in "$MOMO_IMAGE" "$MOCK_IMAGE"; do
  grep -Fq "image: ${image}" "$CONFIG_FILE" || fail "rendered compose config missing local image: $image"
done

echo "[host-runtime] building one local multi-command image"
docker build \
  -f "$MOMO_DOCKERFILE" \
  -t "$MOMO_IMAGE" \
  . 2>&1 | tee "$TMP_ROOT/build-momo-${RUN_SLUG}.log"
docker build -f "$MOCK_DOCKERFILE" -t "$MOCK_IMAGE" . 2>&1 | tee "$TMP_ROOT/build-mock-hermes-${RUN_SLUG}.log"

echo "[host-runtime] booting prod + internal-smoke stack (install.sh 동형 시퀀스)"
# MOMO-316/565: 원샷(runtime-roles/migrate/web-init)은 install.sh처럼 `run --rm`으로
# 분리 실행한다 — `up --wait`는 exit-0 원샷을 실패로 판정하는 compose quirk가 있어
# (v5.x에서 재현, 리허설 Phase 1 검출) 상주 서비스에만 건다. 이 순서가 실제
# 설치 경로와도 동형이라 리허설 충실도도 올라간다.
{
  compose up -d --wait --wait-timeout 180 postgres redis centrifugo mock-hermes &&
  compose run --rm --no-deps runtime-roles &&
  compose run --rm --no-deps migrate &&
  compose run --rm --no-deps web-init &&
  compose up -d --wait --wait-timeout "${HOST_RUNTIME_WAIT_TIMEOUT:-600}" api relay worker linkshort caddy
} 2>&1 | tee "$COMPOSE_LOG" || fail "install-shaped boot sequence did not reach healthy state"

echo "[host-runtime] verifying app health through Caddy edge"
# MOMO-316: 이 wait_http 폴링은 유지한다 — Caddy "edge 라우팅"(host port 매핑 +
# Host 헤더 기반 reverse_proxy) 도달성은 컨테이너 내부 healthcheck로 표현하기
# 어렵다(Caddy가 localhost 사이트를 local-TLS 308 redirect로 처리해 in-container
# self-check이 brittle). api 자체의 HTTP 준비는 위 --wait healthcheck가 이미
# 보장하므로 이 폴링은 사실상 1회 curl로 끝나는 edge 계약 확인이다.
if ! wait_http "http://127.0.0.1:${HTTP_PORT}/health" "localhost" "Caddy edge /health"; then
  echo "[host-runtime] Caddy edge /health not ready; trying internal api route"
  compose exec -T mock-hermes python3 - <<'PY' >/dev/null || fail "internal api /health did not return 200"
import urllib.request
urllib.request.urlopen("http://api:8080/health", timeout=5).read()
PY
fi

echo "[host-runtime] verifying Centrifugo subscribe proxy is edge-denied (MOMO-300)"
# The subscribe proxy is internal-only (centrifugo -> api over the compose
# network) and excluded from API rate limiting; the Caddy edge must answer
# 403 for /v1/centrifugo/* so CENT_PROXY_SECRET cannot be brute-forced from
# the public edge. Checked on the HTTPS edge (the HTTP port only serves the
# local-TLS 308 redirect, see the /health comment above).
EDGE_PROXY_STATUS="$(curl -k -sS -o /dev/null -w '%{http_code}' \
  -H "Host: localhost" \
  -X POST \
  "https://localhost:${HTTPS_PORT}/v1/centrifugo/subscribe" || true)"
if [ "$EDGE_PROXY_STATUS" != "403" ]; then
  fail "Caddy edge must deny /v1/centrifugo/subscribe with 403 (got ${EDGE_PROXY_STATUS:-none})"
fi
echo "[host-runtime] PASS Caddy edge denies /v1/centrifugo/subscribe (403)"

echo "[host-runtime] verifying migration idempotency (single-run evidence)"
# MOMO-316: migrate 러너(scripts/migrate.sh)가 한 번의 컨테이너 실행 안에서
# apply→verify 2패스를 돌고 두 번째 패스의 skip 마커(IDEMPOTENCY_OK)를 남긴다.
# 별도 `compose run --rm migrate` 왕복을 없애고, 최초 부팅 때 완주한 migrate
# 컨테이너의 `compose logs`를 evidence로 캡처한다. verify 패스는 apply 패스와
# 동일한 skip 판정 루프를 재실행하므로 2-run 증명과 증명력이 동일하다.
compose logs --no-color migrate > "$TMP_ROOT/migrate-idempotency-${RUN_SLUG}.log" 2>&1 || true
if ! grep -Fq "IDEMPOTENCY_OK second-pass applied=0" "$TMP_ROOT/migrate-idempotency-${RUN_SLUG}.log"; then
  fail "migrate logs did not show single-run idempotency evidence (IDEMPOTENCY_OK marker)"
fi
if ! grep -Fq "스킵" "$TMP_ROOT/migrate-idempotency-${RUN_SLUG}.log"; then
  fail "migrate logs did not show idempotency skip evidence"
fi

BASE_URL="https://localhost:${HTTPS_PORT}"
WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
AGENT_CHANNEL_ID="00000000-0000-7000-8000-000000000202"
AGENT_ID="00000000-0000-7000-8000-000000000102"
CENT_GENERAL_CHANNEL="ch:ws${WORKSPACE_ID}.${GENERAL_CHANNEL_ID}"
CENT_AGENT_LAB_CHANNEL="ch:ws${WORKSPACE_ID}.${AGENT_CHANNEL_ID}"
AGENT_PROGRESS_CHANNEL="agent:ws${WORKSPACE_ID}.${AGENT_CHANNEL_ID}.${AGENT_ID}"
CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
AGENT_CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

echo "[host-runtime] verifying Kim Intern runtime status projection"
curl -kfsS \
  -H "Host: localhost" \
  "${BASE_URL}/v1/agent-runtime/status" > "$AGENT_STATUS_FILE"
if ! jq -e '
    .schema == "momo.agent_runtime.status.v0"
    and .agentHandle == "kim-intern"
    and .mode == "internal-host-mock"
    and .availability == "mock"
    and .endpointLabel == "http://mock-hermes:8088/v1"
    and .keyConfigured == false
  ' "$AGENT_STATUS_FILE" >/dev/null; then
  fail "agent runtime status projection did not report internal-host mock safely: $(cat "$AGENT_STATUS_FILE")"
fi
if grep -Fq "change-me-hermes-bearer" "$AGENT_STATUS_FILE"; then
  fail "agent runtime status projection leaked HERMES_API_KEY"
fi

echo "[host-runtime] logging in seeded demo user"
LOGIN_JSON="$(
  curl -kfsS \
    -H "Host: localhost" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"demo@momo.local\",\"password\":\"dev-password\",\"workspace\":\"${WORKSPACE_ID}\"}" \
    "${BASE_URL}/v1/auth/login"
)"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken // empty')"
[ "$ACCESS_TOKEN" != "" ] || fail "login did not return an access token: ${LOGIN_JSON}"

echo "[host-runtime] sending REST message and waiting for relay publish"
SEND_BODY="MOMO-220 host-runtime relay smoke ${RUN_SUFFIX}"
SEND_JSON="$(
  curl -kfsS \
    -H "Host: localhost" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"clientMsgId\":\"${CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":$(json_escape "$SEND_BODY"),\"props\":{\"gate\":\"MOMO-220\",\"path\":\"host-runtime\"}}" \
    "${BASE_URL}/v1/workspaces/${WORKSPACE_ID}/channels/${GENERAL_CHANNEL_ID}/messages"
)"
MESSAGE_ID="$(printf '%s' "$SEND_JSON" | jq -r '.id // empty')"
MESSAGE_SEQ="$(printf '%s' "$SEND_JSON" | jq -r '.seq // empty')"
[ "$MESSAGE_ID" != "" ] && [ "$MESSAGE_SEQ" != "" ] && [ "$MESSAGE_SEQ" != "null" ] || fail "message send response missing id/seq: $SEND_JSON"

RELAY_OK=0
deadline=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$deadline" ]; do
  compose exec -T mock-hermes python3 - "$CENT_GENERAL_CHANNEL" > "$MESSAGE_HISTORY_FILE" <<'PY' || true
import json, sys, urllib.request
channel = sys.argv[1]
req = urllib.request.Request(
    "http://centrifugo:8000/api/history",
    data=json.dumps({"channel": channel, "limit": 100}).encode(),
    headers={"Content-Type": "application/json", "X-API-Key": "change-me-cent-api-key"},
    method="POST",
)
print(urllib.request.urlopen(req, timeout=5).read().decode())
PY
  if jq -e --arg id "$MESSAGE_ID" --argjson seq "$MESSAGE_SEQ" '
    [.result.publications[]?.data
      | select(.type == "message.new")
      | select(.payload.id == $id)
      | select(.payload.seq == $seq)
      | select(.seq == $seq)] | length > 0
  ' "$MESSAGE_HISTORY_FILE" >/dev/null 2>&1; then
    RELAY_OK=1
    break
  fi
  sleep 1
done
[ "$RELAY_OK" = "1" ] || fail "relay publish history did not include message $MESSAGE_ID seq=$MESSAGE_SEQ"

echo "[host-runtime] sending @agent mention and waiting for mock Hermes roundtrip"
AGENT_BODY="@김인턴 MOMO-220 host-runtime mock Hermes 왕복 확인"
AGENT_SEND_JSON="$(
  curl -kfsS \
    -H "Host: localhost" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"clientMsgId\":\"${AGENT_CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":$(json_escape "$AGENT_BODY"),\"props\":{\"gate\":\"MOMO-220\",\"path\":\"host-runtime-agent\"}}" \
    "${BASE_URL}/v1/workspaces/${WORKSPACE_ID}/channels/${AGENT_CHANNEL_ID}/messages"
)"
AGENT_TRIGGER_MESSAGE_ID="$(printf '%s' "$AGENT_SEND_JSON" | jq -r '.id // empty')"
[ "$AGENT_TRIGGER_MESSAGE_ID" != "" ] || fail "agent mention send response missing id: $AGENT_SEND_JSON"

AGENT_OK=0
AGENT_RUN_ID=""
deadline=$(($(date +%s) + 120))
while [ "$(date +%s)" -lt "$deadline" ]; do
  compose exec -T postgres psql "postgres://momo:change-me-postgres@postgres:5432/momo" \
    -v ON_ERROR_STOP=1 --no-psqlrc -t -A -F $'\t' \
    -c "SELECT id, status FROM agent_run WHERE trigger_message_id='${AGENT_TRIGGER_MESSAGE_ID}' ORDER BY created_at DESC LIMIT 1;" \
    > "$TMP_ROOT/agent-run-${RUN_SLUG}.tsv" 2>/dev/null || true
  if [ -s "$TMP_ROOT/agent-run-${RUN_SLUG}.tsv" ]; then
    IFS=$'\t' read -r AGENT_RUN_ID AGENT_RUN_STATUS < "$TMP_ROOT/agent-run-${RUN_SLUG}.tsv" || true
  fi
  compose exec -T mock-hermes python3 - "$CENT_AGENT_LAB_CHANNEL" "$AGENT_PROGRESS_CHANNEL" > "$AGENT_HISTORY_FILE" <<'PY' || true
import json, sys, urllib.request
channels = sys.argv[1:]
out = {}
for channel in channels:
    req = urllib.request.Request(
        "http://centrifugo:8000/api/history",
        data=json.dumps({"channel": channel, "limit": 100}).encode(),
        headers={"Content-Type": "application/json", "X-API-Key": "change-me-cent-api-key"},
        method="POST",
    )
    out[channel] = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())
print(json.dumps(out))
PY
  if [ "${AGENT_RUN_STATUS:-}" = "succeeded" ] \
    && jq -e --arg run "$AGENT_RUN_ID" --arg channel "$CENT_AGENT_LAB_CHANNEL" '
      .[$channel].result.publications
      | [.[]?.data
        | select(.type == "message.new")
        | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
        | select(.payload.type == "text")
        | select((.payload.body // "") | contains("MOMO-004 SSE path verified"))]
      | length > 0
    ' "$AGENT_HISTORY_FILE" >/dev/null 2>&1 \
    && jq -e --arg run "$AGENT_RUN_ID" --arg channel "$AGENT_PROGRESS_CHANNEL" '
      .[$channel].result.publications
      | [.[]?.data
        | select(.type == "agent.partial")
        | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))]
      | length > 0
    ' "$AGENT_HISTORY_FILE" >/dev/null 2>&1; then
    AGENT_OK=1
    break
  fi
  sleep 1
done
if [ "$AGENT_OK" != "1" ]; then
  echo "[host-runtime] diagnostics: run status=${AGENT_RUN_STATUS:-unknown}; worker/api tail follows" >&2
  compose logs --tail 80 worker api >&2 || true
  fail "mock Hermes agent roundtrip did not complete for trigger message $AGENT_TRIGGER_MESSAGE_ID run=${AGENT_RUN_ID:-unknown}"
fi

compose logs --no-color > "$COMPOSE_LOG" 2>&1 || true

{
  echo "## MOMO-220 Internal Host-Runtime Evidence"
  echo "- Result: PASS"
  echo "- Compose project: \`${PROJECT}\`"
  echo "- Env file: \`${ENV_FILE}\`"
  echo "- Compose config: \`${CONFIG_FILE}\`"
  echo "- Images:"
  echo "  - momo (api/relay/worker/migrate/linkshort/web-assets 단일): \`${MOMO_IMAGE}\`"
  echo "  - mock Hermes: \`${MOCK_IMAGE}\`"
  echo "- Health: install.sh 동형 시퀀스(기반 서비스 --wait → 원샷 run --rm → 앱 서비스 --wait)로 api /health healthy 도달; Caddy/internal API \`/health\` 200"
  echo "- Agent runtime status: \`/v1/agent-runtime/status\` reported internal-host-mock/mock without leaking provider secrets"
  echo "- Migration: single migrate container run performed apply + idempotent re-apply (MOMO-316 1-run); \`compose logs migrate\` captured \`IDEMPOTENCY_OK second-pass applied=0\` skip evidence"
  echo "- REST message: message_id=\`${MESSAGE_ID}\`, seq=\`${MESSAGE_SEQ}\`, client_msg_id=\`${CLIENT_MSG_ID}\`, channel=\`${CENT_GENERAL_CHANNEL}\`"
  echo "- Relay publish: Centrifugo history contains matching \`message.new\` with \`seq=${MESSAGE_SEQ}\`"
  echo "- Agent mock: trigger_message_id=\`${AGENT_TRIGGER_MESSAGE_ID}\`, run_id=\`${AGENT_RUN_ID}\`, channel=\`${CENT_AGENT_LAB_CHANNEL}\`, progress=\`${AGENT_PROGRESS_CHANNEL}\`"
  echo "- Logs/evidence:"
  echo "  - compose log: \`${COMPOSE_LOG}\`"
  echo "  - agent status: \`${AGENT_STATUS_FILE}\`"
  echo "  - relay history: \`${MESSAGE_HISTORY_FILE}\`"
  echo "  - agent history: \`${AGENT_HISTORY_FILE}\`"
  echo "- Not covered: public TLS/DNS, real registry pull, SOPS prod secret injection, pgBackRest PITR restore remain \`runtime-unverified(public host)\`."
} > "$EVIDENCE_FILE"

cat "$EVIDENCE_FILE"
echo "[host-runtime] MOMO-220 internal host-runtime smoke PASS"
