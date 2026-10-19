#!/usr/bin/env bash
# Isolated Docker measurement for the Hermes login relay sidecar (L-S1, #4078; ADR-0203 증보 2026-10-19).
# NOT part of the default gates: it needs Docker, the pinned Hermes image and reaches auth.openai.com once
# (Codex device-code issuance; nothing is approved, nothing is logged in).
#
#   Phase A  compose project `momo4078`, profile `agents`, the REAL start command (lockgate on the default config):
#            uid/capability/env separation, key file 0400, real Codex device code + real Claude URL, cancel kills the group.
#   Phase B  one more container from the same image with a MOCK OAuth MCP server: the real `hermes mcp login` and the
#            real mcp_login_probe.py run to the end. MOCK-ACCESS/REFRESH tokens and the marker code must appear in
#            /opt/data and NOWHERE else (relay HTTP bodies, relay stderr = container logs).
#
# Only resources named after the project prefix are touched, and they are removed on exit (down -v / rm -fv).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
P="${LOGIN_RELAY_TEST_PROJECT:-momo4078}"
COMPOSE_FILE="$ROOT/infra/rust/docker-compose.rust.yml"
IMG="$(grep -o 'nousresearch/hermes-agent@sha256:[0-9a-f]*' "$COMPOSE_FILE" | head -1)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/login-relay-docker.XXXXXX")"
MCP_NAME="${P}-mcp"
fail() { echo "[login-relay-docker] FAIL: $*" >&2; exit 1; }
say() { echo "[login-relay-docker] $*"; }

[ -n "$IMG" ] || fail "no pinned Hermes image in $COMPOSE_FILE"
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$P")" ] || docker inspect "$MCP_NAME" >/dev/null 2>&1; then
  fail "project/container prefix '$P' is already in use (set LOGIN_RELAY_TEST_PROJECT to an unused name)"
fi

COMPOSE=(docker compose -p "$P" --env-file "$TMP/env" -f "$COMPOSE_FILE" --profile agents)
cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -fv "$MCP_NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---- Phase A: the compose service -------------------------------------------------------------------------------
(cd "$ROOT" && SELF_HOST_ENV_FILE="$TMP/env" bash scripts/self_host_env.sh --local-build --with-agents >/dev/null 2>&1) \
  || fail "generator (--with-agents) failed"
RELAY_KEY="$(sed -n 's/^HERMES_LOGIN_RELAY_KEY=//p' "$TMP/env")"
[ "${#RELAY_KEY}" -ge 32 ] || fail "the generator wrote no HERMES_LOGIN_RELAY_KEY"
say "phase A: compose up hermes (project $P)"
"${COMPOSE[@]}" up -d hermes >"$TMP/up.log" 2>&1 || { cat "$TMP/up.log" >&2; fail "compose up hermes failed"; }
HC="$("${COMPOSE[@]}" ps -q hermes)"
for _ in $(seq 1 90); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$HC" 2>/dev/null)" = "healthy" ] && break
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$HC")" = "healthy" ] || { docker logs "$HC" 2>&1 | tail -20 >&2; fail "hermes never became healthy"; }
for _ in $(seq 1 30); do
  docker exec "$HC" /opt/hermes/.venv/bin/python -c 'import urllib.request;urllib.request.urlopen("http://127.0.0.1:8643/healthz",timeout=2)' 2>/dev/null && break
  sleep 1
done
docker exec "$HC" /opt/hermes/.venv/bin/python -c 'import urllib.request;urllib.request.urlopen("http://127.0.0.1:8643/healthz",timeout=2)' \
  || { docker logs "$HC" 2>&1 | tail -20 >&2; fail "the relay never answered /healthz"; }
docker cp "$ROOT/scripts/tests/fixtures/hermes_login_relay_flow.py" "$HC:/tmp/flow.py"

# the hermes uid must not reach the key, in a file or in the relay's environ
if docker exec -u hermes "$HC" cat /run/oort-login-relay/key >/dev/null 2>&1; then fail "the hermes uid can read the key file"; fi
if docker exec -u hermes "$HC" ls /run/oort-login-relay >/dev/null 2>&1; then fail "the hermes uid can list the key directory"; fi
RELAY_PID="$(docker exec "$HC" /opt/hermes/.venv/bin/python -c '
import os
for d in os.listdir("/proc"):
    if d.isdigit() and b"login_relay.py\0serve" in open("/proc/%s/cmdline" % d, "rb").read():
        print(d); break')"
[ -n "$RELAY_PID" ] || fail "no relay process"
if docker exec -u hermes "$HC" cat "/proc/$RELAY_PID/environ" >/dev/null 2>&1; then fail "the hermes uid can read the relay's /proc/<pid>/environ"; fi
if docker exec -u hermes "$HC" kill -0 "$RELAY_PID" >/dev/null 2>&1; then fail "the hermes uid can signal the relay process"; fi
if docker exec -u hermes "$HC" sh -c "cat /proc/$RELAY_PID/mem >/dev/null 2>&1 || cat /proc/$RELAY_PID/maps >/dev/null 2>&1"; then fail "the hermes uid can read the relay's memory map"; fi
say "ok: the hermes uid can read neither the key file, nor the relay's environ/maps, nor signal it"

