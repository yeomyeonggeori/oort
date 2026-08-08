#!/usr/bin/env bash
# =============================================================================
# scripts/verify_cors_allowlist.sh — MOMO-605 / ADR-0133 P2
#   Server CORS origin allowlist for the Tauri desktop webview.
#
# Two layers, BOTH of which always run (no Docker required):
#   1. Static contract gate: the env key spelled identically in both env
#      templates and both compose files, the Centrifugo e2e/internal-alpha
#      allowance carrying the same desktop origins, no wildcard committed
#      anywhere, schema_v0 untouched, swift build + focused unit tests, AND the
#      Rust momo-server's own mount + socket-level tests (DESK-1 — that binary
#      is what prod runs, and it shipped without CORS for a whole batch while
#      this gate was green).
#   2. LIVE PREFLIGHT ROUNDTRIP against a real MomoServer process. The binary is
#      booted three times on an isolated port with a dead-end DATABASE_URL — the
#      whole CORS decision happens in middleware ahead of any DB access, and
#      /health never touches Postgres, so this needs no database and no
#      container. The three boots prove the three states that matter:
#        A. knob UNSET  -> not a single Access-Control-*/Vary header exists,
#           i.e. the default deployment is byte-identical to the pre-MOMO-605
#           server (this is the acceptance criterion that actually protects
#           every other gate).
#        B. knob SET    -> OPTIONS preflight answers 204 with an exact-echo
#           Access-Control-Allow-Origin, the documented methods/headers, Vary:
#           Origin, NO Access-Control-Allow-Credentials and NO `*`; a
#           non-allowlisted origin gets nothing; a request with no Origin (every
#           native momo client) gets nothing; and an error response still
#           carries the header so the browser can read the real status.
#        C. knob = `*`  -> wildcard is refused at boot (warning logged) and the
#           surface stays completely closed. Fail-closed, not fail-open.
#
# Ports live in the reserved 28300 block. schema_v0.sql is never modified and
# this ticket introduces no migration.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[cors-allowlist] $*"; }
fail() { log "FAIL $*"; exit 1; }

# ---- Isolated port block (28300s). Reserve so a concurrent gate cannot race. --
API_PORT="${CORS_GATE_API_PORT:-28300}"
METRICS_PORT="${CORS_GATE_METRICS_PORT:-28301}"
# Deliberately closed port: the API must boot and serve middleware + /health
# without a database. Nothing in this gate reads or writes Postgres.
DEAD_PG_PORT="${CORS_GATE_DEAD_PG_PORT:-28302}"

command -v python3 >/dev/null 2>&1 || fail "missing python3"
command -v curl >/dev/null 2>&1 || fail "missing curl"

python3 - "$API_PORT" "$METRICS_PORT" "$DEAD_PG_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[cors-allowlist] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[cors-allowlist] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY
log "reserved isolated ports ${API_PORT}/${METRICS_PORT}/${DEAD_PG_PORT}"

# =============================================================================
# Layer 1 — static contract
# =============================================================================
CONFIG="server/Sources/MomoServer/Config.swift"
MIDDLEWARE="server/Sources/MomoServer/Middleware/CORSMiddleware.swift"
APP="server/Sources/MomoServer/App.swift"
TESTS="server/Tests/MomoServerTests/CORSAllowlistTests.swift"
DEV_ENV="infra/.env.example"
PROD_ENV="infra/prod/.env.example"
E2E_COMPOSE="infra/docker-compose.e2e.yml"
PROD_COMPOSE="infra/prod/docker-compose.prod.yml"
CENTRIFUGO="infra/centrifugo.json"

for file in "$CONFIG" "$MIDDLEWARE" "$APP" "$TESTS" "$DEV_ENV" "$PROD_ENV" \
  "$E2E_COMPOSE" "$PROD_COMPOSE" "$CENTRIFUGO"; do
  test -f "$file" || fail "missing $file"
done

ENV_KEY="MOMO_CORS_ALLOWED_ORIGINS"
grep -q "\"$ENV_KEY\"" "$CONFIG" || fail "$CONFIG lost the $ENV_KEY contract"
grep -q "OriginAllowlistCORSMiddleware" "$APP" || fail "$APP does not mount the CORS middleware"
grep -q "config.cors.isEnabled" "$APP" || fail "$APP must mount CORS only when the allowlist is non-empty"

