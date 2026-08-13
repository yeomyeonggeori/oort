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
//! | [`claim_agent_job_batch`] | `agent_job` | `= ANY(['publish','resume_approval'])` |
//!
//! The worker predicate is an explicit **allow-list** ([`WORKER_JOB_METHODS`]),
//! not Swift's `method <> 'gateway'`. B5.1 set it to `= 'publish'` alone and
//! wrote down why: the approval-resume path did not exist, so an equality
//! predicate left `method='resume_approval'` rows untouched for their future
//! consumer instead of claiming work this binary would have to fail.
//!
//! **goal SRV-T1 is that consumer**, so the allow-list now admits the second
//! method. The shape stays an allow-list rather than becoming Swift's `<>`
//! because the two are not equivalent under growth: `<>` claims every method
//! anyone ever adds, including one written for a consumer that does not exist
//! yet, and the failure mode is silent — the row is claimed, found
//! un-runnable, and retried until its attempt budget is spent. An allow-list
//! leaves an unknown method alone, which is the same courtesy B5.1 extended to
//! this batch.
//!
//! ## The two payload shapes this claim carries, and what they share
//!
//! The claim itself is payload-blind — it reads `kind`, `method`,
//! `partition_key`, `status` and the lease columns, and hands `payload` back as
//! opaque text. That is deliberate, and it is also why the contract below has to
//! be written down somewhere: **nothing in this statement would notice if a
//! producer emitted a shape the consumer cannot decode.** The row would be
//! claimed, fail to decode, and be retired as poison — and because the claim
//! serializes per agent, a poison row is not one lost turn, it is that agent
//! blocked until someone reads the logs.
//!
//! | key | `publish` | `resume_approval` | required by the consumer |
//! |---|---|---|---|
//! | `agent_member_id` | ✅ | ✅ | **yes** — no agent, no turn |
//! | `channel_id` | ✅ | ✅ | **yes** — nowhere to answer |
//! | `run_id` | ✅ | ✅ | in practice (a job without one is retired) |
//! | `model`, `prompt` | ✅ | ✅ | no (defaults) |
//! | `recent_messages`, `system_prompt`, `tools`, `tool_grants` | ✅ | ❌ | no |
//! | `resume_from_approval_id` | ❌ | ✅ | no — its **presence is the discriminator** |
//! | `approved_tool_call`, `approved_by` | ❌ | ✅ | no, but a resume without them runs nothing |
//! | `step_count`, `max_steps`, `depth` | ❌ | ✅ | no — carries the G3 budget across the pause |
//!
//! The two shapes agree on exactly the fields the consumer requires, which is
//! what lets one claim, one decoder and one per-agent lease serve both. A
//! `resume_approval` row is deliberately *smaller*: the transcript is re-read
//! from the channel on resume, so re-shipping it would have made the approval
//! payload a second, staler copy of the conversation.
//!
//! `partition_key` is `agent_member_id` for **both**, and that is not a detail:
//! it is what stops a first-turn job and a resume job for the same agent from
//! running at once and interleaving two answers into one conversation.
//!
//! ## This claim runs as a BYPASSRLS role
//!
//! There is **no workspace predicate here and no tenant GUC is set** — a worker
//! drains every tenant. So the caller must connect as the BYPASSRLS `momo_worker`
//! role (`infra/e2e/bootstrap_roles.sql:32`). Under a NOBYPASSRLS role the
//! `outbox` policy evaluates `current_setting('app.workspace_id', true)::uuid`
//! against an unset GUC and Postgres answers
//! `22P02 invalid input syntax for type uuid: ""` — a posture failure that reads
//! like a payload failure. Same rule as `crate::relay`'s broadcast claim.
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
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

/// `outbox.last_error` a human stop writes onto the jobs it retires
/// (`AgentRunRoutes.swift:509`).
///
/// It is a *reason*, not a failure: the row is settled `done`, and this string
/// is what tells an operator reading the outbox why a job was never run.
pub const RUN_CANCELLED_JOB_LAST_ERROR: &str = "human cancelled agent run";

/// `outbox.method` for a first-turn job (Swift `MessageRoutes.swift:2091`).
pub const WORKER_JOB_METHOD: &str = "publish";

