#!/usr/bin/env bash
# SH-5a / #2205 — Railway template: service catalog, --railway key-set
# equality, Caddyfile.railway adapt + 403 order (RED when swapped), missing
# public domain fail-closed. Widens the public-edge contract onto
# Caddyfile.railway via MOMO_NCP_CONTRACT_ROOT fixture (gate body untouched).
#
# #2205 team instance (ship-lanes audit §A.2–A.6), each with a RED copy:
#   * catalog (scripts/tests/check_railway_catalog.py --prove-mutations): start
#     commands name momo-rust-entrypoint, pre-deploy is `/bin/sh -c`, Centrifugo
#     v6 names, api drive volume + RAILWAY_RUN_UID + privilege drop, PG18 +
#     pgvector image service with a volume, push services on tmpfs keys,
#     `${{shared.KEY}}` ⊆ generator keys, README hand-mapped table;
#   * X-Forwarded-Proto: adapt JSON (static) and a live echo upstream behind the
#     committed Caddyfile.railway (https) vs a copy without header_up (http);
#   * Centrifugo booted from the catalog's own variables: Origin upgrade 101 and
#     API-key publish 200; without the v6 names 403 / 401.
set -euo pipefail

fail() {
  printf '[test-railway-template] FAIL %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[test-railway-template] PASS %s\n' "$*"
}

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

RAILWAY_JSON="$ROOT/infra/railway/railway.json"
CADDYFILE_RAILWAY="$ROOT/infra/railway/Caddyfile.railway"
GENERATOR="$ROOT/scripts/self_host_env.sh"
CONTRACT="$ROOT/scripts/verify_public_edge_centrifugo_contract.sh"
LATEST="$ROOT/releases/latest.json"
CADDY_IMAGE="${MOMO_CADDY_IMAGE:-caddy:2-alpine}"
FIXTURE_HOST="app.example.test"
FIXTURE_CSP="'self' https://${FIXTURE_HOST} wss://${FIXTURE_HOST} https://www.googleapis.com"
FIXTURE_DB_URL="postgres://momo:fixturepass@pg.example.test:5432/momo?sslmode=require"
FIXTURE_IMAGE="ghcr.io/yeomyeonggeori/oort@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
MISSING_DOMAIN_SENTENCE='RAILWAY_PUBLIC_DOMAIN 이 없다. Railway 공개 도메인 없이 env를 만들 수 없다.'
MISSING_DB_SENTENCE='DATABASE_URL 이 없다. Postgres 플러그인 변수 없이 env를 만들 수 없다.'

command -v python3 >/dev/null 2>&1 || fail "python3 없음"
command -v jq >/dev/null 2>&1 || fail "jq 없음"
command -v docker >/dev/null 2>&1 || fail "docker 없음"
command -v openssl >/dev/null 2>&1 || fail "openssl 없음"
[ -f "$RAILWAY_JSON" ] || fail "infra/railway/railway.json missing"
[ -f "$CADDYFILE_RAILWAY" ] || fail "infra/railway/Caddyfile.railway missing"
CADDY_DOCKERFILE="$ROOT/infra/railway/Dockerfile.caddy"
PIN_CHECKER="$ROOT/scripts/tests/check_railway_release_pins.py"
CATALOG_CHECKER="$ROOT/scripts/tests/check_railway_catalog.py"
COMPOSE_RUST="$ROOT/infra/rust/docker-compose.rust.yml"
README_RAILWAY="$ROOT/infra/railway/README.md"
[ -f "$CADDY_DOCKERFILE" ] || fail "infra/railway/Dockerfile.caddy missing"
[ -f "$PIN_CHECKER" ] || fail "scripts/tests/check_railway_release_pins.py missing"
[ -f "$CATALOG_CHECKER" ] || fail "scripts/tests/check_railway_catalog.py missing"
[ -f "$COMPOSE_RUST" ] || fail "infra/rust/docker-compose.rust.yml missing"
[ -f "$README_RAILWAY" ] || fail "infra/railway/README.md missing"
[ -f "$GENERATOR" ] || fail "scripts/self_host_env.sh missing"
[ -f "$CONTRACT" ] || fail "scripts/verify_public_edge_centrifugo_contract.sh missing"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-railway-template.XXXXXX")"
# Live probes (XFP echo, Centrifugo) use these names; files reach containers by
# `docker cp` / stdin / --env-file, never a bind mount from TMP_ROOT (Colima does
# not share $TMPDIR with the VM).
PROBE_PREFIX="oort-railway-t$$"
PROBE_NET="${PROBE_PREFIX}-net"
probe_cleanup() {
  local ids
  ids="$(docker ps -aq --filter "name=^${PROBE_PREFIX}-" 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker rm -f -v $ids >/dev/null 2>&1 || true
  fi
  docker network rm "$PROBE_NET" >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap probe_cleanup EXIT INT TERM

canonical_keys() {
  {
    awk '
      /^cat >"\$ENV_FILE" <<EOF$/ { grab = 1; next }
      grab && /^EOF$/ { exit }
      grab && /^[A-Za-z_][A-Za-z0-9_]*=/ {
        key = $0
        sub(/=.*/, "", key)
        print key
      }
    ' "$GENERATOR"
    awk '
      /^oort_public_edge_env_keys\(\) \{/,/^}/ {
        while (match($0, /'\''OORT_[A-Z0-9_]+'\''/)) {
          token = substr($0, RSTART + 1, RLENGTH - 2)
          print token
          $0 = substr($0, RSTART + RLENGTH)
        }
      }
    ' "$GENERATOR"
  } | LC_ALL=C sort -u
}

output_keys() {
  awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 }' "$1" | LC_ALL=C sort -u
}

