#!/usr/bin/env bash
# MOMO-670 / ADR-0142 D3 — cross-provider continuity is the ordinary resume path.
#
# What this gate claims, in one sentence: a session whose substrate died on
# `mock-a` converges to a named `provider_missing` terminal state and resumes on
# `mock-b` through the *existing* resume REST, with `resumed_from_session_id`
# linking the two — no cross-provider special case exists, because there is
# nothing provider-specific left to special-case.
#
# The two negative obligations of ADR-0142 D3 are what make it falsifiable:
#   D3.1 the adapter reports death honestly. Red proof:
#        `T3_CONTINUITY_PROVE_RED=dishonest-probe` makes mock-a answer `present`
#        for the instance it just refused to resume. momo then refuses to settle
#        a paid session on a self-contradicting provider, convergence never
#        happens, and this gate fails by name at a bounded deadline
#        (`provider-missing-convergence`) — it does not hang and does not pass.
#   D3.2 continuity state does not live inside the provider. Nothing in the
#        resume below reads mock-a; mock-a is dead when it runs.
#
# Docker verification is the orchestrator's to run. `T3_GATE_RUN_DOCKER=0`
# keeps the static half.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-continuity] $*"; }
fail() { echo "[t3-continuity] FAIL $*" >&2; exit 1; }
pass() { echo "[t3-continuity] PASS $*"; }

find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-t3c-openssl.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" genpkey -algorithm ED25519 -out "$probe" >/dev/null 2>&1; then
      rm -f "$probe"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  rm -f "$probe"
  fail "no OpenSSL with Ed25519 support found"
}

# ---- static half ------------------------------------------------------------

ADAPTER="services/CloudProviderKit/Sources/CloudProviderKit/CloudProviderAdapter.swift"
REGISTRY="services/CloudProviderKit/Sources/CloudProviderKit/CloudProviderRegistry.swift"
RECONCILER="workers/NotifierWorker/Sources/NotifierWorker/CloudLifecycleReconciler.swift"
MIGRATION="server/Migrations/054_t3_provider_registry.sql"
for required in "$ADAPTER" "$REGISTRY" "$RECONCILER" "$MIGRATION"; do
  test -f "$required" || fail "missing $required"
done
grep -q "case unknown" "$ADAPTER" \
  || fail "named gate probe-is-three-valued"
grep -q "supportsPause" "$ADAPTER" \
  || fail "named gate capability-declaration"
grep -q "mock-a" "$REGISTRY" && grep -q "mock-b" "$REGISTRY" \
  || fail "named gate two-mock-substrates"
grep -q "provider denied its own missing instance" "$RECONCILER" \
  || fail "named gate dishonest-provider-refusal"
grep -q "ALTER COLUMN provider DROP DEFAULT" "$MIGRATION" \
  || fail "named gate provider-must-be-stated"
if git diff --name-only HEAD -- schema_v0.sql | grep -q .; then
  fail "schema_v0.sql must not change"
fi
scripts/check_migration_numbers.sh server/Migrations >/dev/null
bash -n "$0"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" \
  python3 -m py_compile scripts/mock_provider.py

if [ "${T3_GATE_RUN_DOCKER:-1}" != "1" ]; then
  pass "static adapter/registry/migration checks"
  exit 0
fi

# ---- runtime half -----------------------------------------------------------

for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing $tool"
done
OPENSSL_BIN="$(find_openssl)"

