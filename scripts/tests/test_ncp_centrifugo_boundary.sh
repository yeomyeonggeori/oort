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
# shellcheck disable=SC2016 # Remove the literal runtime derivation expression.
grep -Fv 'trusted_origin="$(derive_caddy_origin)"' \
  "$MUT_TREE/scripts/verify_ncp_centrifugo_boundary.sh" \
  > "$MUT_TREE/scripts/verify_ncp_centrifugo_boundary.sh.next"
mv "$MUT_TREE/scripts/verify_ncp_centrifugo_boundary.sh.next" \
  "$MUT_TREE/scripts/verify_ncp_centrifugo_boundary.sh"
expect_contract_red "runtime_origin_binding"
pass "missing canonical runtime origin binding is red"

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
printf 'docker\n' >> "${FAKE_TOOL_LOG:?}"
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
first="${1:-}"
[ "$first" = "--disable" ] || { printf 'fake curl: --disable must be first\n' >&2; exit 92; }
has_max_redirs=0
has_proto=0
has_proto_redir=0
request_url=""
all=" $* "
for arg in "$@"; do
  case "$arg" in
    -L|--location|--location-trusted)
      printf 'fake curl: redirect-follow option is forbidden\n' >&2
      exit 93
      ;;
    --max-redirs) has_max_redirs=1 ;;
    --proto) has_proto=1 ;;
    --proto-redir) has_proto_redir=1 ;;
    http://*|https://*) request_url="$arg" ;;
  esac
  if [ "$arg" = "@-" ]; then
    cat >/dev/null
  fi
done
[ "$has_max_redirs" = "1" ] || { printf 'fake curl: --max-redirs missing\n' >&2; exit 94; }
[ "$has_proto" = "1" ] || { printf 'fake curl: --proto missing\n' >&2; exit 95; }
[ "$has_proto_redir" = "1" ] || { printf 'fake curl: --proto-redir missing\n' >&2; exit 98; }
case "$all" in
  *" --max-redirs 0 "*) ;;
  *) printf 'fake curl: --max-redirs must be zero\n' >&2; exit 99 ;;
esac
case "$all" in
  *" --proto ${FAKE_EXPECTED_PROTO:?} "*) ;;
  *) printf 'fake curl: request protocol allowlist drifted\n' >&2; exit 100 ;;
esac
case "$all" in
  *" --proto-redir ${FAKE_EXPECTED_PROTO} "*) ;;
  *) printf 'fake curl: redirect protocol allowlist drifted\n' >&2; exit 101 ;;
esac
[ -n "$request_url" ] || { printf 'fake curl: request URL missing\n' >&2; exit 96; }
[ "$request_url" = "${FAKE_EXPECTED_URL:?}" ] \
  || { printf 'fake curl: request URL escaped trusted origin\n' >&2; exit 97; }
printf 'curl:%s\n' "$request_url" >> "${FAKE_TOOL_LOG:?}"
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

cat > "$FAKE_BIN/grep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    *CENT_PROXY_SECRET*) printf 'secret-read\n' >> "${FAKE_TOOL_LOG:?}" ;;
  esac
done
exec "${FAKE_REAL_GREP:?}" "$@"
EOF
chmod +x "$FAKE_BIN/docker" "$FAKE_BIN/curl" "$FAKE_BIN/grep"

HOST_ENV="$TMP_ROOT/host.env"
OLD_ENV="$TMP_ROOT/host.old.env"
PROD_ENV="$TMP_ROOT/host.prod.env"
SENTINEL_ENV="$TMP_ROOT/host.sentinel.env"
CURRENT_SECRET="fixture-current-cent-proxy-secret-1329"
OLD_SECRET="fixture-old-cent-proxy-secret-1329"
SENTINEL_SECRET="h1-review-secret-sentinel-must-never-be-read-or-printed"
printf 'MOMO_ENV=test\nCENT_PROXY_SECRET=%s\n' "$CURRENT_SECRET" > "$HOST_ENV"
printf 'CENT_PROXY_SECRET=%s\n' "$OLD_SECRET" > "$OLD_ENV"
printf 'MOMO_ENV=production\nCENT_PROXY_SECRET=%s\n' "$CURRENT_SECRET" > "$PROD_ENV"
printf 'MOMO_ENV=production\nCENT_PROXY_SECRET=%s\n' "$SENTINEL_SECRET" > "$SENTINEL_ENV"
chmod 600 "$HOST_ENV" "$OLD_ENV" "$PROD_ENV" "$SENTINEL_ENV"