# T2 stdout = canonical 45 + stamp outside the heredoc (#2193, #2066).
expected_keys() {
  {
    canonical_keys
    printf 'MOMO_SELF_HOST_PLATFORM\n'
  } | LC_ALL=C sort -u
}

assert_stamp_in_table() {
  local json="$1" readme="$2"
  grep -Fq 'MOMO_SELF_HOST_PLATFORM=railway' "$json" || return 1
  grep -Fq 'MOMO_SELF_HOST_PLATFORM=railway' "$readme" || return 1
  return 0
}

run_railway() {
  local out="$1"
  shift
  set +e
  "$@" >"$out" 2>"${out}.err"
  local ec=$?
  set -e
  printf '%s' "$ec"
}

# ---------------------------------------------------------------------------
# ① railway.json catalog — runs after ② below, because its `${{shared.KEY}}`
# rule needs the generator's own key set. The old `startCommand == role`
# assertion encoded the exit-127 defect (#2205 §A.4-1) and is gone; the
# #2066 webhook-sender key rule moved into the checker (sender-key-dropped).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# ①b release pins: appImage, each app service image, Caddy ARG, web stage,
# and the COPY that ships /srv/web. Compares those sources — not a file-wide
# digest grep, and not an unused FROM ${OORT_IMAGE}. Scratch copies mutate one
# source at a time; committed files stay clean.
# ---------------------------------------------------------------------------
python3 "$PIN_CHECKER" "$RAILWAY_JSON" "$CADDY_DOCKERFILE" "$LATEST" \
  --prove-mutations \
  >"$TMP_ROOT/pins.out" 2>"$TMP_ROOT/pins.err" || {
  cat "$TMP_ROOT/pins.out" >&2
  cat "$TMP_ROOT/pins.err" >&2
  fail "Railway app/Caddy pins drifted from latest.json or mutation proof failed"
}
grep -Fq 'want_image' "$TMP_ROOT/pins.out" || fail "pin checker missing want_image"
grep -Fq 'mutation appImage RED' "$TMP_ROOT/pins.out" || fail "pin checker missing appImage mutation proof"
grep -Fq 'mutation api RED' "$TMP_ROOT/pins.out" || fail "pin checker missing api mutation proof"
grep -Fq 'mutation relay RED' "$TMP_ROOT/pins.out" || fail "pin checker missing relay mutation proof"
grep -Fq 'mutation webhook-sender RED' "$TMP_ROOT/pins.out" || fail "pin checker missing webhook-sender mutation proof"
grep -Fq 'mutation agent-worker RED' "$TMP_ROOT/pins.out" || fail "pin checker missing agent-worker mutation proof"
grep -Fq 'mutation notifier RED' "$TMP_ROOT/pins.out" || fail "pin checker missing notifier mutation proof"
grep -Fq 'mutation push-relay RED' "$TMP_ROOT/pins.out" || fail "pin checker missing push-relay mutation proof"
grep -Fq 'mutation caddy RED' "$TMP_ROOT/pins.out" || fail "pin checker missing Caddy ARG mutation proof"
grep -Fq 'mutation missing-api RED' "$TMP_ROOT/pins.out" || fail "pin checker missing missing-api proof"
grep -Fq 'mutation missing-caddy-arg RED' "$TMP_ROOT/pins.out" || fail "pin checker missing missing-caddy-arg proof"
grep -Fq 'mutation caddy-stale-web-stage RED' "$TMP_ROOT/pins.out" || fail "pin checker missing stale web-stage mutation proof"
grep -Fq 'mutation caddy-copy-from-stale RED' "$TMP_ROOT/pins.out" || fail "pin checker missing COPY --from stale mutation proof"
grep -Fq 'committed tree still pinned' "$TMP_ROOT/pins.out" || fail "pin checker missing restore proof"
pass "appImage + six oort-image service pins (incl. notifier, push-relay) + Caddy web source match latest.json; independent mutations RED"

# ---------------------------------------------------------------------------
# ② generator --railway key set == canonical; sabotage one key → RED
# ---------------------------------------------------------------------------
happy_env="$TMP_ROOT/railway.env"
happy_ec="$(
  run_railway "$happy_env" env \
    RAILWAY_PUBLIC_DOMAIN="$FIXTURE_HOST" \
    DATABASE_URL="$FIXTURE_DB_URL" \
    MOMO_RUST_IMAGE="$FIXTURE_IMAGE" \
    "$GENERATOR" --railway
)"
[ "$happy_ec" = "0" ] || {
  cat "$happy_env.err" >&2
  fail "--railway fixture env failed exit=$happy_ec"
}
grep -Fq "https://${FIXTURE_HOST}" "$happy_env" || fail "--railway output missing https://${FIXTURE_HOST}"
grep -Fxq "OORT_SITE_ADDRESS=${FIXTURE_HOST}" "$happy_env" || fail "OORT_SITE_ADDRESS not derived from RAILWAY_PUBLIC_DOMAIN"
grep -Fxq "MOMO_CENTRIFUGO_WS_URL=same-origin" "$happy_env" || fail "MOMO_CENTRIFUGO_WS_URL is not same-origin"

