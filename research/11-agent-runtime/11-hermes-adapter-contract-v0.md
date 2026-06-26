# Hermes Adapter Contract v0

> Updated: 2026-06-26
> Status: normative contract decision for MOMO-162. No production Hermes deployment in this ticket.

## 1. Decision Summary

momo supports two Hermes integration modes, but they are not equal product paths.

| Mode | Product role | Default? | Owner of context/approval/cost/audit |
|---|---|---:|---|
| AgentWorker OpenAI-compatible SSE | momo creates an `agent_job`, builds the Context Packet projection, reserves budget, calls Hermes/Kim Intern through `/v1/chat/completions` SSE, and records messages/run/cost/audit in Postgres | Yes | momo |
| Hermes platform adapter | Hermes gateway loads `adapters/hermes/momo_adapter.py` so a Hermes agent can see momo as a messaging platform through `connect`, `send`, and `handle_message` | No, optional ingress/interop | Split; adapter must write back only through momo REST |

The product default is **AgentWorker OpenAI-compatible SSE**. That path keeps momo as the agent host: Postgres remains the source of truth, Context Packet is built by momo, approval pause/resume is a protocol checkpoint, budget reserve/reconcile is done by momo, and audit stays in momo tables.

The platform adapter remains useful for dogfood, interoperability, and a future Hermes-native operator experience. It is not the default execution path until it can prove the same Context Packet, approval, cost, audit, RLS, and outbox guarantees without moving ownership into Hermes.

## 2. Non-Negotiable Controls

A Hermes integration is acceptable only if these controls stay under momo ownership.

| Control | Product-default rule |
|---|---|
| Context Packet | momo assembles the bounded packet after workspace membership, channel membership, source grants, redaction, tool policy, and budget checks. Hermes receives only the packet projection, not raw DB/provider credentials. |
| Approval | Write-like tool calls are proposals. AgentWorker evaluates Context Packet / Capability Cache tool grant metadata and pauses with `approval_request` before external side effects. |
| Cost | AgentWorker reserves budget before the call, parses OpenAI-compatible `usage` from SSE or fallback response, reconciles `usage_ledger`, and releases reserve in `budget_window`. |
| Audit | `agent_run`, `message`, `approval`, `usage_ledger`, and `audit_log` are written under the workspace boundary. Realtime delivery is still outbox -> relay -> Centrifugo. |
| Ordering | User-visible messages enter through the normal REST/DB path and receive `message.seq`; no adapter may publish directly to Centrifugo. |
| Tenancy | Runtime work is scoped by `workspace_id`; DB access uses RLS or worker BYPASSRLS only for controlled background consumption. |

## 3. Mode A: AgentWorker OpenAI-Compatible SSE

This is the canonical path for user-visible agent runs.

1. Server creates or claims an `agent_run` and enqueues `outbox(kind='agent_job')`.
2. AgentWorker claims the job with SKIP LOCKED.
3. momo builds or reads the Context Packet projection and tool grants for the run.
4. CostAccounting reserves budget before calling the runtime.
5. `HermesTransport` sends `POST /v1/chat/completions` with `stream=true` and `stream_options.include_usage=true`.
6. SSE chunks map to `AgentEvent.textDelta`, `AgentEvent.toolCall`, and `AgentEvent.usage`.
7. Text deltas publish `agent.partial` after Postgres/outbox rules; final text becomes a normal momo message.
8. Tool calls pass through approval policy before execution.
9. Usage reconciles cost and writes the ledger.

The fixture `fixtures/hermes-adapter-contract-v0/agentworker_openai_sse_input.json` fixes the input shape for this path.

## 4. Mode B: Hermes Platform Adapter

This path lets the Hermes gateway treat momo as one messaging platform.

Adapter contract:

- `connect()` authenticates to momo REST, fetches a Centrifugo token, and subscribes to `agent:` and `user:` streams.
- `send(channel, blocks)` writes through REST `POST /messages` with `client_msg_id` idempotency.
- `handle_message(evt)` acts only on `mention` and `dm.signal`, ignores self-authored events, derives an idempotent trigger key, invokes the target agent, and reflects final output with `send()`.

Adapter hard boundaries:

- It never publishes directly to Centrifugo.
- It must treat channel ids as REST path ids, not as publish channels.
- It must not take broad plugin/provider credentials from Hermes runtime memory.
- It must not bypass momo approval/cost/audit decisions for user-visible work.

The fixture `fixtures/hermes-adapter-contract-v0/platform_adapter_event_mapping.json` fixes the minimum event mapping for this path.

## 5. When To Use Which Mode

| Situation | Use | Reason |
|---|---|---|
| Normal momo mention, slash command, message action, scheduled run, or MCP-originated agent run | AgentWorker SSE | momo owns Context Packet, approval, cost, and audit end to end. |
| Testing Hermes as a multi-platform gateway that can receive momo events | Platform adapter | Validates adapter interop without changing the product execution owner. |
| External Hermes deployment wants to post into momo as an agent member | Platform adapter, REST writes only | Keeps `member.kind='agent'` and `message.seq` semantics. |
| Tool execution with write/spend/admin risk | AgentWorker SSE | Approval pause/resume and same-run audit are momo protocol, not gateway convention. |
| Broad retrieval from workspace memory or external sources | AgentWorker SSE | Context Packet and Memory Plane permission snapshots must be built by momo. |

## 6. Fixture Index

Fixtures live in `research/11-agent-runtime/fixtures/hermes-adapter-contract-v0/`.

| Fixture | Covers |
|---|---|
| `agentworker_openai_sse_input.json` | Canonical AgentWorker request into Hermes/Kim Intern OpenAI-compatible SSE, including Context Packet, approval, cost, and audit controls. |
| `platform_adapter_event_mapping.json` | Optional platform adapter mention event mapping into momo REST invoke/send concepts. |

## 7. Lightweight Contract Test

`adapters/hermes/tests/test_momo_adapter_contract.py` is a stdlib unittest that does not require the Hermes SDK, aiohttp, websockets, Docker, or Postgres. It verifies:

- the SSE fixture carries `stream=true`, `include_usage=true`, and momo-owned control blocks;
- forbidden runtime inputs are not present in the request body;
- a platform adapter Centrifugo push unwraps to the expected adapter event;
- `MomoAdapter.handle_message()` maps that event to REST invoke and final message send shapes;
- `register_platform()` can register the adapter with a gateway-like registry.

Runtime-unverified remains: loading `plugin.yaml` inside a live Hermes gateway and running the platform adapter against live momo + Centrifugo + Postgres. MOMO-004 already verified the AgentWorker SSE path with the repo-local OpenAI-compatible mock; external Hermes staging should re-run that path before release.

## 8. External Code Policy

No Mattermost, Hermes, OpenClaw, or other external implementation code is copied into momo for this contract. This spec references integration patterns and fixes momo-owned wire shapes only.

## 9. Follow-Ups

- Add live Hermes gateway adapter smoke once a Hermes test instance is available.
- Keep platform adapter manifests versioned against the Hermes SDK when the exact production plugin schema is confirmed.
- Ensure future inbound MCP or Google Workspace writes enter through the same Context Packet -> approval -> audit path.
