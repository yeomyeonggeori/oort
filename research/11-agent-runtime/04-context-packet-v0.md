# Context Packet v0

> Updated: 2026-06-25
> Status: normative spec for MOMO-151. No runtime/schema implementation in this ticket.

## 1. Purpose

Context Packet v0 is the single bounded object momo gives to an agent runtime for one request. It answers one question:

> What is this agent allowed to know and do for this run, and why?

The packet is assembled by momo, not by Hermes, Kim Intern, a plugin, or a client. Agent runtimes may keep their own session memory, but momo only trusts context that passed through this packet contract.

## 2. Non-Negotiable Rules

- A packet is built after workspace membership, channel membership, RLS, plugin policy, source grants, budget policy, and redaction rules are checked.
- Every fact that is not user input must have a source reference.
- Memory entries are references with excerpts, not raw chat exhaust.
- External sources such as Google Drive, Gmail, Calendar, Obsidian, Notion, or Confluence enter as citeable refs with permission snapshots.
- Tool grants are scoped per packet. A runtime cannot infer broader plugin access from past runs.
- Dangerous writes are pause points: `tool_call -> approval_request -> tool_result -> audit_log`.
- Packet content is immutable for a run. If policy/source visibility changes, momo creates a new packet or blocks/resumes with a new packet reference.

## 3. Top-Level Shape

All fields use snake_case JSON. IDs are UUID strings unless noted.

```json
{
  "schema": "momo.context_packet.v0",
  "packet_id": "uuid",
  "packet_version": 1,
  "created_at": "RFC3339",
  "expires_at": "RFC3339",
  "workspace": {},
  "request": {},
  "scope": {},
  "goal": {},
  "participants": [],
  "recent_messages": [],
  "memory_refs": [],
  "sources": [],
  "tool_grants": [],
  "budget": {},
  "redactions": [],
  "runtime_envelope": {},
  "audit": {}
}
```

### Required Fields

| Field | Meaning |
|---|---|
| `schema` | Literal `momo.context_packet.v0`. |
| `packet_id` | Stable id used by `agent_run.context_packet_id` in future implementation. |
| `packet_version` | Integer schema version. v0 fixtures use `1` for the first JSON shape. |
| `created_at` / `expires_at` | Packet validity. Long-running runs must refresh when expired. |
| `workspace` | Tenant root: `workspace_id`, slug, display name. |
| `request` | Trigger surface, actor, target agent, idempotency key, raw user intent. |
| `scope` | Channel/thread/window and permission basis used to select context. |
| `goal` | Normalized task, constraints, desired output, and explicit non-goals. |
| `participants` | Actor, agent, and selected visible members relevant to the run. |
| `recent_messages` | Bounded channel/thread messages with seq and source refs. |
| `memory_refs` | Typed, permission-checked memory excerpts. |
| `sources` | External or internal artifacts used as evidence. |
| `tool_grants` | Tools the agent may propose/use in this run and their approval policy. |
| `budget` | Token/cost/model envelope and approval thresholds. |
| `redactions` | Redactions applied and context withheld because of policy. |
| `runtime_envelope` | How AgentWorker should pass the packet to Hermes/Kim Intern/OpenAI-compatible SSE. |
| `audit` | Policy, grant, and source versions used to build the packet. |

## 4. Request

`request.surface` is one of:

| Surface | Meaning |
|---|---|
| `mention` | Human mentions an agent member in a channel/thread. |
| `slash_command` | Human invokes a plugin/agent command. |
| `message_context_action` | Human acts on a message or thread, such as "create ticket" or "summarize decision". |
| `scheduled_trigger` | Future surface for approved recurring work. |
| `api` | Future surface for inbound MCP/API calls. |

Required request fields:

- `request_id`: momo-generated request id.
- `surface`: one of the values above.
- `actor_member_id`: human or service member initiating the request.
- `agent_member_id`: target agent member.
- `channel_id`: channel where the run is visible.
- `trigger_message_id`: source message for mention/context actions when present.
- `idempotency_key`: stable key for retry dedupe.
- `raw_text`: original user-visible instruction when present.
- `normalized_intent`: short normalized intent used by routing and audit.
- `client_context`: optional client info such as platform and app version. No secrets.

## 5. Scope

`scope` records what momo checked before including context.

