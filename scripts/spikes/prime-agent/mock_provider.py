#!/usr/bin/env python3
"""Loopback OpenAI-Chat-Completions mock — the spike's credential-free provider.

Why this exists: prime-agent refuses `prompt` with "No API key found for the
selected model." (spike doc §2), and the packet forbids injecting API keys. A
custom provider in ~/.prime/agent/models.json can point at any OpenAI-compatible
baseUrl, so a scripted local server gets us the *whole* RPC surface — streaming
deltas, tool execution, steering delivery, extension UI — with zero credentials
and zero egress. What it cannot tell us is model quality; that is not what this
spike measures.

It also keeps a request log: every /v1/chat/completions body is appended to
$MOCK_REQUEST_LOG as JSONL. That log is the evidence for "did the steering
message actually reach the next LLM call".

Scenarios (env MOCK_SCENARIO):
  text        one assistant turn, streamed text only
  tool        turn 1 calls the `ipython` tool (sleeps, so there is a window to
              steer into), turn 2+ streams text
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MOCK_PORT", "8099"))
SCENARIO = os.environ.get("MOCK_SCENARIO", "text")
REQUEST_LOG = os.environ.get("MOCK_REQUEST_LOG", "/work/out/mock-requests.jsonl")
MODEL_ID = os.environ.get("MOCK_MODEL_ID", "spike-mock-1")
# Seconds the scripted ipython cell sleeps — the steering window.
TOOL_SLEEP = os.environ.get("MOCK_TOOL_SLEEP", "6")

_turn = {"n": 0}


def _sse(payload: dict) -> bytes:
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


def _chunk(delta: dict, finish: str | None = None) -> dict:
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:12],
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # keep stdout clean for the RPC transcript
        pass

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            body = json.dumps(
                {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]}
            ).encode()
            self._send(200, body, "application/json")
            return
        self._send(404, b'{"error":"not found"}', "application/json")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._send(400, b'{"error":"bad json"}', "application/json")
            return

        _turn["n"] += 1
        turn = _turn["n"]
        self._record(turn, req)

        if not req.get("stream"):
            # Non-streaming path (used by compaction/title helpers).
            body = json.dumps(
                {
                    "id": "chatcmpl-" + uuid.uuid4().hex[:12],
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": MODEL_ID,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "mock-nonstream"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            ).encode()
            self._send(200, body, "application/json")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        if (SCENARIO == "tool" and turn == 1) or (SCENARIO == "tool2" and turn <= 2):
            # tool2 fires a second cell so cold-kernel vs warm-kernel latency
            # can be read off one transcript.
            self._stream_tool_call()
        else:
            self._stream_text(turn, req)

    # --- streaming bodies -------------------------------------------------

    def _stream_text(self, turn: int, req: dict) -> None:
        last_user = ""
        for msg in reversed(req.get("messages", [])):
            if msg.get("role") == "user":
                content = msg.get("content")
                last_user = (
                    content
                    if isinstance(content, str)
                    else " ".join(
                        c.get("text", "") for c in content or [] if isinstance(c, dict)
                    )
                )
                break
        if SCENARIO == "long":
            # ~4 KB at a plausible token cadence, to measure how many REST
            # writes a single assistant answer would cost with and without
            # delta buffering.
            body = " ".join(
                f"segment-{i:03d} the quick brown fox jumps over the lazy dog."
                for i in range(64)
            )
            text = f"[mock turn {turn}] {body}"
        else:
            text = f"[mock turn {turn}] echo: {last_user.strip()[:200]}"
        self._write(_sse(_chunk({"role": "assistant", "content": ""})))
        # Deliberately chunked small so the adapter's delta buffering is exercised.
        for i in range(0, len(text), 7):
            self._write(_sse(_chunk({"content": text[i : i + 7]})))
            time.sleep(0.02)
        self._write(_sse(_chunk({}, finish="stop")))
        self._write(b"data: [DONE]\n\n")
        self._write(b"0\r\n\r\n", raw=True)

    def _stream_tool_call(self) -> None:
        code = (
            f"import time\nprint('spike: cell start')\n"
            f"time.sleep({TOOL_SLEEP})\nprint('spike: cell done')\n"
        )
        args = json.dumps({"code": code})
        call_id = "call_" + uuid.uuid4().hex[:10]
        self._write(_sse(_chunk({"role": "assistant", "content": ""})))
        self._write(
            _sse(
                _chunk(
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": call_id,
                                "type": "function",
                                "function": {"name": "ipython", "arguments": ""},
                            }
                        ]
                    }
                )
            )
        )
        for i in range(0, len(args), 24):
            self._write(
                _sse(
                    _chunk(
                        {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": args[i : i + 24]},
                                }
                            ]
                        }
                    )
                )
            )
            time.sleep(0.02)
        self._write(_sse(_chunk({}, finish="tool_calls")))
        self._write(b"data: [DONE]\n\n")
        self._write(b"0\r\n\r\n", raw=True)

    # --- plumbing ---------------------------------------------------------

    def _write(self, data: bytes, raw: bool = False) -> None:
        try:
            if raw:
                self.wfile.write(data)
            else:
                self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self, turn: int, req: dict) -> None:
        os.makedirs(os.path.dirname(REQUEST_LOG), exist_ok=True)
        entry = {
            "turn": turn,
            "ts": time.time(),
            "stream": bool(req.get("stream")),
            "tools": [
                t.get("function", {}).get("name") for t in req.get("tools", []) or []
            ],
            "messages": [
                {
                    "role": m.get("role"),
                    "content": _short(m.get("content")),
                    "tool_calls": [
                        c.get("function", {}).get("name")
                        for c in m.get("tool_calls", []) or []
                    ],
                }
                for m in req.get("messages", [])
            ],
        }
        with open(REQUEST_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _short(content, limit: int = 400):
    if isinstance(content, str):
        return content[:limit]
    if isinstance(content, list):
        return [
            (c.get("text", "")[:limit] if isinstance(c, dict) else str(c)[:limit])
            for c in content
        ]
    return content


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mock provider on 127.0.0.1:{PORT} scenario={SCENARIO}", file=sys.stderr)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
