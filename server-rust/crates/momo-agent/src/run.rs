//! The `agent_run` state machine — creation, the trigger-bound idempotency key,
//! the gateway's row lock, and the two terminal transitions.
//!
//! **This module owns every `agent_run` write in the workspace**, the same way
//! `momo-outbox` owns `outbox` and `momo-auth` owns `token`. Two B7.2 companions
//! *read* the table beside it and are named here so the ownership claim stays
//! literally true: [`crate::a2a::load_a2a_gate_snapshot_in_tx`] (the delegation
//! counters) and [`crate::usage::chain_usage_in_tx`] (the `parent_run_id` walk a
//! chain's spend is summed over). Both are `SELECT`-only, both live in this same
//! crate, and neither has a second copy of a statement that appears here.
//!
//! Three statements here **read** tables this crate does not own —
//! [`linked_work_session_ids_in_tx`] and the control-window hold pair read
//! `audit_log`/`work_control`, and the resume additionally reads
//! `display_control_window` (076). The alternative is raw SQL in a route
//! handler, which this server allows nowhere; none of them writes, and none has
//! a second copy anywhere in the workspace.
//!
//! Measured against `001_init.sql:267-297` (the table), Swift
//! `AgentRunRoutes.create` (:29-250, the work trigger) and
//! `MessageRoutes.recordMentionRun` (:1988-2025, the mention trigger), plus
//! `AgentGatewayRoutes.lockGatewayRun` (:1186-1233) and the completion
//! transitions (:970-996).

use chrono::{DateTime, Utc};
use momo_db::DbError;
use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The `run_status` enum (`001_init.sql:19-21`), in declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Queued,
    Running,
    AwaitingApproval,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

impl RunStatus {
    pub fn as_db_label(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::AwaitingApproval => "awaiting_approval",
            RunStatus::Paused => "paused",
            RunStatus::Succeeded => "succeeded",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::TimedOut => "timed_out",
        }
    }

    pub fn from_db_label(label: &str) -> Option<RunStatus> {
        Some(match label {
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "awaiting_approval" => RunStatus::AwaitingApproval,
            "paused" => RunStatus::Paused,
            "succeeded" => RunStatus::Succeeded,
            "failed" => RunStatus::Failed,
            "cancelled" => RunStatus::Cancelled,
            "timed_out" => RunStatus::TimedOut,
            _ => return None,
        })
    }

    /// Swift `isTerminalRunStatus` (:1290-1293). A terminal run accepts no new
    /// work — only the replay of a completion it already recorded.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled | RunStatus::TimedOut
        )
    }

    /// Swift `isApprovalHeldRunStatus` (:1295-1297).
    ///
    /// Checked **before** the lease (`completionPreLeaseDisposition`, :1299-1303)
    /// for a reason worth keeping: a run parked on a human decision must answer
    /// "a human has to decide" even to a gateway whose lease already expired.
    /// Ordering it after the lease check would turn the answer into "your lease is
    /// stale", which is true but useless — and would invite a retry loop that can
    /// never succeed.
    pub fn is_approval_held(self) -> bool {
        matches!(self, RunStatus::AwaitingApproval | RunStatus::Paused)
    }

    /// The live statuses — the `agent_run_active_idx` predicate
    /// (`001_init.sql:293-295`) and the concurrency-cap count Swift runs
    /// (`AgentRunRoutes.swift:667-668`).
    pub const LIVE: [RunStatus; 4] = [
        RunStatus::Queued,
        RunStatus::Running,
        RunStatus::AwaitingApproval,
        RunStatus::Paused,
    ];

    /// Swift `isCancellableRunStatus` (`AgentRunRoutes.swift:609-611`): the set a
    /// human "멈춰라" may still act on.
    ///
    /// It is the same four statuses as [`Self::LIVE`] and it is written as its
    /// own predicate anyway, because the two answer different questions. `LIVE`
    /// asks "does this run occupy a concurrency slot"; this asks "is there still
    /// something to stop". They coincide today and a future status (a run parked
    /// on something that is not an approval, say) could easily belong to one and
    /// not the other — at which point a single shared constant would silently
    /// pick a side.
    pub fn is_cancellable(self) -> bool {
        matches!(
            self,
            RunStatus::Queued
                | RunStatus::Running
                | RunStatus::AwaitingApproval
                | RunStatus::Paused
        )
    }
}

/// How a run was triggered, and therefore what makes a re-trigger the *same*
/// run.
///
/// `agent_run.idempotency_key` is `UNIQUE (workspace_id, idempotency_key)`
/// (`001_init.sql:290`), and both Swift writers derive it from the trigger:
///
/// | trigger | key | source |
/// |---|---|---|
/// | a mention | `mention:<message>:<agent>` | `MessageRoutes.swift:1988` |
/// | a work request | `work:<channel>:<actor>:<agent>:<clientRun>` | `AgentRunRoutes.swift:974` |
///
/// That is the whole idempotency story: **one trigger message produces at most
/// one run** (the schema comment at `001_init.sql:288`), enforced by the unique
/// index rather than by a read-then-write anybody could race.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunTrigger {
    /// A message that mentioned the agent. The message id is also written to
    /// `agent_run.trigger_message_id`, so the run and the utterance that caused
    /// it stay joined in the database, not just in a payload.
    Mention {
        message_id: Uuid,
        agent_member_id: Uuid,
    },
    /// An explicit work request from a human, keyed by the client's run id.
    Work {
        channel_id: Uuid,
        actor_member_id: Uuid,
        agent_member_id: Uuid,
        client_run_id: Uuid,
    },
}

impl RunTrigger {
    /// The `agent_run.idempotency_key` for this trigger.
    pub fn idempotency_key(&self) -> String {
        match self {
            RunTrigger::Mention {
                message_id,
                agent_member_id,
            } => format!(
                "mention:{}:{}",
                message_id.to_string().to_uppercase(),
                agent_member_id.to_string().to_uppercase()
            ),
            RunTrigger::Work {
                channel_id,
                actor_member_id,
                agent_member_id,
                client_run_id,
            } => format!(
                "work:{}:{}:{}:{}",
                channel_id.to_string().to_uppercase(),
                actor_member_id.to_string().to_uppercase(),
                agent_member_id.to_string().to_uppercase(),
                client_run_id.to_string().to_uppercase()
            ),
        }
    }

    /// The `trigger_message_id` column value — `Some` only for a mention, which
    /// is the only trigger that *is* a message (`AgentRunRoutes.create` leaves
    /// the column NULL, `MessageRoutes.swift:2021` writes it).
    pub fn trigger_message_id(&self) -> Option<Uuid> {
        match self {
            RunTrigger::Mention { message_id, .. } => Some(*message_id),
            RunTrigger::Work { .. } => None,
        }
    }

    pub fn agent_member_id(&self) -> Uuid {
        match self {
            RunTrigger::Mention {
                agent_member_id, ..
            }
            | RunTrigger::Work {
                agent_member_id, ..
            } => *agent_member_id,
        }
    }
}

/// Everything an `agent_run` INSERT needs beyond its trigger.
#[derive(Debug, Clone)]
pub struct NewAgentRun {
    pub channel_id: Uuid,
    pub trigger: RunTrigger,
    pub parent_run_id: Option<Uuid>,
    /// `agent.max_run_steps` — the per-agent cap, not a constant.
    pub max_steps: i32,
    /// A2A hop depth. `agent_run_depth_a2a_cap_ck` (007) rejects > 4 at the SoT.
    pub depth: i32,
    pub input: Value,
}

/// The result of a create attempt. `created == false` is an **idempotency hit**,
/// not a failure: the caller is holding the run its trigger already produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedRun {
    pub id: Uuid,
    pub created: bool,
}

/// A run row as the read surfaces project it.
#[derive(Debug, Clone)]
pub struct AgentRunRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub agent_member_id: Uuid,
    pub channel_id: Uuid,
    pub trigger_message_id: Option<Uuid>,
    pub parent_run_id: Option<Uuid>,
    pub status: RunStatus,
    pub step_count: i32,
    pub max_steps: i32,
    pub depth: i32,
    pub input: Value,
    pub output: Option<Value>,
    pub error: Option<Value>,
    pub idempotency_key: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const RUN_COLS: &str = "id, workspace_id, agent_member_id, channel_id, trigger_message_id, \
     parent_run_id, status::text AS status_label, step_count, max_steps, depth, input, output, \
     error, idempotency_key, started_at, finished_at, created_at, updated_at";

