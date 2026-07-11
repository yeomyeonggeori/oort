# M3 D/B/C Real-Data Readiness and Blocker Cleanup

> Status: MOMO-198 spec/roadmap slice. Code changes are out of scope.
> Verification target: docs local gate. Swift/runtime gates are unchanged by this document.
> Runtime note: live SwiftCentrifuge adapter, M3 D/B/C local runtime gates, and external provider side effects remain `runtime-unverified`.

## Goal

MOMO-020/021/022 were created before the current M3 agent-runtime work landed. Their old blocker text only says "Depends on MOMO-004", but current `main` now has REST history/send, approval decision runtime, realtime-token, replay/gap driver seams, card rendering, approval UI actions, and AgentWorker mock SSE verification.

This document rewrites the unblock conditions around the current code boundary:

- D Live Tool-Call real-data rendering should be unblocked by a real macOS realtime adapter and a deterministic agent/tool-call fixture.
- B Cost Breathing should be unblocked by a server/client cost projection, not by the macOS ring computing accounting state.
- C Approval Inbox should be unblocked by a pending-approval read/projection path plus the existing decision endpoint and realtime confirmation path.

## Current Readiness Map

| Ticket | Current completed surface | Readiness for M3 D/B/C | Remaining gap |
|---|---|---|---|
| MOMO-170 | macOS `MessageBubble` renders `tool_call`, `tool_result`, `diff`, `approval_request`, `artifact`; shared metadata strip shows Context Packet/Memory/Capability/source/cost props. | D card shell exists; B can attach `CostBreathingRing` to agent bubbles; C inline approval card exists. | Runtime DB/wire projection into those props still needs fixture evidence for old MOMO-020/021/022. |
| MOMO-171 | `ChatBackend.decideApproval(ApprovalDecisionRequest)` and macOS Approve/Reject UI path exist; pending cards update optimistically and via approval events. | C user action path is no longer UI-only. | Pending approval list still needs server-backed discovery rather than seed/demo events only. |
| MOMO-174 | Source-preserving Context Packet compaction exists with deterministic fallback and local model availability guard. | D cards can show bounded source/citation context without pulling raw provider data into UI. | Not a direct D/B/C blocker; remains supporting context for source badges. |
| MOMO-177 | `MomoServerRESTChatBackend` can login, fetch history, send messages, and call approval decision endpoint. `MOMO_SERVER_BASE_URL` drives dev REST mode. | REST SoT path for M3 exists. | Channel list/member roster still come from config/seed; realtime subscription is optional and empty without an injected driver. |
| MOMO-179 | Realtime contract fixes token source, channel names, subscribe proxy boundary, envelope shapes, `message.seq` replay/gap-fill, and macOS apply boundary. | Defines exact event inputs for D/B/C. | Actual SwiftCentrifuge transport is intentionally absent. |
| MOMO-192 | Server `POST /v1/auth/realtime-token` issues short-lived Centrifugo connection JWT after active member recheck under tenant RLS. | Token source required by live macOS realtime is available. | macOS backend does not yet request/refresh this token. |
| MOMO-193 | `MomoCore` has `RealtimeSubscriptionDriver`, `RealtimeEnvelopeSubscriptionTransport`, and `RealtimeReplayController`; macOS REST backend can compose an optional driver. | Shared replay/gap logic is ready for live adapter injection. | No SwiftCentrifuge dependency/adapter or runtime reconnect/recovery gate yet. |

Supporting runtime work already landed outside the requested table:

| Surface | Current completed surface | Why it matters |
|---|---|---|
| MOMO-167 | Approval decision endpoint writes `approval_decision`, audit, `approval.decided` outbox, and same-run resume job for approve. | C approval actions can target a real server endpoint. |
| MOMO-178 | AgentWorker deterministic approved-tool resume executor writes `tool_result`, audit, job-done, and broadcast outbox for mock echo tools. | C can show approve -> tool_result evidence without real external providers. |
| MOMO-004 / runtime-agent gate | OpenAI-compatible SSE mock, `agent.partial`, reserve/reconcile, budget trip, and approved deterministic resume smoke are verified by `scripts/verify_agent_worker.sh`. | D/B/C can use repo-local fixtures instead of waiting for real Hermes/provider side effects. |

