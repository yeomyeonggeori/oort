#!/usr/bin/env python3
"""herdr state-detection accuracy probe (SPIKE #1121 — experiment only).

Sends one prompt to an agent living in a herdr pane and samples, at 200ms,
both what herdr *thinks* (agent.get -> agent_status) and what herdr *sees*
(pane.read --source detection, the same buffer its rules match against).
Emits the state-transition timeline with latencies relative to prompt submit,
plus first-sighting timestamps for ground-truth markers.

Ground truth = when a marker string appears in the detection buffer. Pick
markers that cannot appear in the prompt echo itself, or the composer will
match them at t=0.

    python3 scripts/spikes/herdr_probe.py <case> <agent-or-pane> <pane> <prompt> [seconds] [marker...]

Reads the socket directly (no CLI spawn per sample) so the 200ms cadence is
real. Writes case_<case>.json with every sample for post-hoc inspection.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time

SOCK = os.environ.get("HERDR_SOCKET_PATH", os.path.expanduser("~/.config/herdr/herdr.sock"))
HERDR = os.environ.get("HERDR_BIN", "herdr")
INTERVAL = 0.2


def rpc(method: str, params: dict, timeout: float = 10.0) -> dict:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(SOCK)
    s.sendall((json.dumps({"id": "probe", "method": method, "params": params}) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf.split(b"\n", 1)[0])


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__, file=sys.stderr)
        return 2
    case, target, pane, prompt = sys.argv[1:5]
    duration = float(sys.argv[5]) if len(sys.argv) > 5 else 60.0
    markers = sys.argv[6:]

    samples: list[tuple[float, str, str]] = []
    stop = threading.Event()
    t0 = time.time()

    def sample_loop() -> None:
        while not stop.is_set():
            t = time.time() - t0
            try:
                state = rpc("agent.get", {"target": target})["result"]["agent"]["agent_status"]
            except Exception:
                state = "ERR"
            try:
                text = rpc("pane.read", {"pane_id": pane, "source": "detection",
                                         "lines": 200, "format": "text"})["result"]["read"]["text"]
            except Exception:
                text = ""
            samples.append((round(t, 3), state, text))
            time.sleep(INTERVAL)

    th = threading.Thread(target=sample_loop, daemon=True)
    th.start()
    time.sleep(1.0)  # baseline before submit

    t_send = time.time() - t0
    subprocess.run([HERDR, "agent", "prompt", target, prompt],
                   capture_output=True, env={**os.environ, "HERDR_ENV": "1"})

    time.sleep(duration)
    stop.set()
    th.join(timeout=3)

    transitions, prev = [], None
    for t, state, _ in samples:
        if state != prev:
            transitions.append({"t": t, "state": state, "d_from_send": round(t - t_send, 3)})
            prev = state

    marker_hits = {}
    for m in markers:
        first = next((t for t, _, text in samples if m in text), None)
        marker_hits[m] = {"t": first,
                          "d_from_send": round(first - t_send, 3) if first is not None else None}

    summary = {"case": case, "target": target, "pane": pane, "prompt": prompt,
               "t_send": round(t_send, 3), "samples": len(samples),
               "transitions": transitions, "markers": marker_hits}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    with open("case_%s.json" % case, "w") as f:
        json.dump({"summary": summary,
                   "samples": [{"t": t, "state": s, "tail": x[-300:]} for t, s, x in samples]},
                  f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