fn decode_run(row: &sqlx::postgres::PgRow) -> Result<AgentRunRow, sqlx::Error> {
    let label: String = row.try_get("status_label")?;
    let status = RunStatus::from_db_label(&label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown run_status '{label}'").into()))?;
    Ok(AgentRunRow {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        channel_id: row.try_get("channel_id")?,
        trigger_message_id: row.try_get("trigger_message_id")?,
        parent_run_id: row.try_get("parent_run_id")?,
        status,
        step_count: row.try_get("step_count")?,
        max_steps: row.try_get("max_steps")?,
        depth: row.try_get("depth")?,
        input: row.try_get("input")?,
        output: row.try_get("output")?,
        error: row.try_get("error")?,
        idempotency_key: row.try_get("idempotency_key")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Create the run for a trigger, or return the run that trigger already made.
///
/// `ON CONFLICT (workspace_id, idempotency_key) DO NOTHING` + re-select is the
/// port of both Swift writers (`AgentRunRoutes.swift:121-142`,
/// `MessageRoutes.swift:2024`). The conflict target is the **unique index**, so
/// two concurrent triggers of the same message cannot both insert: one wins, the
/// other reads the winner's row. A `SELECT`-then-`INSERT` would be racy in
/// exactly the window that matters — a client retrying a timed-out request.
pub async fn create_agent_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewAgentRun,
) -> Result<CreatedRun, DbError> {
    let idempotency_key = input.trigger.idempotency_key();
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO agent_run \
           (workspace_id, agent_member_id, channel_id, trigger_message_id, parent_run_id, \
            status, step_count, max_steps, depth, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5, 'queued', 0, $6, $7, $8, $9) \
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(input.trigger.agent_member_id())
    .bind(input.channel_id)
    .bind(input.trigger.trigger_message_id())
    .bind(input.parent_run_id)
    .bind(input.max_steps)
    .bind(input.depth)
    .bind(&input.input)
    .bind(&idempotency_key)
    .fetch_optional(&mut *conn)
    .await?;

    if let Some(id) = inserted {
        return Ok(CreatedRun { id, created: true });
    }

    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM agent_run \
          WHERE workspace_id = $1 AND idempotency_key = $2 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(&idempotency_key)
    .fetch_optional(&mut *conn)
    .await?;
    // No insert and no row means the conflict was on something else entirely —
    // surface it rather than inventing a run id.
    let id = existing.ok_or_else(|| DbError::from(sqlx::Error::RowNotFound))?;
    Ok(CreatedRun { id, created: false })
}

/// Load a run by id (tenant-scoped by the caller's GUC).
pub async fn load_agent_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Option<AgentRunRow>, DbError> {
    let sql = format!("SELECT {RUN_COLS} FROM agent_run WHERE id = $1 AND workspace_id = $2");
    let row = sqlx::query(&sql)
        .bind(run_id)
        .bind(workspace_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_run)
        .transpose()
        .map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// the read surfaces (#1223)
//
// Every write above has had a reader on the client since the Swift server:
// `agent_run` rows have been accumulating on this server all along, and the
// three statements below are the first ones that let a person see them. They
// are `SELECT`-only and they live here rather than in the binary for the reason
// the module header gives — one place holds the `agent_run` vocabulary, so the
// list's visibility predicate and the detail's cannot drift apart.
// ---------------------------------------------------------------------------

/// The bounded, credential-free projection of a run (MOMO-653 — openapi
/// `AgentRunSummary`).
///
/// **What is missing is the feature.** No `input`, no `output`, no `error`, no
/// idempotency key: a workspace-global history is read by anyone who shares a
/// room with the agent, and the brief a person typed into one channel is not
/// theirs to read from another. `trigger_summary` is the one sentence that
/// crosses, bounded to [`TRIGGER_SUMMARY_LIMIT`] characters, and it is derived
/// inside [`decode_run_summary`] so the struct has nowhere to keep the raw
/// object even by accident.
#[derive(Debug, Clone)]
pub struct AgentRunSummaryRow {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub trigger_message_id: Option<Uuid>,
    pub trigger_summary: Option<String>,
    pub status: RunStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One keyset page of [`AgentRunSummaryRow`], newest first.
///
/// `next_cursor` is `Some` only when a further page genuinely exists — the query
/// asks for `limit + 1` rows and reports the cursor only if the extra one came
/// back. A cursor that is always present would make a client page forever
/// through an empty tail.
#[derive(Debug, Clone)]
pub struct AgentRunSummaryPage {
    pub runs: Vec<AgentRunSummaryRow>,
    pub next_cursor: Option<Uuid>,
}

/// The character cap on `trigger_summary` (Swift `runSummaryFieldsSQL`
/// `left(…, 200)`, and openapi's `maxLength: 200`).
pub const TRIGGER_SUMMARY_LIMIT: usize = 200;

/// The one sentence a summary may carry about why a run exists.
///
/// Both shapes of trigger are covered because both reach the same column: a work
/// run stores the person's `title`, a mention run stores the `prompt`. Anything
/// else summarizes to `None` rather than to a guess — an unknown input shape is
/// exactly the case where reaching into it would leak a field nobody vetted.
///
/// Shared with the full detail projection (`routes::shared::run_response`) on
/// purpose: two derivations of "the excerpt a client shows" is how a channel
/// list and an agent hub come to disagree about what the same run was for.
pub fn trigger_summary(input: &Value) -> Option<String> {
    let raw = match input.get("type").and_then(Value::as_str) {
        Some("work") => input.get("title").and_then(Value::as_str),
        _ => match input.get("surface").and_then(Value::as_str) {
            Some("mention") => input.get("prompt").and_then(Value::as_str),
            _ => None,
        },
    };
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(TRIGGER_SUMMARY_LIMIT).collect())
}

/// `?limit=` for both history reads (Swift `validatedLimit`, :614-616).
///
/// An unparsable value falls back to the default instead of 400ing, matching
/// Swift's `flatMap(Int.init)`: a client that sends `limit=all` gets a page, not
/// a refusal it cannot act on.
pub fn validated_run_limit(raw: Option<&str>) -> i64 {
    raw.and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, 200)
}

/// Qualified with the `r` alias, unlike [`RUN_COLS`], because the only statement
/// that uses it joins `membership` — and `channel_id` is a column of both tables,
/// so a bare list is an ambiguous-reference error at runtime rather than a
/// compile-time one.
const SUMMARY_COLS: &str = "r.id, r.channel_id, r.trigger_message_id, \
     r.status::text AS status_label, r.input, r.started_at, r.finished_at, \
     r.created_at, r.updated_at";

fn decode_run_summary(row: &sqlx::postgres::PgRow) -> Result<AgentRunSummaryRow, sqlx::Error> {
    let label: String = row.try_get("status_label")?;
    let status = RunStatus::from_db_label(&label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown run_status '{label}'").into()))?;
    // `input` is read and immediately reduced to the bounded excerpt. It is a
    // local, never a field: the struct this returns cannot carry the object out
    // of this function even if a later caller wanted it to.
    let input: Value = row.try_get("input")?;
    Ok(AgentRunSummaryRow {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        trigger_message_id: row.try_get("trigger_message_id")?,
        trigger_summary: trigger_summary(&input),
        status,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// One channel's **work** runs, newest first (Swift `list`, :253-296).
///
/// `agent_scope` is `Some(member)` when the caller is an agent bearer, and it
/// narrows the page to that agent's own runs. It is `None` for a human, who sees
/// every work run in a room they are in. The membership check itself is the
/// caller's — this statement is the projection, not the door.
///
/// `input->>'type' = 'work'` is the same predicate the create route writes
/// against, and it is why a mention run never appears here: the channel list is
/// the work surface's history, and a mention's history is the timeline itself.
pub async fn list_channel_work_runs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    agent_scope: Option<Uuid>,
    limit: i64,
) -> Result<Vec<AgentRunRow>, DbError> {
    let sql = format!(
        "SELECT {RUN_COLS} FROM agent_run \
          WHERE workspace_id = $1 \
            AND channel_id = $2 \
            AND input->>'type' = 'work' \
            AND ($3::uuid IS NULL OR agent_member_id = $3::uuid) \
          ORDER BY created_at DESC, id DESC \
          LIMIT $4"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(agent_scope)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(decode_run)
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Is this cursor a run the viewer could have been handed? (Swift :336-356.)
///
/// Checked before the page query so an unknown or invisible cursor is a **400**
/// rather than a silently empty page. The distinction is the whole reason this
/// is a separate statement: an empty page means "you have reached the end", and
/// answering that to someone holding a cursor from another agent's history would
/// be a lie about their own data.
///
/// It carries the same `JOIN membership` the page carries, so a cursor naming a
/// run in a room the viewer has left is "not found" and not "found but hidden".
pub async fn agent_run_cursor_is_visible_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    viewer_member_id: Uuid,
    cursor: Uuid,
) -> Result<bool, DbError> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM agent_run r \
           JOIN membership visible \
             ON visible.workspace_id = r.workspace_id \
            AND visible.channel_id = r.channel_id \
            AND visible.member_id = $3 \
            AND visible.left_at IS NULL \
          WHERE r.workspace_id = $1 \
            AND r.agent_member_id = $2 \
            AND r.id = $4 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(viewer_member_id)
    .bind(cursor)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// One agent's workspace-global history, restricted to rooms the viewer is in
/// (Swift `listByAgent`, :304-390 — MOMO-653).
///
/// ## The visibility join is the authorization
///
/// `JOIN membership visible` is not an optimization: an agent hub is reachable
/// by any workspace member, and this agent has been working in rooms the reader
/// may never have been in. Filtering after the fact would still have read those
/// rows into the process; joining makes "runs in rooms I am in" the *only* set
/// the statement can produce.
///
/// ## Why the keyset is `(created_at, id)` and not an offset
///
/// Runs are inserted while a person pages. An `OFFSET` would show a row twice or
/// skip one every time a new run lands between two requests. The pair is a total
/// order (`id` breaks ties inside one clock tick), so a page boundary keeps
/// meaning the same row no matter what else was written.
pub async fn list_agent_run_summaries_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    viewer_member_id: Uuid,
    cursor: Option<Uuid>,
    limit: i64,
) -> Result<AgentRunSummaryPage, DbError> {
    let sql = format!(
        "SELECT {SUMMARY_COLS} \
           FROM agent_run r \
           JOIN membership visible \
             ON visible.workspace_id = r.workspace_id \
            AND visible.channel_id = r.channel_id \
            AND visible.member_id = $3 \
            AND visible.left_at IS NULL \
          WHERE r.workspace_id = $1 \
            AND r.agent_member_id = $2 \
            AND ($4::uuid IS NULL OR (r.created_at, r.id) < ( \
                  SELECT cursor_row.created_at, cursor_row.id \
                    FROM agent_run cursor_row \
                   WHERE cursor_row.workspace_id = $1 \
                     AND cursor_row.agent_member_id = $2 \
                     AND cursor_row.id = $4::uuid \
                )) \
          ORDER BY r.created_at DESC, r.id DESC \
          LIMIT $5"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(viewer_member_id)
        .bind(cursor)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await?;
    let mut decoded = rows
        .iter()
        .map(decode_run_summary)
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)?;

    // The extra row is a probe, never a result: it answers "is there more?" and
    // is then dropped, so a page is exactly `limit` long or is the last one.
    let has_more = decoded.len() as i64 > limit;
    decoded.truncate(limit.max(0) as usize);
    let next_cursor = if has_more {
        decoded.last().map(|run| run.id)
    } else {
        None
    };
    Ok(AgentRunSummaryPage {
        runs: decoded,
        next_cursor,
    })
}

/// A run plus **whether the caller is in the room it belongs to** (Swift
/// `detail`, :393-434).
///
/// The membership is read in the same statement as the row rather than in a
/// second query, because the two answers have to be about the same instant: a
/// caller who left the channel between the two reads would otherwise be served a
/// run out of a room they are no longer in.
///
/// Returning the pair instead of `Option<AgentRunRow>` keeps the *decision* in
/// the route, where the difference between "no such run" (404) and "not your
/// room" (403) is a product sentence and needs the caller's principal kind,
/// which this crate deliberately does not know.
pub async fn load_agent_run_with_visibility_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    viewer_member_id: Uuid,
) -> Result<Option<(AgentRunRow, bool)>, DbError> {
    let sql = format!(
        "SELECT {RUN_COLS}, \
                EXISTS ( \
                  SELECT 1 FROM membership ms \
                   WHERE ms.workspace_id = r.workspace_id \
                     AND ms.channel_id = r.channel_id \
                     AND ms.member_id = $3 \
                     AND ms.left_at IS NULL \
                ) AS has_channel_membership \
           FROM agent_run r \
          WHERE r.id = $1 AND r.workspace_id = $2 \
          LIMIT 1"
    );
    let row = sqlx::query(&sql)
        .bind(run_id)
        .bind(workspace_id)
        .bind(viewer_member_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let visible: bool = row
        .try_get("has_channel_membership")
        .map_err(DbError::from)?;
    let run = decode_run(&row).map_err(DbError::from)?;
    Ok(Some((run, visible)))
}

/// Why a REST write's `runId` was refused (ADR-0158 D5).
///
/// Two variants and not three, and the missing one is the point: "no such run"
/// and "a run in another workspace" are **one answer** here, because under RLS
/// they are one observation. A tenant transaction cannot see another tenant's
/// `agent_run` row at all, so a third variant would be a branch no request could
/// ever reach and a sentence that confirmed the existence of rows the caller may
/// not see. The workspace predicate in [`authorize_run_binding_in_tx`] is still
/// written out explicitly — see there for why belt and braces are both worn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RunBindingRejected {
    /// No run with this id is visible to this workspace.
    #[error("runId names no agent run in this workspace")]
    Unknown,
    /// The run exists here, but the caller is not the agent it belongs to.
    #[error("runId belongs to another member's agent run")]
    NotRunAgent,
}

/// May this caller bind a message to this run? (ADR-0158 D5.)
///
/// **Fail-closed, and the closure is the whole feature.** Until now
/// `POST …/messages` refused every `runId` outright, which cost an out-of-process
/// adapter (prime, hermes) the one name that lets a *server-side* close find the
/// message its run left open (ADR-0155 — see
/// [`momo_messaging::open_stream_message_for_run_in_tx`], which is keyed on the
/// `run_id` column). Serving the field means the column stops being
/// server-authored, so every property a reader draws from it has to be re-earned
/// at this door:
///
/// | check | what a missing check would let through |
/// |---|---|
/// | the run exists | a message bound to an id nobody issued — `runEnded` would answer "not ended" forever, and the tail #1166 draws would never appear |
/// | in **this** workspace | a cross-tenant handle in a tenant's own timeline. `message.run_id`'s FK (`schema_v0.sql:302`) is global — it names `agent_run(id)` with no workspace pair — so **nothing below this function stops it**: the FK is satisfied, and RLS never sees the value because an INSERT of a uuid into a column is not a read of the row it points at |
/// | the caller **is** that run's agent | any member could claim authorship of any agent's turn, and the close path would then be closing a stream on behalf of a producer that never opened one |
///
/// The third check is an identity comparison rather than a
/// `PrincipalKind::Agent` test, deliberately: `agent_run.agent_member_id` always
/// names a `member` with `kind = 'agent'`, so equality with it *is* the agent
/// check. A second, separate kind test would be a second thing to keep in
/// agreement with the first.
///
/// ## Why the workspace predicate is written twice
///
/// `load_agent_run_in_tx` carries `AND workspace_id = $2` and the transaction
/// carries RLS, so inside a tenant transaction the predicate is redundant today.
/// It stays because the redundancy is one-directional: RLS protects the *read*,
/// while what this function authorizes is a *write of a foreign uuid into a
/// column*, and those two are only the same thing for as long as the lookup
/// stays inside the tenant transaction. A caller that ever hoisted it out would
/// lose RLS silently and keep the predicate.
pub async fn authorize_run_binding_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), RunBindingRejected>, DbError> {
    let Some(run) = load_agent_run_in_tx(conn, workspace_id, run_id).await? else {
        return Ok(Err(RunBindingRejected::Unknown));
    };
    // Unreachable while the lookup above keeps its own predicate; asserted
    // anyway, because "unreachable" is a property of today's call sites.
    if run.workspace_id != workspace_id {
        return Ok(Err(RunBindingRejected::Unknown));
    }
    if run.agent_member_id != member_id {
        return Ok(Err(RunBindingRejected::NotRunAgent));
    }
    Ok(Ok(()))
}

/// Which of these runs have **ended** — the durable half of ADR-0155's
/// defensive render (#1166).
///
/// One statement for a whole page, because the caller's question is about a
/// page: a per-message `load_agent_run_in_tx` would put an N+1 inside the read
/// transaction of the busiest route in the product.
///
/// **Only terminal ids come back, and an unknown id simply is not in the set.**
/// A run this workspace cannot see (RLS), a run id a client invented in its own
/// props, and a run still queued are the same answer here — *not ended* — which
/// is the only answer that keeps "absence ≠ ended" true on the wire the way
/// `endedRuns.ts` keeps it true in a session. [`RunStatus::is_terminal`] decides,
/// so this route and the cancel path can never disagree about what "ended"
/// means.
pub async fn terminal_run_ids_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_ids: &[Uuid],
) -> Result<std::collections::HashSet<Uuid>, DbError> {
    if run_ids.is_empty() {
        return Ok(std::collections::HashSet::new());
    }
    let rows = sqlx::query(
        "SELECT id, status::text AS status FROM agent_run \
          WHERE workspace_id = $1 AND id = ANY($2)",
    )
    .bind(workspace_id)
    .bind(run_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut ended = std::collections::HashSet::new();
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(DbError::from)?;
        let status: String = row.try_get("status").map_err(DbError::from)?;
        // An unparseable label is a status this build does not know; treating it
        // as non-terminal keeps a future enum value from being announced as an
        // ending by a server that has never heard of it.
        if RunStatus::from_db_label(&status).is_some_and(RunStatus::is_terminal) {
            ended.insert(id);
        }
    }
    Ok(ended)
}

/// Load a run by its trigger's idempotency key.
pub async fn find_agent_run_by_trigger_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    trigger: &RunTrigger,
) -> Result<Option<AgentRunRow>, DbError> {
    let sql = format!(
        "SELECT {RUN_COLS} FROM agent_run \
          WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(trigger.idempotency_key())
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_run)
        .transpose()
        .map_err(DbError::from)
}

/// How many live runs an agent has right now — the concurrency cap's input
/// (Swift `AgentRunRoutes.swift:662-669`).
pub async fn live_run_count_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<i64, DbError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM agent_run \
          WHERE workspace_id = $1 AND agent_member_id = $2 \
            AND status IN ('queued','running','awaiting_approval','paused')",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// eligibility predicates
//
// These read `member`/`agent`/`agent_profile`/`membership` rather than
// `agent_run`, and they live here anyway: "may this agent take a run" and "may
// this human start one" are agent-run preconditions, and the alternative is raw
// SQL in a route handler (which this server allows nowhere).
// ---------------------------------------------------------------------------

/// The agent facts run creation needs (Swift `EligibleWorkAgent`,
/// `AgentRunRoutes.swift:651-709`).
#[derive(Debug, Clone)]
pub struct EligibleAgent {
    /// `agent.model` — the ledger's fallback and the job payload's instruction.
    pub model: String,
    pub max_run_steps: i32,
    pub max_concurrent_runs: i32,
    /// `agent_profile.paused`, defaulted to `false` when the agent has no
    /// profile row: an agent nobody has configured is not a paused agent.
    pub paused: bool,
    pub hosted_delivery_disabled: bool,
    /// `agent.tool_schema` — the operator's own provider-format function defs
    /// (goal SRV-B5a). Read here so a **work** run carries the same two tool
    /// sources a mention does; before this the work payload had no `tools` key
    /// at all, so an agent that could use a tool when mentioned silently could
    /// not when started from the work surface.
    pub tool_schema: Value,
    /// `agent_profile.enabled_tools` — the names the profile turned on. Raw, for
    /// the same reason the mention path keeps them raw: the intersection with
    /// what a build can run belongs to `momo_agent::tools`, resolved by whichever
    /// worker claims the job.
    pub enabled_tools: Vec<String>,
}

/// Load the agent's run-eligibility facts, or `None` when it may not take a run
/// in this channel at all.
///
/// Membership is part of the query, not a follow-up check, so there is no window
/// between "is it a member" and "create the run". `FOR UPDATE OF a` locks the
/// `agent` row only — that is what serializes two concurrent creates against the
/// same agent's concurrency cap without also locking the member or the channel.
pub async fn load_eligible_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<EligibleAgent>, DbError> {
    let row = sqlx::query(
        "SELECT a.model, a.max_run_steps, a.max_concurrent_runs, \
                a.tool_schema, ap.enabled_tools, \
                COALESCE(ap.paused, false) AS paused \
                , EXISTS (SELECT 1 FROM hosted_agent_connection hc \
                           WHERE hc.workspace_id = m.workspace_id AND hc.agent_member_id = m.id) \
                    AS hosted_delivery_disabled \
           FROM member m \
           JOIN agent a ON a.member_id = m.id AND a.workspace_id = m.workspace_id \
           JOIN membership ms \
             ON ms.workspace_id = m.workspace_id \
            AND ms.channel_id = $2 \
            AND ms.member_id = m.id \
            AND ms.left_at IS NULL \
           LEFT JOIN agent_profile ap \
             ON ap.workspace_id = a.workspace_id AND ap.agent_member_id = a.member_id \
          WHERE m.id = $3 \
            AND m.workspace_id = $1 \
            AND m.kind = 'agent' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          LIMIT 1 \
          FOR UPDATE OF a",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };
    // Both tool columns fail **closed** on anything unexpected: a NULL profile,
    // a non-array value, a non-string entry. The alternative to "no tools" here
    // is "some tool nobody verified", on the surface whose one executable tool
    // is irreversible.
    let enabled_tools: Option<Value> = row.try_get("enabled_tools")?;
    let enabled_tools: Vec<String> = enabled_tools
        .as_ref()
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(Some(EligibleAgent {
        model: row.try_get("model")?,
        max_run_steps: row.try_get("max_run_steps")?,
        max_concurrent_runs: row.try_get("max_concurrent_runs")?,
        paused: row.try_get("paused")?,
        hosted_delivery_disabled: row.try_get("hosted_delivery_disabled")?,
        tool_schema: row.try_get("tool_schema")?,
        enabled_tools,
    }))
}

/// Is this member an active **human** member of the channel? (Swift
/// `hasActiveHumanMembership`, :711-735.)
///
/// `kind = 'human'` is the check, not an assumption about the credential: an
/// agent must not be able to start another agent even if it somehow reached this
/// route.
pub async fn is_active_human_channel_member_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM member m \
           JOIN membership ms \
             ON ms.workspace_id = m.workspace_id \
            AND ms.member_id = m.id \
            AND ms.channel_id = $1 \
            AND ms.left_at IS NULL \
          WHERE m.id = $2 \
            AND m.kind = 'human' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// Is this an active agent of the workspace? (Swift `isActiveAgent`,
/// :1438-1461.)
///
/// The gateway's job-claim gate: a deactivated agent's queue stops draining, so
/// revoking an agent stops its work even if a credential leaked.
pub async fn is_active_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM member m \
           JOIN agent a ON a.member_id = m.id AND a.workspace_id = m.workspace_id \
          WHERE m.id = $2 \
            AND m.workspace_id = $1 \
            AND m.kind = 'agent' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// The run facts a gateway callback needs, read on a row it has just locked —
/// Swift `lockGatewayRun` (:1186-1233).
#[derive(Debug, Clone)]
pub struct GatewayRunSnapshot {
    pub agent_member_id: Uuid,
    pub channel_id: Uuid,
    pub status: RunStatus,
    /// The utterance that started this run — `agent_run.trigger_message_id`,
    /// `NULL` for a run nobody said anything to raise (a work run, an operator
    /// start).
    ///
    /// Projected since ADR-0148 because it is what an agent's answer **points
    /// at**: `reply_to_id` on the final message. Read from the locked run row
    /// rather than from the job payload, so the worker and the gateway quote the
    /// same message, and so a resumed run still answers the mention it started
    /// from — `resume_job_payload` carries no trigger, but the run row never
    /// stopped holding one.
    pub trigger_message_id: Option<Uuid>,
    /// `agent.model` — the ledger's fallback when the adapter reports none.
    pub model: String,
    /// ADR-0134 D2 ledger fallbacks, read on the already-locked row: what the run
    /// requested (`input.routing.effort`) and the agent-tier preference behind it.
    pub requested_effort: Option<String>,
    pub profile_effort_pref: Option<String>,
    /// When the run actually began — `agent_run.started_at`, stamped once by
    /// [`mark_run_started_in_tx`] and never moved after (`COALESCE`).
    ///
    /// Projected since #1454 because it is the **only server-observed** answer to
    /// "how long did this take", which the completion report card prints as its
    /// 성과 단위 (「24분 28초」). Read off the row rather than from any worker's own
    /// clock on purpose: a run can be paused on an approval for an hour, have its
    /// lease taken over by a second worker, or be re-claimed after a restart, and
    /// in every one of those the elapsed a *process* watched is shorter than the
    /// elapsed the *run* took. The card must not report the shorter one.
    ///
    /// `None` only for a run no writer has started yet, which a caller that just
    /// marked it started will not see.
    pub started_at: Option<DateTime<Utc>>,
    /// The **database's** clock at the moment this row was read — Postgres
    /// `now()`, the reading transaction's start.
    ///
    /// Projected beside [`GatewayRunSnapshot::started_at`] on purpose and in the
    /// same statement, because the only honest way to subtract two instants is
    /// to read them from **one clock** (#1454 L-1). `started_at` is written by
    /// the database; measuring it against a worker process's own wall clock
    /// makes every elapsed carry that host's skew against Postgres — inflating
    /// every turn on a host that runs fast and, on one that runs slow, driving
    /// short turns negative so the card silently drops its duration. Neither is
    /// visible to anyone reading the card, which is what makes it worth a column.
    pub observed_at: DateTime<Utc>,
}

/// Lock the run and read the gateway's view of it, or `None` when no such run is
/// *callable*.
///
/// `None` covers more than "no row": the joins require the run's agent to still
/// be an **active agent member** and to still be **a member of the run's
/// channel** (`membership … left_at IS NULL`). An agent removed from a channel
/// mid-run therefore cannot post its result into that channel — the 404 is the
/// authorization, and it is re-evaluated at callback time rather than trusted
/// from when the run started.
///
/// `FOR UPDATE OF r` locks only `agent_run`: the joined `member`/`agent` rows are
/// read for facts, and locking them would serialize every concurrent run of the
/// same agent behind one another.
pub async fn lock_gateway_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Option<GatewayRunSnapshot>, DbError> {
    let row = sqlx::query(
        "SELECT r.agent_member_id, r.channel_id, r.status::text AS status_label, \
                r.trigger_message_id, r.started_at, now() AS observed_at, a.model, \
                r.input->'routing'->>'effort' AS requested_effort, \
                ap.effort_pref AS profile_effort_pref \
           FROM agent_run r \
           JOIN member m \
             ON m.id = r.agent_member_id \
            AND m.workspace_id = $1 \
            AND m.kind = 'agent' \
            AND m.status = 'active' \
           JOIN agent a \
             ON a.member_id = m.id \
            AND a.workspace_id = $1 \
           LEFT JOIN agent_profile ap \
             ON ap.workspace_id = a.workspace_id \
            AND ap.agent_member_id = a.member_id \
          WHERE r.id = $2 \
            AND r.workspace_id = $1 \
            AND EXISTS ( \
              SELECT 1 FROM membership ms \
               WHERE ms.workspace_id = $1 \
                 AND ms.channel_id = r.channel_id \
                 AND ms.member_id = r.agent_member_id \
                 AND ms.left_at IS NULL \
            ) \
          FOR UPDATE OF r",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };
    let label: String = row.try_get("status_label")?;
    let status = RunStatus::from_db_label(&label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown run_status '{label}'").into()))?;
    Ok(Some(GatewayRunSnapshot {
        agent_member_id: row.try_get("agent_member_id")?,
        channel_id: row.try_get("channel_id")?,
        status,
        trigger_message_id: row.try_get("trigger_message_id")?,
        model: row.try_get("model")?,
        requested_effort: row.try_get("requested_effort")?,
        profile_effort_pref: row.try_get("profile_effort_pref")?,
        started_at: row.try_get("started_at")?,
        observed_at: row.try_get("observed_at")?,
    }))
}

/// `queued → running` on the first progress event (Swift :376-389).
///
/// The `WHERE status IN ('queued','running')` guard plus the `CASE` make this
/// idempotent *and* non-regressive: a late event cannot drag a run back out of
/// `awaiting_approval` or a terminal state, and `started_at` is set once
/// (`COALESCE`) so the first event stamps the start, not the last.
pub async fn mark_run_started_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent_run \
            SET status = CASE WHEN status = 'queued' THEN 'running'::run_status ELSE status END, \
                started_at = COALESCE(started_at, now()), \
                updated_at = now() \
          WHERE id = $1 \
            AND status IN ('queued','running')",
    )
    .bind(run_id)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
}

/// Spend one of the run's steps, atomically, or report that it has none left
/// (B7.2 — the G3 half that has to be a write).
///
/// Swift's gate "consumes one step (`step_count + 1` in the proceed UPDATE), so
/// the cap is actually enforced at runtime" (`LoopGuards.swift:29-32`). Read
/// then write would be a race with the run's other consumers; the predicate is
/// therefore *in* the UPDATE, and its `rows_affected() > 0` **is** the verdict.
///
/// `LEAST(max_steps, $2)` is the same tightening Swift applies
/// (`min(runMaxSteps, MAX_STEPS)`), and it is also what makes this write safe
/// against `agent_run_step_cap_ck` (`001_init.sql:289`, `step_count <=
/// max_steps`): the guard admits only `step_count < max_steps`, so the increment
/// can never produce the row the CHECK would reject — which matters here more
/// than usual, because a CHECK violation inside the agent worker's turn
/// transaction would roll back the reply and the ledger row with it.
///
/// Returns `false` for a run that does not exist, which is the same refusal a
/// spent budget gets: no run, no step.
pub async fn consume_run_step_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
    max_steps_ceiling: i32,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent_run \
            SET step_count = step_count + 1, \
                updated_at = now() \
          WHERE id = $1 \
            AND step_count < LEAST(max_steps, $2)",
    )
    .bind(run_id)
    .bind(max_steps_ceiling)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
}

