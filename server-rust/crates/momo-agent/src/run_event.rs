//! The hosted-agent run event ledger — `agent_run_event` (migration 128,
//! ADR-0200 D2).
//!
//! **Who writes what.** The lifecycle rows (`queued`, `started`, `resumed`,
//! `paused`, the four terminals, `approval_requested`, `approval_decided`) are
//! written by AFTER triggers on `agent_run` and `approval`, so every producer is
//! covered by one rule in the same transaction. The two rows a trigger cannot
//! know — `claimed` (the lease lives on the outbox row) and `stage` (an agent
//! report) — are written here, through the same SQL function
//! `agent_run_event_append`, which takes no lock (a lock here closed deadlock cycles with the
//! claim/approve/cancel paths — migration 128) and folds an immediate stage repeat; the
//! 200-row cap is `agent_run_event_trim`, called right after a stage append. There is no other INSERT into the table.
//!
//! Only closed vocabulary and one validated ≤80 char stage marker are stored:
//! never `detail`, never `textDelta` (ADR-0200 D2).

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The two kinds server code (not a trigger) appends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendedRunEvent<'a> {
    /// A hosted `oort_jobs_claim` leased this run's job.
    Claimed,
    /// An agent-reported stage marker (`oort_run_event.stage`).
    Stage(&'a str),
}

/// Append one ledger row for `run_id`; returns its `seq`, or `None` when the run
/// does not exist (a job pointing at a missing run must not poison a claim). An
/// immediate repeat of the same stage folds into the existing row (the same fold
/// `output.stages` applies) and returns that row's seq. Takes no lock (migration 128).
///
/// `actor` is the agent member that did it. The caller must already be inside the
/// tenant transaction (`app.workspace_id` set); RLS rejects a foreign workspace.
pub async fn append_run_event_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    event: AppendedRunEvent<'_>,
    actor: Uuid,
) -> Result<Option<i64>, DbError> {
    let (kind, stage) = match event {
        AppendedRunEvent::Claimed => ("claimed", None),
        AppendedRunEvent::Stage(stage) => ("stage", Some(stage)),
    };
    let row = sqlx::query("SELECT agent_run_event_append($1, $2, $3, $4, NULL, NULL, $5) AS seq")
        .bind(workspace_id)
        .bind(run_id)
        .bind(kind)
        .bind(stage)
        .bind(actor)
        .fetch_one(&mut *conn)
        .await?;
    let seq: Option<i64> = row.try_get("seq")?;
    if kind == "stage" && seq.is_some() {
        // The 200-row cap is its own SQL function so the append (fired by triggers
        // under DELETE-less roles) never contains a DELETE.
        sqlx::query("SELECT agent_run_event_trim($1, $2)")
            .bind(workspace_id)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(seq)
}
