#!/usr/bin/env bash
# MOMO-647/MOMO-651 — ADR-0136 ledger + ADR-0139 D4 idle pause gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-provisioner] $*"; }
fail() { echo "[t3-provisioner] FAIL $*" >&2; exit 1; }
pass() { echo "[t3-provisioner] PASS $*"; }

find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-t3-openssl.XXXXXX")"
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

now_ms() { python3 -c 'import time; print(time.time_ns() // 1_000_000)'; }

MIGRATION="server/Migrations/045_t3_provisioner_credit_ledger.sql"
SETTLEMENT_MIGRATION="server/Migrations/049_t3_lifecycle_settlement.sql"
LIFECYCLE_MIGRATION="server/Migrations/051_t3_unsettled_usage_constraint.sql"
test -f "$MIGRATION" || fail "missing $MIGRATION"
test -f "$SETTLEMENT_MIGRATION" || fail "missing $SETTLEMENT_MIGRATION"
test -f "$LIFECYCLE_MIGRATION" || fail "missing $LIFECYCLE_MIGRATION"
grep -q "CREATE TABLE work_host_usage_interval" "$MIGRATION" \
  || fail "active/pause interval ledger missing"
grep -q "WHEN state = 'active' AND ended_at IS NOT NULL" "$MIGRATION" \
  || fail "active seconds must be generated only for active intervals"
grep -q "ALTER TABLE %I FORCE ROW LEVEL SECURITY" "$MIGRATION" \
  || fail "new tenant tables must FORCE RLS"
grep -q "CREATE FUNCTION settle_t3_work_session" "$SETTLEMENT_MIGRATION" \
  || fail "named gate terminal-settlement-primitive"
grep -q "work_host_usage_one_unsettled_per_host_idx" "$LIFECYCLE_MIGRATION" \
  || fail "named gate one-unsettled-usage-per-host"
grep -q "state IN ('pausing', 'resuming', 'destroy_pending')" \
  workers/NotifierWorker/Sources/NotifierWorker/CloudLifecycleReconciler.swift \
  || fail "named gate provider-intent-reconciler"
grep -q "Idempotency-Key" server/Sources/MomoServer/Cloud/E2BProvisioner.swift \
  || fail "named gate crash-safe-provider-create"
grep -q "/v1/admin/workspaces/:ws/credits/topups" \
  server/Sources/MomoServer/Routes/CloudCreditRoutes.swift \
  || fail "named gate operator-topup-rest"
grep -q "human cloud resume intent must complete" \
  server/Sources/MomoServer/Routes/WorkSessionRoutes.swift \
  || fail "named gate host-report-is-confirmation"

if git diff --name-only HEAD -- schema_v0.sql | grep -q .; then
  fail "schema_v0.sql must not change"
fi
scripts/check_migration_numbers.sh server/Migrations >/dev/null
bash -n "$0"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-pycache" \
  python3 -m py_compile scripts/mock_e2b.py

if [ "${T3_GATE_RUN_DOCKER:-1}" != "1" ]; then
  pass "static migration and fixture checks"
  exit 0
fi

for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing $tool"
done
OPENSSL_BIN="$(find_openssl)"

