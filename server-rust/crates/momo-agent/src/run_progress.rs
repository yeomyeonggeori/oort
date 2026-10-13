//! The honest read side of a hosted agent's run (ADR-0200 D1 / D2 / D3, #3741).
//!
//! Everything a client used to guess — "is it working?", "did it lose the
//! signal?" — is answered here from server facts only: the run row, the delivery
//! job's lease, and the run event ledger (`agent_run_event`, migration 128).
//!
//! ## What this module does not do
//!
//! * It never returns a raw ledger `seq`. The sequence is global across tenants,
//!   so a raw value or the gap between two of them is another tenant's activity
//!   volume. Events leave as an ordered list with a per-run **ordinal**, and the
//!   whole ledger (at most 200 rows) is re-read instead of resumed from a cursor.
//! * It never reads or returns `detail`, `textDelta`, or any free text the agent
//!   did not report as a stage marker.
//! * It names no run, requester, channel or title the viewer cannot see: the
//!   queue answer for a channel the viewer is not in is a **count** only.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::run::{decode_run_summary, AgentRunSummaryRow, SUMMARY_COLS};

/// ADR-0200 D1 `phase`, derived — never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunPhase {
    /// Nobody has taken the job.
    Queued,
    /// An agent leased the job; the run has not reported progress yet.
    Claimed,
    Running,
    AwaitingApproval,
    Paused,
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
}

impl RunPhase {
    pub fn as_wire(self) -> &'static str {
        match self {
            RunPhase::Queued => "queued",
            RunPhase::Claimed => "claimed",
            RunPhase::Running => "running",
            RunPhase::AwaitingApproval => "awaiting_approval",
            RunPhase::Paused => "paused",
            RunPhase::Succeeded => "succeeded",
            RunPhase::Failed => "failed",
            RunPhase::TimedOut => "timed_out",
            RunPhase::Cancelled => "cancelled",
        }
    }
}

/// The delivery job's lease, a server fact and orthogonal to [`RunPhase`].
/// `Stale` means "expired and nobody re-claimed it" — an agent MAY still return
/// (ADR-0162 증보 3 부록 A3), so it is "lease not renewed", not "disconnected".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    Live,
    Stale,
    None,
}

impl LeaseState {
    pub fn as_wire(self) -> &'static str {
        match self {
            LeaseState::Live => "live",
            LeaseState::Stale => "stale",
            LeaseState::None => "none",
        }
    }
}

/// A run ahead in the same agent's queue that the viewer is allowed to name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AheadRun {
    pub run_id: Uuid,
    pub channel_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct RunProgressRow {
    pub summary: AgentRunSummaryRow,
    pub agent_member_id: Uuid,
    pub phase: RunPhase,
    pub lease_state: LeaseState,
    pub step_count: i32,
    pub claimed_at: Option<DateTime<Utc>>,
    pub latest_stage: Option<String>,
    pub last_event_at: Option<DateTime<Utc>>,
    pub approval_id: Option<Uuid>,
    pub approval_expires_at: Option<DateTime<Utc>>,
    /// A closed machine code (`approval_expired`, …) for a finished run.
    pub end_reason: Option<String>,
    /// `Some(n)` only for an unclaimed run the agent can actually claim (1 = next).
    pub queue_position: Option<i64>,
    /// Unclaimed runs ahead of this one in the agent's queue, in ANY channel.
    pub ahead_total: i64,
    /// The subset of those the viewer can see (channels the viewer is a member of).
    pub ahead: Vec<AheadRun>,
}

struct RawProgress {
    summary: AgentRunSummaryRow,
    agent_member_id: Uuid,
    step_count: i32,
    end_reason: Option<String>,
    job_id: Option<i64>,
    job_leased: bool,
    lease_live: bool,
    claimed_at: Option<DateTime<Utc>>,
    latest_stage: Option<String>,
    last_event_at: Option<DateTime<Utc>>,
    approval_id: Option<Uuid>,
    approval_expires_at: Option<DateTime<Utc>>,
}

