#!/usr/bin/env bash
# MOMO-390: e2e web serving smoke for the Caddy {$APP_DOMAIN} site (ADR-0119 D1-A).
#
# Verifies infra/prod/Caddyfile (the real deploy artifact) through the e2e
# compose `web` profile:
#   1. `caddy validate` passes with APP_DOMAIN set AND unset (unset deploys
#      must keep working — backward compat), and fails for a set-but-empty
#      APP_DOMAIN (documented sharp edge; prod compose guards it with
#      `${APP_DOMAIN:-<sentinel>}`).
#   2. APP_DOMAIN site serves the placeholder index.html, including the SPA
#      deep-link fallback (/channels/general -> index.html).
#   3. /v1/* routes to the api upstream (api is intentionally not booted here,
#      so 502 is the expected "proxied, upstream absent" answer; MOMO-391's
#      login smoke covers the full proxy round trip).
#   4. /v1/centrifugo/* is denied at the edge (403, MOMO-300).
#   5. security_headers + ADR-0119 CSP (realtime wss/https connect-src, inline
#      script blocked by default-src, inline style allowed) are present.
#   6. With APP_DOMAIN unset, the sentinel site fails closed: 404 for /, deep
#      links, and /v1/* (the host-matcher guard is ordered ahead of the path
#      handles); the API site still answers (centrifugo edge 403 intact) and
#      no certificate exists for the app host.
#
# Safety: uses a unique COMPOSE_PROJECT_NAME and loopback-only alternate host
# ports, never touches other compose projects/containers, and cleans up only
# what it created.
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

need docker
need curl

CADDYFILE="$REPO_ROOT/infra/prod/Caddyfile"
E2E_COMPOSE="infra/docker-compose.e2e.yml"
CADDY_IMAGE="caddy:2-alpine"
SENTINEL_HOST="momo-app-domain-unset.localhost"

# Unique, self-owned compose project + loopback-only alternate ports so this
# smoke can never collide with (or clean up) a developer's running momo stack.
PROJECT="${WEB_SMOKE_PROJECT_NAME:-momo390smoke$$}"
APP_HOST="${WEB_EDGE_APP_DOMAIN:-app.localhost}"
API_HOST="${WEB_EDGE_API_DOMAIN:-api.localhost}"
RT_HOST="${WEB_EDGE_REALTIME_DOMAIN:-rt.localhost}"
HTTPS_PORT="${WEB_EDGE_HTTPS_PORT:-19443}"
HTTP_PORT="${WEB_EDGE_HTTP_PORT:-19080}"
UNSET_NAME="${PROJECT}-unset-caddy"
UNSET_HTTPS_PORT="${WEB_SMOKE_UNSET_HTTPS_PORT:-19444}"

export WEB_EDGE_HTTP_PORT="$HTTP_PORT"
export WEB_EDGE_HTTPS_PORT="$HTTPS_PORT"

compose() {
  docker compose -p "$PROJECT" --profile web -f "$E2E_COMPOSE" "$@"
}

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$UNSET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Pipe-free substring check: with `set -o pipefail`, `printf | grep -q` can
# fail spuriously when grep -q exits before printf finishes (SIGPIPE).
contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

# $1 label, $2 expected status, $3 host, $4 port, $5 path
expect_status() {
  local label="$1" expected="$2" host="$3" port="$4" path="$5" got
  got="$(curl -ksS -o /dev/null -w '%{http_code}' \
    --resolve "$host:$port:127.0.0.1" "https://$host:$port$path")" \
    || fail "$label: curl to https://$host:$port$path failed"
  [ "$got" = "$expected" ] || fail "$label: expected HTTP $expected, got $got (https://$host:$port$path)"
  pass "$label ($expected)"
}

echo "==> Caddyfile parse matrix (docker $CADDY_IMAGE)"
validate() {
  docker run --rm -v "$CADDYFILE":/etc/caddy/Caddyfile:ro "$@" "$CADDY_IMAGE" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
}
validate -e ACME_EMAIL=e2e-web@momo.localhost -e API_DOMAIN="$API_HOST" -e REALTIME_DOMAIN="$RT_HOST" -e APP_DOMAIN="$APP_HOST" \
  || fail "caddy validate must pass with APP_DOMAIN set"
pass "caddy validate with APP_DOMAIN set"
validate -e ACME_EMAIL=e2e-web@momo.localhost -e API_DOMAIN="$API_HOST" -e REALTIME_DOMAIN="$RT_HOST" \
  || fail "caddy validate must pass with APP_DOMAIN unset (backward-compat sentinel default)"
pass "caddy validate with APP_DOMAIN unset (sentinel default)"
if validate -e ACME_EMAIL=e2e-web@momo.localhost -e API_DOMAIN="$API_HOST" -e REALTIME_DOMAIN="$RT_HOST" -e APP_DOMAIN=; then
  fail "caddy validate unexpectedly passed with set-but-empty APP_DOMAIN; the compose \${APP_DOMAIN:-sentinel} guard may silently stop mattering"
fi
pass "set-but-empty APP_DOMAIN fails parse as documented (prod compose guards with \${APP_DOMAIN:-sentinel})"

echo "==> boot web-edge (project: $PROJECT, https: 127.0.0.1:$HTTPS_PORT)"
compose up -d web-edge

serving_ok=0
for _ in $(seq 1 30); do
  if curl -ksS -o /dev/null --resolve "$APP_HOST:$HTTPS_PORT:127.0.0.1" \
    "https://$APP_HOST:$HTTPS_PORT/" 2>/dev/null; then
    serving_ok=1
    break
  fi
  sleep 1
