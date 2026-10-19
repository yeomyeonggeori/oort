#!/usr/bin/env bash
# #4079 — the oort routes against the REAL login relay sidecar (not a mock of it).
#
# One container from the pinned Hermes image runs the real sidecar (`login_relay.py launch`: uid-separated, key in a
# 0400 file), two mock OAuth MCP servers (`hermes_mock_oauth_mcp.py`) and the real `hermes mcp login` /
# `mcp_login_probe.py`. The sidecar's port is published on 127.0.0.1 only; `cargo test ... the_real_sidecar_...`
# starts the real momo-server routes on an isolated Postgres and drives two app logins through them. The test
# asserts the marker code and the mock tokens are in NO response, api log (TRACE), table dump or audit row, and that
# the sidecar sees the token files the CLI wrote (`connected: true`). Unless LOGIN_RELAY_E2E_NO_VENDOR=1 it also starts
# a real Codex login (ONE call to auth.openai.com for a device code; nothing is approved) and a real Claude login URL,
# cancels both, and checks the device code / vendor URLs are on the screen only (not in api log, DB, audit, sidecar log).
#
# Needs: Docker, cargo, an isolated Postgres (superuser URL) — the same variables as the *_conformance_pg tests:
#   DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo PGHOST=127.0.0.1 PGPORT=<port> PGUSER=momo \
#   PGPASSWORD=momo PGDATABASE=momo CARGO_TARGET_DIR=... bash scripts/tests/test_login_relay_oort_e2e.sh
# Only the container `${P}-e2e` is touched, and it is removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
P="${LOGIN_RELAY_TEST_PROJECT:-momo4079}"
NAME="${P}-e2e"
IMG="$(grep -o 'nousresearch/hermes-agent@sha256:[0-9a-f]*' "$ROOT/infra/rust/docker-compose.rust.yml" | head -1)"
fail() { echo "[login-relay-e2e] FAIL: $*" >&2; exit 1; }
: "${DATABASE_URL:?set DATABASE_URL to an isolated PostgreSQL 18 superuser URL}"
[ -n "$IMG" ] || fail "no pinned Hermes image"
if docker inspect "$NAME" >/dev/null 2>&1; then fail "container $NAME already exists (set LOGIN_RELAY_TEST_PROJECT)"; fi
trap 'docker rm -fv "$NAME" >/dev/null 2>&1 || true' EXIT

KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
docker run -d --name "$NAME" --label "com.docker.compose.project=$P-e2e" --entrypoint /bin/sh \
  -p "127.0.0.1:${PORT}:8643" \
  -v "$ROOT/infra/hermes:/oort:ro" -v "$ROOT/scripts/tests/fixtures:/fx:ro" \
  -e HERMES_LOGIN_RELAY_KEY="$KEY" -e OORT_LOGIN_RELAY_PROBE=/oort/mcp_login_probe.py -e OORT_LOGIN_RELAY_ALLOW_HTTP_LOOPBACK=1 \
  "$IMG" -c '
    set -eu; umask 022; mkdir -p /opt/data; cp /fx/hermes_login_mcp_config.yaml /opt/data/config.yaml; chown -R hermes:hermes /opt/data
    P=/opt/hermes/.venv/bin/python
    setpriv --reuid=10000 --regid=10000 --clear-groups $P /fx/hermes_mock_oauth_mcp.py 9300 4078 &
    setpriv --reuid=10000 --regid=10000 --clear-groups $P /fx/hermes_mock_oauth_mcp.py 9301 4078 --google-like &
    $P -B /oort/login_relay.py launch &
    unset HERMES_LOGIN_RELAY_KEY
    wait' >/dev/null
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null || { docker logs "$NAME" 2>&1 | tail -20 >&2; fail "the real sidecar never answered /healthz"; }

cd "$ROOT/server-rust"
OUT="$(mktemp "${TMPDIR:-/tmp}/login-relay-e2e-secrets.XXXXXX")"
trap 'docker rm -fv "$NAME" >/dev/null 2>&1 || true; rm -f "$OUT"' EXIT
LOGIN_RELAY_E2E_URL="http://127.0.0.1:${PORT}" LOGIN_RELAY_E2E_KEY="$KEY" LOGIN_RELAY_E2E_OUT="$OUT" \
  cargo test -p momo-server --test login_relay_conformance_pg the_real_sidecar_logs_an_app_in_and_no_secret_crosses_oort \
  -- --ignored --nocapture --test-threads=1 2>&1 | tee "${TMPDIR:-/tmp}/login-relay-e2e.out" | grep -E "^(test |E2E_MARKER|test result)|panicked|FAILED" || true
grep -q "^test result: ok. 1 passed" "${TMPDIR:-/tmp}/login-relay-e2e.out" || fail "the e2e test did not pass"
[ -s "$OUT" ] || fail "the test recorded no markers"
# #4081: the relay uid wrote its login times into ITS OWN 0700 directory (Hermes' volume is 0700 hermes: it could not),
# as a file the hermes uid cannot read or replace; the file holds clock readings only.
docker exec "$NAME" sh -c 'stat -c "%A %u" /run/oort-login-relay/issued.json; cat /run/oort-login-relay/issued.json' | tee "${TMPDIR:-/tmp}/login-relay-e2e-issued.txt" >/dev/null
grep -q '^-rw-------' "${TMPDIR:-/tmp}/login-relay-e2e-issued.txt" || fail "the login-time state file is missing or not 0600"
tail -1 "${TMPDIR:-/tmp}/login-relay-e2e-issued.txt" | grep -Eq '^\{("[a-z0-9_-]+": [0-9]{10}(, )?)+\}$' || fail "the login-time state file holds more than names and clock readings"
if docker exec "$NAME" grep -rlF -- "issued.json" /opt/data >/dev/null 2>&1; then fail "a login-time file leaked into Hermes' volume"; fi
rm -f "${TMPDIR:-/tmp}/login-relay-e2e-issued.txt"
docker logs "$NAME" >"${TMPDIR:-/tmp}/login-relay-e2e-sidecar.log" 2>&1
# The marker code, the Codex device code and the vendor URLs: none of them in the sidecar's stderr (its log).
while IFS= read -r secret; do
  [ -n "$secret" ] || continue
  if grep -F -- "$secret" "${TMPDIR:-/tmp}/login-relay-e2e-sidecar.log" >/dev/null; then fail "a screen-only or one-time value is in the sidecar's stderr"; fi
done <"$OUT"
if grep -E "MOCK-ACCESS-TOKEN|MOCK-REFRESH-TOKEN" "${TMPDIR:-/tmp}/login-relay-e2e-sidecar.log" | grep -v "^TOKEN " >/dev/null; then fail "a mock token is in the sidecar's stderr"; fi
echo "[login-relay-e2e] ok: $(grep -c . "$OUT") one-time/screen-only values, 0 hits in the sidecar log"
docker exec "$NAME" grep -rlF -- "MOCK-ACCESS-TOKEN" /opt/data | sed 's#^#[tokens on the Hermes volume] #'
rm -f "${TMPDIR:-/tmp}/login-relay-e2e.out" "${TMPDIR:-/tmp}/login-relay-e2e-sidecar.log"
echo "[login-relay-e2e] ALL PASS"