# Deliberately never source .env/.env.worktree. MOMO-647 E2B credentials are
# orchestrator-owned; this gate uses a literal fake key against a local mock.
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
SAFE_ENV_FILE="$REPO_ROOT/infra/.env.example"
PROJECT="${T3_GATE_PROJECT:-momo855t3}"
API_PORT="${T3_GATE_API_PORT:-28050}"
PG_PORT="${T3_GATE_POSTGRES_PORT:-28051}"
CENT_PORT_HOST="${T3_GATE_CENTRIFUGO_PORT:-28052}"
HERMES_PORT_HOST="${T3_GATE_HERMES_PORT:-28053}"
PUSH_PORT_HOST="${T3_GATE_PUSH_RELAY_PORT:-28054}"
MOCK_E2B_PORT="${T3_GATE_MOCK_E2B_PORT:-28055}"
BOOT_TIMEOUT="${T3_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${T3_GATE_ASSERT_TIMEOUT:-120}"
RUN_TAG="$(date -u +%s)-$$"
OWNER_EMAIL="t3-owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="t3-$RUN_TAG"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-provisioner.XXXXXX")"
BASE_URL="http://127.0.0.1:$API_PORT"
GATE_E2B_KEY=""
GATE_T3_ENABLED=""

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" PUSH_RELAY_PORT="$PUSH_PORT_HOST" \
    E2B_API_BASE_URL="http://host.docker.internal:$MOCK_E2B_PORT" \
    E2B_API_KEY="$GATE_E2B_KEY" E2B_TEMPLATE_ID="momo-workd" \
    MOMO_T3_ENABLED="$GATE_T3_ENABLED" \
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
  if [ -n "${MOCK_E2B_PID:-}" ]; then
    kill "$MOCK_E2B_PID" >/dev/null 2>&1 || true
    wait "$MOCK_E2B_PID" >/dev/null 2>&1 || true
  fi
  if [ "${T3_GATE_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-t3-provisioner.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[t3-provisioner] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 scripts/mock_e2b.py --host 0.0.0.0 --port "$MOCK_E2B_PORT" \
  >"$TMP_DIR/mock-e2b.log" 2>&1 &
MOCK_E2B_PID=$!
deadline=$(( $(date -u +%s) + 30 ))
until curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/health" >/dev/null 2>&1; do
  [ "$(date -u +%s)" -lt "$deadline" ] || fail "mock E2B health timeout"
  sleep 1
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

GATE_E2B_KEY="local-mock-not-a-credential"
log "booting isolated PG18/API with T3 default-off despite configured E2B key"
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
NONOP_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
NONOP_EMAIL="t3-nonop-$RUN_TAG@momo.local"
NONOP_PASSWORD="t3-nonop-$RUN_TAG"
TOPUP_REF="$(python3 -c 'import uuid; print(uuid.uuid4())')"
CREATE_REF="$(python3 -c 'import uuid; print(uuid.uuid4())')"
DUMMY_PROVISION="$(python3 -c 'import uuid; print(uuid.uuid4())')"
PRIVATE_KEY="$TMP_DIR/work-host-private.pem"
PUBLIC_DER="$TMP_DIR/work-host-public.der"
"$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$PRIVATE_KEY" >/dev/null 2>&1
"$OPENSSL_BIN" pkey -in "$PRIVATE_KEY" -pubout -outform DER \
  -out "$PUBLIC_DER" >/dev/null 2>&1
PUBLIC_KEY="$(tail -c 32 "$PUBLIC_DER" | "$OPENSSL_BIN" base64 -A)"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$OWNER_ID', '$WS_ID', 'human', 'active', 'T3 Owner', 't3-owner-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true,
        momo_password_hash('$OWNER_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID', '$OWNER_ID', 'owner');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$NONOP_ID', '$WS_ID', 'human', 'active', 'T3 Non Operator', 't3-nonop-$RUN_TAG');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$NONOP_ID', '$WS_ID', '$NONOP_EMAIL', true,
        momo_password_hash('$NONOP_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID', '$NONOP_ID', 'admin');
COMMIT;
SQL

TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w,
      platformAdminSecret:"local-gate-admin-secret"}')" | jq -er '.accessToken')"
OWNER_TOKEN="$TOKEN"
NONOP_TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$NONOP_EMAIL" --arg p "$NONOP_PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken')"
# 읽기 스코프의 불충분함을 증명하려면 토큰 주인이 **인스턴스 운영자가 아니어야**
# 한다. OWNER_ID로 만들면 그 사람은 허용목록 운영자이기도 해서, 통과/거부가
# 스코프 때문인지 신원 때문인지 갈리지 않는다(실측: 운영자 경로 복원 후 이
# 단정이 200으로 뒤집혔다). 비운영자 멤버로 발급한다.
READ_ONLY_TOKEN="$(python3 - "$NONOP_ID" "$WS_ID" <<'PY'
import base64, hashlib, hmac, json, sys, time, uuid
def enc(value):
    raw = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