## Blocker Cleanup

### MOMO-020: D Live Tool-Call Real-Data Render

Old blocker:

- `Depends on: MOMO-004`
- Acceptance allows stub streaming and only asks for one staging Kim Intern response.

Current blocker reality:

| Boundary | Ready | Needed to unblock |
|---|---:|---|
| First-class card render | Yes | Keep existing `MessageBubble` card contract; do not rewrite UI. |
| Agent progress model | Yes | `AgentPartial` has `tool_call_name`, `tool_call_args`, `spent_micro_usd`; `ChatViewModel` coalesces partials. |
| Server/runtime fixture | Mostly | Use `scripts/verify_agent_worker.sh` or a new D-specific fixture to produce `agent.partial` + final `tool_call`/`tool_result`/`message.new`. |
| Live macOS delivery | No | Implement SwiftCentrifuge transport that obtains `/v1/auth/realtime-token`, subscribes to `ch:` and `agent:`, decodes `RealtimeEnvelope`, and injects `DefaultRealtimeSubscriptionDriver`. |
| Local gate | No | Add a D gate that proves REST history + live `agent.partial`/`message.new` apply into `ChatViewModel` from fixture/runtime evidence. |

Required endpoints/events:

- `POST /v1/auth/login`
- `POST /v1/auth/realtime-token`
- `GET /v1/workspaces/{ws}/channels/{ch}/messages?after=<seq>`
- Centrifugo subscribe proxy `POST /v1/centrifugo/subscribe`
- `agent.partial` on `agent:ws<workspace>.<channel>.<agentMember>`
- `agent.status` on `agent:ws<workspace>.<channel>.<agentMember>`
- `message.new` on `ch:ws<workspace>.<channel>`

Fixture/runtime evidence:

- A deterministic fixture or runtime script must emit an in-progress tool call with `tool_call_name`, bounded `tool_call_args`, and a final `tool_result`.
- Evidence should show `Message.seq` remains the ordering authority for final messages; `agent.partial` is progress-only and may be non-sequenced.
- Local gate profile candidate: `scripts/local_gate.sh --profile macos-d-live` or a subcommand under `macos-ui` that can run without a real Hermes gateway by using repo-local mock SSE.

Unblock condition:

- MOMO-020 can move from `status:blocked` to `status:ready` after MOMO-200 and MOMO-201 land.

### MOMO-021: B Cost Breathing Ring Real-Data Binding

Old blocker:

- `Depends on: MOMO-004`
- Acceptance says reserve/reconcile binding can use demo data.

Current blocker reality:

| Boundary | Ready | Needed to unblock |
|---|---:|---|
| Accounting runtime | Yes | `CostAccounting`, `usage_ledger`, `budget_window`, budget trip, and reserve/reconcile are covered by AgentWorker local gate. |
| Client model | Partial | `AgentStatus` and `AgentPartial` carry cost fields; `CostSnapshot` exists in macOS. |
| UI ring | Partial | `CostBreathingRing` renders reserve/spent/reconciled/estimated states. |
| Server projection | No | Need a read/projection path that maps `usage_ledger`/`budget_window` or run status into client `CostSnapshot`/`agent.status` without the client querying raw ledger tables directly. |
| Local gate | No | Need fixture/runtime evidence that reserve -> in-flight -> reconcile changes are visible to macOS state. |

Required endpoints/events:

- `agent.status` payload fields: `reserved_micro_usd`, `spent_micro_usd`, `run_status`
- `agent.partial` payload field: `spent_micro_usd` for in-flight progress
- Optional server read endpoint candidate: `GET /v1/workspaces/{ws}/agent-runs/{run}/cost` or a broader channel/run projection endpoint
- Existing DB SoT: `usage_ledger`, `budget_window`, `agent_run`

Fixture/runtime evidence:

- Runtime script should create an agent run with a non-zero reserve, stream at least one progress cost event, reconcile actual spend into `usage_ledger`, and release reserve in `budget_window`.
- macOS test can remain fixture-backed if it consumes the same `AgentStatus`/`AgentPartial` JSON shapes as runtime.

Unblock condition:

- MOMO-021 can move from `status:blocked` to `status:ready` after MOMO-202 lands. If MOMO-200 live adapter is not merged yet, MOMO-021 may still proceed as a REST/history + fixture UI slice but must mark live updates `runtime-unverified`.

### MOMO-022: C Approval Inbox Real-Data Roundtrip

Old blocker:

- `Depends on: MOMO-004`
- Acceptance uses `PATCH` language and allows stub actions.

Current blocker reality:

| Boundary | Ready | Needed to unblock |
|---|---:|---|
| Approval decision server endpoint | Yes | Current endpoint is `POST /v1/workspaces/{ws}/approvals/{approval}/decision`, not PATCH. |
| Client action contract | Yes | `ChatBackend.decideApproval` exists and REST backend posts to server endpoint. |
| Inline approval card | Yes | `MessageBubble` has Approve/Reject controls and in-flight state. |
| Inbox list | Partial | `ApprovalInboxView` renders `ChatViewModel.approvals`, currently seeded/live-event based. |
| Pending approval discovery | No | Need REST read path or channel-history projection for pending approvals so app launch can populate inbox before live events. |
| Local gate | No | Need deterministic approve/reject -> audit -> `approval.decided` -> resume/reject evidence tied to macOS state. |

Required endpoints/events:

- `GET /v1/workspaces/{ws}/approvals?status=pending` or equivalent channel-scoped pending approval projection
- `POST /v1/workspaces/{ws}/approvals/{approval}/decision`
- `approval.requested` and `approval.decided` realtime envelopes
- `message.new` for rejected `tool_result` and approved deterministic resume `tool_result`

Fixture/runtime evidence:

- Seed or runtime must create an `approval(status='pending')` row linked to an `approval_request` message.
- Local gate should prove approve and reject are idempotent with `client_decision_id`, write audit/decision evidence, update inbox row status, and do not bypass RLS/channel membership.
- Approved path can use deterministic `mock.echo`/`momo.mock.echo` until real provider side effects exist.

Unblock condition:

- MOMO-022 can move from `status:blocked` to `status:ready` after MOMO-203 lands. MOMO-200 improves live confirmation but is not required for a REST-first pending list + decision roundtrip.

## Proposed GitHub Issue Updates

Do not apply these automatically in this PR. They are proposed body/label updates for `momo-main` or a follow-up issue hygiene pass.

### Issue #12 / MOMO-020

Proposed labels:

- remove: `status:blocked`
- add after prerequisites: `status:ready`, `priority:p1`

Proposed body replacement:

```markdown
## Goal
Render D Live Tool-Call from real momo runtime data in MomoMac: live `agent.partial` progress, first-class `tool_call`/`tool_result` cards, and final `message.new` reconciliation.

## Acceptance
- [ ] [swift] MomoMac build/test green.
- [ ] [runtime/macos-ui] MomoMac receives `agent.partial` and `agent.status` through the SwiftCentrifuge-backed `RealtimeSubscriptionDriver`.
- [ ] [runtime/macos-ui] Final `message.new`/`tool_result` is ordered by `message.seq` and reconciles the progress card.
- [ ] [docs] Local gate evidence attached; any missing real Hermes/provider side-effect remains `runtime-unverified`.

## Depends on
- MOMO-200 macOS SwiftCentrifuge live adapter
- MOMO-201 D Live Tool-Call fixture/local gate
```

