#!/usr/bin/env bash
# SH-2 / #1926 — public edge template: site address + CSP connect-src env,
# ACME fail-closed when unset, wildcard rejection, local deny order.
# bats is not in the toolchain; this file is the suite.
set -euo pipefail

fail() {
  printf '[test-public-edge] FAIL %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[test-public-edge] PASS %s\n' "$*"
}

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

CADDYFILE="$ROOT/infra/rust/Caddyfile"
CADDYFILE_LOCAL="$ROOT/infra/rust/Caddyfile.local"
CADDY_IMAGE="${MOMO_CADDY_IMAGE:-caddy:2-alpine}"
FIXTURE_HOST="edge.example.test"
FIXTURE_ORIGIN="https://${FIXTURE_HOST}"
FIXTURE_CSP="'self' ${FIXTURE_ORIGIN} wss://${FIXTURE_HOST} https://www.googleapis.com"
WILDCARD_SENTENCE='와일드카드를 허용하지 않는다'

command -v docker >/dev/null 2>&1 || fail "docker 없음"
command -v python3 >/dev/null 2>&1 || fail "python3 없음"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-public-edge.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

# ---------------------------------------------------------------------------
# ① fixture env → caddy adapt: site host, CSP tokens, no wildcard, no oor7
# ---------------------------------------------------------------------------
ADAPT_JSON="$TMP_ROOT/adapt-set.json"
ADAPT_ERR="$TMP_ROOT/adapt-set.err"
set +e
docker run --rm \
  -e "OORT_SITE_ADDRESS=${FIXTURE_HOST}" \
  -e "OORT_CSP_CONNECT_SRC=${FIXTURE_CSP}" \
  -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
  >"$ADAPT_JSON" 2>"$ADAPT_ERR"
adapt_set_ec=$?
set -e
[ "$adapt_set_ec" -eq 0 ] || {
  cat "$ADAPT_ERR" >&2
  fail "caddy adapt with fixture env failed exit=$adapt_set_ec"
}

python3 - "$ADAPT_JSON" "$FIXTURE_HOST" "$FIXTURE_ORIGIN" <<'PY'
import json, sys
path, host, origin = sys.argv[1], sys.argv[2], sys.argv[3]
wss = "wss://" + host
with open(path) as f:
    data = json.load(f)
hosts = []
csp_values = []

def walk(obj):
    if isinstance(obj, dict):
        match = obj.get("match")
        if isinstance(match, list):
            for item in match:
                if isinstance(item, dict):
                    for h in item.get("host") or []:
                        hosts.append(h)
        resp = obj.get("response") or {}
        sett = resp.get("set") if isinstance(resp, dict) else None
        if isinstance(sett, dict):
            for key, vals in sett.items():
                if key.lower() == "content-security-policy":
                    if isinstance(vals, list):
                        csp_values.extend(vals)
                    elif isinstance(vals, str):
                        csp_values.append(vals)
        for v in obj.values():
            walk(v)
    elif isinstance(obj, list):
        for item in obj:
            walk(item)

walk(data)
if hosts != [host]:
    raise SystemExit("site host mismatch expected=%s actual=%s" % (host, hosts))
if not csp_values:
    raise SystemExit("no Content-Security-Policy in adapt JSON")
joined = " ".join(csp_values)
# Isolate the connect-src token list (print for the PR body).
connect = None
for policy in csp_values:
    parts = [p.strip() for p in policy.split(";") if p.strip()]
    for part in parts:
        if part.startswith("connect-src "):
            connect = part[len("connect-src "):]
            break
if connect is None:
    raise SystemExit("connect-src directive missing")
tokens = connect.split()
print("connect-src tokens:", " ".join(tokens))
if origin not in tokens:
    raise SystemExit("connect-src missing %s tokens=%s" % (origin, tokens))
if wss not in tokens:
    raise SystemExit("connect-src missing %s tokens=%s" % (wss, tokens))
if "*" in tokens:
    raise SystemExit("connect-src contains wildcard token: %s" % tokens)
if "app.oor7.com" in json.dumps(data):
    raise SystemExit("adapt JSON still names app.oor7.com")
