#!/usr/bin/env bash
# =============================================================================
# scripts/verify_push_registration.sh — MOMO-403 (ADR-0120 P-1) push
# device/push_token registration lifecycle runtime gate.
#
# Boots an ISOLATED e2e compose stack (infra/docker-compose.e2e.yml) under its
# own compose project on non-default loopback ports (19500s) and drives the
# DeviceRoutes REST surface end to end:
#
#   register (201) -> idempotent re-register with a rotated token (200; the
#   previous token flips to invalidated_at, exactly one ACTIVE token per
#   device+env) -> same-token retry (200, still one active row) -> GET list
#   (own devices only) -> revoke via DELETE (invalidated_at, never row
#   deletion; idempotent repeat reports 0) -> invalidated-token reclaim by a
#   second member (account switch) -> actor binding denials (another member's
#   device 403 / active token 403) -> cross-tenant denials (workspace scope
#   mismatch 403, RLS-invisible token conflict 409) -> audit_log rows in the
#   same transaction (suffix only — the raw token appears in NO response body
#   and NO audit detail) -> RLS spot checks as momo_app -> 010 migration
#   index presence.
#
# Boot pattern: only the `api` service is started (`compose up -d api`); its
# dependency chain brings postgres/migrate/db-roles/centrifugo/mock-hermes.
# relay/worker are NOT booted — a single in-container cold Swift build at a
# time, inheriting the MOMO-401 staggered-boot memory guard
# (scripts/verify_web_login_smoke.sh) in its degenerate one-build form.
#
# Isolation: dedicated COMPOSE_PROJECT_NAME (default momo403push), loopback
# host ports 19500-19503, teardown removes only this project's containers and
# volumes. It never touches other compose projects or host momo processes.
#
# Environment overrides:
#   PUSH_GATE_PROJECT        compose project     (default: momo403push)
#   PUSH_GATE_PORT           api host port       (default: 19500)
#   PUSH_GATE_POSTGRES_PORT  postgres host port  (default: 19501)
#   PUSH_GATE_CENT_PORT      centrifugo port     (default: 19502)
#   PUSH_GATE_HERMES_PORT    mock-hermes port    (default: 19503)
#   PUSH_GATE_BOOT_TIMEOUT   seconds for api /health (default: 2400 — the api
#                            container cold-builds Swift on first run)
#   PUSH_GATE_KEEP=1         keep the stack up for debugging
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[push-reg] missing required command: $1" >&2
    exit 1
  }
}

need docker
need curl
need jq
need uuidgen

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${PUSH_GATE_PROJECT:-momo403push}"
API_PORT="${PUSH_GATE_PORT:-19500}"
PG_PORT="${PUSH_GATE_POSTGRES_PORT:-19501}"
CENT_PORT_HOST="${PUSH_GATE_CENT_PORT:-19502}"
HERMES_PORT_HOST="${PUSH_GATE_HERMES_PORT:-19503}"
BOOT_TIMEOUT="${PUSH_GATE_BOOT_TIMEOUT:-2400}"

RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-push-reg-$RUN_ID"
mkdir -p "$TMP_DIR"

DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
# Second tenant for cross-tenant denials (fixture-created, verify_rls.sh style).
WS_B_ID="40300000-0000-7000-8000-000000000001"

# Disposable members. Random per-run passwords; seed rows are never mutated.
M1_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"   # device owner (workspace A)
M2_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"   # same-workspace intruder
M3_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"   # workspace B member
M1_EMAIL="push-owner-$RUN_ID@momo.local"
M2_EMAIL="push-intruder-$RUN_ID@momo.local"
M3_EMAIL="push-tenant-b-$RUN_ID@momo.local"
M1_PASSWORD="push-$(uuidgen | tr '[:upper:]' '[:lower:]')"
M2_PASSWORD="push-$(uuidgen | tr '[:upper:]' '[:lower:]')"
M3_PASSWORD="push-$(uuidgen | tr '[:upper:]' '[:lower:]')"

# Client-stable device ids + 64-hex APNs tokens (uuid-derived; no openssl dep).
DEVICE1_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
DEVICE2_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
DEVICE3_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
hex64() { printf '%s%s' "$(uuidgen | tr -d '-' )" "$(uuidgen | tr -d '-')" | tr '[:upper:]' '[:lower:]'; }
TOKEN1="$(hex64)"
TOKEN2="$(hex64)"
TOKEN3="$(hex64)"
TOPIC="kim.dawn.momo.e2e"

