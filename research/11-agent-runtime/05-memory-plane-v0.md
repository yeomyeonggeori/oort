# Memory Plane v0

> Updated: 2026-06-26
> Status: normative spec for MOMO-152. No runtime/schema implementation in this ticket.

## 1. Purpose

Memory Plane v0 defines how momo stores and retrieves long-term memory for agents without turning chat history into uncontrolled surveillance exhaust.

It answers four questions:

1. What is durable enough to become memory?
2. Which source proves it?
3. Who is allowed to retrieve it for a future Context Packet?
4. How can it expire, be hidden, or be deleted?

Memory Plane is owned by momo, not by Hermes, Kim Intern, openclaw, a plugin, or a client. Agent runtime memory may exist, but it is not trusted context until momo imports it as a typed, sourced, permission-checked memory item.

## 2. Non-Negotiable Rules

- Raw chat transcript is not long-term memory.
- Every memory item has `workspace_id`, `memory_type`, `visibility`, `source_refs`, `expires_at` or an explicit `retention_policy`, and `delete_path`.
- Every memory item is checked again at retrieval time before it can enter a Context Packet.
- If the actor cannot read every required source, the memory item must not be included.
- Source revocation, channel membership loss, external grant loss, expiry, deletion, or policy version change can hide or invalidate memory.
- Local LLM compaction may propose memory candidates, but it cannot create trusted memory without source ids and policy checks.
- Agent runtime private memory is advisory only. It must never bypass workspace, channel, source, or plugin policy.
- BYPASSRLS is not allowed in user-facing memory retrieval. Future memory workers are not BYPASSRLS actors by default; adding one requires an explicit contract change. Broad scans may write candidate or invalidation state only, and Context Packet inclusion still runs through normal workspace/RLS checks.

## 3. Relationship to Context Packet v0

Context Packet v0 carries `memory_refs`. Memory Plane v0 defines the backing model and retrieval rules for those refs.

Projection from memory item to Context Packet memory ref:

| Memory Plane field | Context Packet `memory_refs` field |
|---|---|
| `memory_id` | `memory_id` |
| `memory_type` | `type` |
| `visibility.scope` | `visibility` |
| `source_refs[].source_id` | `source_ids` |
| `statement.summary` or bounded excerpt | `excerpt` |
| retrieval decision reason | `reason_included` |
| `validity.expires_at` | `expires_at` |
| `lifecycle.delete_path` | `delete_path` |
| retrieval permission snapshot | `permission_snapshot` |

A Context Packet must include only the projected, bounded ref. It must not inline a full memory record, raw source body, hidden permission state, or provider credential.

Memory Plane fixtures may show a partial projection with `schema = "momo.context_packet.memory_refs_projection.v0"`. That shape is not a full Context Packet; it contains only the `packet_id`, projected `memory_refs`, and optional memory redactions used to prove how Memory Plane feeds Context Packet v0.

## 4. Memory Item Shape

All fields use snake_case JSON. IDs are UUID strings unless noted.

```json
{
  "schema": "momo.memory_item.v0",
  "memory_id": "uuid",
  "memory_type": "decision",
  "workspace_id": "uuid",
  "subject": {},
  "statement": {},
  "visibility": {},
  "source_refs": [],
  "permissions": {},
  "validity": {},
  "lifecycle": {},
  "quality": {},
  "audit": {}
}
```

Required top-level fields:

| Field | Meaning |
|---|---|
| `schema` | Literal `momo.memory_item.v0`. |
| `memory_id` | Stable memory id. |
| `memory_type` | One of the v0 memory types in section 5. |
| `workspace_id` | Tenant root. Required for RLS and audit. |
| `subject` | The thing this memory is about: member, channel, project, artifact, task, source, or agent skill. |
| `statement` | Bounded human-readable memory statement plus optional structured value. |
| `visibility` | Retrieval scope and required memberships/grants. |
| `source_refs` | Evidence used to create the memory. |
| `permissions` | Creation and retrieval policy snapshot. |
| `validity` | Expiry, staleness, and revalidation rules. |
| `lifecycle` | Deletion, revocation, invalidation, and tombstone rules. |
| `quality` | Confidence, review status, and compaction metadata. |
| `audit` | Creator, reviewer, policy versions, and event ids. |

## 5. Memory Types

v0 has exactly six memory types.

| Type | Meaning | Typical source | Default retention | Default visibility |
|---|---|---|---|---|
| `decision` | A team/project decision that should guide future work. | channel/thread message, meeting notes, approval result | until superseded or deleted | channel or workspace |
| `preference` | User/team preference for style, tools, routing, or working norms. | explicit user statement, settings screen, reviewed agent suggestion | 180 days unless renewed | personal, channel, or workspace |
| `artifact_ref` | Reference to a durable artifact such as PRD, ticket, PR, runbook, file, or generated output. | source URL/path/provider id, message artifact, tool result | follows artifact lifecycle | channel or workspace |
| `task_state` | Current state of an issue, PR, agent run, workflow, or approval process. | tool result, external sync, agent run state | short TTL, usually hours/days | channel or workspace |
| `external_source_ref` | Permission-checked reference to Drive, Gmail, Calendar, Obsidian, Notion, Confluence, or local file metadata/excerpt. | connector sync, user attach, source picker | provider token/change-based | personal, channel, or workspace |
| `agent_skill_note` | Reusable procedure learned by an agent, visible only after review or explicit opt-in. | agent run, human review, tool success/failure | 90 days unless promoted | agent/private, channel, or workspace |

