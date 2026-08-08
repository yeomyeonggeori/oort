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

## Two *files*, not one (#1194)

The file half is not one path either, and watching only the global one was a
second silent hole (실측 `research/2026-08-09-prime-auto-refine-measurement.md`
§4.3). Where a refinement lands depends on who asked for it:

| origin | `RefinementResult.scope` | file |
|---|---|---|
| `refine` command with `global: true` | `global` | `<agentDir>/harness/harness_state.json` |
| automatic refine (`turn_interval` / `compact`), `refine.run` | `local` | `<agentDir>/session-artifacts/<sessionId>/harness/harness_state.json` |

The automatic path is the on-by-default one and it writes **local**, so an
observer holding the global path alone was watching the file the automatic path
never touches. The measured deferred-compaction shape (§2.4) is exactly where
that costs everything: 2/2 runs changed the local file and emitted **zero**
`refine_complete` records, so with stdout silent the audit trail was not thin, it
was empty.

The local path is per-session, so this is a directory scan rather than one
watched name: [`HarnessObserver`] globs `<local_root>/*/harness/harness_state.json`
on every check, and a file it has never seen carries an implicit "did not exist"
baseline — which is what turns a session directory appearing mid-run into a drift
instead of a silence. Files already present when the observer was built are
baselined rather than announced: they are a previous session's history, not news.

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

import glob
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

#: prime's own names for the two halves of the path, spelled once
#: (`refinement.js` `HARNESS_STATE_DIR_NAME` / `getHarnessStatePath`, and
#: `session-manager.js` `getSessionArtifactPath`).
HARNESS_STATE_DIR_NAME = "harness"
HARNESS_STATE_FILE_NAME = "harness_state.json"
SESSION_ARTIFACTS_DIR_NAME = "session-artifacts"

#: How many session-local state files one scan will watch, newest first.
#:
#: A long-lived workspace HOME accumulates one session-artifact directory per
#: session and never prunes them, so an uncapped scan grows without bound while
#: the interesting file is always among the newest. The cap bounds the work, not
#: the correctness of what it finds: a file this adapter already holds a baseline
#: for stays watched regardless of where it falls in the ordering.
HARNESS_LOCAL_SCAN_MAX = 64


def harness_refine_client_msg_id(refinement_id: str) -> str:
    """The derived key an announcement must be sent under (D4).

    The same function as `momo_messaging::harness_refine_client_msg_id`. The
    server computes it independently and **refuses** a POST that carries any
    other value, naming the expected one — so a mismatch here is a loud 400, not
    a duplicated line.

    A 400 is still a production rejection, though, which is why the pair is
    watched rather than trusted (#1190):
    `docs/api/harness-refine-client-msg-id.golden.json` holds the expected uuids
    once, and both this package's tests and the Rust crate's read **that same
    file**. There is no second copy to keep in sync; changing what this returns
    means changing the golden file, and that is an ADR-0158 D4 decision.
    """
    return str(uuid.uuid5(HARNESS_REFINE_NAMESPACE, refinement_id))


