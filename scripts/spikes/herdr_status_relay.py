#!/usr/bin/env python3
"""herdr -> oort status relay (SPIKE #1121 — experiment only, not production).

Subscribes to the herdr socket API (`pane.agent_status_changed`) and relays
worker-state transitions into an oort channel through the REST write path only.

Contract guardrails this prototype keeps (ADR-0100 / L4 §3.1):
  - single write path: POST /v1/workspaces/{ws}/channels/{ch}/messages. Never
    Centrifugo, never direct SQL. `seq` authority stays in Postgres.
  - idempotency: clientMsgId = uuid5(pane_id | state | state_change_seq), so a
    reconnect that replays a transition cannot double-post.
  - notification hygiene (research 2026-08-06 §②): only `blocked` is pushed by
    default; `working`/`idle` are opt-in noise.
  - herdr is executed, never linked. Nothing here is derived from herdr source.

Usage:
    export MOMO_BASE_URL=http://127.0.0.1:28000
    export MOMO_WORKSPACE=<uuid> MOMO_CHANNEL=<uuid>
    export MOMO_EMAIL=... MOMO_PASSWORD=...        # or MOMO_ACCESS_TOKEN=...
    python3 scripts/spikes/herdr_status_relay.py [--states blocked,done] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

HERDR_SOCKET = os.environ.get(
    "HERDR_SOCKET_PATH", os.path.expanduser("~/.config/herdr/herdr.sock")
)
HERDR_BIN = os.environ.get("HERDR_BIN", "herdr")
NS = uuid.UUID("6f9b1d7e-0f1a-4b2c-9d3e-5a7c1b2d4e6f")  # spike-local namespace


# --------------------------------------------------------------------------- herdr
def herdr_rpc(method: str, params: dict, timeout: float = 10.0) -> dict:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(HERDR_SOCKET)
    s.sendall((json.dumps({"id": "relay", "method": method, "params": params}) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf.split(b"\n", 1)[0])


def herdr_explain(target: str) -> str:
    """`agent explain` output is the operator-facing 'why' for a blocked pane."""
    try:
        out = subprocess.run(
            [HERDR_BIN, "agent", "explain", target],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "HERDR_ENV": "1"},
        )
        lines = [l for l in out.stdout.splitlines()
                 if l.startswith(("state:", "rule:", "evidence:", "fallback_reason:"))]
        return "\n".join(lines)
    except Exception as exc:  # explain is best-effort context, never fatal
        return "explain unavailable: %s" % exc


# ---------------------------------------------------------------------------- oort
class Oort:
    def __init__(self, base: str, workspace: str, channel: str,
                 email: str | None, password: str | None, token: str | None):
        self.base = base.rstrip("/")
        self.workspace = workspace
        self.channel = channel
        self.email = email
        self.password = password
        self.token = token
        if not self.token:
            self.login()

    def login(self) -> None:
        body = json.dumps({"email": self.email, "password": self.password,
                           "workspace": self.workspace}).encode()
        req = urllib.request.Request(self.base + "/v1/auth/login", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            self.token = json.load(resp)["accessToken"]

    def send(self, text: str, client_msg_id: str) -> dict:
        url = "%s/v1/workspaces/%s/channels/%s/messages" % (self.base, self.workspace, self.channel)
        body = json.dumps({"body": text, "clientMsgId": client_msg_id}).encode()
        for attempt in (1, 2):
            req = urllib.request.Request(url, data=body, headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.token,
            })
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as exc:
                if exc.code == 401 and attempt == 1 and self.email:
                    self.login()
                    continue
                raise
        raise RuntimeError("unreachable")


# --------------------------------------------------------------------------- relay
STATE_ICON = {"blocked": "🚧", "working": "⏳", "idle": "✅", "done": "✅", "unknown": "❔"}


def render(event: dict, explain: str) -> str:
    state = event.get("agent_status", "unknown")
    head = "%s %s — %s" % (
        STATE_ICON.get(state, "•"),
        event.get("agent") or event.get("display_agent") or "agent",
        state,
    )
    where = "pane %s (workspace %s)" % (event.get("pane_id"), event.get("workspace_id"))
    title = event.get("title")
    lines = [head, where]
    if title:
        lines.append("title: %s" % title)
    if explain:
        lines.append("")
        lines.append(explain)
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", default="blocked",
                    help="comma-separated states to relay (default: blocked)")
    ap.add_argument("--panes", default="",
                    help="comma-separated pane ids; default = every pane that currently hosts an agent")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-dwell-ms", type=int, default=1500,
                    help="ignore a state that flips away again within this window")
    args = ap.parse_args()

    want = {s.strip() for s in args.states.split(",") if s.strip()}

    panes = [p.strip() for p in args.panes.split(",") if p.strip()]
    if not panes:
        agents = herdr_rpc("agent.list", {}).get("result", {}).get("agents", [])
        panes = [a["pane_id"] for a in agents]
    if not panes:
        print("no agent panes found; start an agent first", file=sys.stderr)
        return 2
    print("[relay] watching panes: %s | states: %s" % (", ".join(panes), ",".join(sorted(want))))

    oort = None
    if not args.dry_run:
        oort = Oort(
            os.environ["MOMO_BASE_URL"], os.environ["MOMO_WORKSPACE"], os.environ["MOMO_CHANNEL"],
            os.environ.get("MOMO_EMAIL"), os.environ.get("MOMO_PASSWORD"),
            os.environ.get("MOMO_ACCESS_TOKEN"),
        )

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(HERDR_SOCKET)
    subs = [{"type": "pane.agent_status_changed", "pane_id": p} for p in panes]
    subs.append({"type": "pane.agent_detected"})
    sock.sendall((json.dumps({"id": "relay:sub", "method": "events.subscribe",
                              "params": {"subscriptions": subs}}) + "\n").encode())

    seen: dict[str, str] = {}
    pending: dict[str, tuple[float, dict]] = {}
    buf = b""
    sock.settimeout(0.5)
    while True:
        try:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
        except socket.timeout:
            chunk = b""
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            msg = json.loads(line)
            # herdr 0.8.0 emits this one as "pane.agent_status_changed" while its
            # siblings use underscores ("pane_agent_detected"). Accept both.
            if msg.get("event") not in ("pane.agent_status_changed",
                                        "pane_agent_status_changed"):
                continue
            data = msg["data"]
            pane = data["pane_id"]
            state = data.get("agent_status")
            if seen.get(pane) == state:
                continue
            seen[pane] = state
            if state in want:
                pending[pane] = (time.monotonic(), data)
            else:
                pending.pop(pane, None)

        now = time.monotonic()
        for pane, (t_seen, data) in list(pending.items()):
            if (now - t_seen) * 1000 < args.min_dwell_ms:
                continue
            pending.pop(pane, None)
            if seen.get(pane) != data.get("agent_status"):
                continue  # flipped away during the dwell window
            explain = herdr_explain(pane)
            text = render(data, explain)
            seq_hint = "%s|%s|%s" % (pane, data.get("agent_status"), int(time.time()))
            cid = str(uuid.uuid5(NS, seq_hint))
            if args.dry_run:
                print("[dry-run] clientMsgId=%s\n%s\n---" % (cid, text))
                continue
            msg = oort.send(text, cid)
            print("[relay] posted seq=%s state=%s pane=%s" %
                  (msg.get("seq"), data.get("agent_status"), pane))
    return 0


if __name__ == "__main__":
    sys.exit(main())
