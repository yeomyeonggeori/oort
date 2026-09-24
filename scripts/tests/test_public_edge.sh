#!/usr/bin/env bash
# SH-2 / #1926 — public edge template: site address + CSP connect-src env,
# ACME fail-closed when unset, wildcard rejection, local deny order.
# #2609 ⑥ — local-archive upload route parity on every edge Caddyfile.
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

# ---------------------------------------------------------------------------
# ⑥ local-archive upload route parity on every edge Caddyfile (#2609).
#
# The generator writes MOMO_DRIVE_ARCHIVE_BACKEND=local for every install —
# loopback, T1 public origin (fly · aws-lightsail · gcp-vm · VPS),
# host-network and Railway — so the upload capability URL is always
# `$origin/__momo_stub/drive/uploads/{token}` (ADR-0169, momo-drive local.rs).
# An edge without a /__momo_stub/* route hands that PUT to the SPA catch-all,
# whose file_server answers 405: upload 405 → complete 404 → send 409, and
# the desktop's preflight OPTIONS 405. Measured on Railway (#2205) and then on
# this T1 template (#2609); each time the edge files were guarded by different
# tests and none of them asserted this route.
#
# What this section asserts, on the rendered `caddy adapt` JSON (what Caddy
# actually serves from, so file order and formatting do not matter):
#   * the edge set is DISCOVERED — every tracked `infra/**/Caddyfile*` — not
#     listed, so a new platform edge cannot sit outside the table (the #2297
#     blind spot);
#   * on every edge /__momo_stub/* is a sibling of /v1/* in the site's handle
#     table (not nested in the SPA handle), matched by path alone — any method,
#     because the desktop (tauri origin) PUT is cross-origin and its OPTIONS
#     preflight must reach the api's CORS layer — and its route body is the
#     /v1/* body: same upstream, same header_up lines, no rewrite;
#   * every edge routes the same set of paths the way it routes /v1/*.
# Each property has a scratch-copy RED below; committed files are untouched.
#
# Neighbouring guards own the rest and are deliberately not repeated here:
#   clients/web/gates/gate-csp-deploy.mjs TARGETS   response headers + CSP
#     (web lane, a listed set: infra/rust/Caddyfile · Caddyfile.local ·
#      Caddyfile.railway — Caddyfile.host-network is not in it)
#   scripts/tests/test_webhook_inbound_contract.sh  /hooks/* line shape and
#     the per-file X-Forwarded-For allowlist (the same three files)
#   scripts/verify_public_edge_centrifugo_contract.sh  /v1/centrifugo/* is an
#     exclusive 403 before /v1/* (infra/rust/Caddyfile; Railway via the
#     fixture root in test_railway_template.sh)
# ---------------------------------------------------------------------------
EDGE_ENV_ARGS=(
  -e "OORT_SITE_ADDRESS=${FIXTURE_HOST}"
  -e "OORT_CSP_CONNECT_SRC=${FIXTURE_CSP}"
  -e "PORT=8080"
  -e "MOMO_WEB_PORT=18088"
  -e "MOMO_RUST_API_PORT=18080"
  -e "CENT_HOST_PORT=18000"
)
edge_adapt() {
  # usage: edge_adapt <Caddyfile> <out.json>. Fed on stdin: scratch copies live
  # in TMPDIR, which Colima does not share into its VM.
  docker run --rm -i "${EDGE_ENV_ARGS[@]}" "$CADDY_IMAGE" \
    sh -c 'cat >/tmp/Caddyfile && caddy adapt --config /tmp/Caddyfile --adapter caddyfile' \
    <"$1" >"$2" 2>"$2.err"
}

EDGE_DIR="$TMP_ROOT/edge-parity"
mkdir -p "$EDGE_DIR"
EDGE_MANIFEST="$EDGE_DIR/committed.tsv"
: >"$EDGE_MANIFEST"
edge_count=0
while IFS= read -r edge_file; do
  [ -n "$edge_file" ] || continue
  edge_count=$((edge_count + 1))
  edge_json="$EDGE_DIR/committed-${edge_count}.json"
  edge_adapt "$ROOT/$edge_file" "$edge_json" || {
    cat "$edge_json.err" >&2
    fail "caddy adapt of ${edge_file} failed (the fixture env must cover every placeholder an edge reads)"
  }
  printf '%s\t%s\n' "$edge_file" "$edge_json" >>"$EDGE_MANIFEST"
done <<EOF
$(git ls-files -- infra | awk -F/ '$NF ~ /^Caddyfile/' | LC_ALL=C sort)
EOF
[ "$edge_count" -ge 4 ] || fail "edge discovery found ${edge_count} tracked infra/**/Caddyfile* (expected ≥ 4: rust ×3 + railway)"
grep -Fq "$(printf 'infra/rust/Caddyfile\t')" "$EDGE_MANIFEST" || fail "edge discovery missed infra/rust/Caddyfile"

cat >"$EDGE_DIR/edge_parity.py" <<'PY'
"""Verdict over rendered `caddy adapt` JSON; argv[1] = TSV of <label>\t<json>."""
import json
import sys

STUB = "/__momo_stub/*"
API = "/v1/*"


