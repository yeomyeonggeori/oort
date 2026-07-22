#!/usr/bin/env bash
# MOMO-538: compose drift checks plus an isolated eve/Postgres-world smoke.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
DEV_COMPOSE="$REPO_ROOT/infra/docker-compose.yml"
PROD_COMPOSE="$REPO_ROOT/infra/prod/docker-compose.prod.yml"
PROD_ENV="$REPO_ROOT/infra/prod/.env.example"
PROJECT_NAME="momo538$$"
EVE_PORT=${EVE_PROFILE_PORT:-28140}
POSTGRES_PORT=${EVE_PROFILE_POSTGRES_PORT:-28141}
CENT_PORT=${EVE_PROFILE_CENT_PORT:-28142}
POSTGRES_PASSWORD="momo-538-postgres"
EVE_WORLD_PASSWORD="momo-538-eve-world"
CONFIG_ONLY=0

if [ "${1:-}" = "--config-only" ]; then
  CONFIG_ONLY=1
elif [ "$#" -ne 0 ]; then
  echo "usage: scripts/verify_eve_profile.sh [--config-only]" >&2
  exit 2
fi

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[eve-profile] missing required command: $1" >&2
    exit 1
  }
}

fail() {
  echo "[eve-profile] FAIL: $*" >&2
  exit 1
}

require_bin docker
require_bin jq

DEV_OFF=$(mktemp "${TMPDIR:-/tmp}/momo-eve-dev-off.XXXXXX")
DEV_ON=$(mktemp "${TMPDIR:-/tmp}/momo-eve-dev-on.XXXXXX")
PROD_OFF=$(mktemp "${TMPDIR:-/tmp}/momo-eve-prod-off.XXXXXX")
PROD_ON=$(mktemp "${TMPDIR:-/tmp}/momo-eve-prod-on.XXXXXX")

cleanup_files() {
  rm -f "$DEV_OFF" "$DEV_ON" "$PROD_OFF" "$PROD_ON"
}
trap cleanup_files EXIT INT TERM

echo "[eve-profile] rendering dev/prod profile contracts"
CENT_TOKEN_HMAC=momo-538-config CENT_API_KEY=momo-538-config \
  docker compose -f "$DEV_COMPOSE" config --format json >"$DEV_OFF"
CENT_TOKEN_HMAC=momo-538-config CENT_API_KEY=momo-538-config \
  docker compose -f "$DEV_COMPOSE" --profile eve config --format json >"$DEV_ON"
docker compose --env-file "$PROD_ENV" -f "$PROD_COMPOSE" config --format json >"$PROD_OFF"
docker compose --env-file "$PROD_ENV" -f "$PROD_COMPOSE" --profile eve config --format json >"$PROD_ON"

for rendered in "$DEV_OFF" "$PROD_OFF"; do
  jq -e '.services.eve == null and .services["eve-db-roles"] == null' "$rendered" >/dev/null \
    || fail "eve services rendered without the eve profile: $rendered"
done
for rendered in "$DEV_ON" "$PROD_ON"; do
  jq -e '
    .services.eve.profiles == ["eve"] and
    .services["eve-db-roles"].profiles == ["eve"] and
    .services.eve.image == "node:24.4.1-bookworm-slim@sha256:36ae19f59c91f3303c7a648f07493fe14c4bd91320ac8d898416327bacf1bbfa" and
    .services.eve.environment.WORKFLOW_TARGET_WORLD == "@workflow/world-postgres" and
    (.services.eve.environment.WORKFLOW_POSTGRES_URL | contains("/eve_world")) and
    .services.eve.environment.DATABASE_URL == null and
    .services.eve.environment.MOMO_AGENT_TOKEN != null and
    .services.eve.environment.MOMO_CHANNEL_ROUTE_TOKEN != null and
    .services.eve.healthcheck != null
  ' "$rendered" >/dev/null || fail "eve pin/world/credential contract drifted: $rendered"
done

# Selecting a profile may add services, but may not rewrite the default stack.
jq -S '.services | {postgres, centrifugo}' "$DEV_OFF" >"$DEV_OFF.core"
jq -S '.services | {postgres, centrifugo}' "$DEV_ON" >"$DEV_ON.core"
cmp -s "$DEV_OFF.core" "$DEV_ON.core" || fail "dev default services changed when eve profile was selected"
jq -S '.services | del(.eve, .["eve-db-roles"])' "$PROD_OFF" >"$PROD_OFF.core"
jq -S '.services | del(.eve, .["eve-db-roles"])' "$PROD_ON" >"$PROD_ON.core"
cmp -s "$PROD_OFF.core" "$PROD_ON.core" || fail "prod default services changed when eve profile was selected"
rm -f "$DEV_OFF.core" "$DEV_ON.core" "$PROD_OFF.core" "$PROD_ON.core"

