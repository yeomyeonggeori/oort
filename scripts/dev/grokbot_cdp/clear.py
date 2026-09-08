#!/usr/bin/env python3
"""Clear the Grok Bot composer over CDP. Does not SEND."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    cdp_call,
    cdp_version,
    composer_text,
    connect_ws,
    disk_app_identity,
    focus_composer,
    page_target,
    skip_if_absent,
)


def key_event(ws, event_type: str, key: str, modifiers: int, call_id: int):
    params = {"type": event_type, "key": key, "modifiers": modifiers}
    if key == "Backspace":
        params["windowsVirtualKeyCode"] = 8
        params["nativeVirtualKeyCode"] = 8
    elif key == "a":
        params["windowsVirtualKeyCode"] = 65
        params["nativeVirtualKeyCode"] = 65
        params["text"] = "a" if event_type == "keyDown" and modifiers == 0 else ""
    return cdp_call(ws, "Input.dispatchKeyEvent", params, call_id=call_id)


def main() -> int:
    if skip_if_absent():
        return 0
    version = cdp_version()
    identity = disk_app_identity()
    page = page_target()
    ws = connect_ws(page["webSocketDebuggerUrl"], suppress_origin=True)
    try:
        before = composer_text(ws, call_id=1)
        focus_composer(ws, call_id=2)
        # Meta+A then Backspace. Modifier 4 is Meta (macOS). Does not press Enter.
        key_event(ws, "keyDown", "a", 4, 3)
        key_event(ws, "keyUp", "a", 4, 4)
        key_event(ws, "keyDown", "Backspace", 0, 5)
        key_event(ws, "keyUp", "Backspace", 0, 6)
        after = composer_text(ws, call_id=7)
        print(
            json.dumps(
                {
                    "op": "CLEAR",
                    "browser": version.get("Browser"),
                    "userAgent": version.get("User-Agent"),
                    "diskApp": identity,
                    "before": before,
                    "after": after,
                    "send": "not automated",
                },
                ensure_ascii=False,
            )
        )
    finally:
        ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
