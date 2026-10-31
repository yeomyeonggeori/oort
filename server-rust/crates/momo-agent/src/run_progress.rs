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
//!
//! ## Why the delivery job is an input, not a query
//!
//! This crate owns no `outbox` SQL (see Cargo.toml). The route layer reads the job
//! lease and the claimable queue from `momo-outbox` — the claim's own predicate —
//! and hands plain facts to [`assemble_run_progress`], which is pure.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use momo_db::DbError;
use serde_json::Value;
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

/// The run-side half of a progress row: everything that lives in `agent_run`,
/// `agent_run_event` and `approval`. The delivery job's lease is not here.
#[derive(Debug, Clone)]
pub struct RunProgressBase {
    pub summary: AgentRunSummaryRow,
    pub agent_member_id: Uuid,
    pub step_count: i32,
    pub end_reason: Option<String>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub latest_stage: Option<String>,
    pub last_event_at: Option<DateTime<Utc>>,
    pub approval_id: Option<Uuid>,
    pub approval_expires_at: Option<DateTime<Utc>>,
}

/// The delivery job behind a run, as plain facts (read from `momo-outbox`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobFacts {
    pub job_id: i64,
    pub leased: bool,
    pub lease_live: bool,
}

/// One entry of an agent's claimable queue, in claim order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueEntry {
    pub job_id: i64,
    pub agent_member_id: Uuid,
    pub run_id: Uuid,
    pub channel_id: Uuid,
}

impl QueueEntry {
    /// `None` when the payload does not carry two uuids (the claim refuses such a
    /// job too, so it is not in the queue either).
    pub fn from_payload(job_id: i64, agent_member_id: Uuid, payload: &Value) -> Option<QueueEntry> {
        let uuid_of = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .and_then(|raw| Uuid::parse_str(raw).ok())
        };
        Some(QueueEntry {
            job_id,
            agent_member_id,
            run_id: uuid_of("run_id")?,
            channel_id: uuid_of("channel_id")?,
        })
    }
}

/// The columns every progress read selects: the run summary, the agent, the
/// counters and the ledger-derived facts. Shared by the channel read and the
/// workspace "running now" read (R1) so the two cannot disagree about what a
/// row means. Expects `agent_run r` and is followed by [`PROGRESS_APPROVAL_JOIN`].
fn progress_select_sql() -> String {
    format!(
        "SELECT {SUMMARY_COLS}, r.agent_member_id, r.step_count, \
                CASE WHEN r.status IN ('succeeded','failed','timed_out','cancelled') \
                      AND jsonb_typeof(r.error -> 'code') = 'string' \
                      AND (r.error ->> 'code') ~ '^[a-z0-9_]{{1,64}}$' \
                     THEN r.error ->> 'code' END AS end_reason, \
                (SELECT max(e.created_at) FROM agent_run_event e \
                  WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id \
                    AND e.kind = 'claimed') AS claimed_at, \
                (SELECT e.stage FROM agent_run_event e \
                  WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id \
                    AND e.kind = 'stage' ORDER BY e.seq DESC LIMIT 1) AS latest_stage, \
                (SELECT max(e.created_at) FROM agent_run_event e \
                  WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id \
                    AND e.kind <> 'doorbell_rung') AS last_event_at, \
                ap.id AS approval_id, ap.expires_at AS approval_expires_at "
    )
}

/// The pending approval of an `awaiting_approval` run (at most one row).
const PROGRESS_APPROVAL_JOIN: &str = "LEFT JOIN LATERAL ( \
                SELECT a.id, a.expires_at FROM approval a \
                 WHERE r.status = 'awaiting_approval' \
                   AND a.workspace_id = r.workspace_id AND a.run_id = r.id \
                   AND a.status = 'pending' \
                 ORDER BY a.created_at DESC LIMIT 1 \
           ) ap ON true ";

