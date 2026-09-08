#!/usr/bin/env python3
"""Read the Grok Bot renderer over CDP. Local verification only."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    cdp_version,
    composer_text,
    connect_ws,
    disk_app_identity,
    evaluate,
    page_target,
    skip_if_absent,
)


def main() -> int:
    if skip_if_absent():
        return 0
    version = cdp_version()
    identity = disk_app_identity()
    page = page_target()
    ws = connect_ws(page["webSocketDebuggerUrl"], suppress_origin=True)
    try:
        body = evaluate(
            ws,
            "document.body ? document.body.innerText.slice(0, 4000) : ''",
            call_id=1,
        )
        text = composer_text(ws, call_id=2)
        print(
            json.dumps(
                {
                    "op": "READ",
                    "browser": version.get("Browser"),
                    "userAgent": version.get("User-Agent"),
                    "diskApp": identity,
                    "targetId": page.get("id"),
                    "title": page.get("title"),
                    "url": page.get("url"),
                    "bodyPreview": body.get("result", {}).get("result", {}).get("value"),
                    "composerText": text,
                },
                ensure_ascii=False,
            )
        )
    finally:
        ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
