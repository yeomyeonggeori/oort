//! Tenant provisioning — `POST /v1/workspaces` (MOMO-589 / ADR-0117 §D1-A).
//!
//! Port of Swift `Routes/WorkspaceRoutes.create` (:46-257). The *read* half of
//! that file (`GET /v1/workspaces/{ws}`) already landed in B4.1 and lives in
//! `momo_messaging::identity`; only provisioning is new here, and it is here
//! rather than there because it is an **operator** action on the instance, not a
//! membership read.
//!
//! ## The two things this transaction has to get right
//!
//! 1. **Two RLS scopes, in order.** Authorization reads the operator's own
//!    workspace; every seed INSERT must run under the *new* workspace, because
//!    the seeded tables carry the same FORCE policies as any other tenant row.
//!    The rebind goes through [`momo_db::rebind_tenant_guc`] so `app.workspace_id`
//!    still has exactly one setter in the tree (invariant #6).
//! 2. **The owner's password hash never enters the process.** It is copied from
//!    the operator's `human` row into a `TEMP TABLE … ON COMMIT DROP` and read
//!    back out by SQL alone (ADR-0117 §D5-A). A `SELECT password_hash` into a
//!    Rust `String` would put a credential in a heap the rest of this server can
//!    reach, for no gain.
//!
//! Slug re-use is an **explicit refusal (409)**, detected by the unique
//! constraint rather than a pre-read: under RLS a cross-tenant `SELECT` sees
//! nothing, so a check-then-insert would report "available" for every taken slug
//! on the instance.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// What the caller gets back (Swift `CreateWorkspaceResponse`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedWorkspace {
    pub workspace_id: Uuid,
    pub slug: String,
    pub name: String,
    pub owner_member_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceSpecInvalid {
    #[error("workspace name must be 1-80 characters")]
    NameLength,
    #[error("workspace name contains unsupported characters")]
    NameControlCharacters,
    #[error(
        "workspace slug must be 1-63 chars of lowercase letters, digits, or hyphens \
         (no leading or trailing hyphen)"
    )]
    Slug,
}

/// In-transaction refusals that are not failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceProvisionRejected {
    #[error("operator account not found")]
    OperatorMissing,
    #[error("workspace slug already exists")]
    SlugTaken,
}

/// Swift `normalizedName` (:395-404).
///
/// Control characters are refused rather than stripped: a name is displayed in
/// every sidebar, and a silently-altered one is a name the operator did not
/// choose.
pub fn normalized_workspace_name(raw: &str) -> Result<String, WorkspaceSpecInvalid> {
    let value = raw.trim();
    let length = value.chars().count();
    if !(1..=80).contains(&length) {
        return Err(WorkspaceSpecInvalid::NameLength);
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(WorkspaceSpecInvalid::NameControlCharacters);
    }
    Ok(value.to_string())
}

/// Swift `normalizedSlug` (:410-420), which is itself the rule
/// `infra/prod/create_workspace.sql` applies: 1..63 chars of `[a-z0-9-]`, no
/// leading or trailing hyphen. Lower-cased and trimmed first, so the REST surface
/// and the migrate-image command accept identical inputs.
pub fn normalized_workspace_slug(raw: &str) -> Result<String, WorkspaceSpecInvalid> {
    let value = raw.trim().to_ascii_lowercase();
    let length = value.chars().count();
    let charset_ok = value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let edges_ok = !value.starts_with('-') && !value.ends_with('-');
    if (1..=63).contains(&length) && charset_ok && edges_ok {
        Ok(value)
    } else {
        Err(WorkspaceSpecInvalid::Slug)
    }
}

