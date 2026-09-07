#!/usr/bin/env bash
# SH-5a / #2205 — Railway template: service catalog, --railway key-set
# equality, Caddyfile.railway adapt + 403 order (RED when swapped), missing
# public domain fail-closed. Widens the public-edge contract onto
# Caddyfile.railway via MOMO_NCP_CONTRACT_ROOT fixture (gate body untouched).
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
[ -f "$GENERATOR" ] || fail "scripts/self_host_env.sh missing"
[ -f "$CONTRACT" ] || fail "scripts/verify_public_edge_centrifugo_contract.sh missing"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-railway-template.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

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
# ① railway.json: required services, startCommand, preDeploy
# ---------------------------------------------------------------------------
python3 - "$RAILWAY_JSON" "$LATEST" <<'PY'
import json, sys
path, latest_path = sys.argv[1], sys.argv[2]
data = json.load(open(path))
services = data.get("services") or {}
required = ("api", "relay", "webhook-sender", "agent-worker", "centrifugo", "caddy")
missing = [name for name in required if name not in services]
if missing:
    raise SystemExit("railway.json missing services: %s" % ",".join(missing))
for name in ("api", "relay", "webhook-sender", "agent-worker"):
    start = services[name].get("startCommand")
    if start != name:
        raise SystemExit("%s startCommand expected=%s actual=%s" % (name, name, start))
pre = services["api"].get("preDeployCommand")
if not pre:
    raise SystemExit("api.preDeployCommand missing")
blob = " ".join(pre) if isinstance(pre, list) else str(pre)
if "momo-migrate" not in blob:
    raise SystemExit("api.preDeployCommand does not invoke momo-migrate")
if "MOMO_RUNTIME_ROLE_PROVISION=1" not in blob:
    raise SystemExit("api.preDeployCommand missing runtime-roles invocation")
if "MOMO_BOOTSTRAP_RUNTIME_ROLES=0" not in blob:
    raise SystemExit("api.preDeployCommand missing migrate invocation")
if services["centrifugo"].get("startCommand") != "centrifugo":
    raise SystemExit("centrifugo startCommand missing")
if services["caddy"].get("startCommand") is None:
    raise SystemExit("caddy startCommand missing")
if services["api"].get("public") is not False:
    raise SystemExit("api must be internal (Caddy is the public edge)")
if services["caddy"].get("public") is not True:
    raise SystemExit("caddy must be the public service")
digest = data["appImage"]["digest"]
latest = json.load(open(latest_path))
want = latest["images"]["app"]["digest_list"]
if digest != want:
    raise SystemExit("railway.json app digest %s != latest.json %s" % (digest, want))
print("services", ",".join(required))
print("preDeploy", blob[:120])
PY
pass "railway.json services + startCommand + preDeploy + digest pin"

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
canonical_keys >"$canon"
output_keys "$happy_env" >"$got"
if ! diff -u "$canon" "$got" >"$TMP_ROOT/keys.diff"; then
  cat "$TMP_ROOT/keys.diff" >&2
  fail "key-set diff not empty"
fi
pass "key-set equality (diff empty) count=$(wc -l <"$canon" | tr -d ' ')"

sabotaged="$TMP_ROOT/sabotaged.env"
grep -v '^JWT_HMAC=' "$happy_env" >"$sabotaged" || true
output_keys "$sabotaged" >"$TMP_ROOT/sabotaged.keys"
if diff -q "$canon" "$TMP_ROOT/sabotaged.keys" >/dev/null; then
  fail "sabotage (drop JWT_HMAC) still compared equal — comparison is not load-bearing"
fi
pass "sabotage drop JWT_HMAC → key-set RED"

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

printf '[test-railway-template] PASS complete\n'
