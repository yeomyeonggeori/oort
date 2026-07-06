#!/usr/bin/env bash
# Validate the MOMO-007 local/staging smoke gate without VPS secrets.
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

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "must run inside a git repository"
fi
cd "$REPO_ROOT"

need jq
need git
need docker

PROD_DIR="infra/prod"
COMPOSE_FILE="$PROD_DIR/docker-compose.prod.yml"
ENV_EXAMPLE="$PROD_DIR/.env.example"
CADDYFILE="$PROD_DIR/Caddyfile"
CENTRIFUGO_CONFIG="$PROD_DIR/centrifugo.prod.json"
SECRETS_EXAMPLE="$PROD_DIR/secrets.env.example"
PGBACKREST_CONF="$PROD_DIR/pgbackrest.conf.example"
PGBACKREST_POSTGRES="$PROD_DIR/postgresql.pgbackrest.conf.example"
PGBACKREST_CRON="$PROD_DIR/pgbackrest-cron.example"
RUNBOOK="docs/SECRETS_BACKUP_RUNBOOK.md"
PREFLIGHT="scripts/prod_env_preflight.sh"
PREFLIGHT_EVIDENCE_DIR="${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-public-host-preflight}"

for path in \
  "$COMPOSE_FILE" "$ENV_EXAMPLE" "$CADDYFILE" "$CENTRIFUGO_CONFIG" \
  "$SECRETS_EXAMPLE" "$PGBACKREST_CONF" "$PGBACKREST_POSTGRES" \
  "$PGBACKREST_CRON" "$RUNBOOK" "$PREFLIGHT" ".sops.yaml.example" ".gitignore"; do
  [ -f "$path" ] || fail "missing required staging smoke file: $path"
done

echo "==> prod compose config"
docker compose --env-file "$ENV_EXAMPLE" -f "$COMPOSE_FILE" config --quiet
pass "docker compose prod config validates with infra/prod/.env.example"

echo "==> prod compose structure"
required_services="caddy postgres redis centrifugo api relay worker"
for service in $required_services; do
  grep -Eq "^[[:space:]]{2}${service}:" "$COMPOSE_FILE" || fail "missing service in prod compose: $service"
done
grep -Fq 'postgres:18' "$COMPOSE_FILE" || fail "prod compose must use postgres:18"
grep -Fq 'centrifugo/centrifugo:v6' "$COMPOSE_FILE" || fail "prod compose must use centrifugo v6"
grep -Fq 'CENTRIFUGO_ENGINE_TYPE: redis' "$COMPOSE_FILE" || fail "Centrifugo must use Redis engine env"
grep -Fq 'CENT_API_URL: http://centrifugo:8000/api' "$COMPOSE_FILE" || fail "api/relay/worker must publish to internal Centrifugo API"
pass "prod compose has expected staging/prod services and internal routing"

echo "==> Caddyfile validation"
grep -Fq '{$API_DOMAIN}' "$CADDYFILE" || fail "Caddyfile missing API_DOMAIN site"
grep -Fq '{$REALTIME_DOMAIN}' "$CADDYFILE" || fail "Caddyfile missing REALTIME_DOMAIN site"
grep -Fq 'reverse_proxy api:8080' "$CADDYFILE" || fail "Caddyfile must proxy API to api:8080"
grep -Fq 'reverse_proxy centrifugo:8000' "$CADDYFILE" || fail "Caddyfile must proxy realtime to centrifugo:8000"
grep -Fq 'Strict-Transport-Security' "$CADDYFILE" || fail "Caddyfile missing HSTS header"
grep -Fq 'X-Content-Type-Options' "$CADDYFILE" || fail "Caddyfile missing X-Content-Type-Options header"
# MOMO-300: subscribe proxy callback is internal-only (centrifugo -> api over
# the compose network); the edge must deny /v1/centrifugo/* so the
# rate-limit-excluded CENT_PROXY_SECRET route is never publicly reachable.
grep -Fq 'handle /v1/centrifugo/*' "$CADDYFILE" || fail "Caddyfile must deny /v1/centrifugo/* at the edge (MOMO-300)"
grep -A1 'handle /v1/centrifugo/\*' "$CADDYFILE" | grep -Eq 'respond .*403' || fail "Caddyfile /v1/centrifugo/* handle must respond 403"
if command -v caddy >/dev/null 2>&1; then
  env ACME_EMAIL=ops@example.com \
    API_DOMAIN=api.staging.example.com \
    REALTIME_DOMAIN=rt.staging.example.com \
    caddy validate --config "$CADDYFILE" --adapter caddyfile
  pass "Caddy parser validation passed"
