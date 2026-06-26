# Agent Runtime Roadmap and Methodology

> Updated: 2026-06-25
> Status: roadmap research, not implementation.

## 1. Meta Methodology

Use a four-plane method for every agent integration.

| Plane | Question | Owner |
|---|---|---|
| Context | What may this agent know for this request? | momo Context Broker |
| Capability | What can this agent/plugin do, under which policy? | momo capability registry/cache |
| Execution | How does the runtime stream work and tool calls? | AgentWorker / adapter |
| Ledger | What is recorded for audit, cost, approval, and replay? | Postgres SoT |

An integration is not accepted until all four planes are specified. "The agent can answer" is not enough.

## 2. Technology Selection

### Keep

- Hummingbird 2 + PostgreSQL 18 + Centrifugo v6.
- OpenAI-compatible SSE as v0 outbound execution transport.
- Postgres as SoT for messages, run state, approval, usage, and audit.
- `member.kind='agent'` as identity model.

### Add as specs first

- `Context Packet v0`
- `Memory Plane v0`
- `Capability Cache v0`
- A2A-style task/message/artifact mapping
- Inbound MCP server design

### Avoid

- Copying openclaw or Mattermost code.
- Letting agent runtime memory decide workspace permissions.
- Direct plugin writes without `tool_call -> approval_request -> tool_result -> audit_log`.
- Treating approval as client-only UI state.

## 3. Roadmap Insert

### M1.5 Agent Runtime Spec

| Ticket | Goal | Acceptance |
|---|---|---|
| `MOMO-150` | Research Hermes/Kim Intern/openclaw and document design gaps | `research/11-agent-runtime/*`, roadmap/backlog/status/index updates |
| `MOMO-151` | Context Packet v0 | JSON fixture, source refs, permissions, budget, redactions |
| `MOMO-152` | Memory Plane v0 | typed memory, source attribution, expiry, delete path, RLS visibility |
| `MOMO-153` | Capability Cache v0 | agent/plugin/MCP capability cache, tool schema refs, invalidation, policy/capability versioning |

### M2 Backend Protocol

| Ticket | Goal | Acceptance |
|---|---|---|
| `MOMO-160` | A2A-style `agent_run` lifecycle alignment | mapping for queued/running/input-required/awaiting-approval/succeeded/failed/cancelled |
| `MOMO-161` | Approval pause/resume runtime | canonical spec + worker pause slice; server decision/resume runtime follows |
| `MOMO-162` | Hermes adapter contract verification | platform adapter path and AgentWorker SSE path both tested or one declared canonical |
| `MOMO-163` | Inbound MCP server v0 | governed search/fetch/post/tool surfaces with consent/approval policy |

### M3 UX

| Ticket | Goal | Acceptance |
|---|---|---|
| `MOMO-170` | Agent protocol cards | tool_call, approval, artifact, cost, memory citation, source badge |
| `MOMO-171` | Agent memory inspector | users can view/delete/block memory entries used in context |
| `MOMO-172` | Local LLM context compaction | Foundation Models probe + server fallback, source-preserving summaries |

## 4. Architectural Defaults

- The product default is momo AgentWorker calling Hermes/Kim Intern, not Hermes owning momo.
- Hermes platform adapter remains a compatibility path and dogfood path.
- `Context Packet` is the only way broad context enters an agent runtime.
- `Memory Plane` stores typed, sourced memory only.
- `Capability Cache` is required before broad plugin/MCP tool discovery. Its normative spec is `research/11-agent-runtime/06-capability-cache-v0.md`.
- Approval changes run state; it does not merely display a button. Normative spec: `research/11-agent-runtime/08-approval-pause-resume-runtime.md`.

## 5. Next Goal Recommendation

After MOMO-153, the next implementation-ready split should move into parallel worker goals:

```text
Worker 1: MOMO-160 agent_run lifecycle alignment.
Worker 2: MOMO-170 macOS agent protocol cards.
Worker 3: MOMO-163 inbound MCP server v0 spec/runtime slice.
Worker 4: infra/local gate or plugin fixture hardening.
```

`momo-main` should review/merge/roadmap only while worker threads each claim one issue/worktree.

## 6. Sources

- [Hermes Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- [Hermes platform adapter guide](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters/)
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- [OpenClaw channel plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [A2A protocol specification](https://a2a-protocol.org/latest/specification/)
- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/)
- [OpenAI Agents SDK MCP caching](https://openai.github.io/openai-agents-python/mcp/)
