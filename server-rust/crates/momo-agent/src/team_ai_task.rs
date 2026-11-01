//! The team AI's **task mode** — the marker row and the one place that decides what a step may do
//! (ADR-0201 증보 v3 B5·B13-I7·B14-S4, #4967).
//!
//! A request the helper cannot finish inside one short turn (calls ≤4, tools ≤6, 45 s) becomes a
//! *task*: the same run is continued by **step jobs**, one resume job per step. Between steps only
//! a plan (≤8 lines) and a note (≤2,000 chars) survive, in the server-only `team_ai_task` row
//! (migration 169); the conversation and the tool results do not. Each step re-derives the
//! requester from the run's trigger message and reads again as that person.
//!
//! ## The row's existence is the judgement
//!
//! "Is this run in task mode?" is answered by the row, never by what a job payload says
//! ([`decide_step`]): a re-claimed first-turn job, a duplicated step job and a late job of a task
//! that has ended all read the same row and reach the same verdict, so **no step runs twice**.
//!
//! * `steps_done` counts finished steps (the request's own first turn is step 1). A step commits with
//!   a conditional UPDATE on `steps_done` ([`commit_step_in_tx`]) — a compare-and-swap, so of two
//!   commits for one step exactly one writes.
//! * A step is *executed* under a claim ([`claim_step_in_tx`]): `claim_token` is the claiming
//!   job's outbox lease id and `claim_until` bounds it. A second worker that finds a live claim does
//!   not call the model ([`ClaimOutcome::Taken`]); a worker that finds the claim expired takes the
//!   step over (the first one crashed or hung), and the first one's late commit finds its token
//!   gone and writes nothing.
//! * A task ends exactly once ([`end_in_tx`]) and an ended row holds no plan, no note and no claim —
//!   the table's own CHECK (`team_ai_task_ended_ck`) makes "종결 뒤 노트 삭제" a property of the
//!   database rather than of this module's discipline.
//!
//! ## What this module does not decide
//!
//! The model loop, the replies and the sentences live in `momo_agent_worker::team_ai` and
//! `momo_workspace_actions::team_ai`. This module is the data and the rules that must hold in the
//! same place for the api (`live_run_count_in_tx` excludes a task run from the concurrency count;
//! `cancel_run_in_tx` ends the task) and the worker (claims, commits, ends).

use momo_db::DbError;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::run::RunStatus;
use crate::tools::{TASK_NOTE_CHARS_MAX, TASK_PLAN_ITEMS_MAX, TASK_PLAN_ITEM_CHARS_MAX};
use crate::usage::ResolvedUsage;

/// How long one worker's claim on a step lives. It must outlast the step (a 45-second request plus
/// the commit) and stay below the outbox job lease (`DEFAULT_WORKER_LEASE_SECONDS`, 300 s), so a
/// job that is re-claimed after its lease expired always finds the dead worker's claim expired too.
pub const STEP_CLAIM_SECS: i64 = 120;

/// `created_from` of a step job's payload.
pub const STEP_JOB_CREATED_FROM: &str = "server.team_ai_task.step.v1";

/// The payload key that carries the step number a job intends to run. The key is a hint for the
/// decision, not the judgement: [`decide_step`] compares it with the row.
pub const STEP_JOB_PAYLOAD_KEY: &str = "team_ai_task_step";

/// An active task whose run is over and whose row has been idle this long is an orphan (a run that
/// failed for good through a path that does not know tasks). Longer than the whole retry backoff
/// (≤ ~3 minutes), so a run that is merely `failed` *between attempts* is never swept.
pub const ORPHAN_GRACE_SECS: i64 = 900;

// --- end reasons: the closed vocabulary of `team_ai_task.end_reason` and of the run's error code ---

/// The task finished: the final report was posted.
pub const END_DONE: &str = "done";
/// A task bound was reached (steps, wall clock, model calls, tool calls) or a B9 usage limit
/// (the operator's switch or ceiling, the team's daily tokens or monthly dollars): an interim report
/// from the note was posted (B5-5).
pub const END_LIMIT: &str = "task_limit";
/// A person stopped the run (the existing cancel route, B5-8).
pub const END_CANCELLED: &str = "task_cancelled";
/// The person who asked is no longer an active member of the room (B5-6).
pub const END_REQUESTER_GONE: &str = "task_requester_gone";
/// The model provider could not carry the step on (B5-9).
pub const END_PROVIDER_ERROR: &str = "task_provider_error";
/// An admin switched the `long_research` bundle off while the task was running (B13-I5).
pub const END_ROLE_OFF: &str = "task_role_off";
/// The run ended through a path that does not know tasks; the sweep closed the row.
pub const END_RUN_ENDED: &str = "run_ended";
/// The job ran out of attempts (the worker's own retry budget) and the run failed for good.
pub const END_FAILED: &str = "task_failed";

