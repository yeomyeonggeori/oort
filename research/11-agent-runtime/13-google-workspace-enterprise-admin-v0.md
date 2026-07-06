# Google Workspace Enterprise Admin v0

> Updated: 2026-07-06 (MOMO-323: `service_account_boundary.boundary_kind` added with third mode `shared_drive_member` — not DWD; grounds: `research/13-redesign/03` §2·§5)
> Status: normative spec for MOMO-123. No runtime/schema implementation in this ticket.

## 1. Purpose

Google Workspace Enterprise Admin v0 defines the enterprise-only install path for momo's Google Workspace connector.

It extends MOMO-122 without changing its default:

- Default v0 remains per-user OAuth.
- Enterprise admin install is an opt-in workspace policy.
- Domain-wide delegation is an additional enterprise option, not a default authorization mode.
- Admin install never lets agents bypass Context Packet, Memory Plane, Capability Cache, approval, audit, or source revocation checks.

This spec answers seven questions:

1. Who may approve a Google Workspace enterprise install?
2. Which OAuth scopes and service-account boundaries are allowed?
3. When may domain-wide delegation impersonate a user?
4. How do enterprise grants project into Context Packet, Memory Plane, and Capability Cache?
5. Which audit records must be exportable?
6. How does admin revoke/delete work?
7. What remains manual and outside momo runtime v0?

## 2. Non-Negotiable Rules

- Per-user OAuth from MOMO-122 is the product default. Enterprise admin install must be explicitly enabled per momo workspace.
- Domain-wide delegation (DWD) is disabled by default even after enterprise admin install. It requires a separate admin approval record, scope inventory, service account client id, and user-delegation policy.
- A `shared_drive_member` service-account boundary (§6) is **not DWD**. The service account acts only as itself, holds Content Manager membership in exactly one momo-managed workspace shared drive, never impersonates a user, and never mints delegated tokens. Enabling it must not enable DWD and requires no Admin console API Controls client authorization.
- A delegated request must name a human Google subject or user principal. Agents must not use a domain-wide grant as an ownerless mailbox, Drive, or Calendar identity.
- The service account private key, workload identity credential, refresh token, or access token is never stored in Context Packet, Memory Plane, Capability Cache, fixtures, audit exports, logs, or user-visible props.
- DWD read access is still source-scoped at momo policy time. A broad Workspace grant does not authorize broad Context Packet inclusion.
- Gmail send, Calendar mutation, Drive share/permission mutation, Admin SDK changes, and identity/admin actions are approval-gated or denied. DWD does not convert risky writes into direct tool grants.
- Revocation must fail closed: stop delegated token minting first, hide future source refs, invalidate Capability Cache entries, queue Memory Plane revalidation, and export audit evidence.
- Enterprise audit export is an admin-readable artifact. It may include ids, hashes, scope names, policy versions, timestamps, and redaction reasons, but not provider tokens or raw external content bodies.

## 3. Install Modes

| Mode | Default | Actor | Credential | Intended use |
|---|---|---|---|---|
| `per_user_oauth` | yes | each human member | user's OAuth grant | MOMO-122 read-mostly Drive/Gmail/Calendar sources |
| `enterprise_admin_install` | no | Google Workspace super/admin + momo workspace owner/admin | admin consent and workspace policy | central policy, scope inventory, audit export, optional app allowlisting |
| `domain_wide_delegation` | no | Google Workspace super admin plus momo enterprise admin policy | service account client id with approved scopes | delegated read for enterprise tenants where per-user OAuth is operationally unsuitable |
| `shared_drive_member` | no | momo workspace owner/admin plus a Workspace member/admin who creates the shared drive | service account **as itself** — Content Manager member of exactly one momo-managed shared drive (`boundary_kind = shared_drive_member`, §6) | workspace archive storage and indexing credential (MOMO-320/321); not DWD, no impersonation |

Enterprise admin install can exist without DWD. For example, a customer may use admin approval only to pre-approve the OAuth app and export audits while keeping per-user OAuth as the only data access path.

`shared_drive_member` can likewise exist without DWD and without a full enterprise admin install: a small self-hosted team provisions it with ordinary shared-drive membership plus the Internal-consent GCP project setup (`docs/GWS_INTERNAL_CONSENT_RUNBOOK.md`). It is still recorded as a `service_account_boundary` under this spec so scope inventory, credential storage, review cadence, and revoke rules apply.

## 4. Admin Consent and Manual Boundary

Required records:

| Field | Meaning |
|---|---|
| `enterprise_install_id` | Stable momo id for the enterprise install. |
| `workspace_id` | momo workspace/tenant. |
| `google_customer_id` | Google Workspace customer id, if known. |
| `hosted_domains` | Allowed domains, normalized and verified. |
| `install_mode` | `enterprise_admin_install`. |
| `dwd_status` | `disabled`, `pending_admin`, `active`, `revoked`, or `deleted`. |
| `approved_by_member_id` | momo admin who recorded the install. |
| `google_admin_email_hash` | Hash or redacted email of approving Google admin. |
| `scope_inventory_version` | Version of the approved scope inventory. |
| `service_account_boundary_id` | Boundary record when DWD is enabled. |
| `policy_version` | Enterprise connector policy used for projection. |
| `audit_export_enabled` | Whether admin export is enabled for this workspace. |

Manual tasks that momo must not pretend to complete:

1. Google Cloud project ownership and OAuth app verification.
2. Google Workspace Admin console approval.
3. API Controls / domain-wide delegation client authorization.
4. Service account creation, keyless workload identity setup, or key rotation.
5. Customer security/legal approval.

Codex/runtime may document and validate files, but actual Google admin approval is `[manual]`.

## 5. Scope Inventory

Every enterprise install has a scope inventory. DWD can only mint delegated tokens for scopes present in the active inventory.

Required scope fields:

- `scope`
- `surface`: `drive`, `gmail`, `calendar`, or `admin`
- `classification`: `non_sensitive`, `sensitive`, or `restricted`
- `install_default`: `never`, `admin_optional`, or `enterprise_required`
- `dwd_allowed`: boolean
- `dwd_default`: always false in v0
- `data_classes`: bounded categories such as `drive_metadata`, `gmail_headers`, `calendar_busy_windows`
- `context_packet_projection`: what may enter `sources[]`
- `memory_plane_projection`: allowed memory type and retention
- `capability_cache_projection`: allowed tools and approval policy
- `approval_policy`: `none`, `always`, `admin_only`, or `deny`
- `review_cadence_days`: required admin review cadence

v0 recommended inventory:

| Surface | Scope | DWD allowed | Default | Notes |
|---|---|---:|---|---|
| Drive selected/resource-scoped | `https://www.googleapis.com/auth/drive.file` | false | per-user only | Keep MOMO-122 selected-file default. A `shared_drive_member` boundary may also use this scope **as the service account itself** (not DWD) for the momo-managed shared drive. |
| Drive metadata | `https://www.googleapis.com/auth/drive.metadata.readonly` | true | off | Useful for enterprise source badge refresh; still resource filtered by momo. |
| Drive readonly | `https://www.googleapis.com/auth/drive.readonly` | true | off | Restricted. Requires explicit admin justification and bounded excerpts. |
| Gmail metadata | `https://www.googleapis.com/auth/gmail.metadata` | true | off | Prefer headers/labels/search metadata. |
| Gmail readonly | `https://www.googleapis.com/auth/gmail.readonly` | true | off | Restricted. Requires user delegation and query/window bounds. |
| Calendar freebusy | `https://www.googleapis.com/auth/calendar.freebusy` | true | off | Preferred delegated calendar path. |
| Calendar events readonly | `https://www.googleapis.com/auth/calendar.events.readonly` | true | off | Bounded event windows only. |
| Gmail/Calendar/Drive writes | send/compose/modify/events/drive write/share scopes | false by default | never | Only future approval-gated write products may request these. |
| Admin SDK | Directory/Reports/admin scopes | export-only or deny | off | Use only for admin audit export or directory lookup tickets, not agent context by default. |

## 6. Service Account Boundary

momo records a service account boundary whenever a service-account credential exists for a workspace. `boundary_kind` selects the mode:

| `boundary_kind` | What the service account is | Impersonation |
|---|---|---|
| `dwd_delegation` (default) | DWD client authorized in the Admin console; mints delegated tokens for named users | yes, per §7 |
| `shared_drive_member` (added 2026-07-06, MOMO-323) | **Not DWD.** The service account acts only as itself; its entire authority is Content Manager membership in exactly one momo-managed workspace shared drive | none — no delegated subjects, no Admin console API Controls authorization |

Boundary records without `boundary_kind` are read as `dwd_delegation` (backward compatible — all pre-2026-07 records are DWD).

DWD boundary (`boundary_kind = dwd_delegation`):

```json
{
  "service_account_boundary_id": "gwe_sa_boundary_001",
  "workspace_id": "uuid",
  "google_customer_id": "C01example",
  "boundary_kind": "dwd_delegation",
  "service_account_client_id_hash": "sha256:...",
  "service_account_email_redacted": "momo-enterprise@project.iam.gserviceaccount.com",
  "credential_storage_ref": "secret://google-workspace-enterprise/.../workload-identity",
  "key_material_policy": "no_static_key_preferred",
  "allowed_subject_domains": ["example.com"],
  "allowed_scopes_version": "google-workspace-enterprise-scopes@2026-06-29:001",
  "status": "active"
}
```

