#!/usr/bin/env bash
# SH-10 / #1255 stub E2E: compose rust + push overlay, device register → mention
# → notifier → relay stub capture (id-only) → receipt → push_dispatch_log.
# Never contacts Apple. Isolated compose project; never touches oort-pgdata.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "push-relay stub e2e: SKIP (no docker binary)" >&2
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "push-relay stub e2e: SKIP (docker daemon unavailable)" >&2
  exit 0
fi
command -v jq >/dev/null 2>&1 || {
  echo "push-relay stub e2e: jq is required" >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "push-relay stub e2e: curl is required" >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "push-relay stub e2e: openssl is required" >&2
  exit 1
}

fail() {
  printf '[test-push-relay-stub-e2e] FAIL %s\n' "$*" >&2
  exit 1
}

PROTECTED_VOLUMES=' oort-pgdata momo-pgdata momo-rust-pgdata '
PROTECTED_PROJECTS=' oort momo-rust momo '
PREFIX="oortsh10t$$"
PROJ="${PREFIX}"
VOL="${PROJ}-pgdata"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}.XXXXXX")"
WORKDIR="$(CDPATH='' cd -P -- "$WORKDIR" && pwd)"
API_PORT="${PUSH_RELAY_E2E_API_PORT:-18080}"
CENT_PORT="${PUSH_RELAY_E2E_CENT_PORT:-18000}"
COMPOSE_UP=0
SECRET_DIR=""

assert_unprotected() {
  local kind="$1" name="$2"
  case " $PROTECTED_VOLUMES $PROTECTED_PROJECTS " in
    *" $name "*)
      echo "refusing to operate on protected $kind: $name" >&2
      exit 2
      ;;
  esac
  case "$name" in
    oortsh10t*) ;;
    *)
      echo "temp $kind must be oortsh10t* (got $name)" >&2
      exit 2
      ;;
  esac
}

compose() {
  docker compose \
    --project-directory "$ROOT" \
    -p "$PROJ" \
    --env-file "$WORKDIR/rust.env" \
    --env-file "$WORKDIR/push.env" \
    -f infra/rust/docker-compose.rust.yml \
    -f infra/rust/docker-compose.push.yml \
    "$@"
}

