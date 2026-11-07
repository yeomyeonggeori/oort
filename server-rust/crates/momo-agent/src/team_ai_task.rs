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
//! ## What a task reports (#4968, ADR-0201 증보 v3.3)
//!
//! Every step also says what it did, in the vocabulary of the run event ledger and through the very
//! writer a hosted agent's `oort_run_event` call reaches ([`record_progress_in_tx`], which ends in
//! [`crate::run_activity::record_run_activity_in_tx`]): a progress line ([`stage_label`], judged by
//! the shared short-text rule), the activities of the step ([`StepCounts`], counted by the server
//! from the calls it ran, no label) and the plan that remains ([`progress_report`]). The run's spend
//! is one grouped read of its own ledger rows ([`spent_by_run_in_tx`], [`RunSpent`]) — one run, never
//! a person. What a task keeps for itself, its note, has no way into any of it.
//!
//! ## What this module does not decide
//!
//! The model loop, the replies and the sentences live in `momo_agent_worker::team_ai` and
//! `momo_workspace_actions::team_ai`. This module is the data and the rules that must hold in the
//! same place for the api (`live_run_count_in_tx` excludes a task run from the concurrency count;
//! `cancel_run_in_tx` ends the task) and the worker (claims, commits, ends).

use std::collections::HashMap;

use momo_db::DbError;
use momo_wire::report_text::{checked_report_text, is_unsafe_char};
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::run::RunStatus;
use crate::run_activity::{
    record_run_activity_in_tx, ActivityReport, RawActivity, RawPlanItem, ReportFault,
    MAX_ACTIVITY_N, MAX_PLAN_ITEMS, MAX_PLAN_TEXT_CHARS,
};
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
/// The job ran out of attempts (the worker's own retry budget) and the run failed for good — the
/// last attempt failed, or a step job spent its whole budget unable to run its step (#5029).
pub const END_FAILED: &str = "task_failed";
/// The helper itself can no longer act in the run's room (it left, or was deactivated), so the run
/// cannot be called and the task ends with it (#5029): no row, slot or note outlives that.
pub const END_AGENT_GONE: &str = "task_agent_gone";

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
    /// ADR-0201 증보 v4 P4 (#5370): the delegation marker — `Some` on a row that is a delegation step,
    /// `None` on an ordinary task. **Never the request sentence**: that column is read by the one function
    /// that sends it ([`delegation_request_in_tx`]) and by nothing else (the api's role cannot select it).
    pub delegation: Option<DelegationMark>,
}

/// The delegation marker of a [`TaskRow`] (migration 177).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationMark {
    /// `web_search` or `image` ([`DELEGATION_KINDS`]).
    pub kind: String,
    pub state: DelegationState,
    /// The Hermes member the call went to — set by the very statement that writes `called`.
    pub target: Option<Uuid>,
}

/// `team_ai_task.delegation_state` (migration 177). `pending` → `called` → `done` | `failed`. **`called`
/// is written before Hermes is called**, so a worker that finds it knows a call may be in flight or may
/// have happened, and never calls again (I5, at-most-once).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegationState {
    Pending,
    Called,
    Done,
    Failed,
}

impl DelegationState {
    pub fn as_str(self) -> &'static str {
        match self {
            DelegationState::Pending => "pending",
            DelegationState::Called => "called",
            DelegationState::Done => "done",
            DelegationState::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Option<DelegationState> {
        [
            DelegationState::Pending,
            DelegationState::Called,
            DelegationState::Done,
            DelegationState::Failed,
        ]
        .into_iter()
        .find(|state| state.as_str() == raw)
    }
}

/// The closed kinds of `team_ai_task.delegation_kind`.
pub const DELEGATION_KINDS: [&str; 2] = ["web_search", "image"];

const ROW_COLS: &str = "state, end_reason, steps_done, model_calls, tool_calls, web_searches, plan, note, \
     claim_token, COALESCE(claim_until > clock_timestamp(), false) AS claim_live, \
     GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at))))::bigint AS elapsed_secs, \
     delegation_kind, delegation_state, delegation_target";

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
    let delegation_kind: Option<String> = row.try_get("delegation_kind")?;
    let delegation_state: Option<String> = row.try_get("delegation_state")?;
    let delegation = match (delegation_kind, delegation_state.as_deref()) {
        (Some(kind), Some(raw)) => DelegationState::parse(raw).map(|state| DelegationMark {
            kind,
            state,
            target: row.try_get("delegation_target").ok().flatten(),
        }),
        _ => None,
    };
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
        delegation,
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

/// How many tasks are **running** — in the workspace, and for `requester_member_id` — leaving out
/// `except_run` (the run that is about to start one: it has no row yet, and a re-run of its first turn
/// must not count itself). A task is *running* while its row is active and its run has not ended for
/// good; the requester of a running task is the author of its run's trigger message. **The one
/// definition of "running"**: [`create_in_tx`] counts with it under the workspace lock, and the helper's
/// delegation door (ADR-0201 증보 v4 G6, #5369) reads it without the lock for its advertisement-time
/// estimate — a delegation is a task (B5-5), so the bounds are the same two numbers.
pub async fn running_counts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    requester_member_id: Uuid,
    except_run: Option<Uuid>,
) -> Result<(i64, i64), DbError> {
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT count(*)::bigint, \
                count(*) FILTER (WHERE m.author_member_id = $3)::bigint \
           FROM team_ai_task t \
           JOIN agent_run r ON r.workspace_id = t.workspace_id AND r.id = t.run_id \
           LEFT JOIN message m ON m.workspace_id = r.workspace_id AND m.id = r.trigger_message_id \
          WHERE t.workspace_id = $1 AND t.state = 'active' \
            AND ($2::uuid IS NULL OR t.run_id <> $2) \
            AND r.status NOT IN ('succeeded', 'cancelled', 'timed_out')",
    )
    .bind(workspace_id)
    .bind(except_run)
    .bind(requester_member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(counts)
}

