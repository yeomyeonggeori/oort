import asyncio
import dataclasses
import inspect
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "research" / "11-agent-runtime" / "fixtures" / "hermes-adapter-contract-v0"
sys.path.insert(0, str(REPO_ROOT / "adapters" / "hermes"))

# The repo's static gate may run with a Python that can py_compile the adapter
# but cannot import dataclass(slots=True). Keep this contract test dependency-free
# and focused on adapter shapes by dropping that import-time hint when needed.
if "slots" not in inspect.signature(dataclasses.dataclass).parameters:
    _dataclass = dataclasses.dataclass

    def _dataclass_without_slots(*args, **kwargs):
        kwargs.pop("slots", None)
        return _dataclass(*args, **kwargs)

    dataclasses.dataclass = _dataclass_without_slots

import momo_adapter  # noqa: E402
import smoke_momo_adapter  # noqa: E402

TEST_JOB_ID = 341
TEST_LEASE_ID = "00000000-0000-7341-8000-000000000341"
TEST_LEASE_EXPIRES_AT_MS = 4_102_444_800_000


def claimed_job(job, *, job_id=TEST_JOB_ID):
    return {
        **job,
        "id": job_id,
        "leaseId": TEST_LEASE_ID,
        "leaseExpiresAtMs": TEST_LEASE_EXPIRES_AT_MS,
    }


def claimed_event(event, *, job_id=TEST_JOB_ID):
    return {
        **event,
        "job_id": job_id,
        "lease_id": TEST_LEASE_ID,
        "lease_expires_at_ms": TEST_LEASE_EXPIRES_AT_MS,
    }


class CaptureAdapter(momo_adapter.MomoAdapter):
    def __init__(self, *, workspace_id, agent_member_id, run_id, final_text):
        cfg = momo_adapter.MomoConfig(
            api_base_url="http://momo.test",
            workspace_id=workspace_id,
            agent_member_id=agent_member_id,
            agent_handle="kim-intern",
            agent_token="agent-token-fixture",
            allow_insecure_http=True,
        )
        super().__init__(cfg)
        self._member_id = agent_member_id
        self.run_id = run_id
        self.final_text = final_text
        self.posts = []
        self.gateway_posts = []

    async def _post(self, path, body):
        call = {"method": "POST", "path": path, "body": dict(body)}
        if "/gateway/" in path:
            self.gateway_posts.append(call)
            return {"status": "accepted"}
        self.posts.append(call)
        if path.endswith("/invoke"):
            return {"runId": self.run_id}
        return {"id": "message-fixture", "seq": 43}

    async def handle_message(self, event):
        if (
            isinstance(event, dict)
            and event.get("type") == "agent.job"
            and "lease_id" not in event
        ):
            event = claimed_event(event)
        await super().handle_message(event)

    async def _collect_run_output(self, run_id):
        self.assert_run_id = run_id
        return self.final_text


def load_fixture(name):
    with (FIXTURE_DIR / name).open("r", encoding="utf-8") as fh:
        return json.load(fh)