// ---------------------------------------------------------------------------
// the bounds (B5-5: [추정] defaults, configuration values)
// ---------------------------------------------------------------------------

/// The task's safety bounds — **configuration values, not workspace settings** (B5-5): the numbers
/// are estimates to be measured and amended, so they are knobs of the worker, not constants.
/// A bound reached ends the task with an interim report and the code [`END_LIMIT`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskLimits {
    /// Steps a task may run, the request's own first turn included.
    pub max_steps: i32,
    /// Wall clock from the task's start.
    pub max_wall_secs: i64,
    /// Model calls over the whole task.
    pub max_model_calls: i32,
    /// Workspace read-tool calls over the whole task.
    pub max_tool_calls: i32,
    /// Tasks one workspace may have running at once.
    pub max_per_workspace: i64,
    /// Tasks one requester may have running at once.
    pub max_per_requester: i64,
}

impl Default for TaskLimits {
    fn default() -> Self {
        TaskLimits {
            max_steps: 20,
            max_wall_secs: 60 * 60,
            max_model_calls: 60,
            max_tool_calls: 100,
            max_per_workspace: 3,
            max_per_requester: 1,
        }
    }
}

/// Which bound a task reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitHit {
    Steps,
    WallClock,
    ModelCalls,
    ToolCalls,
}

impl LimitHit {
    pub fn as_str(self) -> &'static str {
        match self {
            LimitHit::Steps => "steps",
            LimitHit::WallClock => "wall_clock",
            LimitHit::ModelCalls => "model_calls",
            LimitHit::ToolCalls => "tool_calls",
        }
    }
}

impl TaskLimits {
    /// The first bound the counters have reached, if any. "Reached" is `>=`: a task that has run
    /// `max_steps` steps does not start another.
    pub fn hit(
        &self,
        steps_done: i32,
        model_calls: i32,
        tool_calls: i32,
        elapsed_secs: i64,
    ) -> Option<LimitHit> {
        if steps_done >= self.max_steps {
            Some(LimitHit::Steps)
        } else if elapsed_secs >= self.max_wall_secs {
            Some(LimitHit::WallClock)
        } else if model_calls >= self.max_model_calls {
            Some(LimitHit::ModelCalls)
        } else if tool_calls >= self.max_tool_calls {
            Some(LimitHit::ToolCalls)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// the row
// ---------------------------------------------------------------------------

/// One `team_ai_task` row as a step reads it. The clock facts are evaluated by the database in the
/// same statement (`claim_live`, `elapsed_secs`), so no worker clock decides who owns a step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    pub active: bool,
    pub end_reason: Option<String>,
    pub steps_done: i32,
    pub model_calls: i32,
    pub tool_calls: i32,
    pub web_searches: i32,
    pub plan: Vec<String>,
    pub note: String,
    pub claim_token: Option<Uuid>,
    /// `claim_until` is in the future.
    pub claim_live: bool,
    /// Seconds since the task started.
    pub elapsed_secs: i64,
}

const ROW_COLS: &str = "state, end_reason, steps_done, model_calls, tool_calls, web_searches, plan, note, \
     claim_token, COALESCE(claim_until > clock_timestamp(), false) AS claim_live, \
     GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at))))::bigint AS elapsed_secs";

fn decode_row(row: &sqlx::postgres::PgRow) -> Result<TaskRow, sqlx::Error> {
    let state: String = row.try_get("state")?;
    let plan: Option<Value> = row.try_get("plan")?;
    let plan = plan
        .as_ref()
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let note: Option<String> = row.try_get("note")?;
    Ok(TaskRow {
        active: state == "active",
        end_reason: row.try_get("end_reason")?,
        steps_done: row.try_get("steps_done")?,
        model_calls: row.try_get("model_calls")?,
        tool_calls: row.try_get("tool_calls")?,
        web_searches: row.try_get("web_searches")?,
        plan,
        note: note.unwrap_or_default(),
        claim_token: row.try_get("claim_token")?,
        claim_live: row.try_get("claim_live")?,
        elapsed_secs: row.try_get("elapsed_secs")?,
    })
}

/// The task of a run, or `None` when the run is not in task mode — the **judgement itself**.
pub async fn load_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Option<TaskRow>, DbError> {
    let sql =
        format!("SELECT {ROW_COLS} FROM team_ai_task WHERE workspace_id = $1 AND run_id = $2");
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(run_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.as_ref().map(decode_row).transpose()?)
}

/// What a job must do, given the run's row and the step number the job intends to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepDecision {
    /// No row, and the job is the request's first turn: the ordinary fast path (it may start a
    /// task at its end).
    FirstTurn,
    /// The row says step `n` is the one to run now. Claim it first.
    RunStep(i32),
    /// Nothing to run: the step is already done (a re-claim or a duplicate job), or the task has
    /// ended, or the job is out of order. The job is dropped; the run is not touched.
    Skip(SkipReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The task has ended (any reason).
    Ended,
    /// That step (or a later one) is already done.
    StepDone,
    /// The job is ahead of the row — it never happens in order; not run.
    OutOfOrder,
    /// A step job whose row does not exist.
    NoTask,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::Ended => "team_ai_task_ended",
            SkipReason::StepDone => "team_ai_task_step_done",
            SkipReason::OutOfOrder => "team_ai_task_out_of_order",
            SkipReason::NoTask => "team_ai_task_missing",
        }
    }
}

