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

pub mod emit;
pub mod gateway;
pub mod relay;

pub use emit::{emit_outbox, OutboxKind};
pub use gateway::{
    claim_gateway_jobs_in_tx, clamp_claim_limit, gateway_lease_authorized,
    lock_gateway_lease_in_tx, release_gateway_lease_in_tx, renew_gateway_lease_in_tx,
    settle_gateway_job_in_tx, ClaimedGatewayJob, GatewayJobStatus, GatewayLeaseBinding,
    GatewayLeaseSnapshot, CLAIM_LIMIT_DEFAULT, CLAIM_LIMIT_MAX, GATEWAY_LEASE_SECONDS,
};
pub use relay::{
    backoff_seconds, claim_batch, claim_broadcast_batch, mark_done, mark_failed, requeue,
    ClaimedRow, NOTIFY_CHANNEL,
};