/// Provision one tenant inside the caller's already-open transaction.
///
/// The transaction must have been opened on `operator_workspace_id`; this
/// function rebinds the GUC to the new workspace before the first seed INSERT and
/// leaves it there — the caller writes nothing else afterwards.
///
/// Returns `Ok(Err(_))` for the two refusals a client can cause and `Err(_)` only
/// for genuine failures, so the caller's transaction rolls back exactly when
/// something actually broke.
#[allow(clippy::too_many_arguments)]
pub async fn create_workspace_in_tx(
    conn: &mut PgConnection,
    operator_workspace_id: Uuid,
    operator_member_id: Uuid,
    slug: &str,
    name: &str,
) -> Result<Result<CreatedWorkspace, WorkspaceProvisionRejected>, DbError> {
    // 1) Pre-generate the tenant identifiers. `uuidv7` for time-ordering, the
    //    same generator `create_workspace.sql` uses. The workspace id has to
    //    exist before the GUC rebind because the workspace policy is id-based.
    let (new_workspace_id, owner_id, channel_id): (Uuid, Uuid, Uuid) =
        sqlx::query_as("SELECT uuidv7(), uuidv7(), uuidv7()")
            .fetch_one(&mut *conn)
            .await?;

    // 2) Snapshot the operator's identity for replication, still under the
    //    operator's own RLS scope. ON COMMIT DROP keeps the copied
    //    `password_hash` inside this transaction and out of the process.
    let seeded: u64 = sqlx::query(
        "CREATE TEMP TABLE momo_ws_seed ON COMMIT DROP AS \
         SELECT m.display_name, m.handle, h.email, h.email_verified, h.password_hash \
           FROM member m \
           JOIN human h \
             ON h.member_id = m.id \
            AND h.workspace_id = m.workspace_id \
          WHERE m.id = $1 \
            AND m.workspace_id = $2 \
            AND m.kind = 'human' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL",
    )
    .bind(operator_member_id)
    .bind(operator_workspace_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if seeded == 0 {
        return Ok(Err(WorkspaceProvisionRejected::OperatorMissing));
    }

    // 3) Re-bind the RLS scope to the new tenant for every seed INSERT below.
    momo_db::rebind_tenant_guc(&mut *conn, new_workspace_id).await?;

    // 4) The workspace row. The unique constraint is the authoritative, race-free
    //    slug detector — a pre-read would see nothing across tenants under RLS.
    let inserted = sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $3)")
        .bind(new_workspace_id)
        .bind(slug)
        .bind(name)
        .execute(&mut *conn)
        .await;
    if let Err(error) = inserted {
        if is_unique_violation(&error) {
            return Ok(Err(WorkspaceProvisionRejected::SlugTaken));
        }
        return Err(DbError::from(error));
    }
    sqlx::query("INSERT INTO workspace_credit (workspace_id, balance_micro_usd) VALUES ($1, 0)")
        .bind(new_workspace_id)
        .execute(&mut *conn)
        .await?;

    // 5) Owner member + human profile (D5-A: same email and password hash, copied
    //    entirely inside SQL).
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         SELECT $1, $2, 'human', 'active', s.display_name, s.handle FROM momo_ws_seed s",
    )
    .bind(owner_id)
    .bind(new_workspace_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         SELECT $1, $2, s.email, s.email_verified, s.password_hash FROM momo_ws_seed s",
    )
    .bind(owner_id)
    .bind(new_workspace_id)
    .execute(&mut *conn)
    .await?;

    // 6) Workspace-level owner role (ADR-0128 — workspace authority is its own row).
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(new_workspace_id)
    .bind(owner_id)
    .execute(&mut *conn)
    .await?;

    // 7) The default #general channel, its gapless seq counter, and the owner's
    //    membership. All three together: a channel without `channel_seq` is a
    //    channel the send path answers 404 for (invariant #4).
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'Team general channel', $3)",
    )
    .bind(channel_id)
    .bind(new_workspace_id)
    .bind(owner_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(new_workspace_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'owner')",
    )
    .bind(new_workspace_id)
    .bind(channel_id)
    .bind(owner_id)
    .execute(&mut *conn)
    .await?;

    Ok(Ok(CreatedWorkspace {
        workspace_id: new_workspace_id,
        slug: slug.to_string(),
        name: name.to_string(),
        owner_member_id: owner_id,
    }))
}

/// `23505` — the unique-violation SQLSTATE Swift matches on (:165).
fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(
        error
            .as_database_error()
            .and_then(|db| db.code())
            .as_deref(),
        Some("23505")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slug_rule_is_create_workspace_sqls_rule() {
        assert_eq!(
            normalized_workspace_slug("  MoMo-Team  ").expect("ok"),
            "momo-team"
        );
        assert_eq!(normalized_workspace_slug("a").expect("single char"), "a");
        assert_eq!(
            normalized_workspace_slug(&"a".repeat(63)).expect("63"),
            "a".repeat(63)
        );
        for bad in [
            "",
            "-momo",
            "momo-",
            "mo mo",
            "모모",
            "momo_team",
            &"a".repeat(64),
        ] {
            assert_eq!(
                normalized_workspace_slug(bad),
                Err(WorkspaceSpecInvalid::Slug),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_name_is_trimmed_bounded_and_never_silently_stripped() {
        assert_eq!(
            normalized_workspace_name("  모모 팀  ").expect("ok"),
            "모모 팀"
        );
        assert_eq!(
            normalized_workspace_name("모").expect("one char counts as one"),
            "모",
            "the bound is characters, not bytes"
        );
        assert_eq!(
            normalized_workspace_name(&"모".repeat(80)).expect("80 chars"),
            "모".repeat(80)
        );
        assert_eq!(
            normalized_workspace_name(&"모".repeat(81)),
            Err(WorkspaceSpecInvalid::NameLength)
        );
        assert_eq!(
            normalized_workspace_name("   "),
            Err(WorkspaceSpecInvalid::NameLength)
        );
        assert_eq!(
            normalized_workspace_name("momo\u{7}team"),
            Err(WorkspaceSpecInvalid::NameControlCharacters),
            "a control character is refused, not stripped into a name nobody chose"
        );
    }
}
