//! The hosted-run stall sweep (ADR-0200 D1-4, #3744): the loop that ends a run whose
//! agent went quiet.
//!
//! ## Why it exists
//!
//! A hosted agent that claimed a job and never came back leaves its run `running` for
//! ever: no reaper expires a hosted lease (ADR-0162 증보 3 부록 A), `deadline_at` is only
//! written by the approval path, and the display cannot honestly say more than "lease not
//! renewed". Left alone, the list of "in progress" work only grows and the agent's
//! concurrency slot (`agent.max_concurrent_runs`) is held by a ghost.
//!
//! So the run is ended with an explicit, closed fact — `timed_out` with `lease_abandoned`
//! (the lease expired more than 2 h ago, nobody re-claimed it, the run saw no event for that
//! long) or `unclaimed_expired` (a queued run nobody took for 24 h). It is never reassigned
//! or retried, and a run that is fresh again — a re-claim, a renewal, any report — is left
//! alone.
//!
//! ## Shape
//!
//! Exactly the approval sweep's (and for the same reason): one cross-tenant READ to learn
//! which workspaces have work, then one `with_tenant_tx` per workspace in which every
//! candidate is ROW-LOCKED (`FOR UPDATE OF r SKIP LOCKED`) and settled with the same
//! domain functions a request uses — the agent's own callbacks lock the run row first, so
//! a report landing mid-sweep serializes behind it and finds a finished run.
//!
//! Per run, in the one transaction: the run ends (`timed_out`, the ledger trigger records
//! the code), its delivery job is retired (a late agent finds it settled, not revived),
//! the progress rail is told (a "working" badge clears), the channel gets one system line,
//! and one audit row says why. The actor is the clock, not a member.

use momo_agent::{end_stalled_run_in_tx, RunStatus};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{
    emit_outbox, lock_stalled_hosted_runs_in_tx, pending_job_has_live_lease_in_tx,
    retire_pending_agent_jobs_for_run_with_reason_in_tx, workspaces_with_stalled_hosted_runs,
    OutboxKind, StallKind, StallPolicy, StalledRun, RUN_STALLED_JOB_LAST_ERROR,
};
use serde_json::json;
use uuid::Uuid;

/// What one sweep iteration did. Counts only — never ids or text.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RunStallStats {
    pub workspaces: usize,
    pub lease_abandoned: usize,
    pub unclaimed_expired: usize,
}

const LINE_LEASE_ABANDONED: &str =
    "에이전트가 응답하지 않아 이 작업을 종료했어요. 다시 요청하면 새로 시작해요.";
const LINE_UNCLAIMED_EXPIRED: &str =
    "에이전트가 오랫동안 이 작업을 가져가지 않아 종료했어요. 다시 요청하면 새로 시작해요.";

/// End every stalled hosted run, oldest first, a batch per workspace.
pub async fn sweep_stalled_runs(
    pool: &PgPool,
    policy: StallPolicy,
    batch: i64,
) -> Result<RunStallStats, DbError> {
    let mut conn = pool.acquire().await?;
    let workspaces = workspaces_with_stalled_hosted_runs(&mut conn, policy, batch)
        .await
        .map_err(DbError::from)?;
    drop(conn);

    let mut stats = RunStallStats {
        workspaces: workspaces.len(),
        ..RunStallStats::default()
    };
    for workspace_id in workspaces {
        let settled = with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move { sweep_workspace_in_tx(conn, workspace_id, policy, batch).await })
        })
        .await;
        match settled {
            Ok((abandoned, unclaimed)) => {
                stats.lease_abandoned += abandoned;
                stats.unclaimed_expired += unclaimed;
            }
            Err(error) => {
                // One tenant's failure must not stop the others; the run is still
                // stalled and the next tick retries.
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "run stall sweep failed for a workspace"
                );
            }
        }
    }
    if stats.lease_abandoned + stats.unclaimed_expired > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            lease_abandoned = stats.lease_abandoned,
            unclaimed_expired = stats.unclaimed_expired,
            "run stall sweep ended stalled hosted runs"
        );
    }
    Ok(stats)
}

