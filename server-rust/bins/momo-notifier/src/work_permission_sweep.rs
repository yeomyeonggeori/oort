//! The work-permission expiry sweep (#5594, ADR-0188 D7 「짧은 TTL」 · D8, ADR-0220 P2 ④ · P7 (a)).
//!
//! A member host's permission request waits [`momo_t3::work_permission::PERMISSION_REQUEST_TTL_SECONDS`]
//! (10 minutes) for its owner. Until this sweep, nothing closed it at its deadline: the decision
//! route closed a lapsed row only when somebody tried to decide it, and the host withdrew it 30 s
//! later on its own clock. Nobody was told that the agent had been left waiting — the request was
//! pushed once (`approval_request`, #5340) and then went silent.
//!
//! So, at the deadline, the server closes the row as `expired` (the same conditional
//! `pending → expired` the decision route uses, 「첫 결정이 이긴다」) and writes one System line in the
//! session's thread — 「10분이 지나 이 요청은 닫혔어요」 — in the same transaction. The judgment's
//! `work_notice` arm pushes it to the session's owner and nobody else. The host's own withdrawal,
//! when it arrives at 630 s, finds the row closed and changes nothing about it.
//!
//! A request whose session is no longer running gets no line: the session's own end (or the host
//! loss line, which also cancels its requests) already said what happened, and one cause is told
//! once (ADR-0220 P5).
//!
//! ## Shape
//!
//! The approval sweep's: one cross-tenant READ (the notifier pool) to learn which workspaces have a
//! lapsed request, then one `with_tenant_tx` per workspace — every write under
//! `SET LOCAL app.workspace_id`. The production `momo_notifier` role reads and updates
//! `work_permission_request` by a table GRANT (`bootstrap_runtime_roles.sql`, #5594) and writes the
//! line with the grants the stall sweep's lines already use.

use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_t3::work_notice::{post_work_notice_in_tx, session_notice_site_in_tx, WorkNotice};
use momo_t3::work_permission::{
    expire_lapsed_permission_requests_in_tx, workspaces_with_lapsed_permission_requests,
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
}

/// Close every lapsed work-permission request and tell its session's owner.
pub async fn sweep_lapsed_work_permissions(
    pool: &PgPool,
    batch: i64,
) -> Result<WorkPermissionSweepStats, DbError> {
    let workspaces = workspaces_with_lapsed_permission_requests(pool, batch)
        .await
        .map_err(t3_to_db)?;
    let mut stats = WorkPermissionSweepStats {
        workspaces: workspaces.len(),
        ..WorkPermissionSweepStats::default()
    };
    for workspace_id in workspaces {
        let settled = with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move { sweep_workspace_in_tx(conn, workspace_id, batch).await })
        })
        .await;
        match settled {
            Ok((expired, noticed)) => {
                stats.expired += expired;
                stats.noticed += noticed;
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
    if stats.expired > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            expired = stats.expired,
            noticed = stats.noticed,
            "work permission expiry sweep closed lapsed requests"
        );
    }
    Ok(stats)
}

async fn sweep_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    batch: i64,
) -> Result<(usize, usize), DbError> {
    let expired = expire_lapsed_permission_requests_in_tx(conn, workspace_id, batch)
        .await
        .map_err(t3_to_db)?;
    let mut noticed = 0;
    for request in &expired {
        let Some(found) = session_notice_site_in_tx(conn, workspace_id, request.work_session_id)
            .await
            .map_err(t3_to_db)?
        else {
            continue;
        };
        if !found.status_running {
            continue;
        }
        let notice = WorkNotice::PermissionExpired {
            session_id: request.work_session_id,
            owner_member_id: found.owner_member_id,
            request_id: request.id,
            request_event_id: request.request_event_id,
        };
        if post_work_notice_in_tx(conn, workspace_id, found.site, &notice)
            .await
            .map_err(t3_to_db)?
        {
            noticed += 1;
        }
    }
    Ok((expired.len(), noticed))
}

fn t3_to_db(error: T3Error) -> DbError {
    match error {
        T3Error::Db(db) => db,
        other => DbError::Sqlx(sqlx_other(other.to_string())),
    }
}

fn sqlx_other(message: String) -> momo_db::sqlx::Error {
    momo_db::sqlx::Error::Protocol(message)
}
