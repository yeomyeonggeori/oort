#!/usr/bin/env python3
"""Run momo Work v0 jobs through a host-owned Codex CLI.

The adapter talks only to momo's scoped gateway REST surface. Codex/provider
credentials remain in the host's Codex installation and are never read, copied,
or sent by this process.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import enum
import ipaddress
import json
import logging
import os
import re
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence


log = logging.getLogger("momo.codex_workbench")

RESULT_SCHEMA = "momo.agent_work.result.v0"
STATE_SCHEMA = "momo.codex_workbench.state.v0"
MAX_DETAIL_BYTES = 2_048
MAX_DELTA_BYTES = 8_192
MAX_PARTIAL_EVENTS = 200
MAX_FINAL_MESSAGE_BYTES = 32_768
PR_URL_RE = re.compile(r"https://github\.com/[^\s/]+/[^\s/]+/pull/\d+")
TOKEN_PATTERNS = (
    re.compile(r"momo_agent_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
    re.compile(
        r"(?i)\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,}|"
        r"github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|"
        r"ya29\.[A-Za-z0-9._-]{8,})\b"
    ),
    re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b"),
)


class WorkbenchError(RuntimeError):
    """Base error for bounded adapter failures."""


class ConfigurationError(WorkbenchError):
    """The host configuration is missing or unsafe."""


class ContractError(WorkbenchError):
    """A claimed gateway job does not satisfy the Work v0 contract."""


class LeaseLost(WorkbenchError):
    """The gateway lease expired or was taken over."""


class MomoAPIError(WorkbenchError):
    """momo returned a non-successful response."""

    def __init__(self, status: int, path: str, detail: str) -> None:
        self.status = status
        self.path = path
        self.detail = detail
        super().__init__(f"momo API {status} at {path}: {detail}")


class SandboxPolicy(str, enum.Enum):
    READ_ONLY = "read-only"
    WORKSPACE_WRITE = "workspace-write"

    @classmethod
    def parse(cls, raw: str) -> "SandboxPolicy":
        value = raw.strip().lower()
        try:
            return cls(value)
        except ValueError as exc:
            raise ConfigurationError(
                "MOMO_CODEX_SANDBOX must be read-only or workspace-write; "
                "network-write and danger-full-access are not available"
            ) from exc

    @property
    def approval_tier(self) -> str:
        return "read_only" if self is self.READ_ONLY else "workspace_write"


@dataclasses.dataclass(frozen=True)
class WorkbenchConfig:
    api_base_url: str
    workspace_id: str
    agent_member_id: str
    agent_token: str
    workspace_path: Path
    state_dir: Path
    sandbox: SandboxPolicy = SandboxPolicy.READ_ONLY
    codex_bin: str = "codex"
    poll_interval_seconds: float = 2.0
    http_timeout_seconds: float = 15.0
    allow_insecure_http: bool = False

    @classmethod
    def from_env(cls) -> "WorkbenchConfig":
        home = Path.home()
        workspace_raw = os.environ.get("MOMO_CODEX_WORKSPACE", "").strip()
        if not workspace_raw:
            raise ConfigurationError("MOMO_CODEX_WORKSPACE is required")
        return cls(
            api_base_url=os.environ.get("MOMO_API_URL", "").strip(),
            workspace_id=os.environ.get("MOMO_WORKSPACE_ID", "").strip(),
            agent_member_id=os.environ.get("MOMO_AGENT_MEMBER_ID", "").strip(),
            agent_token=os.environ.get("MOMO_AGENT_TOKEN", "").strip(),
            workspace_path=Path(workspace_raw).expanduser(),
            state_dir=Path(
                os.environ.get(
                    "MOMO_CODEX_STATE_DIR",
                    str(home / ".local" / "state" / "momo-codex-workbench"),
                )
            ).expanduser(),
            sandbox=SandboxPolicy.parse(
                os.environ.get("MOMO_CODEX_SANDBOX", "read-only")
            ),
            codex_bin=os.environ.get("MOMO_CODEX_BIN", "codex").strip() or "codex",
            poll_interval_seconds=_positive_float_env(
                "MOMO_CODEX_POLL_INTERVAL_SECONDS", 2.0
            ),
            http_timeout_seconds=_positive_float_env(
                "MOMO_CODEX_HTTP_TIMEOUT_SECONDS", 15.0
            ),
            allow_insecure_http=_truthy(
                os.environ.get("MOMO_AGENT_ALLOW_INSECURE_HTTP", "")
            ),
        ).validated()

    def validated(self) -> "WorkbenchConfig":
        if not self.api_base_url:
            raise ConfigurationError("MOMO_API_URL is required")
        _required_uuid(self.workspace_id, "MOMO_WORKSPACE_ID")
        _required_uuid(self.agent_member_id, "MOMO_AGENT_MEMBER_ID")
        if not self.agent_token:
            raise ConfigurationError("MOMO_AGENT_TOKEN is required")
        if not str(self.workspace_path):
            raise ConfigurationError("MOMO_CODEX_WORKSPACE is required")
        workspace = self.workspace_path.resolve()
        if not workspace.is_dir():
            raise ConfigurationError("MOMO_CODEX_WORKSPACE must be an existing directory")
        _validate_api_url(self.api_base_url, self.allow_insecure_http)
        return dataclasses.replace(
            self,
            api_base_url=self.api_base_url.rstrip("/"),
            workspace_path=workspace,
            state_dir=self.state_dir.resolve(),
        )


@dataclasses.dataclass(frozen=True)
class WorkRequest:
    title: str
    brief: str
    repo: Optional[str] = None
    branch: Optional[str] = None

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "WorkRequest":
        raw = payload.get("work") or payload.get("input")
        if not isinstance(raw, Mapping) or raw.get("type") != "work":
            raise ContractError("gateway job is missing input.type=work")
        allowed = {"type", "title", "brief", "repo", "branch"}
        if set(raw).difference(allowed):
            raise ContractError("work input contains unknown fields")
        return cls(
            title=_required_text(raw.get("title"), "work.title", 200),
            brief=_required_text(raw.get("brief"), "work.brief", 16_384),
            repo=_optional_text(raw.get("repo"), "work.repo", 2_048),
            branch=_optional_text(raw.get("branch"), "work.branch", 512),
        )

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "type": "work",
            "title": self.title,
            "brief": self.brief,
        }
        if self.repo is not None:
            value["repo"] = self.repo
        if self.branch is not None:
            value["branch"] = self.branch
        return value


@dataclasses.dataclass(frozen=True)
class ClaimedJob:
    job_id: int
    lease_id: str
    lease_expires_at_ms: int
    run_id: str
    payload: Mapping[str, Any]

    @classmethod
    def from_dict(
        cls,
        raw: Mapping[str, Any],
        *,
        workspace_id: str,
        agent_member_id: str,
    ) -> "ClaimedJob":
        payload = raw.get("payload")
        if not isinstance(payload, Mapping):
            raise ContractError("claimed job payload must be an object")
        try:
            job_id = int(raw.get("id"))
            lease_id = str(raw.get("leaseId") or raw.get("lease_id") or "")
            lease_expires_at_ms = int(
                raw.get("leaseExpiresAtMs") or raw.get("lease_expires_at_ms")
            )
            uuid.UUID(lease_id)
        except (TypeError, ValueError) as exc:
            raise ContractError("claimed job lease binding is invalid") from exc
        run_id = str(raw.get("runId") or payload.get("run_id") or "")
        _required_uuid(run_id, "run_id", error_type=ContractError)
        if job_id <= 0 or lease_expires_at_ms <= 0:
            raise ContractError("claimed job lease binding is invalid")
        if _canonical_uuid(payload.get("workspace_id")) != _canonical_uuid(workspace_id):
            raise ContractError("claimed job workspace does not match adapter")
        if _canonical_uuid(payload.get("agent_member_id")) != _canonical_uuid(
            agent_member_id
        ):
            raise ContractError("claimed job agent does not match adapter")
        if _canonical_uuid(payload.get("run_id")) != _canonical_uuid(run_id):
            raise ContractError("claimed job run binding is inconsistent")
        return cls(job_id, lease_id, lease_expires_at_ms, run_id, payload)

    def callback_binding(self) -> dict[str, Any]:
        return {"job_id": self.job_id, "lease_id": self.lease_id}


@dataclasses.dataclass
class RunState:
    run_id: str
    phase: str
    requested_sandbox: str
    work: dict[str, Any]
    session_id: Optional[str] = None
    approval_call_id: Optional[str] = None
    plan_summary: Optional[str] = None
    completion: Optional[dict[str, Any]] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": STATE_SCHEMA,
            "run_id": self.run_id,
            "phase": self.phase,
            "requested_sandbox": self.requested_sandbox,
            "work": self.work,
            "session_id": self.session_id,
            "approval_call_id": self.approval_call_id,
            "plan_summary": self.plan_summary,
            "completion": self.completion,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "RunState":
        if raw.get("schema") != STATE_SCHEMA:
            raise ContractError("unsupported local run state schema")
        run_id = str(raw.get("run_id") or "")
        _required_uuid(run_id, "state.run_id", error_type=ContractError)
        work = raw.get("work")
        if not isinstance(work, Mapping):
            raise ContractError("local run state is missing work input")
        return cls(
            run_id=run_id,
            phase=str(raw.get("phase") or ""),
            requested_sandbox=str(raw.get("requested_sandbox") or ""),
            work=dict(work),
            session_id=_optional_string(raw.get("session_id")),
            approval_call_id=_optional_string(raw.get("approval_call_id")),
            plan_summary=_optional_string(raw.get("plan_summary")),
            completion=dict(raw["completion"])
            if isinstance(raw.get("completion"), Mapping)
            else None,
        )


class StateStore:
    """Host-local, mode-0600 state used to make approval resume crash-safe."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)

    def _path(self, run_id: str) -> Path:
        canonical = str(_required_uuid(run_id, "run_id", error_type=ContractError))
        return self.root / f"{canonical}.json"

    def load(self, run_id: str) -> Optional[RunState]:
        path = self._path(run_id)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ContractError("local run state is unreadable") from exc
        if not isinstance(raw, Mapping):
            raise ContractError("local run state must be an object")
        state = RunState.from_dict(raw)
        if _canonical_uuid(state.run_id) != _canonical_uuid(run_id):
            raise ContractError("local run state does not match claimed run")
        return state

    def save(self, state: RunState) -> None:
        path = self._path(state.run_id)
        temporary = path.with_suffix(f".tmp-{uuid.uuid4()}")
        payload = json.dumps(state.as_dict(), ensure_ascii=False, sort_keys=True)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            if temporary.exists():
                temporary.unlink()

    def delete(self, run_id: str) -> None:
        try:
            self._path(run_id).unlink()
        except FileNotFoundError:
            pass

    def output_path(self, run_id: str) -> Path:
        canonical = str(_required_uuid(run_id, "run_id", error_type=ContractError))
        return self.root / f"{canonical}.last-message.txt"


