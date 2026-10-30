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
//! ADR-0200 증보 3 (#4284) adds a third code, `woken_not_collected`: the doorbell reached the
//! agent (`doorbell_rung` `_ok` in the run's ledger) and, 30 minutes after the first
//! uncollected ring, nothing says the agent took the job or is busy. The candidate read is a
//! SUPERSET in SQL (`momo_outbox::lock_woken_candidates_in_tx`); the decision is
//! `momo_agent::woken_uncollected_verdict`, taken on the locked rows. A server-made welcome
//! run (nobody asked for it) ends without a channel line under every code.
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

use momo_agent::{
    active_hosted_connection_id_in_tx, end_stalled_run_in_tx, load_woken_agent_facts_in_tx,
    run_trigger_message_in_tx, stall_app_notice, woken_uncollected_verdict, RunStatus,
    WokenVerdictInput, PROP_ANSWERS_MESSAGE_ID, PROP_APP_NOTICE,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{
    emit_outbox, lock_stalled_hosted_runs_in_tx, lock_woken_candidates_in_tx,
    lock_woken_job_facts_in_tx, pending_job_has_live_lease_in_tx,
    retire_pending_agent_jobs_for_run_with_reason_in_tx, workspaces_with_stalled_hosted_runs,
    workspaces_with_woken_candidates, OutboxKind, StallKind, StallPolicy, StalledRun,
    RUN_STALLED_JOB_LAST_ERROR,
};
use serde_json::json;
use uuid::Uuid;

/// What one sweep iteration did. Counts only — never ids or text.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RunStallStats {
    pub workspaces: usize,
    pub lease_abandoned: usize,
    pub unclaimed_expired: usize,
    pub woken_not_collected: usize,
}

const LINE_LEASE_ABANDONED: &str =
    "에이전트가 응답하지 않아 이 작업을 종료했어요. 다시 요청하면 새로 시작해요.";
const LINE_UNCLAIMED_EXPIRED: &str =
    "에이전트가 오랫동안 이 작업을 가져가지 않아 종료했어요. 다시 요청하면 새로 시작해요.";
/// ADR-0200 증보 3 E4. A general member cannot see the connection, so the line points at
/// the owner; the owner/admin sees the liveness wording (E6, #4285).
const LINE_WOKEN_NOT_COLLECTED: &str =
    "에이전트가 이 작업을 가져가지 않아 종료했어요. 다시 요청해 주세요. 계속 안 되면 에이전트 소유자에게 알려 주세요.";

