#!/usr/bin/env bash
# =============================================================================
# scripts/verify_provider_cascade.sh — MOMO-630 provider cascade safety gate
#
# Two layers:
#   1. Worker gate (always): migration 042 presence + FORCE RLS, schema_v0
#      untouched invariant, swift build, and the focused cascade unit tests on
#      BOTH packages (the fall-over rule is mirrored server/worker, so both
#      copies must be green).
#   2. Runtime gate (PROVIDER_CASCADE_RUN_DOCKER=1): boots the real compose stack
#      (PG18 + api + relay + worker) and measures the two things a unit test
#      structurally cannot:
#        * the chain REST contract over live HTTP — GET/PUT/DELETE
#          /v1/provider/link/chain on the MOMO-583 auth model, the position-0
#          back-compat projection, the bytea sealed-box store, the masked-tail
#          projection, the 400 matrix, and provider_link_chain RLS (default-deny
#          tenant, GUC-gated operator, FORCE);
#        * an ACTUAL cascade through the AgentWorker: hop 0 is a provider that
#          never answers, hop 1 is the healthy mock. The turn must succeed on hop
#          1 and leave a `provider.cascade.fallback` audit row plus an
#          outbox-delivered run event (ADR-0135 "조용한 전환 금지"). Then hop 0 is
#          swapped for a 401 provider and the same turn must FAIL without ever
#          touching hop 1 — the "4xx는 전파" half of the rule, which is the one
#          that protects a second provider's budget.
#
# The runtime layer is the point of this gate: the fall-over rule is trivially
# assertable in a unit test and trivially wrong in production if the worker never
# reads the chain, so it is measured against a real worker + real Postgres.
#
# Ports default to the worktree's .conductor/local.env block. schema_v0.sql is
# never modified.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[provider-cascade] $*"; }
fail() { log "FAIL $*" >&2; exit 1; }

# ---- Layer 1: migration + schema invariants --------------------------------
MIGRATION="server/Migrations/042_provider_link_chain.sql"
test -f "$MIGRATION" || fail "missing migration $MIGRATION"
grep -q "CREATE TABLE provider_link_chain" "$MIGRATION" \
  || fail "migration 042 does not create provider_link_chain"
grep -q "FORCE ROW LEVEL SECURITY" "$MIGRATION" \
  || fail "migration 042 must FORCE row level security"
grep -q "position          integer NOT NULL UNIQUE" "$MIGRATION" \
  || fail "migration 042 must keep position UNIQUE (one hop per cascade slot)"
if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -qx "schema_v0.sql"; then
  fail "schema_v0.sql must not be modified"
fi

command -v swift >/dev/null 2>&1 || fail "missing swift toolchain"
log "swift build (server)"
swift build --package-path server >/dev/null
log "swift build (workers/AgentWorker)"
swift build --package-path workers/AgentWorker >/dev/null
log "swift test --filter ProviderCascadeTests (server)"
swift test --package-path server --filter ProviderCascadeTests >/dev/null
log "swift test --filter ProviderCascadeTests (worker)"
swift test --package-path workers/AgentWorker --filter ProviderCascadeTests >/dev/null
log "swift test --filter ProviderLinkTests|ProviderLinkResolutionTests (back-compat)"
swift test --package-path server --filter ProviderLinkTests >/dev/null
swift test --package-path workers/AgentWorker --filter ProviderLinkResolutionTests >/dev/null

log "PASS worker gate: migration 042 present + FORCE RLS, schema_v0 untouched, both cascade copies green"

if [ "${PROVIDER_CASCADE_RUN_DOCKER:-0}" != "1" ]; then
  log "runtime-unverified: the live gate (chain REST over HTTP, provider_link_chain"
  log "  RLS, and a real AgentWorker cascade with fallback audit + outbox evidence)"
  log "  is gated behind PROVIDER_CASCADE_RUN_DOCKER=1 (needs Docker)."
  exit 0
fi

# =============================================================================
# Runtime gate
# =============================================================================
need() { command -v "$1" >/dev/null 2>&1 || fail "missing $1"; }
need docker
need curl
need jq
need python3

