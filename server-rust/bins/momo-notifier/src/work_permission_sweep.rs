//! The work-permission expiry sweep (#5594, ADR-0188 D7 「짧은 TTL」 · D8, ADR-0220 P2 ④ · P7 (a)).
//!
//! A member host's permission request waits [`momo_t3::work_permission::PERMISSION_REQUEST_TTL_SECONDS`]
//! (10 minutes) for its owner. Until this sweep, nothing closed it at its deadline: the decision
//! route closed a lapsed row only when somebody tried to decide it, and the host withdrew it 30 s
//! later on its own clock. Nobody was told that the agent had been left waiting — the request was
//! pushed once (`approval_request`, #5340) and then went silent.
//!
//! So, at the deadline, the server closes the row as `expired` (the decision route's own
//! conditional `pending → expired`, 「첫 결정이 이긴다」) and writes one System line in the session's
//! thread — 「10분이 지나 이 요청은 닫혔어요」 — in the same transaction. The judgment's `work_notice`
//! arm pushes it to the session's owner and nobody else. The host's own withdrawal, when it arrives
//! at 630 s, finds the row closed and changes nothing about it.
//!
//! A request whose session is no longer running gets no line: the session's own end (or the host
//! loss line) already said what happened, and one cause is told once (ADR-0220 P5).
//!
//! ## Shape — two pools (#5614 M2, ADR-0122 D-H4: no new RLS-bypassing write)
//!
//! The share-retention / avatar-reclaim shape:
//!
//! * **notifier pool** (BYPASSRLS `momo_notifier`): ONE cross-tenant read,
//!   [`workspaces_with_lapsed_permission_requests`], which names `workspace_id`, `status` and
//!   `expires_at` — the only columns of `work_permission_request` that role may read (column GRANT,
//!   #5614 M1; the owner-only `preview` stays unreadable). Nothing is written through it.
//! * **write pool** (RLS-bound `momo_app`, `ensure_write_pool_rls_bound`): per workspace, one
//!   `with_tenant_tx` (`SET LOCAL app.workspace_id`, RLS FORCE) that row-locks the lapsed requests
//!   (`FOR UPDATE SKIP LOCKED`, so two notifiers never close or announce one twice), closes each and
//!   writes its line.
//!
//! Without a write URL the loop is not started (`lib.rs`): the decision route already refuses a
//! lapsed request on its own, so the only thing lost is the notice.
//!
//! **One request cannot hold back another** (#5614 H1): each request gets a SAVEPOINT (the approval
//! sweep's shape), and its line a nested one (`post_work_notice_guarded_in_tx`) — a line the DM write
//! boundary refuses is dropped and logged, and the expiry still commits.

use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_messaging::avatar_reclaim::ensure_write_pool_rls_bound;
use momo_t3::work_notice::{post_work_notice_guarded_in_tx, session_notice_site_in_tx, WorkNotice};
use momo_t3::work_permission::{
    close_permission_request_in_tx, lock_lapsed_permission_requests_in_tx,
    workspaces_with_lapsed_permission_requests, LapsedPermissionRequest, STATUS_EXPIRED,
};
use momo_t3::T3Error;
use uuid::Uuid;

/// What one sweep iteration did. Counts only — never ids or text.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WorkPermissionSweepStats {
    pub workspaces: usize,
    /// Rows closed as `expired`.
    pub expired: usize,
    /// Lines written (an expired request of a running session).
    pub noticed: usize,
    /// Requests whose close failed this tick (rolled back alone; retried next tick).
    pub failed: usize,
}