class HermesAdapterContractTests(unittest.TestCase):
    def test_agentworker_sse_fixture_keeps_momo_owned_controls(self):
        fixture = load_fixture("agentworker_openai_sse_input.json")
        body = fixture["http_request"]["body"]

        self.assertEqual(fixture["mode"], "agentworker_openai_sse_default")
        self.assertEqual(fixture["owner"], "momo")
        self.assertTrue(body["stream"])
        self.assertTrue(body["stream_options"]["include_usage"])
        self.assertEqual(fixture["momo_run"]["context_packet_id"], fixture["momo_owned_controls"]["context_packet"]["packet_id"])
        self.assertEqual(set(fixture["momo_owned_controls"].keys()), {"context_packet", "approval", "cost", "audit"})

        serialized_body = json.dumps(body, sort_keys=True)
        for forbidden in fixture["forbidden_runtime_inputs"]:
            self.assertNotIn(forbidden, serialized_body)

    def test_platform_adapter_fixture_unwraps_to_adapter_event(self):
        fixture = load_fixture("platform_adapter_event_mapping.json")
        raw = json.dumps(fixture["input_centrifugo_push"])
        frame = momo_adapter.MomoAdapter._iter_frames(raw)[0]
        push = frame["push"]
        envelope = push["pub"]["data"]
        event = {
            "channel": push["channel"],
            "type": envelope["type"],
            "seq": envelope["seq"],
            "ts": envelope["ts"],
            "payload": envelope["payload"],
        }

        self.assertEqual(event, fixture["unwrapped_adapter_event"])

    def test_centrifugo_ping_frame_maps_to_pong_command(self):
        frame = momo_adapter.MomoAdapter._iter_frames('{}')[0]

        self.assertEqual(momo_adapter.MomoAdapter._pong_for_frame(frame), {})
        self.assertEqual(
            momo_adapter.MomoAdapter._pong_for_frame({"ping": {}}), {"pong": {}}
        )
        self.assertIsNone(momo_adapter.MomoAdapter._pong_for_frame({"id": 1}))

    def test_agent_work_channel_matches_swift_uuid_uppercase_rendering(self):
        self.assertEqual(
            momo_adapter.agent_channel(
                "ca761232-ed42-11ce-bacd-00aa0057b223",
                "0f8fad5b-d9cb-469f-a165-70867728950e",
            ),
            "agentwork:wsCA761232-ED42-11CE-BACD-00AA0057B223."
            "0F8FAD5B-D9CB-469F-A165-70867728950E",
        )

    def test_handle_message_maps_platform_event_to_momo_rest_shapes(self):
        fixture = load_fixture("platform_adapter_event_mapping.json")
        event = fixture["unwrapped_adapter_event"]
        expected = fixture["expected_momo_mapping"]
        payload = event["payload"]
        run_id = expected["final_message_send"]["body"]["runId"]
        final_text = expected["final_message_send"]["body"]["body"]
        adapter = CaptureAdapter(
            workspace_id=payload["workspaceId"],
            agent_member_id=payload["agentMemberId"],
            run_id=run_id,
            final_text=final_text,
        )

        asyncio.run(adapter.handle_message(event))

        self.assertEqual(adapter.posts[0], expected["invoke"])
        self.assertEqual(adapter.posts[1], expected["final_message_send"])
        self.assertEqual(adapter.assert_run_id, run_id)

    def test_repo_local_smoke_harness_captures_rest_mapping(self):
        summary = asyncio.run(smoke_momo_adapter.run_smoke())

        self.assertEqual(summary["result"], "PASS")
        self.assertEqual(summary["network"], "not-used")
        self.assertEqual(len(summary["captured_rest_calls"]), 2)
        self.assertEqual(
            summary["runtime_unverified"], "live Hermes gateway plugin load/e2e"
        )

    def test_agent_job_event_reports_status_and_complete_to_momo_rest(self):
        fixture = load_fixture("gateway_agent_job_mapping.json")
        raw = json.dumps(fixture["input_centrifugo_push"])
        frame = momo_adapter.MomoAdapter._iter_frames(raw)[0]
        push = frame["push"]
        envelope = push["pub"]["data"]
        event = {
            "channel": push["channel"],
            "type": envelope["type"],
            "seq": envelope["seq"],
            "ts": envelope["ts"],
            "payload": envelope["payload"],
            **fixture["pending_claim"],
        }

        class Runtime:
            def run_momo_job(self, payload):
                return {
                    "body": "Drafted a release checklist issue proposal for approval.",
                    "usage": {
                        "model": payload["model"],
                        "prompt_tokens": 0,
                        "completion_tokens": 0,
                        "cached_tokens": 0,
                        "reasoning_tokens": 0,
                        "cost_micro_usd": 0,
                        "was_estimated": True,
                    },
                }

        payload = event["payload"]
        adapter = CaptureAdapter(
            workspace_id=payload["workspace_id"],
            agent_member_id=payload["agent_member_id"],
            run_id=payload["run_id"],
            final_text="unused",
        )
        adapter.runtime = Runtime()

        asyncio.run(adapter.handle_message(event))

        self.assertEqual(adapter.gateway_posts, fixture["expected_momo_callbacks"])

    def test_gateway_provider_stream_forwards_bounded_status_and_partial_events(self):
        class Runtime:
            async def stream_momo_job(self, _payload):
                yield {"type": "text.delta", "delta": "안녕, "}
                yield {
                    "object": "chat.completion.chunk",
                    "choices": [{"delta": {"content": "gateway"}}],
                }
                yield {
                    "type": "finished",
                    "status": "succeeded",
                    "body": "안녕, gateway",
                    "usage": {},
                }

        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="unused",
        )
        adapter.runtime = Runtime()
        event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
            },
        }

        asyncio.run(adapter.handle_message(event))

        callbacks = [call["body"] for call in adapter.gateway_posts]
        self.assertEqual(callbacks[0]["status"], "running")
        self.assertEqual(callbacks[1]["status"], "thinking")
        self.assertIn("event_id", callbacks[1])
        partials = [body for body in callbacks if body["status"] == "streaming"]
        self.assertEqual("".join(body["text_delta"] for body in partials), "안녕, gateway")
        self.assertTrue(all(len(body["text_delta"].encode("utf-8")) <= 8192 for body in partials))
        self.assertEqual(callbacks[-1]["status"], "succeeded")
        self.assertEqual(callbacks[-1]["body"], "안녕, gateway")

    def test_gateway_delta_chunking_preserves_unicode_and_server_size_contract(self):
        text = "가" * 6000
        chunks = momo_adapter.MomoAdapter._bounded_gateway_delta_chunks(text)

        self.assertEqual("".join(chunks), text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk.encode("utf-8")) <= 8192 for chunk in chunks))

    def test_gateway_provider_stream_error_completes_as_failed(self):
        class Runtime:
            async def stream_momo_job(self, _payload):
                yield {"type": "error", "error": "provider stream failed"}

        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="unused",
        )
        adapter.runtime = Runtime()
        event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
            },
        }

        asyncio.run(adapter.handle_message(event))

        completion = adapter.gateway_posts[-1]["body"]
        self.assertEqual(completion["status"], "failed")
        self.assertEqual(completion["error"], "provider stream failed")

    def test_gateway_tool_call_pauses_with_approval_request_callback(self):
        class Runtime:
            def run_momo_job(self, _payload):
                return {
                    "status": "approval_required",
                    "tool_call": {
                        "id": "call-release-1",
                        "name": "create_github_issue",
                        "arguments": {"title": "Release checklist"},
                    },
                    "title": "Create release issue",
                    "summary": "Review the issue before Hermes creates it.",
                    "is_reversible": False,
                }

        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="unused",
        )
        adapter.runtime = Runtime()
        event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
            },
        }

        asyncio.run(adapter.handle_message(event))

        self.assertEqual(len(adapter.gateway_posts), 2)
        self.assertEqual(adapter.gateway_posts[0]["body"]["status"], "running")
        callback = adapter.gateway_posts[1]["body"]
        self.assertEqual(callback["status"], "approval_request")
        self.assertEqual(
            callback["approval_request"]["tool_call"],
            {
                "call_id": "call-release-1",
                "name": "create_github_issue",
                "arguments": {"title": "Release checklist"},
            },
        )
        self.assertNotIn("run-1", adapter._pending_gateway_results)

    def test_gateway_malformed_approval_request_fails_closed(self):
        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="unused",
        )
        with self.assertRaises(momo_adapter.MomoApprovalContractError):
            adapter._normalize_gateway_result(
                {
                    "status": "approval_required",
                    "tool_call": {"name": "create_github_issue", "arguments": {}},
                },
                {},
            )

    def test_gateway_approved_resume_uses_resume_runtime_and_completes(self):
        class Runtime:
            def __init__(self):
                self.resume_calls = 0

            def resume_momo_job(self, payload):
                self.resume_calls += 1
                self.approval_id = payload["resume_from_approval_id"]
                return {"status": "succeeded", "body": "Issue created", "usage": {}}

            def run_momo_job(self, _payload):
                raise AssertionError("approved resume must not restart a fresh job")

        runtime = Runtime()
        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="unused",
        )
        adapter.runtime = runtime
        event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
                "resume_from_approval_id": "approval-1",
                "approval_decision": {"status": "approved"},
            },
        }

        asyncio.run(adapter.handle_message(event))

        self.assertEqual(runtime.resume_calls, 1)
        self.assertEqual(runtime.approval_id, "approval-1")
        self.assertEqual(adapter.gateway_posts[0]["body"]["status"], "running")
        self.assertIn("resuming", adapter.gateway_posts[0]["body"]["detail"])
        self.assertEqual(adapter.gateway_posts[1]["body"]["status"], "succeeded")

    def test_gateway_rejected_resume_stops_without_provider_execution(self):
        class Runtime:
            def run_momo_job(self, _payload):
                raise AssertionError("rejected approval must not execute provider work")

        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="unused",
        )
        adapter.runtime = Runtime()
        event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
                "resume_from_approval_id": "approval-1",
                "approval_decision": {"status": "rejected"},
            },
        }

        asyncio.run(adapter.handle_message(event))

        self.assertEqual(len(adapter.gateway_posts), 1)
        self.assertEqual(adapter.gateway_posts[0]["body"]["status"], "cancelled")
        self.assertIn("provider execution stopped", adapter.gateway_posts[0]["body"]["detail"])

    def test_register_platform_accepts_gateway_like_registry(self):
        class Registry:
            def __init__(self):
                self.calls = []

            def register(self, platform, adapter_cls):
                self.calls.append((platform, adapter_cls))

        registry = Registry()
        adapter_cls = momo_adapter.register_platform(registry)

        self.assertIs(adapter_cls, momo_adapter.MomoAdapter)
        self.assertEqual(registry.calls, [("momo", momo_adapter.MomoAdapter)])

    def test_register_accepts_latest_context_style(self):
        class Context:
            def __init__(self):
                self.kwargs = None

            def register_platform(self, **kwargs):
                self.kwargs = kwargs

        context = Context()
        adapter_cls = momo_adapter.register(context)

        self.assertIs(adapter_cls, momo_adapter.MomoAdapter)
        self.assertEqual(context.kwargs["name"], "momo")
        self.assertEqual(context.kwargs["label"], "Momo")
        self.assertIs(context.kwargs["adapter_factory"], momo_adapter.adapter_factory)
        self.assertIn("MOMO_AGENT_TOKEN", context.kwargs["required_env"])
        self.assertNotIn("MOMO_AGENT_GATEWAY_SECRET", context.kwargs["required_env"])

    def test_register_accepts_strict_hermes_platform_entry_signature(self):
        class Context:
            def __init__(self):
                self.kwargs = None

            def register_platform(
                self,
                name,
                label,
                adapter_factory,
                check_fn,
                validate_config=None,
                required_env=None,
                install_hint="",
                **entry_kwargs,
            ):
                allowed_entry_kwargs = {"env_enablement_fn", "emoji", "platform_hint"}
                unknown = set(entry_kwargs) - allowed_entry_kwargs
                if unknown:
                    raise TypeError(f"unknown PlatformEntry kwargs: {unknown}")
                self.kwargs = {
                    "name": name,
                    "label": label,
                    "adapter_factory": adapter_factory,
                    "check_fn": check_fn,
                    "validate_config": validate_config,
                    "required_env": required_env,
                    "install_hint": install_hint,
                    **entry_kwargs,
                }

        context = Context()
        adapter_cls = momo_adapter.register(context)

        self.assertIs(adapter_cls, momo_adapter.MomoAdapter)
        self.assertEqual(context.kwargs["name"], "momo")
        self.assertIs(context.kwargs["adapter_factory"], momo_adapter.adapter_factory)
        self.assertIs(context.kwargs["env_enablement_fn"], momo_adapter.env_enablement)
        self.assertNotIn("optional_env", context.kwargs)
        self.assertNotIn("description", context.kwargs)

    def test_get_chat_info_satisfies_hermes_v018_adapter_contract(self):
        class ChannelInfoAdapter(CaptureAdapter):
            async def _get(self, path):
                self.get_path = path
                return {
                    "channels": [
                        {
                            "id": "channel-1",
                            "name": "agent-lab",
                            "kind": "public",
                            "topic": "Hermes local smoke",
                        }
                    ]
                }

        adapter = ChannelInfoAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        info = asyncio.run(adapter.get_chat_info("channel-1"))

        self.assertEqual(adapter.get_path, "/v1/workspaces/workspace-1/channels")
        self.assertEqual(info["name"], "agent-lab")
        self.assertEqual(info["type"], "channel")
        self.assertEqual(info["topic"], "Hermes local smoke")

    def test_get_chat_info_falls_back_before_login(self):
        old_home_id = os.environ.get("MOMO_HOME_CHANNEL_ID")
        old_home_name = os.environ.get("MOMO_HOME_CHANNEL_NAME")
        os.environ["MOMO_HOME_CHANNEL_ID"] = "channel-1"
        os.environ["MOMO_HOME_CHANNEL_NAME"] = "general"
        try:
            adapter = CaptureAdapter(
                workspace_id="workspace-1",
                agent_member_id="agent-1",
                run_id="run-1",
                final_text="done",
            )

            info = asyncio.run(adapter.get_chat_info("channel-1"))
        finally:
            if old_home_id is None:
                os.environ.pop("MOMO_HOME_CHANNEL_ID", None)
            else:
                os.environ["MOMO_HOME_CHANNEL_ID"] = old_home_id
            if old_home_name is None:
                os.environ.pop("MOMO_HOME_CHANNEL_NAME", None)
            else:
                os.environ["MOMO_HOME_CHANNEL_NAME"] = old_home_name

        self.assertEqual(info["name"], "general")
        self.assertEqual(info["type"], "channel")

    def test_env_enablement_requires_momo_facing_values_only(self):
        self.assertIsNone(momo_adapter.env_enablement({"MOMO_API_URL": "http://127.0.0.1:28180"}))

        enabled = momo_adapter.env_enablement(
            {
                "MOMO_API_URL": "http://127.0.0.1:28180",
                "MOMO_WORKSPACE_ID": "workspace",
                "MOMO_AGENT_MEMBER_ID": "agent",
                "MOMO_AGENT_TOKEN": "momo-agent-token",
                "OPENAI_API_KEY": "must-not-be-consumed",
            }
        )

        self.assertIsNotNone(enabled)
        self.assertEqual(enabled["MOMO_AGENT_MEMBER_ID"], "agent")
        self.assertEqual(enabled["MOMO_AGENT_TOKEN"], "momo-agent-token")
        self.assertNotIn("OPENAI_API_KEY", enabled)
        self.assertNotIn("MOMO_AGENT_GATEWAY_SECRET", enabled)
        self.assertNotIn("MOMO_AGENT_EMAIL", enabled)
        self.assertNotIn("MOMO_AGENT_PASSWORD", enabled)

    def test_validate_config_requires_per_agent_bearer(self):
        valid, detail = momo_adapter.validate_config(
            {
                "MOMO_API_URL": "http://127.0.0.1:28180",
                "MOMO_WORKSPACE_ID": "workspace",
                "MOMO_AGENT_MEMBER_ID": "agent",
            }
        )

        self.assertFalse(valid)
        self.assertIn("MOMO_AGENT_TOKEN", detail)

    def test_auth_headers_use_only_per_agent_bearer(self):
        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )

        self.assertEqual(
            adapter._auth_headers(),
            {
                "Content-Type": "application/json",
                "Authorization": "Bearer agent-token-fixture",
            },
        )
        self.assertFalse(hasattr(adapter, "_login"))
        self.assertFalse(hasattr(adapter, "_refresh_token"))

    def test_connect_is_login_free_and_recovers_pending_once(self):
        class ConnectAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.calls = []

            async def _fetch_realtime_token(self):
                self.calls.append("realtime-token")

            async def _open_realtime(self):
                self.calls.append("agent-subscribe")

            async def _drain_pending_gateway_jobs(self, *, reason):
                self.calls.append(f"pending:{reason}")

        adapter = ConnectAdapter()
        self.assertTrue(asyncio.run(adapter.connect()))
        self.assertEqual(
            adapter.calls,
            ["realtime-token", "agent-subscribe", "pending:connect"],
        )
        self.assertIsNone(adapter._pending_recovery_task)

    def test_realtime_subscribes_only_to_agent_work_stream(self):
        class FakeWebSocket:
            def __init__(self):
                self.sent = []

            async def send(self, value):
                self.sent.append(json.loads(value))

            async def close(self):
                return None

            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        class FakeWebSockets:
            def __init__(self):
                self.socket = FakeWebSocket()

            async def connect(self, _url):
                return self.socket

        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        adapter._realtime_token = "short-lived-realtime-token"
        fake_websockets = FakeWebSockets()

        async def exercise():
            await adapter._open_realtime()
            await asyncio.sleep(0)
            adapter.reconnect_was_scheduled = adapter._reconnect_task is not None
            await adapter.close()

        with patch.object(momo_adapter, "websockets", fake_websockets):
            asyncio.run(exercise())

        self.assertEqual(
            fake_websockets.socket.sent,
            [
                {"connect": {"token": "short-lived-realtime-token"}, "id": 1},
                {
                    "subscribe": {"channel": "agentwork:wsworkspace-1.agent-1"},
                    "id": 2,
                },
            ],
        )
        self.assertTrue(adapter.reconnect_was_scheduled)

    def test_pending_recovery_accepts_current_and_legacy_payload_shapes(self):
        class PendingAdapter(CaptureAdapter):
            _pending_page_size = 2
            _max_pending_pages = 1

            async def _get(self, path):
                self.pending_path = path
                return {
                    "jobs": [
                        claimed_job(
                            {"type": "agent.job", "payload": {"run_id": "run-1"}},
                            job_id=1,
                        ),
                        claimed_job({
                            "type": "agent.job",
                            "payloadJson": json.dumps({"run_id": "run-2"}),
                        }, job_id=2),
                    ]
                }

            async def handle_message(self, event):
                self.events = getattr(self, "events", []) + [event]

        adapter = PendingAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        asyncio.run(adapter._drain_pending_gateway_jobs(reason="reconnect"))

        self.assertIn("/gateway/jobs/pending?limit=2", adapter.pending_path)
        self.assertEqual(
            [event["payload"]["run_id"] for event in adapter.events],
            ["run-1", "run-2"],
        )

    def test_pending_claim_requires_well_formed_server_lease(self):
        lease = momo_adapter.MomoAdapter._gateway_job_lease(claimed_job({}))

        self.assertEqual(lease.job_id, TEST_JOB_ID)
        self.assertEqual(lease.lease_id, TEST_LEASE_ID)
        self.assertIsNone(momo_adapter.MomoAdapter._gateway_job_lease({"id": 1}))
        self.assertIsNone(momo_adapter.MomoAdapter._gateway_job_lease({
            "id": 1,
            "leaseId": "not-a-uuid",
            "leaseExpiresAtMs": TEST_LEASE_EXPIRES_AT_MS,
        }))

    def test_gateway_callback_fails_closed_without_owned_lease(self):
        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )

        with self.assertRaises(momo_adapter.MomoGatewayLeaseLost):
            adapter._gateway_callback_body("run-1", {"status": "running"})

    def test_lease_renewal_failure_cancels_inflight_provider(self):
        class Runtime:
            def __init__(self):
                self.cancelled = False

            async def run_momo_job(self, _payload):
                try:
                    await asyncio.Event().wait()
                finally:
                    self.cancelled = True

        class LeaseLossAdapter(CaptureAdapter):
            async def _post(self, path, body):
                if path.endswith("/lease/renew"):
                    raise momo_adapter.MomoAPIError(409, path, "lease taken over")
                return await super()._post(path, body)

        runtime = Runtime()
        adapter = LeaseLossAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="unused",
        )
        adapter.runtime = runtime
        event = claimed_event({
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
            },
        })
        event["lease_expires_at_ms"] = 1

        async def exercise():
            with self.assertRaises(momo_adapter.MomoGatewayLeaseLost):
                await asyncio.wait_for(adapter.handle_message(event), timeout=1)

        asyncio.run(exercise())
        self.assertTrue(runtime.cancelled)

    def test_pending_recovery_drains_successive_bounded_pages(self):
        class PagedAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.pages = 0
                self.events = []

            async def _get(self, _path):
                self.pages += 1
                count = 1 if self.pages <= 2 else 0
                return {
                    "jobs": [
                        claimed_job({
                            "type": "agent.job",
                            "payload": {"run_id": f"run-{self.pages}-{index}"},
                        }, job_id=self.pages * 1000 + index)
                        for index in range(count)
                    ]
                }

            async def handle_message(self, event):
                self.events.append(event)

        adapter = PagedAdapter()
        asyncio.run(adapter._drain_pending_gateway_jobs(reason="reconnect"))

        self.assertEqual(adapter.pages, 3)
        self.assertEqual(len(adapter.events), 2)

    def test_full_pending_page_completes_before_next_fetch(self):
        class DurablePageAdapter(CaptureAdapter):
            _pending_page_size = 2

            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.fetches = 0
                self.completed = []

            async def _get(self, _path):
                self.fetches += 1
                pending = [run for run in ("run-a", "run-b") if run not in self.completed]
                return {
                    "jobs": [
                        claimed_job({
                            "type": "agent.job",
                            "payload": {
                                "run_id": run,
                                "workspace_id": "workspace-1",
                                "channel_id": "channel-1",
                                "agent_member_id": "agent-1",
                            },
                        }, job_id=index + 1)
                        for index, run in enumerate(pending)
                    ]
                }

            async def handle_message(self, event):
                self.completed.append(event["payload"]["run_id"])

        adapter = DurablePageAdapter()
        asyncio.run(adapter._drain_pending_gateway_jobs(reason="full-page"))

        self.assertEqual(adapter.completed, ["run-a", "run-b"])
        self.assertEqual(adapter.fetches, 2)

    def test_terminal_worker_401_unblocks_pending_recovery(self):
        class TerminalAdapter(CaptureAdapter):
            async def _get(self, _path):
                return {
                    "jobs": [
                        claimed_job({
                            "type": "agent.job",
                            "payload": {
                                "run_id": "run-401",
                                "workspace_id": "workspace-1",
                                "channel_id": "channel-1",
                                "agent_member_id": "agent-1",
                            },
                        }, job_id=1)
                    ]
                }

            async def handle_message(self, _event):
                raise momo_adapter.MomoAPIError(401, "gateway/complete", "revoked")

        adapter = TerminalAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )

        async def exercise():
            with self.assertRaises(momo_adapter.MomoAPIError):
                await asyncio.wait_for(
                    adapter._drain_pending_gateway_jobs(reason="connect"), timeout=1
                )

        asyncio.run(exercise())
        self.assertTrue(adapter._closing)

    def test_nonretryable_callback_failure_stops_with_operator_visible_state(self):
        class TerminalAdapter(CaptureAdapter):
            async def _get(self, _path):
                return {
                    "jobs": [
                        claimed_job({
                            "type": "agent.job",
                            "payload": {
                                "run_id": "run-400",
                                "workspace_id": "workspace-1",
                                "channel_id": "channel-1",
                                "agent_member_id": "agent-1",
                            },
                        }, job_id=1)
                    ]
                }

            async def handle_message(self, _event):
                raise momo_adapter.MomoAPIError(400, "gateway/complete", "bad result")

        adapter = TerminalAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )

        async def exercise():
            with self.assertRaises(momo_adapter.MomoAPIError):
                await asyncio.wait_for(
                    adapter._drain_pending_gateway_jobs(reason="connect"), timeout=1
                )

        asyncio.run(exercise())
        self.assertTrue(adapter._closing)
        self.assertIn("HTTP 400", adapter._terminal_failure)

    def test_close_settles_queued_completion_waiters(self):
        class BlockingAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def handle_message(self, _event):
                self.started.set()
                await self.release.wait()

        async def exercise():
            adapter = BlockingAdapter()
            first = asyncio.create_task(
                adapter._enqueue_gateway_work(
                    {"type": "agent.job", "payload": {"run_id": "first"}},
                    wait_until_complete=True,
                )
            )
            await adapter.started.wait()
            second = asyncio.create_task(
                adapter._enqueue_gateway_work(
                    {"type": "agent.job", "payload": {"run_id": "second"}},
                    wait_until_complete=True,
                )
            )
            await asyncio.sleep(0)
            await adapter.close()
            results = await asyncio.gather(first, second, return_exceptions=True)
            return results, adapter._ensure_work_queue().qsize()

        results, queue_size = asyncio.run(exercise())
        self.assertTrue(all(isinstance(result, BaseException) for result in results))
        self.assertEqual(queue_size, 0)

    def test_non401_api_error_redacts_credential_shaped_response(self):
        error = momo_adapter.MomoAPIError(
            400,
            "gateway/complete",
            "echo sk-proj-abcdefghijklmnop eyJheader12.eyJpayload12.signature12",
        )
        self.assertNotIn("sk-proj", str(error))
        self.assertNotIn("eyJheader", str(error))
        self.assertIn("[redacted-provider-token]", str(error))

    def test_401_retries_are_bounded_and_error_is_redacted(self):
        class FakeResponse:
            status = 401

            async def text(self):
                return "server echoed super-secret-agent-token"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

        class FakeSession:
            def __init__(self):
                self.calls = 0

            def get(self, _url, **_kwargs):
                self.calls += 1
                return FakeResponse()

        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        session = FakeSession()
        adapter._ensure_session = AsyncMock(return_value=session)

        with patch.object(asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(momo_adapter.MomoAPIError) as raised:
                asyncio.run(adapter._get("/v1/private"))

        self.assertEqual(session.calls, 3)
        self.assertIn("reissue it from pairing", str(raised.exception))
        self.assertNotIn("super-secret-agent-token", str(raised.exception))

    def test_realtime_token_actor_must_match_configured_agent(self):
        class TokenAdapter(CaptureAdapter):
            async def _post(self, _path, _body):
                return {
                    "token": "realtime-token",
                    "workspaceId": "workspace-1",
                    "memberId": "different-agent",
                }

        adapter = TokenAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )

        with self.assertRaises(momo_adapter.MomoConfigurationError):
            asyncio.run(adapter._fetch_realtime_token())

    def test_non_loopback_plaintext_requires_explicit_opt_in(self):
        cfg = momo_adapter.MomoConfig(
            api_base_url="http://momo.internal:8080",
            centrifugo_ws_url="ws://centrifugo.internal:8000/connection/websocket",
            workspace_id="workspace",
            agent_member_id="agent",
            agent_token="agent-token",
        )

        valid, detail = momo_adapter.validate_config(cfg)
        self.assertFalse(valid)
        self.assertIn("https outside loopback", detail)

        cfg.allow_insecure_http = True
        self.assertEqual(momo_adapter.validate_config(cfg), (True, None))

    def test_failed_connect_closes_started_transport(self):
        class FailedConnectAdapter(CaptureAdapter):
            async def _fetch_realtime_token(self):
                return None

            async def _open_realtime(self):
                self._listen_task = asyncio.create_task(asyncio.sleep(30))

            async def _drain_pending_gateway_jobs(self, *, reason):
                raise momo_adapter.MomoAPIError(503, "pending", "unavailable")

        adapter = FailedConnectAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )

        with self.assertRaises(momo_adapter.MomoAPIError):
            asyncio.run(adapter.connect())

        self.assertTrue(adapter._closing)
        self.assertIsNone(adapter._listen_task)

    def test_cancelled_connect_closes_started_transport(self):
        class CancelledConnectAdapter(CaptureAdapter):
            async def _fetch_realtime_token(self):
                return None

            async def _open_realtime(self):
                self._listen_task = asyncio.create_task(asyncio.sleep(30))

            async def _drain_pending_gateway_jobs(self, *, reason):
                await asyncio.Event().wait()

        adapter = CancelledConnectAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )

        async def exercise():
            task = asyncio.create_task(adapter.connect())
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(exercise())

        self.assertTrue(adapter._closing)
        self.assertIsNone(adapter._listen_task)

    def test_failed_reconnect_cleans_partially_started_listener(self):
        class FailedReconnectAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.close_attempts = 0

            async def _fetch_realtime_token(self):
                return None

            async def _open_realtime(self):
                self._listen_task = asyncio.create_task(asyncio.sleep(30))

            async def _drain_pending_gateway_jobs(self, *, reason):
                raise momo_adapter.MomoAPIError(503, "pending", "unavailable")

            async def _close_realtime_attempt(self):
                self.close_attempts += 1
                await super()._close_realtime_attempt()
                if self.close_attempts >= 2:
                    self._closing = True

        adapter = FailedReconnectAdapter()
        with patch.object(asyncio, "sleep", new=AsyncMock()):
            asyncio.run(adapter._reconnect_realtime())

        self.assertGreaterEqual(adapter.close_attempts, 2)
        self.assertIsNone(adapter._listen_task)

    def test_failed_pending_recovery_retries_and_consumes_coalesced_signal(self):
        class RecoveryAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.recovery_calls = 0

            async def _drain_pending_gateway_jobs(self, *, reason):
                self.recovery_calls += 1
                if self.recovery_calls == 1:
                    self._pending_recovery_requested = True
                    raise momo_adapter.MomoAPIError(503, "pending", "unavailable")

        adapter = RecoveryAdapter()
        with patch.object(asyncio, "sleep", new=AsyncMock()):
            asyncio.run(adapter._recover_pending_safely(reason="publication-gap"))

        self.assertEqual(adapter.recovery_calls, 2)
        self.assertFalse(adapter._pending_recovery_requested)

    def test_failed_completion_retries_cached_result_without_rerunning_provider(self):
        class RetryAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.provider_calls = 0
                self.complete_calls = 0

            async def _report_gateway_event(self, *_args):
                return None

            async def _run_gateway_job(self, _payload):
                self.provider_calls += 1
                return {"status": "succeeded", "body": "done", "usage": {}}

            async def _complete_gateway_job(self, *_args):
                self.complete_calls += 1
                if self.complete_calls == 1:
                    raise momo_adapter.MomoAPIError(503, "complete", "unavailable")

        adapter = RetryAdapter()
        event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
            },
        }

        with self.assertRaises(momo_adapter.MomoAPIError):
            asyncio.run(adapter.handle_message(event))
        asyncio.run(adapter.handle_message(event))

        self.assertEqual(adapter.provider_calls, 1)
        self.assertEqual(adapter.complete_calls, 2)
        self.assertNotIn("run-1", adapter._pending_gateway_results)
        self.assertIn("agent.job:run-1", adapter._handled_triggers)

    def test_completion_backlog_defers_new_provider_work_without_eviction(self):
        class BackpressureAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.provider_calls = 0

            async def _run_gateway_job(self, _payload):
                self.provider_calls += 1
                return {"status": "succeeded", "body": "done", "usage": {}}

        adapter = BackpressureAdapter()
        adapter._max_pending_results = 1
        adapter._pending_gateway_results["unacknowledged-run"] = {
            "status": "succeeded",
            "body": "preserve me",
            "usage": {},
        }
        event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "new-run",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
            },
        }

        with self.assertRaises(momo_adapter.MomoGatewayBackpressure):
            asyncio.run(adapter.handle_message(event))

        self.assertEqual(adapter.provider_calls, 0)
        self.assertEqual(list(adapter._pending_gateway_results), ["unacknowledged-run"])
        self.assertNotIn("agent.job:new-run", adapter._handled_triggers)

    def test_agent_job_requires_exact_actor_and_private_channel_binding(self):
        class BoundAdapter(CaptureAdapter):
            async def _run_gateway_job(self, _payload):
                self.provider_called = True
                return {"status": "succeeded", "body": "done", "usage": {}}

        adapter = BoundAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        base_payload = {
            "run_id": "run-1",
            "workspace_id": "workspace-1",
            "channel_id": "channel-1",
            "agent_member_id": "agent-1",
        }
        invalid_events = [
            {"type": "agent.job", "payload": base_payload},
            {
                "channel": "agentwork:wsworkspace-2.agent-1",
                "type": "agent.job",
                "payload": base_payload,
            },
            {
                "channel": "agentwork:wsworkspace-1.agent-1",
                "type": "agent.job",
                "payload": {**base_payload, "workspace_id": "workspace-2"},
            },
            {
                "channel": "agentwork:wsworkspace-1.agent-1",
                "type": "agent.job",
                "payload": {**base_payload, "agent_member_id": "agent-2"},
            },
        ]

        for event in invalid_events:
            asyncio.run(adapter.handle_message(event))

        self.assertFalse(getattr(adapter, "provider_called", False))

    def test_agent_job_binding_canonicalizes_uuid_case(self):
        workspace = "ca761232-ed42-11ce-bacd-00aa0057b223"
        agent = "0f8fad5b-d9cb-469f-a165-70867728950e"

        class BoundAdapter(CaptureAdapter):
            async def _run_gateway_job(self, _payload):
                self.provider_called = True
                return {"status": "succeeded", "body": "done", "usage": {}}

        adapter = BoundAdapter(
            workspace_id=workspace,
            agent_member_id=agent,
            run_id="run-1",
            final_text="unused",
        )
        event = {
            "channel": momo_adapter.agent_channel(workspace, agent),
            "type": "agent.job",
            "payload": {
                "run_id": "run-1",
                "workspace_id": workspace.upper(),
                "channel_id": "channel-1",
                "agent_member_id": agent.upper(),
            },
        }

        asyncio.run(adapter.handle_message(event))

        self.assertTrue(adapter.provider_called)
        self.assertEqual(adapter.gateway_posts[-1]["body"]["status"], "succeeded")

    def test_realtime_reader_treats_job_as_wakeup_and_still_answers_ping(self):
        class FakeWebSocket:
            def __init__(self):
                self.sent = []
                self.frames = iter(
                    [
                        json.dumps(
                            {
                                "push": {
                                    "channel": "agentwork:wsworkspace-1.agent-1",
                                    "pub": {
                                        "data": {
                                            "type": "agent.job",
                                            "payload": {
                                                "run_id": "run-1",
                                                "workspace_id": "workspace-1",
                                                "channel_id": "channel-1",
                                                "agent_member_id": "agent-1",
                                            },
                                        }
                                    },
                                }
                            }
                        ),
                        json.dumps({"ping": {}}),
                    ]
                )

            def __aiter__(self):
                return self

            async def __anext__(self):
                try:
                    return next(self.frames)
                except StopIteration:
                    raise StopAsyncIteration

            async def send(self, value):
                self.sent.append(json.loads(value))

            async def close(self):
                return None

        class WakeOnlyAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.recovery_reasons = []
                self.provider_called = False

            def _schedule_pending_recovery(self, *, reason, delay_s=0.0):
                self.recovery_reasons.append((reason, delay_s))

            async def handle_message(self, _event):
                self.provider_called = True

        adapter = WakeOnlyAdapter()
        adapter._ws = FakeWebSocket()

        async def exercise():
            adapter._work_task = asyncio.create_task(adapter._work_loop())
            await adapter._listen_loop()
            sent = list(adapter._ws.sent)
            await adapter.close()
            return sent

        sent = asyncio.run(exercise())

        self.assertIn({"pong": {}}, sent)
        self.assertIn(("realtime-agent-job", 0.0), adapter.recovery_reasons)
        self.assertFalse(adapter.provider_called)

    def test_gateway_result_redacts_exact_and_token_shaped_bearers(self):
        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        adapter.cfg.agent_token = "momo_agent_v1.workspace-1.exact-secret"

        result = adapter._normalize_gateway_result(
            {
                "status": "failed",
                "error": (
                    "exact=momo_agent_v1.workspace-1.exact-secret "
                    "other=momo_agent_v1.workspace-2.other-secret "
                    "provider=sk-proj-abcdefghijklmnop "
                    "jwt=eyJheader12.eyJpayload12.signature12"
                ),
            },
            {"model": "hermes-agent"},
        )

        self.assertEqual(
            result["error"],
            "exact=[redacted] other=[redacted-agent-token] "
            "provider=[redacted-provider-token] jwt=[redacted-jwt]",
        )
        implicit_failure = adapter._normalize_gateway_result(
            {"error": "provider failed"}, {"model": "hermes-agent"}
        )
        self.assertEqual(implicit_failure["status"], "failed")

    def test_realtime_and_pending_recovery_share_one_provider_worker(self):
        class SequentialAdapter(CaptureAdapter):
            _pending_page_size = 2

            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.current = 0
                self.max_current = 0
                self.processed = []
                self.release = None

            async def _get(self, _path):
                return {
                    "jobs": [
                        claimed_job({
                            "type": "agent.job",
                            "payload": {
                                "run_id": "recovered",
                                "workspace_id": "workspace-1",
                                "channel_id": "channel-1",
                                "agent_member_id": "agent-1",
                            },
                        }, job_id=2)
                    ]
                }

            async def handle_message(self, event):
                self.current += 1
                self.max_current = max(self.max_current, self.current)
                try:
                    await self.release.wait()
                    self.processed.append(event["payload"]["run_id"])
                finally:
                    self.current -= 1

        adapter = SequentialAdapter()
        realtime_event = {
            "channel": "agentwork:wsworkspace-1.agent-1",
            "type": "agent.job",
            "payload": {
                "run_id": "realtime",
                "workspace_id": "workspace-1",
                "channel_id": "channel-1",
                "agent_member_id": "agent-1",
            },
        }

        async def exercise():
            adapter.release = asyncio.Event()
            await adapter._enqueue_gateway_work(realtime_event)
            recovery = asyncio.create_task(
                adapter._drain_pending_gateway_jobs(reason="queue-full")
            )
            await asyncio.sleep(0)
            adapter.release.set()
            await recovery
            await adapter.close()

        asyncio.run(exercise())

        self.assertEqual(adapter.max_current, 1)
        self.assertEqual(adapter.processed, ["realtime", "recovered"])

    def test_reconnect_backoff_is_bounded_for_large_attempts(self):
        with patch.object(momo_adapter.random, "uniform", return_value=0.0):
            self.assertEqual(momo_adapter.MomoAdapter._reconnect_delay(10_000), 30.0)

    def test_reconnect_retries_when_replacement_listener_dies_during_recovery(self):
        class ReconnectAdapter(CaptureAdapter):
            def __init__(self):
                super().__init__(
                    workspace_id="workspace-1",
                    agent_member_id="agent-1",
                    run_id="run-1",
                    final_text="done",
                )
                self.opens = 0
                self.live_listener_release = None

            async def _fetch_realtime_token(self):
                return None

            async def _open_realtime(self):
                self.opens += 1
                if self.opens == 1:
                    self._listen_task = asyncio.get_running_loop().create_future()
                    self._listen_task.set_result(None)
                else:
                    self.live_listener_release = asyncio.Event()
                    self._listen_task = asyncio.create_task(
                        self.live_listener_release.wait()
                    )

            async def _drain_pending_gateway_jobs(self, *, reason):
                await asyncio.sleep(0)

        adapter = ReconnectAdapter()

        async def exercise():
            with patch.object(adapter, "_reconnect_delay", return_value=0.0):
                await asyncio.wait_for(adapter._reconnect_realtime(), timeout=1)
            opens = adapter.opens
            await adapter.close()
            return opens

        self.assertEqual(asyncio.run(exercise()), 2)

    def test_permanent_401_stops_reconnect_until_restart(self):
        class ReconnectAdapter(CaptureAdapter):
            async def _close_ws_only(self):
                self.closed = True

            async def _fetch_realtime_token(self):
                raise momo_adapter.MomoAPIError(401, "realtime", "raw-token-echo")

        adapter = ReconnectAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        with patch.object(asyncio, "sleep", new=AsyncMock()):
            asyncio.run(adapter._reconnect_realtime())

        self.assertTrue(adapter._closing)
        self.assertTrue(adapter.closed)

    def test_trigger_dedup_cache_is_bounded(self):
        adapter = CaptureAdapter(
            workspace_id="workspace-1",
            agent_member_id="agent-1",
            run_id="run-1",
            final_text="done",
        )
        adapter._max_handled_triggers = 3
        for index in range(5):
            key = f"trigger-{index}"
            self.assertTrue(adapter._begin_trigger(key))
            adapter._finish_trigger(key, handled=True)

        self.assertEqual(list(adapter._handled_triggers), ["trigger-2", "trigger-3", "trigger-4"])


if __name__ == "__main__":
    unittest.main()