new_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
# Worktree ports (.conductor/local.env). Override per environment if needed.
API_PORT="${PROVIDER_CASCADE_API_PORT:-28330}"
CENTRIFUGO_PORT="${PROVIDER_CASCADE_CENTRIFUGO_PORT:-28331}"
PG_PORT="${PROVIDER_CASCADE_POSTGRES_PORT:-28332}"
HERMES_PORT="${PROVIDER_CASCADE_HERMES_PORT:-28333}"
PROJECT="${PROVIDER_CASCADE_PROJECT:-momo622cascade}"
BOOT_TIMEOUT="${PROVIDER_CASCADE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${PROVIDER_CASCADE_ASSERT_TIMEOUT:-240}"

RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-provider-cascade.XXXXXX")"

# In-container ports for the misbehaving hops (extra processes inside the
# mock-hermes container, which already has the source mount and the compose
# network — no compose-file change, no published ports).
SILENT_PORT=8089        # accepts then hangs up -> provider_unreachable
UNAUTHORIZED_PORT=8090  # always 401            -> must propagate
# A dedicated healthy instance rather than the stack's :8088 one: mock_hermes
# emits a tool_call on every turn by default, which parks the run at
# awaiting_approval (MOMO-565) and would mask the run-succeeded assertion. The
# gate needs a pure text roundtrip, so this instance runs with
# MOCK_HERMES_TOOL_CALLS=0 and leaves the shared :8088 fixture untouched.
HEALTHY_PORT=8091
HEALTHY_URL="http://mock-hermes:${HEALTHY_PORT}/v1"
SILENT_URL="http://mock-hermes:${SILENT_PORT}/v1"
UNAUTHORIZED_URL="http://mock-hermes:${UNAUTHORIZED_PORT}/v1"

WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
AGENT_ID="00000000-0000-7000-8000-000000000103"
OWNER_ID="$(new_uuid)"
MEMBER_ID="$(new_uuid)"
OWNER_EMAIL="cascade-owner-$RUN_ID@momo.local"
MEMBER_EMAIL="cascade-member-$RUN_ID@momo.local"
OWNER_PASSWORD="cascade-owner-$(new_uuid)"
MEMBER_PASSWORD="cascade-member-$(new_uuid)"

