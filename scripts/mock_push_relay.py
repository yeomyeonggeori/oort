#!/usr/bin/env python3
"""Tiny mock push relay for MOMO-404 runtime verification (ADR-0120 P-2).

Stands in for the Dawn-operated PushRelay (P-3) so the NotifierWorker's
judgment + id-only dispatch contract can be verified without APNs:

  POST /v1/push   -> record the received dispatch payload, return an APNs-ish
                     receipt {"apns_status": 200, "apns_id": "..."}
  GET  /received  -> JSON array of every payload received so far (verifier
                     inspection surface — asserts id-only: no message body,
                     no display names)
  GET  /health    -> {"ok": true}

No third-party dependencies; this is a local test fixture in the
scripts/mock_hermes.py mold, not a production relay replacement. Received
payloads are kept in memory (single process; ThreadingHTTPServer handlers
share state under a lock).
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


_LOCK = threading.Lock()
_RECEIVED: list[dict[str, Any]] = []


class MockPushRelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[mock-push-relay] " + fmt % args)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json({"ok": True})
            return
        if self.path == "/received":
            with _LOCK:
                snapshot = list(_RECEIVED)
            self._send_json({"received": snapshot, "count": len(snapshot)})
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/v1/push":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self.send_error(400, f"invalid JSON: {exc}")
            return
        if not isinstance(body, dict):
            self.send_error(400, "dispatch payload must be a JSON object")
            return

        with _LOCK:
            _RECEIVED.append(body)
            count = len(_RECEIVED)
        print(
            "[mock-push-relay] dispatch #%d reason=%s collapse_id=%s"
            % (count, body.get("reason"), body.get("collapse_id"))
        )
        # APNs-shaped receipt: the notifier records apns_status/apns_reason
        # into push_dispatch_log (001_init.sql contract).
        self._send_json(
            {
                "apns_status": 200,
                "apns_reason": None,
                "apns_id": str(uuid.uuid4()),
                "received_at_ms": int(time.time() * 1000),
            }
        )

    def _send_json(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), MockPushRelayHandler)
    print(f"[mock-push-relay] listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