header = enc({"alg": "HS256", "kid": "app", "typ": "JWT"})
now = int(time.time())
payload = enc({
    "sub": sys.argv[1].lower(), "exp": now + 900, "iat": now,
    "jti": str(uuid.uuid4()), "ws": sys.argv[2].lower(),
    "scopes": ["platform:read"], "typ": "access",
})
body = f"{header}.{payload}"
signature = base64.urlsafe_b64encode(
    hmac.new(b"change-me-jwt-hmac", body.encode(), hashlib.sha256).digest()
).rstrip(b"=").decode()
print(f"{body}.{signature}")
PY
)"
if [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "topup-scope" ]; then
  # Behavioral red proof: present an actual credit-writer token to the
  # read-only denial assertion. The named REST assertion must turn red.
  READ_ONLY_TOKEN="$OWNER_TOKEN"
fi
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO token
  (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at)
VALUES
  ('$WS_ID', 'session', '$OWNER_ID', digest('$READ_ONLY_TOKEN', 'sha256'),
   ARRAY['platform:read'], 't3-read-only-proof',
   clock_timestamp() + interval '15 minutes')
ON CONFLICT (token_hash) DO NOTHING;
COMMIT;
SQL

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
host_api() {
  local method="$1" path="$2" host_id="$3" data="${4:-}"
  local sent_at request_id body_hash payload signature
  sent_at="$(now_ms)"
  request_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  body_hash="$(printf '%s' "$data" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $NF}')"
  payload="$TMP_DIR/work-host-request-$sent_at.txt"
  printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
    "$method" "$path" \
    "$(printf '%s' "$WS_ID" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" "$body_hash" "$request_id" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$PRIVATE_KEY" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  local -a args=(-sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json'
    -H "Authorization: MomoHost $host_id"
    -H "X-Momo-Work-Host-Sent-At: $sent_at"
    -H "X-Momo-Work-Host-Signature: $signature"
    -H "X-Momo-Work-Host-Request-ID: $request_id")
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

CLOUD_PATH="/v1/workspaces/$WS_ID/work-hosts/cloud"
CREATE_BODY="$(jq -cn --arg ref "$CREATE_REF" \
  '{displayName:"T3 gate",confirmPaidCloud:true,idempotencyRef:$ref}')"
api POST "$CLOUD_PATH" "$CREATE_BODY"
expect_status 503 "named default-off provisioning 503"
printf '%s' "$BODY" | jq -er '.error.message | contains("기본 비활성") and contains("#888")' >/dev/null

DUMMY_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
api GET "/v1/workspaces/$WS_ID/work-hosts/cloud/$DUMMY_ID"
expect_status 503 "named default-off cloud projection 503"
api POST "/v1/workspaces/$WS_ID/work-hosts/$DUMMY_ID/cloud/pause"
expect_status 503 "named default-off cloud pause 503"
api POST "/v1/workspaces/$WS_ID/work-hosts/$DUMMY_ID/cloud/resume"
expect_status 503 "named default-off cloud resume 503"
api DELETE "/v1/workspaces/$WS_ID/work-hosts/$DUMMY_ID/cloud"
expect_status 503 "named default-off cloud destroy 503"
api POST "/v1/admin/workspaces/$WS_ID/credits/topups" \
  "$(jq -cn --arg ref "$TOPUP_REF" \
    '{amountMicroUsd:1000000,idempotencyRef:$ref}')"
expect_status 503 "named default-off cloud topup 503"
api POST "/v1/workspaces/$WS_ID/work-hosts/cloud/register" '{}'
expect_status 503 "named default-off cloud register 503"
pass "default-off closes every T3 HTTP surface with readable 503"

