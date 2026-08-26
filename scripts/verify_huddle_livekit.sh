#!/usr/bin/env bash
# HD-1 / ADR-0122: prove a token issued by the Rust huddle join route is
# accepted by the pinned LiveKit service in infra/rust's opt-in profile.
# Intentionally excluded from local_gate/runtime-db: LiveKit is a heavy opt-in
# profile. Docker execution belongs to momo-main; workers run bash -n only.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[huddle-livekit] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need uuidgen

RUST_COMPOSE="$REPO_ROOT/infra/rust/docker-compose.rust.yml"
BUILD_OVERLAY="$REPO_ROOT/infra/rust/docker-compose.rust.build.yml"
PROJECT="${HUDDLE_LIVEKIT_PROJECT:-hd1-huddle-livekit}"
RUN_ID="$(date -u +%s)-$$"
API_PORT="${HUDDLE_LIVEKIT_API_PORT:-19870}"
CENT_PORT="${HUDDLE_LIVEKIT_CENT_PORT:-19872}"
LIVEKIT_PORT="${HUDDLE_LIVEKIT_PORT:-19874}"
LIVEKIT_TCP_PORT="${HUDDLE_LIVEKIT_TCP_PORT:-19875}"
LIVEKIT_UDP_START="${HUDDLE_LIVEKIT_UDP_START:-50100}"
LIVEKIT_UDP_END="${HUDDLE_LIVEKIT_UDP_END:-50200}"
BOOT_TIMEOUT="${HUDDLE_LIVEKIT_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oort-hd1-livekit.XXXXXX")"
ENV_FILE="$TMP_DIR/huddle.secrets.env"

LIVEKIT_API_KEY="huddle-livekit-key"
LIVEKIT_API_SECRET="huddle-livekit-secret-$RUN_ID"
POSTGRES_PASSWORD="huddle-postgres-$RUN_ID"

cat >"$ENV_FILE" <<ENV
MOMO_RUST_IMAGE=momo-rust-huddle:$RUN_ID
COMPOSE_PROJECT_NAME=$PROJECT
MOMO_ENV=development
MOMO_MIGRATE_ENV=development
MOMO_PITR_EVIDENCE_REQUIRED=0
MOMO_PITR_BOOTSTRAP_EMPTY=0
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
MIGRATE_DATABASE_URL=postgres://momo:$POSTGRES_PASSWORD@postgres:5432/momo
MOMO_APP_POSTGRES_PASSWORD=momo_app_dev_pw
RELAY_POSTGRES_PASSWORD=momo_relay_dev_pw
WORKER_POSTGRES_PASSWORD=momo_worker_dev_pw
MOMO_APP_DATABASE_URL=postgres://momo_app:momo_app_dev_pw@postgres:5432/momo
RELAY_DATABASE_URL=postgres://momo_relay:momo_relay_dev_pw@postgres:5432/momo
JWT_HMAC=huddle-jwt-secret-$RUN_ID
CENT_TOKEN_HMAC=huddle-cent-token-$RUN_ID
CENT_API_KEY=huddle-cent-api-$RUN_ID
CENT_PROXY_SECRET=huddle-cent-proxy-$RUN_ID
PROVIDER_LINK_MASTER_KEY=huddle-provider-link-$RUN_ID
MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:$CENT_PORT/connection/websocket
MOMO_AGENT_SEED_MODE=none
MIGRATE_IDEMPOTENCY_CHECK=1
MOMO_INITIAL_OWNER_EMAIL=
MOMO_INITIAL_OWNER_PASSWORD=
MOMO_BOOTSTRAP_CLAIM=
PLATFORM_ADMIN_EMAILS=
MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT
MOMO_LIVEKIT_API_KEY=$LIVEKIT_API_KEY
MOMO_LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
MOMO_LIVEKIT_URL=ws://127.0.0.1:$LIVEKIT_PORT
LIVEKIT_PORT=$LIVEKIT_PORT
LIVEKIT_RTC_TCP_PORT=$LIVEKIT_TCP_PORT
LIVEKIT_RTC_UDP_START=$LIVEKIT_UDP_START
LIVEKIT_RTC_UDP_END=$LIVEKIT_UDP_END
ENV

