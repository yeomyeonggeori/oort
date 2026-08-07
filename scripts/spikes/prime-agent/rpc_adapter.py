#!/usr/bin/env python3
"""Spike #1120 — prime-agent `--mode rpc` ⇄ oort adapter prototype.

Shape under test (ADR-0154 D5-⑴):

    prime-agent --mode rpc            (inside a container — NOT a sandbox)
        stdout JSONL ──► JsonlRpc ──► DeltaBuffer ──► Sink
                                                       ├─ RestSink  → POST /v1/.../messages
                                                       └─ FileSink  → out/relay.jsonl (dry run)
        stdin  JSONL ◄── prompt / steer / extension_ui_response

Invariants this prototype is written to respect (CLAUDE.md hard rules):
  * single write path — the adapter only ever speaks REST. It never publishes to
    Centrifugo and never touches Postgres. `seq` is whatever the server returns.
  * delta buffering — token deltas are coalesced into time/size-bounded flushes,
    because one REST write per `text_delta` would be a write amplification bomb
    (the mock alone emits a delta per 7 characters).
  * ADR-0004 — no provider credential is read, stored, or forwarded. The oort
    bearer token is ours, not the model provider's.

Not production code. It exists to answer "does the surface work and what would
the real adapter have to own".
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import hashlib
from dataclasses import dataclass, field
from typing import Any, Callable


# --------------------------------------------------------------------------
# JSONL transport
# --------------------------------------------------------------------------


class JsonlRpc:
    """stdin/stdout JSONL client for `prime-agent --mode rpc`.

    Framing follows docs/rpc.md: split on LF only, strip one trailing CR. A
    generic line reader is wrong here — Python's iteration over a text stream is
    LF-based and safe, but we read bytes and split manually so U+2028/U+2029
    inside JSON strings can never be mistaken for record separators.
    """

    def __init__(self, argv: list[str], env: dict[str, str] | None = None, cwd: str | None = None):
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
        )
        self.inbox: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self.raw_lines: list[str] = []
        self.stderr_lines: list[str] = []
        self._lock = threading.Lock()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        buf = b""
        while True:
            chunk = self.proc.stdout.read(1)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.endswith(b"\r"):
                    line = line[:-1]
                if not line.strip():
                    continue
                text = line.decode("utf-8", "replace")
                self.raw_lines.append(text)
                try:
                    self.inbox.put(json.loads(text))
                except json.JSONDecodeError:
                    self.inbox.put({"type": "__unparsed__", "raw": text})
        self.inbox.put({"type": "__eof__"})

    def _read_stderr(self) -> None:
        for line in self.proc.stderr:
            self.stderr_lines.append(line.decode("utf-8", "replace").rstrip("\n"))

    def send(self, cmd: dict[str, Any]) -> None:
        payload = json.dumps(cmd, ensure_ascii=False) + "\n"
        with self._lock:
            self.proc.stdin.write(payload.encode("utf-8"))
            self.proc.stdin.flush()

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


# --------------------------------------------------------------------------
# Sinks — the only write path
# --------------------------------------------------------------------------


class FileSink:
    """Dry-run sink: records what would have been POSTed."""

    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.count = 0

    def send(self, kind: str, body: str, props: dict[str, str]) -> dict[str, Any]:
        self.count += 1
        rec = {
            "n": self.count,
            "ts": time.time(),
            "type": kind,
            "clientMsgId": str(uuid.uuid4()),
            "body": body,
            "props": props,
        }
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return {"sink": "file", "ok": True, "n": self.count}


class RestSink:
    """Real relay leg: POST /v1/workspaces/{ws}/channels/{ch}/messages.

    `clientMsgId` is the idempotency key (L4 §3.1) — a retried flush must not
    produce a second message. The server owns `seq`; the adapter never invents
    ordering.
    """

    def __init__(self, base_url: str, workspace: str, channel: str, token: str, mirror: str | None = None):
        self.url = f"{base_url.rstrip('/')}/v1/workspaces/{workspace}/channels/{channel}/messages"
        self.token = token
        self.mirror = FileSink(mirror) if mirror else None
        self.count = 0

    def send(self, kind: str, body: str, props: dict[str, str]) -> dict[str, Any]:
        self.count += 1
        payload = {
            "clientMsgId": str(uuid.uuid4()),
            "type": kind,
            "body": body,
            "props": props,
        }
        if self.mirror:
            self.mirror.send(kind, body, props)
        req = urllib.request.Request(
            self.url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return {"sink": "rest", "ok": True, "status": resp.status, "seq": data.get("seq"), "id": data.get("id")}
        except urllib.error.HTTPError as exc:
            return {"sink": "rest", "ok": False, "status": exc.code, "error": exc.read().decode("utf-8", "replace")[:400]}
        except Exception as exc:  # network/DNS/etc — recorded, not swallowed
            return {"sink": "rest", "ok": False, "error": f"{type(exc).__name__}: {exc}"}


# --------------------------------------------------------------------------
# Delta buffering
# --------------------------------------------------------------------------


@dataclass
class DeltaBuffer:
    """Coalesce `text_delta` into bounded flushes.

    Policy: flush when the pending text crosses `max_chars`, or `max_interval`
    seconds have passed since the first pending delta, or the message ends.
    A real implementation would additionally edit-in-place the last message
    instead of appending; that needs a message-edit contract and is out of
    spike scope — recorded as a gap in the spike doc.
    """

    sink: Any
    max_chars: int = 220
    max_interval: float = 0.8
    pending: str = ""
    first_ts: float | None = None
    flushes: list[dict[str, Any]] = field(default_factory=list)
    delta_count: int = 0

    def add(self, delta: str) -> None:
        self.delta_count += 1
        if self.first_ts is None:
            self.first_ts = time.time()
        self.pending += delta
        if len(self.pending) >= self.max_chars or (time.time() - self.first_ts) >= self.max_interval:
            self.flush("policy")

    def flush(self, reason: str) -> None:
        if not self.pending.strip():
            self.pending = ""
            self.first_ts = None
            return
        result = self.sink.send("text", self.pending, {"harness": "prime-agent", "flush": reason})
        self.flushes.append({"reason": reason, "chars": len(self.pending), "result": result})
        self.pending = ""
        self.first_ts = None


# --------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------


class Adapter:
    def __init__(self, rpc: JsonlRpc, sink: Any, ui_policy: str, transcript_path: str):
        self.rpc = rpc
        self.sink = sink
        self.buffer = DeltaBuffer(sink=sink)
        self.ui_policy = ui_policy  # approve | deny | cancel | none
        self.transcript_path = transcript_path
        self.events: list[dict[str, Any]] = []
        self.ui_requests: list[dict[str, Any]] = []
        self.agent_ended = threading.Event()
        self.tool_started = threading.Event()
        self.observed: dict[str, int] = {}
        # Every inbound record, in arrival order, with only its type and (for
        # `response`) which command it answers. This is the instrument for the
        # #1130 ② audit question: "does a harness self-modification produce any
        # protocol output at all?" A per-type counter cannot answer that,
        # because the answer is about a *window* in the stream.
        self.stream_log: list[dict[str, Any]] = []
        self.cell_output: list[str] = []

    def note(self, obj: dict[str, Any]) -> None:
        self.events.append({"ts": time.time(), **obj})

    def pump(self, deadline: float) -> None:
        """Drain events until agent_end or deadline."""
        while time.time() < deadline:
            try:
                ev = self.rpc.inbox.get(timeout=0.2)
            except queue.Empty:
                # Time-based flush still has to happen when no delta arrives.
                if self.buffer.first_ts and (time.time() - self.buffer.first_ts) >= self.buffer.max_interval:
                    self.buffer.flush("idle")
                continue
            self.handle(ev)
            if ev.get("type") == "__eof__":
                return
            if ev.get("type") == "agent_end":
                return

    def handle(self, ev: dict[str, Any]) -> None:
        etype = ev.get("type", "?")
        self.observed[etype] = self.observed.get(etype, 0) + 1
        self.stream_log.append(
            {"ts": time.time(), "type": etype, **({"command": ev["command"]} if "command" in ev else {})}
        )

        if etype == "response":
            self.note({"kind": "response", "command": ev.get("command"), "success": ev.get("success"), "error": ev.get("error")})
            return

        if etype == "message_update":
            ame = ev.get("assistantMessageEvent") or {}
            if ame.get("type") == "text_delta":
                self.buffer.add(ame.get("delta", ""))
            elif ame.get("type") == "text_end":
                self.buffer.flush("text_end")
            return

        if etype == "tool_execution_start":
            self.tool_started.set()
            self.buffer.flush("tool_start")
            self.sink.send(
                "tool_call",
                f"{ev.get('toolName')}",
                {
                    "harness": "prime-agent",
                    "toolCallId": str(ev.get("toolCallId")),
                    "args": json.dumps(ev.get("args"), ensure_ascii=False)[:800],
                },
            )
            self.note({"kind": "tool_start", "tool": ev.get("toolName")})
            return

        if etype == "tool_execution_update":
            # Progress text only — deliberately NOT relayed. One REST write per
            # partial tool output is the same write-amplification mistake as
            # per-token relay; the buffered flush belongs here too if we ever
            # want live tool output in-channel.
            partial = ev.get("partialResult") or {}
            text = " ".join(c.get("text", "") for c in partial.get("content", []) if isinstance(c, dict))
            self.note({"kind": "tool_update", "status": (partial.get("details") or {}).get("status"), "text": text[:200]})
            return

        if etype == "tool_execution_end":
            result = ev.get("result") or {}
            text = " ".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict))
            self.cell_output.append(text)
            self.sink.send(
                "tool_result",
                text[:2000],
                {"harness": "prime-agent", "toolCallId": str(ev.get("toolCallId")), "isError": str(bool(ev.get("isError"))).lower()},
            )
            self.note({"kind": "tool_end", "tool": ev.get("toolName"), "isError": ev.get("isError")})
            return

        if etype == "extension_ui_request":
            self.handle_ui(ev)
            return

        if etype == "agent_end":
            self.buffer.flush("agent_end")
            self.agent_ended.set()
            self.note({"kind": "agent_end"})
            return

        if etype in ("session_action_update",):
            self.note({"kind": "session_action_update", "actions": ev.get("actions")})
            return

        if etype == "__eof__":
            self.buffer.flush("eof")
            self.note({"kind": "eof"})
            return

    def handle_ui(self, ev: dict[str, Any]) -> None:
        """extension_ui_request → oort approval card (ADR-0125 D6-A shape).

        Dialog methods (select/confirm/input/editor) block the agent until an
        `extension_ui_response` with the same id comes back — which is exactly
        the approval-card contract we already have (`type: approval_request`).
        Fire-and-forget methods (notify/setStatus/setWidget/setTitle/
        set_editor_text) must NOT be answered.
        """
        method = ev.get("method")
        dialog = method in ("select", "confirm", "input", "editor")
        self.ui_requests.append({"method": method, "dialog": dialog, "raw": ev})
        self.buffer.flush("ui_request")

        card = {
            "harness": "prime-agent",
            "uiMethod": str(method),
            "uiRequestId": str(ev.get("id")),
            "dialog": str(dialog).lower(),
        }
        for key in ("title", "message", "placeholder", "prefill", "notifyType", "statusText"):
            if ev.get(key) is not None:
                card[key] = str(ev[key])
        if ev.get("options") is not None:
            card["options"] = json.dumps(ev["options"], ensure_ascii=False)
        if ev.get("timeout") is not None:
            card["timeoutMs"] = str(ev["timeout"])

        self.sink.send("approval_request" if dialog else "system", str(ev.get("title") or ev.get("message") or method), card)
        self.note({"kind": "ui_request", "method": method, "dialog": dialog, "timeout": ev.get("timeout")})

        if not dialog or self.ui_policy == "none":
            return

        # Decision. In the real product this is a human tapping the card; here a
        # fixed policy stands in so the run is deterministic.
        resp: dict[str, Any] = {"type": "extension_ui_response", "id": ev.get("id")}
        if self.ui_policy == "cancel":
            resp["cancelled"] = True
        elif method == "confirm":
            resp["confirmed"] = self.ui_policy == "approve"
        else:
            options = ev.get("options") or []
            if self.ui_policy == "approve" and options:
                resp["value"] = options[0]
            elif self.ui_policy == "deny" and options:
                resp["value"] = options[-1]
            else:
                resp["value"] = "spike-adapter"
        self.rpc.send(resp)
        self.note({"kind": "ui_response", "sent": resp})

    def dump(self, extra: dict[str, Any] | None = None) -> None:
        os.makedirs(os.path.dirname(self.transcript_path), exist_ok=True)
        with open(self.transcript_path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "eventCounts": self.observed,
                    "deltaCount": self.buffer.delta_count,
                    "flushes": self.buffer.flushes,
                    "uiRequests": self.ui_requests,
                    "notes": self.events,
                    "streamLog": self.stream_log,
                    "cellOutput": self.cell_output,
                    "stderr": self.rpc.stderr_lines[-40:],
                    **(extra or {}),
                },
                fh,
                ensure_ascii=False,
                indent=2,
            )


# --------------------------------------------------------------------------
# Harness state observation (#1130 ②)
# --------------------------------------------------------------------------


def harness_snapshot() -> dict[str, Any]:
    """What a host can learn about harness self-modification — by looking at disk.

    There is no RPC event for it (`AgentEvent` has ten members and none of them
    is about the harness), so an adapter that wants an audit trail has to hash
    the file and diff. This function is that fallback, written down so the cost
    of the missing event is concrete rather than rhetorical.
    """
    agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.join(
        os.path.expanduser("~"), ".prime", "agent"
    )
    path = os.path.join(agent_dir, "harness", "harness_state.json")
    snap: dict[str, Any] = {"path": path, "exists": os.path.exists(path)}
    if not snap["exists"]:
        return snap
    with open(path, "rb") as fh:
        raw = fh.read()
    snap["sha256"] = hashlib.sha256(raw).hexdigest()
    snap["bytes"] = len(raw)
    try:
        state = json.loads(raw)
        snap["entryIds"] = sorted(
            eid for kind in (state.get("entries") or {}).values() for eid in (kind or {})
        )
        snap["refinementIds"] = [r.get("id") for r in state.get("refinements") or []]
    except json.JSONDecodeError:
        snap["parse"] = "failed"
    return snap


# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------


def build_sink(args) -> Any:
    if args.relay == "rest":
        if not (args.api_base and args.workspace and args.channel and args.token):
            raise SystemExit("relay=rest needs --api-base --workspace --channel --token")
        return RestSink(args.api_base, args.workspace, args.channel, args.token, mirror=f"{args.out}/relay.jsonl")
    return FileSink(f"{args.out}/relay.jsonl")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="text", choices=["text", "steer", "extension-ui", "nocreds", "refine"])
    ap.add_argument("--out", default="/work/out")
    ap.add_argument("--tag", help="transcript/artifact suffix; defaults to --scenario")
    ap.add_argument("--relay", default="file", choices=["file", "rest"])
    ap.add_argument("--api-base")
    ap.add_argument("--workspace")
    ap.add_argument("--channel")
    ap.add_argument("--token")
    ap.add_argument("--ui-policy", default="approve", choices=["approve", "deny", "cancel", "none"])
    ap.add_argument("--extension")
    ap.add_argument("--model", default="spike-mock/spike-mock-1")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--prompt", default="hello from oort")
    ap.add_argument("--steer-after", type=float, default=3.0)
    ap.add_argument("--steer-message", default="STEER: drop that and answer 42 instead")
    ap.add_argument(
        "--refine-global",
        action="store_true",
        help="refine scenario: ask for scope=global, i.e. the cross-workspace harness dir",
    )
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    tag = args.tag or args.scenario

    argv = ["prime-agent", "--mode", "rpc", "--no-session", "--offline"]
    if args.scenario != "nocreds":
        argv += ["--model", args.model]
    if args.extension:
        argv += ["-e", args.extension]

    workdir = os.environ.get("SPIKE_CWD") or ("/work" if os.path.isdir("/work") else os.getcwd())
    rpc = JsonlRpc(argv, env=dict(os.environ), cwd=workdir)
    sink = build_sink(args)
    adapter = Adapter(rpc, sink, args.ui_policy, f"{args.out}/transcript-{tag}.json")
    deadline = time.time() + args.timeout
    extra: dict[str, Any] = {}

    rpc.send({"id": "state-1", "type": "get_state"})
    time.sleep(0.5)
    drain_nonblocking(adapter)

    rpc.send({"id": "p-1", "type": "prompt", "message": args.prompt})

    if args.scenario == "steer":
        # Steer mid-flight: wait for the tool to actually start, so the steering
        # message lands in the window docs/rpc.md describes ("after the current
        # assistant turn finishes executing its tool calls, before the next LLM
        # call"). Steering before that window is a different test.
        t = threading.Thread(target=_steer_later, args=(rpc, adapter, args), daemon=True)
        t.start()

    adapter.pump(deadline)
    # Give queued steering/follow-up work a second lap.
    if args.scenario == "steer":
        adapter.pump(min(deadline, time.time() + 40))

    if args.scenario == "refine":
        extra = run_refine_probe(rpc, adapter, args, deadline)

    adapter.buffer.flush("final")
    rpc.close()
    adapter.dump(extra)
    summary = {
        "eventCounts": adapter.observed,
        "flushes": len(adapter.buffer.flushes),
        "uiRequests": len(adapter.ui_requests),
    }
    if extra:
        summary["refineAudit"] = extra.get("refineAudit")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


def run_refine_probe(rpc: JsonlRpc, adapter: Adapter, args, deadline: float) -> dict[str, Any]:
    """#1130 ② — invoke `refine` and measure what the *protocol* said about it.

    The measurement is the window: how many records arrive between sending the
    command and its own `response`, and how many of those are `AgentEvent`s. If
    the only trace of a harness mutation is the reply to the command that caused
    it, then anything that refines without a host command (auto-refine at
    `turnInterval`, at compaction, or a kernel-side `rlm.harness` write) is
    invisible to the host — which is the audit gap #1130 ② names.
    """
    before = harness_snapshot()
    mark = len(adapter.stream_log)
    sent_at = time.time()
    adapter.note({"kind": "refine_send", "global": bool(args.refine_global)})
    cmd: dict[str, Any] = {"id": "refine-1", "type": "refine"}
    if args.refine_global:
        cmd["global"] = True
    rpc.send(cmd)

    response: dict[str, Any] | None = None
    window_deadline = min(deadline, time.time() + 90)
    while time.time() < window_deadline and response is None:
        try:
            ev = rpc.inbox.get(timeout=0.2)
        except queue.Empty:
            continue
        adapter.handle(ev)
        if ev.get("type") == "response" and ev.get("command") == "refine":
            response = {
                "success": ev.get("success"),
                "error": ev.get("error"),
                "data": ev.get("data"),
            }
        if ev.get("type") == "__eof__":
            break

    after = harness_snapshot()
    window = adapter.stream_log[mark:]
    agent_events = [
        r
        for r in window
        if r["type"] not in ("response", "__eof__", "__unparsed__", "extension_ui_request")
    ]
    return {
        "refineAudit": {
            "sentAt": sent_at,
            "responded": response is not None,
            "response": response,
            "recordsInWindow": [r["type"] for r in window],
            "agentEventsInWindow": [r["type"] for r in agent_events],
            "agentEventCount": len(agent_events),
            "harnessBefore": before,
            "harnessAfter": after,
            "harnessChanged": before.get("sha256") != after.get("sha256"),
        }
    }


def _steer_later(rpc: JsonlRpc, adapter: Adapter, args) -> None:
    started = adapter.tool_started.wait(timeout=args.steer_after + 20)
    time.sleep(0.5 if started else args.steer_after)
    adapter.note({"kind": "steer_send", "toolStarted": started})
    rpc.send({"id": "s-1", "type": "steer", "message": args.steer_message})


def drain_nonblocking(adapter: Adapter) -> None:
    while True:
        try:
            adapter.handle(adapter.rpc.inbox.get_nowait())
        except queue.Empty:
            return


if __name__ == "__main__":
    raise SystemExit(main())
