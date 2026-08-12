#!/usr/bin/env bash
# Runtime proof for the Rust/NCP internal-only Centrifugo subscribe callback.
#
# Read-only: this script does not reload Caddy, recreate a service, rotate a
# secret, or write an env file.  Run it on the deploy host after the operator's
# attended reload/recreate.  Evidence contains only HTTP status codes and a
# SHA-256 fingerprint; the shared secret is never printed or written.
set -euo pipefail
set +x 2>/dev/null || true
umask 077

ENV_FILE=""
OLD_ENV_FILE=""
EDGE_URL=""
EVIDENCE_DIR="${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-ncp-cent-boundary}"
ALLOW_HTTP_LOCAL=0
TEST_MODE=0
TRUSTED_ORIGIN_SOURCE=""
EDGE_CURL_PROTO=""

usage() {
  cat <<'EOF'
Usage: scripts/verify_ncp_centrifugo_boundary.sh \
  --env-file PATH --edge-url https://app.example.com \
  [--old-env-file PATH] [--evidence-dir DIR]

Options:
  --env-file PATH       Host env file used by docker-compose.rust.yml.
  --old-env-file PATH   Optional pre-rotation env backup. Its old secret must
                        get 401 on the compose-private API.
  --edge-url URL        Must exactly equal the HTTPS origin derived from the
                        canonical infra/rust/Caddyfile site label.
  --evidence-dir DIR    Redacted markdown/json output directory.
  --allow-http-local    Test-only: permit the exact loopback origin in
                        MOMO_NCP_TEST_TRUSTED_ORIGIN, and only with MOMO_ENV=test
                        in the env file and synthetic fixture secrets.

The running Compose project must contain services `api` and `centrifugo`.
The verifier is read-only and never performs a reload, recreate, or rotation.
EOF
}

fail() {
  printf '[ncp-cent-boundary] FAIL %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_command name=$1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --old-env-file)
      OLD_ENV_FILE="${2:-}"
      shift 2
      ;;
    --edge-url)
      EDGE_URL="${2:-}"
      shift 2
      ;;
    --evidence-dir)
      EVIDENCE_DIR="${2:-}"
      shift 2
      ;;
    --allow-http-local)
      ALLOW_HTTP_LOCAL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown_argument"
      ;;
  esac
done

[ -n "$ENV_FILE" ] || fail "env_file_required"
[ -f "$ENV_FILE" ] || fail "env_file_missing"
[ -z "$OLD_ENV_FILE" ] || [ -f "$OLD_ENV_FILE" ] || fail "old_env_file_missing"
[ -n "$EDGE_URL" ] || fail "edge_url_required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_COMPOSE="$REPO_ROOT/infra/rust/docker-compose.rust.yml"
CADDYFILE="$REPO_ROOT/infra/rust/Caddyfile"
[ -f "$BASE_COMPOSE" ] || fail "base_compose_missing"
[ -f "$CADDYFILE" ] || fail "canonical_caddyfile_missing"
[ -z "${MOMO_NCP_RUNTIME_ROOT:-}" ] || fail "runtime_root_override_forbidden"

derive_caddy_origin() {
  local sites site_count site
  sites="$(awk '
    /^[[:alnum:]][[:alnum:].-]*[[:space:]]+\{[[:space:]]*$/ { print $1 }
  ' "$CADDYFILE")"
  site_count="$(printf '%s\n' "$sites" | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$site_count" = "1" ] || fail "canonical_caddy_site_count expected=1 actual=$site_count"
  site="$sites"
  if ! awk -v host="$site" 'BEGIN {
    if (host !~ /^[a-z0-9.-]+$/ || host ~ /^\./ || host ~ /\.$/ || host ~ /\.\./) exit 1
    count = split(host, labels, ".")
    if (count < 2 || length(host) > 253) exit 1
    for (i = 1; i <= count; i += 1) {
      if (length(labels[i]) > 63 || labels[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) exit 1
    }
  }'; then
    fail "canonical_caddy_site_invalid"
  fi
  printf 'https://%s' "$site"
}

