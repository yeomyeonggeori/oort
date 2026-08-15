//! The control-window lease sweep (#1425) — the loop that resumes a parked run
//! nobody is coming back for.
//!
//! ## Why a window needs an author for its own lapse
//!
//! ADR-0004 증보 3 names three ways a control window closes, and only one of
//! them is an act: the person hands the keyboard back. The other two are the
//! world happening to a window nobody closed — the session ends underneath it,
//! or the producer stops re-validating and the 90-second lease runs out.
//!
//! LIVE-3 (#1424) settled the lapse **by use**: every route that reads the
//! ledger sweeps it first, so a window whose holder walked away stops blocking
//! the agent the next time anything looks. That was sufficient while the only
//! consequence of a standing window was a `NOT EXISTS` in two queries — nothing
//! was left in a state that needed unwinding, so a late reconciliation cost
//! only a late history row.
//!
//! #1425 made the window **park runs** (증보 3 D6), and settling by use stopped
//! being sufficient in a way that is worth stating precisely, because it is not
//! a general "sweeps are nice" argument:
//!
//! > `work_controls::create` judges the requesting run's eligibility **above**
//! > the window sweep (`control_run_binding_in_tx` requires `queued|running`).
//! > A parked run is therefore refused *before* it reaches the statement that
//! > would have freed it.
//!
//! So on the agent's own path the reconciliation is unreachable by construction,
//! and the remaining readers are all human acts — re-taking control, returning
//! it, ending the session. A person who shuts their laptop mid-login performs
//! none of them, and their agent stays `paused` forever with a `usage_ledger`
//! that will never gain another row and a channel that simply stops.
//!
//! That is the same failure shape, for the same reason, as the one
//! [`crate::approval_sweep`] exists for ("김인턴이 답을 안 해요, and nothing in
//! the logs says why"), so it gets the same answer: a loop that runs whether or
//! not anybody looks.
//!
//! ## Shape
//!
//! Two steps, and the split is invariant #6 — identical to the approval sweep's:
//!
//! 1. **find the work** with one cross-tenant read on the pool
//!    ([`workspaces_with_lapsed_control_windows`]); a sweep cannot know which
//!    tenants need visiting until it looks.
//! 2. **do the work** inside a per-workspace `with_tenant_tx`, so every write
//!    happens under `app.workspace_id` with RLS FORCE, exactly like a request
//!    would.
//!
//! Each window is settled with the *same* domain functions and the *same*
//! payload builder `routes::display_attach::emit_control_closed_in_tx` uses. The
//! three steps are recomposed here rather than called through that function
//! because it lives in `momo-server`, and a notifier that depended on the HTTP
//! binary would be exactly the layering inversion the approval sweep was careful
//! not to make. What must not drift is the *shape* of the settlement, and that
//! is held by the shared pieces: one envelope builder, one audit action, one
//! resume statement.
//!
//! ## What this loop deliberately does not do
//!
//! It never closes a window whose lease still stands, on any signal — not a dead
//! host, not an ended session, not an orphaned sandbox. The lease is the only
//! evidence this system has about whether a person is still typing, and a sweep
//! that second-guessed it would resume the agent mid-password, which is the one
//! failure ADR-0004 증보 3 D3 exists to prevent. Every other close has an author
//! already.

use momo_agent::resume_runs_from_control_window_in_tx;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_messaging::cent_channel;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::{
    control_window_payload, expire_lapsed_control_windows_for_workspace_in_tx,
    workspaces_with_lapsed_control_windows, LapsedControlWindow, AUDIT_ACTION_CONTROL_CLOSED,
    AUDIT_SCHEMA_CONTROL_CLOSED,
};
use serde_json::json;
use uuid::Uuid;

/// What one sweep iteration did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ControlWindowSweepStats {
    pub workspaces: usize,
    /// Windows moved open → `expired`.
    pub closed: usize,
    /// Runs those windows had parked, returned to `running`.
    ///
    /// Counted separately from `closed` because the two are not the same number
    /// and the difference is informative: a window that parked nothing was a
    /// person looking at a screen no agent was driving, which is the ordinary
    /// case and not a fault.
    pub resumed: usize,
}