/// The terminal transition a completion writes (Swift :970-996).
///
/// Only `succeeded` and `failed` are reachable here — [`completion_status`] maps
/// every gateway-reported status onto one of the two, because a gateway saying
/// "cancelled" is reporting *its* outcome for a run momo never cancelled.
pub async fn finish_run_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
    succeeded: bool,
    output: &Value,
    error: Option<&Value>,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent_run \
            SET status = CASE WHEN $2 THEN 'succeeded'::run_status ELSE 'failed'::run_status END, \
                output = $3, \
                error = $4, \
                updated_at = now(), \
                finished_at = now() \
          WHERE id = $1",
    )
    .bind(run_id)
    .bind(succeeded)
    .bind(output)
    .bind(error)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
}

// ---------------------------------------------------------------------------
// the approval hold (goal SRV-T1)
//
// Before this batch, `agent_run.status` had exactly three writers — the INSERT
// (`queued`), `mark_run_started_in_tx` (`running`) and `finish_run_in_tx`
// (`succeeded`/`failed`). `awaiting_approval`, `paused`, `cancelled` and
// `timed_out` were reachable in the enum and unreachable in the database. The
// three statements below are the missing transitions, and they are separate
// statements rather than parameters on the existing ones for one reason:
// `mark_run_started_in_tx`'s `WHERE status IN ('queued','running')` guard is
// what stops a late progress event from dragging a run back OUT of an approval
// hold, and widening it to serve a resume would have destroyed that guard.
// ---------------------------------------------------------------------------

