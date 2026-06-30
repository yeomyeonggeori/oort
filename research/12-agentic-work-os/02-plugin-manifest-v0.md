# Plugin Manifest v0 and Catalog Split Criteria

> Status: normative spec for MOMO-181; clarified by GitHub issue #178.
> Updated: 2026-06-30.
> Related: MOMO-180, MOMO-151, MOMO-152, MOMO-153, MOMO-161, MOMO-167.

## 1. Purpose

Plugin Manifest v0 fixes the minimum contract for momo plugins before any repo split or plugin runtime implementation. It answers:

1. What can this plugin expose to a channel, agent run, source picker, or approval card?
2. Which capability schemas can become Capability Cache `plugin_tool_schema` entries?
3. Which bounded grants can become Context Packet `tool_grants` for one run?
4. Which source refs and memory refs can survive into Context Packet and Memory Plane?
5. What approval, audit, source, signature, and compatibility evidence must a catalog carry?

momo v0 is not a WASM marketplace and not a Paca-style catalog of backend apps. It is a governed connector ecosystem: every useful action is mediated by workspace policy, Context Packet, Capability Cache, Memory Plane, approval pause/resume, usage ledger, and audit log.

The product center remains the channel timeline execution ledger. A plugin is admitted only when its reads, proposals, approvals, tool results, usage/cost evidence, source refs, and audit events can be projected back into that ledger.

## 2. Non-Negotiable Rules

- Manifest data is policy evidence, not permission by itself. Context Packet projection still rechecks workspace membership, channel membership, provider grant, resource scope, risk, approval policy, budget, and RLS.
- Plugin tools that write, spend, deploy, change identity, administer permissions, or create durable external side effects must project as `grant = "propose"` and pause on an approval ledger step.
- Provider credentials, OAuth refresh tokens, webhook secrets, signing keys, raw external document bodies, and hidden policy clauses never appear in manifests, Context Packets, Memory Plane records, Capability Cache entries, catalog indexes, or fixtures.
- The manifest controls `plugin_tool_schema` discovery, but execution must recheck `tool_schema_refs`, `resource_scope_ref`, `policy_version`, and approval outcome at call time.
- Source refs are citeable pointers plus bounded excerpts. They are not broad provider mirrors.
- Memory Plane retrieval uses `permissions.retrieval_policy_version`; plugin install or provider revocation can force memory revalidation but does not silently delete memory.
- `signature.required_for_catalog = true` for any artifact in `momo-plugins`. Dev fixtures may be unsigned only when they are explicitly not catalog installable.
- `schema_v0.sql` is unchanged by this spec. Runtime tables, registry migrations, and executors are out of scope.
- Catalog metadata never grants execution. It only lets momo discover signed manifests, compare compatibility, and decide whether a workspace may install or project capabilities.
- A plugin that cannot produce approval metadata and audit evidence for write-like side effects is not a momo plugin v0 catalog candidate.

## 3. Manifest Shape

All fields use snake_case JSON. A v0 installable manifest has:

```json
{
  "schema": "momo.plugin_manifest.v0",
  "plugin_id": "com.momo.plugins.github-issues",
  "id": "com.momo.plugins.github-issues",
  "name": "GitHub Issues",
  "version": "0.1.0",
  "publisher": {},
  "runtime": {},
  "runtime_boundary": {},
  "surfaces": [],
  "ui_surfaces": [],
  "capabilities": [],
  "tools": [],
  "tool_schema_refs": [],
  "approval_policy": {},
  "risk": {},
  "scopes": {},
  "source_policy": {},
  "audit_surface": {},
  "audit_policy": {},
  "license": {},
  "provenance": {},
  "compatibility": {},
  "signature": {}
}
```

Required fields:

