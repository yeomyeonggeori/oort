# Capability Cache v0

> Updated: 2026-06-26
> Status: normative spec for MOMO-153. No runtime/schema implementation in this ticket.

## 1. Purpose

Capability Cache v0 defines how oort discovers, stores, invalidates, and projects agent/plugin/MCP capabilities into a Context Packet.

It answers five questions:

1. Which agent, plugin, or MCP tool exists?
2. Which workspace policy and provider grant made it visible?
3. Which JSON schema should validate its input and output?
4. How long may oort reuse that discovery result?
5. How does a cached capability become a bounded `tool_grant` for one run?

Capability Cache is owned by oort. Hermes, Kim Intern, openclaw-style plugins, MCP servers, or provider SDKs may announce capabilities, but they do not decide workspace authorization. A cached capability is evidence for policy evaluation, not permission by itself.

## 2. Non-Negotiable Rules

- Capability Cache never grants access alone. Every Context Packet projection rechecks workspace membership, channel scope, provider grant, plugin policy, risk, and approval policy.
- Every cache entry has `workspace_id`, `cache_kind`, `visibility`, `source`, `expires_at`, `policy_version`, `capability_version`, `schema_hash`, and an audit trail.
- Capability entries must not contain provider refresh tokens, database URLs, cookies, private keys, broad admin credentials, raw message bodies, or external document dumps.
- Risky writes are always projected as `grant = "propose"` with `approval_policy != "none"` unless workspace policy explicitly denies them.
- Expired or invalidated entries cannot produce `tool_grants`. The Context Packet may include a withheld-tool redaction without exposing hidden schemas or credentials.
- BYPASSRLS is not allowed for user-facing capability projection. Future broad discovery workers require an explicit contract change and may only write candidate cache state; projection still runs through normal workspace/RLS checks.
- Capability Cache invalidation is an audit event. It must be traceable to a plugin version, provider grant, policy version, manual refresh, MCP notification, or TTL expiry.

## 3. Relationship to Context Packet v0

Context Packet v0 carries `tool_grants`. Capability Cache v0 defines the backing discovery and schema records.

Projection from cache entry to Context Packet tool grant:

| Capability Cache field | Context Packet `tool_grants` field |
|---|---|
| `tool.name` | `tool_name` |
| `provider.kind` or `source.provider` | `provider` |
| policy decision | `grant` |
| `risk.level` | `risk` |
| `approval.approval_policy` | `approval_policy` |
| `tool.allowed_operations` | `allowed_operations` |
| policy-denied operations | `denied_operations` |
| `schema_ref` | `input_schema_ref` |
| `capability_version` | `capability_version` |
| `policy_version` | `policy_version` |

A Context Packet must include only the projected grant. It must not inline provider credentials, hidden policy clauses, broad plugin config, or full MCP server metadata.

Capability Cache fixtures may show a partial projection with `schema = "momo.context_packet.tool_grants_projection.v0"`. That shape is not a full Context Packet; it contains only `packet_id`, projected `tool_grants`, optional withheld-tool redactions, and the audit ids that prove how Capability Cache fed Context Packet v0.

## 4. Relationship to Memory Plane v0

Memory Plane and Capability Cache are separate planes:

| Concern | Owner | Version field |
|---|---|---|
| Whether a memory item may be retrieved | Memory Plane | `permissions.retrieval_policy_version` |
| Whether a tool may be offered to an agent | Capability Cache | `policy_version` + `capability_version` |
| Whether an external provider grant is still valid | Connector/provider policy | provider grant version or change token |
| Whether an agent runtime can execute a requested operation | AgentWorker / plugin runtime | `capability_version` + approval outcome |

The planes share invalidation signals. For example, Google Drive grant revocation invalidates Drive-backed tool capabilities and also forces Memory Plane revalidation for `external_source_ref` memories that cite that grant. Capability invalidation does not delete memory. It records that future Context Packets must withhold or revalidate affected refs.

## 5. Cache Kinds

v0 has exactly four capability cache kinds.

