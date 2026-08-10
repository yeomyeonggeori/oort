#!/usr/bin/env python3
"""Loopback OpenAI-Chat-Completions mock — the adapter's credential-free provider.

Promoted in behaviour from `scripts/spikes/prime-agent/mock_provider.py`
(#1120/#1130), which stays in place as the measurement record. Here it is a
fixture with a job: this adapter and its image are exercised end to end without
a single provider credential, which is ADR-0004 turned into something a gate can
run.

Why it is needed at all: prime-agent refuses `prompt` with "No API key found for
the selected model." (spike doc §2), and no provider key may be injected. A
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
  cell        turn 1 calls `ipython` with code supplied verbatim by the host in
              $MOCK_CELL_CODE, turn 2+ streams text. Used by the tenancy probe
              (#1130 ③): the only way to reach `rlm.harness` — the harness store
              the *kernel* can write — is through a real kernel cell.

`/refine` (#1130 ②) does not stream: it goes through `completeSimple` and needs a
parseable JSON proposal back, so the non-streaming path answers a refinement
request with a real `RefinementProposal` (see `_refinement_proposal`). Without
that the command errors out on parsing and we would only ever be measuring the
error path, not the audit surface.

## Two refine passes, not one — and why that used to be silent (#1194)

The *automatic* refine path makes **two** LLM calls, and both carry
`<current_harness_state>`:

1. the **review gate** (`reviewAutoRefine`), which must be answered with
   `{"shouldRefine": true|false, ...}`;
2. the **plan** (`planRefinement`), which must be answered with a
   `RefinementProposal`.

Until #1194 this fixture keyed on `<current_harness_state>` alone and returned a
proposal to both. `parseAutoRefineReview` reads a proposal as
`shouldRefine !== true`, so it declined — **every automatic refinement, silently,
without an error anywhere** (실측 §4.5). A regression test written against that
fixture is green because nothing ran, which is the worst shape a test can have:
it reports on a path it never reached.

The two passes are told apart by what only the review has — upstream's own
`AUTO_REFINE_REVIEW_SYSTEM_PROMPT` sentence, and the `<trigger>` block naming
`turn_interval` or `compact`. Either marker is enough, so a reworded system
prompt on the next version bump does not silently return this fixture to
declining everything. If upstream drops both, the review branch stops matching
and `MOCK_AUTO_REFINE_REVIEW=reject`'s counterpart assertion fails — which is the
point of keeping a reverse control.
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
REQUEST_LOG = os.environ.get("MOCK_REQUEST_LOG", "")
# Per-pass tallies (`agent` / `review` / `plan`) as JSON. This is how a caller
# proves the automatic path's *gate* ran, rather than inferring it from the
# announcement it was trying to test.
PASS_LOG = os.environ.get("MOCK_PASS_LOG", "")
MODEL_ID = os.environ.get("MOCK_MODEL_ID", "oort-mock-1")
# Seconds the scripted ipython cell sleeps — the steering window.
TOOL_SLEEP = os.environ.get("MOCK_TOOL_SLEEP", "6")
# Verbatim cell body for MOCK_SCENARIO=cell.
CELL_CODE = os.environ.get("MOCK_CELL_CODE", "print('spike: empty cell')")
# Harness id the scripted /refine proposal creates, so the caller can assert on it.
REFINE_ENTRY_ID = os.environ.get("MOCK_REFINE_ENTRY_ID", "oort-refine-probe")
# How the automatic refine review gate answers: approve (default) or reject.
# `reject` is the reverse control — same run, gate closed, zero refinements — and
# it is what proves an approved run measured the gate rather than bypassing it.
AUTO_REFINE_REVIEW = os.environ.get("MOCK_AUTO_REFINE_REVIEW", "approve").strip().lower()

# Markers that identify the automatic review gate's LLM pass. Upstream spellings,
# copied from `dist/core/refinement/refinement.js` v0.7.0:
# `AUTO_REFINE_REVIEW_SYSTEM_PROMPT` and `reviewAutoRefine`'s user prompt.
REVIEW_GATE_MARKERS = ("automatic /refine review gate", "<trigger>")
# The marker every refine-family pass carries — review and plan both.
REFINE_PASS_MARKER = "<current_harness_state>"

_turn = {"n": 0}
#: Which passes this process has answered, for the caller that wants to assert
#: the gate actually ran. Written to $MOCK_PASS_LOG on every request.
_passes: dict[str, int] = {}


def _refinement_proposal() -> str:
    """A minimal, valid `RefinementProposal` for the `/refine` LLM pass.

    Shape from `dist/core/refinement/refinement.d.ts`. One `create` edit is
    enough: the audit question is not *what* a refinement decides, it is whether
    the host can see that one happened at all.
    """
    return json.dumps(
        {
            "summary": "spike: record a tenancy marker",
            "rationale": "Scripted by the oort prime adapter tests so /refine has a parseable proposal.",
            "expectedOutcome": "One memory entry exists in the harness state.",
            "edits": [
                {
                    "action": "create",
                    "kind": "memory",
                    "id": REFINE_ENTRY_ID,
                    "title": "oort refine probe",
                    "content": "Written by prime-agent /refine during an oort adapter test.",
                    "path": "general",
                    "reason": "audit probe",
                }
            ],
        }
    )


def _auto_refine_review() -> str:
    """The review gate's answer — the JSON `parseAutoRefineReview` reads.

    `shouldRefine` must be literally `true`; the parser treats anything else,
    including a perfectly good `RefinementProposal`, as a decline.
    """
    approve = AUTO_REFINE_REVIEW != "reject"
    return json.dumps(
        {
            "shouldRefine": approve,
            "rationale": (
                "Scripted by the oort prime adapter tests so the automatic path reaches /refine."
                if approve
                else "Scripted decline — the reverse control for the automatic refine gate."
            ),
            "instructions": "Record one probe entry." if approve else "",
        }
    )


def _classify(req: dict) -> str:
    """`review` | `plan` | `agent` — which of the harness's passes this is.

    `planRefinement` builds a user prompt containing `<current_harness_state>`;
    that marker is how a refinement pass is told apart from the other helpers
    without guessing. Measured: it arrives **streamed**, not on the non-streaming
    path, even though it goes through `completeSimple` — hence the check happens
    before the stream/non-stream branch.

    The review gate carries the same marker (#1194), so it is separated first by
    the two markers only it has. Getting this order wrong is not a slightly wrong
    answer, it is a fixture that silently declines every automatic refinement.
    """
    blob = json.dumps(req.get("messages", []), ensure_ascii=False)
    if any(marker in blob for marker in REVIEW_GATE_MARKERS):
        return "review"
    if REFINE_PASS_MARKER in blob:
        return "plan"
    return "agent"


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
        request_index = _turn["n"]

        pass_kind = _classify(req)
        _passes[pass_kind] = _passes.get(pass_kind, 0) + 1
        self._record(request_index, req, pass_kind)

        # Scenario branching counts **agent** passes only. Before the automatic
        # path could run, every request was an agent pass and the distinction did
        # not exist; now a review and a plan land between two agent turns, and a
        # shared counter would move `turn == 1` under the scenario that names it.
        turn = _passes.get("agent", 0)

        if pass_kind == "review":
            # The gate answers JSON on whichever transport it was asked on, and
            # never a proposal: a proposal here reads as `shouldRefine=false`.
            self._answer(req, _auto_refine_review())
            return
        if pass_kind == "plan":
            self._answer(req, _refinement_proposal())
            return

        if not req.get("stream"):
            self._answer(req, "mock-nonstream")
            return

        self._begin_stream()
        if (SCENARIO == "tool" and turn == 1) or (SCENARIO == "tool2" and turn <= 2):
            # tool2 fires a second cell so cold-kernel vs warm-kernel latency
            # can be read off one transcript.
            self._stream_tool_call()
        elif SCENARIO == "cell" and turn == 1:
            self._stream_tool_call(CELL_CODE)
        else:
            self._stream_text(turn, req)

    # --- transports -------------------------------------------------------

    def _answer(self, req: dict, content: str) -> None:
        """One exact payload, on whichever transport the caller asked for."""
        if req.get("stream"):
            self._begin_stream()
            self._stream_raw(content)
            return
        body = json.dumps(
            {
                "id": "chatcmpl-" + uuid.uuid4().hex[:12],
                "object": "chat.completion",
                "created": int(time.time()),
                "model": MODEL_ID,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        ).encode()
        self._send(200, body, "application/json")

    def _begin_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

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

    def _stream_raw(self, text: str) -> None:
        """Stream one exact payload — no chunking games, no framing prefix."""
        self._write(_sse(_chunk({"role": "assistant", "content": ""})))
        self._write(_sse(_chunk({"content": text})))
        self._write(_sse(_chunk({}, finish="stop")))
        self._write(b"data: [DONE]\n\n")
        self._write(b"0\r\n\r\n", raw=True)

    def _stream_tool_call(self, code: str | None = None) -> None:
        if code is None:
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

    def _record(self, turn: int, req: dict, pass_kind: str = "agent") -> None:
        if PASS_LOG:
            # Written on every request, not at exit: the harness is killed by its
            # own entrypoint trap and an at-exit dump would be the file that is
            # missing exactly when a run failed.
            os.makedirs(os.path.dirname(os.path.abspath(PASS_LOG)), exist_ok=True)
            with open(PASS_LOG, "w", encoding="utf-8") as fh:
                json.dump(dict(_passes), fh)
        if not REQUEST_LOG:
            return
        os.makedirs(os.path.dirname(os.path.abspath(REQUEST_LOG)), exist_ok=True)
        entry = {
            "turn": turn,
            "pass": pass_kind,
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