| Field | Meaning |
|---|---|
| `plugin_id` | Canonical reverse-DNS or org-scoped stable id. Immutable across releases. |
| `id` | Backward-compatible alias for `plugin_id` in early fixtures. New catalog entries must index by `plugin_id`. |
| `name` | Human-readable display name. |
| `version` | SemVer plugin version. This feeds Capability Cache `capability_version`. |
| `publisher` | Publisher id/name/homepage/support; no secret contacts or private keys. |
| `runtime` | How momo reaches the plugin: connector, webhook, MCP proxy, future WASM, or internal host. |
| `runtime_boundary` | Trust boundary summary: process/host owner, sandbox, egress, secret boundary, and executor owner. |
| `surfaces` | User and system surfaces exposed by the plugin. |
| `ui_surfaces` | Client-visible surfaces: slash command, message context action, approval card, source picker, settings, and timeline card affordances. |
| `capabilities` | Tool/capability declarations, grants, risk, operations, provider grant requirements, result kind. |
| `tools` | Stable tool inventory derived from capabilities and schema refs; optimized for catalog/search display and SDK generation. |
| `tool_schema_refs` | Hash-addressed input/output schema refs used by Capability Cache and future executors. |
| `approval_policy` | Fail-closed policy for risky actions and approval-card behavior. |
| `risk` | Overall risk classes, external systems, data sensitivity, and side-effect classes. |
| `scopes` | Workspace/channel/member/provider/resource scope vocabulary used by projection and approval. |
| `source_policy` | Which source refs may enter Context Packet/Memory Plane and under which policy versions. |
| `audit_surface` | Timeline and admin audit surfaces the plugin must populate. |
| `audit_policy` | Required audit event kinds and redaction obligations. |
| `license` | SPDX license id and notice requirements. Must stay permissive for bundled/first-party distribution. |
| `provenance` | Source repo, release ref, build/signing evidence, and publisher verification metadata. |
| `compatibility` | Protocol and card compatibility matrix. |
| `signature` | Artifact digest/signature status for catalog trust. |

`runtime_boundary`, `ui_surfaces`, `tools`, `scopes`, `audit_surface`, `license`, and `provenance` are explicit v0 review fields. Existing fixtures may keep the older compact `runtime`, `surfaces`, `capabilities`, `source_policy`, `audit_policy`, `publisher`, and `signature` objects, but catalog admission must be able to derive the explicit fields above without guessing.

## 4. Field Contracts

### 4.1 `publisher`

Required:

- `id`: stable publisher id, for example `momo.first_party`.
- `name`: display name.
- `homepage`: public or internal reference.
- `support`: URL or `momo://` support path.

Catalog admission requires publisher ownership verification and signing key registration. The manifest must not carry the private signing key.

### 4.2 `runtime`

`runtime.kind` is one of:

| Kind | Meaning | v0 status |
|---|---|---|
| `hosted_connector` | momo-owned connector process or worker path calls provider APIs. | Preferred v0 default. |
| `external_webhook` | momo calls a remote HTTPS endpoint controlled by publisher/customer. | Allowed with strict egress/signature policy. |
| `mcp_tool_proxy` | momo proxies a bounded MCP tool list into Capability Cache. | Allowed after inbound/outbound MCP policy exists. |
| `internal` | Capability is implemented in the core monorepo but described as plugin-like metadata. | Allowed for first-party bootstrap only. |
| `wasm` | Sandboxed in-process artifact. | Reserved M5+; not a v0 implementation default. |

Required runtime fields:

- `kind`
- `entrypoint`
- `transport`
- `sandbox`
- `network.egress_allowlist` when network is used

### 4.3 `surfaces`

Allowed v0 surface kinds:

- `slash_command`
- `message_context_action`
- `approval_card`
- `source_provider`
- `sidebar_settings`
- `admin_settings`
- `scheduled_trigger`
- `api`

Every surface must have `kind`, `name`, and `display_name`. A surface only makes the plugin discoverable; Context Packet still decides per-run access.

### 4.4 `capabilities`

Each capability must include:

- `tool_name`: fully qualified name such as `github.create_issue`.
- `display_name`
- `grant`: default projection intent, one of `read`, `propose`, or `deny`.
- `risk`: one of `read`, `write`, `spend`, `deploy`, `identity`, or `admin`.
- `allowed_operations`
- `denied_operations` when the provider API has dangerous adjacent operations.
- `required_provider_grants`
- `result_kind`: `message`, `artifact_ref`, `task_state`, `approval_request`, `external_source_ref`, or `tool_result`.
- `idempotency_required`: boolean.
- `resource_scope_summary` when the tool schema is broader than policy-admitted resources.