# Distinctive bearers so any plaintext leak (response body, log, ciphertext at
# rest) is unambiguously detectable.
BEARER_HEAD="sk-momo622-HEAD-PLAINTEXT-do-not-leak-7K2Q"
BEARER_HOP1="sk-momo622-HOP1-PLAINTEXT-do-not-leak-4B9X"
HEAD_LAST4="${BEARER_HEAD: -4}"
HOP1_LAST4="${BEARER_HOP1: -4}"
# Sealed box = version(1) + nonce(12) + ciphertext(=plaintext len) + tag(16).
HOP1_CIPHERTEXT_LEN=$(( ${#BEARER_HOP1} + 29 ))

HEAD_URL_VALUE="https://cascade-head.example.test/v1"
HOP1_URL_VALUE="https://cascade-hop1.example.test/v1"
HOP2_URL_VALUE="https://cascade-hop2.example.test/v1"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENTRIFUGO_PORT" \
    HERMES_PORT="$HERMES_PORT" PLATFORM_ADMIN_EMAILS="$OWNER_EMAIL" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${PROVIDER_CASCADE_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-provider-cascade.*) rm -r -- "$TMP_DIR" ;;
      *) log "refusing unexpected temp path: $TMP_DIR" ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"

# Linux trap: the api/worker containers copy the read-only source mount with
# `cp -Rp`. A host-side `.build/` (the layer-1 swift build just produced one)
# holds symlinks Linux `cp` cannot read, which aborts boot before /health.
for build_dir in \
  "$REPO_ROOT/server/.build" \
  "$REPO_ROOT/workers/AgentWorker/.build" \
  "$REPO_ROOT/services/OutboundHTTPPolicy/.build" \
  "$REPO_ROOT/services/MomoMetrics/.build"; do
  rm -rf "$build_dir" 2>/dev/null || true
done

log "booting isolated PG18 + api + relay + worker stack '$PROJECT' on ${API_PORT}/${PG_PORT}/${CENTRIFUGO_PORT}/${HERMES_PORT}"
compose up -d api relay worker
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    fail "api health timeout"
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    fail "api exited before health"
  fi
  sleep 3
done
log "api health green"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

# ---- Seed an operator (listed instance operator) + a non-admin member -------
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$WORKSPACE_ID', 'human', 'active', 'Cascade Owner', 'cascade-owner-$RUN_ID'),
  ('$MEMBER_ID', '$WORKSPACE_ID', 'human', 'active', 'Cascade Member', 'cascade-member-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WORKSPACE_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$MEMBER_ID', '$WORKSPACE_ID', '$MEMBER_EMAIL', true, momo_password_hash('$MEMBER_PASSWORD'), 'UTC');
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
[ -n "$OWNER_TOKEN" ] && [ -n "$MEMBER_TOKEN" ] || fail "login did not return tokens"

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" token="$3" body="${4:-}" out="$TMP_DIR/response"
  local args=(-sS -o "$out" -w '%{http_code}' --max-time 60 -X "$method" \
    -H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    log "FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}
expect_json() {
  printf '%s' "$RESPONSE_BODY" | jq -e "$1" >/dev/null || {
    log "FAIL $2" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}
assert_no_plaintext() {
  for secret in "$BEARER_HEAD" "$BEARER_HOP1"; do
    if printf '%s' "$RESPONSE_BODY" | grep -Fq -- "$secret"; then
      fail "$1: plaintext bearer leaked into response body"
    fi
  done
}

LINK_PATH="/v1/provider/link"
CHAIN_PATH="/v1/provider/link/chain"
TEST_PATH="/v1/provider/link/test"

# =============================================================================
# A. Chain REST contract
# =============================================================================

# ---- A1 baseline: no singleton, no chain -> position 0 is the env fallback ---
api GET "$CHAIN_PATH" "$OWNER_TOKEN"
expect_status 200 "owner GET chain (baseline)"
expect_json '.schema == "momo.provider_link.chain.v0"
  and (.entries | length) == 1
  and .entries[0].position == 0
  and .entries[0].source == "environment"
  and .fallbackCount == 0' "baseline chain projection"
log "PASS A1: empty chain projects the env fallback as position 0 (이전 경로)"

# ---- A2 non-admin is denied on every chain verb ----------------------------
api GET "$CHAIN_PATH" "$MEMBER_TOKEN"
expect_status 403 "non-admin GET chain"
api PUT "$CHAIN_PATH" "$MEMBER_TOKEN" '{"entries":[]}'
expect_status 403 "non-admin PUT chain"
api DELETE "$CHAIN_PATH" "$MEMBER_TOKEN"
expect_status 403 "non-admin DELETE chain"
log "PASS A2: chain reuses the MOMO-583 operator gate (non-admin 403 on every verb)"

# ---- A3 configure position 0 through the LEGACY singleton surface ------------
api PUT "$LINK_PATH" "$OWNER_TOKEN" \
  "$(jq -cn --arg u "$HEAD_URL_VALUE" --arg b "$BEARER_HEAD" \
    '{baseUrl:$u,bearer:$b,mode:"external-hermes"}')"
expect_status 200 "legacy PUT provider link"
assert_no_plaintext "legacy PUT"
printf '%s' "$RESPONSE_BODY" | jq -e --arg l4 "$HEAD_LAST4" '
    .schema == "momo.provider_link.v0"
    and .configured == true
    and .source == "database"
    and .bearerLast4 == $l4
  ' >/dev/null || { log "FAIL A3 legacy singleton projection" >&2; echo "$RESPONSE_BODY" >&2; exit 1; }
log "PASS A3: legacy GET/PUT /v1/provider/link still owns position 0, shape unchanged (하위호환)"

# ---- A4 PUT the fallback chain ---------------------------------------------
api PUT "$CHAIN_PATH" "$OWNER_TOKEN" \
  "$(jq -cn --arg u1 "$HOP1_URL_VALUE" --arg b1 "$BEARER_HOP1" --arg u2 "$HOP2_URL_VALUE" '
    {entries:[
      {position:2,baseUrl:$u2,bearer:"sk-momo622-hop2-secondary-1Z",mode:"external-hermes",enabled:false},
      {position:1,baseUrl:$u1,bearer:$b1,mode:"external-hermes",enabled:true}
    ]}')"
expect_status 200 "owner PUT chain"
assert_no_plaintext "owner PUT chain"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg l4 "$HOP1_LAST4" '
    (.entries | map(.position)) == [0,1,2]
    and .entries[1].source == "chain"
    and .entries[1].bearerLast4 == $l4
    and .entries[1].enabled == true
    and .entries[2].enabled == false
    and .fallbackCount == 2
    and .attemptableCount == 2
  ' >/dev/null || { log "FAIL A4 chain projection" >&2; echo "$RESPONSE_BODY" >&2; exit 1; }
log "PASS A4: chain stored in position order, parked hop excluded from attemptableCount, tails masked"

# ---- A5 storage proof: real bytea sealed boxes, plaintext absent at rest -----
VERSION_BYTE="$(printf "SELECT get_byte(bearer_ciphertext, 0) FROM provider_link_chain WHERE position = 1;" | sql_scalar)"
[ "$VERSION_BYTE" = "1" ] || fail "A5 stored version byte: got '$VERSION_BYTE' want 1"
CIPHERTEXT_LEN="$(printf "SELECT octet_length(bearer_ciphertext) FROM provider_link_chain WHERE position = 1;" | sql_scalar)"
[ "$CIPHERTEXT_LEN" = "$HOP1_CIPHERTEXT_LEN" ] \
  || fail "A5 ciphertext octet_length: got '$CIPHERTEXT_LEN' want $HOP1_CIPHERTEXT_LEN"
PLAINTEXT_POS="$(printf "SELECT position(convert_to('%s','UTF8') in bearer_ciphertext) FROM provider_link_chain WHERE position = 1;" "$BEARER_HOP1" | sql_scalar)"
[ "$PLAINTEXT_POS" = "0" ] || fail "A5 plaintext bearer present at rest (pos=$PLAINTEXT_POS)"
log "PASS A5: chain bearers are AES-GCM sealed boxes (version=1, len=$CIPHERTEXT_LEN), plaintext absent at rest"

# ---- A6 GET returns the same projection ------------------------------------
api GET "$CHAIN_PATH" "$OWNER_TOKEN"
expect_status 200 "owner GET chain (after PUT)"
assert_no_plaintext "owner GET chain"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg l4 "$HOP1_LAST4" --arg u "$HOP1_URL_VALUE" '
    (.entries | map(.position)) == [0,1,2]
    and .entries[1].baseUrl == $u
    and .entries[1].bearerLast4 == $l4
  ' >/dev/null || { log "FAIL A6 GET projection" >&2; echo "$RESPONSE_BODY" >&2; exit 1; }
log "PASS A6: chain store+decrypt roundtrip confirmed over live REST"

# ---- A7 400 matrix ----------------------------------------------------------
api PUT "$CHAIN_PATH" "$OWNER_TOKEN" \
  "$(jq -cn --arg u "$HOP1_URL_VALUE" '{entries:[{position:0,baseUrl:$u,bearer:"sk-x"}]}')"
expect_status 400 "position 0 rejected"
api PUT "$CHAIN_PATH" "$OWNER_TOKEN" \
  "$(jq -cn --arg u "$HOP1_URL_VALUE" '{entries:[{position:1,baseUrl:$u,bearer:"sk-a"},{position:1,baseUrl:$u,bearer:"sk-b"}]}')"
expect_status 400 "duplicate position rejected"
api PUT "$CHAIN_PATH" "$OWNER_TOKEN" \
  "$(jq -cn --arg u "$HOP1_URL_VALUE" '{entries:[{position:1,baseUrl:$u,bearer:"sk-a",codexOauthToken:"leak"}]}')"
expect_status 400 "ADR-0004 closed-world: oauth-shaped field rejected"
api PUT "$CHAIN_PATH" "$OWNER_TOKEN" \
  '{"entries":[{"position":1,"baseUrl":"http://plain.example/v1","bearer":"sk-a"}]}'
expect_status 400 "non-loopback http baseUrl rejected"
log "PASS A7: 400 matrix (position 0, duplicate, oauth-shaped field, plain http)"

# ---- A8 omitted bearer keeps the stored ciphertext --------------------------
CIPHERTEXT_BEFORE="$(printf "SELECT md5(bearer_ciphertext) FROM provider_link_chain WHERE position = 1;" | sql_scalar)"
api PUT "$CHAIN_PATH" "$OWNER_TOKEN" \
  "$(jq -cn --arg u1 "$HOP1_URL_VALUE" --arg u2 "$HOP2_URL_VALUE" '
    {entries:[
      {position:1,baseUrl:$u1,mode:"external-hermes",enabled:true},
      {position:2,baseUrl:$u2,bearer:"sk-momo622-hop2-secondary-1Z",mode:"external-hermes",enabled:false}
    ]}')"
expect_status 200 "PUT chain without bearer (reorder/park path)"
CIPHERTEXT_AFTER="$(printf "SELECT md5(bearer_ciphertext) FROM provider_link_chain WHERE position = 1;" | sql_scalar)"
[ "$CIPHERTEXT_BEFORE" = "$CIPHERTEXT_AFTER" ] \
  || fail "A8 omitted bearer must retain the stored ciphertext"
printf '%s' "$RESPONSE_BODY" | jq -e --arg l4 "$HOP1_LAST4" '.entries[1].bearerLast4 == $l4' >/dev/null \
  || fail "A8 retained bearer no longer decrypts to the same tail"
log "PASS A8: an operator can reorder/park a hop without re-entering the write-only bearer"

# ---- A9 chain-wide probe ----------------------------------------------------
api POST "$TEST_PATH" "$OWNER_TOKEN"
expect_status 200 "owner POST test (chain probe)"
assert_no_plaintext "owner POST test"
# Legacy v0 fields still describe position 0 (macOS client back-compat)…
printf '%s' "$RESPONSE_BODY" | jq -e '
    .schema == "momo.provider_link.test.v0"
    and .source == "database"
    and .mode == "external-hermes"
    and has("ok") and has("reason") and has("endpointLabel") and has("checkedAtMs")
  ' >/dev/null || { log "FAIL A9 legacy field back-compat" >&2; echo "$RESPONSE_BODY" >&2; exit 1; }
# …and the chain extension reports every hop with its cascade disposition.
printf '%s' "$RESPONSE_BODY" | jq -e '
    (.entries | length) == 3
    and (.entries | map(.position)) == [0,1,2]
    and has("cascadeOk")
    and (.entries[2].disposition == "skipped")
    and ([.entries[] | select(.position < 2) | .disposition]
         | all(. == "fall_over" or . == "propagate" or . == "ok"))
  ' >/dev/null || { log "FAIL A9 chain probe array" >&2; echo "$RESPONSE_BODY" >&2; exit 1; }
DISPOSITIONS="$(printf '%s' "$RESPONSE_BODY" | jq -c '[.entries[] | {p:.position,d:.disposition,r:.reason}]')"
log "PASS A9: POST /test probes the whole chain; dispositions=$DISPOSITIONS"

# ---- A10 provider_link_chain RLS -------------------------------------------
DENY_COUNT="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='%s'; SELECT count(*) FROM provider_link_chain; COMMIT;" "$WORKSPACE_ID" | sql_scalar)"
[ "$DENY_COUNT" = "0" ] || fail "A10 RLS default-deny: ordinary tenant saw $DENY_COUNT chain rows"
ADMIN_COUNT="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.provider_link_admin='on'; SELECT count(*) FROM provider_link_chain; COMMIT;" | sql_scalar)"
[ "$ADMIN_COUNT" = "2" ] || fail "A10 RLS operator view: expected 2 rows under the GUC, got $ADMIN_COUNT"
FORCE_RLS="$(printf "SELECT count(*) FROM pg_class WHERE relname='provider_link_chain' AND relrowsecurity AND relforcerowsecurity;" | sql_scalar)"
[ "$FORCE_RLS" = "1" ] || fail "A10 provider_link_chain FORCE RLS metadata: $FORCE_RLS"
log "PASS A10: provider_link_chain default-denies tenant sessions, unlocks only under provider_link_admin GUC (FORCE)"

# =============================================================================
# B. Real cascade through the AgentWorker
# =============================================================================

# ---- B1 start the misbehaving hops inside the mock-hermes container ---------
# Extra processes in an existing container: same compose network, no compose-file
# change, no published ports.
compose exec -T -d mock-hermes \
  python3 scripts/mock_provider_hop.py --port "$SILENT_PORT" --mode hangup
compose exec -T -d mock-hermes \
  python3 scripts/mock_provider_hop.py --port "$UNAUTHORIZED_PORT" --mode status --status 401
compose exec -T -d -e MOCK_HERMES_TOOL_CALLS=0 mock-hermes \
  python3 scripts/mock_hermes.py --host 0.0.0.0 --port "$HEALTHY_PORT"
for port in "$SILENT_PORT" "$UNAUTHORIZED_PORT" "$HEALTHY_PORT"; do
  ready=0
  for _ in $(seq 1 30); do
    if compose exec -T mock-hermes python3 -c \
      "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:$port/health', timeout=2).read()" \
      >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 1
  done
  [ "$ready" = "1" ] || fail "B1 mock provider hop on :$port did not come up"
done
log "PASS B1: hops up — :$SILENT_PORT hangs up, :$UNAUTHORIZED_PORT returns 401, :$HEALTHY_PORT serves text"

# The chain REST surface deliberately refuses mock/non-https hosts
# (AgentRoutes.validatedBaseURL), so the runtime hops are pointed at the
# in-network mocks with SQL. Only the URL *policy* is bypassed: the bearer stays
# the AES-GCM ciphertext the API sealed (copied from the singleton row), so the
# worker still exercises the real read + decrypt + cascade path.
point_cascade_at() {
  local head_url="$1"
  # `updated_at` MUST be bumped: the worker's ProviderLinkCache uses it as the
  # change key and skips the decrypt (returning the previously cached link) when
  # it is unchanged. The REST upsert always bumps it, so a raw UPDATE that does
  # not is a verifier-only hazard — without this the worker keeps serving the
  # PREVIOUS hop and the propagate case silently "passes" as a fall-over.
  run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE provider_link
   SET base_url = '$head_url',
       mode = 'external-hermes',
       updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
 WHERE id = true;
DELETE FROM provider_link_chain;
INSERT INTO provider_link_chain (position, base_url, bearer_ciphertext, mode, enabled)
SELECT 1, '$HEALTHY_URL', bearer_ciphertext, 'external-hermes', true FROM provider_link WHERE id = true;
COMMIT;
SQL
  # Outlive the worker's provider-resolution TTL so the next turn is guaranteed
  # to see this chain (PROVIDER_LINK_CACHE_TTL_MS, default 2000).
  sleep 4
}

inject_turn() {
  local run_uuid="$1" prompt="$2"
  run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, step_count, max_steps,
   depth, input, idempotency_key)
VALUES
  ('$run_uuid', '$WORKSPACE_ID', '$AGENT_ID', '$CHANNEL_ID', 'queued', 0, 12, 0,
   jsonb_build_object('prompt', '$prompt'),
   'momo-622-cascade-$run_uuid');
INSERT INTO outbox
  (workspace_id, kind, status, method, payload, partition_key)
VALUES
  ('$WORKSPACE_ID', 'agent_job', 'pending', 'publish',
   jsonb_build_object(
     'run_id', '$run_uuid',
     'workspace_id', '$WORKSPACE_ID',
     'agent_member_id', '$AGENT_ID',
     'channel_id', '$CHANNEL_ID',
     'model', 'hermes-agent',
     'prompt', '$prompt',
     'max_output_tokens', 64,
     'step_count', 0,
     'depth', 0,
     'consecutive_auto', 0
   ),
   '$AGENT_ID');
COMMIT;
SQL
}

await_run_status() {
  local run_uuid="$1" want="$2" status=""
  local deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    status="$(printf "SELECT status FROM agent_run WHERE id='%s';" "$run_uuid" | sql_scalar)"
    [ "$status" = "$want" ] && { echo "$status"; return 0; }
    case "$status" in
      succeeded|failed|cancelled|timed_out) echo "$status"; return 0 ;;
    esac
    if [ -n "$(compose ps -aq --status exited worker 2>/dev/null)" ]; then
      compose logs --tail 160 worker >&2 || true
      fail "worker exited while awaiting run $run_uuid"
    fi
    sleep 2
  done
  echo "${status:-timeout}"
}