canon="$TMP_ROOT/canonical.keys"
got="$TMP_ROOT/railway.keys"
expected_keys >"$canon"
output_keys "$happy_env" >"$got"
if ! diff -u "$canon" "$got" >"$TMP_ROOT/keys.diff"; then
  cat "$TMP_ROOT/keys.diff" >&2
  fail "key-set diff not empty"
fi
key_count="$(wc -l <"$canon" | tr -d ' ')"
[ "$key_count" = "46" ] || fail "key-set count expected 46 got $key_count"
grep -Fxq 'MOMO_SELF_HOST_PLATFORM=railway' "$happy_env" || \
  fail "T2 stdout missing MOMO_SELF_HOST_PLATFORM=railway stamp"
pass "key-set equality (diff empty) count=$key_count"

# #2438 — --railway --claim swaps password ↔ claim; count stays 46 (#2066: +2).
claim_env="$TMP_ROOT/railway-claim.env"
claim_ec="$(
  run_railway "$claim_env" env \
    RAILWAY_PUBLIC_DOMAIN="$FIXTURE_HOST" \
    DATABASE_URL="$FIXTURE_DB_URL" \
    MOMO_RUST_IMAGE="$FIXTURE_IMAGE" \
    "$GENERATOR" --railway --claim
)"
[ "$claim_ec" = "0" ] || {
  cat "$claim_env.err" >&2
  fail "--railway --claim fixture env failed exit=$claim_ec"
}
grep -Fxq 'MOMO_BOOTSTRAP_CLAIM=1' "$claim_env" || fail "--railway --claim missing MOMO_BOOTSTRAP_CLAIM=1"
if grep -q '^MOMO_INITIAL_OWNER_PASSWORD=' "$claim_env"; then
  fail "--railway --claim wrote MOMO_INITIAL_OWNER_PASSWORD"
fi
{
  canonical_keys | awk '
    $0 == "MOMO_INITIAL_OWNER_PASSWORD" { print "MOMO_BOOTSTRAP_CLAIM"; next }
    { print }
  '
  printf 'MOMO_SELF_HOST_PLATFORM\n'
} | LC_ALL=C sort -u >"$TMP_ROOT/claim.expected.keys"
output_keys "$claim_env" >"$TMP_ROOT/claim.got.keys"
if ! diff -u "$TMP_ROOT/claim.expected.keys" "$TMP_ROOT/claim.got.keys" \
  >"$TMP_ROOT/claim.keys.diff"; then
  cat "$TMP_ROOT/claim.keys.diff" >&2
  fail "--railway --claim key-set diff not empty"
fi
claim_count="$(wc -l <"$TMP_ROOT/claim.got.keys" | tr -d ' ')"
[ "$claim_count" = "46" ] || fail "--railway --claim key-set count expected 46 got $claim_count"
pass "key-set --claim equality (diff empty) count=$claim_count (password variant $key_count; 1:1 swap)"

# ---------------------------------------------------------------------------
# ① railway.json catalog (#2205). The team instance is rendered with --claim,
# so `${{shared.KEY}}` must name a key that render writes. Each rule has a
# scratch mutation that must turn RED naming it.
# ---------------------------------------------------------------------------
output_keys "$claim_env" >"$TMP_ROOT/claim.keys"
python3 "$CATALOG_CHECKER" "$RAILWAY_JSON" "$COMPOSE_RUST" "$TMP_ROOT/claim.keys" \
  "$README_RAILWAY" --prove-mutations \
  >"$TMP_ROOT/catalog.out" 2>"$TMP_ROOT/catalog.err" || {
  cat "$TMP_ROOT/catalog.out" >&2
  cat "$TMP_ROOT/catalog.err" >&2
  fail "railway.json catalog check or its mutation proof failed"
}
for mutation in start-bare-api start-bare-relay start-no-exec predeploy-raw \
  centrifugo-origins-dropped centrifugo-compose-name api-volume-missing \
  api-run-uid-missing api-keeps-superuser api-dsn-superuser postgres-plugin \
  postgres-image-drift postgres-volume-missing worker-url-drift push-sandbox \
  push-key-on-disk sealed-shared sender-key-dropped unknown-shared-ref api-public \
  readme-row-missing; do
  grep -Fq "mutation ${mutation} RED" "$TMP_ROOT/catalog.out" || \
    fail "catalog checker missing mutation proof: ${mutation}"
done
grep -Fq 'committed catalog still passes' "$TMP_ROOT/catalog.out" || \
  fail "catalog checker missing restore proof"
pass "catalog: start commands, pre-deploy sh -c, Centrifugo v6 names, api volume/UID/privilege drop, PG18+pgvector image+volume, push tmpfs keys, shared refs ⊆ --claim keys, README hand-mapped table; 21 mutations RED"