Forbidden memory types in v0:

- `raw_transcript`
- `user_profile_full`
- `email_dump`
- `drive_dump`
- `secret`
- `credential`
- `unbounded_summary`

## 6. Subject Model

`subject.kind` is one of:

- `member`
- `channel`
- `thread`
- `workspace`
- `project`
- `artifact`
- `task`
- `external_source`
- `agent_skill`

Examples:

```json
{
  "kind": "project",
  "project_key": "launch-2026",
  "display_name": "Launch 2026"
}
```

```json
{
  "kind": "member",
  "member_id": "uuid",
  "member_kind": "human"
}
```

## 7. Statement Model

`statement` is the memory payload. It must be bounded and explainable.

Required fields:

- `summary`: short sentence fit for Context Packet projection.
- `body`: optional longer bounded note. Do not store full transcript.
- `structured`: optional typed fields for machine use.
- `language`: BCP-47 tag such as `en` or `ko`.
- `source_quote_policy`: `excerpt_only`, `no_quote`, or `provider_link_only`.

`statement.body` should be short enough to fit into a Context Packet only as an excerpt. Large artifacts must be `artifact_ref` or `external_source_ref`, not copied into memory.

## 8. Source Attribution

Every memory item needs at least one source ref.

```json
{
  "source_id": "src_001",
  "source_kind": "message",
  "uri": "momo://workspaces/.../channels/.../messages/...",
  "workspace_id": "uuid",
  "channel_id": "uuid",
  "message_id": "uuid",
  "seq": 42,
  "permission_snapshot": "actor:read channel:member",
  "retrieved_at": "2026-06-26T09:00:00Z",
  "excerpt": "Bounded excerpt used to justify memory.",
  "checksum": "sha256:optional"
}
```

Allowed `source_kind` values for v0:

- `message`
- `thread`
- `approval`
- `tool_result`
- `agent_run`
- `google_drive`
- `gmail`
- `calendar`
- `obsidian`
- `github`
- `jira`
- `notion`
- `confluence`
- `local_file_ref`

Source refs are not credentials. They are citeable pointers plus bounded excerpts and permission snapshots.

## 9. Visibility Model

`visibility.scope` is one of:

| Scope | Meaning | Retrieval requirement |
|---|---|---|
| `personal` | Memory for one human member. | actor is subject member or an explicitly delegated agent running for that member. |
| `channel` | Memory visible in a channel/thread. | actor and target agent are current channel members, and source refs remain visible. |
| `workspace` | Workspace-wide memory. | actor is workspace member and sources are workspace-visible or separately granted. |
| `admin` | Admin-only operational memory. | actor has platform/workspace admin role and the request surface permits admin context. |

Required visibility fields:

- `scope`
- `workspace_id`
- `channel_id` when scope is `channel`
- `subject_member_id` when scope is `personal`
- `required_roles`: optional roles such as `workspace_admin`
- `source_visibility_policy`: `all_sources_visible` or `source_grants_required`

Default rule: all sources must still be visible to the actor. If one source is not visible, the memory item is withheld unless the item has a separate approved source grant.

## 10. Permission Model

Memory has two gates: write-time and retrieval-time.

### Write-Time Gate

To create or update a memory item, momo checks:

1. The creator is a workspace member.
2. The creator can read all source refs.
3. The chosen visibility is not broader than the narrowest required source visibility.
4. The memory type is allowed by workspace policy.
5. The statement is bounded and does not include secrets or hidden raw text.
6. Personal memory about another member requires explicit delegation, admin policy, or direct source proof.
7. Agent-created memory starts as `quality.review_status = "candidate"` unless policy allows auto-accept for that type.

### Retrieval-Time Gate

To include memory in a Context Packet, momo checks:

1. `SET LOCAL app.workspace_id` matches the request workspace.
2. Actor is a current workspace member.
3. Actor and target agent satisfy `visibility` requirements.
4. Actor can still read every required source ref.
5. External grants are still valid.
6. The item is not expired, deleted, revoked, tombstoned, or invalidated.
7. `permissions.retrieval_policy_version` is compatible with current workspace policy. `permissions.write_policy_version` remains audit evidence for the original write gate.
8. The memory type is allowed for the request surface.
9. The memory reason matches the current goal enough to avoid unrelated profiling.

If any check fails, the item is excluded and the Context Packet may include a `withheld_source` or `withheld_memory` redaction record without revealing hidden contents.

## 11. Expiry, Deletion, and Revocation

Required `validity` fields:

- `created_at`
- `expires_at`
- `stale_after`
- `refresh_policy`: `none`, `on_access`, `provider_change_token`, or `manual_review`

Required `lifecycle` fields:

- `delete_path`: user-visible route or action id.
- `deleted_at`: nullable.
- `revoked_at`: nullable.
- `invalidated_at`: nullable.
- `invalidated_reason`: nullable string.
- `tombstone_policy`: `hide`, `keep_citation_only`, or `purge_after_retention`.

Deletion paths by memory type:

| Type | Delete path |
|---|---|
| `decision` | channel owner or workspace admin delete/supersede. |
| `preference` | subject user delete for personal; admin delete for team preference. |
| `artifact_ref` | artifact unlink/delete; source provider deletion hides ref. |
| `task_state` | expires quickly or is superseded by newer state. |
| `external_source_ref` | provider grant revoke, source delete, or user/admin unlink. |
| `agent_skill_note` | reviewer/admin reject, agent owner delete, expiry, or policy reset. |

Deleting a memory item should not delete the original source message or document. It removes the durable memory projection.

## 12. Local LLM Compaction

Local LLM compaction can help produce memory candidates, especially on macOS/iOS with Apple Foundation Models or similar on-device models.

Rules:

- Compaction output is a candidate, not trusted memory.
- Candidate must preserve source ids and bounded excerpts.
- Candidate must include `quality.compaction_model`, `quality.compaction_prompt_version`, and `quality.confidence`.
- PII/secret redaction happens before or during candidate creation.
- A candidate cannot broaden visibility beyond its sources.
- Low-confidence or agent-generated memories require human review before workspace-wide visibility.
- Local-only processing may improve privacy, but the resulting memory still follows the same source, visibility, expiry, and delete rules.

## 13. Agent Runtime Boundaries

### Hermes and Kim Intern

Hermes and Kim Intern may maintain their own session memory, but momo does not treat that as workspace truth.

Allowed import path:

1. Runtime emits an explicit candidate memory proposal.
2. momo records the source `agent_run`, source messages, tool results, and policy versions.
3. momo applies write-time gate.
4. Candidate is stored as `quality.review_status = "candidate"` or accepted by policy.
5. Future retrieval still runs retrieval-time gate.

### openclaw lesson

openclaw-style channel/plugin runtime is useful for interaction boundaries, but momo keeps memory ownership in Postgres:

| Concern | momo owner |
|---|---|
| Memory availability | retrieval-time permission check |
| Presentation | memory inspector and source badges |
| Transport | Context Packet projection, not direct runtime memory injection |
| Interactions | delete/block/promote/review endpoints |
| Observe | memory audit events and Context Packet references |

## 14. Audit Events

Every memory state transition writes an audit event in future implementation.

Required event kinds:

- `memory.created`
- `memory.updated`
- `memory.reviewed`
- `memory.retrieved`
- `memory.withheld`
- `memory.expired`
- `memory.revoked`
- `memory.deleted`
- `memory.invalidated`

`memory.retrieved` should record the `context_packet_id`, not the full packet body.

## 15. Candidate Database Shape

This is not an implementation ticket, but future migrations should start from these concepts:

| Candidate table | Purpose |
|---|---|
| `memory_item` | Core typed memory row, one workspace tenant, RLS FORCE. |
| `memory_source_ref` | Many-to-many source attribution and permission snapshot. |
| `memory_visibility_grant` | Optional explicit grant beyond default visibility. |
| `memory_lifecycle_event` | Create/update/review/retrieve/withhold/delete/revoke audit stream. |
| `memory_candidate` | Optional pre-review local LLM/agent-generated candidate queue. |

RLS defaults:

- All memory tables have `workspace_id`.
- User-facing reads require `SET LOCAL app.workspace_id`.
- Channel-scoped reads require membership checks.
- Personal reads require subject/delegation checks.
- Admin reads require explicit admin role checks.
- BYPASSRLS is not used for Context Packet assembly.

## 16. Fixture Index

Fixtures live in `research/11-agent-runtime/fixtures/memory-plane-v0/`.

| Fixture | Coverage |
|---|---|
| `typed_memory_items.json` | One valid memory item for each v0 type. |
| `retrieval_allowed_context_packet_refs.json` | Retrieval-time permission pass and projection into Context Packet `memory_refs`. |
| `retrieval_denied_permission_examples.json` | Expired, revoked, cross-channel, and external grant denied examples with withheld-memory redactions. |

## 17. Follow-Up Implementation Notes

- `MOMO-153` should define capability/tool cache invalidation independently from memory retrieval.
- `MOMO-160` should attach memory retrieval decisions to `agent_run` lifecycle.
- `MOMO-161` should ensure approval outcomes can become `decision`, `task_state`, or `artifact_ref` memory only through this spec.
- `MOMO-171` should render a memory inspector that can show source refs, visibility, expiry, and delete/block actions.
- `MOMO-172` should require local LLM context compaction to emit source-preserving memory candidates.