if [ "${T3_GATE_PROVE_RED_DEFAULT_OFF:-0}" = "1" ]; then
  GATE_T3_ENABLED="1"
  compose up -d --force-recreate api
  wait_api
  api POST "$CLOUD_PATH" "$CREATE_BODY"
  expect_status 503 "red proof named default-off provisioning 503"
  printf '%s' "$BODY" | jq -er '.error.message | contains("기본 비활성")' >/dev/null \
    || fail "red proof named default-off provisioning 503"
fi

GATE_T3_ENABLED="1"
compose up -d --force-recreate api
wait_api

api POST "$CLOUD_PATH" "$CREATE_BODY"
expect_status 409 "missing credit ledger"
printf '%s' "$BODY" | jq -er '.error.message | contains("크레딧")' >/dev/null
pass "missing balance rejects before E2B create"

TOKEN="$READ_ONLY_TOKEN"
api POST "/v1/admin/workspaces/$WS_ID/credits/topups" \
  "$(jq -cn --arg ref "$TOPUP_REF" \
    '{amountMicroUsd:1000000,idempotencyRef:$ref}')"
expect_status 403 "read-scope-topup-denial"
TOKEN="$NONOP_TOKEN"
api POST "/v1/admin/workspaces/$WS_ID/credits/topups" \
  "$(jq -cn --arg ref "$TOPUP_REF" \
    '{amountMicroUsd:1000000,idempotencyRef:$ref}')"
expect_status 403 "ordinary workspace admin topup rejection"
TOKEN="$OWNER_TOKEN"
api POST "/v1/admin/workspaces/$WS_ID/credits/topups" \
  "$(jq -cn --arg ref "$TOPUP_REF" \
    '{amountMicroUsd:1000000,idempotencyRef:$ref}')"
expect_status 200 "instance-operator topup"
printf '%s' "$BODY" | jq -e '.balanceMicroUsd == 1000000' >/dev/null
api POST "/v1/admin/workspaces/$WS_ID/credits/topups" \
  "$(jq -cn --arg ref "$TOPUP_REF" \
    '{amountMicroUsd:1000000,idempotencyRef:$ref}')"
expect_status 200 "idempotent instance-operator topup replay"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE work_pool SET max_active=1, per_member_soft_limit=1 WHERE workspace_id='$WS_ID';
INSERT INTO work_cloud_host
  (id, workspace_id, requester_member_id, state, bootstrap_token_digest,
   bootstrap_expires_at, unit_rate_micro_usd_second)
VALUES
  ('$DUMMY_PROVISION', '$WS_ID', '$OWNER_ID', 'provisioning',
   repeat('0',64), clock_timestamp()+interval '10 minutes', 25);
COMMIT;
SQL
api POST "$CLOUD_PATH" "$CREATE_BODY"
expect_status 409 "slot exhaustion"
printf '%s' "$BODY" | jq -er '.error.message | contains("슬롯")' >/dev/null
pass "slot exhaustion returns readable reason"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
DELETE FROM work_cloud_host WHERE id='$DUMMY_PROVISION';
UPDATE work_pool SET max_active=2, per_member_soft_limit=2 WHERE workspace_id='$WS_ID';
COMMIT;
SQL

CREATE_PIDS=()
for attempt in 1 2; do
  attempt_body="$CREATE_BODY"
  if [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "concurrent-create" ] \
    && [ "$attempt" = "2" ]; then
    attempt_body="$(jq -cn --arg ref "$(python3 -c 'import uuid; print(uuid.uuid4())')" \
      '{displayName:"T3 gate",confirmPaidCloud:true,idempotencyRef:$ref}')"
  fi
  (
    curl -sS -o "$TMP_DIR/concurrent-$attempt.json" -w '%{http_code}' \
      -X POST "$BASE_URL$CLOUD_PATH" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $TOKEN" \
      --data "$attempt_body" >"$TMP_DIR/concurrent-$attempt.status"
  ) &
  CREATE_PIDS+=("$!")
done
for create_pid in "${CREATE_PIDS[@]}"; do
  wait "$create_pid"
