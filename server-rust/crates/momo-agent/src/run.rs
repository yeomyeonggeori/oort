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
                r.trigger_message_id, a.model, \
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
}
