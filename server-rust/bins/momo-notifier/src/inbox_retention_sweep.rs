//! Inbox retention (#3681 E2, ADR-0199 D4): **read** `inbox_item` rows are
//! deleted [`momo_messaging::INBOX_READ_RETENTION_DAYS`] (30) days after
//! `read_at`. Unread items are kept without limit and the source `message` is
//! never touched — the projection is rebuildable, the message is not.
//!
//! Same two-pool shape as the share-retention sweep and the avatar reclaim: one
//! cross-tenant **read** on the notifier's BYPASSRLS pool to learn which
//! workspaces have work, then one `with_tenant_tx` per workspace on a second,
//! **RLS-bound** `momo_app` pool so the DELETE runs under `app.workspace_id` with
//! RLS FORCE. The sweep refuses a write pool whose role bypasses RLS, so it adds
//! no RLS-bypassing write path.
//!
//! Idempotent: the delete re-evaluates `read_at < now() - 30d` itself, a second
//! run (or a concurrent one — rows are claimed `FOR UPDATE SKIP LOCKED`) finds
//! nothing more. Bounded: at most `batch` rows per workspace per tick; a backlog
//! drains over the following ticks.

use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::avatar_reclaim::ensure_write_pool_rls_bound;
use momo_messaging::{delete_read_inbox_items_in_tx, workspaces_with_expired_inbox_items};

/// What one sweep iteration did. Counts only — never ids or text.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct InboxRetentionStats {
    pub workspaces: usize,
    pub deleted: u64,
}

/// Delete every read item past retention, a batch per workspace.
///
/// `read_pool` is the BYPASSRLS notifier pool (candidate read only);
/// `write_pool` must be RLS-bound (`momo_app`) or this refuses to run.
pub async fn sweep_read_inbox_items(
    read_pool: &PgPool,
    write_pool: &PgPool,
    batch: i64,
) -> Result<InboxRetentionStats, DbError> {
    ensure_write_pool_rls_bound(write_pool).await?;
    let mut conn = read_pool.acquire().await?;
    let workspaces = workspaces_with_expired_inbox_items(&mut conn, batch).await?;
    drop(conn);

    let mut stats = InboxRetentionStats {
        workspaces: workspaces.len(),
        ..InboxRetentionStats::default()
    };
    for workspace_id in workspaces {
        let settled = with_tenant_tx(write_pool, workspace_id, move |conn| {
            Box::pin(async move { delete_read_inbox_items_in_tx(conn, workspace_id, batch).await })
        })
        .await;
        match settled {
            Ok(deleted) => stats.deleted += deleted,
            Err(error) => {
                // One tenant's failure must not stop the others; the rows are
                // still past retention and the next tick retries.
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "inbox retention sweep failed for a workspace"
                );
            }
        }
    }
    if stats.deleted > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            deleted = stats.deleted,
            "inbox retention sweep deleted read items"
        );
    }
    Ok(stats)
}