done
[ "$(<"$TMP_DIR/concurrent-1.status")" = "202" ] \
  && [ "$(<"$TMP_DIR/concurrent-2.status")" = "202" ] || {
  cat "$TMP_DIR"/concurrent-*.json >&2
  fail "concurrent-create-idempotency"
}
PROVISION_ID="$(jq -er '.cloudHost.provisionId' "$TMP_DIR/concurrent-1.json")"
[ "$(jq -er '.cloudHost.provisionId' "$TMP_DIR/concurrent-2.json" \
  | tr '[:upper:]' '[:lower:]')" = \
  "$(printf '%s' "$PROVISION_ID" | tr '[:upper:]' '[:lower:]')" ] \
  || fail "concurrent-create-idempotency"
[ "$(sql_value <<SQL
SELECT count(*) FROM work_cloud_host
 WHERE workspace_id='$WS_ID' AND create_idempotency_key='$CREATE_REF';
SQL
)" = "1" ] || fail "concurrent-create-idempotency"
CREATE_CALLS="$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq '[.requests[] | select(.path == "/sandboxes")] | length')"
pass "concurrent retries converged on one provision row and sandbox identity"
api POST "$CLOUD_PATH" "$CREATE_BODY"
expect_status 202 "lost-create-response idempotent retry"
[ "$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq '[.requests[] | select(.path == "/sandboxes")] | length')" = "$CREATE_CALLS" ] \
  || fail "create response retry duplicated paid sandbox"
BOOTSTRAP_TOKEN="$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq -er '.requests[0].body.envVars.MOMO_WORKD_REGISTRATION_TOKEN')"
[ "$(sql_value <<SQL
SELECT count(*) FROM work_cloud_host
 WHERE id='$PROVISION_ID'
   AND bootstrap_token_digest <> '$BOOTSTRAP_TOKEN'
   AND length(bootstrap_token_digest)=64;
SQL
)" = "1" ] || fail "raw bootstrap token reached PostgreSQL"

REGISTER_BODY="$(jq -cn --arg key "$PUBLIC_KEY" \
  '{scope:"workspace",type:"cloud",displayName:"T3 gate",publicKey:$key,
    capabilities:{"tool.codex":true}}')"
STATUS="$(curl -sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X POST \
  "$BASE_URL/v1/workspaces/$WS_ID/work-hosts/cloud/register" \
  -H 'Content-Type: application/json' \
  -H "Authorization: MomoBootstrap $BOOTSTRAP_TOKEN" \
  --data "$REGISTER_BODY")"
BODY="$(<"$TMP_DIR/response.json")"
expect_status 201 "cloud workd self-registration"
HOST_ID="$(printf '%s' "$BODY" | jq -er '.workHost.id')"
pass "mock E2B create + one-shot Ed25519 cloud registration"

api POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg ch "$CHANNEL_ID" --arg host "$HOST_ID" \
    '{channelId:$ch,hostId:$host,tool:"codex",label:"T3 ledger gate"}')"
expect_status 201 "T3 work session create"
SESSION_ID="$(printf '%s' "$BODY" | jq -er '.workSession.id')"
api POST "/v1/workspaces/$WS_ID/work-sessions" \
  "$(jq -cn --arg ch "$CHANNEL_ID" --arg host "$HOST_ID" \
    '{channelId:$ch,hostId:$host,tool:"codex",label:"must reject duplicate host usage"}')"
expect_status 409 "second unsettled session on one paid host"
# 409만 보면 슬롯 한도·잔액 부족도 같은 코드를 낸다 — 이 단정이 주장하는 것은
# "같은 유료 sandbox에 두 번째 미정산 세션이 붙지 않는다"이므로 사유까지 본다.
# (실측: unique index를 지워도 이 단정이 통과했다. 사유 확인이 없으면 무엇이
#  막았는지 모른 채 초록이 된다.)
printf '%s' "$BODY" | grep -q "이미 정산 전 세션이 있습니다" || {
  echo "[t3-provisioner] FAIL second session rejected for the wrong reason: $BODY" >&2
  exit 1
}
pass "host-level unsettled usage uniqueness rejects double billing"
sleep 2