class HarnessObserver:
    """The disk-side half of refine auditing: hash the state files, diff the ids.

    This exists because of the kernel path. If upstream ever emits an event on
    every `HarnessState.save()` regardless of who called it, this class is the
    code that gets deleted — and the `observed-drift` trigger with it.

    **Two scopes, one observer** (#1194). `path` is prime's global file and
    `local_root` is the session-artifacts directory the automatic path writes
    under; every check globs the latter, because the file's name contains a
    session id that does not exist yet when this object is built.

    `scan_local=False` is the red-proof lever, not a tuning knob: it reproduces
    the measured pre-#1194 world in which an automatic refinement changed a file
    nobody watched. Production never passes it.
    """

    def __init__(
        self,
        path: str | None = None,
        *,
        local_root: str | None = None,
        scan_local: bool = True,
    ):
        self.path = path or default_harness_state_path()
        self.scan_local = scan_local
        self.local_root = local_root or session_artifacts_root_for(self.path)
        self.baselines: dict[str, dict[str, Any]] = {
            source: self.snapshot(source) for source in self.sources()
        }

    # -- what is watched ---------------------------------------------------

    def local_sources(self) -> list[str]:
        """Every session-local state file that exists right now, newest first."""
        if not self.scan_local:
            return []
        pattern = os.path.join(
            self.local_root, "*", HARNESS_STATE_DIR_NAME, HARNESS_STATE_FILE_NAME
        )
        found = glob.glob(pattern)
        if len(found) > HARNESS_LOCAL_SCAN_MAX:
            found = sorted(found, key=_mtime_or_zero, reverse=True)[:HARNESS_LOCAL_SCAN_MAX]
        return sorted(found)

    def sources(self) -> list[str]:
        """The global file, the local scan, and anything already baselined.

        The third term is what keeps a deleted session directory from silently
        dropping out of the audit: a file this observer has a baseline for stays
        watched even after it disappears, so its disappearance is a drift.
        """
        watched = [self.path]
        for source in self.local_sources():
            if source not in watched:
                watched.append(source)
        for source in sorted(getattr(self, "baselines", {})):
            if source not in watched:
                watched.append(source)
        return watched

    def scope_of(self, path: str) -> str:
        """`global` for prime's shared file, `local` for a session's own."""
        return "global" if os.path.abspath(path) == os.path.abspath(self.path) else "local"

    # -- reading -----------------------------------------------------------

    def snapshot(self, path: str | None = None) -> dict[str, Any]:
        path = path or self.path
        snap: dict[str, Any] = {
            "path": path,
            "scope": self.scope_of(path),
            "exists": os.path.exists(path),
        }
        if not snap["exists"]:
            snap["sha256"] = None
            snap["entryIds"] = []
            snap["refinementIds"] = []
            return snap
        try:
            with open(path, "rb") as handle:
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

    @property
    def baseline(self) -> dict[str, Any]:
        """The global file's baseline — what `summary()` has always reported."""
        return self.baselines.get(self.path) or self.snapshot(self.path)

    def drifts(self, *, include_local: bool = True) -> list[dict[str, Any]]:
        """Every watched file that changed since its last accepted baseline.

        Reading advances nothing: [`accept`] is separate so a failed announcement
        is retried on the next turn instead of being lost because the observer
        already moved on.

        A source with no baseline at all is one that appeared after this observer
        was built — a session directory created mid-run — and its implicit
        baseline is "did not exist", so its first content is news.

        `include_local=False` restricts the answer to the global file. See
        `PrimeAdapter.check_harness_drift` for why the two scopes are not asked
        about at the same moments.
        """
        changed: list[dict[str, Any]] = []
        for path in self.sources():
            if not include_local and self.scope_of(path) == "local":
                continue
            baseline = self.baselines.get(path) or _absent_snapshot(path, self.scope_of(path))
            current = self.snapshot(path)
            if current.get("sha256") == baseline.get("sha256"):
                continue
            before_entries = set(baseline.get("entryIds") or [])
            before_refinements = set(baseline.get("refinementIds") or [])
            changed.append(
                {
                    "before": baseline,
                    "after": current,
                    "newEntryIds": sorted(set(current.get("entryIds") or []) - before_entries),
                    "newRefinementIds": [
                        item
                        for item in (current.get("refinementIds") or [])
                        if item not in before_refinements
                    ],
                }
            )
        return changed

    def drift(self) -> dict[str, Any] | None:
        """The first pending drift, or `None`. See [`drifts`] for all of them."""
        pending = self.drifts()
        return pending[0] if pending else None

    def accept(self, path: str | None = None) -> dict[str, Any]:
        """Move a baseline to what is on disk now, and return the global one.

        Called after a `refine_complete` announcement too — otherwise the file
        change that refinement just made would be re-announced a second time as
        an `observed-drift`, which is the same fact wearing a worse name. With
        the local scan in place that is no longer a nicety: an automatic
        refinement *always* writes a file this observer is watching, so without
        the accept every automatic refinement would produce two channel lines.

        `path` narrows the move to one file, which is what an announcement
        should do — accepting everything would swallow an unrelated kernel write
        that happened to land in the same window.
        """
        if path is None:
            for source in self.sources():
                self.baselines[source] = self.snapshot(source)
        else:
            self.baselines[path] = self.snapshot(path)
        return self.baseline


def _absent_snapshot(path: str, scope: str) -> dict[str, Any]:
    return {"path": path, "scope": scope, "exists": False, "sha256": None, "entryIds": [], "refinementIds": []}