The values map directly into Capability Cache `cache_kind = "plugin_tool_schema"` and then Context Packet `tool_grants`.

### 4.5 `tool_schema_refs`

Each schema ref must include:

- `tool_name`
- `input_schema_ref`
- `output_schema_ref` or `null`
- `schema_format`: `json_schema_2020_12`, `mcp_tool_schema`, or `openai_tool_schema`
- `schema_hash`

Inline schemas are allowed in dev fixtures only. Catalog artifacts should publish stable refs and digests. Execution must validate a future `tool_call` against the same hash that produced the Context Packet grant.

### 4.6 `approval_policy`

Allowed policy values:

- `none`: direct read-only execution may be allowed.
- `require_approval`: approval required when the request matches risk/resource rules.
- `always`: always pause before execution.
- `deny`: never project the capability.

Manifest v0 deliberately avoids the older ambiguous `read-only` policy name. Read-only behavior is represented as `risk = "read"`, `grant = "read"`, `approval_policy = "none"` after projection checks pass.

Rules are evaluated fail-closed. If multiple rules match and conflict, the strictest outcome wins in this order: `deny`, `always`, `require_approval`, `none`.

### 4.7 `risk`

The plugin-level risk object summarizes:

- `level`: `low`, `medium`, `high`, or `critical`.
- `classes`: any of `read`, `write`, `spend`, `deploy`, `identity`, `admin`.
- `external_systems`
- `data_sensitivity`
- `side_effects`

Tool-level risk remains the source of truth for projection.

### 4.8 `source_policy`

`source_policy` defines how plugin-created refs may enter context:

- `source_kinds`: provider kinds such as `github`, `google_drive`, `gmail`, `calendar`, `jira`.
- `context_packet_projection.sources_allowed`
- `context_packet_projection.max_excerpt_chars`
- `context_packet_projection.required_permission_basis`
- `memory_plane_projection.allowed_memory_types`
- `memory_plane_projection.default_visibility`
- `memory_plane_projection.retrieval_policy_version`

The policy must preserve Context Packet boundedness and Memory Plane source visibility rules.

### 4.9 `audit_policy`

Required:

- `event_prefix`
- `required_events`
- `redact_fields`

Minimum events for v0:

- `plugin.installed`
- `plugin.revoked`
- `capability.discovered`
- `capability.projected_to_context_packet`
- `tool_call.proposed`
- `approval.requested` for approval-gated tools
- `approval.decided` for approval-gated tools
- `tool_result.recorded`
- `source_ref.created` when plugin contributes sources
- `memory.revalidation_required` when revocation affects Memory Plane

### 4.10 `compatibility`

Required:

- `manifest_version`
- `momo_protocol`
- `context_packet`
- `capability_cache`
- `memory_plane`
- `client_cards`

The catalog compatibility matrix must index these fields so old clients can hide unsupported cards and servers can reject incompatible capabilities.

### 4.11 `signature`

Required:

- `required_for_catalog`
- `algorithm`
- `artifact_digest`
- `signature_ref`
- `signed_at`

v0 accepts `minisign-ed25519` or future Sigstore-style provenance as policy options. `momo-plugins` catalog entries require a digest and signature reference before installation by non-dev workspaces.

### 4.12 `runtime_boundary`

`runtime_boundary` makes repo split and execution ownership reviewable before runtime code exists.

Required:

- `executor_owner`: `core`, `first_party_plugin`, `third_party`, or `enterprise_customer`.
- `process_boundary`: `in_core_process`, `sidecar_worker`, `remote_https`, `mcp_server`, or `future_wasm`.
- `secret_boundary`: where provider credentials and signing material live. Must never be the catalog.
- `network_boundary`: egress allowlist and inbound webhook policy when applicable.
- `state_boundary`: whether durable state remains in momo Postgres, provider APIs, plugin-owned storage, or none.
- `failure_boundary`: retry/idempotency owner and how failures return to the channel timeline.

### 4.13 `tools`

`tools` is a catalog-facing inventory. It must be derivable from `capabilities[]` and `tool_schema_refs[]`, but it exists so reviewers and future SDKs can inspect the tool surface without reading every policy rule.

