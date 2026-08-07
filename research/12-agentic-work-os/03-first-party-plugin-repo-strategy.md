# First-Party Plugin Repo Strategy

> Status: normative strategy for MOMO-183.
> Updated: 2026-06-29.
> Related: MOMO-122, MOMO-123, MOMO-151, MOMO-152, MOMO-153, MOMO-161, MOMO-167, MOMO-180, MOMO-181.

## 1. Purpose

This document fixes the first-party plugin sequencing for oort before any repo split is created.

It defines:

1. Which first-party plugins prove the ecosystem first.
2. In what order plugin repos split from the core monorepo.
3. Which user surfaces each plugin must expose.
4. How each plugin connects to Plugin Manifest v0, Context Packet `tool_grants`, Capability Cache, Memory Plane, approval cards, source refs, and audit events.

No repo is created in MOMO-183. No plugin runtime, OAuth implementation, external provider execution, schema migration, marketplace UI, or WASM sandbox is implemented here.

## 2. Ordering Decision

The first-party plugin order is:

| Priority | Plugin | First repo name | Visibility default | Why this order |
|---|---|---|---|---|
| P0 | GitHub / GitHub Issues | `momo-plugin-github` | Public once provider grants and approval writes are stable; private during bootstrap if the core repo is private. | Best proof of agent work OS value: messages become issues, issue state returns to the timeline, writes are approval-gated, and source refs are easy to cite. |
| P1 | Google Workspace | `momo-plugin-google-workspace` | Private first. Public only after OAuth consent, restricted scopes, DWD option, and enterprise admin docs are review-ready. | Highest source-provider value for "ask my work" but highest trust burden. Start read-mostly and approval-gate writes. |
| P2 | Jira-like Work Items | `momo-plugin-work-items` | Public/private depending on provider mix. Prefer neutral `work-items` until Jira-specific runtime is required. | Proves that oort can bridge existing ticket systems without becoming a board-first clone. |
| P3 | Docs Connector | `momo-plugin-docs` | Private first if it includes enterprise sources; public can start with open local/Markdown/Obsidian adapters. | Proves long-lived knowledge/source citation and Memory Plane revalidation across docs systems. |

GitHub comes first because it covers both source citation and approval-gated external writes with narrow repository allowlists. Google Workspace follows because it is the most important source provider but needs the strictest credential and admin boundary. Jira-like work items and Docs follow once the shared command/action/source/audit patterns are proven.

## 3. Repo Split Sequence

The repo split sequence is manifest-first:

| Step | Repo | Earliest milestone | Split trigger | Must not happen before |
|---|---|---|---|---|
| 1 | Keep bootstrap manifests and fixtures in `momo` | Now | Manifest v0 and this strategy need review with core protocol specs. | N/A |
| 2 | `momo-plugins` catalog | M2.5/M3 | At least two first-party manifests exist, catalog index shape is stable, signatures are required for installable artifacts, and docs gate validates fixtures. | Do not move runtime code into the catalog. |
| 3 | `momo-plugin-github` | M3 | GitHub manifest, tool schemas, approval card contract, source refs, audit events, and local provider tests can version independently. | Do not split if one story still needs core + SDK + plugin lockstep changes. |
| 4 | `momo-plugin-google-workspace` | M3/M4 | MOMO-122/123 runtime design is accepted, OAuth/admin boundaries are private-reviewable, and read-mostly source sync tests can run outside core. | Do not publish before consent screen, restricted-scope review plan, and admin revoke/delete docs are ready. |
| 5 | `momo-plugin-work-items` | M3/M4 | GitHub/Jira-like task-state abstractions stabilize enough to avoid hard-coding one provider into the shared model. | Do not split while work item terminology is still changing in core cards. |
| 6 | `momo-plugin-docs` | M3/M4 | Source refs, Memory Plane `external_source_ref`, and docs citation cards are stable across at least two docs backends. | Do not split if it would copy broad document bodies into fixtures or memory. |
| 7 | `momo-plugin-sdk-ts` | M4 | Two or more plugin repos duplicate manifest types, schema validators, signing helpers, or approval-card helper types. | Do not create an SDK to stabilize unfinished APIs. |
| 8 | `momo-plugin-sdk-mcp` / `momo-mcp` | M4/M5 | External MCP distribution needs a small package independent of core. | Do not expose broad MCP tools before Context Packet and approval policy are enforced. |

Visibility rules:

- Public repos are allowed for manifest/schema/source policy and provider tests that contain no secrets and no customer data.
- Private repos are required for OAuth-sensitive implementation, restricted scope review material, enterprise admin setup, signing secrets, unreleased provider contracts, and any test fixture that cannot be sanitized.
- `momo-signing` remains private. Catalog signatures may reference public verification material, but private signing keys never leave that boundary.
- The core monorepo remains the protocol owner through M3/M4. Plugin repos consume published specs, SDKs, fixtures, and compatibility tests; they do not redefine Context Packet, Memory Plane, Capability Cache, or approval semantics.

## 4. Shared Plugin Contract

Every first-party plugin must ship:

| Contract item | Requirement |
|---|---|
| Plugin Manifest v0 | `id`, `name`, `version`, `publisher`, `runtime`, `surfaces`, `capabilities`, `tool_schema_refs`, `approval_policy`, `risk`, `source_policy`, `audit_policy`, `compatibility`, `signature`. |
| Slash commands | Stable command names with explicit output intent and provider scope. Commands are discoverable surfaces only; they are not permission grants. |
| Message context actions | Actions operate on a message/thread source ref and must preserve `trigger_message_id`, source ids, and idempotency keys. |
| Approval cards | Any write/admin/spend/deploy/identity side effect projects as `grant = "propose"` and pauses through the approval ledger before execution. |
| Source provider | Source refs are citeable pointers plus bounded excerpts, permission snapshots, retrieved_at, and provider URI/id. No broad provider mirror. |
| Capability Cache | Manifest `capabilities[]` and `tool_schema_refs[]` produce `plugin_tool_schema` cache entries with `policy_version`, `capability_version`, `schema_hash`, risk, approval, and resource scope. |
| Context Packet | Only projected `tool_grants` and source refs enter the packet. Provider credentials, full manifests, hidden policy, and broad catalog metadata are forbidden. |
| Memory Plane | Plugin source refs may create `external_source_ref`, `artifact_ref`, `task_state`, or `decision` memory only when write-time and retrieval-time gates pass. `permissions.retrieval_policy_version` must include plugin/source policy version. |
| Audit | Install, discovery, projection, proposal, approval, execution/result, source creation, memory revalidation, revoke, and failure events are required. |

## 5. Plugin Surface Matrix

### 5.1 GitHub / GitHub Issues

| Surface | v0 contract |
|---|---|
| Slash command | `/github issue create`, `/github issue search`, `/github pr link`, `/github status`. |
| Message context action | `Create GitHub issue from message`, `Link thread to issue`, `Summarize thread into issue comment`, `Attach PR/issue source`. |
| Approval card | Required for `github.create_issue`, `github.update_issue`, `github.comment_issue`, `github.apply_label`, `github.link_pr`. Card shows repository allowlist, target issue/repo, proposed title/body/labels, idempotency key, and source message/thread refs. |
| Source provider | `github` refs for issues, PRs, comments, commits, files, checks. Excerpts are bounded and cite provider URL plus repository allowlist snapshot. |
| Audit events | `github.installed`, `github.capability.discovered`, `github.source_ref.created`, `github.issue.proposed`, `approval.requested`, `approval.decided`, `github.issue.created`, `github.issue.updated`, `github.issue.comment_created`, `github.grant.revoked`, `memory.revalidation_required`. |

Initial capabilities:

| Tool | Grant | Risk | Context Packet projection |
|---|---|---|---|
| `github.search_issues` | `read` | `read` | Allowed only for repository allowlist and actor-visible repos. |
| `github.fetch_issue` | `read` | `read` | Produces source refs and optional `task_state` memory. |
| `github.create_issue` | `propose` | `write` | Requires approval; execution rechecks repo allowlist and schema hash. |
| `github.comment_issue` | `propose` | `write` | Requires approval; source message/thread refs must be attached. |

Repo split trigger: split `momo-plugin-github` first when provider tests can verify repository allowlists, idempotent issue creation, approval-card payloads, and source-ref creation without changing core protocol code.

### 5.2 Google Workspace

| Surface | v0 contract |
|---|---|
| Slash command | `/gdrive search`, `/gmail search`, `/calendar availability`, `/workspace sources`. |
| Message context action | `Search related Drive docs`, `Find related email thread`, `Check calendar availability`, `Attach source to thread`. |
| Approval card | Required for `gdrive.share`, `gmail.send_draft`, `calendar.create_event`, `calendar.update_event`. Card shows delegated user, OAuth scope, target document/mail/event, recipients, time range, and source refs. |
| Source provider | `google_drive`, `gmail`, `calendar` refs. Read-mostly sync stores provider ids, URLs, bounded excerpts, change tokens, permission snapshots, and retrieved_at. |
| Audit events | `google_workspace.installed`, `google_workspace.admin_install.created`, `google_workspace.scope_inventory.recorded`, `google_workspace.source_ref.created`, `google_workspace.capability.discovered`, `google_workspace.write.proposed`, `approval.requested`, `approval.decided`, `google_workspace.write.executed`, `google_workspace.grant.revoked`, `memory.revalidation_required`. |