read_env_mode() {
  local count line value
  count="$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?MOMO_ENV=' "$ENV_FILE" || true)"
  [ "$count" = "1" ] || fail "test_env_mode_line_count expected=1 actual=$count"
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?MOMO_ENV=' "$ENV_FILE")"
  value="${line#*=}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# Trust is resolved before CENT_PROXY_SECRET is read, before Docker is invoked,
# and before curl can touch the network.  In production there is no caller-
# supplied allowlist: the tracked/deployed Caddy site is the only authority.
case "$EDGE_URL" in
  https://*)
    [ "$ALLOW_HTTP_LOCAL" = "0" ] || fail "test_override_only_for_loopback"
    [ -z "${MOMO_NCP_TEST_TRUSTED_ORIGIN:-}" ] || fail "test_trusted_origin_forbidden_in_production_mode"
    trusted_origin="$(derive_caddy_origin)"
    [ "$EDGE_URL" = "$trusted_origin" ] || fail "edge_origin_not_trusted"
    TRUSTED_ORIGIN_SOURCE="canonical-caddy"
    EDGE_CURL_PROTO="=https"
    ;;
  http://127.0.0.1:*)
    [ "$ALLOW_HTTP_LOCAL" = "1" ] || fail "https_required (loopback http needs --allow-http-local)"
    case "${MOMO_ENV:-}" in
      production|prod|staging|live) fail "test_override_forbidden_for_process_env" ;;
    esac
    env_mode="$(read_env_mode)"
    [ "$env_mode" = "test" ] || fail "test_override_requires_env_file_MOMO_ENV=test"
    trusted_origin="${MOMO_NCP_TEST_TRUSTED_ORIGIN:-}"
    [ -n "$trusted_origin" ] || fail "test_trusted_origin_required"
    if [[ ! "$trusted_origin" =~ ^http://127\.0\.0\.1:([0-9]+)$ ]]; then
      fail "test_trusted_origin_invalid"
    fi
    trusted_port="${BASH_REMATCH[1]}"
    [ "$trusted_port" -ge 1024 ] && [ "$trusted_port" -le 65535 ] \
      || fail "test_trusted_origin_port_invalid"
    [ "$EDGE_URL" = "$trusted_origin" ] || fail "edge_origin_not_trusted"
    TEST_MODE=1
    TRUSTED_ORIGIN_SOURCE="test-only-exact"
    EDGE_CURL_PROTO="=http"
    ;;
  *) fail "https_required" ;;
esac

need curl
need docker
need jq
if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL="sha256sum"
else
  fail "missing_command name=shasum-or-sha256sum"
fi

read_env_secret() {
  local path="$1"
  local role="$2"
  local count line value
  count="$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?CENT_PROXY_SECRET=' "$path" || true)"
  [ "$count" = "1" ] || fail "${role}_secret_line_count expected=1 actual=$count"
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?CENT_PROXY_SECRET=' "$path")"
  value="${line#*=}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  [ -n "$value" ] || fail "${role}_secret_empty"
  [ "${#value}" -ge 32 ] || fail "${role}_secret_too_short minimum=32"
  case "$value" in
    change-me-*|dev-insecure-*|example-*|placeholder-*) fail "${role}_secret_placeholder_forbidden" ;;
  esac
  case "$value" in
    *[!A-Za-z0-9._~+/=-]*) fail "${role}_secret_shape must be a single URL-safe/base64 token" ;;
  esac
  printf '%s' "$value"
}

host_secret="$(read_env_secret "$ENV_FILE" host)"
if [ "$TEST_MODE" = "1" ]; then
  case "$host_secret" in
    fixture-*) ;;
    *) fail "test_secret_must_be_synthetic" ;;
  esac
fi
old_secret="oort-invalid-proxy-secret-1329"
old_secret_source="synthetic-invalid"
if [ -n "$OLD_ENV_FILE" ]; then
  old_secret="$(read_env_secret "$OLD_ENV_FILE" old)"
  if [ "$TEST_MODE" = "1" ]; then
    case "$old_secret" in
      fixture-*) ;;
      *) fail "test_old_secret_must_be_synthetic" ;;
    esac
  fi
  [ "$old_secret" != "$host_secret" ] || fail "old_secret_not_rotated"
  old_secret_source="previous-env"
fi
if [ "$old_secret" = "$host_secret" ]; then
  old_secret="${old_secret}-different"
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$BASE_COMPOSE" "$@"
}

hash_value() {
  if [ "$SHA_TOOL" = "shasum" ]; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  else
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  fi
}

if ! api_secret="$(compose exec -T api printenv CENT_PROXY_SECRET 2>/dev/null)"; then
  fail "api_secret_unreadable (is the api service running?)"
fi
if ! cent_headers="$(compose exec -T centrifugo printenv CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS 2>/dev/null)"; then
  fail "centrifugo_header_env_unreadable (is the centrifugo service running?)"