compose() {
  PORT="$API_PORT" \
  POSTGRES_PORT="$PG_PORT" \
  CENT_PORT="$CENT_PORT_HOST" \
  HERMES_PORT="$HERMES_PORT_HOST" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${PUSH_GATE_KEEP:-0}" = "1" ]; then
    echo "[push-reg] PUSH_GATE_KEEP=1 — leaving compose project '$PROJECT' up"
  else
    echo "[push-reg] tearing down compose project '$PROJECT'"
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

for p in "$API_PORT" "$PG_PORT" "$CENT_PORT_HOST" "$HERMES_PORT_HOST"; do
  if port_in_use "$p"; then
    if [ -z "$(compose ps -q --status running 2>/dev/null)" ]; then
      echo "[push-reg] host port $p is busy and not owned by compose project '$PROJECT'." >&2
      echo "[push-reg] Override with PUSH_GATE_PORT/PUSH_GATE_POSTGRES_PORT/PUSH_GATE_CENT_PORT/PUSH_GATE_HERMES_PORT." >&2
      exit 1
    fi
  fi
done

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[push-reg] booting compose project '$PROJECT' (api :$API_PORT — api service only, single cold Swift build)"
compose up -d api

echo "[push-reg] waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s; cold Swift build can take many minutes)"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[push-reg] timed out waiting for api health" >&2
    compose logs --tail 80 api >&2 || true
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    echo "[push-reg] api container exited before health became green" >&2
    compose logs --tail 120 api >&2 || true
    exit 1
  fi
  sleep 3
done
echo "[push-reg] api health is green"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}

sql_scalar() { # one -tA scalar query on stdin
  run_sql -tA | tr -d '[:space:]'
}

echo "[push-reg] installing disposable member fixtures (workspace A x2, workspace B x1)"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;

-- Workspace A (seed demo): owner + intruder members.
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$M1_ID', '$DEMO_WORKSPACE_ID', 'human', 'active', 'Push Owner',    'push-owner-$RUN_EPOCH'),
  ('$M2_ID', '$DEMO_WORKSPACE_ID', 'human', 'active', 'Push Intruder', 'push-intruder-$RUN_EPOCH');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$M1_ID', '$DEMO_WORKSPACE_ID', '$M1_EMAIL', true, momo_password_hash('$M1_PASSWORD'), 'UTC'),
  ('$M2_ID', '$DEMO_WORKSPACE_ID', '$M2_EMAIL', true, momo_password_hash('$M2_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$M1_ID', 'member'),
  ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$M2_ID', 'member');

-- Workspace B: minimal second tenant (login needs workspace+member+human only).
INSERT INTO workspace (id, slug, name)
VALUES ('$WS_B_ID', 'momo-push-b-$RUN_EPOCH', 'MOMO Push Gate Workspace B');

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$M3_ID', '$WS_B_ID', 'human', 'active', 'Push Tenant B', 'push-b-$RUN_EPOCH');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$M3_ID', '$WS_B_ID', '$M3_EMAIL', true, momo_password_hash('$M3_PASSWORD'), 'UTC');

COMMIT;
SQL

echo "[push-reg] asserting 010 migration indexes exist"
got="$(printf "SELECT count(*) FROM pg_indexes WHERE indexname IN ('push_token_device_env_active_uniq','push_token_device_idx');\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[push-reg] FAIL: 010_push_registration.sql indexes missing (got=$got)" >&2; exit 1; }

# ---- REST helpers ------------------------------------------------------------
RESPONSE_BODY=""
RESPONSE_STATUS=""
api() { # method path [json-body] [token]
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}

expect_status() { # expected label
  if [ "$RESPONSE_STATUS" != "$1" ]; then
    echo "[push-reg] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  echo "[push-reg] ok: $2 (HTTP $1)"
}

expect_no_raw_token() { # token label
  case "$RESPONSE_BODY" in
    *"$1"*)
      echo "[push-reg] FAIL $2: raw apns token leaked into the response body" >&2
      exit 1
      ;;
  esac
}