fn decode_progress_base(row: &sqlx::postgres::PgRow) -> Result<RunProgressBase, DbError> {
    Ok(RunProgressBase {
        summary: decode_run_summary(row).map_err(DbError::from)?,
        agent_member_id: row.try_get("agent_member_id")?,
        step_count: row.try_get("step_count")?,
        end_reason: row.try_get("end_reason")?,
        claimed_at: row.try_get("claimed_at")?,
        latest_stage: row.try_get("latest_stage")?,
        last_event_at: row.try_get("last_event_at")?,
        approval_id: row.try_get("approval_id")?,
        approval_expires_at: row.try_get("approval_expires_at")?,
    })
}

/// Hosted-agent runs of one channel (mention runs and work runs alike), newest
/// first, WITHOUT their delivery-job facts. The caller has already proven the
/// viewer is an active member of `channel_id`. Only runs whose agent has a hosted
/// connection are listed (the ledger exists for no other kind, ADR-0200 D6).
pub async fn list_channel_run_progress_base_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    active_only: bool,
    limit: i64,
) -> Result<Vec<RunProgressBase>, DbError> {
    let sql = format!(
        "{select} \
           FROM agent_run r \
           {PROGRESS_APPROVAL_JOIN} \
          WHERE r.workspace_id = $1 AND r.channel_id = $2 \
            AND agent_run_event_is_hosted(r.workspace_id, r.agent_member_id) \
            AND ($3::boolean = false OR r.status IN ('queued','running','awaiting_approval','paused')) \
          ORDER BY r.created_at DESC, r.id DESC \
          LIMIT $4",
        select = progress_select_sql(),
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(active_only)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    let mut base = Vec::with_capacity(rows.len());
    for row in &rows {
        base.push(decode_progress_base(row)?);
    }
    Ok(base)
}

// ---------------------------------------------------------------------------
// R1 — "running now" across the viewer's channels (ADR-0200 증보 2026-10-15)
// ---------------------------------------------------------------------------

/// The page cap of the "running now" read (R1: `limit ≤ 100`).
pub const ACTIVE_RUN_PAGE_MAX: i64 = 100;

/// `?limit=` for the "running now" read. Like [`crate::validated_run_limit`] an
/// unparsable value falls back to the default rather than 400ing, but the cap is
/// R1's 100, not the history reads' 200.
pub fn validated_active_run_limit(raw: Option<&str>) -> i64 {
    raw.and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, ACTIVE_RUN_PAGE_MAX)
}

/// `scope=` of the "running now" read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveRunScope {
    /// Every visible run (the default — channels the viewer is a member of).
    Team,
    /// Only runs the viewer requested: the author of a mention run's trigger
    /// message, or the actor of a work run's `agent.work.queued` audit row (the
    /// run has no requester column — the same source the team board reads).
    Mine,
}

impl ActiveRunScope {
    fn is_mine(self) -> bool {
        matches!(self, ActiveRunScope::Mine)
    }
}

/// The ONE predicate that decides which runs the "running now" read may show:
/// a non-terminal run whose channel is unarchived and has the viewer as an
/// active member (`left_at IS NULL` — a DM's runs are therefore its two
/// people's), optionally narrowed to runs the viewer requested. Every agent
/// kind (hosted, managed, BYOA, team AI) and every trigger (mention, work)
/// counts. The page and the per-agent counts both read through it, so a row
/// can never be counted that cannot be listed, or listed that is not counted.
///
/// Binds: `$1` workspace, `$2` viewer member, `$3` mine-only flag.
const ACTIVE_VISIBLE_FROM: &str = "FROM agent_run r \
     JOIN channel c \
       ON c.workspace_id = r.workspace_id AND c.id = r.channel_id AND c.archived_at IS NULL \
     JOIN membership vm \
       ON vm.workspace_id = r.workspace_id AND vm.channel_id = r.channel_id \
      AND vm.member_id = $2 AND vm.left_at IS NULL ";