/// `running` → `awaiting_approval`, with the deadline that bounds the hold.
///
/// The guard is `status = 'running'`: only the turn that is executing may park
/// itself. A job re-claimed after a lease takeover finds the run already parked
/// and gets `false`, which is what keeps a retried turn from raising a second
/// approval for the same tool call.
///
/// `deadline_at` is written here and nowhere else. `001_init.sql:284` declared
/// the column "for timed_out" and nothing had ever written it; an approval hold
/// is precisely the state that needs one, because
/// [`live_run_count_in_tx`] counts `awaiting_approval` against
/// `agent.max_concurrent_runs` — which **defaults to 1**. Without a deadline the
/// first unanswered approval silences the agent permanently.
pub async fn park_run_for_approval_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
    deadline_at: DateTime<Utc>,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent_run \
            SET status = 'awaiting_approval'::run_status, \
                deadline_at = $2, \
                updated_at = now() \
          WHERE id = $1 \
            AND status = 'running'",
    )
    .bind(run_id)
    .bind(deadline_at)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
}

/// `awaiting_approval` → `queued` (Swift `enqueueResume` :704-714).
///
/// Swift clears `error` and `finished_at`; this also clears `deadline_at`,
/// because the hold that deadline bounded is over and leaving it set would make
/// the run look overdue to any future reader of that column.
///
/// The `status = 'awaiting_approval'` guard is what makes a replayed decision
/// safe: the second one finds the run already requeued (or already finished) and
/// changes nothing, so an approval cannot resurrect a run that has since been
/// rejected, expired or cancelled.
pub async fn requeue_run_from_approval_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent_run \
            SET status = 'queued'::run_status, \
                error = NULL, \
                finished_at = NULL, \
                deadline_at = NULL, \
                updated_at = now() \
          WHERE id = $1 \
            AND status = 'awaiting_approval'",
    )
    .bind(run_id)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
}

