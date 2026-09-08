#!/usr/bin/env python3
"""Shared CDP helpers for the local Grok Bot harness. Not a product surface."""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any

CDP_HOST = "127.0.0.1"
CDP_PORT = 9333
SKIP_MESSAGE = "SKIPPED: Grok Bot app not running (port 9333 closed)"
APP_PLIST = "/Applications/Grok Bot.app/Contents/Info.plist"


def port_is_open(host: str = CDP_HOST, port: int = CDP_PORT, timeout: float = 0.4) -> bool:
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        return sock.connect_ex((host, port)) == 0
    finally:
        sock.close()


def skip_if_absent() -> bool:
    if port_is_open():
        return False
    print(SKIP_MESSAGE)
    return True


def http_json(path: str, timeout: float = 2.0) -> Any:
    url = f"http://{CDP_HOST}:{CDP_PORT}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def page_target() -> dict[str, Any]:
    targets = http_json("/json/list")
    pages = [row for row in targets if row.get("type") == "page"]
    if len(pages) != 1:
        raise SystemExit(f"expected a single page target, got {len(pages)}")
    return pages[0]


def cdp_version() -> dict[str, Any]:
    try:
        return http_json("/json/version")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return {}


def disk_app_identity() -> dict[str, str]:
    identity = {"bundle": "com.anysphere.sand", "version": "", "build": ""}
    try:
        import plistlib
        from pathlib import Path

        raw = plistlib.loads(Path(APP_PLIST).read_bytes())
        identity["bundle"] = str(raw.get("CFBundleIdentifier") or identity["bundle"])
        identity["version"] = str(raw.get("CFBundleShortVersionString") or "")
        identity["build"] = str(raw.get("CFBundleVersion") or "")
    except OSError:
        pass
    return identity


def connect_ws(url: str, suppress_origin=True):
    import websocket

    return websocket.create_connection(url, suppress_origin=suppress_origin)


def cdp_call(ws: Any, method: str, params: dict[str, Any] | None = None, call_id: int = 1) -> Any:
    payload = {"id": call_id, "method": method}
    if params is not None:
        payload["params"] = params
    ws.send(json.dumps(payload))
    while True:
        message = json.loads(ws.recv())
        if message.get("id") == call_id:
            return message


def evaluate(ws: Any, expression: str, call_id: int = 1) -> Any:
    return cdp_call(
        ws,
        "Runtime.evaluate",
        {"expression": expression, "returnByValue": True, "awaitPromise": True},
        call_id=call_id,
    )


def focus_composer(ws: Any, call_id: int = 1) -> Any:
    return evaluate(
        ws,
        "(() => { const el = document.querySelector('.ProseMirror'); if (el) el.focus(); return Boolean(el); })()",
        call_id=call_id,
    )


def composer_text(ws: Any, call_id: int = 1) -> str:
    result = evaluate(
        ws,
        "(() => { const el = document.querySelector('.ProseMirror'); return el ? (el.innerText || '') : ''; })()",
        call_id=call_id,
    )
    value = result.get("result", {}).get("result", {}).get("value")
    return value if isinstance(value, str) else ""
