# Inbound MCP Server v0

> Updated: 2026-06-26
> Status: normative spec for MOMO-163. No runtime/schema implementation in this ticket.

## 1. Purpose

Inbound MCP Server v0 defines how external agent hosts such as Claude, Codex, Cursor, or a local IDE agent can use oort as a governed tool surface.

It answers four questions:

1. What can an external host read from oort?
2. What can it write back into oort?
3. How do Context Packet, Memory Plane, and Capability Cache constrain that access?
4. How does oort keep approval-safe external actions auditable?

This server is inbound to oort: the host is the MCP client and oort is the MCP server. It is not the canonical agent runtime path, and it does not replace AgentWorker, Hermes, Kim Intern, or the REST message send path.

## 2. Protocol Baseline

The v0 surface follows the Model Context Protocol 2025-06-18 server primitives:

- Tools: model-invoked functions exposed through `tools/list` and `tools/call`.
- Resources: URI-addressed context exposed through `resources/list`, `resources/read`, and resource templates.
- Prompts: user-selectable prompt templates exposed through `prompts/list` and `prompts/get`.

References:

- https://modelcontextprotocol.io/specification/2025-06-18
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
- https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

v0 SHOULD support HTTP transport for remote hosts and MAY support stdio for local developer hosts. HTTP transport uses oort-issued access tokens or OAuth-compatible resource server authorization when that is implemented. Stdio transport may read a token from the environment for local development, but that token still maps to oort `token`, `member`, workspace, channel, and audit policy.

## 3. Non-Negotiable Rules

- Postgres remains the source of truth. The MCP server never publishes directly to Centrifugo.
- All user-facing reads and writes run with `SET LOCAL app.workspace_id` and RLS. BYPASSRLS is forbidden for inbound MCP requests.
- The MCP host never receives database URLs, provider refresh tokens, raw secret values, private cross-channel history, or broad plugin credentials.
- The MCP host is represented by an oort principal: a `member` row for write-capable hosts or a delegated token bound to a member/subject pair.
- A host may not impersonate a human message author. Delegation is recorded through token subject/audit metadata, not hidden author substitution.
- Search and thread fetch return bounded excerpts and source refs, not unbounded transcript dumps.
- Memory Plane retrieval is explicit. Message search results are not durable memory and do not create memory items.
- Capability Cache is discovery evidence, not authorization. Every write-capable tool proposal is rechecked against current policy before approval or execution.
- External writes, spend, deploy, identity, and admin operations are approval-safe: `tool_call -> approval_request -> approval decision -> tool_result -> audit_log`.
- `momo.create_tool_call` does not execute provider tools. It only creates an auditable proposal and approval card.

## 4. v0 Capabilities

During initialization, oort declares server capabilities for tools, resources, and prompts.

```json
{
  "capabilities": {
    "tools": {
      "listChanged": true
    },
    "resources": {
      "subscribe": false,
      "listChanged": true
    },
    "prompts": {
      "listChanged": true
    }
  }
}
```

v0 does not request MCP client-side sampling, roots, or elicitation. Future versions may add elicitation for approval clarification, but approval decisions stay inside oort first-party UI and API.

## 5. Identity and Authorization Model

Inbound MCP authentication resolves into this request context:

```json
{
  "host_id": "claude-desktop",
  "mcp_client_id": "client-123",
  "workspace_id": "uuid",
  "actor_member_id": "uuid",
  "subject_member_id": "uuid-or-null",
  "token_id": "uuid",
  "token_kind": "delegation",
  "scopes": ["mcp.read", "mcp.post", "mcp.tool.propose"],
  "transport": "http"
}
```

Required checks:

1. Token is not expired or revoked.
2. Token workspace matches the request workspace.
3. `actor_member_id` is a current workspace member.
4. If `subject_member_id` is present, token kind is `delegation`, subject is a current workspace member, and the requested scope allows delegation.
5. Channel-scoped operations require actor membership in the target channel.
6. Admin-scoped operations require explicit admin role and are out of v0 minimal surface.
7. All transactions run `SET LOCAL app.workspace_id = <workspace_id>`.

Author rule:

- `post_message` author is the authenticated actor member.
- If the actor is an external host acting for a human subject, the message and audit detail may show "via subject", but `message.author_member_id` remains the actor. Hidden impersonation is forbidden.

## 6. Minimal Tool Surface