# ---------------------------------------------------------------------------
# ②b #2066 R2 — T2 has no env file, so the `--ensure-managed-keys` backfill
# never runs here (`oort_upgrade_t2` prints digest instructions and returns).
# The only D2(a) path a platform install has is this render: when the operator
# hands us the JWT secret already in use and no webhook keys, the two new keys
# must be an explicit **copy** of it. Fresh randoms would invalidate every
# issued native ingress secret, event subscription and doorbell secret at once.
# ---------------------------------------------------------------------------
FIXTURE_JWT="jwt-in-use-$(openssl rand -hex 8)"
transition_env="$TMP_ROOT/railway-transition.env"
transition_ec="$(
  run_railway "$transition_env" env \
    RAILWAY_PUBLIC_DOMAIN="$FIXTURE_HOST" \
    DATABASE_URL="$FIXTURE_DB_URL" \
    MOMO_RUST_IMAGE="$FIXTURE_IMAGE" \
    JWT_HMAC="$FIXTURE_JWT" \
    "$GENERATOR" --railway
)"
[ "$transition_ec" = "0" ] || {
  cat "$transition_env.err" >&2
  fail "--railway with an in-use JWT_HMAC failed exit=$transition_ec"
}
grep -Fxq "JWT_HMAC=${FIXTURE_JWT}" "$transition_env" || \
  fail "--railway did not reuse the surrounding JWT_HMAC"
grep -Fxq "WEBHOOK_INGRESS_MASTER_KEY=${FIXTURE_JWT}" "$transition_env" || \
  fail "T2 D2(a): WEBHOOK_INGRESS_MASTER_KEY is not the transition copy of JWT_HMAC — every issued native secret would die: $(grep '^WEBHOOK_INGRESS_MASTER_KEY=' "$transition_env" | sed 's/=.*/=<redacted>/')"
grep -Fxq "OUTBOUND_WEBHOOK_MASTER_KEY=${FIXTURE_JWT}" "$transition_env" || \
  fail "T2 D2(a): OUTBOUND_WEBHOOK_MASTER_KEY is not the transition copy of JWT_HMAC"
grep -Fq '이행 복사' "$transition_env.err" || {
  cat "$transition_env.err" >&2
  fail "the transition copy must be announced on stderr"
}
if grep -Fq "$FIXTURE_JWT" "$transition_env.err"; then
  fail "the transition notice leaked the key value"
fi
pass "T2 D2(a): JWT_HMAC in env + no webhook keys → both keys are its copy, announced without the value"

# Already-set keys win: a platform operator who rotated must not be reset by a
# re-render (add-only, the same rule the file backfill keeps).
PRESET_IN="rotated-in-$(openssl rand -hex 8)"
PRESET_OUT="rotated-out-$(openssl rand -hex 8)"
preset_env="$TMP_ROOT/railway-preset.env"
preset_ec="$(
  run_railway "$preset_env" env \
    RAILWAY_PUBLIC_DOMAIN="$FIXTURE_HOST" \
    DATABASE_URL="$FIXTURE_DB_URL" \
    MOMO_RUST_IMAGE="$FIXTURE_IMAGE" \
    JWT_HMAC="$FIXTURE_JWT" \
    WEBHOOK_INGRESS_MASTER_KEY="$PRESET_IN" \
    OUTBOUND_WEBHOOK_MASTER_KEY="$PRESET_OUT" \
    "$GENERATOR" --railway
)"
[ "$preset_ec" = "0" ] || {
  cat "$preset_env.err" >&2
  fail "--railway with preset webhook keys failed exit=$preset_ec"
}
grep -Fxq "WEBHOOK_INGRESS_MASTER_KEY=${PRESET_IN}" "$preset_env" || \
  fail "a rotated WEBHOOK_INGRESS_MASTER_KEY must survive a re-render"
grep -Fxq "OUTBOUND_WEBHOOK_MASTER_KEY=${PRESET_OUT}" "$preset_env" || \
  fail "a rotated OUTBOUND_WEBHOOK_MASTER_KEY must survive a re-render"
if grep -Fq '이행 복사' "$preset_env.err"; then
  fail "preset keys are not a transition copy; the notice must not fire"
fi
pass "T2: preset webhook keys survive a re-render and raise no transition notice"

sabotaged="$TMP_ROOT/sabotaged.env"
grep -v '^JWT_HMAC=' "$happy_env" >"$sabotaged" || true
output_keys "$sabotaged" >"$TMP_ROOT/sabotaged.keys"
if diff -q "$canon" "$TMP_ROOT/sabotaged.keys" >/dev/null; then
  fail "sabotage (drop JWT_HMAC) still compared equal — comparison is not load-bearing"
fi
pass "sabotage drop JWT_HMAC → key-set RED"

README_RAILWAY="$ROOT/infra/railway/README.md"
assert_stamp_in_table "$RAILWAY_JSON" "$README_RAILWAY" || \
  fail "MOMO_SELF_HOST_PLATFORM=railway missing from railway.json or README variable table"
pass "stamp listed in railway.json notes.platformStamp and README variable table"

python3 - "$RAILWAY_JSON" "$TMP_ROOT/railway.nostamp.json" <<'PY'
from pathlib import Path
import sys
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
text = src.read_text()
needle = "MOMO_SELF_HOST_PLATFORM=railway"
if needle not in text:
    raise SystemExit("railway.json missing stamp line to sabotage")
dst.write_text(text.replace(needle, "MOMO_SELF_HOST_TIER=t2", 1))
PY
if assert_stamp_in_table "$TMP_ROOT/railway.nostamp.json" "$README_RAILWAY"; then
  fail "sabotage (remove stamp from railway.json table) still asserted present"
fi
pass "sabotage remove MOMO_SELF_HOST_PLATFORM from railway.json table → RED"

