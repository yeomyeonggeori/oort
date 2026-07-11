# Realtime Client Subscription Contract v0

> Updated: 2026-06-29
> Status: MOMO-179 canonical client realtime contract. Spec + fixtures + narrow Swift payload alignment.
> Verification target: docs local gate + swift local gate. Live SwiftCentrifuge client remains `runtime-unverified`.

## 1. Purpose

MOMO-179 fixes the contract a macOS/iOS client must implement before adding SwiftCentrifuge. The client should not guess token endpoints, channel names, replay semantics, or whether Centrifugo offset is the ordering source.

The v0 rule is simple:

```text
Postgres REST history/send is the source of truth.
Centrifugo is a delivery/cache transport.
Message ordering and replay are keyed by message.seq.
Clients never publish to Centrifugo.
```

## 2. Current Code Boundary

| Slice | Current state | v0 contract |
|---|---|---|
| `MomoCore.ChatBackend` | Already states REST auth/history + SwiftCentrifuge subscribe, `Message.seq` ordering, REST gap-fill. | This remains the shared protocol boundary. |
| `MomoCore.RealtimeEnvelope` / `RealtimeEvent` | Decodes `message.new`, `approval.*`, `agent.status`, `agent.partial`, and other known event types. | Envelope payloads must use the snake_case model keys those types decode. |
| `MomoServerRESTChatBackend` | REST login/history/send/approval only; `subscribe(channel:)` returns an empty stream. | No SwiftCentrifuge dependency in this ticket. Future live backend composes REST + subscription driver. |
| `ChatViewModel.apply` | Upserts by message id or `client_msg_id`, sorts by `Message.seq`, coalesces partials by `run_id`. | Future subscription driver must feed this path only after duplicate/gap/replay checks. |
| `CentrifugoRoutes.subscribe` | Authorizes `ch:`/`dm:` channel subscriptions by workspace/channel membership through subscribe proxy. | Channel subscribe is implementation-ready. Agent namespace auth/token route still needs runtime work. |
| `OutboxRelay` | Publishes outbox `payload.data` verbatim with optional `version=seq` and `idempotency_key`. | Relay does not reshape events; API/worker are responsible for contract shape. |

## 3. Connection And Tokens

Connection sequence:

1. Client authenticates with REST `POST /v1/auth/login` and stores the app access token.
2. Client requests a Centrifugo connection token from `POST /v1/auth/realtime-token` using the app access token.
3. Server returns a short-lived Centrifugo connection JWT:
   - `sub = member_id`
   - `ws = workspace_id` in token `info` or claims
   - `exp <= 30m`
   - optional server-side `channels` only for private `user:` notifications.
4. SwiftCentrifuge connects with that token and refreshes it before expiry.
5. Channel subscriptions are requested by exact channel name. The client does not mint subscription JWTs for normal channel timelines.

Implementation status:

- MOMO-192 implements `POST /v1/auth/realtime-token` on MomoServer. The route is protected by app access JWT auth, re-checks active member state inside tenant RLS, and returns a short-lived Centrifugo connection JWT with `sub=member_id`, `ws=workspace_id`, and JSON `info`.
- Channel authorization remains outside the connection token. Normal `ch:`/`dm:` subscribe attempts still go through `/v1/centrifugo/subscribe`, which checks active channel membership under tenant RLS.
- The current macOS REST backend must continue to work without a realtime token. Its empty `subscribe(channel:)` stream is a compatibility boundary, not a live implementation.

## 4. Channel Names

Clients derive channel names only from authenticated workspace/member/channel identifiers returned by REST. No UI string, channel title, or handle may be used.

