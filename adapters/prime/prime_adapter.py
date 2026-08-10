"""`PrimeAdapter` — the resident prime-agent ⇄ oort adapter (ADR-0158 D6).

Promoted from `scripts/spikes/prime-agent/rpc_adapter.py`, which stays where it
is as the measurement record. What the spike proved and this keeps: the harness
speaks JSONL on stdout, and every one of its facts maps onto a message oort
already has a type for. What the spike did **not** have and this adds:

* streaming as one growing message (#1152 + #1173 + ADR-0155) instead of one
  message per flush;
* a fixed `clientMsgId` per logical write, so a retry is not a duplicate (the
  spike's own §8 wrote this gap down);
* refinement announcements on both the RPC and the kernel path (`refine.py`);
* a run binding (`runId`) so a stream this adapter opened is one the server can
  close when this process dies.

## The event map

| prime record | oort |
|---|---|
| `message_update` / `text_delta` | buffered into the open stream |
| `message_update` / `text_end` | the stream's final slice |
| `tool_execution_start` | close the stream, then a `tool_call` message |
| `tool_execution_update` | transcript only — see below |
| `tool_execution_end` | a `tool_result` message |
| `extension_ui_request` (dialog) | an `approval_request` message, answered on stdin |
| `extension_ui_request` (fire-and-forget) | a `system` message, never answered |
| `compaction_end` (successful) | nothing said; the next automatic refinement is attributed to it |
| `refine_complete` | a `system` refinement announcement |
| `agent_end` / EOF | close whatever is open, then check the harness files |

`tool_execution_update` is deliberately not relayed. It is partial tool output,
it arrives at the same cadence as token deltas, and relaying it would be the
write-amplification mistake that buffering exists to avoid — with none of the
"the answer is arriving" value, because the tool's result is already a message.

## Endings

A turn ends three ways and the channel must be able to tell them apart:

* the text finished — final slice, no outcome;
* a human stopped it — final slice, `outcome: "cancelled"`;
* the producer died — final slice, `outcome: "failed"`. This is the case the
  adapter cannot always write itself (if the *adapter* is what died), and it is
  exactly why the opening POST carries a run binding: the server can then find
  the half-written message and mark it.

## Where a refinement came from (#1194)

`refine_complete` carries **no field naming its trigger** — not `reason`, not
`trigger` (실측 `research/2026-08-09-prime-auto-refine-measurement.md` §3.2), and
until #1194 this adapter answered that by writing `trigger: "command"` on every
one of them. Measured consequence: an automatic refinement told the channel a
person had asked for it, in all three measured automatic shapes.

The adapter cannot read the harness's `reason`, but it is not guessing either —
it knows two things the event does not carry:

1. **whether it asked.** A host `refine` command is in flight from the moment the
   transport writes it until its `response(command: "refine")` comes back, and
   `refine_complete` arrives *inside* that window (the event precedes its own
   response — spike-measured order, and `fake_prime` reproduces it). Outside the
   window nobody on this side asked, so the refinement is automatic.
2. **whether a compaction just carried one.** A successful `compaction_end`
   schedules exactly one compaction-triggered refinement
   (`_scheduleAutoRefineAfterCompaction`), immediately or deferred, so the next
   automatic refinement after one is that one.

Everything else automatic is `turn_interval`, which is prime's own name for the
on-by-default timer (`agent-session.js:2853` `_maybeAutoRefine("turn_interval")`)
and one of the four values ADR-0158 fixed on the wire.

Two residues, written down rather than papered over:

* if a compaction's review gate **declines**, no refinement follows it, and the
  pending attribution is spent by a later `turn_interval` one. Both are still
  honestly "automatic"; the finer word can be wrong.
* a refinement the agent starts itself from a kernel cell (`refine.run`, session-
  gated like the automatic path) is indistinguishable from `turn_interval` on
  stdout. Naming it would need a fifth `trigger` value, and that enum is a landed
  wire contract in two languages — an ADR-0158 amendment, not an adapter change.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .oort_client import OUTCOME_CANCELLED, OUTCOME_FAILED, OortClient, stable_key
from .refine import (
    TRIGGER_COMMAND,
    TRIGGER_COMPACT,
    TRIGGER_TURN_INTERVAL,
    HarnessObserver,
    RefineAnnouncer,
)
from .rpc import EOF_RECORD, UNPARSED_RECORD, JsonlRpc
from .stream_relay import StreamRelay

#: The harness-side name for a completed refinement. It is real and undocumented
#: (see `refine.py`), so it is spelled once and re-measured on every version bump.
REFINE_COMPLETE_EVENT = "refine_complete"
REFINE_FAILED_EVENT = "refine_failed"

#: The harness command whose in-flight window makes a refinement the host's.
REFINE_COMMAND = "refine"

#: Compaction's two events. Only the end matters here, and only a successful one:
#: an unsuccessful `compaction_end` carries `result: undefined`
#: (`_endCompactionUnsuccessfully`) and schedules no refinement at all, which is
#: measured as case G — *"Session is too short to compact"*, zero refine passes.
COMPACTION_END_EVENT = "compaction_end"

#: `extension_ui_request` methods that block the agent until the host answers.
#: The others (notify/setStatus/setWidget/setTitle/set_editor_text) must NOT be
#: answered — replying to one is a protocol error, not a harmless extra.
DIALOG_UI_METHODS = ("select", "confirm", "input", "editor")


@dataclass
class AdapterSettings:
    """Everything the adapter needs that is not a live object.

    Kept as data rather than read from `os.environ` inside the class so the tests
    can build one without touching the process environment — the same reason the
    hermes adapter has `MomoConfig`.
    """

    agent_handle: str = "prime"
    flush_chars: int = 220
    flush_interval: float = 0.8
    ui_policy: str = "none"  # approve | deny | cancel | none
    harness_state_path: str | None = None
    #: The session-artifacts root the automatic path writes under (#1194). `None`
    #: derives it from `harness_state_path`, which is what production wants; an
    #: explicit value exists for an operator whose layout is not prime's default.
    harness_local_root: str | None = None
    turn_timeout: float = 300.0


class PrimeAdapter:
    """One prime RPC session relayed into one oort channel."""

    def __init__(
        self,
        rpc: JsonlRpc,
        client: OortClient,
        settings: AdapterSettings | None = None,
        *,
        session_key: str | None = None,
        observer: HarnessObserver | None = None,
        announcer: RefineAnnouncer | None = None,
    ):
        self.rpc = rpc
        self.client = client
        self.settings = settings or AdapterSettings()
        # The stable half of every generated `clientMsgId`. The run id is the
        # right anchor when there is one: two adapter processes serving the same
        # run must not mint different keys for the same turn.
        self.session_key = session_key or client.run_id or stable_key("session", str(time.time()))
        self.observer = (
            observer
            if observer is not None
            else HarnessObserver(
                self.settings.harness_state_path,
                local_root=self.settings.harness_local_root,
            )
        )
        self.announcer = announcer or RefineAnnouncer(
            client, agent_handle=self.settings.agent_handle, observer=self.observer
        )

        self.stream: StreamRelay | None = None
        self.turn_index = 0
        self.event_counts: dict[str, int] = {}
        self.transcript: list[dict[str, Any]] = []
        self.ui_requests: list[dict[str, Any]] = []
        self.agent_ended = threading.Event()
        self.tool_started = threading.Event()
        self.cancelled = False
        self.ended_by_eof = False
        #: `response(command: "refine")` records seen. Compared against the
        #: transport's outbound tally, this is the in-flight window that makes a
        #: refinement the host's rather than the harness's own idea.
        self.refine_responses = 0
        #: A successful compaction whose scheduled refinement has not arrived yet.
        self.compaction_refine_pending = False

    # -- transcript --------------------------------------------------------

    def note(self, **fields: Any) -> None:
        self.transcript.append({"ts": time.time(), **fields})

    # -- stream ownership --------------------------------------------------

    def _open_stream(self) -> StreamRelay:
        if self.stream is None or self.stream.closed:
            self.turn_index += 1
            self.stream = StreamRelay(
                self.client,
                client_msg_id=stable_key(self.session_key, "turn", str(self.turn_index)),
                props={"harness": "prime-agent"},
                flush_chars=self.settings.flush_chars,
                flush_interval=self.settings.flush_interval,
            )
        return self.stream

    def _close_stream(self, reason: str, outcome: str | None = None) -> None:
        if self.stream is None or self.stream.closed:
            return
        wrote = self.stream.close(reason, outcome=outcome)
        self.note(
            kind="stream_close",
            reason=reason,
            outcome=outcome,
            wrote=wrote,
            rev=self.stream.rev,
            chars=len(self.stream.body),
        )

    # -- pump --------------------------------------------------------------

    def pump(self, deadline: float) -> None:
        """Drain the RPC inbox until `agent_end`, EOF, or the deadline."""
        while time.time() < deadline:
            try:
                record = self.rpc.inbox.get(timeout=0.2)
            except queue.Empty:
                if self.stream is not None and not self.stream.closed:
                    self.stream.tick()
                continue
            self.handle(record)
            record_type = record.get("type")
            if record_type == EOF_RECORD:
                return
            if record_type == "agent_end":
                return

    def drain(self) -> None:
        """Handle whatever is already queued, without waiting."""
        while True:
            try:
                self.handle(self.rpc.inbox.get_nowait())
            except queue.Empty:
                return

    # -- events ------------------------------------------------------------

    def handle(self, record: dict[str, Any]) -> None:
        record_type = str(record.get("type", "?"))
        self.event_counts[record_type] = self.event_counts.get(record_type, 0) + 1

        handler = {
            "response": self._on_response,
            "message_update": self._on_message_update,
            "tool_execution_start": self._on_tool_start,
            "tool_execution_update": self._on_tool_update,
            "tool_execution_end": self._on_tool_end,
            "extension_ui_request": self._on_ui_request,
            COMPACTION_END_EVENT: self._on_compaction_end,
            REFINE_COMPLETE_EVENT: self._on_refine_complete,
            REFINE_FAILED_EVENT: self._on_refine_failed,
            "agent_end": self._on_agent_end,
            "turn_end": self._on_turn_end,
            EOF_RECORD: self._on_eof,
            UNPARSED_RECORD: self._on_unparsed,
        }.get(record_type)
        if handler is None:
            self.note(kind="unhandled", type=record_type)
            return
        handler(record)

    def _on_response(self, record: dict[str, Any]) -> None:
        if record.get("command") == REFINE_COMMAND:
            # Closes the in-flight window opened by the transport's write. A
            # failed `refine` answers here too and emits no `refine_complete`, so
            # counting the response rather than the event is what keeps a failure
            # from leaving the window open over the next automatic refinement.
            self.refine_responses += 1
        self.note(
            kind="response",
            command=record.get("command"),
            success=record.get("success"),
            error=record.get("error"),
        )

    def _on_message_update(self, record: dict[str, Any]) -> None:
        event = record.get("assistantMessageEvent") or {}
        event_type = event.get("type")
        if event_type == "text_delta":
            self._open_stream().add(str(event.get("delta") or ""))
        elif event_type == "text_end":
            # The assistant message is complete. Closing here rather than at
            # `agent_end` is what makes one assistant message one channel
            # message: a turn that also calls tools produces several.
            self._close_stream("text_end")
        elif event_type == "error":
            # `docs/rpc.md`: reason is `"aborted"` or `"error"`. The two map onto
            # the two ADR-0155 outcomes exactly, and the mapping is the whole
            # reason to read this event: without it an aborted answer closes as
            # `failed` and the channel says the provider died when a person
            # pressed stop.
            reason = str(event.get("reason") or "error")
            outcome = OUTCOME_CANCELLED if reason == "aborted" else OUTCOME_FAILED
            self.cancelled = self.cancelled or outcome == OUTCOME_CANCELLED
            self._close_stream(f"message_error:{reason}", outcome=outcome)

    def _on_tool_start(self, record: dict[str, Any]) -> None:
        self.tool_started.set()
        self._close_stream("tool_start")
        tool_name = str(record.get("toolName") or "tool")
        call_id = str(record.get("toolCallId") or "")
        self.client.post_message(
            client_msg_id=stable_key(self.session_key, "tool_call", call_id or tool_name),
            message_type="tool_call",
            body=tool_name,
            props={
                "harness": "prime-agent",
                "toolCallId": call_id,
                "args": json.dumps(record.get("args"), ensure_ascii=False)[:800],
            },
        )
        self.note(kind="tool_start", tool=tool_name, toolCallId=call_id)

    def _on_tool_update(self, record: dict[str, Any]) -> None:
        partial = record.get("partialResult") or {}
        text = " ".join(
            chunk.get("text", "")
            for chunk in partial.get("content", [])
            if isinstance(chunk, dict)
        )
        self.note(
            kind="tool_update",
            status=(partial.get("details") or {}).get("status"),
            text=text[:200],
        )

    def _on_tool_end(self, record: dict[str, Any]) -> None:
        result = record.get("result") or {}
        text = " ".join(
            chunk.get("text", "") for chunk in result.get("content", []) if isinstance(chunk, dict)
        )
        call_id = str(record.get("toolCallId") or "")
        self.client.post_message(
            client_msg_id=stable_key(self.session_key, "tool_result", call_id or text[:32]),
            message_type="tool_result",
            body=text[:2000],
            props={
                "harness": "prime-agent",
                "toolCallId": call_id,
                "isError": bool(record.get("isError")),
            },
        )
        self.note(kind="tool_end", tool=record.get("toolName"), isError=record.get("isError"))

    def _on_ui_request(self, record: dict[str, Any]) -> None:
        method = record.get("method")
        dialog = method in DIALOG_UI_METHODS
        self.ui_requests.append({"method": method, "dialog": dialog})
        self._close_stream("ui_request")

        request_id = str(record.get("id") or "")
        props: dict[str, Any] = {
            "harness": "prime-agent",
            "uiMethod": str(method),
            "uiRequestId": request_id,
            "dialog": dialog,
        }
        for key in ("title", "message", "placeholder", "prefill", "notifyType", "statusText"):
            if record.get(key) is not None:
                props[key] = str(record[key])
        if record.get("options") is not None:
            props["options"] = record["options"]
        if record.get("timeout") is not None:
            props["timeoutMs"] = str(record["timeout"])

        self.client.post_message(
            client_msg_id=stable_key(self.session_key, "ui", request_id or str(method)),
            message_type="approval_request" if dialog else "system",
            body=str(record.get("title") or record.get("message") or method),
            props=props,
        )
        self.note(kind="ui_request", method=method, dialog=dialog)

        if not dialog or self.settings.ui_policy == "none":
            # A fire-and-forget method must not be answered, and `none` is the
            # honest v0 default: a human decision needs a read surface this
            # credential does not have (see README, "Approval decisions").
            return
        self.rpc.send(self._ui_response(record, method))

    def _ui_response(self, record: dict[str, Any], method: Any) -> dict[str, Any]:
        response: dict[str, Any] = {"type": "extension_ui_response", "id": record.get("id")}
        policy = self.settings.ui_policy
        if policy == "cancel":
            response["cancelled"] = True
            return response
        if method == "confirm":
            response["confirmed"] = policy == "approve"
            return response
        options = record.get("options") or []
        if options:
            response["value"] = options[0] if policy == "approve" else options[-1]
        else:
            response["value"] = "oort-prime-adapter"
        return response

    def _on_compaction_end(self, record: dict[str, Any]) -> None:
        # Only a compaction that actually compacted schedules a refinement. The
        # unsuccessful shape carries `result: undefined` and an `errorMessage`,
        # and an aborted one carries `aborted: true` — neither reaches
        # `_scheduleAutoRefineAfterCompaction`, so neither may claim the next
        # automatic refinement.
        compacted = bool(record.get("result")) and not record.get("aborted")
        if compacted:
            self.compaction_refine_pending = True
        self.note(
            kind="compaction_end",
            reason=record.get("reason"),
            compacted=compacted,
            error=record.get("errorMessage"),
        )

    def host_refine_in_flight(self) -> bool:
        """Is a `refine` command this host sent still unanswered?

        The transport counts what was written and this counts what was answered,
        so any caller's `refine` opens the window — including `adapter.py`'s own
        `rpc.send`, which does not go through this class.
        """
        return self.rpc.sent_counts.get(REFINE_COMMAND, 0) > self.refine_responses

    def refine_trigger(self) -> str:
        """What set this refinement off, from what the adapter actually knows.

        See the module docstring for why the event itself cannot answer this and
        what the two observations are. The compaction attribution is consumed
        here rather than at `compaction_end`, because a compaction's refinement
        can be deferred past several turns before it lands (실측 case G4).
        """
        if self.host_refine_in_flight():
            return TRIGGER_COMMAND
        if self.compaction_refine_pending:
            self.compaction_refine_pending = False
            return TRIGGER_COMPACT
        return TRIGGER_TURN_INTERVAL

    def _on_refine_complete(self, record: dict[str, Any]) -> None:
        result = record.get("result") or {}
        trigger = self.refine_trigger()
        announcement = self.announcer.announce_refine_complete(result, trigger=trigger)
        self.note(
            kind="refine_complete",
            trigger=trigger,
            scope=result.get("scope"),
            announced=announcement is not None,
            clientMsgId=(announcement or {}).get("clientMsgId"),
        )

    def _on_refine_failed(self, record: dict[str, Any]) -> None:
        # Nothing is announced: no harness change happened, so there is no fact
        # about the agent for the channel to carry. It stays in the transcript
        # because "the agent tried to change itself and could not" is an
        # operational signal.
        self.note(kind="refine_failed", error=record.get("error"))

    def _on_turn_end(self, _record: dict[str, Any]) -> None:
        self.check_harness_drift(include_local=False)

    def _on_agent_end(self, _record: dict[str, Any]) -> None:
        self._close_stream("agent_end")
        self.agent_ended.set()
        # Still global-only: a compaction can defer its refinement past several
        # `agent_end`s before landing (실측 case G4), so the session is not over
        # and the event may still be coming.
        self.check_harness_drift(include_local=False)
        self.note(kind="agent_end")

    def _on_eof(self, _record: dict[str, Any]) -> None:
        self.ended_by_eof = True
        # EOF with a stream still open is the harness dying mid-answer. ADR-0155
        # calls that `failed`; the alternative is a half sentence in the channel
        # wearing a finished answer's clothes.
        outcome = None if self.agent_ended.is_set() else OUTCOME_FAILED
        self._close_stream("eof", outcome=outcome)
        self.note(kind="eof", stderr=self.rpc.stderr_lines[-10:])

    def _on_unparsed(self, record: dict[str, Any]) -> None:
        self.note(kind="unparsed", raw=str(record.get("raw"))[:400])

    # -- lifecycle ---------------------------------------------------------

    def check_harness_drift(self, *, include_local: bool = True) -> dict[str, Any] | None:
        """Did a harness state file change without an event saying so?

        Two silences, one check. The kernel writes the global file through
        `rlm.harness` and emits nothing at all; a compaction-deferred automatic
        refinement writes a **session-local** file and emits nothing either,
        because by the time the queue drains the RPC is already down (실측 §2.4,
        2/2 runs). Both are a file that moved with no line in the channel, so
        both are announced the same way and with the same honest trigger.

        The two scopes are **not** asked about at the same moments, and that is
        the whole of `include_local`:

        * the global file has a writer that never speaks (`rlm.harness`), so
          every checkpoint asks about it and the answer is timely;
        * a session-local file has exactly one writer — the refine machinery —
          and it *does* speak, so asking mid-turn only creates a race between the
          file and its own imminent `refine_complete`. Whichever won would decide
          the announcement's trigger, which is how a label becomes a coin toss.
          Once the RPC is down, nothing further can explain the file, and that is
          when the question is worth asking.

        Returns the last announcement, for the callers that only ever expect one.
        """
        announcement = None
        for drift in self.observer.drifts(include_local=include_local):
            announcement = self.announcer.announce_observed_drift(drift)
            after = drift.get("after") or {}
            self.note(
                kind="observed_drift",
                path=after.get("path"),
                scope=after.get("scope"),
                announced=announcement is not None,
                newEntryIds=drift.get("newEntryIds"),
            )
        return announcement

    def cancel(self, reason: str = "cancel", *, tell_harness: bool = True) -> None:
        """A human pressed stop.

        Two halves, in this order: tell the harness (`abort`, the RPC command
        that stops the current operation) and close the open answer as
        `cancelled`. Closing first would leave the harness still generating into
        a message that says it stopped; telling first and never closing would
        leave a half sentence wearing a finished answer's clothes. The stream
        close is guarded by `closed`, so an `error/aborted` event arriving right
        after this is a no-op rather than a second closing slice.
        """
        self.cancelled = True
        if tell_harness:
            try:
                self.rpc.send({"id": "abort-1", "type": "abort"})
            except Exception as exc:  # the harness may already be gone
                self.note(kind="abort_send_failed", error=f"{type(exc).__name__}: {exc}")
        self._close_stream(reason, outcome=OUTCOME_CANCELLED)

    def finish(self) -> None:
        """Last call before the process goes away.

        An answer still open here never got its `text_end`, and the honest label
        depends on why: a cancel already closed it, and anything else is the
        producer stopping without finishing.
        """
        if self.stream is not None and not self.stream.closed:
            self._close_stream("finish", outcome=OUTCOME_FAILED)

    def summary(self) -> dict[str, Any]:
        return {
            "eventCounts": dict(self.event_counts),
            "turns": self.turn_index,
            "writes": list(self.client.writes),
            "refinements": [
                {"clientMsgId": item["clientMsgId"], "harnessRefine": item["harnessRefine"]}
                for item in self.announcer.announcements
            ],
            "uiRequests": list(self.ui_requests),
            "cancelled": self.cancelled,
            "endedByEof": self.ended_by_eof,
            "harness": self.observer.baseline,
            # Which files were actually watched, not which one was configured.
            # The measured failure this answers (#1194 §4.3) is an operator
            # reading `observerWatchPath` and finding it never existed, with no
            # way to tell "nothing changed" from "nothing was looked at".
            "harnessSources": list(self.observer.baselines),
            # And separately, what the *scan* finds — because a baseline can also
            # be added by an announcement adopting the file it just wrote. Only
            # this list answers "would a file nobody told us about be seen".
            "harnessLocalWatched": self.observer.local_sources(),
            "harnessLocalRoot": self.observer.local_root,
            "commandsSent": dict(self.rpc.sent_counts),
            "stderr": self.rpc.stderr_lines[-40:],
        }