/// Close every lapsed work-permission request and tell its session's owner.
///
/// `read_pool` is the BYPASSRLS notifier pool (the candidate read only); `write_pool` must be
/// RLS-bound (`momo_app`) or this refuses to run.
pub async fn sweep_lapsed_work_permissions(
    read_pool: &PgPool,
    write_pool: &PgPool,
    batch: i64,
) -> Result<WorkPermissionSweepStats, DbError> {
    ensure_write_pool_rls_bound(write_pool).await?;
    let workspaces = workspaces_with_lapsed_permission_requests(read_pool, batch)
        .await
        .map_err(t3_to_db)?;
    let mut stats = WorkPermissionSweepStats {
        workspaces: workspaces.len(),
        ..WorkPermissionSweepStats::default()
    };
    for workspace_id in workspaces {
        let settled = with_tenant_tx(write_pool, workspace_id, move |conn| {
            Box::pin(async move { sweep_workspace_in_tx(conn, workspace_id, batch).await })
        })
        .await;
        match settled {
            Ok(counts) => {
                stats.expired += counts.expired;
                stats.noticed += counts.noticed;
                stats.failed += counts.failed;
            }
            Err(error) => {
                // One tenant's failure must not stop the others; the next tick retries,
                // and the decision route still refuses a lapsed request by itself.
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "work permission expiry sweep failed for a workspace"
                );
            }
        }
    }
    if stats.expired > 0 || stats.failed > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            expired = stats.expired,
            noticed = stats.noticed,
            failed = stats.failed,
            "work permission expiry sweep closed lapsed requests"
        );
    }
    Ok(stats)
}

#[derive(Debug, Default, Clone, Copy)]
struct WorkspaceCounts {
    expired: usize,
    noticed: usize,
    failed: usize,
}

async fn sweep_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    batch: i64,
) -> Result<WorkspaceCounts, DbError> {
    let lapsed = lock_lapsed_permission_requests_in_tx(conn, workspace_id, batch)
        .await
        .map_err(t3_to_db)?;
    let mut counts = WorkspaceCounts::default();
    for request in lapsed {
        // One SAVEPOINT per request (the approval sweep's shape): a request that cannot be
        // closed must not roll back — and, tick after tick, block — the others in this tenant.
        let mut savepoint = momo_db::sqlx::Connection::begin(&mut *conn).await?;
        match expire_one_in_tx(&mut savepoint, workspace_id, &request).await {
            Ok(Some(noticed)) => {
                savepoint.commit().await?;
                counts.expired += 1;
                if noticed {
                    counts.noticed += 1;
                }
            }
            Ok(None) => {
                savepoint.rollback().await?;
            }
            Err(error) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    request_id = %request.id,
                    error = %error,
                    "work permission expiry sweep could not close one request; retrying next tick"
                );
                savepoint.rollback().await?;
                counts.failed += 1;
            }
        }
    }
    Ok(counts)
}

/// Close one lapsed request and, when its session still runs, write its line (guarded: a line
/// that cannot be written does not undo the close). `None` when somebody closed it first.
async fn expire_one_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    request: &LapsedPermissionRequest,
) -> Result<Option<bool>, DbError> {
    let closed = close_permission_request_in_tx(conn, workspace_id, request.id, STATUS_EXPIRED)
        .await
        .map_err(t3_to_db)?;
    if closed.is_none() {
        return Ok(None);
    }
    let Some(found) = session_notice_site_in_tx(conn, workspace_id, request.work_session_id)
        .await
        .map_err(t3_to_db)?
    else {
        return Ok(Some(false));
    };
    if !found.status_running {
        return Ok(Some(false));
    }
    let notice = WorkNotice::PermissionExpired {
        session_id: request.work_session_id,
        owner_member_id: found.owner_member_id,
        request_id: request.id,
        request_event_id: request.request_event_id,
    };
    let noticed = post_work_notice_guarded_in_tx(conn, workspace_id, found.site, &notice)
        .await
        .map_err(t3_to_db)?;
    Ok(Some(noticed))
}

fn t3_to_db(error: T3Error) -> DbError {
    match error {
        T3Error::Db(db) => db,
        other => DbError::Sqlx(momo_db::sqlx::Error::Protocol(other.to_string())),
    }
}
