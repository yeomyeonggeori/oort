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
- The tenant root itself is protected by `workspace` ENABLE/FORCE RLS. Its policy admits only the row whose `id` equals the transaction-local `app.workspace_id`; a missing or different context exposes no workspace row and permits no update.
- Public invite join cannot know that context before resolving its bearer code. The sole exception is `momo_join_private.invite_workspace_id(text)`, owned by the migration/database owner in a locked schema: fixed `pg_catalog` search path, static SQL, schema/function PUBLIC revoked, and explicit schema USAGE + function EXECUTE only for the app role. Migration 009 creates both private objects exactly; any pre-existing schema/function makes the transaction fail instead of adopting or replacing drifted privileged code. Broad grants on `public` therefore cannot reopen it to relay, worker, or platform roles. Internal smoke may apply migration 009 before its test-only roles and must then reassert app USAGE/EXECUTE plus relay/worker denial. Production (`MOMO_BOOTSTRAP_RUNTIME_ROLES=0`) has the opposite executable contract: externally managed app/relay/worker roles with their required RLS attributes must exist before migration, or the migration job fails before creating `schema_migrations`. The fresh-order verifier covers both orders and the exact ACL allowlist. Only the exact normalized invite hash may return one active workspace UUID. It returns no workspace or invite row data; all status reads and writes resume under that exact tenant context. This is not a workspace identity API and grants no enumeration or `BYPASSRLS` role.
- Approved platform inspection keeps the pre-existing separate `momo_platform_admin` BYPASSRLS connection in a read-only transaction. It cannot back ordinary workspace reads or writes and receives no invite lookup EXECUTE grant.
- A successful rename and its `workspace.name.updated` audit record commit in the same transaction. Denied or stale attempts create no success audit record.
- Client cache fallback is server-origin + authenticated-member + workspace scoped. It is allowed only for transient transport/5xx failure; 401/403/404 delete that exact persisted cache before hiding identity, so a later 5xx cannot revive denied data.
- Bootstrap, refresh, rename-conflict reload, and realtime subscriptions are session/workspace-generation bound. Every awaited result is discarded after logout or session switch, including delayed errors.
- Workspace icon and invite-policy persistence are not part of this decision and remain explicitly local drafts until a later ADR/API.

## Industry comparison

Slack and Discord present the workspace/server as shared administrative identity, while rename authority is restricted to administrative roles. oort follows that familiar boundary while preserving its stronger tenant transaction, RLS, audit, and optimistic-concurrency requirements.

## Consequences

- Workspace names become durable and consistent across authorized clients.
- Concurrent administrators cannot silently overwrite one another; the losing client reloads before retry.
- Suspended, deleted, unauthorized, and cross-tenant principals cannot read or mutate identity through this surface.
- Invite discovery has a deliberately tiny privileged boundary whose runtime gate verifies owner, ACL, fixed search path, static SQL, nonexistent-code behavior, and lack of tenant-row visibility.
- The API and role policy are now explicit decision contracts rather than implementation detail.