login() { # email password [workspace] -> access token on stdout
  local body
  if [ -n "${3:-}" ]; then
    body="$(jq -cn --arg e "$1" --arg p "$2" --arg w "$3" '{email:$e,password:$p,workspace:$w}')"
  else
    body="$(jq -cn --arg e "$1" --arg p "$2" '{email:$e,password:$p}')"
  fi
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$body" | jq -r '.accessToken'
}

register_body() { # deviceId platform apnsToken env topic [appBuild]
  jq -cn --arg d "$1" --arg pl "$2" --arg t "$3" --arg e "$4" --arg to "$5" --arg b "${6:-}" \
    '{deviceId:$d,platform:$pl,apnsToken:$t,env:$e,topic:$to} + (if $b == "" then {} else {appBuild:$b} end)'
}

echo "[push-reg] logging in fixture members"
M1_ACCESS="$(login "$M1_EMAIL" "$M1_PASSWORD")"
M2_ACCESS="$(login "$M2_EMAIL" "$M2_PASSWORD")"
M3_ACCESS="$(login "$M3_EMAIL" "$M3_PASSWORD" "$WS_B_ID")"
for v in "$M1_ACCESS" "$M2_ACCESS" "$M3_ACCESS"; do
  [ -n "$v" ] && [ "$v" != "null" ] || { echo "[push-reg] fixture login failed" >&2; exit 1; }
done

DEV_PATH="/v1/workspaces/$DEMO_WORKSPACE_ID/devices"
DEV_PATH_B="/v1/workspaces/$WS_B_ID/devices"

# ---- 1) register -------------------------------------------------------------
api POST "$DEV_PATH" "$(register_body "$DEVICE1_ID" ios "$TOKEN1" sandbox "$TOPIC" "1.0.0+403")" "$M1_ACCESS"
expect_status 201 "M1 registers device D1 + token T1"
expect_no_raw_token "$TOKEN1" "register response"
got="$(printf '%s' "$RESPONSE_BODY" | jq -r '.device.id')"
[ "$(printf '%s' "$got" | tr '[:upper:]' '[:lower:]')" = "$DEVICE1_ID" ] || {
  echo "[push-reg] FAIL: register response device.id mismatch ($got)" >&2; exit 1; }
suffix="$(printf '%s' "$RESPONSE_BODY" | jq -r '.device.pushTokens[0].apnsTokenSuffix')"
[ "$suffix" = "${TOKEN1: -8}" ] || {
  echo "[push-reg] FAIL: apnsTokenSuffix mismatch (got $suffix)" >&2; exit 1; }
echo "[push-reg] ok: response carries suffix ref only (${suffix})"

# ---- 2) unauthenticated is 401 ------------------------------------------------
api POST "$DEV_PATH" "$(register_body "$DEVICE1_ID" ios "$TOKEN1" sandbox "$TOPIC")"
expect_status 401 "unauthenticated register denied"

# ---- 3) idempotent re-register rotates the token ------------------------------
api POST "$DEV_PATH" "$(register_body "$DEVICE1_ID" ios "$TOKEN2" sandbox "$TOPIC" "1.0.1+404")" "$M1_ACCESS"
expect_status 200 "M1 re-registers D1 with rotated token T2"
expect_no_raw_token "$TOKEN1" "rotation response (old token)"
expect_no_raw_token "$TOKEN2" "rotation response (new token)"
active_suffixes="$(printf '%s' "$RESPONSE_BODY" | jq -r '[.device.pushTokens[] | select(.invalidatedAtMs == null) | .apnsTokenSuffix] | join(",")')"
[ "$active_suffixes" = "${TOKEN2: -8}" ] || {
  echo "[push-reg] FAIL: expected exactly one active token (T2), got [$active_suffixes]" >&2; exit 1; }
invalidated_count="$(printf '%s' "$RESPONSE_BODY" | jq -r '[.device.pushTokens[] | select(.invalidatedAtMs != null)] | length')"
[ "$invalidated_count" = "1" ] || {
  echo "[push-reg] FAIL: expected T1 invalidated after rotation (got $invalidated_count invalidated)" >&2; exit 1; }
echo "[push-reg] ok: rotation invalidated T1, single active token invariant holds"

got="$(printf "SELECT count(*) FROM push_token WHERE device_id = '$DEVICE1_ID' AND invalidated_at IS NULL;\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[push-reg] FAIL: DB active-token count for D1 expected 1, got $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM push_token WHERE device_id = '$DEVICE1_ID';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[push-reg] FAIL: rotation must keep rows (expected 2, got $got)" >&2; exit 1; }

