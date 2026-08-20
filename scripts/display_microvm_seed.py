#!/usr/bin/env python3
"""LIVE-5c #1587 — seed a momo-server so a CubeSandbox microVM producer can attach to it.

The microVM leg of the input round trip needs what production gives a producer
for free: a workspace whose owner can mint capabilities, a registered work host
whose Ed25519 PUBLIC key the server holds, a work session, and a display
binding. `scripts/display_input_e2e.py` measures the producer; this script
stands the ledger up around it, over the same REST grammar the conformance
suite uses (`display_attach_conformance_pg.rs`) — nothing here writes SQL.

Subcommands (all read MOMO_BASE / MOMO_OWNER_EMAIL / MOMO_OWNER_PASSWORD /
MOMO_WORKSPACE_ID from the environment; the password never appears on argv):

  seed            login → register a display-capable work host (a fresh Ed25519
                  seed lands in --key-out, mode 0600, and its PUBLIC half goes
                  to the server) → create a work session → publish the display
                  binding, signed as that host. Prints the resulting ids as
                  JSON on stdout. The seed is what the microVM's envVars will
                  carry as MOMO_WORK_HOST_SIGNING_KEY — the same delivery the
                  #1437 receiver lands to a 0600 file.
  issue           mint a display-attach capability (--mode controller|observer)
                  for the seeded session. Prints the issue response JSON —
                  capability_token (a 60-second bearer: dial immediately) and
                  ice_servers (the LIVE-5a per-session relay credential, which
                  is why this script never needs a TURN secret of its own).
  return-control  DELETE the control window (반환). This is the server-side
                  close the revocation measurement watches for.

Why binding is published HERE rather than by the producer: in production the
workd daemon publishes it at spawn. The display template deliberately contains
no daemon and no bearer — the producer only ever calls `validate` — so the
measurement's driver signs the binding with the same key the microVM is about
to hold. Same key, same route, same signature grammar (momo.work_host.request.v2).

Dependencies: stdlib + `cryptography` (Debian python3-cryptography — present in
the display template image, which is where the cube-host runbook runs this).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("MOMO_BASE", "http://127.0.0.1:28080").rstrip("/")
WORKSPACE = os.environ.get(
    "MOMO_WORKSPACE_ID", "00000000-0000-7000-8000-000000000001"
).lower()
OWNER_EMAIL = os.environ.get("MOMO_OWNER_EMAIL", "")
OWNER_PASSWORD = os.environ.get("MOMO_OWNER_PASSWORD", "")
# The seeded demo #general channel (002_seed.sql) — the same fixture channel the
# terminal-attach verifier drives.
CHANNEL = os.environ.get(
    "MOMO_CHANNEL_ID", "00000000-0000-7000-8000-000000000201"
).lower()

SIGNING_SCHEMA = "momo.work_host.request.v2"


def fail(message: str) -> "NoReturn":  # noqa: F821
    print(f"[seed] FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def _context():
    if not BASE.startswith("https://"):
        return None
    context = ssl.create_default_context()
    bundle = os.environ.get("MOMO_CA_BUNDLE", "")
    if bundle:
        context.load_verify_locations(cafile=bundle)
    return context


def request(
    method: str,
    path: str,
    body: dict | None = None,
    bearer: str = "",
    headers: dict | None = None,
    raw_body: bytes | None = None,
) -> tuple[int, dict]:
    data = raw_body
    if data is None and body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=15, context=_context()) as resp:
            payload = resp.read()
            return resp.status, json.loads(payload) if payload.strip() else {}
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        try:
            parsed = json.loads(payload)
        except ValueError:
            parsed = {"raw": payload.decode("utf-8", "replace")[:400]}
        return exc.code, parsed


def login() -> str:
    if not OWNER_EMAIL or not OWNER_PASSWORD:
        fail("MOMO_OWNER_EMAIL / MOMO_OWNER_PASSWORD must be set")
    status, body = request(
        "POST",
        "/v1/auth/login",
        {"email": OWNER_EMAIL, "password": OWNER_PASSWORD, "workspace": WORKSPACE},
    )
    if status != 200 or "accessToken" not in body:
        fail(f"login answered {status}")
    return body["accessToken"]


def signed_headers(seed: bytes, host_id: str, method: str, path: str, body: bytes) -> dict:
    """The producer's exact signature grammar (momo-display-producer WorkHostSigner)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = Ed25519PrivateKey.from_private_bytes(seed)
    sent_at_ms = int(time.time() * 1000)
    request_id = str(uuid.uuid4())
    digest = hashlib.sha256(body).hexdigest()
    payload = (
        f"{SIGNING_SCHEMA}\n{method.upper()}\n{path}\n{WORKSPACE}\n{host_id}"
        f"\n{sent_at_ms}\n{digest}\n{request_id}"
    ).encode("utf-8")
    signature = base64.b64encode(key.sign(payload)).decode("ascii")
    return {
        "Authorization": f"MomoHost {host_id}",
        "X-Momo-Work-Host-Sent-At": str(sent_at_ms),
        "X-Momo-Work-Host-Signature": signature,
        "X-Momo-Work-Host-Request-Id": request_id,
    }