Shared-drive-member boundary (`boundary_kind = shared_drive_member`):

```json
{
  "service_account_boundary_id": "gwe_sa_boundary_002",
  "workspace_id": "uuid",
  "google_customer_id": "C01example",
  "boundary_kind": "shared_drive_member",
  "service_account_client_id_hash": "sha256:...",
  "service_account_email_redacted": "momo-archive@project.iam.gserviceaccount.com",
  "credential_storage_ref": "secret://google-workspace-enterprise/.../shared-drive-archive-sa",
  "key_material_policy": "no_static_key_preferred",
  "shared_drive_id": "0AExampleSharedDriveId",
  "shared_drive_role": "content_manager",
  "allowed_subject_domains": [],
  "allowed_scopes_version": "google-workspace-enterprise-scopes@2026-07-06:001",
  "status": "active"
}
```

Boundary rules (both kinds):

- Prefer keyless workload identity or secret-manager backed credentials. If a static key exists, it must have a rotation deadline and a delete path.
- The boundary is workspace-scoped. A service account authorized for one customer must not be reused across unrelated momo workspaces unless a future multi-tenant enterprise contract explicitly allows it.
- Token minting is runtime-only. Store `credential_storage_ref`, not credentials.
- A disabled, revoked, stale, or unreviewed boundary denies projection and execution.

`dwd_delegation`-only rules:

- Token minting requires `(workspace_id, service_account_boundary_id, delegated_subject, scope_set, resource_scope, purpose)`.
- DWD scopes must match the approved Google Admin console client authorization and momo scope inventory.

`shared_drive_member`-only rules:

- `shared_drive_id` names exactly one momo-managed shared drive; `shared_drive_role` is `content_manager` in v0. `allowed_subject_domains` is empty and the §7 delegated-subject model does not apply — the boundary must never mint delegated tokens.
- Scope set follows the §5 inventory: `drive.file` as the service account itself is preferred. If runtime evidence shows SA-side `drive.file` is insufficient for changes.list/download on the shared drive, SA-only `drive.readonly` may be recorded with justification in the scope inventory (`research/13-redesign/03` §6, 실증 1 — runtime-unverified until MOMO-320).
- Revoking the boundary = remove the service account from the shared drive membership `[manual]`, disable/delete credential material, set status `revoked`, and delete the derived index rows built from that drive (the MOMO-122 §2 carve-out is revocable by construction).

## 7. User Delegation Model

Delegation is not anonymous domain access. A delegated read uses:

| Field | Meaning |
|---|---|
| `delegated_subject` | Google user principal being impersonated. |
| `delegated_member_id` | momo human member mapped to that Google user when available. |
| `delegation_basis` | `admin_policy`, `user_opt_in`, `legal_hold`, or `support_case`. v0 product path should use `admin_policy` plus optional `user_opt_in`. |
| `resource_scope` | Mailbox query, calendar window, Drive corpus/file/shared drive scope. |
| `request_actor_member_id` | Human initiating the momo request. |
| `agent_member_id` | Agent member receiving Context Packet/tool grant. |
| `purpose` | Short user-visible reason included in audit. |
| `expires_at` | Delegation decision TTL. |

Projection requirements:

- Context Packet `scope.permission_basis[]` must include `google_workspace_enterprise_install`, `domain_wide_delegation`, `delegated_subject`, and the relevant scope/resource basis.
- Context Packet `sources[]` must name the source kind and delegated permission snapshot, but not service account credentials.
- Memory Plane may store only `external_source_ref` or `artifact_ref` with provider grant version and delegated subject hash. Gmail delegated refs are personal or admin visibility unless a human explicitly shares a reviewed summary.
- Capability Cache may project delegated read tools only when the current actor, delegated subject, scope inventory, resource scope, and service account boundary all pass. Write-like tools remain `propose` or denied.

## 8. Context Packet / Memory Plane / Capability Cache

### 8.1 Context Packet

Enterprise sources use the same `sources[]` contract as MOMO-122 with extra permission evidence:

- `permission_snapshot` includes `enterprise_install:<id>`, `dwd:<active|disabled>`, `delegated_subject_hash`, `scope_inventory_version`, and `resource_scope`.
- `redactions[]` records any source withheld due to DWD disabled, scope not approved, delegated subject mismatch, stale admin review, provider 403/404, or user deletion.
- `tool_grants[]` must not include admin/setup tools for ordinary mention runs.