| Kind | Meaning | Typical source | Default TTL | Context Packet projection |
|---|---|---|---|---|
| `agent_capability` | Agent member runtime abilities: transport, surfaces, streaming, tool calls, model route, max context. | agent config, Hermes/Kim Intern manifest, admin install | 10 minutes | agent availability and runtime envelope hints |
| `plugin_tool_schema` | Plugin command/action tool schema, risk, approval, provider grant requirements. | plugin manifest, admin install, connector introspection | 30 minutes | `tool_grants` |
| `mcp_tool_list` | MCP server tool list and schema refs. | MCP `tools/list`, server capability notification | 5 minutes | `tool_grants` |
| `model_pricing` | Model usage accounting inputs: token buckets, cached token handling, price version. | static config, provider price table, admin override | 1 hour | budget/cost routing hints, not direct tool grants |

The older research term `context_summary_cache` belongs to Context Broker or Memory Plane implementation, not Capability Cache v0. `external_source_cache` belongs to connector/source indexing. Capability Cache may reference those systems through provider grants and invalidation events, but it does not store source bodies or summaries.

## 6. Cache Entry Shape

All fields use snake_case JSON. IDs are UUID strings unless noted.

```json
{
  "schema": "momo.capability_cache_entry.v0",
  "cache_entry_id": "uuid",
  "cache_key": "cap:workspace:kind:provider:tool",
  "workspace_id": "uuid",
  "cache_kind": "plugin_tool_schema",
  "visibility": {},
  "source": {},
  "tool": {},
  "risk": {},
  "approval": {},
  "schema_ref": {},
  "policy": {},
  "validity": {},
  "invalidation": {},
  "quality": {},
  "audit": {}
}
```

Required top-level fields:

| Field | Meaning |
|---|---|
| `schema` | Literal `momo.capability_cache_entry.v0`. |
| `cache_entry_id` | Stable cache entry id. |
| `cache_key` | Stable lookup key scoped by workspace/kind/provider/tool/version. |
| `workspace_id` | Tenant root. Required for RLS and audit. |
| `cache_kind` | One of the v0 cache kinds in section 5. |
| `visibility` | Who may see or project this capability. |
| `source` | Agent/plugin/MCP/provider source that announced the capability. |
| `tool` | Tool or capability metadata. |
| `risk` | Risk class and side-effect profile. |
| `approval` | Approval policy before execution. |
| `schema_ref` | Input/output schema reference and hash. |
| `policy` | Workspace/plugin/provider policy versions used to admit it. |
| `validity` | TTL, expiry, stale behavior, and refresh policy. |
| `invalidation` | Signals that hide or refresh the entry. |
| `quality` | Discovery confidence and validation status. |
| `audit` | Discovery, projection, invalidation, and refresh event ids. |

## 7. Visibility Model

`visibility.scope` is one of:

| Scope | Meaning | Projection requirement |
|---|---|---|
| `personal` | Capability installed by or delegated to one member. | actor is subject member or delegated agent running for that member. |
| `channel` | Capability is available in a channel/thread. | actor and target agent are current channel members; plugin is enabled for channel. |
| `workspace` | Capability is workspace-wide. | actor is workspace member; plugin/admin policy allows the surface. |
| `admin` | Admin-only operational capability. | actor has admin role and request surface permits admin context. |

Required visibility fields:

- `scope`
- `workspace_id`
- `channel_id` when scope is `channel`
- `subject_member_id` when scope is `personal`
- `required_roles`: optional roles such as `workspace_admin`
- `surface_allowlist`: surfaces such as `mention`, `slash_command`, `message_context_action`, `scheduled_trigger`, `api`

## 8. Source Model

`source.kind` is one of:

- `agent_manifest`
- `plugin_manifest`
- `mcp_server`
- `provider_connector`
- `workspace_policy`
- `admin_override`
- `model_pricing_table`

Required source fields:

- `kind`
- `provider`: e.g. `github`, `jira`, `google_workspace`, `obsidian`, `mcp`, `kim_intern`, `hermes`
- `source_uri`
- `source_version`
- `retrieved_at`
- `retrieved_by`
- `checksum` or `schema_hash` when available