Initial capabilities:

| Tool | Grant | Risk | Context Packet projection |
|---|---|---|---|
| `gdrive.search` | `read` | `read` | Source refs only; no raw Drive dump. |
| `gmail.search_threads` | `read` | `read` | Actor/delegated-user visible threads only. |
| `calendar.check_availability` | `read` | `read` | Bounded availability window; no full calendar mirror. |
| `gmail.send_draft` | `propose` | `write` | Always approval-gated; draft body and recipients shown. |
| `calendar.create_event` | `propose` | `write` | Always approval-gated; attendees/time/location shown. |

Repo split trigger: split `momo-plugin-google-workspace` private-first after MOMO-122/123 are accepted and the connector can run sanitized source fixtures and OAuth/admin policy tests outside core.

### 5.3 Jira-Like Work Items

| Surface | v0 contract |
|---|---|
| Slash command | `/work item create`, `/work item search`, `/work item status`, `/work item link`. |
| Message context action | `Create work item from message`, `Link thread to work item`, `Update work item status from decision`, `Attach work item source`. |
| Approval card | Required for create/update/comment/transition operations. Card shows project allowlist, work item type, title/body/status transition, assignee, due date, and source refs. |
| Source provider | `jira` or neutral `work_item` refs for issues, comments, status, assignee, sprint/project metadata. Bounded excerpts only. |
| Audit events | `work_items.installed`, `work_items.capability.discovered`, `work_items.source_ref.created`, `work_items.item.proposed`, `approval.requested`, `approval.decided`, `work_items.item.created`, `work_items.item.updated`, `work_items.transition.executed`, `work_items.grant.revoked`, `memory.revalidation_required`. |

Initial capabilities:

| Tool | Grant | Risk | Context Packet projection |
|---|---|---|---|
| `work_items.search` | `read` | `read` | Project allowlist and actor-visible items only. |
| `work_items.fetch` | `read` | `read` | Produces source refs and `task_state` memory candidates. |
| `work_items.create` | `propose` | `write` | Requires approval; source message/thread refs attached. |
| `work_items.transition` | `propose` | `write` | Requires approval; transition graph and current state rechecked. |

Repo split trigger: split neutral `momo-plugin-work-items` before provider-specific `momo-plugin-jira` unless Jira API details become the dominant runtime. This keeps oort's model provider-neutral and prevents a board-first product drift.

### 5.4 Docs Connector

| Surface | v0 contract |
|---|---|
| Slash command | `/docs search`, `/docs attach`, `/docs summarize`, `/docs cite`. |
| Message context action | `Attach docs source`, `Summarize linked docs`, `Create decision memory from docs`, `Refresh source citation`. |
| Approval card | Usually not needed for read-only search/attach. Required for publishing, moving, permission changes, or writing back to Notion/Confluence/Docs. Card shows target space/page/path, proposed content, permission change, and source refs. |
| Source provider | `obsidian`, `notion`, `confluence`, `google_drive`, `local_file_ref`, or generic `docs` refs. Stores provider URI/id, title, path/space, bounded excerpt, checksum/change token, permission snapshot. |
| Audit events | `docs.installed`, `docs.capability.discovered`, `docs.source_ref.created`, `docs.source_ref.refreshed`, `docs.summary.created`, `docs.write.proposed`, `approval.requested`, `approval.decided`, `docs.write.executed`, `docs.grant.revoked`, `memory.revalidation_required`. |

Initial capabilities:

| Tool | Grant | Risk | Context Packet projection |
|---|---|---|---|
| `docs.search` | `read` | `read` | Source refs only; excerpts bounded by source policy. |
| `docs.fetch_excerpt` | `read` | `read` | Permission snapshot and checksum required. |
| `docs.attach_source` | `read` | `read` | Adds citeable source ref to thread context. |
| `docs.publish_page` | `propose` | `write` | Approval-gated; target space/path and content diff shown. |

Repo split trigger: split `momo-plugin-docs` only after source citation cards and Memory Plane `external_source_ref` revalidation are stable enough to support multiple docs backends without copying full documents into memory or fixtures.

## 6. Plane Connections

### 6.1 Plugin Manifest v0

Each first-party plugin starts as a Manifest v0 fixture or internal manifest in `momo`. The manifest is the only source for:

- Surfaces: slash commands, message context actions, approval cards, source providers, settings.
- Capabilities: tool names, grants, risk, operations, provider grants, result kind.
- Schema refs: input/output schema hash used by Capability Cache and future executors.
- Policies: approval, risk, source, audit, compatibility, signature.

Manifest data is policy evidence, not permission. Runtime projection still rechecks workspace membership, channel membership, provider grant, source scope, policy versions, risk, budget, and RLS.

### 6.2 Capability Cache

Manifest `capabilities[]` and `tool_schema_refs[]` become `plugin_tool_schema` entries. Each entry must include:

- `source.kind = "plugin_manifest"` or `provider_connector`.
- `source.provider` such as `github`, `google_workspace`, `work_items`, or `docs`.
- `tool.name`, `allowed_operations`, `required_grants`, `side_effects`, and `result_kind`.
- `risk.level`, `approval.approval_policy`, `schema_ref.schema_hash`.
- `policy.policy_version`, `plugin_policy_version`, `provider_grant_version`, `capability_version`, and `resource_scope_ref` when applicable.

Expired, invalidated, signature-held, grant-revoked, or policy-incompatible entries cannot produce Context Packet `tool_grants`.

### 6.3 Context Packet `tool_grants`

For each run, oort projects only the bounded tools needed for the request:

- Read tools project as `grant = "read"` only when provider and resource scopes are valid.
- External writes project as `grant = "propose"` with `approval_policy = "require_approval"` or `always`.
- The packet carries `tool_name`, `provider`, `grant`, `risk`, `approval_policy`, `allowed_operations`, `denied_operations`, `input_schema_ref`, `resource_scope_ref`, `resource_scope_summary`, `capability_version`, and `policy_version`.
- The packet must not carry provider credentials, OAuth refresh tokens, full manifests, broad catalog metadata, hidden policy text, or raw external document bodies.

Message context actions must also preserve `trigger_message_id`, source refs, and idempotency keys so approval and execution can be retried safely.

### 6.4 Memory Plane Permission Model

First-party plugins may create or refresh memory only through typed, sourced, permission-checked records:

| Plugin output | Allowed memory types | Retrieval rule |
|---|---|---|
| GitHub issue/PR/ref | `task_state`, `artifact_ref`, `external_source_ref`, `decision` when sourced from approved thread outcome | Actor and agent must still see the channel/thread and repository source scope. |
| Google Drive/Gmail/Calendar ref | `external_source_ref`, `artifact_ref`, `task_state` for calendar workflow state | Actor/delegated user must still have provider grant and source visibility. |
| Work item ref | `task_state`, `artifact_ref`, `external_source_ref`, `decision` when tied to approval/result | Actor must still have project/work item visibility and channel source access. |
| Docs ref/summary | `external_source_ref`, `artifact_ref`, `decision` only when the statement is sourced and bounded | Actor must still have docs provider/source visibility and current retrieval policy. |

`permissions.write_policy_version` records memory policy plus plugin/source policy at creation. `permissions.retrieval_policy_version` must include the current memory policy plus plugin/source policy required for future Context Packet inclusion. Provider grant revocation, plugin uninstall, source scope narrowing, signature trust hold, channel membership loss, or workspace policy change triggers Memory Plane revalidation.

### 6.5 Approval and Audit

Approval is part of the plugin contract, not UI sugar:

1. Agent proposes a write-like `tool_call` from an admitted `tool_grant`.
2. AgentWorker/server records `approval_request` and pauses the run.
3. Client renders an approval card with provider, resource scope, source refs, proposed diff/body, risk, policy evidence, and idempotency key.
4. Human decision records `approval.decided`.
5. Executor rechecks schema hash, resource scope, provider grant, approval outcome, and idempotency before side effect.
6. Tool result and audit events return to the timeline.

Required audit events are namespaced by plugin but must map to oort's common lifecycle:

- `plugin.installed`
- `capability.discovered`
- `capability.projected_to_context_packet`
- `source_ref.created`
- `tool_call.proposed`
- `approval.requested`
- `approval.decided`
- `tool_result.recorded`
- `plugin.grant.revoked`
- `memory.revalidation_required`

## 7. Non-Goals

- Create `momo-plugins` or first-party plugin repos.
- Implement provider OAuth, API clients, webhook handlers, or external write executors.
- Implement marketplace UI or install flows.
- Implement WASM runtime.
- Change `schema_v0.sql`, server runtime, AgentWorker runtime, macOS cards, or local gate profiles.
- Commit provider credentials, customer data, raw external document bodies, or signing keys.