/// The one decision. `intended_step` is the number the job carries (`1` for the request's own
/// first-turn job, which carries none).
pub fn decide_step(task: Option<&TaskRow>, intended_step: i32) -> StepDecision {
    let Some(task) = task else {
        return if intended_step <= 1 {
            StepDecision::FirstTurn
        } else {
            StepDecision::Skip(SkipReason::NoTask)
        };
    };
    if !task.active {
        return StepDecision::Skip(SkipReason::Ended);
    }
    if intended_step <= task.steps_done {
        StepDecision::Skip(SkipReason::StepDone)
    } else if intended_step == task.steps_done + 1 {
        StepDecision::RunStep(intended_step)
    } else {
        StepDecision::Skip(SkipReason::OutOfOrder)
    }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/// What a task starts with: the first step's plan, note and spend.
#[derive(Debug, Clone)]
pub struct NewTask<'a> {
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub agent_member_id: Uuid,
    pub plan: &'a [String],
    pub note: &'a str,
    pub model_calls: i32,
    pub tool_calls: i32,
    pub web_searches: i32,
}

/// What [`create_in_tx`] decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateOutcome {
    /// The row now exists with `steps_done = 1`.
    Created,
    /// A row for this run already exists (a re-run of the first turn): nothing was written.
    AlreadyExists,
    /// The workspace already has [`TaskLimits::max_per_workspace`] tasks running.
    WorkspaceBusy,
    /// The requester already has [`TaskLimits::max_per_requester`] tasks running.
    RequesterBusy,
}

/// Start a task: take the per-workspace lock, count the tasks that are running, and insert the row
/// — one transaction, so two starts cannot both pass the count. A task is *running* while its row
/// is active and its run has not ended for good; the requester of a running task is the author of
/// its run's trigger message (the one place a requester is derived).
pub async fn create_in_tx(
    conn: &mut PgConnection,
    new: &NewTask<'_>,
    requester_member_id: Uuid,
    limits: &TaskLimits,
) -> Result<CreateOutcome, DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4967))")
        .bind(format!("team_ai_task:{}", new.workspace_id))
        .execute(&mut *conn)
        .await?;
    let exists: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM team_ai_task WHERE workspace_id = $1 AND run_id = $2")
            .bind(new.workspace_id)
            .bind(new.run_id)
            .fetch_optional(&mut *conn)
            .await?;
    if exists.is_some() {
        return Ok(CreateOutcome::AlreadyExists);
    }
    let (in_workspace, by_requester): (i64, i64) = sqlx::query_as(
        "SELECT count(*)::bigint, \
                count(*) FILTER (WHERE m.author_member_id = $3)::bigint \
           FROM team_ai_task t \
           JOIN agent_run r ON r.workspace_id = t.workspace_id AND r.id = t.run_id \
           LEFT JOIN message m ON m.workspace_id = r.workspace_id AND m.id = r.trigger_message_id \
          WHERE t.workspace_id = $1 AND t.state = 'active' AND t.run_id <> $2 \
            AND r.status NOT IN ('succeeded', 'cancelled', 'timed_out')",
    )
    .bind(new.workspace_id)
    .bind(new.run_id)
    .bind(requester_member_id)
    .fetch_one(&mut *conn)
    .await?;
    if in_workspace >= limits.max_per_workspace {
        return Ok(CreateOutcome::WorkspaceBusy);
    }
    if by_requester >= limits.max_per_requester {
        return Ok(CreateOutcome::RequesterBusy);
    }
    let inserted = sqlx::query(
        "INSERT INTO team_ai_task \
           (workspace_id, run_id, agent_member_id, steps_done, model_calls, tool_calls, web_searches, \
            plan, note) \
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8) \
         ON CONFLICT (workspace_id, run_id) DO NOTHING",
    )
    .bind(new.workspace_id)
    .bind(new.run_id)
    .bind(new.agent_member_id)
    .bind(new.model_calls)
    .bind(new.tool_calls)
    .bind(new.web_searches)
    .bind(json!(new.plan))
    .bind(new.note)
    .execute(&mut *conn)
    .await?;
    Ok(if inserted.rows_affected() > 0 {
        CreateOutcome::Created
    } else {
        CreateOutcome::AlreadyExists
    })
}

