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

usage() {
  cat <<'EOF'
Usage: scripts/verify_ncp_centrifugo_boundary.sh \
  --env-file PATH --edge-url https://app.example.com \
  [--old-env-file PATH] [--evidence-dir DIR]

Options:
  --env-file PATH       Host env file used by docker-compose.rust.yml.
  --old-env-file PATH   Optional pre-rotation env backup. Its old secret must
                        get 401 on the compose-private API.
  --edge-url URL        Public Caddy origin. HTTPS is mandatory by default.
  --evidence-dir DIR    Redacted markdown/json output directory.
  --allow-http-local    Test-only: permit a loopback http:// edge URL.

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

case "$EDGE_URL" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*)
    [ "$ALLOW_HTTP_LOCAL" = "1" ] || fail "https_required (loopback http needs --allow-http-local)"
    ;;
  *) fail "https_required" ;;
esac

# Evidence must name only an origin. Reject userinfo, paths, queries, fragments,
# and whitespace so an accidental credential-bearing URL can never be recorded.
EDGE_URL="${EDGE_URL%/}"
edge_authority="${EDGE_URL#*://}"
case "$edge_authority" in
  ""|*/*|*@*|*\?*|*\#*|*[[:space:]]*) fail "edge_url_must_be_origin" ;;
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${MOMO_NCP_RUNTIME_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BASE_COMPOSE="$REPO_ROOT/infra/rust/docker-compose.rust.yml"
[ -f "$BASE_COMPOSE" ] || fail "base_compose_missing"

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
old_secret="oort-invalid-proxy-secret-1329"
old_secret_source="synthetic-invalid"
if [ -n "$OLD_ENV_FILE" ]; then
  old_secret="$(read_env_secret "$OLD_ENV_FILE" old)"
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
      curl -sS --connect-timeout 5 --max-time 20 -o /dev/null -w '%{http_code}' \
        -H 'Content-Type: application/json' -X POST --data-binary 'not-json' "$url"
      ;;
    wrong-secret)
      curl -sS --connect-timeout 5 --max-time 20 -o /dev/null -w '%{http_code}' \
        -H 'Content-Type: application/json' \
        -H "X-Centrifugo-Proxy-Secret: $wrong_secret" \
        -X POST --data-binary 'not-json' "$url"
      ;;
    current-secret)
      printf 'X-Centrifugo-Proxy-Secret: %s\n' "$host_secret" \
        | curl -sS --connect-timeout 5 --max-time 20 -o /dev/null -w '%{http_code}' \
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
        curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w "%{http_code}" \
          -H "Content-Type: application/json" -X POST --data-binary "not-json" "$url"
        ;;
      old-secret)
        IFS= read -r presented
        printf "X-Centrifugo-Proxy-Secret: %s\\n" "$presented" \
          | curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w "%{http_code}" \
            --header @- -H "Content-Type: application/json" \
            -X POST --data-binary "not-json" "$url"
        ;;
      wrong-secret)
        curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w "%{http_code}" \
          -H "Content-Type: application/json" \
          -H "X-Centrifugo-Proxy-Secret: oort-invalid-proxy-secret-1329" \
          -X POST --data-binary "not-json" "$url"
        ;;
      current-secret)
        printf "X-Centrifugo-Proxy-Secret: %s\\n" "$CENT_PROXY_SECRET" \
          | curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w "%{http_code}" \
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
  --arg secretSha256 "$host_hash" \
  --arg edgeNo "$edge_no" --arg edgeWrong "$edge_wrong" --arg edgeCurrent "$edge_current" \
  --arg directNo "$direct_no" --arg directWrong "$direct_wrong" --arg directCurrent "$direct_current" \
  --arg oldSecretSource "$old_secret_source" \
  '{
    schema: "oort.ncp.centrifugo-boundary.v1",
    result: "PASS",
    checkedAt: $checkedAt,
    edgeUrl: $edgeUrl,
    secretEquality: {algorithm: "SHA-256", host: $secretSha256, api: $secretSha256, centrifugo: $secretSha256},
    edge: {noHeader: ($edgeNo|tonumber), wrongSecret: ($edgeWrong|tonumber), currentSecret: ($edgeCurrent|tonumber)},
    composePrivateApi: {noHeader: ($directNo|tonumber), oldSecret: ($directWrong|tonumber), oldSecretSource: $oldSecretSource, currentSecretMalformedBody: ($directCurrent|tonumber)}
  }' > "$json_file"

cat > "$md_file" <<EOF
# NCP Centrifugo boundary evidence

- Result: **PASS**
- Checked at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Edge: $EDGE_URL
- Secret equality: host = api = Centrifugo static header (SHA-256 \`$host_hash\`; raw value not recorded)
- Public edge: no header \`$edge_no\`, wrong secret \`$edge_wrong\`, current secret \`$edge_current\`
- Compose-private API: no header \`$direct_no\`, old secret \`$direct_wrong\` ($old_secret_source), current secret + malformed body \`$direct_current\` (authentication passed; body validation rejected)
- Mutation scope: none. This verifier is read-only.
EOF

printf '[ncp-cent-boundary] PASS evidence_json=%s\n' "$json_file"
printf '[ncp-cent-boundary] PASS evidence_markdown=%s\n' "$md_file"
