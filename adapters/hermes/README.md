# oort — hermes platform adapter (`MomoAdapter`)

A Hermes gateway plugin that makes an agent a **first-class member**
of a oort workspace (`member.kind = 'agent'`) instead of a webhook bot. This is the
`BasePlatformAdapter` implementation from the L4 spec **§6.3**.

## Integration modes and product default

oort has two Hermes integration modes:

| Mode | Role | Default? |
|---|---|---:|
| **AgentWorker -> OpenAI-compatible SSE** | oort builds the Context Packet projection, reserves budget, calls Hermes/Kim Intern through `/v1/chat/completions` SSE, then records message/run/cost/audit in Postgres. | **Yes** |
| **Hermes platform adapter** | Hermes gateway loads this plugin so a Hermes agent can treat oort as a messaging platform through `connect`, `send`, and `handle_message`. | Optional ingress/interop |

The product default is the AgentWorker SSE path because oort must own Context
Packet, approval pause/resume, cost reserve/reconcile, and audit ledger decisions.
This platform adapter remains useful for dogfood and gateway interop, but it does
not replace the momo-owned execution path. The normative decision and fixtures are
in [`research/11-agent-runtime/11-hermes-adapter-contract-v0.md`](../../research/11-agent-runtime/11-hermes-adapter-contract-v0.md).

> A credentialed end-to-end run still requires a user-owned Hermes provider
> login. The adapter contract and oort bearer surfaces are covered locally by:
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
| `connect()` | Use `MOMO_AGENT_TOKEN` for realtime-token exchange, subscribe only to the agent's private `agentwork:` stream, then atomically claim one durable pending job with a bounded lease. |
| `send(channel, blocks)` | A oort `run_id` is required before REST `POST .../messages`. Run-bound agent output uses a `client_msg_id` for **idempotency**; unbound Hermes lifecycle/setup/command notices are handled as local-log-only and never enter the timeline ledger. |
| `handle_message(evt)` | An `agent.job` is completed through server-owned `/gateway/complete`; legacy `mention` / `dm.signal` interop supplies its oort `run_id` to `send()`. Both paths keep the final agent response linked to a run. |

### Write-path invariant (§1.2 / §8.1)

The adapter **never** publishes to Centrifugo directly. It only *reads* the
realtime stream and *writes* via REST. Every state change is
`REST → PG commit → outbox → relay publishes`.

Hermes also calls platform `send()` for session reset, home-channel setup,
`/resume`/`/sethome` hints and model/provider diagnostics. oort deliberately
suppresses every such unbound call: only an explicit oort `run_id` may use the
direct message endpoint, while the native gateway path commits its final agent
response through `/gateway/complete`. Configure `MOMO_HOME_CHANNEL` and
`MOMO_HOME_CHANNEL_NAME` before gateway startup when a home target is needed.

### Loop safety (§3.4)

`handle_message` ignores the agent's own messages, dedups one mention → one run
(trigger key + `agent_run` idempotency key), and only acts on `mention` /
`dm.signal` event types — so `message.new` echoes never re-trigger it.

## Files