// ---------------------------------------------------------------------------
// claim, commit, end
// ---------------------------------------------------------------------------

/// What [`claim_step_in_tx`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimOutcome {
    /// This job owns step `step` now; the row is what the step runs on.
    Claimed(TaskRow),
    /// Another worker holds a live claim on this very step. Do not call the model; try again later.
    Taken,
    /// The row is gone, ended, or already past this step.
    Gone,
}

/// Claim step `step` (`steps_done` must be `step - 1`) for `token`, unless a live claim of another
/// token holds it. An expired claim — a worker that died or hung — is taken over.
pub async fn claim_step_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    step: i32,
    token: Uuid,
) -> Result<ClaimOutcome, DbError> {
    let sql = format!(
        "UPDATE team_ai_task \
            SET claim_token = $4, \
                claim_until = clock_timestamp() + make_interval(secs => $5), \
                updated_at = now() \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active' AND steps_done = $3 \
            AND (claim_token IS NULL OR claim_token = $4 OR claim_until <= clock_timestamp()) \
      RETURNING {ROW_COLS}"
    );
    let claimed = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(run_id)
        .bind(step - 1)
        .bind(token)
        .bind(STEP_CLAIM_SECS as f64)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(row) = claimed {
        return Ok(ClaimOutcome::Claimed(decode_row(&row)?));
    }
    Ok(match load_in_tx(conn, workspace_id, run_id).await? {
        Some(row) if row.active && row.steps_done == step - 1 => ClaimOutcome::Taken,
        _ => ClaimOutcome::Gone,
    })
}

/// Give a claim back without finishing the step (the step failed before it wrote anything and the
/// job will be retried): a retry should not wait out [`STEP_CLAIM_SECS`].
pub async fn release_claim_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    token: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE team_ai_task SET claim_token = NULL, claim_until = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active' AND claim_token = $3",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(token)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A finished step that is not the last: the plan and note for the next one, and what this step
/// spent.
#[derive(Debug, Clone)]
pub struct StepCommit<'a> {
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub token: Uuid,
    /// The step being committed (`steps_done` becomes this).
    pub step: i32,
    pub plan: &'a [String],
    pub note: &'a str,
    pub model_calls: i32,
    pub tool_calls: i32,
    pub web_searches: i32,
}

/// Commit step `commit.step`: `steps_done` moves from `step - 1` to `step` **only** for the holder
/// of the claim on an active row. `None` means the step lost (the task ended, was cancelled, or the
/// claim was taken over): the caller writes nothing but what it already spent.
pub async fn commit_step_in_tx(
    conn: &mut PgConnection,
    commit: &StepCommit<'_>,
) -> Result<Option<TaskRow>, DbError> {
    let sql = format!(
        "UPDATE team_ai_task \
            SET steps_done = steps_done + 1, \
                plan = $5, note = $6, \
                model_calls = model_calls + $7, tool_calls = tool_calls + $8, \
                web_searches = web_searches + $9, \
                claim_token = NULL, claim_until = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active' \
            AND steps_done = $3 AND claim_token = $4 \
      RETURNING {ROW_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(commit.workspace_id)
        .bind(commit.run_id)
        .bind(commit.step - 1)
        .bind(commit.token)
        .bind(json!(commit.plan))
        .bind(commit.note)
        .bind(commit.model_calls)
        .bind(commit.tool_calls)
        .bind(commit.web_searches)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.as_ref().map(decode_row).transpose()?)
}