def path_only(route):
    """The one path of a route matched by path alone, else None."""
    match = route.get("match")
    if not isinstance(match, list) or len(match) != 1:
        return None
    only = match[0]
    if not isinstance(only, dict) or set(only) != {"path"} or len(only["path"]) != 1:
        return None
    return only["path"][0]


def mentions(route, path):
    return any(path in (m.get("path") or []) for m in route.get("match") or [] if isinstance(m, dict))


def body(route):
    return {key: value for key, value in route.items() if key != "match"}


def route_lists(node):
    """Every `routes` array in the document, outermost first."""
    if isinstance(node, dict):
        if isinstance(node.get("routes"), list):
            yield node["routes"]
        for value in node.values():
            yield from route_lists(value)
    elif isinstance(node, list):
        for value in node:
            yield from route_lists(value)


def handlers(route):
    """(handler chain, reverse_proxy upstreams, reverse_proxy header ops) of a route."""
    chain, dials, header_ops = [], [], []

    def walk(node):
        if isinstance(node, dict):
            if "handler" in node:
                chain.append(node["handler"])
            if node.get("handler") == "reverse_proxy":
                dials.extend(u.get("dial") for u in node.get("upstreams") or [])
                header_ops.append(node.get("headers") or {})
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(route.get("handle"))
    return chain, dials, header_ops


def upstreams(route):
    return handlers(route)[1]


def body_difference(stub, api):
    names = ("handlers", "upstream", "header_up")
    parts = ["%s %s vs %s" % (name, json.dumps(mine), json.dumps(theirs))
             for name, mine, theirs in zip(names, handlers(stub), handlers(api)) if mine != theirs]
    if stub.get("group") != api.get("group"):
        parts.append("handle group %r vs %r" % (stub.get("group"), api.get("group")))
    return "; ".join(parts) or "other route keys"


def verdict(label, doc):
    problems = []
    tables = [routes for routes in route_lists(doc) if any(path_only(r) == API for r in routes)]
    if len(tables) != 1:
        return ["%s: expected one site handle table holding %s, found %d" % (label, API, len(tables))], None
    routes = tables[0]
    api = next(r for r in routes if path_only(r) == API)
    siblings = [r for r in routes if mentions(r, STUB)]
    anywhere = [r for table in route_lists(doc) for r in table if mentions(r, STUB)]
    if not siblings:
        if anywhere:
            problems.append(
                "%s: %s is nested, not a sibling of %s in the site handle table — the SPA "
                "handle's try_files/file_server run around it" % (label, STUB, API))
        else:
            problems.append(
                "%s: %s is missing — the SPA catch-all answers the upload PUT 405 "
                "(upload 405 → complete 404 → send 409, #2609)" % (label, STUB))
    elif len(siblings) != 1:
        problems.append("%s: %d routes mention %s (want exactly 1)" % (label, len(siblings), STUB))
    else:
        stub = siblings[0]
        if path_only(stub) != STUB:
            problems.append(
                "%s: %s matcher is not path-only: %s — a method/host restriction drops the "
                "desktop preflight (OPTIONS) onto the SPA handle" % (label, STUB, json.dumps(stub.get("match"))))
        if body(stub) != body(api):
            problems.append(
                "%s: %s route body differs from %s — %s (required: same upstream, same header_up, no rewrite)"
                % (label, STUB, API, body_difference(stub, api)))
    api_paths = sorted(path_only(r) for r in routes if path_only(r) and body(r) == body(api))
    return problems, {"api_paths": api_paths, "upstream": upstreams(api)}


problems = []
views = []
for raw in open(sys.argv[1], encoding="utf-8"):
    label, path = raw.rstrip("\n").split("\t", 1)
    found, view = verdict(label, json.load(open(path, encoding="utf-8")))
    problems.extend(found)
    if view is not None:
        views.append((label, view))
        if not found:
            print("[edge-parity] %s: %s → %s, sibling of %s, path-only, same route body; api paths %s"
                  % (label, STUB, ",".join(view["upstream"]), API, " ".join(view["api_paths"])))
if views:
    reference_label, reference = views[0]
    for label, view in views[1:]:
        if view["api_paths"] != reference["api_paths"]:
            problems.append(
                "parity: %s routes %s like %s, %s routes %s" % (
                    label, view["api_paths"], API, reference_label, reference["api_paths"]))
for problem in problems:
    print("[edge-parity] RED %s" % problem)
if problems:
    raise SystemExit(1)
print("[edge-parity] %d edges route the same api paths: %s" % (len(views), " ".join(views[0][1]["api_paths"])))
PY

python3 "$EDGE_DIR/edge_parity.py" "$EDGE_MANIFEST" || \
  fail "local-archive upload route parity RED on the committed edges (see [edge-parity] lines)"
pass "every tracked edge Caddyfile (${edge_count}) routes /__momo_stub/* like /v1/*: sibling, path-only, same upstream and header_up; same api path set on every edge"

cat >"$EDGE_DIR/sabotage.py" <<'PY'
"""Write one sabotaged copy of an edge file: argv = mode src dst."""
import re
import sys
from pathlib import Path

