#!/usr/bin/env bash
# =============================================================================
# scripts/verify_provider_link.sh — MOMO-572 / MOMO-576 / MOMO-577
#   ADR-0004 증보 1 provider link gate
#
# Two layers:
#   1. Worker gate (always): isolated port reservation, migration 039 presence,
#      schema_v0 untouched invariant, swift build + focused unit tests.
#   2. Runtime REST smoke (PROVIDER_LINK_RUN_DOCKER=1): boots a real PG18 + api
#      on the docker-compose e2e stack and drives the operator REST surface end
#      to end over live HTTP:
#        * owner login token (MOMO-576 path — owner/admin, no platform:read)
#          drives PUT -> GET -> POST /test -> DELETE.
#        * PUT stores the bearer; the stored value is asserted to be a genuine
#          bytea sealed box (version byte, exact octet_length) — this is the
#          regression that a mock-store unit test could not see: `[UInt8]`
#          interpolation encoded a Postgres "char"[] array (500 on real PG),
#          whereas the fix binds a ByteBuffer as bytea (MOMO-577).
#        * GET returns the decrypted masked tail (store+decrypt roundtrip) and
#          NEVER the plaintext bearer; the plaintext bytes never appear at rest
#          in the ciphertext column.
#        * DELETE reverts to the env fallback.
#        * non-admin member token -> 403 on every verb.
#        * provider_link default-denies an ordinary tenant momo_app session and
#          unlocks only under the app.provider_link_admin GUC (RLS FORCE).
#
# Historically this runtime layer was handed off to the orchestrator as
# "runtime-unverified", which is exactly how the bytea binding bug reached a
# real server. The smoke now lives here so a future regression fails the gate.
#
# Ports live in the reserved 28260 block. schema_v0.sql is never modified.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[provider-link] $*"; }

# ---- Isolated port block (28260s). Reserve so a concurrent gate cannot race. ---
API_PORT="${PROVIDER_LINK_API_PORT:-28260}"
HERMES_PORT="${PROVIDER_LINK_HERMES_PORT:-28261}"
PG_PORT="${PROVIDER_LINK_POSTGRES_PORT:-28262}"
CENTRIFUGO_PORT="${PROVIDER_LINK_CENTRIFUGO_PORT:-28263}"

command -v python3 >/dev/null 2>&1 || {
  log "missing python3"
  exit 1
}

python3 - "$API_PORT" "$HERMES_PORT" "$PG_PORT" "$CENTRIFUGO_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[provider-link] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[provider-link] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY
log "reserved isolated ports ${API_PORT}/${HERMES_PORT}/${PG_PORT}/${CENTRIFUGO_PORT}"

# ---- Migration presence + schema_v0 untouched invariant --------------------
MIGRATION="server/Migrations/039_provider_link.sql"
test -f "$MIGRATION" || {
  log "missing migration $MIGRATION"
  exit 1
}
grep -q "CREATE TABLE provider_link" "$MIGRATION" || {
  log "migration 039 does not create provider_link"
  exit 1
}
grep -q "FORCE ROW LEVEL SECURITY" "$MIGRATION" || {
  log "migration 039 must FORCE row level security"
  exit 1
}
if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -qx "schema_v0.sql"; then
  log "schema_v0.sql must not be modified"
  exit 1
fi

# ---- swift build + focused server unit gate --------------------------------
command -v swift >/dev/null 2>&1 || {
  log "missing swift toolchain"
  exit 1
}
log "swift build (server)"
swift build --package-path server >/dev/null
log "swift test --filter ProviderLinkTests (server)"
swift test --package-path server --filter ProviderLinkTests >/dev/null

log "PASS worker gate: migration present, schema_v0 untouched, build + provider-link unit tests green"

# ---- Runtime REST smoke gate -----------------------------------------------
if [ "${PROVIDER_LINK_RUN_DOCKER:-0}" != "1" ]; then
  log "runtime-unverified: the live REST smoke (compose PG18+api, owner-token"
  log "  PUT/GET/POST-test/DELETE roundtrip with bytea store+decrypt+mask, plaintext"
  log "  non-leak, non-admin 403, provider_link RLS default-deny) is gated behind"
  log "  PROVIDER_LINK_RUN_DOCKER=1 (needs Docker). Re-run there to exercise it."
  exit 0
fi

