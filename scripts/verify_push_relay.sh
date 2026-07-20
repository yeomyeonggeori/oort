#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PUSH_RELAY_VERIFY_PORT:-28195}"

# Resolve an OpenSSL that actually supports Ed25519. macOS ships LibreSSL at
# /usr/bin/openssl (no ED25519 genpkey), and a login shell (gate uses `bash -lc`)
# can resolve it ahead of Homebrew's OpenSSL 3.x — a bare `openssl` therefore
# fails silently under set -e. Pick the first candidate that can genpkey Ed25519.
find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-openssl-probe.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
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

KEY_DIR="$TMP_ROOT/keys"
"$REPO_ROOT/scripts/push_relay_keygen.sh" "$KEY_DIR" >"$TMP_ROOT/keygen.log"
PRIVATE_KEY="$KEY_DIR/server-ed25519-private.pem"
PUBLIC_B64="$(tail -n 1 "$TMP_ROOT/keygen.log")"
CAPTURE="$TMP_ROOT/apns-capture.jsonl"
BODY="$TMP_ROOT/dispatch.json"
TAMPERED="$TMP_ROOT/tampered.json"

printf '%s' '{"schema":"momo.push.dispatch.v1","server_id":"verify-server","workspace_id":"11111111-1111-1111-1111-111111111111","device_id":"22222222-2222-2222-2222-222222222222","device_platform":"ios","apns_token":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef","apns_env":"sandbox","apns_topic":"com.momo.app","collapse_id":"message-4444","badge":1,"reason":"mention","channel_id":"33333333-3333-3333-3333-333333333333","message_id":"44444444-4444-4444-4444-444444444444"}' >"$BODY"
sed 's/"badge":1/"badge":2/' "$BODY" >"$TAMPERED"

sign_body() {
  "$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$PRIVATE_KEY" -in "$1" | "$OPENSSL_BIN" base64 -A
}

MOMO_RELAY_SERVERS="{\"verify-server\":\"$PUBLIC_B64\"}" \
MOMO_APNS_SENDER=stub \
MOMO_APNS_STUB_STATUS=410 \
MOMO_APNS_STUB_REASON=Unregistered \
MOMO_APNS_STUB_CAPTURE_PATH="$CAPTURE" \
MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE=2 \
MOMO_PUSH_RELAY_HOST=127.0.0.1 \
MOMO_PUSH_RELAY_PORT="$PORT" \
swift run --disable-sandbox --package-path "$REPO_ROOT/relay/PushRelay" PushRelay \
  >"$TMP_ROOT/relay.log" 2>&1 &
RELAY_PID=$!

READY=0
for _ in $(seq 1 240); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >"$TMP_ROOT/health.json" 2>/dev/null; then
    READY=1
    break
  fi
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    echo "PushRelay exited before health check" >&2
    sed -n '1,240p' "$TMP_ROOT/relay.log" >&2
    exit 1
  fi
  sleep 0.5
done
if [ "$READY" -ne 1 ]; then
  echo "PushRelay health check timed out" >&2
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

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$TAMPERED" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 403

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: unregistered-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$BODY" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 403

# First valid dispatch consumed one slot. The second succeeds; the third is 429.
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$BODY" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 200
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'X-Momo-Server-Id: verify-server' \
  -H "X-Momo-Push-Signature: $SIGNATURE" \
  --data-binary "@$BODY" "http://127.0.0.1:$PORT/v1/push")"
test "$STATUS" = 429

test -s "$CAPTURE"
head -n 1 "$CAPTURE" >"$TMP_ROOT/captured.json"
test "$(jq -r 'keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "aps,momo"
test "$(jq -r '.aps | keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "alert,badge,content-available,mutable-content"
test "$(jq -r '.aps.alert | keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "body,title"
test "$(jq -r '.aps.alert.title' "$TMP_ROOT/captured.json")" = "momo"
test "$(jq -r '.aps.alert.body' "$TMP_ROOT/captured.json")" = "새 알림"
test "$(jq -r '.momo | keys | sort | join(",")' "$TMP_ROOT/captured.json")" = "channel_id,collapse_id,message_id,reason,schema,server_id,workspace_id"
if grep -Eiq 'message_body|display_name|handle|channel_name|apns_token' "$TMP_ROOT/captured.json"; then
  echo "id-only APNs payload widened with conversation/token content" >&2
  exit 1
fi

echo "PASS: signed dispatch HTTP 200 + APNs 410 passthrough + static placeholder alert, bad signature 403, unregistered 403, rate limit 429, id-only momo envelope"
