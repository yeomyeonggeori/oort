#!/usr/bin/env bash
# Synthetic, no-network regression test for scripts/make_deploy_bundle.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
PACKER="$REPO_ROOT/scripts/make_deploy_bundle.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-deploy-bundle-test.XXXXXX")"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[deploy-bundle-test] FAIL: $*" >&2
  exit 1
}

make_fixture() {
  local root="$1"
  mkdir -p "$root/infra/prod" "$root/docs/runbooks" "$root/server"

  # shellcheck disable=SC2016 # Compose placeholders must remain literal.
  printf '%s\n' \
    'services:' \
    '  app:' \
    '    environment:' \
    '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}' \
    '      REDIS_PASSWORD: ${REDIS_PASSWORD:?set REDIS_PASSWORD}' \
    '      CENT_TOKEN_HMAC: ${CENT_TOKEN_HMAC:?set CENT_TOKEN_HMAC}' \
    '      CENT_API_KEY: ${CENT_API_KEY:?set CENT_API_KEY}' \
    '      JWT_HMAC: ${JWT_HMAC:?set JWT_HMAC}' \
    '      HERMES_API_KEY: ${HERMES_API_KEY:?set HERMES_API_KEY}' \
    > "$root/infra/prod/docker-compose.prod.yml"
  # shellcheck disable=SC2016 # Caddy placeholder must remain literal.
  printf '%s\n' '{$API_DOMAIN} { respond "ok" 200 }' > "$root/infra/prod/Caddyfile"
  printf '%s\n' '{"X-Centrifugo-Proxy-Secret": "change-me-cent-proxy-secret"}' > "$root/infra/prod/centrifugo.prod.json"
  printf '%s\n' \
    'AWS_ALPHA_PROVIDER=ec2' \
    'MOMO_API_IMAGE=ghcr.io/example/momo-server:sha-0123456789abcdef' \
    > "$root/infra/prod/aws-internal-alpha.env.example"
  printf '%s\n' \
    'POSTGRES_PASSWORD=__OPENSSL_RAND_HEX_32__' \
    'DATABASE_URL=postgres://momo:__URL_ENCODED_POSTGRES_PASSWORD__@postgres:5432/momo' \
    'CENT_API_KEY=change-me-cent-api-key' \
    'HERMES_API_KEY=__HERMES_BEARER_TOKEN__' \
    > "$root/infra/prod/secrets.env.example"
  printf '%s\n' '# Deploy runbook fixture' > "$root/docs/runbooks/aws-internal-alpha-deploy.md"
  printf '%s\n' '# Onboarding runbook fixture' > "$root/docs/runbooks/internal-alpha-onboarding.md"

  # A real checkout may contain both source and host-local secrets. Neither is
  # selected by the fixed allowlist.
  printf '%s\n' 'let secret = "source-only"' > "$root/server/Secret.swift"
  printf '%s\n' 'POSTGRES_PASSWORD=must-not-be-packed' > "$root/.env"
}

FIXTURE="$TMP_ROOT/fixture"
make_fixture "$FIXTURE"

BUNDLE="$TMP_ROOT/deploy.tar.gz"
"$PACKER" --source-root "$FIXTURE" --output "$BUNDLE"
[ -f "$BUNDLE" ] || fail "packer did not create an archive"

tar -tzf "$BUNDLE" > "$TMP_ROOT/archive.list"
grep -Fxq 'momo-deploy/docker-compose.prod.yml' "$TMP_ROOT/archive.list" || fail "compose missing"
grep -Fxq 'momo-deploy/templates/prod.env.example' "$TMP_ROOT/archive.list" || fail "prod env template missing"
grep -Fxq 'momo-deploy/runbooks/internal-alpha-onboarding.md' "$TMP_ROOT/archive.list" || fail "onboarding runbook missing"
if grep -Eq '(^|/)(\.env|Secret\.swift|server)(/|$)' "$TMP_ROOT/archive.list"; then
  fail "archive included source checkout or populated .env"
fi

EXTRACTED="$TMP_ROOT/extracted"
mkdir -p "$EXTRACTED"
tar -xzf "$BUNDLE" -C "$EXTRACTED"
[ ! -L "$EXTRACTED/momo-deploy/templates/prod.env.example" ] || fail "archive contains a symlink"

SECRET_FIXTURE="$TMP_ROOT/secret-fixture"
make_fixture "$SECRET_FIXTURE"
printf '%s\n' 'POSTGRES_PASSWORD=actual-alpha-password' > "$SECRET_FIXTURE/infra/prod/secrets.env.example"
if "$PACKER" --source-root "$SECRET_FIXTURE" --output "$TMP_ROOT/secret.tar.gz" >/dev/null 2>&1; then
  fail "packer accepted an actual secret in the env template"
fi
[ ! -e "$TMP_ROOT/secret.tar.gz" ] || fail "failed secret build left an archive behind"

CONFIG_SECRET_FIXTURE="$TMP_ROOT/config-secret-fixture"
make_fixture "$CONFIG_SECRET_FIXTURE"
printf '%s\n' '{"X-Centrifugo-Proxy-Secret": "actual-alpha-secret"}' \
  > "$CONFIG_SECRET_FIXTURE/infra/prod/centrifugo.prod.json"
if "$PACKER" --source-root "$CONFIG_SECRET_FIXTURE" --output "$TMP_ROOT/config-secret.tar.gz" >/dev/null 2>&1; then
  fail "packer accepted an actual secret in the Centrifugo config"
fi
[ ! -e "$TMP_ROOT/config-secret.tar.gz" ] || fail "failed config-secret build left an archive behind"

SYMLINK_FIXTURE="$TMP_ROOT/symlink-fixture"
make_fixture "$SYMLINK_FIXTURE"
rm "$SYMLINK_FIXTURE/infra/prod/secrets.env.example"
ln -s "$SYMLINK_FIXTURE/.env" "$SYMLINK_FIXTURE/infra/prod/secrets.env.example"
if "$PACKER" --source-root "$SYMLINK_FIXTURE" --output "$TMP_ROOT/symlink.tar.gz" >/dev/null 2>&1; then
  fail "packer accepted a symlinked required input"
fi
[ ! -e "$TMP_ROOT/symlink.tar.gz" ] || fail "failed symlink build left an archive behind"

DEPLOY_RUNBOOK="$REPO_ROOT/docs/runbooks/aws-internal-alpha-deploy.md"
ONBOARDING_RUNBOOK="$REPO_ROOT/docs/runbooks/internal-alpha-onboarding.md"
for anchor in \
  'AWS_READY' \
  'scripts/aws_internal_alpha_preflight.sh' \
  'scripts/prod_env_preflight.sh' \
  'docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml pull' \
  'docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml run --rm migrate' \
  'docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml up -d --no-build --wait' \
  'runtime-unverified(aws-host)' \
  '## Non-goals'
do
  grep -Fq "$anchor" "$DEPLOY_RUNBOOK" || fail "deploy runbook missing anchor: $anchor"
done

# shellcheck disable=SC2016 # Runbook route anchors must remain literal.
for anchor in \
  '/v1/workspaces/$WORKSPACE_ID/channels' \
  '/v1/workspaces/$WORKSPACE_ID/invites' \
  'Join with invite' \
  '@hermes' \
  '**Approve**' \
  '**Reject**' \
  'iOS 배포'
do
  grep -Fq "$anchor" "$ONBOARDING_RUNBOOK" || fail "onboarding runbook missing anchor: $anchor"
done

echo "[deploy-bundle-test] PASS: allowlist, source exclusion, secret rejection, symlink rejection"
