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
//! 200-row cap is `agent_run_event_trim`, called after every server-side append here (stage or claimed). There is no other INSERT into the table.
//!
//! `seq` is an ordering key from a global sequence (gaps, cross-tenant): callers must
//! not hand it to a client as a count (migration 128).
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
    if seq.is_some() {
        // The 200-row cap is its own SQL function so the append (fired by triggers
        // under DELETE-less roles) never contains a DELETE. Called after EVERY
        // server-side append — a run that only ever re-claims (no stage) is bounded too.
        sqlx::query("SELECT agent_run_event_trim($1, $2)")
            .bind(workspace_id)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(seq)
}

/// How long a FINISHED run's ledger is kept (ADR-0200 D2). The same number as the
/// shared-session payload retention (`momo_t3::work_share::SHARE_RETENTION_DAYS`, ADR-0162
/// 증보 3 D13); a read past it answers an empty ledger without waiting for the sweep.
pub const RUN_EVENT_RETENTION_DAYS: i32 = 30;

/// Workspaces that hold at least one ledger row of a run finished past retention — the
/// cross-tenant **read** half of the retention sweep (the caller connects as the
/// BYPASSRLS notifier role, which holds SELECT only). Runs still in progress are never
/// candidates.
pub async fn workspaces_with_expired_run_events(
    conn: &mut PgConnection,
    limit: i64,
) -> Result<Vec<Uuid>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT workspace_id FROM ( \
           SELECT r.workspace_id FROM agent_run r \
            WHERE r.finished_at IS NOT NULL \
              AND r.finished_at < clock_timestamp() - make_interval(days => $1) \
              AND EXISTS (SELECT 1 FROM agent_run_event e \
                           WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id) \
            LIMIT $2) expired",
    )
    .bind(RUN_EVENT_RETENTION_DAYS)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?)
}

/// Delete up to `batch` ledger rows of runs finished past retention in this workspace
/// (the **write** half: the caller is the RLS-bound `momo_app` pool). Idempotent, bounded,
/// and `SKIP LOCKED` so two sweeps never fight over a row.
pub async fn delete_expired_run_events_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    batch: i64,
) -> Result<u64, DbError> {
    let deleted = sqlx::query(
        "WITH doomed AS MATERIALIZED ( \
           SELECT e.workspace_id, e.run_id, e.seq \
             FROM agent_run_event e \
             JOIN agent_run r ON r.workspace_id = e.workspace_id AND r.id = e.run_id \
            WHERE e.workspace_id = $1 \
              AND r.finished_at IS NOT NULL \
              AND r.finished_at < clock_timestamp() - make_interval(days => $2) \
            ORDER BY r.finished_at \
            LIMIT $3 \
              FOR UPDATE OF e SKIP LOCKED) \
         DELETE FROM agent_run_event t USING doomed d \
          WHERE t.workspace_id = d.workspace_id AND t.run_id = d.run_id AND t.seq = d.seq",
    )
    .bind(workspace_id)
    .bind(RUN_EVENT_RETENTION_DAYS)
    .bind(batch)
    .execute(&mut *conn)
    .await?;
    Ok(deleted.rows_affected())
}
