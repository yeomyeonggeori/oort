#!/usr/bin/env bash
# #1265 inbound webhook contract (static). Runtime cases live in
# scripts/verify_webhook_rust.sh → webhook_inbound_conformance_pg.
# Direct INSERT into message is forbidden; Caddy public-edge 403 must not
# cover /hooks; both ingress routes share one 404 sentence.
set -euo pipefail

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)"
cd "$REPO_ROOT"

fail() {
  printf '[test-webhook-inbound-contract] FAIL %s\n' "$*" >&2
  exit 1
}

INGRESS_RS="server-rust/bins/momo-server/src/routes/webhook_ingress.rs"
INGRESS_SQL="server-rust/crates/momo-webhook/src/ingress.rs"
PAYLOAD_RS="server-rust/crates/momo-webhook/src/payload.rs"

echo "[test-webhook-inbound-contract] direct INSERT INTO message = 0"
hits="$(
  python3 - <<'PY'
import re, pathlib
files = [
    "server-rust/bins/momo-server/src/routes/webhook_ingress.rs",
    "server-rust/crates/momo-webhook/src/ingress.rs",
    "server-rust/crates/momo-webhook/src/payload.rs",
]
pat = re.compile(r"INSERT\s+INTO\s+message\b", re.IGNORECASE)
total = 0
for path in files:
    text = pathlib.Path(path).read_text()
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("///"):
            continue
        if pat.search(line):
            print(f"{path}:{i}:{line}")
            total += 1
print(f"COUNT={total}")
PY
)"
echo "$hits"
echo "$hits" | grep -qx 'COUNT=0' || fail "inbound path contains INSERT INTO message"

echo "[test-webhook-inbound-contract] both handlers share UNKNOWN_INSTALLATION"
grep -q 'pub(crate) const UNKNOWN_INSTALLATION' "$INGRESS_RS" \
  || fail "UNKNOWN_INSTALLATION missing"
native_hits="$(grep -c 'ApiError::not_found(UNKNOWN_INSTALLATION)' "$INGRESS_RS" || true)"
[ "$native_hits" -eq 3 ] || fail "expected UNKNOWN_INSTALLATION on native load + slack parse + slack load, got $native_hits"

echo "[test-webhook-inbound-contract] write path is send_message_in_tx"
grep -q 'momo_messaging::send_message_in_tx' "$INGRESS_RS" \
  || fail "inbound must create messages through send_message_in_tx"

echo "[test-webhook-inbound-contract] Caddy 403 does not cover /hooks"
python3 - <<'PY'
import re, pathlib, sys
for path in ("infra/rust/Caddyfile", "infra/rust/Caddyfile.local"):
    text = pathlib.Path(path).read_text()
    if "handle /v1/centrifugo/*" not in text:
        print(f"{path}: missing centrifugo 403 matcher", file=sys.stderr)
        sys.exit(1)
    for match in re.finditer(r"handle\s+(\S+)\s*\{([^}]*)\}", text):
        matcher, body = match.group(1), match.group(2)
        if "respond 403" in body and "hooks" in matcher:
            print(f"{path}: {matcher} is 403", file=sys.stderr)
            sys.exit(1)
print("caddy 403 does not cover /hooks")
PY

echo "[test-webhook-inbound-contract] OpenAPI documents 404 on both ingress ops"
python3 - <<'PY'
from pathlib import Path
text = Path("docs/api/openapi.yaml").read_text()
native = text.split("/v1/webhooks/{workspaceId}/{installationId}:", 1)[1]
native = native.split("/hooks/{token}:", 1)[0]
slack = text.split("/hooks/{token}:", 1)[1]
slack = slack.split("/v1/mcp/drive:", 1)[0]
if '"404":' not in native:
    raise SystemExit("native ingress OpenAPI missing 404")
if '"401":' not in native:
    raise SystemExit("native ingress OpenAPI missing 401")
if '"404":' not in slack:
    raise SystemExit("slack ingress OpenAPI missing 404")
if '"401":' in slack.split("responses:", 1)[1]:
    raise SystemExit("slack ingress must not 401 a bad token")
print("openapi 404/401 split matches ADR-0115")
PY

echo "[test-webhook-inbound-contract] order anchors exist for sabotage"
grep -q '#1265-order: signature check' "$INGRESS_RS" || fail "signature-order anchor missing"
grep -q '#1265-order: replay short-circuit' "$INGRESS_RS" || fail "replay-order anchor missing"
grep -q '#1265-order: parse' "$INGRESS_RS" || fail "parse-order anchor missing"
grep -q 'INSERT INTO webhook_receipt' "$INGRESS_SQL" || fail "receipt insert missing"
grep -q 'parse_native' "$PAYLOAD_RS" || fail "payload parser missing"

echo "PASS: webhook inbound contract (INSERT=0, same 404 sentence, Caddy /hooks not 403, OpenAPI)"
