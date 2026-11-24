//! The agent's **status reactions** — 👀 while it holds the job, ✅ once the run succeeded
//! (ADR-0200 증보 8, #6067).
//!
//! The server derives both from the run's state and writes them **under the agent member's name**;
//! the agent never chooses them (L1, L11). Every function here takes a connection that is already
//! inside the tenant transaction of the state change that causes it, and writes through the same
//! `reaction` table and the same `reaction.added` / `reaction.removed` outbox frame the REST
//! path writes (L7, LA11), so a shipped client draws them unchanged.
//!
//! ## The rule is a state, not a list of functions (L4)
//!
//! An eye on (message, agent) means "a run of this agent that this message started is **taken**
//! right now". *Taken* is D1's phase: the run is `running` / `awaiting_approval` / `paused`, or
//! it is `queued` while its gateway job holds a lease (`claimed` — the same reading
//! `momo_agent::run_progress` gives: `RunStatus::Queued if leased => RunPhase::Claimed`). So:
//!
//! * [`on_run_taken_in_tx`] — called by the tx that records the take (a hosted claim, a
//!   `queued → running` start) — **adds** the eye, at most [`MAX_EYE_ATTACHES_PER_RUN`] times a run;
//! * [`on_run_released_in_tx`] / [`on_agent_jobs_released_in_tx`] — a lease handed back, jobs
//!   suppressed — and [`on_run_terminal_in_tx`] — every terminal write — **remove** it unless
//!   another run of the same (message, agent) is still taken; a terminal `succeeded` adds ✅;
//! * [`sweep_settled_eyes_in_tx`] is the api's follow-up removal for the two terminal writes the
//!   notifier makes (L7 5): it starts **from the eye rows**, with no time window, so an api that
//!   was down for a day still finds the run that ended a day ago.
//!
//! The terminal writers are closed by a static list (`tests/status_reaction_writers.rs` in
//! `momo-server`): each statement that writes a terminal `agent_run.status` is classified as
//! "removes in the same tx" or "left to the follow-up removal", and only the notifier's two are
//! the latter.
//!
//! ## One lock, judged after it (N2)
//!
//! The add, the remove and the follow-up all take the **message row lock first, in a statement of
//! its own**, and only then judge "is a run of this (message, agent) taken?" in a fresh statement.
//! Under READ COMMITTED the statement after a lock wait sees what the winner committed, so a
//! follow-up removal racing a re-claim of the same message either runs first (and the claim then
//! adds a fresh eye) or runs second and sees the claim (and keeps the eye). It never removes the
//! eye of a run that is alive. Lock order everywhere here: (the caller's own run / outbox locks) →
//! `message` → `agent_run` with `SKIP LOCKED` for the per-run count, so this module never waits on
//! a run row another transaction holds (the claim path holds the outbox row and must not wait on
//! a run a cancel holds — migration 128's deadlock).
//!
//! ## Never in the way of the run (L7 3)
//!
//! Every write is inside a savepoint. A refusal (a deleted message, the 200-reaction cap, an agent
//! that left the channel) writes nothing; a database error rolls back to the savepoint. Either way
//! the caller's transaction — the run's terminal status, its final answer — commits as it would
//! have without this module.
//!
//! ## No notification (L8)
//!
//! A reaction consumes no `seq`, touches no `message` row and makes no push candidate, inbox row
//! or unread (the reaction path's own invariants — see [`crate::interaction`]). Nothing here
//! creates a run (L14).

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::AgentReactionsMode;
use serde_json::json;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::identity::is_channel_member;
use crate::interaction::{
    build_reaction_payload, lock_message_in_tx, ReactionAction, ReactionDelta,
    MESSAGE_REACTION_LIMIT,
};

/// The eye: "the agent holds this job right now" (L1, L3).
pub const STATUS_EYE: &str = "\u{1F440}";
/// The check: "a run this message started succeeded" (L1, L5).
pub const STATUS_CHECK: &str = "\u{2705}";
/// L3 (owner 값 ⑤): the server adds an eye to one run at most this many times. A run's status
/// reaction frames are therefore at most seven (three adds, three removes, one check — LA4).
pub const MAX_EYE_ATTACHES_PER_RUN: i16 = 3;
/// `detail.derived` on every audit row this module writes (L9, LA8).
pub const DERIVED_RUN_LIFECYCLE: &str = "run_lifecycle";
/// How late the follow-up removal may be (L7 5, owner 값 ⑥): the api's tick runs well inside it.
pub const FOLLOW_UP_REMOVAL_BOUND_SECS: u64 = 60;