# Both env templates must document the SAME key — a template that silently
# lacks it is how an operator ends up with a desktop client that cannot log in.
for template in "$DEV_ENV" "$PROD_ENV"; do
  grep -q "$ENV_KEY" "$template" || fail "$template does not document $ENV_KEY"
  # Templates ship the knob commented out: uncommenting it by default would
  # change behaviour for every existing deploy.
  if grep -Eq "^[[:space:]]*$ENV_KEY=" "$template"; then
    fail "$template must keep $ENV_KEY commented out (empty default = no behaviour change)"
  fi
done
log "PASS templates: both env templates document $ENV_KEY and keep it commented out"

# Both compose files must hand the value to the api service, defaulting empty.
for compose in "$E2E_COMPOSE" "$PROD_COMPOSE"; do
  grep -q "$ENV_KEY: \${$ENV_KEY:-}" "$compose" \
    || fail "$compose does not pass $ENV_KEY to the api service with an empty default"
done
log "PASS compose: e2e + prod api services pass $ENV_KEY through with an empty default"

# Centrifugo (e2e + internal alpha both run infra/docker-compose.e2e.yml with
# this config) must accept the same desktop origins over wss, otherwise realtime
# 403s while REST succeeds.
python3 - "$CENTRIFUGO" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    config = json.load(handle)
origins = config.get("client", {}).get("allowed_origins", [])
required = ["tauri://localhost", "http://tauri.localhost"]
missing = [origin for origin in required if origin not in origins]
if missing:
    raise SystemExit(f"[cors-allowlist] centrifugo client.allowed_origins missing {missing}")
if any("*" in origin for origin in origins):
    raise SystemExit("[cors-allowlist] centrifugo client.allowed_origins must not contain a wildcard")
PY
log "PASS centrifugo: e2e/internal-alpha allowed_origins carry the desktop origins, no wildcard"

# No wildcard may be committed as a shipped value anywhere in this surface.
if grep -Eq "^[[:space:]]*#?[[:space:]]*$ENV_KEY=.*[*]" "$DEV_ENV" "$PROD_ENV"; then
  fail "an env template ships a wildcard $ENV_KEY value"
fi

if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -qx "schema_v0.sql"; then
  fail "schema_v0.sql must not be modified"
fi
if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -q "^server/Migrations/"; then
  fail "MOMO-605 introduces no migration"
fi
log "PASS invariants: schema_v0 untouched, no migration introduced"

# ---- swift build + focused unit gate ---------------------------------------
command -v swift >/dev/null 2>&1 || fail "missing swift toolchain"
log "swift build (server)"
swift build --package-path server >/dev/null
log "swift test --filter CORSAllowlistTests (server)"
swift test --package-path server --filter CORSAllowlistTests >/dev/null
log "PASS worker gate: static contract + build + CORS unit tests green"

# ---- Rust momo-server: the binary prod actually runs (DESK-1) ---------------
# The Swift layers were the whole gate when this ticket opened, and that was the
# trap: the Axum rewrite (ADR-0145) never ported the CORS middleware, so this
# script kept passing while the DEPLOYED server answered no preflight at all and
# the packaged desktop client could not log in. Whatever else changes, the gate
# must go red when the shipped binary loses this surface.
RUST_CORS="server-rust/bins/momo-server/src/cors.rs"
RUST_CONFIG="server-rust/bins/momo-server/src/config.rs"
RUST_LIB="server-rust/bins/momo-server/src/lib.rs"
RUST_TESTS="server-rust/bins/momo-server/tests/cors_allowlist.rs"

for file in "$RUST_CORS" "$RUST_CONFIG" "$RUST_LIB" "$RUST_TESTS"; do
  test -f "$file" || fail "missing $file (the deployed server would have no CORS)"
done
grep -q "\"$ENV_KEY\"" "$RUST_CONFIG" || fail "$RUST_CONFIG lost the $ENV_KEY contract"
grep -q "cors::allowlist" "$RUST_LIB" || fail "$RUST_LIB does not mount the CORS middleware"
grep -q "cors.is_enabled()" "$RUST_LIB" \
  || fail "$RUST_LIB must mount CORS only when the allowlist is non-empty"
log "PASS rust static: momo-server mounts the allowlist, and only when it is non-empty"

