# Agent Protocol and Google Workspace Roadmap

> Updated: 2026-06-25
> Status: roadmap research, not implementation.

## 1. Protocol Lessons

oort should borrow interaction patterns from existing chat platforms, but not their responsibility model.

| Platform | Useful lesson | oort decision |
|---|---|---|
| Slack | Agent context management, app governance, streaming UX | Store `context_packet`, `tool_call`, `approval`, `cost`, and `audit` as first-class Postgres records, not app-side ephemera. Sources: [Slack context management](https://docs.slack.dev/ai/agent-context-management/), [Slack governance](https://docs.slack.dev/ai/agent-governance/) |
| Discord | Gateway sequence/resume, slash/message/user commands, interaction verification | Keep Centrifugo as transport but maintain oort-owned `message.seq`, idempotency, and signed interaction/approval protocol. Sources: [Discord Gateway](https://docs.discord.com/developers/events/gateway), [Discord Interactions](https://docs.discord.com/developers/interactions/overview) |
| Telegram | Bots, mini apps, rich messages, broad distribution | Do not claim Telegram-style E2EE for all chats. Use self-hosting, audit, optional E2EE, and local AI privacy as the trust message. Sources: [Telegram FAQ](https://telegram.org/faq), [Telegram Bot API](https://core.telegram.org/bots/api) |
| Mattermost | Deep plugin surface and self-hosted enterprise posture | Do not copy Mattermost code. Use API/UX ideas only. Source builds and enterprise plugins have license constraints. Sources: [Mattermost LICENSE](https://raw.githubusercontent.com/mattermost/mattermost/master/LICENSE.txt), [Mattermost source available plugins](https://developers.mattermost.com/integrate/plugins/source-available-license/) |
| OpenAgents | Agents embedded in daily apps and web UI surfaces | Treat as research input; oort's moat is protocolized execution in the channel timeline. Source: [OpenAgents paper](https://arxiv.org/abs/2310.10634) |

## 2. Agent Protocol v0

The protocol should make agent work inspectable and replayable.

| Object | Purpose | Persistence |
|---|---|---|
| `agent_request` | User intent plus trigger surface: mention, slash command, context action, scheduled trigger | DB row linked to source message |
| `context_packet` | Bounded, permission-aware packet assembled by Context Broker | DB JSONB with source refs |
| `tool_call` | Proposed or running external action | Timeline message/card plus DB row |
| `approval_request` | Explicit human gate for risky writes or expensive work | Timeline card and audit event |
| `tool_result` | External action result, error, or partial output | Timeline message/card |
| `usage_ledger` | Cost, tokens, model, reserve/reconcile | Existing budget/cost tables |
| `audit_log` | Who/what/why/when for user, agent, plugin, external system | Append-only operational log |

The wire format should be stable enough for macOS/iOS cards, server APIs, AgentWorker, and plugins to share the same semantics.

## 3. Invocation Surfaces

Keep the surface set small:

- `@agent`: conversational participation as `member.kind='agent'`.
- `/command`: structured plugin command, e.g. create ticket, search docs, request HR approval.
- Message context action: turn a message/thread into a ticket, document, task, or decision.
- Approval card: required before external writes, elevated scopes, or high-cost work.

Rules:

- A plugin is not automatically a channel member. It becomes `member.kind='agent'` only when it needs conversational presence.
- Every external write follows `tool_call -> approval_request -> tool_result -> audit_log`.
- Reads may still need user-visible source disclosure when they pull from external providers.

## 4. Google Workspace Connector v0

Google Workspace matters because most users already run work through Gmail, Drive, Calendar, Docs, and Meet. oort should make that existing work available to agents without forcing immediate migration.

Source facts:

- Google provides Workspace MCP server documentation in Developer Preview: [Configure MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers).
- Domain-wide delegation is powerful but admin-heavy: [Delegating domain-wide authority](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority).
- Drive supports changes collection/start page token flows: [Manage changes](https://developers.google.com/workspace/drive/api/guides/manage-changes).
- Gmail supports push notifications for mailbox changes: [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push).

v0 product path:

1. Per-user OAuth first.
2. Read-mostly sync:
   - Drive metadata, selected file excerpts, source URL, permission snapshot.
   - Gmail search/thread read for user-approved scopes.
   - Calendar availability/events read.
3. No broad full-content mirror by default.
4. Writes require approval cards:
   - Gmail draft/send.
   - Calendar create/update.
   - Drive upload/share/permission changes.
5. Domain-wide delegation becomes an enterprise option after admin trust work.

## 5. Context Packet with Workspace Sources

When Google Workspace is enabled, the Context Broker should pass references, not unbounded raw data:

```json
{
  "sources": [
    {
      "kind": "google_drive",
      "provider_id": "drive-file-id",
      "title": "Q3 hiring plan",
      "url": "https://docs.google.com/...",
      "excerpt": "approved headcount is...",
      "permission_snapshot": "user:read",
      "retrieved_at": "2026-06-25T00:00:00Z"
    }
  ]
}
```

This keeps answers citeable and lets agents explain why a source was used.

## 6. Roadmap Tickets

- `MOMO-120`: Context Packet v0 spec and fixtures.
- `MOMO-121`: Memory Plane v0 spec and permission model.
- `MOMO-122`: Google Workspace connector v0, per-user OAuth and read-mostly sync.
- `MOMO-123`: Domain-wide delegation and admin install design.
- `MOMO-132`: Agent Protocol v0 DB/wire/Swift/card alignment.
- `MOMO-133`: "Ask my work" UX with source citations.

## 7. Anti-goals

- Do not build a generic chat bot layer where each integration invents its own cards.
- Do not sync private external content into oort without source, scope, and delete controls.
- Do not make "agent did it" an audit answer. The actor, subject, approver, plugin, model, cost, and source must be visible.