# ---- 4) same-token retry stays idempotent -------------------------------------
api POST "$DEV_PATH" "$(register_body "$DEVICE1_ID" ios "$TOKEN2" sandbox "$TOPIC")" "$M1_ACCESS"
expect_status 200 "M1 same-token retry is idempotent"
got="$(printf "SELECT count(*) FROM push_token WHERE device_id = '$DEVICE1_ID';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[push-reg] FAIL: same-token retry must not add rows (expected 2, got $got)" >&2; exit 1; }

# ---- 5) platform is immutable per device --------------------------------------
api POST "$DEV_PATH" "$(register_body "$DEVICE1_ID" macos "$TOKEN2" sandbox "$TOPIC")" "$M1_ACCESS"
expect_status 409 "device platform change rejected"

# ---- 6) GET lists own devices only ---------------------------------------------
api GET "$DEV_PATH" "" "$M1_ACCESS"
expect_status 200 "M1 lists devices"
expect_no_raw_token "$TOKEN2" "list response"
got="$(printf '%s' "$RESPONSE_BODY" | jq -r '.devices | length')"
[ "$got" = "1" ] || { echo "[push-reg] FAIL: M1 list expected 1 device, got $got" >&2; exit 1; }
api GET "$DEV_PATH" "" "$M2_ACCESS"
expect_status 200 "M2 lists devices"
got="$(printf '%s' "$RESPONSE_BODY" | jq -r '.devices | length')"
[ "$got" = "0" ] || { echo "[push-reg] FAIL: M2 must not see M1 devices (got $got)" >&2; exit 1; }

# ---- 7) actor binding denials ---------------------------------------------------
api POST "$DEV_PATH" "$(register_body "$DEVICE1_ID" ios "$(hex64)" sandbox "$TOPIC")" "$M2_ACCESS"
expect_status 403 "M2 cannot register onto M1's device"
api POST "$DEV_PATH" "$(register_body "$DEVICE2_ID" ios "$TOKEN2" sandbox "$TOPIC")" "$M2_ACCESS"
expect_status 403 "M2 cannot claim M1's ACTIVE token"
api DELETE "$DEV_PATH/$DEVICE1_ID" "" "$M2_ACCESS"
expect_status 403 "M2 cannot revoke M1's device"

# ---- 8) cross-tenant denials ----------------------------------------------------
api GET "$DEV_PATH" "" "$M3_ACCESS"
expect_status 403 "workspace B member denied on workspace A path (scope mismatch)"
api POST "$DEV_PATH_B" "$(register_body "$DEVICE3_ID" ios "$TOKEN2" sandbox "$TOPIC")" "$M3_ACCESS"
expect_status 409 "workspace B cannot claim a token registered in workspace A (RLS-invisible conflict)"
api POST "$DEV_PATH_B" "$(register_body "$DEVICE3_ID" ios "$TOKEN3" sandbox "$TOPIC")" "$M3_ACCESS"
expect_status 201 "workspace B registers its own device (positive control)"

# ---- 9) revoke = invalidated_at, never DELETE -----------------------------------
api DELETE "$DEV_PATH/$DEVICE1_ID" "" "$M1_ACCESS"
expect_status 200 "M1 revokes D1"
expect_no_raw_token "$TOKEN1" "revoke response"
expect_no_raw_token "$TOKEN2" "revoke response"
got="$(printf '%s' "$RESPONSE_BODY" | jq -r '.invalidatedCount')"
[ "$got" = "1" ] || { echo "[push-reg] FAIL: revoke expected invalidatedCount=1, got $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM push_token WHERE device_id = '$DEVICE1_ID' AND invalidated_at IS NULL;\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[push-reg] FAIL: active tokens remain after revoke ($got)" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM push_token WHERE device_id = '$DEVICE1_ID';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[push-reg] FAIL: revoke must keep rows (expected 2, got $got)" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM device WHERE id = '$DEVICE1_ID';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[push-reg] FAIL: device row must survive revoke" >&2; exit 1; }
api DELETE "$DEV_PATH/$DEVICE1_ID" "" "$M1_ACCESS"
expect_status 200 "repeat revoke is idempotent"
got="$(printf '%s' "$RESPONSE_BODY" | jq -r '.invalidatedCount')"
[ "$got" = "0" ] || { echo "[push-reg] FAIL: repeat revoke expected invalidatedCount=0, got $got" >&2; exit 1; }
api DELETE "$DEV_PATH/$(uuidgen | tr '[:upper:]' '[:lower:]')" "" "$M1_ACCESS"
expect_status 404 "revoking an unknown device is 404"

