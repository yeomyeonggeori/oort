from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


ADAPTER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER_DIR))

import codex_workbench as workbench  # noqa: E402


WORKSPACE_ID = "00000000-0000-7000-8000-000000000001"
AGENT_ID = "00000000-0000-7000-8000-000000000103"
RUN_ID = "00000000-0000-7000-8000-000000000363"
LEASE_ID = "00000000-0000-7341-8000-000000000363"
TOKEN = "momo_agent_v1.contract.secret"


class FakeMomoClient:
    def __init__(self):
        self.events = []
        self.completions = []
        self.releases = []
        self.renewals = []

    async def pending_jobs(self, *, limit=1):
        return []

    async def event(self, job, status, **fields):
        self.events.append({"job": job, "status": status, **fields})
        return {"status": "accepted"}

    async def complete(self, job, completion):
        self.completions.append({"job": job, "completion": dict(completion)})
        return {"status": completion["status"]}

    async def renew(self, job):
        self.renewals.append(job)
        return int(time.time() * 1_000) + 30_000

    async def release(self, job):
        self.releases.append(job)


class CodexWorkbenchContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        subprocess.run(
            ["git", "init", "-q", str(self.workspace)],
            check=True,
            capture_output=True,
        )
        self.state_dir = self.root / "state"
        self.mock_log = self.root / "mock-codex.jsonl"
        self.mock_codex = Path(__file__).with_name("mock_codex.py")
        self.client = FakeMomoClient()

    def tearDown(self):
        self.temp.cleanup()

    def adapter(self, sandbox):
        config = workbench.WorkbenchConfig(
            api_base_url="http://127.0.0.1:8080",
            workspace_id=WORKSPACE_ID,
            agent_member_id=AGENT_ID,
            agent_token=TOKEN,
            workspace_path=self.workspace,
            state_dir=self.state_dir,
            sandbox=sandbox,
            codex_bin=str(self.mock_codex),
        ).validated()
        store = workbench.StateStore(config.state_dir)
        return workbench.CodexWorkbench(
            config,
            client=self.client,
            state_store=store,
            runner=workbench.CodexRunner(config, store),
        )

    def claimed_job(self, *, job_id=363, payload=None):
        value = payload or {
            "run_id": RUN_ID,
            "workspace_id": WORKSPACE_ID,
            "channel_id": "00000000-0000-7000-8000-000000000010",
            "agent_member_id": AGENT_ID,
            "work": {
                "type": "work",
                "title": "Contract work",
                "brief": "Inspect the repository",
                "repo": "Dawn-kim-official/momo",
                "branch": "feat/contract",
            },
        }
        return workbench.ClaimedJob.from_dict(
            {
                "id": job_id,
                "runId": RUN_ID,
                "payload": value,
                "leaseId": str(uuid.uuid5(uuid.NAMESPACE_URL, f"lease-{job_id}")),
                "leaseExpiresAtMs": int(time.time() * 1_000) + 30_000,
            },
            workspace_id=WORKSPACE_ID,
            agent_member_id=AGENT_ID,
        )

    def mock_invocations(self):
        return [
            json.loads(line)
            for line in self.mock_log.read_text(encoding="utf-8").splitlines()
        ]

    async def test_read_only_claim_streams_and_commits_structured_result(self):
        adapter = self.adapter(workbench.SandboxPolicy.READ_ONLY)
        with patch.dict(
            os.environ,
            {"MOCK_CODEX_LOG": str(self.mock_log), "MOMO_AGENT_TOKEN": TOKEN},
        ):
            await adapter.process_job(self.claimed_job())

        self.assertTrue(any(event["status"] == "running" for event in self.client.events))
        self.assertTrue(any(event["status"] == "streaming" for event in self.client.events))
        self.assertFalse(
            any(event["status"] == "approval_request" for event in self.client.events)
        )
        completion = self.client.completions[0]["completion"]
        card = json.loads(completion["body"])
        self.assertEqual(completion["status"], "succeeded")
        self.assertEqual(card["schema"], workbench.RESULT_SCHEMA)
        self.assertEqual(card["sandbox"], "read-only")
        self.assertEqual(card["exit_code"], 0)
        self.assertEqual(card["changed_file_count"], 0)
        self.assertEqual(
            card["session_id"], "0199a213-81c0-7800-8aa1-bbab2a035a53"
        )
        invocation = self.mock_invocations()[0]
        self.assertIn("read-only", invocation["argv"])
        self.assertNotIn("resume", invocation["argv"])
        self.assertNotIn(TOKEN, json.dumps(invocation))
        self.assertFalse(invocation["momo_token_present"])
        self.assertFalse((self.state_dir / f"{RUN_ID}.json").exists())

    async def test_workspace_write_plans_then_requires_approval_and_resumes_session(self):
        adapter = self.adapter(workbench.SandboxPolicy.WORKSPACE_WRITE)
        initial = self.claimed_job()
        initial.payload["work"]["brief"] = "CREATE_FILE after approval"
        with patch.dict(
            os.environ,
            {"MOCK_CODEX_LOG": str(self.mock_log), "MOMO_AGENT_TOKEN": TOKEN},
        ):
            await adapter.process_job(initial)

            self.assertEqual(self.client.completions, [])
            approval = next(
                event
                for event in self.client.events
                if event["status"] == "approval_request"
            )["approval_request"]
            self.assertEqual(approval["tier"], "workspace_write")
            self.assertEqual(approval["tool_call"]["name"], "codex.exec.resume")
            self.assertEqual(approval["tool_call"]["tool_grant"]["network"], "denied")
            call_id = approval["tool_call"]["call_id"]
            state = adapter.state_store.load(RUN_ID)
            self.assertEqual(state.phase, "awaiting_approval")
            self.assertIsNotNone(state.session_id)

            resume_payload = {
                "run_id": RUN_ID,
                "workspace_id": WORKSPACE_ID,
                "channel_id": "00000000-0000-7000-8000-000000000010",
                "agent_member_id": AGENT_ID,
                "resume_from_approval_id": "00000000-0000-7000-8000-000000000349",
                "approval_decision": {"status": "approved"},
                "approved_tool_call": {"call_id": call_id, "name": "codex.exec.resume"},
            }
            await adapter.process_job(self.claimed_job(job_id=364, payload=resume_payload))

        invocations = self.mock_invocations()
        self.assertEqual(len(invocations), 2)
        self.assertEqual(invocations[0]["sandbox"], "read-only")
        self.assertFalse(invocations[0]["resume"])
        self.assertEqual(invocations[1]["sandbox"], "workspace-write")
        self.assertTrue(invocations[1]["resume"])
        self.assertIn("0199a213-81c0-7800-8aa1-bbab2a035a53", invocations[1]["argv"])
        self.assertTrue((self.workspace / "mock-change.txt").exists())
        card = json.loads(self.client.completions[0]["completion"]["body"])
        self.assertEqual(card["changed_file_count"], 1)
        self.assertEqual(card["changed_files"], ["mock-change.txt"])
        self.assertEqual(
            card["links"]["pull_request"],
            "https://github.com/Dawn-kim-official/momo/pull/999",
        )
        self.assertFalse((self.state_dir / f"{RUN_ID}.json").exists())

    async def test_rejected_workspace_write_never_resumes_codex(self):
        adapter = self.adapter(workbench.SandboxPolicy.WORKSPACE_WRITE)
        with patch.dict(
            os.environ,
            {"MOCK_CODEX_LOG": str(self.mock_log), "MOMO_AGENT_TOKEN": TOKEN},
        ):
            await adapter.process_job(self.claimed_job())
            state = adapter.state_store.load(RUN_ID)
            rejected = {
                "run_id": RUN_ID,
                "workspace_id": WORKSPACE_ID,
                "channel_id": "00000000-0000-7000-8000-000000000010",
                "agent_member_id": AGENT_ID,
                "resume_from_approval_id": "00000000-0000-7000-8000-000000000349",
                "approval_decision": {"status": "rejected"},
                "approved_tool_call": {
                    "call_id": state.approval_call_id,
                    "name": "codex.exec.resume",
                },
            }
            await adapter.process_job(self.claimed_job(job_id=365, payload=rejected))

        self.assertEqual(len(self.mock_invocations()), 1)
        self.assertEqual(self.client.completions, [])
        self.assertEqual(self.client.events[-1]["status"], "cancelled")
        self.assertFalse((self.state_dir / f"{RUN_ID}.json").exists())

    def test_danger_and_network_sandboxes_have_no_configuration_path(self):
        for denied in ("danger-full-access", "danger", "network-write"):
            with self.assertRaises(workbench.ConfigurationError):
                workbench.SandboxPolicy.parse(denied)

    def test_codex_argv_has_no_bypass_or_provider_credential_arguments(self):
        adapter = self.adapter(workbench.SandboxPolicy.WORKSPACE_WRITE)
        argv = adapter.runner.argv(
            run_id=RUN_ID,
            sandbox=workbench.SandboxPolicy.WORKSPACE_WRITE,
            resume_session_id="0199a213-81c0-7800-8aa1-bbab2a035a53",
        )
        serialized = " ".join(argv)
        self.assertNotIn("danger", serialized)
        self.assertNotIn("yolo", serialized)
        self.assertNotIn(TOKEN, serialized)
        self.assertIn("-c approval_policy=never", serialized)
        self.assertIn("resume", argv)

    def test_state_files_are_private_and_never_store_agent_token(self):
        adapter = self.adapter(workbench.SandboxPolicy.READ_ONLY)
        state = workbench.RunState(
            run_id=RUN_ID,
            phase="new",
            requested_sandbox="read-only",
            work={"type": "work", "title": "T", "brief": "B"},
        )
        adapter.state_store.save(state)
        path = self.state_dir / f"{RUN_ID}.json"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(TOKEN, path.read_text(encoding="utf-8"))

    async def test_cached_completion_retries_without_rerunning_codex(self):
        adapter = self.adapter(workbench.SandboxPolicy.READ_ONLY)
        completion = {
            "status": "succeeded",
            "body": json.dumps({"schema": workbench.RESULT_SCHEMA, "exit_code": 0}),
            "usage": {"model": "codex-cli", "was_estimated": True},
        }
        adapter.state_store.save(
            workbench.RunState(
                run_id=RUN_ID,
                phase="completion_pending",
                requested_sandbox="read-only",
                work={"type": "work", "title": "T", "brief": "B"},
                completion=completion,
            )
        )

        await adapter.process_job(self.claimed_job())

        self.assertEqual(self.client.completions[0]["completion"], completion)
        self.assertFalse(self.mock_log.exists())
        self.assertFalse((self.state_dir / f"{RUN_ID}.json").exists())

    def test_source_has_no_durable_message_or_database_write_path(self):
        source = (ADAPTER_DIR / "codex_workbench.py").read_text(encoding="utf-8")
        self.assertNotIn("/messages", source)
        self.assertNotIn("POSTGRES_", source)
        self.assertNotIn("/api/publish", source)


if __name__ == "__main__":
    unittest.main()