# =============================================================================
# PROVIDER_LINK_RUN_DOCKER=1 — real compose PG18 + api REST roundtrip.
# =============================================================================
need() { command -v "$1" >/dev/null 2>&1 || { log "missing $1"; exit 1; }; }
need docker
need curl
need jq

new_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${PROVIDER_LINK_GATE_PROJECT:-momo577provlink}"
BOOT_TIMEOUT="${PROVIDER_LINK_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-provider-link.XXXXXX")"

# Default e2e seed workspace (002_seed.sql slug 'demo'); its seeded human has no
# password, so we seed our own operator + non-admin humans inside it.
WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
OWNER_ID="$(new_uuid)"
MEMBER_ID="$(new_uuid)"
OWNER_EMAIL="provider-owner-$RUN_ID@momo.local"
MEMBER_EMAIL="provider-member-$RUN_ID@momo.local"
OWNER_PASSWORD="provider-owner-$(new_uuid)"
MEMBER_PASSWORD="provider-member-$(new_uuid)"

# Operator-supplied bearer under test. >= 8 chars so the masked tail is exposed;
# a distinctive infix so any plaintext leak (response body, api log, ciphertext
# at rest) is unambiguously detectable.
BEARER_SECRET="sk-momo577-verifier-PLAINTEXT-do-not-leak-9Q7Z"
BEARER_LAST4="${BEARER_SECRET: -4}"
BEARER_LEN="${#BEARER_SECRET}"
# Sealed box = version(1) + nonce(12) + ciphertext(=plaintext len for AES-GCM) + tag(16).
EXPECTED_CIPHERTEXT_LEN=$((BEARER_LEN + 29))
# Non-loopback https base_url: passes AgentRoutes.validatedBaseURL in every
# environment (loopback needs the local opt-in; a mock host is rejected).
BASE_URL_VALUE="https://provider.example.test/v1"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENTRIFUGO_PORT" \
    HERMES_PORT="$HERMES_PORT" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${PROVIDER_LINK_GATE_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-provider-link.*) rm -r -- "$TMP_DIR" ;;
      *) log "refusing unexpected temp path: $TMP_DIR" ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"

# Linux trap: the api container copies the read-only source mount with
# `cp -Rp /workspace/server ...`. A host-side `.build/` (the worker gate above
# just ran a local macOS `swift build`) holds symlinks such as `.build/debug`
# that Linux `cp` cannot read ("cannot read symbolic link '.build/debug':
# Invalid argument"), which aborts api boot before /health. The container builds
# fresh in its own scratch volume, so drop the host build artifacts from every
# package tree the api service copies.
for build_dir in \
  "$REPO_ROOT/server/.build" \
  "$REPO_ROOT/services/OutboundHTTPPolicy/.build" \
  "$REPO_ROOT/services/MomoMetrics/.build"; do
  rm -rf "$build_dir" 2>/dev/null || true
done

log "booting isolated PG18 + api stack '$PROJECT' on ${API_PORT}/${PG_PORT}/${CENTRIFUGO_PORT}/${HERMES_PORT}"
# `api` depends_on db-roles -> migrate (applies every migration incl. 039) ->
# postgres, plus centrifugo + mock-hermes; bringing up api boots the chain.
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    log "api health timeout"
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    log "api exited before health"
    exit 1
  fi
  sleep 3
done
log "api health green"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

# ---- Seed an operator (workspace_membership owner) + a non-admin member -----
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$WORKSPACE_ID', 'human', 'active', 'Provider Owner', 'provider-owner-$RUN_ID'),
  ('$MEMBER_ID', '$WORKSPACE_ID', 'human', 'active', 'Provider Member', 'provider-member-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WORKSPACE_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$MEMBER_ID', '$WORKSPACE_ID', '$MEMBER_EMAIL', true, momo_password_hash('$MEMBER_PASSWORD'), 'UTC');
