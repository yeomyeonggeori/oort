#!/usr/bin/env bash
# Validate MOMO-216 internal single-node hosting smoke wiring.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

section() {
  echo
  echo "==> $*"
}

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "must run inside a git repository"
fi
cd "$REPO_ROOT"

need docker
need jq

PROD_DIR="infra/prod"
PROD_COMPOSE="$PROD_DIR/docker-compose.prod.yml"
SMOKE_COMPOSE="$PROD_DIR/docker-compose.internal-smoke.yml"
SMOKE_ENV="$PROD_DIR/internal-smoke.env.example"
CADDYFILE="$PROD_DIR/Caddyfile"
CENTRIFUGO_CONFIG="$PROD_DIR/centrifugo.prod.json"
CENTRIFUGO_DEV_CONFIG="infra/centrifugo.json"
CONFIG_OUT="${TMPDIR:-/tmp}/momo-internal-hosting-smoke-compose.yml"

for path in \
  "$PROD_COMPOSE" "$SMOKE_COMPOSE" "$SMOKE_ENV" "$CADDYFILE" "$CENTRIFUGO_CONFIG" \
  "$CENTRIFUGO_DEV_CONFIG" \
  "scripts/migrate.sh" "server/Sources/MomoServer/App.swift" \
  "server/Migrations/001_init.sql" "server/Migrations/002_seed.sql" \
  "infra/prod/pgbackrest.conf.example" "docs/SECRETS_BACKUP_RUNBOOK.md" \
  "scripts/prod_env_preflight.sh"; do
  [ -f "$path" ] || fail "missing required internal hosting smoke file: $path"
done

section "internal smoke compose config"
docker compose \
  --env-file "$SMOKE_ENV" \
  -f "$PROD_COMPOSE" \
  -f "$SMOKE_COMPOSE" \
  config > "$CONFIG_OUT"
pass "compose config renders for prod + internal-smoke layering: $CONFIG_OUT"

section "image-based app service boundary"
for service in api relay worker linkshort; do
  grep -Eq "^[[:space:]]{2}${service}:" "$PROD_COMPOSE" || fail "prod compose missing service: $service"
  awk -v service="$service" '
    $0 ~ "^  " service ":" { inside = 1; next }
    inside && $0 ~ "^  [A-Za-z0-9_-]+:" { inside = 0 }
    inside && $0 ~ "^[[:space:]]+build:" { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$PROD_COMPOSE" && fail "prod service must not build from source checkout: $service"
  grep -Eq "^[[:space:]]{2}${service}:" "$CONFIG_OUT" || fail "rendered smoke config missing service: $service"
  case "$service" in
    api) expected_image="momo-api:internal-smoke" ;;
    relay) expected_image="momo-outbox-relay:internal-smoke" ;;
    worker) expected_image="momo-agent-worker:internal-smoke" ;;
    linkshort) expected_image="momo-linkshort:internal-smoke" ;;
  esac
  grep -Fq "$expected_image" "$SMOKE_ENV" || fail "internal smoke env missing local image fallback for $service"
done
grep -Fq "momo-migrate:internal-smoke" "$SMOKE_ENV" || fail "internal smoke env missing local migrate image fallback"
grep -Fq "momo-mock-hermes:internal-smoke" "$SMOKE_ENV" || fail "internal smoke env missing local mock Hermes image fallback"
grep -Fq "pull_policy: never" "$CONFIG_OUT" || fail "internal smoke override must use local image fallback pull_policy"
if grep -Fq "target: /workspace" "$CONFIG_OUT" || grep -Fq "source: ../.." "$CONFIG_OUT"; then
  fail "internal smoke runtime overlay must not bind-mount the source checkout"
fi
pass "api/relay/worker/linkshort/migrate/mock-hermes remain image-based with local image fallback tags for smoke"

section "Caddy and public/private network boundary"
# shellcheck disable=SC2016 # Caddy placeholders are intentionally literal.
grep -Fq '{$API_DOMAIN}' "$CADDYFILE" || fail "Caddyfile missing API_DOMAIN"
# shellcheck disable=SC2016 # Caddy placeholders are intentionally literal.
grep -Fq '{$REALTIME_DOMAIN}' "$CADDYFILE" || fail "Caddyfile missing REALTIME_DOMAIN"
grep -Fq 'reverse_proxy api:8080' "$CADDYFILE" || fail "Caddyfile must proxy API to api:8080"
grep -Fq 'reverse_proxy centrifugo:8000' "$CADDYFILE" || fail "Caddyfile must proxy realtime to centrifugo:8000"
grep -Fq 'Strict-Transport-Security' "$CADDYFILE" || fail "Caddyfile missing HSTS header"
# MOMO-300: rate-limit-excluded subscribe proxy must be edge-denied (403).
grep -Fq 'handle /v1/centrifugo/*' "$CADDYFILE" || fail "Caddyfile must deny /v1/centrifugo/* at the edge (MOMO-300)"
metrics_deny_handles="$(grep -Fc 'handle /metrics' "$CADDYFILE")"
metrics_deny_404s="$(grep -A1 'handle /metrics' "$CADDYFILE" | grep -Ec 'respond .*404' || true)"
[ "$metrics_deny_handles" -ge 2 ] && [ "$metrics_deny_404s" -eq "$metrics_deny_handles" ] \
  || fail "every public Caddy site must deny /metrics with 404"