# ---- B2/B3 무응답 -> 2차 성공 -----------------------------------------------
point_cascade_at "$SILENT_URL"
FALLOVER_RUN="$(new_uuid)"
inject_turn "$FALLOVER_RUN" "MOMO-622 cascade fallover probe"
STATUS="$(await_run_status "$FALLOVER_RUN" succeeded)"
[ "$STATUS" = "succeeded" ] || {
  compose logs --tail 200 worker >&2 || true
  fail "B3 cascade run ended '$STATUS', expected succeeded on hop 1"
}
log "PASS B3: hop 0 never answered, hop 1 served the turn (run succeeded)"

# ---- B4 the transition is recorded: audit row -------------------------------
AUDIT_JSON="$(run_sql -tA <<SQL
SELECT detail::text FROM audit_log
 WHERE workspace_id = '$WORKSPACE_ID'
   AND action = 'provider.cascade.fallback'
   AND run_id = '$FALLOVER_RUN';
SQL
)"
[ -n "$AUDIT_JSON" ] || {
  compose logs --tail 200 worker >&2 || true
  fail "B4 no provider.cascade.fallback audit row for run $FALLOVER_RUN"
}
printf '%s' "$AUDIT_JSON" | jq -e '
    .schema == "momo.provider.cascade.fallback.v1"
    and .from == 0 and .to == 1
    and .reason == "provider_unreachable"
    and (.to_endpoint_label | test("mock-hermes:'"$HEALTHY_PORT"'"))
  ' >/dev/null || { log "FAIL B4 audit detail" >&2; echo "$AUDIT_JSON" >&2; exit 1; }
