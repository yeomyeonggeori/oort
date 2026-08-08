# Google Workspace Connector v0

> Updated: 2026-07-06 (MOMO-323 corrections: `drive.metadata.readonly` is restricted-class, Internal-consent deployment assumption, oort-managed shared-drive derived-index carve-out — grounds: `research/13-redesign/03` §2·§5)
> Status: normative spec for MOMO-122. No runtime/schema implementation in this ticket.

## 1. Purpose

Google Workspace Connector v0 defines how oort imports citeable, permission-checked references from Drive, Gmail, and Calendar into the agent runtime planes without copying a user's workspace into oort.

It answers five questions:

1. Which Google account and scopes authorize a read?
2. What token and provider state may oort store?
3. Which Drive, Gmail, and Calendar read paths feed source refs?
4. How do those refs project into Context Packet, Memory Plane, and Capability Cache?
5. Which operations remain external writes that must pause for approval?

The connector is owned by oort. Google Workspace MCP servers and future domain-wide delegation can inform later implementations, but the v0 product default is per-user OAuth plus official Google APIs.

## 2. Non-Negotiable Rules

- Per-user OAuth is the only v0 authorization model. Domain-wide delegation and the shared-drive-member service-account path (`boundary_kind: shared_drive_member`) are out of scope for this spec and belong to MOMO-123; this spec only records the carve-out below so the two documents stay consistent.
- The connector stores provider ids, cursors, bounded excerpts, permission snapshots, and audit state. It must not store raw mailbox dumps, full Drive mirrors, broad calendar history, OAuth access tokens in Context Packets, or refresh tokens in Memory Plane/Capability Cache.
- Bounded carve-out to "no full Drive mirrors" (MOMO-323): for the **oort-managed workspace shared drive only** (workspace archive mode — MOMO-123 `service_account_boundary` with `boundary_kind = shared_drive_member`), oort may keep a **revocable derived index**: embeddings plus chunked text, with a permission snapshot version on every row. Those files are oort-managed artifacts, the index is rebuildable from Drive, and delete/permission-loss tombstones must remove the derived rows. User personal Drive files (`drive.file` selected) stay excerpt-only as before — oort never builds a derived full-text/embedding index from a user's personal Drive.
- Google source refs are citeable pointers, not credentials. Every ref has `workspace_id`, `subject_member_id`, provider resource id, scope snapshot, retrieval time, and delete/revoke path.
- Context Packet can include `sources.kind = google_drive|gmail|calendar` only after workspace membership, channel visibility, source grant, and redaction checks pass.
- Memory Plane can store Google-backed durable references only as `memory_type = external_source_ref` or `artifact_ref`; it must not promote Gmail or Drive body text into unsourced long-term memory.
- Capability Cache may cache connector tool schemas and grant projections, but it does not authorize access by itself. Projection rechecks the current user grant and resource scope.
- External writes are approval-gated. Gmail send/draft mutation, Calendar create/update/delete, Drive upload/share/permission change, and destructive or identity-affecting actions must project as `grant = propose`, `risk = write|identity|admin`, `approval_policy = always`, or be omitted.
- Revocation, user unlink, provider 401/403, OAuth scope change, deleted source, Drive change tombstone, Gmail message delete, Calendar event cancellation, or membership loss hides future refs and triggers Memory Plane revalidation.

## 3. Source References and Provider Grant Shape

All fields use snake_case JSON. IDs are UUID strings unless noted.

```json
{
  "schema": "momo.google_workspace.source_ref.v0",
  "source_id": "src_google_001",
  "workspace_id": "uuid",
  "subject_member_id": "uuid",
  "provider": "google_workspace",
  "source_kind": "google_drive",
  "provider_account": {},
  "provider_resource": {},
  "permission_snapshot": {},
  "sync_state": {},
  "excerpt": {},
  "lifecycle": {},
  "audit": {}
}
```

Required top-level fields:

| Field | Meaning |
|---|---|
| `schema` | Literal `momo.google_workspace.source_ref.v0`. |
| `source_id` | Stable ref id used by Context Packet `sources[].source_id`, Memory Plane `source_refs[].source_id`, and audit events. |
| `workspace_id` | oort tenant root. Required for RLS and audit. |
| `subject_member_id` | oort human member whose Google OAuth grant authorized the read. |
| `provider` | Literal `google_workspace`. |
| `source_kind` | `google_drive`, `gmail`, or `calendar`. |
| `provider_account` | Google account boundary: stable `google_subject`, primary email hash or redacted email, hosted domain when known. |
| `provider_resource` | Provider ids and display metadata safe for source badges. |
| `permission_snapshot` | OAuth scopes, user grant version, resource scope, app verification class, and oort visibility decision. |
| `sync_state` | Cursor/change token/search query/time window used to retrieve or refresh the ref. |
| `excerpt` | Bounded, redacted excerpt or metadata summary fit for citation. |
| `lifecycle` | Delete, revoke, invalidation, tombstone, and retention behavior. |
| `audit` | Connector policy, source policy, and provider request evidence. |

## 4. OAuth and Token Boundary

### 4.1 Per-User Grant

v0 uses one grant per oort workspace member and Google account:

```json
{
  "grant_id": "gw_grant_user_001",
  "workspace_id": "uuid",
  "subject_member_id": "uuid",
  "google_subject": "google-oauth-sub",
  "google_primary_email_hash": "sha256:...",
  "scopes": [],
  "scope_grant_version": "google-workspace-grant@2026-06-27:001",
  "status": "active",
  "created_at": "RFC3339",
  "last_verified_at": "RFC3339",
  "revoked_at": null
}
```

Boundary rules:

- Access tokens are short-lived process/runtime material. They are never persisted in Context Packet, Memory Plane, Capability Cache, audit props, logs, or fixtures.
- Refresh tokens, when needed for offline sync, live only in encrypted secret storage keyed by `grant_id`. Docs and fixtures may refer to `token_storage_ref`, never token bytes.
- Grant lookup is always `(workspace_id, subject_member_id, google_subject)`. Agents cannot borrow another user's Google grant unless the request is explicitly delegated and the grant policy allows it.
- Incremental authorization is preferred. The initial consent asks only for the requested surface, then expands to Gmail/Calendar/Drive scopes when the user enables that source.
- OAuth consent and code exchange use CSRF `state`, exact redirect URI matching, and `access_type=offline` only when background read sync is enabled.
- Token refresh failures hide affected source refs until the user reconnects.

### 4.2 v0 Scope Policy

Official scope pages classify broad data scopes as sensitive or restricted. v0 therefore prefers the narrowest scope that can satisfy the selected feature.

**Verification-class correction (2026-07, MOMO-323):** `drive.metadata.readonly` is a **restricted-class** scope — the same app-verification class as `drive` and `drive.readonly`. It is not a lighter "metadata tier"; earlier revisions of the table below implied otherwise. Among the Drive scopes in this spec only `drive.file` is non-sensitive.

**Deployment assumption (Internal consent):** self-hosted oort assumes each deploying organization owns its own GCP project and configures the OAuth consent screen as **User type = Internal** (users restricted to the same Google Workspace organization). Internal apps are exempt from Google app verification and the CASA security assessment, so restricted-class scopes carry no external verification burden in this deployment shape. The binding limit on scope selection is therefore oort's own policy — non-retention, least privilege, approval-gated writes — not Google verification economics. External/multi-tenant consent screens are out of scope for v0. Setup runbook: `docs/GWS_INTERNAL_CONSENT_RUNBOOK.md`; grounds: `research/13-redesign/03` §2.

| Surface | Preferred scopes | Notes |
|---|---|---|
| Drive selected files | `https://www.googleapis.com/auth/drive.file` plus picker/resource allowlist | Non-sensitive class. Preferred for user-selected Drive files because it keeps access resource-scoped. |
| Drive metadata/index | `https://www.googleapis.com/auth/drive.metadata.readonly` | **Restricted-class** (same verification class as `drive.readonly`; corrected 2026-07, MOMO-323). For metadata, changes, and source badge refresh. Verification-exempt only under the Internal-consent deployment assumption above; still not default. |
| Drive full/excerpt export | `https://www.googleapis.com/auth/drive.readonly` only after explicit user consent and policy approval | Restricted. Store bounded excerpts, not full mirrors (the §2 derived-index carve-out applies only to the oort-managed shared drive). |
| Gmail metadata search | `https://www.googleapis.com/auth/gmail.metadata` | Restricted but narrower than full body read; supports headers/labels without body. |
| Gmail thread/message read | `https://www.googleapis.com/auth/gmail.readonly` | Restricted. Use only for user-approved search/thread read windows and bounded excerpts. |
| Calendar availability | `https://www.googleapis.com/auth/calendar.freebusy` or `https://www.googleapis.com/auth/calendar.events.freebusy` | Availability summaries should prefer busy windows over event bodies. |
| Calendar event read | `https://www.googleapis.com/auth/calendar.events.readonly` | For user-approved event context and citations. |
| External writes | Gmail `send`/`compose`/`modify`, Calendar `events`, Drive upload/share/permission scopes | Not requested by default. If installed later, project only approval-gated propose grants. |