# MOMO-399: MOMO-390 added a second edge site ({$APP_DOMAIN}) with its own
# /v1/centrifugo/* handle. Require EVERY such handle to respond 403 so one
# site block losing its deny cannot hide behind another block's match.
centrifugo_deny_handles="$(grep -Fc 'handle /v1/centrifugo/*' "$CADDYFILE")"
centrifugo_deny_403s="$(grep -A1 'handle /v1/centrifugo/\*' "$CADDYFILE" | grep -Ec 'respond .*403' || true)"
[ "$centrifugo_deny_403s" -eq "$centrifugo_deny_handles" ] \
  || fail "every Caddyfile /v1/centrifugo/* handle must respond 403 (handles=$centrifugo_deny_handles, 403s=$centrifugo_deny_403s)"
grep -Eq 'published: "?18080"?' "$CONFIG_OUT" || fail "internal smoke HTTP port must be local-only 18080 by default"
grep -Eq 'published: "?18443"?' "$CONFIG_OUT" || fail "internal smoke HTTPS port must be local-only 18443 by default"
if grep -Eq 'published: "?5432"?|published: "?6379"?|published: "?8000"?|published: "?8080"?' "$CONFIG_OUT"; then
  fail "internal hosting smoke must not expose Postgres/Redis/Centrifugo/API directly"
fi
pass "Caddy is the only public edge; API/realtime route internally"

section "Centrifugo Redis engine and subscribe proxy"
jq empty "$CENTRIFUGO_CONFIG"
jq -e '.engine.type == "redis"' "$CENTRIFUGO_CONFIG" >/dev/null || fail "Centrifugo prod config must use Redis engine"
# MOMO-399: derive the namespace expectation from infra/centrifugo.json (the
# local/dev runtime SoT config exercised by the runtime gates) instead of a
# hardcoded list. MOMO-338 added the agentwork namespace and this gate's frozen
# list went stale, failing main (DEVIATION_LOG 2026-07-15). The prod namespace
# set may never drift from the dev namespace set; future additions are picked
# up automatically as long as both configs change together.
dev_namespaces="$(jq -r '[.channel.namespaces[].name] | sort | join(",")' "$CENTRIFUGO_DEV_CONFIG")"
prod_namespaces="$(jq -r '[.channel.namespaces[].name] | sort | join(",")' "$CENTRIFUGO_CONFIG")"
[ -n "$dev_namespaces" ] || fail "no Centrifugo namespaces parsed from $CENTRIFUGO_DEV_CONFIG"
[ "$prod_namespaces" = "$dev_namespaces" ] \
  || fail "Centrifugo namespace drift: prod=[$prod_namespaces] dev=[$dev_namespaces] — prod config must carry the same namespace set as $CENTRIFUGO_DEV_CONFIG"
# Presence-only core contract (additions never break this; removing a product
# namespace must consciously touch this gate).
for ns in agent agentwork ch dm user; do
  case ",$prod_namespaces," in
    *",$ns,"*) ;;
    *) fail "Centrifugo prod config missing required namespace: $ns" ;;
  esac
done
jq -e '.channel.proxy.subscribe.endpoint == "http://api:8080/v1/centrifugo/subscribe"' "$CENTRIFUGO_CONFIG" >/dev/null || fail "subscribe proxy must use compose-internal api:8080"
grep -Fq 'CENTRIFUGO_ENGINE_TYPE: redis' "$PROD_COMPOSE" || fail "compose must enable Centrifugo Redis engine"
grep -Fq 'CENTRIFUGO_REDIS_ADDRESS' "$PROD_COMPOSE" || fail "compose must wire Centrifugo Redis address from env"
pass "Centrifugo prod transport uses Redis and internal subscribe proxy"

