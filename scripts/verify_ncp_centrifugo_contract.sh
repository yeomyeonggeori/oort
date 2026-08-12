#!/usr/bin/env bash
# Static fail-closed contract for the Rust/NCP Centrifugo subscribe boundary.
#
# This verifier never reads an operator env file and never contacts a host.  It
# proves that the tracked edge/compose/runbook bytes still describe one private
# callback rail.  Live status and secret-fingerprint equality are verified by
# scripts/verify_ncp_centrifugo_boundary.sh after an attended deployment.
set -euo pipefail

fail() {
  printf '[ncp-cent-contract] FAIL %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[ncp-cent-contract] PASS %s\n' "$*"
}

service_block() {
  local service="$1"
  local compose_path="$2"
  awk -v wanted="$service" '
    $0 == "  " wanted ":" { inside = 1 }
    inside && $0 ~ /^  [[:alnum:]_-]+:[[:space:]]*$/ && $0 != "  " wanted ":" { exit }
    inside { print }
  ' "$compose_path"
}

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  fail "must run inside a git repository"
fi

CONTRACT_ROOT="${MOMO_NCP_CONTRACT_ROOT:-$REPO_ROOT}"
CADDYFILE="$CONTRACT_ROOT/infra/rust/Caddyfile"
COMPOSE="$CONTRACT_ROOT/infra/rust/docker-compose.rust.yml"
RUNBOOK="$CONTRACT_ROOT/docs/runbooks/ncp-rust-deploy.md"
RUNTIME_VERIFIER="$CONTRACT_ROOT/scripts/verify_ncp_centrifugo_boundary.sh"

for path in "$CADDYFILE" "$COMPOSE" "$RUNBOOK" "$RUNTIME_VERIFIER"; do
  [ -f "$path" ] || fail "required_file_missing path=${path#"$CONTRACT_ROOT"/}"
done

deny_count="$(grep -Ec '^[[:space:]]*handle /v1/centrifugo/\* \{[[:space:]]*$' "$CADDYFILE" || true)"
[ "$deny_count" = "1" ] || fail "edge_deny_count expected=1 actual=$deny_count"

deny_line="$(grep -En '^[[:space:]]*handle /v1/centrifugo/\* \{[[:space:]]*$' "$CADDYFILE" | cut -d: -f1)"
api_line="$(grep -En '^[[:space:]]*handle /v1/\* \{[[:space:]]*$' "$CADDYFILE" | cut -d: -f1 | head -1)"
[ -n "$deny_line" ] && [ -n "$api_line" ] || fail "edge_route_missing"
[ "$deny_line" -lt "$api_line" ] || fail "edge_deny_order deny_line=$deny_line api_line=$api_line"

if ! awk '
  /^[[:space:]]*handle \/v1\/centrifugo\/\* \{[[:space:]]*$/ {
    if (seen) exit 2
    seen = 1
    state = 1
    next
  }
  state == 1 {
    if ($0 ~ /^[[:space:]]*(#.*)?$/) next
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/[[:space:]]*$/, "", line)
    if (line != "respond 403") exit 3
    state = 2
    next
  }
  state == 2 {
    if ($0 ~ /^[[:space:]]*(#.*)?$/) next
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/[[:space:]]*$/, "", line)
    if (line != "}") exit 4
    state = 0
    closed = 1
  }
  END {
    if (!seen || !closed || state != 0) exit 5
  }
' "$CADDYFILE"; then
  fail "edge_deny_shape must be an exclusive respond-403 handle"
fi
pass "public /v1/centrifugo/* is an exclusive 403 before /v1/*"

# shellcheck disable=SC2016 # Compose interpolation must remain literal here.
api_secret_count="$(service_block api "$COMPOSE" \
  | grep -Fxc '      CENT_PROXY_SECRET: ${CENT_PROXY_SECRET:?set CENT_PROXY_SECRET}' || true)"
[ "$api_secret_count" = "1" ] || fail "api_secret_source expected=1 actual=$api_secret_count"

# shellcheck disable=SC2016 # Compose interpolation must remain literal here.
expected_cent_header='      CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS: '\''{"X-Centrifugo-Proxy-Secret":"${CENT_PROXY_SECRET:?set CENT_PROXY_SECRET}"}'\'''
cent_header_count="$(service_block centrifugo "$COMPOSE" | grep -Fxc "$expected_cent_header" || true)"
[ "$cent_header_count" = "1" ] || fail "cent_header_secret_source expected=1 actual=$cent_header_count"

if grep -Eq 'CENT_PROXY_SECRET: \$\{CENT_PROXY_SECRET:-|X-Centrifugo-Proxy-Secret.*\$\{CENT_PROXY_SECRET:-' "$COMPOSE"; then
  fail "secret_default_forbidden CENT_PROXY_SECRET must use required interpolation"
fi
pass "api and Centrifugo header require the same no-default env source"

# shellcheck disable=SC2016 # Runtime shell expressions must remain literal.
grep -Fq 'trusted_origin="$(derive_caddy_origin)"' "$RUNTIME_VERIFIER" \
  || fail "runtime_origin_binding missing canonical Caddy derivation"
# shellcheck disable=SC2016 # Runtime shell expressions must remain literal.
grep -Fq '[ "$EDGE_URL" = "$trusted_origin" ] || fail "edge_origin_not_trusted"' "$RUNTIME_VERIFIER" \
  || fail "runtime_origin_binding missing exact origin comparison"
# shellcheck disable=SC2016 # Runtime shell expressions must remain literal.
grep -Fq -- '--max-redirs 0 --proto "$EDGE_CURL_PROTO" --proto-redir "$EDGE_CURL_PROTO"' "$RUNTIME_VERIFIER" \
  || fail "runtime_redirect_policy missing no-follow protocol pin"
grep -Fq 'test_secret_must_be_synthetic' "$RUNTIME_VERIFIER" \
  || fail "runtime_test_escape missing synthetic-secret guard"
pass "runtime binds canonical origin before secret use and disables redirects"

grep -Fq 'scripts/verify_ncp_centrifugo_boundary.sh' "$RUNBOOK" \
  || fail "runbook_missing runtime verifier command"
grep -Fq '## CENT_PROXY_SECRET 회전' "$RUNBOOK" \
  || fail "runbook_missing rotation heading"
grep -Fq 'SHA-256' "$RUNBOOK" \
  || fail "runbook_missing non-disclosing SHA-256 equality step"
grep -Fq '### 회전 롤백' "$RUNBOOK" \
  || fail "runbook_missing rotation rollback"
# shellcheck disable=SC2016 # Markdown backticks must remain literal.
grep -Fq '`--edge-url`은 목적지를 신뢰하게 만드는 입력이 아니라' "$RUNBOOK" \
  || fail "runbook_missing trusted-origin boundary"
pass "runbook pins attended verification, rotation, and rollback"

printf '[ncp-cent-contract] PASS complete\n'