/// The phase predicate "this run is taken" (D1), as SQL over a row aliased `r`. One definition for
/// every reader in this module.
const RUN_IS_TAKEN: &str = "(r.status IN ('running', 'awaiting_approval', 'paused') \
    OR (r.status = 'queued' AND EXISTS ( \
          SELECT 1 FROM outbox o \
           WHERE o.workspace_id = r.workspace_id \
             AND o.kind = 'agent_job' \
             AND o.method = 'gateway' \
             AND o.status = 'pending' \
             AND lower(o.payload->>'run_id') = r.id::text \
             AND o.lease_owner IS NOT NULL)))";

/// What one call did — for tests and for a caller that wants to count. Callers on the run's own
/// path ignore it: nothing here may decide the run's outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StatusReactionOutcome {
    pub eye_added: bool,
    pub eye_removed: bool,
    pub check_added: bool,
    /// A database error was rolled back to the savepoint (the caller's transaction goes on).
    pub rolled_back: bool,
}

/// The run facts every entry point needs.
struct RunFacts {
    trigger_message_id: Option<Uuid>,
    agent_member_id: Uuid,
    status: String,
}

async fn run_facts(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Option<RunFacts>, DbError> {
    let row = sqlx::query(
        "SELECT trigger_message_id, agent_member_id, status::text AS status \
           FROM agent_run WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(RunFacts {
        trigger_message_id: row.try_get("trigger_message_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        status: row.try_get("status")?,
    }))
}

/// The effective switch for one agent (L10): the narrower of the workspace's settings key and the
/// agent's own column. A missing agent row reads as off.
pub async fn effective_mode_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<AgentReactionsMode, DbError> {
    let settings = momo_settings::read_workspace_settings(&mut *conn, workspace_id).await?;
    let workspace = AgentReactionsMode::from_workspace_settings(settings.as_ref());
    let agent: Option<Option<String>> = sqlx::query_scalar(
        "SELECT agent_reactions FROM agent WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(agent) = agent else {
        return Ok(AgentReactionsMode::Off);
    };
    // A stored word outside the three cannot pass the column's CHECK; read it as off anyway.
    let agent =
        agent.map(|word| AgentReactionsMode::from_wire(&word).unwrap_or(AgentReactionsMode::Off));
    Ok(AgentReactionsMode::effective(workspace, agent))
}

/// Is any run of this (message, agent) taken right now? Judged in its own statement, after the
/// caller took the message lock.
async fn pair_is_taken(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM agent_run r \
           WHERE r.workspace_id = $1 AND r.trigger_message_id = $2 \
             AND r.agent_member_id = $3 AND {RUN_IS_TAKEN})"
    ))
    .bind(workspace_id)
    .bind(message_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?)
}

async fn run_is_taken(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM agent_run r \
           WHERE r.workspace_id = $1 AND r.id = $2 AND {RUN_IS_TAKEN})"
    ))
    .bind(workspace_id)
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// Write the frame and the audit row of one change this module made (L7, L9).
#[allow(clippy::too_many_arguments)]
async fn announce(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    message_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    seq: i64,
    emoji: &str,
    action: ReactionAction,
) -> Result<(), DbError> {
    let delta = ReactionDelta {
        action,
        message_id,
        member_id: agent_member_id,
        emoji: emoji.to_string(),
        seq,
        channel_id,
        changed: true,
    };
    let payload = build_reaction_payload(workspace_id, &delta);
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(channel_id),
    )
    .await?;
    let event = format!("reaction.{}", action.as_wire_label());
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, event.clone())
            .by(agent_member_id)
            .about_optional(None)
            .target("message", message_id)
            .run(run_id)
            .with_schema(
                "momo.message_interaction.v1",
                json!({
                    "channel_id": channel_id,
                    "event_type": event,
                    "derived": DERIVED_RUN_LIFECYCLE,
                    "run_id": run_id,
                }),
            ),
    )
    .await?;
    Ok(())
}

/// Run `body` inside a savepoint: an error rolls back to it and is reported as
/// [`StatusReactionOutcome::rolled_back`], never to the caller.
async fn in_savepoint<F>(conn: &mut PgConnection, body: F) -> Result<StatusReactionOutcome, DbError>
where
    F: for<'c> FnOnce(
        &'c mut PgConnection,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<StatusReactionOutcome, DbError>> + Send + 'c>,
    >,
{
    sqlx::query("SAVEPOINT momo_status_reaction")
        .execute(&mut *conn)
        .await?;
    match body(&mut *conn).await {
        Ok(outcome) => {
            sqlx::query("RELEASE SAVEPOINT momo_status_reaction")
                .execute(&mut *conn)
                .await?;
            Ok(outcome)
        }
        Err(_) => {
            sqlx::query("ROLLBACK TO SAVEPOINT momo_status_reaction")
                .execute(&mut *conn)
                .await?;
            sqlx::query("RELEASE SAVEPOINT momo_status_reaction")
                .execute(&mut *conn)
                .await?;
            Ok(StatusReactionOutcome {
                rolled_back: true,
                ..StatusReactionOutcome::default()
            })
        }
    }
}