const ACTIVE_VISIBLE_WHERE: &str = "WHERE r.workspace_id = $1 \
      AND r.status IN ('queued','running','awaiting_approval','paused') \
      AND ($3::boolean = false \
           OR EXISTS (SELECT 1 FROM message tm \
                       WHERE tm.workspace_id = r.workspace_id AND tm.id = r.trigger_message_id \
                         AND tm.author_member_id = $2) \
           OR EXISTS (SELECT 1 FROM audit_log al \
                       WHERE al.workspace_id = r.workspace_id AND al.run_id = r.id \
                         AND al.action = 'agent.work.queued' AND al.actor_member_id = $2)) ";

/// The `(created_at, id)` keyset position of `cursor`, or `None` when that run is
/// not in a channel the viewer can see (the caller answers 400, not an empty
/// page). The run need not still be active: a run that finished between two
/// page reads is still a valid place to resume from.
pub async fn active_run_cursor_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    cursor: Uuid,
) -> Result<Option<(DateTime<Utc>, Uuid)>, DbError> {
    let row = sqlx::query(
        "SELECT r.created_at, r.id FROM agent_run r \
           JOIN membership vm \
             ON vm.workspace_id = r.workspace_id AND vm.channel_id = r.channel_id \
            AND vm.member_id = $2 AND vm.left_at IS NULL \
          WHERE r.workspace_id = $1 AND r.id = $3",
    )
    .bind(workspace_id)
    .bind(viewer_member_id)
    .bind(cursor)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some((row.try_get("created_at")?, row.try_get("id")?))),
        None => Ok(None),
    }
}

/// One keyset page of the "running now" read, newest first, without delivery-job
/// facts. `next_cursor` is `Some` only when a further page exists (the query
/// reads `limit + 1`).
pub async fn list_active_run_progress_base_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    scope: ActiveRunScope,
    after: Option<(DateTime<Utc>, Uuid)>,
    limit: i64,
) -> Result<(Vec<RunProgressBase>, Option<Uuid>), DbError> {
    let sql = format!(
        "{select} \
           {ACTIVE_VISIBLE_FROM} \
           {PROGRESS_APPROVAL_JOIN} \
           {ACTIVE_VISIBLE_WHERE} \
            AND ($4::timestamptz IS NULL OR (r.created_at, r.id) < ($4, $5)) \
          ORDER BY r.created_at DESC, r.id DESC \
          LIMIT $6",
        select = progress_select_sql(),
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(viewer_member_id)
        .bind(scope.is_mine())
        .bind(after.map(|(at, _)| at))
        .bind(after.map(|(_, id)| id))
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await?;
    let mut base = Vec::with_capacity(rows.len());
    for row in &rows {
        base.push(decode_progress_base(row)?);
    }
    let next_cursor = if base.len() as i64 > limit {
        base.truncate(limit as usize);
        base.last().map(|run| run.summary.id)
    } else {
        None
    };
    Ok((base, next_cursor))
}

/// Per-agent counts of the runs the "running now" read can show — over the
/// WHOLE visible set, never the page, so `limit=1` does not shrink them.
/// `queued` is the raw status: the route moves the leased ones to `claimed`
/// with the outbox facts (this crate owns no outbox SQL), which is why the
/// queued run ids come along.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleAgentRunCounts {
    pub agent_member_id: Uuid,
    pub queued: i64,
    pub running: i64,
    pub awaiting_approval: i64,
    pub paused: i64,
    pub queued_run_ids: Vec<Uuid>,
}