def seed(args) -> int:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        PublicFormat,
    )

    token = login()

    raw_seed = os.urandom(32)
    public = (
        Ed25519PrivateKey.from_private_bytes(raw_seed)
        .public_key()
        .public_bytes(Encoding.Raw, PublicFormat.Raw)
    )
    # The delivered form is base64 of the 32-byte seed — exactly what the #1437
    # receiver lands and the producer's signer reads back.
    seed_b64 = base64.b64encode(raw_seed).decode("ascii")
    fd = os.open(args.key_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    # os.open's mode applies only when the file is CREATED: re-seeding into an
    # existing path would keep whatever mode that file already carried. The 0600
    # posture is therefore asserted on the descriptor, never assumed.
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(seed_b64 + "\n")

    status, body = request(
        "POST",
        f"/v1/workspaces/{WORKSPACE}/work-hosts",
        {
            "scope": "workspace",
            "type": "workd",
            "displayName": args.display_name,
            "publicKey": base64.b64encode(public).decode("ascii"),
            "capabilities": {"terminal_attach": True, "display_attach": True},
        },
        bearer=token,
    )
    if status != 201:
        fail(f"work host registration answered {status}: {body}")
    host_id = body["workHost"]["id"].lower()

    status, body = request(
        "POST",
        f"/v1/workspaces/{WORKSPACE}/work-sessions",
        {
            "channelId": CHANNEL,
            "hostId": host_id,
            "tool": "claude",
            "label": args.label,
        },
        bearer=token,
    )
    if status != 201:
        fail(f"work session create answered {status}: {body}")
    session_id = body["workSession"]["id"].lower()

    display_endpoint = args.display_endpoint_template.format(display_id=args.display_id)
    path = f"/v1/workspaces/{WORKSPACE}/work-sessions/{session_id}/display-binding"
    raw = json.dumps(
        {"displayId": args.display_id, "displayEndpoint": display_endpoint}
    ).encode("utf-8")
    status, body = request(
        "POST",
        path,
        headers=signed_headers(raw_seed, host_id, "POST", path, raw),
        raw_body=raw,
    )
    if status != 204:
        fail(f"display binding publish answered {status}: {body}")

    json.dump(
        {
            "workspace": WORKSPACE,
            "host_id": host_id,
            "session_id": session_id,
            "display_id": args.display_id,
            "display_endpoint": display_endpoint,
            "key_out": args.key_out,
        },
        sys.stdout,
    )
    print()
    return 0


def issue(args) -> int:
    token = login()
    status, body = request(
        "POST",
        f"/v1/workspaces/{WORKSPACE}/work-sessions/{args.session}/display-attach",
        {"mode": args.mode},
        bearer=token,
    )
    if status != 200:
        fail(f"display-attach issue answered {status}: {body}")
    json.dump(body, sys.stdout)
    print()
    return 0


def return_control(args) -> int:
    token = login()
    status, body = request(
        "DELETE",
        f"/v1/workspaces/{WORKSPACE}/work-sessions/{args.session}/display-control",
        bearer=token,
    )
    if status not in (200, 204):
        fail(f"display-control return answered {status}: {body}")
    print(f"[seed] control window closed (HTTP {status})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_seed = sub.add_parser("seed")
    p_seed.add_argument("--display-id", required=True)
    p_seed.add_argument("--key-out", required=True)
    p_seed.add_argument("--display-name", default="live5c microVM display host")
    p_seed.add_argument("--label", default="live5c microVM input round trip")
    p_seed.add_argument(
        "--display-endpoint-template",
        default="wss://101.79.18.230:8443/display/signal/{display_id}",
    )
    p_seed.set_defaults(func=seed)

    p_issue = sub.add_parser("issue")
    p_issue.add_argument("--session", required=True)
    p_issue.add_argument("--mode", choices=("controller", "observer"), required=True)
    p_issue.set_defaults(func=issue)

    p_return = sub.add_parser("return-control")
    p_return.add_argument("--session", required=True)
    p_return.set_defaults(func=return_control)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
