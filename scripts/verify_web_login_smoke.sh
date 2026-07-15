#!/usr/bin/env bash
# =============================================================================
# scripts/verify_web_login_smoke.sh — MOMO-391 web login -> timeline e2e smoke
#
# Boots an ISOLATED e2e compose stack (infra/docker-compose.e2e.yml) under its
# own compose project on non-default loopback ports, serves the built SPA
# (clients/web/dist) through the REAL prod Caddyfile web-edge (strict CSP),
# and drives a real Chromium (playwright) through:
#
#   login form (workspace empty -> demo fallback) -> channel list -> #general
#   timeline (REST seeded messages displayed) -> realtime wss subscribe under
#   CSP -> REST-sent message rendered live (REST -> PG -> outbox -> relay ->
#   Centrifugo -> browser) -> REST `?after=` catch-up evidence (never after=0)
#   -> expired-access logout rotate+retry with server-side revoke -> zero CSP
#   console violations.
#
# Isolation: dedicated COMPOSE_PROJECT_NAME (default momo391web), loopback
# host ports 18990-18995, teardown removes only this project's containers and
# volumes. It never touches other compose projects or host momo processes.
#
# Prereqs: clients/web/dist built (the web gate profile builds it first),
# clients/web/node_modules installed, docker, curl, jq, node.
#
# Environment overrides:
#   WEB_LOGIN_SMOKE_PROJECT        compose project (default: momo391web)
#   WEB_LOGIN_SMOKE_PORT           api host port        (default: 18990)
#   WEB_LOGIN_SMOKE_POSTGRES_PORT  postgres host port   (default: 18991)
#   WEB_LOGIN_SMOKE_CENT_PORT      centrifugo host port (default: 18992)
#   WEB_LOGIN_SMOKE_HERMES_PORT    mock-hermes port     (default: 18993)
#   WEB_LOGIN_SMOKE_EDGE_HTTPS     web-edge https port  (default: 18994)
#   WEB_LOGIN_SMOKE_EDGE_HTTP      web-edge http port   (default: 18995)
#   WEB_LOGIN_SMOKE_BOOT_TIMEOUT   seconds for api /health (default: 2400 —
#                                  the api container cold-builds Swift)
#   WEB_LOGIN_SMOKE_RELAY_TIMEOUT  seconds for outbox drain (default: 1200 —
#                                  the relay container also cold-builds)
#   WEB_LOGIN_SMOKE_KEEP=1         keep the stack up for debugging
#   WEB_LOGIN_SMOKE_OUT_DIR        artifact dir (screenshot); defaults under
#                                  $LOCAL_GATE_OUTPUT_DIR or $TMPDIR
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[web-smoke] missing required command: $1" >&2
    exit 1
  }
}

need docker
need curl
need jq
need node
need npx
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
WEB_DIR="$REPO_ROOT/clients/web"
DIST_DIR="$WEB_DIR/dist"

[ -f "$DIST_DIR/index.html" ] || {
  echo "[web-smoke] clients/web/dist/index.html not found — run (cd clients/web && npm ci && npm run build) first" >&2
  exit 1
}
[ -d "$WEB_DIR/node_modules" ] || {
  echo "[web-smoke] clients/web/node_modules not found — run (cd clients/web && npm ci) first" >&2
  exit 1
}

PROJECT="${WEB_LOGIN_SMOKE_PROJECT:-momo391web}"
API_PORT="${WEB_LOGIN_SMOKE_PORT:-18990}"
PG_PORT="${WEB_LOGIN_SMOKE_POSTGRES_PORT:-18991}"
CENT_PORT_HOST="${WEB_LOGIN_SMOKE_CENT_PORT:-18992}"
HERMES_PORT_HOST="${WEB_LOGIN_SMOKE_HERMES_PORT:-18993}"
EDGE_HTTPS="${WEB_LOGIN_SMOKE_EDGE_HTTPS:-18994}"
EDGE_HTTP="${WEB_LOGIN_SMOKE_EDGE_HTTP:-18995}"
BOOT_TIMEOUT="${WEB_LOGIN_SMOKE_BOOT_TIMEOUT:-2400}"
RELAY_TIMEOUT="${WEB_LOGIN_SMOKE_RELAY_TIMEOUT:-1200}"

APP_HOST="app.localhost"
API_HOST="api.localhost"
RT_HOST="rt.localhost"

RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
OUT_DIR="${WEB_LOGIN_SMOKE_OUT_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}}/momo-web-login-smoke-$RUN_ID}"
mkdir -p "$OUT_DIR"

# Fixture credentials: the seed demo user has no password hash (002_seed.sql),
# so the smoke installs its own disposable member — same pattern as the
# OpenAPI drift gate. Random per run; seed rows are never mutated.
SMOKE_MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
SMOKE_EMAIL="web-smoke-$RUN_ID@momo.local"
SMOKE_PASSWORD="web-smoke-$(uuidgen | tr '[:upper:]' '[:lower:]')"
SMOKE_HANDLE="web-smoke-$RUN_EPOCH"
DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"

compose() {
  PORT="$API_PORT" \
  POSTGRES_PORT="$PG_PORT" \
  CENT_PORT="$CENT_PORT_HOST" \
  HERMES_PORT="$HERMES_PORT_HOST" \
  WEB_EDGE_HTTP_PORT="$EDGE_HTTP" \
  WEB_EDGE_HTTPS_PORT="$EDGE_HTTPS" \
  WEB_EDGE_APP_DOMAIN="$APP_HOST" \
  WEB_EDGE_API_DOMAIN="$API_HOST" \
  WEB_EDGE_REALTIME_DOMAIN="$RT_HOST" \
  WEB_EDGE_ASSETS_DIR="$DIST_DIR" \
  MOMO_E2E_REALTIME_WS_URL="wss://$RT_HOST/connection/websocket" \
  docker compose -p "$PROJECT" --profile web -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WEB_LOGIN_SMOKE_KEEP:-0}" = "1" ]; then
    echo "[web-smoke] WEB_LOGIN_SMOKE_KEEP=1 — leaving compose project '$PROJECT' up"
  else
    echo "[web-smoke] tearing down compose project '$PROJECT'"
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}