# --privileged only for this measuring process: root without CAP_SYS_PTRACE cannot read another uid's /proc/<pid>/environ
docker exec -i --privileged -u root -e RELAY_KEY="$RELAY_KEY" "$HC" /opt/hermes/.venv/bin/python /tmp/flow.py A | tee "$TMP/phase-a.out" || fail "phase A had failures"
docker logs "$HC" >"$TMP/hermes-a.log" 2>&1
docker cp "$HC:/tmp/relay-bodies.log" "$TMP/a-bodies.log"
# the device code is in exactly one HTTP body (the start response) and in no log
DEVICE_CODE="$(python3 - "$TMP/a-bodies.log" <<'PY'
import json, sys
codes = [json.loads(l).get("user_code") for l in open(sys.argv[1]) if l.strip().startswith("{")]
codes = [c for c in codes if c]
print(codes[0] if len(codes) == 1 else "")
PY
)"
[ -n "$DEVICE_CODE" ] || fail "expected exactly one device code in the relay HTTP bodies (the start response)"
[ "$(grep -cF "$DEVICE_CODE" "$TMP/a-bodies.log")" = "1" ] || fail "the device code appears in more than one relay HTTP body"
if grep -F "$DEVICE_CODE" "$TMP/hermes-a.log" >/dev/null; then fail "the device code is in the container log"; fi
if grep -E "oauth/authorize|codex/device|auth\.openai\.com|claude\.ai" "$TMP/hermes-a.log" >/dev/null; then
  fail "the relay/container log carries an authorization URL"
fi
if grep -F "$RELAY_KEY" "$TMP/hermes-a.log" >/dev/null; then fail "the relay key is in the container log"; fi
say "ok: container log (relay stderr included) has no URL, no device code, no key; the device code is in exactly one HTTP body"
{ grep -E "relay on|listening|start login=|state login=" "$TMP/hermes-a.log" || true; } | sed 's/^/[relay log] /' | head -8

# ---- Phase B: mock MCP, real CLIs to the end ---------------------------------------------------------------------
say "phase B: mock OAuth MCP + the real CLIs (container $MCP_NAME)"
MCP_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$MCP_NAME" --label "com.docker.compose.project=$P-mock" --entrypoint /bin/sh \
  -v "$ROOT/infra/hermes:/oort:ro" -v "$ROOT/scripts/tests/fixtures:/fx:ro" \
  -e HERMES_LOGIN_RELAY_KEY="$MCP_KEY" -e OORT_LOGIN_RELAY_PROBE=/oort/mcp_login_probe.py -e OORT_LOGIN_RELAY_ALLOW_HTTP_LOOPBACK=1 \
  "$IMG" -c '
    set -eu; umask 022; mkdir -p /opt/data; cp /fx/hermes_login_mcp_config.yaml /opt/data/config.yaml; chown -R hermes:hermes /opt/data
    P=/opt/hermes/.venv/bin/python
    setpriv --reuid=10000 --regid=10000 --clear-groups $P /fx/hermes_mock_oauth_mcp.py 9300 4078 &
    setpriv --reuid=10000 --regid=10000 --clear-groups $P /fx/hermes_mock_oauth_mcp.py 9301 4078 --google-like &
    $P -B /oort/login_relay.py launch &
    unset HERMES_LOGIN_RELAY_KEY
    wait' >/dev/null
for _ in $(seq 1 30); do
  docker exec "$MCP_NAME" /opt/hermes/.venv/bin/python -c 'import urllib.request;urllib.request.urlopen("http://127.0.0.1:8643/healthz",timeout=2)' 2>/dev/null && break
  sleep 1
done
docker cp "$ROOT/scripts/tests/fixtures/hermes_login_relay_flow.py" "$MCP_NAME:/tmp/flow.py"
docker exec -i --privileged -u root -e RELAY_KEY="$MCP_KEY" "$MCP_NAME" /opt/hermes/.venv/bin/python /tmp/flow.py B | tee "$TMP/phase-b.out" || { docker logs "$MCP_NAME" 2>&1 | tail -20 >&2; fail "phase B had failures"; }
MARKER_CODE="$(sed -n 's/^MARKER_CODE=//p' "$TMP/phase-b.out")"
[ -n "$MARKER_CODE" ] || fail "no marker code from phase B"

docker logs "$MCP_NAME" >"$TMP/mcp.log" 2>&1
docker cp "$MCP_NAME:/tmp/relay-bodies.log" "$TMP/mcp-bodies.log"
docker cp "$HC:/tmp/relay-bodies.log" "$TMP/a-bodies.log"
leak=0
for f in "$TMP/mcp.log" "$TMP/mcp-bodies.log" "$TMP/a-bodies.log" "$TMP/hermes-a.log"; do
  for m in "$MARKER_CODE" "MOCK-ACCESS-TOKEN" "MOCK-REFRESH-TOKEN"; do
    if grep -F -- "$m" "$f" >/dev/null; then echo "LEAK: $m in $(basename "$f")" >&2; leak=1; fi
  done
done
[ "$leak" -eq 0 ] || fail "a marker crossed the relay (HTTP bodies or relay stderr)"
say "ok: marker code + MOCK-ACCESS/REFRESH tokens: 0 hits in relay HTTP bodies and relay stderr"
grep -F "TOKEN grant=authorization_code has_verifier=True code_is_marker=True" "$TMP/mcp.log" >/dev/null \
  || fail "the mock never saw the exchange with PKCE verifier and the relayed marker code (the flow did not really run)"
say "ok: positive control — the CLI exchanged the relayed code with PKCE verifier, tokens are on /opt/data"
docker exec "$MCP_NAME" sh -c 'grep -rlF -- "MOCK-ACCESS-TOKEN" /opt/data 2>/dev/null | sed "s#^#[tokens on volume] #"'
hits="$(docker exec "$MCP_NAME" sh -c "grep -rlF -- '$MARKER_CODE' /opt/data/logs 2>/dev/null | wc -l" | tr -d ' ')"
say "info: Hermes' own log files under /opt/data/logs containing the marker code: $hits"
say "ALL PASS"