# Shared fields are the compose drift guard. Network/host dependencies differ
# intentionally between dev and prod and are checked by their own render.
dev_contract=$(jq -cS '.services.eve | {image,command,working_dir,profiles,healthcheck,environment_keys: (.environment | keys)}' "$DEV_ON")
prod_contract=$(jq -cS '.services.eve | {image,command,working_dir,profiles,healthcheck,environment_keys: (.environment | keys)}' "$PROD_ON")
[ "$dev_contract" = "$prod_contract" ] || fail "dev/prod eve runtime contract drifted"

echo "[eve-profile] PASS profile off/on renders, default services stay byte-equivalent, dev/prod eve contract matches"
[ "$CONFIG_ONLY" -eq 0 ] || exit 0

require_bin curl
require_bin lsof

for port in "$EVE_PORT" "$POSTGRES_PORT" "$CENT_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port already in use: $port"
  fi
done

compose() {
  POSTGRES_PORT="$POSTGRES_PORT" \
  CENT_PORT="$CENT_PORT" \
  EVE_PORT="$EVE_PORT" \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  CENT_TOKEN_HMAC="momo-538-cent-token" \
  CENT_API_KEY="momo-538-cent-api" \
  EVE_WORLD_PASSWORD="$EVE_WORLD_PASSWORD" \
  EVE_MOMO_BASE_URL="http://host.docker.internal:9" \
  MOMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001" \
  MOMO_AGENT_MEMBER_ID="00000000-0000-7000-8000-000000000103" \
  MOMO_AGENT_TOKEN="momo-538-agent-token" \
  MOMO_CHANNEL_ROUTE_TOKEN="momo-538-route-token" \
    docker compose -p "$PROJECT_NAME" -f "$DEV_COMPOSE" "$@"
}

cleanup_runtime() {
  rc=$?
  trap - EXIT INT TERM
  compose --profile eve down -v --remove-orphans >/dev/null 2>&1 || true
  cleanup_files
  exit "$rc"
}
trap cleanup_runtime EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[eve-profile] starting default dev stack on ports $POSTGRES_PORT/$CENT_PORT"
compose up -d
default_services=$(compose ps --services --status running | sort | tr '\n' ' ')
[ "$default_services" = "centrifugo postgres " ] \
  || fail "profile-off runtime changed default services: $default_services"
if compose ps -a --services | grep -Eq '^eve(-db-roles)?$'; then
  fail "profile-off runtime created an eve container"
fi

echo "[eve-profile] enabling eve on port $EVE_PORT"
compose --profile eve up -d
deadline=$(($(date +%s) + 300))
while [ "$(date +%s)" -lt "$deadline" ]; do
  eve_id=$(compose --profile eve ps -q eve)
  if [ -n "$eve_id" ]; then
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$eve_id" 2>/dev/null || true)
    [ "$health" = "healthy" ] && break
    [ "$health" != "unhealthy" ] || {
      compose --profile eve logs --tail 200 eve eve-db-roles >&2 || true
      fail "eve became unhealthy"
    }
  fi
  sleep 2
done

curl -fsS "http://127.0.0.1:$EVE_PORT/eve/v1/health" >/dev/null \
  || fail "eve health endpoint did not answer"
compose --profile eve logs eve | grep -Fq 'momo channel preset loaded (eve 0.27.0, world=@workflow/world-postgres)' \
  || fail "MOMO-534 preset load marker missing from eve logs"

world_owner=$(compose exec -T postgres psql -U momo -d postgres -tA --no-psqlrc \
  -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='eve_world';")
[ "$world_owner" = "eve_world" ] || fail "eve_world owner mismatch: $world_owner"
world_tables=$(compose exec -T -e PGPASSWORD="$EVE_WORLD_PASSWORD" postgres psql \
  -h 127.0.0.1 -U eve_world -d eve_world -tA --no-psqlrc \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');")
[ "$world_tables" -gt 0 ] || fail "Postgres world created no durable tables"

compose exec -T postgres psql -U momo -d momo -v ON_ERROR_STOP=1 --no-psqlrc \
  -c 'CREATE TABLE IF NOT EXISTS momo_eve_isolation_sentinel (id integer PRIMARY KEY);' >/dev/null
if compose exec -T -e PGPASSWORD="$EVE_WORLD_PASSWORD" postgres psql \
  -h 127.0.0.1 -U eve_world -d momo -v ON_ERROR_STOP=1 --no-psqlrc \
  -c 'SELECT * FROM momo_eve_isolation_sentinel;' >/dev/null 2>&1; then
  fail "eve_world role accessed a momo schema table"
fi

echo "[eve-profile] PASS eve healthy, MOMO-534 preset loaded, eve_world durable tables present, momo table access denied"
echo "[eve-profile] runtime-unverified: real provider-backed eve session roundtrip requires operator-owned model credentials"