Source records are not credentials. OAuth refresh tokens, API keys, and database URLs stay in secret storage and are never copied into capability entries.

## 9. Tool and Schema Model

Required `tool` fields for `plugin_tool_schema` and `mcp_tool_list`:

- `name`: fully qualified tool name such as `github.create_issue`.
- `display_name`
- `description`
- `provider`
- `allowed_operations`
- `side_effects`: `none`, `external_read`, `external_write`, `spend`, `deploy`, `identity`, or `admin`.
- `required_grants`: provider scopes or plugin grants.
- `idempotency_required`: boolean.
- `result_kind`: `message`, `artifact_ref`, `task_state`, `approval_request`, or `external_source_ref`.

Required `schema_ref` fields:

- `input_schema_ref`: e.g. `momo://capability-cache/github.create_issue/schemas/input/sha256:...`
- `output_schema_ref`: nullable for v0 if the provider has no stable output schema.
- `schema_hash`
- `schema_format`: `json_schema_2020_12`, `mcp_tool_schema`, or `openai_tool_schema`.
- `schema_inline_allowed`: boolean. Inline schemas are allowed in cache fixtures, but Context Packet projection should use refs.

Resource-scoped tools need an additional policy projection:

- `resource_scope_ref`: hash-addressed policy scope for repositories, Jira projects, Drive corpora, calendars, mailboxes, or other provider resources.
- `resource_scope_hash`: stable hash of the admitted scope.
- `resource_scope_summary`: human-readable summary safe to show in approval cards.

Broad input schemas are not authorization. For example, a GitHub schema may accept any `owner/repo` string, but projection must still prove that the requested repository matches the admitted `resource_scope_ref`. Future executors must recheck the same resource scope before approval or execution.

## 10. Policy and Version Model

Required `policy` fields:

- `policy_version`: workspace-level capability policy version used for projection.
- `plugin_policy_version`: plugin-specific policy when present.
- `provider_grant_version`: external grant/scope version when present.
- `capability_version`: provider/plugin/runtime capability version.
- `schema_version`: schema contract version.
- `pricing_version`: required for `model_pricing` entries.
- `resource_scopes`: required when a tool is limited to provider resources narrower than its input schema.

Version compatibility rule:

1. `policy.policy_version` must be compatible with current workspace policy.
2. `policy.capability_version` must match the source's current version or a still-allowed compatibility window.
3. `policy.provider_grant_version` must match a non-revoked grant for the actor or workspace.
4. `schema_ref.schema_hash` must match the schema used to validate the future `tool_call`.
5. `resource_scope_ref` must admit the requested provider resource when the input schema is broader than the allowed scope.
6. For risky operations, approval policy is checked after version compatibility and before projection.

## 11. TTL, Staleness, and Refresh

Required `validity` fields:

- `created_at`
- `expires_at`
- `stale_after`
- `ttl_seconds`
- `stale_mode`: `deny`, `refresh_before_use`, or `allow_read_only`
- `refresh_policy`: `none`, `on_access`, `scheduled`, `mcp_list_changed`, `provider_change_token`, or `manual_refresh`

Default stale behavior:

- `agent_capability`: `refresh_before_use`
- `plugin_tool_schema`: `deny` for writes, `refresh_before_use` for reads
- `mcp_tool_list`: `refresh_before_use`
- `model_pricing`: `refresh_before_use`

High-risk capabilities (`spend`, `deploy`, `identity`, `admin`) must not use stale entries for projection.

## 12. Invalidation Model

Invalidation hides the cache entry until it is refreshed and admitted by policy again.

Invalidation reasons:

- `ttl_expired`
- `plugin_version_changed`
- `mcp_tool_list_changed`
- `provider_grant_revoked`
- `provider_scope_changed`
- `workspace_policy_changed`
- `channel_membership_changed`
- `agent_config_changed`
- `schema_hash_changed`
- `model_pricing_changed`
- `manual_refresh`
- `security_hold`