### 8.2 Memory Plane

Enterprise-backed memory follows MOMO-152:

- Default memory type is `external_source_ref`.
- Durable summaries must cite the enterprise source ref and keep the delegated subject permission snapshot.
- Retrieval rechecks workspace membership, source visibility, DWD status, scope inventory version, service account boundary status, delegated subject status, and provider resource availability.
- Revocation hides future retrieval. Tombstones can keep citation metadata only when policy permits.

### 8.3 Capability Cache

Enterprise capabilities are `plugin_tool_schema` entries with:

- `source.provider = "google_workspace"`
- `source.kind = "provider_connector"` or `admin_override`
- `visibility.scope = "workspace"` for delegated read tools, `admin` for install/audit tools
- `policy.provider_grant_version = enterprise_install_id + scope_inventory_version`
- `policy.resource_scopes[]` for mailbox/calendar/Drive corpora
- invalidation signals `enterprise_install_revoked`, `dwd_disabled`, `scope_inventory_changed`, `service_account_boundary_revoked`, `delegated_subject_suspended`, `provider_admin_revoked`

## 9. Audit Export

Enterprise audit export must support JSONL or CSV later. v0 fixtures use JSON.

Required event categories:

| Event | Required evidence |
|---|---|
| `enterprise_install.created` | admin ids/hashes, domains, policy version, audit export setting |
| `scope_inventory.approved` | scopes, classifications, DWD allowed/default flags, reviewer |
| `service_account_boundary.activated` | client id hash, service account redaction, credential storage ref, key policy |
| `delegated_token.minted` | delegated subject hash, scopes, resource scope, purpose, runtime actor, token ttl, no token bytes |
| `source_ref.cited` | Context Packet id, source id, delegated subject hash, excerpt checksum |
| `capability.projected` | tool name, grant, risk, approval policy, resource scope |
| `memory.revalidated` | memory id, decision, policy/source versions |
| `enterprise_install.revoked` | revoker, reason, stopped token minting, cache invalidation ids |
| `source_ref.deleted` | source id, delete path, tombstone policy |

Exports must be filterable by time range, delegated subject hash, actor member id, source kind, tool name, and event type. Export does not imply broad data export of Google content.

## 10. Revoke and Delete Flow

Admin revoke flow:

1. Set enterprise install or DWD status to `revoked` in momo policy state.
2. Stop delegated token minting immediately.
3. Delete or disable credential material referenced by `credential_storage_ref` when the customer requests local revoke/delete.
4. Invalidate Capability Cache entries that depend on the install, scope inventory, or boundary.
5. Mark source refs `revoked` or `invalidated` and hide them from future Context Packets.
6. Queue Memory Plane revalidation; hide or tombstone dependent memory based on source policy.
7. Append audit export events.
8. Tell the admin which Google Admin console/API Controls cleanup remains manual.

User delete/unlink flow:

- If the source came from per-user OAuth, use MOMO-122 user disconnect behavior.
- If the source came from DWD, delete or hide source refs for that delegated subject/resource scope inside momo and record audit evidence.
- A delegated subject leaving the Google domain, being suspended, or losing momo workspace membership hides future refs and triggers revalidation.
- Deleting a source ref does not delete the original Google resource.

## 11. Fixtures

Fixtures live in `research/11-agent-runtime/fixtures/google-workspace-enterprise-admin-v0/`:

- `admin_install_scope_inventory.json`: enterprise install policy, DWD disabled default, approved scope inventory, service account boundary placeholder, plus a `shared_drive_member` boundary example (MOMO-323).
- `dwd_delegated_context_projection.json`: active DWD read projection into Context Packet, Memory Plane, and Capability Cache without credentials.
- `audit_export_revoke_flow.json`: exportable audit event bundle plus revoke/delete invalidation effects.

Fixture boundary records carry `boundary_kind` since 2026-07-06; records without it are read as `dwd_delegation` (backward compatible).

## 12. External References

- Google OAuth 2.0 service accounts and domain-wide delegation: https://developers.google.com/identity/protocols/oauth2/service-account
- Google Workspace Admin Help, control API access with domain-wide delegation: https://support.google.com/a/answer/162106
- Google Workspace Marketplace OAuth consent configuration: https://developers.google.com/workspace/marketplace/configure-oauth-consent-screen
- Google Admin SDK Reports API overview: https://developers.google.com/admin-sdk/reports/v1/get-start/overview
- Google Admin SDK Reports API Admin audit events: https://developers.google.com/admin-sdk/reports/v1/guides/manage-audit-admin
- Google Drive API scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Google Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