/// End a parked run without a completion — a rejection (`cancelled`, Swift
/// `cancelRunAndAppendToolResult` :822-836) or an expiry (`timed_out`, Swift
/// `recordExpiredClick` :930-943).
///
/// This is the statement that **releases the concurrency gate**: the run leaves
/// `RunStatus::LIVE`, so `live_run_count_in_tx` stops counting it and the agent
/// can take work again. Guarded on `awaiting_approval` so it can only ever end a
/// run that is actually parked.
///
/// `finish_run_in_tx` cannot serve this: it writes only `succeeded`/`failed` and
/// carries no status guard at all.
pub async fn end_parked_run_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
    status: RunStatus,
    error: &Value,
) -> Result<bool, DbError> {
    debug_assert!(
        matches!(status, RunStatus::Cancelled | RunStatus::TimedOut),
        "an approval hold ends as cancelled (rejected) or timed_out (expired)"
    );
    let updated = sqlx::query(
        "UPDATE agent_run \
            SET status = $2::run_status, \
                error = $3, \
                deadline_at = NULL, \
                updated_at = now(), \
                finished_at = now() \
          WHERE id = $1 \
            AND status = 'awaiting_approval'",
    )
    .bind(run_id)
    .bind(status.as_db_label())
    .bind(error)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
}

// ---------------------------------------------------------------------------
// the human stop (goal SRV-C2 — ADR-0132 휴먼 정지권)
//
// The transitions above all belong to the machine: a gateway reports, an
// approval resolves, a deadline passes. This one belongs to a person, and that
// is why its authorization is different from every other write in this module —
// **any active member of the run's channel** may stop it, not the agent's owner
// and not a workspace admin. Being in the room is the right to stop what is
// happening in the room.
//
// `cancel_run_in_tx` is a separate statement from `end_parked_run_in_tx` for the
// same reason that one is separate from `finish_run_in_tx`: the guard is the
// contract. `end_parked_run_in_tx` may only end a run that is parked on an
// approval; a human stop must reach a run that is `queued`, `running`, parked,
// or `paused`, and widening the approval statement to serve it would have
// removed the guard that keeps a rejection from ending a run nobody parked.
// ---------------------------------------------------------------------------

/// The locked run row a cancel decides on — Swift's `SELECT … FOR UPDATE`
/// (`AgentRunRoutes.swift:441-464`).
#[derive(Debug, Clone)]
pub struct CancellableRun {
    pub channel_id: Uuid,
    pub agent_member_id: Uuid,
    pub status: RunStatus,
    /// Swift's `can_cancel`: is the caller an active member of the run's
    /// channel (`membership … left_at IS NULL`)?
    ///
    /// Read in the **same statement** as the row lock rather than as a
    /// follow-up, so a membership that ends between the two cannot be the
    /// difference between a refusal and a cancellation. `member.kind` is not
    /// checked here and Swift does not check it either: the route already
    /// requires a human principal, and repeating the test in SQL would suggest
    /// this predicate is the human gate when it is the *room* gate.
    pub caller_is_channel_member: bool,
}

