//! `momo-db` — DB foundation for the Rust rewrite (ADR-0145 B안, D1/D2).
//!
//! This crate owns the two invariant-bearing DB seams that the whole server
//! leans on:
//!
//! * **RLS GUC wiring is here and only here** — [`tenant::with_tenant_tx`] is the
//!   single place that sets `app.workspace_id` (via `SET LOCAL`, transaction
//!   scoped). Invariant #6 (RLS FORCE) becomes structural: a domain query that
//!   does not go through a tenant transaction never gets the GUC, so the DB
//!   policies filter it to zero rows. Ports Swift `DB/Database.swift:85-105`.
//! * **The migration runner reuses the existing 59 SQL files in place**
//!   (`server/Migrations/NNN_*.sql`), unmodified — the DB enforcement layer is
//!   language independent (ADR-0145). See [`migrate`].
//!
//! B0 scope: pool setup, tenant/variant transaction guards, migration
//! discovery+runner, and an `audit_log` write stub. No domain queries (B1+),
//! no new migrations.

pub mod audit;
pub mod error;
pub mod migrate;
pub mod pool;
pub mod tenant;

pub use error::DbError;
pub use pool::{connect, PoolConfig};
pub use tenant::{with_provider_link_admin_tx, with_provider_quota_ingest_tx, with_tenant_tx};

// Re-export the sqlx types domain crates build on, so B1+ crates depend on one
// pinned sqlx through `momo-db` rather than each pinning their own.
pub use sqlx::{self, PgConnection, PgPool, Postgres, Transaction};