class MomoClient:
    def __init__(self, config: WorkbenchConfig) -> None:
        self.config = config

    async def pending_jobs(self, *, limit: int = 1) -> Sequence[Mapping[str, Any]]:
        path = (
            f"/v1/workspaces/{self.config.workspace_id}"
            f"/agents/{self.config.agent_member_id}/gateway/jobs/pending?limit={limit}"
        )
        response = await self._request("GET", path)
        jobs = response.get("jobs")
        if not isinstance(jobs, Sequence) or isinstance(jobs, (str, bytes, bytearray)):
            raise ContractError("pending jobs response has an invalid shape")
        return [job for job in jobs if isinstance(job, Mapping)]

    async def event(
        self, job: ClaimedJob, status: str, **fields: Any
    ) -> Mapping[str, Any]:
        path = (
            f"/v1/workspaces/{self.config.workspace_id}"
            f"/agent-runs/{job.run_id}/gateway/events"
        )
        body = {**job.callback_binding(), "status": status, **fields}
        return await self._request("POST", path, body)

    async def complete(
        self, job: ClaimedJob, completion: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        path = (
            f"/v1/workspaces/{self.config.workspace_id}"
            f"/agent-runs/{job.run_id}/gateway/complete"
        )
        return await self._request(
            "POST", path, {**completion, **job.callback_binding()}
        )

    async def renew(self, job: ClaimedJob) -> int:
        path = (
            f"/v1/workspaces/{self.config.workspace_id}"
            f"/agents/{self.config.agent_member_id}/gateway/jobs/{job.job_id}"
            "/lease/renew"
        )
        response = await self._request("POST", path, job.callback_binding())
        try:
            return int(
                response.get("leaseExpiresAtMs")
                or response.get("lease_expires_at_ms")
            )
        except (TypeError, ValueError) as exc:
            raise LeaseLost("lease renewal response has no expiry") from exc

    async def release(self, job: ClaimedJob) -> None:
        path = (
            f"/v1/workspaces/{self.config.workspace_id}"
            f"/agents/{self.config.agent_member_id}/gateway/jobs/{job.job_id}"
            "/lease/release"
        )
        await self._request("POST", path, job.callback_binding())

    async def _request(
        self, method: str, path: str, body: Optional[Mapping[str, Any]] = None
    ) -> Mapping[str, Any]:
        return await asyncio.to_thread(self._sync_request, method, path, body)

    def _sync_request(
        self, method: str, path: str, body: Optional[Mapping[str, Any]]
    ) -> Mapping[str, Any]:
        data = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.config.agent_token}",
        }
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.config.api_base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.config.http_timeout_seconds
            ) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read(4_096).decode("utf-8", errors="replace")
            raise MomoAPIError(
                exc.code,
                path,
                redact_text(detail, exact=self.config.agent_token),
            ) from exc
        except urllib.error.URLError as exc:
            raise MomoAPIError(0, path, "momo API is unavailable") from exc
        if not raw:
            return {}
        try:
            decoded = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise MomoAPIError(0, path, "momo API returned invalid JSON") from exc
        if not isinstance(decoded, Mapping):
            raise MomoAPIError(0, path, "momo API returned a non-object response")
        return decoded