SESSION_PATH="/v1/workspaces/$WS_ID/work-sessions/$SESSION_ID"
host_api PATCH "$SESSION_PATH" "$HOST_ID" '{"status":"idle","exitCode":0}'
expect_status 200 "idle->pause REST transition"
[ "$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq '[.requests[] | select(.path == "/sandboxes/momo647sandbox/pause")] | length')" = "1" ] \
  || fail "idle->pause did not call E2B pause exactly once"
[ "$(sql_value <<SQL
SELECT count(*) FROM work_session ws
JOIN work_cloud_host ch ON ch.host_id=ws.host_id
JOIN work_host_usage u ON u.session_id=ws.id
JOIN work_host_usage_interval i ON i.usage_id=u.id
WHERE ws.id='$SESSION_ID' AND ws.status='idle' AND ch.state='paused'
  AND i.state='paused' AND i.ended_at IS NULL;
SQL
)" = "1" ] || fail "idle->pause did not open the paused interval boundary"
pass "idle->pause called E2B and opened paused usage"

sleep 2
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/cloud/resume"
expect_status 200 "human resume intent REST transition"
[ "$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq '[.requests[] | select(.path == "/sandboxes/momo647sandbox/connect")] | length')" = "1" ] \
  || fail "running->resume did not call E2B connect exactly once"
[ "$(sql_value <<SQL
SELECT count(*) FROM work_session ws
JOIN work_cloud_host ch ON ch.host_id=ws.host_id
JOIN work_host_usage u ON u.session_id=ws.id
JOIN work_host_usage_interval i ON i.usage_id=u.id
WHERE ws.id='$SESSION_ID' AND ws.status='running' AND ch.state='running'
  AND i.state='active' AND i.ended_at IS NULL;
SQL
)" = "1" ] || fail "running->resume did not reopen the active interval boundary"
pass "running->resume called E2B and reopened active usage"

sleep 2
host_api PATCH "$SESSION_PATH" "$HOST_ID" '{"status":"idle","exitCode":0}'
expect_status 200 "second idle->pause REST transition"
sleep 2
CONNECT_CALLS_BEFORE="$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
  | jq '[.requests[] | select(.path == "/sandboxes/momo647sandbox/connect")] | length')"
# reconciler-cas가 빠져 있어 이 블록 전체를 건너뛰었고, 안쪽 fail 단정에 닿지
# 못해 red proof가 초록이었다(실측 exit 0). 두 red 모드 모두 이 경로를 지나야
# 한다 — 레이스를 만드는 준비가 여기 있기 때문이다.
if [ "${T3_GATE_RECONCILER_RACE:-0}" = "1" ] \
  || [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "resume-terminal" ] \
  || [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "reconciler-cas" ]; then
  curl -fsS -X POST \
    "http://127.0.0.1:$MOCK_E2B_PORT/controls/resume-drop-then-block" >/dev/null
else
  curl -fsS -X POST \
    "http://127.0.0.1:$MOCK_E2B_PORT/controls/resume-drop-then-missing" >/dev/null
fi
api POST "/v1/workspaces/$WS_ID/work-hosts/$HOST_ID/cloud/resume"
expect_status 503 "ambiguous resume response loss"
compose up -d notifier

deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
if [ "${T3_GATE_RECONCILER_RACE:-0}" = "1" ] \
  || [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "resume-terminal" ]; then
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    CONNECT_CALLS="$(curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
      | jq '[.requests[] | select(.path == "/sandboxes/momo647sandbox/connect")] | length')"
    [ "$CONNECT_CALLS" -ge "$((CONNECT_CALLS_BEFORE + 2))" ] && break
    sleep 1
  done
  [ "${CONNECT_CALLS:-0}" -ge "$((CONNECT_CALLS_BEFORE + 2))" ] \
    || fail "reconciler-race-provider-call-not-observed"
  if [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "resume-terminal" ] \
    || [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "reconciler-cas" ]; then
    curl -fsS -X POST \
      "http://127.0.0.1:$MOCK_E2B_PORT/controls/release-resume" >/dev/null
    sleep 1
    RED_STATE="$(sql_value <<SQL
