//! ADR-0113 P3 (#3914) — the plugin registry's four writes, as domain functions.
//!
//! ```text
//! install        workspace owner/admin   POST   …/plugins/{plugin}/install
//! uninstall      workspace owner/admin   DELETE …/plugins/{plugin}/install
//! grant          the member, for self    POST   …/plugins/{plugin}/grants
//! revoke_grant   the member, for self    DELETE …/plugins/{plugin}/grants/{scope}
//! ```
//!
//! 결재 원문: 2026-10-15 「이월 풀고 읽기부터 (추천)」(쓰기는 P3 다음 단계로 미룸) ·
//! 2026-10-16 「미뤄둔 후속도 같이 작업해줘.」
//!
//! The semantics are the retired Swift `PluginRoutes.swift` (`8f4a23cac^`); the
//! wire is what the deployed core parser reads (`pluginMutationFromWire`). What
//! this module adds on top of Swift is stricter, never looser:
//!
//! * **D1-A (custody).** No function here takes, stores, logs or returns a
//!   provider credential. The tables it writes (`workspace_plugin_install`,
//!   `plugin_grant`, `plugin_capability_projection`, `audit_log`) have no column
//!   that could hold one, and every audit `detail` is built by a function whose
//!   key set a test pins.
//! * **D2 (4-tuple, delegated user).** A grant row is `(workspace, member,
//!   plugin, scope)` and its `granted_by` is always the member itself
//!   (`plugin_grant_self_ck`). There is no signature that names another member,
//!   so an admin cannot grant for someone else; and [`grant`] itself — not only
//!   the HTTP shell in front of it — refuses a member that is not a human, or is a
//!   guest (a hosted app such as Drive reads workspace data with the server's own
//!   credential, so for it the grant is the only per-member gate).
//! * **D5 (egress, fail-closed).** An install or grant answers with the
//!   manifest's `egressDomains` (the receipt of what was consented to) and
//!   records them, with the manifest version and digest, in the audit row. A
//!   disabled or revoked install hides every tool from the caller's policy
//!   (the read side joins on it), and revoking deletes the projection outright.
//!
//! Two functions, one set of rules: the REST handlers
//! (`routes::plugins::{install, uninstall, grant, revoke_grant}`) and the team
//! AI's `plugin.install` approval card (#3889) call these, so what the card does
//! when approved is what the route does, by construction. Every function runs
//! inside a tenant transaction the caller opened (`with_tenant_tx`, RLS FORCE),
//! returns every rejection **before its first write**, and writes its own
//! `audit_log` row first — the `*_audit_id` columns are `NOT NULL REFERENCES
//! audit_log`, so an executor cannot leave that to a later step.
//!
//! Revocation is always possible; creation is not. A plugin the registry has
//! since revoked (or marked unofficial) can no longer be installed or granted,
//! but its install and grants can still be taken away. Only the official four
//! (ADR-0113 P2) are addressable at all — `external_webhook`'s install row has
//! its own lifecycle (ADR-0115) and is not reachable from here.

use axum::http::StatusCode;
use momo_auth::{active_workspace_role, WorkspaceRole};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::sqlx;
use momo_db::{DbError, PgConnection};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::ApiError;
use crate::plugin_manifest::{is_scope, ValidatedPluginManifest, ValidatedPluginTool};
use crate::routes::invites::require_admin;
use crate::routes::plugins::{registry_rows, NOT_FOUND, OFFICIAL_PLUGIN_IDS};
use crate::routes::shared::DbRejectable;

/// `audit_log.detail.schema` values (Swift's, unchanged).
pub const SCHEMA_INSTALLED: &str = "momo.plugin.installed.v1";
pub const SCHEMA_REVOKED: &str = "momo.plugin.revoked.v1";
pub const SCHEMA_GRANT: &str = "momo.plugin.grant.v1";
pub const SCHEMA_GRANT_REVOKED: &str = "momo.plugin.grant.revoked.v1";

/// One audit row's identity: the `audit_log.action`, the `detail.schema` that
/// versions its payload, and the kind of row it points at (Swift's, unchanged).
#[derive(Debug, Clone, Copy)]
struct AuditKind {
    action: &'static str,
    schema: &'static str,
    target_type: &'static str,
}

const AUDIT_INSTALLED: AuditKind = AuditKind {
    action: "plugin.installed",
    schema: SCHEMA_INSTALLED,
    target_type: "plugin_install",
};
const AUDIT_REVOKED: AuditKind = AuditKind {
    action: "plugin.revoked",
    schema: SCHEMA_REVOKED,
    target_type: "plugin_install",
};
const AUDIT_GRANT_CREATED: AuditKind = AuditKind {
    action: "plugin.grant.created",
    schema: SCHEMA_GRANT,
    target_type: "plugin_grant",
};
const AUDIT_GRANT_REVOKED: AuditKind = AuditKind {
    action: "plugin.grant.revoked",
    schema: SCHEMA_GRANT_REVOKED,
    target_type: "plugin_grant",
};