/// Take the per-workspace task lock for the rest of the transaction. **The one lock** every count that
/// bounds tasks or delegations is judged under: [`create_in_tx`] starts a task under it, and the
/// delegation's `called` commit (ADR-0201 증보 v4 P4-5, P7) re-judges the day's, the requester's and the
/// concurrent limits under it — so two delegations that start at the same moment cannot both pass the
/// last free slot (the overshoot is zero because the second sees the first's `called`).
pub async fn lock_workspace_tasks_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4967))")
        .bind(format!("team_ai_task:{workspace_id}"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// What a delegation row starts with (ADR-0201 증보 v4 P4-4): the kind and the one request sentence.
/// The sentence is kept in this row and nowhere else, and is gone once the row ends (migration 177).
#[derive(Clone, Copy)]
pub struct NewDelegation<'a> {
    /// One of [`DELEGATION_KINDS`].
    pub kind: &'a str,
    /// The cleaned request sentence (2~1,200 characters).
    pub request: &'a str,
}

impl std::fmt::Debug for NewDelegation<'_> {
    /// Prints the kind and a length — a stray `{:?}` must not be where the sentence reaches a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "NewDelegation {{ kind: {:?}, request: <{} chars> }}",
            self.kind,
            self.request.chars().count()
        )
    }
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
    create_with_delegation_in_tx(conn, new, requester_member_id, limits, None).await
}

/// [`create_in_tx`], and — for the helper's delegation to Hermes — the same row with its marker
/// (`pending`) and the request sentence. A delegation **is** a task (B5-5): the same lock, the same two
/// counts, the same row.
pub async fn create_with_delegation_in_tx(
    conn: &mut PgConnection,
    new: &NewTask<'_>,
    requester_member_id: Uuid,
    limits: &TaskLimits,
    delegation: Option<&NewDelegation<'_>>,
) -> Result<CreateOutcome, DbError> {
    lock_workspace_tasks_in_tx(conn, new.workspace_id).await?;
    let exists: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM team_ai_task WHERE workspace_id = $1 AND run_id = $2")
            .bind(new.workspace_id)
            .bind(new.run_id)
            .fetch_optional(&mut *conn)
            .await?;
    if exists.is_some() {
        return Ok(CreateOutcome::AlreadyExists);
    }
    let (in_workspace, by_requester) = running_counts_in_tx(
        conn,
        new.workspace_id,
        requester_member_id,
        Some(new.run_id),
    )
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
            plan, note, delegation_kind, delegation_state, delegation_request) \
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, \
                 $9::text, CASE WHEN $9::text IS NULL THEN NULL ELSE 'pending' END, $10::text) \
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
    .bind(delegation.map(|d| d.kind))
    .bind(delegation.map(|d| d.request))
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