| Namespace | Channel name | Subscriber | Authorization |
|---|---|---|---|
| Channel timeline | `ch:ws<workspaceUUID>.<channelUUID>` | Human clients and agents that are active channel members | Centrifugo subscribe proxy calls `POST /v1/centrifugo/subscribe`; server checks `membership.left_at IS NULL` under RLS. |
| DM timeline | `dm:ws<workspaceUUID>.<channelUUID>` | DM members | Same membership rule. |
| Agent progress | `agent:ws<workspaceUUID>.<channelUUID>.<agentMemberUUID>` | Active members of that exact channel when the agent is also active there | Subscribe proxy checks both memberships on every attempt; this prevents progress/tool data crossing channel boundaries. |
| Agent private work | `agentwork:ws<workspaceUUID>.<agentMemberUUID>` | The exact active agent bearer actor only | Gateway jobs are private; human/member observation and direct publish are denied. |
| User private notifications | `user:<memberUUID>` or server-side connection JWT channel | One member | Server-side subscription only; not used for timeline ordering. |

Publish source:

- `ch:` / `dm:` durable timeline events are published only by server transactions through `outbox(kind='broadcast')` and `OutboxRelay`.
- `agent:` progress events may be published by AgentWorker through Centrifugo server API, but they are progress projections only. Final durable messages still flow through Postgres + outbox.
- macOS/iOS clients never call Centrifugo publish.

## 5. Event Envelope

All Centrifugo publication `data` uses:

```json
{
  "type": "message.new",
  "v": 1,
  "ts": 1782463260000,
  "seq": 43,
  "payload": {}
}
```

Rules:

- `type` maps to `RealtimeEnvelope.EventType`.
- `v` is currently `1`; unknown future versions are ignored or routed to telemetry, not force-decoded.
- `ts` is publish/event time in epoch milliseconds.
- `seq` is present for channel timeline events with a committed `message.seq`. It must equal the Centrifugo publish `version`.
- `payload` is type-specific and uses MomoCore snake_case coding keys.

Forward compatibility:

- Unknown `type` means ignore and record debug telemetry.
- Known `type` with malformed payload means do not crash the stream. Mark the subscription unhealthy and fetch REST history if the event is channel-sequenced.

## 6. Event Types v0

| Event | Namespace | `seq` | Core mapping | UI effect |
|---|---|---:|---|---|
| `message.new` | `ch:`/`dm:` | required | `.message(Message)` | Upsert by `message.id` or optimistic `client_msg_id`; sort by `seq`. |
| `message.edited` | `ch:`/`dm:` | required when edit is timeline-sequenced | `.messageEdited(Message)` | Replace existing row by `message.id`. |
| `message.deleted` | `ch:`/`dm:` | optional | `.messageDeleted(MessageID)` | Tombstone local message state. |
| `approval.requested` | `ch:`/`dm:` | required if paired with an approval_request message | `.approval(ApprovalEvent)` | Add/update pending approval inbox by `approval_id`. |
| `approval.decided` | `ch:`/`dm:` | present when decision edits/appends a timeline message | `.approval(ApprovalEvent)` | Reconcile pending card/receipt by `approval_id`. |
| `agent.partial` | `agent:` | absent | `.agentPartial(AgentPartial)` | Coalesce by `run_id`; append `text_delta`; update tool-call fields. |
| `agent.status` | `agent:` | absent | `.agentStatus(AgentStatus)` | Replace latest status by `run_id`; drive cost/presence surfaces. |

`agent.partial` and `agent.status` are not channel-ordering authority. If the client misses them, it should rely on final `message.new`/history to recover durable state.

## 7. Replay, Gap Detection, And Idempotency

Each channel subscription keeps:

```text
lastAppliedSeq[channel_id]: Int64
seenMessageIDs[channel_id]: Set<MessageID>
pendingEvents[channel_id]: min-heap keyed by seq
```

Apply algorithm for channel-sequenced events:

1. Decode envelope.
2. If event has no `seq`, apply only if it is explicitly non-durable/progress; otherwise ignore and refresh history.
3. If `seq <= lastAppliedSeq`, treat as duplicate/replay. Upsert by stable id where useful, but do not advance state.
4. If `seq == lastAppliedSeq + 1`, apply and advance.
5. If `seq > lastAppliedSeq + 1`, buffer the event and call REST `history(channel, after: lastAppliedSeq, limit: 200)`.
6. Apply returned REST messages in ascending `seq` until the gap closes. Repeat while a page is full and the gap remains.
7. Drain buffered events in order.

