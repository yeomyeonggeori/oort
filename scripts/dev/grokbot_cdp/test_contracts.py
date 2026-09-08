#!/usr/bin/env python3
"""Contracts for the local Grok Bot CDP harness. Can be sabotaged RED."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKIP = "SKIPPED: Grok Bot app not running (port 9333 closed)"
PYTHON = sys.executable
SABOTAGE = os.environ.get("GROKBOT_CDP_CONTRACT_SABOTAGE", "")


def fail(message: str) -> None:
    print(f"RED: {message}", file=sys.stderr)
    raise SystemExit(1)


def source(name: str) -> str:
    return (HERE / name).read_text(encoding="utf-8")


def run_script(name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [PYTHON, str(HERE / name)],
        check=False,
        capture_output=True,
        text=True,
    )


def main() -> int:
    if SABOTAGE == "require_send":
        write = source("write.py")
        if "Input.dispatchKeyEvent" in write and '"Enter"' in write:
            print("GREEN: auto-SEND helper present (sabotage expected this)")
            return 0
        fail("write.py has no auto-SEND helper (Enter dispatch); sabotage require_send is RED")

    for name in ("read.py", "write.py", "clear.py"):
        completed = run_script(name)
        if completed.returncode != 0:
            fail(f"{name} exit {completed.returncode}: {completed.stderr.strip() or completed.stdout.strip()}")
        line = completed.stdout.strip().splitlines()
        if not line or line[0] != SKIP:
            # Port may be open (app running) — either SKIP or a JSON op is fine.
            if not (completed.stdout.strip().startswith("{") or (line and line[0] == SKIP)):
                fail(f"{name} did not print SKIPPED or JSON, got {completed.stdout!r}")

    write = source("write.py")
    if "suppress_origin=True" not in source("_common.py") and "suppress_origin=True" not in write:
        fail("suppress_origin=True missing")
    if "suppress_origin" not in write:
        fail("write.py does not thread suppress_origin")
    if "Input.insertText" not in write:
        fail("write.py must inject via Input.insertText")
    if "--send" in write or 'key": "Enter"' in write or "click Send" in write:
        fail("write.py must not automate SEND")
    if "human Enter tap" not in write and "human Enter tap" not in source("README.md"):
        fail("human Enter tap is not documented")
    print("GREEN: grokbot_cdp contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
