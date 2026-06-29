#!/usr/bin/env python3
"""Repo-local smoke harness for the optional Hermes platform adapter path.

This script intentionally avoids Hermes SDK, aiohttp, websockets, Docker, and
network access. It loads the adapter directly, feeds the canonical Centrifugo
fixture, captures the REST calls the adapter would make, and verifies the
invoke/final-message mapping stays aligned with the contract fixture.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import sys
from pathlib import Path
from typing import Any, Optional


REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = (
    REPO_ROOT
    / "research"
    / "11-agent-runtime"
    / "fixtures"
    / "hermes-adapter-contract-v0"
    / "platform_adapter_event_mapping.json"
)

sys.path.insert(0, str(REPO_ROOT / "adapters" / "hermes"))

# Python 3.9 compatibility for older local machines that can py_compile the
# adapter but do not support dataclass(slots=True).
if "slots" not in inspect.signature(dataclasses.dataclass).parameters:
    _dataclass = dataclasses.dataclass

    def _dataclass_without_slots(*args: Any, **kwargs: Any) -> Any:
        kwargs.pop("slots", None)
        return _dataclass(*args, **kwargs)

    dataclasses.dataclass = _dataclass_without_slots

import momo_adapter  # noqa: E402


class CaptureAdapter(momo_adapter.MomoAdapter):
    """MomoAdapter subclass that captures REST writes instead of networking."""

    def __init__(
        self,
        *,
        workspace_id: str,
        agent_member_id: str,
        run_id: str,
        final_text: str,
    ) -> None:
        cfg = momo_adapter.MomoConfig(
            api_base_url="http://momo-smoke.invalid",
            workspace_id=workspace_id,
            agent_member_id=agent_member_id,
            agent_handle="kim-intern",
        )
        super().__init__(cfg)
        self._member_id = agent_member_id
        self.run_id = run_id
        self.final_text = final_text
        self.posts: list[dict[str, Any]] = []
        self.collected_run_id: Optional[str] = None

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        self.posts.append({"method": "POST", "path": path, "body": dict(body)})
        if path.endswith("/invoke"):
            return {"runId": self.run_id}
        return {"id": "message-smoke", "seq": 43}

    async def _collect_run_output(self, run_id: Optional[str]) -> str:
        self.collected_run_id = run_id
        return self.final_text


def load_fixture() -> dict[str, Any]:
    with FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def unwrap_event(fixture: dict[str, Any]) -> dict[str, Any]:
    raw = json.dumps(fixture["input_centrifugo_push"])
    frame = momo_adapter.MomoAdapter._iter_frames(raw)[0]
    push = frame["push"]
    envelope = push["pub"]["data"]
    return {
        "channel": push["channel"],
        "type": envelope["type"],
        "seq": envelope["seq"],
        "ts": envelope["ts"],
        "payload": envelope["payload"],
    }


async def run_smoke() -> dict[str, Any]:
    fixture = load_fixture()
    event = unwrap_event(fixture)
    expected = fixture["expected_momo_mapping"]

    if event != fixture["unwrapped_adapter_event"]:
        raise AssertionError("Centrifugo fixture did not unwrap to adapter event")

    payload = event["payload"]
    run_id = expected["final_message_send"]["body"]["runId"]
    final_text = expected["final_message_send"]["body"]["body"]
    adapter = CaptureAdapter(
        workspace_id=payload["workspaceId"],
        agent_member_id=payload["agentMemberId"],
        run_id=run_id,
        final_text=final_text,
    )

    await adapter.handle_message(event)

    expected_posts = [expected["invoke"], expected["final_message_send"]]
    if adapter.posts != expected_posts:
        raise AssertionError(
            "REST capture mismatch:\n"
            f"expected={json.dumps(expected_posts, indent=2, sort_keys=True)}\n"
            f"actual={json.dumps(adapter.posts, indent=2, sort_keys=True)}"
        )
    if adapter.collected_run_id != run_id:
        raise AssertionError(
            f"expected collected run id {run_id}, got {adapter.collected_run_id}"
        )

    return {
        "result": "PASS",
        "fixture": str(FIXTURE_PATH.relative_to(REPO_ROOT)),
        "event_type": event["type"],
        "captured_rest_calls": adapter.posts,
        "network": "not-used",
        "runtime_unverified": "live Hermes gateway plugin load/e2e",
    }


def main() -> int:
    summary = asyncio.run(run_smoke())
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
