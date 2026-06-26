# Memory, Cache, and Protocol Gaps

> Updated: 2026-06-25
> Status: roadmap research, not implementation.

## 1. Why This Matters

For an agent-native messenger, memory and cache are not performance details. They decide what the agent is allowed to know, what it can reuse, what it can cite, and whether a team can trust an automated action later.

Existing momo primitives are strong:

- `member.kind='agent'`
- `message.seq` as channel order source of truth
- `agent_run`
- `approval`
- `usage_ledger`
- `budget_window`
- transactional outbox
- RLS tenant boundary

The missing layer is the durable contract between the user's request and the agent's runtime: `Context Packet`, `Memory Plane`, and `Capability Cache`.

## 2. Memory Plane v0

Memory must be typed and permission-aware. Raw chat history should not become long-term memory automatically.

Normative spec: `research/11-agent-runtime/05-memory-plane-v0.md`.

| Type | Meaning | Required provenance |
|---|---|---|
| `decision` | Team/project decision | source message/doc, deciding members, workspace visibility |
| `preference` | User/team preference | subject member/team, source, expiry, delete path |
| `artifact_ref` | PRD, ticket, runbook, file, document | URL/path/provider ID, version/checksum, permission snapshot |
| `task_state` | Issue/PR/run/workflow status | owner, external ID, last checked timestamp |
| `external_source_ref` | Drive/Gmail/Calendar/Obsidian reference | provider, source URL, excerpt, grant |
| `agent_skill_note` | Agent-suggested reusable procedure | author agent, review status, source run |

Permission is checked at retrieval time, not only at write time. If the requesting user cannot see the source, the memory entry cannot enter the context packet.

Every memory entry needs a deletion path:

- user delete for personal preference
- workspace admin delete for workspace memory
- expiry for operational memory
- source revoked -> memory hidden or invalidated

## 3. Capability Cache v0

Agents and plugins expose capability lists that can be expensive to fetch. OpenAI Agents SDK notes that MCP tool lists may be cached when definitions do not change frequently, with explicit invalidation available. Source: [OpenAI Agents SDK MCP caching](https://openai.github.io/openai-agents-python/mcp/).

Normative spec: `research/11-agent-runtime/06-capability-cache-v0.md`.

| Cache | Contents | Invalidation |
|---|---|---|
| `agent_capability` | model, surfaces, supported event types, max context, tool-call support | agent config version, TTL, manual refresh |
| `plugin_tool_schema` | tool/command names, input schemas, risk tags, approval policy | plugin version, connection config version, policy version |
| `mcp_tool_list` | MCP tool names, input schemas, server capability metadata | MCP list-changed notification, TTL, manual refresh |
| `model_pricing` | pricing and cache-read/write token prices | model pricing version |

Cache entries must include `workspace_id`, `visibility`, `source`, `expires_at`, `policy_version`, `capability_version`, and schema/provider revision when applicable.

`context_summary_cache` and `external_source_cache` remain adjacent Context Broker/connector concerns. Capability Cache v0 may reference provider grants and source revisions, but it does not store source bodies or summaries.

## 4. Protocol Baseline

### MCP

MCP is the best fit for inbound tool/context access: external Claude/Codex/Cursor-like clients ask momo for resources, prompts, and tools. MCP uses JSON-RPC 2.0, stateful connections, and capability negotiation; it defines resources, prompts, tools, sampling, roots, and elicitation. Source: [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25).

momo implication:

- MCP server = "external agent reads/acts through momo with user consent."
- MCP must not bypass RLS or plugin approval policy.
- MCP tools should produce the same `tool_call`, `approval_request`, `tool_result`, and `audit_log` records as native flows.

### A2A

A2A is a better semantic reference for agent-to-agent tasks. It defines Agent Cards, task lifecycle, messages, artifacts, streaming events, idempotency, push notifications, and protocol bindings. Source: [A2A protocol specification](https://a2a-protocol.org/latest/specification/).

| A2A concept | momo concept |
|---|---|
| Agent Card | `member.kind='agent'` + capability cache |
| Task | `agent_run` |
| Context identifier | workspace/channel/thread/run context |
| Message | `message` with type-specific props |
| Artifact | `artifact_ref` memory + `message.type='artifact'` |
| Task status update | `agent.status` / `agent.partial` realtime event |
| Input required | `agent_run.status='input_required'` + agent question message |
| Approval required | `approval.status='pending'`, `agent_run.status='awaiting_approval'`, `message.type='approval_request'` |

`input_required` and `awaiting_approval` are deliberately separate. The first asks for more information; the second pauses on a policy-controlled side effect. The lifecycle contract is now `research/11-agent-runtime/07-agent-run-lifecycle-v0.md`.

### OpenAI-Compatible SSE

OpenAI-compatible SSE remains the v0 execution transport because Hermes and Kim Intern can converge on it quickly.

momo should normalize all transports into:

```json
{
  "event": "tool_call",
  "run_id": "...",
  "call_id": "...",
  "name": "github.create_issue",
  "arguments": {},
  "risk": "write",
  "requires_approval": true
}
```

## 5. Approval Pause/Resume Gap

Current worker behavior can parse tool calls and knows that side-effecting actions need approval, but the durable pause/resume flow still needs a ticket.

Required behavior:

1. Agent emits risky `tool_call`.
2. Worker inserts `approval(status='pending')`.
3. Worker writes `message.type='approval_request'`.
4. Worker sets `agent_run.status='awaiting_approval'`.
5. Human approves or rejects.
6. If approved, same run resumes with a `tool_result` or continuation event.
7. If rejected or expired, run ends or requests alternate action.
8. All decisions write `audit_log`.

This turns approval from a pretty card into a protocol checkpoint.

## 6. Design Gaps to Fill

| Gap | Why it matters | Ticket |
|---|---|---|
| Context Packet fixture | Agents need bounded, permission-aware context | `MOMO-151` |
| Memory Plane spec | Prevents raw chat exhaust and unsourced memories | `MOMO-152` |
| Capability Cache spec | Makes agent/plugin/tool discovery fast and auditable | `MOMO-153` |
| A2A lifecycle alignment | Enables future agent-to-agent delegation without rewrites | `MOMO-160` |
| Approval pause/resume | Makes dangerous actions actually governed | `MOMO-161` |
| Hermes contract verification | Confirms real adapter/runtime behavior beyond docs | `MOMO-162` |
| Inbound MCP v0 | Lets external agents use momo as governed context/tool server | `MOMO-163` |

## 7. Sources

- [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [A2A protocol specification](https://a2a-protocol.org/latest/specification/)
- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/)
- [OpenAI Agents SDK MCP caching](https://openai.github.io/openai-agents-python/mcp/)
