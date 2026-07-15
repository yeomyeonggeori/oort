#!/usr/bin/env bash
# =============================================================================
# scripts/verify_web_login_smoke.sh — MOMO-391 + MOMO-400 web e2e smoke
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
# MOMO-400 (ADR-0119 W-4) additions:
#   - read-state: bulk-GET badge init, external cursor PUT reflected through
#     the `user:read-state#<member-id>` push (badge clears with zero extra
#     GETs), browser cursor PUTs strictly monotonic.
#   - composer idempotency: first in-browser send forwarded to the server but
#     answered 500; retry must reuse the SAME clientMsgId; exactly one message
#     in DOM and REST history.
#   - approvals: two pending fixtures (agent_run + approval + approval_request
#     message, same SQL pattern as scripts/verify_openapi_contract.sh);
#     in-browser 승인 (receipt 200) and an externally pre-decided 409 receipt
#     that must transition the card, not error.
#   - DM: picker -> POST /dms open -> composer round-trip -> GET /dms listing.
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
# MOMO-400 fixtures: #agent-lab is the "parked" channel (no unread) and the
# seeded 김인턴 agent (MOMO_AGENT_SEED_MODE=e2e, 002_seed.sql) authors the two
# pending approval fixtures in #general — same pattern as the OpenAPI gate.
AGENT_LAB_CHANNEL_ID="00000000-0000-7000-8000-000000000202"
KIM_INTERN_MEMBER_ID="00000000-0000-7000-8000-000000000102"
RUN1_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
APPROVAL1_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
RUN2_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
APPROVAL2_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
# Message props mirror the server's spelling (Swift uuidString = UPPERCASE).
APPROVAL1_UPPER="$(printf '%s' "$APPROVAL1_UUID" | tr '[:lower:]' '[:upper:]')"
APPROVAL2_UPPER="$(printf '%s' "$APPROVAL2_UUID" | tr '[:lower:]' '[:upper:]')"
RUN1_UPPER="$(printf '%s' "$RUN1_UUID" | tr '[:lower:]' '[:upper:]')"
RUN2_UPPER="$(printf '%s' "$RUN2_UUID" | tr '[:lower:]' '[:upper:]')"
# ADR-0112 leak probes (review fix M1): both approval.payload AND the
# approval_request message props carry the SAME dangerous fields the real
# gateway writes (AgentGatewayRoutes.swift approvalPayload /
# approvalRequestProps): tool `arguments` JSON, `tool_grant`, and
# `estimated_micro_usd` — each tagged with a unique marker the browser smoke
# asserts never reaches the rendered DOM (timeline card + panel card).
LEAK_MARKER="LEAKPROBE-$RUN_EPOCH"
LEAK_MICRO_USD_1=431337
LEAK_MICRO_USD_2=917331

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

DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent WHERE member_id = '$KIM_INTERN_MEMBER_ID'
  ) THEN
    RAISE EXCEPTION
      'agent seed missing — run the e2e stack with MOMO_AGENT_SEED_MODE=e2e (002_seed.sql)';
  END IF;
END \$\$;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$SMOKE_MEMBER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'Web Smoke', '$SMOKE_HANDLE');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$SMOKE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$SMOKE_EMAIL', true,
        momo_password_hash('$SMOKE_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$SMOKE_MEMBER_ID', 'member');

-- MOMO-400: second channel membership — the browser parks here (no unread)
-- so #general's badge stays observable for the read-state assertions.
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$AGENT_LAB_CHANNEL_ID', '$SMOKE_MEMBER_ID', 'member');

-- MOMO-400: two pending approval fixtures in #general (agent = seeded 김인턴),
-- each with its approval_request timeline message (single-transaction seq
-- bump, mirroring the server's write path). Fixture SQL pattern follows
-- scripts/verify_openapi_contract.sh. Both the payload AND the message props
-- deliberately CONTAIN the real gateway's dangerous fields (arguments tool
-- JSON, tool_grant, estimated_micro_usd — AgentGatewayRoutes.swift shapes):
-- the smoke asserts the cards never render any of them (ADR-0112 basic mode).

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key)
VALUES
  ('$RUN1_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
   '$GENERAL_CHANNEL_ID', 'awaiting_approval',
   '{"prompt":"web smoke approval one"}'::jsonb, 'web-smoke-1-$RUN_ID'),
  ('$RUN2_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
   '$GENERAL_CHANNEL_ID', 'awaiting_approval',
   '{"prompt":"web smoke approval two"}'::jsonb, 'web-smoke-2-$RUN_ID');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, requested_by, action_type, payload,
   status, expires_at)