/// Lock the run for a cancel and read the two facts the decision needs.
///
/// `FOR UPDATE` on `agent_run` is what serializes two people tapping 중지 at
/// once: the second waits, then reads `status = 'cancelled'` and takes the
/// idempotent path instead of writing a second system line.
///
/// `None` is "no such run **in this tenant**" — the workspace predicate is in
/// the statement beside RLS, so another tenant's run id is a 404 rather than a
/// 403 that would confirm it exists.
pub async fn lock_run_for_cancel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    member_id: Uuid,
) -> Result<Option<CancellableRun>, DbError> {
    let row = sqlx::query(
        "SELECT r.channel_id, r.agent_member_id, r.status::text AS status_label, \
                EXISTS ( \
                  SELECT 1 FROM membership ms \
                   WHERE ms.workspace_id = $1 \
                     AND ms.channel_id = r.channel_id \
                     AND ms.member_id = $3 \
                     AND ms.left_at IS NULL \
                ) AS can_cancel \
           FROM agent_run r \
          WHERE r.workspace_id = $1 AND r.id = $2 \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };
    let label: String = row.try_get("status_label")?;
    let status = RunStatus::from_db_label(&label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown run_status '{label}'").into()))?;
    Ok(Some(CancellableRun {
        channel_id: row.try_get("channel_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        status,
        caller_is_channel_member: row.try_get("can_cancel")?,
    }))
}

/// `queued|running|awaiting_approval|paused` → `cancelled` (Swift :489-503).
///
/// The status guard is in the `WHERE` even though the caller has already read it
/// under the row lock: the lock makes the read authoritative, and the predicate
/// makes the *statement* safe to call from anywhere. `deadline_at` is cleared
/// like [`end_parked_run_in_tx`] does — a cancelled run is not overdue, it is
/// over — which is one column more than Swift writes and cannot change any
/// answer, since nothing reads `deadline_at` on a terminal run.
///
/// Returns `false` when the run had already left the cancellable set, which the
/// caller must treat as "somebody else ended it", never as a failure.
pub async fn cancel_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    error: &Value,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent_run \
            SET status = 'cancelled'::run_status, \
                error = $3, \
                deadline_at = NULL, \
                updated_at = now(), \
                finished_at = now() \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND status IN ('queued','running','awaiting_approval','paused')",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(error)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
}

/// The `work_session` ids this run's `work_control` records touched — Swift's
/// `audit_log ⋈ work_control` join (:468-486).
///
/// It reads two tables this crate does not own, for the same reason the
/// eligibility predicates above read `member`/`membership`: the alternative is
/// raw SQL in a route handler, which this server allows nowhere. Nothing here
/// writes, and neither table has a second copy of this statement.
///
/// **What the answer means today (runtime-unverified):** `work_control` is not
/// ported to this server — no Rust path writes a row — so the list is empty in
/// practice and the response's `workSessionsTerminated: false` is the literal
/// truth rather than a promise deferred. The query is ported verbatim anyway so
/// that the field starts telling the truth the moment the work-control dispatch
/// lands, instead of being a stub someone has to remember to fill in.
pub async fn linked_work_session_ids_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Vec<Uuid>, DbError> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT wc.session_id \
           FROM audit_log al \
           JOIN work_control wc \
             ON wc.workspace_id = al.workspace_id \
            AND wc.id = al.target_id \
            AND al.target_type = 'work_control' \
          WHERE al.workspace_id = $1 \
            AND al.run_id = $2 \
            AND wc.session_id IS NOT NULL \
          ORDER BY wc.session_id",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(ids)
}

// ---------------------------------------------------------------------------
// the control-window hold (ADR-0004 증보 3 D6 — 「사용자 개입 대기」)
//
// LIVE-3 (#1424) opened the boundary and wrote the ledger for it: while a person
// holds a live session's keyboard, `display_control_window` stands and the two
// gates in `momo_t3::work_control` refuse the agent that session. What LIVE-3
// deliberately did **not** write is the other half of 증보 3 D6 — 「정지되는
// 것은 에이전트 런 층 … 토큰 소진 0」. `RunStatus::Paused` was reachable in the
// enum, counted by [`RunStatus::LIVE`], held by [`RunStatus::is_approval_held`]
// and stoppable by [`RunStatus::is_cancellable`]; nothing anywhere wrote it.
//
// These two statements are that writer, and they are a **pair**: the same
// relation decides who is parked and who is resumed, and both guards are exact
// so either may be replayed. Everything they touch about `Paused` was already
// true before this batch — that is the point. Parking a run does not teach the
// gateway a new refusal, it walks the run into the refusal the gateway has
// always had for a held run (`agent_gateway`:345, :567), which is what makes
// 「토큰 소진 0」 a property of the ledger rather than a promise: a parked run
// cannot record a progress event, cannot complete, and therefore cannot write a
// `usage_ledger` row.
//
// ## What is NOT parked, and why each absence is deliberate
//
// * `awaiting_approval` — that hold belongs to a human decision and its resume
//   is `requeue_run_from_approval_in_tx`, guarded on `awaiting_approval`.
//   Parking it would move the run out from under that guard and a later
//   approval would silently do nothing. 증보 3 does not get to break the
//   approval contract to enforce its own.
// * `queued` — a run that has not started is spending nothing, which is the
//   subject of D6. It is also the status a resume restores *to* in the approval
//   path, so parking it would need a column remembering which live status to
//   put back, and `agent_run` has none. What protects the session from a queued
//   run that starts mid-window is the pair of gates LIVE-3 landed, neither of
//   which reads the run's status at all.
// * anything terminal — there is nothing to hold.
// ---------------------------------------------------------------------------

/// The one relation that joins a run to the work sessions it drives.
///
/// It is [`linked_work_session_ids_in_tx`]'s join read the other way round —
/// same tables, same predicate, one place — because "which sessions did this run
/// touch" and "which runs touched this session" are one fact and must not become
/// two statements that agree today. `audit_log.run_id` is written by
/// `routes::work_controls::create` on every control an agent requests, so this
/// is the ledger's own record of the reach 증보 3 D3 is about, not an inference
/// from membership or ownership.
///
/// `$1` is the workspace. The caller appends its own session clause.
const RUN_DRIVES_SESSION: &str = "\
    SELECT DISTINCT al.run_id, wc.session_id \
       FROM audit_log al \
       JOIN work_control wc \
         ON wc.workspace_id = al.workspace_id \
        AND wc.id = al.target_id \
      WHERE al.workspace_id = $1 \
        AND al.target_type = 'work_control' \
        AND al.run_id IS NOT NULL \
        AND wc.session_id IS NOT NULL";

/// Take `FOR UPDATE` on every run this session's control window can move, and
/// hold it to the end of the caller's transaction.
///
/// ## The hole this closes
///
/// A run may drive more than one session (that is the whole reason the resume
/// below asks its second question), and two sessions are two *different* rows
/// for every lock this area already takes: `lock_attach_target_in_tx` serializes
/// window work **within one session**, and nothing serialized window work on
/// session A against window work on session B. The two statements below both
/// decide from a `display_control_window` read, and under READ COMMITTED that
/// read sees only *committed* windows — so two transactions on two sessions of
/// one run could each decide against a world the other was in the middle of
/// changing:
///
/// 1. **a live window with a running run.** B's `open` + park is in flight and
///    uncommitted; the park moves nothing because the run is already `paused`
///    under A's window, so before this lock it took no lock at all and simply
///    passed through. A's return (or its lapse sweep) then resumes: its `held`
///    subquery cannot see B's uncommitted window, so the run goes back to
///    `running` while somebody is typing into B. That is the gateway hold
///    coming off mid-keyboard — ADR-0004 증보 3 D6's 토큰 소진 0 broken by an
///    interleaving, not by a missing statement.
/// 2. **a permanently parked run.** A and B close at the same time; each
///    resume sees the *other* window still open (the other close is
///    uncommitted) and skips. Both windows end, the run stays `paused`, and
///    there is no path back: the sweep only looks at open windows, and a
///    replayed close finds nothing to close. The agent is silent forever.
///
/// The lock is what makes those two orderings impossible. Whichever transaction
/// takes it first finishes its window write and its run write together; the
/// second one waits, and the statement it runs *after* waiting takes a fresh
/// snapshot that contains the first one's window. Both interleavings then land
/// on the same answer they would have if the two had been run one after the
/// other, which is the definition being asked for.
///
/// ## Why it is a separate statement, and status-blind
///
/// **Separate** because a `FOR UPDATE` inside the park/resume statement itself
/// would share that statement's snapshot: the waiter would re-check the locked
/// row and then judge `held` against the snapshot it took *before* blocking —
/// exactly the stale read this is here to prevent. Only a lock taken in its own
/// statement gives the next statement a snapshot from after the wait.
///
/// **Status-blind** because the lock set has to be a function of the ledger
/// relation and not of a status that is itself racing. Case (1) above is a park
/// that moves **no rows** — an already-`paused` run — so a lock narrowed to what
/// the caller intends to update would lock nothing in precisely the case that
/// needs it most.
///
/// ## Lock order (the contract every caller of the pair keeps)
///
/// > `work_session`/`work_host` → `display_control_window` → `agent_run`
///
/// * `issue_in_tx` — session lock, lapsed-window close, then park/resume.
/// * `return_control_in_tx` — session lock, close, then resume.
/// * `work_controls::create_in_tx` — lapsed-window close, then resume (it holds
///   no session lock; it does not need one, because the run lock is what
///   serializes the resume and the window close is its own row lock).
/// * `work_sessions`' end/resume paths — session lock, close, then resume.
/// * `momo-notifier`'s `settle_lapsed_in_tx` — window close (`FOR UPDATE SKIP
///   LOCKED`, so it never waits on a window), then resume.
///
/// Every one of them closes or opens the window **before** it reaches this
/// lock, which is what makes the waiter's fresh snapshot contain the fact it
/// has to see. `ORDER BY r.id` orders the rows *within* one lock set, so two
/// sessions whose driver runs overlap cannot deadlock against each other.
///
/// The one residual is the notifier sweep, which settles several windows —
/// several lock sets — in one transaction and could in principle cross with
/// another sweep replica taking two sets in the opposite order. PostgreSQL
/// aborts one of them, `sweep_lapsed_control_windows` logs it per workspace and
/// the next tick retries an unchanged state, so the cost is one late resume
/// rather than a lost one.
async fn lock_driver_runs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query(&format!(
        "WITH driver AS ({RUN_DRIVES_SESSION} AND wc.session_id = $2) \
         SELECT r.id \
           FROM agent_run r \
           JOIN driver d \
             ON d.run_id = r.id \
          WHERE r.workspace_id = $1 \
          ORDER BY r.id \
            FOR UPDATE OF r"
    ))
    .bind(workspace_id)
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(())
}

