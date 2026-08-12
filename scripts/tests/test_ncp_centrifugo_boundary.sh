#!/usr/bin/env bash
# Regression and red-proof fixtures for #1329.
set -euo pipefail

fail() {
  printf '[test-ncp-cent] FAIL %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[test-ncp-cent] PASS %s\n' "$*"
}

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "must run inside a git repository"
fi
cd "$REPO_ROOT"

CONTRACT="$REPO_ROOT/scripts/verify_ncp_centrifugo_contract.sh"
RUNTIME="$REPO_ROOT/scripts/verify_ncp_centrifugo_boundary.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-ncp-cent-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

BASE_TREE="$TMP_ROOT/base"
MUT_TREE="$TMP_ROOT/mutation"
mkdir -p "$BASE_TREE/infra/rust" "$BASE_TREE/docs/runbooks" "$BASE_TREE/scripts"
cp infra/rust/Caddyfile "$BASE_TREE/infra/rust/Caddyfile"
cp infra/rust/docker-compose.rust.yml "$BASE_TREE/infra/rust/docker-compose.rust.yml"
cp docs/runbooks/ncp-rust-deploy.md "$BASE_TREE/docs/runbooks/ncp-rust-deploy.md"
cp scripts/verify_ncp_centrifugo_boundary.sh "$BASE_TREE/scripts/verify_ncp_centrifugo_boundary.sh"

MOMO_NCP_CONTRACT_ROOT="$BASE_TREE" "$CONTRACT" >/dev/null
pass "canonical contract fixture is green"

reset_mutation() {
  rm -rf "$MUT_TREE"
  cp -R "$BASE_TREE" "$MUT_TREE"
}

expect_contract_red() {
  local marker="$1"
  local log="$TMP_ROOT/contract-${marker}.log"
  if MOMO_NCP_CONTRACT_ROOT="$MUT_TREE" "$CONTRACT" >"$log" 2>&1; then
    fail "mutation unexpectedly passed marker=$marker"
  fi
  grep -Fq "$marker" "$log" || {
    cat "$log" >&2
    fail "mutation did not name marker=$marker"
  }
}

reset_mutation
# shellcheck disable=SC2016 # Mutate the literal Compose interpolation.
sed 's/CENT_PROXY_SECRET: ${CENT_PROXY_SECRET:?set CENT_PROXY_SECRET}/CENT_PROXY_SECRET: ${CENT_PROXY_SECRET_DRIFT:?set CENT_PROXY_SECRET_DRIFT}/' \
  "$MUT_TREE/infra/rust/docker-compose.rust.yml" > "$MUT_TREE/infra/rust/docker-compose.rust.yml.next"
mv "$MUT_TREE/infra/rust/docker-compose.rust.yml.next" "$MUT_TREE/infra/rust/docker-compose.rust.yml"
expect_contract_red "api_secret_source"
pass "API secret source drift is red"

