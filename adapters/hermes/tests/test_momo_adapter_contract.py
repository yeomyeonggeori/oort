import asyncio
import dataclasses
import inspect
import json
import os
import sys
import unittest
from pathlib import Path

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


class CaptureAdapter(momo_adapter.MomoAdapter):
    def __init__(self, *, workspace_id, agent_member_id, run_id, final_text):
        cfg = momo_adapter.MomoConfig(
            api_base_url="http://momo.test",
            workspace_id=workspace_id,
            agent_member_id=agent_member_id,
            agent_handle="kim-intern",
        )
        super().__init__(cfg)
        self._member_id = agent_member_id
        self.run_id = run_id
        self.final_text = final_text
        self.posts = []
        self.gateway_posts = []

    async def _post(self, path, body):
        self.posts.append({"method": "POST", "path": path, "body": dict(body)})
        if path.endswith("/invoke"):
            return {"runId": self.run_id}
        return {"id": "message-fixture", "seq": 43}

    async def _post_gateway(self, path, body):
        self.gateway_posts.append({"method": "POST", "path": path, "body": dict(body)})
        return {"status": "accepted"}

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
        self.assertIn("MOMO_AGENT_GATEWAY_SECRET", context.kwargs["required_env"])

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
        adapter._access_token = "access-token"

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
                "MOMO_AGENT_GATEWAY_SECRET": "gateway-secret",
                "OPENAI_API_KEY": "must-not-be-consumed",
            }
        )

        self.assertIsNotNone(enabled)
        self.assertEqual(enabled["MOMO_AGENT_MEMBER_ID"], "agent")
        self.assertNotIn("OPENAI_API_KEY", enabled)


if __name__ == "__main__":
    unittest.main()
