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
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


MOCK_TEXT = "김인턴 mock reply: MOMO-004 SSE path verified."

# MOMO-302: opt-in request capture. When MOCK_HERMES_REQUEST_DUMP=<path> is set,
# each received /v1/chat/completions body is appended as one JSON line so
# verifiers can assert the assembled chat array (roles, history, budgeting).
# Disabled by default — never writes anything unless the env var is present.
REQUEST_DUMP_PATH = os.environ.get("MOCK_HERMES_REQUEST_DUMP") or None
EVENT_DELAY_SECONDS = float(os.environ.get("MOCK_HERMES_EVENT_DELAY_SECONDS", "0.05"))
MOCK_TOOL_ARGS = {
    "repo": "Dawn-kim-official/momo",
    "query": "MOMO-201 live tool-call fixture",
    "limit": 2,
}
EQUIVALENCE_TOOL_ARGS = {"message": "MOMO-352 approved hello"}
UUID_PATTERN = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

# ---- MAESTRO-1 lane directives ----------------------------------------------
#
# The phone lane (clients/mobile/scripts/lane-phone.sh) needs two shapes of turn
# that the existing knobs can only produce PROCESS-WIDE, which is useless here:
# `MOCK_HERMES_TOOL_CALLS` and `MOCK_HERMES_EVENT_DELAY_SECONDS` are read once at
# import (lines 31-32), so a lane that wants a text-only turn in one flow and an
# approval-pausing turn in the next would have to restart the container between
# them — inside a run whose whole point is to be one command.
#
# So the lane steers per-request, through the channel the fixture already uses
# for tool selection: a marker in the message the person sends. `_tool_fixture`
# has read the prompt since MOMO-352; these two read the same string.
#
#   "MAESTRO TEXT"  -> this turn emits text deltas and NO tool_call, so it ends
#                      in a durable channel message instead of an approval pause
#                      (flows 10-mention-working and 20-stop).
#   "MAESTRO SLOW"  -> this turn sleeps MAESTRO_SLOW_SECONDS between events
#                      instead of EVENT_DELAY_SECONDS, so 「작업 중」 is on screen
#                      long enough to be asserted, and 20-stop has a live turn to
#                      interrupt. Without it, a default turn is ~0.2s end to end
#                      and the indicator is gone before Maestro can look.
#
# Both are inert when the marker is absent: a request that carries neither takes
# byte-identical paths to before. Every existing verifier sends neither.
MAESTRO_TEXT_MARKER = "MAESTRO TEXT"
MAESTRO_SLOW_MARKER = "MAESTRO SLOW"
MAESTRO_SLOW_SECONDS = float(
    os.environ.get("MOCK_HERMES_MAESTRO_SLOW_SECONDS", "2.0")
)


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

        _, tool_name, _ = self._tool_fixture(request)
        # MAESTRO-1: per-request overrides, all absent from every other caller.
        text_only, delay, slow = self._maestro_directives(request)
        chunks = [] if tool_name.startswith("work_") else [
            "김인턴 mock reply: ",
            "MOMO-004 SSE ",
            "path verified.",
        ]
        # A lead-in pause BEFORE the first token, only under `MAESTRO SLOW`.
        #
        # This is what makes the literal 「작업 중」 observable, and it took a
        # hierarchy dump to find out why it wasn't. The client's activity line
        # (packages/momo-core/.../turnCopy.ts activityText) reads "김인턴이 작업 중"
        # only while the turn has NO headline yet; the moment the first delta
        # lands it becomes "김인턴: <streamed text>". Streaming immediately meant
        # the phrase the lane is supposed to assert never rendered at all — the
        # bar was up the whole time saying something else.
        if slow:
            time.sleep(delay)
        for chunk in chunks:
            self._write_event(self._stream_chunk(request, content=chunk))
            time.sleep(delay)

        # MOMO-565 리허설 검출: 528 fail-closed 이후 grant가 시드되지 않은 스택에서
        # tool_call은 승인 대기로 멈춘다. 순수 텍스트 왕복만 검증하는 스모크는
        # MOCK_HERMES_TOOL_CALLS=0으로 툴콜 방출을 끈다(기본 1 = 기존 동작).
        # MAESTRO-1: `MAESTRO TEXT` does the same thing for ONE request.
        if os.environ.get("MOCK_HERMES_TOOL_CALLS", "1") != "0" and not text_only:
            self._write_event(self._tool_call_chunk(request, arguments_prefix=True))
            time.sleep(delay)
            self._write_event(self._tool_call_chunk(request, arguments_prefix=False))
            time.sleep(delay)
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
        tool_id, tool_name, tool_args = self._tool_fixture(request)
        args = json.dumps(tool_args, ensure_ascii=False, separators=(",", ":"))
        delta: dict[str, Any]
        if arguments_prefix:
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": tool_id,
                        "type": "function",
                        "function": {
                            "name": tool_name,
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

    @staticmethod
    def _combined_prompt(request: dict[str, Any]) -> str:
        messages = request.get("messages") or []
        return "\n".join(
            str(message.get("content") or "")
            for message in messages
            if isinstance(message, dict)
        )

    @staticmethod
    def _latest_user_content(request: dict[str, Any]) -> str:
        """The content of the last `user` message, or the last message at all.

        MAESTRO-1 markers are read from HERE and not from the concatenated
        prompt `_tool_fixture` uses, because the server sends recent channel
        history with every turn (MessageRoutes `recent_messages`). Scanning the
        whole prompt means one `MAESTRO TEXT` message poisons every later turn
        in that channel: the marker is still in the context window, so a turn
        that was supposed to make a tool call silently keeps returning plain
        text. That cost a green-looking 30-approval that never produced an
        approval at all.
        """
        messages = request.get("messages") or []
        for message in reversed(messages):
            if not isinstance(message, dict):
                continue
            if message.get("role") == "user":
                return str(message.get("content") or "")
        for message in reversed(messages):
            if isinstance(message, dict):
                return str(message.get("content") or "")
        return ""

    def _maestro_directives(self, request: dict[str, Any]) -> tuple[bool, float, bool]:
        """MAESTRO-1 per-request overrides.

        Returns (suppress tool_call, event delay, slow) — the process defaults
        unless the marker is in THIS turn's prompt, so a request from any other
        caller is unaffected.
        """
        latest = self._latest_user_content(request)
        text_only = MAESTRO_TEXT_MARKER in latest
        slow = MAESTRO_SLOW_MARKER in latest
        delay = MAESTRO_SLOW_SECONDS if slow else EVENT_DELAY_SECONDS
        return text_only, delay, slow

    def _tool_fixture(
        self, request: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any]]:
        combined = self._combined_prompt(request)
        channel_match = re.search(
            rf"current channel UUID is ({UUID_PATTERN})", combined, re.IGNORECASE
        )
        input_match = re.search(
            rf"MOMO-486 INPUT session=({UUID_PATTERN}) text=([^\n]+)",
            combined,
            re.IGNORECASE,
        )
        if input_match:
            return (
                "call_momo_486_input",
                "work_input",
                {
                    "session_id": input_match.group(1),
                    "text": input_match.group(2).strip(),
                },
            )
        if "MOMO-486 SPAWN" in combined and channel_match:
            return (
                "call_momo_486_spawn",
                "work_spawn",
                {
                    "tool": "codex",
                    "label": "MOMO-486 agent spawned session",
                    "channel": channel_match.group(1),
                },
            )
        if "MOMO-352" in combined:
            return "call_momo_352_echo", "momo.mock.echo", EQUIVALENCE_TOOL_ARGS
        return "call_momo_201_search", "github.search_issues", MOCK_TOOL_ARGS

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
        tool_id, tool_name, tool_args = self._tool_fixture(request)
        content = None if tool_name.startswith("work_") else MOCK_TEXT
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
                        "content": content,
                        "tool_calls": [
                            {
                                "id": tool_id,
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": json.dumps(
                                        tool_args,
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
