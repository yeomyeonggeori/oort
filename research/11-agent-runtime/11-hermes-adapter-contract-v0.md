# Hermes Adapter Contract v0

> Updated: 2026-07-12
> Status: normative contract, realigned by ADR-0102 Option C (Accepted). Implementation parity is tracked by MOMO-349/350/341/352.

## 1. Decision Summary

momo supports two **official, role-separated execution paths**. The path says who owns the runtime; it does not move governance out of momo.

| Mode | Official product role | Runtime owner | Delivery |
|---|---|---|---|
| AgentWorker OpenAI-compatible SSE (`AGENT_GATEWAY_MODE=worker`) | **managed** agent path | momo | server creates `agent_job`; AgentWorker claims it and calls the provider through `/v1/chat/completions` SSE |
| Hermes platform adapter (`AGENT_GATEWAY_MODE=gateway`) | **BYOA** (bring your own agent) path | user-owned Hermes/provider runtime | server publishes a private `agentwork:` wake-up; adapter re-reads the durable job and returns events/results through momo REST |

Both paths keep momo as the governance host. Postgres remains the source of truth; the server owns the `agent_run` state machine, Context Packet projection, approval records and decisions, budget/usage ledger, audit log, message ordering, and transactional outbox. The runtime may report progress, proposed tool calls, results, and usage evidence, but it cannot commit those guarantees itself.

`AGENT_GATEWAY_MODE` selects the delivery role for a deployment. Its safe configuration default remains `worker`, but that default is not product-path precedence: gateway is the official BYOA path used by Hermes dogfood. Gateway parity rolls out through MOMO-349 (approval), MOMO-350 (status/partial), MOMO-341 (claim/lease), and MOMO-352 (two-path equivalence verifier); until each lands, the corresponding row below is a normative target rather than completed runtime evidence.

Codex OAuth is outside the momo boundary. If Hermes/Kim Intern uses Codex OAuth,
the provider owns authorization code exchange, access/refresh token storage,
refresh, unlink, rotation, and provider account audit. momo accepts only the
OpenAI-compatible provider endpoint plus `HERMES_API_KEY`; momo app/API/DB,
Context Packet, Memory Plane, Capability Cache, diagnostics, and local gate
evidence must not contain Codex OAuth access or refresh tokens. The detailed
credential boundary is `docs/adr/0004-codex-oauth-hermes-provider-boundary.md`.

## 2. Server-Owned Guarantee Matrix

A runtime integration is acceptable only if every row stays under momo server ownership. The two paths may differ in transport, never in the authority that commits a guarantee.

| Guarantee | Server-owned rule shared by worker and gateway | Path-specific transport |
|---|---|---|
| Identity / tenancy | `member.kind='agent'`, `workspace_id`, channel membership, token scope, and actor/run binding are checked before work or writes | worker uses the run-bound server/worker identity; gateway uses the same agent's scoped `agent_bearer` |
| Context Packet | server assembles a bounded projection after grants, redaction, tool policy, and budget checks; raw DB/provider credentials are excluded | worker reads the job; gateway receives the same projection from the durable pending job |
| Run lifecycle | `agent_run` is the only run state machine and server transactions authorize each transition | worker claims rows; gateway reports events through `POST .../gateway/events` |
| Approval | write/spend/admin tool calls are proposals; server creates `approval`, moves the run to `awaiting_approval`, records the human decision, then emits `resume_approval`/resume work | worker pauses locally; gateway reports `approval_request` and resumes from a new private job (MOMO-349) |
| Cost | budget authority and `usage_ledger` reserve/reconcile stay in momo; provider/runtime usage is evidence, not authority | worker parses SSE usage; gateway submits bounded usage with completion |
| Audit | server writes `audit_log` with workspace, actor, run, and `via_token_id` provenance | both paths call/execute only through server-authorized transitions |
| Ordering / durability | user-visible output receives `message.seq` in the same transaction as message/outbox writes; Postgres is SoT and Centrifugo is transport only | worker and gateway both finish through REST/PG/outbox; neither publishes client-visible state directly |
| Progress | server records/validates progress and publishes observable `agent.status` / `agent.partial` only to `agent:` | worker forwards SSE deltas; gateway posts bounded status/partial events (MOMO-350) |
| Recovery | durable outbox rows are the work source; retries remain idempotent | worker claim retry; gateway realtime wake-up plus actor-bound `FOR UPDATE SKIP LOCKED` pending claim, 30s renewable lease, and expiry takeover |
| Provider credential | provider OAuth/API keys stay inside the runtime selected by the operator (ADR-0004) | managed deployment configures provider access for AgentWorker; BYOA keeps it entirely inside user-owned Hermes |