/// 404 body for an install row that is not there (the plugin itself is known).
pub const INSTALL_NOT_FOUND: &str = "plugin install not found";
/// 404 body for a grant the caller does not hold.
pub const GRANT_NOT_FOUND: &str = "plugin grant not found";
/// 409 body for a grant against an app that is not installed and enabled.
pub const NOT_INSTALLED: &str = "plugin is not installed and enabled";

/// Who acts, as the audit row records it.
#[derive(Debug, Clone, Copy)]
pub struct Actor {
    pub member_id: Uuid,
    /// `audit_log.via_token_id` — a bearer's `token` row (`audit_via_token_id`).
    pub via_token_id: Option<Uuid>,
}

/// What the approval-card path adds to the same audit row (#3889). The REST
/// routes pass `Provenance::default()`.
///
/// Typed fields, not a free-form map: the only text a caller can add to an audit
/// `detail` is two ids, so there is no key name for a secret to hide behind.
#[derive(Debug, Clone, Default)]
pub struct Provenance {
    /// `audit_log.subject_member_id` when the action is done *for* someone else
    /// (the proposing agent). `None` keeps the actor as its own subject.
    pub subject_member_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    /// `detail.via_agent` — the agent whose proposal an approver carries out.
    pub via_agent: Option<Uuid>,
    /// `detail.approval_id` — the approval that authorised it.
    pub approval_id: Option<Uuid>,
}

/// The result of one write, projected onto `PluginMutationResponse` by the
/// route layer.
#[derive(Debug, Clone, PartialEq)]
pub struct Mutation {
    pub plugin_id: String,
    pub member_id: Option<Uuid>,
    pub scope: Option<String>,
    pub status: &'static str,
    pub enabled: bool,
    pub audit_ref: Option<Uuid>,
    /// Tool names the grant projected; empty for everything else.
    pub capabilities: Vec<String>,
    /// D5 receipt. Set on the two writes that extend access (install, grant),
    /// absent on the two that take it away.
    pub egress_domains: Option<Vec<String>>,
    /// `true` when this call created the row (HTTP 201), `false` when it
    /// updated or restored one (HTTP 200).
    pub created: bool,
}

// ---- pure helpers ------------------------------------------------------------

/// Swift `normalizedScope`: trim, lowercase, then the `plugin_grant.scope`
/// grammar. `None` is a 400 at the route.
pub fn normalize_scope(raw: &str) -> Option<String> {
    let scope = raw.trim().to_ascii_lowercase();
    is_scope(&scope).then_some(scope)
}

/// Whether `plugin_id` is one of the four addressable apps (ADR-0113 P2).
pub fn is_official_four(plugin_id: &str) -> bool {
    OFFICIAL_PLUGIN_IDS.contains(&plugin_id)
}

/// The tools a scope projects: every tool whose manifest `scopes` names it.
pub fn tools_for_scope<'a>(
    manifest: &'a ValidatedPluginManifest,
    scope: &str,
) -> Vec<&'a ValidatedPluginTool> {
    manifest
        .tools
        .iter()
        .filter(|tool| tool.scopes.iter().any(|declared| declared == scope))
        .collect()
}

/// The audit `detail` an install writes. Key set pinned by a test.
pub fn installed_detail(
    manifest: &ValidatedPluginManifest,
    manifest_digest: &str,
    enabled: bool,
) -> Map<String, Value> {
    object(json!({
        "schema": SCHEMA_INSTALLED,
        "plugin_id": manifest.plugin_id,
        "enabled": enabled,
        "version": manifest.version,
        "manifest_digest": manifest_digest,
        "egress_domains": manifest.egress_domains,
    }))
}

/// The audit `detail` an uninstall writes.
pub fn revoked_detail(plugin_id: &str) -> Map<String, Value> {
    object(json!({
        "schema": SCHEMA_REVOKED,
        "plugin_id": plugin_id,
    }))
}

/// The audit `detail` a grant writes: what the member consented to, including
/// where the app reaches out to (D5).
pub fn grant_detail(
    manifest: &ValidatedPluginManifest,
    manifest_digest: &str,
    scope: &str,
    tools: &[&ValidatedPluginTool],
) -> Map<String, Value> {
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    object(json!({
        "schema": SCHEMA_GRANT,
        "plugin_id": manifest.plugin_id,
        "scope": scope,
        "version": manifest.version,
        "manifest_digest": manifest_digest,
        "egress_domains": manifest.egress_domains,
        "tools": names,
    }))
}