/// Remove the eye of (message, agent) unless a run of that pair is still taken. Membership and the
/// switch are **not** read (L7 2, L10 「끔은 달기만 막는다」). Caller is inside a savepoint.
async fn remove_eye_unless_taken(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    message_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    // The lock first, alone; the judgement after it, in a fresh statement (N2).
    let Some(locked) = lock_message_in_tx(&mut *conn, message_id).await? else {
        return Ok(false);
    };
    if pair_is_taken(&mut *conn, workspace_id, message_id, agent_member_id).await? {
        return Ok(false);
    }
    let removed: Option<Uuid> = sqlx::query_scalar(
        "DELETE FROM reaction \
          WHERE workspace_id = $1 AND message_id = $2 AND member_id = $3 AND emoji = $4 \
        RETURNING id",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(agent_member_id)
    .bind(STATUS_EYE)
    .fetch_optional(&mut *conn)
    .await?;
    if removed.is_none() {
        return Ok(false);
    }
    announce(
        conn,
        workspace_id,
        run_id,
        message_id,
        agent_member_id,
        locked.channel_id,
        locked.seq,
        STATUS_EYE,
        ReactionAction::Removed,
    )
    .await?;
    Ok(true)
}

/// Add `emoji` for the agent if the message and the channel allow it (L7 1). `Ok(None)` = refused
/// or already there (nothing written). Caller holds the message lock and is inside a savepoint.
async fn insert_if_allowed(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    agent_member_id: Uuid,
    emoji: &str,
) -> Result<Option<(Uuid, i64)>, DbError> {
    let Some(locked) = lock_message_in_tx(&mut *conn, message_id).await? else {
        return Ok(None);
    };
    if locked.is_deleted() {
        return Ok(None);
    }
    if !is_channel_member(&mut *conn, locked.channel_id, agent_member_id).await? {
        return Ok(None);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM reaction WHERE message_id = $1")
        .bind(message_id)
        .fetch_one(&mut *conn)
        .await?;
    if count >= MESSAGE_REACTION_LIMIT {
        return Ok(None);
    }
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO reaction (workspace_id, message_id, member_id, emoji) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (message_id, member_id, emoji) DO NOTHING \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(agent_member_id)
    .bind(emoji)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(inserted.map(|_| (locked.channel_id, locked.seq)))
}

/// The take was recorded in this transaction (L3): add the eye if the switch allows it, the
/// message is the run's trigger and still there, the agent is in the channel, and this run has
/// not used its [`MAX_EYE_ATTACHES_PER_RUN`] adds. An eye already there (another run of the same
/// pair) is left and not counted.
pub async fn on_run_taken_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<StatusReactionOutcome, DbError> {
    in_savepoint(conn, move |conn| {
        Box::pin(async move {
            let mut outcome = StatusReactionOutcome::default();
            let Some(run) = run_facts(conn, workspace_id, run_id).await? else {
                return Ok(outcome);
            };
            let Some(message_id) = run.trigger_message_id else {
                return Ok(outcome);
            };
            if effective_mode_in_tx(conn, workspace_id, run.agent_member_id).await?
                == AgentReactionsMode::Off
            {
                return Ok(outcome);
            }
            // The lock, then the judgement (the run must be taken as of now).
            if lock_message_in_tx(&mut *conn, message_id).await?.is_none() {
                return Ok(outcome);
            }
            if !run_is_taken(conn, workspace_id, run_id).await? {
                return Ok(outcome);
            }
            let Some((channel_id, seq)) =
                insert_if_allowed(conn, workspace_id, message_id, run.agent_member_id, STATUS_EYE)
                    .await?
            else {
                return Ok(outcome);
            };
            // The per-run cap, counted on the run row. SKIP LOCKED: never wait on a run row
            // another transaction holds (module docs) — a skipped count is a skipped eye.
            let counted: Option<i16> = sqlx::query_scalar(
                "UPDATE agent_run SET status_eye_attach_count = status_eye_attach_count + 1 \
                  WHERE id = ( \
                    SELECT id FROM agent_run \
                     WHERE workspace_id = $1 AND id = $2 \
                       AND status_eye_attach_count < $3 \
                     FOR UPDATE SKIP LOCKED) \
                RETURNING status_eye_attach_count",
            )
            .bind(workspace_id)
            .bind(run_id)
            .bind(MAX_EYE_ATTACHES_PER_RUN)
            .fetch_optional(&mut *conn)
            .await?;
            if counted.is_none() {
                // Over the cap (or the row is busy): undo the insert, add nothing.
                sqlx::query(
                    "DELETE FROM reaction \
                      WHERE workspace_id = $1 AND message_id = $2 AND member_id = $3 AND emoji = $4",
                )
                .bind(workspace_id)
                .bind(message_id)
                .bind(run.agent_member_id)
                .bind(STATUS_EYE)
                .execute(&mut *conn)
                .await?;
                return Ok(outcome);
            }
            announce(
                conn,
                workspace_id,
                run_id,
                message_id,
                run.agent_member_id,
                channel_id,
                seq,
                STATUS_EYE,
                ReactionAction::Added,
            )
            .await?;
            outcome.eye_added = true;
            Ok(outcome)
        })
    })
    .await
}

/// The run's job lease was handed back (D1: the run reads `queued` again) — remove the eye unless
/// another run of the pair is taken.
pub async fn on_run_released_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<StatusReactionOutcome, DbError> {
    in_savepoint(conn, move |conn| {
        Box::pin(async move {
            let mut outcome = StatusReactionOutcome::default();
            let Some(run) = run_facts(conn, workspace_id, run_id).await? else {
                return Ok(outcome);
            };
            let Some(message_id) = run.trigger_message_id else {
                return Ok(outcome);
            };
            outcome.eye_removed = remove_eye_unless_taken(
                conn,
                workspace_id,
                run_id,
                message_id,
                run.agent_member_id,
            )
            .await?;
            Ok(outcome)
        })
    })
    .await
}

/// A terminal status was written for `run_id` in this transaction (L4): remove the eye (unless
/// another run of the pair is taken) and, for `succeeded`, add the check (L5 — once per pair, the
/// unique key makes a replayed completion a no-op). A run that is not terminal is left alone, so a
/// caller whose guarded update moved nothing may still call this.
pub async fn on_run_terminal_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<StatusReactionOutcome, DbError> {
    in_savepoint(conn, move |conn| {
        Box::pin(async move {
            let mut outcome = StatusReactionOutcome::default();
            let Some(run) = run_facts(conn, workspace_id, run_id).await? else {
                return Ok(outcome);
            };
            let Some(message_id) = run.trigger_message_id else {
                return Ok(outcome);
            };
            if !matches!(
                run.status.as_str(),
                "succeeded" | "failed" | "cancelled" | "timed_out"
            ) {
                return Ok(outcome);
            }
            outcome.eye_removed = remove_eye_unless_taken(
                conn,
                workspace_id,
                run_id,
                message_id,
                run.agent_member_id,
            )
            .await?;
            if run.status == "succeeded"
                && effective_mode_in_tx(conn, workspace_id, run.agent_member_id).await?
                    != AgentReactionsMode::Off
            {
                if let Some((channel_id, seq)) = insert_if_allowed(
                    conn,
                    workspace_id,
                    message_id,
                    run.agent_member_id,
                    STATUS_CHECK,
                )
                .await?
                {
                    announce(
                        conn,
                        workspace_id,
                        run_id,
                        message_id,
                        run.agent_member_id,
                        channel_id,
                        seq,
                        STATUS_CHECK,
                        ReactionAction::Added,
                    )
                    .await?;
                    outcome.check_added = true;
                }
            }
            Ok(outcome)
        })
    })
    .await
}

/// [`on_run_terminal_in_tx`] for each run of a batched terminal write (one savepoint each).
pub async fn on_runs_terminal_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_ids: &[Uuid],
) -> Result<(), DbError> {
    for run_id in run_ids {
        on_run_terminal_in_tx(&mut *conn, workspace_id, *run_id).await?;
    }
    Ok(())
}

/// Leases or jobs of one agent were dropped in bulk (a disconnect, a connector closure): walk the
/// agent's eyes in this workspace and remove each one no run of its pair still takes.
pub async fn on_agent_jobs_released_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<u64, DbError> {
    let pairs = settled_eye_pairs(conn, workspace_id, Some(agent_member_id), i64::MAX).await?;
    remove_pairs(conn, workspace_id, &pairs).await
}

/// One (message, agent, run) whose eye no taken run holds any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettledEye {
    pub message_id: Uuid,
    pub agent_member_id: Uuid,
    /// The newest run of the pair — the run the audit row names.
    pub run_id: Uuid,
}