References checked for this spec: Google Drive scope guidance, Drive changes, Gmail scopes/search, Calendar scopes/freebusy/events, and Google OAuth offline/incremental auth docs.

## 5. Read-Mostly Sync Paths

### 5.1 Drive Changes and Selected File Excerpts

Drive v0 has two modes:

1. Selected-file mode: user picks files or shares files with oort. Resource scope is the selected provider file ids.
2. Metadata/index mode: oort tracks metadata changes for files visible to the grant, subject to policy and user consent.

Read path:

1. On connect, create a per-user grant and store the Drive scope set.
2. For metadata/index mode, request a Drive start page token and store it as `sync_state.cursor.start_page_token_ref`.
3. Poll or receive notification triggers, then call Drive changes list with the last page token.
4. For each changed file, store metadata needed for a source badge: file id, name, mime type, web/view URL, owners redacted or hashed, modified time, shared drive id when present, trashed/deleted flag, and checksum/version when available.
5. Fetch content excerpts only when a user-selected file, message action, slash command, or explicit source picker needs it. Excerpts are bounded and redacted before Context Packet inclusion.
6. Tombstones or permission-loss changes invalidate matching source refs and mark dependent Memory Plane items for revalidation.

Drive `provider_resource` fields:

- `drive_file_id`
- `drive_id` or `shared_drive_id`, nullable
- `name`
- `mime_type`
- `web_url`
- `resource_key`, nullable and never shown to agents unless required for provider fetch
- `revision_id` or `head_revision_id`, nullable
- `modified_time`
- `trashed`

### 5.2 Gmail Thread/Search Read

Gmail v0 is read-mostly and query/window based. It never builds a full mailbox mirror.

Read path:

1. User enables Gmail source and grants metadata or readonly scope.
2. Context Broker creates a bounded search plan from a user request, source picker, or channel action. The plan records query text, label filters, time window, max threads/messages, and redaction policy.
3. For metadata-only grants, oort can store thread ids, message ids, labels, internal date, sender/recipient hashes, and subject snippets. It cannot store body excerpts.
4. For readonly grants, oort may fetch selected thread/message bodies and keep only bounded excerpts needed for citation. Attachments are references only unless separately selected and scanned.
5. Gmail API search differences from the Gmail UI are recorded in `sync_state.query_semantics`. Thread-wide search behavior must not be assumed unless proven by returned messages.
6. Delete/revoke/lost-scope events hide refs and invalidate dependent memory. If Gmail returns 404/403 for a previously stored ref, Context Packet withholds it.

Gmail `provider_resource` fields:

- `gmail_thread_id`
- `gmail_message_ids`
- `history_id`, nullable
- `label_ids`
- `subject_redacted`
- `participants_redacted`
- `internal_date_range`
- `query`

### 5.3 Calendar Availability and Events

Calendar v0 separates availability from event content.

Read path:

1. Availability requests use free/busy scopes whenever possible and store busy windows, not event titles or descriptions.
2. Event context requests use event-read scopes and a narrow time window. The source ref stores event id, calendar id, summary redaction, start/end, attendee role, organizer redaction, and recurrence marker.
3. Incremental event sync may use Calendar events list `syncToken`, but token expiry requires clearing connector-local calendar state and rebuilding from a bounded full sync window.
4. Calendar cancellations, deleted calendars, provider 410/403, and grant revocation invalidate source refs and Memory Plane projections.
5. Scheduling suggestions are read-only. Creating, updating, cancelling, inviting attendees, or changing calendar ACLs are external writes and require approval-gated tool grants.

