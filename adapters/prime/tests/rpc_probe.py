#!/usr/bin/env python3
"""Drive one prime-agent RPC session with **no oort relay at all**.

Two jobs, and both need the harness without needing a channel:

1. **Image prewarm.** The Dockerfile runs one throwaway turn while the build
   still has network, so the runtime container has a warm kernel venv and its
   eight bundled skills. Using the real adapter there would mean the image build
   depended on an oort endpoint, which it must not.
2. **The tenancy probe.** `tenancy_probe.sh` needs a real kernel cell to run
   (`rlm.harness` is only reachable from inside the kernel) and needs the cell's
   stdout back. It does not need, and must not have, a channel to write to.

Everything it prints is measurement. If you want messages in oort, that is
`adapter.py`.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import time
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from prime.rpc import EOF_RECORD, JsonlRpc  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", default="hello")
    parser.add_argument("--model", default=os.environ.get("OORT_PRIME_MODEL", "oort-mock/oort-mock-1"))
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--out", help="write the probe record here as JSON")
    parser.add_argument("--refine", action="store_true", help="send one `refine` command after the turn")
    parser.add_argument("--prime-bin", default=os.environ.get("OORT_PRIME_BIN", "prime-agent"))
    args = parser.parse_args(argv)

    argv_prime = [args.prime_bin, "--mode", "rpc", "--no-session", "--offline"]
    if args.model:
        argv_prime += ["--model", args.model]
    rpc = JsonlRpc(argv_prime, env=dict(os.environ), cwd=os.getcwd())

    counts: dict[str, int] = {}
    cell_output: list[str] = []
    stream_log: list[str] = []
    deadline = time.time() + args.timeout

    rpc.send({"id": "p-1", "type": "prompt", "message": args.prompt})
    ended = _pump(rpc, deadline, counts, cell_output, stream_log)

    refine: dict[str, Any] | None = None
    if args.refine:
        mark = len(stream_log)
        rpc.send({"id": "r-1", "type": "refine"})
        response = _await_response(rpc, min(deadline, time.time() + 90), counts, cell_output, stream_log, "refine")
        refine = {"response": response, "recordsInWindow": stream_log[mark:]}

    rpc.close()
    record = {
        "eventCounts": counts,
        "cellOutput": cell_output,
        "streamLog": stream_log,
        "agentEnded": ended,
        "refine": refine,
        "stderr": rpc.stderr_lines[-40:],
    }
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"eventCounts": counts, "agentEnded": ended}, ensure_ascii=False))
    # A probe that never saw `agent_end` measured a broken harness, and the image
    # build must fail on that rather than shipping a container whose first real
    # cell will be 80 seconds late.
    return 0 if ended else 1


def _note(record: dict[str, Any], counts: dict[str, int], cell_output: list[str], stream_log: list[str]) -> str:
    record_type = str(record.get("type", "?"))
    counts[record_type] = counts.get(record_type, 0) + 1
    stream_log.append(record_type)
    if record_type == "tool_execution_end":
        result = record.get("result") or {}
        cell_output.append(
            " ".join(part.get("text", "") for part in result.get("content", []) if isinstance(part, dict))
        )
    return record_type


def _pump(
    rpc: JsonlRpc,
    deadline: float,
    counts: dict[str, int],
    cell_output: list[str],
    stream_log: list[str],
) -> bool:
    while time.time() < deadline:
        try:
            record = rpc.inbox.get(timeout=0.2)
        except queue.Empty:
            continue
        record_type = _note(record, counts, cell_output, stream_log)
        if record_type == "agent_end":
            return True
        if record_type == EOF_RECORD:
            return False
    return False


def _await_response(
    rpc: JsonlRpc,
    deadline: float,
    counts: dict[str, int],
    cell_output: list[str],
    stream_log: list[str],
    command: str,
) -> dict[str, Any] | None:
    while time.time() < deadline:
        try:
            record = rpc.inbox.get(timeout=0.2)
        except queue.Empty:
            continue
        record_type = _note(record, counts, cell_output, stream_log)
        if record_type == "response" and record.get("command") == command:
            return {"success": record.get("success"), "error": record.get("error")}
        if record_type == EOF_RECORD:
            return None
    return None


if __name__ == "__main__":
    raise SystemExit(main())