## 3. Mode A: AgentWorker OpenAI-Compatible SSE

This is the official **managed** path.

1. Server creates or claims an `agent_run` and enqueues `outbox(kind='agent_job')`.
2. AgentWorker claims the job with SKIP LOCKED.
3. momo builds or reads the Context Packet projection and tool grants for the run.
4. CostAccounting reserves budget before calling the runtime.
5. `HermesTransport` sends `POST /v1/chat/completions` with `stream=true` and `stream_options.include_usage=true`.
6. SSE chunks map to `AgentEvent.textDelta`, `AgentEvent.toolCall`, and `AgentEvent.usage`.
7. Text deltas become server-governed `agent.partial`; final text becomes a normal momo message through Postgres/outbox.
8. Tool calls pass through approval policy before execution.
9. Usage reconciles cost and writes the ledger.

The fixture `fixtures/hermes-adapter-contract-v0/agentworker_openai_sse_input.json` fixes the input shape for this path.

Credentialed smoke for a real provider uses `AGENT_PROVIDER_MODE=external-hermes`,
`HERMES_BASE_URL=https://.../v1`, `HERMES_API_KEY`, and `AGENT_MODEL`. Do not
pass Codex OAuth token env vars to momo processes or verifier scripts.

## 4. Mode B: Hermes Platform Adapter

This is the official **BYOA** path. Hermes treats momo as one messaging platform while momo keeps run governance.

Adapter contract:

- `connect()` authenticates with a per-agent bearer through `POST /v1/auth/realtime-token`, fetches a Centrifugo token, and subscribes only to the private `agentwork:` stream. Observable `agent:` status/partial remains a separate client surface.
- An `agentwork:` publication is a wake-up, not trusted execution input. On connect, reconnect, or a wake-up, the adapter claims one row at a time through `GET /v1/workspaces/:ws/agents/:agent/gateway/jobs/pending`; the response carries an opaque job lease capability.
- The adapter renews the lease while provider work and callbacks are in flight. `events`/`complete`, renew, and release bind the exact job id + lease id + bearer actor; an expired/non-owner capability fails closed, and an expired pending row can be taken over.
- `send(channel, blocks)` writes through REST `POST /messages` only for an explicit momo `run_id`, with `client_msg_id` idempotency. Unbound Hermes lifecycle/setup/command notices are local-log-only; the native gateway final response is committed by `/gateway/complete`.
- For a server-created job, the adapter reports status/tool proposals/partial output through `POST .../gateway/events` and final output/usage through `POST .../gateway/complete`. The server commits all user-visible state.
- A configured gateway work host adds the closed `work.spawn|input|read|kill` tool definitions to the per-job provider payload. The provider returns `{call_id,name,arguments}` only; the adapter-owned `MOMO_WORK_HOST_ID` is attached outside `arguments` when posting `status=tool_call`. The server revalidates the exact run/lease/actor, requires the bearer to also hold `work:control`, derives the channel from `agent_run`, and enters the same `WorkControlRoutes` transaction used by the managed worker. `call_id` retries are idempotent and conflicting reuse is rejected. Missing/invalid host configuration exposes no work tools.
- Legacy `handle_message(evt)` interop still acts only on `mention` and `dm.signal`, ignores self-authored events, derives an idempotent trigger key, and writes through REST.

Adapter hard boundaries:

- It never publishes directly to Centrifugo.
- It must treat channel ids as REST path ids, not as publish channels.
- It must not take broad plugin/provider credentials from Hermes runtime memory.
- It must not bypass momo approval/cost/audit decisions for user-visible work.
- It must not forward Codex OAuth tokens into momo REST requests, message props,
  audit payloads, diagnostics, or adapter evidence.
- It authenticates realtime-token, pending recovery, callbacks, and message writes with the same scoped `agent_bearer`; token actor must equal the job/run agent.
- It never accepts provider-authored workspace/channel/run/host authority in work-tool arguments. Host selection stays in adapter configuration and raw PTY/process output still never crosses this callback.

The fixture `fixtures/hermes-adapter-contract-v0/platform_adapter_event_mapping.json` fixes the minimum event mapping for this path.

## 5. Path Selection And Migration

