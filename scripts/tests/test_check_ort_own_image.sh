#!/usr/bin/env bash
# Proofs for scripts/check_ort_own_image.sh (#6012). No external network: a stub registry on a
# loopback port serves one digest; RED cases are the registry no longer having it, and a tag pin.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check_ort_own_image.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-ort-own-image-test.XXXXXX")"
STUB_PID=""
cleanup() {
  [ -z "$STUB_PID" ] || kill "$STUB_PID" 2>/dev/null || true
  rm -r "$SANDBOX"
}
trap cleanup EXIT INT TERM

CASES=0
fail() { echo "[ort-own-image-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[ort-own-image-test] ok: $*"; }

GOOD="sha256:$(printf 'a%.0s' $(seq 64))"
GONE="sha256:$(printf 'b%.0s' $(seq 64))"

cat >"$SANDBOX/stub.py" <<'PY'
import http.server, json, sys
SERVED = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _go(self, body):
        if self.path.startswith("/token?"):
            data = json.dumps({"token": "t"}).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers()
            if body: self.wfile.write(data)
        elif self.path.endswith("/manifests/" + SERVED) and self.headers.get("Authorization") == "Bearer t":
            self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers()
        else:
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
    def do_GET(self): self._go(True)
    def do_HEAD(self): self._go(False)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
python3 -I "$SANDBOX/stub.py" "$GOOD" >"$SANDBOX/port" &
STUB_PID=$!
for _ in $(seq 50); do [ -s "$SANDBOX/port" ] && break; sleep 0.1; done
PORT="$(cat "$SANDBOX/port")"
[ -n "$PORT" ] || fail "stub registry did not start"
REG="http://127.0.0.1:$PORT"

df_with() { printf 'ARG ORT_OWN_IMAGE=%s\n' "$1" >"$SANDBOX/Dockerfile"; echo "$SANDBOX/Dockerfile"; }

# 1. the pinned digest is served -> exit 0
bash "$CHECK" --dockerfile "$(df_with "ghcr.io/example/oort@$GOOD")" --registry "$REG" >/dev/null \
  || fail "a readable digest must pass"
pass "digest readable on the registry -> 0"

# 2. RED: the registry no longer has the pinned digest (deleted) -> nonzero
if bash "$CHECK" --dockerfile "$(df_with "ghcr.io/example/oort@$GONE")" --registry "$REG" >/dev/null 2>&1; then
  fail "a deleted digest must fail"
fi
pass "digest gone from the registry -> nonzero"

# 3. RED: pinned by tag instead of digest -> nonzero before any network call
if bash "$CHECK" --dockerfile "$(df_with "ghcr.io/example/oort:v0.1.46")" --registry "$REG" >/dev/null 2>&1; then
  fail "a tag pin must fail"
fi
pass "tag pin -> nonzero"

# 4. the real Dockerfile's pin parses as a digest, and the build default stays a declared source
ref="$(bash "$CHECK" --parse-only)"
printf '%s\n' "$ref" | grep -Eq '@sha256:[0-9a-f]{64}$' || fail "real Dockerfile pin is not a digest: $ref"
grep -Eq '^ARG ORT_SOURCE=(own-image|upstream)$' "$REPO_ROOT/server-rust/Dockerfile" \
  || fail "Dockerfile must declare ORT_SOURCE with a default of own-image or upstream"
pass "real Dockerfile: digest pin + ORT_SOURCE default declared"

echo "[ort-own-image-test] $CASES cases passed"