# ---- 10) invalidated token is reclaimable (account switch) -----------------------
api POST "$DEV_PATH" "$(register_body "$DEVICE2_ID" ios "$TOKEN2" sandbox "$TOPIC")" "$M2_ACCESS"
expect_status 201 "M2 reclaims the now-invalidated T2 on their own device"
got="$(printf "SELECT member_id::text || ':' || device_id::text FROM push_token WHERE apns_token = '$TOKEN2' AND env = 'sandbox';\n" | sql_scalar)"
[ "$got" = "$M2_ID:$DEVICE2_ID" ] || {
  echo "[push-reg] FAIL: reclaim must rebind token to M2/D2 (got $got)" >&2; exit 1; }

# ---- 11) audit rows (same transaction, suffix only) -------------------------------
got="$(printf "SELECT count(*) FROM audit_log WHERE action = 'device.registered' AND actor_member_id = '$M1_ID' AND target_id = '$DEVICE1_ID';\n" | sql_scalar)"
[ "$got" = "3" ] || { echo "[push-reg] FAIL: expected 3 device.registered audit rows for M1/D1, got $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM audit_log WHERE action = 'device.revoked' AND actor_member_id = '$M1_ID' AND target_id = '$DEVICE1_ID';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[push-reg] FAIL: expected 2 device.revoked audit rows, got $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM audit_log WHERE detail::text LIKE '%%$TOKEN1%%' OR detail::text LIKE '%%$TOKEN2%%' OR detail::text LIKE '%%$TOKEN3%%';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[push-reg] FAIL: raw apns token leaked into audit_log detail" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM audit_log WHERE action = 'device.registered' AND detail->>'apns_token_suffix' = '${TOKEN2: -8}';\n" | sql_scalar)"
[ "$got" != "0" ] || { echo "[push-reg] FAIL: audit detail should carry the token suffix" >&2; exit 1; }
echo "[push-reg] ok: audit rows present, suffix-only detail"

# ---- 12) RLS spot checks (momo_app, bootstrap_roles.sql) --------------------------
run_sql <<SQL
SET ROLE momo_app;
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM device WHERE id IN ('$DEVICE1_ID','$DEVICE2_ID','$DEVICE3_ID');
  IF got <> 0 THEN RAISE EXCEPTION 'device leaked without app.workspace_id: %', got; END IF;
  SELECT count(*) INTO got FROM push_token
   WHERE device_id IN ('$DEVICE1_ID','$DEVICE2_ID','$DEVICE3_ID');
  IF got <> 0 THEN RAISE EXCEPTION 'push_token leaked without app.workspace_id: %', got; END IF;
END \$\$;
RESET ROLE;

SET ROLE momo_app;
BEGIN;
SELECT set_config('app.workspace_id', '$WS_B_ID', true);
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM device WHERE id IN ('$DEVICE1_ID','$DEVICE2_ID');
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A device leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM push_token WHERE device_id IN ('$DEVICE1_ID','$DEVICE2_ID');
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A push_token leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM device WHERE id = '$DEVICE3_ID';
  IF got <> 1 THEN RAISE EXCEPTION 'workspace B device unavailable in exact context: %', got; END IF;
END \$\$;
COMMIT;
RESET ROLE;
SQL
echo "[push-reg] ok: RLS keeps device/push_token tenant-scoped for momo_app"

echo
echo "MOMO-403 push device registration verification PASS"
echo "- stack: compose project '$PROJECT' (api :$API_PORT), torn down on exit"
echo "- verified: register 201 + suffix-only receipt, idempotent re-register with token rotation (single ACTIVE token per device+env, rows preserved), same-token retry, platform immutability 409, own-devices-only GET, actor binding 403s (foreign device/active token/revoke), cross-tenant 403 (scope mismatch) + 409 (RLS-invisible token conflict) + tenant-B positive control, revoke=invalidated_at (no row deletion, idempotent, 404 unknown), invalidated-token reclaim rebind, same-transaction audit rows with suffix-only detail, momo_app RLS isolation, 010 index presence"