else
  echo "runtime-unverified: caddy binary is unavailable; structural Caddyfile checks passed, parser validation remains host-runtime."
fi

echo "==> Centrifugo prod config validation"
jq empty "$CENTRIFUGO_CONFIG"
jq -e '.engine.type == "redis"' "$CENTRIFUGO_CONFIG" >/dev/null || fail "Centrifugo prod config must use Redis engine"
jq -e '.engine.redis.address == "redis://redis:6379/0"' "$CENTRIFUGO_CONFIG" >/dev/null || fail "Centrifugo Redis address must use internal redis service"
jq -e '([.channel.namespaces[].name] | sort) == ["agent","ch","dm","user"]' "$CENTRIFUGO_CONFIG" >/dev/null || fail "Centrifugo namespaces must be agent/ch/dm/user"
jq -e '.channel.proxy.subscribe.endpoint == "http://api:8080/v1/centrifugo/subscribe"' "$CENTRIFUGO_CONFIG" >/dev/null || fail "subscribe proxy must stay on internal api:8080"
jq -e '.client.subscription_token.enabled == true' "$CENTRIFUGO_CONFIG" >/dev/null || fail "subscription tokens must be enabled"
jq -e '
  [.channel.namespaces[]
   | select(.history_ttl and .history_meta_ttl)
   | ((.history_meta_ttl | sub("h$"; "") | tonumber) > (.history_ttl | sub("h$"; "") | tonumber))]
  | all
' "$CENTRIFUGO_CONFIG" >/dev/null || fail "history_meta_ttl must be greater than history_ttl for every history namespace"
pass "Centrifugo prod JSON contract validates"

echo "==> secret template and committed secret guard"
tracked_forbidden="$(
  git ls-files \
    '.env' '.env.local' '.env.worktree' \
    'infra/prod/.env' 'infra/prod/.env.*' \
    'infra/prod/secrets.env' 'infra/prod/*.plain.env' \
    'infra/prod/*.decrypted' 'infra/prod/age.key' 'infra/prod/keys.txt' \
    | grep -v '^infra/prod/\.env\.example$' || true
)"
if [ -n "$tracked_forbidden" ]; then
  printf '%s\n' "$tracked_forbidden" >&2
  fail "forbidden plaintext/env secret file is tracked"
fi
grep -Fq 'infra/prod/.env.*' .gitignore || fail ".gitignore must ignore infra/prod/.env.*"
grep -Fq '!infra/prod/.env.example' .gitignore || fail ".gitignore must allow only infra/prod/.env.example"
grep -Fq 'infra/prod/secrets.env' .gitignore || fail ".gitignore must ignore plaintext prod secrets.env"
grep -Fq 'infra/prod/age.key' .gitignore || fail ".gitignore must ignore age private keys"
grep -Eq 'change-me|example\.com' "$ENV_EXAMPLE" || fail "infra/prod/.env.example must use obvious example placeholders"
grep -Eq '__[A-Z0-9_]+__|__HERMES_HOST__|__HERMES_BEARER_TOKEN__' "$SECRETS_EXAMPLE" || fail "secrets.env.example must use explicit placeholders"
if grep -Eq '^[A-Z0-9_]*(PASSWORD|HMAC|API_KEY|TOKEN|SECRET|CIPHER_PASS)=([0-9a-f]{32,}|[A-Za-z0-9+/]{40,}={0,2})$' "$ENV_EXAMPLE" "$SECRETS_EXAMPLE"; then
  fail "example secret template appears to contain a real high-entropy secret"