for p in "$API_PORT" "$PG_PORT" "$CENT_PORT_HOST" "$HERMES_PORT_HOST" "$EDGE_HTTPS" "$EDGE_HTTP"; do
  if port_in_use "$p"; then
    if [ -z "$(compose ps -q --status running 2>/dev/null)" ]; then
      echo "[web-smoke] host port $p is busy and not owned by compose project '$PROJECT'." >&2
      echo "[web-smoke] Override with WEB_LOGIN_SMOKE_PORT/.../WEB_LOGIN_SMOKE_EDGE_HTTPS." >&2
      exit 1
    fi
  fi
done

echo "[web-smoke] ensuring playwright chromium is installed (cached after first run)"
(cd "$WEB_DIR" && npx playwright install chromium)

echo "[web-smoke] booting compose project '$PROJECT' (api :$API_PORT, edge :$EDGE_HTTPS)"
compose up -d api relay web-edge

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[web-smoke] waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s; cold Swift build can take many minutes)"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[web-smoke] timed out waiting for api health" >&2
    compose logs --tail 80 api >&2 || true
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    echo "[web-smoke] api container exited before health became green" >&2
    compose logs --tail 120 api >&2 || true
    exit 1
  fi
  sleep 3
done
echo "[web-smoke] api health is green"

echo "[web-smoke] waiting for web-edge to serve the SPA"
edge_ok=0
for _ in $(seq 1 60); do
  edge_body="$(curl -ksS --resolve "$APP_HOST:$EDGE_HTTPS:127.0.0.1" \
    "https://$APP_HOST:$EDGE_HTTPS/" 2>/dev/null || true)"
  case "$edge_body" in
    *momo*) edge_ok=1; break ;;
  esac
  sleep 1
done
[ "$edge_ok" = "1" ] || { compose logs web-edge >&2 || true; echo "[web-smoke] web-edge did not serve the SPA" >&2; exit 1; }

echo "[web-smoke] installing disposable smoke member fixture"
run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
run_sql <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID';
SET LOCAL row_security = off;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$SMOKE_MEMBER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'Web Smoke', '$SMOKE_HANDLE');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$SMOKE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$SMOKE_EMAIL', true,
        momo_password_hash('$SMOKE_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$SMOKE_MEMBER_ID', 'member');

COMMIT;
SQL

echo "[web-smoke] proving relay liveness (probe message -> outbox drained)"
ACCESS="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg e "$SMOKE_EMAIL" --arg p "$SMOKE_PASSWORD" '{email:$e,password:$p}')" \
  | jq -r '.accessToken')"
[ -n "$ACCESS" ] && [ "$ACCESS" != "null" ] || { echo "[web-smoke] probe login failed" >&2; exit 1; }

curl -fsS -X POST \
  "$BASE_URL/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$GENERAL_CHANNEL_ID/messages" \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg c "$(uuidgen)" --arg b "web smoke relay probe $RUN_ID" \
      '{clientMsgId:$c,body:$b}')" >/dev/null

relay_deadline=$(( $(date -u +%s) + RELAY_TIMEOUT ))
while :; do
  pending="$(printf "SELECT count(*) FROM outbox WHERE kind = 'broadcast' AND status <> 'done';\n" | run_sql -tA || echo error)"
  pending="$(printf '%s' "$pending" | tr -d '[:space:]')"
  if [ "$pending" = "0" ]; then
    break
  fi
  if [ "$(date -u +%s)" -ge "$relay_deadline" ]; then
    echo "[web-smoke] timed out waiting for the relay to drain the outbox (pending=$pending)" >&2
    compose logs --tail 80 relay >&2 || true
    exit 1
  fi
  sleep 3
done
echo "[web-smoke] relay drained the broadcast outbox — realtime rail is live"

echo "[web-smoke] running the browser smoke (playwright chromium)"
(
  cd "$WEB_DIR"
  WEB_SMOKE_APP_HOST="$APP_HOST" \
  WEB_SMOKE_RT_HOST="$RT_HOST" \
  WEB_SMOKE_API_HOST="$API_HOST" \
  WEB_SMOKE_EDGE_HTTPS_PORT="$EDGE_HTTPS" \
  WEB_SMOKE_API_BASE="$BASE_URL" \
  WEB_SMOKE_EMAIL="$SMOKE_EMAIL" \
  WEB_SMOKE_PASSWORD="$SMOKE_PASSWORD" \
  WEB_SMOKE_CHANNEL_NAME="general" \
  WEB_SMOKE_OUT_DIR="$OUT_DIR" \
  node smoke/login-timeline.smoke.mjs
)

echo
echo "MOMO-391 web login/timeline smoke PASS"
echo "- stack: compose project '$PROJECT' (api :$API_PORT, edge :$EDGE_HTTPS), torn down on exit"
echo "- verified: SPA served by the prod Caddyfile under strict CSP, browser login with demo workspace fallback, channel list, seeded timeline display, wss realtime subscribe + live REST-sent message render, REST ?after= catch-up (never after=0), expired-access logout rotate+retry with server-side revoke, zero CSP console violations"
echo "- artifacts: $OUT_DIR"
