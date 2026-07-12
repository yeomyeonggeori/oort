"""momo platform adapter for the Hermes agent gateway plugin.

L4 spec §6.3 — registers a momo workspace as a first-class platform for a hermes
agent so the agent *lives* in momo as a `member` (kind='agent'), not a webhook bot.

What this adapter does (the three BasePlatformAdapter primitives, §6.3):

  connect()         authenticate every momo surface with one scoped per-agent
                    bearer (`MOMO_AGENT_TOKEN`) → realtime-token exchange →
                    subscribe the agent's private `agentwork:` Centrifugo stream.

  send(channel, …)  REST POST .../messages with a client_msg_id for idempotency
                    (§3.1 — the server's UPDATE channel_seq + INSERT message +
                    INSERT outbox single tx dedups on
                    (channel_id, author_member_id, client_msg_id)).

  handle_message()  a mention / DM signal arrives on the realtime stream →
                    invoke the agent (POST .../agents/{id}/invoke) → stream the
                    agent.partial / agent.status deltas back and reflect them into
                    the channel via send().

Write path (L4 §1.2 / §8.1): this adapter NEVER publishes to Centrifugo directly.
All writes go REST → PG commit → outbox → relay publishes. The adapter only
*reads* the realtime stream and *writes* via REST.

------------------------------------------------------------------------------
Credentialed runtime boundary:
  This module is the momo-side plugin adapter that the Hermes gateway loads
  (it imports `BasePlatformAdapter` from the Hermes plugin SDK). The repository
  can verify the adapter contract and momo server bearer surfaces without a
  provider credential:
      python3 -m py_compile adapters/hermes/momo_adapter.py
  A real provider completion still requires a user-owned Hermes login. Network
  calls degrade gracefully if `aiohttp` / `websockets` are absent so static gates
  remain import-safe.

  The bearer-protected realtime, pending-job, event, completion, and message
  surfaces are regression-tested against MomoServer by the runtime-agent gate.
"""

from __future__ import annotations

import asyncio
import inspect
import ipaddress
import json
import logging
import os
import random
import re
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Mapping, Optional, Sequence
from urllib.parse import urlsplit

log = logging.getLogger("momo.adapter")


def _redact_credential_text(raw: Any, *, exact: Optional[str] = None) -> str:
    value = str(raw)
    if exact:
        value = value.replace(exact, "[redacted]")
    replacements = (
        (
            r"momo_agent_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "[redacted-agent-token]",
        ),
        (
            r"(?i)\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,}|"
            r"github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|"
            r"ya29\.[A-Za-z0-9._-]{8,})\b",
            "[redacted-provider-token]",
        ),
        (
            r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b",
            "[redacted-jwt]",
        ),
        (
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*",
            "Bearer [redacted]",
        ),
    )
    for pattern, replacement in replacements:
        value = re.sub(pattern, replacement, value)
    return value

# ---------------------------------------------------------------------------
# Optional runtime deps. The hermes plugin runtime provides an async HTTP client
# and a WebSocket client; we prefer aiohttp/websockets but keep import-time
# success (py_compile + plain `import`) even when they are not installed, so the
# static gate passes in environments without the runtime wheels.
# ---------------------------------------------------------------------------
try:  # pragma: no cover - exercised only with the runtime dep present
    import aiohttp
except Exception:  # pragma: no cover
    aiohttp = None  # type: ignore[assignment]

try:  # pragma: no cover
    import websockets
except Exception:  # pragma: no cover
    websockets = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# BasePlatformAdapter import.
# The Hermes plugin SDK supplies BasePlatformAdapter through
# `gateway.platforms.base` in the current public runtime. Older/internal builds
# exposed it under `hermes.*`, so keep those as fallbacks. If none resolve
# (e.g. py_compile outside the gateway), a tiny local shim keeps this file
# import-safe for repo gates.
# ---------------------------------------------------------------------------
_BASE_IMPORTED = False
_GATEWAY_BASE_IMPORTED = False
Platform = None  # type: ignore[assignment]
PlatformConfig = None  # type: ignore[assignment]
SessionSource = None  # type: ignore[assignment]
MessageEvent = None  # type: ignore[assignment]
MessageType = None  # type: ignore[assignment]
try:  # pragma: no cover - depends on gateway runtime
    from gateway.config import Platform, PlatformConfig  # type: ignore
    from gateway.platforms.base import (  # type: ignore
        BasePlatformAdapter,
        MessageEvent,
        MessageType,
        SendResult,
    )
    from gateway.session import SessionSource  # type: ignore

    _BASE_IMPORTED = True
    _GATEWAY_BASE_IMPORTED = True
except Exception:  # pragma: no cover
    try:
        from hermes.platform import BasePlatformAdapter  # type: ignore

        _BASE_IMPORTED = True
    except Exception:  # pragma: no cover
        try:
            from hermes.plugins import BasePlatformAdapter  # type: ignore

            _BASE_IMPORTED = True
        except Exception:
            class BasePlatformAdapter:  # type: ignore[no-redef]
                """Fallback shim mirroring the Hermes adapter surface."""

                #: platform identifier the gateway keys the registry on.
                platform_name: str = "momo"

                def __init__(self, *args: Any, **kwargs: Any) -> None:
                    ...

                async def connect(self, *args: Any, **kwargs: Any) -> bool:
                    raise NotImplementedError

                async def disconnect(self) -> None:
                    raise NotImplementedError

                async def send(self, channel: str, blocks: Any, *args: Any, **kwargs: Any) -> Any:
                    raise NotImplementedError

                async def handle_message(self, evt: Any) -> Any:
                    raise NotImplementedError


            @dataclass(slots=True)
            class SendResult:  # type: ignore[no-redef]
                success: bool
                message_id: Optional[str] = None
                error: Optional[str] = None
                raw_response: Any = None

else:
    _BASE_IMPORTED = True

if "SendResult" not in globals():  # pragma: no cover - legacy SDK import path
    @dataclass(slots=True)
    class SendResult:  # type: ignore[no-redef]
        success: bool
        message_id: Optional[str] = None
        error: Optional[str] = None
        raw_response: Any = None


# ---------------------------------------------------------------------------
# Configuration (env-driven, mirrors infra/.env.example + L4 §0.3 / §7.1).
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class MomoConfig:
    """Connection + identity config for one agent instance on one workspace."""

    # momo REST API base, e.g. http://api:8080 (Hummingbird server, L4 §1.1).
    api_base_url: str = field(
        default_factory=lambda: os.environ.get("MOMO_API_URL", "http://localhost:8080")
    )
    # Centrifugo WebSocket endpoint, e.g. ws://centrifugo:8000/connection/websocket.
    centrifugo_ws_url: str = field(
        default_factory=lambda: os.environ.get(
            "MOMO_CENTRIFUGO_WS_URL", "ws://localhost:8000/connection/websocket"
        )
    )
    # Per-agent momo bearer (ADR-0101 Phase 1). This is not a provider OAuth
    # credential; it authorizes only the scoped momo surfaces granted at mint.
    agent_token: str = field(
        default_factory=lambda: os.environ.get("MOMO_AGENT_TOKEN", "")
    )
    # Tenant + identity. workspace_id and agent_member_id come from the seeded
    # agent row (member.id where kind='agent'); both are encoded in agent: channels.
    workspace_id: str = field(
        default_factory=lambda: os.environ.get("MOMO_WORKSPACE_ID", "")
    )
    agent_member_id: str = field(
        default_factory=lambda: os.environ.get("MOMO_AGENT_MEMBER_ID", "")
    )
    agent_handle: str = field(
        default_factory=lambda: os.environ.get("MOMO_AGENT_HANDLE", "hermes")
    )
    allow_insecure_http: bool = field(
        default_factory=lambda: os.environ.get(
            "MOMO_AGENT_ALLOW_INSECURE_HTTP", "0"
        ).lower() in ("1", "true", "yes")
    )
    request_timeout_s: float = 120.0


# ---------------------------------------------------------------------------
# Centrifugo channel naming (L4 §4.1).
#   ch    : ch:ws<workspaceUUID>.<channelUUID>       # group channel
#   agentwork : agentwork:ws<workspaceUUID>.<agentMemberUUID> # private work stream
# Channel ids handed to send() remain opaque; REST is the only write path.
# ---------------------------------------------------------------------------
def _canonical_uuid_text(value: Any) -> str:
    text = str(value)
    try:
        return str(uuid.UUID(text)).upper()
    except (ValueError, TypeError, AttributeError):
        return text