reset_mutation
awk '
  /^[[:space:]]*handle \/v1\/centrifugo\/\* \{/ { skip = 3 }
  skip > 0 { skip--; next }
  { print }
' "$MUT_TREE/infra/rust/Caddyfile" > "$MUT_TREE/infra/rust/Caddyfile.next"
mv "$MUT_TREE/infra/rust/Caddyfile.next" "$MUT_TREE/infra/rust/Caddyfile"
expect_contract_red "edge_deny_count"
pass "missing edge deny is red"

reset_mutation
awk '
  /^[[:space:]]*handle \/v1\/centrifugo\/\* \{/ { skip = 3 }
  skip > 0 { skip--; next }
  { print }
  END {
    print "\thandle /v1/centrifugo/* {"
    print "\t\trespond 403"
    print "\t}"
  }
' "$MUT_TREE/infra/rust/Caddyfile" > "$MUT_TREE/infra/rust/Caddyfile.next"
mv "$MUT_TREE/infra/rust/Caddyfile.next" "$MUT_TREE/infra/rust/Caddyfile"
expect_contract_red "edge_deny_order"
pass "deny after general /v1 proxy is red"

reset_mutation
awk '
  { gsub(/CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS/, "CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS_OLD"); print }
' "$MUT_TREE/infra/rust/docker-compose.rust.yml" > "$MUT_TREE/infra/rust/docker-compose.rust.yml.next"
mv "$MUT_TREE/infra/rust/docker-compose.rust.yml.next" "$MUT_TREE/infra/rust/docker-compose.rust.yml"
expect_contract_red "cent_header_secret_source"
pass "Centrifugo header source drift is red"

reset_mutation
grep -Fv '## CENT_PROXY_SECRET 회전' "$MUT_TREE/docs/runbooks/ncp-rust-deploy.md" \
  > "$MUT_TREE/docs/runbooks/ncp-rust-deploy.md.next"
mv "$MUT_TREE/docs/runbooks/ncp-rust-deploy.md.next" "$MUT_TREE/docs/runbooks/ncp-rust-deploy.md"
expect_contract_red "runbook_missing rotation heading"
pass "missing rotation procedure is red"

FAKE_BIN="$TMP_ROOT/fake-bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
all=" $* "
case "$all" in
  *" exec -T api printenv CENT_PROXY_SECRET "*)
    printf '%s\n' "${FAKE_API_SECRET:?}"
    ;;
  *" exec -T centrifugo printenv CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS "*)
    printf '{"X-Centrifugo-Proxy-Secret":"%s"}\n' "${FAKE_CENT_SECRET:?}"
    ;;
  *" exec -T api sh -c "*)
    eval "mode=\${$#}"
    case "$mode" in
      no-header) printf '%s' "${FAKE_DIRECT_NO:-401}" ;;
      old-secret) cat >/dev/null; printf '%s' "${FAKE_DIRECT_OLD:-401}" ;;
      wrong-secret) printf '%s' "${FAKE_DIRECT_WRONG:-401}" ;;
      current-secret) printf '%s' "${FAKE_DIRECT_CURRENT:-400}" ;;
      *) exit 2 ;;
    esac
    ;;
  *)
    printf 'unexpected fake docker call\n' >&2
    exit 90
    ;;
esac
EOF

cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [ "$arg" = "@-" ]; then
    cat >/dev/null
    break
  fi
done
count=0
if [ -f "${FAKE_CURL_COUNT_FILE:?}" ]; then
  count="$(cat "$FAKE_CURL_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_CURL_COUNT_FILE"
status="$(printf '%s' "${FAKE_EDGE_STATUSES:?}" | cut -d, -f"$count")"
[ -n "$status" ] || exit 91
printf '%s' "$status"
EOF
chmod +x "$FAKE_BIN/docker" "$FAKE_BIN/curl"

HOST_ENV="$TMP_ROOT/host.env"
OLD_ENV="$TMP_ROOT/host.old.env"
CURRENT_SECRET="fixture-current-cent-proxy-secret-1329"
OLD_SECRET="fixture-old-cent-proxy-secret-1329"
printf 'CENT_PROXY_SECRET=%s\n' "$CURRENT_SECRET" > "$HOST_ENV"
printf 'CENT_PROXY_SECRET=%s\n' "$OLD_SECRET" > "$OLD_ENV"
chmod 600 "$HOST_ENV" "$OLD_ENV"

URL_RED_LOG="$TMP_ROOT/runtime-url-red.log"
if PATH="$FAKE_BIN:$PATH" "$RUNTIME" --env-file "$HOST_ENV" \
  --edge-url 'https://operator:credential@app.example.invalid/path?token=redacted' \
  --evidence-dir "$TMP_ROOT/evidence-url-red" > "$URL_RED_LOG" 2>&1; then
  fail "runtime accepted a credential-bearing non-origin edge URL"
fi
grep -Fq 'edge_url_must_be_origin' "$URL_RED_LOG" \
  || fail "edge URL red proof did not fail by name"
pass "credential-bearing/path edge URL is red before evidence"