SELECT status || ':' || ch.state
  FROM work_session ws
  JOIN work_cloud_host ch ON ch.host_id=ws.host_id
 WHERE ws.id='$SESSION_ID';
SQL
)"
    if [ "${T3_GATE_PROVE_RED_REPAIR:-}" = "resume-terminal" ]; then
      fail "red proof resume-404-terminal-settlement observed $RED_STATE"
    fi
    fail "red proof reconciler-cas-dependent-state-rollback observed $RED_STATE"
  fi
  TOKEN="$OWNER_TOKEN"
  api PATCH "$SESSION_PATH" '{"status":"ended","exitCode":0}'
  expect_status 200 "actual REST terminal transition during reconcile"
  curl -fsS -X POST \
    "http://127.0.0.1:$MOCK_E2B_PORT/controls/release-resume" >/dev/null
  RACE_RESULT=""
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    RACE_RESULT="$(sql_value <<SQL
SELECT
  (SELECT status FROM work_session WHERE id='$SESSION_ID') || ':' ||
  (SELECT count(*) FROM work_host_usage
    WHERE session_id='$SESSION_ID' AND settled_at IS NOT NULL) || ':' ||
  (SELECT count(*) FROM work_cloud_host
    WHERE host_id='$HOST_ID' AND state <> 'running');
SQL
)"
    [ "$RACE_RESULT" = "ended:1:1" ] && break
    sleep 1
  done
  [ "$RACE_RESULT" = "ended:1:1" ] \
    || fail "reconciler-cas-dependent-state-rollback: $RACE_RESULT"
  pass "stale reconciler result cannot revive terminal dependent state"
else
  ORPHAN_RESULT=""
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    ORPHAN_RESULT="$(sql_value <<SQL
SELECT
  (SELECT count(*) FROM work_session
    WHERE id='$SESSION_ID' AND status='orphaned') || ':' ||
  (SELECT count(*) FROM work_cloud_host
    WHERE host_id='$HOST_ID' AND state='destroyed') || ':' ||
  (SELECT count(*) FROM work_host
    WHERE id='$HOST_ID' AND revoked_at IS NOT NULL) || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.cloud.resume_failed'
      AND lower(detail->>'session_id')=lower('$SESSION_ID')
      AND detail->>'reason'='sandbox_missing') || ':' ||
  (SELECT count(*) FROM audit_log
    WHERE action='work.session.orphaned' AND target_id='$SESSION_ID') || ':' ||
  (SELECT count(*) FROM outbox
    WHERE payload->'data'->>'type'='work.session.orphaned'
      AND lower(payload->'data'->'payload'->>'session_id')=lower('$SESSION_ID')) || ':' ||
  (SELECT count(*) FROM message
    WHERE props->>'kind'='resume_offer'
      AND lower(props->>'session_id')=lower('$SESSION_ID'));
SQL
)"
    [ "$ORPHAN_RESULT" = "1:1:1:1:1:1:1" ] && break
    sleep 1
  done
  [ "$ORPHAN_RESULT" = "1:1:1:1:1:1:1" ] || {
    compose logs --tail 160 api notifier >&2 || true
    fail "resume-404-terminal-settlement: $ORPHAN_RESULT"
  }
  pass "ambiguous REST loss -> reconciler 404 -> terminal settlement and orphan sweep"
fi

INTERVALS="$(sql_value <<SQL
SELECT count(*) || ':' ||
       count(*) FILTER (WHERE i.state='paused' AND i.active_seconds=0) || ':' ||
       COALESCE(sum(i.active_seconds),0)
  FROM work_host_usage_interval i
  JOIN work_host_usage u ON u.id=i.usage_id
 WHERE u.session_id='$SESSION_ID';