fi
pass "plaintext prod secrets are untracked and templates contain placeholders only"

echo "==> production secret/bootstrap preflight"
mkdir -p "$PREFLIGHT_EVIDENCE_DIR"
if "$PREFLIGHT" --env-file "$ENV_EXAMPLE" --mode staging --evidence-dir "$PREFLIGHT_EVIDENCE_DIR" >/tmp/momo-prod-preflight-expected-fail.log 2>&1; then
  cat /tmp/momo-prod-preflight-expected-fail.log >&2
  fail "prod preflight must reject infra/prod/.env.example placeholders in staging mode"
fi
grep -Eq 'placeholder|change-me|example|local value|unsafe|missing required env' /tmp/momo-prod-preflight-expected-fail.log \
  || fail "prod preflight expected-fail output did not explain placeholder/default rejection"
"$PREFLIGHT" --env-file "$PROD_DIR/internal-smoke.env.example" --mode internal-smoke

STRICT_ENV="$(mktemp "${TMPDIR:-/tmp}/momo-public-preflight.XXXXXX")"
cat > "$STRICT_ENV" <<'EOF'
COMPOSE_PROJECT_NAME=momo-staging
MOMO_ENV=staging
SECRET_SOURCE=sops://infra/prod/secrets.sops.env
PUBLIC_BASE_URL=https://api.staging.momo-alpha.dev
API_DOMAIN=api.staging.momo-alpha.dev
REALTIME_DOMAIN=rt.staging.momo-alpha.dev
CADDY_EMAIL=ops@momo-alpha.dev
ACME_EMAIL=ops@momo-alpha.dev
HTTP_PORT=80
HTTPS_PORT=443
MOMO_API_IMAGE=ghcr.io/dawn-kim-official/momo-server:20260701-1f83728
MOMO_RELAY_IMAGE=ghcr.io/dawn-kim-official/momo-outbox-relay:20260701-1f83728
MOMO_WORKER_IMAGE=ghcr.io/dawn-kim-official/momo-agent-worker:20260701-1f83728
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=postgres_20260701_operator_generated_shape
DATABASE_URL=postgres://momo:postgres_20260701_operator_generated_shape@postgres:5432/momo
RELAY_DATABASE_URL=postgres://momo_relay:relay_20260701_operator_generated_shape@postgres:5432/momo
DB_VOLUME_NAME=momo-staging-pgdata
REDIS_PASSWORD=redis_20260701_operator_generated_shape
CENTRIFUGO_REDIS_ADDRESS=redis://:redis_20260701_operator_generated_shape@redis:6379/0
REDIS_VOLUME_NAME=momo-staging-redis-data
CENT_TOKEN_HMAC=cent_token_hmac_20260701_operator_generated_shape
CENT_API_KEY=cent_api_key_20260701_operator_generated_shape
JWT_HMAC=jwt_hmac_20260701_operator_generated_shape
AGENT_PROVIDER_MODE=external-hermes
AGENT_MODEL=hermes-agent
HERMES_BASE_URL=https://hermes.staging.momo-alpha.dev/v1
HERMES_API_KEY=hermes_api_key_20260701_operator_generated_shape
PGBACKREST_STANZA=momo
PGBACKREST_REPO1_PATH=/var/lib/pgbackrest
PGBACKREST_REPO1_CIPHER_PASS=pgbackrest_cipher_20260701_operator_generated_shape
PGBACKREST_WAL_ARCHIVE_REQUIRED=1
PGBACKREST_STANZA_CHECK_REQUIRED=1
PGBACKREST_FULL_BACKUP_REQUIRED=1
PGBACKREST_PITR_REHEARSAL_REQUIRED=1
EOF
"$PREFLIGHT" --env-file "$STRICT_ENV" --mode staging --evidence-dir "$PREFLIGHT_EVIDENCE_DIR"
RESERVED_ENV="$(mktemp "${TMPDIR:-/tmp}/momo-public-preflight-reserved.XXXXXX")"
cp "$STRICT_ENV" "$RESERVED_ENV"
cat >> "$RESERVED_ENV" <<'EOF'
PUBLIC_BASE_URL=https://api.staging.momo.test
API_DOMAIN=api.staging.momo.test
REALTIME_DOMAIN=rt.staging.momo.test
EOF
if "$PREFLIGHT" --env-file "$RESERVED_ENV" --mode staging >/tmp/momo-prod-preflight-reserved-expected-fail.log 2>&1; then
  cat /tmp/momo-prod-preflight-reserved-expected-fail.log >&2
  fail "prod preflight must reject reserved/local public-routing domains in staging mode"
