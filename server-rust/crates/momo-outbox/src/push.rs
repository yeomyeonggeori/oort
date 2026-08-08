//! The `push_candidate` consumer feed (ADR-0120 D3, batch P2).
//!
//! Ports the claim + startup sweep from
//! `workers/NotifierWorker/.../NotifierService.swift:117-230`. It lives in
//! `momo-outbox` for the same reason [`relay`](crate::relay) and
//! [`gateway`](crate::gateway) do: these statements touch the `outbox` table,
//! and this crate is its sole owner (invariant #3). The notifier binary owns the
//! loop; it owns none of this SQL.
//!
//! **Feed exclusivity.** The four consumers partition `outbox` by
//! `(kind, method)` and can never drain each other:
//!
//! | consumer | `kind` | `method` |
//! |---|---|---|
//! | [`relay::claim_broadcast_batch`](crate::relay::claim_broadcast_batch) | `broadcast` | any |
//! | [`gateway::claim_gateway_jobs_in_tx`](crate::gateway::claim_gateway_jobs_in_tx) | `agent_job` | `gateway` |
//! | [`agent_job::claim_agent_job_batch`](crate::agent_job::claim_agent_job_batch) | `agent_job` | `publish` |
//! | [`claim_push_candidate_batch`] | `push_candidate` | any |
//!
//! The rows themselves are produced by the `push_candidate_enqueue_trg` AFTER
//! INSERT trigger on `message` (`011_push_notifier.sql:47-69`) — in the same
//! transaction as the source message, which is what makes a candidate
//! impossible to lose and impossible to observe before its message commits. No
//! application code emits this kind (see [`emit::OutboxKind::PushCandidate`](crate::emit::OutboxKind)).

use sqlx::PgPool;

/// A claimed `push_candidate` row, flipped to `processing`.
///
/// `workspace_id` rides along because the notifier is a BYPASSRLS consumer with
/// no tenant predicate on the claim: it learns the tenant *from the row*, then
/// re-enters RLS scope per candidate.
#[derive(Debug, Clone)]
pub struct ClaimedPushCandidate {
    pub id: i64,
    pub attempts: i32,
    pub workspace_id: uuid::Uuid,
    pub payload: String,
}

/// Claim up to `batch_size` pending `push_candidate` rows and flip them to
/// `processing` in one statement.
///
/// `FOR UPDATE SKIP LOCKED` makes the claim loss-free and keeps two notifier
/// instances off the same row — the same arbitration the relay and agent worker
/// use. `kind = 'push_candidate'` is the mutual-exclusion boundary.
pub async fn claim_push_candidate_batch(
    pool: &PgPool,
    batch_size: i64,
) -> Result<Vec<ClaimedPushCandidate>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i64, i32, uuid::Uuid, String)>(
        "WITH claimed AS ( \
             SELECT id FROM outbox \
              WHERE kind = 'push_candidate' \
                AND status = 'pending' \
                AND available_at <= now() \
              ORDER BY id \
              FOR UPDATE SKIP LOCKED \
              LIMIT $1 \
         ) \
         UPDATE outbox o \
            SET status = 'processing', attempts = o.attempts + 1 \
           FROM claimed c \
          WHERE o.id = c.id \
          RETURNING o.id, o.attempts, o.workspace_id, o.payload::text",
    )
    .bind(batch_size)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(
        |(id, attempts, workspace_id, payload)| ClaimedPushCandidate {
            id,
            attempts,
            workspace_id,
            payload,
        },
    )
    .collect();
    Ok(rows)
}

/// Return `push_candidate` rows stuck in `processing` to `pending`, once per
/// boot, before the drain loop starts. Returns how many were reclaimed.
///
/// A crash between claim and settle would otherwise strand a candidate forever.
/// This is safe *only* because dispatch is idempotent (the 011 partial unique
/// index on `push_dispatch_log`): a reclaimed candidate re-runs judgment and
/// skips every already-settled target.
///
/// Scoped strictly to `kind='push_candidate'` — the relay and agent worker own
/// their own recovery and must never be swept by this.
pub async fn reclaim_stuck_push_candidates(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE outbox \
            SET status = 'pending', available_at = now() \
          WHERE kind = 'push_candidate' \
            AND status = 'processing'",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