Duplicate rules:

- `message.new`: idempotent by `message.id`, then by `client_msg_id` for optimistic local echo reconciliation.
- `approval.*`: idempotent by `approval_id`; latest server status wins.
- `agent.partial`: idempotency is best-effort by stream position; clients coalesce by `run_id` and tolerate duplicate text only within the live progress surface. Durable text is recovered from final message history.
- `agent.status`: last event per `run_id` wins; map `phase` to UI animation and `run_status` to durable lifecycle meaning.

## 8. Reconnect And Recovery

Centrifugo recovery is a transport optimization, not a source of truth.

On reconnect/resubscribe:

1. Reconnect with refreshed connection JWT if needed.
2. Resubscribe to the exact channel names for the selected channel and observable agents.
3. If Centrifugo reports recovery success, still keep `lastAppliedSeq` as the authority and apply recovered publications through the same gap logic.
4. If recovery fails, immediately run REST backfill from `lastAppliedSeq`.
5. If REST backfill cannot close a gap after bounded pages, mark the channel degraded and reload newest history from REST.

The macOS UI must never show Centrifugo offset as message order. Offset is useful only to the Centrifugo client library.

## 9. macOS Subscription Boundary

MOMO-179 does not add SwiftCentrifuge. The implementation-ready boundary is:

```text
MomoServerRESTChatBackend
  owns REST login/history/send/approval

Future RealtimeSubscriptionDriver
  owns Centrifugo connect/refresh/subscribe/recovery
  emits decoded RealtimeEvent only after replay checks

ChatViewModel
  remains UI state owner
  applies RealtimeEvent on MainActor
```

The future live backend should not let SwiftCentrifuge code mutate `ChatViewModel` directly. It should implement `ChatBackend.subscribe(channel:) -> AsyncStream<RealtimeEvent>` and feed the existing apply path.

## 10. Fixtures

Fixtures live in `research/11-agent-runtime/fixtures/realtime-client-subscription-contract-v0/`.

| Fixture | Covers |
|---|---|
| `message_new_event.json` | Server/outbox/relay `message.new` with `version=seq`, `idempotency_key`, and snake_case MomoCore payload. |
| `approval_requested_event.json` | Approval request inbox projection on channel timeline. |
| `approval_decided_event.json` | Approval decision reconciliation by `approval_id`. |
| `agent_partial_event.json` | Agent progress/tool-call partial on `agent:` namespace. |
| `agent_status_event.json` | Agent lifecycle/cost status on `agent:` namespace. |
| `gap_backfill_scenario.json` | Duplicate, out-of-order, reconnect, and REST `history(after:)` replay behavior. |

## 11. Runtime Status And Follow-ups

Implementation-ready in this ticket:

- Canonical client contract and fixtures.
- Server `message.new` broadcast payload aligned to MomoCore snake_case decode.
- AgentWorker `agent.status` / `agent.partial` progress payloads aligned to MomoCore decode.
- Documentation pointers in `docs/INDEX.md`, `ROADMAP.md`, `BUILD_TICKETS.md`, and `STATUS.md`.

Still `runtime-unverified`:

- `/v1/auth/realtime-token` endpoint.
- Real SwiftCentrifuge macOS network implementation.
- Agent namespace authorization policy beyond current worker publish channel naming.
- End-to-end reconnect/recovery against a live macOS client.

Suggested follow-ups:

| Follow-up | Scope |
|---|---|
| MOMO-179-R1 | Server realtime-token endpoint + connection JWT refresh tests. |
| MOMO-179-R2 | SwiftCentrifuge `RealtimeSubscriptionDriver` with replay/gap controller. |
| MOMO-179-R3 | Runtime reconnect/recovery local gate with forced dropped publications and REST backfill evidence. |