section "API health endpoint and app env"
grep -Fq 'router.get("/health")' server/Sources/MomoServer/App.swift || fail "MomoServer must expose GET /health"
grep -Fq 'PORT: 8080' "$PROD_COMPOSE" || fail "api service must bind internal PORT=8080"
grep -Fq 'DATABASE_URL: ${MOMO_APP_DATABASE_URL:?set MOMO_APP_DATABASE_URL}' "$PROD_COMPOSE" || fail "api service must consume the NOBYPASSRLS MOMO_APP_DATABASE_URL"
grep -Fq 'DATABASE_URL: ${MIGRATE_DATABASE_URL:?set MIGRATE_DATABASE_URL}' "$PROD_COMPOSE" || fail "migrate service must consume the owner-only MIGRATE_DATABASE_URL"
grep -Fq 'RELAY_DATABASE_URL: ${WORKER_DATABASE_URL:?set WORKER_DATABASE_URL}' "$PROD_COMPOSE" || fail "worker service must consume its distinct momo_worker URL"
grep -Fq 'CENT_API_URL: http://centrifugo:8000/api' "$PROD_COMPOSE" || fail "api service missing internal Centrifugo API URL"
pass "health endpoint is wired behind Caddy -> api:8080"

section "migration path"
grep -Fq 'service_completed_successfully' "$SMOKE_COMPOSE" || fail "internal smoke must gate app services on migrate success"
grep -Fq 'MOMO_MIGRATE_IMAGE' "$SMOKE_COMPOSE" || fail "internal smoke migrate service must use the local migrate image"
grep -Fq 'schema_migrations' scripts/migrate.sh || fail "migration runner must track schema_migrations"
pass "internal smoke has an explicit image-based one-shot DB migration path"

section "relay and worker enablement"
grep -Fq 'RELAY_DATABASE_URL:' "$PROD_COMPOSE" || fail "relay/worker must use RELAY_DATABASE_URL"
grep -Fq 'RELAY_POLL_INTERVAL_MS:' "$PROD_COMPOSE" || fail "relay service missing poll interval"
grep -Fq 'WORKER_POLL_INTERVAL_MS:' "$PROD_COMPOSE" || fail "worker service missing poll interval"
grep -Fq 'HERMES_BASE_URL:' "$PROD_COMPOSE" || fail "worker service missing Hermes base URL"
grep -Fq 'mock-hermes:' "$SMOKE_COMPOSE" || fail "internal smoke must provide mock Hermes boundary"
pass "relay and worker are enabled as single-node services"

section "env template and secret guard"
scripts/prod_env_preflight.sh --env-file "$SMOKE_ENV" --mode internal-smoke
for key in \
  COMPOSE_PROJECT_NAME API_DOMAIN REALTIME_DOMAIN MOMO_IMAGE_TAG MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE MOMO_MIGRATE_IMAGE MOMO_MOCK_HERMES_IMAGE \
  MIGRATE_DATABASE_URL MOMO_APP_POSTGRES_PASSWORD MOMO_APP_DATABASE_URL DATABASE_URL \
  RELAY_POSTGRES_PASSWORD RELAY_DATABASE_URL WORKER_POSTGRES_PASSWORD WORKER_DATABASE_URL \
  REDIS_PASSWORD CENT_TOKEN_HMAC CENT_API_KEY JWT_HMAC OUTBOUND_WEBHOOK_MASTER_KEY HERMES_BASE_URL HERMES_API_KEY; do
  grep -Eq "^${key}=" "$SMOKE_ENV" || fail "internal smoke env missing key: $key"
done
if grep -Eq '^[A-Z0-9_]*(PASSWORD|HMAC|API_KEY|TOKEN|SECRET|CIPHER_PASS)=([0-9a-f]{32,}|[A-Za-z0-9+/]{40,}={0,2})$' "$SMOKE_ENV"; then
  fail "internal smoke env appears to contain a high-entropy real secret"
fi
grep -Fq 'internal-smoke.env.example' .gitignore && fail "example env files must remain tracked"
pass "internal smoke env is a placeholder template, not a secret file"

section "backup/restore placeholder boundary"
grep -Fq '[momo]' infra/prod/pgbackrest.conf.example || fail "pgBackRest config missing momo stanza"
grep -Fq '## PITR Evidence' docs/SECRETS_BACKUP_RUNBOOK.md || fail "runbook missing PITR evidence template"
grep -Fq 'runtime-unverified' docs/SECRETS_BACKUP_RUNBOOK.md || fail "runbook must mark host-only restore rehearsal runtime-unverified"
pass "backup/restore responsibility boundary is documented"

echo
echo "MOMO-216 internal single-node hosting smoke PASS"
echo "- verified: prod compose + internal smoke override config, image-only smoke service boundary, env template guard, Caddy/Centrifugo static wiring, migration path, API health route wiring, relay/worker enablement, backup/restore placeholders."
echo "- runtime-unverified(public TLS/DNS): public DNS, public ACME certificate issuance/renewal, real VPS firewall, registry image pull/run, SOPS production secret injection, pgBackRest backup/PITR restore rehearsal."