/// [`VisibleAgentRunCounts`] for every agent with at least one visible run in
/// `scope`, ordered by agent id. An agent with no visible run is not listed at
/// all — naming it would tell the viewer it is busy in rooms they cannot see.
pub async fn visible_active_run_counts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    scope: ActiveRunScope,
) -> Result<Vec<VisibleAgentRunCounts>, DbError> {
    let sql = format!(
        "SELECT r.agent_member_id, \
                count(*) FILTER (WHERE r.status = 'queued') AS queued, \
                count(*) FILTER (WHERE r.status = 'running') AS running, \
                count(*) FILTER (WHERE r.status = 'awaiting_approval') AS awaiting_approval, \
                count(*) FILTER (WHERE r.status = 'paused') AS paused, \
                COALESCE(array_agg(r.id) FILTER (WHERE r.status = 'queued'), '{{}}'::uuid[]) \
                  AS queued_run_ids \
           {ACTIVE_VISIBLE_FROM} \
           {ACTIVE_VISIBLE_WHERE} \
          GROUP BY r.agent_member_id \
          ORDER BY r.agent_member_id"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(viewer_member_id)
        .bind(scope.is_mine())
        .fetch_all(&mut *conn)
        .await?;
    let mut counts = Vec::with_capacity(rows.len());
    for row in &rows {
        counts.push(VisibleAgentRunCounts {
            agent_member_id: row.try_get("agent_member_id")?,
            queued: row.try_get("queued")?,
            running: row.try_get("running")?,
            awaiting_approval: row.try_get("awaiting_approval")?,
            paused: row.try_get("paused")?,
            queued_run_ids: row.try_get("queued_run_ids")?,
        });
    }
    Ok(counts)
}

/// Each listed agent's non-terminal runs in the WHOLE workspace — every
/// channel, every requester — as one number (R1 `activeTotal`). The same class
/// of leak as D3's `ahead_total` ("this agent is busy"), and nothing else: no
/// id, channel, requester or title of a run the viewer cannot see.
pub async fn workspace_active_run_totals_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agents: &[Uuid],
) -> Result<HashMap<Uuid, i64>, DbError> {
    if agents.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT r.agent_member_id, count(*) AS total FROM agent_run r \
          WHERE r.workspace_id = $1 AND r.agent_member_id = ANY($2) \
            AND r.status IN ('queued','running','awaiting_approval','paused') \
          GROUP BY r.agent_member_id",
    )
    .bind(workspace_id)
    .bind(agents)
    .fetch_all(&mut *conn)
    .await?;
    let mut totals = HashMap::with_capacity(rows.len());
    for row in &rows {
        totals.insert(row.try_get("agent_member_id")?, row.try_get("total")?);
    }
    Ok(totals)
}

/// Which of `channels` the viewer is an active member of.
pub async fn visible_channels_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    channels: &[Uuid],
) -> Result<HashSet<Uuid>, DbError> {
    if channels.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(sqlx::query_scalar::<_, Uuid>(
        "SELECT channel_id FROM membership \
          WHERE workspace_id = $1 AND member_id = $2 AND left_at IS NULL \
            AND channel_id = ANY($3)",
    )
    .bind(workspace_id)
    .bind(viewer_member_id)
    .bind(channels)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect())
}