Required scope fields:

- `workspace_id`
- `channel_id`
- `thread_root_message_id`
- `visibility`: `channel`, `thread`, `dm`, or `admin`.
- `seq_window`: `{ "from": number, "to": number, "reason": string }`
- `permission_basis`: array of checks such as `workspace_member`, `channel_member`, `source_grant`, `tool_policy`.
- `rls_context`: `{ "set_local_workspace_id": "uuid" }`

The packet must not include data from another workspace or a channel the actor cannot read.

## 6. Goal

The goal object turns chat text into an auditable task contract.

Required fields:

- `summary`: one-line task.
- `user_prompt`: the exact prompt after redaction.
- `constraints`: hard requirements.
- `desired_outputs`: e.g. `timeline_reply`, `ticket_draft`, `approval_request`, `artifact_ref`.
- `non_goals`: scope boundaries.
- `acceptance_hint`: optional user-visible success criteria for the run.

## 7. Sources and Attribution

Each source must be citeable.

```json
{
  "source_id": "src_001",
  "kind": "message",
  "title": "Message #42 in #launch",
  "uri": "momo://workspaces/.../channels/.../messages/...",
  "workspace_id": "uuid",
  "permission_snapshot": "actor:read",
  "retrieved_at": "2026-06-25T09:00:00Z",
  "excerpt": "Short bounded excerpt",
  "checksum": "sha256:optional"
}
```

Allowed `kind` values for v0 fixtures:

- `message`
- `thread`
- `google_drive`
- `gmail`
- `calendar`
- `obsidian`
- `github`
- `jira`
- `notion`
- `confluence`
- `local_file_ref`

For external systems, the URI should be a provider URL or stable provider id. momo should store enough metadata to cite and revalidate, not a broad copy of the external system.

## 8. Memory References

Memory reference backing rules are defined by `research/11-agent-runtime/05-memory-plane-v0.md`. Context Packet only carries bounded, permission-checked projections; it does not inline full memory records, raw transcripts, hidden permission state, or provider credentials.

Memory is typed and permission-aware. `memory_refs` may contain:

- `decision`
- `preference`
- `artifact_ref`
- `task_state`
- `external_source_ref`
- `agent_skill_note`

Required fields:

- `memory_id`
- `type`
- `visibility`: `personal`, `channel`, `workspace`, or `admin`.
- `source_ids`: source refs proving the memory.
- `excerpt`
- `reason_included`
- `expires_at`
- `delete_path`
- `permission_snapshot`

Forbidden:

- Unsourced memories.
- Cross-channel memories invisible to the actor.
- Raw chat transcript promoted to memory.
- Agent runtime memory without source import.

## 9. Tool Grants

`tool_grants` are per-run capabilities. They do not grant permanent plugin access.

Capability discovery, schema refs, TTL, invalidation, and policy/capability versioning are defined by `research/11-agent-runtime/06-capability-cache-v0.md`. Context Packet only carries bounded projections from that cache after workspace, channel, provider grant, plugin policy, risk, and approval checks pass.

```json
{
  "tool_name": "github.create_issue",
  "provider": "github",
  "grant": "propose",
  "risk": "write",
  "approval_policy": "always",
  "allowed_operations": ["create_issue"],
  "denied_operations": ["delete_repo"],
  "input_schema_ref": "momo://capability-cache/github.create_issue/schemas/input/sha256:githubcreateissuev3",
  "resource_scope_ref": "momo://capability-cache/github.create_issue/resource-scopes/sha256:githubrepoallowmomo",
  "resource_scope_summary": "repository_allowlist:Dawn-kim-official/momo",
  "capability_version": "github-plugin@0.3.0",
  "policy_version": "capability-policy@2026-06-26"
}
```

`resource_scope_ref` is required when the tool input schema is broader than the resource scope admitted by workspace/provider policy. The agent may cite the summary in a proposal, but execution must recheck the referenced scope before approval or tool execution.

`grant` values:

- `read`: runtime may call directly if the provider grant is valid.
- `propose`: runtime may emit a `tool_call`, but execution waits for approval.
- `deny`: runtime may explain that the action is unavailable.

`risk` values:

- `read`
- `write`
- `spend`
- `deploy`
- `identity`
- `admin`