/// End the task of a run with `reason`, dropping the plan, the note and the claim. Idempotent: an
/// already-ended or missing row is not touched, and `false` says so. Called by every path that
/// ends the run (the worker's final reply, the cancel route), in the same transaction.
pub async fn end_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    reason: &str,
) -> Result<bool, DbError> {
    let ended = sqlx::query(
        "UPDATE team_ai_task \
            SET state = 'ended', end_reason = $3, plan = NULL, note = NULL, \
                claim_token = NULL, claim_until = NULL, ended_at = now(), updated_at = now() \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active'",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(ended.rows_affected() > 0)
}

/// Workspaces holding an orphaned active task — the cross-tenant **read** half of the sweep (the
/// worker's BYPASSRLS connection, like the job claim). A task is an orphan when its run is over
/// (`failed` counts: the retry path marks a run `failed` between attempts, so the row must also be
/// idle for [`ORPHAN_GRACE_SECS`]) and nothing has touched the row since.
pub async fn workspaces_with_orphan_tasks(
    conn: &mut PgConnection,
    limit: i64,
) -> Result<Vec<Uuid>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT t.workspace_id \
           FROM team_ai_task t \
           JOIN agent_run r ON r.workspace_id = t.workspace_id AND r.id = t.run_id \
          WHERE t.state = 'active' \
            AND r.status IN ('succeeded', 'failed', 'cancelled', 'timed_out') \
            AND t.updated_at < now() - make_interval(secs => $1) \
          LIMIT $2",
    )
    .bind(ORPHAN_GRACE_SECS as f64)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?)
}