async fn sweep_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    policy: StallPolicy,
    batch: i64,
) -> Result<(usize, usize), DbError> {
    let stalled = lock_stalled_hosted_runs_in_tx(&mut *conn, workspace_id, policy, batch)
        .await
        .map_err(DbError::from)?;
    let (mut abandoned, mut unclaimed) = (0usize, 0usize);
    for run in stalled {
        // One SAVEPOINT per run: a run whose line or audit row cannot be written must not
        // roll back (and, tick after tick, block) the others in this workspace.
        let mut savepoint = momo_db::sqlx::Connection::begin(&mut *conn).await?;
        match settle_stalled_run_in_tx(&mut savepoint, workspace_id, &run).await {
            Ok(true) => {
                savepoint.commit().await?;
                match run.kind {
                    StallKind::LeaseAbandoned => abandoned += 1,
                    StallKind::UnclaimedExpired => unclaimed += 1,
                }
            }
            Ok(false) => {
                savepoint.rollback().await?;
            }
            Err(error) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    run_id = %run.run_id,
                    error = %error,
                    "run stall sweep could not settle one run"
                );
                savepoint.rollback().await?;
            }
        }
    }
    Ok((abandoned, unclaimed))
}

/// A run silent for longer than this is ended without the channel line: the first sweep
/// after a deploy finds every ghost the system ever accumulated, and an old channel must
/// not light up with weeks-old "the agent did not respond" notices.
const QUIET_AFTER_DAYS: i64 = 7;

/// End one stalled run. `Ok(false)` = the run turned out not to be stalled after all.
async fn settle_stalled_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run: &StalledRun,
) -> Result<bool, DbError> {
    // The candidate read is a snapshot, and a claim locks the job row, never the run: an agent
    // that re-claimed between the snapshot and our run lock holds a live lease now. Lock the
    // job rows and look again before ending anything.
    if pending_job_has_live_lease_in_tx(&mut *conn, workspace_id, run.run_id)
        .await
        .map_err(DbError::from)?
    {
        return Ok(false);
    }
    if !end_stalled_run_in_tx(&mut *conn, run.run_id, run.kind.code()).await? {
        return Ok(false);
    }
    retire_pending_agent_jobs_for_run_with_reason_in_tx(
        &mut *conn,
        workspace_id,
        run.run_id,
        RUN_STALLED_JOB_LAST_ERROR,
    )
    .await
    .map_err(DbError::from)?;

    let now = chrono::Utc::now();
    let ancient = now - run.last_activity_at > chrono::Duration::days(QUIET_AFTER_DAYS);
    if let Some(frame) = momo_agent::terminal_agent_status_payload(
        workspace_id,
        run.channel_id,
        run.agent_member_id,
        run.run_id,
        RunStatus::TimedOut,
        now.timestamp_millis(),
    ) {
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &frame,
            Some(run.channel_id),
        )
        .await?;
    }

    if !ancient {
        let line = match run.kind {
            StallKind::LeaseAbandoned => LINE_LEASE_ABANDONED,
            StallKind::UnclaimedExpired => LINE_UNCLAIMED_EXPIRED,
        };
        send_message_in_tx(
            &mut *conn,
            workspace_id,
            NewMessage {
                channel_id: run.channel_id,
                author_member_id: run.agent_member_id,
                message_type: MessageType::System,
                body: Some(line.to_string()),
                props: json!({
                    "kind": "agent_run_timed_out",
                    "code": run.kind.code(),
                    "run_id": run.run_id.to_string(),
                }),
                root_id: None,
                reply_to_id: None,
                // One line per run (the run ends exactly once). NOT the run id itself:
                // the push judgment recognises a hosted run's ANSWER by
                // `client_msg_id = run id`, and this notice is not an answer.
                client_msg_id: Some(Uuid::new_v5(&run.run_id, b"agent_run_timed_out")),
                run_id: Some(run.run_id),
                hlc_ts: None,
                hlc_count: None,
            },
        )
        .await?;
    }

    write_audit(
        &mut *conn,
        // No `.by(..)`: the clock ended this run, not a member.
        &AuditEntry::new(workspace_id, "agent.run.stalled")
            .about(run.agent_member_id)
            .target("agent_run", run.run_id)
            .run(run.run_id)
            .with_schema(
                "momo.agent.run.stalled.v1",
                json!({"code": run.kind.code(), "quiet": ancient}),
            ),
    )
    .await?;
    Ok(true)
}