def agent_channel(workspace_id: str, agent_member_id: str) -> str:
    return (
        f"agentwork:ws{_canonical_uuid_text(workspace_id)}."
        f"{_canonical_uuid_text(agent_member_id)}"
    )


def _is_platform_config(value: Any) -> bool:
    if value is None or PlatformConfig is None:
        return False
    try:
        return isinstance(value, PlatformConfig)
    except TypeError:  # pragma: no cover - exotic SDK typing object
        return value.__class__.__name__ == "PlatformConfig"


def _platform_value() -> Any:
    if Platform is None:
        return "momo"
    for value in ("momo", "MOMO"):
        try:
            return Platform(value)
        except Exception:
            continue
    momo_attr = getattr(Platform, "MOMO", None) or getattr(Platform, "momo", None)
    return momo_attr or "momo"


def _platform_extra(config: Any) -> Mapping[str, Any]:
    if config is None:
        return {}
    extra = getattr(config, "extra", None)
    if isinstance(extra, Mapping):
        return extra
    if isinstance(config, Mapping):
        return config
    return {}


def _extra_value(extra: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        if key in extra and extra[key] is not None:
            value = str(extra[key]).strip()
            if value:
                return value
    return ""


def _momo_config_from(config: Any) -> MomoConfig:
    if isinstance(config, MomoConfig):
        return config

    cfg = MomoConfig()
    extra = _platform_extra(config)
    cfg.api_base_url = (
        _extra_value(extra, "MOMO_API_URL", "momo_api_url", "api_base_url")
        or cfg.api_base_url
    )
    cfg.centrifugo_ws_url = (
        _extra_value(
            extra,
            "MOMO_CENTRIFUGO_WS_URL",
            "momo_centrifugo_ws_url",
            "centrifugo_ws_url",
        )
        or cfg.centrifugo_ws_url
    )
    cfg.agent_token = (
        _extra_value(extra, "MOMO_AGENT_TOKEN", "momo_agent_token", "agent_token")
        or cfg.agent_token
    )
    cfg.workspace_id = (
        _extra_value(extra, "MOMO_WORKSPACE_ID", "momo_workspace_id", "workspace_id")
        or cfg.workspace_id
    )
    cfg.agent_member_id = (
        _extra_value(
            extra, "MOMO_AGENT_MEMBER_ID", "momo_agent_member_id", "agent_member_id"
        )
        or cfg.agent_member_id
    )
    cfg.agent_handle = (
        _extra_value(extra, "MOMO_AGENT_HANDLE", "momo_agent_handle", "agent_handle")
        or cfg.agent_handle
    )
    insecure_flag = _extra_value(
        extra,
        "MOMO_AGENT_ALLOW_INSECURE_HTTP",
        "momo_agent_allow_insecure_http",
        "allow_insecure_http",
    )
    if insecure_flag:
        cfg.allow_insecure_http = insecure_flag.lower() in ("1", "true", "yes")
    return cfg


def _platform_config_from_momo(cfg: MomoConfig) -> Any:
    if PlatformConfig is None:
        return None
    extra = {
        "MOMO_API_URL": cfg.api_base_url,
        "MOMO_CENTRIFUGO_WS_URL": cfg.centrifugo_ws_url,
        "MOMO_WORKSPACE_ID": cfg.workspace_id,
        "MOMO_AGENT_MEMBER_ID": cfg.agent_member_id,
        "MOMO_AGENT_HANDLE": cfg.agent_handle,
        "MOMO_AGENT_TOKEN": cfg.agent_token,
        "MOMO_AGENT_ALLOW_INSECURE_HTTP": "1" if cfg.allow_insecure_http else "0",
    }
    attempts = (
        {"platform": _platform_value(), "enabled": True, "extra": extra},
        {"enabled": True, "extra": extra},
        {"extra": extra},
        {},
    )
    for kwargs in attempts:
        try:
            return PlatformConfig(**kwargs)
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# The adapter.
# ---------------------------------------------------------------------------
class MomoAdapter(BasePlatformAdapter):
    """First-class momo membership for a hermes agent (L4 §6.3).

    Lifecycle: construct → connect() (auth + subscribe) → the gateway pumps
    inbound realtime events through handle_message(), which invokes the agent and
    streams the reply back via send().
    """

    platform_name = "momo"
    _max_handled_triggers = 4096
    _max_pending_results = 128
    _max_queued_jobs = 64
    _pending_page_size = 100
    _max_pending_pages = 10
    _max_pending_recovery_attempts = 3

    def __init__(
        self,
        config: Optional[Any] = None,
        *,
        hermes_runtime: Any = None,
        **kwargs: Any,
    ) -> None:
        self.cfg = _momo_config_from(config)
        base_config = config if _is_platform_config(config) else _platform_config_from_momo(self.cfg)
        platform = kwargs.pop("platform", None) or _platform_value()
        # Current Hermes BasePlatformAdapter expects (PlatformConfig, Platform).
        # Legacy shims accepted no args or **kwargs; try in that order without
        # leaking momo/provider secrets into logs.
        try:
            if _GATEWAY_BASE_IMPORTED:
                super().__init__(base_config, platform)
            else:
                super().__init__(**kwargs)
        except TypeError:
            try:
                super().__init__(base_config, platform)
            except TypeError:
                try:
                    super().__init__(**kwargs)
                except TypeError:
                    super().__init__()
        # `hermes_runtime` is the gateway handle used to invoke the model and to
        # observe the agent's run stream (the OpenAI-compat /v1/chat/completions
        # SSE path lives behind this — L4 §6.2). Injected by the gateway.
        self.runtime = hermes_runtime or kwargs.get("hermes_runtime")

        self._realtime_token: Optional[str] = None
        self._member_id: Optional[str] = self.cfg.agent_member_id or None

        self._http: Any = None           # aiohttp.ClientSession
        self._ws: Any = None             # websockets connection
        self._listen_task: Optional[asyncio.Task[None]] = None
        self._work_task: Optional[asyncio.Task[None]] = None
        self._reconnect_task: Optional[asyncio.Task[None]] = None
        self._reconnect_requested = False
        self._pending_recovery_task: Optional[asyncio.Task[None]] = None
        self._pending_recovery_requested = False
        # Python 3.9 binds asyncio.Queue to the current loop at construction.
        # Hermes creates adapters outside a running loop, so initialize lazily.
        self._work_queue: Any = None
        self._closing = False
        self._terminal_failure: Optional[str] = None
        self._last_publication_offset: Optional[int] = None
        # idempotency cache: dedup re-deliveries of the same trigger message so an
        # agent never double-replies to one mention (belt-and-suspenders on top of
        # the server-side (channel,author,client_msg_id) unique — L4 §3.1).
        self._handled_triggers: OrderedDict[str, None] = OrderedDict()
        self._inflight_triggers: set[str] = set()
        self._pending_gateway_results: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._gateway_result_reservations: set[str] = set()

    # ----- HTTP helpers ----------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.cfg.agent_token:
            h["Authorization"] = f"Bearer {self.cfg.agent_token}"
        return h

    async def _ensure_session(self) -> Any:
        if aiohttp is None:  # pragma: no cover - runtime dep missing
            raise RuntimeError(
                "aiohttp not installed — momo adapter needs it at runtime "
                "(see adapters/hermes/requirements.txt). runtime-unverified."
            )
        if self._http is None or self._http.closed:
            timeout = aiohttp.ClientTimeout(total=self.cfg.request_timeout_s)
            self._http = aiohttp.ClientSession(timeout=timeout)
        return self._http

    @staticmethod
    def _auth_retry_delay(attempt: int) -> float:
        return min(2.0 ** max(attempt, 0), 4.0) + random.uniform(0.0, 0.25)

    async def _request_json(
        self,
        method: str,
        path: str,
        body: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        session = await self._ensure_session()
        url = f"{self.cfg.api_base_url}{path}"
        attempts = 3
        for attempt in range(attempts):
            request = (
                session.get(url, headers=self._auth_headers())
                if method == "GET"
                else session.post(url, json=body or {}, headers=self._auth_headers())
            )
            async with request as resp:
                response_text = await resp.text()
                response_status = resp.status
            if response_status < 400:
                return json.loads(response_text) if response_text else {}
            if response_status != 401 or attempt == attempts - 1:
                error = MomoAPIError(response_status, path, response_text)
                if response_status == 401:
                    await self._handle_terminal_credential_failure(path)
                raise error
            delay = self._auth_retry_delay(attempt)
            log.warning(
                "momo agent bearer rejected on %s; retrying in %.2fs "
                "(attempt %s/%s). Reissue the agent token from pairing if this persists.",
                path,
                delay,
                attempt + 1,
                attempts,
            )
            await asyncio.sleep(delay)
        raise MomoAPIError(401, path, "agent bearer rejected")

    async def _post(self, path: str, body: Mapping[str, Any]) -> dict[str, Any]:
        return await self._request_json("POST", path, body)

    async def _get(self, path: str) -> dict[str, Any]:
        return await self._request_json("GET", path)

    # ----- connect (L4 §6.3) ----------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        """Use one per-agent bearer for realtime and every momo REST surface.

        Steps (L4 §6.3 / §7.1 / §4.3):
          1. POST /v1/auth/realtime-token with MOMO_AGENT_TOKEN
          2. WS connect to Centrifugo with the returned short-lived JWT
          3. subscribe agentwork:ws<workspaceUUID>.<agentMemberUUID>
          4. drain durable pending jobs once to recover a missed realtime signal
        """
        valid, detail = validate_config(self.cfg)
        if not valid:
            raise MomoConfigurationError(detail or "invalid momo adapter configuration")
        self._closing = False
        self._terminal_failure = None
        try:
            await self._fetch_realtime_token()
            await self._open_realtime()
            await self._drain_pending_gateway_jobs(reason="connect")
            if self._closing:
                raise MomoConfigurationError(
                    "momo adapter closed during pending job recovery"
                )
            if self._pending_recovery_requested:
                self._schedule_pending_recovery(reason="connect-continuation")
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception:
            await self.close()
            raise
        mark_connected = getattr(self, "_mark_connected", None)
        if callable(mark_connected):  # pragma: no cover - live Hermes SDK only
            mark_connected()
        log.info(
            "momo adapter connected: ws=%s agent=%s handle=%s reconnect=%s",
            self.cfg.workspace_id,
            self.cfg.agent_member_id or self._member_id,
            self.cfg.agent_handle,
            is_reconnect,
        )
        return True

    async def _fetch_realtime_token(self) -> None:
        # The server resolves the agent principal from MOMO_AGENT_TOKEN and
        # returns a short-lived Centrifugo JWT whose subject is that same agent.
        data = await self._post("/v1/auth/realtime-token", {})
        issued_workspace_id = data.get("workspaceId") or data.get("workspace_id")
        issued_member_id = data.get("memberId") or data.get("member_id")
        if str(issued_workspace_id or "") != self.cfg.workspace_id:
            raise MomoConfigurationError(
                "MOMO_WORKSPACE_ID does not match the agent bearer actor"
            )
        if str(issued_member_id or "") != self.cfg.agent_member_id:
            raise MomoConfigurationError(
                "MOMO_AGENT_MEMBER_ID does not match the agent bearer actor"
            )
        # Accept common field spellings the server might use.
        self._realtime_token = (
            data.get("token")
            or data.get("realtimeToken")
            or data.get("connectionToken")
        )
        if not self._realtime_token:
            raise MomoAPIError(
                0, "/v1/auth/realtime-token", "no realtime token in response"
            )

    async def _open_realtime(self) -> None:
        """Open the Centrifugo WS, authenticate, subscribe, start listening."""
        if websockets is None:  # pragma: no cover - runtime dep missing
            raise RuntimeError(
                "websockets not installed — momo adapter needs it at runtime "
                "(see adapters/hermes/requirements.txt). runtime-unverified."
            )
        self._ws = await websockets.connect(self.cfg.centrifugo_ws_url)
        # Centrifugo client protocol: connect command carries the JWT, then the
        # adapter subscribes only to its own agent work stream.
        await self._ws_send({"connect": {"token": self._realtime_token}, "id": 1})
        agent_member_id = self.cfg.agent_member_id or self._member_id
        if not self.cfg.workspace_id or not agent_member_id:
            raise MomoAPIError(
                0, "/v1/auth/realtime-token", "missing workspace_id or agent_member_id"
            )
        await self._ws_send({
            "subscribe": {"channel": agent_channel(self.cfg.workspace_id, agent_member_id)},
            "id": 2,
        })
        self._ensure_work_task()
        self._listen_task = asyncio.create_task(self._listen_loop())

    async def _ws_send(self, command: Mapping[str, Any]) -> None:
        assert self._ws is not None
        await self._ws.send(json.dumps(command))

    async def _listen_loop(self) -> None:
        """Pump inbound Centrifugo frames into handle_message().

        Centrifugo pushes arrive as `{"push": {"channel": ..., "pub": {"data": …}}}`.
        We unwrap the envelope (L4 §5.2: {type, v, ts, seq, payload}) and forward
        mention/dm.signal events to handle_message().
        """
        assert self._ws is not None
        try:
            async for raw in self._ws:
                for frame in self._iter_frames(raw):
                    pong = self._pong_for_frame(frame)
                    if pong is not None:
                        await self._ws_send(pong)
                        continue
                    push = frame.get("push")
                    if not push:
                        continue  # connect/subscribe acks
                    pub = push.get("pub") or {}
                    offset = pub.get("offset")
                    if isinstance(offset, int):
                        if (
                            self._last_publication_offset is not None
                            and offset > self._last_publication_offset + 1
                        ):
                            self._schedule_pending_recovery(reason="publication-gap")
                        self._last_publication_offset = max(
                            offset,
                            self._last_publication_offset or 0,
                        )
                    envelope = pub.get("data") or {}
                    evt = {
                        "channel": push.get("channel"),
                        "type": envelope.get("type"),
                        "seq": envelope.get("seq"),
                        "ts": envelope.get("ts"),
                        "payload": envelope.get("payload") or {},
                    }
                    if evt.get("type") == "agent.job":
                        # Realtime is only a wake-up.  Never execute the
                        # client-visible publication payload: the bearer-
                        # authenticated pending endpoint is the Postgres-backed
                        # authorization and integrity boundary.
                        self._schedule_pending_recovery(reason="realtime-agent-job")
                    else:
                        try:
                            await self.handle_message(evt)
                        except Exception:  # one bad event must not kill the loop
                            log.exception("handle_message failed for %s", evt.get("type"))
        except asyncio.CancelledError:  # pragma: no cover
            raise
        except Exception:  # pragma: no cover - transport drop → caller reconnects
            if self._closing:
                log.debug("momo realtime listen loop ended during shutdown")
                return
            log.exception("momo realtime listen loop ended; scheduling reconnect")
            self._schedule_reconnect()
        else:  # normal close codes (for example 1000/1001) also require recovery
            if not self._closing:
                log.warning("momo realtime stream closed; scheduling reconnect")
                self._schedule_reconnect()

    async def _work_loop(self) -> None:
        """Execute gateway jobs away from the Centrifugo receive/ping loop."""
        queue = self._ensure_work_queue()
        while not self._closing:
            evt, completion = await queue.get()
            try:
                await self.handle_message(evt)
            except asyncio.CancelledError:
                if completion is not None and not completion.done():
                    completion.cancel()
                raise
            except MomoAPIError as exc:
                if completion is not None and not completion.done():
                    completion.set_exception(exc)
                if exc.status == 401:
                    self._fail_queued_work(exc)
                    await self._handle_terminal_credential_failure(exc.path)
                    return
                if not self._is_retryable_http_status(exc.status):
                    self._fail_queued_work(exc)
                    await self._handle_terminal_gateway_failure(exc)
                    return
                log.error(
                    "gateway job callback failed; scheduling recovery: %s",
                    self._redact_gateway_error(exc),
                )
                self._schedule_pending_recovery(
                    reason="gateway-job-callback-failed", delay_s=1.0
                )
            except MomoGatewayBackpressure:
                if completion is not None and not completion.done():
                    completion.set_exception(
                        MomoGatewayBackpressure("gateway result backlog is full")
                    )
                log.warning("gateway work deferred by completion backpressure")
                self._schedule_pending_recovery(
                    reason="gateway-result-backpressure", delay_s=1.0
                )
            except Exception as exc:
                if completion is not None and not completion.done():
                    completion.set_exception(exc)
                log.error(
                    "gateway job processing failed; scheduling recovery: %s",
                    self._redact_gateway_error(exc),
                )
                self._schedule_pending_recovery(
                    reason="gateway-job-failed", delay_s=1.0
                )
            else:
                if completion is not None and not completion.done():
                    completion.set_result(None)
            finally:
                queue.task_done()

    def _ensure_work_queue(self) -> Any:
        if self._work_queue is None:
            self._work_queue = asyncio.Queue(maxsize=self._max_queued_jobs)
        return self._work_queue

    def _ensure_work_task(self) -> None:
        self._ensure_work_queue()
        if self._work_task is None or self._work_task.done():
            self._work_task = asyncio.create_task(self._work_loop())

    async def _enqueue_gateway_work(
        self, evt: Mapping[str, Any], *, wait_until_complete: bool = False
    ) -> None:
        if self._closing:
            raise MomoConfigurationError("momo adapter is closing")
        self._ensure_work_task()
        completion = (
            asyncio.get_running_loop().create_future()
            if wait_until_complete
            else None
        )
        await self._ensure_work_queue().put((dict(evt), completion))
        if self._closing:
            closing_error = MomoConfigurationError("momo adapter is closing")
            self._fail_queued_work(closing_error)
            if completion is not None:
                await completion
            raise closing_error
        if completion is not None:
            await completion

    def _fail_queued_work(self, error: Exception) -> None:
        queue = self._ensure_work_queue()
        while True:
            try:
                _evt, completion = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            if completion is not None and not completion.done():
                completion.set_exception(error)
            queue.task_done()

    async def _handle_terminal_credential_failure(self, path: str) -> None:
        if self._closing:
            return
        log.error(
            "momo agent credential rejected on %s; stopping adapter until pairing reissues it",
            path,
        )
        await self.close()

    @staticmethod
    def _is_retryable_http_status(status: int) -> bool:
        return status in (408, 425, 429) or status >= 500

    async def _handle_terminal_gateway_failure(self, error: MomoAPIError) -> None:
        if self._closing:
            return
        self._terminal_failure = (
            f"non-retryable momo callback failure: HTTP {error.status} on {error.path}"
        )
        log.error(
            "%s; stopping adapter for operator intervention",
            self._terminal_failure,
        )
        await self.close()

    def _schedule_reconnect(self) -> None:
        if self._closing:
            return
        if self._reconnect_task is not None and not self._reconnect_task.done():
            self._reconnect_requested = True
            return
        self._reconnect_requested = False
        self._reconnect_task = asyncio.create_task(self._reconnect_realtime())

    async def _reconnect_realtime(self) -> None:
        attempt = 0
        while not self._closing:
            delay = self._reconnect_delay(attempt)
            await asyncio.sleep(delay)
            try:
                await self._close_realtime_attempt()
                await self._fetch_realtime_token()
                await self._open_realtime()
                await self._drain_pending_gateway_jobs(reason="reconnect")
                if self._pending_recovery_requested:
                    self._schedule_pending_recovery(reason="reconnect-continuation")
                listener_is_live = (
                    self._listen_task is not None and not self._listen_task.done()
                )
                if self._reconnect_requested or not listener_is_live:
                    self._reconnect_requested = False
                    await self._close_realtime_attempt()
                    attempt += 1
                    continue
                log.info("momo realtime reconnected")
                return
            except asyncio.CancelledError:  # pragma: no cover
                await self._close_realtime_attempt()
                raise
            except MomoAPIError as exc:
                await self._close_realtime_attempt()
                log.error(
                    "momo realtime reconnect blocked: %s",
                    self._redact_gateway_error(exc),
                )
                if exc.status == 401:
                    await self._handle_terminal_credential_failure(exc.path)
                    return
            except Exception:
                await self._close_realtime_attempt()
                log.exception("momo realtime reconnect failed")
            attempt += 1

    @staticmethod
    def _reconnect_delay(attempt: int) -> float:
        exponent = min(max(attempt, 0), 5)
        return min(2.0 ** exponent, 30.0) + random.uniform(0.0, 0.5)

    async def _close_realtime_attempt(self) -> None:
        """Close one WS attempt, including a listener started before recovery failed."""
        task = self._listen_task
        self._listen_task = None
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:  # pragma: no cover - best-effort transport teardown
                log.debug("momo realtime listener teardown failed", exc_info=True)
        await self._close_ws_only()

    async def _close_ws_only(self) -> None:
        if self._ws is None:
            return
        try:
            await self._ws.close()
        except Exception:  # pragma: no cover
            pass
        self._ws = None

    def _schedule_pending_recovery(self, *, reason: str, delay_s: float = 0.0) -> None:
        if self._closing:
            return
        if self._pending_recovery_task is not None and not self._pending_recovery_task.done():
            self._pending_recovery_requested = True
            return
        self._pending_recovery_requested = False
        self._pending_recovery_task = asyncio.create_task(
            self._recover_pending_safely(reason=reason, initial_delay_s=delay_s)
        )

    async def _recover_pending_safely(
        self, *, reason: str, initial_delay_s: float = 0.0
    ) -> None:
        failures = 0
        if initial_delay_s > 0:
            await asyncio.sleep(initial_delay_s)
        while not self._closing:
            self._pending_recovery_requested = False
            try:
                await self._drain_pending_gateway_jobs(reason=reason)
            except asyncio.CancelledError:  # pragma: no cover - shutdown path
                raise
            except MomoAPIError as exc:
                log.error(
                    "momo pending recovery blocked (%s): %s",
                    reason,
                    self._redact_gateway_error(exc),
                )
                if exc.status == 401:
                    await self._handle_terminal_credential_failure(exc.path)
                    return
                failures += 1
            except Exception:
                log.exception("momo pending recovery failed (%s)", reason)
                failures += 1
            else:
                failures = 0
                if not self._pending_recovery_requested:
                    return
                reason = "coalesced-signal"
                continue

            delay = min(2.0 ** min(max(failures - 1, 0), 5), 30.0)
            if failures % self._max_pending_recovery_attempts == 0:
                log.error(
                    "momo pending recovery remains unavailable after %s attempts; "
                    "continuing with capped backoff",
                    failures,
                )
            await asyncio.sleep(delay)
            reason = "retry-after-failure"

    async def _drain_pending_gateway_jobs(self, *, reason: str) -> None:
        if not (self.cfg.workspace_id and self.cfg.agent_member_id):
            return
        path = (
            f"/v1/workspaces/{self.cfg.workspace_id}"
            f"/agents/{self.cfg.agent_member_id}/gateway/jobs/pending"
            f"?limit={self._pending_page_size}"
        )
        for page in range(self._max_pending_pages):
            data = await self._get(path)
            jobs = data.get("jobs") or []
            if not isinstance(jobs, Sequence) or isinstance(jobs, (str, bytes, bytearray)):
                log.warning("momo pending recovery returned an invalid jobs shape")
                return
            if jobs:
                log.info(
                    "momo pending recovery reason=%s page=%s jobs=%s",
                    reason,
                    page + 1,
                    len(jobs),
                )
            for job in jobs:
                if not isinstance(job, Mapping):
                    continue
                payload = job.get("payload")
                if payload is None and isinstance(job.get("payloadJson"), str):
                    try:
                        payload = json.loads(str(job["payloadJson"]))
                    except json.JSONDecodeError:
                        log.warning(
                            "skipping malformed pending gateway job id=%s", job.get("id")
                        )
                        continue
                if not isinstance(payload, Mapping):
                    continue
                await self._enqueue_gateway_work(
                    {
                        "channel": agent_channel(
                            self.cfg.workspace_id, self.cfg.agent_member_id
                        ),
                        "type": str(job.get("type") or "agent.job"),
                        "seq": job.get("id"),
                        "ts": job.get("createdAtMs") or payload.get("created_at_ms"),
                        "payload": payload,
                    },
                    wait_until_complete=True,
                )
            if len(jobs) < self._pending_page_size:
                return
        log.warning(
            "momo pending recovery reached the bounded page limit; scheduling one continuation"
        )
        self._pending_recovery_requested = True

    @staticmethod
    def _iter_frames(raw: Any) -> list[dict[str, Any]]:
        """Centrifugo may batch multiple newline-delimited JSON frames per message."""
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        frames: list[dict[str, Any]] = []
        for line in str(raw).splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                frames.append(json.loads(line))
            except json.JSONDecodeError:
                log.debug("skipping non-JSON frame: %r", line[:80])
        return frames

    @staticmethod
    def _pong_for_frame(frame: Mapping[str, Any]) -> Optional[dict[str, Any]]:
        """Return the Centrifugo JSON protocol pong response for a ping frame."""
        if not frame:
            return {}
        if "ping" in frame:
            return {"pong": {}}
        return None

    def _begin_trigger(self, key: str) -> bool:
        if key in self._handled_triggers or key in self._inflight_triggers:
            return False
        self._inflight_triggers.add(key)
        return True

    def _finish_trigger(self, key: str, *, handled: bool) -> None:
        self._inflight_triggers.discard(key)
        if not handled:
            return
        self._handled_triggers[key] = None
        self._handled_triggers.move_to_end(key)
        while len(self._handled_triggers) > self._max_handled_triggers:
            self._handled_triggers.popitem(last=False)

    def _cache_gateway_result(self, run_id: str, result: dict[str, Any]) -> None:
        if (
            run_id not in self._pending_gateway_results
            and len(self._pending_gateway_results) >= self._max_pending_results
        ):
            raise RuntimeError("unacknowledged gateway result cache is full")
        self._pending_gateway_results[run_id] = result
        self._pending_gateway_results.move_to_end(run_id)

    def _reserve_gateway_result_slot(self, run_id: str) -> bool:
        if run_id in self._pending_gateway_results:
            return True
        if run_id in self._gateway_result_reservations:
            return False
        if (
            len(self._pending_gateway_results) + len(self._gateway_result_reservations)
            >= self._max_pending_results
        ):
            return False
        self._gateway_result_reservations.add(run_id)
        return True

    # ----- send (L4 §6.3 / §3.1 / §5.1) -----------------------------------

    async def send(
        self,
        channel: str,
        blocks: Any,
        reply_to: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        *,
        client_msg_id: Optional[str] = None,
        run_id: Optional[str] = None,
        msg_type: str = "text",
        props: Optional[Mapping[str, str]] = None,
    ) -> dict[str, Any]:
        """REST POST .../messages with an idempotent client_msg_id (L4 §3.1).

        `channel` is a momo channel UUID (the server's path id). `blocks` is the
        agent's rendered output; we flatten it to a body string for the v0 text
        message type (richer block types map onto message.props later).

        Idempotency: a stable client_msg_id means a retried send dedups on the
        server's (channel_id, author_member_id, client_msg_id) unique constraint,
        returning the prior seq (exactly-once effect, L4 §3.1).
        """
        cmid = client_msg_id or str(uuid.uuid4())
        body = self._blocks_to_body(blocks)
        path = (
            f"/v1/workspaces/{self.cfg.workspace_id}"
            f"/channels/{channel}/messages"
        )
        payload: dict[str, Any] = {
            "clientMsgId": cmid,
            "type": msg_type,
            "body": body,
        }
        merged_props: dict[str, str] = {}
        if props:
            merged_props.update({str(k): str(v) for k, v in dict(props).items()})
        if reply_to:
            merged_props["reply_to"] = reply_to
        if metadata:
            for k, v in metadata.items():
                if isinstance(v, (str, int, float, bool)) or v is None:
                    merged_props[f"hermes_{k}"] = "" if v is None else str(v)
        if merged_props:
            payload["props"] = merged_props
        if run_id:
            payload["runId"] = run_id
        result = await self._post(path, payload)
        return self._send_result(result, cmid)

    @staticmethod
    def _send_result(result: Mapping[str, Any], client_msg_id: str) -> Any:
        message_id = str(result.get("id") or result.get("messageId") or client_msg_id)
        try:
            return SendResult(success=True, message_id=message_id, raw_response=dict(result))
        except TypeError:  # pragma: no cover - SDK shape drift
            try:
                return SendResult(True, message_id, None, dict(result))
            except Exception:
                return dict(result)

    @staticmethod
    def _blocks_to_body(blocks: Any) -> str:
        """Flatten the gateway's block list / string into a body string (v0 text)."""
        if blocks is None:
            return ""
        if isinstance(blocks, str):
            return blocks
        if isinstance(blocks, Mapping):
            return str(blocks.get("text") or blocks.get("body") or "")
        if isinstance(blocks, Sequence):
            parts: list[str] = []
            for b in blocks:
                if isinstance(b, str):
                    parts.append(b)
                elif isinstance(b, Mapping):
                    parts.append(str(b.get("text") or b.get("body") or ""))
            return "\n".join(p for p in parts if p)
        return str(blocks)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        """Return Hermes' minimal chat metadata for a momo channel.

        Hermes v0.18 makes this an abstract platform contract. momo keeps the
        source of truth in Postgres, so use the authenticated channel list when
        available; during early gateway boot or degraded smoke, return a stable
        env/default fallback instead of failing platform construction.
        """
        is_home_channel = chat_id in {
            os.environ.get("MOMO_HOME_CHANNEL_ID", ""),
            os.environ.get("MOMO_DEFAULT_CHANNEL_ID", ""),
        }
        fallback_name = (
            os.environ.get("MOMO_HOME_CHANNEL_NAME")
            if chat_id
            and is_home_channel
            else None
        )
        fallback_name = fallback_name or os.environ.get("MOMO_HOME_CHANNEL_NAME") or "momo"
        fallback: dict[str, Any] = {
            "id": str(chat_id),
            "name": fallback_name if not chat_id or is_home_channel else str(chat_id),
            "type": "channel",
        }
        if not self.cfg.workspace_id or not self.cfg.agent_token:
            return fallback

        try:
            data = await self._get(f"/v1/workspaces/{self.cfg.workspace_id}/channels")
        except Exception as exc:  # noqa: BLE001 - chat info must not break gateway boot
            log.debug("momo get_chat_info fallback for %s: %s", chat_id, exc)
            return fallback

        channels = data.get("channels")
        if not isinstance(channels, Sequence) or isinstance(channels, (str, bytes, bytearray)):
            return fallback
        for channel in channels:
            if not isinstance(channel, Mapping):
                continue
            channel_id = channel.get("id") or channel.get("channelId") or channel.get("channel_id")
            if str(channel_id) != str(chat_id):
                continue
            kind = str(channel.get("kind") or "public")
            return {
                "id": str(channel_id),
                "name": str(channel.get("name") or channel_id),
                "type": "dm" if kind == "dm" else "channel",
                "topic": channel.get("topic"),
            }
        return fallback

    # ----- handle_message (L4 §6.3 / §6.2) --------------------------------

    async def handle_message(self, evt: Any) -> None:
        """A mention / dm signal → invoke the agent → stream the reply back.

        Inbound `evt` (from the listen loop):
          {channel, type: 'mention'|'dm.signal', seq, ts,
           payload: {channelId, messageId, body, authorMemberId, ...}}

        Flow (L4 §6.2):
          1. filter: only act on mention / dm.signal aimed at us; ignore our own
             output and the immediate-sender (loop safety, §3.4).
          2. invoke the agent via /invoke (creates an agent_run; the worker runs
             the hermes SSE turn and budget reserve/reconcile — §6.2 / §8.5).
          3. stream agent.partial/agent.status deltas and reflect the final text
             into the channel via send() (idempotent client_msg_id).
        """
        if not isinstance(evt, Mapping):
            base_handle = getattr(super(), "handle_message", None)
            if callable(base_handle):  # pragma: no cover - live Hermes SDK only
                result = base_handle(evt)
                if inspect.isawaitable(result):
                    await result
                return
            log.debug("skipping unknown Hermes event object: %r", type(evt))
            return

        etype = evt.get("type")
        if etype == "agent.job":
            await self._handle_agent_job(evt)
            return

        if etype not in ("mention", "dm.signal"):
            return  # not an actionable trigger (message.new echoes, etc.)

        payload = evt.get("payload") or {}
        author = payload.get("authorMemberId")
        if author and author == self._member_id:
            return  # ignore our own messages — self-loop guard (§3.4)

        channel_id = payload.get("channelId") or payload.get("channel_id")
        message_id = payload.get("messageId") or payload.get("message_id")
        prompt = payload.get("body") or payload.get("text") or ""
        if not channel_id:
            log.debug("mention without channelId; skipping: %s", payload)
            return

        # Idempotent trigger handling: one mention → one run.
        trigger_key = message_id or f"{channel_id}:{evt.get('seq')}"
        if not self._begin_trigger(trigger_key):
            return
        handled = False
        try:
            # The server-side idempotency key keeps a recovered mention mapped to
            # the same run even when this process retries after a transport error.
            idempotency_key = f"momo:mention:{trigger_key}"
            run_id = await self._invoke_agent(
                channel_id=channel_id, prompt=prompt, idempotency_key=idempotency_key
            )
            if not run_id:
                return

            text = await self._collect_run_output(run_id)
            if text:
                await self.send(
                    channel_id,
                    text,
                    client_msg_id=f"{run_id}:final",
                    run_id=run_id,
                )
            handled = True
        finally:
            self._finish_trigger(trigger_key, handled=handled)

    async def _handle_agent_job(self, evt: Mapping[str, Any]) -> None:
        """Execute a momo-created agent job and report the result back to momo.

        This is the MOMO-325 product path for Hermes-as-platform-gateway:
        momo creates agent_run/context/budget/audit + `agent.job`, Hermes owns
        provider OAuth/model execution, and the final user-visible message is
        committed by momo's `/gateway/complete` endpoint.
        """
        payload = evt.get("payload") or {}
        run_id = payload.get("run_id") or payload.get("runId")
        workspace_id = payload.get("workspace_id") or payload.get("workspaceId")
        channel_id = payload.get("channel_id") or payload.get("channelId")
        agent_member_id = payload.get("agent_member_id") or payload.get("agentMemberId")
        expected_work_channel = agent_channel(
            self.cfg.workspace_id, self.cfg.agent_member_id
        )
        if (
            not run_id
            or not workspace_id
            or not channel_id
            or not agent_member_id
            or _canonical_uuid_text(workspace_id)
            != _canonical_uuid_text(self.cfg.workspace_id)
            or _canonical_uuid_text(agent_member_id)
            != _canonical_uuid_text(self.cfg.agent_member_id)
            or str(evt.get("channel") or "") != expected_work_channel
        ):
            log.warning("agent.job actor/channel binding rejected; run=%s", run_id)
            return

        trigger_key = f"agent.job:{run_id}"
        if not self._begin_trigger(trigger_key):
            return
        handled = False
        try:
            result = self._pending_gateway_results.get(str(run_id))
            if result is None:
                if not self._reserve_gateway_result_slot(str(run_id)):
                    raise MomoGatewayBackpressure(
                        "gateway completion backlog is full"
                    )
                resume_status = self._resume_decision_status(payload)
                if resume_status is not None and resume_status != "approved":
                    await self._report_gateway_event(
                        workspace_id,
                        run_id,
                        "cancelled",
                        f"approval {resume_status}; provider execution stopped",
                    )
                    handled = True
                    return
                await self._report_gateway_event(
                    workspace_id,
                    run_id,
                    "running",
                    "approval approved; resuming job"
                    if resume_status == "approved"
                    else "job received",
                )
                try:
                    result = await self._run_gateway_job(payload)
                except Exception as exc:  # noqa: BLE001 - durable readable failure
                    log.error(
                        "gateway job failed: run=%s error=%s",
                        run_id,
                        self._redact_gateway_error(exc),
                    )
                    result = {
                        "status": "failed",
                        "error": "Hermes runtime failed before producing a final response.",
                        "usage": {
                            "model": payload.get("model") or "hermes-agent",
                            "prompt_tokens": 0,
                            "completion_tokens": 0,
                            "cached_tokens": 0,
                            "reasoning_tokens": 0,
                            "cost_micro_usd": 0,
                            "was_estimated": True,
                        },
                    }
                try:
                    self._cache_gateway_result(str(run_id), result)
                finally:
                    self._gateway_result_reservations.discard(str(run_id))

            approval_request = self._approval_request_from_result(result)
            if approval_request is not None:
                await self._report_gateway_approval_request(
                    workspace_id, run_id, approval_request
                )
                self._pending_gateway_results.pop(str(run_id), None)
                self._schedule_pending_recovery(
                    reason="gateway-approval-slot-released", delay_s=0.1
                )
                handled = True
                return

            await self._complete_gateway_job(workspace_id, run_id, result)
            self._pending_gateway_results.pop(str(run_id), None)
            self._schedule_pending_recovery(
                reason="gateway-result-slot-released", delay_s=0.1
            )
            handled = True
        finally:
            self._gateway_result_reservations.discard(str(run_id))
            self._finish_trigger(trigger_key, handled=handled)

    async def _report_gateway_event(
        self, workspace_id: str, run_id: str, status: str, detail: str
    ) -> None:
        path = f"/v1/workspaces/{workspace_id}/agent-runs/{run_id}/gateway/events"
        await self._post(path, {"status": status, "detail": detail})

    async def _report_gateway_approval_request(
        self,
        workspace_id: str,
        run_id: str,
        approval_request: Mapping[str, Any],
    ) -> None:
        path = f"/v1/workspaces/{workspace_id}/agent-runs/{run_id}/gateway/events"
        await self._post(
            path,
            {
                "status": "approval_request",
                "approval_request": dict(approval_request),
            },
        )

    async def _complete_gateway_job(
        self, workspace_id: str, run_id: str, result: Mapping[str, Any]
    ) -> None:
        path = f"/v1/workspaces/{workspace_id}/agent-runs/{run_id}/gateway/complete"
        await self._post(path, dict(result))

    async def _run_gateway_job(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Ask the injected Hermes runtime to execute a momo job.

        The live gateway SDK is intentionally treated as an adapter boundary.
        We support a few narrow method names to keep the momo plugin resilient
        without importing Hermes internals in repo-local tests.
        """
        if (
            payload.get("resume_from_approval_id")
            and self.runtime is not None
            and hasattr(self.runtime, "resume_momo_job")
        ):
            result = self.runtime.resume_momo_job(payload)
            if inspect.isawaitable(result):
                result = await result
            return self._normalize_gateway_result(result, payload)

        handler = getattr(self, "_message_handler", None)
        if callable(handler):
            event = self._payload_to_hermes_message_event(payload)
            if event is not None:
                result = handler(event)
                if inspect.isawaitable(result):
                    result = await result
                return self._normalize_gateway_result(result, payload)

        if self.runtime is None:
            raise RuntimeError("Hermes runtime handle is not configured")

        if hasattr(self.runtime, "run_momo_job"):
            result = self.runtime.run_momo_job(payload)
            if inspect.isawaitable(result):
                result = await result
            return self._normalize_gateway_result(result, payload)

        if hasattr(self.runtime, "run_agent_job"):
            result = self.runtime.run_agent_job(payload)
            if inspect.isawaitable(result):
                result = await result
            return self._normalize_gateway_result(result, payload)

        if hasattr(self.runtime, "chat"):
            messages = self._payload_messages(payload)
            result = self.runtime.chat(messages=messages, model=payload.get("model"))
            if inspect.isawaitable(result):
                result = await result
            return self._normalize_gateway_result(result, payload)

        raise RuntimeError("Hermes runtime does not expose a momo-compatible job method")

    @staticmethod
    def _payload_to_hermes_message_event(payload: Mapping[str, Any]) -> Any:
        if MessageEvent is None or SessionSource is None:
            return None
        workspace_id = str(payload.get("workspace_id") or payload.get("workspaceId") or "")
        channel_id = str(payload.get("channel_id") or payload.get("channelId") or "")
        author_member_id = str(
            payload.get("author_member_id") or payload.get("authorMemberId") or ""
        )
        trigger_message_id = str(
            payload.get("trigger_message_id") or payload.get("triggerMessageId") or ""
        )
        prompt = str(payload.get("prompt") or payload.get("body") or "")
        recent_context = MomoAdapter._recent_messages_context(payload)
        source_kwargs = {
            "platform": _platform_value(),
            "chat_id": channel_id,
            "chat_name": str(payload.get("channel_name") or channel_id),
            "chat_type": "channel",
            "user_id": author_member_id,
            "user_name": str(payload.get("author_display_name") or author_member_id),
            "message_id": trigger_message_id or None,
            "scope_id": workspace_id or None,
        }
        try:
            source = SessionSource(**source_kwargs)
        except TypeError:
            try:
                source = SessionSource(
                    platform=_platform_value(),
                    chat_id=channel_id,
                    user_id=author_member_id,
                    message_id=trigger_message_id or None,
                )
            except Exception:
                return None

        event_kwargs = {
            "text": prompt,
            "source": source,
            "raw_message": dict(payload),
            "message_id": trigger_message_id or None,
            "metadata": {
                "momo_run_id": payload.get("run_id") or payload.get("runId"),
                "momo_workspace_id": workspace_id,
                "momo_channel_id": channel_id,
            },
        }
        if MessageType is not None:
            event_kwargs["message_type"] = getattr(MessageType, "TEXT", None) or getattr(MessageType, "text", None) or "text"
        if recent_context:
            event_kwargs["channel_context"] = recent_context
        for kwargs in (
            event_kwargs,
            {k: v for k, v in event_kwargs.items() if k != "channel_context"},
            {"text": prompt, "source": source},
        ):
            try:
                return MessageEvent(**kwargs)
            except TypeError:
                continue
        return None

    @staticmethod
    def _recent_messages_context(payload: Mapping[str, Any]) -> str:
        recent = payload.get("recent_messages")
        if not isinstance(recent, Sequence) or isinstance(recent, (str, bytes, bytearray)):
            return ""
        rows: list[str] = []
        for item in recent:
            if not isinstance(item, Mapping):
                continue
            body = str(item.get("body") or "").strip()
            if not body:
                continue
            author = str(
                item.get("author_display_name")
                or item.get("author_handle")
                or item.get("author_kind")
                or "member"
            )
            rows.append(f"{author}: {body}")
        return "\n".join(rows[-20:])

    @staticmethod
    def _payload_messages(payload: Mapping[str, Any]) -> list[dict[str, str]]:
        recent = payload.get("recent_messages")
        messages: list[dict[str, str]] = []
        if isinstance(recent, Sequence) and not isinstance(recent, (str, bytes, bytearray)):
            for item in recent:
                if not isinstance(item, Mapping):
                    continue
                body = str(item.get("body") or "")
                if not body:
                    continue
                role = "assistant" if item.get("author_kind") == "agent" else "user"
                messages.append({"role": role, "content": body})
        if not messages:
            prompt = str(payload.get("prompt") or "")
            messages.append({"role": "user", "content": prompt})
        return messages

    def _normalize_gateway_result(self, result: Any, payload: Mapping[str, Any]) -> dict[str, Any]:
        if isinstance(result, Mapping):
            approval_request = self._normalize_approval_request(result)
            if approval_request is not None:
                return {
                    "status": "awaiting_approval",
                    "approval_request": approval_request,
                }
            status_hint = str(result.get("status") or "").strip().lower()
            if "approval_request" in result or status_hint in {
                "approval_required",
                "requires_approval",
                "awaiting_approval",
            }:
                raise MomoApprovalContractError(
                    "Hermes approval request is missing a bounded tool call id/name"
                )
            body = result.get("body") or result.get("text") or result.get("content")
            usage = result.get("usage")
            raw_error = result.get("error")
            status = result.get("status") or ("failed" if raw_error else "succeeded")
            error = self._redact_gateway_error(raw_error)
        else:
            body = str(result)
            usage = None
            status = "succeeded"
            error = None

        if usage is None:
            usage = {
                "model": payload.get("model") or "hermes-agent",
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cached_tokens": 0,
                "reasoning_tokens": 0,
                "cost_micro_usd": 0,
                "was_estimated": True,
            }
        return {
            "status": status,
            "body": body,
            "error": error,
            "usage": usage,
        }

    @staticmethod
    def _resume_decision_status(payload: Mapping[str, Any]) -> Optional[str]:
        if not payload.get("resume_from_approval_id"):
            return None
        decision = payload.get("approval_decision")
        if not isinstance(decision, Mapping):
            return "missing"
        status = str(decision.get("status") or "missing").strip().lower()
        return status or "missing"

    @staticmethod
    def _approval_request_from_result(
        result: Mapping[str, Any],
    ) -> Optional[dict[str, Any]]:
        value = result.get("approval_request")
        return dict(value) if isinstance(value, Mapping) else None

    @staticmethod
    def _normalize_approval_request(
        result: Mapping[str, Any],
    ) -> Optional[dict[str, Any]]:
        status = str(result.get("status") or "").strip().lower()
        raw = result.get("approval_request")
        if raw is None and status in {
            "approval_required",
            "requires_approval",
            "awaiting_approval",
        }:
            raw = {
                "action_type": result.get("action_type") or "tool_call",
                "title": result.get("title"),
                "summary": result.get("summary"),
                "tool_call": result.get("tool_call"),
                "estimated_micro_usd": result.get("estimated_micro_usd"),
                "is_reversible": result.get("is_reversible"),
            }
        if not isinstance(raw, Mapping):
            return None

        tool_call = raw.get("tool_call")
        if not isinstance(tool_call, Mapping):
            return None
        call_id = str(tool_call.get("call_id") or tool_call.get("id") or "").strip()
        name = str(tool_call.get("name") or "").strip()
        if not call_id or not name:
            return None

        normalized_tool_call: dict[str, Any] = {
            "call_id": call_id,
            "name": name,
            "arguments": tool_call.get("arguments", {}),
        }
        tool_grant = tool_call.get("tool_grant") or raw.get("policy_evidence")
        if isinstance(tool_grant, Mapping):
            normalized_tool_call["tool_grant"] = dict(tool_grant)

        normalized: dict[str, Any] = {
            "action_type": str(raw.get("action_type") or "tool_call"),
            "tool_call": normalized_tool_call,
        }
        for key in ("title", "summary", "estimated_micro_usd", "is_reversible"):
            if raw.get(key) is not None:
                normalized[key] = raw[key]
        return normalized

    def _redact_gateway_error(self, raw: Any) -> Any:
        if raw is None:
            return None
        return _redact_credential_text(raw, exact=self.cfg.agent_token)

    async def _invoke_agent(
        self, *, channel_id: str, prompt: str, idempotency_key: str
    ) -> Optional[str]:
        """POST .../channels/{ch}/agents/{agent}/invoke → RunID (L4 §5.1 / §6.1).

        (spec'd endpoint; server wiring lands with the agent-orchestration ticket —
        runtime-unverified. Returns the created agent_run id.)
        """
        if not self._member_id:
            log.warning("no agent member id; cannot invoke")
            return None
        path = (
            f"/v1/workspaces/{self.cfg.workspace_id}"
            f"/channels/{channel_id}/agents/{self._member_id}/invoke"
        )
        try:
            data = await self._post(
                path,
                {"prompt": prompt, "idempotencyKey": idempotency_key},
            )
        except MomoAPIError as exc:
            log.error("invoke failed: %s", self._redact_gateway_error(exc))
            return None
        return data.get("runId") or data.get("run_id")

    async def _collect_run_output(self, run_id: Optional[str]) -> str:
        """Assemble the agent's streamed text for the final 1급 message.

        Prefers the injected hermes runtime's run stream (the OpenAI-compat SSE
        path with non-stream fallback — L4 §6.2 / §6.3) when available. Without a
        runtime (static / no-gateway env), returns "" so send() is skipped.
        runtime-unverified.
        """
        if self.runtime is None or run_id is None:
            return ""
        chunks: list[str] = []
        try:
            stream = self.runtime.observe_run(run_id)  # async iterator of events
            async for event in self._aiter(stream):
                if event.get("type") in ("agent.partial", "text.delta", "textDelta"):
                    delta = event.get("delta") or event.get("text") or ""
                    if delta:
                        chunks.append(str(delta))
                elif event.get("type") in ("agent.status", "finished"):
                    status = event.get("status") or event.get("payload", {}).get("status")
                    if status in ("done", "error", "failed"):
                        break
        except Exception:  # pragma: no cover - runtime path, no gateway here
            log.exception("run stream collection failed for %s", run_id)
        return "".join(chunks)

    @staticmethod
    async def _aiter(obj: Any) -> AsyncIterator[Any]:
        """Adapt either an async-iterator or an awaitable-of-iterable to async for."""
        if hasattr(obj, "__aiter__"):
            async for item in obj:
                yield item
            return
        result = await obj if asyncio.iscoroutine(obj) else obj
        for item in result or []:
            yield item

    # ----- teardown --------------------------------------------------------

    async def close(self) -> None:
        """Cancel the listen loop and close WS + HTTP transports."""
        self._closing = True
        self._reconnect_requested = False
        current_task = asyncio.current_task()
        for name in (
            "_pending_recovery_task",
            "_reconnect_task",
            "_listen_task",
            "_work_task",
        ):
            task = getattr(self, name)
            if task is None:
                continue
            if task is current_task:
                setattr(self, name, None)
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:  # pragma: no cover - expected teardown
                pass
            except Exception:  # pragma: no cover - best-effort teardown
                log.debug("momo adapter task teardown failed: %s", name, exc_info=True)
            setattr(self, name, None)
        self._fail_queued_work(MomoConfigurationError("momo adapter closed"))
        await self._close_ws_only()
        if self._http is not None and not self._http.closed:
            await self._http.close()
            self._http = None

    async def disconnect(self) -> None:
        """Hermes SDK teardown hook."""
        await self.close()
        mark_disconnected = getattr(self, "_mark_disconnected", None)
        if callable(mark_disconnected):  # pragma: no cover - live Hermes SDK only
            mark_disconnected()


class MomoConfigurationError(RuntimeError):
    """Missing or unsafe local adapter configuration."""


class MomoGatewayBackpressure(RuntimeError):
    """Provider work is deferred until a durable completion slot is available."""


class MomoApprovalContractError(RuntimeError):
    """Hermes requested approval without a valid tool-call contract."""


class MomoAPIError(RuntimeError):
    """Non-2xx (or malformed) response from the momo REST API."""

    def __init__(self, status: int, path: str, detail: str) -> None:
        self.status = status
        self.path = path
        safe_detail = (
            "agent token rejected or expired; reissue it from pairing"
            if status == 401
            else _redact_credential_text(detail)[:300]
        )
        self.detail = safe_detail
        super().__init__(f"momo API {status} on {path}: {safe_detail}")


# ---------------------------------------------------------------------------
# Plugin registration entrypoint (L4 §6.3 — register_platform).
# The hermes gateway calls register_platform(registry) on plugin load; we hand it
# the MomoAdapter class keyed by platform name "momo".
# ---------------------------------------------------------------------------
REQUIRED_ENV = (
    "MOMO_API_URL",
    "MOMO_WORKSPACE_ID",
    "MOMO_AGENT_MEMBER_ID",
    "MOMO_AGENT_TOKEN",
)

OPTIONAL_ENV = (
    "MOMO_CENTRIFUGO_WS_URL",
    "MOMO_AGENT_HANDLE",
    "MOMO_AGENT_ALLOW_INSECURE_HTTP",
)


def check_requirements() -> bool:
    """Hermes plugin check hook.

    Keep the check focused on import/load. Dependency absence is surfaced during
    connect with a readable error so the plugin can still be listed by Hermes.
    """
    return True


def validate_config(config: Any) -> tuple[bool, str | None]:
    cfg = _momo_config_from(config)
    missing = []
    if not cfg.api_base_url:
        missing.append("MOMO_API_URL")
    if not cfg.workspace_id:
        missing.append("MOMO_WORKSPACE_ID")
    if not cfg.agent_member_id:
        missing.append("MOMO_AGENT_MEMBER_ID")
    if not cfg.agent_token:
        missing.append("MOMO_AGENT_TOKEN")
    if missing:
        return False, "Missing momo adapter env: " + ", ".join(missing)
    if not cfg.allow_insecure_http:
        if not _transport_is_safe(cfg.api_base_url, secure_scheme="https", local_scheme="http"):
            return False, (
                "MOMO_API_URL must use https outside loopback; set "
                "MOMO_AGENT_ALLOW_INSECURE_HTTP=1 only for a trusted private network"
            )
        if not _transport_is_safe(
            cfg.centrifugo_ws_url, secure_scheme="wss", local_scheme="ws"
        ):
            return False, (
                "MOMO_CENTRIFUGO_WS_URL must use wss outside loopback; set "
                "MOMO_AGENT_ALLOW_INSECURE_HTTP=1 only for a trusted private network"
            )
    return True, None


def _transport_is_safe(url: str, *, secure_scheme: str, local_scheme: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme == secure_scheme and bool(parsed.hostname):
        return True
    if parsed.scheme != local_scheme or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def env_enablement(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    if not all(str(env.get(key) or "").strip() for key in REQUIRED_ENV):
        return None
    return {
        "home_channel": {
            "chat_id": env.get("MOMO_HOME_CHANNEL_ID")
            or env.get("MOMO_DEFAULT_CHANNEL_ID")
            or env["MOMO_AGENT_MEMBER_ID"],
            "name": env.get("MOMO_HOME_CHANNEL_NAME", "momo"),
        },
        "MOMO_API_URL": env["MOMO_API_URL"],
        "MOMO_CENTRIFUGO_WS_URL": env.get("MOMO_CENTRIFUGO_WS_URL", ""),
        "MOMO_WORKSPACE_ID": env["MOMO_WORKSPACE_ID"],
        "MOMO_AGENT_MEMBER_ID": env["MOMO_AGENT_MEMBER_ID"],
        "MOMO_AGENT_HANDLE": env.get("MOMO_AGENT_HANDLE", "hermes"),
        "MOMO_AGENT_TOKEN": env["MOMO_AGENT_TOKEN"],
        "MOMO_AGENT_ALLOW_INSECURE_HTTP": env.get(
            "MOMO_AGENT_ALLOW_INSECURE_HTTP", "0"
        ),
    }


def adapter_factory(config: Any = None, **kwargs: Any) -> MomoAdapter:
    runtime = (
        kwargs.pop("hermes_runtime", None)
        or kwargs.pop("runtime", None)
        or kwargs.pop("gateway_runtime", None)
    )
    return MomoAdapter(config, hermes_runtime=runtime, **kwargs)


def register_platform(registry: Any = None) -> type[MomoAdapter]:
    """Register MomoAdapter with the hermes platform registry.

    The gateway passes its platform registry; we register the adapter under
    "momo". Returns the class so callers/tests can introspect it. Tolerant of a
    None registry (static import / no gateway) so this stays import-safe.
    """
    if registry is not None:
        # Support a couple of plausible registry method names across SDK versions.
        for method in ("register", "register_platform", "add"):
            fn = getattr(registry, method, None)
            if callable(fn):
                fn(MomoAdapter.platform_name, MomoAdapter)
                break
    log.info("registered momo platform adapter (%s)", MomoAdapter.platform_name)
    return MomoAdapter


def register(ctx: Any) -> type[MomoAdapter]:
    """Hermes plugin-SDK entrypoint (PLUGIN.yaml + adapter.py path).

    Current Hermes docs recommend plugin registration through a context object
    rather than editing the built-in gateway registry. Keep this thin and
    tolerant because the SDK object is owned by Hermes, not momo.
    """
    for method in ("register_platform", "register", "add"):
        fn = getattr(ctx, method, None)
        if callable(fn):
            official_kwargs = {
                "name": MomoAdapter.platform_name,
                "label": "Momo",
                "adapter_factory": adapter_factory,
                "check_fn": check_requirements,
                "validate_config": validate_config,
                "required_env": list(REQUIRED_ENV),
                "env_enablement_fn": env_enablement,
                "emoji": "💬",
                "platform_hint": "You are operating inside momo, an agent-native team messenger. Reply through momo only; never publish directly to Centrifugo.",
            }
            try:
                fn(**official_kwargs)
            except TypeError:
                official_kwargs.pop("env_enablement_fn", None)
                official_kwargs.pop("emoji", None)
                official_kwargs.pop("platform_hint", None)
                try:
                    fn(**official_kwargs)
                    break
                except TypeError:
                    pass
                try:
                    fn(
                        platform_name=MomoAdapter.platform_name,
                        adapter_cls=MomoAdapter,
                        config_cls=MomoConfig,
                        env_enablement_fn=env_enablement,
                    )
                except TypeError:
                    try:
                        fn(MomoAdapter.platform_name, MomoAdapter)
                    except TypeError:
                        fn(MomoAdapter)
            break
    return MomoAdapter


if not _BASE_IMPORTED:  # pragma: no cover
    log.debug(
        "BasePlatformAdapter not found in hermes SDK; using local shim "
        "(expected outside the gateway runtime)."
    )
