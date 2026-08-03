//! The approval expiry sweep (goal SRV-T1) — the loop that releases the gate.
//!
//! ## Why this exists, when Swift has no equivalent
//!
//! Swift notices an expired approval **only when someone taps it**
//! (`ApprovalDecisionRoutes.recordExpiredClick`). An approval nobody ever opens
//! is never settled there: its run stays `awaiting_approval` forever.
//!
//! On this server that is not a cosmetic difference. `agent.max_concurrent_runs`
//! defaults to **1** (`001_init.sql:84`) and
//! `momo_agent::live_run_count_in_tx` counts `awaiting_approval` among the live
//! statuses, so one unanswered approval does not merely linger — it stops that
//! agent taking any further work run, permanently, with no error anywhere. The
//! symptom a person reports is "김인턴이 답을 안 해요", and nothing in the logs
//! says why.
//!
//! So the deadline every approval carries has to be enforced by something that
//! runs whether or not a human ever looks. That is this loop.
//!
//! (A2A's G1 is already immune — it counts only fresh `status='running'` rows
//! and says so at `momo_agent::a2a`:343-344. The HTTP work-run cap is the one
//! that leaks, which is why this sweep is about `agent_run`, not about
//! delegation.)
//!
//! ## Shape
//!
//! Two steps, and the split is invariant #6:
//!
//! 1. **find the work** with one cross-tenant read on the pool — the same thing
//!    `momo_t3::sweep::stale_session_candidates` does, and for the same reason:
//!    a sweep cannot know which tenants need visiting until it looks.
//! 2. **do the work** inside a per-workspace `with_tenant_tx`, so every write
//!    happens under `app.workspace_id` with RLS FORCE, exactly like a request
//!    would.
//!
//! Each approval is settled with the *same* domain functions and the *same*
//! payload builders the decision route uses. The only thing that differs is who
//! decided: nobody. `approval.decided_by` stays NULL (which
//! `approval_decided_ck` requires for a non-approved/rejected status) and the
//! audit row's actor is NULL — the clock is not a member.

use momo_agent::approval::{
    decision_broadcast_payload, decision_event_payload, lock_approval_in_tx,
    mark_approval_expired_in_tx, workspaces_with_overdue_approvals, LockedApproval,
};
use momo_agent::tools::{ToolResult, TOOL_AUDIT_SCHEMA};
use momo_agent::{end_parked_run_in_tx, RunStatus};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_messaging::{cent_channel, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use serde_json::json;
use uuid::Uuid;

/// What one sweep iteration did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ApprovalSweepStats {
    pub workspaces: usize,
    /// Approvals moved `pending` → `expired`, each of which released one run.
    pub expired: usize,
    /// Rows that were no longer expirable by the time the lock was taken — a
    /// human decided in the meantime, which is the race working correctly.
    pub raced: usize,
}

/// The sentence the channel gets. Deliberately about the deadline, not about
/// the person: nobody failed to act, the window closed.
const EXPIRED_REASON: &str = "Approval expired before a human decision.";
const EXPIRED_TOOL_RESULT_BODY: &str = "Tool call expired without a human approval.";

/// Settle every overdue pending approval, oldest first.
pub async fn sweep_expired_approvals(
    pool: &PgPool,
    batch: i64,
) -> Result<ApprovalSweepStats, DbError> {
    // (1) which tenants have work. Cross-tenant by necessity; no writes.
    let mut conn = pool.acquire().await?;
    let workspaces = workspaces_with_overdue_approvals(&mut conn, batch).await?;
    drop(conn);

    let mut stats = ApprovalSweepStats {
        workspaces: workspaces.len(),
        ..ApprovalSweepStats::default()
    };

    for workspace_id in workspaces {
        // (2) one tenant transaction per workspace — every write under the GUC.
        let settled = with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move { sweep_workspace_in_tx(conn, workspace_id, batch).await })
        })
        .await;

        match settled {
            Ok((expired, raced)) => {
                stats.expired += expired;
                stats.raced += raced;
            }
            Err(error) => {
                // One tenant's failure must not stop the others: the next tick
                // retries, and an approval that stays pending is still bounded
                // by the same deadline.
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "approval expiry sweep failed for a workspace"
                );
            }
        }
    }

    if stats.expired > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            expired = stats.expired,
            raced = stats.raced,
            "approval expiry sweep released parked runs"
        );
    }
    Ok(stats)
}