cleanup() {
  local status=$?
  if [ "$COMPOSE_UP" = 1 ]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  if [ -n "$SECRET_DIR" ]; then
    rm -rf "$SECRET_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

assert_unprotected project "$PROJ"
assert_unprotected volume "$VOL"

secret() {
  openssl rand -hex 24
}

echo "[test-push-relay-stub-e2e] generating isolated env + synthetic keys"
SECRET_DIR="$ROOT/.tmp-push-relay-e2e-$$"
mkdir -p "$SECRET_DIR"
chmod 755 "$SECRET_DIR"
KEY_DIR="$SECRET_DIR/keys"
"$ROOT/scripts/push_relay_keygen.sh" "$KEY_DIR" >"$SECRET_DIR/keygen.log"
PUBLIC_B64="$(tail -n 1 "$SECRET_DIR/keygen.log")"
PRIVATE_KEY="$KEY_DIR/server-ed25519-private.pem"
DUMMY_P8="$SECRET_DIR/dummy-apns.p8"
# Bind-mount source only. Stub mode never reads it; live would refuse this.
printf 'NOT-AN-APPLE-KEY\n' >"$DUMMY_P8"
chmod 755 "$KEY_DIR"
chmod 644 "$DUMMY_P8" "$PRIVATE_KEY"
test -f "$PRIVATE_KEY" || fail "keygen did not write $PRIVATE_KEY"
test -f "$DUMMY_P8" || fail "dummy .p8 missing"

IMAGE="${MOMO_RUST_IMAGE:-}"
if [ -z "$IMAGE" ]; then
  IMAGE="momo-rust:sh10-${PREFIX}"
  echo "[test-push-relay-stub-e2e] docker build -f server-rust/Dockerfile (image $IMAGE)"
  SHA="$(git -C "$ROOT" rev-parse HEAD)"
  docker build -f server-rust/Dockerfile --build-arg "MOMO_BUILD_SHA=$SHA" -t "$IMAGE" "$ROOT"
else
  echo "[test-push-relay-stub-e2e] using existing image $IMAGE"
  docker image inspect "$IMAGE" >/dev/null || fail "MOMO_RUST_IMAGE=$IMAGE is not a local image"
fi

OWNER_EMAIL="owner@example.test"
OWNER_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
PG_PASSWORD="$(secret)"
APP_PASSWORD="$(secret)"
RELAY_PASSWORD="$(secret)"
WORKER_PASSWORD="$(secret)"
NOTIFIER_PASSWORD="$(secret)"
JWT="$(secret)"
CENT_TOKEN="$(secret)"
CENT_API="$(secret)"
CENT_PROXY="$(secret)"
PROVIDER_KEY="$(secret)"

cat >"$WORKDIR/rust.env" <<EOF
MOMO_RUST_IMAGE=$IMAGE
COMPOSE_PROJECT_NAME=$PROJ
DB_VOLUME_NAME=$VOL
MOMO_ENV=staging
MOMO_MIGRATE_ENV=development
MOMO_PITR_EVIDENCE_REQUIRED=0
MOMO_PITR_BOOTSTRAP_EMPTY=0
LOG_LEVEL=info
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=$PG_PASSWORD
MIGRATE_DATABASE_URL=postgres://momo:${PG_PASSWORD}@postgres:5432/momo
MOMO_APP_POSTGRES_PASSWORD=$APP_PASSWORD
RELAY_POSTGRES_PASSWORD=$RELAY_PASSWORD
WORKER_POSTGRES_PASSWORD=$WORKER_PASSWORD
NOTIFIER_POSTGRES_PASSWORD=$NOTIFIER_PASSWORD
MOMO_APP_DATABASE_URL=postgres://momo_app:${APP_PASSWORD}@postgres:5432/momo
RELAY_DATABASE_URL=postgres://momo_relay:${RELAY_PASSWORD}@postgres:5432/momo
NOTIFIER_DATABASE_URL=postgres://momo_notifier:${NOTIFIER_PASSWORD}@postgres:5432/momo
JWT_HMAC=$JWT
CENT_TOKEN_HMAC=$CENT_TOKEN
CENT_API_KEY=$CENT_API
CENT_PROXY_SECRET=$CENT_PROXY
PROVIDER_LINK_MASTER_KEY=$PROVIDER_KEY
MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:${CENT_PORT}/connection/websocket
MOMO_LIVEKIT_API_KEY=
MOMO_LIVEKIT_API_SECRET=
MOMO_LIVEKIT_URL=
MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT
MOMO_AGENT_SEED_MODE=none
MIGRATE_IDEMPOTENCY_CHECK=1
MOMO_INITIAL_OWNER_EMAIL=$OWNER_EMAIL
MOMO_INITIAL_OWNER_PASSWORD=$OWNER_PASSWORD
MOMO_BOOTSTRAP_CLAIM=
PLATFORM_ADMIN_EMAILS=$OWNER_EMAIL
EOF

cat >"$WORKDIR/push.env" <<EOF
MOMO_RELAY_SERVERS={"momo-local":"$PUBLIC_B64"}
MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE=60
MOMO_APNS_SENDER=stub
MOMO_APNS_ALLOW_STUB=1
MOMO_APNS_ENV=sandbox
MOMO_APNS_KEY_HOST_PATH=$DUMMY_P8
MOMO_APNS_KEY_ID=TESTKEYID1
MOMO_APNS_TEAM_ID=TESTTEAMID
MOMO_APNS_STUB_STATUS=200
MOMO_APNS_STUB_REASON=
MOMO_APNS_STUB_CAPTURE_PATH=/tmp/apns-capture.jsonl
MOMO_PUSH_NOTIFIER_ENABLED=1
PUSH_RELAY_SERVER_ID=momo-local
PUSH_RELAY_URL=http://push-relay:28195/v1/push
MOMO_RELAY_SIGNING_KEY_HOST_PATH=$PRIVATE_KEY
EOF

grep -E '^NOTIFIER_DATABASE_URL=postgres://momo_notifier:' "$WORKDIR/rust.env" >/dev/null \
  || fail "NOTIFIER_DATABASE_URL is not the momo_notifier role"
if grep -E '^NOTIFIER_DATABASE_URL=postgres://momo:' "$WORKDIR"/*.env >/dev/null; then
  fail "NOTIFIER_DATABASE_URL still uses the owner URL"
fi

echo "[test-push-relay-stub-e2e] compose up (project $PROJ)"
compose up -d --wait
COMPOSE_UP=1

API="http://127.0.0.1:${API_PORT}"
WS="00000000-0000-7000-8000-000000000001"
CH="00000000-0000-7000-8000-000000000201"
SECRET_BODY="sh10-must-not-leak-into-apns-payload"

api() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local -a args=(-sS -o "$WORKDIR/http.body" -w '%{http_code}' -X "$method")
  args+=(-H 'Content-Type: application/json')
  if [ -n "$token" ]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [ -n "$body" ]; then
    args+=(--data "$body")
  fi
  HTTP_STATUS="$(curl "${args[@]}" "$API$path")"
  HTTP_BODY="$(cat "$WORKDIR/http.body")"
}

expect() {
  local want="$1" label="$2"
  if [ "$HTTP_STATUS" != "$want" ]; then
    printf '%s\n' "$HTTP_BODY" >&2
    fail "$label: expected HTTP $want, got $HTTP_STATUS"
  fi
}

echo "[test-push-relay-stub-e2e] owner login → invite → join → device register → mention"
api POST /v1/auth/login "" "$(jq -cn --arg email "$OWNER_EMAIL" --arg password "$OWNER_PASSWORD" --arg workspace "$WS" \
  '{email:$email,password:$password,workspace:$workspace}')"
expect 200 "owner login"
OWNER_TOKEN="$(printf '%s' "$HTTP_BODY" | jq -r '.accessToken')"
[ -n "$OWNER_TOKEN" ] && [ "$OWNER_TOKEN" != null ] || fail "owner accessToken missing"

api POST "/v1/workspaces/$WS/invites" "$OWNER_TOKEN" '{"role":"member","maxUses":1}'
expect 201 "create invite"
INVITE_CODE="$(printf '%s' "$HTTP_BODY" | jq -r '.code')"
[ -n "$INVITE_CODE" ] && [ "$INVITE_CODE" != null ] || fail "invite code missing"

JOIN_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
api POST /v1/join "" "$(jq -cn --arg code "$INVITE_CODE" --arg password "$JOIN_PASSWORD" \
  '{code:$code,email:"qa@example.test",displayName:"QA Push",handle:"qa-push",password:$password,timeZone:"Asia/Seoul"}')"
expect 201 "join qa-push"
QA_TOKEN="$(printf '%s' "$HTTP_BODY" | jq -r '.accessToken')"
[ -n "$QA_TOKEN" ] && [ "$QA_TOKEN" != null ] || fail "qa accessToken missing"

DEVICE_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
APNS_TOKEN="$(python3 -c 'print("ab"*32)')"
api POST "/v1/workspaces/$WS/devices" "$QA_TOKEN" "$(jq -cn \
  --arg deviceId "$DEVICE_ID" --arg apnsToken "$APNS_TOKEN" \
  '{deviceId:$deviceId,platform:"ios",apnsToken:$apnsToken,env:"sandbox",topic:"com.example.test.oort"}')"
expect 201 "register device"

CLIENT_MSG_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
api POST "/v1/workspaces/$WS/channels/$CH/messages" "$OWNER_TOKEN" "$(jq -cn \
  --arg clientMsgId "$CLIENT_MSG_ID" --arg body "@qa-push $SECRET_BODY" \
  '{clientMsgId:$clientMsgId,body:$body}')"
expect 201 "send mention"
MESSAGE_ID="$(printf '%s' "$HTTP_BODY" | jq -r '.id // .message.id // empty')"

echo "[test-push-relay-stub-e2e] waiting for stub capture + push_dispatch_log"
CAPTURE=""
LOG_ROW=""
for _ in $(seq 1 60); do
  CAPTURE="$(compose exec -T push-relay sh -c 'cat /tmp/apns-capture.jsonl 2>/dev/null || true')"
  LOG_ROW="$(compose exec -T postgres psql -U momo -d momo -At -c \
    "SELECT id::text || E'\t' || coalesce(apns_status::text,'') || E'\t' || coalesce(apns_reason,'') || E'\t' || coalesce(message_id::text,'') FROM push_dispatch_log LIMIT 1;" \
    2>/dev/null || true)"
  if [ -n "$CAPTURE" ] && [ -n "$LOG_ROW" ]; then
    break
  fi
  sleep 1
done
[ -n "$CAPTURE" ] || {
  compose logs push-relay notifier >&2 || true
  fail "stub capture file empty after 60s"
}
[ -n "$LOG_ROW" ] || {
  compose logs notifier >&2 || true
  fail "push_dispatch_log empty after 60s"
}

echo "----- stub capture (raw) -----"
printf '%s\n' "$CAPTURE"
echo "----- push_dispatch_log (raw) -----"
printf '%s\n' "$LOG_ROW"
echo "----- end raw -----"

LINE="$(printf '%s\n' "$CAPTURE" | head -n 1)"
test "$(jq -r 'keys | sort | join(",")' <<<"$LINE")" = "aps,momo"
test "$(jq -r '.aps.alert.title' <<<"$LINE")" = "oort"
test "$(jq -r '.aps.alert.body' <<<"$LINE")" = "새 알림"
test "$(jq -r '.momo.schema' <<<"$LINE")" = "momo.push.notification.v2"
test "$(jq -r '.momo.reason' <<<"$LINE")" = "mention"
if grep -Fqe "$SECRET_BODY" <<<"$CAPTURE"; then
  fail "conversation body bytes leaked into APNs capture"
fi
if grep -Eiq 'apns_token|display_name|channel_name|qa@example.test' <<<"$CAPTURE"; then
  fail "id-only APNs payload widened"
fi
BODY_BYTES="$(python3 -c 'import json,sys; o=json.loads(sys.argv[1]); print(0 if sys.argv[2] not in json.dumps(o) else 1)' "$LINE" "$SECRET_BODY")"
test "$BODY_BYTES" = 0

APNS_STATUS="$(printf '%s\n' "$LOG_ROW" | awk -F '\t' '{print $2}')"
test "$APNS_STATUS" = 200

echo "PASS: stub E2E device-register → mention → notifier → id-only capture → push_dispatch_log (Apple never contacted)"

echo "[test-push-relay-stub-e2e] sabotage: DROP ROLE momo_notifier → notifier must fail to start"
compose exec -T postgres psql -U momo -d momo -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'momo_notifier' AND pid <> pg_backend_pid();" \
  >/dev/null
compose exec -T postgres psql -U momo -d momo -v ON_ERROR_STOP=1 -c \
  "DROP OWNED BY momo_notifier; DROP ROLE momo_notifier;" >/dev/null
compose stop notifier >/dev/null
compose up -d --no-deps notifier >/dev/null
found=0
for _ in $(seq 1 30); do
  logs="$(compose logs --tail=80 notifier 2>/dev/null || true)"
  if printf '%s' "$logs" | grep -Eqi 'role .*momo_notifier.* does not exist|password authentication failed'; then
    found=1
    break
  fi
  sleep 1
done
[ "$found" = 1 ] || {
  compose logs --tail=80 notifier >&2 || true
  fail "notifier still started after DROP ROLE momo_notifier"
}
echo "PASS: sabotage DROP ROLE momo_notifier → notifier failed to start"