AUDIT_COUNT="$(printf "SELECT count(*) FROM audit_log WHERE action='provider.cascade.fallback' AND run_id='%s';" "$FALLOVER_RUN" | sql_scalar)"
[ "$AUDIT_COUNT" = "1" ] || fail "B4 expected exactly 1 fallback audit row, got $AUDIT_COUNT"
log "PASS B4: audit row provider.cascade.fallback {from:0,to:1,reason:provider_unreachable}"

# ---- B5 the transition is broadcast through the OUTBOX ----------------------
OUTBOX_JSON="$(run_sql -tA <<SQL
SELECT payload::text FROM outbox
 WHERE workspace_id = '$WORKSPACE_ID'
   AND kind = 'broadcast'
   AND payload->'data'->>'type' = 'provider.cascade.fallback'
   AND lower(payload->'data'->'payload'->>'run_id') = lower('$FALLOVER_RUN');
SQL
)"
[ -n "$OUTBOX_JSON" ] || fail "B5 no outbox run event for the cascade transition (단일 쓰기경로 위반)"
printf '%s' "$OUTBOX_JSON" | jq -e \
  --arg ch "ch:ws${WORKSPACE_ID}.${CHANNEL_ID}" '
    .channel == $ch
    and .data.type == "provider.cascade.fallback"
    and .data.payload.from == 0
    and .data.payload.to == 1
    and .data.payload.reason == "provider_unreachable"
    and (.idempotency_key | test("provider.cascade.fallback"))
  ' >/dev/null || { log "FAIL B5 outbox payload" >&2; echo "$OUTBOX_JSON" >&2; exit 1; }