# ---------------------------------------------------------------------------
# ④ missing public domain / DATABASE_URL → explicit fail sentences
# ---------------------------------------------------------------------------
miss_domain_ec="$(
  run_railway "$TMP_ROOT/missing-domain.out" env \
    DATABASE_URL="$FIXTURE_DB_URL" \
    MOMO_RUST_IMAGE="$FIXTURE_IMAGE" \
    "$GENERATOR" --railway
)"
[ "$miss_domain_ec" != "0" ] || fail "--railway without RAILWAY_PUBLIC_DOMAIN unexpectedly succeeded"
grep -Fq "$MISSING_DOMAIN_SENTENCE" "$TMP_ROOT/missing-domain.out.err" || {
  cat "$TMP_ROOT/missing-domain.out.err" >&2
  fail "missing-domain stderr did not contain the explicit failure sentence"
}
pass "missing RAILWAY_PUBLIC_DOMAIN fails with the explicit sentence"

miss_db_ec="$(
  run_railway "$TMP_ROOT/missing-db.out" env \
    RAILWAY_PUBLIC_DOMAIN="$FIXTURE_HOST" \
    MOMO_RUST_IMAGE="$FIXTURE_IMAGE" \
    "$GENERATOR" --railway
)"
[ "$miss_db_ec" != "0" ] || fail "--railway without DATABASE_URL unexpectedly succeeded"
grep -Fq "$MISSING_DB_SENTENCE" "$TMP_ROOT/missing-db.out.err" || {
  cat "$TMP_ROOT/missing-db.out.err" >&2
  fail "missing-db stderr did not contain the explicit failure sentence"
}
pass "missing DATABASE_URL fails with the explicit sentence (compose :? equivalent)"

# ---------------------------------------------------------------------------
# ③ Caddyfile.railway: caddy adapt + 403 order; broken order RED
# ---------------------------------------------------------------------------
grep -Fq 'auto_https off' "$CADDYFILE_RAILWAY" && grep -Eq '^:8080[[:space:]]+\{' "$CADDYFILE_RAILWAY" && \
  fail "Caddyfile.railway uses forbidden auto_https off + :8080 site form"
grep -Fq 'http://{$OORT_SITE_ADDRESS}' "$CADDYFILE_RAILWAY" || \
  fail "Caddyfile.railway missing http://{\$OORT_SITE_ADDRESS} site"

ADAPT_JSON="$TMP_ROOT/adapt.json"
ADAPT_ERR="$TMP_ROOT/adapt.err"
set +e
docker run --rm \
  -e "OORT_SITE_ADDRESS=${FIXTURE_HOST}" \
  -e "OORT_CSP_CONNECT_SRC=${FIXTURE_CSP}" \
  -e "PORT=8080" \
  -v "${CADDYFILE_RAILWAY}:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
  >"$ADAPT_JSON" 2>"$ADAPT_ERR"
adapt_ec=$?
set -e
[ "$adapt_ec" -eq 0 ] || {
  cat "$ADAPT_ERR" >&2
  fail "caddy adapt Caddyfile.railway failed exit=$adapt_ec"
}
pass "caddy adapt Caddyfile.railway with fixture env"

# ---------------------------------------------------------------------------
# ③b X-Forwarded-Proto (#2205, audit §A.4-5). Railway terminates TLS, so Caddy
# receives plain HTTP and — with no trusted_proxies — forwards `http`; the api
# then advertises ws:// and an http:// QR origin. Every reverse_proxy to the
# api must set the header; Centrifugo's proxy does not need it.
# ---------------------------------------------------------------------------
xfp_api_proxies() {
  # prints "<with-https> <without>" for reverse_proxy handlers dialing the api
  python3 - "$1" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
with_https = without = 0
def walk(node):
    global with_https, without
    if isinstance(node, dict):
        if node.get("handler") == "reverse_proxy":
            dials = [u.get("dial") for u in node.get("upstreams", [])]
            if "api.railway.internal:8080" in dials:
                xfp = (((node.get("headers") or {}).get("request") or {}).get("set") or {}).get("X-Forwarded-Proto")
                if xfp == ["https"]:
                    with_https += 1
                else:
                    without += 1
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
walk(doc)
print("%d %d" % (with_https, without))
PY
}

adapt_stdin() {
  # caddy adapt of an arbitrary (scratch) Caddyfile, fed on stdin.
  docker run --rm -i \
    -e "OORT_SITE_ADDRESS=${FIXTURE_HOST}" \
    -e "OORT_CSP_CONNECT_SRC=${FIXTURE_CSP}" \
    -e "PORT=8080" \
    "$CADDY_IMAGE" \
    sh -c 'cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile' \
    <"$1"
}

xfp_counts="$(xfp_api_proxies "$ADAPT_JSON")"
[ "$xfp_counts" = "3 0" ] || \
  fail "Caddyfile.railway: api reverse_proxy blocks with X-Forwarded-Proto https / without = ${xfp_counts} (want 3 0)"
pass "adapt JSON: all 3 api reverse_proxy blocks set X-Forwarded-Proto https"

XFP_STRIPPED="$TMP_ROOT/Caddyfile.no-xfp"
python3 - "$CADDYFILE_RAILWAY" "$XFP_STRIPPED" <<'PY'
from pathlib import Path
import sys
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
text = src.read_text()
block = "\t\treverse_proxy api.railway.internal:8080 {\n\t\t\theader_up X-Forwarded-Proto https\n\t\t}\n"
if text.count(block) != 3:
    raise SystemExit("expected 3 header_up blocks to strip, found %d" % text.count(block))
