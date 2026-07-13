#!/usr/bin/env python3
"""Login-free mock for the codex-workbench subprocess contract."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


SESSION_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53"


def option(args, long_name, short_name=None):
    for name in (long_name, short_name):
        if name and name in args:
            index = args.index(name)
            return args[index + 1]
    return None


def main():
    args = sys.argv[1:]
    prompt = sys.stdin.read()
    sandbox = option(args, "--sandbox", "-s") or ""
    output = option(args, "--output-last-message", "-o")
    resume = "resume" in args
    log_path = os.environ.get("MOCK_CODEX_LOG")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "argv": args,
                        "prompt": prompt,
                        "sandbox": sandbox,
                        "resume": resume,
                        "momo_token_present": bool(os.environ.get("MOMO_AGENT_TOKEN")),
                    },
                    sort_keys=True,
                )
                + "\n"
            )

    print(json.dumps({"type": "thread.started", "thread_id": SESSION_ID}), flush=True)
    print(json.dumps({"type": "turn.started"}), flush=True)
    print(
        json.dumps(
            {
                "type": "item.started",
                "item": {
                    "id": "item-command",
                    "type": "command_execution",
                    "command": "git status --short",
                    "status": "in_progress",
                },
            }
        ),
        flush=True,
    )
    if sandbox == "workspace-write" and "CREATE_FILE" in prompt:
        Path("mock-change.txt").write_text("changed by mock codex\n", encoding="utf-8")
    final = (
        "Executed approved work. PR: "
        "https://github.com/Dawn-kim-official/momo/pull/999"
        if resume
        else "Prepared a read-only plan."
    )
    print(
        json.dumps(
            {
                "type": "item.completed",
                "item": {"id": "item-message", "type": "agent_message", "text": final},
            }
        ),
        flush=True,
    )
    print(
        json.dumps(
            {
                "type": "turn.completed",
                "usage": {
                    "input_tokens": 21,
                    "cached_input_tokens": 8,
                    "output_tokens": 13,
                    "reasoning_output_tokens": 5,
                },
            }
        ),
        flush=True,
    )
    if output:
        Path(output).write_text(final, encoding="utf-8")
    return 17 if "FORCE_FAIL" in prompt else 0


if __name__ == "__main__":
    raise SystemExit(main())
