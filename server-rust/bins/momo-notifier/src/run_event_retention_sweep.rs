//! Run event ledger retention (ADR-0200 D2, #3744): the ledger of a run is deleted
//! [`momo_agent::RUN_EVENT_RETENTION_DAYS`] (30) days after the run FINISHED. A run still
//! in progress is never a candidate, and the run row itself is never touched.
//!
//! Same two-pool shape as the inbox and share retention sweeps: one cross-tenant READ on
//! the notifier's BYPASSRLS pool (SELECT only — that role has no DELETE) to learn which
//! workspaces have work, then one `with_tenant_tx` per workspace on an RLS-bound
//! `momo_app` pool so the DELETE runs under `app.workspace_id` with RLS FORCE. Refuses a
//! write pool that bypasses RLS. Idempotent and bounded per tick.

use momo_agent::{delete_expired_run_events_in_tx, workspaces_with_expired_run_events};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::avatar_reclaim::ensure_write_pool_rls_bound;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RunEventRetentionStats {
    pub workspaces: usize,
    pub deleted: u64,
}

pub async fn sweep_expired_run_events(
    read_pool: &PgPool,
    write_pool: &PgPool,
    batch: i64,
) -> Result<RunEventRetentionStats, DbError> {
    ensure_write_pool_rls_bound(write_pool).await?;
    let mut conn = read_pool.acquire().await?;
    let workspaces = workspaces_with_expired_run_events(&mut conn, batch).await?;
    drop(conn);

    let mut stats = RunEventRetentionStats {
        workspaces: workspaces.len(),
        ..RunEventRetentionStats::default()
    };
    for workspace_id in workspaces {
        let settled = with_tenant_tx(write_pool, workspace_id, move |conn| {
            Box::pin(
                async move { delete_expired_run_events_in_tx(conn, workspace_id, batch).await },
            )
        })
        .await;
        match settled {
            Ok(deleted) => stats.deleted += deleted,
            Err(error) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "run event retention sweep failed for a workspace"
                );
            }
        }
    }
    if stats.deleted > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            deleted = stats.deleted,
            "run event retention sweep deleted expired ledgers"
        );
    }
    Ok(stats)
}