mode, src, dst = sys.argv[1:4]
text = Path(src).read_text(encoding="utf-8")
block_re = re.compile(r"^\thandle /__momo_stub/\* \{\n(?:\t\t.*\n)*?\t\}\n", re.M)
blocks = block_re.findall(text)
if len(blocks) != 1:
    raise SystemExit("sabotage anchor: %s holds %d top-level /__momo_stub/* blocks (want 1)" % (src, len(blocks)))
block = blocks[0]
opener = "\thandle /__momo_stub/* {\n"
if mode == "removed":
    out = block_re.sub("", text)
elif mode == "nested":
    spa = "\thandle {\n\t\troot * /srv/web\n"
    if text.count(spa) != 1:
        raise SystemExit("sabotage anchor: SPA handle not found in %s" % src)
    moved = "".join("\t" + line for line in block.splitlines(True))
    out = block_re.sub("", text).replace(spa, spa + moved, 1)
elif mode == "method-put":
    out = text.replace(opener, "\t@momo_stub_put {\n\t\tpath /__momo_stub/*\n\t\tmethod PUT\n\t}\n"
                       "\thandle @momo_stub_put {\n", 1)
elif mode == "strip-prefix":
    out = text.replace(opener, opener + "\t\turi strip_prefix /__momo_stub\n", 1)
elif mode == "wrong-upstream":
    moved = re.sub(r"reverse_proxy \S+", "reverse_proxy centrifugo:8000", block, count=1)
    out = text.replace(block, moved, 1)
elif mode == "no-header_up":
    moved = re.sub(r"^\t\t\theader_up .*\n", "", block, flags=re.M)
    if moved == block:
        raise SystemExit("sabotage anchor: no header_up lines in the %s block" % src)
    out = text.replace(block, moved, 1)
else:
    raise SystemExit("unknown sabotage mode %s" % mode)
if out == text:
    raise SystemExit("sabotage %s changed nothing in %s" % (mode, src))
Path(dst).write_text(out, encoding="utf-8")
PY

edge_sabotage() {
  # usage: edge_sabotage <edge file> <mode> <phrase the RED must name> [<second phrase>]
  local target="$1" mode="$2" want="$3" want2="${4:-}" tag variant out ec
  tag="$(printf '%s-%s' "$target" "$mode" | tr '/.' '__')"
  variant="$EDGE_DIR/${tag}.Caddyfile"
  python3 "$EDGE_DIR/sabotage.py" "$mode" "$ROOT/$target" "$variant" || \
    fail "sabotage ${mode} on ${target}: could not build the scratch copy"
  edge_adapt "$variant" "$EDGE_DIR/${tag}.json" || {
    cat "$EDGE_DIR/${tag}.json.err" >&2
    fail "sabotage ${mode} on ${target}: caddy adapt of the scratch copy failed"
  }
  awk -F'\t' -v target="$target" -v json="$EDGE_DIR/${tag}.json" \
    'BEGIN { OFS = "\t" } $1 == target { $2 = json } { print }' \
    "$EDGE_MANIFEST" >"$EDGE_DIR/${tag}.tsv"
  set +e
  out="$(python3 "$EDGE_DIR/edge_parity.py" "$EDGE_DIR/${tag}.tsv" 2>&1)"
  ec=$?
  set -e
  [ "$ec" -ne 0 ] || fail "sabotage ${mode} on ${target} still PASSED — the parity check is not load-bearing"
  for phrase in "$want" ${want2:+"$want2"}; do
    printf '%s\n' "$out" | grep -F "RED" | grep -Fq "$phrase" || {
      printf '%s\n' "$out" >&2
      fail "sabotage ${mode} on ${target} went RED without naming '${phrase}'"
    }
  done
  printf '[test-public-edge] sabotage %-14s %-33s → %s\n' "$mode" "$target" \
    "$(printf '%s\n' "$out" | grep -F "RED" | grep -F "$want" | head -1 | sed 's/^\[edge-parity\] //')"
}

sabotage_count=0
while IFS="$(printf '\t')" read -r edge_file _json; do
  # Removing the block must fail both the per-edge check and the cross-edge set.
  edge_sabotage "$edge_file" removed "is missing" "parity:"
  sabotage_count=$((sabotage_count + 1))
  if grep -Eq "$(printf '^\t\t\theader_up ')" "$ROOT/$edge_file"; then
    edge_sabotage "$edge_file" no-header_up "route body differs"
    sabotage_count=$((sabotage_count + 1))
  fi
done <"$EDGE_MANIFEST"
edge_sabotage infra/rust/Caddyfile nested "is nested"
edge_sabotage infra/rust/Caddyfile method-put "not path-only"
edge_sabotage infra/rust/Caddyfile strip-prefix "route body differs"
edge_sabotage infra/rust/Caddyfile wrong-upstream "route body differs"
sabotage_count=$((sabotage_count + 4))
pass "sabotage (${sabotage_count} scratch copies): block removed on each edge, header_up dropped, nested in the SPA handle, PUT-only matcher, strip_prefix, wrong upstream → RED; committed edges untouched"

printf '[test-public-edge] PASS complete\n'