/// A run this batch moved, in the shape a caller needs to announce it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParkedRun {
    pub run_id: Uuid,
    pub channel_id: Uuid,
    pub agent_member_id: Uuid,
}

fn decode_parked(row: &sqlx::postgres::PgRow) -> Result<ParkedRun, sqlx::Error> {
    Ok(ParkedRun {
        run_id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
    })
}

/// `running` → `paused` for every run driving this session — the writer ADR-0004
/// 증보 3 D6 asks for, called in the same transaction as the window that causes
/// it.
///
/// Idempotent by its guard: a re-take that rebinds a standing window (the client
/// retry `open_control_window_in_tx` is built for) finds the runs already
/// `paused` and moves nothing, so 「정지 시각」 stays the one the window row
/// carries.
///
/// `deadline_at` is deliberately **not** written, which is the one place this
/// hold differs from the approval hold and the difference is the argument:
/// `park_run_for_approval_in_tx` sets a deadline because an approval nobody
/// answers would otherwise silence the agent forever. A control window cannot do
/// that — it carries its own 90-second lease, renewed only while a producer
/// keeps saying the stream is up, and the lapse of that lease is what resumes
/// the run. A second clock here would either fight the lease or resume the agent
/// mid-login, which is the failure 증보 3 D3 exists to prevent.
///
/// Takes `lock_driver_runs_in_tx` first, **including on the idempotent path
/// where it will move nothing**: a re-take whose runs are already `paused` is
/// case (1) in that function's docs, and a park that passed through unlocked is
/// what let a concurrent resume on another session of the same run hand the
/// agent back its reach into the screen this window stands on.
pub async fn park_runs_for_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Vec<ParkedRun>, DbError> {
    lock_driver_runs_in_tx(conn, workspace_id, session_id).await?;
    let rows = sqlx::query(&format!(
        "WITH driver AS ({RUN_DRIVES_SESSION} AND wc.session_id = $2) \
         UPDATE agent_run r \
            SET status = 'paused'::run_status, \
                updated_at = now() \
           FROM driver d \
          WHERE r.workspace_id = $1 \
            AND r.id = d.run_id \
            AND r.status = 'running' \
        RETURNING r.id, r.channel_id, r.agent_member_id"
    ))
    .bind(workspace_id)
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_parked)
        .collect::<Result<Vec<_>, _>>()
        .map_err(DbError::from)
}

/// `paused` → `running` for every run this session's closing window was holding.
///
/// The inverse of [`park_runs_for_control_window_in_tx`], and `running` rather
/// than `queued` because it is the exact status the park took away: the turn was
/// in flight, its gateway was refused for the duration, and 「사용자 개입 완료」
/// means it may speak again — not that it must be scheduled afresh. Resuming to
/// `queued` would also be indistinguishable from a run that had never started,
/// which is a different fact.
///
/// ## The second window clause, and the bug it exists to prevent
///
/// A run may drive more than one session. Closing one window while another still
/// stands must not resume it — that would hand the agent back its reach into a
/// screen somebody is still typing into, by the door of a session they finished
/// with. So the resume asks the question the park never had to: is any window
/// this run is held by still open? A run held by two windows is resumed by the
/// second close, not the first.
///
/// Idempotent both ways. A replayed close finds the runs already `running` and
/// changes nothing; a run that was cancelled while parked
/// ([`RunStatus::is_cancellable`] admits `paused`, and `cancel_run_in_tx` names
/// it) is left terminal, because `status = 'paused'` no longer matches. A close
/// must never resurrect a run a human stopped.
///
/// The second window clause is a **read of another transaction's writes**, which
/// is why this takes `lock_driver_runs_in_tx` first: the clause is only as
/// good as the snapshot it runs on, and every caller closes its own window
/// before reaching this, so the waiter's post-lock snapshot carries the close
/// the winner just committed. Without that, two closes racing each see the
/// other's window standing and skip — the permanent `paused` in case (2) of
/// that function's docs.
pub async fn resume_runs_from_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Vec<ParkedRun>, DbError> {
    lock_driver_runs_in_tx(conn, workspace_id, session_id).await?;
    let rows = sqlx::query(&format!(
        "WITH driver AS ({RUN_DRIVES_SESSION} AND wc.session_id = $2), \
              held AS ( \
                SELECT DISTINCT l.run_id \
                  FROM ({RUN_DRIVES_SESSION}) l \
                  JOIN display_control_window w \
                    ON w.workspace_id = $1 \
                   AND w.work_session_id = l.session_id \
                   AND w.ended_at IS NULL \
                   AND w.lease_expires_at > clock_timestamp() \
              ) \
         UPDATE agent_run r \
            SET status = 'running'::run_status, \
                updated_at = now() \
           FROM driver d \
          WHERE r.workspace_id = $1 \
            AND r.id = d.run_id \
            AND r.status = 'paused' \
            AND NOT EXISTS (SELECT 1 FROM held h WHERE h.run_id = r.id) \
        RETURNING r.id, r.channel_id, r.agent_member_id"
    ))
    .bind(workspace_id)
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_parked)
        .collect::<Result<Vec<_>, _>>()
        .map_err(DbError::from)
}

/// Why a gateway completion was refused, or the status it resolved to — Swift
/// `normalizedCompletionStatus` (:1476-1495).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CompletionStatusError {
    /// 400 — `status: "succeeded"` together with a non-empty `error`. The two
    /// halves contradict each other, and guessing which one is true would either
    /// bill a failure as a success or lose the error.
    #[error("successful completion cannot include an error")]
    SuccessWithError,
    #[error("unknown gateway completion status")]
    Unknown,
}

