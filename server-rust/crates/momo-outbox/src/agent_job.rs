//! The worker-side `agent_job` claim — the third consumer feed (B5.1).
//!
//! [`crate::relay`] owns the `broadcast` claim and [`crate::gateway`] owns the
//! *leased* `agent_job` claim an external gateway polls over HTTP. This module
//! owns the remaining one: the in-process **worker** claim that Swift
//! `workers/AgentWorker/.../WorkerService.claimOne()` (:159-186) performs, i.e.
//! the jobs the server enqueues with `method='publish'`
//! (`MessageRoutes.swift:2090-2100`, `jobMethod = agentGateway.enabled ?
//! "gateway" : "publish"`).
//!
//! It lives here for the same reason the other two do: `momo-outbox` is the one
//! crate allowed to contain `outbox` SQL (invariant #3), so the arrival of a
//! third consumer must not scatter a third claim statement across the workspace.
//!
//! ## The three claims cannot drain each other
//!
//! | claim | `kind` | `method` |
//! |---|---|---|
//! | [`crate::relay::claim_broadcast_batch`] | `broadcast` | any |
//! | [`crate::gateway::claim_gateway_jobs_in_tx`] | `agent_job` | `= 'gateway'` |
//! | [`claim_agent_job_batch`] | `agent_job` | `= 'publish'` |
//!
//! The worker predicate is `method = 'publish'` rather than Swift's
//! `method <> 'gateway'` — deliberately *narrower*. Swift's own `<>` form also
//! swallows `method='resume_approval'` rows, which it then routes to its
//! approval-resume path; that path is not ported in B5.1, so an equality
//! predicate leaves those rows untouched for their future consumer instead of
//! claiming work this binary would have to fail.
//!
//! ## Why per-agent serialization is in the SQL, not in the loop
//!
//! L4 §3.5 makes `partition_key = agent_member_id` the per-agent serialization
//! key. Swift approximates it with `LIMIT 1` inside a single-threaded drain
//! loop, which holds only while exactly one worker process exists — two workers
//! (or one worker with a batch) would run two turns for the same agent at once
//! and interleave two answers into one conversation.
//!
//! [`claim_agent_job_batch`] makes the guarantee structural instead, with two
//! predicates that together admit **at most one in-flight job per
//! `partition_key`**:
//!
//! * `NOT EXISTS (… status = 'processing' AND partition_key IS NOT DISTINCT
//!   FROM o.partition_key)` — an agent that already has a claimed job is not
//!   eligible at all, across processes;
//! * `row_number() OVER (PARTITION BY o.partition_key ORDER BY o.id) = 1` —
//!   within one batch only the *oldest* pending job of each agent is a
//!   candidate, so a batch cannot do what a second process is forbidden to do.
//!
//! Two claimers racing on the same agent resolve through `FOR UPDATE … SKIP
//! LOCKED`: the loser skips the row-locked rank-1 job, and rank 2 was never in
//! its candidate set, so it claims nothing for that agent rather than the
//! *next* job. `IS NOT DISTINCT FROM` (not `=`) is what makes a NULL
//! `partition_key` group with the other NULLs instead of matching nothing —
//! a job with no partition key is serialized conservatively rather than
//! unbounded.
//!
//! ## Why the claim also takes a lease
//!
//! Serialization has a cost the broadcast claim does not pay: if a worker dies
//! between the claim and the settle, its row stays `processing` forever, and the
//! `NOT EXISTS` above would then block **every future job for that agent**, not
//! just lose one. A crash would silence an agent permanently.
//!
//! Migration 008 already put the answer on the `outbox` row — its header states
//! it exactly: "these columns make that claim durable so overlapping consumers
//! cannot both start provider work, while an expired owner can be taken over
//! after a crash". So this claim writes `lease_owner`/`lease_acquired_at`/
//! `lease_expires_at` like the gateway one, and:
//!
//! * only a **live** lease blocks its partition, so a dead worker's grip expires
//!   on its own with no reaper;
//! * an **expired-lease `processing`** row is itself claimable again, so the
//!   turn is retried rather than lost (`attempts` still increments, so
//!   `max_attempts` continues to bound it).
//!
//! A `processing` row with **no** lease at all keeps blocking — that is another
//! consumer's in-flight job (a Swift AgentWorker sets no lease), and refusing to
//! run beside it is the whole point of per-agent serialization.
//!
//! The lease must outlast a turn (provider timeout plus commit), so it is a
//! caller parameter with a deliberately generous default,
//! [`DEFAULT_WORKER_LEASE_SECONDS`]. Overrunning it is safe rather than
//! corrupting: a taken-over turn re-posts through the same `client_msg_id`
//! idempotency and the same `usage_ledger` `NOT EXISTS`, so it costs a second
//! provider call, not a second answer or a second charge.
//!
//! Settlement reuses [`crate::relay`]'s `mark_done` / `mark_failed` / `requeue`
//! / `backoff_seconds`: those statements address a row by `id` and are already
//! kind-agnostic, so a second copy would only be a second thing to drift. None
//! of them needs to clear the lease — the predicate only ever looks at rows that
//! are still `processing`.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// `outbox.method` for the jobs this worker consumes (Swift
/// `MessageRoutes.swift:2091`).
pub const WORKER_JOB_METHOD: &str = "publish";