/// Join the run-side facts with the delivery-job facts and the claimable queue.
/// Pure: no SQL, so the honesty rules below are testable without a database.
///
/// * `jobs` is keyed by run id; a run with no pending job simply has no entry.
/// * `queue` is every agent's claimable queue in claim order.
/// * `visible` is the set of channels the viewer may name runs from.
pub fn assemble_run_progress(
    base: Vec<RunProgressBase>,
    jobs: &HashMap<Uuid, JobFacts>,
    queue: &[QueueEntry],
    visible: &HashSet<Uuid>,
) -> Vec<RunProgressRow> {
    use crate::run::RunStatus;
    let mut by_agent: HashMap<Uuid, Vec<&QueueEntry>> = HashMap::new();
    for entry in queue {
        by_agent
            .entry(entry.agent_member_id)
            .or_default()
            .push(entry);
    }
    base.into_iter()
        .map(|run| {
            let job = jobs.get(&run.summary.id).copied();
            let status = run.summary.status;
            let leased = job.is_some_and(|job| job.leased);
            let phase = match status {
                RunStatus::Queued if leased => RunPhase::Claimed,
                RunStatus::Queued => RunPhase::Queued,
                RunStatus::Running => RunPhase::Running,
                RunStatus::AwaitingApproval => RunPhase::AwaitingApproval,
                RunStatus::Paused => RunPhase::Paused,
                RunStatus::Succeeded => RunPhase::Succeeded,
                RunStatus::Failed => RunPhase::Failed,
                RunStatus::TimedOut => RunPhase::TimedOut,
                RunStatus::Cancelled => RunPhase::Cancelled,
            };
            let lease_state = match job {
                Some(job) if job.leased && job.lease_live => LeaseState::Live,
                Some(job) if job.leased => LeaseState::Stale,
                _ => LeaseState::None,
            };
            let (queue_position, ahead_total, ahead) = match job {
                Some(job) if status == RunStatus::Queued && !job.leased => {
                    position_in_queue(job.job_id, by_agent.get(&run.agent_member_id), visible)
                }
                _ => (None, 0, Vec::new()),
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
        .collect()
}

fn position_in_queue(
    job_id: i64,
    queue: Option<&Vec<&QueueEntry>>,
    visible: &HashSet<Uuid>,
) -> (Option<i64>, i64, Vec<AheadRun>) {
    let Some(queue) = queue else {
        return (None, 0, Vec::new());
    };
    // The run's own job is not claimable (connection not active, token revoked,
    // channel not approved, not yet available): there is no honest position, so
    // none is given.
    let Some(index) = queue.iter().position(|entry| entry.job_id == job_id) else {
        return (None, 0, Vec::new());
    };
    let ahead: Vec<AheadRun> = queue[..index]
        .iter()
        .filter(|entry| visible.contains(&entry.channel_id))
        .map(|entry| AheadRun {
            run_id: entry.run_id,
            channel_id: entry.channel_id,
        })
        .collect();
    (Some(index as i64 + 1), index as i64, ahead)
}

/// One ledger row as a client may see it. No `seq`, no free text beyond the agent-reported
/// `stage`, activity label / id and plan step.
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
    /// `tool_call` rows only: the oort tool name (ADR-0200 증보 2026-10-15 T1).
    pub tool: Option<String>,
    /// `tool_call` rows only: the server-measured duration.
    pub duration_ms: Option<i32>,
    /// `activity` rows only, and only with [`RunEventInclude::activity`]: the newest state of
    /// one activity id (ADR-0200 증보 7 7-7). Agent-reported plain text.
    pub activity: Option<ActivityView>,
    /// `plan` rows only, and only with [`RunEventInclude::activity`]: the newest whole plan.
    pub plan: Option<Vec<PlanStepView>>,
    /// An `activity` row: the time of its last update (the first report is
    /// [`ActivityView::started_at`]).
    pub created_at: DateTime<Utc>,
}

/// One activity as its newest report left it (ADR-0200 증보 7 7-7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityView {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    pub status: String,
    pub n: i32,
    /// The id's FIRST report, carried on every later row.
    pub started_at: DateTime<Utc>,
}

/// One step of the newest plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStepView {
    pub text: String,
    pub status: String,
}

/// Which opt-in ledger kinds a read asks for. Clients built before a kind reject a
/// ledger holding a kind they do not know, so every kind added after the first
/// release is returned only on request (`?include=`).
///
/// `Default` is **everything off**. That default is what keeps the helper's read tool
/// (`get_agent_run`, `RunEventInclude::default()`) from ever carrying an agent's activity
/// label or plan text into a model's context (ADR-0200 증보 7 7-7, 7-8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunEventInclude {
    /// `doorbell_rung` rows (ADR-0200 증보 2026-10-14).
    pub doorbell: bool,
    /// `tool_call` rows plus the tally (ADR-0200 증보 2026-10-15 T4).
    pub tools: bool,
    /// `activity` / `plan` rows (folded to the newest) plus the activity total
    /// (ADR-0200 증보 7 7-7).
    pub activity: bool,
}