/// Resolve the reported `(status, error)` pair to `succeeded` (`true`) or
/// `failed` (`false`).
///
/// The table is Swift's verbatim, including the two conveniences an adapter
/// relies on: an **omitted** status means "succeeded unless you sent an error",
/// and `cancelled`/`timed_out` reported *by the gateway* land on `failed` —
/// momo's own `cancelled` is a human act recorded elsewhere, so a gateway must
/// not be able to write it here.
pub fn completion_status(
    raw: Option<&str>,
    error: Option<&str>,
) -> Result<bool, CompletionStatusError> {
    let has_error = error.map(|value| !value.trim().is_empty()).unwrap_or(false);
    let status = raw.map(|value| value.trim().to_ascii_lowercase());
    match status.as_deref() {
        None | Some("") => Ok(!has_error),
        Some("failed" | "error" | "cancelled" | "timed_out") => Ok(false),
        Some("succeeded" | "success" | "done") => {
            if has_error {
                Err(CompletionStatusError::SuccessWithError)
            } else {
                Ok(true)
            }
        }
        Some(_) => Err(CompletionStatusError::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_run_status_label_round_trips() {
        for status in [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::AwaitingApproval,
            RunStatus::Paused,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
            RunStatus::TimedOut,
        ] {
            assert_eq!(RunStatus::from_db_label(status.as_db_label()), Some(status));
        }
        assert_eq!(RunStatus::from_db_label("nope"), None);
    }

    /// The three groups the gateway branches on must not overlap, or a run could
    /// be both "already finished" and "still accepting work".
    #[test]
    fn terminal_and_approval_held_are_disjoint_and_leave_the_live_pair() {
        for status in [
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
            RunStatus::TimedOut,
        ] {
            assert!(status.is_terminal());
            assert!(!status.is_approval_held());
        }
        for status in [RunStatus::AwaitingApproval, RunStatus::Paused] {
            assert!(status.is_approval_held());
            assert!(!status.is_terminal());
        }
        for status in [RunStatus::Queued, RunStatus::Running] {
            assert!(!status.is_terminal() && !status.is_approval_held());
        }
        // `LIVE` is the `agent_run_active_idx` predicate (001:293-295).
        assert_eq!(
            RunStatus::LIVE.map(RunStatus::as_db_label),
            ["queued", "running", "awaiting_approval", "paused"]
        );
    }

    /// Swift's `isCancellableRunStatus` set, and its complement: every terminal
    /// status must be **un**-cancellable, or the route's 409 arm becomes
    /// unreachable and a run that already succeeded would answer "stopped".
    #[test]
    fn only_a_live_run_can_be_stopped() {
        for status in [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::AwaitingApproval,
            RunStatus::Paused,
        ] {
            assert!(status.is_cancellable(), "{status:?} is stoppable");
        }
        for status in [
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
            RunStatus::TimedOut,
        ] {
            assert!(
                !status.is_cancellable(),
                "{status:?} is terminal — there is nothing left to stop"
            );
            assert!(status.is_terminal());
        }
        // Today the cancellable set and the live set coincide; the assertion is
        // written so that a future divergence is a decision someone made on
        // purpose rather than a silent one.
        assert_eq!(
            RunStatus::LIVE.map(RunStatus::as_db_label),
            ["queued", "running", "awaiting_approval", "paused"]
        );
        assert!(RunStatus::LIVE
            .iter()
            .copied()
            .all(RunStatus::is_cancellable));
    }

    /// #1425 gave `Paused` a writer. It gave it nothing else, and this is the
    /// assertion that says so.
    ///
    /// Every predicate below was already true before the control-window hold
    /// existed — `Paused` has been in the enum, in [`RunStatus::LIVE`], in
    /// `is_approval_held` and in `is_cancellable` since the approval batch, and
    /// the gateway's two doors (`agent_gateway`:345, :567) and the cancel route
    /// have been reading them all along. Parking a run therefore does not teach
    /// the system a new rule; it walks a run into rules that were waiting.
    ///
    /// That is exactly why this test is worth having. The tempting "cleanup"
    /// after this batch is to give the control-window hold a status of its own,
    /// or to drop `Paused` out of `is_approval_held` because "it is not an
    /// approval" — and either one silently reopens the gateway to a run whose
    /// screen a person is typing into, which is 「토큰 소진 0」 undone. The
    /// consequences are named here, in one place, so that change cannot be made
    /// by accident.
    #[test]
    fn the_control_window_hold_borrows_the_approval_holds_meaning_unchanged() {
        // The gateway refuses a held run on BOTH doors — that pair is what makes
        // 「토큰 소진 0」 a property of the ledger: no progress event, no
        // completion, and therefore no `usage_ledger` row.
        assert!(
            RunStatus::Paused.is_approval_held(),
            "the gateway's refusal is the enforcement; ADR-0004 증보 3 D6"
        );
        // A person may still stop a parked run. A hold that made 중지
        // unreachable would trap the run behind a window nobody has to close.
        assert!(RunStatus::Paused.is_cancellable());
        // …and the concurrency slot stays occupied, because the run is not over.
        assert!(RunStatus::LIVE.contains(&RunStatus::Paused));
        // It is not terminal, which is what makes the resume representable at
        // all: `resume_runs_from_control_window_in_tx` guards on `paused`.
        assert!(!RunStatus::Paused.is_terminal());

        // The park's guard and the resume's target are the same status, and it
        // is the one status that means "a turn is in flight". `queued` is
        // deliberately outside the pair (see the module comment above the two
        // statements), so an assertion that it stays a *separate* live status is
        // the guard against a future "tidy" that merges them.
        assert!(!RunStatus::Running.is_approval_held());
        assert!(!RunStatus::Queued.is_approval_held());
        assert_ne!(RunStatus::Queued, RunStatus::Running);

        // And the approval hold's own resume is still keyed to its own status,
        // so a control window can never satisfy an approval nobody answered.
        assert!(RunStatus::AwaitingApproval.is_approval_held());
        assert_ne!(RunStatus::AwaitingApproval, RunStatus::Paused);
    }

    /// One relation, read in two directions, spelled once.
    ///
    /// The park/resume pair and [`linked_work_session_ids_in_tx`] answer the two
    /// halves of the same question ("which sessions did this run touch" / "which
    /// runs touched this session"), and the day those become two different joins
    /// is the day a run is parked by a window that will never resume it. The
    /// fragment is asserted rather than merely shared so that editing it into
    /// something the other direction no longer matches is a red test.
    #[test]
    fn the_run_session_relation_is_the_audit_log_work_control_join() {
        for needle in [
            "audit_log",
            "work_control",
            "al.target_type = 'work_control'",
            "wc.id = al.target_id",
            "al.run_id IS NOT NULL",
            "wc.session_id IS NOT NULL",
        ] {
            assert!(
                RUN_DRIVES_SESSION.contains(needle),
                "the run↔session relation lost `{needle}`"
            );
        }
    }

    /// The whole idempotency contract in one assertion: same trigger → same key
    /// → (with the UNIQUE index) one run.
    #[test]
    fn the_same_trigger_yields_the_same_idempotency_key() {
        let message = Uuid::from_u128(11);
        let agent = Uuid::from_u128(12);
        let first = RunTrigger::Mention {
            message_id: message,
            agent_member_id: agent,
        };
        let retry = RunTrigger::Mention {
            message_id: message,
            agent_member_id: agent,
        };
        assert_eq!(first.idempotency_key(), retry.idempotency_key());
        assert!(first.idempotency_key().starts_with("mention:"));
        assert_eq!(first.trigger_message_id(), Some(message));

        // A different agent mentioned in the SAME message is a different run —
        // "@a @b do X" must start two.
        let other_agent = RunTrigger::Mention {
            message_id: message,
            agent_member_id: Uuid::from_u128(13),
        };
        assert_ne!(first.idempotency_key(), other_agent.idempotency_key());
    }

    #[test]
    fn a_work_trigger_keys_on_the_client_run_id_and_binds_no_message() {
        let work = RunTrigger::Work {
            channel_id: Uuid::from_u128(1),
            actor_member_id: Uuid::from_u128(2),
            agent_member_id: Uuid::from_u128(3),
            client_run_id: Uuid::from_u128(4),
        };
        assert!(work.idempotency_key().starts_with("work:"));
        assert_eq!(
            work.trigger_message_id(),
            None,
            "AgentRunRoutes.create leaves trigger_message_id NULL"
        );
        let resent = RunTrigger::Work {
            channel_id: Uuid::from_u128(1),
            actor_member_id: Uuid::from_u128(2),
            agent_member_id: Uuid::from_u128(3),
            client_run_id: Uuid::from_u128(4),
        };
        assert_eq!(work.idempotency_key(), resent.idempotency_key());
        let different_client_run = RunTrigger::Work {
            channel_id: Uuid::from_u128(1),
            actor_member_id: Uuid::from_u128(2),
            agent_member_id: Uuid::from_u128(3),
            client_run_id: Uuid::from_u128(5),
        };
        assert_ne!(
            work.idempotency_key(),
            different_client_run.idempotency_key()
        );
    }

    #[test]
    fn completion_status_matches_the_swift_table() {
        assert_eq!(completion_status(None, None), Ok(true));
        assert_eq!(completion_status(Some(""), None), Ok(true));
        assert_eq!(completion_status(None, Some("boom")), Ok(false));
        assert_eq!(
            completion_status(None, Some("   ")),
            Ok(true),
            "a whitespace-only error is no error"
        );
        for label in ["succeeded", "success", "done", "  DONE  "] {
            assert_eq!(completion_status(Some(label), None), Ok(true));
        }
        for label in ["failed", "error", "cancelled", "timed_out"] {
            assert_eq!(
                completion_status(Some(label), None),
                Ok(false),
                "a gateway-reported {label} is a failure, never momo's own cancellation"
            );
        }
        assert_eq!(
            completion_status(Some("succeeded"), Some("boom")),
            Err(CompletionStatusError::SuccessWithError)
        );
        assert_eq!(
            completion_status(Some("weird"), None),
            Err(CompletionStatusError::Unknown)
        );
    }

    #[test]
    fn completion_status_messages_match_swift() {
        assert_eq!(
            CompletionStatusError::SuccessWithError.to_string(),
            "successful completion cannot include an error"
        );
        assert_eq!(
            CompletionStatusError::Unknown.to_string(),
            "unknown gateway completion status"
        );
    }

    // ---- the read surfaces (#1223) ----------------------------------------

    /// The excerpt reads **both** trigger shapes, because both write the same
    /// column: a work run's `title` and a mention run's `prompt`.
    #[test]
    fn the_trigger_excerpt_covers_both_shapes_of_run() {
        assert_eq!(
            trigger_summary(&serde_json::json!({"type": "work", "title": "  배포 준비  "})),
            Some("배포 준비".to_string()),
            "trimmed, like the projection Swift computes in SQL"
        );
        assert_eq!(
            trigger_summary(&serde_json::json!({"surface": "mention", "prompt": "이거 고쳐줘"})),
            Some("이거 고쳐줘".to_string())
        );
    }

    /// An unrecognized input shape summarizes to **nothing**, and that is the
    /// safety property: reaching into an object nobody vetted is how a raw brief
    /// ends up in a list view of a room its author never posted to.
    #[test]
    fn an_unknown_input_shape_summarizes_to_nothing() {
        for input in [
            serde_json::json!({"type": "work", "title": "   "}),
            serde_json::json!({"type": "work"}),
            serde_json::json!({"type": "something_new", "title": "t", "secret": "s"}),
            serde_json::json!({"surface": "mention"}),
            serde_json::json!("a bare string"),
            serde_json::Value::Null,
        ] {
            assert_eq!(trigger_summary(&input), None, "{input}");
        }
    }

    /// The cap is on **characters**, not bytes: a Korean title truncated by byte
    /// length would either cut a syllable in half or overshoot the openapi
    /// `maxLength: 200` depending on which end you measured.
    #[test]
    fn the_excerpt_is_capped_in_characters() {
        let long = "가".repeat(TRIGGER_SUMMARY_LIMIT + 50);
        let summary = trigger_summary(&serde_json::json!({"type": "work", "title": long}))
            .expect("a long title still summarizes");
        assert_eq!(summary.chars().count(), TRIGGER_SUMMARY_LIMIT);
        assert!(summary.ends_with('가'), "no half-character at the boundary");
    }

    /// Swift's `validatedLimit` clamps rather than refuses, and an unparsable
    /// value falls back to the default: a client that sends `limit=all` gets a
    /// page it can render, not a 400 it cannot act on.
    #[test]
    fn the_limit_clamps_instead_of_refusing() {
        assert_eq!(validated_run_limit(None), 50);
        assert_eq!(validated_run_limit(Some("all")), 50, "unparsable = default");
        assert_eq!(validated_run_limit(Some(" 20 ")), 20);
        assert_eq!(validated_run_limit(Some("0")), 1, "the floor is one row");
        assert_eq!(validated_run_limit(Some("-5")), 1);
        assert_eq!(
            validated_run_limit(Some("100000")),
            200,
            "the ceiling is openapi's maximum, so a page cannot be asked to be a dump"
        );
    }
}
