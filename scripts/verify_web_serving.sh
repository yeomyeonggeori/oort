#!/usr/bin/env bash
# MOMO-576 / ADR-0119 W-3: isolated HTTP verification for the production
# Caddyfile + real clients/web build. Docker execution belongs to the
# orchestrator; workers may run bash/static checks only.
set -euo pipefail

fail() {
  printf '[web-serving] FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[web-serving] PASS: %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need docker
need curl

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WEB_SERVING_PROJECT:-momo576web$$}"
EDGE_PORT="${WEB_SERVING_PORT:-28070}"
PG_PORT="${WEB_SERVING_POSTGRES_PORT:-28071}"
CENT_PORT_HOST="${WEB_SERVING_CENT_PORT:-28072}"
HERMES_PORT_HOST="${WEB_SERVING_HERMES_PORT:-28073}"
API_PORT="${WEB_SERVING_API_PORT:-28074}"
APP_HOST="${WEB_SERVING_APP_DOMAIN:-app.localhost}"
RT_HOST="${WEB_SERVING_REALTIME_DOMAIN:-rt.localhost}"
BOOT_TIMEOUT="${WEB_SERVING_BOOT_TIMEOUT:-2400}"
BASE_URL="http://127.0.0.1:$EDGE_PORT"

compose() {
  local env_args=()
  if [ -f "$REPO_ROOT/.env.worktree" ]; then
    env_args=(--env-file "$REPO_ROOT/.env.worktree")
  fi
  WEB_SERVING_PORT="$EDGE_PORT" \
  WEB_SERVING_APP_DOMAIN="$APP_HOST" \
  WEB_SERVING_REALTIME_DOMAIN="$RT_HOST" \
  PORT="$API_PORT" \
  POSTGRES_PORT="$PG_PORT" \
  CENT_PORT="$CENT_PORT_HOST" \
  HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose "${env_args[@]+${env_args[@]}}" -p "$PROJECT" \
      --profile web -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WEB_SERVING_KEEP:-0}" = "1" ]; then
    printf '[web-serving] WEB_SERVING_KEEP=1; compose project %s remains running\n' "$PROJECT"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && {
    exec 3>&- 3<&-
    return 0
  }
  return 1
}

for port in "$EDGE_PORT" "$PG_PORT" "$CENT_PORT_HOST" "$HERMES_PORT_HOST" "$API_PORT"; do
  port_in_use "$port" && fail "host port $port is already in use; choose an override in the 28070-28074 verifier band"
done
pass "ports 28070-28074 are available"

printf '[web-serving] building web-init and booting HTTP edge on 127.0.0.1:%s\n' "$EDGE_PORT"
compose up -d --build web-serving-edge

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS -H "Host: $APP_HOST" "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api web-init web-serving-edge >&2 || true
    fail "timed out waiting for /health through Caddy"
  fi
  sleep 3
done

index_body="$(curl -fsS -H "Host: $APP_HOST" "$BASE_URL/")" || fail "GET / failed"
case "$index_body" in
  *'<title>momo</title>'*) ;;
  *) fail "GET / did not return the built momo index.html" ;;
esac
pass "1/9 GET / serves the built momo index.html"

route_body="$(curl -fsS -H "Host: $APP_HOST" "$BASE_URL/some/spa/route")" || fail "SPA deep route failed"
case "$route_body" in
  *'<title>momo</title>'*) ;;
  *) fail "SPA deep route did not fall back to index.html" ;;
esac
pass "2/9 SPA deep route falls back to index.html"

join_body="$(curl -fsS -H "Host: $APP_HOST" "$BASE_URL/join")" || fail "GET /join failed"
case "$join_body" in
  *'<title>momo</title>'*) ;;
  *) fail "GET /join did not fall back to the momo SPA" ;;
esac
pass "3/9 GET /join falls back to index.html"

invite_headers="$(curl -sS -D - -o /dev/null -H "Host: $APP_HOST" "$BASE_URL/i/verifier-code" | tr -d '\r')" || fail "GET /i/verifier-code failed"
case "$invite_headers" in
  *' 302 '*|*' 302') ;;
  *) fail "GET /i/verifier-code did not return 302" ;;
esac
case "$invite_headers" in
  *"location: http://$APP_HOST/join?code=verifier-code"*|*"Location: http://$APP_HOST/join?code=verifier-code"*) ;;
  *) fail "GET /i/verifier-code did not proxy through LinkShort" ;;
esac
pass "4/9 GET /i/* proxies to LinkShort"

login_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Host: $APP_HOST" -H 'Content-Type: application/json' \
  -X POST --data '{}' "$BASE_URL/v1/auth/login")" || fail "login proxy request failed"
case "$login_status" in
  400|401) ;;
  *) fail "POST /v1/auth/login expected API 400/401, got $login_status" ;;
esac
pass "5/9 POST /v1/auth/login reaches the API ($login_status)"

centrifugo_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Host: $APP_HOST" -X POST "$BASE_URL/v1/centrifugo/subscribe")" || fail "centrifugo deny request failed"
[ "$centrifugo_status" = "403" ] || fail "/v1/centrifugo/subscribe expected 403, got $centrifugo_status"
pass "6/9 internal Centrifugo callback is edge-denied"

headers="$(curl -fsSI -H "Host: $APP_HOST" "$BASE_URL/" | tr '[:upper:]' '[:lower:]')" || fail "SPA header request failed"
case "$headers" in *'content-security-policy:'*) ;; *) fail "missing Content-Security-Policy" ;; esac
case "$headers" in *'x-frame-options: deny'*) ;; *) fail "missing X-Frame-Options DENY" ;; esac
case "$headers" in *"connect-src 'self' wss://$RT_HOST https://$RT_HOST"*) ;; *) fail "CSP realtime connect-src is incomplete" ;; esac
pass "7/9 CSP and X-Frame-Options headers are present"

health_status="$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: $APP_HOST" "$BASE_URL/health")" || fail "health proxy request failed"
[ "$health_status" = "200" ] || fail "GET /health expected 200, got $health_status"
pass "8/9 GET /health reaches the API"

metrics_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Host: $APP_HOST" "$BASE_URL/metrics")" || fail "public /metrics deny request failed"
[ "$metrics_status" = "404" ] || fail "public /metrics expected 404, got $metrics_status"
pass "9/9 public /metrics is edge-denied"

printf '[web-serving] PASS: nine web-serving assertions complete (HTTP e2e only)\n'
printf '[web-serving] runtime-unverified here: public DNS, ACME certificate issuance, and production TLS\n'
