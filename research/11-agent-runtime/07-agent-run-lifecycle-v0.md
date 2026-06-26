# Agent Run Lifecycle v0

> Updated: 2026-06-26
> Status: normative spec for MOMO-160. Swift boundary mapping is included; DB/runtime behavior changes are follow-up work.

## 1. Purpose

`agent_run` is momo's durable task row. It is the stateful unit of work that connects:

- a human-visible channel/thread timeline,
- the immutable Context Packet for a run,
- Memory Plane retrieval decisions,
- Capability Cache tool grants,
- Hermes/Kim Intern/OpenAI-compatible execution,
- approval, usage, audit, and artifact records.

This document aligns `agent_run` with the A2A-style Task lifecycle while preserving momo's invariant that Postgres is the source of truth and Centrifugo is only the delivery layer.

Reference: A2A protocol specification, especially Task, TaskStatus/TaskState, Message, Artifact, TaskStatusUpdateEvent, and TaskArtifactUpdateEvent: <https://a2a-protocol.org/latest/specification/>.

## 2. Canonical States

The public lifecycle has exactly seven states:

| Public state | DB/Swift raw value | Terminal | Meaning |
|---|---|---:|---|
| `queued` | `queued` | no | Run is persisted and eligible for an AgentWorker claim. No model/tool spend has started. |
| `running` | `running` | no | Worker has claimed the run, built/validated context, reserved budget, or is streaming/model/tool processing. |
| `input-required` | `input_required` | no | Agent needs more natural-language input from a human or upstream agent. This is not an approval gate. |
| `awaiting-approval` | `awaiting_approval` | no | Run is paused on a policy-controlled approval row for an external write, spend, deploy, identity, or admin action. |
| `succeeded` | `succeeded` | yes | Run finished successfully and any final message/artifact/usage/audit records are durable. |
| `failed` | `failed` | yes | Run ended because of runtime, policy, budget, timeout, transport, or validation failure. |
| `cancelled` | `cancelled` | yes | Human/system deliberately stopped the run before success. Rejected approvals usually end here unless the agent has a safe alternate path. |

Spelling rule:

- API/docs may show A2A-style kebab case (`input-required`, `awaiting-approval`) in prose.
- Postgres enum text, Swift raw values, and JSON wire fields use snake case (`input_required`, `awaiting_approval`).
- `agent.status` events should carry both a lifecycle value and a UI phase when the runtime can distinguish them. Phases such as `thinking`, `streaming`, `done`, and `error` are not durable lifecycle states.

## 3. State Transitions

Allowed v0 transitions:

```text
queued
  -> running
  -> cancelled

running
  -> input-required
  -> awaiting-approval
  -> succeeded
  -> failed
  -> cancelled

input-required
  -> running          # human/agent supplied more input
  -> failed           # required input expired or became invalid
  -> cancelled

awaiting-approval
  -> running          # approval approved and policy still valid
  -> failed           # approval expired, policy invalidated, or execution failed closed
  -> cancelled        # approval rejected or run cancelled

succeeded | failed | cancelled
  -> no further transitions
```

Rules:

- `input-required` is for missing information. It creates or references a normal first-class `message` from the agent asking for input and resumes only after a new user/agent message is bound to the same task context.
- `awaiting-approval` is for permissioned side effects. It must have `approval.status='pending'` and a `message.type='approval_request'` card in the channel.
- A run may not be both `input-required` and `awaiting-approval`.
- Retries of transient transport failures may requeue the outbox job, but the user-visible terminal state remains `failed` only after max attempts or a non-retryable error.
- Timeout is a failure reason, not a public lifecycle state. Existing `timed_out` rows map to public `failed` with `error.reason='timed_out'`.

## 4. A2A Mapping

| A2A concept | momo source of truth | Notes |
|---|---|---|
| Agent Card | `member.kind='agent'` + Capability Cache `agent_capability` | Agent discovery is a cache/policy projection, not permission by itself. |
| Agent skill/capability | Capability Cache `agent_capability`, `plugin_tool_schema`, `mcp_tool_list` | Projected into Context Packet `tool_grants` after policy checks. |
| Task | `agent_run` | One durable row per invocation/turn. `agent_run.id` is the task id. |
| Task context id | workspace + channel + thread root + Context Packet id | A2A `contextId` groups tasks/messages. momo uses tenant/channel/thread scope and immutable packet references. |
| Task status | `agent_run.status` | Public states are the seven states in section 2. |
| Task status update | `agent.status` event | Event delivery is Centrifugo; durable state remains Postgres. |
| Message | `message` | Same table for human and agent messages. `message.run_id` links outputs to the task. |
| Message role | `member.kind` + `message.author_member_id` | `human` maps to user/client role; `agent` maps to agent role. |
| Message parts | `message.body` + `message.props` | Text lives in `body`; structured tool/diff/approval/artifact payloads live in `props`. |
| Artifact | `message.type='artifact'` + Memory Plane `artifact_ref` | Timeline card is the visible artifact; Memory Plane stores durable references and retrieval policy. |
| Artifact update | `message.new`/`message.edited` for artifact cards + optional `agent.partial` | Final artifact writes follow REST/DB/outbox. Progress chunks may be ephemeral. |
| Input required | `agent_run.status='input_required'` + agent question message | Follow-up input resumes the same run context or creates a child run with `parent_run_id`. |
| Approval required | `agent_run.status='awaiting_approval'` + `approval(status='pending')` + `approval_request` message | This is momo-specific policy control, not a generic A2A input request. |
| Cancel task | future cancel endpoint updates `agent_run.status='cancelled'` | Worker must stop/reconcile budget and write audit. |
| Push notification | outbox/realtime/APNs future path | Push delivery must mirror the same task/message/artifact updates. |