async fn settled_eye_pairs(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Option<Uuid>,
    limit: i64,
) -> Result<Vec<SettledEye>, DbError> {
    // From the eye rows themselves — no time window (N2: an api that was down long still finds
    // the run that ended long ago). Only eyes of an agent on a message one of its runs started:
    // a person's 👀 never matches, and an agent cannot choose 👀 itself (L11).
    let rows = sqlx::query(&format!(
        "SELECT re.message_id, re.member_id, latest.id AS run_id \
           FROM reaction re \
           CROSS JOIN LATERAL ( \
             SELECT r.id FROM agent_run r \
              WHERE r.workspace_id = re.workspace_id \
                AND r.trigger_message_id = re.message_id \
                AND r.agent_member_id = re.member_id \
              ORDER BY r.created_at DESC, r.id DESC LIMIT 1) latest \
          WHERE re.workspace_id = $1 AND re.emoji = $2 \
            AND ($3::uuid IS NULL OR re.member_id = $3) \
            AND NOT EXISTS ( \
              SELECT 1 FROM agent_run r \
               WHERE r.workspace_id = re.workspace_id \
                 AND r.trigger_message_id = re.message_id \
                 AND r.agent_member_id = re.member_id \
                 AND {RUN_IS_TAKEN}) \
          ORDER BY re.message_id, re.member_id \
          LIMIT $4"
    ))
    .bind(workspace_id)
    .bind(STATUS_EYE)
    .bind(agent_member_id)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(SettledEye {
                message_id: row.try_get("message_id")?,
                agent_member_id: row.try_get("member_id")?,
                run_id: row.try_get("run_id")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

async fn remove_pairs(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    pairs: &[SettledEye],
) -> Result<u64, DbError> {
    let mut removed = 0;
    for pair in pairs {
        let pair = *pair;
        let outcome = in_savepoint(&mut *conn, move |conn| {
            Box::pin(async move {
                Ok(StatusReactionOutcome {
                    eye_removed: remove_eye_unless_taken(
                        conn,
                        workspace_id,
                        pair.run_id,
                        pair.message_id,
                        pair.agent_member_id,
                    )
                    .await?,
                    ..StatusReactionOutcome::default()
                })
            })
        })
        .await?;
        if outcome.eye_removed {
            removed += 1;
        }
    }
    Ok(removed)
}

/// The api's follow-up removal for one workspace (L7 5, LA13): up to `limit` eyes whose pair no
/// taken run holds — in practice the runs the notifier ended (approval expiry, abandoned lease),
/// which it may not remove itself (L7 4). Same removal as the terminal path: idempotent, no
/// membership or switch read, the same frame and audit row. The caller is the api's own
/// RLS-bound tenant transaction (`SET LOCAL app.workspace_id`).
pub async fn sweep_settled_eyes_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    limit: i64,
) -> Result<u64, DbError> {
    let pairs = settled_eye_pairs(conn, workspace_id, None, limit).await?;
    remove_pairs(conn, workspace_id, &pairs).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_reading_closes_anything_but_the_three_words() {
        assert_eq!(
            AgentReactionsMode::from_workspace_settings(Some(&json!({}))),
            AgentReactionsMode::Status
        );
        for (stored, read) in [
            (json!("off"), AgentReactionsMode::Off),
            (json!("status"), AgentReactionsMode::Status),
            (json!("free"), AgentReactionsMode::Free),
            (json!(true), AgentReactionsMode::Off),
            (json!(""), AgentReactionsMode::Off),
            (json!("on"), AgentReactionsMode::Off),
            (json!("FREE"), AgentReactionsMode::Off),
        ] {
            assert_eq!(
                AgentReactionsMode::from_workspace_settings(Some(
                    &json!({ "agent_reactions": stored })
                )),
                read,
                "{stored}"
            );
        }
        assert_eq!(
            AgentReactionsMode::from_workspace_settings(None),
            AgentReactionsMode::Off
        );
    }

    #[test]
    fn the_agent_value_only_narrows() {
        use AgentReactionsMode::*;
        assert_eq!(AgentReactionsMode::effective(Status, Some(Free)), Status);
        assert_eq!(AgentReactionsMode::effective(Free, Some(Status)), Status);
        assert_eq!(AgentReactionsMode::effective(Free, Some(Off)), Off);
        assert_eq!(AgentReactionsMode::effective(Off, Some(Free)), Off);
        assert_eq!(AgentReactionsMode::effective(Free, None), Free);
    }

    #[test]
    fn the_status_emoji_are_the_canonical_scalars() {
        assert_eq!(STATUS_EYE, "👀");
        assert_eq!(STATUS_CHECK, "✅");
    }
}
