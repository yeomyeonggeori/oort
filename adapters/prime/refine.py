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

The id itself cannot be the key, and that is measured, not assumed.
`SendMessageRequest.client_msg_id` is a `Uuid` on the server, so posting
`refine_20260807041452415` answers **422** *"clientMsgId: UUID parsing failed:
invalid character: found `r` at 0"*. The key is therefore
`uuid5("refinement", <RefinementResult.id>)` — a pure function of exactly the
value D4 named, which keeps its guarantee while being a value the route can
decode. For an observed drift there is no such id, so the key is a UUIDv5 over
the **content hash of the state file**: observing the same state twice names the
same message, and only a real further change names a new one.

The in-process `emitted` set is the first line and the server's `clientMsgId`
unique index is the second. Neither alone is enough: the set forgets across a
restart, and the index cannot stop us from minting a fresh key.

## What the channel is told, and what it is not

Props carry `trigger`, `entryIds`, `refinementIds`, `scope` — ids and shape, no
content. Harness entries can quote the conversation that produced them, so
pouring them into a channel would leak a summary of everything the agent read.
The full text stays in the worker host's file; the channel gets "what kind, how
many".

`scope` is always `workspace`. The harness's own word for a cross-session write
is "global", but this adapter runs one workspace per HOME (see
`container/entrypoint.sh`), so the harness's global *is* our workspace. Passing
its word through would be a lie in the one direction that matters.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

from .oort_client import OortClient, stable_key

TRIGGER_COMMAND = "command"
TRIGGER_TURN_INTERVAL = "turn_interval"
TRIGGER_COMPACT = "compact"
TRIGGER_OBSERVED_DRIFT = "observed-drift"

#: The props key ADR-0158 D2 puts the evidence under. Namespaced under `momo.`
#: like `momo.stream`, because the wire namespace is frozen (ADR-0152 D1).
REFINE_PROPS_KEY = "momo.harnessRefine"

#: Scope as the channel is allowed to read it. See the module docstring.
WORKSPACE_SCOPE = "workspace"


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


def default_client_msg_id(refinement_id: str | None, digest: str | None) -> str:
    """The announcement's idempotency key (D4), as a value the route can decode.

    Both branches are pure functions of something the harness owns: the
    refinement's own id, or the content hash of the state file it wrote. Nothing
    here consults a clock or a counter, which is the whole property — two
    processes observing the same fact name the same message.
    """
    if refinement_id:
        return stable_key("refinement", refinement_id)
    return stable_key("drift", digest or "")


def refine_body(handle: str, entry_count: int, trigger: str) -> str:
    """The human sentence. Evidence lives in props; this is what a person reads.

    Same discipline as the approval card: the body is a plain statement, and the
    ids that back it are one layer down for whoever wants them.
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
    talking", and adding a type costs every client a branch. The props key is
    what a future filter would split on if the demand ever shows up.
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
        # the duplicate announcement that D4 exists to prevent. Production code
        # never passes this.
        self._key_factory = key_factory or default_client_msg_id
        self.emitted: set[str] = set()
        self.announcements: list[dict[str, Any]] = []

    def announce_refine_complete(
        self, result: dict[str, Any], *, trigger: str = TRIGGER_COMMAND
    ) -> dict[str, Any] | None:
        """The RPC path — `refine_complete` carried a `RefinementResult`."""
        refinement_id = str(result.get("id") or "") or None
        applied = [edit for edit in (result.get("appliedEdits") or []) if isinstance(edit, dict)]
        entry_ids = sorted({str(edit.get("id")) for edit in applied if edit.get("id")})
        refinement_ids = [refinement_id] if refinement_id else []
        digest = None
        if self.observer is not None:
            digest = self.observer.snapshot().get("sha256")
        announcement = self._announce(
            client_msg_id=self._key_factory(refinement_id, digest),
            trigger=trigger,
            entry_ids=entry_ids,
            refinement_ids=refinement_ids,
        )
        if self.observer is not None:
            # The refinement just wrote the file; adopt that as the new baseline
            # so it is not announced twice under two triggers.
            self.observer.accept()
        return announcement

    def announce_observed_drift(self, drift: dict[str, Any]) -> dict[str, Any] | None:
        """The kernel path — nothing said anything, the file simply changed."""
        after = drift.get("after") or {}
        digest = after.get("sha256")
        announcement = self._announce(
            client_msg_id=self._key_factory(None, digest),
            trigger=TRIGGER_OBSERVED_DRIFT,
            entry_ids=list(drift.get("newEntryIds") or []),
            refinement_ids=list(drift.get("newRefinementIds") or []),
        )
        if self.observer is not None:
            self.observer.accept()
        return announcement

    def _announce(
        self,
        *,
        client_msg_id: str,
        trigger: str,
        entry_ids: list[str],
        refinement_ids: list[str],
    ) -> dict[str, Any] | None:
        if client_msg_id in self.emitted:
            # Second line of defence is the server's unique index; this one keeps
            # a restart-free process from even asking.
            return None
        evidence = {
            "trigger": trigger,
            "entryIds": entry_ids,
            "refinementIds": refinement_ids,
            "scope": WORKSPACE_SCOPE,
        }
        result = self.client.post_message(
            client_msg_id=client_msg_id,
            message_type="system",
            body=refine_body(self.agent_handle, len(entry_ids), trigger),
            props={"harness": "prime-agent", REFINE_PROPS_KEY: evidence},
        )
        self.emitted.add(client_msg_id)
        record = {"clientMsgId": client_msg_id, "evidence": evidence, "result": result}
        self.announcements.append(record)
        return record
