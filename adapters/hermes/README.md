# momo — hermes platform adapter (`MomoAdapter`)

A Hermes gateway plugin that makes an agent a **first-class member**
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

> A credentialed end-to-end run still requires a user-owned Hermes provider
> login. The adapter contract and momo bearer surfaces are covered locally by:
>
> ```sh
> python3 -m py_compile adapters/hermes/momo_adapter.py
> ```
>
> The repo-local contract tests verify the login-free bearer path and recovery
> behavior without reading or storing provider credentials.

## What it does (the three primitives, §6.3)

| Primitive | Behavior |
|---|---|
| `connect()` | Use `MOMO_AGENT_TOKEN` for realtime-token exchange, subscribe only to the agent's private `agentwork:` stream, then perform one durable pending-job recovery read. |
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
| `momo_adapter.py` | `MomoAdapter(BasePlatformAdapter)` + `register(ctx)` / `register_platform()`. |
| `plugin.yaml` | Hermes platform plugin manifest (`kind: platform`, entrypoint `adapter.py`). On default macOS case-insensitive filesystems this also resolves as `PLUGIN.yaml`. |
| `requirements.txt` | runtime deps (`aiohttp`, `websockets`). |
| `tests/smoke_momo_adapter.py` | dependency-free local smoke: Centrifugo fixture in, REST calls captured, no network. |
| `tests/test_momo_adapter_contract.py` | stdlib unittest for contract fixtures and smoke harness. |
| `README.md` | this file. |

## Install

The gateway loads this directory as a plugin via the manifest.
For a local Hermes install:

```sh
scripts/momo hermes-gateway-init
scripts/momo hermes-gateway-install-plugin
scripts/momo hermes-gateway-status
```

To install adapter deps into the gateway's environment:

```sh
pip install -r adapters/hermes/requirements.txt
```

`BasePlatformAdapter` and `register_platform` are provided by the hermes plugin
SDK at load time (not a PyPI package), so they are not pinned in
`requirements.txt`. Without the SDK present (e.g. running `py_compile` standalone),
the module imports an internal shim so static checks still pass.

## Connect / configure

The adapter is env-driven (see `PLUGIN.yaml` `requires_env`/`optional_env`):

| Env var | Meaning |
|---|---|
| `MOMO_API_URL` | momo REST API base, e.g. `http://api:8080`. |
| `MOMO_CENTRIFUGO_WS_URL` | Centrifugo WS endpoint, e.g. `ws://centrifugo:8000/connection/websocket`. |
| `MOMO_WORKSPACE_ID` | target workspace UUID (tenant). |
| `MOMO_AGENT_MEMBER_ID` | the agent's `member.id` (`kind='agent'`). |
| `MOMO_AGENT_HANDLE` | agent display handle for logs/UI hints (default `hermes`). |
| `MOMO_AGENT_TOKEN` | scoped per-agent momo bearer used for realtime, pending recovery, callbacks, and message writes. It is not a provider token. |
| `MOMO_AGENT_ALLOW_INSECURE_HTTP` | optional explicit opt-in for trusted non-loopback private networks. Without it, non-loopback API/WS endpoints require `https`/`wss`. |

Connection sequence (§6.3 / §7.1 / §4.3):

1. Send `MOMO_AGENT_TOKEN` to `POST /v1/auth/realtime-token`.
2. WS connect to Centrifugo with the returned short-lived JWT.
3. Subscribe only to `agentwork:ws<workspaceUUID>.<agentMemberUUID>`.
4. Fetch pending jobs once after connect, reconnect, or a detected publication
   offset gap; there is no idle polling loop.
5. Use the same bearer for pending jobs, gateway events/completion, and messages.

On a 401, the adapter performs three bounded exponential-backoff attempts and
then asks the operator to reissue the credential from pairing. It never logs the
token or attempts to mint a replacement credential. A permanently rejected
credential stops reconnect attempts until the Hermes process is restarted with
the rotated token.

Programmatic use (inside the gateway runtime):

```python
from momo_adapter import MomoAdapter, MomoConfig

adapter = MomoAdapter(MomoConfig(), hermes_runtime=gateway_runtime)
await adapter.connect()        # auth + subscribe
# gateway pumps realtime events → adapter.handle_message(evt)
# ... on shutdown:
await adapter.close()
```

Current Hermes SDK compatibility:

- official import path: `gateway.platforms.base.BasePlatformAdapter`
- official registration path: `register(ctx)` with `adapter_factory`
- legacy fallback: `register_platform(registry)` and import-safe local shim for
  repo-local static gates

## Channel naming (§4.1)

```
agentwork : agentwork:ws<workspaceUUID>.<agentMemberUUID> # private work stream
agent     : agent:ws<workspaceUUID>.<channelUUID>.<agentMemberUUID> # channel-scoped progress
ch        : ch:ws<workspaceUUID>.<channelUUID>            # timeline transport
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

Real Hermes readiness / smoke:

```sh
scripts/momo hermes-gateway-smoke --real
MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger
```

Real provider completion remains user-credentialed: provider OAuth stays inside
Hermes and is never copied into momo or this adapter configuration.

## Server-contract status

MOMO-337 wires and runtime-tests the scoped agent bearer across realtime-token,
pending jobs, gateway event/completion callbacks, and agent-authored messages.
Legacy shared-secret support is migration-only and is not consumed by this
adapter.