/// Close every control window whose lease has lapsed, oldest lease first.
pub async fn sweep_lapsed_control_windows(
    pool: &PgPool,
    batch: i64,
) -> Result<ControlWindowSweepStats, DbError> {
    // (1) which tenants have work. Cross-tenant by necessity; no writes.
    let mut conn = pool.acquire().await?;
    let workspaces = workspaces_with_lapsed_control_windows(&mut conn, batch).await?;
    drop(conn);

    let mut stats = ControlWindowSweepStats {
        workspaces: workspaces.len(),
        ..ControlWindowSweepStats::default()
    };

    for workspace_id in workspaces {
        // (2) one tenant transaction per workspace — every write under the GUC.
        let settled = with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move { sweep_workspace_in_tx(conn, workspace_id, batch).await })
        })
        .await;

        match settled {
            Ok((closed, resumed)) => {
                stats.closed += closed;
                stats.resumed += resumed;
            }
            Err(error) => {
                // One tenant's failure must not stop the others: the next tick
                // retries, and a window that stays open is still lapsed, so
                // nothing about the state it describes has changed.
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "control window sweep failed for a workspace"
                );
            }
        }
    }

    if stats.closed > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            closed = stats.closed,
            resumed = stats.resumed,
            "control window sweep closed lapsed windows"
        );
    }
    Ok(stats)
}

async fn sweep_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    batch: i64,
) -> Result<(usize, usize), DbError> {
    // The close is the claim: one statement moves the row and hands it back, so
    // two sweeps racing settle on the row lock and only one of them sees the
    // window. Everything below is therefore written exactly once per lapse.
    let lapsed =
        expire_lapsed_control_windows_for_workspace_in_tx(conn, workspace_id, batch).await?;

    let closed = lapsed.len();
    let mut resumed = 0usize;
    for entry in &lapsed {
        resumed += settle_lapsed_in_tx(conn, workspace_id, entry).await?;
    }
    Ok((closed, resumed))
}

/// Resume this window's parked runs, record the close, and announce it.
///
/// The same three steps, in the same order, as
/// `routes::display_attach::emit_control_closed_in_tx`. No actor is named on
/// either the audit row or the envelope: a lapse is an event, not an act, and
/// recording the person who held the keyboard as having *returned* it would be
/// a wrong story about what happened (`routes::shared::audit_via_token_id`'s
/// rule, and the reason `end_reason` distinguishes `expired` from `returned` at
/// all).
async fn settle_lapsed_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    entry: &LapsedControlWindow,
) -> Result<usize, DbError> {
    let window = &entry.window;
    let resumed =
        resume_runs_from_control_window_in_tx(conn, workspace_id, window.work_session_id).await?;

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_ACTION_CONTROL_CLOSED)
            .target("work_session", window.work_session_id)
            .with_schema(
                AUDIT_SCHEMA_CONTROL_CLOSED,
                json!({
                    "grantee_member_id": window.grantee_member_id.to_string(),
                    "started_at": window.started_at_ms,
                    "ended_at": window.ended_at_ms,
                    "end_reason": window.end_reason.map(|reason| reason.as_db_label()),
                    "runs_resumed": resumed
                        .iter()
                        .map(|run| run.run_id.to_string())
                        .collect::<Vec<_>>(),
                }),
            ),
    )
    .await?;

    // 재개 시각 — the boundary event 증보 3 D3 entitles the agent to. It is the
    // whole of what leaves this workspace about a control window, and a lapse
    // that closed silently would be the one close an agent could never learn
    // about.
    emit_outbox(
        conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &control_window_payload(&cent_channel(workspace_id, entry.channel_id), window, false),
        Some(entry.channel_id),
    )
    .await?;

    Ok(resumed.len())
}