v0 exposes exactly four normative tools. Provider/plugin tools are not exported one-by-one to the host. The host asks oort to search, fetch, post, or propose a tool call; oort enforces local policy.

| MCP tool | Risk | Direct side effect | Purpose |
|---|---|---|---|
| `momo.search_messages` | read | none | Search visible channel/thread messages and return bounded citeable results. |
| `momo.fetch_thread` | read | none | Fetch a visible thread with seq ordering, participants, source refs, and optional Context Packet seed data. |
| `momo.post_message` | write | oort timeline only | Post a visible message through the canonical message write path. |
| `momo.create_tool_call` | write/propose | proposal only | Create an approval-safe tool proposal; no external provider execution. |

### `momo.search_messages`

Input:

```json
{
  "workspace_id": "uuid",
  "query": "refund FAQ",
  "channel_ids": ["uuid"],
  "thread_root_message_id": "uuid-or-null",
  "seq_from": 1,
  "seq_to": 500,
  "author_member_ids": ["uuid"],
  "limit": 20,
  "include_deleted": false,
  "include_memory_refs": false
}
```

Rules:

- Requires `mcp.read`.
- Requires `channel_ids` with 1-10 channel UUIDs in v0.
- Requires workspace membership and channel membership for every searched channel before any DB search execution.
- `include_deleted` is always false in v0 unless a future admin-only surface is added.
- Results must be bounded excerpts with `message_id`, `channel_id`, `seq`, `root_id`, `source_id`, and `permission_snapshot`.
- If `include_memory_refs` is true, Memory Plane retrieval gates run separately and return only `memory_refs` projections. Search results themselves are not memory.

Output:

```json
{
  "results": [
    {
      "message_id": "uuid",
      "channel_id": "uuid",
      "seq": 42,
      "root_id": "uuid-or-null",
      "author_member_id": "uuid",
      "type": "text",
      "excerpt": "Bounded matching excerpt.",
      "source_id": "src_msg_42",
      "uri": "momo://workspaces/.../channels/.../messages/...",
      "permission_snapshot": "actor:channel_member;rls:workspace"
    }
  ],
  "redactions": []
}
```

### `momo.fetch_thread`

Input:

```json
{
  "workspace_id": "uuid",
  "channel_id": "uuid",
  "root_message_id": "uuid",
  "seq_from": 1,
  "seq_to": 100,
  "limit": 100,
  "include_context_packet_seed": true
}
```

Rules:

- Requires `mcp.read`.
- Requires actor and target channel membership.
- Returns messages ordered by `message.seq`, not by client time.
- If `include_context_packet_seed` is true, the response may include `request.surface = "api"` seed fields for a future Context Packet, but it is not a full Context Packet until the Context Broker builds one.

### `momo.post_message`

Input:

```json
{
  "workspace_id": "uuid",
  "channel_id": "uuid",
  "root_id": "uuid-or-null",
  "reply_to_id": "uuid-or-null",
  "body": "I found the thread and will draft the summary.",
  "props": {
    "mcp_host": "codex"
  },
  "client_msg_id": "uuid"
}
```

Rules:

- Requires `mcp.post`.
- Uses the canonical message write path: `channel_seq` bump, `message` insert, and `outbox` insert in one transaction.
- Uses `client_msg_id` for retry idempotency.
- Authored by `actor_member_id`.
- Writes `audit_log.action = "mcp.message.posted"`.
- Never publishes directly to Centrifugo.

### `momo.create_tool_call`

Input:

```json
{
  "workspace_id": "uuid",
  "channel_id": "uuid",
  "root_id": "uuid-or-null",
  "context_packet_id": "uuid-or-null",
  "tool_name": "github.create_issue",
  "tool_arguments": {
    "repo": "Dawn-kim-official/momo",
    "title": "Refund FAQ missing"
  },
  "reason": "User asked for a tracked follow-up.",
  "client_msg_id": "uuid"
}
```

Rules:

- Requires `mcp.tool.propose`.
- If `context_packet_id` is present, oort rechecks packet expiry, workspace, actor, channel, and `tool_grants`.
- If no packet is present, oort may build a small `request.surface = "api"` Context Packet before accepting the proposal.
- Tool name and arguments are validated against Capability Cache `schema_ref` and current workspace/provider policy.
- Read-only tools may be proposed, but v0 still records them as oort-visible `tool_call` proposals rather than executing hidden provider calls through MCP.
- Write/spend/deploy/identity/admin tools always create an `approval` row with `status = "pending"` and an `approval_request` message/card.
- The external provider call is not executed by the MCP server. Execution is a later AgentWorker/plugin executor concern after approval.
- Writes `audit_log.action = "mcp.tool_call.proposed"`.