Calendar `provider_resource` fields:

- `calendar_id`
- `event_id`, nullable for freebusy-only refs
- `ical_uid`, nullable
- `time_min`
- `time_max`
- `busy_windows`
- `event_summaries`, bounded and redacted when event-read scope exists
- `time_zone`

## 6. Context Packet Projection

Google connector refs enter Context Packet through `sources[]` and may be referenced by `memory_refs[].source_ids`.

Required Context Packet source fields for Google refs:

| Context Packet field | Google connector source |
|---|---|
| `source_id` | `source_id` |
| `kind` | `google_drive`, `gmail`, or `calendar` |
| `title` | Redacted provider display title or generated availability/search title |
| `uri` | Provider URL when safe, otherwise `momo://sources/google-workspace/...` |
| `workspace_id` | `workspace_id` |
| `permission_snapshot` | Short summary of grant, resource scope, and actor visibility |
| `retrieved_at` | `sync_state.retrieved_at` |
| `excerpt` | Bounded excerpt or availability summary |
| `checksum` | Provider revision/hash or oort excerpt hash when available |

Additional `source_refs` metadata may be stored in future DB records, but Context Packet must remain bounded and credential-free.

Projection rules:

- `request.actor_member_id` must match `subject_member_id` unless an explicit delegated source grant exists.
- `scope.permission_basis` must include the relevant connector grant, for example `google_workspace_grant:gmail.readonly`.
- `redactions[]` must list any withheld source, narrowed scope, PII redaction, or restricted-scope body omission.
- `recent_messages[]` may cite Google refs only through `source_id`; it must not inline external content beyond the bounded excerpt.

## 7. Memory Plane Projection

Google-backed durable memory uses `memory_type = external_source_ref` by default. `artifact_ref` is allowed for user-selected Drive files that represent durable artifacts, such as PRDs or runbooks.

Required Memory Plane fields:

| Memory Plane field | Google connector rule |
|---|---|
| `subject.kind` | `external_source` or `artifact` |
| `statement.summary` | Human-readable bounded summary, never a full email/doc/event dump |
| `visibility.scope` | `personal` by default; `channel` or `workspace` only when the source was explicitly shared or linked in that scope |
| `source_refs[].source_kind` | `google_drive`, `gmail`, or `calendar` |
| `source_refs[].permission_snapshot` | Must include `provider_grant_version` and resource scope |
| `permissions.retrieval_policy_version` | Current memory policy plus connector policy version |
| `validity.refresh_policy` | `provider_change_token`, `on_access`, or `manual_review` |
| `lifecycle.delete_path` | User-visible unlink/delete path |

Revalidation rules:

- Retrieval checks current workspace membership, source visibility, active Google grant, scope compatibility, and provider resource availability.
- Personal Gmail refs do not become workspace memory unless a human explicitly shares the message/thread into an oort channel or stores a reviewed summary with safe visibility.
- Drive docs shared in a channel can become `artifact_ref` or `external_source_ref` with `channel` visibility only if the actor and agent can still read the channel and the Drive grant/resource scope remains valid.
- Calendar availability memory should expire quickly and prefer `task_state` or `external_source_ref` with short TTL. It must not become permanent availability profiling.

## 8. Capability Cache and Tool Grants

Google Workspace connector tools are cached as `plugin_tool_schema` entries with `source.kind = provider_connector` and `source.provider = google_workspace`.

Read tools may project as direct `read` grants only when the current per-user grant and resource scope pass:

| Tool | Allowed operations | Risk | Approval policy |
|---|---|---|---|
| `google_workspace.drive.search` | `search_files`, `fetch_file_metadata`, `fetch_file_excerpt` | `read` | `none` for selected/resource-scoped reads |
| `google_workspace.gmail.search_threads` | `search_threads`, `fetch_thread_metadata`, `fetch_thread_excerpt` | `read` | `none` when readonly grant and bounded query pass |
| `google_workspace.calendar.availability` | `query_freebusy`, `list_events_window` | `read` | `none` for freebusy/read-only event windows |

Write-like tools must not execute directly:

| Tool | Risk | v0 projection |
|---|---|---|
| `google_workspace.gmail.send` | `write` | `grant = propose`, `approval_policy = always`, or omitted if write scopes are absent |
| `google_workspace.gmail.create_draft` | `write` | `grant = propose`, `approval_policy = always` |
| `google_workspace.calendar.create_event` | `write` | `grant = propose`, `approval_policy = always` |
| `google_workspace.calendar.update_event` | `write` | `grant = propose`, `approval_policy = always` |
| `google_workspace.drive.upload_file` | `write` | `grant = propose`, `approval_policy = always` |
| `google_workspace.drive.share_file` | `identity` | `grant = propose`, `approval_policy = always` |
| `google_workspace.drive.change_permission` | `admin` | deny or admin approval only; out of v0 read-mostly sync |

Capability entries must include:

- `policy.provider_grant_version`
- `schema_ref.resource_scope_ref` for selected files, mailbox query windows, calendars, or event windows
- `tool.required_grants` containing OAuth scopes
- `risk.writes_external_system`
- `approval.approval_policy`
- invalidation signals `provider_grant_revoked`, `provider_scope_changed`, `workspace_policy_changed`, and provider-specific cursor expiry

## 9. Deletion, Revocation, and User Controls

User-visible controls:

- Disconnect Google account for a workspace member.
- Revoke individual source refs from oort memory/context.
- Delete or unlink Memory Plane items created from Google refs.
- Refresh a source ref or mark it stale.
- View which Context Packets and agent runs cited a source ref.

Connector lifecycle effects:

| Event | Effect |
|---|---|
| User disconnects Google | Mark grant `revoked`, delete encrypted refresh token, hide source refs, invalidate capabilities, queue memory revalidation. |
| Google OAuth revocation or token refresh failure | Same as disconnect, but reason is `provider_grant_revoked` or `token_refresh_failed`. |
| Scope narrowed | Hide refs requiring removed scopes; keep metadata-only refs only if still allowed. |
| Drive file removed/permission lost | Tombstone source ref; Memory Plane keeps citation-only tombstone or hides per policy. |
| Gmail message/thread deleted or inaccessible | Hide ref; do not keep body excerpt unless retention policy explicitly allows citation-only tombstone. |
| Calendar event cancelled/deleted | Mark stale or cancelled; availability refs expire on TTL. |
| oort member leaves workspace/channel | Future Context Packets cannot include personal or channel refs for that actor; memory retrieval rechecks visibility. |

Token deletion must happen before user-facing disconnect returns success. If provider revocation API is unavailable, oort still deletes local token material and marks the grant revoked.

## 10. Runtime Boundaries

This ticket does not implement runtime tables or API clients. Future implementation should add migrations and code without changing `schema_v0.sql` directly.

Suggested future storage boundaries:

- `google_workspace_grant`: per-user grant metadata and encrypted token reference.
- `google_workspace_source_ref`: provider resource metadata, permission snapshots, and lifecycle.
- `google_workspace_sync_cursor`: Drive page token, Gmail history/search window state, Calendar sync token/time window.
- `google_workspace_audit`: connect, refresh, cite, revoke, delete, and approval events.

All user-facing reads must run under normal workspace/RLS checks. A future connector worker may perform provider polling, but Context Packet inclusion still rechecks membership, source grants, and policy without BYPASSRLS.

## 11. Fixtures

Fixtures live in `research/11-agent-runtime/fixtures/google-workspace-connector-v0/`:

- `drive_source_ref_context_projection.json`: Drive selected-file source ref projected into Context Packet `sources[]`, Memory Plane `external_source_ref`, and a read-only Capability Cache grant.
- `gmail_thread_source_ref.json`: Gmail bounded thread/search ref with restricted-scope boundary, redactions, and memory projection constraints.
- `calendar_availability_context_projection.json`: Calendar freebusy/event read projection with short TTL memory and approval-gated write grants withheld.

## 12. External References

- Google Drive API scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Google Drive changes: https://developers.google.com/workspace/drive/api/guides/manage-changes
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail search and filtering: https://developers.google.com/workspace/gmail/api/guides/filtering
- Google Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
- Calendar FreeBusy query: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Calendar Events list: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- Google OAuth web server flow: https://developers.google.com/identity/protocols/oauth2/web-server