fi
if ! cent_secret="$(printf '%s' "$cent_headers" | jq -er '.["X-Centrifugo-Proxy-Secret"] | select(type == "string" and length > 0)' 2>/dev/null)"; then
  fail "centrifugo_header_env_invalid_json"
fi

host_hash="$(hash_value "$host_secret")"
api_hash="$(hash_value "$api_secret")"
cent_hash="$(hash_value "$cent_secret")"
if [ "$host_secret" != "$api_secret" ] || [ "$host_secret" != "$cent_secret" ]; then
  fail "secret_hash_mismatch host=$host_hash api=$api_hash centrifugo=$cent_hash"
fi
printf '[ncp-cent-boundary] PASS secret SHA-256 equality host=api=centrifugo %s\n' "$host_hash"

wrong_secret="oort-invalid-proxy-secret-1329"
if [ "$wrong_secret" = "$host_secret" ]; then
  wrong_secret="${wrong_secret}-different"
fi

edge_status() {
  local mode="$1"
  local url="${EDGE_URL%/}/v1/centrifugo/subscribe"
  case "$mode" in
    no-header)
      curl --disable --silent --show-error --connect-timeout 5 --max-time 20 \
        --max-redirs 0 --proto "$EDGE_CURL_PROTO" --proto-redir "$EDGE_CURL_PROTO" \
        -o /dev/null -w '%{http_code}' \
        -H 'Content-Type: application/json' -X POST --data-binary 'not-json' "$url"
      ;;
    wrong-secret)
      curl --disable --silent --show-error --connect-timeout 5 --max-time 20 \
        --max-redirs 0 --proto "$EDGE_CURL_PROTO" --proto-redir "$EDGE_CURL_PROTO" \
        -o /dev/null -w '%{http_code}' \
        -H 'Content-Type: application/json' \
        -H "X-Centrifugo-Proxy-Secret: $wrong_secret" \
        -X POST --data-binary 'not-json' "$url"
      ;;
    current-secret)
      printf 'X-Centrifugo-Proxy-Secret: %s\n' "$host_secret" \
        | curl --disable --silent --show-error --connect-timeout 5 --max-time 20 \
          --max-redirs 0 --proto "$EDGE_CURL_PROTO" --proto-redir "$EDGE_CURL_PROTO" \
          -o /dev/null -w '%{http_code}' \
          --header @- -H 'Content-Type: application/json' \
          -X POST --data-binary 'not-json' "$url"
      ;;
    *) return 2 ;;
  esac
}

direct_status() {
  local mode="$1"
  # shellcheck disable=SC2016 # This program runs inside the api container.
  compose exec -T api sh -c '
    mode="$1"
    url="http://127.0.0.1:8080/v1/centrifugo/subscribe"
    case "$mode" in
      no-header)
        curl --disable --silent --show-error --connect-timeout 3 --max-time 10 \
          --max-redirs 0 --proto "=http" --proto-redir "=http" -o /dev/null -w "%{http_code}" \
          -H "Content-Type: application/json" -X POST --data-binary "not-json" "$url"
        ;;
      old-secret)
        IFS= read -r presented
        printf "X-Centrifugo-Proxy-Secret: %s\\n" "$presented" \
          | curl --disable --silent --show-error --connect-timeout 3 --max-time 10 \
            --max-redirs 0 --proto "=http" --proto-redir "=http" -o /dev/null -w "%{http_code}" \
            --header @- -H "Content-Type: application/json" \
            -X POST --data-binary "not-json" "$url"
        ;;
      wrong-secret)
        curl --disable --silent --show-error --connect-timeout 3 --max-time 10 \
          --max-redirs 0 --proto "=http" --proto-redir "=http" -o /dev/null -w "%{http_code}" \
          -H "Content-Type: application/json" \
          -H "X-Centrifugo-Proxy-Secret: oort-invalid-proxy-secret-1329" \
          -X POST --data-binary "not-json" "$url"
        ;;
      current-secret)
        printf "X-Centrifugo-Proxy-Secret: %s\\n" "$CENT_PROXY_SECRET" \
          | curl --disable --silent --show-error --connect-timeout 3 --max-time 10 \
            --max-redirs 0 --proto "=http" --proto-redir "=http" -o /dev/null -w "%{http_code}" \
            --header @- -H "Content-Type: application/json" \
            -X POST --data-binary "not-json" "$url"
        ;;
      *) exit 2 ;;
    esac
  ' sh "$mode"
}

