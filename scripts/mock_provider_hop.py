#!/usr/bin/env python3
"""Misbehaving OpenAI-compatible provider fixture for the MOMO-622 cascade gate.

`scripts/mock_hermes.py` is the *healthy* provider every runtime gate uses. The
cascade (ADR-0135 D1) is about what happens when a provider is NOT healthy, so
this fixture supplies the failure side of the matrix and nothing else:

  --mode hangup            accept the request, then close the connection with no
                           response at all — the "무응답" fall-over trigger,
                           deterministic and immediate (unlike a refused
                           connection, which AsyncHTTPClient retries with backoff).
  --mode status --status N answer every provider call with HTTP N. Used for the
                           429/5xx fall-over triggers and, crucially, for 401 —
                           the case that must PROPAGATE instead of spending a
                           second provider's budget.

`GET /health` always answers 200 so a verifier can wait for readiness regardless
of mode. `GET /v1/models` follows the selected mode, so the server-side chain
probe (`POST /v1/provider/link/test`, which probes `{base}/models`) and the
worker-side cascade (`POST {base}/chat/completions`) see the same behavior.

Deliberately dependency-free (stdlib only) so it runs inside the existing
`python:3.12-slim` mock-hermes container off the read-only source mount.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODE = "status"
STATUS = 503


class MockProviderHopHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[mock-provider-hop] " + fmt % args, flush=True)

    # ---- routing -----------------------------------------------------------

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json({"ok": True, "mode": MODE, "status": STATUS})
            return
        if self.path.endswith("/models"):
            self._misbehave()
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path.endswith("/chat/completions"):
            # Drain the body so the client sees a complete request/response cycle
            # rather than a write error that muddies the classification.
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length:
                    self.rfile.read(length)
            except Exception:
                pass
            self._misbehave()
            return
        self.send_error(404)

    # ---- behaviors ---------------------------------------------------------

    def _misbehave(self) -> None:
        if MODE == "hangup":
            # No status line, no headers, no body: the peer observes the
            # connection closing mid-exchange. This is "provider_unreachable".
            self.close_connection = True
            try:
                self.connection.close()
            except Exception:
                pass
            return
        self._send_json(
            {"error": {"message": f"mock provider hop forced {STATUS}"}},
            status=STATUS,
        )

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    global MODE, STATUS
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--mode", choices=["hangup", "status"], default="status")
    parser.add_argument("--status", type=int, default=503)
    args = parser.parse_args()

    MODE = args.mode
    STATUS = args.status
    server = ThreadingHTTPServer((args.host, args.port), MockProviderHopHandler)
    print(
        f"[mock-provider-hop] listening on {args.host}:{args.port} "
        f"mode={MODE} status={STATUS}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
