"""Self-modification, observed on both paths and announced once (ADR-0158 D1~D4).

## Two paths, one fact

prime's continual-harness refinement reaches `harness_state.json` two ways, and
they have different visibility (measured, `research/2026-08-07-prime-refine-upstream-draft.md`):

1. **The host command path.** `refine` produces a `refine_complete` record on the
   same stdout as every other event. It is real, it is undocumented, and it is
   absent from the shipped RPC types — so an adapter has to know the name by
   hand. Re-measuring that the name still exists is part of the version-pin
   discipline when this package moves off v0.7.0.
2. **The kernel path.** `rlm.harness` inside the IPython kernel writes the *same
   file* with **zero** protocol output (6 runs x 37 events, `refine_complete` = 0).
   Nothing observes it except the file.

Both change what a teammate will do next, so ADR-0158 D1 says both belong in the
channel. This module makes them one announcement type with an honest `trigger`:
the second path says `observed-drift`, which claims only what we actually know —
we saw the file change — instead of claiming the agent decided something.

## Idempotency (D4)

ADR-0158 D4 says the key is `RefinementResult.id`, and the *property* it wants is
what this module delivers: the harness's own stable name for a refinement decides
the message, so a retry lands on the message that exists.

The id itself cannot be the key, and that is measured rather than assumed.
`SendMessageRequest.client_msg_id` is a `Uuid` on the server, so posting
`refine_20260807041452415` answers **422** (`UUID parsing failed`). The server
therefore *derives* the key — `uuid5(b"momo.harnessRefi", refinementId)` — and
**refuses** an announcement sent under any other one rather than rewriting it
silently, because a silently rewritten idempotency key is one the caller cannot
retry with. `harness_refine_client_msg_id` below is that same derivation, and the
two must stay byte-identical: it is one function implemented twice on purpose,
once on each side of the wire, and the conformance for it is a real POST.

An observed drift has no harness-assigned id, so this module mints one that is
still a pure function of what was seen: `drift_<sha256 of the state file>`. The
same state names the same announcement; only a real further change names a new
one.

The in-process `emitted` set is the first line and the server's `clientMsgId`
unique index is the second. Neither alone is enough: the set forgets across a
restart, and the index cannot stop us from minting a fresh key.

## What the channel is told, and what it is not

The announcement is a **top-level `harnessRefine` block**, not a props key. Props
are a flat string map in v0, while the stored value is a structured object under
a `momo.`-namespaced key the server must be the sole author of — a key a client
could spell by hand is one a client could forge a server-vouched claim under. So
the request states what happened and the server writes what the row shows.

The block carries `refinementId`, `trigger`, `scope`, `edits[]`
(`action`/`kind`/`id` only) and an optional bounded `summary` / `rollbackId`. It
is `deny_unknown_fields` on the server, which is what makes the disclosure rule
mechanical rather than aspirational: a producer that adds `before`/`after`/
`content` is refused, not silently trimmed. Harness entries can quote the
conversation that produced them, so the full text stays in the worker host's file
and the channel gets "what kind, how many".

`scope` is always `workspace`, and the server writes its own value rather than
copying ours. The harness's word for a cross-session write is "global", but this
adapter runs one workspace per HOME (see `container/entrypoint.sh`), so the
harness's global *is* our workspace. Passing its word through would be a lie in
the one direction that matters.

`rollbackId` travels when the harness gave one (D3): recorded on the row for an
operator asking "can this be undone, and by what id", with no channel affordance
promised.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from typing import Any

from .oort_client import OortClient

TRIGGER_COMMAND = "command"
TRIGGER_TURN_INTERVAL = "turn_interval"
TRIGGER_COMPACT = "compact"
TRIGGER_OBSERVED_DRIFT = "observed-drift"
TRIGGERS = (TRIGGER_COMMAND, TRIGGER_TURN_INTERVAL, TRIGGER_COMPACT, TRIGGER_OBSERVED_DRIFT)

#: The props key ADR-0158 D2 stores the announcement under. Namespaced under
#: `momo.` like `momo.stream`, because the wire namespace is frozen (ADR-0152
#: D1). **Server-owned**: this package never writes it, it only reads it back.
REFINE_PROPS_KEY = "momo.harnessRefine"

#: Scope as the channel is allowed to read it. See the module docstring.
WORKSPACE_SCOPE = "workspace"

#: The namespace the server derives the announcement's `clientMsgId` under
#: (`momo_messaging::refine::HARNESS_REFINE_NAMESPACE`). Sixteen ASCII bytes, so
#: its version nibble is `6` while every `agent_run.id` is a v7 — the refinement
#: key space cannot collide with the tool-card one at its root.
HARNESS_REFINE_NAMESPACE = uuid.UUID(bytes=b"momo.harnessRefi")

#: Server-side caps (`momo_messaging::refine`). Enforced here too, so an
#: over-long summary is trimmed at the source rather than costing a round trip
#: and a 400 — the cap is a disclosure rule, and the adapter is the side holding
#: the text it is a rule about.
REFINE_ID_MAX_CHARS = 200
REFINE_SUMMARY_MAX_CHARS = 500
REFINE_EDITS_MAX = 50


def harness_refine_client_msg_id(refinement_id: str) -> str:
    """The derived key an announcement must be sent under (D4).

    The same function as `momo_messaging::harness_refine_client_msg_id`. The
    server computes it independently and **refuses** a POST that carries any
    other value, naming the expected one — so a mismatch here is a loud 400, not
    a duplicated line.
    """
    return str(uuid.uuid5(HARNESS_REFINE_NAMESPACE, refinement_id))


class HarnessObserver:
    """The disk-side half of refine auditing: hash the state file, diff the ids.

    This exists because of the kernel path. If upstream ever emits an event on
    every `HarnessState.save()` regardless of who called it, this class is the
    code that gets deleted — and the `observed-drift` trigger with it.
    """

    def __init__(self, path: str | None = None):
        self.path = path or default_harness_state_path()
        self.baseline = self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        snap: dict[str, Any] = {"path": self.path, "exists": os.path.exists(self.path)}
        if not snap["exists"]:
            snap["sha256"] = None
            snap["entryIds"] = []
            snap["refinementIds"] = []
            return snap
        try:
            with open(self.path, "rb") as handle:
                raw = handle.read()
        except OSError as exc:  # the file can vanish between the check and the read
            snap.update({"exists": False, "sha256": None, "entryIds": [], "refinementIds": [], "error": str(exc)})
            return snap
        snap["sha256"] = hashlib.sha256(raw).hexdigest()
        snap["bytes"] = len(raw)
        snap["entryIds"] = []
        snap["refinementIds"] = []
        try:
            state = json.loads(raw)
        except json.JSONDecodeError:
            # A half-written file is a real observation, not a crash: record that
            # it changed and let the ids stay empty rather than dropping the
            # drift entirely.
            snap["parse"] = "failed"
            return snap
        entries = state.get("entries") or {}
        if isinstance(entries, dict):
            snap["entryIds"] = sorted(
                str(entry_id)
                for kind in entries.values()
                if isinstance(kind, dict)
                for entry_id in kind
            )
        refinements = state.get("refinements") or []
        if isinstance(refinements, list):
            snap["refinementIds"] = [str(item.get("id")) for item in refinements if isinstance(item, dict)]
        return snap

    def drift(self) -> dict[str, Any] | None:
        """The change since the last accepted baseline, or `None`.

        Reading advances nothing: [`accept`] is separate so a failed announcement
        is retried on the next turn instead of being lost because the observer
        already moved on.
        """
        current = self.snapshot()
        if current.get("sha256") == self.baseline.get("sha256"):
            return None
        before_entries = set(self.baseline.get("entryIds") or [])
        before_refinements = set(self.baseline.get("refinementIds") or [])
        return {
            "before": self.baseline,
            "after": current,
            "newEntryIds": sorted(set(current.get("entryIds") or []) - before_entries),
            "newRefinementIds": [
                item for item in (current.get("refinementIds") or []) if item not in before_refinements
            ],
        }

    def accept(self) -> dict[str, Any]:
        """Move the baseline to what is on disk now, and return it.

        Called after a `refine_complete` announcement too — otherwise the file
        change that refinement just made would be re-announced a second time as
        an `observed-drift`, which is the same fact wearing a worse name.
        """
        self.baseline = self.snapshot()
        return self.baseline


def default_harness_state_path() -> str:
    """Where prime keeps global harness state, resolved the way prime resolves it.

    `$PRIME_AGENT_CODING_AGENT_DIR` else `$HOME/.prime/agent` (`dist/config.js`
    `getAgentDir`, and `rlm/harness.py:_agent_dir` on the kernel side). Both
    halves matter: the kernel writes through the Python spelling, and if this
    adapter watched a different path it would observe nothing at all.
    """
    agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.join(
        os.path.expanduser("~"), ".prime", "agent"
    )
    return os.path.join(agent_dir, "harness", "harness_state.json")


def drift_refinement_id(digest: str | None) -> str:
    """A refinement id for the path that has none.

    The kernel writes `harness_state.json` and says nothing, so there is no
    `RefinementResult.id` to key on. The content hash of what we saw is the next
    best stable name: the same state produces the same id, and therefore the same
    derived `clientMsgId`, so two adapters watching one workspace announce one
    line. The `drift_` prefix keeps it obviously ours rather than something the
    harness assigned.
    """
    return ("drift_" + (digest or "unknown"))[:REFINE_ID_MAX_CHARS]


def refine_body(handle: str, entry_count: int, trigger: str) -> str:
    """The human sentence. The evidence is in props; this is what a person reads.

    Same discipline as the approval card: the body is a plain statement, and the
    ids that back it are one layer down for whoever wants them. The server
    refuses an announcement with no body, and rightly so — a bodyless one renders
    as a blank line whose meaning lives only in an object nobody reads.
    """
    who = handle or "에이전트"
    if trigger == TRIGGER_OBSERVED_DRIFT:
        if entry_count > 0:
            return f"{who}의 작업 방식이 갱신된 것을 확인했습니다 (항목 {entry_count}건)"
        return f"{who}의 작업 방식이 갱신된 것을 확인했습니다"
    if entry_count > 0:
        return f"{who}이 자기 작업 방식을 갱신했습니다 (항목 {entry_count}건)"
    return f"{who}이 자기 작업 방식을 갱신했습니다"


class RefineAnnouncer:
    """Turns an observed refinement into exactly one `system` message.

    Type `system` rather than a new message type is ADR-0158 D2: the timeline
    already has a quiet line for "something happened that is not someone
    talking", and adding a type costs every client a branch. The props key the
    server writes is what a future filter would split on, if the demand ever
    shows up.
    """

    def __init__(
        self,
        client: OortClient,
        *,
        agent_handle: str = "",
        observer: HarnessObserver | None = None,
        key_factory=None,
    ):
        self.client = client
        self.agent_handle = agent_handle
        self.observer = observer
        # Seam for the red proof: swapping in a per-call unique key reproduces
        # the duplicate announcement D4 exists to prevent. Production code never
        # passes this — and against a server that has landed D4, the mutation is
        # answered with a 400 naming the key it should have used, which is the
        # guard working from the other side.
        self._key_factory = key_factory or harness_refine_client_msg_id
        self.emitted: set[str] = set()
        self.announcements: list[dict[str, Any]] = []

    def announce_refine_complete(
        self, result: dict[str, Any], *, trigger: str = TRIGGER_COMMAND
    ) -> dict[str, Any] | None:
        """The RPC path — `refine_complete` carried a `RefinementResult`."""
        refinement_id = str(result.get("id") or "").strip()
        if not refinement_id:
            # Without the harness's id there is no stable key, and an
            # announcement we cannot make idempotent is one that will duplicate.
            # The drift path already covers "we know the file changed".
            return None
        edits = _wire_edits(result.get("appliedEdits"))
        announcement = self._announce(
            refinement_id=refinement_id,
            trigger=trigger,
            edits=edits,
            summary=result.get("summary"),
            rollback_id=result.get("rollbackId"),
        )
        if self.observer is not None:
            # The refinement just wrote the file; adopt that as the new baseline
            # so it is not announced twice under two triggers.
            self.observer.accept()
        return announcement

    def announce_observed_drift(self, drift: dict[str, Any]) -> dict[str, Any] | None:
        """The kernel path — nothing said anything, the file simply changed.

        No `summary`: we did not see one, and inventing a sentence about what the
        agent decided is exactly what `observed-drift` exists not to do.
        """
        after = drift.get("after") or {}
        edits = [
            {"action": "observed", "kind": "entry", "id": str(entry_id)}
            for entry_id in (drift.get("newEntryIds") or [])
        ][:REFINE_EDITS_MAX]
        announcement = self._announce(
            refinement_id=drift_refinement_id(after.get("sha256")),
            trigger=TRIGGER_OBSERVED_DRIFT,
            edits=edits,
            summary=None,
            rollback_id=None,
        )
        if self.observer is not None:
            self.observer.accept()
        return announcement

    def _announce(
        self,
        *,
        refinement_id: str,
        trigger: str,
        edits: list[dict[str, str]],
        summary: Any,
        rollback_id: Any,
    ) -> dict[str, Any] | None:
        client_msg_id = self._key_factory(refinement_id)
        if client_msg_id in self.emitted:
            # Second line of defence is the server's unique index; this one keeps
            # a restart-free process from even asking.
            return None
        block: dict[str, Any] = {
            "refinementId": refinement_id[:REFINE_ID_MAX_CHARS],
            "trigger": trigger,
            # Claimed, then written by the server from its own constant. Sending
            # it anyway is not redundant: the server refuses any other value, so
            # this line is where an adapter that started passing the harness's
            # "global" through would be stopped.
            "scope": WORKSPACE_SCOPE,
            "edits": edits[:REFINE_EDITS_MAX],
        }
        if isinstance(summary, str) and summary.strip():
            block["summary"] = summary.strip()[:REFINE_SUMMARY_MAX_CHARS]
        if isinstance(rollback_id, str) and rollback_id.strip():
            block["rollbackId"] = rollback_id.strip()[:REFINE_ID_MAX_CHARS]

        result = self.client.post_message(
            client_msg_id=client_msg_id,
            message_type="system",
            body=refine_body(self.agent_handle, len(edits), trigger),
            props={"harness": "prime-agent"},
            harness_refine=block,
        )
        self.emitted.add(client_msg_id)
        record = {"clientMsgId": client_msg_id, "harnessRefine": block, "result": result}
        self.announcements.append(record)
        return record


def _wire_edits(applied: Any) -> list[dict[str, str]]:
    """`RefinementResult.appliedEdits` reduced to what may leave this host.

    Three fields survive — `action`, `kind`, `id` — and `before`/`after`/
    `content` are dropped here rather than filtered later, because a redaction
    that happens next to the transport is one somebody eventually moves. The
    server refuses the extra keys too (`deny_unknown_fields`), so this is the
    inner of two locks on the same door.
    """
    out: list[dict[str, str]] = []
    for edit in applied or []:
        if not isinstance(edit, dict):
            continue
        entry_id = str(edit.get("id") or "").strip()
        if not entry_id:
            continue
        out.append(
            {
                "action": str(edit.get("action") or "update")[:REFINE_ID_MAX_CHARS],
                "kind": str(edit.get("kind") or "entry")[:REFINE_ID_MAX_CHARS],
                "id": entry_id[:REFINE_ID_MAX_CHARS],
            }
        )
    return out