done
[ "$serving_ok" = "1" ] || { compose logs web-edge >&2 || true; fail "web-edge did not start serving within 30s"; }

echo "==> APP_DOMAIN site behavior (APP_DOMAIN=$APP_HOST)"
body="$(curl -ksS --resolve "$APP_HOST:$HTTPS_PORT:127.0.0.1" "https://$APP_HOST:$HTTPS_PORT/")"
contains "$body" "momo web placeholder" || fail "index.html placeholder not served on /"
pass "placeholder index.html served on /"

deep="$(curl -ksS --resolve "$APP_HOST:$HTTPS_PORT:127.0.0.1" "https://$APP_HOST:$HTTPS_PORT/channels/general")"
contains "$deep" "momo web placeholder" || fail "SPA deep link /channels/general did not fall back to index.html"
pass "SPA routing fallback serves index.html for deep links"

expect_status "asset path /index.html" 200 "$APP_HOST" "$HTTPS_PORT" "/index.html"
expect_status "/v1/centrifugo/subscribe edge-denied" 403 "$APP_HOST" "$HTTPS_PORT" "/v1/centrifugo/subscribe"
expect_status "/v1/* proxied to api upstream (absent in this smoke)" 502 "$APP_HOST" "$HTTPS_PORT" "/v1/health"

# HTTP/2 lowercases header names on the wire; normalize before matching.
headers_lc="$(curl -ksSI --resolve "$APP_HOST:$HTTPS_PORT:127.0.0.1" "https://$APP_HOST:$HTTPS_PORT/" | tr '[:upper:]' '[:lower:]')"
contains "$headers_lc" "strict-transport-security:" || fail "missing HSTS header on SPA response"
contains "$headers_lc" "x-frame-options: deny" || fail "missing X-Frame-Options DENY on SPA response"
contains "$headers_lc" "content-security-policy:" || fail "missing Content-Security-Policy on SPA response"
contains "$headers_lc" "default-src 'self'" || fail "CSP default-src must restrict scripts to 'self'"
contains "$headers_lc" "connect-src 'self' wss://$RT_HOST https://$RT_HOST" || fail "CSP connect-src must allow realtime wss/https"
# 이슈 #1207: 첨부 바이트는 브라우저가 Drive로 직접 PUT 한다(ADR-0151 D1). 그
# 호스트가 이 헤더에 없으면 app.oor7.com 에서만 첨부가 조용히 막히고, 데스크톱
# (Tauri) 검수 표면에서는 영영 재현되지 않는다 — #1206 이 실측한 사각이다.
contains "$headers_lc" "https://www.googleapis.com" || fail "CSP connect-src must allow the attachment archive host (#1207)"
contains "$headers_lc" "style-src 'self' 'unsafe-inline'" || fail "CSP style-src must match ADR-0119 D3"
pass "security headers + ADR-0119 SPA CSP present"

echo "==> APP_DOMAIN-unset runtime behavior (sentinel fail-closed)"
docker run -d --name "$UNSET_NAME" \
  -p "127.0.0.1:$UNSET_HTTPS_PORT:443" \
  -v "$CADDYFILE":/etc/caddy/Caddyfile:ro \
  -e ACME_EMAIL=e2e-web@momo.localhost \
  -e API_DOMAIN="$API_HOST" \
  -e REALTIME_DOMAIN="$RT_HOST" \
  "$CADDY_IMAGE" >/dev/null

unset_ok=0
for _ in $(seq 1 30); do
  if curl -ksS -o /dev/null --resolve "$SENTINEL_HOST:$UNSET_HTTPS_PORT:127.0.0.1" \
    "https://$SENTINEL_HOST:$UNSET_HTTPS_PORT/" 2>/dev/null; then
    unset_ok=1
    break
  fi
  sleep 1
done
[ "$unset_ok" = "1" ] || { docker logs "$UNSET_NAME" >&2 || true; fail "unset-mode caddy did not start serving within 30s"; }

expect_status "unset: sentinel host / fails closed" 404 "$SENTINEL_HOST" "$UNSET_HTTPS_PORT" "/"
expect_status "unset: sentinel host deep link fails closed" 404 "$SENTINEL_HOST" "$UNSET_HTTPS_PORT" "/channels/general"
expect_status "unset: sentinel host /v1/* fails closed (guard ordered before proxy)" 404 "$SENTINEL_HOST" "$UNSET_HTTPS_PORT" "/v1/health"
expect_status "unset: API site centrifugo edge 403 intact" 403 "$API_HOST" "$UNSET_HTTPS_PORT" "/v1/centrifugo/subscribe"
expect_status "unset: API site still proxies to api upstream (absent here)" 502 "$API_HOST" "$UNSET_HTTPS_PORT" "/v1/health"
if curl -ksS -o /dev/null --resolve "$APP_HOST:$UNSET_HTTPS_PORT:127.0.0.1" \
  "https://$APP_HOST:$UNSET_HTTPS_PORT/" 2>/dev/null; then
  fail "unset: TLS handshake for $APP_HOST unexpectedly succeeded — no site/cert should exist without APP_DOMAIN"
fi
pass "unset: no certificate/site exists for $APP_HOST (TLS handshake refused)"

echo
echo "MOMO-390 web serving smoke PASS"
echo "- verified: Caddyfile parse matrix (set/unset/empty), placeholder index.html serving, SPA deep-link fallback, /v1 proxy wiring (502 without upstream), /v1/centrifugo/* edge 403, security headers + strict SPA CSP, and fail-closed sentinel behavior when APP_DOMAIN is unset."
echo "- not covered: real DNS/ACME issuance, the full browser round trip through /v1 to a live api (MOMO-391 web login smoke), and prod host TLS."