Invalidation effects:

| Effect | Meaning |
|---|---|
| `hide_from_projection` | Entry cannot produce `tool_grants`. |
| `refresh_required` | Worker may rediscover before projection. |
| `deny_until_admin_review` | Admin action required before re-enabling. |
| `memory_revalidation_required` | Memory Plane must recheck affected external/source refs. |
| `pricing_recalculation_required` | New usage reservations must use refreshed pricing. |

## 13. Audit Events

Every capability state transition writes an audit event in future implementation.

Required event kinds:

- `capability.discovered`
- `capability.cached`
- `capability.projected_to_context_packet`
- `capability.withheld`
- `capability.refreshed`
- `capability.expired`
- `capability.invalidated`
- `capability.schema_changed`
- `capability.grant_revoked`
- `capability.security_hold`

`capability.projected_to_context_packet` should record `context_packet_id`, `cache_entry_id`, `tool_name`, `policy_version`, `capability_version`, and `schema_hash`, not full credentials or hidden policy details.

## 14. Runtime Boundaries

### Hermes and Kim Intern

Hermes and Kim Intern may expose tools or runtime capabilities, but oort decides if those capabilities are available in a workspace.

Allowed import path:

1. Runtime or admin config announces an agent capability.
2. oort records the source manifest, version, schema hash, and policy versions.
3. oort applies workspace/plugin/provider policy.
4. The capability is cached as valid, withheld, or candidate.
5. Future Context Packet projection still runs policy/version/approval checks.

### MCP

MCP `tools/list` is an input to Capability Cache, not a direct grant. MCP tool definitions may be cached, but oort must support explicit invalidation through list-changed notifications, manual refresh, TTL expiry, and policy changes.

### Plugin ecosystem

Plugin manifests should declare tool schemas, required grants, risk, approval policy, and capability versions. Custom plugins can be powerful, but all write-capable tools still enter the same `tool_call -> approval_request -> tool_result -> audit_log` flow.

## 15. Candidate Database Shape

This is not an implementation ticket, but future migrations should start from these concepts:

| Candidate table | Purpose |
|---|---|
| `capability_cache_entry` | Core cached capability/tool row, one workspace tenant, RLS FORCE. |
| `capability_schema_ref` | Input/output schema refs and hashes. |
| `capability_visibility_grant` | Optional channel/personal/admin visibility grants. |
| `capability_invalidation_event` | Expire/revoke/version-change/manual-refresh audit stream. |
| `capability_projection_event` | Context Packet projection evidence. |

RLS defaults:

- All capability tables have `workspace_id`.
- User-facing projection requires `SET LOCAL app.workspace_id`.
- Channel-scoped capabilities require membership checks.
- Personal capabilities require subject/delegation checks.
- Admin capabilities require explicit admin role checks.
- BYPASSRLS is not used for Context Packet assembly.

## 16. Fixture Index

Fixtures live in `research/11-agent-runtime/fixtures/capability-cache-v0/`.

| Fixture | Coverage |
|---|---|
| `capability_list_snapshot.json` | Agent capability, plugin tool schema, MCP tool list, and model pricing snapshot. |
| `plugin_tool_schema_cache.json` | Write-capable plugin tool schema and its Context Packet `tool_grants` projection. |
| `invalidation_audit_examples.json` | Plugin version change, provider grant revoke, MCP list change, workspace policy change, and withheld-tool projection. |

## 17. Follow-Up Implementation Notes

- `MOMO-160` should attach projected capability evidence to `agent_run.context_packet_id`.
- `MOMO-161` should enforce approval pause/resume for projected tools with `approval_policy != "none"`.
- `MOMO-162` should verify which Hermes/Kim Intern capabilities are discoverable through manifest vs SSE metadata.
- `MOMO-163` should define inbound MCP v0 using this cache as the source of tool proposal validation; runtime implementation remains a follow-up.
- `MOMO-170` should render tool-call cards from projected tool grant and schema refs, not raw plugin config.