If a cached capability is expired, invalidated, or policy-incompatible, the packet must omit the tool grant and may include a `withheld_tool` redaction without exposing hidden schemas, provider grants, or credentials.

## 10. Budget

Budget controls are part of context. They affect routing, local/server model choice, and approval.

Required fields:

- `budget_id`
- `model_route`: `local`, `server`, or `hybrid`.
- `max_prompt_tokens`
- `max_completion_tokens`
- `reserved_micro_usd`
- `soft_limit_micro_usd`
- `hard_limit_micro_usd`
- `approval_required_over_micro_usd`
- `usage_ledger_mode`: `reserve_reconcile`

Lightweight local LLM compaction can happen before the packet is built, but summaries must preserve source ids.

## 11. Redactions and Withheld Context

Redactions must be explicit.

```json
{
  "redaction_id": "red_001",
  "kind": "pii_email",
  "placeholder": "[redacted-email-1]",
  "applied_to": ["recent_messages[2].body"],
  "reason": "default_pii_policy"
}
```

Withheld context is also explicit:

```json
{
  "redaction_id": "withheld_001",
  "kind": "withheld_source",
  "applied_to": ["sources"],
  "reason": "actor_lacks_channel_membership",
  "source_hint": "private-finance-thread"
}
```

## 12. Runtime Envelope

AgentWorker should pass the packet through an OpenAI-compatible SSE request without giving the runtime direct DB or provider credentials.

```json
{
  "transport": "openai_chat_completions_sse",
  "endpoint": "/v1/chat/completions",
  "stream": true,
  "metadata": {
    "workspace_id": "uuid",
    "channel_id": "uuid",
    "run_id": "uuid",
    "context_packet_id": "uuid",
    "idempotency_key": "uuid"
  },
  "messages_strategy": "system_summary_plus_context_json",
  "forbidden_runtime_inputs": [
    "database_url",
    "provider_refresh_token",
    "raw_cross_channel_history",
    "unredacted_secret"
  ]
}
```

Hermes and Kim Intern should receive the same envelope shape. Hermes platform-adapter compatibility remains separate from the canonical momo AgentWorker path.

## 13. OpenClaw Approval Lesson

openclaw's split between availability, presentation, transport, interactions, and observe maps to momo as:

| Concern | momo owner |
|---|---|
| Availability | tool grant and policy checks in Context Broker |
| Presentation | macOS/iOS approval card renderers |
| Transport | Centrifugo events after Postgres commit |
| Interactions | server approval decision endpoints |
| Observe | `agent_run`, `approval`, `audit_log`, and timeline messages |

The packet controls availability. Clients only render the resulting cards.

## 14. Forbidden Fields

A Context Packet must not contain:

- `.env`, tokens, cookies, private keys, OAuth refresh tokens, or database URLs.
- Rows selected through BYPASSRLS.
- Messages hidden by tombstone/delete policy.
- Private DM/thread content not visible to the actor.
- Raw Google/Gmail/Drive full bodies unless the source grant and packet scope explicitly allow the excerpt.
- Runtime-private memory that lacks source ids and permission snapshots.
- A plugin's broad admin credentials.

## 15. Fixture Index

Fixtures live in `research/11-agent-runtime/fixtures/context-packet-v0/`.

| Fixture | Surface | Coverage |
|---|---|---|
| `mention_thread_summary.json` | `mention` | Thread window, Google Drive source ref, decision memory, read/write tool grants, PII redaction. |
| `slash_ticket_create.json` | `slash_command` | Structured command args, task state memory, Jira-like write proposal, budget threshold. |
| `message_context_action_erm.json` | `message_context_action` | Selected message, ERM workflow proposal, withheld source due permission, approval-required write. |

## 16. Follow-Up Implementation Notes

- `MOMO-152` turns `memory_refs` into the Memory Plane spec at `research/11-agent-runtime/05-memory-plane-v0.md`.
- `MOMO-153` turns `tool_grants.input_schema_ref`, policy/capability versions, TTL, and invalidation into the Capability Cache spec at `research/11-agent-runtime/06-capability-cache-v0.md`.
- `MOMO-160` should map `context_packet_id` into `agent_run` lifecycle and A2A task semantics.
- `MOMO-161` should implement pause/resume for `approval_policy != "none"`.
- `MOMO-172` should require local LLM summaries to retain `source_ids`.
