#!/usr/bin/env bash
# Signed v2 dispatch round-trip against momo-push-relay (stub). Never contacts Apple.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PUSH_RELAY_VERIFY_PORT:-28195}"
MANIFEST="$REPO_ROOT/server-rust/Cargo.toml"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/server-rust/target}"
BIN="$TARGET_DIR/debug/momo-push-relay"

find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-openssl-probe.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl /opt/homebrew/opt/openssl@3/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" genpkey -algorithm ED25519 -out "$probe" >/dev/null 2>&1; then
      rm -f "$probe"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  rm -f "$probe"
  echo "[push-relay] no OpenSSL with Ed25519 genpkey support found" >&2
  exit 1
}
OPENSSL_BIN="$(find_openssl)"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-push-relay.XXXXXX")"
RELAY_PID=""

cleanup() {
  if [ -n "$RELAY_PID" ]; then
    kill "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

echo "[push-relay] building momo-push-relay"
cargo build --manifest-path "$MANIFEST" -p momo-push-relay --quiet
test -x "$BIN"

KEY_DIR="$TMP_ROOT/keys"
"$REPO_ROOT/scripts/push_relay_keygen.sh" "$KEY_DIR" >"$TMP_ROOT/keygen.log"
PRIVATE_KEY="$KEY_DIR/server-ed25519-private.pem"
PUBLIC_B64="$(tail -n 1 "$TMP_ROOT/keygen.log")"
CAPTURE="$TMP_ROOT/apns-capture.jsonl"
BODY="$TMP_ROOT/dispatch.json"
TAMPERED="$TMP_ROOT/tampered.json"
WIDENED="$TMP_ROOT/widened.json"

printf '%s' '{"schema":"momo.push.dispatch.v2","server_id":"verify-server","workspace_id":"11111111-1111-1111-1111-111111111111","device_id":"22222222-2222-2222-2222-222222222222","device_platform":"ios","apns_token":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef","apns_env":"sandbox","apns_topic":"com.momo.app","collapse_id":"message-4444","badge":1,"reason":"mention","thread_id":"33333333-3333-3333-3333-333333333333","category":"momo.mention","channel_id":"33333333-3333-3333-3333-333333333333","message_id":"44444444-4444-4444-4444-444444444444"}' >"$BODY"
sed 's/"badge":1/"badge":2/' "$BODY" >"$TAMPERED"
sed 's/}$/,"body":"secret conversation"}/' "$BODY" >"$WIDENED"

sign_body() {
  "$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$PRIVATE_KEY" -in "$1" | "$OPENSSL_BIN" base64 -A
}

unique_body() {
  local suffix="$1"
  sed "s/44444444-4444-4444-4444-444444444444/44444444-4444-4444-4444-44444444444${suffix}/" "$BODY"
}

MOMO_RELAY_SERVERS="{\"verify-server\":\"$PUBLIC_B64\"}" \
MOMO_APNS_SENDER=stub \
MOMO_APNS_ALLOW_STUB=1 \
MOMO_APNS_STUB_STATUS=410 \
MOMO_APNS_STUB_REASON=Unregistered \
MOMO_APNS_STUB_CAPTURE_PATH="$CAPTURE" \
MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE=2 \
MOMO_PUSH_RELAY_HOST=127.0.0.1 \
MOMO_PUSH_RELAY_PORT="$PORT" \
"$BIN" >"$TMP_ROOT/relay.log" 2>&1 &
RELAY_PID=$!

READY=0
for _ in $(seq 1 240); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >"$TMP_ROOT/health.json" 2>/dev/null; then
    READY=1
    break
  fi
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    echo "momo-push-relay exited before health check" >&2
    sed -n '1,240p' "$TMP_ROOT/relay.log" >&2
    exit 1
  fi
  sleep 0.05
done
if [ "$READY" -ne 1 ]; then
  echo "momo-push-relay health check timed out" >&2
  sed -n '1,240p' "$TMP_ROOT/relay.log" >&2
  exit 1
fi

SIGNATURE="$(sign_body "$BODY")"
STATUS="$(curl -sS -o "$TMP_ROOT/ok.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$BODY" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 200
test "$(jq -r '.apns_status' "$TMP_ROOT/ok.json")" = 410
test "$(jq -r '.apns_reason' "$TMP_ROOT/ok.json")" = Unregistered
test "$(jq -r '.apns_id' "$TMP_ROOT/ok.json")" = stub-apns-id

# Replay of the same signed body is idempotent: 200, no second APNs payload.
STATUS="$(curl -sS -o "$TMP_ROOT/replay.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$BODY" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 200
test "$(jq -r '.apns_id' "$TMP_ROOT/replay.json")" = stub-apns-id
test "$(wc -l <"$CAPTURE" | tr -d ' ')" = 1

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$TAMPERED" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 401

FLIPPED="$TMP_ROOT/flipped.b64"
python3 - "$SIGNATURE" >"$FLIPPED" <<'PY'
import base64, sys
raw = bytearray(base64.b64decode(sys.argv[1]))
raw[0] ^= 1
sys.stdout.write(base64.b64encode(raw).decode("ascii"))
PY
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $(cat "$FLIPPED")" \
  --data-binary "@$BODY" "http://127.0.0.1:$PORT/v1/push")"
echo "[sabotage] flipped signature byte -> HTTP $STATUS (expect 401)"
test "$STATUS" = 401

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: unregistered-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$BODY" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 401

WIDE_SIG="$(sign_body "$WIDENED")"
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $WIDE_SIG" \
  --data-binary "@$WIDENED" "http://127.0.0.1:$PORT/v1/push")"
echo "[sabotage] extra envelope field body -> HTTP $STATUS (expect 400)"
test "$STATUS" = 400

# Rate limit counts distinct accepted dispatches. Replay of the first body
# did not consume a second slot, so the next unique body fills the window of 2
# and the one after that is 429.
unique_body 0 >"$TMP_ROOT/u0.json"
unique_body 1 >"$TMP_ROOT/u1.json"
SIG0="$(sign_body "$TMP_ROOT/u0.json")"
SIG1="$(sign_body "$TMP_ROOT/u1.json")"
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIG0" \
  --data-binary "@$TMP_ROOT/u0.json" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 200
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIG1" \
  --data-binary "@$TMP_ROOT/u1.json" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 429

test -s "$CAPTURE"
head -n 1 "$CAPTURE" >"$TMP_ROOT/captured.json"
test "$(jq -r 'keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "aps,momo"
test "$(jq -r '.aps | keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "alert,badge,category,content-available,mutable-content,thread-id"
test "$(jq -r '.aps.alert | keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "body,title"
test "$(jq -r '.aps.alert.title' "$TMP_ROOT/captured.json")" = "oort"
test "$(jq -r '.aps.alert.body' "$TMP_ROOT/captured.json")" = "새 알림"
test "$(jq -r '.aps.category' "$TMP_ROOT/captured.json")" = "momo.mention"
test "$(jq -r '.aps["thread-id"]' "$TMP_ROOT/captured.json")" = "33333333-3333-3333-3333-333333333333"
test "$(jq -r '.momo | keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "channel_id,collapse_id,message_id,reason,schema,server_id,workspace_id"
test "$(jq -r '.momo.schema' "$TMP_ROOT/captured.json")" = "momo.push.notification.v2"
if grep -Eiq 'message_body|display_name|handle|channel_name|apns_token' "$TMP_ROOT/captured.json"; then
  echo "id-only APNs payload widened with conversation/token content" >&2
  exit 1
fi

# Capture assertions finished — stop the listener so boot-refusal processes
# cannot collide on the same port if a config check ever reached bind.
kill "$RELAY_PID" 2>/dev/null || true
wait "$RELAY_PID" 2>/dev/null || true
RELAY_PID=""

assert_refuses_to_boot() {
  local description="$1" expected="$2" status
  shift 2
  local log="$TMP_ROOT/refusal.log"
  set +e
  env "$@" "$BIN" >"$log" 2>&1
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "momo-push-relay booted when it should have refused: $description" >&2
    sed -n '1,40p' "$log" >&2
    exit 1
  fi
  if [ "$status" != 78 ]; then
    echo "refusal for '$description' exited $status, expected 78 (EX_CONFIG)" >&2
    sed -n '1,40p' "$log" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$log"; then
    echo "refusal for '$description' did not name $expected" >&2
    sed -n '1,40p' "$log" >&2
    exit 1
  fi
}

assert_refuses_to_boot "stub sender without MOMO_APNS_ALLOW_STUB" MOMO_APNS_ALLOW_STUB \
  MOMO_RELAY_SERVERS="{\"verify-server\":\"$PUBLIC_B64\"}" \
  MOMO_APNS_SENDER=stub \
  MOMO_PUSH_RELAY_PORT="$PORT"

assert_refuses_to_boot "live sender with no APNs credential" MOMO_APNS_ENV \
  MOMO_RELAY_SERVERS="{\"verify-server\":\"$PUBLIC_B64\"}" \
  MOMO_PUSH_RELAY_PORT="$PORT"

assert_refuses_to_boot "live sender with an unreadable .p8" MOMO_APNS_KEY_PATH \
  MOMO_RELAY_SERVERS="{\"verify-server\":\"$PUBLIC_B64\"}" \
  MOMO_APNS_ENV=sandbox \
  MOMO_APNS_KEY_PATH="$TMP_ROOT/definitely-not-a-key.p8" \
  MOMO_APNS_KEY_ID=ABCD123456 \
  MOMO_APNS_TEAM_ID=TEAM123456 \
  MOMO_PUSH_RELAY_PORT="$PORT"

assert_refuses_to_boot "empty server registry" MOMO_RELAY_SERVERS \
  MOMO_APNS_SENDER=stub \
  MOMO_APNS_ALLOW_STUB=1 \
  MOMO_PUSH_RELAY_PORT="$PORT"

echo "PASS: signed v2 dispatch + APNs category/thread-id + 410 passthrough + static placeholder alert, bad signature 401, unregistered 401, replay idempotent, rate limit 429, id-only body field 400, fail-closed boot refusals (stub opt-in, missing credential, unreadable .p8, empty registry)"