async fn sweep_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    batch: i64,
) -> Result<(usize, usize), DbError> {
    let candidates =
        momo_agent::approval::overdue_approvals_in_tx(&mut *conn, workspace_id, batch).await?;
    let mut expired = 0usize;
    let mut raced = 0usize;

    for candidate in candidates {
        // Re-read under `FOR UPDATE` through the same loader the decision route
        // uses, so the sweep and a tap racing on one approval serialize on the
        // same row — and so the payload builders below get exactly the object
        // they get on the route.
        let Some(approval) = lock_approval_in_tx(&mut *conn, workspace_id, candidate.id).await?
        else {
            raced += 1;
            continue;
        };
        if approval.status != "pending" {
            raced += 1;
            continue;
        }
        if settle_expired_in_tx(&mut *conn, &approval).await? {
            expired += 1;
        } else {
            raced += 1;
        }
    }
    Ok((expired, raced))
}

/// Expire one approval and release its run.
async fn settle_expired_in_tx(
    conn: &mut PgConnection,
    approval: &LockedApproval,
) -> Result<bool, DbError> {
    let now = chrono::Utc::now();
    let workspace_id = approval.workspace_id;

    if !mark_approval_expired_in_tx(&mut *conn, approval.id, now, EXPIRED_REASON).await? {
        return Ok(false);
    }

    // THE line this whole module exists for: the run leaves `RunStatus::LIVE`,
    // so `live_run_count_in_tx` stops counting it and the agent can work again.
    end_parked_run_in_tx(
        &mut *conn,
        approval.run_id,
        RunStatus::TimedOut,
        &json!({
            "code": "approval_expired",
            "approval_id": approval.id.to_string(),
        }),
    )
    .await?;

    // Tell the channel, through the message spine like everything else — the
    // person who asked deserves to see that the request lapsed rather than to
    // find a conversation that simply stops.
    let call_id = approval
        .payload
        .get("tool_call")
        .and_then(|call| call.get("call_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let mut props = ToolResult::error(call_id, EXPIRED_TOOL_RESULT_BODY).message_props();
    if let Some(object) = props.as_object_mut() {
        object.insert("approval_id".into(), json!(approval.id.to_string()));
        object.insert("run_id".into(), json!(approval.run_id.to_string()));
        object.insert("status".into(), json!("expired"));
        object.insert("decided_at_ms".into(), json!(now.timestamp_millis()));
    }
    send_message_in_tx(
        &mut *conn,
        workspace_id,
        NewMessage {
            channel_id: approval.channel_id,
            author_member_id: approval.requested_by,
            message_type: MessageType::ToolResult,
            body: Some(EXPIRED_TOOL_RESULT_BODY.to_string()),
            props,
            root_id: None,
            reply_to_id: None,
            // One expiry line per approval. Shares the key space with the
            // rejection line for the same approval, which is correct: an
            // approval ends exactly once, so only one of the two can exist.
            client_msg_id: Some(approval.id),
            run_id: Some(approval.run_id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;

    let event = decision_event_payload(approval, "expired", None, now, Some(EXPIRED_REASON));
    write_audit(
        &mut *conn,
        // No `.by(..)`: the actor is NULL because no member decided this.
        &AuditEntry::new(workspace_id, "approval.expired")
            .about(approval.requested_by)
            .target("approval", approval.id)
            .run(approval.run_id)
            .with_schema(TOOL_AUDIT_SCHEMA, event.clone()),
    )
    .await?;

    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &decision_broadcast_payload(
            &cent_channel(workspace_id, approval.channel_id),
            approval,
            "expired",
            &event,
            now,
        ),
        Some(approval.channel_id),
    )
    .await?;

    Ok(true)
}