print("site_host", hosts[0])
PY

pass "caddy adapt fixture host=$FIXTURE_HOST and CSP tokens include https/wss twins"

# ---------------------------------------------------------------------------
# ② unset public-edge keys → compose `:?` refuses to render (load-bearing)
#    caddy adapt/validate also fail, but that is incidental: an empty site
#    address makes `encode` an unrecognized global option.
# ---------------------------------------------------------------------------
COMPOSE_UNSET_ERR="$TMP_ROOT/compose-unset.err"
set +e
env -u OORT_SITE_ADDRESS -u OORT_CSP_CONNECT_SRC -u COMPOSE_FILE \
  docker compose --env-file "$ROOT/infra/rust/rust-smoke.env.example" \
    -f "$ROOT/infra/rust/docker-compose.rust.yml" \
    -f "$ROOT/infra/rust/caddy.override.yml" \
    config >"$TMP_ROOT/compose-unset.out" 2>"$COMPOSE_UNSET_ERR"
compose_unset_ec=$?
set -e
printf '[test-public-edge] compose-unset exit=%s\n' "$compose_unset_ec"
[ "$compose_unset_ec" -ne 0 ] || fail "compose config without OORT_SITE_ADDRESS unexpectedly succeeded"
grep -Fq 'set OORT_SITE_ADDRESS' "$COMPOSE_UNSET_ERR" || {
  cat "$COMPOSE_UNSET_ERR" >&2
  fail "compose unset stderr did not contain set OORT_SITE_ADDRESS"
}
pass "unset OORT_SITE_ADDRESS / OORT_CSP_CONNECT_SRC refuses compose config via :?"

# Incidental: caddy adapt/validate with the two keys unset also exit ≠ 0.
# They fail because `encode` is parsed as a global option, not because compose
# `:?` ran. The compose case above is the guard.
UNSET_ERR="$TMP_ROOT/adapt-unset.err"
set +e
docker run --rm \
  -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
  >"$TMP_ROOT/adapt-unset.json" 2>"$UNSET_ERR"
adapt_unset_ec=$?
docker run --rm \
  -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  >"$TMP_ROOT/validate-unset.out" 2>"$TMP_ROOT/validate-unset.err"
validate_unset_ec=$?
set -e
printf '[test-public-edge] adapt-unset exit=%s (incidental)\n' "$adapt_unset_ec"
printf '[test-public-edge] validate-unset exit=%s (incidental)\n' "$validate_unset_ec"
[ "$adapt_unset_ec" -ne 0 ] || fail "caddy adapt without OORT_SITE_ADDRESS unexpectedly succeeded"
[ "$validate_unset_ec" -ne 0 ] || fail "caddy validate without OORT_SITE_ADDRESS unexpectedly succeeded"
pass "unset OORT_SITE_ADDRESS / OORT_CSP_CONNECT_SRC refuses adapt/validate (incidental)"

# ---------------------------------------------------------------------------
# Generator fixture (fake docker/openssl — never writes the worktree env)
# ---------------------------------------------------------------------------
make_fixture() {
  local name="$1"
  local fixture="$TMP_ROOT/$name"
  mkdir -p "$fixture/scripts" "$fixture/infra/rust" "$fixture/fake-bin"
  cp "$ROOT/scripts/self_host_env.sh" "$fixture/scripts/self_host_env.sh"
  cp "$ROOT/infra/rust/docker-compose.rust.yml" "$fixture/infra/rust/docker-compose.rust.yml"
  cp "$ROOT/infra/rust/docker-compose.rust.build.yml" "$fixture/infra/rust/docker-compose.rust.build.yml"
  cp "$ROOT/infra/rust/local.override.yml" "$fixture/infra/rust/local.override.yml"
  cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
  cat >"$fixture/fake-bin/openssl" <<'EOF'
#!/usr/bin/env sh
if [ "${1:-}" = "rand" ] && [ "${2:-}" = "-hex" ]; then
  count=$((${3:-1} * 2))
  i=0
  while [ "$i" -lt "$count" ]; do
    printf 'a'
    i=$((i + 1))
  done
  printf '\n'
  exit 0
fi
exit 2
EOF
  chmod +x "$fixture/fake-bin/docker" "$fixture/fake-bin/openssl" "$fixture/scripts/self_host_env.sh"
  printf '%s\n' "$fixture"
}