/// End the task of a run with `reason`, dropping the plan, the note, the claim **and the delegation's
/// request sentence** (`team_ai_task_ended_ck` refuses an ended row that still holds any of them).
/// Idempotent: an already-ended or missing row is not touched, and `false` says so. Called by every path
/// that ends the run (the worker's final reply, the cancel route), in the same transaction.
///
/// **A delegation that was called and is not settled gets its ledger row here** (ADR-0201 증보 v4 P4-8,
/// A8·A13): the marker moves `called` → `failed` and one estimated Hermes row is written in the same
/// transaction, whoever ends the row — the api's cancel route (which never knew about Hermes), the
/// worker's attempt-exhaustion path, `requester_gone`, `agent_gone`. A worker that settles first (the
/// normal answer, a timeout) has already moved the marker, so this finds nothing to settle: the row is
/// written exactly once because the one that moves the marker is the one that writes it.
pub async fn end_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    reason: &str,
) -> Result<bool, DbError> {
    // The row lock makes "who moves the marker" a single answer when two enders meet.
    let unsettled: Option<(Option<String>, Option<Uuid>)> = sqlx::query_as(
        "SELECT delegation_state, delegation_target FROM team_ai_task \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active' FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    let ended = sqlx::query(
        "UPDATE team_ai_task \
            SET state = 'ended', end_reason = $3, plan = NULL, note = NULL, delegation_request = NULL, \
                delegation_state = CASE WHEN delegation_state = 'called' THEN 'failed' ELSE delegation_state END, \
                claim_token = NULL, claim_until = NULL, ended_at = now(), updated_at = now() \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active'",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    if let Some((Some(state), Some(target))) = unsettled {
        if state == DelegationState::Called.as_str() {
            record_hermes_usage_in_tx(
                conn,
                workspace_id,
                run_id,
                target,
                &HermesUsageRow::unknown(HERMES_LEDGER_MODEL),
            )
            .await?;
        }
    }
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
/// task there with [`END_RUN_ENDED`] (a delegation that was called gets its estimated ledger row, as in
/// [`end_in_tx`]). Returns how many rows it closed.
pub async fn end_orphan_tasks_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<u64, DbError> {
    let unsettled: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT t.run_id, t.delegation_target \
           FROM team_ai_task t \
           JOIN agent_run r ON r.workspace_id = t.workspace_id AND r.id = t.run_id \
          WHERE t.workspace_id = $1 AND t.state = 'active' \
            AND t.delegation_state = 'called' AND t.delegation_target IS NOT NULL \
            AND r.status IN ('succeeded', 'failed', 'cancelled', 'timed_out') \
            AND t.updated_at < now() - make_interval(secs => $2) \
            FOR UPDATE OF t",
    )
    .bind(workspace_id)
    .bind(ORPHAN_GRACE_SECS as f64)
    .fetch_all(&mut *conn)
    .await?;
    let ended = sqlx::query(
        "UPDATE team_ai_task t \
            SET state = 'ended', end_reason = $2, plan = NULL, note = NULL, delegation_request = NULL, \
                delegation_state = CASE WHEN t.delegation_state = 'called' THEN 'failed' ELSE t.delegation_state END, \
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
    for (run_id, target) in unsettled {
        record_hermes_usage_in_tx(
            conn,
            workspace_id,
            run_id,
            target,
            &HermesUsageRow::unknown(HERMES_LEDGER_MODEL),
        )
        .await?;
    }
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

/// What one run has spent, read from the ledger (the system of record): the sums of that run's
/// `usage_ledger` rows, one row per step. The read side of ADR-0201 증보 v3 B12 ("그 run 한 건의
/// 토큰·검색 횟수") and the only figure of spend a run read carries.
///
/// **One run, never a person.** The ledger has no requester column and this struct has no field a
/// requester could be read from (ADR-0147 증보 2026-10-30 D6: 「누가 팀 AI를 많이 불렀나」는 계산하지도
/// 표시하지도 않는다). The sums are grouped by run id and by nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunSpent {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    /// The provider's own web searches (`usage_ledger.web_search_requests`).
    pub web_searches: i64,
    /// Some of the tokens are oort's estimate because the provider reported none (ADR-0147 D3).
    pub estimated: bool,
    /// ADR-0201 증보 v4 P7 (#5370): how many times the helper handed work to Hermes in this run (0 or 1:
    /// a request delegates once). **The helper's own rows are the only ones summed above** — Hermes's row
    /// is a subscription, not the team's credits, and lives under Hermes's own agent id (`usage/agents`).
    pub delegations: i64,
}

/// The spend of every task-mode run among `run_ids`, keyed by run id. A run that is **not** a task
/// (no `team_ai_task` row) has no entry — which also is what keeps another agent's tokens out of a
/// run read: only the team AI's task runs carry the row, and the team AI is a shared agent whose
/// spend every member may read (ADR-0147 D1, B12). An ended task keeps its row, so the end line can
/// read the same figure.
pub async fn spent_by_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_ids: &[Uuid],
) -> Result<HashMap<Uuid, RunSpent>, DbError> {
    if run_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT t.run_id, \
                COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt_tokens, \
                COALESCE(SUM(u.completion_tokens), 0)::bigint AS completion_tokens, \
                COALESCE(SUM(u.web_search_requests), 0)::bigint AS web_searches, \
                COALESCE(bool_or(u.was_estimated), false) AS estimated, \
                (t.delegation_called_at IS NOT NULL)::int::bigint AS delegations \
           FROM team_ai_task t \
           LEFT JOIN usage_ledger u \
                  ON u.workspace_id = t.workspace_id AND u.run_id = t.run_id \
                 AND u.agent_member_id = t.agent_member_id \
          WHERE t.workspace_id = $1 AND t.run_id = ANY($2) \
          GROUP BY t.run_id, t.delegation_called_at",
    )
    .bind(workspace_id)
    .bind(run_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut spent = HashMap::with_capacity(rows.len());
    for row in &rows {
        spent.insert(
            row.try_get::<Uuid, _>("run_id")?,
            RunSpent {
                prompt_tokens: row.try_get("prompt_tokens")?,
                completion_tokens: row.try_get("completion_tokens")?,
                web_searches: row.try_get("web_searches")?,
                estimated: row.try_get("estimated")?,
                delegations: row.try_get("delegations")?,
            },
        );
    }
    Ok(spent)
}

// ---------------------------------------------------------------------------
// the delegation (ADR-0201 증보 v4 P4·P7, #5370)
// ---------------------------------------------------------------------------

/// The key of the helper's answer message that says which delegation it carries (ADR-0201 증보 v4 P8):
/// `team_ai_delegated: [{kind, agent_member_id}]`. **Server-owned**: written only by the worker from a
/// delegation it ran, stripped from every person's and webhook's props (`is_server_owned_props_key`).
pub const DELEGATED_PROPS_KEY: &str = "team_ai_delegated";

/// The model label of the estimated ledger row a path writes when it does not know what Hermes
/// reported (a cancel, a crash, a timeout). A closed word: it names nothing the operator chose.
pub const HERMES_LEDGER_MODEL: &str = "hermes";

/// What the three delegation limits are judged by (P7): rows whose marker is `called` or later, read
/// from the task row itself — a delegation in flight is counted, which the ledger (written when a
/// delegation ends) could not do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DelegationCounts {
    /// Delegations called today (UTC day of `delegation_called_at`), in this workspace.
    pub today: i64,
    /// Delegations this requester called in the last `window_secs`. The requester is the author of the
    /// run's trigger message — the same predicate [`running_counts_in_tx`] uses. **Only delegations**:
    /// the helper's other runs are not counted (a person asking the helper ten ordinary questions is
    /// not ten delegations).
    pub requester_recent: i64,
    /// Delegations running now: called, the row still active and its claim alive (a worker is on it).
    pub in_flight: i64,
}