Each tool entry should include:

- `tool_name`
- `display_name`
- `schema_hash`
- `default_grant`
- `risk`
- `approval_policy`
- `result_kind`
- `resource_scope_summary`
- `capability_version`

Catalog tooling must reject a tool entry whose `schema_hash`, `risk`, or approval fields disagree with the backing capability/schema records.

### 4.14 `scopes`

`scopes` names the resource vocabulary that policy may admit or deny:

- `workspace_scope`: workspace install and admin visibility.
- `channel_scope`: channels or channel classes where surfaces may appear.
- `member_scope`: actor/delegated user/on-behalf-of constraints.
- `provider_scope`: OAuth/API grants or enterprise admin grants.
- `resource_scope`: provider resources such as GitHub repos, Jira projects, Drive corpora, calendars, mailboxes, or docs spaces.

Broad provider scopes are not enough. If a tool input can name arbitrary provider resources, Context Packet projection must include a `resource_scope_ref`, and approval/execution must recheck that same ref.

### 4.15 `audit_surface`

`audit_surface` binds plugin activity to momo's channel timeline execution ledger.

Required:

- `timeline_events`: user-visible message/card/event projections such as `tool_call.proposed`, `approval.requested`, `approval.decided`, and `tool_result.recorded`.
- `admin_events`: install, revoke, capability discovery, signature hold, provider grant changes, and policy changes.
- `source_events`: source ref creation/refresh and Memory Plane revalidation triggers.
- `cost_events`: usage/reserve/reconcile references when a tool spends model/provider budget.
- `redaction_policy`: fields hidden from cards, Context Packet, logs, and exported audit.

Approval cards are not the audit surface by themselves. The server-owned approval row, message props, outbox event, and audit log together make the approved or rejected side effect reviewable later.

### 4.16 `license` and `provenance`

Required:

- `license.spdx_id`
- `license.notice_required`
- `provenance.source_repo`
- `provenance.release_ref`
- `provenance.build_digest`
- `provenance.publisher_verification`

Bundled and first-party plugins must remain permissive-license compatible with momo's Apache/MIT target. Third-party and private enterprise plugins may use their own licenses only when the catalog marks them non-bundled and workspace admins accept the separate terms.

## 5. Plane Connections

### 5.1 Capability Cache `plugin_tool_schema`

Manifest `capabilities[]` and `tool_schema_refs[]` produce cache entries with:

| Manifest | Capability Cache |
|---|---|
| `id`, `version` | `source.source_uri`, `source.source_version`, `policy.capability_version` |
| `runtime.kind` | `source.kind = plugin_manifest` or `provider_connector` plus runtime metadata |
| `capabilities[].tool_name` | `tool.name` |
| `capabilities[].allowed_operations` | `tool.allowed_operations` |
| `capabilities[].required_provider_grants` | `tool.required_grants` |
| `capabilities[].risk` | `risk.level` |
| `approval_policy` | `approval.approval_policy` |
| `tool_schema_refs[]` | `schema_ref.input_schema_ref`, `schema_ref.output_schema_ref`, `schema_ref.schema_hash` |
| `source_policy` | `policy.resource_scopes`, projection conditions |

Cache entries expire and invalidate independently from manifest publication. A manifest version bump invalidates affected `plugin_tool_schema` entries.

### 5.2 Context Packet `tool_grants`

Context Packet projection turns a valid cache entry into:

- `tool_name`
- `provider`
- `grant`
- `risk`
- `approval_policy`
- `allowed_operations`
- `denied_operations`
- `input_schema_ref`
- `resource_scope_ref`
- `resource_scope_summary`
- `capability_version`
- `policy_version`

No Context Packet may inline provider credentials, full manifests, hidden policy, or broad catalog metadata. The grant is valid for one packet/run only.

### 5.3 Approval Metadata Gate

The approval metadata gate is the runtime check that prevents a catalog entry from becoming an unreviewed side effect.

For every proposed tool call, AgentWorker/server must find exactly one matching Context Packet `tool_grant` derived from Capability Cache. The grant must include:

- `tool_name`
- `grant`
- `risk` or `risk_level`
- `approval_policy`
- `allowed_operations`
- `denied_operations`
- `input_schema_ref`
- `resource_scope_ref` when the schema is broader than the admitted resource set
- `resource_scope_summary`
- `capability_version`
- `policy_version`

Gate rules:

| Metadata state | Result |
|---|---|
| Missing, duplicate, malformed, expired, or policy-incompatible grant | Fail closed: pause for approval or deny according to workspace policy. |
| `grant = "read"`, `risk = "read"`, `approval_policy = "none"` | Direct read may proceed after provider/resource recheck. |
| `grant = "propose"` with `approval_policy = "require_approval"` or `always` | Create approval request and pause the run. |
| Write/spend/deploy/identity/admin risk with `approval_policy = "none"` | Invalid metadata; fail closed. |
| Schema hash or resource scope mismatch at decision/resume time | Reject/expire the approval or fail the resume job without provider side effect. |

Approval metadata is persisted into the proposed `tool_call`/`approval_request` props as sanitized policy evidence. It must be sufficient for a human to see what is being approved and for the executor to recheck the frozen payload after `approval.decided`.

### 5.4 Memory Plane Permission and `policy_version`

When plugin source refs become memory, the memory item must include:

- `permissions.write_policy_version`: memory policy plus plugin/source policy version at write time.
- `permissions.retrieval_policy_version`: current memory policy plus plugin/source policy version required at retrieval time.
- `source_refs[].permission_snapshot`: provider grant version and resource scope.
- `lifecycle.delete_path`: user-visible unlink/delete path.

Plugin uninstall, provider grant revocation, source scope narrowing, signature trust hold, or workspace policy change triggers Memory Plane revalidation. Revalidation can hide or tombstone future retrieval without deleting the audit history.

## 6. Catalog and Repo Split Criteria

### 6.1 Catalog Classes

The catalog is not a task-board app store. It is an install/discovery ledger for governed capabilities that can appear in channel timelines.

| Class | Home | Admission rule | Typical examples |
|---|---|---|---|
| Core bundled plugin | `momo` monorepo | Allowed only when the capability is protocol/bootstrap infrastructure and releases with core. Still needs manifest-derived metadata and audit events. | internal docs search fixture, built-in approval-safe demo tools |
| First-party repo plugin | `momo-plugin-*` | Split when provider runtime/tests/security boundary release independently and Manifest v0 is stable. Must use catalog metadata and local plugin gates. | GitHub Issues, Google Workspace, work items, docs |
| Third-party/custom plugin | external repo or customer repo | Catalog entry can be public or workspace-local. Must include signature/provenance, compatibility, scopes, risk, approval, audit, and license terms. | customer Jira workflow, internal CRM connector |
| Private enterprise plugin | customer/private org repo | May be absent from public `momo-plugins`; install through private catalog index. Must preserve same Context Packet, Capability Cache, approval, and audit gates. | enterprise DWD connector, internal admin automation |

All four classes share one projection path: Manifest/Catalog evidence -> Capability Cache `plugin_tool_schema` -> Context Packet `tool_grants` -> approval metadata gate -> timeline/audit result.

### 6.2 `momo-plugins` Catalog Split

Do not create `momo-plugins` until this spec is accepted and at least the following are true:

- Plugin Manifest v0 fields and fixtures are merged.
- At least two first-party plugin manifests exist as fixtures or internal manifests, one read-mostly and one approval-gated write.
- A catalog index shape is agreed: manifest URL, version, artifact digest, signature ref, compatibility matrix, risk summary, publisher id, and deprecation status.
- Local docs gate validates catalog fixture JSON.
- Installation still happens inside the core repo or dev fixture path; repo split is catalog metadata only.

Create `momo-plugins` when at least one of these triggers becomes true:

- Plugin manifests need independent review/release cadence from core.
- External contributors need to propose manifests without seeing the private core repo.
- Signed artifact metadata and compatibility matrix become a release input.
- Multiple first-party plugin repos need a shared catalog index.

Do not split `momo-plugins` when the only goal is to move unfinished runtime code or hide unstable protocol churn.

The catalog index shape is:

| Field | Meaning |
|---|---|
| `plugin_id` | Stable manifest id. |
| `version` | SemVer artifact version. |
| `manifest_ref` | URL or `momo://` ref to the manifest. |
| `artifact_digest` | Hash of the installable artifact or manifest-only package. |
| `signature_ref` | Verification material; required for installable non-dev catalog entries. |
| `publisher_id` | Verified publisher. |
| `catalog_class` | `core_bundled`, `first_party_repo`, `third_party_custom`, or `private_enterprise`. |
| `compatibility` | Manifest/Context Packet/Capability Cache/Memory Plane/client card compatibility. |
| `risk_summary` | Human-reviewable risk classes and side-effect profile. |
| `approval_summary` | Whether risky tools require approval, always pause, or are denied. |
| `scope_summary` | Safe summary of provider/resource scopes. |
| `audit_surface_summary` | Events/cards/logs the plugin must produce. |
| `license_summary` | SPDX id and notice/terms pointer. |
| `deprecation_status` | `active`, `deprecated`, `security_hold`, or `revoked`. |

### 6.3 First-Party Plugin Repo Split Criteria

First-party plugin repos such as `momo-plugin-github` and `momo-plugin-google-workspace` split only after:

- The plugin has runtime code or provider-specific tests that can release independently.
- The manifest, tool schemas, approval policy, source policy, and audit policy are stable enough for SemVer.
- The plugin has a security or OAuth boundary different from core.
- The plugin has local gates that can run without the core repo except for published SDK/types/fixtures.
- Cross-repo development will not require one user story to change core, SDK, and plugin in lockstep.

Google Workspace starts private-first because OAuth, restricted scopes, admin install, and domain-wide delegation have higher trust review burden. GitHub Issues can be public earlier if its provider grants, repository allowlist, and approval writes are stable.

### 6.4 SDK Repo Split Criteria

Do not create SDK repos before duplication exists. Split `momo-plugin-sdk-ts`, `momo-plugin-sdk-swift`, or `momo-plugin-sdk-mcp` only when:

- Two or more plugin repos share manifest types, schema validators, approval-card helpers, or catalog signing helpers.
- Third-party developers need a smaller installable package than the core repo.
- SDK APIs can be versioned independently with compatibility tests against Manifest v0.
- The SDK does not carry provider credentials, core server internals, private signing material, or unfinished runtime assumptions.

`momo-plugin-sdk-ts` is the likely first SDK because manifest/schema/catalog tooling is web/CLI-friendly. Swift SDK is only justified if native client extensions become real. MCP SDK is justified when external MCP servers need a stable bridge without cloning core.

## 7. Paca Comparison and momo Difference

Paca is useful as a repo-topology reference: core, catalog, plugins, SDKs, and MCP-adjacent packages can be separated. momo must not copy Paca's plugin catalog semantics directly.

| Paca-like concern | momo v0 decision |
|---|---|
| Plugin as backend extension | Plugin as governed work surface visible in the channel timeline. |
| Catalog as installable app list | Catalog as signed capability evidence feeding Capability Cache and approval/audit gates. |
| Runtime isolation first | Manifest, policy, Context Packet, Capability Cache, approval metadata, and audit first; runtime isolation later. |
| Board/task object as center | Channel timeline execution ledger as center; external tickets/docs are source refs or tool results. |
| Plugin permission at install time | Install creates candidate capabilities; each run still projects bounded `tool_grants`. |
| Tool execution hidden in plugin runtime | Writes pause into approval cards and return `tool_result`/audit evidence to the timeline. |

## 8. Fixtures

Fixture directory:

- `research/11-agent-runtime/fixtures/plugin-manifest-v0/github_issues_plugin_manifest.json`
- `research/11-agent-runtime/fixtures/plugin-manifest-v0/google_workspace_read_manifest.json`
- `research/11-agent-runtime/fixtures/plugin-manifest-v0/high_risk_write_policy_example.json`

These are normative examples for field names and policy shape, not runtime implementation.

## 9. Non-Goals

- Implement plugin runtime.
- Create `momo-plugins` or any first-party plugin repo.
- Implement WASM sandboxing.
- Build marketplace UI.
- Implement external OAuth.
- Change schema or server runtime.