run_generator() {
  local fixture="$1" output="$2" web_port="$3"
  shift 3
  (
    cd "$fixture"
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
      MOMO_WEB_PORT="$web_port" \
      MOMO_RUST_API_PORT="$((web_port + 1))" \
      CENT_HOST_PORT="$((web_port + 2))" \
      bash scripts/self_host_env.sh "$@"
  ) >"$output" 2>&1
}

edge_key_count() {
  local env_file="$1"
  grep -Ec '^OORT_SITE_ADDRESS=|^OORT_CSP_CONNECT_SRC=' "$env_file" || true
}

# ---------------------------------------------------------------------------
# ③ wildcard origin is rejected with the #1792 sentence
# ---------------------------------------------------------------------------
star_fixture="$(make_fixture public-origin-wildcard)"
set +e
run_generator "$star_fixture" "$TMP_ROOT/wildcard.out" 49810 \
  --local-build --public-origin "https://*.example.test"
wildcard_ec=$?
set -e
printf '[test-public-edge] wildcard --public-origin exit=%s\n' "$wildcard_ec"
[ "$wildcard_ec" -ne 0 ] || fail "--public-origin https://*.example.test unexpectedly succeeded"
grep -Fq "$WILDCARD_SENTENCE" "$TMP_ROOT/wildcard.out" || {
  cat "$TMP_ROOT/wildcard.out" >&2
  fail "wildcard rejection did not contain the wildcard sentence"
}
pass "wildcard --public-origin fails with the #1792 sentence"

# ---------------------------------------------------------------------------
# ④ --public-origin absent → generated env has neither public-edge key
# ---------------------------------------------------------------------------
local_fixture="$(make_fixture local-no-public)"
run_generator "$local_fixture" "$local_fixture/output" 49820 --local-build
local_env="$local_fixture/infra/rust/local.secrets.env"
[ -f "$local_env" ] || fail "local-build did not write env"
absent_count="$(edge_key_count "$local_env")"
printf '[test-public-edge] keys without --public-origin count=%s\n' "$absent_count"
[ "$absent_count" = "0" ] || fail "local env without --public-origin wrote public-edge keys ($absent_count)"
pass "--public-origin absent writes 0 OORT_SITE_ADDRESS / OORT_CSP_CONNECT_SRC lines"

# --public-origin present → keys derived from the origin (not hand-typed)
pub_fixture="$(make_fixture public-origin-keys)"
run_generator "$pub_fixture" "$pub_fixture/output" 49830 \
  --local-build --public-origin "$FIXTURE_ORIGIN"
pub_env="$pub_fixture/infra/rust/local.secrets.env"
grep -Fxq "OORT_SITE_ADDRESS=${FIXTURE_HOST}" "$pub_env" || {
  grep '^OORT_SITE_ADDRESS=' "$pub_env" >&2 || true
  fail "OORT_SITE_ADDRESS was not derived as ${FIXTURE_HOST}"
}
# Docker env-file: wrap the CSP value so a leading 'self' token is not stripped.
csp_line="$(awk -F= '$1 == "OORT_CSP_CONNECT_SRC" { print substr($0, index($0, "=") + 1) }' "$pub_env")"
csp_value="$csp_line"
case "$csp_value" in
  \"*\") csp_value="${csp_value#\"}"; csp_value="${csp_value%\"}" ;;
esac
[ "$csp_value" = "$FIXTURE_CSP" ] || fail "OORT_CSP_CONNECT_SRC mismatch actual=${csp_value}"
pass "--public-origin derives both public-edge keys from the origin"

# LiveKit URL, if present, is appended as its origin.
lk_fixture="$(make_fixture public-origin-livekit)"
run_generator "$lk_fixture" "$lk_fixture/first" 49840 --local-build
printf '\nMOMO_LIVEKIT_URL=wss://livekit.example.test/rtc\n' >>"$lk_fixture/infra/rust/local.secrets.env"
run_generator "$lk_fixture" "$lk_fixture/origin" 49840 \
  --public-origin "$FIXTURE_ORIGIN"
lk_csp="$(awk -F= '$1 == "OORT_CSP_CONNECT_SRC" { print substr($0, index($0, "=") + 1) }' "$lk_fixture/infra/rust/local.secrets.env")"
case "$lk_csp" in
  \"*\") lk_csp="${lk_csp#\"}"; lk_csp="${lk_csp%\"}" ;;
esac
case " $lk_csp " in
  *" wss://livekit.example.test "*) ;;
  *) fail "LiveKit origin missing from CSP actual=${lk_csp}" ;;