/// Per-tool totals of one run's oort calls (`agent_run_tool_tally`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolTallyRow {
    pub tool: String,
    pub ok: i64,
    pub error: i64,
    pub duration_ms_sum: i64,
}

/// The units of ENDED activities of one kind (`agent_run_activity_tally`): the agent's own
/// report, not a count oort made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityTallyRow {
    pub kind: String,
    pub completed: i64,
    pub failed: i64,
}

/// One run's ledger as a viewer may read it.
#[derive(Debug, Clone, Default)]
pub struct RunLedger {
    pub events: Vec<RunEventRow>,
    /// `Some` only when [`RunEventInclude::tools`] was asked for.
    pub tool_tally: Option<Vec<ToolTallyRow>>,
    /// `Some` only with `tools`: whether calls were counted past the row cap (the tally
    /// holds more calls than the ledger has `tool_call` rows).
    pub tool_call_rows_capped: Option<bool>,
    /// `Some` only with [`RunEventInclude::activity`]: the ended units per kind, in the
    /// vocabulary's order, kinds with nothing ended left out.
    pub activity_tally: Option<Vec<ActivityTallyRow>>,
    /// `Some` only with `activity`: the total is larger than the ended activities still
    /// shown, so part of it survives only as a total (the roll removed the rest).
    pub activity_rows_trimmed: Option<bool>,
}

/// The whole ledger of one run (≤ 200 rows), oldest first — or `None` when the run
/// is not in this workspace or the viewer is not an active member of its channel.
/// Both are the same `None`, so the answer is no existence oracle (ADR-0200 D3).
///
/// `doorbell_rung` rows (ADR-0200 증보 2026-10-14) are returned only when the caller asks
/// (`include_doorbell`): clients built before that kind reject a ledger with a kind they
/// do not know, so the default read must stay what they can parse. `tool_call` and
/// `activity`/`plan` rows are never returned here — see [`list_run_ledger_in_tx`].
pub async fn list_run_events_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    viewer_member_id: Uuid,
    include_doorbell: bool,
) -> Result<Option<Vec<RunEventRow>>, DbError> {
    Ok(list_run_ledger_in_tx(
        conn,
        workspace_id,
        run_id,
        viewer_member_id,
        RunEventInclude {
            doorbell: include_doorbell,
            tools: false,
            activity: false,
        },
    )
    .await?
    .map(|ledger| ledger.events))
}