# Never sources .env: both provider keys below are literal fakes pointed at
# local mock substrates.
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
SAFE_ENV_FILE="$REPO_ROOT/infra/.env.example"
PROJECT="${T3_CONTINUITY_PROJECT:-momo670cont}"
API_PORT="${T3_CONTINUITY_API_PORT:-28060}"
PG_PORT="${T3_CONTINUITY_POSTGRES_PORT:-28061}"
CENT_PORT_HOST="${T3_CONTINUITY_CENTRIFUGO_PORT:-28062}"
HERMES_PORT_HOST="${T3_CONTINUITY_HERMES_PORT:-28063}"
PUSH_PORT_HOST="${T3_CONTINUITY_PUSH_RELAY_PORT:-28064}"
MOCK_A_PORT="${T3_CONTINUITY_MOCK_A_PORT:-28065}"
MOCK_B_PORT="${T3_CONTINUITY_MOCK_B_PORT:-28066}"
BOOT_TIMEOUT="${T3_CONTINUITY_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${T3_CONTINUITY_ASSERT_TIMEOUT:-120}"
RUN_TAG="$(date -u +%s)-$$"
OWNER_EMAIL="t3c-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="t3c-$RUN_TAG"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-continuity.XXXXXX")"
BASE_URL="http://127.0.0.1:$API_PORT"
DEFAULT_PROVIDER="mock-a"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" PUSH_RELAY_PORT="$PUSH_PORT_HOST" \
    MOMO_T3_ENABLED=1 \
    MOMO_T3_PROVIDER="$DEFAULT_PROVIDER" \
    MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL="http://host.docker.internal:$MOCK_A_PORT" \
    MOMO_T3_PROVIDER_MOCK_A_API_KEY="mock-a-not-a-credential" \
    MOMO_T3_PROVIDER_MOCK_A_IMAGE_REF="momo-workd" \
    MOMO_T3_PROVIDER_MOCK_B_API_BASE_URL="http://host.docker.internal:$MOCK_B_PORT" \
    MOMO_T3_PROVIDER_MOCK_B_API_KEY="mock-b-not-a-credential" \
    MOMO_T3_PROVIDER_MOCK_B_IMAGE_REF="momo-workd" \
    MOMO_PUBLIC_BASE_URL="https://momo.invalid" \
    MOMO_T3_RATE_MICRO_USD_PER_SECOND=25 \
    PLATFORM_ADMIN_EMAILS="$OWNER_EMAIL" \
    PLATFORM_ADMIN_LOGIN_SECRET="local-gate-admin-secret" \
    MOMO_HOST_OFFLINE_GRACE_S=1 NOTIFIER_POLL_INTERVAL_MS=100 \
    docker compose --env-file "$SAFE_ENV_FILE" -p "$PROJECT" -f "$COMPOSE_FILE" \
      --profile push "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  for pid in "${MOCK_A_PID:-}" "${MOCK_B_PID:-}"; do
    [ -n "$pid" ] || continue
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  done
  if [ "${T3_CONTINUITY_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-t3-continuity.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[t3-continuity] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

MOCK_A_ARGS=()
if [ "${T3_CONTINUITY_PROVE_RED:-}" = "dishonest-probe" ]; then
  # Red proof: mock-a hides its own death from `probe`.
  MOCK_A_ARGS+=(--dishonest-probe)
fi
python3 scripts/mock_provider.py --host 0.0.0.0 --port "$MOCK_A_PORT" \
  --provider-id mock-a "${MOCK_A_ARGS[@]+"${MOCK_A_ARGS[@]}"}" \
  >"$TMP_DIR/mock-a.log" 2>&1 &
MOCK_A_PID=$!
python3 scripts/mock_provider.py --host 0.0.0.0 --port "$MOCK_B_PORT" \
  --provider-id mock-b >"$TMP_DIR/mock-b.log" 2>&1 &
MOCK_B_PID=$!
deadline=$(( $(date -u +%s) + 30 ))
for port in "$MOCK_A_PORT" "$MOCK_B_PORT"; do
  until curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
    [ "$(date -u +%s)" -lt "$deadline" ] || fail "mock substrate health timeout on $port"
    sleep 1
  done
done

wait_api() {
  local deadline
  deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
  until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
    if [ "$(date -u +%s)" -ge "$deadline" ]; then
      compose logs --tail 200 api >&2 || true
      fail "API health timeout"
    fi
    sleep 2
  done
}

log "booting isolated PG18/API with mock-a as the default substrate"
compose up -d api
wait_api

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" \
    -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
OWNER_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TOPUP_REF="$(python3 -c 'import uuid; print(uuid.uuid4())')"
CREATE_REF_A="$(python3 -c 'import uuid; print(uuid.uuid4())')"
CREATE_REF_B="$(python3 -c 'import uuid; print(uuid.uuid4())')"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$OWNER_ID'::uuid, '$WS_ID'::uuid, 'human'::member_kind,
        'active'::member_status, 'T3C Owner', 't3c-owner-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID'::uuid, '$WS_ID'::uuid, '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID'::uuid, '$OWNER_ID'::uuid, 'owner');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID'::uuid, '$CHANNEL_ID'::uuid, '$OWNER_ID'::uuid, 'owner');
UPDATE work_pool SET max_active=4, per_member_soft_limit=4
 WHERE workspace_id='$WS_ID'::uuid;
COMMIT;
SQL

TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w,
      platformAdminSecret:"local-gate-admin-secret"}')" | jq -er '.accessToken')"

