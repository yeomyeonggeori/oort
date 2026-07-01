# macOS Agent Protocol Cards v0

> Updated: 2026-06-26
> Status: MOMO-170 UX/spec slice. Runtime DB/wire completion remains in MOMO-132 and MOMO-161.

## 1. Purpose

macOS channel timelines should make agent work inspectable without turning every run into a debugger. The v0 card set renders agent protocol objects as normal timeline messages with compact evidence:

- what the agent is doing,
- which Context Packet bounded the run,
- which Memory Plane refs were used,
- which Capability Cache grant made the tool visible,
- which sources justify the answer or action,
- what the run is estimated to cost or has spent,
- whether a human approval is required before side effects.

The UI is presentation-only. Postgres remains the source of truth, `message.seq` remains the channel order authority, and Centrifugo remains transport. The client never publishes card state directly.

## 2. Timeline Principles

| Principle | macOS behavior |
|---|---|
| Agent work is a first-class message | `tool_call`, `approval_request`, `tool_result`, and `artifact` render as cards inside the same seq-ordered timeline as human messages. |
| Evidence is visible but compact | Cards show source, memory, capability, context, and cost badges; expansion/inspectors are follow-up UI. |
| Source text stays bounded | Cards show titles, provider kind, and stable URIs. Full source bodies stay in Context Packet/source systems. |
| Approval is a checkpoint | Risky writes display an approval card and also appear in Approval Inbox. Runtime pause/resume is MOMO-161. |
| Cost is social signal, not accounting logic | macOS displays integer `micro_usd` from `agent.status`, `usage_ledger`, or card props. It never computes ledger values. |
| Memory is cited, not silently injected | Memory badges cite typed Memory Plane projections, never raw chat exhaust. |

## 3. Card Types

### `tool_call`

Use when an agent proposes or starts a tool/action.

Required display:

- tool name,
- call id when present,
- compact arguments preview,
- Capability Cache badge,
- Context Packet badge,
- source badges,
- memory citations when the call depends on memory,
- estimated cost when known,
- approval requirement if `requires_approval=true`.

Minimum `message.props`:

```json
{
  "name": "github.search_issues",
  "call_id": "call_pg18_search_001",
  "arguments": {},
  "requires_approval": false,
  "context_packet": {},
  "capability": {},
  "source_badges": [],
  "memory_citations": [],
  "estimated_micro_usd": 120000
}
```

### `approval_request`

Use when a run must pause for human confirmation before an external write, elevated scope, irreversible action, or high-cost step.

Required display:

- action type,
- human-readable title/summary,
- risk/source/capability badges,
- estimated cost,
- delegation subject when available in the approval event,
- primary approve/reject controls in Approval Inbox; inline controls are follow-up.

Minimum `message.props`:

```json
{
  "action_type": "github.issue.create",
  "title": "Create rollout checklist issue",
  "summary": "Open a tracked GitHub issue before the agent writes to the repo.",
  "requires_approval": true,
  "context_packet": {},
  "capability": {},
  "source_badges": [],
  "memory_citations": [],
  "estimated_micro_usd": 820000
}
```

### `tool_result`

Use when a tool returns output, an error, or a pointer to a durable artifact.

Required display:

- tool name,
- error/success tone,
- bounded output preview,
- artifact reference when present,
- source badge for provider/system that produced the result,
- spent cost when known.

Minimum `message.props`:

```json
{
  "tool_name": "github.search_issues",
  "call_id": "call_pg18_search_001",
  "is_error": false,
  "output": {},
  "artifact_ref": {},
  "source_badges": [],
  "spent_micro_usd": 51000
}
```

### `artifact`

Use when the agent creates or attaches a durable output: runbook draft, PRD, file, patch, search result set, export, diagram, or provider object.

Required display:

- title,
- artifact kind,
- stable `momo://` or provider URI,
- source badges,
- memory citations if the artifact should become or update `artifact_ref` memory.

Minimum `message.props`:

```json
{
  "artifact_id": "artifact_pg18_runbook_patch",
  "kind": "runbook_draft",
  "title": "PG18 migration runbook patch",
  "uri": "momo://artifacts/pg18-runbook-patch",
  "context_packet": {},
  "source_badges": [],
  "memory_citations": []
}
```

## 4. Shared Metadata Contract

All card props may include these optional objects. The macOS v0 card skeleton renders them as compact badges.

### `context_packet`

Projection from Context Packet v0. This is a UI hint, not the packet body.

```json
{
  "packet_id": "10000000-0000-7000-8000-000000000170",
  "scope": "#feature-pg18",
  "source_count": 2,
  "memory_count": 1
}
```

Source: `research/11-agent-runtime/04-context-packet-v0.md`.

### `capability`

Projection from Capability Cache v0 and the Context Packet `tool_grants` field.

```json
{
  "provider": "github",
  "tool_name": "github.create_issue",
  "risk": "write",
  "approval_policy": "always",
  "input_schema_ref": "momo://capability-cache/github.create_issue/schemas/input/sha256:...",
  "resource_scope_summary": "repo:Dawn-kim-official/momo",
  "capability_version": "github-plugin@0.3.0",
  "policy_version": "capability-policy@2026-06-26"
}
```

Source: `research/11-agent-runtime/06-capability-cache-v0.md`.

### `source_badges`

Compact source attribution from Context Packet `sources`.

```json
[
  {
    "source_id": "src_github_migration",
    "kind": "github",
    "title": "MOMO-001 Runtime Gate",
    "uri": "https://github.com/Dawn-kim-official/momo/issues/1",
    "permission_snapshot": "provider:read repo:momo"
  }
]
```

Cards should show provider kind and title first. URI, permission snapshot, checksum, and retrieved time belong in a future detail popover/inspector.

### `memory_citations`

Projection from Memory Plane v0 `memory_refs`.

```json
[
  {
    "memory_id": "20000000-0000-7000-8000-000000000172",
    "type": "preference",
    "label": "External writes require explicit approval",
    "source_ids": ["src_general_rollout"],
    "permission_snapshot": "actor:read channel:member"
  }
]
```

Cards should show memory type and label. Delete, block, revalidate, and full source drill-down belong to MOMO-171 memory inspector.

### Cost

Cards may carry direct display hints:

- `estimated_micro_usd`
- `reserved_micro_usd`
- `spent_micro_usd`

The live channel header and bubble ring should continue to prefer `agent.status` and `CostSnapshot` where available. Card props are useful for committed result/history messages and offline fixtures.

## 5. MomoMac Impact

Touched surface:

- `MomoMacRootView`: no API change. It still hosts `ChannelListView`, `MessageListView`, and `ApprovalInboxView`.
- `MessageBubble`: structured cards now render a shared metadata strip.
- `LiveChatBackend.seedDemo()`: offline fixture seeds all MOMO-170 card types plus context/source/memory/capability/cost props.
- `MomoMacTests`: fixture contract asserts every card type has Context Packet and source metadata.

No MomoCore schema or server migration is introduced in this slice. The current `Message.props: JSON` surface is sufficient for the offline fixture and v0 renderer.

## 6. Follow-up Boundaries

MOMO-170 does not complete:

- durable DB tables for `agent_request`, `context_packet`, `tool_call`, or `tool_result`,
- approval pause/resume execution semantics,
- source inspector or memory delete/block UI,
- live SwiftCentrifuge transport binding,
- Xcode `.app` packaging or distribution.

Those remain in MOMO-132, MOMO-161, MOMO-171, M3 live data binding, and M4 packaging.