if command -v cargo >/dev/null 2>&1; then
  # The Rust half's live roundtrip: `tests/cors_allowlist.rs` boots the real
  # router on an ephemeral port and drives real preflights over a real socket.
  # No database and no container — the CORS decision is made in middleware ahead
  # of routing, and the deliberate 503 from the DB-less health route doubles as
  # the "an error response still carries the header" assertion.
  log "cargo test -p momo-server --test cors_allowlist (server-rust)"
  ( cd "$REPO_ROOT/server-rust" && cargo test -p momo-server --test cors_allowlist >/dev/null ) \
    || fail "rust CORS allowlist tests failed"
  log "PASS rust live: preflight/echo, hostile denial and fail-closed proved over a socket"
else
  log "SKIP rust live: no cargo toolchain on PATH (the static contract above still holds)"
fi

# =============================================================================
# Layer 2 — live preflight roundtrip against a booted MomoServer
# =============================================================================
BIN_PATH="$(swift build --package-path server --show-bin-path 2>/dev/null | tail -n 1)"
SERVER_BIN="$BIN_PATH/MomoServer"
test -x "$SERVER_BIN" || fail "missing built server binary at $SERVER_BIN"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-cors-allowlist.XXXXXX")"
SERVER_PID=""
BASE_URL="http://127.0.0.1:$API_PORT"

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_server
  case "$TMP_DIR" in
    "${TMPDIR:-/tmp}"/momo-cors-allowlist.*) rm -r -- "$TMP_DIR" 2>/dev/null || true ;;
    *) log "refusing unexpected temp path: $TMP_DIR" ;;
  esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

SERVER_LOG=""
start_server() {
  # $1 = MOMO_CORS_ALLOWED_ORIGINS value (may be empty), $2 = log label.
  stop_server
  SERVER_LOG="$TMP_DIR/server-$2.log"
  # MOMO_ENV=local keeps the strict-env boot guard off; the DATABASE_URL points
  # at a closed port on purpose so no real database is contacted.
  env MOMO_ENV=local HOST=127.0.0.1 PORT="$API_PORT" \
    MOMO_METRICS_HOST=127.0.0.1 MOMO_METRICS_PORT="$METRICS_PORT" \
    DATABASE_URL="postgres://momo:momo@127.0.0.1:$DEAD_PG_PORT/momo" \
    MOMO_CORS_ALLOWED_ORIGINS="$1" \
    "$SERVER_BIN" >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    if curl -fsS -m 2 "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      cat "$SERVER_LOG" >&2 || true
      fail "server exited before becoming healthy ($2)"
    fi
    sleep 0.5
  done
  cat "$SERVER_LOG" >&2 || true
  fail "server health timeout ($2)"
}

# Capture one response's status line + headers into $TMP_DIR/headers.
RESPONSE_STATUS=""
probe() {
  # probe METHOD PATH [curl args...]
  local method="$1" path="$2"
  shift 2
  RESPONSE_STATUS="$(curl -sS -o /dev/null -D "$TMP_DIR/headers" -w '%{http_code}' \
    -m 10 -X "$method" "$@" "$BASE_URL$path")"
}

header_value() {
  # Case-insensitive header lookup (HTTP field names are case-insensitive and
  # HTTP/2 lowercases them). Folded through tolower() rather than gawk's
  # IGNORECASE so this works on the BSD awk shipped with macOS too.
  awk -v name="$1" '
    BEGIN { needle = tolower(name) ":" }
    {
      line = $0
      sub(/\r$/, "", line)
      split_at = index(tolower(line), needle)
      if (split_at == 1) {
        value = substr(line, length(needle) + 1)
        sub(/^[[:space:]]+/, "", value)
        print value
      }
    }
  ' "$TMP_DIR/headers"
}

assert_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    cat "$TMP_DIR/headers" >&2
    fail "$2: expected HTTP $1, got $RESPONSE_STATUS"
  }
}

assert_header_equals() {
  local actual
  actual="$(header_value "$1")"
  [ "$actual" = "$2" ] || {
    cat "$TMP_DIR/headers" >&2
    fail "$3: expected '$1: $2', got '$actual'"
  }
}

assert_header_contains() {
  header_value "$1" | grep -qi -- "$2" || {
    cat "$TMP_DIR/headers" >&2
    fail "$3: header '$1' does not contain '$2'"
  }
}

assert_header_absent() {
  local actual
  actual="$(header_value "$1")"
  [ -z "$actual" ] || {
    cat "$TMP_DIR/headers" >&2
    fail "$2: header '$1' must be absent, got '$actual'"
  }
}

assert_no_cors_headers() {
  if grep -Eqi '^(access-control-|vary:)' "$TMP_DIR/headers"; then
    cat "$TMP_DIR/headers" >&2
    fail "$1: response carries CORS/Vary headers but the allowlist is closed"
  fi
}

