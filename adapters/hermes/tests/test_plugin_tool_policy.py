import asyncio
import dataclasses
import inspect
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "adapters" / "hermes"))

if "slots" not in inspect.signature(dataclasses.dataclass).parameters:
    _dataclass = dataclasses.dataclass

    def _dataclass_without_slots(*args, **kwargs):
        kwargs.pop("slots", None)
        return _dataclass(*args, **kwargs)

    dataclasses.dataclass = _dataclass_without_slots

import momo_adapter  # noqa: E402


WORKSPACE_ID = "10000000-0000-7000-8000-000000000001"
AGENT_ID = "30000000-0000-7000-8000-000000000020"
AUTHOR_ID = "20000000-0000-7000-8000-000000000010"
CHANNEL_ID = "40000000-0000-7000-8000-000000000040"


def github_descriptor():
    return {
        "pluginId": "com.momo.plugins.github",
        "mcp": {
            "url": "https://api.githubcopilot.com/mcp/",
            "transport": "streamable_http",
        },
        "egressDomains": ["api.githubcopilot.com"],
        "tools": [
            {
                "name": "github.list_repositories",
                "risk": "read",
                "approvalTier": "read_only",
            }
        ],
    }


def packet_payload():
    return {
        "workspace_id": WORKSPACE_ID,
        "agent_member_id": AGENT_ID,
        "author_member_id": AUTHOR_ID,
        "channel_id": CHANNEL_ID,
        "context_packet_projection": {
            "schema": "momo.context_packet.mention_projection.v0",
            "request": {"agent_member_id": AGENT_ID},
        },
    }


class MockRESTAdapter(momo_adapter.MomoAdapter):
    def __init__(self, responses):
        super().__init__(
            momo_adapter.MomoConfig(
                api_base_url="http://momo.test",
                workspace_id=WORKSPACE_ID,
                agent_member_id=AGENT_ID,
                agent_token="agent-token-fixture",
                allow_insecure_http=True,
            )
        )
        self.responses = list(responses)
        self.get_paths = []

    async def _get(self, path):
        self.get_paths.append(path)
        return self.responses.pop(0)


class PluginToolPolicyContractTests(unittest.TestCase):
    def test_active_grant_includes_allowlisted_mcp_descriptor(self):
        adapter = MockRESTAdapter(
            [{"plugins": [], "toolPolicy": {"plugins": [github_descriptor()]}}]
        )

        assembled = asyncio.run(adapter._payload_with_plugin_tool_policy(packet_payload()))

        self.assertEqual(
            assembled["context_packet_projection"]["tool_policy"],
            {"plugins": [github_descriptor()]},
        )
        self.assertEqual(len(adapter.get_paths), 1)
        self.assertIn(f"delegatedMemberId={AUTHOR_ID}", adapter.get_paths[0])
        self.assertIn(f"channelId={CHANNEL_ID}", adapter.get_paths[0])
        serialized = json.dumps(assembled, sort_keys=True).lower()
        for forbidden in ("credential", "access_token", "authorization", "password"):
            self.assertNotIn(forbidden, serialized)

    def test_missing_grant_produces_empty_policy(self):
        adapter = MockRESTAdapter(
            [{"plugins": [], "toolPolicy": {"plugins": []}}]
        )

        assembled = asyncio.run(adapter._payload_with_plugin_tool_policy(packet_payload()))

        self.assertEqual(
            assembled["context_packet_projection"]["tool_policy"],
            {"plugins": []},
        )

    def test_revoke_is_observed_by_the_next_packet_without_cache(self):
        adapter = MockRESTAdapter(
            [
                {"toolPolicy": {"plugins": [github_descriptor()]}},
                {"toolPolicy": {"plugins": []}},
            ]
        )

        before = asyncio.run(adapter._payload_with_plugin_tool_policy(packet_payload()))
        after = asyncio.run(adapter._payload_with_plugin_tool_policy(packet_payload()))

        self.assertEqual(len(before["context_packet_projection"]["tool_policy"]["plugins"]), 1)
        self.assertEqual(after["context_packet_projection"]["tool_policy"], {"plugins": []})
        self.assertEqual(len(adapter.get_paths), 2)

    def test_malformed_manifest_descriptor_skips_only_that_plugin_and_logs(self):
        malformed = {
            "pluginId": "com.momo.plugins.malformed",
            "mcp": {
                "url": "https://malformed.example/mcp",
                "transport": "streamable_http",
                "authorization": "Bearer must-not-cross",
            },
            "egressDomains": ["different.example"],
            "tools": [{"name": "bad", "risk": "unknown", "approvalTier": "read_only"}],
        }
        adapter = MockRESTAdapter(
            [{"toolPolicy": {"plugins": [malformed, github_descriptor()]}}]
        )

        with self.assertLogs("momo.adapter", level="WARNING") as captured:
            assembled = asyncio.run(
                adapter._payload_with_plugin_tool_policy(packet_payload())
            )

        self.assertEqual(
            assembled["context_packet_projection"]["tool_policy"],
            {"plugins": [github_descriptor()]},
        )
        self.assertTrue(
            any("skipping malformed plugin" in line for line in captured.output)
        )
        self.assertNotIn("must-not-cross", json.dumps(assembled))


if __name__ == "__main__":
    unittest.main()
