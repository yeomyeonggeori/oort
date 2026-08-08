#!/usr/bin/env python3
"""Contract tests for the oort prime adapter — stdlib only, no docker, no network.

    python3 adapters/prime/tests/test_prime_adapter_contract.py

Three kinds of test live here and they are labelled, because they answer
different questions:

* **contract** — the adapter speaks the wire the server actually serves;
* **RED PROOF** — deleting a specific guard reproduces a specific, named,
  previously-measured failure. A guard whose removal changes nothing was never
  load bearing, and this file is where that claim is settled;
* **fail-closed** — the isolation lever refuses to open by accident.

The container-level red proof (isolation off -> one workspace reads another's
harness memory) needs a real kernel and lives in `tenancy_probe.sh`; what is
here is the half that can run in every gate.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, PACKAGE_ROOT)
sys.path.insert(0, HERE)

from fake_oort import REFINE_PROPS_KEY, STREAM_PROPS_KEY, FakeOort  # noqa: E402
from prime.oort_client import OortClient, OortError, stable_key, string_props  # noqa: E402
from prime.refine import (  # noqa: E402
    TRIGGER_OBSERVED_DRIFT,
    HarnessObserver,
    RefineAnnouncer,
    drift_refinement_id,
    harness_refine_client_msg_id,
    refine_body,
)
from prime.stream_relay import StreamRelay  # noqa: E402

WS = "00000000-0000-7000-8000-000000000001"
CH = "00000000-0000-7000-8000-000000000201"


def client_for(oort: FakeOort, **kwargs) -> OortClient:
    kwargs.setdefault("backoff", 0.0)
    return OortClient(oort.url, WS, CH, "test-bearer", **kwargs)


class WireShape(unittest.TestCase):
    """contract — what goes on the wire is what the server decodes."""

    def test_props_are_flat_strings_and_structure_is_json(self):
        props = string_props({"harness": "prime-agent", "isError": False, "n": 3, "evidence": {"b": 1, "a": 2}})
        self.assertEqual(props["harness"], "prime-agent")
        self.assertEqual(props["isError"], "false")
        self.assertEqual(props["n"], "3")
        # Sorted keys, so the same evidence is the same bytes on a retry.
        self.assertEqual(props["evidence"], '{"a":2,"b":1}')
        self.assertTrue(all(isinstance(value, str) for value in props.values()))

    def test_the_opening_write_declares_rev_zero_and_streaming(self):
        with FakeOort() as oort:
            client = client_for(oort)
            client.post_message(client_msg_id="k1", message_type="text", body="답이 자", opens_stream=True)
            payload = oort.model.requests[0]["payload"]
            self.assertEqual(payload["stream"], {"rev": 0, "streaming": True})
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["props"][STREAM_PROPS_KEY], {"rev": 0, "streaming": True})

    def test_the_server_owns_the_stream_props_key(self):
        """A client-supplied `momo.stream` is dropped, not honoured."""
        with FakeOort() as oort:
            client = client_for(oort)
            client.post_message(
                client_msg_id="k1",
                message_type="text",
                body="답",
                props={STREAM_PROPS_KEY: '{"rev":9999,"streaming":false}'},
                opens_stream=True,
            )
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["props"][STREAM_PROPS_KEY]["rev"], 0)

    def test_an_outcome_only_rides_the_final_slice(self):
        with FakeOort() as oort:
            client = client_for(oort)
            opened = client.post_message(
                client_msg_id="k1", message_type="text", body="답이 자", opens_stream=True
            )
            with self.assertRaises(ValueError):
                client.patch_stream(opened["id"], body="답", rev=1, is_final=False, outcome="cancelled")
            with self.assertRaises(ValueError):
                client.patch_stream(opened["id"], body="답", rev=1, is_final=True, outcome="exploded")

    def test_a_slice_never_starts_below_one(self):
        with FakeOort() as oort:
            client = client_for(oort)
            opened = client.post_message(client_msg_id="k1", message_type="text", body="답", opens_stream=True)
            with self.assertRaises(ValueError):
                client.patch_stream(opened["id"], body="답", rev=0, is_final=False)


class StreamArithmetic(unittest.TestCase):
    """contract — one growing message, absolute bodies, monotone revisions."""

    def relay(self, oort: FakeOort, **kwargs) -> StreamRelay:
        return StreamRelay(client_for(oort), client_msg_id=str(uuid.uuid4()), flush_chars=10, **kwargs)

    def test_one_answer_is_one_message(self):
        with FakeOort() as oort:
            relay = self.relay(oort)
            for chunk in ("첫 번째 조각입니다 ", "두 번째 조각입니다 ", "세 번째 조각입니다 "):
                relay.add(chunk)
            relay.close("text_end")
            self.assertEqual(len(oort.model.messages), 1)
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["body"], relay.body)
            self.assertFalse(message["streaming"])
            self.assertIsNone(message["editedAtMs"], "a slice is not an edit (#1152)")

    def test_every_slice_carries_the_whole_body(self):
        with FakeOort() as oort:
            relay = self.relay(oort)
            relay.add("아주 긴 첫 조각입니다 ")
            relay.add("그리고 이어지는 둘째 조각 ")
            relay.close("text_end")
            bodies = [
                request["payload"]["body"]
                for request in oort.model.requests
                if request["method"] == "PATCH"
            ]
            self.assertTrue(bodies)
            for earlier, later in zip(bodies, bodies[1:]):
                self.assertTrue(later.startswith(earlier), "bodies are absolute, never deltas")

    def test_a_short_answer_is_one_plain_write(self):
        """Most replies never fill a buffer, and they must still arrive.

        Measured on the local stack before this branch existed: a reply shorter
        than `flush_chars` produced **no message at all**, because nothing ever
        opened the stream and `close` had nothing to close. One plain POST, no
        stream marker — the answer never grew, so there is no history to claim.
        """
        with FakeOort() as oort:
            relay = StreamRelay(client_for(oort), client_msg_id=str(uuid.uuid4()), flush_chars=10_000)
            relay.add("네, 됐습니다.")
            self.assertTrue(relay.close("text_end"))
            self.assertEqual(len(oort.model.messages), 1)
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["body"], "네, 됐습니다.")
            self.assertNotIn(STREAM_PROPS_KEY, message["props"], "a whole answer is not a stream")
            self.assertEqual(len(oort.model.requests), 1, "one write, not open-then-close")

    def test_a_short_answer_that_stopped_still_says_so(self):
        with FakeOort() as oort:
            relay = StreamRelay(client_for(oort), client_msg_id=str(uuid.uuid4()), flush_chars=10_000)
            relay.add("네, 됐")
            self.assertTrue(relay.close("cancel", outcome="cancelled"))
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["outcome"], "cancelled")
            self.assertFalse(message["streaming"])

    def test_an_answer_that_said_nothing_writes_nothing(self):
        with FakeOort() as oort:
            relay = StreamRelay(client_for(oort), client_msg_id=str(uuid.uuid4()))
            self.assertFalse(relay.close("agent_end"))
            self.assertEqual(len(oort.model.messages), 0)

    def test_a_replayed_slice_is_a_no_op_not_an_error(self):
        with FakeOort() as oort:
            client = client_for(oort)
            opened = client.post_message(client_msg_id="k1", message_type="text", body="답이", opens_stream=True)
            client.patch_stream(opened["id"], body="답이 자", rev=1, is_final=False)
            client.patch_stream(opened["id"], body="답이 자라", rev=2, is_final=False)
            # A late duplicate of rev 1 arrives after rev 2.
            client.patch_stream(opened["id"], body="답이 자", rev=1, is_final=False)
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["body"], "답이 자라", "a stale slice must not rewind the message")
            self.assertEqual(message["rev"], 2)


class RefineAnnouncement(unittest.TestCase):
    """contract — ADR-0158 D1~D4 as the channel sees them."""

    def test_the_block_is_top_level_and_the_props_are_the_server_s(self):
        with FakeOort() as oort:
            announcer = RefineAnnouncer(client_for(oort), agent_handle="김인턴")
            announcer.announce_refine_complete(
                {
                    "id": "refine_1",
                    "scope": "global",
                    "summary": "기억 1건 추가",
                    "rollbackId": "rollback_1",
                    "appliedEdits": [{"action": "create", "kind": "memory", "id": "e1", "applied": True}],
                }
            )
            sent = oort.model.requests[0]["payload"]
            self.assertIn("harnessRefine", sent, "a top-level block, not a props key")
            self.assertNotIn(REFINE_PROPS_KEY, sent.get("props", {}))
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["type"], "system", "ADR-0158 D2 — no new message type")
            stored = message["props"][REFINE_PROPS_KEY]
            self.assertEqual(stored["refinementId"], "refine_1")
            self.assertEqual(stored["edits"], [{"action": "create", "kind": "memory", "id": "e1"}])
            self.assertEqual(stored["summary"], "기억 1건 추가")
            self.assertEqual(stored["rollbackId"], "rollback_1", "D3 — recorded, nothing promised")

    def test_the_harness_global_scope_is_never_repeated_to_the_channel(self):
        with FakeOort() as oort:
            announcer = RefineAnnouncer(client_for(oort))
            announcer.announce_refine_complete({"id": "refine_1", "scope": "global", "appliedEdits": []})
            sent = oort.model.requests[0]["payload"]["harnessRefine"]
            self.assertEqual(sent["scope"], "workspace", "the harness's word is not repeated on the wire")
            stored = next(iter(oort.model.messages.values()))["props"][REFINE_PROPS_KEY]
            self.assertEqual(
                stored["scope"],
                "workspace",
                "one workspace per HOME means the harness's 'global' is our workspace",
            )

    def test_no_edit_content_reaches_the_channel(self):
        secret = "the user's private plan, quoted verbatim by the harness"
        with FakeOort() as oort:
            announcer = RefineAnnouncer(client_for(oort))
            announcer.announce_refine_complete(
                {"id": "refine_1", "appliedEdits": [{"id": "e1", "before": secret, "after": secret}]}
            )
            message = next(iter(oort.model.messages.values()))
            self.assertNotIn(secret, json.dumps(message, ensure_ascii=False))

    def test_the_observed_drift_trigger_claims_only_what_was_seen(self):
        with FakeOort() as oort:
            announcer = RefineAnnouncer(client_for(oort))
            announcer.announce_observed_drift(
                {"after": {"sha256": "abc"}, "newEntryIds": ["e9"], "newRefinementIds": []}
            )
            stored = next(iter(oort.model.messages.values()))["props"][REFINE_PROPS_KEY]
            self.assertEqual(stored["trigger"], TRIGGER_OBSERVED_DRIFT)
            self.assertEqual(stored["refinementId"], drift_refinement_id("abc"))
            self.assertNotIn("summary", stored, "we saw a file change, not a decision")

    def test_the_body_is_a_sentence_and_the_ids_are_not_in_it(self):
        body = refine_body("김인턴", 2, "command")
        self.assertIn("김인턴", body)
        self.assertNotIn("{", body)
        self.assertNotIn("—", body, "em-dash is banned in user-visible copy")


class Idempotency(unittest.TestCase):
    """contract — the same fact announced twice is one message."""

    def test_the_refinement_id_decides_the_client_msg_id(self):
        """D4's property, on a wire that types `clientMsgId` as a UUID.

        Posting the raw `RefinementResult.id` answers 422 (`UUID parsing
        failed`), measured against the local Rust stack. The key is therefore a
        UUIDv5 **of** that id: still a pure function of the value D4 named, so a
        second process announcing the same refinement computes the same key.
        """
        with FakeOort() as oort:
            announcer = RefineAnnouncer(client_for(oort))
            announcer.announce_refine_complete({"id": "refine_42", "appliedEdits": []})
            message = next(iter(oort.model.messages.values()))
            self.assertEqual(message["clientMsgId"], harness_refine_client_msg_id("refine_42"))
            uuid.UUID(message["clientMsgId"])  # the route decodes it or nothing else matters
            self.assertNotEqual(message["clientMsgId"], harness_refine_client_msg_id("refine_43"))

    def test_an_observed_drift_key_is_stable_for_the_same_state(self):
        first = harness_refine_client_msg_id(drift_refinement_id("sha-abc"))
        second = harness_refine_client_msg_id(drift_refinement_id("sha-abc"))
        third = harness_refine_client_msg_id(drift_refinement_id("sha-def"))
        self.assertEqual(first, second)
        self.assertNotEqual(first, third)

    def test_a_forgetful_restart_does_not_duplicate(self):
        with FakeOort() as oort:
            client = client_for(oort)
            for _ in range(2):
                announcer = RefineAnnouncer(client)  # a fresh process each time
                announcer.announce_refine_complete({"id": "refine_42", "appliedEdits": [{"id": "e1"}]})
            self.assertEqual(len(oort.model.messages), 1)


class RedProofs(unittest.TestCase):
    """RED PROOF — remove the guard, reproduce the measured failure."""

    def test_removing_the_idempotency_key_duplicates_the_announcement(self):
        """D4's key, deleted — in both worlds, because they fail differently.

        The mutation is exactly the spike's behaviour: `RestSink` minted a fresh
        `clientMsgId` per write, and spike §8 wrote down that a retry would
        therefore duplicate. Here it is that sentence turned into a failing run.

        Against a server **without** D4 the mutation duplicates the announcement,
        which is the damage. Against the landed server it is refused by name,
        which is the guard working from the other side — and the refusal is
        worth asserting because a server that silently rewrote the key would
        leave the producer holding a key it could not retry with.
        """
        mutate = lambda _refinement_id: str(uuid.uuid4())  # noqa: E731

        with FakeOort(validates_refine_key=False) as oort:
            mutated = RefineAnnouncer(client_for(oort), key_factory=mutate)
            for _ in range(2):
                mutated.announce_refine_complete({"id": "refine_42", "appliedEdits": [{"id": "e1"}]})
            self.assertEqual(
                len(oort.model.messages), 2, "without a stable key the retry is a second announcement"
            )
            self.assertEqual(len(oort.model.of_type("system")), 2)

        with FakeOort() as oort:
            mutated = RefineAnnouncer(client_for(oort), key_factory=mutate)
            with self.assertRaises(OortError) as caught:
                mutated.announce_refine_complete({"id": "refine_42", "appliedEdits": [{"id": "e1"}]})
            self.assertEqual(caught.exception.status, 400)
            self.assertIn(harness_refine_client_msg_id("refine_42"), caught.exception.body)
            self.assertEqual(len(oort.model.messages), 0)

        # ...and with the derivation in place, two announcements are one message.
        with FakeOort() as oort:
            announcer = RefineAnnouncer(client_for(oort))
            for _ in range(2):
                announcer.emitted.clear()
                announcer.announce_refine_complete({"id": "refine_42", "appliedEdits": [{"id": "e1"}]})
            self.assertEqual(len(oort.model.messages), 1)

    def test_sending_harness_text_is_refused_not_trimmed(self):
        """RED PROOF for the disclosure rule (§2.2).

        `_wire_edits` drops `before`/`after` at the source. If it ever stopped,
        the block would reach a `deny_unknown_fields` server and be refused —
        the outer of the two locks. Asserting the refusal here is what proves the
        outer lock exists, rather than trusting that our own filter is enough.
        """
        with FakeOort() as oort:
            client = client_for(oort)
            secret = "사용자가 어제 말한 배포 비밀"
            with self.assertRaises(OortError) as caught:
                client.post_message(
                    client_msg_id=harness_refine_client_msg_id("refine_leak"),
                    message_type="system",
                    body="김인턴이 자기 작업 방식을 갱신했습니다",
                    harness_refine={
                        "refinementId": "refine_leak",
                        "trigger": "command",
                        "scope": "workspace",
                        "edits": [{"action": "create", "kind": "memory", "id": "e1", "before": secret}],
                    },
                )
            self.assertEqual(caught.exception.status, 400)
            self.assertIn("before", caught.exception.body)
            self.assertEqual(len(oort.model.messages), 0)

    def test_a_non_increasing_rev_freezes_the_answer(self):
        """The monotone counter, deleted: the message stops growing.

        `stream_message_body_in_tx` treats a not-newer `rev` as a no-op — that is
        the staleness guard that makes retries safe. A producer that reuses a
        revision therefore does not error; it silently stops appearing to say
        anything, which is the worst of the three possible failures and the
        reason the counter lives in one place.
        """
        with FakeOort() as oort:
            client = client_for(oort)
            opened = client.post_message(client_msg_id="k1", message_type="text", body="답", opens_stream=True)
            client.patch_stream(opened["id"], body="답이", rev=1, is_final=False)
            client.patch_stream(opened["id"], body="답이 자라", rev=1, is_final=False)  # mutation
            frozen = next(iter(oort.model.messages.values()))["body"]
            self.assertEqual(frozen, "답이", "a reused rev is dropped, and the answer stops moving")

        with FakeOort() as oort:
            client = client_for(oort)
            opened = client.post_message(client_msg_id="k1", message_type="text", body="답", opens_stream=True)
            client.patch_stream(opened["id"], body="답이", rev=1, is_final=False)
            client.patch_stream(opened["id"], body="답이 자라", rev=2, is_final=False)
            self.assertEqual(next(iter(oort.model.messages.values()))["body"], "답이 자라")

    def test_relative_bodies_would_truncate_the_answer(self):
        """The absolute body, deleted: the channel keeps only the last delta.

        Not a hypothetical — `body` on a slice replaces, it does not append. The
        accumulator lives in `StreamRelay` for this reason and nowhere else.
        """
        with FakeOort() as oort:
            client = client_for(oort)
            opened = client.post_message(client_msg_id="k1", message_type="text", body="첫", opens_stream=True)
            client.patch_stream(opened["id"], body="둘째", rev=1, is_final=False)  # mutation: delta, not absolute
            client.patch_stream(opened["id"], body="셋째", rev=2, is_final=True)
            self.assertEqual(next(iter(oort.model.messages.values()))["body"], "셋째")

        with FakeOort() as oort:
            relay = StreamRelay(client_for(oort), client_msg_id=str(uuid.uuid4()), flush_chars=1)
            relay.add("첫")
            relay.add("둘째")
            relay.close("text_end")
            self.assertEqual(next(iter(oort.model.messages.values()))["body"], "첫둘째")


class IsolationLever(unittest.TestCase):
    """fail-closed — the boundary cannot be dropped by a typo."""

    ENTRYPOINT = os.path.join(PACKAGE_ROOT, "prime", "container", "entrypoint.sh")

    def run_entrypoint(self, env: dict[str, str]) -> subprocess.CompletedProcess:
        merged = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        merged.update(env)
        return subprocess.run(
            ["bash", self.ENTRYPOINT, "true"],
            env=merged,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_a_nameless_workspace_is_refused(self):
        result = self.run_entrypoint({})
        self.assertEqual(result.returncode, 2)
        self.assertIn("OORT_PRIME_WORKSPACE_ID is required", result.stderr)

    def test_dropping_isolation_needs_an_explicit_unsafe_opt_in(self):
        result = self.run_entrypoint({"OORT_PRIME_WORKSPACE_ID": "ws-a", "OORT_PRIME_ISOLATION": "off"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("red-proof lever", result.stderr)

    def test_an_unknown_isolation_mode_is_refused_rather_than_guessed(self):
        result = self.run_entrypoint({"OORT_PRIME_WORKSPACE_ID": "ws-a", "OORT_PRIME_ISOLATION": "ful"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown OORT_PRIME_ISOLATION", result.stderr)


class HarnessWatching(unittest.TestCase):
    """contract — the disk half of refine auditing."""

    def setUp(self):
        import tempfile

        self.dir = tempfile.mkdtemp(prefix="oort-prime-harness-")
        self.path = os.path.join(self.dir, "harness_state.json")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, entry_id: str, refinement_id: str) -> None:
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "entries": {"memory": {entry_id: {}}},
                    "refinements": [{"id": refinement_id}],
                },
                handle,
            )

    def test_a_missing_file_is_a_baseline_not_an_error(self):
        observer = HarnessObserver(self.path)
        self.assertFalse(observer.baseline["exists"])
        self.assertIsNone(observer.drift())

    def test_the_first_write_is_a_drift_with_its_new_ids(self):
        observer = HarnessObserver(self.path)
        self.write("e1", "r1")
        drift = observer.drift()
        self.assertIsNotNone(drift)
        self.assertEqual(drift["newEntryIds"], ["e1"])
        self.assertEqual(drift["newRefinementIds"], ["r1"])

    def test_reading_the_drift_does_not_consume_it(self):
        observer = HarnessObserver(self.path)
        self.write("e1", "r1")
        self.assertIsNotNone(observer.drift())
        self.assertIsNotNone(observer.drift(), "a failed announcement must be retried, not lost")
        observer.accept()
        self.assertIsNone(observer.drift())

    def test_a_half_written_file_still_counts_as_a_change(self):
        observer = HarnessObserver(self.path)
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write('{"entries": {')
        drift = observer.drift()
        self.assertIsNotNone(drift)
        self.assertEqual(drift["after"].get("parse"), "failed")


class TransportRules(unittest.TestCase):
    """contract — what the client refuses before it sends anything."""

    def test_plaintext_off_loopback_is_refused_by_default(self):
        with self.assertRaises(ValueError):
            OortClient("http://api.example.com", WS, CH, "t")
        OortClient("http://127.0.0.1:8080", WS, CH, "t")
        OortClient("https://api.example.com", WS, CH, "t")
        OortClient("http://api.example.com", WS, CH, "t", allow_insecure_http=True)

    def test_a_client_mistake_is_not_retried(self):
        with FakeOort() as oort:
            client = client_for(oort, run_id="run-1", send_run_id_field=True)
            with self.assertRaises(OortError) as caught:
                client.post_message(client_msg_id="k1", message_type="text", body="답")
            self.assertEqual(caught.exception.status, 400)
            self.assertEqual(len(oort.model.requests), 1, "a 400 is the caller's mistake; repeating it is noise")


if __name__ == "__main__":
    unittest.main(verbosity=2)
