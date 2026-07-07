"""momo platform adapter for the 김인턴 (hermes) agent gateway plugin.

L4 spec §6.3 — registers a momo workspace as a first-class platform for a hermes
agent so the agent *lives* in momo as a `member` (kind='agent'), not a webhook bot.

What this adapter does (the three BasePlatformAdapter primitives, §6.3):

  connect()         momo REST auth (POST /v1/auth/login, Bearer) →
                    realtime-token exchange (POST /v1/auth/realtime-token) →
                    subscribe the agent's `agent:` Centrifugo channel (work stream)
                    plus the `user:` channel (mention / dm signals) over WebSocket.

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
runtime-unverified (hermes 게이트웨이 필요):
  This module is the momo-side plugin adapter that the 김인턴/hermes gateway loads
  (it imports `BasePlatformAdapter` from the hermes plugin SDK). Without a running
  hermes gateway *and* a running momo stack (Hummingbird API + Centrifugo + PG18),
  it cannot be exercised end-to-end. In THIS build env there is no hermes gateway
  and no docker/psql, so only static checks apply:
      python3 -m py_compile adapters/hermes/momo_adapter.py
  The HTTP/WS shapes below match L4 §5.1 / §5.2 / §4.1 but are not validated
  against a live gateway. Network calls degrade gracefully if `aiohttp` /
  `websockets` are absent (see the optional-import shims) so py_compile and import
  succeed without the runtime deps installed.

  Server-contract note: as of build ticket T05 the momo API implements
  /v1/auth/login and the messages endpoints; /v1/auth/realtime-token and the
  agent /invoke endpoint are specified (§5.1) but not yet wired server-side. This
  adapter targets the spec contract; those calls are marked below and will work
  once the server ships them.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Mapping, Optional, Sequence

log = logging.getLogger("momo.adapter")

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
    # Service-account credentials the agent authenticates with (a human-owned
    # bot identity in v0; delegation tokens layer on later per L4 §7.3).
    login_email: str = field(
        default_factory=lambda: os.environ.get("MOMO_AGENT_EMAIL", "")
    )
    login_password: str = field(
        default_factory=lambda: os.environ.get("MOMO_AGENT_PASSWORD", "")
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
    # Shared secret for momo-owned gateway callbacks. This is NOT an OpenAI/Codex
    # credential; it only authorizes Hermes to report status/results for momo-
    # created agent_run rows.
    gateway_secret: str = field(
        default_factory=lambda: os.environ.get("MOMO_AGENT_GATEWAY_SECRET", "")
    )
    request_timeout_s: float = 120.0


# ---------------------------------------------------------------------------
# Centrifugo channel naming (L4 §4.1).
#   ch    : ch:ws<workspaceUUID>.<channelUUID>       # group channel
#   agent : agent:ws<workspaceUUID>.<agentMemberUUID> # agent work stream
#   user  : user:ws<workspaceUUID>.<memberUUID>       # personal notifications
# Channel ids handed to send() remain opaque; REST is the only write path.
# ---------------------------------------------------------------------------
def agent_channel(workspace_id: str, agent_member_id: str) -> str:
    return f"agent:ws{workspace_id}.{agent_member_id}"


def user_channel(workspace_id: str, member_id: str) -> str:
    return f"user:ws{workspace_id}.{member_id}"


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
    cfg.login_email = (
        _extra_value(extra, "MOMO_AGENT_EMAIL", "momo_agent_email", "login_email")
        or cfg.login_email
    )
    cfg.login_password = (
        _extra_value(
            extra, "MOMO_AGENT_PASSWORD", "momo_agent_password", "login_password"
        )
        or cfg.login_password
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
    cfg.gateway_secret = (
        _extra_value(
            extra,
            "MOMO_AGENT_GATEWAY_SECRET",
            "momo_agent_gateway_secret",
            "gateway_secret",
        )
        or cfg.gateway_secret
    )
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
        "MOMO_AGENT_GATEWAY_SECRET": cfg.gateway_secret,
        "MOMO_AGENT_EMAIL": cfg.login_email,
        "MOMO_AGENT_PASSWORD": cfg.login_password,
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

        self._access_token: Optional[str] = None
        self._refresh_token: Optional[str] = None
        self._realtime_token: Optional[str] = None
        self._operator_member_id: Optional[str] = None
        self._member_id: Optional[str] = self.cfg.agent_member_id or None

        self._http: Any = None           # aiohttp.ClientSession
        self._ws: Any = None             # websockets connection
        self._listen_task: Optional[asyncio.Task[None]] = None
        # idempotency cache: dedup re-deliveries of the same trigger message so an
        # agent never double-replies to one mention (belt-and-suspenders on top of
        # the server-side (channel,author,client_msg_id) unique — L4 §3.1).
        self._handled_triggers: set[str] = set()

    # ----- HTTP helpers ----------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._access_token:
            h["Authorization"] = f"Bearer {self._access_token}"
        return h

    def _gateway_headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.cfg.gateway_secret:
            h["X-Momo-Agent-Gateway-Secret"] = self.cfg.gateway_secret
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

    async def _post(self, path: str, body: Mapping[str, Any]) -> dict[str, Any]:
        session = await self._ensure_session()
        url = f"{self.cfg.api_base_url}{path}"
        async with session.post(url, json=body, headers=self._auth_headers()) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise MomoAPIError(resp.status, path, text)
            return json.loads(text) if text else {}

    async def _post_gateway(self, path: str, body: Mapping[str, Any]) -> dict[str, Any]:
        session = await self._ensure_session()
        url = f"{self.cfg.api_base_url}{path}"
        async with session.post(url, json=body, headers=self._gateway_headers()) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise MomoAPIError(resp.status, path, text)
            return json.loads(text) if text else {}

    # ----- connect (L4 §6.3) ----------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        """REST auth → realtime-token → subscribe agent: and user: channels.

        Steps (L4 §6.3 / §7.1 / §4.3):
          1. POST /v1/auth/login                 → access(15m)/refresh(30d) + member
          2. POST /v1/auth/realtime-token        → Centrifugo connection JWT (30m)
          3. WS connect to Centrifugo with that JWT
          4. subscribe agent:ws<workspaceUUID>.<agentMemberUUID>  (work stream)
             subscribe user:ws<workspaceUUID>.<memberUUID>        (mention/dm signals)
          5. spawn the listen loop that feeds handle_message()
        """
        await self._login()
        await self._fetch_realtime_token()
        await self._open_realtime()
        mark_connected = getattr(self, "_mark_connected", None)
        if callable(mark_connected):  # pragma: no cover - live Hermes SDK only
            mark_connected()
        log.info(
            "momo adapter connected: ws=%s agent=%s operator=%s handle=%s reconnect=%s",
            self.cfg.workspace_id,
            self.cfg.agent_member_id or self._member_id,
            self._operator_member_id,
            self.cfg.agent_handle,
            is_reconnect,
        )
        return True

    async def _login(self) -> None:
        # L4 §5.1 POST /v1/auth/login. Matches server LoginRequest/LoginResponse.
        data = await self._post(
            "/v1/auth/login",
            {
                "email": self.cfg.login_email,
                "password": self.cfg.login_password,
                # optional explicit workspace; server resolves a default if omitted.
                "workspace": self.cfg.workspace_id or None,
            },
        )
        self._access_token = data.get("accessToken")
        self._refresh_token = data.get("refreshToken")
        member = data.get("member") or {}
        # The login principal is an operator/subscriber. Keep it separate from
        # the agent member identity so we subscribe to the agent work stream,
        # not accidentally to the operator's personal stream.
        self._operator_member_id = member.get("id") or self._operator_member_id
        self.cfg.workspace_id = member.get("workspaceId") or self.cfg.workspace_id
        if not self.cfg.agent_member_id and self._operator_member_id:
            self.cfg.agent_member_id = self._operator_member_id
            self._member_id = self.cfg.agent_member_id
        if not self._access_token:
            raise MomoAPIError(0, "/v1/auth/login", "no accessToken in response")

    async def _fetch_realtime_token(self) -> None:
        # L4 §5.1 POST /v1/auth/realtime-token → Centrifugo connection JWT.
        # (spec'd; server-side wiring lands with a later ticket — runtime-unverified.)
        data = await self._post("/v1/auth/realtime-token", {})
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
        # Centrifugo client protocol: connect command carries the JWT, then one
        # subscribe command per channel. Subscribe to the agent work stream + the
        # personal notification channel (mentions / dm signals, L4 §5.2).
        await self._ws_send({"connect": {"token": self._realtime_token}, "id": 1})
        agent_member_id = self.cfg.agent_member_id or self._member_id
        operator_member_id = self._operator_member_id or agent_member_id
        if not self.cfg.workspace_id or not agent_member_id:
            raise MomoAPIError(
                0, "/v1/auth/realtime-token", "missing workspace_id or agent_member_id"
            )
        chans = [agent_channel(self.cfg.workspace_id, agent_member_id)]
        if operator_member_id:
            chans.append(user_channel(self.cfg.workspace_id, operator_member_id))
        chans = list(dict.fromkeys(chans))
        for i, ch in enumerate(chans, start=2):
            await self._ws_send({"subscribe": {"channel": ch}, "id": i})
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
                    push = frame.get("push")
                    if not push:
                        continue  # connect/subscribe acks, pings — ignore
                    pub = push.get("pub") or {}
                    envelope = pub.get("data") or {}
                    evt = {
                        "channel": push.get("channel"),
                        "type": envelope.get("type"),
                        "seq": envelope.get("seq"),
                        "ts": envelope.get("ts"),
                        "payload": envelope.get("payload") or {},
                    }
                    try:
                        await self.handle_message(evt)
                    except Exception:  # one bad event must not kill the loop
                        log.exception("handle_message failed for %s", evt.get("type"))
        except asyncio.CancelledError:  # pragma: no cover
            raise
        except Exception:  # pragma: no cover - transport drop → caller reconnects
            log.exception("momo realtime listen loop ended")

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
        if trigger_key in self._handled_triggers:
            return
        self._handled_triggers.add(trigger_key)

        # The agent_run idempotency_key (L4 §6.1 invoke contract / agent_run
        # UNIQUE(workspace_id, idempotency_key)) is derived from the trigger so a
        # redelivered mention maps to the same run, not a new one.
        idempotency_key = f"momo:mention:{trigger_key}"

        run_id = await self._invoke_agent(
            channel_id=channel_id, prompt=prompt, idempotency_key=idempotency_key
        )

        # Stream the reply. The agent: channel carries agent.partial deltas; for a
        # 1급 message we reflect the assembled text into the source channel via the
        # REST write path (never publishing to Centrifugo directly — §1.2).
        text = await self._collect_run_output(run_id)
        if text:
            # Deterministic client_msg_id from the run → idempotent final post.
            await self.send(
                channel_id,
                text,
                client_msg_id=f"{run_id}:final" if run_id else None,
                run_id=run_id,
            )

    async def _handle_agent_job(self, evt: Mapping[str, Any]) -> None:
        """Execute a momo-created agent job and report the result back to momo.

        This is the MOMO-325 product path for Hermes-as-platform-gateway:
        momo creates agent_run/context/budget/audit + `agent.job`, Hermes owns
        provider OAuth/model execution, and the final user-visible message is
        committed by momo's `/gateway/complete` endpoint.
        """
        payload = evt.get("payload") or {}
        run_id = payload.get("run_id") or payload.get("runId")
        workspace_id = payload.get("workspace_id") or payload.get("workspaceId") or self.cfg.workspace_id
        channel_id = payload.get("channel_id") or payload.get("channelId")
        agent_member_id = payload.get("agent_member_id") or payload.get("agentMemberId")
        if not run_id or not workspace_id or not channel_id:
            log.warning("agent.job missing run/workspace/channel; skipping: %s", payload)
            return

        trigger_key = f"agent.job:{run_id}"
        if trigger_key in self._handled_triggers:
            return
        self._handled_triggers.add(trigger_key)

        if agent_member_id and agent_member_id != self.cfg.agent_member_id:
            log.debug("agent.job for another agent; skipping run=%s", run_id)
            return

        await self._report_gateway_event(workspace_id, run_id, "running", "job received")
        try:
            result = await self._run_gateway_job(payload)
        except Exception as exc:  # noqa: BLE001 - report a readable timeline error
            log.exception("gateway job failed: run=%s", run_id)
            await self._complete_gateway_job(
                workspace_id,
                run_id,
                {
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
                },
            )
            return

        await self._complete_gateway_job(workspace_id, run_id, result)

    async def _report_gateway_event(
        self, workspace_id: str, run_id: str, status: str, detail: str
    ) -> None:
        path = f"/v1/workspaces/{workspace_id}/agent-runs/{run_id}/gateway/events"
        await self._post_gateway(path, {"status": status, "detail": detail})

    async def _complete_gateway_job(
        self, workspace_id: str, run_id: str, result: Mapping[str, Any]
    ) -> None:
        path = f"/v1/workspaces/{workspace_id}/agent-runs/{run_id}/gateway/complete"
        await self._post_gateway(path, dict(result))

    async def _run_gateway_job(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Ask the injected Hermes runtime to execute a momo job.

        The live gateway SDK is intentionally treated as an adapter boundary.
        We support a few narrow method names to keep the momo plugin resilient
        without importing Hermes internals in repo-local tests.
        """
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

    @staticmethod
    def _normalize_gateway_result(result: Any, payload: Mapping[str, Any]) -> dict[str, Any]:
        if isinstance(result, Mapping):
            body = result.get("body") or result.get("text") or result.get("content")
            usage = result.get("usage")
            status = result.get("status") or "succeeded"
            error = result.get("error")
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
            log.error("invoke failed: %s", exc)
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
        if self._listen_task is not None:
            self._listen_task.cancel()
            try:
                await self._listen_task
            except (asyncio.CancelledError, Exception):  # pragma: no cover
                pass
            self._listen_task = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # pragma: no cover
                pass
            self._ws = None
        if self._http is not None and not self._http.closed:
            await self._http.close()
            self._http = None

    async def disconnect(self) -> None:
        """Hermes SDK teardown hook."""
        await self.close()
        mark_disconnected = getattr(self, "_mark_disconnected", None)
        if callable(mark_disconnected):  # pragma: no cover - live Hermes SDK only
            mark_disconnected()


