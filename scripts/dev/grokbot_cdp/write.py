#!/usr/bin/env python3
"""Inject text into the Grok Bot composer over CDP. Does not SEND."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    cdp_call,
    cdp_version,
    composer_text,
    connect_ws,
    disk_app_identity,
    evaluate,
    focus_composer,
    page_target,
    skip_if_absent,
)

PROBE_TEXT = "oort-cdp-probe"
SABOTAGE_ORIGIN = "origin"
SABOTAGE_INNERTEXT = "innertext"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inject composer text. SEND is not automated; a human Enter tap is required."
    )
    parser.add_argument("--text", default=PROBE_TEXT, help="text to insert (default: oort-cdp-probe)")
    parser.add_argument(
        "--sabotage",
        choices=(SABOTAGE_ORIGIN, SABOTAGE_INNERTEXT),
        default=os.environ.get("GROKBOT_CDP_SABOTAGE", "") or None,
        help="reproduce a known-failing injection (origin → 403, innertext → ProseMirror unchanged)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    # Sabotage must still attempt the WS handshake when :9333 is closed so the
    # connection-refused proof is visible (it is not a forged 403).
    if args.sabotage is None and skip_if_absent():
        return 0
    identity = disk_app_identity()
    suppress_origin = args.sabotage != SABOTAGE_ORIGIN
    try:
        version = cdp_version()
        page = page_target()
        ws_url = page["webSocketDebuggerUrl"]
    except Exception:
        version = {}
        page = {"id": None, "title": None, "url": None}
        ws_url = "ws://127.0.0.1:9333/devtools/page/sabotage"
        if args.sabotage is None:
            raise
    try:
        ws = connect_ws(ws_url, suppress_origin=suppress_origin)
    except Exception as error:
        print(
            json.dumps(
                {
                    "op": "WRITE",
                    "sabotage": args.sabotage,
                    "suppress_origin": suppress_origin,
                    "handshakeError": f"{type(error).__name__}: {error}",
                    "diskApp": identity,
                    "browser": version.get("Browser"),
                },
                ensure_ascii=False,
            )
        )
        return 1
    try:
        before = composer_text(ws, call_id=1)
        focus_composer(ws, call_id=2)
        if args.sabotage == SABOTAGE_INNERTEXT:
            injected = json.dumps(args.text)
            evaluate(
                ws,
                f"(() => {{ const el = document.querySelector('.ProseMirror'); if (el) el.innerText = {injected}; return el ? el.innerText : ''; }})",
                call_id=3,
            )
            method = "innerText"
        else:
            cdp_call(ws, "Input.insertText", {"text": args.text}, call_id=3)
            method = "Input.insertText"
        after = composer_text(ws, call_id=4)
        print(
            json.dumps(
                {
                    "op": "WRITE",
                    "method": method,
                    "suppress_origin": suppress_origin,
                    "sabotage": args.sabotage,
                    "browser": version.get("Browser"),
                    "userAgent": version.get("User-Agent"),
                    "diskApp": identity,
                    "before": before,
                    "after": after,
                    "proseMirrorUpdated": after != before and args.text in after,
                    "send": "not automated; human Enter tap required",
                },
                ensure_ascii=False,
            )
        )
    finally:
        ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
