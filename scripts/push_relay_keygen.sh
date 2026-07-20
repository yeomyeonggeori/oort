#!/usr/bin/env bash
set -euo pipefail

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
  echo "[push-relay-keygen] no OpenSSL with Ed25519 genpkey support found" >&2
  exit 1
}
OPENSSL_BIN="$(find_openssl)"

OUTPUT_DIR="${1:-push-relay-keys}"
PRIVATE_KEY="$OUTPUT_DIR/server-ed25519-private.pem"
PUBLIC_KEY="$OUTPUT_DIR/server-ed25519-public.pem"

if [ -e "$OUTPUT_DIR" ]; then
  echo "refusing to overwrite existing path: $OUTPUT_DIR" >&2
  exit 1
fi
umask 077
mkdir -p "$OUTPUT_DIR"
"$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$PRIVATE_KEY"
"$OPENSSL_BIN" pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY"
PUBLIC_KEY_BASE64="$("$OPENSSL_BIN" pkey -in "$PRIVATE_KEY" -pubout -outform DER | tail -c 32 | "$OPENSSL_BIN" base64 -A)"
chmod 600 "$PRIVATE_KEY" "$PUBLIC_KEY"

echo "private key: $PRIVATE_KEY"
echo "public key:  $PUBLIC_KEY"
echo "MOMO_RELAY_SERVERS public-key value (raw Ed25519, base64):"
echo "$PUBLIC_KEY_BASE64"