/// How long a claimed turn holds its agent's partition before another worker may
/// take it over. Comfortably longer than the Swift transport's 120 s request
/// ceiling (`HermesTransport.requestTimeout`) plus the commit, so a slow-but-live
/// turn is never taken over in practice.
pub const DEFAULT_WORKER_LEASE_SECONDS: i64 = 300;

/// A claimed `agent_job` row, flipped to `processing` and ready to run.
///
/// Carries more than [`crate::relay::ClaimedRow`] because an agent turn needs
/// its tenant (`workspace_id`, for the RLS GUC) and its serialization key
/// (`partition_key = agent_member_id`) before the payload is even parsed.
#[derive(Debug, Clone)]
pub struct ClaimedAgentJob {
    pub id: i64,
    pub workspace_id: Uuid,
    /// Already incremented by the claim, so a retry count is deterministic.
    pub attempts: i32,
    pub method: String,
    /// The raw `payload` JSON text; the consumer owns its shape.
    pub payload: String,
    /// `agent_member_id` (L4 §3.5). `None` only for a malformed enqueue.
    pub partition_key: Option<Uuid>,
    /// The lease this claim minted. Held so a later API (renew/handback) has the
    /// capability without re-reading the row.
    pub lease_id: Uuid,
    pub lease_expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// Claim up to `batch_size` runnable worker `agent_job` rows — at most one per
/// agent — flip them to `processing`, and mint a `lease_seconds` lease on each,
/// in one statement.
///
/// "Runnable" is `pending` **or** a `processing` row whose lease has expired
/// (a crashed claimer's turn, taken over rather than lost).
///
/// Returned in `id` order (oldest first), which is also mention order.
pub async fn claim_agent_job_batch(
    pool: &PgPool,
    batch_size: i64,
    lease_seconds: i64,
) -> Result<Vec<ClaimedAgentJob>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        i64,
        Uuid,
        i32,
        String,
        String,
        Option<Uuid>,
        Uuid,
        DateTime<Utc>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        "WITH eligible AS ( \
             SELECT o.id, \
                    row_number() OVER ( \
                      PARTITION BY o.partition_key ORDER BY o.id \
                    ) AS rank_in_partition \
               FROM outbox o \
              WHERE o.kind = 'agent_job' \
                AND o.method = $2 \
                AND o.available_at <= now() \
                AND ( \
                      o.status = 'pending' \
                      OR ( \
                        o.status = 'processing' \
                        AND o.lease_expires_at IS NOT NULL \
                        AND o.lease_expires_at <= now() \
                      ) \
                    ) \
                AND NOT EXISTS ( \
                      SELECT 1 \
                        FROM outbox inflight \
                       WHERE inflight.kind = 'agent_job' \
                         AND inflight.status = 'processing' \
                         AND inflight.partition_key \
                             IS NOT DISTINCT FROM o.partition_key \
                         AND ( \
                               inflight.lease_expires_at IS NULL \
                               OR inflight.lease_expires_at > now() \
                             ) \
                    ) \
         ), candidate AS ( \
             SELECT o.id \
               FROM outbox o \
               JOIN eligible e ON e.id = o.id AND e.rank_in_partition = 1 \
              ORDER BY o.id \
              FOR UPDATE OF o SKIP LOCKED \
              LIMIT $1 \
         ) \
         UPDATE outbox o \
            SET status = 'processing', \
                attempts = o.attempts + 1, \
                lease_owner = uuidv7(), \
                lease_acquired_at = now(), \
                lease_expires_at = now() + make_interval(secs => $3) \
           FROM candidate c \
          WHERE o.id = c.id \
         RETURNING o.id, o.workspace_id, o.attempts, o.method, \
                   o.payload::text, o.partition_key, o.lease_owner, \
                   o.lease_expires_at, o.created_at",
    )
    .bind(batch_size)
    .bind(WORKER_JOB_METHOD)
    .bind(lease_seconds as f64)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                workspace_id,
                attempts,
                method,
                payload,
                partition_key,
                lease_id,
                lease_expires_at,
                created_at,
            )| ClaimedAgentJob {
                id,
                workspace_id,
                attempts,
                method,
                payload,
                partition_key,
                lease_id,
                lease_expires_at,
                created_at,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worker feed and the gateway feed are separated by this literal. If it
    /// ever drifts from `MessageRoutes.swift:2091`'s non-gateway branch, the
    /// worker claims nothing and every mention silently stalls — so the string
    /// is pinned rather than inlined at the call site.
    #[test]
    fn the_worker_method_is_the_servers_non_gateway_branch() {
        assert_eq!(WORKER_JOB_METHOD, "publish");
        assert_ne!(WORKER_JOB_METHOD, "gateway");
    }

    /// The lease has to outlast a whole turn, or a live worker gets its own job
    /// taken over mid-provider-call. Swift's transport ceiling is 120 s
    /// (`HermesTransport.requestTimeout`), so that is the floor this default has
    /// to clear.
    #[test]
    fn the_default_lease_outlasts_a_full_provider_timeout() {
        let swift_request_timeout_seconds = 120i64;
        assert!(
            DEFAULT_WORKER_LEASE_SECONDS > swift_request_timeout_seconds,
            "a lease shorter than the provider request timeout takes over live turns"
        );
    }
}
