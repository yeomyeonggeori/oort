#!/usr/bin/env bash
# MOMO-565: build one image and smoke all six top-level commands.
# Docker execution belongs to the orchestrator; workers may run static checks.
set -euo pipefail

fail() {
  printf '[multibinary-image] FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[multibinary-image] PASS: %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

wait_log() {
  local container="$1"
  local marker="$2"
  local deadline=$(( $(date -u +%s) + 90 ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    if docker logs "$container" 2>&1 | grep -Fq "$marker"; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  return 1
}

wait_http() {
  local url="$1"
  local deadline=$(( $(date -u +%s) + 90 ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

port_available() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "must run inside the repository"
cd "$REPO_ROOT"

need curl
need docker
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"

API_PORT="${MOMO565_API_PORT:-28240}"
LINKSHORT_PORT="${MOMO565_LINKSHORT_PORT:-28241}"
POSTGRES_PORT="${MOMO565_POSTGRES_PORT:-28242}"
METRICS_PORT="${MOMO565_METRICS_PORT:-28243}"
for port in "$API_PORT" "$LINKSHORT_PORT" "$POSTGRES_PORT" "$METRICS_PORT"; do
  port_available "$port" || fail "reserved verifier port is busy: $port"
done
pass "reserved ports 28240-28243 are available"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SLUG="$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
IMAGE="momo:multibinary-${SLUG}"
NETWORK="momo565-${SLUG}"
PG="momo565-pg-${SLUG}"
API="momo565-api-${SLUG}"
RELAY="momo565-relay-${SLUG}"
WORKER="momo565-worker-${SLUG}"
LINKSHORT="momo565-linkshort-${SLUG}"
WEB_VOLUME="momo565-web-${SLUG}"
TMP_ROOT="${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo565-multibinary}"
mkdir -p "$TMP_ROOT"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  docker rm -f "$API" "$RELAY" "$WORKER" "$LINKSHORT" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$WEB_VOLUME" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '[multibinary-image] building %s with swift:6.2-noble products and bundled web/migration assets\n' "$IMAGE"
docker build \
  -f infra/prod/docker/momo.Dockerfile \
  --build-arg SWIFT_IMAGE=swift:6.2-noble \
  -t "$IMAGE" \
  . 2>&1 | tee "$TMP_ROOT/build-${SLUG}.log"

docker run --rm --entrypoint /usr/bin/test "$IMAGE" -s /usr/share/licenses/momo/LICENSE
docker run --rm --entrypoint /usr/bin/test "$IMAGE" -s /usr/share/licenses/momo/NOTICE
pass "LICENSE and NOTICE are bundled"

docker network create "$NETWORK" >/dev/null
docker run -d --name "$PG" --network "$NETWORK" -p "127.0.0.1:${POSTGRES_PORT}:5432" \
  -e POSTGRES_DB=momo \
  -e POSTGRES_USER=momo \
  -e POSTGRES_PASSWORD=change-me-postgres \
  pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e >/dev/null
for _attempt in $(seq 1 60); do
  docker exec "$PG" pg_isready -U momo -d momo >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U momo -d momo >/dev/null 2>&1 || fail "PostgreSQL 18 did not become ready"

DB_OWNER_URL="postgres://momo:change-me-postgres@${PG}:5432/momo"
docker run --rm --network "$NETWORK" \
  -e DATABASE_URL="$DB_OWNER_URL" \
  -e MOMO_BOOTSTRAP_RUNTIME_ROLES=1 \
  -e MOMO_AGENT_SEED_MODE=none \
  "$IMAGE" migrate 2>&1 | tee "$TMP_ROOT/migrate-${SLUG}.log"
grep -Fq "IDEMPOTENCY_OK second-pass applied=0" "$TMP_ROOT/migrate-${SLUG}.log" ||
  fail "migrate command lost idempotency evidence"
pass "1/6 migrate command completed against PostgreSQL 18"

docker volume create "$WEB_VOLUME" >/dev/null
docker run --rm -v "${WEB_VOLUME}:/srv/momo-web" "$IMAGE" web-assets
docker run --rm -v "${WEB_VOLUME}:/srv/momo-web:ro" --entrypoint /usr/bin/test "$IMAGE" -s /srv/momo-web/index.html
pass "2/6 web-assets command populated the serving volume"

COMMON_ENV=(
  -e MOMO_ENV=internal-smoke
  -e CENT_API_URL=http://centrifugo.invalid:8000/api
  -e CENT_API_KEY=change-me-cent-api-key
  -e LOG_LEVEL=info
)
APP_DB_URL="postgres://momo_app:momo_app_dev_pw@${PG}:5432/momo"
RELAY_DB_URL="postgres://momo_relay:momo_relay_dev_pw@${PG}:5432/momo"
WORKER_DB_URL="postgres://momo_worker:momo_worker_dev_pw@${PG}:5432/momo"

docker run -d --name "$API" --network "$NETWORK" -p "127.0.0.1:${API_PORT}:8080" \
  "${COMMON_ENV[@]}" \
  -e HOST=0.0.0.0 -e PORT=8080 \
  -e DATABASE_URL="$APP_DB_URL" \
  -e JWT_HMAC=change-me-jwt-hmac \
  -e OUTBOUND_WEBHOOK_MASTER_KEY=change-me-outbound-webhook-master-key \
  -e CENT_TOKEN_HMAC=change-me-cent-token-hmac \
  -e CENT_PROXY_SECRET=change-me-cent-proxy-secret \
  -e MOMO_CENTRIFUGO_WS_URL=wss://rt.localhost/connection/websocket \
  -e AGENT_PROVIDER_MODE=internal-host-mock \
  -e AGENT_MODEL=hermes-agent \
  -e HERMES_BASE_URL=http://mock-hermes:8088/v1 \
  -e HERMES_API_KEY=change-me-hermes-bearer \
  "$IMAGE" api >/dev/null
wait_http "http://127.0.0.1:${API_PORT}/health" || {
  docker logs "$API" >&2 || true
  fail "api command did not serve /health"
}
pass "3/6 api command served /health on port 28240"

docker run -d --name "$RELAY" --network "$NETWORK" -p "127.0.0.1:${METRICS_PORT}:9091" \
  "${COMMON_ENV[@]}" \
  -e RELAY_DATABASE_URL="$RELAY_DB_URL" \
  -e OUTBOUND_WEBHOOK_MASTER_KEY=change-me-outbound-webhook-master-key \
  -e MOMO_METRICS_HOST=0.0.0.0 -e MOMO_METRICS_PORT=9091 \
  "$IMAGE" relay >/dev/null
wait_log "$RELAY" "outbox relay starting" || fail "relay command did not reach its start marker"
wait_http "http://127.0.0.1:${METRICS_PORT}/metrics" || fail "relay metrics endpoint did not start"
pass "4/6 relay command reached its runtime loop on port 28243"
docker rm -f "$RELAY" >/dev/null

docker run -d --name "$WORKER" --network "$NETWORK" -p "127.0.0.1:${METRICS_PORT}:9092" \
  "${COMMON_ENV[@]}" \
  -e RELAY_DATABASE_URL="$WORKER_DB_URL" \
  -e AGENT_PROVIDER_MODE=internal-host-mock \
  -e AGENT_MODEL=hermes-agent \
  -e HERMES_BASE_URL=http://mock-hermes:8088/v1 \
  -e HERMES_API_KEY=change-me-hermes-bearer \
  -e MEMORY_EXTRACTION_ENABLED=0 \
  -e MEMORY_EMBEDDING_ENABLED=0 \
  -e MOMO_METRICS_HOST=0.0.0.0 -e MOMO_METRICS_PORT=9092 \
  "$IMAGE" worker >/dev/null
# Cold images may still be initializing when the process container is created;
# wait for the worker's own marker before opening a short readiness window.
wait_log "$WORKER" "agent worker starting" || fail "worker command did not reach its start marker"
wait_http "http://127.0.0.1:${METRICS_PORT}/metrics" || fail "worker metrics endpoint did not start"
pass "5/6 worker command reached its runtime loop on port 28243"

docker run -d --name "$LINKSHORT" -p "127.0.0.1:${LINKSHORT_PORT}:28190" \
  -e MOMO_LINKSHORT_HOST=0.0.0.0 \
  -e MOMO_LINKSHORT_PORT=28190 \
  -e MOMO_LINKSHORT_TARGET_BASE_URL=http://app.localhost \
  "$IMAGE" linkshort >/dev/null
wait_http "http://127.0.0.1:${LINKSHORT_PORT}/healthz" || {
  docker logs "$LINKSHORT" >&2 || true
  fail "linkshort command did not serve /healthz"
}
pass "6/6 linkshort command served /healthz on port 28241"

printf '[multibinary-image] PASS: one image booted all six commands; ports 28240-28243\n'