REAL_GREP="$(command -v grep)"
TRUSTED_PROD_ORIGIN="https://app.oor7.com"
TRUSTED_TEST_ORIGIN="http://127.0.0.1:28443"
EXPECTED_SUBSCRIBE_URL="${TRUSTED_TEST_ORIGIN}/v1/centrifugo/subscribe"
TOOL_LOG="$TMP_ROOT/tool.log"

reject_untrusted_origin_without_io() {
  local label="$1"
  local candidate="$2"
  local log="$TMP_ROOT/runtime-origin-${label}.log"
  local evidence="$TMP_ROOT/evidence-origin-${label}"
  : > "$TOOL_LOG"
  if PATH="$FAKE_BIN:$PATH" FAKE_REAL_GREP="$REAL_GREP" FAKE_TOOL_LOG="$TOOL_LOG" \
    MOMO_NCP_TEST_TRUSTED_ORIGIN='' MOMO_ENV='' \
    "$RUNTIME" --env-file "$SENTINEL_ENV" --edge-url "$candidate" \
      --evidence-dir "$evidence" > "$log" 2>&1; then
    fail "untrusted origin unexpectedly passed label=$label"
  fi
  grep -Fq 'edge_origin_not_trusted' "$log" \
    || fail "untrusted origin did not fail by trust marker label=$label"
  [ ! -s "$TOOL_LOG" ] || fail "untrusted origin performed secret/docker/curl I/O label=$label"
  [ ! -e "$evidence" ] || fail "untrusted origin wrote evidence label=$label"
  if grep -Fq "$SENTINEL_SECRET" "$log"; then
    fail "untrusted origin log leaked sentinel label=$label"
  fi
}

reject_untrusted_origin_without_io attacker 'https://attacker.example'
reject_untrusted_origin_without_io typo 'https://app.oor7.co'
reject_untrusted_origin_without_io wrong-port 'https://app.oor7.com:443'
reject_untrusted_origin_without_io userinfo 'https://operator:credential@app.oor7.com'
reject_untrusted_origin_without_io path 'https://app.oor7.com/v1'
reject_untrusted_origin_without_io query 'https://app.oor7.com?next=attacker'
reject_untrusted_origin_without_io fragment 'https://app.oor7.com#attacker'
reject_untrusted_origin_without_io punycode 'https://xn--oor7-9za.example'
reject_untrusted_origin_without_io trailing-slash 'https://app.oor7.com/'
pass "attacker/typo/port/userinfo/path/query/fragment/punycode origins are network-zero before secret read"

BAD_ROOT="$TMP_ROOT/bad-runtime-root"
mkdir -p "$BAD_ROOT/scripts" "$BAD_ROOT/infra/rust"
cp "$RUNTIME" "$BAD_ROOT/scripts/verify_ncp_centrifugo_boundary.sh"
cp infra/rust/docker-compose.rust.yml "$BAD_ROOT/infra/rust/docker-compose.rust.yml"
printf 'app.oor7.com {\nsecond.example.com {\n' > "$BAD_ROOT/infra/rust/Caddyfile"
chmod +x "$BAD_ROOT/scripts/verify_ncp_centrifugo_boundary.sh"
: > "$TOOL_LOG"
BAD_CADDY_LOG="$TMP_ROOT/runtime-bad-caddy.log"
if PATH="$FAKE_BIN:$PATH" FAKE_REAL_GREP="$REAL_GREP" FAKE_TOOL_LOG="$TOOL_LOG" \
  "$BAD_ROOT/scripts/verify_ncp_centrifugo_boundary.sh" \
    --env-file "$SENTINEL_ENV" --edge-url "$TRUSTED_PROD_ORIGIN" \
    --evidence-dir "$TMP_ROOT/evidence-bad-caddy" > "$BAD_CADDY_LOG" 2>&1; then
  fail "runtime accepted ambiguous canonical Caddy sites"
fi
grep -Fq 'canonical_caddy_site_count' "$BAD_CADDY_LOG" \
  || fail "ambiguous canonical Caddy sites did not fail by name"
[ ! -s "$TOOL_LOG" ] || fail "canonical Caddy parse failure performed secret/docker/curl I/O"
pass "canonical Caddy ambiguity is network-zero before secret read"

