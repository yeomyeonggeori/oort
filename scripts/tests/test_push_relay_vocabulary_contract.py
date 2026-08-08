#!/usr/bin/env python3
"""Pins the push `reason` vocabulary divergence documented in ADR-0120 부록 A.

Nothing here proposes a fix. This test **freezes the current behaviour** so that
the day someone changes it, they change it deliberately:

  1. The judgment layer can emit `work_session_idle`
     (`server-rust/crates/momo-push/src/judgment.rs`, `dispatch.rs`).
  2. Every downstream validator — the relay, the iOS NSE, the RN kit, the RN JS
     mirror — accepts only the OTHER FOUR reasons. Such a dispatch is answered
     400, classified permanent, settled, and dropped without delivery.
  3. `scripts/mock_push_relay.py` performs **no vocabulary validation at all**,
     which is exactly why the e2e gate cannot see (2). This file asserts that
     blindness live, on a loopback socket, so it cannot be assumed away.

The sibling tripwire on the Rust side is
`momo-push::dispatch::tests::work_session_idle_is_not_deliverable_through_the_relay`.
Widening the relay's vocabulary is an ADR-0120 wire change and must turn BOTH
red — plus this file's `MOCK_IS_BLIND` check, because a widened relay with a
still-blind mock would leave the gate asserting nothing.

Static checks read files only. The one live check binds 127.0.0.1:0 (ephemeral
loopback); no docker, no external network, no database.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from mock_push_relay import MockPushRelayHandler  # noqa: E402


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


# The four reasons every validator on the delivery path accepts.
DELIVERABLE_REASONS = ("dm", "mention", "approval_request", "resume_offer")
# The fifth reason judgment can produce, which none of them accept.
UNDELIVERABLE_REASON = "work_session_idle"

RELAY = "relay/PushRelay/Sources/PushRelay/PushDispatch.swift"
RUST_DISPATCH = "server-rust/crates/momo-push/src/dispatch.rs"
RUST_JUDGMENT = "server-rust/crates/momo-push/src/judgment.rs"
IOS_KIT = "clients/iOS/MomoiOSKit/Sources/MomoiOSPushKit/PushNotification.swift"
RN_KIT = "clients/mobile/ios/MomoPushKit/PushNotification.swift"
RN_JS = "clients/mobile/src/push/contract.ts"
MOCK = "scripts/mock_push_relay.py"

# --- 1. judgment CAN produce the fifth reason -------------------------------

rust_dispatch = read(RUST_DISPATCH)
assert (
    f'PushReason::WorkSessionIdle => "{UNDELIVERABLE_REASON}"' in rust_dispatch
), f"{RUST_DISPATCH}: PushReason no longer emits {UNDELIVERABLE_REASON}"
assert (
    "pub fn accepted_by_relay(self) -> bool {" in rust_dispatch
    and "!matches!(self, PushReason::WorkSessionIdle)" in rust_dispatch
), f"{RUST_DISPATCH}: accepted_by_relay no longer encodes the divergence"

rust_judgment = read(RUST_JUDGMENT)
assert (
    f"THEN '{UNDELIVERABLE_REASON}'" in rust_judgment
), f"{RUST_JUDGMENT}: judgment SQL no longer labels {UNDELIVERABLE_REASON}"

# `work_session_idle` is categorised as work, so it dies on the reason guard
# alone — never on the category guard.
assert (
    f'Some("resume_offer") | Some("{UNDELIVERABLE_REASON}")' in rust_dispatch
), f"{RUST_DISPATCH}: {UNDELIVERABLE_REASON} no longer maps to PushCategory::Work"

# --- 2. every downstream validator accepts only the other four --------------

swift_allowlist = (
    '["dm", "mention", "approval_request", "resume_offer"]'
)

relay = read(RELAY)
assert (
    f"guard {swift_allowlist}.contains(reason) else {{" in relay
), f"{RELAY}: relay reason allowlist changed — is this the ADR-0120 widening?"
assert (
    UNDELIVERABLE_REASON not in relay
), f"{RELAY}: relay now knows {UNDELIVERABLE_REASON} — update ADR-0120 부록 A"

for path in (IOS_KIT, RN_KIT):
    source = read(path)
    assert (
        f"{swift_allowlist}.contains(payload.reason)" in source
    ), f"{path}: NSE reason allowlist changed"
    assert (
        UNDELIVERABLE_REASON not in source
    ), f"{path}: NSE now knows {UNDELIVERABLE_REASON} — update ADR-0120 부록 A"

rn_js = read(RN_JS)
for reason in DELIVERABLE_REASONS:
    assert f"'{reason}'," in rn_js, f"{RN_JS}: missing reason {reason}"
assert (
    UNDELIVERABLE_REASON not in rn_js
), f"{RN_JS}: JS mirror now knows {UNDELIVERABLE_REASON} — update ADR-0120 부록 A"

# --- 3. the mock is blind, which is why the gate cannot see any of this -----

mock_source = read(MOCK)
assert (
    UNDELIVERABLE_REASON not in mock_source
), f"{MOCK}: unexpected vocabulary reference"
for reason in DELIVERABLE_REASONS:
    assert (
        f'"{reason}"' not in mock_source
    ), f"{MOCK}: now validates reason {reason} — the gate is no longer blind, update ADR-0120 부록 A"

# Live proof of the blindness: the mock accepts the exact dispatch the real
# relay answers 400. MOCK_IS_BLIND.
server = ThreadingHTTPServer(("127.0.0.1", 0), MockPushRelayHandler)
port = server.server_address[1]
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    payload = json.dumps(
        {
            "schema": "momo.push.dispatch.v2",
            "reason": UNDELIVERABLE_REASON,
            "category": "momo.work",
            "collapse_id": "pin-work-session-idle",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/push",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status = response.status
            receipt = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # pragma: no cover - the pin failing
        raise AssertionError(
            f"{MOCK} rejected {UNDELIVERABLE_REASON} with HTTP {exc.code}. "
            "The mock now validates the vocabulary — that is a real improvement, "
            "but it changes what the e2e gate proves. Update ADR-0120 부록 A."
        ) from exc

    assert status == 200, f"{MOCK}: expected 200, got {status}"
    assert receipt["apns_status"] == 200, (
        f"{MOCK}: expected an accepting receipt, got {receipt}"
    )
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

print(
    "push reason vocabulary contract: PASS — judgment emits 5, "
    "relay/NSE/RN accept 4, mock validates 0 (ADR-0120 부록 A, 미결)"
)