/// [`list_run_events_in_tx`] with every opt-in kind selectable. With `tools`, the
/// `tool_call` rows (≤ 100 per run, ADR-0200 증보 T3) ride along — so the row bound is
/// 300 — and the run's per-tool tally is returned beside them. With `activity`, the
/// agent-reported rows ride along **folded**: one row per activity id (the newest, ≤ 100
/// ids by the roll of migration 167) and the newest plan (1) — so the bound is
/// `200 + (tools: 100) + (activity: 100 + 1)` — beside the ended-unit total. The folded rows
/// have their own bound and are not cut by the oldest-first `LIMIT` of the rest.
///
/// Without `activity` not one `activity` or `plan` row leaves this function.
pub async fn list_run_ledger_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    viewer_member_id: Uuid,
    include: RunEventInclude,
) -> Result<Option<RunLedger>, DbError> {
    // `expired`: the run finished past retention, so its ledger answers empty even before
    // the sweep has deleted it (ADR-0200 D2). `None` = not in this workspace / not a member.
    let visible: Option<bool> = sqlx::query_scalar(
        "SELECT (r.finished_at IS NOT NULL \
                 AND r.finished_at < clock_timestamp() - make_interval(days => $4)) AS expired \
           FROM agent_run r \
           JOIN membership m \
             ON m.workspace_id = r.workspace_id AND m.channel_id = r.channel_id \
            AND m.member_id = $3 AND m.left_at IS NULL \
          WHERE r.workspace_id = $1 AND r.id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(viewer_member_id)
    .bind(crate::run_event::RUN_EVENT_RETENTION_DAYS)
    .fetch_optional(&mut *conn)
    .await?;
    let empty_tools = || include.tools.then(Vec::new);
    match visible {
        None => return Ok(None),
        Some(true) => {
            return Ok(Some(RunLedger {
                events: Vec::new(),
                tool_tally: empty_tools(),
                tool_call_rows_capped: include.tools.then_some(false),
                activity_tally: include.activity.then(Vec::new),
                activity_rows_trimmed: include.activity.then_some(false),
            }))
        }
        Some(false) => {}
    }
    let limit: i64 = if include.tools {
        200 + crate::run_event::TOOL_CALL_ROWS_PER_RUN
    } else {
        200
    };
    // The agent-reported kinds never ride this query: they are folded and bounded below,
    // and only when asked for.
    let rows = sqlx::query(
        "SELECT e.seq, e.kind, e.stage, e.code, e.approval_id, e.actor_member_id, \
                e.tool, e.duration_ms, e.created_at \
           FROM agent_run_event e \
          WHERE e.workspace_id = $1 AND e.run_id = $2 \
            AND e.kind NOT IN ('activity', 'plan') \
            AND ($3 OR e.kind <> 'doorbell_rung') \
            AND ($4 OR e.kind <> 'tool_call') \
          ORDER BY e.seq ASC \
          LIMIT $5",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(include.doorbell)
    .bind(include.tools)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    // `seq` orders the merge below and goes no further: it is not a client value.
    let mut keyed: Vec<(i64, RunEventRow)> = Vec::with_capacity(rows.len());
    for row in &rows {
        keyed.push((
            row.try_get("seq")?,
            RunEventRow {
                ordinal: 0,
                kind: row.try_get("kind")?,
                stage: row.try_get("stage")?,
                code: row.try_get("code")?,
                approval_id: row.try_get("approval_id")?,
                actor_member_id: row.try_get("actor_member_id")?,
                tool: row.try_get("tool")?,
                duration_ms: row.try_get("duration_ms")?,
                activity: None,
                plan: None,
                created_at: row.try_get("created_at")?,
            },
        ));
    }

    let mut activity_tally = None;
    let mut activity_rows_trimmed = None;
    if include.activity {
        // The newest row of each activity id; `ORDER BY seq DESC LIMIT` keeps the newest
        // ids if the roll ever left more than its bound.
        let folded = sqlx::query(
            "SELECT * FROM ( \
               SELECT DISTINCT ON (e.activity_id) \
                      e.seq, e.actor_member_id, e.activity_id, e.activity_kind, e.label, \
                      e.activity_status, e.activity_n, e.activity_started_at, e.created_at \
                 FROM agent_run_event e \
                WHERE e.workspace_id = $1 AND e.run_id = $2 AND e.kind = 'activity' \
                ORDER BY e.activity_id, e.seq DESC) newest \
              ORDER BY newest.seq DESC \
              LIMIT $3",
        )
        .bind(workspace_id)
        .bind(run_id)
        .bind(crate::run_activity::ACTIVITY_ROWS_PER_RUN)
        .fetch_all(&mut *conn)
        .await?;
        let mut ended_shown: i64 = 0;
        for row in &folded {
            let status: String = row.try_get("activity_status")?;
            let n: i32 = row.try_get("activity_n")?;
            if status == "completed" || status == "failed" {
                ended_shown += i64::from(n);
            }
            keyed.push((
                row.try_get("seq")?,
                RunEventRow {
                    ordinal: 0,
                    kind: "activity".to_string(),
                    stage: None,
                    code: None,
                    approval_id: None,
                    actor_member_id: row.try_get("actor_member_id")?,
                    tool: None,
                    duration_ms: None,
                    activity: Some(ActivityView {
                        id: row.try_get("activity_id")?,
                        kind: row.try_get("activity_kind")?,
                        label: row.try_get("label")?,
                        status,
                        n,
                        started_at: row.try_get("activity_started_at")?,
                    }),
                    plan: None,
                    created_at: row.try_get("created_at")?,
                },
            ));
        }
        // The newest whole plan; the older ones are superseded and never read.
        let newest_plan = sqlx::query(
            "SELECT e.seq, e.actor_member_id, e.plan, e.created_at \
               FROM agent_run_event e \
              WHERE e.workspace_id = $1 AND e.run_id = $2 AND e.kind = 'plan' \
              ORDER BY e.seq DESC LIMIT 1",
        )
        .bind(workspace_id)
        .bind(run_id)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(row) = newest_plan {
            let stored: serde_json::Value = row.try_get("plan")?;
            let steps = stored
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            Some(PlanStepView {
                                text: item.get("text")?.as_str()?.to_string(),
                                status: item.get("status")?.as_str()?.to_string(),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            keyed.push((
                row.try_get("seq")?,
                RunEventRow {
                    ordinal: 0,
                    kind: "plan".to_string(),
                    stage: None,
                    code: None,
                    approval_id: None,
                    actor_member_id: row.try_get("actor_member_id")?,
                    tool: None,
                    duration_ms: None,
                    activity: None,
                    plan: Some(steps),
                    created_at: row.try_get("created_at")?,
                },
            ));
        }
        let total_rows = sqlx::query(
            "SELECT kind, completed_units, failed_units \
               FROM agent_run_activity_tally \
              WHERE workspace_id = $1 AND run_id = $2",
        )
        .bind(workspace_id)
        .bind(run_id)
        .fetch_all(&mut *conn)
        .await?;
        let mut totals: Vec<ActivityTallyRow> = Vec::with_capacity(total_rows.len());
        for row in &total_rows {
            let completed: i64 = row.try_get("completed_units")?;
            let failed: i64 = row.try_get("failed_units")?;
            if completed > 0 || failed > 0 {
                totals.push(ActivityTallyRow {
                    kind: row.try_get("kind")?,
                    completed,
                    failed,
                });
            }
        }
        // The vocabulary's order, so the wire order does not depend on the table's.
        totals.sort_by_key(|row| {
            crate::run_activity::ACTIVITY_KINDS
                .iter()
                .position(|kind| *kind == row.kind)
                .unwrap_or(usize::MAX)
        });
        let counted: i64 = totals.iter().map(|row| row.completed + row.failed).sum();
        activity_rows_trimmed = Some(counted > ended_shown);
        activity_tally = Some(totals);
    }

    keyed.sort_by_key(|(seq, _)| *seq);
    let mut events: Vec<RunEventRow> = Vec::with_capacity(keyed.len());
    for (index, (_, mut event)) in keyed.into_iter().enumerate() {
        event.ordinal = index as i64 + 1;
        events.push(event);
    }
    if !include.tools {
        return Ok(Some(RunLedger {
            events,
            tool_tally: None,
            tool_call_rows_capped: None,
            activity_tally,
            activity_rows_trimmed,
        }));
    }
    let tally_rows = sqlx::query(
        "SELECT tool, ok_count, error_count, duration_ms_sum \
           FROM agent_run_tool_tally \
          WHERE workspace_id = $1 AND run_id = $2 \
          ORDER BY tool",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut tally = Vec::with_capacity(tally_rows.len());
    for row in &tally_rows {
        tally.push(ToolTallyRow {
            tool: row.try_get("tool")?,
            ok: row.try_get("ok_count")?,
            error: row.try_get("error_count")?,
            duration_ms_sum: row.try_get("duration_ms_sum")?,
        });
    }
    let counted: i64 = tally.iter().map(|row| row.ok + row.error).sum();
    let written = events.iter().filter(|e| e.kind == "tool_call").count() as i64;
    Ok(Some(RunLedger {
        events,
        tool_tally: Some(tally),
        tool_call_rows_capped: Some(counted > written),
        activity_tally,
        activity_rows_trimmed,
    }))
}
