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