/// The audit `detail` a grant revoke writes.
pub fn grant_revoked_detail(plugin_id: &str, scope: &str) -> Map<String, Value> {
    object(json!({
        "schema": SCHEMA_GRANT_REVOKED,
        "plugin_id": plugin_id,
        "scope": scope,
    }))
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `detail` plus the two provenance ids, when the card path supplied them. The
/// write set's own keys are never replaced.
pub fn with_provenance(mut detail: Map<String, Value>, provenance: &Provenance) -> Value {
    for (key, id) in [
        ("via_agent", provenance.via_agent),
        ("approval_id", provenance.approval_id),
    ] {
        if let Some(id) = id {
            detail
                .entry(key.to_string())
                .or_insert_with(|| Value::String(id.to_string()));
        }
    }
    Value::Object(detail)
}

fn audit_entry(
    workspace_id: Uuid,
    kind: AuditKind,
    target_id: Uuid,
    actor: Actor,
    provenance: &Provenance,
    detail: Map<String, Value>,
) -> AuditEntry {
    let mut entry = AuditEntry::new(workspace_id, kind.action)
        .by(actor.member_id)
        .target(kind.target_type, target_id)
        .via_token(actor.via_token_id);
    if let Some(subject) = provenance.subject_member_id {
        entry = entry.about(subject);
    }
    if let Some(run_id) = provenance.run_id {
        entry = entry.run(run_id);
    }
    entry.with_schema(kind.schema, with_provenance(detail, provenance))
}

fn conflict(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, message)
}

// ---- gates -------------------------------------------------------------------