VALUES
  ('$APPROVAL1_UUID', '$DEMO_WORKSPACE_ID', '$RUN1_UUID',
   '$GENERAL_CHANNEL_ID', '$KIM_INTERN_MEMBER_ID', 'tool_call',
   '{"run_id":"$RUN1_UPPER","action_type":"tool_call","tier":"read_only","tool_call":{"call_id":"web-smoke-1","name":"github.search_issues","arguments":{"query":"$LEAK_MARKER-args-1 repo:momo is:open"},"tool_grant":{"tool":"github.search_issues","scope":"$LEAK_MARKER-grant-1"}},"resume_model":"gateway_resume_agent_job","source":"hermes_gateway","title":"GitHub 이슈 검색 실행","summary":"김인턴이 GitHub 이슈를 검색하려고 합니다.","estimated_micro_usd":$LEAK_MICRO_USD_1,"is_reversible":true}'::jsonb,
   'pending', now() + interval '1 hour'),
  ('$APPROVAL2_UUID', '$DEMO_WORKSPACE_ID', '$RUN2_UUID',
   '$GENERAL_CHANNEL_ID', '$KIM_INTERN_MEMBER_ID', 'tool_call',
   '{"run_id":"$RUN2_UPPER","action_type":"tool_call","tier":"network_write","tool_call":{"call_id":"web-smoke-2","name":"github.create_comment","arguments":{"body":"$LEAK_MARKER-args-2 draft comment"},"tool_grant":{"tool":"github.create_comment","scope":"$LEAK_MARKER-grant-2"}},"resume_model":"gateway_resume_agent_job","source":"hermes_gateway","title":"GitHub 코멘트 작성","summary":"김인턴이 이슈에 코멘트를 남기려고 합니다.","estimated_micro_usd":$LEAK_MICRO_USD_2,"is_reversible":false}'::jsonb,
   'pending', now() + interval '1 hour');

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$GENERAL_CHANNEL_ID'
  RETURNING last_seq AS seq
), msg AS (
  INSERT INTO message
    (workspace_id, channel_id, seq, hlc_ts, hlc_count,
     author_member_id, type, body, props, run_id)
  SELECT '$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', b.seq,
         (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
         '$KIM_INTERN_MEMBER_ID', 'approval_request'::message_type,
         'GitHub 이슈 검색 실행 승인 요청',
         '{"approval_id":"$APPROVAL1_UPPER","run_id":"$RUN1_UPPER","channel_id":"$GENERAL_CHANNEL_ID","action_type":"tool_call","tier":"read_only","call_id":"web-smoke-1","tool_name":"github.search_issues","title":"GitHub 이슈 검색 실행","summary":"김인턴이 GitHub 이슈를 검색하려고 합니다.","arguments":{"query":"$LEAK_MARKER-args-1 repo:momo is:open"},"tool_grant":{"tool":"github.search_issues","scope":"$LEAK_MARKER-grant-1"},"estimated_micro_usd":$LEAK_MICRO_USD_1,"is_reversible":true,"status":"pending","source":"web-smoke"}'::jsonb,
         '$RUN1_UUID'
    FROM bumped b
  RETURNING id
)
UPDATE approval
   SET request_message_id = (SELECT id FROM msg)
 WHERE id = '$APPROVAL1_UUID';

WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 1
   WHERE channel_id = '$GENERAL_CHANNEL_ID'
  RETURNING last_seq AS seq
), msg AS (
  INSERT INTO message
    (workspace_id, channel_id, seq, hlc_ts, hlc_count,
     author_member_id, type, body, props, run_id)
  SELECT '$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', b.seq,
         (extract(epoch from clock_timestamp()) * 1000)::bigint, 0,
         '$KIM_INTERN_MEMBER_ID', 'approval_request'::message_type,
         'GitHub 코멘트 작성 승인 요청',
         '{"approval_id":"$APPROVAL2_UPPER","run_id":"$RUN2_UPPER","channel_id":"$GENERAL_CHANNEL_ID","action_type":"tool_call","tier":"network_write","call_id":"web-smoke-2","tool_name":"github.create_comment","title":"GitHub 코멘트 작성","summary":"김인턴이 이슈에 코멘트를 남기려고 합니다.","arguments":{"body":"$LEAK_MARKER-args-2 draft comment"},"tool_grant":{"tool":"github.create_comment","scope":"$LEAK_MARKER-grant-2"},"estimated_micro_usd":$LEAK_MICRO_USD_2,"is_reversible":false,"status":"pending","source":"web-smoke"}'::jsonb,
         '$RUN2_UUID'
    FROM bumped b
  RETURNING id
)
UPDATE approval
   SET request_message_id = (SELECT id FROM msg)
 WHERE id = '$APPROVAL2_UUID';

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
  WEB_SMOKE_UNREAD_CHANNEL_NAME="agent-lab" \
  WEB_SMOKE_APPROVAL_ID="$APPROVAL1_UUID" \
  WEB_SMOKE_APPROVAL2_ID="$APPROVAL2_UUID" \
  WEB_SMOKE_LEAK_MARKER="$LEAK_MARKER" \
  WEB_SMOKE_LEAK_MICRO_USD="$LEAK_MICRO_USD_1,$LEAK_MICRO_USD_2" \
  WEB_SMOKE_DM_AGENT_HANDLE="kim-intern" \
  WEB_SMOKE_OUT_DIR="$OUT_DIR" \
  node smoke/login-timeline.smoke.mjs
)

echo
echo "MOMO-391 + MOMO-400 web browser smoke PASS"
echo "- stack: compose project '$PROJECT' (api :$API_PORT, edge :$EDGE_HTTPS), torn down on exit"
echo "- verified (MOMO-391): SPA served by the prod Caddyfile under strict CSP, browser login with demo workspace fallback, channel list, seeded timeline display, wss realtime subscribe + live REST-sent message render, REST ?after= catch-up (never after=0), expired-access logout rotate+retry with server-side revoke, zero CSP console violations"
echo "- verified (MOMO-400): unread badge from bulk read-state GET, external cursor PUT reflected via user:read-state push (zero extra GETs, counter pinned only after the re-baseline GET response completed), never-regressing browser cursor PUTs, composer clientMsgId idempotent retry (one DOM render + one REST row), ADR-0112 approval cards leak none of the gateway-shaped fixture's arguments/tool_grant/estimated_micro_usd (timeline card + panel card), in-browser approve receipt 200, externally pre-decided 409 receipt as card state transition, DM open via POST /dms + composer round-trip + GET /dms listing"
echo "- artifacts: $OUT_DIR"