| File | Purpose |
|---|---|
| `momo_adapter.py` | `MomoAdapter(BasePlatformAdapter)` + `register(ctx)` / `register_platform()`. |
| `provider_chain.py` | provider polymorphism (ADR-0135 D3): chat/health/probe interface, cascade, effort table, quota snapshots. |
| `plugin.yaml` | Hermes platform plugin manifest (`kind: platform`, entrypoint `adapter.py`). On default macOS case-insensitive filesystems this also resolves as `PLUGIN.yaml`. |
| `requirements.txt` | runtime deps (`aiohttp`, `websockets`). |
| `tests/smoke_momo_adapter.py` | dependency-free local smoke: Centrifugo fixture in, REST calls captured, no network. |
| `tests/test_momo_adapter_contract.py` | stdlib unittest for contract fixtures and smoke harness. |
| `tests/test_provider_chain_contract.py` | stdlib unittest for cascade/effort/quota — no oort server, no provider, no network. |
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
| `MOMO_API_URL` | oort REST API base, e.g. `http://api:8080`. |
| `MOMO_CENTRIFUGO_WS_URL` | Centrifugo WS endpoint, e.g. `ws://centrifugo:8000/connection/websocket`. |
| `MOMO_WORKSPACE_ID` | target workspace UUID (tenant). |
| `MOMO_AGENT_MEMBER_ID` | the agent's `member.id` (`kind='agent'`). |
| `MOMO_AGENT_HANDLE` | agent display handle for logs/UI hints (default `hermes`). |
| `MOMO_HOME_CHANNEL` | home channel UUID loaded at gateway startup. `scripts/momo hermes-gateway-init` sets this instead of asking through a timeline message. |
| `MOMO_HOME_CHANNEL_NAME` | display name for the configured home channel (default `agent-lab` in the local setup). |
| `MOMO_AGENT_TOKEN` | scoped per-agent oort bearer used for realtime, pending recovery, callbacks, and message writes. It is not a provider token. |
| `MOMO_AGENT_ALLOW_INSECURE_HTTP` | optional explicit opt-in for trusted non-loopback private networks. Without it, non-loopback API/WS endpoints require `https`/`wss`. |
| `MOMO_PROVIDER_BEARER_ENV_PREFIX` | env prefix this adapter reads *provider* bearers from (default `HERMES_PROVIDER_BEARER`; per link `HERMES_PROVIDER_BEARER__<PROVIDER_REF>`). The name of a variable, never a secret value. |
| `MOMO_QUOTA_PROBE_ENABLED` | set `0` to disable the periodic remaining-quota probe (default enabled). |
| `MOMO_QUOTA_PROBE_INTERVAL_S` | probe period in seconds, floor 30, default 900. |

### Provider cascade, effort, quota probe (ADR-0134 D2 / ADR-0135 D2·D3)

oort hands down the provider chain **shape only** — an ordered list of
`{provider_ref, position, base_url, mode, enabled}`. Credentials never travel on
that payload: each link's bearer is read from this adapter's own environment
under `MOMO_PROVIDER_BEARER_ENV_PREFIX` (ADR-0004, "provider 자격증명 비유입"). A
chain payload carrying a credential-shaped key is rejected outright, not sanitized.

* **cascade** — links are tried in `position` order. Only *no response / 5xx /
  429* (plus 408/425, matching `MomoAdapter._is_retryable_http_status` so the
  adapter and the oort gateway classify identically) fall through to the next
  link. Every other 4xx is a validation error and propagates unchanged — a user's
  bad request must never be re-billed against a second provider. Each transition
  is reported to oort as `provider.cascade.fallback {from, to, reason}`; silent
  failover is a contract violation.
* **effort** — a request's `routing {model, effort}` is validated against the
  provider×model effort table oort owns (`GET /v1/provider/effort-table`). An
  effort the model does not support — or an unavailable table — is dropped with a
  log line and never guessed into the provider request.
* **quota probe** — the adapter probes because it is the side holding the
  credential, then posts *numbers only* to
  `POST /v1/provider/quota-snapshots` as
  `{provider_ref, window(short|weekly), remaining_ratio, resets_at, probed_at}`.
  The body is asserted key-exact and credential-free before it is sent.

Connection sequence (§6.3 / §7.1 / §4.3):

1. Send `MOMO_AGENT_TOKEN` to `POST /v1/auth/realtime-token`.
2. WS connect to Centrifugo with the returned short-lived JWT.
3. Subscribe only to `agentwork:ws<workspaceUUID>.<agentMemberUUID>`.
4. Claim pending jobs one at a time after connect, reconnect, or a detected
   publication gap. Realtime `agent.job` is wake-only; the leased pending row is
   the execution input and there is no idle polling loop.
5. Renew the lease while provider work/callbacks are in flight. Exact job+lease
   ownership is required for events/completion/renew/release; expiry enables
   crash takeover.
6. Use the same bearer for pending jobs, gateway events/completion, and messages.

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
through oort REST; it never publishes directly to Centrifugo.

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
Hermes and is never copied into oort or this adapter configuration.

## Server-contract status

MOMO-337 wires and runtime-tests the scoped agent bearer across realtime-token,
pending jobs, gateway event/completion callbacks, and agent-authored messages.
Legacy shared-secret support is migration-only and is not consumed by this
adapter.