Output:

```json
{
  "tool_call_message_id": "uuid",
  "approval_request_message_id": "uuid",
  "approval_id": "uuid",
  "status": "awaiting_approval",
  "context_packet_id": "uuid",
  "capability_cache_entry_id": "uuid",
  "audit_event_id": "uuid"
}
```

## 7. Resource Candidates

v0 resources are read-only views over governed oort state. They are URI-addressed and must not expose hidden policy internals or credentials.

| Resource template | Meaning |
|---|---|
| `momo://workspaces/{workspace_id}/channels/{channel_id}/messages/{message_id}` | One visible message with bounded body/props. |
| `momo://workspaces/{workspace_id}/channels/{channel_id}/threads/{root_message_id}` | Visible thread view ordered by `message.seq`. |
| `momo://workspaces/{workspace_id}/context-packets/{context_packet_id}` | Context Packet projection if actor can still read it. |
| `momo://workspaces/{workspace_id}/memory/{memory_id}` | Memory Plane projection only; no raw source body. |
| `momo://workspaces/{workspace_id}/capabilities/{cache_entry_id}` | Capability Cache public projection: tool name, risk, schema refs, policy version. |
| `momo://workspaces/{workspace_id}/approvals/{approval_id}` | Approval request state visible in the channel/thread. |

Resource reads write audit events for sensitive resources:

- `mcp.resource.read` for context packets, memory, capability projections, and approvals.
- Simple message/thread reads may be sampled or aggregated in audit to avoid log volume, but denials must always be recorded.

## 8. Prompt Candidates

Prompts are user-controlled templates that help external hosts call the v0 tools safely. They are not hidden system policy.

| Prompt | Arguments | Purpose |
|---|---|---|
| `momo.thread_brief` | `workspace_id`, `channel_id`, `root_message_id` | Fetch a thread, cite sources, and summarize without creating memory. |
| `momo.reply_with_sources` | `workspace_id`, `channel_id`, `goal` | Search/fetch visible messages, cite source ids, then post a draft reply only if user asks. |
| `momo.approval_proposal` | `workspace_id`, `channel_id`, `tool_name`, `reason` | Build a `momo.create_tool_call` proposal with approval-safe wording. |
| `momo.memory_safe_search` | `workspace_id`, `query` | Explain message search versus Memory Plane retrieval and avoid durable-memory creation. |

## 9. Relationship to Context Packet v0

Inbound MCP adds a concrete use for `request.surface = "api"` in Context Packet v0.

Mapping:

| MCP operation | Context Packet relationship |
|---|---|
| `search_messages` | Produces source candidates. Does not itself create a packet unless the host asks to continue into a task. |
| `fetch_thread` | Produces thread source refs and optional packet seed. |
| `post_message` | May cite a prior packet id in `message.props.context_packet_id`, but posting does not require a packet. |
| `create_tool_call` | Requires an unexpired packet with a matching `tool_grant`, or triggers new packet assembly with surface `api`. |

The packet remains immutable for a run. If a host retries after policy changes, oort must rebuild or reject rather than reuse stale grants.

## 10. Relationship to Memory Plane v0

Inbound MCP can retrieve memory only through Memory Plane projection rules:

- Message search is not memory retrieval.
- Thread fetch is not memory retrieval.
- `include_memory_refs` runs the retrieval-time gate from Memory Plane v0.
- Returned memory is a bounded `memory_ref` with source ids, excerpt, delete path, and permission snapshot.
- The MCP server cannot create trusted memory in v0. Future memory write surfaces must go through Memory Plane write-time gates and review policy.

Denials should return `withheld_memory` redactions without revealing hidden channel names, provider paths, or sensitive excerpts.

## 11. Relationship to Capability Cache v0

The inbound MCP server exposes stable oort meta-tools. It does not mirror every plugin/provider capability as an MCP tool.

Capability Cache still controls tool proposals:

1. `momo.create_tool_call` looks up the requested provider/plugin tool in Capability Cache.
2. The cache entry must be valid, not expired, not invalidated, and visible to the actor/channel/surface.
3. The tool input schema validates `tool_arguments`.
4. Resource scope policy admits the requested provider resource.
5. Risk/approval policy decides whether the proposal can be created.
6. Projection evidence is written to audit and linked to the future approval.