## 5. Context, Memory, and Capability Alignment

### Context Packet

- `queued`: run input must contain enough request metadata to build a Context Packet. Future schema should add `agent_run.context_packet_id`; until then the reference belongs in `agent_run.input.context_packet_id`.
- `running`: worker must pass exactly one valid Context Packet runtime envelope to Hermes/Kim Intern/OpenAI-compatible SSE. If the packet is expired or policy-incompatible, the run fails closed before model/tool spend.
- `input-required`: packet content is immutable. Resume requires a new packet reference or packet version that includes the follow-up input and fresh permission checks.
- `awaiting-approval`: the approval card must cite the packet/tool grant/policy version that made the proposed action available.

### Memory Plane

- Memory retrieval decisions are inputs to the run, not private runtime memory.
- `input-required` may produce `task_state` memory only after the follow-up is visible and sourced.
- Approval outcomes may become `decision`, `task_state`, or `artifact_ref` memory only through Memory Plane write-time gates.
- Terminal runs should record which memory refs were used and which were withheld; future implementation can keep those refs in `agent_run.input`/`output` until dedicated tables exist.

### Capability Cache

- Tool availability comes from Capability Cache projection into Context Packet `tool_grants`.
- Risky grants project as `grant='propose'` and should transition to `awaiting-approval`, not direct execution.
- Expired or invalidated capabilities fail closed. A running task may return to `input-required` only when the missing item is human input; missing permission/provider grant is `failed` or `awaiting-approval` depending on policy.

## 6. Current Code and Migration Impact

| Layer | Current state | Required alignment | Action |
|---|---|---|---|
| `schema_v0.sql` / `001_init.sql` | `run_status` has `queued`, `running`, `awaiting_approval`, `paused`, `succeeded`, `failed`, `cancelled`, `timed_out`. | Add `input_required`; treat `paused`/`timed_out` as legacy/internal compatibility states. | Follow-up migration only. Do not edit `schema_v0.sql`. |
| `agent_run_active_idx` | Active statuses include `queued`, `running`, `awaiting_approval`, `paused`. | Include `input_required`; eventually drop reliance on `paused`. | Follow-up migration must rebuild the partial index after enum value is committed. |
| `clients/Core RunStatus` | Mirrors DB enum including legacy/internal states. | Keep DB mirror, add a public lifecycle projection for seven-state product semantics. | This ticket adds Swift boundary mapping without changing DB runtime. |
| `workers/AgentWorker RunStatus` | Local enum mixes UI phases (`thinking`, `streaming`, `done`, `error`) with `awaiting_approval`. | Split durable lifecycle from UI phase in future runtime event payloads. | Follow-up runtime refactor; current behavior remains compile/runtime-compatible. |
| `WorkerService.updateRunStatus` | Maps `thinking/streaming` -> `running`, `done` -> `succeeded`, `error` -> `failed`, `awaitingApproval` -> `awaiting_approval`. | Add `inputRequired` only after DB migration exists; do not map it to `paused` for new writes. | Follow-up MOMO-161/runtime work. |
| `approval` table | Durable approval gate exists. | Only `awaiting_approval` may depend on `approval(status='pending')`. | MOMO-161 implements pause/resume. |
| Hermes/OpenAI SSE | Emits text/tool/usage/error events, not A2A task states. | AgentWorker normalizes transport events into momo lifecycle + phase. | No Hermes protocol change in this ticket. |
| Server REST | No public task get/cancel/resume API yet. | Future APIs should expose the seven-state lifecycle and preserve `message.seq` ordering. | Follow-up MOMO-160 implementation slice or MOMO-161/163. |

## 7. Future Migration Sketch

Do not apply this sketch directly without runtime tests:

1. `003_agent_run_lifecycle_status.sql`: `ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'input_required' BEFORE 'awaiting_approval';`
2. `004_agent_run_active_idx.sql`: rebuild `agent_run_active_idx` so active statuses include `input_required`.
3. Add `agent_run.context_packet_id` or a typed `agent_run_context_packet` reference table once Context Packet persistence is designed.
4. Update MomoCore `RunStatus` to include `inputRequired` only when DB and API can emit it.
5. Update AgentWorker events to publish `{ phase, run_status }` instead of a single overloaded `status` field.

Runtime verification for those migrations must include `make migrate` idempotency, queued -> input-required -> running resume, awaiting-approval pause/resume, cancel, failure, and existing MOMO-004 AgentWorker SSE/cost gates.
