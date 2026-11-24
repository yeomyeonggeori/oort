//! The api's **follow-up removal** of agent status eyes (ADR-0200 증보 8 L7 5, #6067).
//!
//! Two terminal writes are the notifier's — the approval-expiry sweep and the abandoned-lease sweep —
//! and the notifier has no `reaction` privilege and gets none (L7 4, LA12). The eye a run of either
//! held is therefore removed here, by the api's own `momo_app` pool (NOBYPASSRLS — [`start`]
//! refuses a role that bypasses row security), in one tenant transaction per workspace
//! (`SET LOCAL app.workspace_id`), exactly like a request.
//!
//! **Which workspaces.** This process cannot list tenants (it is RLS-bound), so it walks the
//! workspaces it has **served an authenticated request for since it started**
//! ([`StatusReactionTouched`], filled by `auth::require_principal` from the credential's own
//! workspace — never a request body). That is the attachment-reclaim precedent
//! (`attachment_reclaim::TouchedWorkspaces`), with the same bound: an api that restarted removes a
//! workspace's stale eyes within [`momo_messaging::status_reaction::FOLLOW_UP_REMOVAL_BOUND_SECS`] of
//! that workspace's first request — before that, nobody reads that workspace through this api.
//!
//! **No window.** Each pass starts from the eye rows themselves
//! (`sweep_settled_eyes_in_tx`), so a run that ended long before this process started is found.

use std::sync::Arc;
use std::time::Duration;

use momo_db::{DbError, PgPool};
use momo_messaging::avatar_reclaim::ensure_write_pool_rls_bound;
use momo_messaging::status_reaction::sweep_settled_eyes_in_tx;
use tokio::sync::watch;
use uuid::Uuid;

use crate::attachment_reclaim::TouchedWorkspaces;

/// The touched set this tick walks — the same type as the attachment reclaim's, a separate set.
pub type StatusReactionTouched = TouchedWorkspaces;

/// One pass every 20 seconds: well inside the 60-second bound, with room for a slow pass.
pub const TICK: Duration = Duration::from_secs(20);
/// Eyes removed per workspace per pass.
pub const BATCH_PER_WORKSPACE: i64 = 200;
/// Workspaces looked at per pass. A set larger than this is walked window by window.
pub const WORKSPACES_PER_PASS: usize = 500;

/// One pass over (up to [`WORKSPACES_PER_PASS`] of) the touched workspaces. Returns the eyes
/// removed. A workspace whose transaction fails is skipped; the next pass retries it.
pub async fn sweep_once(
    touched: &TouchedWorkspaces,
    pool: &PgPool,
    cursor: &mut Option<Uuid>,
) -> u64 {
    let batch = touched.next_batch(*cursor, WORKSPACES_PER_PASS);
    let mut removed = 0;
    for &workspace_id in &batch {
        let outcome = momo_db::with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move {
                sweep_settled_eyes_in_tx(conn, workspace_id, BATCH_PER_WORKSPACE).await
            })
        })
        .await;
        match outcome {
            Ok(count) => removed += count,
            Err(_) => tracing::warn!(
                "agent status eye follow-up removal: one workspace failed (database error)"
            ),
        }
    }
    *cursor = batch.last().copied();
    removed
}

/// Start the tick, or `None` when the pool's role bypasses row security (or cannot be asked):
/// its writes must be filtered by the tenant policies like a request's.
pub async fn start(
    touched: Arc<TouchedWorkspaces>,
    pool: PgPool,
    stop: watch::Receiver<bool>,
) -> Option<tokio::task::JoinHandle<()>> {
    if let Err(error) = ensure_write_pool_rls_bound(&pool).await {
        let error: DbError = error;
        tracing::error!(
            error = %error,
            "agent status eye follow-up removal is NOT running: its database role could not be \
             confirmed as row-level-security bound"
        );
        return None;
    }
    Some(tokio::spawn(run_loop(touched, pool, stop)))
}

async fn run_loop(touched: Arc<TouchedWorkspaces>, pool: PgPool, mut stop: watch::Receiver<bool>) {
    let mut cursor: Option<Uuid> = None;
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            _ = tokio::time::sleep(TICK) => {}
        }
        if *stop.borrow() {
            break;
        }
        let removed = sweep_once(&touched, &pool, &mut cursor).await;
        if removed > 0 {
            tracing::info!(removed, "agent status eye follow-up removal");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tick_runs_well_inside_the_bound() {
        // A pass may start up to one TICK after the commit; two ticks still fit the bound.
        assert!(TICK.as_secs() * 2 < momo_messaging::status_reaction::FOLLOW_UP_REMOVAL_BOUND_SECS);
    }
}