run_fake_runtime() {
  local statuses="$1"
  local api_secret="$2"
  local cent_secret="$3"
  local direct_current="$4"
  local out_dir="$5"
  rm -f "$TMP_ROOT/curl-count"
  PATH="$FAKE_BIN:$PATH" \
    FAKE_CURL_COUNT_FILE="$TMP_ROOT/curl-count" \
    FAKE_EDGE_STATUSES="$statuses" \
    FAKE_API_SECRET="$api_secret" \
    FAKE_CENT_SECRET="$cent_secret" \
    FAKE_DIRECT_CURRENT="$direct_current" \
    "$RUNTIME" --env-file "$HOST_ENV" --old-env-file "$OLD_ENV" \
      --edge-url http://127.0.0.1:28443 \
      --allow-http-local --evidence-dir "$out_dir"
}

GREEN_LOG="$TMP_ROOT/runtime-green.log"
run_fake_runtime "403,403,403" "$CURRENT_SECRET" "$CURRENT_SECRET" "400" "$TMP_ROOT/evidence-green" \
  > "$GREEN_LOG" 2>&1
if grep -Fq "$CURRENT_SECRET" "$GREEN_LOG"; then
  fail "runtime stdout leaked the shared secret"
fi
green_json="$(find "$TMP_ROOT/evidence-green" -name '*.json' -type f -print -quit)"
[ -n "$green_json" ] || fail "runtime did not write JSON evidence"
jq -e '
  .result == "PASS"
  and .edge == {noHeader:403, wrongSecret:403, currentSecret:403}
  and .composePrivateApi == {noHeader:401, oldSecret:401, oldSecretSource:"previous-env", currentSecretMalformedBody:400}
  and (.secretEquality.host == .secretEquality.api)
  and (.secretEquality.host == .secretEquality.centrifugo)
' "$green_json" >/dev/null || fail "runtime evidence contract drift"
if grep -RFq "$CURRENT_SECRET" "$TMP_ROOT/evidence-green"; then
  fail "runtime evidence leaked the shared secret"
fi
if grep -RFq "$OLD_SECRET" "$TMP_ROOT/evidence-green"; then
  fail "runtime evidence leaked the previous shared secret"
fi
pass "runtime green path is redacted and records 403/401/400 evidence"

HASH_RED_LOG="$TMP_ROOT/runtime-hash-red.log"
if run_fake_runtime "403,403,403" "$CURRENT_SECRET" "fixture-different-cent-secret-1329" "400" "$TMP_ROOT/evidence-hash-red" \
  > "$HASH_RED_LOG" 2>&1; then
  fail "runtime accepted mismatched API/Centrifugo secret hashes"
fi
grep -Fq 'secret_hash_mismatch' "$HASH_RED_LOG" || fail "hash mismatch did not fail by name"
if grep -Fq "$CURRENT_SECRET" "$HASH_RED_LOG"; then fail "hash mismatch log leaked the secret"; fi
pass "runtime secret hash mismatch is fail-closed and redacted"

EDGE_RED_LOG="$TMP_ROOT/runtime-edge-red.log"
if run_fake_runtime "401,401,400" "$CURRENT_SECRET" "$CURRENT_SECRET" "400" "$TMP_ROOT/evidence-edge-red" \
  > "$EDGE_RED_LOG" 2>&1; then
  fail "runtime accepted a public path reaching API authentication"
fi
grep -Fq 'edge_status mode=no-header expected=403 actual=401' "$EDGE_RED_LOG" \
  || fail "edge red proof did not name public 401"
if grep -Fq "$CURRENT_SECRET" "$EDGE_RED_LOG"; then fail "edge red log leaked the secret"; fi
pass "pre-fix public 401/401/400 shape is RED"

DIRECT_RED_LOG="$TMP_ROOT/runtime-direct-red.log"
if run_fake_runtime "403,403,403" "$CURRENT_SECRET" "$CURRENT_SECRET" "401" "$TMP_ROOT/evidence-direct-red" \
  > "$DIRECT_RED_LOG" 2>&1; then
  fail "runtime accepted current secret that did not pass authentication"
fi
grep -Fq 'direct_status mode=current-secret expected=400(auth-passed) actual=401' "$DIRECT_RED_LOG" \
  || fail "direct current-secret red proof did not fail by name"
pass "private current secret must reach body validation, not 401"

printf '[test-ncp-cent] PASS complete\n'