/// Read [`DelegationCounts`]. A read — the caller that **decides** under it holds
/// [`lock_workspace_tasks_in_tx`] first.
pub async fn delegation_counts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    requester_member_id: Uuid,
    window_secs: i64,
) -> Result<DelegationCounts, DbError> {
    let (today, requester_recent, in_flight): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
           count(*) FILTER (WHERE t.delegation_called_at >= \
                  (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::bigint, \
           count(*) FILTER (WHERE m.author_member_id = $2 \
                  AND t.delegation_called_at > now() - make_interval(secs => $3))::bigint, \
           count(*) FILTER (WHERE t.state = 'active' AND t.delegation_state = 'called' \
                  AND t.claim_until > clock_timestamp())::bigint \
           FROM team_ai_task t \
           LEFT JOIN agent_run r ON r.workspace_id = t.workspace_id AND r.id = t.run_id \
           LEFT JOIN message m ON m.workspace_id = r.workspace_id AND m.id = r.trigger_message_id \
          WHERE t.workspace_id = $1 AND t.delegation_called_at IS NOT NULL",
    )
    .bind(workspace_id)
    .bind(requester_member_id)
    .bind(window_secs as f64)
    .fetch_one(&mut *conn)
    .await?;
    Ok(DelegationCounts {
        today,
        requester_recent,
        in_flight,
    })
}

/// **The at-most-once commit** (I5): `pending` → `called`, written *before* Hermes is called, for the
/// holder of the step's claim only. In the same statement the claim is extended to `extend_secs` from now
/// (the worst time of the call and the merging — the default step claim is shorter than that, F18) and the
/// Hermes member the call goes to is recorded. Returns the request sentence **iff this call made the
/// transition** — it is read here and nowhere else: a second claim, a re-run, a lost race finds the
/// marker no longer `pending` and gets `None`, so it has no sentence to send and no right to send one.
pub async fn mark_called_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    token: Uuid,
    target: Uuid,
    extend_secs: i64,
) -> Result<Option<String>, DbError> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "UPDATE team_ai_task \
            SET delegation_state = 'called', delegation_called_at = clock_timestamp(), \
                delegation_target = $4, \
                claim_until = clock_timestamp() + make_interval(secs => $5), updated_at = now() \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active' \
            AND delegation_state = 'pending' AND claim_token = $3 \
      RETURNING delegation_request",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(token)
    .bind(target)
    .bind(extend_secs as f64)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.and_then(|(request,)| request))
}

/// What [`commit_called_in_tx`] decided.
#[derive(Debug, PartialEq, Eq)]
pub enum CalledCommit<R> {
    /// This call made the transition and owns the request: the sentence, to be sent once.
    Go(String),
    /// The caller's judgement refused, under the lock. Nothing was written.
    Refused(R),
    /// The marker was not `pending` for this claim any more (another claim made or holds the call, the row
    /// ended, the claim was taken over). Nothing was written; there is no sentence to send.
    Lost,
}

/// **The `called` commit** (ADR-0201 증보 v4 P4-5, P7): under the workspace lock, count the delegations,
/// let `judge` refuse, and — only if it did not — write `called` and stretch the claim. Counting, judging
/// and writing are one critical section, which is what makes the overshoot zero: two delegations that reach
/// the last free slot together are serialised on [`lock_workspace_tasks_in_tx`], and the second one counts
/// the first one's `called` (the count reads the marker, so a delegation in flight is in it).
///
/// `judge` is the caller's rule (the limits live in `momo-workspace-actions`, which depends on this crate):
/// it sees the counts as they are under the lock and returns why the door is shut, or `None`.
#[allow(clippy::too_many_arguments)]
pub async fn commit_called_in_tx<R>(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    token: Uuid,
    requester_member_id: Uuid,
    target: Uuid,
    extend_secs: i64,
    window_secs: i64,
    judge: impl FnOnce(&DelegationCounts) -> Option<R>,
) -> Result<CalledCommit<R>, DbError> {
    lock_workspace_tasks_in_tx(conn, workspace_id).await?;
    let counts =
        delegation_counts_in_tx(conn, workspace_id, requester_member_id, window_secs).await?;
    if let Some(refusal) = judge(&counts) {
        return Ok(CalledCommit::Refused(refusal));
    }
    Ok(
        match mark_called_in_tx(conn, workspace_id, run_id, token, target, extend_secs).await? {
            Some(request) if !request.trim().is_empty() => CalledCommit::Go(request),
            _ => CalledCommit::Lost,
        },
    )
}

/// How long the claim on a step still has to live, in seconds (`None` when there is no active claim).
/// A second claimant that meets a live claim on a `called` delegation waits exactly this long — and no
/// longer: the wait ends where the lease ends, not after a fixed number of attempts (the review's Low).
pub async fn claim_remaining_secs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Option<i64>, DbError> {
    let remaining: Option<Option<f64>> = sqlx::query_scalar(
        "SELECT extract(epoch FROM (claim_until - clock_timestamp()))::float8 \
           FROM team_ai_task \
          WHERE workspace_id = $1 AND run_id = $2 AND state = 'active' AND claim_until IS NOT NULL",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(remaining
        .flatten()
        .filter(|secs| *secs > 0.0)
        .map(|secs| secs.ceil() as i64))
}

/// One Hermes ledger row (P7): the target's id, the label Hermes is known by, the tokens Hermes reported
/// or an estimate — **never** a price (a subscription has none; the row counts as unpriced).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HermesUsageRow<'a> {
    pub model: &'a str,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    /// Hermes reported no usage: the tokens are oort's estimate (ADR-0147 D3).
    pub was_estimated: bool,
}