STATUS=""
BODY=""
api() {
  local method="$1" path="$2" data="${3:-}"
  local -a args=(-sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN")
  [ -n "$data" ] && args+=(--data "$data")
  STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  BODY="$(<"$TMP_DIR/response.json")"
}
expect_status() {
  [ "$STATUS" = "$1" ] || {
    echo "$BODY" >&2
    fail "$2: expected $1 got $STATUS"
  }
}

api POST "/v1/admin/workspaces/$WS_ID/credits/topups" \
  "$(jq -cn --arg ref "$TOPUP_REF" '{amountMicroUsd:5000000,idempotencyRef:$ref}')"
expect_status 200 "instance-operator topup"

# Provision a host on whichever substrate is currently the default, then let the
# cloud workd consume its one-shot token exactly as it would in production.
provision_host() {
  local create_ref="$1" mock_port="$2" expected_provider="$3" label="$4"
  local private_key public_der public_key provision_id bootstrap_token register_body

  api POST "/v1/workspaces/$WS_ID/work-hosts/cloud" \
    "$(jq -cn --arg ref "$create_ref" --arg n "$label" \
      '{displayName:$n,confirmPaidCloud:true,idempotencyRef:$ref}')"
  expect_status 202 "$label provisioning accepted"
  provision_id="$(printf '%s' "$BODY" | jq -er '.cloudHost.provisionId')"

  local deadline
  deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
  bootstrap_token=""
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    bootstrap_token="$(curl -fsS "http://127.0.0.1:$mock_port/requests" \
      | jq -r '[.requests[] | select(.path == "/v1/instances")][0].body.env.MOMO_WORKD_REGISTRATION_TOKEN // empty')"
    [ -n "$bootstrap_token" ] && break
    sleep 1
  done
  [ -n "$bootstrap_token" ] || fail "$label: reconciler never created an instance"

  private_key="$TMP_DIR/$expected_provider-private.pem"
  public_der="$TMP_DIR/$expected_provider-public.der"
  "$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$private_key" >/dev/null 2>&1
  "$OPENSSL_BIN" pkey -in "$private_key" -pubout -outform DER \
    -out "$public_der" >/dev/null 2>&1
  public_key="$(tail -c 32 "$public_der" | "$OPENSSL_BIN" base64 -A)"
  register_body="$(jq -cn --arg key "$public_key" --arg n "$label" \
    '{scope:"workspace",type:"cloud",displayName:$n,publicKey:$key,
      capabilities:{"tool.codex":true}}')"
  STATUS="$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X POST \
    "$BASE_URL/v1/workspaces/$WS_ID/work-hosts/cloud/register" \
    -H 'Content-Type: application/json' \
    -H "Authorization: MomoBootstrap $bootstrap_token" \
    --data "$register_body")"
  BODY="$(<"$TMP_DIR/response.json")"
  expect_status 201 "$label cloud workd self-registration"
  PROVISIONED_HOST_ID="$(printf '%s' "$BODY" | jq -er '.workHost.id')"
  PROVISIONED_PRIVATE_KEY="$private_key"
  [ "$(sql_value <<SQL
SELECT provider FROM work_cloud_host WHERE id='$provision_id'::uuid;
SQL
)" = "$expected_provider" ] \
    || fail "$label: provision row does not name its adapter registry id"
}

compose up -d notifier
provision_host "$CREATE_REF_A" "$MOCK_A_PORT" "mock-a" "continuity source"
HOST_A="$PROVISIONED_HOST_ID"
KEY_A="$PROVISIONED_PRIVATE_KEY"
pass "mock-a host provisioned through the adapter and self-registered"

api POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg ch "$CHANNEL_ID" --arg host "$HOST_A" \
    '{channelId:$ch,hostId:$host,tool:"codex",label:"continuity lineage"}')"
expect_status 201 "source work session create"
SESSION_A="$(printf '%s' "$BODY" | jq -er '.workSession.id')"
INSTANCE_A="$(sql_value <<SQL
SELECT provider_sandbox_id FROM work_cloud_host
 WHERE host_id='$HOST_A'::uuid;
SQL
)"
[ -n "$INSTANCE_A" ] || fail "mock-a host kept no provider instance handle"

# mock-a dies mid-flight: the resume REST loses its answer, and the durable
# intent — not the caller — is what carries the retry.
curl -fsS -X POST "http://127.0.0.1:$MOCK_A_PORT/controls/resume-drop-then-missing" \
  >/dev/null
