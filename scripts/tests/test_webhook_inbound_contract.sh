#!/usr/bin/env bash
# #1265 inbound webhook contract (static). Runtime cases live in
# scripts/verify_webhook_rust.sh → webhook_inbound_conformance_pg.
# Direct INSERT into message is forbidden; all three public Caddyfiles must
# reverse_proxy /hooks/* to the same API upstream as /v1/* (after the
# centrifugo 403, before the SPA catch-all).
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

echo "[test-webhook-inbound-contract] Caddy /hooks/* reverse_proxy on all three edges"
python3 - <<'PY'
import re
import sys
from pathlib import Path

FILES = (
    "infra/rust/Caddyfile",
    "infra/rust/Caddyfile.local",
    "infra/railway/Caddyfile.railway",
)
HANDLE_OPEN = re.compile(r"^(\t)handle(?: (\S+))? \{\s*$")
PROXY = re.compile(r"^reverse_proxy\s+(\S+)\s*$")
CSP = "Content-Security-Policy"


def exclusive_proxy_body(lines, start_idx):
    """start_idx is the handle-open line. Return (upstream, close_idx)."""
    i = start_idx + 1
    upstream = None
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped == "" or stripped.startswith("#"):
            i += 1
            continue
        if upstream is None:
            match = PROXY.match(stripped)
            if not match:
                raise ValueError(f"expected reverse_proxy, got {lines[i]!r}")
            upstream = match.group(1)
            i += 1
            continue
        if stripped == "}":
            return upstream, i
        raise ValueError(f"extra directive in handle: {lines[i]!r}")
    raise ValueError("handle never closed")


def check(path):
    lines = Path(path).read_text().splitlines()
    opens = []
    for idx, line in enumerate(lines):
        match = HANDLE_OPEN.match(line)
        if match:
            opens.append((idx, match.group(2) or ""))

    matchers = [matcher for _, matcher in opens]
    if matchers.count("/hooks/*") != 1:
        raise SystemExit(f"{path}: expected exactly one handle /hooks/*, got {matchers.count('/hooks/*')}")
    if "/v1/centrifugo/*" not in matchers:
        raise SystemExit(f"{path}: missing centrifugo 403 matcher")
    if "/v1/*" not in matchers:
        raise SystemExit(f"{path}: missing /v1/*")
    if "" not in matchers:
        raise SystemExit(f"{path}: missing catch-all handle")

    deny_idx = next(i for i, m in opens if m == "/v1/centrifugo/*")
    v1_idx = next(i for i, m in opens if m == "/v1/*")
    hooks_idx = next(i for i, m in opens if m == "/hooks/*")
    catch_idx = next(i for i, m in opens if m == "")
    if not (deny_idx < hooks_idx < catch_idx):
        raise SystemExit(
            f"{path}: /hooks/* must sit after centrifugo 403 (line {deny_idx + 1}) "
            f"and before catch-all (line {catch_idx + 1}); hooks is line {hooks_idx + 1}"
        )
    if deny_idx >= v1_idx:
        raise SystemExit(f"{path}: centrifugo 403 must precede /v1/*")

    v1_up, _ = exclusive_proxy_body(lines, v1_idx)
    hooks_up, hooks_close = exclusive_proxy_body(lines, hooks_idx)
    if hooks_up != v1_up:
        raise SystemExit(
            f"{path}: /hooks/* reverse_proxy {hooks_up!r} != /v1/* {v1_up!r}"
        )
    hooks_block = "\n".join(lines[hooks_idx : hooks_close + 1])
    if CSP in hooks_block:
        raise SystemExit(f"{path}: /hooks/* must not carry SPA CSP")
    csp_lines = [i for i, line in enumerate(lines) if CSP in line]
    if not csp_lines:
        raise SystemExit(f"{path}: missing SPA CSP")
    if any(i < catch_idx for i in csp_lines):
        raise SystemExit(f"{path}: CSP must stay only in the catch-all handle")
    print(f"{path}: handle /hooks/* reverse_proxy {hooks_up} (after 403, before catch-all)")


for path in FILES:
    check(path)
print("caddy /hooks/* present, same upstream as /v1/*, CSP only on catch-all")
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

echo "PASS: webhook inbound contract (INSERT=0, same 404 sentence, Caddy /hooks/* proxy, OpenAPI)"