reject_loopback_for_env() {
  local mode="$1"
  local mode_env="$TMP_ROOT/host-${mode}.env"
  local log="$TMP_ROOT/runtime-loopback-${mode}.log"
  printf 'MOMO_ENV=%s\nCENT_PROXY_SECRET=%s\n' "$mode" "$SENTINEL_SECRET" > "$mode_env"
  chmod 600 "$mode_env"
  : > "$TOOL_LOG"
  if PATH="$FAKE_BIN:$PATH" FAKE_REAL_GREP="$REAL_GREP" FAKE_TOOL_LOG="$TOOL_LOG" \
    MOMO_NCP_TEST_TRUSTED_ORIGIN="$TRUSTED_TEST_ORIGIN" MOMO_ENV='' \
    "$RUNTIME" --env-file "$mode_env" --edge-url "$TRUSTED_TEST_ORIGIN" \
      --allow-http-local --evidence-dir "$TMP_ROOT/evidence-loopback-${mode}" > "$log" 2>&1; then
    fail "loopback test escape passed for MOMO_ENV=$mode"
  fi
  grep -Fq 'test_override_requires_env_file_MOMO_ENV=test' "$log" \
    || fail "loopback production/staging rejection did not fail by name mode=$mode"
  if grep -Eq '^(secret-read|docker|curl:)' "$TOOL_LOG"; then
    fail "loopback env rejection touched secret/docker/network mode=$mode"
  fi
  if grep -Fq "$SENTINEL_SECRET" "$log"; then
    fail "loopback env rejection leaked sentinel mode=$mode"
  fi
}
reject_loopback_for_env production
reject_loopback_for_env staging
pass "production/staging env cannot enable loopback escape"

: > "$TOOL_LOG"
LOOPBACK_PORT_LOG="$TMP_ROOT/runtime-loopback-wrong-port.log"
if PATH="$FAKE_BIN:$PATH" FAKE_REAL_GREP="$REAL_GREP" FAKE_TOOL_LOG="$TOOL_LOG" \
  MOMO_NCP_TEST_TRUSTED_ORIGIN="$TRUSTED_TEST_ORIGIN" MOMO_ENV='' \
  "$RUNTIME" --env-file "$HOST_ENV" --edge-url 'http://127.0.0.1:28444' \
    --allow-http-local --evidence-dir "$TMP_ROOT/evidence-loopback-wrong-port" \
    > "$LOOPBACK_PORT_LOG" 2>&1; then
  fail "loopback wrong port escaped exact test allowlist"
fi
grep -Fq 'edge_origin_not_trusted' "$LOOPBACK_PORT_LOG" \
  || fail "loopback wrong port did not fail by trust marker"
if grep -Eq '^(secret-read|docker|curl:)' "$TOOL_LOG"; then
  fail "loopback wrong port touched secret/docker/network"
fi
pass "test loopback wrong port is network-zero before secret read"

NON_SYNTH_ENV="$TMP_ROOT/host.non-synthetic.env"
printf 'MOMO_ENV=test\nCENT_PROXY_SECRET=non-synthetic-but-long-enough-secret-1329\n' > "$NON_SYNTH_ENV"
chmod 600 "$NON_SYNTH_ENV"
: > "$TOOL_LOG"
NON_SYNTH_LOG="$TMP_ROOT/runtime-non-synthetic.log"
if PATH="$FAKE_BIN:$PATH" FAKE_REAL_GREP="$REAL_GREP" FAKE_TOOL_LOG="$TOOL_LOG" \
  MOMO_NCP_TEST_TRUSTED_ORIGIN="$TRUSTED_TEST_ORIGIN" MOMO_ENV='' \
  "$RUNTIME" --env-file "$NON_SYNTH_ENV" --edge-url "$TRUSTED_TEST_ORIGIN" \
    --allow-http-local --evidence-dir "$TMP_ROOT/evidence-non-synthetic" \
    > "$NON_SYNTH_LOG" 2>&1; then
  fail "loopback test escape accepted a non-synthetic secret"
fi
grep -Fq 'test_secret_must_be_synthetic' "$NON_SYNTH_LOG" \
  || fail "non-synthetic test secret did not fail by name"
if grep -Eq '^(docker|curl:)' "$TOOL_LOG"; then
  fail "non-synthetic test secret reached docker/network"
fi
pass "test loopback accepts synthetic fixture secrets only"

run_fake_runtime() {
  local statuses="$1"
  local api_secret="$2"
  local cent_secret="$3"
  local direct_current="$4"
  local out_dir="$5"
  rm -f "$TMP_ROOT/curl-count"
  : > "$TOOL_LOG"
  PATH="$FAKE_BIN:$PATH" \
    FAKE_REAL_GREP="$REAL_GREP" \
    FAKE_TOOL_LOG="$TOOL_LOG" \
    FAKE_CURL_COUNT_FILE="$TMP_ROOT/curl-count" \
    FAKE_EDGE_STATUSES="$statuses" \
    FAKE_EXPECTED_URL="$EXPECTED_SUBSCRIBE_URL" \
    FAKE_EXPECTED_PROTO="=http" \
    FAKE_API_SECRET="$api_secret" \
    FAKE_CENT_SECRET="$cent_secret" \
    FAKE_DIRECT_CURRENT="$direct_current" \
    MOMO_NCP_TEST_TRUSTED_ORIGIN="$TRUSTED_TEST_ORIGIN" MOMO_ENV='' \
    "$RUNTIME" --env-file "$HOST_ENV" --old-env-file "$OLD_ENV" \
      --edge-url "$TRUSTED_TEST_ORIGIN" \
      --allow-http-local --evidence-dir "$out_dir"
}

