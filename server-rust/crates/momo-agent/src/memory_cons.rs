//! Team memory v2 M3 — the SQL half of the consolidation job (#3172, ADR-0196 D4/D6/D10, plan §6).
//!
//! Every call here is one worker-only SQL function of migration 107, run inside a memory tx
//! ([`crate::memory::with_memory_tx`]): `momo_worker` with `SET LOCAL ROLE momo_memory` and
//! `SET LOCAL app.workspace_id`. Nothing in this module reads a `mem_*` table directly and none of
//! it decides what may be changed — the database does: a curated/confirmed item is never merged,
//! closed or decayed automatically (it becomes a proposal), no pair from two channels is ever
//! consolidated, and every change writes a `mem_event` that carries what is needed to undo it.
//!
//! The worker (`consolidate.rs`) owns *when* and *what to ask the model*; the model only ever
//! answers one of three words per candidate pair ([`Verdict`]), so no model-written text is stored
//! by this job.
//!
//! ## Attribution
//!
//! The consolidation flow (candidate → judge → fold the losing observation into the winner, time
//! bounds preserved, everything logged) follows Hindsight's consolidation engine
//! (`hindsight_api/engine/consolidation/consolidator.py`, MIT, vectorize-io) and the interval
//! closing rule follows Graphiti's contradiction resolution (`graphiti_core/utils/maintenance/
//! edge_operations.py`, Apache-2.0, Zep). The algorithms were re-implemented over Postgres for
//! oort; no upstream code or prompt text is copied. See `NOTICE` and
//! `legal/THIRD_PARTY_NOTICES.md` (ADR-0196 D2).

use chrono::{DateTime, Utc};
use momo_db::{DbError, PgConnection, PgPool};
use sqlx::Row;
use uuid::Uuid;

/// Bumped when a judging prompt or a rule of the job changes; logged with the run.
pub const CONSOLIDATOR_VERSION: &str = "cons-v1";

/// The audit action written (throttled) when the consolidation job hits the daily token cap.
pub const AUDIT_CONSOLIDATE_TOKEN_CAP: &str = "mem.consolidate.token_cap_reached";

/// A candidate pair the database found: same channel, space and kind, both live, not judged yet.
/// `a` is the earlier one (`valid_from`).
#[derive(Debug, Clone)]
pub struct CandidatePair {
    pub a_id: Uuid,
    pub b_id: Uuid,
    pub kind: String,
    pub a_body: String,
    pub b_body: String,
    pub a_valid_from: DateTime<Utc>,
    pub b_valid_from: DateTime<Utc>,
    pub a_origin: String,
    pub b_origin: String,
    pub similarity: f32,
    pub same_subject: bool,
}

/// What the model may decide about a pair (and the only thing it decides).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The two say the same thing.
    Duplicate,
    /// The later decision replaces the earlier one.
    Supersedes,
    /// Two different things.
    Distinct,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Duplicate => "duplicate",
            Verdict::Supersedes => "supersedes",
            Verdict::Distinct => "distinct",
        }
    }
}

/// What `mem_cons_apply` did with a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    Merged,
    Closed,
    ProposedMerge,
    ProposedClose,
    Distinct,
    /// The state changed between the read and the write (an item retired, already judged, …).
    Skipped,
    /// A proposal was called for but the channel already has enough pending ones.
    Deferred,
}

impl ApplyOutcome {
    fn parse(text: &str) -> Option<ApplyOutcome> {
        Some(match text {
            "merged" => ApplyOutcome::Merged,
            "closed" => ApplyOutcome::Closed,
            "proposed_merge" => ApplyOutcome::ProposedMerge,
            "proposed_close" => ApplyOutcome::ProposedClose,
            "distinct" => ApplyOutcome::Distinct,
            "skipped" => ApplyOutcome::Skipped,
            "deferred" => ApplyOutcome::Deferred,
            _ => return None,
        })
    }
}

/// Take the channel's consolidation lease for today's slot. `false` = not due (already ran since
/// `slot_start`, still in a retry back-off) or another worker holds it.
pub async fn begin(
    conn: &mut PgConnection,
    channel_id: Uuid,
    lease_token: Uuid,
    lease_seconds: f64,
    slot_start: DateTime<Utc>,
) -> Result<bool, DbError> {
    Ok(
        sqlx::query_scalar("SELECT mem_cons_begin($1, $2, $3, $4)")
            .bind(channel_id)
            .bind(lease_token)
            .bind(lease_seconds)
            .bind(slot_start)
            .fetch_one(&mut *conn)
            .await?,
    )
}

/// Release the lease. `done` = today's slot is complete; otherwise retry after `retry_seconds`.
pub async fn finish(
    conn: &mut PgConnection,
    channel_id: Uuid,
    lease_token: Uuid,
    done: bool,
    retry_seconds: i32,
) -> Result<bool, DbError> {
    Ok(
        sqlx::query_scalar("SELECT mem_cons_finish($1, $2, $3, $4)")
            .bind(channel_id)
            .bind(lease_token)
            .bind(done)
            .bind(retry_seconds)
            .fetch_one(&mut *conn)
            .await?,
    )
}

/// Retire items whose evidence died (`source_deleted` / `source_edited`, D6-5). Returns the count.
pub async fn retire_dead(
    conn: &mut PgConnection,
    channel_id: Uuid,
    limit: i32,
) -> Result<i32, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_cons_retire_dead($1, $2)")
        .bind(channel_id)
        .bind(limit)
        .fetch_one(&mut *conn)
        .await?)
}