@dataclasses.dataclass(frozen=True)
class CodexRunResult:
    exit_code: int
    final_message: str
    session_id: Optional[str]
    usage: Mapping[str, Any]
    stderr: str


class CodexRunner:
    """Headless Codex CLI wrapper. It never reads Codex auth storage."""

    def __init__(self, config: WorkbenchConfig, state_store: StateStore) -> None:
        self.config = config
        self.state_store = state_store

    def argv(
        self,
        *,
        run_id: str,
        sandbox: SandboxPolicy,
        resume_session_id: Optional[str],
    ) -> list[str]:
        output_path = self.state_store.output_path(run_id)
        args = [
            self.config.codex_bin,
            "exec",
            "--json",
            "--color",
            "never",
            "--sandbox",
            sandbox.value,
            "-c",
            "approval_policy=never",
            "--output-last-message",
            str(output_path),
            "--cd",
            str(self.config.workspace_path),
        ]
        if resume_session_id:
            args.extend(["resume", resume_session_id, "-"])
        else:
            args.append("-")
        return args

    async def run(
        self,
        *,
        run_id: str,
        prompt: str,
        sandbox: SandboxPolicy,
        resume_session_id: Optional[str],
        on_event: Callable[[Mapping[str, Any]], Awaitable[None]],
    ) -> CodexRunResult:
        output_path = self.state_store.output_path(run_id)
        output_path.unlink(missing_ok=True)
        argv = self.argv(
            run_id=run_id,
            sandbox=sandbox,
            resume_session_id=resume_session_id,
        )
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=self.config.workspace_path,
                env=self._codex_environment(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise WorkbenchError("unable to start configured Codex binary") from exc

        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None
        process.stdin.write(prompt.encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()

        session_id: Optional[str] = None
        usage: dict[str, Any] = {}

        async def consume_stdout() -> None:
            nonlocal session_id, usage
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    log.debug("ignoring non-JSON Codex stdout line")
                    continue
                if not isinstance(event, Mapping):
                    continue
                if event.get("type") == "thread.started":
                    candidate = str(event.get("thread_id") or "").strip()
                    if candidate:
                        session_id = candidate
                if event.get("type") == "turn.completed" and isinstance(
                    event.get("usage"), Mapping
                ):
                    usage = dict(event["usage"])
                await on_event(event)

        stderr_task = asyncio.create_task(process.stderr.read(MAX_FINAL_MESSAGE_BYTES))
        try:
            await consume_stdout()
            exit_code = await process.wait()
            stderr_raw = await stderr_task
        except asyncio.CancelledError:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            stderr_task.cancel()
            raise

        stderr = redact_text(
            stderr_raw.decode("utf-8", errors="replace"),
            exact=self.config.agent_token,
        )
        try:
            final_message = output_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            final_message = ""
        finally:
            output_path.unlink(missing_ok=True)
        final_message = _truncate_utf8(
            redact_text(final_message, exact=self.config.agent_token),
            MAX_FINAL_MESSAGE_BYTES,
        ).strip()
        return CodexRunResult(
            exit_code=exit_code,
            final_message=final_message,
            session_id=session_id or resume_session_id,
            usage=_gateway_usage(usage),
            stderr=stderr,
        )

    @staticmethod
    def _codex_environment() -> dict[str, str]:
        """Keep host Codex auth, but never expose momo control-plane secrets."""
        environment = dict(os.environ)
        for name in (
            "MOMO_AGENT_TOKEN",
            "MOMO_AGENT_GATEWAY_SECRET",
            "MOMO_API_URL",
            "MOMO_WORKSPACE_ID",
            "MOMO_AGENT_MEMBER_ID",
        ):
            environment.pop(name, None)
        return environment


@dataclasses.dataclass(frozen=True)
class GitSummary:
    diff_summary: str
    changed_files: Sequence[str]


class GitInspector:
    def __init__(self, workspace_path: Path) -> None:
        self.workspace_path = workspace_path

    async def summarize(self) -> GitSummary:
        return await asyncio.to_thread(self._summarize_sync)

    def _summarize_sync(self) -> GitSummary:
        status = self._git("status", "--porcelain=v1", "--untracked-files=all")
        if status is None:
            return GitSummary("workspace is not a Git worktree", [])
        files: list[str] = []
        for line in status.splitlines():
            if len(line) < 4:
                continue
            path = line[3:].strip()
            if " -> " in path:
                path = path.split(" -> ", 1)[1]
            if path and path not in files:
                files.append(path)
        stat = self._git("diff", "--stat", "--", ".") or ""
        summary = stat.strip()
        if not summary:
            summary = (
                f"{len(files)} changed file(s): {', '.join(files[:8])}"
                if files
                else "no worktree diff"
            )
        return GitSummary(_truncate_utf8(summary, 4_000), files[:100])

    def _git(self, *args: str) -> Optional[str]:
        try:
            result = subprocess.run(
                ["git", "-C", str(self.workspace_path), *args],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return result.stdout if result.returncode == 0 else None


class CodexWorkbench:
    def __init__(
        self,
        config: WorkbenchConfig,
        *,
        client: Optional[MomoClient] = None,
        runner: Optional[CodexRunner] = None,
        state_store: Optional[StateStore] = None,
        git_inspector: Optional[GitInspector] = None,
    ) -> None:
        self.config = config
        self.state_store = state_store or StateStore(config.state_dir)
        self.client = client or MomoClient(config)
        self.runner = runner or CodexRunner(config, self.state_store)
        self.git_inspector = git_inspector or GitInspector(config.workspace_path)
        self._stopping = False
        self._partial_events = 0

    async def run_once(self) -> bool:
        jobs = await self.client.pending_jobs(limit=1)
        if not jobs:
            return False
        raw = jobs[0]
        job: Optional[ClaimedJob] = None
        try:
            job = ClaimedJob.from_dict(
                raw,
                workspace_id=self.config.workspace_id,
                agent_member_id=self.config.agent_member_id,
            )
            await self.process_job(job)
        except Exception as exc:
            safe = redact_text(str(exc), exact=self.config.agent_token)
            log.error("claimed work job failed: %s", safe)
            if job is not None:
                try:
                    await self.client.release(job)
                except Exception:
                    log.warning("failed to release unprocessed gateway job")
        return True

    async def run_forever(self) -> None:
        while not self._stopping:
            try:
                handled = await self.run_once()
            except Exception as exc:
                log.error(
                    "gateway recovery failed: %s",
                    redact_text(str(exc), exact=self.config.agent_token),
                )
                handled = False
            if not handled:
                await asyncio.sleep(self.config.poll_interval_seconds)

    def stop(self) -> None:
        self._stopping = True

    async def process_job(self, job: ClaimedJob) -> None:
        self._partial_events = 0
        state = self.state_store.load(job.run_id)
        resume_status = _resume_status(job.payload)

        if state is not None and state.phase == "completion_pending":
            if not state.completion:
                raise ContractError("completion-pending state has no result")
            await self.client.complete(job, state.completion)
            self.state_store.delete(job.run_id)
            return

        if resume_status is not None:
            await self._process_approval_resume(job, state, resume_status)
            return

        work = WorkRequest.from_payload(job.payload)
        if state is None:
            state = RunState(
                run_id=job.run_id,
                phase="new",
                requested_sandbox=self.config.sandbox.value,
                work=work.as_dict(),
            )
            self.state_store.save(state)
        else:
            self._validate_state_for_job(state, work)

        if self.config.sandbox is SandboxPolicy.READ_ONLY:
            await self._execute_and_complete(
                job,
                state,
                prompt=self._execution_prompt(work, read_only=True),
                sandbox=SandboxPolicy.READ_ONLY,
                resume_session_id=state.session_id,
            )
            return
        await self._prepare_workspace_write_approval(job, state, work)

    async def _prepare_workspace_write_approval(
        self, job: ClaimedJob, state: RunState, work: WorkRequest
    ) -> None:
        if state.phase != "awaiting_approval":
            await self.client.event(
                job,
                "thinking",
                detail="Codex is preparing a read-only execution plan",
                event_id=str(uuid.uuid4()),
            )
            plan = await self._run_codex_with_lease(
                job,
                prompt=self._planning_prompt(work),
                sandbox=SandboxPolicy.READ_ONLY,
                resume_session_id=state.session_id,
            )
            if plan.exit_code != 0 or not plan.session_id:
                completion = await self._structured_completion(
                    plan, SandboxPolicy.READ_ONLY
                )
                await self._cache_and_complete(job, state, completion)
                return
            state.session_id = plan.session_id
            state.plan_summary = plan.final_message
            state.approval_call_id = f"codex-workspace-write:{job.run_id}"
            state.phase = "awaiting_approval"
            self.state_store.save(state)

        if not state.session_id or not state.approval_call_id:
            raise ContractError("workspace-write approval state is incomplete")
        await self.client.event(
            job,
            "approval_request",
            approval_request=self._approval_request(state, work),
        )

    async def _process_approval_resume(
        self,
        job: ClaimedJob,
        state: Optional[RunState],
        resume_status: str,
    ) -> None:
        if state is None or state.phase != "awaiting_approval":
            raise ContractError("approval resume has no matching host-local run state")
        if state.requested_sandbox != SandboxPolicy.WORKSPACE_WRITE.value:
            raise ContractError("approval resume does not target workspace-write")
        if resume_status != "approved":
            await self.client.event(
                job,
                "cancelled",
                detail=f"workspace-write approval {resume_status}; Codex was not resumed",
                event_id=str(uuid.uuid4()),
            )
            self.state_store.delete(job.run_id)
            return
        approved_call = job.payload.get("approved_tool_call")
        approved_call_id = (
            str(approved_call.get("call_id") or "")
            if isinstance(approved_call, Mapping)
            else ""
        )
        if not state.approval_call_id or approved_call_id != state.approval_call_id:
            raise ContractError("approved tool call does not match pending Codex action")
        if not state.session_id:
            raise ContractError("approved workspace-write run has no Codex session id")
        work = WorkRequest.from_payload({"work": state.work})
        await self._execute_and_complete(
            job,
            state,
            prompt=self._approved_resume_prompt(work),
            sandbox=SandboxPolicy.WORKSPACE_WRITE,
            resume_session_id=state.session_id,
        )

    async def _execute_and_complete(
        self,
        job: ClaimedJob,
        state: RunState,
        *,
        prompt: str,
        sandbox: SandboxPolicy,
        resume_session_id: Optional[str],
    ) -> None:
        await self.client.event(
            job,
            "running",
            detail=f"Codex exec started in {sandbox.value} sandbox",
            event_id=str(uuid.uuid4()),
        )
        result = await self._run_codex_with_lease(
            job,
            prompt=prompt,
            sandbox=sandbox,
            resume_session_id=resume_session_id,
        )
        state.session_id = result.session_id or state.session_id
        completion = await self._structured_completion(result, sandbox)
        await self._cache_and_complete(job, state, completion)

    async def _cache_and_complete(
        self, job: ClaimedJob, state: RunState, completion: Mapping[str, Any]
    ) -> None:
        state.phase = "completion_pending"
        state.completion = dict(completion)
        self.state_store.save(state)
        await self.client.complete(job, completion)
        self.state_store.delete(job.run_id)

    async def _run_codex_with_lease(
        self,
        job: ClaimedJob,
        *,
        prompt: str,
        sandbox: SandboxPolicy,
        resume_session_id: Optional[str],
    ) -> CodexRunResult:
        run_task = asyncio.create_task(
            self.runner.run(
                run_id=job.run_id,
                prompt=prompt,
                sandbox=sandbox,
                resume_session_id=resume_session_id,
                on_event=lambda event: self._forward_codex_event(job, event),
            )
        )
        renew_task = asyncio.create_task(self._renew_while_running(job, run_task))
        done, _ = await asyncio.wait(
            {run_task, renew_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if renew_task in done:
            error = renew_task.exception()
            if not run_task.done():
                run_task.cancel()
                try:
                    await run_task
                except asyncio.CancelledError:
                    pass
            if error:
                raise LeaseLost("gateway lease renewal failed") from error
            raise LeaseLost("gateway lease renewal stopped unexpectedly")
        try:
            return await run_task
        finally:
            renew_task.cancel()
            try:
                await renew_task
            except asyncio.CancelledError:
                pass

    async def _renew_while_running(
        self, job: ClaimedJob, run_task: "asyncio.Task[CodexRunResult]"
    ) -> None:
        expires_at_ms = job.lease_expires_at_ms
        while not run_task.done():
            remaining = (expires_at_ms - int(time.time() * 1_000)) / 1_000.0
            await asyncio.sleep(max(0.25, min(10.0, remaining / 3.0)))
            if run_task.done():
                return
            try:
                expires_at_ms = await self.client.renew(job)
            except MomoAPIError as exc:
                if exc.status == 409:
                    raise LeaseLost("gateway lease is no longer owned") from exc
                raise

    async def _forward_codex_event(
        self, job: ClaimedJob, event: Mapping[str, Any]
    ) -> None:
        if self._partial_events >= MAX_PARTIAL_EVENTS:
            return
        rendered = _render_codex_event(event)
        if not rendered:
            return
        safe = redact_text(rendered, exact=self.config.agent_token)
        for chunk in _utf8_chunks(safe, MAX_DELTA_BYTES):
            if self._partial_events >= MAX_PARTIAL_EVENTS:
                return
            try:
                await self.client.event(
                    job,
                    "streaming",
                    detail="Codex transcript",
                    text_delta=chunk,
                    event_id=str(uuid.uuid4()),
                )
            except MomoAPIError as exc:
                if exc.status == 429:
                    log.warning("momo partial stream rate limit reached")
                    self._partial_events = MAX_PARTIAL_EVENTS
                    return
                if exc.status == 409:
                    raise LeaseLost("gateway lease rejected during transcript stream") from exc
                raise
            self._partial_events += 1

    async def _structured_completion(
        self, result: CodexRunResult, sandbox: SandboxPolicy
    ) -> dict[str, Any]:
        git = await self.git_inspector.summarize()
        summary = result.final_message or f"Codex exec exited with code {result.exit_code}."
        pr_match = PR_URL_RE.search(summary)
        card = {
            "schema": RESULT_SCHEMA,
            "summary": summary,
            "diff_summary": git.diff_summary,
            "changed_file_count": len(git.changed_files),
            "changed_files": list(git.changed_files),
            "exit_code": result.exit_code,
            "links": {"pull_request": pr_match.group(0) if pr_match else None},
            "session_id": result.session_id,
            "sandbox": sandbox.value,
        }
        completion: dict[str, Any] = {
            "status": "succeeded" if result.exit_code == 0 else "failed",
            "body": json.dumps(card, ensure_ascii=False, sort_keys=True),
            "usage": dict(result.usage),
        }
        if result.exit_code != 0:
            detail = f"codex exec exited with code {result.exit_code}"
            stderr = _truncate_utf8(result.stderr.strip(), 700)
            completion["error"] = f"{detail}: {stderr}" if stderr else detail
        return completion

    def _approval_request(
        self, state: RunState, work: WorkRequest
    ) -> dict[str, Any]:
        target = work.repo or self.config.workspace_path.name
        branch = work.branch or "current branch"
        plan = _truncate_utf8(state.plan_summary or "read-only plan prepared", 900)
        return {
            "action_type": "codex.exec.workspace_write",
            "tier": SandboxPolicy.WORKSPACE_WRITE.approval_tier,
            "title": f"Run Codex work: {work.title}",
            "summary": (
                f"Resume Codex session with workspace-write for {target} "
                f"({branch}); network writes and credentials remain unavailable. "
                f"Plan: {plan}"
            ),
            "tool_call": {
                "call_id": state.approval_call_id,
                "name": "codex.exec.resume",
                "arguments": {
                    "sandbox": SandboxPolicy.WORKSPACE_WRITE.value,
                    "workspace": self.config.workspace_path.name,
                    "title": work.title,
                    "repo": work.repo,
                    "branch": work.branch,
                    "session_id": state.session_id,
                },
                "tool_grant": {
                    "filesystem": "workspace-write",
                    "network": "denied",
                    "provider_credentials": "host-only",
                },
            },
            "is_reversible": False,
        }

    def _validate_state_for_job(self, state: RunState, work: WorkRequest) -> None:
        if state.requested_sandbox != self.config.sandbox.value:
            raise ContractError("local run state sandbox does not match adapter policy")
        if state.work != work.as_dict():
            raise ContractError("claimed work input differs from host-local run state")

    @staticmethod
    def _planning_prompt(work: WorkRequest) -> str:
        return (
            "Planning phase only. Inspect the workspace under a read-only sandbox and "
            "produce a concise execution plan. Do not modify files, use credentials, "
            "access the network, push, or deploy. Preserve this session for a later "
            "human-approved resume.\n\n"
            + _work_prompt(work)
        )

    @staticmethod
    def _execution_prompt(work: WorkRequest, *, read_only: bool) -> str:
        boundary = (
            "This is a read-only Work request. Inspect and report only; do not modify files."
            if read_only
            else "Execute the approved Work request."
        )
        return (
            f"{boundary} Network writes, credential use, push, deploy, and "
            "danger-full-access are prohibited.\n\n{_work_prompt(work)}"
        )

    @staticmethod
    def _approved_resume_prompt(work: WorkRequest) -> str:
        return (
            "Human approval for workspace-write was granted in momo. Continue this "
            "session and execute the original Work request. Network writes, credential "
            "use, push, deploy, and danger-full-access remain prohibited. Finish with a "
            "concise summary and include a pull-request URL only if one already exists.\n\n"
            + _work_prompt(work)
        )


def _work_prompt(work: WorkRequest) -> str:
    lines = [f"Title: {work.title}", f"Brief: {work.brief}"]
    if work.repo:
        lines.append(f"Repository label: {work.repo}")
    if work.branch:
        lines.append(f"Branch label: {work.branch}")
    return "\n".join(lines)


def _render_codex_event(event: Mapping[str, Any]) -> str:
    event_type = str(event.get("type") or "")
    item = event.get("item")
    if event_type == "item.started" and isinstance(item, Mapping):
        if item.get("type") == "command_execution":
            command = _truncate_utf8(str(item.get("command") or "command"), 1_000)
            return f"$ {command}\n"
        if item.get("type") == "file_change":
            return "file change started\n"
    if event_type == "item.completed" and isinstance(item, Mapping):
        item_type = str(item.get("type") or "")
        if item_type == "agent_message":
            text = str(item.get("text") or "").strip()
            return f"{text}\n" if text else ""
        if item_type == "command_execution":
            command = _truncate_utf8(str(item.get("command") or "command"), 1_000)
            status = str(item.get("status") or "completed")
            return f"$ {command} [{status}]\n"
        if item_type == "file_change":
            changes = item.get("changes")
            count = len(changes) if isinstance(changes, Sequence) else 0
            return f"file change completed ({count} path(s))\n"
    if event_type in {"turn.failed", "error"}:
        message = str(event.get("message") or event.get("error") or "Codex turn failed")
        return f"{_truncate_utf8(message, 1_000)}\n"
    return ""


def _gateway_usage(raw: Mapping[str, Any]) -> dict[str, Any]:
    def nonnegative(name: str) -> int:
        try:
            return max(0, int(raw.get(name) or 0))
        except (TypeError, ValueError):
            return 0

    return {
        "model": "codex-cli",
        "prompt_tokens": nonnegative("input_tokens"),
        "completion_tokens": nonnegative("output_tokens"),
        "cached_tokens": nonnegative("cached_input_tokens"),
        "reasoning_tokens": nonnegative("reasoning_output_tokens"),
        "cost_micro_usd": 0,
        "was_estimated": True,
    }


def _resume_status(payload: Mapping[str, Any]) -> Optional[str]:
    if not payload.get("resume_from_approval_id"):
        return None
    decision = payload.get("approval_decision")
    if not isinstance(decision, Mapping):
        return "missing"
    return str(decision.get("status") or "missing").strip().lower() or "missing"


def redact_text(raw: Any, *, exact: str = "") -> str:
    value = str(raw)
    if exact:
        value = value.replace(exact, "[redacted-agent-token]")
    for pattern in TOKEN_PATTERNS:
        value = pattern.sub("[redacted-credential]", value)
    lower = value.lower()
    if any(
        hint in lower
        for hint in ("authorization:", "bearer ", "api_key", "access_token", "refresh_token")
    ):
        return "credential-shaped content was redacted"
    return value


def _utf8_chunks(text: str, limit: int) -> Sequence[str]:
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for character in text:
        encoded = len(character.encode("utf-8"))
        if current and size + encoded > limit:
            chunks.append("".join(current))
            current = []
            size = 0
        current.append(character)
        size += encoded
    if current:
        chunks.append("".join(current))
    return chunks


def _truncate_utf8(text: str, limit: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode("utf-8", errors="ignore") + "…"


def _required_text(raw: Any, field: str, limit: int) -> str:
    if not isinstance(raw, str):
        raise ContractError(f"{field} is required")
    value = raw.strip()
    if not value or len(value.encode("utf-8")) > limit:
        raise ContractError(f"{field} is invalid")
    return value


def _optional_text(raw: Any, field: str, limit: int) -> Optional[str]:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ContractError(f"{field} must be a string")
    value = raw.strip()
    if not value or len(value.encode("utf-8")) > limit:
        raise ContractError(f"{field} is invalid")
    return value


def _optional_string(raw: Any) -> Optional[str]:
    value = str(raw).strip() if raw is not None else ""
    return value or None


def _required_uuid(
    raw: Any,
    field: str,
    *,
    error_type: type[WorkbenchError] = ConfigurationError,
) -> uuid.UUID:
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as exc:
        raise error_type(f"{field} must be a UUID") from exc


def _canonical_uuid(raw: Any) -> str:
    try:
        return str(uuid.UUID(str(raw)))
    except (TypeError, ValueError):
        return ""


def _truthy(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _positive_float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be positive")
    return value


def _validate_api_url(raw: str, allow_insecure_http: bool) -> None:
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigurationError("MOMO_API_URL must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ConfigurationError("MOMO_API_URL must not contain credentials")
    if parsed.scheme == "https":
        return
    host = parsed.hostname
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.lower() == "localhost"
    if not loopback and not allow_insecure_http:
        raise ConfigurationError(
            "non-loopback MOMO_API_URL requires https or "
            "MOMO_AGENT_ALLOW_INSECURE_HTTP=1"
        )


async def _main_async(args: argparse.Namespace) -> int:
    config = WorkbenchConfig.from_env()
    adapter = CodexWorkbench(config)
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, adapter.stop)
        except NotImplementedError:
            pass
    if args.once:
        await adapter.run_once()
    else:
        await adapter.run_forever()
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--once", action="store_true", help="claim at most one job, then exit"
    )
    parser.add_argument(
        "--log-level", default=os.environ.get("MOMO_CODEX_LOG_LEVEL", "INFO")
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        return asyncio.run(_main_async(args))
    except KeyboardInterrupt:
        return 130
    except WorkbenchError as exc:
        log.error("startup failed: %s", redact_text(exc))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
