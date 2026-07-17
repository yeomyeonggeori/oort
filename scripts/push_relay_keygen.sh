#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${1:-push-relay-keys}"
PRIVATE_KEY="$OUTPUT_DIR/server-ed25519-private.pem"
PUBLIC_KEY="$OUTPUT_DIR/server-ed25519-public.pem"

if [ -e "$OUTPUT_DIR" ]; then
  echo "refusing to overwrite existing path: $OUTPUT_DIR" >&2
  exit 1
fi
umask 077
mkdir -p "$OUTPUT_DIR"
openssl genpkey -algorithm ED25519 -out "$PRIVATE_KEY"
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY"
PUBLIC_KEY_BASE64="$(openssl pkey -in "$PRIVATE_KEY" -pubout -outform DER | tail -c 32 | openssl base64 -A)"
chmod 600 "$PRIVATE_KEY" "$PUBLIC_KEY"

echo "private key: $PRIVATE_KEY"
echo "public key:  $PUBLIC_KEY"
echo "MOMO_RELAY_SERVERS public-key value (raw Ed25519, base64):"
echo "$PUBLIC_KEY_BASE64"
