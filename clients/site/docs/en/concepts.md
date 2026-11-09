---
title: Concepts
description: What workspaces, members, agents, channels and approval cards are, and how they fit together.
status: done
checked: 2026-11-09
sources:
- schema_v0.sql
- AGENTS.md
- docs/architecture/overview.md
- server-rust/crates/momo-messaging/src/message.rs
- server-rust/bins/momo-server/src/dto.rs
- server-rust/bins/momo-server/src/routes/approvals.rs
- packages/momo-core/src/features/agents/channelPlacement.ts
- server-rust/crates/momo-db/src/tenant.rs
---

## Workspace

The space one team works in. People, agents, channels and messages all belong to a workspace. One server can hold several workspaces, and the database keeps their data apart. How it does that is under [Security](/docs/en/security/#workspaces-are-kept-apart).

## Member

Anyone who has joined a workspace. A member is either a person (`human`) or an agent (`agent`). Both sit on the same roster, send messages through the same API and follow the same data rules. Approving, though, is for people only.

## Agent member

An agent is not a bot that only posts through a webhook. It is created as a member, and you can call it in a channel only after it has been added to that channel. An agent that is in no channel still appears on the roster, but it does not answer.

Mention it with `@handle` in a channel and its run starts; progress and results show up in the same channel. What an agent writes is stored the same way as what people write. How to connect one is in [Connecting agents](/docs/en/agents/).

## Channels and messages

A channel is a room where members talk. Each message gets a number (`seq`) that goes up by one per channel with no gaps, and that number sets the order.

The sender attaches a `clientMsgId` to every message. If a message is sent again after a dropped connection, the same value means it is stored only once.

Messages are more than text.

| Type | Used for |
|---|---|
| `text` | What people and agents write |
| `tool_call`, `tool_result` | An agent's tool call and its result |
| `diff`, `artifact` | Changes and results |
| `approval_request` | An approval card |
| `system` | Notices from the server |

## Approvals are cards in the conversation

When an agent wants to do something that needs permission, an approval request appears in the conversation as a card. A person who is in that channel approves or declines it on the card.

- Agents cannot approve anything, including their own requests.
- A decided request cannot be decided again. Sending the same decision again returns the original result.
- A request that passes its deadline closes as expired, and its run ends as timed out.

## The server is the source of truth

Every record lives first in the PostgreSQL database on your server. When a message is sent, the server bumps the channel number, stores the message and queues what needs to go out (the outbox), all in one transaction. A relay then hands that queue to the realtime server (Centrifugo).

The realtime server only delivers. It is not where history or permissions live, and neither the apps nor the agents write to it directly.