log "PASS B5: run event delivered via outbox (kind=broadcast), not a direct broker publish"

# ---- B6 401 propagates and never spends hop 1 -------------------------------
point_cascade_at "$UNAUTHORIZED_URL"
PROPAGATE_RUN="$(new_uuid)"
inject_turn "$PROPAGATE_RUN" "MOMO-622 cascade propagate probe"
STATUS="$(await_run_status "$PROPAGATE_RUN" failed)"
[ "$STATUS" = "failed" ] || {
  compose logs --tail 200 worker >&2 || true
  fail "B6 a 401 on hop 0 must fail the run, got '$STATUS' (silent fall-over?)"
}
# Pin that hop 0 really was the 401 provider. Without this a stale provider
# resolution (worker still pointed at the previous hop) would let a fall-over
# masquerade as a pass — exactly the false green this gate exists to prevent.
RUN_ERROR="$(printf "SELECT coalesce(error #>> '{}', '') FROM agent_run WHERE id='%s';" "$PROPAGATE_RUN" | sql_scalar)"
case "$RUN_ERROR" in
  *401*) ;;
  *) fail "B6 run error '$RUN_ERROR' does not mention 401 — hop 0 was not the 401 provider" ;;
esac
PROPAGATE_AUDIT="$(printf "SELECT count(*) FROM audit_log WHERE action='provider.cascade.fallback' AND run_id='%s';" "$PROPAGATE_RUN" | sql_scalar)"
[ "$PROPAGATE_AUDIT" = "0" ] \
  || fail "B6 a 401 recorded $PROPAGATE_AUDIT fallback rows — 4xx must propagate, never fall over"