sleep 2
HOST_PATH="/v1/workspaces/$WS_ID/work-sessions/$SESSION_A"
sign_host_request() {
  local method="$1" path="$2" host_id="$3" private_key="$4" data="$5"
  local sent_at request_id body_hash payload signature
  sent_at="$(python3 -c 'import time; print(time.time_ns() // 1_000_000)')"
  request_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  body_hash="$(printf '%s' "$data" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $NF}')"
  payload="$TMP_DIR/host-request-$sent_at.txt"
  printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
    "$method" "$path" \
    "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" "$body_hash" "$request_id" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$private_key" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  STATUS="$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' \
    -H "Authorization: MomoHost $host_id" \
    -H "X-Momo-Work-Host-Sent-At: $sent_at" \
    -H "X-Momo-Work-Host-Signature: $signature" \
    -H "X-Momo-Work-Host-Request-ID: $request_id" \
    --data "$data" "$BASE_URL$path")"
  BODY="$(<"$TMP_DIR/response.json")"
}
sign_host_request PATCH "$HOST_PATH" "$HOST_A" "$KEY_A" '{"status":"idle","exitCode":0}'
expect_status 200 "source session idle->pause"

api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_A/cloud/resume"
expect_status 503 "resume against a dying substrate loses its answer"

CONVERGED=""
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  CONVERGED="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_session
    WHERE id='$SESSION_A'::uuid AND status='orphaned') || ':' ||
  (SELECT count(*) FROM work_cloud_host
    WHERE host_id='$HOST_A'::uuid AND state='destroyed') || ':' ||
  (SELECT count(*) FROM work_host_usage
    WHERE session_id='$SESSION_A'::uuid AND settled_at IS NOT NULL) || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.cloud.resume_failed'
      AND lower(detail->>'session_id')=lower('$SESSION_A')
      AND detail->>'reason'='sandbox_missing'
      AND detail->>'provider'='mock-a');
SQL
)"
  [ "$CONVERGED" = "1:1:1:1" ] && break
  sleep 1
done
[ "$CONVERGED" = "1:1:1:1" ] || {
  compose logs --tail 200 notifier >&2 || true
  # Reached under the red proof: mock-a claimed `present` for the instance it
  # had just refused to resume, momo refused to settle on that contradiction,
  # and no convergence exists to observe. Named, bounded, red.
  fail "provider-missing-convergence: $CONVERGED"
}
pass "dead mock-a converged to a named provider_missing terminal state"

# D3.2: everything needed to continue is in momo's own ledger. mock-a is gone.
DEFAULT_PROVIDER="mock-b"
compose up -d --force-recreate api notifier
wait_api
TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w,
      platformAdminSecret:"local-gate-admin-secret"}')" | jq -er '.accessToken')"
provision_host "$CREATE_REF_B" "$MOCK_B_PORT" "mock-b" "continuity target"
HOST_B="$PROVISIONED_HOST_ID"
pass "mock-b host provisioned with no code path aware of which substrate it is"

api POST "/v1/workspaces/$WS_ID/work-sessions/$SESSION_A/resume" \
  "$(jq -cn --arg host "$HOST_B" '{targetHostId:$host}')"
expect_status 201 "cross-provider resume uses the ordinary resume REST"
SESSION_B="$(printf '%s' "$BODY" | jq -er '.workSession.id')"

LINEAGE="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_session
    WHERE id='$SESSION_B'::uuid
      AND lower(resumed_from_session_id::text)=lower('$SESSION_A')) || ':' ||
  (SELECT count(DISTINCT ch.provider) FROM work_session ws
     JOIN work_cloud_host ch ON ch.host_id=ws.host_id
    WHERE ws.id IN ('$SESSION_A'::uuid, '$SESSION_B'::uuid)) || ':' ||
  (SELECT count(*) FROM work_session a JOIN work_session b ON b.id='$SESSION_B'::uuid
    WHERE a.id='$SESSION_A'::uuid AND a.channel_id=b.channel_id
      AND a.root_message_id=b.root_message_id AND a.tool=b.tool
      AND a.observation=b.observation) || ':' ||
  (SELECT count(*) FROM credit_entry
    WHERE workspace_id='$WS_ID'::uuid AND reason='t3_usage'
      AND lower(ref_id::text)=lower('$SESSION_A'));
SQL
)"
[ "$LINEAGE" = "1:2:1:1" ] || fail "cross-provider-lineage: $LINEAGE"
pass "lineage, channel/root/observation carry-over and single settlement survived the substrate swap"

# The new session's substrate declares no pause. Policy must honour the
# declaration rather than fake one — a capability is a fact, not a preference.
[ "$(curl -fsS "http://127.0.0.1:$MOCK_B_PORT/requests" \
  | jq '[.requests[] | select(.path | endswith("/pause"))] | length')" = "0" ] \
  || fail "policy called pause on a substrate that declares it unsupported"
pass "capability declaration, not a provider constant, decided the pause path"

pass "cross-provider continuity is the ordinary resume path (ADR-0142 D3)"