dst.write_text(text.replace(block, "\t\treverse_proxy api.railway.internal:8080\n"))
PY
adapt_stdin "$XFP_STRIPPED" >"$TMP_ROOT/adapt-no-xfp.json" 2>"$TMP_ROOT/adapt-no-xfp.err" || {
  cat "$TMP_ROOT/adapt-no-xfp.err" >&2
  fail "caddy adapt of the header_up-stripped copy failed"
}
stripped_counts="$(xfp_api_proxies "$TMP_ROOT/adapt-no-xfp.json")"
[ "$stripped_counts" = "0 3" ] || \
  fail "sabotage (strip header_up) still counted ${stripped_counts} — XFP check is not load-bearing"
pass "sabotage strip header_up → adapt JSON has 0/3 api proxies with X-Forwarded-Proto https (RED)"

assert_403_order() {
  local file="$1"
  local deny_count deny_line api_line
  deny_count="$(grep -Ec '^[[:space:]]*handle /v1/centrifugo/\* \{[[:space:]]*$' "$file" || true)"
  [ "$deny_count" = "1" ] || return 1
  deny_line="$(grep -En '^[[:space:]]*handle /v1/centrifugo/\* \{[[:space:]]*$' "$file" | cut -d: -f1)"
  api_line="$(grep -En '^[[:space:]]*handle /v1/\* \{[[:space:]]*$' "$file" | cut -d: -f1 | head -1)"
  [ -n "$deny_line" ] && [ -n "$api_line" ] || return 1
  [ "$deny_line" -lt "$api_line" ] || return 1
  awk '
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
  ' "$file"
}

assert_403_order "$CADDYFILE_RAILWAY" || fail "Caddyfile.railway 403 order/shape"
pass "Caddyfile.railway /v1/centrifugo/* exclusive 403 before /v1/*"

broken="$TMP_ROOT/Caddyfile.broken"
python3 - "$CADDYFILE_RAILWAY" "$broken" <<'PY'
from pathlib import Path
import sys
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
text = src.read_text()
old = """\thandle /v1/centrifugo/* {
\t\trespond 403
\t}
\thandle /v1/* {
"""
new = """\thandle /v1/* {
\t\treverse_proxy api.railway.internal:8080
\t}
\thandle /v1/centrifugo/* {
\t\trespond 403
\t}
\thandle /v1/* {
"""
if old not in text:
    raise SystemExit("could not locate 403 block to sabotage")
dst.write_text(text.replace(old, new, 1))
PY
if assert_403_order "$broken"; then
  fail "swapped 403 order still asserted PASS — order check is not load-bearing"
fi
pass "sabotage 403 after /v1/* → order assertion RED"

# ---------------------------------------------------------------------------
# Contract fixture: Caddyfile.railway as infra/rust/Caddyfile (gate unmodified)
# ---------------------------------------------------------------------------
setup_contract_tree() {
  local dest="$1" caddy_src="$2"
  mkdir -p "$dest/infra/rust" "$dest/scripts" "$dest/docs"
  cp "$caddy_src" "$dest/infra/rust/Caddyfile"
  cp "$ROOT/infra/rust/docker-compose.rust.yml" "$dest/infra/rust/docker-compose.rust.yml"
  cp "$ROOT/docs/SELF_HOST.md" "$dest/docs/SELF_HOST.md"
  cp "$ROOT/scripts/verify_public_edge_centrifugo_boundary.sh" \
    "$dest/scripts/verify_public_edge_centrifugo_boundary.sh"
}

ok_tree="$TMP_ROOT/contract-ok"
setup_contract_tree "$ok_tree" "$CADDYFILE_RAILWAY"
set +e
MOMO_NCP_CONTRACT_ROOT="$ok_tree" bash "$CONTRACT" >"$TMP_ROOT/contract-ok.out" 2>"$TMP_ROOT/contract-ok.err"
contract_ok_ec=$?
set -e
[ "$contract_ok_ec" -eq 0 ] || {
  cat "$TMP_ROOT/contract-ok.out" >&2
  cat "$TMP_ROOT/contract-ok.err" >&2
  fail "public-edge contract RED on Caddyfile.railway fixture exit=$contract_ok_ec"
}
grep -Fq 'PASS complete' "$TMP_ROOT/contract-ok.out" || fail "contract fixture missing PASS complete"
pass "verify_public_edge_centrifugo_contract.sh PASS on Caddyfile.railway fixture"

bad_tree="$TMP_ROOT/contract-bad"
setup_contract_tree "$bad_tree" "$broken"
set +e
MOMO_NCP_CONTRACT_ROOT="$bad_tree" bash "$CONTRACT" >"$TMP_ROOT/contract-bad.out" 2>"$TMP_ROOT/contract-bad.err"
contract_bad_ec=$?
set -e
[ "$contract_bad_ec" -ne 0 ] || {
  cat "$TMP_ROOT/contract-bad.out" >&2
  fail "public-edge contract PASS on swapped-403 Caddyfile.railway fixture"
}
grep -Eq 'edge_deny_order|edge_deny_count|edge_deny_shape' "$TMP_ROOT/contract-bad.err" || {
  cat "$TMP_ROOT/contract-bad.err" >&2
  fail "contract RED on broken order did not name deny order/shape"
}
pass "verify_public_edge_centrifugo_contract.sh RED when Caddyfile.railway 403 order is broken"

