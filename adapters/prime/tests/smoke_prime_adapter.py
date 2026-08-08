#!/usr/bin/env python3
"""The closed loop, without Docker: fake harness in, real adapter, fake oort out.

    python3 adapters/prime/tests/smoke_prime_adapter.py

No network, no npm, no container, no credential — and every piece between the
two doubles is the code that ships. What it proves, per scenario:

* **text** — a streamed answer becomes ONE message that grows: one opening POST
  plus slices whose `rev` strictly increases, each carrying the absolute body,
  the last one final. This is the #1152/#1173 contract and it is also the
  spike's headline defect closed (17 writes had meant 17 messages).
* **abort** — a stopped answer closes with `outcome: "cancelled"`, so the channel
  can tell "someone pressed stop" from "this is the whole answer" (ADR-0155).
* **die** — the harness exiting mid-answer closes the stream `failed` instead of
  leaving a half sentence that claims to be finished.
* **refine** — the undocumented `refine_complete` becomes exactly one `system`
  line, and replaying it produces no second line (ADR-0158 D4).
* **silent-drift** — a harness file rewritten by the kernel with zero protocol
  output still becomes one announcement, honestly labelled `observed-drift`.
* **retry** — a flush replayed after a transport failure lands on the message it
  already wrote, not beside it.

The `assert`s are the point; the printed table is for a human reading the PR.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

from prime.oort_client import OortClient  # noqa: E402
from prime.prime_adapter import AdapterSettings, PrimeAdapter  # noqa: E402
from prime.refine import harness_refine_client_msg_id  # noqa: E402
from prime.rpc import JsonlRpc  # noqa: E402
from prime.stream_relay import StreamRelay  # noqa: E402

sys.path.insert(0, HERE)
from fake_oort import REFINE_PROPS_KEY, FakeOort  # noqa: E402

FAKE_PRIME = os.path.join(HERE, "fake_prime.py")
RESULTS: list[tuple[str, str]] = []


def record(name: str, detail: str) -> None:
    RESULTS.append((name, detail))
    print(f"  ok  {name:<28} {detail}")


def run_session(
    scenario: str,
    *,
    harness_state: str,
    serves_run_id: bool = False,
    run_id: str | None = None,
    after_prompt=None,
    inspect=None,
    timeout: float = 25.0,
) -> tuple[Any, Any]:
    """One adapter session against one fake harness and one fake oort.

    `inspect(adapter, model)` runs while the server is still listening — the only
    place a test can make a further write, which is what a replay assertion needs.
    """
    with FakeOort(serves_run_id=serves_run_id) as oort:
        client = OortClient(
            oort.url,
            "00000000-0000-7000-8000-000000000001",
            "00000000-0000-7000-8000-000000000201",
            "test-bearer",
            run_id=run_id,
            send_run_id_field=serves_run_id,
        )
        rpc = JsonlRpc(
            [sys.executable, FAKE_PRIME, "--scenario", scenario, "--harness-state", harness_state],
            env=dict(os.environ),
        )
        adapter = PrimeAdapter(
            rpc,
            client,
            AdapterSettings(agent_handle="김인턴", flush_chars=60, flush_interval=0.2, harness_state_path=harness_state),
            session_key=f"smoke-{scenario}",
        )
        try:
            rpc.send({"id": "state-1", "type": "get_state"})
            rpc.send({"id": "p-1", "type": "prompt", "message": "안녕"})
            adapter.pump(time.time() + timeout)
            if after_prompt is not None:
                after_prompt(adapter, rpc)
                adapter.pump(time.time() + timeout)
        finally:
            adapter.finish()
            adapter.check_harness_drift()
            rpc.close()
        if inspect is not None:
            inspect(adapter, oort.model)
        return adapter, oort.model


def scenario_text(tmp: str) -> None:
    adapter, model = run_session("text", harness_state=os.path.join(tmp, "text", "harness_state.json"))
    posts = [w for w in adapter.client.writes if w["method"] == "POST"]
    patches = [w for w in adapter.client.writes if w["method"] == "PATCH"]
    assert len(model.messages) == 1, f"one growing message, got {len(model.messages)}"
    assert len(posts) == 1 and posts[0]["opensStream"], "exactly one opening POST"
    assert len(patches) >= 2, f"a long answer must produce several slices, got {len(patches)}"
    revs = [w["rev"] for w in patches]
    assert revs == sorted(set(revs)) and revs[0] == 1, f"rev must start at 1 and strictly increase: {revs}"
    assert patches[-1]["final"] is True and patches[-1]["outcome"] is None, "a finished answer closes with no outcome"
    assert [w["chars"] for w in patches] == sorted(w["chars"] for w in patches), "each slice carries the whole body so far"
    message = next(iter(model.messages.values()))
    assert message["streaming"] is False and message["editedAtMs"] is None, "a slice never stamps an edit"
    assert message["body"].endswith("볼 수 있습니다."), "the final slice carries the whole body"
    assert message["seq"] == 1, "one message consumed one seq"
    record("text", f"1 message, {len(patches)} slices, rev 1..{revs[-1]}, seq {message['seq']}")


def scenario_abort(tmp: str) -> None:
    def press_stop(adapter, _rpc):
        adapter.cancel("smoke")

    adapter, model = run_session(
        "abort", harness_state=os.path.join(tmp, "abort", "harness_state.json"), after_prompt=press_stop
    )
    message = next(iter(model.messages.values()))
    assert message["outcome"] == "cancelled", f"a stopped answer closes cancelled, got {message['outcome']}"
    assert message["streaming"] is False, "a closed stream is not still streaming"
    closing = [w for w in adapter.client.writes if w["method"] == "PATCH" and w["final"]]
    assert len(closing) == 1, f"exactly one closing slice, got {len(closing)}"
    record("abort", f"outcome=cancelled, body {len(message['body'])} chars")


def scenario_die(tmp: str) -> None:
    adapter, model = run_session("die", harness_state=os.path.join(tmp, "die", "harness_state.json"))
    assert adapter.ended_by_eof, "the harness was expected to die"
    message = next(iter(model.messages.values()))
    assert message["outcome"] == "failed", f"a dead producer closes failed, got {message['outcome']}"
    record("die", "EOF mid-answer closed the stream failed")


def scenario_refine(tmp: str) -> None:
    state = os.path.join(tmp, "refine", "harness_state.json")

    def ask_refine(_adapter, rpc):
        rpc.send({"id": "r-1", "type": "refine"})

    def replay(adapter, model):
        # Simulate a restart that forgot what it had announced. The clientMsgId
        # is the harness's own refinement id, so the server's unique index
        # answers with the message that already exists.
        before = len(model.messages)
        adapter.announcer.emitted.clear()
        adapter.announcer.announce_refine_complete(
            {"id": "refine_20260808000000000", "appliedEdits": [{"id": "oort-adapter-probe"}]}
        )
        assert len(model.messages) == before, "a replayed refinement must dedupe on clientMsgId"

    adapter, model = run_session(
        "refine", harness_state=state, after_prompt=ask_refine, inspect=replay
    )
    systems = model.of_type("system")
    assert len(systems) == 1, f"one refinement, one line, got {len(systems)}"
    stored = systems[0]["props"][REFINE_PROPS_KEY]
    assert stored["trigger"] == "command", stored
    assert stored["scope"] == "workspace", "the harness's 'global' must not be repeated to the channel"
    assert [edit["id"] for edit in stored["edits"]] == ["oort-adapter-probe"], stored
    assert systems[0]["clientMsgId"] == harness_refine_client_msg_id(
        "refine_20260808000000000"
    ), "the server derives the key from the RefinementResult id (D4)"
    assert adapter.event_counts.get("refine_complete") == 1, adapter.event_counts
    record("refine", "1 announcement, replay deduped, props keys exact")


def scenario_silent_drift(tmp: str) -> None:
    state = os.path.join(tmp, "drift", "harness_state.json")
    adapter, model = run_session("silent-drift", harness_state=state)
    systems = model.of_type("system")
    assert len(systems) == 1, f"the kernel path must still be announced, got {len(systems)}"
    stored = systems[0]["props"][REFINE_PROPS_KEY]
    assert stored["trigger"] == "observed-drift", stored
    assert [edit["id"] for edit in stored["edits"]] == ["oort-adapter-probe"], stored
    assert adapter.event_counts.get("refine_complete", 0) == 0, "the kernel path emits no event, by definition"
    record("silent-drift", "0 protocol events, 1 observed-drift announcement")


def scenario_retry() -> None:
    """A flush that fails in transit and is replayed writes the same message."""

    class FlakyOpener:
        def __init__(self, inner):
            self.inner = inner
            self.failed = False

        def __call__(self, request, timeout=None):
            if request.get_method() == "POST" and not self.failed:
                self.failed = True
                raise TimeoutError("connection reset")
            return self.inner(request, timeout=timeout)

    import urllib.request

    with FakeOort() as oort:
        opener = FlakyOpener(urllib.request.urlopen)
        client = OortClient(
            oort.url,
            "00000000-0000-7000-8000-000000000001",
            "00000000-0000-7000-8000-000000000201",
            "test-bearer",
            backoff=0.0,
            opener=opener,
        )
        relay = StreamRelay(client, client_msg_id="11111111-2222-3333-4444-555555555555")
        relay.add("첫 조각")
        relay.flush("policy")
        relay.add(" 둘째 조각")
        relay.close("done")
        assert opener.failed, "the retry path was not exercised"
        assert len(oort.model.messages) == 1, f"a retried open must not duplicate, got {len(oort.model.messages)}"
        message = next(iter(oort.model.messages.values()))
        assert message["body"] == "첫 조각 둘째 조각", message["body"]
        record("retry", "opening POST retried, 1 message, absolute body intact")


def scenario_run_id() -> None:
    """The D5 dependency, measured rather than asserted.

    A server that has not landed `runId` acceptance refuses the field by name.
    The adapter surfaces that refusal instead of dropping the binding, because a
    dropped binding is a stream nothing can close.
    """
    from prime.oort_client import OortError

    with FakeOort(serves_run_id=False) as oort:
        client = OortClient(
            oort.url, "ws", "ch", "t", run_id="run-1", send_run_id_field=True, backoff=0.0
        )
        try:
            client.post_message(client_msg_id="k1", message_type="text", body="hi")
        except OortError as error:
            assert error.status == 400 and "runId" in error.body, error
        else:  # pragma: no cover - the point is that it raises
            raise AssertionError("an unserved runId must not pass silently")

    with FakeOort(serves_run_id=True) as oort:
        client = OortClient(
            oort.url, "ws", "ch", "t", run_id="run-1", send_run_id_field=True, backoff=0.0
        )
        client.post_message(client_msg_id="k1", message_type="text", body="hi")
        message = next(iter(oort.model.messages.values()))
        assert message["props"]["run_id"] == "run-1", "props keep the run for #1166's verdict too"
        assert oort.model.requests[0]["payload"]["runId"] == "run-1"
    record("runId", "refused loudly before D5, accepted after, props copy always")


def scenario_agent_bearer_patch() -> None:
    """A scope refusal on a slice must arrive with its reason.

    This is the world before ADR-0158 증보 1 (D7), when
    `momo_auth::required_agent_scope` let an agent bearer POST a message and
    nothing else, so every slice was a 403. D7 opened the slice route to the
    message's own author, and this scenario stays because the shape outlives the
    gap: any future scope regression looks exactly like this, and the difference
    between "403, here is why" and a silent stall is an hour of someone's day.
    """
    from prime.oort_client import OortError

    with FakeOort(patch_allowed=False) as oort:
        client = OortClient(oort.url, "ws", "ch", "t", backoff=0.0)
        relay = StreamRelay(client, client_msg_id="22222222-3333-4444-5555-666666666666")
        relay.add("첫 조각")
        relay.flush("policy")
        try:
            relay.add("둘째 조각")
            relay.close("done")
        except OortError as error:
            assert error.status == 403, error
        else:  # pragma: no cover
            raise AssertionError("a scope-less PATCH must not appear to succeed")
    record("agent-bearer PATCH", "403 surfaced with its reason, not swallowed")


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="oort-prime-smoke-")
    print("oort prime adapter — closed-loop smoke (no docker, no network, no credential)")
    try:
        scenario_text(tmp)
        scenario_abort(tmp)
        scenario_die(tmp)
        scenario_refine(tmp)
        scenario_silent_drift(tmp)
        scenario_retry()
        scenario_run_id()
        scenario_agent_bearer_patch()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"PASS {len(RESULTS)} scenarios")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