run_fake_production() {
  local out_dir="$1"
  rm -f "$TMP_ROOT/curl-count"
  : > "$TOOL_LOG"
  PATH="$FAKE_BIN:$PATH" \
    FAKE_REAL_GREP="$REAL_GREP" \
    FAKE_TOOL_LOG="$TOOL_LOG" \
    FAKE_CURL_COUNT_FILE="$TMP_ROOT/curl-count" \
    FAKE_EDGE_STATUSES="403,403,403" \
    FAKE_EXPECTED_URL="${TRUSTED_PROD_ORIGIN}/v1/centrifugo/subscribe" \
    FAKE_EXPECTED_PROTO="=https" \
    FAKE_API_SECRET="$CURRENT_SECRET" \
    FAKE_CENT_SECRET="$CURRENT_SECRET" \
    FAKE_DIRECT_CURRENT="400" \
    MOMO_NCP_TEST_TRUSTED_ORIGIN='' MOMO_ENV='' \
    "$RUNTIME" --env-file "$PROD_ENV" --old-env-file "$OLD_ENV" \
      --edge-url "$TRUSTED_PROD_ORIGIN" --evidence-dir "$out_dir"
}

GREEN_LOG="$TMP_ROOT/runtime-green.log"
if ! run_fake_runtime "403,403,403" "$CURRENT_SECRET" "$CURRENT_SECRET" "400" \
  "$TMP_ROOT/evidence-green" > "$GREEN_LOG" 2>&1; then
  cat "$GREEN_LOG" >&2
  fail "runtime green fixture failed"
fi
if grep -Fq "$CURRENT_SECRET" "$GREEN_LOG"; then
  fail "runtime stdout leaked the shared secret"
fi
green_json="$(find "$TMP_ROOT/evidence-green" -name '*.json' -type f -print -quit)"
[ -n "$green_json" ] || fail "runtime did not write JSON evidence"
jq -e '
  .result == "PASS"
  and .trustedOriginSource == "test-only-exact"
  and .redirectPolicy == "no-follow"
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

PROD_GREEN_LOG="$TMP_ROOT/runtime-production-green.log"
if ! run_fake_production "$TMP_ROOT/evidence-production-green" > "$PROD_GREEN_LOG" 2>&1; then
  cat "$PROD_GREEN_LOG" >&2
  fail "production canonical-origin green fixture failed"
fi
prod_green_json="$(find "$TMP_ROOT/evidence-production-green" -name '*.json' -type f -print -quit)"
[ -n "$prod_green_json" ] || fail "production runtime did not write JSON evidence"
jq -e '
  .result == "PASS"
  and .edgeUrl == "https://app.oor7.com"
  and .trustedOriginSource == "canonical-caddy"
  and .redirectPolicy == "no-follow"
  and .edge == {noHeader:403, wrongSecret:403, currentSecret:403}
' "$prod_green_json" >/dev/null || fail "production canonical-origin evidence contract drift"
if grep -Fq "$CURRENT_SECRET" "$PROD_GREEN_LOG"; then
  fail "production runtime stdout leaked the shared secret"
fi
pass "production accepts only the exact canonical Caddy HTTPS origin"

REDIRECT_LOG="$TMP_ROOT/runtime-redirect-red.log"
if run_fake_runtime "403,403,302" "$CURRENT_SECRET" "$CURRENT_SECRET" "400" \
  "$TMP_ROOT/evidence-redirect-red" > "$REDIRECT_LOG" 2>&1; then
  fail "runtime accepted a redirect response"
fi
grep -Fq 'edge_status mode=current-secret expected=403 actual=302' "$REDIRECT_LOG" \
  || fail "redirect red proof did not fail by status"
[ "$(grep -c '^curl:' "$TOOL_LOG")" = "3" ] \
  || fail "redirect fixture made an unexpected number of edge requests"
unexpected_redirect_url="$(grep '^curl:' "$TOOL_LOG" \
  | grep -Fvx "curl:$EXPECTED_SUBSCRIBE_URL" || true)"
[ -z "$unexpected_redirect_url" ] \
  || fail "redirect fixture escaped the exact trusted request URL"
pass "3xx is RED and curl never follows or crosses origin"

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