# ---------------------------------------------------------------------------
# ⑤ live X-Forwarded-Proto (#2205). What the api actually receives: an echo
# upstream aliased api.railway.internal answers with the X-Forwarded-Proto it
# got. Requests carry `X-Forwarded-Proto: https` the way Railway's edge sends
# them. Committed Caddyfile → https on all three api paths; the stripped copy
# → http (the defect: ws:// realtime URL, http:// QR origin).
# ---------------------------------------------------------------------------
docker network create "$PROBE_NET" >/dev/null
docker run -d --name "${PROBE_PREFIX}-echo" --network "$PROBE_NET" \
  --network-alias api.railway.internal \
  -e 'ECHO_CADDYFILE=:8080 {
	respond "{http.request.header.X-Forwarded-Proto}"
}' \
  "$CADDY_IMAGE" \
  sh -c 'printf "%s\n" "$ECHO_CADDYFILE" >/tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile' \
  >/dev/null

start_edge() {
  # usage: start_edge <suffix> <Caddyfile>; copied in, never bind-mounted
  docker create --name "${PROBE_PREFIX}-$1" --network "$PROBE_NET" \
    -p 127.0.0.1::8080 \
    -e "OORT_SITE_ADDRESS=${FIXTURE_HOST}" \
    -e "OORT_CSP_CONNECT_SRC=${FIXTURE_CSP}" \
    -e "PORT=8080" \
    "$CADDY_IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  docker cp "$2" "${PROBE_PREFIX}-$1:/etc/caddy/Caddyfile" >/dev/null
  docker start "${PROBE_PREFIX}-$1" >/dev/null
}

published_port() {
  docker port "$1" "$2/tcp" | head -1 | awk -F: '{ print $NF }'
}

xfp_seen() {
  curl -sS -m 5 -H "Host: ${FIXTURE_HOST}" -H 'X-Forwarded-Proto: https' \
    "http://127.0.0.1:$1$2" 2>/dev/null || true
}

start_edge edge-committed "$CADDYFILE_RAILWAY"
start_edge edge-no-xfp "$XFP_STRIPPED"
EDGE_PORT="$(published_port "${PROBE_PREFIX}-edge-committed" 8080)"
EDGE_NOXFP_PORT="$(published_port "${PROBE_PREFIX}-edge-no-xfp" 8080)"
i=0
until [ -n "$(xfp_seen "$EDGE_PORT" /healthz)" ] && [ -n "$(xfp_seen "$EDGE_NOXFP_PORT" /healthz)" ]; do
  i=$((i + 1))
  [ "$i" -lt 50 ] || fail "live XFP probe: edge/echo containers did not answer"
  sleep 0.2
done
for path in /v1/xfp-probe /hooks/xfp-probe /healthz; do
  seen="$(xfp_seen "$EDGE_PORT" "$path")"
  printf '[test-railway-template] XFP committed %s → api sees X-Forwarded-Proto=%s\n' "$path" "$seen"
  [ "$seen" = "https" ] || fail "committed Caddyfile.railway: api saw X-Forwarded-Proto=${seen:-<empty>} on ${path} (want https)"
  seen="$(xfp_seen "$EDGE_NOXFP_PORT" "$path")"
  printf '[test-railway-template] XFP no-header_up %s → api sees X-Forwarded-Proto=%s\n' "$path" "$seen"
  [ "$seen" = "http" ] || fail "sabotage (strip header_up) on ${path}: api saw ${seen:-<empty>} — probe is not load-bearing (want http)"
done
pass "live: committed edge forwards X-Forwarded-Proto=https to the api on /v1, /hooks, /healthz; without header_up it is http (RED)"

# ---------------------------------------------------------------------------
# ⑥ live Centrifugo from the catalog's own variables (#2205, audit §A.4-4).
# The pinned image boots with services.centrifugo.variables rendered against
# the --claim generator output. Origin upgrade → 101 and an API-key publish →
# 200. A scratch catalog without the two v6 names (the pre-#2205 catalog had
# none) → 403 and 401, while an upgrade with no Origin still gets 101.
# ---------------------------------------------------------------------------
render_service_env() {
  # usage: render_service_env <catalog> <service> <generator env> <out>
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, re, sys
catalog, service, env_in, env_out = sys.argv[1:5]
shared = {}
for raw in open(env_in, encoding="utf-8"):
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", raw.rstrip("\n"))
    if not match:
        continue
    value = match.group(2)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    shared[match.group(1)] = value
variables = json.load(open(catalog))["services"][service].get("variables") or {}
def resolve(value):
    def sub(match):
        ref = match.group(1)
        if not ref.startswith("shared."):
            raise SystemExit("unsupported reference ${{%s}}" % ref)
        if ref[len("shared."):] not in shared:
            raise SystemExit("${{%s}} is not in the generator output" % ref)
        return shared[ref[len("shared."):]]
    return re.sub(r"\$\{\{([^}]*)\}\}", sub, value)
with open(env_out, "w", encoding="utf-8") as out:
    for name, value in variables.items():
        resolved = resolve(str(value))
        if "\n" in resolved:
            raise SystemExit("%s has a newline" % name)
        out.write("%s=%s\n" % (name, resolved))
PY
}

