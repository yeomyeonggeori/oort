#!/usr/bin/env python3
"""Credential-free local E2B lifecycle fixture for MOMO-647.

Implements only the REST shapes used by E2BProvisioner. `/requests` is a local
verifier inspection surface so the test can consume the one-shot workd token;
production never exposes this endpoint and the mock deliberately does not log
request bodies.
"""

from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


_LOCK = threading.Lock()
_REQUESTS: list[dict[str, Any]] = []
_STATE: dict[str, str] = {}
_CREATE_KEYS: dict[str, str] = {}
_MISSING_ON_RESUME = False
_RESUME_MODE = ""
_RESUME_STAGE = 0
_RESUME_RELEASE = threading.Event()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[mock-e2b] " + fmt % args)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True})
            return
        if self.path == "/requests":
            with _LOCK:
                requests = list(_REQUESTS)
                states = dict(_STATE)
            self._json(200, {"requests": requests, "states": states})
            return
        self.send_error(404)

    def do_POST(self) -> None:
        global _MISSING_ON_RESUME, _RESUME_MODE, _RESUME_STAGE
        if self.path == "/controls/resume-missing":
            with _LOCK:
                _MISSING_ON_RESUME = True
            self._json(200, {"resumeMissing": True})
            return
        if self.path == "/controls/resume-drop-then-missing":
            with _LOCK:
                _RESUME_MODE = "drop_then_missing"
                _RESUME_STAGE = 0
            self._json(200, {"resumeMode": _RESUME_MODE})
            return
        if self.path == "/controls/resume-drop-then-block":
            with _LOCK:
                _RESUME_MODE = "drop_then_block"
                _RESUME_STAGE = 0
                _RESUME_RELEASE.clear()
            self._json(200, {"resumeMode": _RESUME_MODE})
            return
        if self.path == "/controls/release-resume":
            _RESUME_RELEASE.set()
            self._json(200, {"released": True})
            return
        if self.path == "/sandboxes":
            body = self._body()
            if not isinstance(body, dict) or not isinstance(body.get("templateID"), str):
                self.send_error(400)
                return
            idempotency_key = self.headers.get("Idempotency-Key", "")
            with _LOCK:
                sandbox_id = _CREATE_KEYS.setdefault(
                    idempotency_key or f"unkeyed-{len(_CREATE_KEYS)}",
                    "momo647sandbox",
                )
                _REQUESTS.append({"method": "POST", "path": self.path, "body": body})
                _STATE[sandbox_id] = "running"
            self._json(
                201,
                {
                    "templateID": body["templateID"],
                    "sandboxID": sandbox_id,
                    "clientID": "mock",
                    "envdVersion": "mock",
                    "alias": "momo-workd",
                    "envdAccessToken": "mock-envd-token",
                    "trafficAccessToken": None,
                    "domain": None,
                },
            )
            return
        if self.path == "/sandboxes/momo647sandbox/pause":
            with _LOCK:
                _REQUESTS.append({"method": "POST", "path": self.path})
                _STATE["momo647sandbox"] = "paused"
            self._empty(204)
            return
        if self.path == "/sandboxes/momo647sandbox/connect":
            self._body()
            with _LOCK:
                _REQUESTS.append({"method": "POST", "path": self.path})
                missing = _MISSING_ON_RESUME
                mode = _RESUME_MODE
                stage = _RESUME_STAGE
                if mode:
                    _RESUME_STAGE += 1
                if missing:
                    _STATE["momo647sandbox"] = "missing"
                if mode == "drop_then_missing":
                    _STATE["momo647sandbox"] = "missing"
            if mode in {"drop_then_missing", "drop_then_block"} and stage == 0:
                # Simulate an ambiguous REST failure after the provider has
                # observed the idempotent request: the API keeps `resuming`.
                self.close_connection = True
                self.connection.shutdown(2)
                self.connection.close()
                return
            if mode == "drop_then_missing":
                self._json(404, {"error": "sandbox not found"})
                return
            if mode == "drop_then_block":
                _RESUME_RELEASE.wait(timeout=30)
            if missing:
                self._json(404, {"error": "sandbox not found"})
                return
            with _LOCK:
                _STATE["momo647sandbox"] = "running"
            self._json(
                200,
                {
                    "templateID": "momo-workd",
                    "sandboxID": "momo647sandbox",
                    "clientID": "mock",
                    "envdVersion": "mock",
                    "alias": "momo-workd",
                    "envdAccessToken": "mock-envd-token",
                    "trafficAccessToken": None,
                    "domain": None,
                },
            )
            return
        self.send_error(404)

    def do_DELETE(self) -> None:
        if self.path != "/sandboxes/momo647sandbox":
            self.send_error(404)
            return
        with _LOCK:
            _REQUESTS.append({"method": "DELETE", "path": self.path})
            _STATE["momo647sandbox"] = "destroyed"
        self._empty(204)

    def _body(self) -> Any:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def _json(self, status: int, value: Any) -> None:
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=28055)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[mock-e2b] listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
