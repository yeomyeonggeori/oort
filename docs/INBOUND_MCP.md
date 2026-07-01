# Inbound MCP v0 Runtime Skeleton

> Status: MOMO-172 / GitHub #80 skeleton. Compile verified; runtime e2e is `runtime-unverified`.
> Normative spec: [`research/11-agent-runtime/09-inbound-mcp-server-v0.md`](../research/11-agent-runtime/09-inbound-mcp-server-v0.md).

This document describes the server-side runtime shape added after the MOMO-163 spec/fixture ticket.
It is not a complete MCP JSON-RPC server yet. The current code is a spec-to-code bridge inside
`MomoServer` that fixes the tool descriptors, mounts Hummingbird routes, and enforces the shared
auth/RLS preflight before returning a compile-safe stub result.

## Endpoints

All endpoints are under the existing app JWT `Authorization: Bearer <token>` middleware:

| Method | Path | Purpose | Runtime status |
|---|---|---|---|
| `GET` | `/v1/mcp` | Discovery snapshot: server capabilities, tools, resources, prompts, audit policy | compile-safe |
| `GET` | `/v1/mcp/tools` | Tool descriptor list only | compile-safe |
| `POST` | `/v1/mcp/tools/call` | HTTP-shaped tool call preflight + stub response | `runtime-unverified` |

`POST /v1/mcp/tools/call` accepts:

```json
{
  "name": "momo.search_messages",
  "arguments": {
    "workspace_id": "00000000-0000-7000-8000-000000000001",
    "channel_ids": ["00000000-0000-7000-8000-000000000010"],
    "query": "refund FAQ",
    "limit": 20
  },
  "idempotency_key": "optional-host-key"
}
```

The response currently uses an MCP-like tool result envelope with `isError=true` and
`structuredContent.error.code = "momo.mcp.runtime_stub"`. This is intentional until the full MCP
transport and tool execution are implemented.

## Tool Surface

MOMO-172 fixes the same four tools from MOMO-163 in compiled Swift descriptors:

| Tool | Required scope | Side effect | Current implementation |
|---|---|---|---|
| `momo.search_messages` | `mcp.read` | none | auth/RLS/member preflight + stub |
| `momo.fetch_thread` | `mcp.read` | none | auth/RLS/member/channel preflight + stub |
| `momo.post_message` | `mcp.post` | momo timeline only | preflight + stub; must later reuse the canonical message tx |
| `momo.create_tool_call` | `mcp.tool.propose` | proposal only | preflight + stub; must later create approval-safe rows |

The server also exposes the resource template and prompt descriptors from the MOMO-163 discovery
fixture. Provider/plugin tools are not mirrored directly as inbound MCP tools. In v0,
`momo.search_messages` requires an explicit `channel_ids` array with 1-10 channel UUIDs; the server
checks active membership for every listed channel before any search execution.

## Security Model

Inbound MCP actions are never BYPASSRLS paths. Each tool call preflight does the following before
returning the stub result:

1. Requires a valid app access JWT via `AuthMiddleware`.
2. Requires at least one `mcp.*` scope for discovery/list and the exact tool scope for calls.
3. Requires `arguments.workspace_id` to match the JWT `ws` claim.
4. Runs DB checks through `Database.withTenantConnection`, which sets `SET LOCAL app.workspace_id`.
5. Verifies the actor `member` is active in the workspace.
6. Verifies channel membership for channel-scoped operations.

Current `POST /v1/auth/login` does not issue `mcp.*` scopes. Until OAuth/admin install exists, MCP
tokens must be provisioned out of band or by a future dedicated install flow. That is deliberate:
missing MCP scope fails closed.

## Permission And Audit Model

The descriptor policy is code, not only prose:

- `momo.post_message` declares `canonical_write_path = "channel_seq_bump_message_insert_outbox_insert"`.
- `momo.create_tool_call` declares `executes_provider_tool = false` and writes
  `message:tool_call`, `approval`, `message:approval_request`, `outbox`, and `audit_log`.
- Every descriptor carries `requires_rls`, `requires_channel_membership`, `required_scopes`, and
  a future `audit_action`.

Future implementation must write the audit events listed in the MOMO-163 spec, including
`mcp.tools.listed`, `mcp.tool.called`, `mcp.search.performed`, `mcp.thread.fetched`,
`mcp.message.posted`, `mcp.tool_call.proposed`, `mcp.resource.read`, and `mcp.denied`.

## Follow-Up Runtime Work

- Replace the HTTP-shaped route with real MCP JSON-RPC HTTP transport.
- Reuse the canonical message write path for `momo.post_message`.
- Implement `momo.create_tool_call` as a single transaction that creates `tool_call`,
  `approval_request`, outbox, and audit rows without executing provider tools.
- Add RLS/idempotency integration tests with PostgreSQL.
- Add OAuth/admin install and dedicated MCP token provisioning.