/// End every stalled hosted run, oldest first, a batch per workspace.
pub async fn sweep_stalled_runs(
    pool: &PgPool,
    policy: StallPolicy,
    batch: i64,
) -> Result<RunStallStats, DbError> {
    let mut conn = pool.acquire().await?;
    let mut workspaces = workspaces_with_stalled_hosted_runs(&mut conn, policy, batch)
        .await
        .map_err(DbError::from)?;
    for workspace_id in workspaces_with_woken_candidates(&mut conn, policy, batch)
        .await
        .map_err(DbError::from)?
    {
        if !workspaces.contains(&workspace_id) {
            workspaces.push(workspace_id);
        }
    }
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
            Ok((abandoned, unclaimed, woken)) => {
                stats.lease_abandoned += abandoned;
                stats.unclaimed_expired += unclaimed;
                stats.woken_not_collected += woken;
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
    if stats.lease_abandoned + stats.unclaimed_expired + stats.woken_not_collected > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            lease_abandoned = stats.lease_abandoned,
            unclaimed_expired = stats.unclaimed_expired,
            woken_not_collected = stats.woken_not_collected,
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
) -> Result<(usize, usize, usize), DbError> {
    // The woken candidates first: a run both woken-and-uncollected and a day old ends as
    // `woken_not_collected` (the earlier, more specific fact). A candidate whose verdict is
    // false is rolled back and still reaches the 24-hour read below on its own terms.
    let mut stalled = lock_woken_candidates_in_tx(&mut *conn, workspace_id, policy, batch)
        .await
        .map_err(DbError::from)?;
    stalled.extend(
        lock_stalled_hosted_runs_in_tx(&mut *conn, workspace_id, policy, batch)
            .await
            .map_err(DbError::from)?,
    );
    let (mut abandoned, mut unclaimed, mut woken) = (0usize, 0usize, 0usize);
    for run in stalled {
        // One SAVEPOINT per run: a run whose line or audit row cannot be written must not
        // roll back (and, tick after tick, block) the others in this workspace.
        let mut savepoint = momo_db::sqlx::Connection::begin(&mut *conn).await?;
        match settle_stalled_run_in_tx(&mut savepoint, workspace_id, &run, policy).await {
            Ok(true) => {
                savepoint.commit().await?;
                match run.kind {
                    StallKind::LeaseAbandoned => abandoned += 1,
                    StallKind::UnclaimedExpired => unclaimed += 1,
                    StallKind::WokenNotCollected => woken += 1,
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
    Ok((abandoned, unclaimed, woken))
}

/// A run silent for longer than this is ended without the channel line: the first sweep
/// after a deploy finds every ghost the system ever accumulated, and an old channel must
/// not light up with weeks-old "the agent did not respond" notices.
const QUIET_AFTER_DAYS: i64 = 7;

/// Does this agent have apps attached (`agent.connector_owner_human_id`)? A plain read
/// inside the sweep's tenant transaction.
async fn agent_has_apps_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    let has: Option<bool> = momo_db::sqlx::query_scalar(
        "SELECT connector_owner_human_id IS NOT NULL \
           FROM agent WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(has.unwrap_or(false))
}

/// ADR-0200 증보 3 E1: the verdict for one locked woken candidate. The run row is locked by
/// the candidate read; here the delivery job row is locked too (a claim waits for this
/// transaction and finds a finished run), then every fact is read AFTER both locks and
/// handed to the pure `woken_uncollected_verdict`. SQL decided nothing before this point.
async fn woken_run_should_end_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run: &StalledRun,
    policy: StallPolicy,
) -> Result<bool, DbError> {
    let connection_id =
        active_hosted_connection_id_in_tx(&mut *conn, workspace_id, run.agent_member_id).await?;
    let Some(connection_id) = connection_id else {
        // E1-1: no active connection — the 24-hour rule and the disconnect cleanup's.
        return Ok(false);
    };
    let job = lock_woken_job_facts_in_tx(
        &mut *conn,
        workspace_id,
        run.run_id,
        run.agent_member_id,
        connection_id,
    )
    .await
    .map_err(DbError::from)?;
    let facts =
        load_woken_agent_facts_in_tx(&mut *conn, workspace_id, run.run_id, connection_id).await?;
    Ok(woken_uncollected_verdict(&WokenVerdictInput {
        now: facts.db_now.unwrap_or_else(chrono::Utc::now),
        expire: chrono::Duration::seconds(policy.woken_expire_seconds),
        run_queued: facts.run_queued,
        run_claimed: facts.run_claimed,
        connection_active: true,
        job_claimable_by_oort: job.claimable_by_oort,
        other_job_live_lease: job.other_job_live_lease,
        liveness: facts.liveness,
        ring_ok_times: facts.ring_ok_times,
        manual_ring_latest: facts.manual_ring_latest,
    }))
}

/// End one stalled run. `Ok(false)` = the run turned out not to be stalled after all.
async fn settle_stalled_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run: &StalledRun,
    policy: StallPolicy,
) -> Result<bool, DbError> {
    if run.kind == StallKind::WokenNotCollected
        && !woken_run_should_end_in_tx(&mut *conn, workspace_id, run, policy).await?
    {
        return Ok(false);
    }
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
    // An ancient ghost has no badge on any screen, so no terminal frame either. Neither
    // has a welcome run that was never claimed (E4): it announces no start frame
    // (`routes/welcome.rs`), so there is no badge for a terminal frame to clear.
    let frame_has_badge = !run.is_welcome || run.claimed;
    if let Some(frame) = momo_agent::terminal_agent_status_payload(
        workspace_id,
        run.channel_id,
        run.agent_member_id,
        run.run_id,
        RunStatus::TimedOut,
        now.timestamp_millis(),
    )
    .filter(|_| !ancient && frame_has_badge)
    {
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

    // E4: nobody is waiting for a welcome run (the server raised it, not a person), so no
    // code says anything in the channel. The ledger and the audit row still record it.
    if !ancient
        && !run.is_welcome
        && momo_messaging::dm::dm_agent_can_speak_in_tx(
            conn,
            workspace_id,
            run.channel_id,
            run.agent_member_id,
        )
        .await?
    {
        let line = match run.kind {
            StallKind::LeaseAbandoned => LINE_LEASE_ABANDONED,
            StallKind::UnclaimedExpired => LINE_UNCLAIMED_EXPIRED,
            StallKind::WokenNotCollected => LINE_WOKEN_NOT_COLLECTED,
        };
        let mut props = json!({
            "kind": "agent_run_timed_out",
            "code": run.kind.code(),
            "run_id": run.run_id.to_string(),
        });
        // ADR-0204 D8 (#3929): the stall notice answers the request the run was raised
        // for, so it names that message and the person who asked is pushed (unless they
        // are looking at the channel). A run with no trigger message (a Work run) still gets
        // the line — a person asked for it — just without the marker or the push; only a
        // server-made welcome run says nothing at all (`is_welcome`, above).
        if let (Some(trigger), Some(object)) = (
            run_trigger_message_in_tx(&mut *conn, workspace_id, run.run_id).await?,
            props.as_object_mut(),
        ) {
            object.insert(PROP_ANSWERS_MESSAGE_ID.into(), json!(trigger.to_string()));
        }
        // ADR-0113 증보 2 E8 (#4054): a silent site is a fact the SERVER observed (the
        // lease nobody renewed → `site_silent`; a job nobody took for a day → `site_off`; a job the doorbell woke the site for and it did not take → `site_silent`), so it says so itself — and only for an agent
        // that has apps attached, where the apps surface is the one reading this key.
        // `site` stays off: a hosted connection is not known to be a Mac or Hermes.
        if let (Some(notice), Some(object)) = (
            stall_app_notice(
                run.kind.code(),
                agent_has_apps_in_tx(&mut *conn, workspace_id, run.agent_member_id).await?,
            ),
            props.as_object_mut(),
        ) {
            object.insert(PROP_APP_NOTICE.into(), notice.to_json());
        }
        send_message_in_tx(
            &mut *conn,
            workspace_id,
            NewMessage {
                channel_id: run.channel_id,
                author_member_id: run.agent_member_id,
                message_type: MessageType::System,
                body: Some(line.to_string()),
                props,
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

#[cfg(test)]
mod tests {
    use super::*;
    use momo_agent::AppNoticeKind;

    /// #4054 — `momo_agent::stall_app_notice` matches the stall's closed code by
    /// string (the agent crate cannot see `StallKind`); this pins the two spellings to
    /// the real codes, so renaming one without the other fails here, not in production.
    #[test]
    fn the_stall_codes_map_to_the_site_facts() {
        let kind_of =
            |kind: StallKind| stall_app_notice(kind.code(), true).map(|notice| notice.kind);
        assert_eq!(
            kind_of(StallKind::LeaseAbandoned),
            Some(AppNoticeKind::SiteSilent)
        );
        assert_eq!(
            kind_of(StallKind::UnclaimedExpired),
            Some(AppNoticeKind::SiteOff)
        );
        // ADR-0200 증보 3 E3: the bell reached the site and it took nothing — silent, not off.
        assert_eq!(
            kind_of(StallKind::WokenNotCollected),
            Some(AppNoticeKind::SiteSilent)
        );
        assert_eq!(
            stall_app_notice(StallKind::LeaseAbandoned.code(), false),
            None
        );
        assert_eq!(
            stall_app_notice(StallKind::WokenNotCollected.code(), false),
            None
        );
    }
}