impl<'a> HermesUsageRow<'a> {
    /// What a path that never saw Hermes's answer writes: a call happened, its size is not known.
    pub fn unknown(model: &'a str) -> HermesUsageRow<'a> {
        HermesUsageRow {
            model,
            prompt_tokens: 0,
            completion_tokens: 0,
            was_estimated: true,
        }
    }
}

/// Write the delegation's ledger row against the Hermes member — **at most once per run and member**
/// (`NOT EXISTS`, under the caller's row lock). `source` is `self_reported`: the numbers are Hermes's own
/// (or an estimate), not oort's measurement. Returns whether this call wrote the row.
pub async fn record_hermes_usage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    hermes_member_id: Uuid,
    usage: &HermesUsageRow<'_>,
) -> Result<bool, DbError> {
    let inserted = sqlx::query(
        "INSERT INTO usage_ledger \
           (workspace_id, run_id, agent_member_id, channel_id, model, \
            prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, \
            cost_micro_usd, was_estimated, effort, source, web_search_requests) \
         SELECT $1, $2, $3, (SELECT channel_id FROM agent_run WHERE workspace_id = $1 AND id = $2), \
                $4, $5, $6, 0, 0, 0, $7, NULL, 'self_reported', 0 \
          WHERE NOT EXISTS (SELECT 1 FROM usage_ledger \
                             WHERE workspace_id = $1 AND run_id = $2 AND agent_member_id = $3)",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(hermes_member_id)
    .bind(usage.model)
    .bind(usage.prompt_tokens.max(0))
    .bind(usage.completion_tokens.max(0))
    .bind(usage.was_estimated)
    .execute(&mut *conn)
    .await?;
    Ok(inserted.rows_affected() > 0)
}

/// Settle a called delegation: the marker moves `called` → `to` (`done` or `failed`) **and** the Hermes
/// ledger row is written, in the caller's transaction. The marker move is the compare-and-swap that makes
/// "exactly one row" true: the caller that moves it writes the row; a caller that finds the marker already
/// moved (a cancel that ended the row first, a second worker) writes nothing. Returns whether this call
/// settled it.
pub async fn settle_delegation_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    to: DelegationState,
    usage: &HermesUsageRow<'_>,
) -> Result<bool, DbError> {
    debug_assert!(matches!(
        to,
        DelegationState::Done | DelegationState::Failed
    ));
    let moved: Option<(Option<Uuid>,)> = sqlx::query_as(
        "UPDATE team_ai_task SET delegation_state = $3, updated_at = now() \
          WHERE workspace_id = $1 AND run_id = $2 AND delegation_state = 'called' \
      RETURNING delegation_target",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(to.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    let Some((Some(target),)) = moved else {
        return Ok(false);
    };
    record_hermes_usage_in_tx(conn, workspace_id, run_id, target, usage).await?;
    Ok(true)
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

/// Characters that never reach the plan, the note or a progress line. **This is not a list of its
/// own**: it is the predicate of the one short-text rule an agent's words pass through
/// (`momo_wire::report_text::is_unsafe_char` — controls, soft hyphen, bidi marks and overrides, line
/// and paragraph separators, the invisible operators, the default-ignorable fillers, variation
/// selectors, tag characters). A private, narrower list used to stand here, so a plan line with a
/// Hangul filler or an emoji variation selector became a progress line the rule itself refuses
/// (#4968).
///
/// `pub` since #5369: the helper's delegation to Hermes (ADR-0201 증보 v4 P1) cleans the one sentence it
/// writes and folds names for its identity filter by **this** predicate — "v3.1·v3.3이 쓰는 같은 규칙" —
/// so a fourth private copy of the list cannot drift from the third.
pub fn is_invisible(c: char) -> bool {
    is_unsafe_char(c)
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

/// The limit of a progress line, in characters: the Agent Port stage marker's own
/// (`momo_t3::work_share::MAX_STAGE_MARKER_CHARS`). This crate cannot depend on `momo-t3` (a boundary
/// test in momo-server pins that), so a test in the worker pins the two numbers together.
pub const STAGE_LABEL_CHARS_MAX: usize = 80;

/// One line of the model's own words, made to fit the short-text rule people read it under — the
/// progress line's `next` part and the visible plan's steps. `/` and `\` become a space (a short name
/// is not a path), everything [`is_invisible`] names goes, whitespace collapses, and the line is cut
/// at `max_chars`. The result is empty or **a text `momo_wire::report_text::checked_report_text`
/// accepts for `max_chars`**: that is the contract, and the unit tests measure it with that very
/// function rather than with a rule of this module's own.
pub fn display_line(raw: &str, max_chars: usize) -> String {
    let spaced: String = raw
        .chars()
        .map(|c| if matches!(c, '/' | '\\') { ' ' } else { c })
        .collect();
    clean_line(&spaced, max_chars)
}

/// The lines of the **visible plan**: what is left of the task's remaining plan lines once they are
/// made readable ([`display_line`]) — a line that says nothing then (a bare `/`) is left out. This is
/// the one place the progress line's denominator and the visible plan ([`progress_report`]) both take
/// their lines from, so a reader's `stepCount + plan.len()` is always the line's `m`.
fn visible_plan_lines(plan: &[String]) -> Vec<String> {
    plan.iter()
        .map(|line| display_line(line, MAX_PLAN_TEXT_CHARS))
        .filter(|line| !line.is_empty())
        .take(MAX_PLAN_ITEMS)
        .collect()
}

/// The progress line a step writes to the run's event ledger (ADR-0200 D2 `stage`, no new kind):
/// `조사 중 · 3／6 · 가격 비교하는 중`. `steps_done` steps are finished and the plan is what remains,
/// so the denominator is `steps_done` plus the length of the **visible** plan
/// ([`visible_plan_lines`], the same lines [`progress_report`] writes), and the line names the first
/// of them — the step the visible plan marks `in_progress`.
///
/// **Judged by the rule a stage marker passes through**: the finished line goes through
/// `checked_report_text(…, 80)` — the function the Agent Port's `oort_run_event.stage` is judged by
/// (ADR-0200 증보 7 7-3) — and a line it refuses falls back to the head (`조사 중 · 3／6`), which it
/// always accepts. So the line is at most 80 characters, free of every character the rule names,
/// never empty, and a plan line the model made odd can neither fail the ledger's CHECK nor stop the
/// step. The note and the trigger text have no way in: only the plan's first line does.
///
/// The count is written with a **fullwidth solidus** (`／`, U+FF0F): the rule and the ledger's stage
/// CHECK (`work_session_share_stage_markers_ok`, migration 114) refuse an ASCII `/` and `\` anywhere
/// in a marker, so the ADR's `3/6` cannot be stored as typed. Anything that wants the numbers reads
/// them from the run read (`stepCount`, and the visible plan's length: ADR-0201 증보 v3.3), not from
/// this line.
pub fn stage_label(steps_done: i32, plan: &[String]) -> String {
    let lines = visible_plan_lines(plan);
    let total = steps_done.max(0) as usize + lines.len();
    let head = format!("조사 중 · {}／{}", steps_done.max(0), total.max(1));
    let candidate = match lines.first() {
        Some(next) => format!("{head} · {next}"),
        None => head.clone(),
    };
    judged_label(&candidate, &head)
}

/// The progress line's last gate, apart from [`stage_label`] so it can be tested on lines the
/// cleaning never makes: the candidate is cut at the limit and judged by
/// `checked_report_text` — the stage marker's own rule — and a candidate it refuses is replaced by
/// `head`, which it always accepts.
fn judged_label(candidate: &str, head: &str) -> String {
    let cut: String = candidate.chars().take(STAGE_LABEL_CHARS_MAX).collect();
    checked_report_text(&cut, STAGE_LABEL_CHARS_MAX).unwrap_or_else(|_| head.to_string())
}

// ---------------------------------------------------------------------------
// what a step reports: activities and the visible plan (ADR-0200 증보 7, #4968)
// ---------------------------------------------------------------------------

/// What one step did, in the kinds of the activity vocabulary (ADR-0200 증보 7 7-1). Counts of calls
/// the server itself made on the helper's behalf, never the model's words.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StepCounts {
    /// Reads of the workspace (every read tool but the message search; an attachment read too).
    pub reads: i32,
    /// The message search.
    pub searches: i32,
    /// The provider's own web searches.
    pub web: i32,
}

impl StepCounts {
    pub fn is_empty(&self) -> bool {
        self.reads <= 0 && self.searches <= 0 && self.web <= 0
    }
}

/// What [`record_progress_in_tx`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressWrite {
    /// Ledger rows written (0 when the report repeated what the ledger already held — the writer's
    /// own fold — or the run is not this agent's).
    Written(i32),
    /// The shared rule refused the report. Every text in it is the server's own or the model's plan
    /// line after [`display_line`], so this is a bug of this module, never the model's doing: the
    /// caller **logs it and goes on** (a progress decoration must not stop a step), and a test that
    /// feeds the worst plan lines fails when it happens.
    Refused(ReportFault),
}

/// The activity id of one kind in one step: `s2_read`. A number-name with no content, so a channel
/// member who reads it learns nothing the kind does not say.
fn step_activity_id(step: i32, kind: &str) -> String {
    format!("s{}_{kind}", step.max(0))
}

/// The report of one step: its activities (`completed`, no label — the kind names the work and
/// there is nothing to leak) and, when `plan` is given, the visible plan: the lines that remain,
/// the first `in_progress` and the rest `pending`. The plan is replaced whole (`Some(&[])` clears
/// it); `None` leaves it as it is.
///
/// The visible plan is **what remains**, because that is all the task row keeps (B5-2); the steps
/// already done are `agent_run.step_count`, so a reader's "n of m" is `step_count` of
/// `step_count + plan.len()` — the very numbers of [`stage_label`], which takes its lines from the
/// same [`visible_plan_lines`]. Pure, so the shared rule's
/// verdict on the worst plan lines is testable without a database.
pub fn progress_report(
    step: i32,
    counts: StepCounts,
    plan: Option<&[String]>,
) -> Result<ActivityReport, ReportFault> {
    let mut activities: Vec<RawActivity> = Vec::new();
    for (kind, n) in [
        ("read", counts.reads),
        ("search", counts.searches),
        ("web", counts.web),
    ] {
        if n > 0 {
            activities.push(RawActivity {
                id: step_activity_id(step, kind),
                kind: kind.to_string(),
                label: None,
                status: "completed".to_string(),
                n: Some(i64::from(n).min(MAX_ACTIVITY_N)),
            });
        }
    }
    let visible: Option<Vec<RawPlanItem>> = plan.map(|lines| {
        visible_plan_lines(lines)
            .into_iter()
            .enumerate()
            .map(|(index, text)| RawPlanItem {
                text,
                status: if index == 0 { "in_progress" } else { "pending" }.to_string(),
            })
            .collect()
    });
    ActivityReport::validate(
        (!activities.is_empty()).then_some(activities.as_slice()),
        visible.as_deref(),
    )
}

/// Write one step's report to the run's event ledger through **the** writer
/// ([`record_run_activity_in_tx`], the very function the Agent Port tool path calls — the same
/// validation, fold, roll and total; ADR-0201 B5-7, ADR-0200 증보 7 7-10), inside the caller's
/// transaction: a step's progress is written, or lost with the step, together with its commit.
///
/// The caller is the worker, connected as `momo_worker`. That role holds the verbs the writer needs
/// (UPDATE on `agent_run` for the run-row lock, INSERT/DELETE on `agent_run_event`, the sequence,
/// and the total table): a worker test runs this through that role and fails if one is missing.
/// `agent_member_id` must be the run's own agent — the writer refuses (writes 0) for anyone else.
pub async fn record_progress_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    step: i32,
    counts: StepCounts,
    plan: Option<&[String]>,
) -> Result<ProgressWrite, DbError> {
    if counts.is_empty() && plan.is_none() {
        return Ok(ProgressWrite::Written(0));
    }
    match progress_report(step, counts, plan) {
        Ok(report) => Ok(ProgressWrite::Written(
            record_run_activity_in_tx(conn, workspace_id, run_id, agent_member_id, &report).await?,
        )),
        Err(fault) => Ok(ProgressWrite::Refused(fault)),
    }
}

// ---------------------------------------------------------------------------
// what a delegation reports (ADR-0201 증보 v4 P8, #5370)
// ---------------------------------------------------------------------------

/// The closed word for a delegation kind in the progress line.
fn delegation_kind_word(kind: &str) -> &'static str {
    match kind {
        "image" => "그림",
        _ => "검색",
    }
}