| Situation | Use | Reason |
|---|---|---|
| momo operates the runtime/provider for a hosted or server-side agent | AgentWorker SSE (`worker`) | managed execution; no user-owned gateway process is required |
| A user brings a Hermes runtime/provider account | Platform adapter (`gateway`) | BYOA execution; provider credentials stay in the user's runtime |
| Tool execution with write/spend/admin risk | Either official path | the same server approval state machine is mandatory; path choice cannot bypass it |
| Broad workspace/source retrieval | Either official path | the server builds the same bounded Context Packet and permission snapshot |
| External agent writes a message | Gateway REST write | preserves `member.kind='agent'`, `client_msg_id`, `message.seq`, RLS, audit, and outbox semantics |

### 5.1 SD-5 surface (retroactively approved by ADR-0102)

- `POST /v1/auth/realtime-token`: scoped connection-token exchange for agent realtime access.
- `GET /v1/workspaces/:ws/agents/:agent/gateway/jobs/pending`: actor-bound durable recovery endpoint.
- `POST /v1/workspaces/:ws/agents/:agent/gateway/jobs/:job/lease/renew|release`: exact-owner bounded lease lifecycle (`agent:jobs:read`).
- `AGENT_GATEWAY_MODE=worker|gateway`: selects managed or BYOA delivery without changing the guarantee owner.

### 5.2 Agent identity and legacy secret removal

Both paths converge on `token.kind='agent_bearer'` (ADR-0101). Gateway uses the four v0 scopes `agent:jobs:read`, `agent:runs:callback`, `messages:write`, and `realtime:subscribe`; callback and pending paths additionally enforce actor/target binding.

`X-Momo-Agent-Gateway-Secret` / `AGENT_GATEWAY_SECRET` is migration-only and disabled unless `MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1`. Normal dogfood and new deployments must keep the flag at `0`. After MOMO-349/350/341 land and MOMO-352 passes the clean/root equivalence gate, a dedicated security cleanup removes the header, both env keys, and the legacy-only regression case; removal is required before M7.

## 6. Fixture Index

Fixtures live in `research/11-agent-runtime/fixtures/hermes-adapter-contract-v0/`.

| Fixture | Covers |
|---|---|
| `agentworker_openai_sse_input.json` | Managed AgentWorker request into Hermes/Kim Intern OpenAI-compatible SSE, including Context Packet, approval, cost, and audit controls. |
| `platform_adapter_event_mapping.json` | BYOA platform adapter mention event mapping into momo REST invoke/send concepts. |

## 7. Lightweight Contract Test And Smoke

`adapters/hermes/tests/test_momo_adapter_contract.py` is a stdlib unittest that does not require the Hermes SDK, aiohttp, websockets, Docker, or Postgres. It verifies:

- the SSE fixture carries `stream=true`, `include_usage=true`, and momo-owned control blocks;
- forbidden runtime inputs are not present in the request body;
- a platform adapter Centrifugo push unwraps to the expected adapter event;
- `MomoAdapter.handle_message()` maps that event to REST invoke and final message send shapes;
- `adapters/hermes/tests/smoke_momo_adapter.py` can run the same fixture as a repo-local smoke and capture REST calls without network;
- `register_platform()` can register the adapter with a gateway-like registry.

`scripts/local_gate.sh --profile docs` runs `py_compile`, the unittest, and the standalone smoke script so fixture drift fails before PR handoff. These static checks do not prove the Option C parity rows. Runtime evidence for gateway approval/status/lease and two-path equivalence belongs to MOMO-349/350/341/352. Loading `plugin.yaml` inside a live Hermes gateway with a real provider remains operator-credentialed runtime evidence.

## 8. External Code Policy

No Mattermost, Hermes, OpenClaw, or other external implementation code is copied into momo for this contract. This spec references integration patterns and fixes momo-owned wire shapes only.

## 9. Follow-Ups

- Complete MOMO-349/350/341, then keep MOMO-352's equivalence verifier as the regression gate for the server-owned matrix.
- Remove the legacy gateway shared-secret surface after that equivalence gate, no later than M7 entry.
- Keep platform adapter manifests versioned against the Hermes SDK when the exact production plugin schema is confirmed.
- Ensure future inbound MCP or Google Workspace writes enter through the same Context Packet -> approval -> audit path.
- Keep Codex OAuth provider links provider-owned unless a future security review
  explicitly adds an encrypted provider-link table and migration.
