//! Shared-session payload retention (#2862 — ADR-0190 증보 D4-b, ADR-0194 D9).
//!
//! A shared local session's S1 extension (`work_session_share`) is deleted
//! [`momo_t3::work_share::SHARE_RETENTION_DAYS`] days after the session ended.
//! The name and status columns of `work_session` follow the ledger's own rules and
//! are not touched here.
//!
//! Same two-step shape as every sweep in this crate (invariant #6): one
//! cross-tenant read on the pool to learn which workspaces have work, then one
//! `with_tenant_tx` per workspace so the delete runs under `app.workspace_id`
//! with RLS FORCE. The delete is the claim (`FOR UPDATE SKIP LOCKED`), so two
//! sweeps never announce the same payload twice. Each deleted payload commits one
//! `work.session.share_changed` outbox row (kind `disabled`) in the same
//! transaction — a card that shows 「공유가 꺼진 작업이에요」 must learn it the same way
//! it learns an unshare.

use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_messaging::cent_channel;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::work_share::{
    delete_expired_shares_for_workspace_in_tx, share_changed_payload,
    workspaces_with_expired_shares,
};
use uuid::Uuid;

/// What one sweep iteration did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ShareRetentionStats {
    pub workspaces: usize,
    pub deleted: usize,
}

/// Delete every payload past retention, a batch per workspace.
pub async fn sweep_expired_shares(
    pool: &PgPool,
    batch: i64,
) -> Result<ShareRetentionStats, DbError> {
    let mut conn = pool.acquire().await?;
    let workspaces = workspaces_with_expired_shares(&mut conn, batch).await?;
    drop(conn);

    let mut stats = ShareRetentionStats {
        workspaces: workspaces.len(),
        ..ShareRetentionStats::default()
    };
    for workspace_id in workspaces {
        let settled = with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move { sweep_workspace_in_tx(conn, workspace_id, batch).await })
        })
        .await;
        match settled {
            Ok(deleted) => stats.deleted += deleted,
            Err(error) => {
                // One tenant's failure must not stop the others; the next tick
                // retries and the rows are still past retention.
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "share retention sweep failed for a workspace"
                );
            }
        }
    }
    if stats.deleted > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            deleted = stats.deleted,
            "share retention sweep deleted expired payloads"
        );
    }
    Ok(stats)
}

async fn sweep_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    batch: i64,
) -> Result<usize, DbError> {
    let expired = delete_expired_shares_for_workspace_in_tx(conn, workspace_id, batch).await?;
    for share in &expired {
        let discriminator: Uuid = momo_db::sqlx::query_scalar("SELECT uuidv7()")
            .fetch_one(&mut *conn)
            .await?;
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or_default();
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &share_changed_payload(
                &cent_channel(workspace_id, share.channel_id),
                share.channel_id,
                share.session_id,
                "disabled",
                ts_ms,
                discriminator,
            ),
            Some(share.channel_id),
        )
        .await?;
    }
    Ok(expired.len())
}
