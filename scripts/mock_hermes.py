#!/usr/bin/env python3
"""Tiny OpenAI-compatible SSE gateway for MOMO runtime verification.

It implements the subset AgentWorker needs:

  POST /v1/chat/completions
    - stream=true  -> text/event-stream chat.completion.chunk deltas + usage
    - stream=false -> ordinary chat.completion JSON fallback

No third-party dependencies are required; this is intentionally a local test
fixture, not a production hermes replacement.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


MOCK_TEXT = "김인턴 mock reply: MOMO-004 SSE path verified."

# MOMO-302: opt-in request capture. When MOCK_HERMES_REQUEST_DUMP=<path> is set,
# each received /v1/chat/completions body is appended as one JSON line so
# verifiers can assert the assembled chat array (roles, history, budgeting).
# Disabled by default — never writes anything unless the env var is present.
REQUEST_DUMP_PATH = os.environ.get("MOCK_HERMES_REQUEST_DUMP") or None
MOCK_TOOL_ARGS = {
    "repo": "Dawn-kim-official/momo",
    "query": "MOMO-201 live tool-call fixture",
    "limit": 2,
}


class MockHermesHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[mock-hermes] " + fmt % args)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json({"ok": True})
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self.send_error(400, f"invalid JSON: {exc}")
            return

        self._dump_request(body)

        if body.get("stream") is False:
            self._send_json(self._non_stream_response(body))
            return

        self._send_sse(body)

    def _dump_request(self, body: dict[str, Any]) -> None:
        if not REQUEST_DUMP_PATH:
            return
        try:
            line = json.dumps(body, ensure_ascii=False) + "\n"
            with open(REQUEST_DUMP_PATH, "a", encoding="utf-8") as handle:
                handle.write(line)
        except Exception as exc:  # never let capture break the mock response
            print(f"[mock-hermes] request dump failed: {exc}")

    def _send_json(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _send_sse(self, request: dict[str, Any]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        chunks = [
            "김인턴 mock reply: ",
            "MOMO-004 SSE ",
            "path verified.",
        ]
        for chunk in chunks:
            self._write_event(self._stream_chunk(request, content=chunk))
            time.sleep(0.05)

        self._write_event(self._tool_call_chunk(request, arguments_prefix=True))
        time.sleep(0.05)
        self._write_event(self._tool_call_chunk(request, arguments_prefix=False))
        time.sleep(0.05)
        self._write_event(self._usage_chunk(request))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _write_event(self, payload: dict[str, Any]) -> None:
        line = "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
        self.wfile.write(line.encode("utf-8"))
        self.wfile.flush()

    def _stream_chunk(
        self, request: dict[str, Any], *, content: str | None
    ) -> dict[str, Any]:
        return {
            "id": "chatcmpl-momo-004-mock",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": request.get("model", "hermes-agent"),
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": content} if content is not None else {},
                    "finish_reason": None,
                }
            ],
        }

    def _tool_call_chunk(
        self, request: dict[str, Any], *, arguments_prefix: bool
    ) -> dict[str, Any]:
        args = json.dumps(MOCK_TOOL_ARGS, ensure_ascii=False, separators=(",", ":"))
        delta: dict[str, Any]
        if arguments_prefix:
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_momo_201_search",
                        "type": "function",
                        "function": {
                            "name": "github.search_issues",
                            "arguments": args[:32],
                        },
                    }
                ]
            }
            finish_reason = None
        else:
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "function": {
                            "arguments": args[32:],
                        },
                    }
                ]
            }
            finish_reason = "tool_calls"
        return {
            "id": "chatcmpl-momo-004-mock",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": request.get("model", "hermes-agent"),
            "choices": [
                {
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finish_reason,
                }
            ],
        }

    def _usage_chunk(self, request: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": "chatcmpl-momo-004-mock",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": request.get("model", "hermes-agent"),
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "prompt_tokens_details": {"cached_tokens": 0},
                "completion_tokens_details": {"reasoning_tokens": 0},
            },
        }

    def _non_stream_response(self, request: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": "chatcmpl-momo-004-mock",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.get("model", "hermes-agent"),
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": MOCK_TEXT,
                        "tool_calls": [
                            {
                                "id": "call_momo_201_search",
                                "type": "function",
                                "function": {
                                    "name": "github.search_issues",
                                    "arguments": json.dumps(
                                        MOCK_TOOL_ARGS,
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                    ),
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
            },
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8088)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), MockHermesHandler)
    print(f"[mock-hermes] listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