esac
pass "MOMO_LIVEKIT_URL origin is appended to OORT_CSP_CONNECT_SRC"

# ---------------------------------------------------------------------------
# Caddyfile.local deny sits in front of /v1/* (same order as the public file)
# ---------------------------------------------------------------------------
deny_before_v1() {
  local file="$1"
  local deny api
  deny="$(grep -En '^[[:space:]]*handle /v1/centrifugo/\* \{[[:space:]]*$' "$file" | head -1 | cut -d: -f1)"
  api="$(grep -En '^[[:space:]]*handle /v1/\* \{[[:space:]]*$' "$file" | head -1 | cut -d: -f1)"
  [ -n "$deny" ] && [ -n "$api" ] && [ "$deny" -lt "$api" ]
}

deny_before_v1 "$CADDYFILE" || fail "infra/rust/Caddyfile deny is missing or after /v1/*"
deny_before_v1 "$CADDYFILE_LOCAL" || fail "infra/rust/Caddyfile.local deny is missing or after /v1/*"
pass "both Caddyfiles deny /v1/centrifugo/* before /v1/*"

# Real 403 on the loopback file — :80 so automatic HTTPS/ACME stays off.
LOCAL_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
cid="$(docker run -d --name "oort-sh2-local-edge-$$" \
  -p "127.0.0.1:${LOCAL_PORT}:80" \
  -v "${CADDYFILE_LOCAL}:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE")"
cleanup_local_edge() {
  docker rm -f "$cid" >/dev/null 2>&1 || true
}
trap 'cleanup_local_edge; rm -rf "$TMP_ROOT"' EXIT INT TERM
deadline=$(( $(date -u +%s) + 30 ))
local_code=""
until local_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 \
  -X POST "http://127.0.0.1:${LOCAL_PORT}/v1/centrifugo/subscribe" || true)"; do
  [ "$(date -u +%s)" -lt "$deadline" ] || break
  sleep 1
done
until [ -n "$local_code" ] && [ "$local_code" != "000" ]; do
  [ "$(date -u +%s)" -lt "$deadline" ] || break
  local_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 \
    -X POST "http://127.0.0.1:${LOCAL_PORT}/v1/centrifugo/subscribe" || true)"
  sleep 1
done
printf '[test-public-edge] Caddyfile.local /v1/centrifugo/subscribe HTTP %s\n' "$local_code"
[ "$local_code" = "403" ] || fail "Caddyfile.local /v1/centrifugo/* expected 403 got ${local_code:-none}"
cleanup_local_edge
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM
pass "Caddyfile.local loopback edge returns 403 for /v1/centrifugo/*"

# ---------------------------------------------------------------------------
# ⑤ app.oor7.com: public template + local twin have 0 operational hits.
#    Repo-wide remainder is printed for the PR (banner/archive / out of scope).
# ---------------------------------------------------------------------------
if grep -F 'app.oor7.com' "$CADDYFILE"; then
  fail "infra/rust/Caddyfile still names app.oor7.com"
fi
if grep -E '^[^#]*app\.oor7\.com' "$CADDYFILE_LOCAL"; then
  fail "infra/rust/Caddyfile.local still names app.oor7.com outside comments"
fi
grep_count="$( { git grep -n 'app.oor7.com' || true; } | wc -l | tr -d ' ')"
printf '[test-public-edge] repo grep app.oor7.com count=%s\n' "$grep_count"
pass "public Caddyfile template has 0 app.oor7.com hits (repo count printed)"

printf '[test-public-edge] PASS complete\n'