-- MOMO-576 D3: owner/admin of its own workspace authorizes the operator surface
-- without platform:read. The non-admin member intentionally has no
-- workspace_membership owner/admin row.
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WORKSPACE_ID', '$OWNER_ID', 'owner')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = 'owner';
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WORKSPACE_ID', '$MEMBER_ID', 'member')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = 'member';
COMMIT;
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WORKSPACE_ID" \
      '{email:$e,password:$p,workspace:$w}')" \
    | jq -er '.accessToken'
}
OWNER_TOKEN="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
MEMBER_TOKEN="$(login "$MEMBER_EMAIL" "$MEMBER_PASSWORD")"
[ -n "$OWNER_TOKEN" ] && [ -n "$MEMBER_TOKEN" ] || { log "login did not return tokens"; exit 1; }

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" token="$3" body="${4:-}" out="$TMP_DIR/response"
  local args=(-sS -o "$out" -w '%{http_code}' --max-time 30 -X "$method" \
    -H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    log "FAIL $2: expected HTTP $1, got $RESPONSE_STATUS"
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}
# Guard: the plaintext bearer must never surface in any operator response.
assert_no_plaintext() {
  if printf '%s' "$RESPONSE_BODY" | grep -Fq -- "$BEARER_SECRET"; then
    log "FAIL $1: plaintext bearer leaked into response body"
    exit 1
  fi
}

LINK_PATH="/v1/provider/link"
TEST_PATH="/v1/provider/link/test"

# ---- Non-admin member is denied on every verb (403, no bearer exposure) -----
api GET "$LINK_PATH" "$MEMBER_TOKEN"
expect_status 403 "non-admin GET"
api PUT "$LINK_PATH" "$MEMBER_TOKEN" \
  "$(jq -cn --arg u "$BASE_URL_VALUE" --arg b "$BEARER_SECRET" '{baseUrl:$u,bearer:$b,mode:"external-hermes"}')"
expect_status 403 "non-admin PUT"
api POST "$TEST_PATH" "$MEMBER_TOKEN"
expect_status 403 "non-admin POST test"
api DELETE "$LINK_PATH" "$MEMBER_TOKEN"
expect_status 403 "non-admin DELETE"

# ---- Baseline: nothing configured -> env fallback --------------------------
api GET "$LINK_PATH" "$OWNER_TOKEN"
expect_status 200 "owner GET (baseline)"
printf '%s' "$RESPONSE_BODY" | jq -e '.configured == false and .source == "environment"' >/dev/null || {
  log "FAIL baseline GET expected configured:false source:environment"; echo "$RESPONSE_BODY" >&2; exit 1; }

# ---- PUT: store the bearer (the bytea binding under test) -------------------
api PUT "$LINK_PATH" "$OWNER_TOKEN" \
  "$(jq -cn --arg u "$BASE_URL_VALUE" --arg b "$BEARER_SECRET" '{baseUrl:$u,bearer:$b,mode:"external-hermes"}')"
expect_status 200 "owner PUT (bytea store)"
assert_no_plaintext "owner PUT"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg last4 "$BEARER_LAST4" '
    .configured == true
    and .source == "database"
    and .mode == "external-hermes"
    and .bearerConfigured == true
    and .bearerLast4 == $last4
  ' >/dev/null || {
  log "FAIL PUT response projection (store+decrypt+mask)"; echo "$RESPONSE_BODY" >&2; exit 1; }
log "PASS PUT: bearer stored, decrypted tail masked, HTTP 200 (no 500 — bytea bind OK)"

# ---- Storage-layer proof: the column holds a real bytea sealed box ----------
# Under the pre-fix `[UInt8]` interpolation PUT 500'd on real PG; had it stored
# anything, it would be a "char"[] array, not these exact sealed-box bytes.
VERSION_BYTE="$(printf "SELECT get_byte(bearer_ciphertext, 0) FROM provider_link WHERE id = true;" | sql_scalar)"
[ "$VERSION_BYTE" = "1" ] || { log "FAIL stored version byte: got '$VERSION_BYTE' want 1"; exit 1; }
CIPHERTEXT_LEN="$(printf "SELECT octet_length(bearer_ciphertext) FROM provider_link WHERE id = true;" | sql_scalar)"
[ "$CIPHERTEXT_LEN" = "$EXPECTED_CIPHERTEXT_LEN" ] || {
  log "FAIL ciphertext octet_length: got '$CIPHERTEXT_LEN' want $EXPECTED_CIPHERTEXT_LEN"; exit 1; }
# Plaintext bytes must not appear at rest inside the sealed box.
PLAINTEXT_POS="$(printf "SELECT position(convert_to('%s','UTF8') in bearer_ciphertext) FROM provider_link WHERE id = true;" "$BEARER_SECRET" | sql_scalar)"
[ "$PLAINTEXT_POS" = "0" ] || { log "FAIL plaintext bearer bytes present at rest (pos=$PLAINTEXT_POS)"; exit 1; }
log "PASS storage: bytea sealed box (version=1, octet_length=$CIPHERTEXT_LEN), plaintext absent at rest"

