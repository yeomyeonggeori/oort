//! `momo-outbox` — the single write-path egress (invariant #3).
//!
//! **This crate is the only place in the workspace that owns `outbox` table
//! SQL.** [`emit`] holds the sole outbox-insert statement ([`emit::emit_outbox`]);
//! [`relay`] holds the consumer claim (`FOR UPDATE SKIP LOCKED`). A domain crate
//! cannot append an outbox row except through [`emit::emit_outbox`], so the
//! single-write-path invariant moves from "did all 18 call sites obey the
//! convention" (the Swift reality — inline inserts scattered across 18 route
//! files) to "there is exactly one chokepoint, guarded by the compiler and a
//! grep-able lint" (D1 §3, D2 #3).
//!
//! The DB backstop stays intact: `outbox_notify_trg` (`001_init.sql:432`) fires
//! `pg_notify('outbox', kind)` AFTER INSERT, so the relay wakes without any app
//! code emitting the notify.

//! B2.6 adds [`gateway`], the `agent_job` half of the consumer story (migration
//! 008): claim-with-lease, renew, release, the lease authorization read, and the
//! settle-on-completion update. It is here for the same ownership reason as the
//! other two — a lease is columns on an `outbox` row — and its `WHERE` clauses
//! are disjoint from [`relay`]'s by `kind`, so the two consumers cannot drain
//! each other's feed.

//! B5.1 adds [`agent_job`], the **worker** half of that story: the
//! `method='publish'` claim `momo-agent-worker` drains, with per-agent
//! serialization (`partition_key`) enforced in the SQL rather than in the
//! caller's loop. Its `WHERE` clause is disjoint from [`relay`]'s by `kind` and
//! from [`gateway`]'s by `method`, so all three consumers keep their own feed.

//! P2 adds [`push`], the `push_candidate` half (migration 011): the notifier's
//! claim and its boot-time reclaim of rows a crashed run left `processing`. Its
//! `WHERE` clause is disjoint from all three by `kind`, so the fourth consumer
//! keeps its own feed too.

//! #1222 adds [`webhook`], the `webhook_delivery` half (migration 033): the
//! outbound sender's claim and the transaction-scoped settlement it shares with
//! the subscription's failure ledger. Its `WHERE` clause is disjoint from all
//! four by `kind`, so the fifth consumer keeps its own feed too — and it is a
//! **separate binary** rather than the relay, because the relay's single HTTP
//! destination is what makes invariant #2 checkable.

pub mod agent_job;
pub mod emit;
pub mod gateway;
pub mod push;
pub mod relay;
pub mod webhook;

pub use agent_job::{
    claim_agent_job_batch, retire_pending_agent_jobs_for_run_in_tx, ClaimedAgentJob,
    DEFAULT_WORKER_LEASE_SECONDS, RESUME_APPROVAL_JOB_METHOD, RUN_CANCELLED_JOB_LAST_ERROR,
    WORKER_JOB_METHOD, WORKER_JOB_METHODS,
};
pub use emit::{emit_outbox, OutboxKind};
pub use gateway::{
    claim_gateway_jobs_in_tx, claim_hosted_gateway_jobs_in_tx, clamp_claim_limit,
    gateway_lease_authorized, lock_gateway_lease_in_tx, release_gateway_lease_in_tx,
    renew_gateway_lease_in_tx, settle_gateway_job_in_tx, suppress_hosted_agent_jobs_in_tx,
    ClaimedGatewayJob, GatewayJobStatus, GatewayLeaseBinding, GatewayLeaseSnapshot,
    HostedWorkSuppression, CLAIM_LIMIT_DEFAULT, CLAIM_LIMIT_MAX, GATEWAY_LEASE_SECONDS,
    HOSTED_DISCONNECT_JOB_LAST_ERROR,
};
pub use push::{claim_push_candidate_batch, reclaim_stuck_push_candidates, ClaimedPushCandidate};
pub use relay::{
    backoff_seconds, claim_batch, claim_broadcast_batch, mark_done, mark_failed, requeue,
    ClaimedRow, NOTIFY_CHANNEL,
};
pub use webhook::{
    claim_webhook_delivery_batch, mark_done_in_tx, mark_failed_in_tx, requeue_in_tx,
};