ws_upgrade_code() {
  # usage: ws_upgrade_code <port> [origin]; curl waits after a real 101 until -m
  local port="$1" origin="${2:-}" key
  key="$(openssl rand -base64 16 | tr -d '\n')"
  if [ -n "$origin" ]; then
    curl -sS --http1.1 -m 2 -o /dev/null -w '%{http_code}' \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H "Sec-WebSocket-Key: ${key}" -H "Origin: ${origin}" \
      "http://127.0.0.1:${port}/connection/websocket" 2>/dev/null || true
  else
    curl -sS --http1.1 -m 2 -o /dev/null -w '%{http_code}' \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H "Sec-WebSocket-Key: ${key}" \
      "http://127.0.0.1:${port}/connection/websocket" 2>/dev/null || true
  fi
}

publish_code() {
  # usage: publish_code <port> <api key>; the relay's publish shape
  curl -sS -m 5 -o /dev/null -w '%{http_code}' \
    -H "X-API-Key: $2" -H 'Content-Type: application/json' \
    -d '{"channel":"oort-railway-probe","data":{"probe":1}}' \
    "http://127.0.0.1:$1/api/publish" 2>/dev/null || true
}

CENT_IMAGE_PIN="$(jq -r '.services.centrifugo.image' "$RAILWAY_JSON")"
read -r -a CENT_ARGV <<<"$(jq -r '.services.centrifugo.startCommand' "$RAILWAY_JSON")"
render_service_env "$RAILWAY_JSON" centrifugo "$claim_env" "$TMP_ROOT/centrifugo.env"
jq 'del(.services.centrifugo.variables.CENTRIFUGO_CLIENT_ALLOWED_ORIGINS, .services.centrifugo.variables.CENTRIFUGO_HTTP_API_KEY)' \
  "$RAILWAY_JSON" >"$TMP_ROOT/railway.no-v6-names.json"
render_service_env "$TMP_ROOT/railway.no-v6-names.json" centrifugo "$claim_env" "$TMP_ROOT/centrifugo.no-v6.env"
docker run -d --name "${PROBE_PREFIX}-cent" -p 127.0.0.1::8000 \
  --env-file "$TMP_ROOT/centrifugo.env" "$CENT_IMAGE_PIN" "${CENT_ARGV[@]}" >/dev/null
docker run -d --name "${PROBE_PREFIX}-cent-bare" -p 127.0.0.1::8000 \
  --env-file "$TMP_ROOT/centrifugo.no-v6.env" "$CENT_IMAGE_PIN" "${CENT_ARGV[@]}" >/dev/null
CENT_PORT="$(published_port "${PROBE_PREFIX}-cent" 8000)"
CENT_BARE_PORT="$(published_port "${PROBE_PREFIX}-cent-bare" 8000)"
FIXTURE_API_KEY="$(awk 'index($0, "CENT_API_KEY=") == 1 { print substr($0, 14); exit }' "$claim_env")"
[ -n "$FIXTURE_API_KEY" ] || fail "claim env has no CENT_API_KEY"
i=0
until [ "$(publish_code "$CENT_PORT" x)" != "000" ] && [ "$(publish_code "$CENT_BARE_PORT" x)" != "000" ]; do
  i=$((i + 1))
  [ "$i" -lt 50 ] || { docker logs "${PROBE_PREFIX}-cent" 2>&1 | tail -5 >&2; fail "Centrifugo from the catalog did not start"; }
  sleep 0.2
done

origin="https://${FIXTURE_HOST}"
code="$(ws_upgrade_code "$CENT_PORT" "$origin")"
printf '[test-railway-template] centrifugo(catalog) WS upgrade Origin %s → %s\n' "$origin" "$code"
[ "$code" = "101" ] || fail "Centrifugo from the catalog refused Origin ${origin}: HTTP ${code} (want 101)"
code="$(publish_code "$CENT_PORT" "$FIXTURE_API_KEY")"
printf '[test-railway-template] centrifugo(catalog) publish with CENT_API_KEY → %s\n' "$code"
[ "$code" = "200" ] || fail "Centrifugo from the catalog refused the relay's API key: HTTP ${code} (want 200)"

code="$(ws_upgrade_code "$CENT_BARE_PORT" "$origin")"
printf '[test-railway-template] centrifugo(no v6 names) WS upgrade Origin %s → %s\n' "$origin" "$code"
[ "$code" = "403" ] || fail "sabotage (no CENTRIFUGO_CLIENT_ALLOWED_ORIGINS) still answered ${code} to Origin ${origin} (want 403)"
code="$(publish_code "$CENT_BARE_PORT" "$FIXTURE_API_KEY")"
printf '[test-railway-template] centrifugo(no v6 names) publish with CENT_API_KEY → %s\n' "$code"
[ "$code" = "401" ] || fail "sabotage (no CENTRIFUGO_HTTP_API_KEY) still answered ${code} to a publish (want 401)"
code="$(ws_upgrade_code "$CENT_BARE_PORT")"
printf '[test-railway-template] centrifugo(no v6 names) WS upgrade without Origin → %s (the pre-#2205 doctor probe)\n' "$code"
[ "$code" = "101" ] || fail "no-Origin upgrade against an empty allowlist answered ${code}; expected 101 (the blind spot)"
pass "live: Centrifugo from the catalog 101 (Origin) + 200 (publish); without the v6 names 403 + 401, and a no-Origin upgrade still 101"

printf '[test-railway-template] PASS complete\n'
