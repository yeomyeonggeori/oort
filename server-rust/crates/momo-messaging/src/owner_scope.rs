//! The owner-scope GUC — `app.member_id`, the second predicate of an owner-scoped
//! FORCE RLS table (082 `message_reminder`, 145 `scheduled_message`).
//!
//! `app.workspace_id` says which tenant a transaction speaks for and lives in
//! [`momo_db::tenant`]. A row that belongs to **one person** also needs that person's
//! id in the transaction, and this module is where it is bound. `SET LOCAL`
//! semantics (`set_config(.., is_local => true)`): the binding unwinds with the
//! transaction, so a pooled connection never carries a previous caller's id into
//! the next request.
//!
//! ## Two kinds of binding, and only one of them is ordinary
//!
//! * [`bind_owner_guc`] — the transaction speaks as the member whose rows it
//!   touches: a request as its own caller, the scheduler tick as the author of the
//!   row it is sending (ADR-0208 D14 point 4: the tick and the retention sweep are
//!   outside the rule below).
//! * [`bind_foreign_owner_guc`] — a transaction that holds **only** the workspace
//!   GUC (an admin suspending or removing a member, a lineage ending in a
//!   `with_tenant_tx`) reaches into somebody else's owner-scoped rows. That is the
//!   one place RLS is asked to trust the application about *whose* rows these are,
//!   so it is `pub(crate)`, hands back what to put back, and is called by exactly
//!   three named functions in [`crate::scheduled`]. `tests/owner_scope_guard.rs`
//!   pins that list by scanning the source, and the raw `set_config` literal below
//!   is pinned to this file plus the two older binders.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// Bind the transaction to `member_id`'s owner scope (the caller's own id).
pub async fn bind_owner_guc(conn: &mut PgConnection, member_id: Uuid) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.member_id', $1, true)")
        .bind(member_id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Unbind the owner scope (`''`, which every owner-scoped policy reads as "no
/// member" through `NULLIF`). The canonical send runs unbound so that REST and the
/// scheduler execute it in the same GUC state (ADR-0208 D4).
pub async fn clear_owner_guc(conn: &mut PgConnection) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.member_id', '', true)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The owner scope the transaction holds right now (`''` when none).
pub async fn current_owner_guc(conn: &mut PgConnection) -> Result<String, DbError> {
    let value: Option<String> = sqlx::query_scalar("SELECT current_setting('app.member_id', true)")
        .fetch_one(&mut *conn)
        .await?;
    Ok(value.unwrap_or_default())
}

/// What a foreign binding displaced — the value to put back, which is whatever the
/// transaction held before the call (`''` when it held nothing; the policies read
/// both through `NULLIF`).
#[derive(Debug)]
#[must_use = "a foreign owner binding must be restored"]
pub(crate) struct OwnerGucRestore(String);

/// Bind **another** member's owner scope and remember what to restore.
///
/// `pub(crate)` on purpose: it is not reachable from `momo-server`, and inside this
/// crate the caller list is a test (see the module docs).
pub(crate) async fn bind_foreign_owner_guc(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<OwnerGucRestore, DbError> {
    let previous = current_owner_guc(conn).await?;
    bind_owner_guc(conn, member_id).await?;
    Ok(OwnerGucRestore(previous))
}

/// Put back what [`bind_foreign_owner_guc`] displaced.
pub(crate) async fn restore_owner_guc(
    conn: &mut PgConnection,
    restore: OwnerGucRestore,
) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.member_id', $1, true)")
        .bind(restore.0)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