if ! edge_no="$(edge_status no-header)"; then fail "edge_request_failed mode=no-header"; fi
if ! edge_wrong="$(edge_status wrong-secret)"; then fail "edge_request_failed mode=wrong-secret"; fi
if ! edge_current="$(edge_status current-secret)"; then fail "edge_request_failed mode=current-secret"; fi

[ "$edge_no" = "403" ] || fail "edge_status mode=no-header expected=403 actual=${edge_no:-none}"
[ "$edge_wrong" = "403" ] || fail "edge_status mode=wrong-secret expected=403 actual=${edge_wrong:-none}"
[ "$edge_current" = "403" ] || fail "edge_status mode=current-secret expected=403 actual=${edge_current:-none}"
printf '[ncp-cent-boundary] PASS public edge no-header/wrong/current all 403\n'

if ! direct_no="$(direct_status no-header)"; then fail "direct_request_failed mode=no-header"; fi
if ! direct_wrong="$(printf '%s\n' "$old_secret" | direct_status old-secret)"; then fail "direct_request_failed mode=old-secret"; fi
if ! direct_current="$(direct_status current-secret)"; then fail "direct_request_failed mode=current-secret"; fi

[ "$direct_no" = "401" ] || fail "direct_status mode=no-header expected=401 actual=${direct_no:-none}"
[ "$direct_wrong" = "401" ] || fail "direct_status mode=old-secret expected=401 actual=${direct_wrong:-none}"
# Deliberately malformed JSON proves the exact current secret passed the first
# authentication gate: body parsing is later and returns 400.  A 200 would need
# live token/member fixtures and would test product authorization, not this rail.
[ "$direct_current" = "400" ] || fail "direct_status mode=current-secret expected=400(auth-passed) actual=${direct_current:-none}"
printf '[ncp-cent-boundary] PASS private api no-header/old=401 current=400(auth-passed)\n'

mkdir -p "$EVIDENCE_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
json_file="$EVIDENCE_DIR/ncp-centrifugo-boundary-${stamp}.json"
md_file="$EVIDENCE_DIR/ncp-centrifugo-boundary-${stamp}.md"

jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg edgeUrl "$EDGE_URL" \
  --arg trustedOriginSource "$TRUSTED_ORIGIN_SOURCE" \
  --arg secretSha256 "$host_hash" \
  --arg edgeNo "$edge_no" --arg edgeWrong "$edge_wrong" --arg edgeCurrent "$edge_current" \
  --arg directNo "$direct_no" --arg directWrong "$direct_wrong" --arg directCurrent "$direct_current" \
  --arg oldSecretSource "$old_secret_source" \
  '{
    schema: "oort.ncp.centrifugo-boundary.v1",
    result: "PASS",
    checkedAt: $checkedAt,
    edgeUrl: $edgeUrl,
    trustedOriginSource: $trustedOriginSource,
    redirectPolicy: "no-follow",
    secretEquality: {algorithm: "SHA-256", host: $secretSha256, api: $secretSha256, centrifugo: $secretSha256},
    edge: {noHeader: ($edgeNo|tonumber), wrongSecret: ($edgeWrong|tonumber), currentSecret: ($edgeCurrent|tonumber)},
    composePrivateApi: {noHeader: ($directNo|tonumber), oldSecret: ($directWrong|tonumber), oldSecretSource: $oldSecretSource, currentSecretMalformedBody: ($directCurrent|tonumber)}
  }' > "$json_file"

cat > "$md_file" <<EOF
# NCP Centrifugo boundary evidence

- Result: **PASS**
- Checked at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Edge: $EDGE_URL
- Trusted origin source: $TRUSTED_ORIGIN_SOURCE (exact match; redirects disabled)
- Secret equality: host = api = Centrifugo static header (SHA-256 \`$host_hash\`; raw value not recorded)
- Public edge: no header \`$edge_no\`, wrong secret \`$edge_wrong\`, current secret \`$edge_current\`
- Compose-private API: no header \`$direct_no\`, old secret \`$direct_wrong\` ($old_secret_source), current secret + malformed body \`$direct_current\` (authentication passed; body validation rejected)
- Mutation scope: none. This verifier is read-only.
EOF

printf '[ncp-cent-boundary] PASS evidence_json=%s\n' "$json_file"
printf '[ncp-cent-boundary] PASS evidence_markdown=%s\n' "$md_file"