ALLOWED_ORIGIN="tauri://localhost"
DEV_ORIGIN="http://localhost:5173"
HOSTILE_ORIGIN="https://evil.example.com"

# ---- A. knob unset -> byte-identical to the pre-MOMO-605 server -------------
start_server "" "unset"
probe GET /health -H "Origin: $ALLOWED_ORIGIN"
assert_status 200 "unset/health"
assert_no_cors_headers "unset/health with Origin"

probe OPTIONS /v1/auth/login -H "Origin: $ALLOWED_ORIGIN" \
  -H 'Access-Control-Request-Method: POST'
assert_no_cors_headers "unset/preflight"
[ "$RESPONSE_STATUS" != "204" ] \
  || fail "unset/preflight: OPTIONS must NOT be short-circuited when the allowlist is empty"

probe GET /health
assert_status 200 "unset/health without Origin"
assert_no_cors_headers "unset/health without Origin"
log "PASS default: with $ENV_KEY unset no Access-Control-*/Vary header exists and OPTIONS is untouched"

# ---- B. knob set -> real preflight roundtrip --------------------------------
start_server "$ALLOWED_ORIGIN,$DEV_ORIGIN" "allowlist"

probe OPTIONS /v1/auth/login -H "Origin: $ALLOWED_ORIGIN" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
assert_status 204 "preflight"
assert_header_equals "Access-Control-Allow-Origin" "$ALLOWED_ORIGIN" "preflight"
assert_header_contains "Access-Control-Allow-Methods" "POST" "preflight"
assert_header_contains "Access-Control-Allow-Headers" "authorization" "preflight"
assert_header_contains "Access-Control-Allow-Headers" "content-type" "preflight"
assert_header_contains "Vary" "Origin" "preflight"
# Credentials must stay off: momo issues no cookies and rides an Authorization
# bearer, so the browser must never be told to attach ambient credentials.
assert_header_absent "Access-Control-Allow-Credentials" "preflight"
if header_value "Access-Control-Allow-Origin" | grep -q '[*]'; then
  fail "preflight: Access-Control-Allow-Origin must never be a wildcard"
fi
log "PASS preflight: OPTIONS /v1/auth/login -> 204, exact-echo origin, no credentials, no wildcard"

probe OPTIONS /v1/auth/login -H "Origin: $HOSTILE_ORIGIN" \
  -H 'Access-Control-Request-Method: POST'
assert_no_cors_headers "preflight/hostile origin"
log "PASS allowlist: a non-allowlisted origin receives no CORS header (browser blocks it)"

probe GET /health -H "Origin: $DEV_ORIGIN"
assert_status 200 "actual request"
assert_header_equals "Access-Control-Allow-Origin" "$DEV_ORIGIN" "actual request"
assert_header_contains "Vary" "Origin" "actual request"
assert_header_absent "Access-Control-Allow-Credentials" "actual request"

probe GET /health
assert_status 200 "actual request without Origin"
assert_no_cors_headers "actual request without Origin"
log "PASS roundtrip: allowlisted origin echoed with Vary; native clients (no Origin) unchanged"

# Error responses must carry the header too, otherwise a browser reports an
# opaque network failure instead of the real status the API returned.
probe GET /v1/does-not-exist -H "Origin: $ALLOWED_ORIGIN"
assert_header_equals "Access-Control-Allow-Origin" "$ALLOWED_ORIGIN" "error response"
log "PASS errors: non-2xx responses keep Access-Control-Allow-Origin (status is readable)"

# ---- C. wildcard is refused, fail-closed ------------------------------------
start_server "*" "wildcard"
probe GET /health -H "Origin: $HOSTILE_ORIGIN"
assert_status 200 "wildcard/health"
assert_no_cors_headers "wildcard/health"
probe OPTIONS /v1/auth/login -H "Origin: $HOSTILE_ORIGIN" \
  -H 'Access-Control-Request-Method: POST'
assert_no_cors_headers "wildcard/preflight"
grep -q "ignoring invalid entries" "$SERVER_LOG" \
  || fail "wildcard: the server must warn that the entry was refused"
log "PASS wildcard: '*' is refused at boot with a warning and the surface stays closed"

stop_server
log "PASS live preflight roundtrip on port ${API_PORT}: default no-op, allowlisted preflight/echo, hostile denial, wildcard fail-closed"
