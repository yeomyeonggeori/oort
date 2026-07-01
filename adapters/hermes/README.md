# momo — hermes platform adapter (`MomoAdapter`)

A 김인턴 (hermes) gateway plugin that makes a hermes agent a **first-class member**
of a momo workspace (`member.kind = 'agent'`) instead of a webhook bot. This is the
`BasePlatformAdapter` implementation from the L4 spec **§6.3**.

## Integration modes and product default

momo has two Hermes integration modes:

| Mode | Role | Default? |
|---|---|---:|
| **AgentWorker -> OpenAI-compatible SSE** | momo builds the Context Packet projection, reserves budget, calls Hermes/Kim Intern through `/v1/chat/completions` SSE, then records message/run/cost/audit in Postgres. | **Yes** |
| **Hermes platform adapter** | Hermes gateway loads this plugin so a Hermes agent can treat momo as a messaging platform through `connect`, `send`, and `handle_message`. | Optional ingress/interop |

The product default is the AgentWorker SSE path because momo must own Context
Packet, approval pause/resume, cost reserve/reconcile, and audit ledger decisions.
This platform adapter remains useful for dogfood and gateway interop, but it does
not replace the momo-owned execution path. The normative decision and fixtures are
in [`research/11-agent-runtime/11-hermes-adapter-contract-v0.md`](../../research/11-agent-runtime/11-hermes-adapter-contract-v0.md).

> **runtime-unverified (hermes 게이트웨이 필요).** This adapter only runs inside a
> live 김인턴/hermes gateway connected to a running momo stack (Hummingbird API +
> Centrifugo v6 + PostgreSQL 18). This build env has **no hermes gateway and no
> docker/psql**, so it is validated by static check only:
>
> ```sh
> python3 -m py_compile adapters/hermes/momo_adapter.py
> ```
>
> HTTP/WS shapes match L4 §5.1 / §5.2 / §4.1. The repo-local smoke below
> verifies fixture → adapter event → captured REST invoke/final-message mapping
> without a live gateway, but live plugin load/e2e remains runtime-unverified.

## What it does (the three primitives, §6.3)

| Primitive | Behavior |
|---|---|
| `connect()` | momo REST auth (`POST /v1/auth/login`, Bearer) → realtime-token exchange (`POST /v1/auth/realtime-token`) → subscribe the agent's `agent:` Centrifugo channel (work stream) + `user:` channel (mention / dm signals) over WebSocket. |
| `send(channel, blocks)` | REST `POST .../messages` with a `client_msg_id` for **idempotency** (§3.1 — server dedups on `(channel_id, author_member_id, client_msg_id)` in the single `channel_seq`-bump + message + outbox tx). |
| `handle_message(evt)` | A `mention` / `dm.signal` arrives on the realtime stream → `invoke` the agent → stream `agent.partial` / `agent.status` deltas and reflect the final 1급 message into the channel via `send()`. |

### Write-path invariant (§1.2 / §8.1)

The adapter **never** publishes to Centrifugo directly. It only *reads* the
realtime stream and *writes* via REST. Every state change is
`REST → PG commit → outbox → relay publishes`.

### Loop safety (§3.4)

`handle_message` ignores the agent's own messages, dedups one mention → one run
(trigger key + `agent_run` idempotency key), and only acts on `mention` /
`dm.signal` event types — so `message.new` echoes never re-trigger it.

## Files

| File | Purpose |
|---|---|
| `momo_adapter.py` | `MomoAdapter(BasePlatformAdapter)` + `register_platform()`. |
| `plugin.yaml` | gateway plugin manifest (`register_platform` hook, platform = `momo`). |
| `requirements.txt` | runtime deps (`aiohttp`, `websockets`). |
| `tests/smoke_momo_adapter.py` | dependency-free local smoke: Centrifugo fixture in, REST calls captured, no network. |
| `tests/test_momo_adapter_contract.py` | stdlib unittest for contract fixtures and smoke harness. |
| `README.md` | this file. |

## Install

The gateway loads this directory as a plugin via `plugin.yaml`. To install deps
into the gateway's environment:

```sh
pip install -r adapters/hermes/requirements.txt
```

`BasePlatformAdapter` and `register_platform` are provided by the hermes plugin
SDK at load time (not a PyPI package), so they are not pinned in
`requirements.txt`. Without the SDK present (e.g. running `py_compile` standalone),
the module imports an internal shim so static checks still pass.

## Connect / configure

The adapter is env-driven (see `plugin.yaml` `spec.env`, mirrors
`infra/.env.example`):

| Env var | Meaning |
|---|---|
| `MOMO_API_URL` | momo REST API base, e.g. `http://api:8080`. |
| `MOMO_CENTRIFUGO_WS_URL` | Centrifugo WS endpoint, e.g. `ws://centrifugo:8000/connection/websocket`. |
| `MOMO_AGENT_EMAIL` / `MOMO_AGENT_PASSWORD` | service-account credentials the agent authenticates with. |
| `MOMO_WORKSPACE_ID` | target workspace UUID (tenant). |
| `MOMO_AGENT_MEMBER_ID` | the agent's `member.id` (`kind='agent'`). |
| `MOMO_AGENT_HANDLE` | agent display handle for logs/UI hints (default `kim-intern`). |

Connection sequence (§6.3 / §7.1 / §4.3):

1. `POST /v1/auth/login` → access(15m) / refresh(30d) JWT + member.
2. `POST /v1/auth/realtime-token` → Centrifugo connection JWT (sub = memberId, 30m).
3. WS connect to Centrifugo with that JWT.
4. subscribe `agent:ws<workspaceUUID>.<agentMemberUUID>` + `user:ws<workspaceUUID>.<memberUUID>`.
5. listen loop feeds inbound pushes to `handle_message()`.

Programmatic use (inside the gateway runtime):

```python
from momo_adapter import MomoAdapter, MomoConfig

adapter = MomoAdapter(MomoConfig(), hermes_runtime=gateway_runtime)
await adapter.connect()        # auth + subscribe
# gateway pumps realtime events → adapter.handle_message(evt)
# ... on shutdown:
await adapter.close()
```

## Channel naming (§4.1)

```
agent : agent:ws<workspaceUUID>.<agentMemberUUID> # the agent's work stream
user  : user:ws<workspaceUUID>.<memberUUID>       # personal notifications
ch    : ch:ws<workspaceUUID>.<channelUUID>        # group channel
```

The adapter treats channel ids handed to `send()` as opaque and still writes only
through momo REST; it never publishes directly to Centrifugo.

## Local smoke

Run the adapter smoke without Hermes, Docker, aiohttp, websockets, or network:

```sh
python3 adapters/hermes/tests/smoke_momo_adapter.py
```

The harness loads `platform_adapter_event_mapping.json`, unwraps the Centrifugo
push to the adapter event, calls `MomoAdapter.handle_message()`, and captures the
REST calls that would be made:

1. `POST .../agents/{agent}/invoke`
2. `POST .../messages` for the final agent message

`scripts/local_gate.sh --profile docs` runs this smoke in addition to
`python3 -m py_compile adapters/hermes/momo_adapter.py` and the contract unittest.
Live Hermes gateway plugin loading and live momo/Centrifugo/Postgres e2e are still
`runtime-unverified` until a Hermes test instance is available.

## Server-contract status

As of build ticket **T05**, the momo API implements `/v1/auth/login` and the
messages endpoints. `/v1/auth/realtime-token` and the agent `/invoke` endpoint are
specified (§5.1) but not yet wired server-side. This adapter targets the spec
contract; those calls work once the server ships them.