/// Decay: `forget_after` elapsed, never re-observed, origin extracted/synthesized only.
pub async fn decay(conn: &mut PgConnection, channel_id: Uuid, limit: i32) -> Result<i32, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_cons_decay($1, $2)")
        .bind(channel_id)
        .bind(limit)
        .fetch_one(&mut *conn)
        .await?)
}

/// Mark digests stale that still cite a message a forgotten item rested on. Returns the count.
pub async fn reconcile(conn: &mut PgConnection, channel_id: Uuid) -> Result<i32, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_cons_reconcile($1)")
        .bind(channel_id)
        .fetch_one(&mut *conn)
        .await?)
}

/// Candidate pairs, keyword-similarity signal. **The vector signal of #3173 joins here**: it will
/// extend `mem_cons_pairs` (a second `UNION` arm over `mem_item.embedding`), so the worker keeps
/// consuming one list of [`CandidatePair`] whatever produced them.
pub async fn candidate_pairs(
    conn: &mut PgConnection,
    channel_id: Uuid,
    merge_similarity: f32,
    close_similarity: f32,
    limit: i32,
) -> Result<Vec<CandidatePair>, DbError> {
    let rows = sqlx::query(
        "SELECT a_id, b_id, kind, a_body, b_body, a_valid_from, b_valid_from, a_origin, b_origin, \
                sim, same_subject FROM mem_cons_pairs($1, $2::real, $3::real, $4)",
    )
    .bind(channel_id)
    .bind(merge_similarity)
    .bind(close_similarity)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|row| CandidatePair {
            a_id: row.get("a_id"),
            b_id: row.get("b_id"),
            kind: row.get("kind"),
            a_body: row.get("a_body"),
            b_body: row.get("b_body"),
            a_valid_from: row.get("a_valid_from"),
            b_valid_from: row.get("b_valid_from"),
            a_origin: row.get("a_origin"),
            b_origin: row.get("b_origin"),
            similarity: row.get("sim"),
            same_subject: row.get("same_subject"),
        })
        .collect())
}

/// Apply one verdict. SQLSTATE `23514` = the pair is not consolidable (different channel, space or
/// kind); `55000` = the channel is switched off.
pub async fn apply_verdict(
    conn: &mut PgConnection,
    a: Uuid,
    b: Uuid,
    verdict: Verdict,
) -> Result<ApplyOutcome, DbError> {
    let text: String = sqlx::query_scalar("SELECT mem_cons_apply($1, $2, $3)")
        .bind(a)
        .bind(b)
        .bind(verdict.as_str())
        .fetch_one(&mut *conn)
        .await?;
    ApplyOutcome::parse(&text).ok_or_else(|| {
        DbError::from(sqlx::Error::Protocol(format!(
            "mem_cons_apply returned {text:?}"
        )))
    })
}

/// Retention (D10 / plan §6.3, §6.5): `(retired items deleted, covered window digests pruned)`.
pub async fn retention(
    conn: &mut PgConnection,
    channel_id: Uuid,
    retired_days: i32,
    window_days: i32,
    limit: i32,
) -> Result<(i32, i32), DbError> {
    let row = sqlx::query(
        "SELECT items_deleted, windows_pruned FROM mem_cons_retention($1, $2, $3, $4)",
    )
    .bind(channel_id)
    .bind(retired_days)
    .bind(window_days)
    .bind(limit)
    .fetch_one(&mut *conn)
    .await?;
    Ok((row.get("items_deleted"), row.get("windows_pruned")))
}

/// Delete pending proposals that expired, lost their evidence or match a forgotten hash.
pub async fn purge_proposals(conn: &mut PgConnection, channel_id: Uuid) -> Result<i32, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_cons_purge_proposals($1)")
        .bind(channel_id)
        .fetch_one(&mut *conn)
        .await?)
}

/// Undo one consolidation event (`merged`, `superseded`/contradiction, `retired`/decayed).
/// Returns which kind was undone.
pub async fn revert(conn: &mut PgConnection, event_id: Uuid) -> Result<String, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_cons_revert($1)")
        .bind(event_id)
        .fetch_one(&mut *conn)
        .await?)
}

/// The subset of `ids` that a forgotten item rested on: they must not feed a summary again.
pub async fn suppressed_messages(
    conn: &mut PgConnection,
    channel_id: Uuid,
    ids: &[Uuid],
) -> Result<Vec<Uuid>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(
        sqlx::query_scalar("SELECT mem_suppressed_messages($1, $2)")
            .bind(channel_id)
            .bind(ids)
            .fetch_all(&mut *conn)
            .await?,
    )
}

/// The channels one consolidation sweep looks at: `(workspace_id, channel_id)` across every tenant
/// (metadata only — no `mem_*`, no bodies; the same polling exception the summary loop's
/// `active_channels` holds). Order is shuffled per UTC day so a cap smaller than the number of
/// channels does not always starve the same ones. Archived channels are included: their retired
/// items and dead evidence still have to be cleaned up.
pub async fn consolidation_channels(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<(Uuid, Uuid)>, DbError> {
    let rows = sqlx::query(
        "SELECT cs.workspace_id, cs.channel_id FROM channel_seq cs \
          WHERE cs.last_seq > 0 \
          ORDER BY md5(cs.channel_id::text || (now() AT TIME ZONE 'UTC')::date::text) \
          LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| (row.get("workspace_id"), row.get("channel_id")))
        .collect())
}
