# ADR-0118: Workspace identity read and rename boundary

> Status: Accepted (성재 승인, 2026-07-15; workspace-first UX 요청)
> Related: ADR-0100, ADR-0112, MOMO-383/#387

## Context

ADR-0112 places the workspace above channels and direct messages, but the app previously kept its display name only in local preferences. That made two clients disagree and offered no tenant-safe authority for a workspace identity. Adding a read and rename API also introduces a public API and authorization boundary, which requires an Accepted ADR under ADR-0100.

## Options

1. **Keep the name local-only.** Rejected because a workspace identity must be shared by every member and survive reinstall or another client.
2. **Allow every active member to rename.** Rejected because identity changes affect the whole tenant and need an accountable administrative boundary.
3. **Allow only platform administrators through BYPASSRLS.** Rejected because ordinary workspace administration must remain tenant-scoped and must not widen BYPASSRLS.
4. **Tenant-scoped read for active members, owner/admin rename with optimistic concurrency.** Accepted.

## Decision

- Add authenticated `GET /v1/workspaces/:workspaceId` for active, non-deleted members of that workspace.
- Add authenticated `PATCH /v1/workspaces/:workspaceId` for active, non-deleted workspace owners and admins.
- The patch accepts a normalized 1-80 character name and `expectedUpdatedAtMs`. A stale version returns `409` and performs no write.
- Read and write use the normal tenant transaction and RLS context. No workspace identity path uses `BYPASSRLS`.
- A successful rename and its `workspace.name.updated` audit record commit in the same transaction. Denied or stale attempts create no success audit record.
- Client cache fallback is server-origin + authenticated-member + workspace scoped. It is allowed only for transient transport/5xx failure; 401/403/404 must not reveal cached identity.
- Workspace icon and invite-policy persistence are not part of this decision and remain explicitly local drafts until a later ADR/API.

## Industry comparison

Slack and Discord present the workspace/server as shared administrative identity, while rename authority is restricted to administrative roles. momo follows that familiar boundary while preserving its stronger tenant transaction, RLS, audit, and optimistic-concurrency requirements.

## Consequences

- Workspace names become durable and consistent across authorized clients.
- Concurrent administrators cannot silently overwrite one another; the losing client reloads before retry.
- Suspended, deleted, unauthorized, and cross-tenant principals cannot read or mutate identity through this surface.
- The API and role policy are now explicit decision contracts rather than implementation detail.