MCP `tools/list` for this inbound server should be cached as `mcp_tool_list` too, using source kind `mcp_server` and provider `momo_inbound`. That cache entry is operational evidence for what external hosts could see at a point in time; it is still not a permission grant by itself.

## 12. Approval-Safe Write Principle

There are two write classes in v0:

| Write class | Examples | Gate |
|---|---|---|
| oort timeline write | `momo.post_message` | actor/channel permission + canonical message transaction + audit |
| external action proposal | `momo.create_tool_call` for GitHub/Jira/Drive/etc. | Capability Cache validation + Context Packet grant + pending approval |

`momo.create_tool_call` transaction should create, in order:

1. A proposed `tool_call` timeline message with bounded, redacted arguments.
2. An `approval` row with `status = "pending"` for risky actions.
3. An `approval_request` timeline message/card linked to `approval.id`.
4. Outbox rows for post-commit realtime delivery.
5. An `audit_log` row with actor, subject, token, run/packet id, capability evidence, and idempotency key.

If multiple messages are created in one transaction, oort allocates contiguous `message.seq` values through the `channel_seq` row counter. It still never uses database sequences for channel ordering.

The executor later revalidates:

- approval is approved and not expired;
- actor/subject/token are still valid;
- Context Packet or replacement packet still authorizes the tool;
- Capability Cache policy/schema/resource scope still matches;
- idempotency key has not executed before.

## 13. Audit Events

Future implementation should record these action names in `audit_log.action`:

| Action | When |
|---|---|
| `mcp.session.started` | Authenticated MCP session starts. |
| `mcp.tools.listed` | Host lists the v0 tool surface. |
| `mcp.tool.called` | Any MCP tool call is received. |
| `mcp.search.performed` | `momo.search_messages` returns visible results. |
| `mcp.thread.fetched` | `momo.fetch_thread` returns a visible thread. |
| `mcp.message.posted` | `momo.post_message` commits. |
| `mcp.tool_call.proposed` | `momo.create_tool_call` creates a proposal. |
| `mcp.resource.read` | Host reads context, memory, capability, or approval resources. |
| `mcp.denied` | Any operation fails auth, RLS, membership, policy, schema, or approval checks. |

Audit detail must include ids and policy versions, not raw hidden data or credentials.

## 14. Error Semantics

Use JSON-RPC protocol errors for malformed MCP requests and unknown tools. Use tool execution errors for authorized requests that fail oort policy.

Recommended `structuredContent.error.code` values:

- `momo.auth.token_revoked`
- `momo.auth.scope_missing`
- `momo.rls.workspace_mismatch`
- `momo.channel.not_member`
- `momo.message.not_visible`
- `momo.context_packet.expired`
- `momo.capability.not_projectable`
- `momo.capability.schema_mismatch`
- `momo.approval.required`
- `momo.idempotency.conflict`

The server should avoid leaking whether a hidden workspace/channel/message exists. For authorization failures, prefer "not visible or not found" plus an audit event.

## 15. Forbidden v0 Surface

These are intentionally out of v0:

- Direct provider calls such as `github.create_issue` as MCP tools.
- Direct `tool_result` injection by the host.
- Direct approval decision by the host unless future first-party approval UI binds that user action.
- Workspace/admin export APIs.
- Cross-workspace search.
- Full transcript dump.
- Memory creation/update/delete.
- Capability policy mutation.
- Sampling requests from oort server to MCP client.
- Roots/filesystem access from the host.

## 16. Fixture Index

Fixtures live in `research/11-agent-runtime/fixtures/inbound-mcp-server-v0/`.

| Fixture | Coverage |
|---|---|
| `tools_resources_prompts_snapshot.json` | MCP server capability snapshot, four tools, resource templates, prompts, and audit policy. |
| `approval_safe_tool_call_request.json` | `momo.create_tool_call` request through Context Packet, Capability Cache, approval row, messages, outbox, and audit projection. |

## 17. Follow-Up Implementation Notes

- `MOMO-160` should connect `request.surface = "api"` to `agent_run` and packet lifecycle.
- `MOMO-161` should make `momo.create_tool_call` proposals resumable through the same approval pause/resume runtime.
- `MOMO-170` should render inbound MCP proposed tool calls using the same tool-call and approval cards as native agent runs.
- A future runtime ticket should implement the MCP server with a small, separately testable module and add integration tests for RLS, idempotency, and approval-safe writes.