/// `outbox.method` for the job an approved approval decision enqueues (Swift
/// `ApprovalDecisionRoutes.enqueueResume` :721).
///
/// Reserved out of the claim predicate by B5.1 and **consumed for the first time
/// by goal SRV-T1**. Until then the decision route did not exist, so no row
/// could carry this method; now that it does, a row left unclaimed would be a
/// person who tapped 승인 and watched nothing happen — with no error anywhere,
/// because an unclaimed row is not a failed row.
pub const RESUME_APPROVAL_JOB_METHOD: &str = "resume_approval";

/// Every `method` this worker claims.
///
/// Kept as one array bound with `= ANY($2)` rather than as two claim functions:
/// the per-agent serialization guarantee below is a property of the **whole**
/// claim (`NOT EXISTS … IS NOT DISTINCT FROM o.partition_key` plus
/// `row_number() … = 1`), and two separate claims would each hold it for their
/// own method while breaking it across the pair — a first-turn job and a resume
/// job for the same agent could then run at once and interleave two answers into
/// one conversation, which is the exact failure this module was built to make
/// impossible.
pub const WORKER_JOB_METHODS: [&str; 2] = [WORKER_JOB_METHOD, RESUME_APPROVAL_JOB_METHOD];

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
                AND o.method = ANY($2) \
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
                      SELECT 1 FROM hosted_agent_connection hc \
                       WHERE hc.workspace_id = o.workspace_id \
                         AND hc.agent_member_id = o.partition_key \
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
    .bind(WORKER_JOB_METHODS.map(str::to_string).to_vec())
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

/// Retire every **unclaimed** `agent_job` belonging to a run a human just
/// stopped — Swift's cancel `UPDATE outbox` (`AgentRunRoutes.swift:504-511`).
///
/// This is the half of a cancel that actually stops work: the `agent_run` row
/// says `cancelled`, but a queued job is an instruction that a worker would
/// otherwise claim and run to completion, answering in the channel minutes after
/// a person asked it to stop. Retiring it as `done` is what makes 중지 mean
/// stopped rather than merely marked.
///
/// It lives here because `momo-outbox` owns every `outbox` statement in the
/// workspace (invariant #3) — the route composes it inside the cancel's
/// transaction, so a rolled-back cancel takes the retirement with it.
///
/// **Only `pending` rows**, exactly as Swift: a `processing` row is a turn that
/// is already running inside a worker holding a lease, and flipping its status
/// under it would race the worker's own settle rather than stop it. That turn is
/// stopped by the run status instead — the gateway/worker paths re-read the run
/// and refuse a terminal one — and `agent_gateway`'s cancellation
/// acknowledgement is the event it may still report.
///
/// The predicate is `payload->>'run_id'`, not a column: `outbox` has no
/// `run_id`, the job payload carries it as a string, and every producer
/// (`work_job_payload`, `mention_job_payload`, `resume_job_payload`) writes it.
///
/// ## Why the comparison is case-folded, where Swift's is not
///
/// Swift compares the raw text (`payload->>'run_id' = \(runID.uuidString)`) and
/// is safe doing so, because *every* Swift producer writes `uuidString` — one
/// casing, workspace-wide. **This server's producers disagree**: measured,
/// `momo_agent::mention::mention_job_payload` writes the id UPPERCASE (Swift
/// parity for the payload a gateway reads) while `work_job_payload` and
/// `resume_job_payload` write it lowercase. A literal port of Swift's predicate
/// would therefore retire a work run's job and silently miss a **mention** run's
/// — the most common kind — leaving the exact instruction a person asked to stop
/// sitting `pending` for the next worker to claim.
///
/// `lower(...)` on both sides is the narrowest fix that cannot be wrong for
/// either producer. A `::uuid` cast would also work and is rejected: it raises
/// on any row whose payload happens to hold a non-uuid `run_id`, which would
/// turn one malformed job anywhere in the tenant into a failed cancel.
///
/// Returns how many rows were retired.
pub async fn retire_pending_agent_jobs_for_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE outbox \
            SET status = 'done', processed_at = now(), last_error = $3 \
          WHERE workspace_id = $1 \
            AND kind = 'agent_job' \
            AND status = 'pending' \
            AND lower(payload->>'run_id') = $2",
    )
    .bind(workspace_id)
    .bind(run_id.to_string().to_lowercase())
    .bind(RUN_CANCELLED_JOB_LAST_ERROR)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
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
