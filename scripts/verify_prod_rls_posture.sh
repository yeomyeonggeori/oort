#!/usr/bin/env bash
# MOMO-554: prove the production compose API role actually enforces FORCE RLS.
set -euo pipefail

fail() {
  printf '[prod-rls-posture] FAIL: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "must run inside the repository"
cd "$REPO_ROOT"
need curl
need docker
need python3

# Reserved for #647. Do not auto-select ephemeral ports: collision detection is
# part of the parallel-worker contract.
POSTGRES_PORT=28170
API_PORT=28171
HTTP_PORT=28172
HTTPS_PORT=28173
python3 - "$POSTGRES_PORT" "$API_PORT" "$HTTP_PORT" "$HTTPS_PORT" <<'PY'
import socket
import sys

for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError as exc:
        raise SystemExit(f"reserved port {port} is unavailable: {exc}")
    finally:
        sock.close()
PY

RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
PROJECT="momo-554-prod-rls-${RUN_TAG//[^a-zA-Z0-9]/-}"
PROJECT="$(printf '%s' "$PROJECT" | tr '[:upper:]' '[:lower:]')"
TMP_ROOT="${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo-prod-rls-posture}"
mkdir -p "$TMP_ROOT"
ENV_FILE="$TMP_ROOT/prod-rls-${RUN_TAG}.env"
OVERRIDE_FILE="$TMP_ROOT/prod-rls-${RUN_TAG}.override.yml"
CONFIG_FILE="$TMP_ROOT/prod-rls-${RUN_TAG}.config.yml"
SUPERUSER_LOG="$TMP_ROOT/prod-rls-${RUN_TAG}.superuser.log"
PROD_COMPOSE="infra/prod/docker-compose.prod.yml"
SWIFT_DOCKERFILE="infra/prod/docker/swift-service.Dockerfile"
MIGRATE_DOCKERFILE="infra/prod/docker/internal-smoke-migrate.Dockerfile"
API_IMAGE="momo-api:internal-smoke-prod-rls-${RUN_TAG}"
MIGRATE_IMAGE="momo-migrate:internal-smoke-prod-rls-${RUN_TAG}"

cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=${PROJECT}
MOMO_ENV=internal-smoke
API_DOMAIN=localhost
REALTIME_DOMAIN=rt.localhost
MOMO_CENTRIFUGO_WS_URL=wss://rt.localhost/connection/websocket
ACME_EMAIL=ops@example.com
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
MOMO_IMAGE_TAG=internal-smoke-${RUN_TAG}
MOMO_API_IMAGE=${API_IMAGE}
MOMO_RELAY_IMAGE=momo-outbox-relay:internal-smoke-unused
MOMO_WORKER_IMAGE=momo-agent-worker:internal-smoke-unused
MOMO_MIGRATE_IMAGE=${MIGRATE_IMAGE}
MOMO_MOCK_HERMES_IMAGE=mock-hermes:internal-smoke-unused
MOMO_WEB_IMAGE=momo-web:internal-smoke-unused
MOMO_LINKSHORT_IMAGE=momo-linkshort:internal-smoke-unused
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
MOMO_BOOTSTRAP_RUNTIME_ROLES=0
REDIS_PASSWORD=change-me-redis
CENTRIFUGO_REDIS_ADDRESS=redis://:change-me-redis@redis:6379/0
CENT_TOKEN_HMAC=change-me-cent-token-hmac
CENT_API_KEY=change-me-cent-api-key
CENT_PROXY_SECRET=change-me-cent-proxy-secret
JWT_HMAC=change-me-jwt-hmac
OUTBOUND_WEBHOOK_MASTER_KEY=change-me-outbound-webhook-master-key
AGENT_PROVIDER_MODE=internal-host-mock
AGENT_MODEL=hermes-agent
HERMES_BASE_URL=http://mock-hermes:8088/v1
HERMES_API_KEY=change-me-hermes-bearer
EOF

set -a
# shellcheck disable=SC1090 # generated verifier-only env
. "$ENV_FILE"
set +a

cat > "$OVERRIDE_FILE" <<EOF
services:
  postgres:
    ports:
      - "127.0.0.1:${POSTGRES_PORT}:5432"
  api:
    pull_policy: never
    ports:
      - "127.0.0.1:${API_PORT}:8080"
  migrate:
    pull_policy: never
    environment:
      MOMO_BOOTSTRAP_RUNTIME_ROLES: "0"
  runtime-roles:
    pull_policy: never
EOF

compose() {
  docker compose --env-file "$ENV_FILE" -f "$PROD_COMPOSE" -f "$OVERRIDE_FILE" "$@"
}

cleanup() {
  compose down --remove-orphans --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

scripts/prod_env_preflight.sh --env-file "$ENV_FILE" --mode internal-smoke >/dev/null
compose config > "$CONFIG_FILE"
grep -Fq 'DATABASE_URL: postgres://momo_app:momo_app_dev_pw@postgres:5432/momo' "$CONFIG_FILE" ||
  fail "rendered prod API does not consume MOMO_APP_DATABASE_URL"
grep -Fq 'DATABASE_URL: postgres://momo:change-me-postgres@postgres:5432/momo' "$CONFIG_FILE" ||
  fail "rendered prod migrate does not consume MIGRATE_DATABASE_URL"
grep -Fq 'RELAY_DATABASE_URL: postgres://momo_worker:momo_worker_dev_pw@postgres:5432/momo' "$CONFIG_FILE" ||
  fail "rendered prod worker does not consume WORKER_DATABASE_URL"

printf '[prod-rls-posture] building API and migration images\n'
docker build -f "$SWIFT_DOCKERFILE" --build-arg PACKAGE_PATH=server --build-arg PRODUCT=MomoServer -t "$API_IMAGE" .
docker build -f "$MIGRATE_DOCKERFILE" -t "$MIGRATE_IMAGE" .

compose up -d --wait --wait-timeout 120 postgres
compose run --rm --no-deps runtime-roles
compose run --rm --no-deps migrate

role_ok="$(compose exec -T postgres psql "$MIGRATE_DATABASE_URL" -qAt --no-psqlrc -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) = 3 AND bool_and(NOT rolsuper AND CASE WHEN rolname = 'momo_app' THEN NOT rolbypassrls ELSE rolbypassrls END) FROM pg_roles WHERE rolname IN ('momo_app','momo_relay','momo_worker');")"
[ "$role_ok" = "t" ] || fail "runtime role posture query failed"

plugin_write="$(compose exec -T postgres psql "$MIGRATE_DATABASE_URL" -qAt --no-psqlrc -v ON_ERROR_STOP=1 -c \
  "SELECT has_table_privilege('momo_app', 'plugin_registry', 'INSERT,UPDATE,DELETE');")"
[ "$plugin_write" = "f" ] || fail "momo_app still has plugin_registry write privileges"

cross_count="$(compose exec -T postgres psql "$MOMO_APP_DATABASE_URL" -qAt --no-psqlrc -v ON_ERROR_STOP=1 -c \
  "BEGIN; SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000099'; SELECT count(*) FROM workspace; COMMIT;")"
[ "$cross_count" = "0" ] || fail "momo_app cross-workspace read returned $cross_count rows instead of zero"

if compose exec -T postgres psql "$MOMO_APP_DATABASE_URL" -q --no-psqlrc -v ON_ERROR_STOP=1 -c \
  "INSERT INTO plugin_registry(plugin_id,version,manifest,manifest_digest) VALUES ('momo554.forbidden','1.0.0','{}','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');" >/dev/null 2>&1; then
  fail "momo_app unexpectedly mutated plugin_registry"
fi

compose up -d --no-deps api
deadline=$(($(date +%s) + 90))
until curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || fail "momo_app API did not become healthy"
  sleep 1
done

compose stop api >/dev/null
set +e
docker compose --env-file "$ENV_FILE" -f "$PROD_COMPOSE" -f "$OVERRIDE_FILE" \
  run --rm --no-deps -e DATABASE_URL="$MIGRATE_DATABASE_URL" api >"$SUPERUSER_LOG" 2>&1 &
superuser_pid=$!
for _attempt in $(seq 1 30); do
  kill -0 "$superuser_pid" >/dev/null 2>&1 || break
  sleep 1
done
if kill -0 "$superuser_pid" >/dev/null 2>&1; then
  kill "$superuser_pid" >/dev/null 2>&1 || true
  wait "$superuser_pid" >/dev/null 2>&1 || true
  set -e
  fail "API stayed running with the PostgreSQL superuser URL"
fi
wait "$superuser_pid"
superuser_status=$?
set -e
if [ "$superuser_status" -eq 0 ]; then
  fail "API stayed running with the PostgreSQL superuser URL"
fi
grep -Eqi 'DatabaseSecurityPostureError|current_user must be momo_app|superuser|refusing to boot' "$SUPERUSER_LOG" ||
  fail "superuser refusal did not expose the expected fail-closed reason"

printf '[prod-rls-posture] PASS: prod compose API=momo_app, FORCE RLS isolation, catalog revoke, and superuser boot refusal verified on ports %s-%s\n' "$POSTGRES_PORT" "$HTTPS_PORT"
