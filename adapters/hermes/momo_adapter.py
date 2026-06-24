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
# The 김인턴/hermes plugin SDK supplies BasePlatformAdapter + register_platform.
# We try a few likely module paths; if none resolve (e.g. running py_compile
# outside the gateway), we fall back to a minimal local Protocol-shaped base so
# this file imports and statically checks standalone. The real gateway always
# overrides this with its own class (the MRO uses whichever is imported first).
# ---------------------------------------------------------------------------
_BASE_IMPORTED = False
try:  # pragma: no cover - depends on gateway runtime
    from hermes.platform import BasePlatformAdapter  # type: ignore

    _BASE_IMPORTED = True
except Exception:  # pragma: no cover
    try:
        from hermes.plugins import BasePlatformAdapter  # type: ignore

        _BASE_IMPORTED = True
    except Exception:
        class BasePlatformAdapter:  # type: ignore[no-redef]
            """Fallback shim mirroring the hermes BasePlatformAdapter surface.

            Only present so this module imports / py_compiles without the gateway
            SDK. The live gateway provides the real base class. The three async
            primitives below (connect/send/handle_message) are the contract a
            platform adapter must implement (L4 §6.3).
            """

            #: platform identifier the gateway keys the registry on.
            platform_name: str = "momo"

            def __init__(self, *args: Any, **kwargs: Any) -> None:
                ...

            async def connect(self) -> None:  # noqa: D401 - contract stub
                raise NotImplementedError

            async def send(self, channel: str, blocks: Any) -> Any:
                raise NotImplementedError

            async def handle_message(self, evt: Mapping[str, Any]) -> None:
                raise NotImplementedError


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
        default_factory=lambda: os.environ.get("MOMO_AGENT_HANDLE", "kim-intern")
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
        config: Optional[MomoConfig] = None,
        *,
        hermes_runtime: Any = None,
        **kwargs: Any,
    ) -> None:
        # The gateway may pass its own kwargs; forward what the base accepts.
        try:
            super().__init__(**kwargs)
        except TypeError:
            super().__init__()
        self.cfg = config or MomoConfig()
        # `hermes_runtime` is the gateway handle used to invoke the model and to
        # observe the agent's run stream (the OpenAI-compat /v1/chat/completions
        # SSE path lives behind this — L4 §6.2). Injected by the gateway.
        self.runtime = hermes_runtime

        self._access_token: Optional[str] = None
        self._refresh_token: Optional[str] = None
        self._realtime_token: Optional[str] = None
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

    # ----- connect (L4 §6.3) ----------------------------------------------

    async def connect(self) -> None:
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
        log.info(
            "momo adapter connected: ws=%s agent=%s handle=%s",
            self.cfg.workspace_id, self._member_id, self.cfg.agent_handle,
        )

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
        # Prefer the server-resolved member/workspace ids over env defaults.
        self._member_id = member.get("id") or self._member_id
        self.cfg.workspace_id = member.get("workspaceId") or self.cfg.workspace_id
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
        member_id = self._member_id or self.cfg.agent_member_id
        if not self.cfg.workspace_id or not member_id:
            raise MomoAPIError(
                0, "/v1/auth/realtime-token", "missing workspace_id or member_id"
            )
        chans = [
            agent_channel(self.cfg.workspace_id, member_id),
            user_channel(self.cfg.workspace_id, member_id),
        ]
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
        if props:
            payload["props"] = dict(props)
        if run_id:
            payload["runId"] = run_id
        return await self._post(path, payload)

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

    async def handle_message(self, evt: Mapping[str, Any]) -> None:
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
        etype = evt.get("type")
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


if not _BASE_IMPORTED:  # pragma: no cover
    log.debug(
        "BasePlatformAdapter not found in hermes SDK; using local shim "
        "(expected outside the gateway runtime)."
    )