### Issue #13 / MOMO-021

Proposed labels:

- keep `status:blocked` until MOMO-202 lands
- add after prerequisite: `status:ready`

Proposed body replacement:

```markdown
## Goal
Bind CostBreathingRing to server-owned cost projection for reserve -> in-flight -> reconcile, without moving accounting logic into macOS.

## Acceptance
- [ ] [swift] MomoMac build/test green.
- [ ] [runtime] AgentWorker reserve/reconcile evidence exists in `usage_ledger` and `budget_window`.
- [ ] [swift/macos-ui] MomoMac consumes `agent.status`/`agent.partial` or REST cost projection as `CostSnapshot`.
- [ ] [runtime/macos-ui] Ring shows reserve, running spend, reconciled actual, and soft/hard-limit state from fixture/runtime evidence.

## Depends on
- MOMO-202 Cost projection endpoint/event contract + macOS binding
```

### Issue #14 / MOMO-022

Proposed labels:

- keep `status:blocked` until MOMO-203 lands
- add after prerequisite: `status:ready`

Proposed body replacement:

```markdown
## Goal
Render Approval Inbox from real pending approval data and complete approve/reject -> server decision -> audit/resume/reject -> realtime confirmation.

## Acceptance
- [ ] [swift] MomoMac build/test green.
- [ ] [runtime] Pending approvals are loaded from server-owned projection or channel history on app start.
- [ ] [runtime] Approve/reject uses `POST /v1/workspaces/{ws}/approvals/{approval}/decision` with idempotency.
- [ ] [runtime/macos-ui] Inbox row status updates from receipt and `approval.decided`; approved deterministic resume emits `tool_result` evidence.
- [ ] [docs] Local gate evidence attached; real external provider writes remain out of scope.

## Depends on
- MOMO-203 Approval pending list/projection + inbox real-data gate
```

## Next Buildable Tickets

| Candidate | Scope | Verification | Unblocks |
|---|---|---|---|
| MOMO-200 | macOS SwiftCentrifuge live adapter: token fetch/refresh, `ch:` + `agent:` subscribe, envelope decode, driver injection into `MomoServerRESTChatBackend`. | `[swift/macos-ui/runtime-relay]` with mock transport tests first, then Docker/Centrifugo live smoke. | MOMO-020 live delivery; improves MOMO-021/022 realtime confirmation. |
| MOMO-201 | D Live Tool-Call fixture/local gate: repo-local mock SSE creates `agent.partial` tool-call progress and final `tool_result`; macOS consumes same event shapes. | `[runtime-agent/macos-ui]` with no real Hermes/provider dependency. | MOMO-020. |
| MOMO-202 | Cost projection contract: server event/read projection for reserve/spent/reconciled/limit state and macOS `CostSnapshot` binding. | `[swift/runtime-agent/macos-ui]`; DB accounting stays server-owned. | MOMO-021. |
| MOMO-203 | Approval pending projection: REST pending list or channel-history projection, macOS inbox initial load, decision receipt + `approval.decided` reconciliation. | `[swift/runtime-db/macos-ui]` with approve/reject/idempotency/RLS evidence. | MOMO-022. |
| MOMO-204 | M3 D/B/C local gate profile: combine REST login/history, live adapter or mock realtime, tool-call/cost/approval fixture, and evidence markdown into one M3 PR gate. | `[docs/swift/runtime-agent/macos-ui]`; may skip external Hermes/provider with explicit `runtime-unverified`. | M3 exit evidence and QA gate input. |

## Decision

MOMO-020/021/022 should not be closed or merged as one large M3 blob. Keep them as experience-level tickets, but only mark them ready after the narrower follow-up blockers above have produced local evidence. This preserves one issue = one PR while avoiding another stale umbrella ticket.