def _mtime_or_zero(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def prime_agent_dir() -> str:
    """prime's agent dir, resolved the way prime resolves it.

    `$PRIME_AGENT_CODING_AGENT_DIR` else `$HOME/.prime/agent` (`dist/config.js`
    `getAgentDir`, and `rlm/harness.py:_agent_dir` on the kernel side). Both
    halves matter: the kernel writes through the Python spelling, and if this
    adapter watched a different path it would observe nothing at all.
    """
    return os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.join(
        os.path.expanduser("~"), ".prime", "agent"
    )


def default_harness_state_path() -> str:
    """Where prime keeps *global* harness state."""
    return os.path.join(prime_agent_dir(), HARNESS_STATE_DIR_NAME, HARNESS_STATE_FILE_NAME)


def session_artifacts_root_for(state_path: str) -> str:
    """The session-artifacts root that belongs with a given global state file.

    Derived from the watched path rather than read from the environment a second
    time, so an operator who points `OORT_PRIME_HARNESS_STATE_PATH` somewhere
    else gets a local root beside it instead of a scan of the real `$HOME` — and
    so a test with a temporary path scans a temporary directory.

    prime spells the pair `<agentDir>/harness/harness_state.json` and
    `<agentDir>/session-artifacts/<sessionId>/harness/harness_state.json`
    (`refinement.js` `getGlobalHarnessStateDir`, `session-manager.js`
    `getSessionArtifactPath`), so the agent dir is two levels up **when the
    parent directory is prime's `harness/`** and one level up otherwise.
    """
    parent = os.path.dirname(state_path)
    agent_dir = (
        os.path.dirname(parent) if os.path.basename(parent) == HARNESS_STATE_DIR_NAME else parent
    )
    return os.path.join(agent_dir, SESSION_ARTIFACTS_DIR_NAME)


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


def observed_drift_id(drift: dict[str, Any]) -> str:
    """The id a drift announces under — the harness's own when the file has one.

    Not two ids for one fact. A state file carries a `refinements[]` list, and a
    refinement that wrote it leaves its `RefinementResult.id` there. When the
    drift names a new one, that id **is** D4's key, so the file watcher and the
    `refine_complete` event derive the *same* `clientMsgId` for the same
    refinement and the second one to notice adds nothing — which is the property
    `momo_messaging::harness_refine_client_msg_id` is documented to provide
    ("the RPC path and the file watcher both noticing the same event").

    It stopped being theoretical when the local scan landed (#1194): every
    automatic refinement now writes a file this adapter watches, so a drift check
    that lands between the write and the event sees exactly that. Keyed on the
    content hash it was a second line for one refinement; keyed on the harness's
    id it is the same line, and whichever observation arrives first is the one
    that names the trigger.

    Falls back to the content hash when the file names no new refinement — the
    kernel's `add_memory` + `save()` writes entries without appending a
    refinement event, and that path is what `drift_` exists for.
    """
    new_refinements = [str(item) for item in (drift.get("newRefinementIds") or []) if str(item).strip()]
    if new_refinements:
        # The last one: a file can gain several between two checkpoints, and the
        # newest is the one whose event has not arrived yet.
        return new_refinements[-1][:REFINE_ID_MAX_CHARS]
    return drift_refinement_id((drift.get("after") or {}).get("sha256"))


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
            # so it is not announced twice under two triggers. `harnessStatePath`
            # is the harness's own word for which file it wrote (실측 §3.2), and
            # narrowing to it is what keeps an unrelated kernel write in the same
            # window from being swallowed by this accept.
            written = result.get("harnessStatePath")
            self.observer.accept(written if isinstance(written, str) and written else None)
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
            refinement_id=observed_drift_id(drift),
            trigger=TRIGGER_OBSERVED_DRIFT,
            edits=edits,
            summary=None,
            rollback_id=None,
        )
        if self.observer is not None:
            self.observer.accept(after.get("path"))
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

    **`applied` is a filter, not decoration** (#1194). The field's name is
    misleading: `appliedEdits` is the list of edits the harness *attempted*, and
    an edit that failed — re-creating an entry that already exists, measured in
    §4.4 — stays in it with `applied: false`. Announcing it as "항목 1건" tells
    the channel a change happened that did not. Upstream's own extension emit
    counts `appliedEdits.filter(e => e.applied).length`
    (`agent-session.js:6283`), so this is the same filter on our side of the
    wire rather than a rule invented here.
    """
    out: list[dict[str, str]] = []
    for edit in applied or []:
        if not isinstance(edit, dict):
            continue
        if not edit.get("applied"):
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