/// The progress line of a delegation (P8, D5-4): `위임: Hermes · 검색` while the helper waits for Hermes
/// and `위임 결과 수신: Hermes` once the answer is in. **Assembled by the server from closed words and the
/// target's current display name** — the request sentence and Hermes's answer have no way into it. The
/// name is made to fit the short-text rule people read it under ([`display_line`]); the finished line is
/// judged by the stage marker's own rule ([`judged_label`]) and falls back to a head that always passes.
pub fn delegation_stage_label(target_display_name: &str, kind: &str, received: bool) -> String {
    let name = display_line(target_display_name, 30);
    let name = if name.is_empty() {
        "Hermes".to_string()
    } else {
        name
    };
    if received {
        judged_label(&format!("위임 결과 수신: {name}"), "위임 결과 수신")
    } else {
        judged_label(
            &format!("위임: {name} · {}", delegation_kind_word(kind)),
            "위임 중",
        )
    }
}

/// Write the delegation's one activity (`kind: "delegate"`, no label — the kind names the work, ADR-0200
/// 증보 7 7-1) through **the** run-activity writer, in the caller's transaction. `status` is
/// `in_progress` while Hermes is on it, `completed` or `failed` after: a change of status is a new row
/// of the ledger, a repeat is folded (the writer's own rule). A refusal by the shared rule is returned
/// for the caller to log — a progress decoration must not stop a delegation.
pub async fn record_delegate_activity_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    step: i32,
    status: &str,
) -> Result<ProgressWrite, DbError> {
    let activity = RawActivity {
        id: step_activity_id(step, "delegate"),
        kind: "delegate".to_string(),
        label: None,
        status: status.to_string(),
        n: None,
    };
    match ActivityReport::validate(Some(&[activity]), None) {
        Ok(report) => Ok(ProgressWrite::Written(
            record_run_activity_in_tx(conn, workspace_id, run_id, agent_member_id, &report).await?,
        )),
        Err(fault) => Ok(ProgressWrite::Refused(fault)),
    }
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
            delegation: None,
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

    /// #4968 (acceptance 1): a progress line is judged by the rule an Agent Port stage marker passes
    /// through, and that is how it is **measured** here — with `checked_report_text` itself, not with a
    /// predicate of this module's own (the narrower private list this test used to ask is exactly
    /// what let a Hangul filler through). Worst lines a model can write, every step number.
    #[test]
    fn the_stage_label_is_what_the_shared_rule_accepts() {
        assert_eq!(
            stage_label(
                3,
                &["가격 비교하는 중".into(), "후기 읽기".into(), "정리".into()]
            ),
            "조사 중 · 3／6 · 가격 비교하는 중"
        );
        assert_eq!(stage_label(2, &[]), "조사 중 · 2／2");
        let worst: Vec<String> = vec![
            "a/b\\c\u{202e}\u{0000}가".repeat(40),
            "\u{3164}\u{3164}".to_string(),
            "비교\u{fe0f}하기".to_string(),
            "\u{e0041}tag".to_string(),
            "\u{034f}x".to_string(),
            format!("{}\u{ffa0}", "x".repeat(70)),
            "/////".to_string(),
            "   ".to_string(),
            String::new(),
            "가".repeat(500),
            "A/B 비교, C\\D 정리".to_string(),
        ];
        for line in &worst {
            for steps in [0, 1, 7, 20] {
                let label = stage_label(steps, &[line.clone(), "다음".to_string()]);
                assert_eq!(
                    checked_report_text(&label, STAGE_LABEL_CHARS_MAX).as_deref(),
                    Ok(label.as_str()),
                    "the shared rule must accept {label:?} unchanged (plan line {line:?}, step {steps})"
                );
                assert!(label.chars().count() <= STAGE_LABEL_CHARS_MAX, "{label:?}");
                assert!(label.starts_with("조사 중 · "), "{label:?}");
            }
        }
        // What the model wrote survives where the rule allows it; a path separator or an invisible
        // character parts the words instead (the way `clean_line` has always treated one).
        assert_eq!(
            stage_label(1, &["A/B 비교".to_string()]),
            "조사 중 · 1／2 · A B 비교"
        );
        assert_eq!(
            stage_label(1, &["비교\u{fe0f}하기".to_string()]),
            "조사 중 · 1／2 · 비교 하기"
        );
    }

    /// The contract `display_line` states: empty, or a text the shared rule accepts unchanged.
    #[test]
    fn a_display_line_is_empty_or_accepted_by_the_shared_rule() {
        for raw in [
            "가격 비교하기",
            "a/b",
            "a\\b",
            "\u{3164}",
            "x\u{fe0f}\u{200d}y",
            "\n\t 줄바꿈  끼움 \n",
            "가".repeat(200).as_str(),
            "",
            "////",
        ] {
            for max in [1, 20, MAX_PLAN_TEXT_CHARS, STAGE_LABEL_CHARS_MAX] {
                let line = display_line(raw, max);
                assert!(line.chars().count() <= max, "{line:?}");
                if !line.is_empty() {
                    assert_eq!(
                        checked_report_text(&line, max).as_deref(),
                        Ok(line.as_str()),
                        "{raw:?} at {max}"
                    );
                }
            }
        }
    }

    /// The last gate is the shared rule and nothing else: a candidate that the cleaning never makes
    /// (a separator, a filler, a control character, nothing at all) is replaced by the head; a clean
    /// one passes unchanged; a long one is cut at the limit first.
    #[test]
    fn the_judge_replaces_a_line_the_shared_rule_refuses() {
        let head = "조사 중 · 1／2";
        for refused in [
            "조사 중 · 1／2 · a/b",
            "조사 중 · 1／2 · a\\b",
            "조사 중 · 1／2 · \u{3164}",
            "조사 중 · 1／2 · x\u{7}y",
            "조사 중 · 1／2 · \u{202e}rtl",
            "",
            "   ",
        ] {
            assert_eq!(judged_label(refused, head), head, "{refused:?}");
        }
        assert_eq!(
            judged_label("조사 중 · 1／2 · 가격 비교", head),
            "조사 중 · 1／2 · 가격 비교"
        );
        let long = format!("{head} · {}", "가".repeat(200));
        let cut = judged_label(&long, head);
        assert_eq!(cut.chars().count(), STAGE_LABEL_CHARS_MAX);
        assert!(cut.starts_with(head));
    }

    /// #4968: the progress line's `m` is `n` plus the **visible** plan's length, for every mix of plan
    /// lines — a line that says nothing once it is made readable is in neither the plan nor the count
    /// (the reader's "n of m" and the line must be the same numbers).
    #[test]
    fn the_progress_lines_denominator_is_the_visible_plans_length() {
        let plan: Vec<String> = ["/", "가격 비교", "\u{3164}", "정리", "\\"]
            .map(String::from)
            .to_vec();
        assert_eq!(stage_label(2, &plan), "조사 중 · 2／4 · 가격 비교");
        let mixes: Vec<Vec<String>> = vec![
            plan.clone(),
            vec!["/".to_string()],
            vec![],
            vec!["가".to_string(); 8],
            vec!["a/b".to_string(), "///".to_string(), "c".to_string()],
        ];
        for lines in &mixes {
            for steps in [0, 1, 5, 20] {
                let label = stage_label(steps, lines);
                let head = label.split(" · ").nth(1).expect("the count");
                let (n, m) = head.split_once('／').expect("n／m");
                let (n, m): (usize, usize) = (n.parse().unwrap(), m.parse().unwrap());
                let report =
                    progress_report(steps, StepCounts::default(), Some(lines)).expect("accepted");
                assert_eq!(n, steps as usize);
                assert_eq!(
                    m.max(1),
                    (n + report.plan_steps().expect("a plan")).max(1),
                    "{lines:?} at step {steps}: {label}"
                );
            }
        }
    }

    /// The report of a step: kinds from the closed vocabulary, one activity per kind that was used,
    /// the plan as what remains (first `in_progress`) — and none of it refused for the worst lines.
    #[test]
    fn a_steps_report_is_accepted_whole_for_the_worst_plan_lines() {
        let counts = StepCounts {
            reads: 3,
            searches: 1,
            web: 2,
        };
        let worst: Vec<String> = vec![
            "a/b\\c".to_string(),
            "\u{3164}".to_string(),
            "x\u{fe0f}".to_string(),
            "/".to_string(),
            "가".repeat(200),
        ];
        let report = progress_report(2, counts, Some(&worst)).expect("accepted");
        assert_eq!(report.activity_count(), 3);
        // `"/"` and `"\u{3164}"` leave nothing; the other three remain.
        assert_eq!(report.plan_steps(), Some(3));
        // No activity for what was not done; no plan when none is given.
        let quiet = progress_report(3, StepCounts::default(), None).expect("accepted");
        assert!(quiet.is_empty());
        let only_reads = progress_report(
            3,
            StepCounts {
                reads: 1,
                ..StepCounts::default()
            },
            None,
        )
        .expect("accepted");
        assert_eq!(
            (only_reads.activity_count(), only_reads.plan_steps()),
            (1, None)
        );
        // A plan whose lines all vanish clears the visible plan rather than showing nothing true.
        let cleared =
            progress_report(2, StepCounts::default(), Some(&["/".to_string()])).expect("accepted");
        assert_eq!(cleared.plan_steps(), Some(0));
        // The id is a number-name inside the rule's alphabet for every step number.
        for step in [0, 1, 9, 20, i32::MAX] {
            for kind in ["read", "search", "web"] {
                let id = step_activity_id(step, kind);
                assert!(
                    id.chars().count() <= 32 && crate::run_activity::id_alphabet_ok(&id),
                    "{id}"
                );
            }
        }
    }

    /// A count past the writer's ceiling is cut to it, not refused.
    #[test]
    fn a_huge_count_is_cut_to_the_ceiling() {
        let counts = StepCounts {
            reads: i32::MAX,
            ..StepCounts::default()
        };
        assert!(progress_report(1, counts, None).is_ok());
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