/// Hosted-agent runs of one channel with their derived progress, newest first.
///
/// The caller has already proven the viewer is an active member of `channel_id`.
/// Only runs whose agent has a hosted connection are listed (the ledger exists for
/// no other kind, ADR-0200 D6) — mention runs and work runs alike.
pub async fn list_channel_run_progress_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    viewer_member_id: Uuid,
    active_only: bool,
    limit: i64,
) -> Result<Vec<RunProgressRow>, DbError> {
    let sql = format!(
        "SELECT {SUMMARY_COLS}, r.agent_member_id, r.step_count, \
                CASE WHEN r.status IN ('succeeded','failed','timed_out','cancelled') \
                      AND jsonb_typeof(r.error -> 'code') = 'string' \
                      AND (r.error ->> 'code') ~ '^[a-z0-9_]{{1,64}}$' \
                     THEN r.error ->> 'code' END AS end_reason, \
                j.id AS job_id, \
                (j.lease_owner IS NOT NULL) AS job_leased, \
                COALESCE(j.lease_expires_at > now(), false) AS lease_live, \
                (SELECT max(e.created_at) FROM agent_run_event e \
                  WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id \
                    AND e.kind = 'claimed') AS claimed_at, \
                (SELECT e.stage FROM agent_run_event e \
                  WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id \
                    AND e.kind = 'stage' ORDER BY e.seq DESC LIMIT 1) AS latest_stage, \
                (SELECT max(e.created_at) FROM agent_run_event e \
                  WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id) AS last_event_at, \
                ap.id AS approval_id, ap.expires_at AS approval_expires_at \
           FROM agent_run r \
           LEFT JOIN LATERAL ( \
                SELECT o.id, o.lease_owner, o.lease_expires_at \
                  FROM outbox o \
                 WHERE o.workspace_id = r.workspace_id \
                   AND o.kind = 'agent_job' AND o.method = 'gateway' \
                   AND o.status = 'pending' \
                   AND o.partition_key = r.agent_member_id \
                   AND lower(o.payload ->> 'run_id') = lower(r.id::text) \
                 ORDER BY o.id DESC LIMIT 1 \
           ) j ON r.status IN ('queued', 'running') \
           LEFT JOIN LATERAL ( \
                SELECT a.id, a.expires_at FROM approval a \
                 WHERE a.workspace_id = r.workspace_id AND a.run_id = r.id \
                   AND a.status = 'pending' \
                 ORDER BY a.created_at DESC LIMIT 1 \
           ) ap ON r.status = 'awaiting_approval' \
          WHERE r.workspace_id = $1 AND r.channel_id = $2 \
            AND agent_run_event_is_hosted(r.workspace_id, r.agent_member_id) \
            AND ($3::boolean = false OR r.status IN ('queued','running','awaiting_approval','paused')) \
          ORDER BY r.created_at DESC, r.id DESC \
          LIMIT $4"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(active_only)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    let mut raw = Vec::with_capacity(rows.len());
    for row in &rows {
        raw.push(RawProgress {
            summary: decode_run_summary(row).map_err(DbError::from)?,
            agent_member_id: row.try_get("agent_member_id")?,
            step_count: row.try_get("step_count")?,
            end_reason: row.try_get("end_reason")?,
            job_id: row.try_get("job_id")?,
            job_leased: row.try_get("job_leased")?,
            lease_live: row.try_get("lease_live")?,
            claimed_at: row.try_get("claimed_at")?,
            latest_stage: row.try_get("latest_stage")?,
            last_event_at: row.try_get("last_event_at")?,
            approval_id: row.try_get("approval_id")?,
            approval_expires_at: row.try_get("approval_expires_at")?,
        });
    }

    // The queue: only needed when some run is waiting to be taken.
    let waiting_agents: Vec<Uuid> = raw
        .iter()
        .filter(|run| is_unclaimed(run))
        .map(|run| run.agent_member_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let queue = if waiting_agents.is_empty() {
        Vec::new()
    } else {
        claimable_queue_in_tx(conn, workspace_id, &waiting_agents).await?
    };
    let queue_channels: Vec<Uuid> = queue
        .iter()
        .map(|job| job.channel_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let visible: HashSet<Uuid> = if queue_channels.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT channel_id FROM membership \
              WHERE workspace_id = $1 AND member_id = $2 AND left_at IS NULL \
                AND channel_id = ANY($3)",
        )
        .bind(workspace_id)
        .bind(viewer_member_id)
        .bind(&queue_channels)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect()
    };

    let mut by_agent: HashMap<Uuid, Vec<&QueuedJob>> = HashMap::new();
    for job in &queue {
        by_agent.entry(job.agent_member_id).or_default().push(job);
    }

    Ok(raw
        .into_iter()
        .map(|run| {
            let phase = phase_of(&run);
            let lease_state = lease_state_of(&run);
            let (queue_position, ahead_total, ahead) = if is_unclaimed(&run) {
                position_in_queue(&run, by_agent.get(&run.agent_member_id), &visible)
            } else {
                (None, 0, Vec::new())
            };
            RunProgressRow {
                phase,
                lease_state,
                step_count: run.step_count,
                claimed_at: run.claimed_at,
                latest_stage: run.latest_stage,
                last_event_at: run.last_event_at,
                approval_id: run.approval_id,
                approval_expires_at: run.approval_expires_at,
                end_reason: run.end_reason,
                queue_position,
                ahead_total,
                ahead,
                agent_member_id: run.agent_member_id,
                summary: run.summary,
            }
        })
        .collect())
}

fn is_unclaimed(run: &RawProgress) -> bool {
    use crate::run::RunStatus;
    run.summary.status == RunStatus::Queued && run.job_id.is_some() && !run.job_leased
}

fn phase_of(run: &RawProgress) -> RunPhase {
    use crate::run::RunStatus;
    match run.summary.status {
        RunStatus::Queued if run.job_leased => RunPhase::Claimed,
        RunStatus::Queued => RunPhase::Queued,
        RunStatus::Running => RunPhase::Running,
        RunStatus::AwaitingApproval => RunPhase::AwaitingApproval,
        RunStatus::Paused => RunPhase::Paused,
        RunStatus::Succeeded => RunPhase::Succeeded,
        RunStatus::Failed => RunPhase::Failed,
        RunStatus::TimedOut => RunPhase::TimedOut,
        RunStatus::Cancelled => RunPhase::Cancelled,
    }
}

fn lease_state_of(run: &RawProgress) -> LeaseState {
    if run.job_id.is_none() || !run.job_leased {
        LeaseState::None
    } else if run.lease_live {
        LeaseState::Live
    } else {
        LeaseState::Stale
    }
}

struct QueuedJob {
    job_id: i64,
    agent_member_id: Uuid,
    run_id: Uuid,
    channel_id: Uuid,
}

/// Unclaimed delivery jobs of the given agents that the agent could claim right
/// now, in claim order (`outbox.id ASC`, the order `oort_jobs_claim` takes them).
/// The predicate mirrors the hosted claim's candidate set: pending, no live lease,
/// the connection active, the channel one the human approved for it.
async fn claimable_queue_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agents: &[Uuid],
) -> Result<Vec<QueuedJob>, DbError> {
    let rows = sqlx::query(
        "SELECT o.id AS job_id, o.partition_key AS agent_member_id, \
                o.payload ->> 'run_id' AS run_id, o.payload ->> 'channel_id' AS channel_id \
           FROM outbox o \
           JOIN hosted_agent_connection hc \
             ON hc.workspace_id = o.workspace_id \
            AND hc.agent_member_id = o.partition_key AND hc.status = 'active' \
          WHERE o.workspace_id = $1 \
            AND o.kind = 'agent_job' AND o.method = 'gateway' AND o.status = 'pending' \
            AND o.partition_key = ANY($2) \
            AND (o.lease_owner IS NULL OR o.lease_expires_at <= now()) \
            AND EXISTS ( \
                  SELECT 1 FROM unnest(hosted_connection_channel_ids(hc.workspace_id, hc.id)) \
                         AS approved(channel_id) \
                   WHERE lower(approved.channel_id::text) = lower(o.payload ->> 'channel_id')) \
          ORDER BY o.id ASC \
          LIMIT 2000",
    )
    .bind(workspace_id)
    .bind(agents)
    .fetch_all(&mut *conn)
    .await?;
    let mut jobs = Vec::with_capacity(rows.len());
    for row in &rows {
        let run_id: Option<String> = row.try_get("run_id")?;
        let channel_id: Option<String> = row.try_get("channel_id")?;
        let (Some(run_id), Some(channel_id)) = (
            run_id.and_then(|raw| Uuid::parse_str(&raw).ok()),
            channel_id.and_then(|raw| Uuid::parse_str(&raw).ok()),
        ) else {
            continue;
        };
        jobs.push(QueuedJob {
            job_id: row.try_get("job_id")?,
            agent_member_id: row.try_get("agent_member_id")?,
            run_id,
            channel_id,
        });
    }
    Ok(jobs)
}