SQL
)"
IFS=: read -r INTERVAL_COUNT PAUSED_ZERO ACTIVE_SECONDS <<EOF
$INTERVALS
EOF
[ "$INTERVAL_COUNT" = "4" ] || fail "expected active/paused/active/paused intervals, got $INTERVALS"
[ "$PAUSED_ZERO" = "2" ] || fail "paused interval counted as active: $INTERVALS"
[ "$ACTIVE_SECONDS" -ge 2 ] && [ "$ACTIVE_SECONDS" -le 8 ] \
  || fail "unexpected active seconds $ACTIVE_SECONDS"

LEDGER_ACTIVE="$(sql_value <<SQL
SELECT active_seconds FROM work_host_usage WHERE session_id='$SESSION_ID';
SQL
)"
[ "$LEDGER_ACTIVE" = "$ACTIVE_SECONDS" ] || fail "usage aggregate mismatch"
DEBIT="$(sql_value <<SQL
SELECT -delta_micro_usd FROM credit_entry
 WHERE workspace_id='$WS_ID' AND reason='t3_usage' AND ref_id='$SESSION_ID';
SQL
)"
[ "$DEBIT" = "$((ACTIVE_SECONDS * 25))" ] || fail "credit debit mismatch"

LATENCY_AUDIT="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE target_id='$SESSION_ID'
   AND action IN ('work.session.idle','work.session.resumed-to-running')
   AND detail->>'cloud_provider'='e2b'
   AND jsonb_typeof(detail->'cloud_provisioner_latency_ms')='number'
   AND (detail->>'cloud_provisioner_latency_ms')::bigint >= 0;
SQL
)"
[ "$LATENCY_AUDIT" = "2" ] \
  || fail "pause/resume latency evidence missing from lifecycle audit: $LATENCY_AUDIT"
pass "pause/resume latency is queryable from audit; pause wall time bills zero"

# Tenant isolation under the real NOBYPASSRLS app role.
RLS_VISIBLE="$(run_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$WS_ID';
SELECT count(*) FROM work_host_usage WHERE session_id='$SESSION_ID';
ROLLBACK;
SQL
)"
[ "$RLS_VISIBLE" = "1" ] || fail "owner workspace cannot see its T3 usage"
CROSS_WS="00000000-0000-7000-8000-000000000099"
RLS_HIDDEN="$(run_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$CROSS_WS';
SELECT count(*) FROM work_host_usage WHERE session_id='$SESSION_ID';
ROLLBACK;
SQL
)"
[ "$RLS_HIDDEN" = "0" ] || fail "cross-workspace T3 usage leaked"

if [ "${T3_GATE_PROVE_RED_PAUSE:-0}" = "1" ]; then
  # Simulates the forbidden regression: every interval, including pause, bills
  # by wall time. The gate must become red because this exceeds the stored
  # active-only total after the deliberate two-second pause.
  REVERTED_TOTAL="$(sql_value <<SQL
SELECT COALESCE(sum(floor(extract(epoch FROM (i.ended_at-i.started_at)))::bigint),0)
  FROM work_host_usage_interval i
  JOIN work_host_usage u ON u.id=i.usage_id
 WHERE u.session_id='$SESSION_ID';
SQL
)"
  [ "$REVERTED_TOTAL" = "$LEDGER_ACTIVE" ] \
    || fail "red proof: reverted pause accounting bills $REVERTED_TOTAL vs active-only $LEDGER_ACTIVE"
fi

if [ "${T3_GATE_RECONCILER_RACE:-0}" != "1" ]; then
  curl -fsS "http://127.0.0.1:$MOCK_E2B_PORT/requests" \
    | jq -e '.states.momo647sandbox == "missing"' >/dev/null
fi

pass "idle pause/resume, orphan fallback, ledger consistency, credit debit, RLS isolation"