compose() {
  docker compose --env-file "$ENV_FILE" -p "$PROJECT" \
    -f "$RUST_COMPOSE" -f "$BUILD_OVERLAY" --profile huddle "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${HUDDLE_LIVEKIT_KEEP:-0}" = "1" ]; then
    echo "[huddle-livekit] leaving compose project '$PROJECT' up; env: $ENV_FILE"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf -- "$TMP_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[huddle-livekit] building Rust image and booting '$PROJECT' huddle profile"
compose up -d --build api livekit

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 \
   && curl -fsS "http://127.0.0.1:$LIVEKIT_PORT/" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api livekit migrate runtime-roles >&2 || true
    echo "[huddle-livekit] Rust API / LiveKit readiness timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api livekit 2>/dev/null)" ]; then
    compose logs --tail 160 api livekit migrate runtime-roles >&2 || true
    echo "[huddle-livekit] Rust API or LiveKit exited" >&2
    exit 1
  fi
  sleep 3
done

WS_ID="17570000-0000-7000-8000-000000000001"
CH_ID="17570000-0000-7000-8000-000000000201"
MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
EMAIL="huddle-livekit-$RUN_ID@momo.local"
PASSWORD="huddle-$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose exec -T postgres psql -U momo -d momo -v ON_ERROR_STOP=1 --no-psqlrc -q <<SQL
BEGIN;
INSERT INTO workspace (id, slug, name)
VALUES ('$WS_ID', 'hd1-livekit-$RUN_ID', 'HD-1 LiveKit');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$MEMBER_ID', '$WS_ID', 'human', 'active', 'LiveKit Verify', 'livekit-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$MEMBER_ID', '$WS_ID', '$EMAIL', true, momo_password_hash('$PASSWORD'), 'UTC');
INSERT INTO channel (id, workspace_id, kind, name, created_by)
VALUES ('$CH_ID', '$WS_ID', 'public', 'huddle-livekit', '$MEMBER_ID');
INSERT INTO channel_seq (workspace_id, channel_id, last_seq)
VALUES ('$WS_ID', '$CH_ID', 0);
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_ID', '$CH_ID', '$MEMBER_ID', 'owner');
COMMIT;
SQL

BASE_URL="http://127.0.0.1:$API_PORT"
ACCESS_TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e "$EMAIL" --arg p "$PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken')"
HUDDLE_ID="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/channels/$CH_ID/huddles" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -er '.huddle.id')"
LIVEKIT_TOKEN="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/$WS_ID/huddles/$HUDDLE_ID/join" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -er '.token')"

VALID_STATUS="$(curl -sS -o "$TMP_DIR/valid.out" -w '%{http_code}' --get \
  --data-urlencode "access_token=$LIVEKIT_TOKEN" \
  "http://127.0.0.1:$LIVEKIT_PORT/rtc/validate")"
[ "$VALID_STATUS" = "200" ] || {
  echo "[huddle-livekit] valid Rust grant: expected 200, got $VALID_STATUS" >&2
  exit 1
}

INVALID_STATUS="$(curl -sS -o "$TMP_DIR/invalid.out" -w '%{http_code}' --get \
  --data-urlencode 'access_token=invalid.jwt.token' \
  "http://127.0.0.1:$LIVEKIT_PORT/rtc/validate")"
case "$INVALID_STATUS" in
  401|403) ;;
  *)
    echo "[huddle-livekit] invalid JWT: expected 401/403, got $INVALID_STATUS" >&2
    exit 1
    ;;
esac

echo "HD-1 Rust join JWT accepted by pinned LiveKit (200); invalid JWT rejected ($INVALID_STATUS) PASS"