/// The **write** half of the sweep, inside one workspace's tenant transaction: end every orphaned
/// task there with [`END_RUN_ENDED`]. Returns how many rows it closed.
pub async fn end_orphan_tasks_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<u64, DbError> {
    let ended = sqlx::query(
        "UPDATE team_ai_task t \
            SET state = 'ended', end_reason = $2, plan = NULL, note = NULL, \
                claim_token = NULL, claim_until = NULL, ended_at = now(), updated_at = now() \
           FROM agent_run r \
          WHERE t.workspace_id = $1 AND t.state = 'active' \
            AND r.workspace_id = t.workspace_id AND r.id = t.run_id \
            AND r.status IN ('succeeded', 'failed', 'cancelled', 'timed_out') \
            AND t.updated_at < now() - make_interval(secs => $3)",
    )
    .bind(workspace_id)
    .bind(END_RUN_ENDED)
    .bind(ORPHAN_GRACE_SECS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(ended.rows_affected())
}

/// Does the run still have a **G3** step to spend (`agent.max_run_steps`, copied to the run as
/// `max_steps`), under the task's own step bound `ceiling`? A read: the caller holds the run's row
/// lock, so the answer stays true until its transaction ends.
///
/// G3 and the task bound are two counters that meet here (ADR-0201 증보 v3 B5-11): a task step
/// spends one of the run's G3 steps exactly where `steps_done` moves, so `agent_run.step_count`
/// equals the steps the task has finished, and the lower of the two ceilings wins. With the
/// defaults (`max_run_steps` 50, task bound 20) G3 never binds; an operator who lowers the
/// helper's `max_run_steps` lowers every task with it.
pub async fn step_room_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    ceiling: i32,
) -> Result<bool, DbError> {
    let room: Option<bool> = sqlx::query_scalar(
        "SELECT step_count < LEAST(max_steps, $3) FROM agent_run \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(ceiling)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(room.unwrap_or(false))
}

/// A run's status as a step reads it (the cooperative cancel check), or `None` for no such run.
pub async fn run_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Option<RunStatus>, DbError> {
    let label: Option<String> = sqlx::query_scalar(
        "SELECT status::text FROM agent_run WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(label.as_deref().and_then(RunStatus::from_db_label))
}

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------

/// One `usage_ledger` row for one step. The ledger is immutable and its run-level writer
/// ([`crate::usage::record_run_usage_in_tx`]) keeps one row per run, which a task of many steps
/// cannot use: each step is one request and writes its own row. What keeps a step from being
/// charged twice is not this statement but the transaction around it — a step's commit is a
/// compare-and-swap on the task row, and a spend whose step lost is still real money, so it is
/// written (the caller does) and counted once because each worker attempt writes its own.
pub async fn record_step_usage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    usage: &ResolvedUsage,
    web_search_requests: i32,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO usage_ledger \
           (workspace_id, run_id, agent_member_id, channel_id, model, \
            prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, \
            cost_micro_usd, was_estimated, effort, source, web_search_requests) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(agent_member_id)
    .bind(channel_id)
    .bind(&usage.model)
    .bind(usage.prompt_tokens)
    .bind(usage.completion_tokens)
    .bind(usage.cached_tokens)
    .bind(usage.reasoning_tokens)
    .bind(usage.cost_micro_usd)
    .bind(usage.was_estimated)
    .bind(usage.effort)
    .bind(usage.source.as_str())
    .bind(web_search_requests.max(0))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// What a task has spent so far, read from the ledger (the system of record): tokens and web
/// searches over every step of the run.
pub async fn spent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<(i64, i64), DbError> {
    Ok(sqlx::query_as(
        "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint, \
                COALESCE(SUM(web_search_requests), 0)::bigint \
           FROM usage_ledger WHERE workspace_id = $1 AND run_id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?)
}

// ---------------------------------------------------------------------------
// the step job
// ---------------------------------------------------------------------------

/// The payload of the job that runs step `step`. It names the run, the agent and the room and
/// nothing a step could mistake for an instruction: no message text, no author, no trigger — the
/// requester is derived again from the run row at the start of every step (B5-6), and the model
/// is resolved again from the team's 「기본 AI」 row.
pub fn step_job_payload(
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    step: i32,
    model: &str,
    model_source: Option<&str>,
) -> Value {
    let mut payload = json!({
        // Lowercase: `retire_pending_agent_jobs_for_run_in_tx` matches `lower(payload->>'run_id')`,
        // so a human's cancel retires the pending step job together with the run.
        "run_id": run_id.to_string().to_lowercase(),
        "workspace_id": workspace_id,
        "channel_id": channel_id,
        "agent_member_id": agent_member_id,
        "model": model,
        "depth": 0,
        "delivery": "worker",
        "created_from": STEP_JOB_CREATED_FROM,
        STEP_JOB_PAYLOAD_KEY: step,
    });
    if let Some(source) = model_source {
        payload["model_source"] = json!(source);
    }
    payload
}

// ---------------------------------------------------------------------------
// what the model writes: plan and note
// ---------------------------------------------------------------------------

/// `task_continue`'s arguments after cleaning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskContinueArgs {
    /// 1..=[`TASK_PLAN_ITEMS_MAX`] lines of at most [`TASK_PLAN_ITEM_CHARS_MAX`] characters.
    pub plan: Vec<String>,
    /// 1..=[`TASK_NOTE_CHARS_MAX`] characters.
    pub note: String,
}

/// Characters that never reach the plan, the note or a progress line: controls, soft hyphen,
/// bidi marks and overrides, line and paragraph separators, the invisible operators. The same
/// family `agent_run_event`'s stage CHECK refuses, so a progress line built from the plan can
/// never fail its own insert.
fn is_invisible(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{00ad}' | '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
}

/// One line of plan: invisible characters dropped, whitespace collapsed, cut at the line limit.
fn clean_line(raw: &str, max_chars: usize) -> String {
    let words: Vec<&str> = raw
        .split(|c: char| c.is_whitespace() || is_invisible(c))
        .filter(|word| !word.is_empty())
        .collect();
    let line = words.join(" ");
    line.chars()
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The note: invisible characters dropped (line breaks kept), cut at the note limit.
fn clean_note(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| *c == '\n' || !is_invisible(*c))
        .collect();
    kept.trim()
        .chars()
        .take(TASK_NOTE_CHARS_MAX)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Read the model's `task_continue` arguments. Strictness is about *shape*, not about words: a
/// plan that is not a non-empty array of strings, or a note that is empty after cleaning, is
/// refused with a short reason the worker hands back to the model; text that is merely too long is
/// cut (the schema asks for the limits, a provider that ignores them does not fail the task).
pub fn parse_task_continue(arguments: &Value) -> Result<TaskContinueArgs, &'static str> {
    let Some(plan) = arguments.get("plan").and_then(Value::as_array) else {
        return Err("plan must be an array of short strings");
    };
    let mut lines = Vec::new();
    for item in plan {
        let Some(text) = item.as_str() else {
            return Err("plan must be an array of short strings");
        };
        let line = clean_line(text, TASK_PLAN_ITEM_CHARS_MAX);
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines.truncate(TASK_PLAN_ITEMS_MAX);
    if lines.is_empty() {
        return Err("plan must name at least one next step");
    }
    let Some(note) = arguments.get("note").and_then(Value::as_str) else {
        return Err("note must be a string");
    };
    let note = clean_note(note);
    if note.is_empty() {
        return Err("note must say what has been found so far");
    }
    Ok(TaskContinueArgs { plan: lines, note })
}

/// The progress line a step writes to the run's event ledger (ADR-0200 D2 `stage`, no new kind):
/// `조사 중 · 3／6 · 가격 비교하는 중`. `steps_done` steps are finished and `plan` is what remains,
/// so the denominator is `steps_done + plan.len()`. At most 80 characters, none of the characters
/// the ledger refuses, never empty.
///
/// The count is written with a **fullwidth solidus** (`／`, U+FF0F): the ledger's stage CHECK
/// (`work_session_share_stage_markers_ok`, migration 114) refuses an ASCII `/` and `\` anywhere in
/// a marker, so the ADR's `3/6` cannot be stored as typed. Anything that wants the numbers should
/// read them from structured fields (S5), not parse this line.
pub fn stage_label(steps_done: i32, plan: &[String]) -> String {
    let total = steps_done.max(0) as usize + plan.len();
    let head = format!("조사 중 · {}／{}", steps_done.max(0), total.max(1));
    let next: String = plan
        .first()
        .map(|line| {
            line.chars()
                .filter(|c| !matches!(c, '/' | '\\') && !is_invisible(*c))
                .collect()
        })
        .unwrap_or_default();
    let label = if next.trim().is_empty() {
        head
    } else {
        format!("{head} · {}", next.trim())
    };
    label.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(active: bool, steps_done: i32) -> TaskRow {
        TaskRow {
            active,
            end_reason: (!active).then(|| END_DONE.to_string()),
            steps_done,
            model_calls: 0,
            tool_calls: 0,
            web_searches: 0,
            plan: vec![],
            note: String::new(),
            claim_token: None,
            claim_live: false,
            elapsed_secs: 0,
        }
    }

    /// B15-A6: the verdict comes from the row. A first-turn job with no row is the fast path; with
    /// a row (the task already started — a re-claim) it is a no-op; a step job runs only when the
    /// row says it is next.
    #[test]
    fn the_row_decides_not_the_job() {
        assert_eq!(decide_step(None, 1), StepDecision::FirstTurn);
        assert_eq!(decide_step(None, 2), StepDecision::Skip(SkipReason::NoTask));
        // The first-turn job J1 re-claimed after the task started: step 1 is done.
        assert_eq!(
            decide_step(Some(&row(true, 1)), 1),
            StepDecision::Skip(SkipReason::StepDone)
        );
        assert_eq!(
            decide_step(Some(&row(true, 1)), 2),
            StepDecision::RunStep(2)
        );
        assert_eq!(
            decide_step(Some(&row(true, 2)), 2),
            StepDecision::Skip(SkipReason::StepDone)
        );
        assert_eq!(
            decide_step(Some(&row(true, 1)), 3),
            StepDecision::Skip(SkipReason::OutOfOrder)
        );
        // An ended task runs nothing, whatever the job says.
        assert_eq!(
            decide_step(Some(&row(false, 4)), 5),
            StepDecision::Skip(SkipReason::Ended)
        );
        assert_eq!(
            decide_step(Some(&row(false, 1)), 1),
            StepDecision::Skip(SkipReason::Ended)
        );
    }

    /// B5-5: each bound is `>=`, each is judged on its own.
    #[test]
    fn each_bound_is_reached_on_its_own() {
        let limits = TaskLimits {
            max_steps: 3,
            max_wall_secs: 100,
            max_model_calls: 10,
            max_tool_calls: 20,
            max_per_workspace: 3,
            max_per_requester: 1,
        };
        assert_eq!(limits.hit(2, 9, 19, 99), None);
        assert_eq!(limits.hit(3, 0, 0, 0), Some(LimitHit::Steps));
        assert_eq!(limits.hit(1, 0, 0, 100), Some(LimitHit::WallClock));
        assert_eq!(limits.hit(1, 10, 0, 0), Some(LimitHit::ModelCalls));
        assert_eq!(limits.hit(1, 0, 20, 0), Some(LimitHit::ToolCalls));
        let defaults = TaskLimits::default();
        assert_eq!(
            (
                defaults.max_steps,
                defaults.max_wall_secs,
                defaults.max_model_calls
            ),
            (20, 3600, 60)
        );
        assert_eq!(
            (
                defaults.max_tool_calls,
                defaults.max_per_workspace,
                defaults.max_per_requester
            ),
            (100, 3, 1)
        );
    }

    #[test]
    fn task_continue_arguments_are_cleaned_and_bounded() {
        let ok = parse_task_continue(&json!({
            "plan": ["  가격을   비교하기 ", "후기 \u{202e}읽기", ""],
            "note": "  경쟁사 두 곳을 찾았어요.\n\u{0007}다음은 가격이에요.  "
        }))
        .expect("valid");
        assert_eq!(ok.plan, ["가격을 비교하기", "후기 읽기"]);
        assert_eq!(ok.note, "경쟁사 두 곳을 찾았어요.\n다음은 가격이에요.");

        // Too many / too long is cut, not refused.
        let many: Vec<String> = (0..12)
            .map(|i| format!("{i}{}", "가".repeat(100)))
            .collect();
        let cut = parse_task_continue(&json!({"plan": many, "note": "가".repeat(5000)})).unwrap();
        assert_eq!(cut.plan.len(), TASK_PLAN_ITEMS_MAX);
        assert!(cut
            .plan
            .iter()
            .all(|line| line.chars().count() <= TASK_PLAN_ITEM_CHARS_MAX));
        assert_eq!(cut.note.chars().count(), TASK_NOTE_CHARS_MAX);

        // Shape errors are refused with a reason.
        for bad in [
            json!({}),
            json!({"plan": "다음", "note": "x"}),
            json!({"plan": [], "note": "x"}),
            json!({"plan": ["", "  "], "note": "x"}),
            json!({"plan": [1], "note": "x"}),
            json!({"plan": ["a"]}),
            json!({"plan": ["a"], "note": ""}),
            json!({"plan": ["a"], "note": " \u{200b} "}),
        ] {
            assert!(parse_task_continue(&bad).is_err(), "{bad}");
        }
    }

    /// The progress line can always be inserted: at most 80 characters, none the ledger's CHECK
    /// refuses, never empty.
    #[test]
    fn the_stage_label_fits_the_ledgers_check() {
        assert_eq!(
            stage_label(
                3,
                &["가격 비교하는 중".into(), "후기 읽기".into(), "정리".into()]
            ),
            "조사 중 · 3／6 · 가격 비교하는 중"
        );
        assert_eq!(stage_label(2, &[]), "조사 중 · 2／2");
        let nasty = stage_label(1, &["a/b\\c\u{202e}\u{0000}가".repeat(40)]);
        assert!(nasty.chars().count() <= 80);
        assert!(!nasty.contains('/') && !nasty.contains('\\'));
        assert!(!nasty.chars().any(is_invisible));
        assert!(!nasty.is_empty());
    }

    /// A step job carries ids and the step number, and a lowercase run id (the cancel's retire
    /// statement matches `lower(payload->>'run_id')`) — and no text a model could read as an order.
    #[test]
    fn the_step_job_payload_names_ids_only() {
        let run = Uuid::from_u128(0xABCDEF);
        let payload = step_job_payload(
            Uuid::from_u128(1),
            run,
            Uuid::from_u128(3),
            Uuid::from_u128(4),
            5,
            "team-ai-default",
            Some("instance_default"),
        );
        assert_eq!(payload["run_id"], run.to_string().to_lowercase());
        assert_eq!(payload[STEP_JOB_PAYLOAD_KEY], 5);
        assert_eq!(payload["created_from"], STEP_JOB_CREATED_FROM);
        assert_eq!(payload["model_source"], "instance_default");
        for absent in [
            "prompt",
            "recent_messages",
            "trigger_message_id",
            "author_member_id",
        ] {
            assert!(
                payload.get(absent).is_none(),
                "{absent} must not ride a step job"
            );
        }
    }

    #[test]
    fn skip_reasons_have_distinct_stable_words() {
        let all = [
            SkipReason::Ended,
            SkipReason::StepDone,
            SkipReason::OutOfOrder,
            SkipReason::NoTask,
        ];
        let words: std::collections::BTreeSet<_> = all.iter().map(|r| r.as_str()).collect();
        assert_eq!(words.len(), all.len());
    }

    #[test]
    fn the_end_reasons_fit_the_column() {
        for reason in [
            END_DONE,
            END_LIMIT,
            END_CANCELLED,
            END_REQUESTER_GONE,
            END_PROVIDER_ERROR,
            END_ROLE_OFF,
            END_RUN_ENDED,
            END_FAILED,
        ] {
            assert!((1..=48).contains(&reason.chars().count()), "{reason}");
        }
    }
}