# ---- GET: decrypt roundtrip, masked tail, no plaintext ---------------------
api GET "$LINK_PATH" "$OWNER_TOKEN"
expect_status 200 "owner GET (after PUT)"
assert_no_plaintext "owner GET"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg last4 "$BEARER_LAST4" --arg url "$BASE_URL_VALUE" '
    .configured == true
    and .source == "database"
    and .mode == "external-hermes"
    and .baseUrl == $url
    and .bearerConfigured == true
    and .bearerLast4 == $last4
  ' >/dev/null || {
  log "FAIL GET response projection after PUT"; echo "$RESPONSE_BODY" >&2; exit 1; }
log "PASS GET: bytea store+decrypt roundtrip confirmed over live REST"

# ---- POST /test: authorized, structured (external probe unreachable -> ok:false) ----
api POST "$TEST_PATH" "$OWNER_TOKEN"
expect_status 200 "owner POST test"
assert_no_plaintext "owner POST test"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.schema == "momo.provider_link.test.v0" and (.source == "database") and (.mode == "external-hermes") and (has("ok"))' \
  >/dev/null || { log "FAIL POST test response schema"; echo "$RESPONSE_BODY" >&2; exit 1; }

# ---- provider_link RLS: default-deny tenant, GUC-gated operator view --------
DENY_COUNT="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='%s'; SELECT count(*) FROM provider_link; COMMIT;" "$WORKSPACE_ID" | sql_scalar)"
[ "$DENY_COUNT" = "0" ] || { log "FAIL RLS default-deny: ordinary tenant saw $DENY_COUNT provider_link rows"; exit 1; }
ADMIN_COUNT="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.provider_link_admin='on'; SELECT count(*) FROM provider_link; COMMIT;" | sql_scalar)"
[ "$ADMIN_COUNT" = "1" ] || { log "FAIL RLS operator view: expected 1 row under provider_link_admin GUC, got $ADMIN_COUNT"; exit 1; }
FORCE_RLS="$(printf "SELECT count(*) FROM pg_class WHERE relname='provider_link' AND relrowsecurity AND relforcerowsecurity;" | sql_scalar)"
[ "$FORCE_RLS" = "1" ] || { log "FAIL provider_link FORCE RLS metadata: $FORCE_RLS"; exit 1; }
log "PASS RLS: provider_link default-denies tenant sessions, unlocks only under provider_link_admin GUC (FORCE)"

# ---- DELETE: revert to env fallback ----------------------------------------
api DELETE "$LINK_PATH" "$OWNER_TOKEN"
expect_status 200 "owner DELETE"
assert_no_plaintext "owner DELETE"
printf '%s' "$RESPONSE_BODY" | jq -e '.configured == false and .source == "environment"' >/dev/null || {
  log "FAIL DELETE response expected configured:false source:environment"; echo "$RESPONSE_BODY" >&2; exit 1; }
ROW_COUNT="$(printf "SELECT count(*) FROM provider_link WHERE id = true;" | sql_scalar)"
[ "$ROW_COUNT" = "0" ] || { log "FAIL DELETE left $ROW_COUNT provider_link rows"; exit 1; }
api GET "$LINK_PATH" "$OWNER_TOKEN"
expect_status 200 "owner GET (after DELETE)"
printf '%s' "$RESPONSE_BODY" | jq -e '.configured == false and .source == "environment"' >/dev/null || {
  log "FAIL GET after DELETE expected configured:false source:environment"; echo "$RESPONSE_BODY" >&2; exit 1; }
log "PASS DELETE: provider link removed, resolution fell back to env"

# ---- ADR-0004: plaintext bearer must never enter the api log ----------------
compose logs --no-color api >"$TMP_DIR/api.log" 2>&1 || true
if grep -Fq -- "$BEARER_SECRET" "$TMP_DIR/api.log"; then
  log "FAIL ADR-0004: plaintext bearer leaked into api log"
  exit 1
fi
log "PASS ADR-0004: plaintext bearer absent from api log"

log "PASS runtime smoke: owner PUT/GET/test/DELETE bytea roundtrip, masking, plaintext non-leak, non-admin 403, RLS default-deny (MOMO-577)"
exit 0