class MomoAPIError(RuntimeError):
    """Non-2xx (or malformed) response from the momo REST API."""

    def __init__(self, status: int, path: str, detail: str) -> None:
        self.status = status
        self.path = path
        self.detail = detail
        super().__init__(f"momo API {status} on {path}: {detail[:300]}")


# ---------------------------------------------------------------------------
# Plugin registration entrypoint (L4 §6.3 — register_platform).
# The hermes gateway calls register_platform(registry) on plugin load; we hand it
# the MomoAdapter class keyed by platform name "momo".
# ---------------------------------------------------------------------------
REQUIRED_ENV = (
    "MOMO_API_URL",
    "MOMO_WORKSPACE_ID",
    "MOMO_AGENT_MEMBER_ID",
    "MOMO_AGENT_GATEWAY_SECRET",
)

OPTIONAL_ENV = (
    "MOMO_CENTRIFUGO_WS_URL",
    "MOMO_AGENT_EMAIL",
    "MOMO_AGENT_PASSWORD",
    "MOMO_AGENT_HANDLE",
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
    if not cfg.gateway_secret:
        missing.append("MOMO_AGENT_GATEWAY_SECRET")
    if missing:
        return False, "Missing momo adapter env: " + ", ".join(missing)
    return True, None


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
        "MOMO_AGENT_GATEWAY_SECRET": env["MOMO_AGENT_GATEWAY_SECRET"],
        "MOMO_AGENT_EMAIL": env.get("MOMO_AGENT_EMAIL", ""),
        "MOMO_AGENT_PASSWORD": env.get("MOMO_AGENT_PASSWORD", ""),
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
                "optional_env": list(OPTIONAL_ENV),
                "env_enablement_fn": env_enablement,
                "description": "momo native messaging platform adapter",
            }
            try:
                fn(**official_kwargs)
            except TypeError:
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