log "PASS B6: 401 on hop 0 propagated (run failed with $RUN_ERROR, 0 fallback rows) — hop 1's budget untouched"

# The cascade's typed propagate disposition must reach the worker terminal
# branch. A 401 used to be requeued (up to WORKER_MAX_ATTEMPTS); this proves the
# same first claim is terminal and no retry amplification is pending.
PROPAGATE_JOB="$(run_sql -tA <<SQL
SELECT json_build_object('status', status, 'attempts', attempts)::text
  FROM outbox
 WHERE kind = 'agent_job'
   AND payload->>'run_id' = '$PROPAGATE_RUN'
 ORDER BY id DESC
 LIMIT 1;
SQL
)"
printf '%s' "$PROPAGATE_JOB" | jq -e '
    .status == "failed" and .attempts == 1
  ' >/dev/null || {
    fail "B6 401 agent_job was requeued or claimed more than once: $PROPAGATE_JOB"
  }
log "PASS B6: 401 terminal failure leaves agent_job status=failed, attempts=1 (no requeue)"

# =============================================================================
# C. ADR-0004: plaintext bearers never reach the logs
# =============================================================================
compose logs --no-color api >"$TMP_DIR/api.log" 2>&1 || true
compose logs --no-color worker >"$TMP_DIR/worker.log" 2>&1 || true
for secret in "$BEARER_HEAD" "$BEARER_HOP1"; do
  # `grep -q ... && fail` would abort the SUCCESS path under `set -e` (the
  # compound's status is grep's non-zero "not found"). Use an explicit if.
  if grep -Fq -- "$secret" "$TMP_DIR/api.log"; then
    fail "C: plaintext bearer leaked into the api log"
  fi
  if grep -Fq -- "$secret" "$TMP_DIR/worker.log"; then
    fail "C: plaintext bearer leaked into the worker log"
  fi
done
log "PASS C: ADR-0004 — plaintext bearers absent from api and worker logs"

log "PASS runtime gate: chain REST + RLS + a real AgentWorker cascade (무응답→2차 성공 with audit+outbox evidence, 401→전파)"
exit 0