/// Install and uninstall are workspace authority, judged by the single
/// `require_admin` (ADR-0186 D2 judges a card's approver with the very same
/// function). The role it returns is read only for the manifest's
/// `serverPolicy.allowedRoles`; it is not a second gate, so taking `require_admin`
/// out changes the outcome (the manifest then refuses a plain member with its own
/// message) and a test sees it.
async fn install_role(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> DbRejectable<WorkspaceRole> {
    if let Err(rejection) = require_admin(conn, workspace_id, member_id).await? {
        return Ok(Err(rejection));
    }
    Ok(active_workspace_role(conn, workspace_id, member_id)
        .await?
        .ok_or_else(|| ApiError::forbidden("not a workspace member")))
}

/// Taking a grant back is for any active member of any role: consent can always be
/// withdrawn (a member who became a guest after granting still can).
async fn require_active_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> DbRejectable<()> {
    Ok(
        match active_workspace_role(conn, workspace_id, member_id).await? {
            Some(_) => Ok(()),
            None => Err(ApiError::forbidden("not a workspace member")),
        },
    )
}

/// Giving a grant is for an active **human** member who is not a guest (ADR-0113
/// D2: the delegating user's own consent; no agent-owned grants in v1). The kind
/// is checked here, in the domain function, so the rule does not depend on which
/// credentials the HTTP shell happens to admit. A guest is refused because a hosted
/// app (Drive) reads workspace data with the server's own credential: for it, the
/// grant is the only per-member gate, and a guest does not see the whole workspace.
async fn require_grantor(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> DbRejectable<()> {
    let Some(role) = active_workspace_role(conn, workspace_id, member_id).await? else {
        return Ok(Err(ApiError::forbidden("not a workspace member")));
    };
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind::text FROM member WHERE workspace_id = $1 AND id = $2")
            .bind(workspace_id)
            .bind(member_id)
            .fetch_optional(&mut *conn)
            .await?;
    if kind.as_deref() != Some("human") {
        return Ok(Err(ApiError::forbidden(
            "only a human member can grant an app",
        )));
    }
    if role == WorkspaceRole::Guest {
        return Ok(Err(ApiError::forbidden("guests cannot connect apps")));
    }
    Ok(Ok(()))
}

/// The registry row a *creating* write may act on: one of the official four,
/// official, not revoked (all three in `registry_rows`' SQL), whose manifest
/// passes admission. Anything else is the 404 a plugin that does not exist
/// gets; a manifest that fails admission is the 409 Swift answered.
async fn admitted_official(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    plugin_id: &str,
) -> DbRejectable<(String, ValidatedPluginManifest)> {
    let mut rows = registry_rows(conn, workspace_id, Some(plugin_id)).await?;
    let Some(row) = rows.pop() else {
        return Ok(Err(ApiError::not_found(NOT_FOUND)));
    };
    match row.admit() {
        Ok(manifest) => Ok(Ok((row.expected_digest, manifest))),
        Err(error) => Ok(Err(conflict(format!("plugin manifest rejected: {error}")))),
    }
}

async fn advisory_lock(conn: &mut PgConnection, key: &str) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The shared side of [`advisory_lock`]: many holders at once, but it queues
/// **behind** a waiting exclusive request, which a row-level `FOR SHARE` does not —
/// a member looping on grants could otherwise keep an admin's disable or uninstall
/// waiting indefinitely.
async fn advisory_lock_shared(conn: &mut PgConnection, key: &str) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))")
        .bind(key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The key `install`/`uninstall` hold exclusively and `grant` holds shared: the
/// one place an uninstall and a grant of the same app meet.
fn install_lock_key(workspace_id: Uuid, plugin_id: &str) -> String {
    format!("install:{workspace_id}:{plugin_id}")
}

// ---- install -----------------------------------------------------------------

/// Install (or re-enable, or disable) an official app for the workspace.
///
/// `enabled` is the request's; `None` takes the manifest's `enabledByDefault`.
/// An existing row — even a revoked one — is updated rather than inserted
/// (`UNIQUE (workspace_id, plugin_id)`), and answers 200. A re-install after an
/// uninstall starts with no grants: uninstall revoked them, and consent is not
/// resurrected.
pub async fn install(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    plugin_id: &str,
    enabled: Option<bool>,
    actor: Actor,
    provenance: &Provenance,
) -> DbRejectable<Mutation> {
    let role = match install_role(conn, workspace_id, actor.member_id).await? {
        Ok(role) => role,
        Err(rejection) => return Ok(Err(rejection)),
    };
    let (manifest_digest, manifest) = match admitted_official(conn, workspace_id, plugin_id).await?
    {
        Ok(found) => found,
        Err(rejection) => return Ok(Err(rejection)),
    };
    if !manifest.install_allowed
        || !manifest
            .allowed_roles
            .iter()
            .any(|allowed| allowed == role.as_db_label())
    {
        return Ok(Err(ApiError::forbidden(
            "plugin serverPolicy rejects installation",
        )));
    }
    let enabled = enabled.unwrap_or(manifest.enabled_by_default);

    advisory_lock(conn, &install_lock_key(workspace_id, plugin_id)).await?;
    let existing: Option<(Uuid, bool, bool, Uuid)> = sqlx::query_as(
        "SELECT id, enabled, revoked_at IS NULL, installed_audit_id \
           FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(plugin_id)
    .fetch_optional(&mut *conn)
    .await?;
    // The same call again is a no-op, not a second record: an install that is
    // already in force in the state asked for keeps its row, its `installed_by`
    // and its audit row, and answers with that audit id.
    if let Some((_, current_enabled, true, installed_audit_id)) = existing {
        if current_enabled == enabled {
            return Ok(Ok(Mutation {
                plugin_id: plugin_id.to_string(),
                member_id: None,
                scope: None,
                status: if enabled { "enabled" } else { "disabled" },
                enabled,
                audit_ref: Some(installed_audit_id),
                capabilities: Vec::new(),
                egress_domains: Some(manifest.egress_domains.clone()),
                created: false,
            }));
        }
    }
    let created = existing.is_none();
    let install_id = existing.map(|(id, ..)| id).unwrap_or_else(Uuid::new_v4);

    let audit_id = write_audit(
        conn,
        &audit_entry(
            workspace_id,
            AUDIT_INSTALLED,
            install_id,
            actor,
            provenance,
            installed_detail(&manifest, &manifest_digest, enabled),
        ),
    )
    .await?;

    if created {
        sqlx::query(
            "INSERT INTO workspace_plugin_install \
               (id, workspace_id, plugin_id, enabled, installed_by, installed_audit_id) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(install_id)
        .bind(workspace_id)
        .bind(plugin_id)
        .bind(enabled)
        .bind(actor.member_id)
        .bind(audit_id)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "UPDATE workspace_plugin_install \
                SET enabled = $2, installed_by = $3, installed_audit_id = $4, \
                    revoked_at = NULL, revoked_by = NULL, revoked_audit_id = NULL, \
                    updated_at = now() \
              WHERE id = $1",
        )
        .bind(install_id)
        .bind(enabled)
        .bind(actor.member_id)
        .bind(audit_id)
        .execute(&mut *conn)
        .await?;
    }

    Ok(Ok(Mutation {
        plugin_id: plugin_id.to_string(),
        member_id: None,
        scope: None,
        status: if enabled { "enabled" } else { "disabled" },
        enabled,
        audit_ref: Some(audit_id),
        capabilities: Vec::new(),
        egress_domains: Some(manifest.egress_domains.clone()),
        created,
    }))
}

// ---- uninstall ---------------------------------------------------------------

/// Revoke the workspace's install and, with it, every member's grant and every
/// capability projection of that app. Idempotent: a repeat answers 200 with the
/// first revoke's audit id, and still clears any projection row that lingers.
pub async fn uninstall(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    plugin_id: &str,
    actor: Actor,
    provenance: &Provenance,
) -> DbRejectable<Mutation> {
    if let Err(rejection) = install_role(conn, workspace_id, actor.member_id).await? {
        return Ok(Err(rejection));
    }
    // Only the four. The registry row is deliberately *not* consulted: an app
    // the registry has since revoked must stay removable.
    if !is_official_four(plugin_id) {
        return Ok(Err(ApiError::not_found(NOT_FOUND)));
    }

    advisory_lock(conn, &install_lock_key(workspace_id, plugin_id)).await?;
    let row: Option<(Uuid, bool, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, revoked_at IS NULL, revoked_audit_id \
           FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(plugin_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((install_id, active, previous_audit)) = row else {
        return Ok(Err(ApiError::not_found(INSTALL_NOT_FOUND)));
    };

    let mut audit_ref = previous_audit;
    if active {
        let audit_id = write_audit(
            conn,
            &audit_entry(
                workspace_id,
                AUDIT_REVOKED,
                install_id,
                actor,
                provenance,
                revoked_detail(plugin_id),
            ),
        )
        .await?;
        sqlx::query(
            "UPDATE workspace_plugin_install \
                SET enabled = false, revoked_at = now(), revoked_by = $2, \
                    revoked_audit_id = $3, updated_at = now() \
              WHERE id = $1",
        )
        .bind(install_id)
        .bind(actor.member_id)
        .bind(audit_id)
        .execute(&mut *conn)
        .await?;
        audit_ref = Some(audit_id);
    }
    // Every grant of the app goes under the audit row that ended the install, and
    // it is swept on a repeat too: a straggler left by an older writer (the Swift
    // server read the install without a lock) is healed rather than kept alive
    // under a revoked install.
    if let Some(revoking_audit) = audit_ref {
        sqlx::query(
            "UPDATE plugin_grant \
                SET status = 'revoked', revoked_at = now(), revoked_audit_id = $3, \
                    updated_at = now() \
              WHERE workspace_id = $1 AND plugin_id = $2 AND status = 'active'",
        )
        .bind(workspace_id)
        .bind(plugin_id)
        .bind(revoking_audit)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "DELETE FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(workspace_id)
    .bind(plugin_id)
    .execute(&mut *conn)
    .await?;

    Ok(Ok(Mutation {
        plugin_id: plugin_id.to_string(),
        member_id: None,
        scope: None,
        status: "revoked",
        enabled: false,
        audit_ref,
        capabilities: Vec::new(),
        egress_domains: None,
        created: false,
    }))
}

// ---- grant -------------------------------------------------------------------

/// The calling member grants themselves one scope the app declares, and the
/// scope is projected into one capability row per tool that names it.
///
/// Order of refusals (each before the first write): not a human member of the
/// workspace, or a guest (403), unknown or non-official app (404, so install state
/// never leaks for an id outside the four), manifest rejected (409), not installed
/// and enabled (409), scope not declared by this app (400).
///
/// The install key is held **shared** from before the install check to the commit,
/// and `install`/`uninstall` hold it exclusively: a grant that races an uninstall
/// either finishes first (and the uninstall then revokes it) or waits and sees the
/// revoked install (409). Without it a grant could land after the uninstall's sweep
/// and leave an active grant under a revoked install — alive again, with no new
/// consent, at the next install. (Advisory rather than a row-level `FOR SHARE`
/// because a shared advisory request queues behind a waiting exclusive one: a
/// member looping on this call cannot starve an admin's disable or uninstall.)
///
/// An unchanged grant is a no-op: the call that finds the member's grant active
/// with exactly the projection the manifest declares now answers 200 with that
/// grant's audit id and writes nothing, so a retry does not grow `audit_log`. One
/// whose projection has drifted from the manifest is rebuilt, with a new audit row.
pub async fn grant(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    plugin_id: &str,
    scope: &str,
    actor: Actor,
    provenance: &Provenance,
) -> DbRejectable<Mutation> {
    if let Err(rejection) = require_grantor(conn, workspace_id, actor.member_id).await? {
        return Ok(Err(rejection));
    }
    let (manifest_digest, manifest) = match admitted_official(conn, workspace_id, plugin_id).await?
    {
        Ok(found) => found,
        Err(rejection) => return Ok(Err(rejection)),
    };
    advisory_lock_shared(conn, &install_lock_key(workspace_id, plugin_id)).await?;
    let installed: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2 \
            AND enabled AND revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(plugin_id)
    .fetch_optional(&mut *conn)
    .await?;
    if installed.is_none() {
        return Ok(Err(conflict(NOT_INSTALLED)));
    }
    let tools = tools_for_scope(&manifest, scope);
    if tools.is_empty() {
        return Ok(Err(ApiError::bad_request(
            "scope is not declared by this plugin",
        )));
    }

    let member_id = actor.member_id;
    advisory_lock(
        conn,
        &format!("grant:{workspace_id}:{member_id}:{plugin_id}:{scope}"),
    )
    .await?;
    let existing: Option<(Uuid, String, Uuid)> = sqlx::query_as(
        "SELECT id, status, granted_audit_id FROM plugin_grant \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 AND scope = $4 \
            FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(plugin_id)
    .bind(scope)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((_, status, granted_audit_id)) = &existing {
        if status == "active"
            && projection_matches(
                conn,
                workspace_id,
                member_id,
                plugin_id,
                scope,
                &manifest,
                &tools,
            )
            .await?
        {
            return Ok(Ok(Mutation {
                plugin_id: plugin_id.to_string(),
                member_id: Some(member_id),
                scope: Some(scope.to_string()),
                status: "active",
                enabled: true,
                audit_ref: Some(*granted_audit_id),
                capabilities: tools.iter().map(|tool| tool.name.clone()).collect(),
                egress_domains: Some(manifest.egress_domains.clone()),
                created: false,
            }));
        }
    }
    let created = existing.is_none();
    let grant_id = existing.map(|(id, ..)| id).unwrap_or_else(Uuid::new_v4);

    let audit_id = write_audit(
        conn,
        &audit_entry(
            workspace_id,
            AUDIT_GRANT_CREATED,
            grant_id,
            actor,
            provenance,
            grant_detail(&manifest, &manifest_digest, scope, &tools),
        ),
    )
    .await?;

    if created {
        sqlx::query(
            "INSERT INTO plugin_grant \
               (id, workspace_id, member_id, plugin_id, scope, status, granted_by, \
                granted_audit_id) \
             VALUES ($1, $2, $3, $4, $5, 'active', $3, $6)",
        )
        .bind(grant_id)
        .bind(workspace_id)
        .bind(member_id)
        .bind(plugin_id)
        .bind(scope)
        .bind(audit_id)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "UPDATE plugin_grant \
                SET status = 'active', granted_by = $2, granted_audit_id = $3, \
                    revoked_at = NULL, revoked_audit_id = NULL, updated_at = now() \
              WHERE id = $1",
        )
        .bind(grant_id)
        .bind(member_id)
        .bind(audit_id)
        .execute(&mut *conn)
        .await?;
    }

    // The projection is rebuilt, not patched: whatever the manifest declares now
    // is what this grant projects now.
    delete_projection(conn, workspace_id, member_id, plugin_id, scope).await?;
    for tool in &tools {
        sqlx::query(
            "INSERT INTO plugin_capability_projection \
               (workspace_id, member_id, plugin_id, scope, tool_name, capability_version, \
                schema_digest, risk, approval_tier, grant_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(workspace_id)
        .bind(member_id)
        .bind(plugin_id)
        .bind(scope)
        .bind(&tool.name)
        .bind(&manifest.version)
        .bind(&tool.schema_digest)
        .bind(&tool.risk)
        .bind(&tool.approval_tier)
        .bind(grant_id)
        .execute(&mut *conn)
        .await?;
    }

    Ok(Ok(Mutation {
        plugin_id: plugin_id.to_string(),
        member_id: Some(member_id),
        scope: Some(scope.to_string()),
        status: "active",
        enabled: true,
        audit_ref: Some(audit_id),
        capabilities: tools.iter().map(|tool| tool.name.clone()).collect(),
        egress_domains: Some(manifest.egress_domains.clone()),
        created,
    }))
}

// ---- revoke_grant ------------------------------------------------------------

/// The calling member takes back one of their own grants and its projection.
/// Idempotent: a grant that is already revoked answers 200 with the audit id of
/// the revoke that did it. A grant the caller never held is a 404 — whoever else
/// holds the same `(plugin, scope)` is invisible here.
pub async fn revoke_grant(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    plugin_id: &str,
    scope: &str,
    actor: Actor,
    provenance: &Provenance,
) -> DbRejectable<Mutation> {
    if let Err(rejection) = require_active_member(conn, workspace_id, actor.member_id).await? {
        return Ok(Err(rejection));
    }
    // Only the four — but not the registry row: a grant stays revocable.
    if !is_official_four(plugin_id) {
        return Ok(Err(ApiError::not_found(NOT_FOUND)));
    }

    let member_id = actor.member_id;
    advisory_lock(
        conn,
        &format!("grant:{workspace_id}:{member_id}:{plugin_id}:{scope}"),
    )
    .await?;
    let row: Option<(Uuid, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, status, revoked_audit_id FROM plugin_grant \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 AND scope = $4 \
            FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(plugin_id)
    .bind(scope)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((grant_id, status, previous_audit)) = row else {
        return Ok(Err(ApiError::not_found(GRANT_NOT_FOUND)));
    };

    let mut audit_ref = previous_audit;
    if status == "active" {
        let audit_id = write_audit(
            conn,
            &audit_entry(
                workspace_id,
                AUDIT_GRANT_REVOKED,
                grant_id,
                actor,
                provenance,
                grant_revoked_detail(plugin_id, scope),
            ),
        )
        .await?;
        sqlx::query(
            "UPDATE plugin_grant \
                SET status = 'revoked', revoked_at = now(), revoked_audit_id = $2, \
                    updated_at = now() \
              WHERE id = $1",
        )
        .bind(grant_id)
        .bind(audit_id)
        .execute(&mut *conn)
        .await?;
        audit_ref = Some(audit_id);
    }
    delete_projection(conn, workspace_id, member_id, plugin_id, scope).await?;

    // What the install is *now*, not what a grant needs it to have been.
    let install_enabled: Option<bool> = sqlx::query_scalar(
        "SELECT enabled AND revoked_at IS NULL FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(workspace_id)
    .bind(plugin_id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(Ok(Mutation {
        plugin_id: plugin_id.to_string(),
        member_id: Some(member_id),
        scope: Some(scope.to_string()),
        status: "revoked",
        enabled: install_enabled.unwrap_or(false),
        audit_ref,
        capabilities: Vec::new(),
        egress_domains: None,
        created: false,
    }))
}

/// Whether the member's stored projection for `(plugin, scope)` is exactly what
/// the manifest declares now: the same tools at the same version, schema digest,
/// risk and approval tier. Anything else — a tool added, dropped or re-tiered since
/// the grant — is drift, and a repeated grant refreshes it.
async fn projection_matches(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    plugin_id: &str,
    scope: &str,
    manifest: &ValidatedPluginManifest,
    tools: &[&ValidatedPluginTool],
) -> Result<bool, DbError> {
    // Compared as Rust-sorted tuples on both sides: the database's own `ORDER BY` follows the
    // cluster collation (which can rank `a_b` and `ab` differently from byte order), and with
    // the measured catalogue's snake_case names that made every repeat grant look drifted.
    let mut stored: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT tool_name, capability_version, schema_digest, risk, approval_tier \
           FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 AND scope = $4",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(plugin_id)
    .bind(scope)
    .fetch_all(&mut *conn)
    .await?;
    let mut wanted: Vec<(String, String, String, String, String)> = tools
        .iter()
        .map(|tool| {
            (
                tool.name.clone(),
                manifest.version.clone(),
                tool.schema_digest.clone(),
                tool.risk.clone(),
                tool.approval_tier.clone(),
            )
        })
        .collect();
    wanted.sort();
    stored.sort();
    Ok(stored == wanted)
}

async fn delete_projection(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    plugin_id: &str,
    scope: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 AND scope = $4",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(plugin_id)
    .bind(scope)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{is_secret_like_key, validate_manifest};

    const GITHUB: &str = include_str!("../../../../server/Fixtures/plugin-manifests/github.json");
    const DRIVE: &str = include_str!("../../../../server/Fixtures/plugin-manifests/drive.json");

    fn github() -> ValidatedPluginManifest {
        validate_manifest(GITHUB).expect("github fixture is admitted")
    }

    #[test]
    fn a_scope_is_trimmed_lowercased_and_held_to_the_column_grammar() {
        assert_eq!(
            normalize_scope(" GitHub:Read ").as_deref(),
            Some("github:read")
        );
        assert_eq!(normalize_scope("drive:read").as_deref(), Some("drive:read"));
        let too_long = "a".repeat(129);
        for bad in [
            "",
            " ",
            ":read",
            "has space",
            "semi;colon",
            "ünï",
            too_long.as_str(),
        ] {
            assert_eq!(normalize_scope(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_the_official_four_are_addressable() {
        for id in OFFICIAL_PLUGIN_IDS {
            assert!(is_official_four(id), "{id}");
        }
        // The install row of the incoming-webhook plugin is a registry id too,
        // and is exactly what a generic uninstall must not reach.
        assert!(!is_official_four("external_webhook"));
        assert!(!is_official_four("com.momo.plugins.extra"));
        assert!(!is_official_four(""));
    }

    #[test]
    fn a_scope_projects_every_tool_that_declares_it_and_no_other() {
        let manifest = github();
        let tools = tools_for_scope(&manifest, "github:read");
        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        // Migration 143 (#3944): github:read projects the 26 measured read tools, none
        // of them a write; github:write projects only the grade B tools.
        assert_eq!(names.len(), 26);
        assert!(names.contains(&"github.search_issues"));
        assert!(names.contains(&"github.search_repositories"));
        assert!(
            !names.contains(&"github.list_repositories"),
            "never a GitHub tool"
        );
        assert!(tools.iter().all(|tool| tool.risk == "read"));
        let writes = tools_for_scope(&manifest, "github:write");
        assert_eq!(writes.len(), 10);
        assert!(writes
            .iter()
            .all(|tool| tool.risk == "write" && tool.approval_policy == "always"));
        assert!(tools_for_scope(&manifest, "").is_empty());
        assert!(
            tools_for_scope(&validate_manifest(DRIVE).expect("drive"), "github:read").is_empty()
        );
    }

    /// The audit detail is an allowlist, not a pass-through: these are the only
    /// keys any of the four writes can put in `audit_log.detail` (before the card
    /// path's two provenance ids), none is credential-shaped, and the egress list
    /// the member consented to is in it.
    #[test]
    fn audit_details_carry_an_allowlist_of_keys_and_no_credential() {
        let manifest = github();
        let digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        let tools = tools_for_scope(&manifest, "github:read");
        let cases: [(&str, Map<String, Value>, &[&str]); 4] = [
            (
                "installed",
                installed_detail(&manifest, digest, true),
                &[
                    "schema",
                    "plugin_id",
                    "enabled",
                    "version",
                    "manifest_digest",
                    "egress_domains",
                ],
            ),
            ("revoked", revoked_detail("p"), &["schema", "plugin_id"]),
            (
                "grant",
                grant_detail(&manifest, digest, "github:read", &tools),
                &[
                    "schema",
                    "plugin_id",
                    "scope",
                    "version",
                    "manifest_digest",
                    "egress_domains",
                    "tools",
                ],
            ),
            (
                "grant revoked",
                grant_revoked_detail("p", "github:read"),
                &["schema", "plugin_id", "scope"],
            ),
        ];
        for (name, detail, allowed) in cases {
            let mut keys: Vec<&str> = detail.keys().map(String::as_str).collect();
            keys.sort_unstable();
            let mut wanted = allowed.to_vec();
            wanted.sort_unstable();
            assert_eq!(keys, wanted, "{name} detail keys");
            assert!(
                keys.iter().all(|key| !is_secret_like_key(key)),
                "{name} detail has a credential-shaped key"
            );
        }
        let installed = installed_detail(&manifest, digest, true);
        assert_eq!(
            installed["egress_domains"],
            json!(["api.githubcopilot.com"])
        );
        assert_eq!(installed["version"], json!("1.1.0"));
    }

    /// The card path can add exactly two ids — which agent's proposal, which
    /// approval — and nothing else: there is no field to carry any other key, and
    /// the write set's own keys are never replaced.
    #[test]
    fn provenance_adds_two_typed_ids_and_nothing_else() {
        let (agent, approval) = (Uuid::from_u128(7), Uuid::from_u128(9));
        let base = revoked_detail("com.momo.plugins.github");
        assert_eq!(
            with_provenance(base.clone(), &Provenance::default()),
            Value::Object(base.clone()),
            "the REST routes add nothing"
        );
        let carried = with_provenance(
            base.clone(),
            &Provenance {
                subject_member_id: Some(Uuid::from_u128(1)),
                run_id: Some(Uuid::from_u128(2)),
                via_agent: Some(agent),
                approval_id: Some(approval),
            },
        );
        let mut keys: Vec<&str> = carried
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["approval_id", "plugin_id", "schema", "via_agent"]);
        assert_eq!(carried["via_agent"], json!(agent.to_string()));
        assert_eq!(carried["approval_id"], json!(approval.to_string()));
        assert_eq!(carried["plugin_id"], json!("com.momo.plugins.github"));
        assert_eq!(carried["schema"], json!(SCHEMA_REVOKED));
    }
}