fn position_in_queue(
    run: &RawProgress,
    queue: Option<&Vec<&QueuedJob>>,
    visible: &HashSet<Uuid>,
) -> (Option<i64>, i64, Vec<AheadRun>) {
    let (Some(queue), Some(job_id)) = (queue, run.job_id) else {
        return (None, 0, Vec::new());
    };
    // The run's own job is not claimable (connection not active / channel not
    // approved): there is no honest position, so none is given.
    let Some(index) = queue.iter().position(|job| job.job_id == job_id) else {
        return (None, 0, Vec::new());
    };
    let ahead: Vec<AheadRun> = queue[..index]
        .iter()
        .filter(|job| visible.contains(&job.channel_id))
        .map(|job| AheadRun {
            run_id: job.run_id,
            channel_id: job.channel_id,
        })
        .collect();
    (Some(index as i64 + 1), index as i64, ahead)
}

/// One ledger row as a client may see it. No `seq`, no free text beyond `stage`.
#[derive(Debug, Clone)]
pub struct RunEventRow {
    /// 1-based position in this run's ledger — an ordering aid, not a counter of
    /// anything outside this run.
    pub ordinal: i64,
    pub kind: String,
    pub stage: Option<String>,
    pub code: Option<String>,
    pub approval_id: Option<Uuid>,
    pub actor_member_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

/// The whole ledger of one run (≤ 200 rows), oldest first — or `None` when the run
/// is not in this workspace or the viewer is not an active member of its channel.
/// Both are the same `None`, so the answer is no existence oracle (ADR-0200 D3).
pub async fn list_run_events_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    viewer_member_id: Uuid,
) -> Result<Option<Vec<RunEventRow>>, DbError> {
    let visible: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM agent_run r \
           JOIN membership m \
             ON m.workspace_id = r.workspace_id AND m.channel_id = r.channel_id \
            AND m.member_id = $3 AND m.left_at IS NULL \
          WHERE r.workspace_id = $1 AND r.id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(viewer_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    if visible.is_none() {
        return Ok(None);
    }
    let rows = sqlx::query(
        "SELECT row_number() OVER (ORDER BY e.seq) AS ordinal, \
                e.kind, e.stage, e.code, e.approval_id, e.actor_member_id, e.created_at \
           FROM agent_run_event e \
          WHERE e.workspace_id = $1 AND e.run_id = $2 \
          ORDER BY e.seq ASC \
          LIMIT 200",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut events = Vec::with_capacity(rows.len());
    for row in &rows {
        events.push(RunEventRow {
            ordinal: row.try_get("ordinal")?,
            kind: row.try_get("kind")?,
            stage: row.try_get("stage")?,
            code: row.try_get("code")?,
            approval_id: row.try_get("approval_id")?,
            actor_member_id: row.try_get("actor_member_id")?,
            created_at: row.try_get("created_at")?,
        });
    }
    Ok(Some(events))
}
