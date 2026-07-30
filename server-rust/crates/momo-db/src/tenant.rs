//! Tenant-scoped transaction guards — the single wiring point for the RLS GUC.
//!
//! Invariant #6 (RLS FORCE) is enforced structurally: every tenant transaction
//! begins by running `SELECT set_config('app.workspace_id', $1, true)`. Because
//! `set_config(..., is_local => true)` is `SET LOCAL`, the binding is released
//! on commit/rollback — correct even under a transaction-mode pooler. Ports
//! Swift `DB/Database.swift`:
//!   * `withTenantTransaction`     :85-105  (base tenant guard, `set_config` :92)
//!   * `withProviderLinkTransaction`      :171-191 (`app.provider_link_admin`)
//!   * `withProviderQuotaIngestTransaction`:223-243 (`app.provider_quota_admin`)
//!
//! The closure receives the transaction's connection so a domain write and its
//! `momo_outbox::emit_outbox` call run in the *same* transaction (invariant #3).

use futures::future::BoxFuture;
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::DbError;

/// Set the tenant RLS GUC on an open transaction. `SET LOCAL` semantics via
/// `set_config(_, _, is_local => true)`, byte-for-byte the Swift statement so
/// the RLS policies behave identically.
async fn bind_workspace_guc(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Set an additional boolean GUC (`'on'`) on an open transaction. Used by the
/// operator-scoped variants below; callers MUST have verified the operator
/// scope BEFORE opening the transaction — the GUC is the last gate, not the
/// first (ADR-0004 증보 1 / ADR-0135 D2).
async fn bind_admin_guc(tx: &mut Transaction<'_, Postgres>, guc: &str) -> Result<(), DbError> {
    // `guc` is a compile-time constant supplied by this crate only (never user
    // input), so the literal interpolation cannot inject.
    let stmt = format!("SELECT set_config('{guc}', 'on', true)");
    sqlx::query(&stmt).execute(&mut **tx).await?;
    Ok(())
}

/// Run `body` inside a transaction with the tenant's RLS scope set.
///
/// This is the ONLY sanctioned way for a domain crate to open a tenant write:
/// it cannot obtain the GUC any other way, so a query that skips this guard is
/// filtered to zero rows by the DB policies (invariant #6 backstop).
pub async fn with_tenant_tx<T, F>(pool: &PgPool, workspace_id: Uuid, body: F) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    let mut tx = pool.begin().await?;
    bind_workspace_guc(&mut tx, workspace_id).await?;
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            // Best-effort rollback; surface the original closure error.
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Run `body` inside a tenant transaction, with two caller-supplied preludes
/// sandwiching the RLS GUC.
///
/// Added for ADR-0140 D2 (B2.1). The T3 lifecycle ladder needs statements on
/// **both** sides of `set_config('app.workspace_id', …)`:
///
/// * `before_guc` — `pg_advisory_xact_lock` must be the transaction's *first*
///   statement, ahead of every row lock. It touches no RLS table, so it does
///   not need the tenant scope, and the Swift prelude
///   (`Cloud/T3LifecycleLock.swift:17-27`) puts it first for exactly that
///   reason. This guard ports that order faithfully.
/// * `after_guc` — the coarse-to-fine row locks (`work_pool`,
///   `workspace_credit`, `work_cloud_host`). Every one of those tables is
///   `FORCE ROW LEVEL SECURITY`, so they must come after the GUC — and before
///   `body`, so that a domain closure can never take them out of order.
///
/// Routing this through `momo-db` rather than opening a second transaction
/// helper elsewhere is what preserves invariant #6: `bind_workspace_guc` stays
/// the one and only wiring point for `app.workspace_id` in the workspace.
///
/// Generic over the error type so a domain crate can classify PostgreSQL
/// failures (trigger rejections, constraint violations) into its own domain
/// errors instead of flattening them to [`DbError`]; `E: From<DbError>` keeps
/// the transaction plumbing's own failures representable.
pub async fn with_tenant_tx_prelude<T, E, P, Q, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    before_guc: P,
    after_guc: Q,
    body: F,
) -> Result<T, E>
where
    T: Send,
    E: From<DbError> + Send,
    P: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<(), E>> + Send,
    Q: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<(), E>> + Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, E>> + Send,
{
    let mut tx = pool.begin().await.map_err(DbError::from)?;
    if let Err(err) = before_guc(&mut tx).await {
        let _ = tx.rollback().await;
        return Err(err);
    }
    if let Err(err) = bind_workspace_guc(&mut tx, workspace_id).await {
        let _ = tx.rollback().await;
        return Err(E::from(err));
    }
    if let Err(err) = after_guc(&mut tx).await {
        let _ = tx.rollback().await;
        return Err(err);
    }
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await.map_err(DbError::from)?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Operator provider-link transaction (MOMO-572 / ADR-0004 증보 1). Binds both
/// `app.workspace_id` (for the operator's workspace-scoped audit write) and
/// `app.provider_link_admin` to unlock the GUC-gated `provider_link` policy.
pub async fn with_provider_link_admin_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    let mut tx = pool.begin().await?;
    bind_workspace_guc(&mut tx, workspace_id).await?;
    bind_admin_guc(&mut tx, "app.provider_link_admin").await?;
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Provider quota-snapshot ingest transaction (MOMO-623 / ADR-0135 D2). Binds
/// `app.workspace_id` (ingesting agent's workspace) and `app.provider_quota_admin`
/// to unlock the write policy on the instance-global `quota_snapshot` table.
pub async fn with_provider_quota_ingest_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    let mut tx = pool.begin().await?;
    bind_workspace_guc(&mut tx, workspace_id).await?;
    bind_admin_guc(&mut tx, "app.provider_quota_admin").await?;
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}