fi
grep -Fq 'reserved/local domain' /tmp/momo-prod-preflight-reserved-expected-fail.log \
  || fail "prod preflight reserved-domain expected-fail output did not explain the rejection"
rm -f "$STRICT_ENV"
rm -f "$RESERVED_ENV"
[ -f "$PREFLIGHT_EVIDENCE_DIR/prod-env-preflight-staging.md" ] || fail "missing preflight markdown evidence"
[ -f "$PREFLIGHT_EVIDENCE_DIR/prod-env-preflight-staging.json" ] || fail "missing preflight JSON evidence"
jq -e '.result == "PASS" and (.coverage | index("pgbackrest_wal_pitr_required_env"))' \
  "$PREFLIGHT_EVIDENCE_DIR/prod-env-preflight-staging.json" >/dev/null \
  || fail "preflight JSON evidence missing PASS pgBackRest/WAL/PITR coverage"
pass "prod preflight rejects staging placeholders, allows documented internal-smoke placeholders, and writes public/staging evidence"

echo "==> SOPS and pgBackRest checklist validation"
grep -Fq 'path_regex: ^infra/prod/.*\.sops\.(env|yaml|json)$' .sops.yaml.example || fail ".sops.yaml.example must target infra/prod/*.sops.*"
grep -Fq 'PGBACKREST_REPO1_CIPHER_PASS' "$SECRETS_EXAMPLE" || fail "secrets.env.example missing pgBackRest cipher pass"
grep -Fq '[momo]' "$PGBACKREST_CONF" || fail "pgBackRest config missing momo stanza"
grep -Fq 'repo1-cipher-type=aes-256-cbc' "$PGBACKREST_CONF" || fail "pgBackRest config missing repo encryption"
grep -Fq "archive_command = 'pgbackrest --stanza=momo archive-push %p'" "$PGBACKREST_POSTGRES" || fail "PostgreSQL pgBackRest conf missing archive_command"
grep -Fq -- '--type=full backup' "$PGBACKREST_CRON" || fail "pgBackRest cron missing full backup"
grep -Fq -- '--type=diff backup' "$PGBACKREST_CRON" || fail "pgBackRest cron missing diff backup"
grep -Fq 'pgbackrest --stanza=momo check' "$PGBACKREST_CRON" || fail "pgBackRest cron missing check"
grep -Fq '## 4. PITR Rehearsal' "$RUNBOOK" || fail "runbook missing PITR rehearsal section"
grep -Fq '## PITR Evidence' "$RUNBOOK" || fail "runbook missing PITR evidence template"
grep -Fq 'runtime-unverified' "$RUNBOOK" || fail "runbook must mark host-only pgBackRest rehearsal runtime-unverified"
pass "SOPS/age and pgBackRest rehearsal checklist is present"

echo
echo "MOMO-007 staging smoke local gate PASS"
echo "- runtime-unverified: real staging VPS TLS, Caddy parser healthcheck when caddy is absent, pgBackRest stanza/check/full backup/PITR restore rehearsal, and external hermes staging connectivity require host secrets/infrastructure."
