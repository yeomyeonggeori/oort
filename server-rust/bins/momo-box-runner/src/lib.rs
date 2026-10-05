//! `momo-box-runner` — the personal-cloud box runner (ADR-0197 M2, D2).
//!
//! ```text
//! verbs      the five verbs, fixed in source
//! wire       the closed control schema and the closed report vocabulary
//! config     the runner's own configuration: what a box runs lives here
//! template   the fixed docker template (the box volume is its only mount)
//! docker     the closed list of docker operations, by argv vector
//! engine     typed presence / run-state of a box's container and volume
//! executor   one function per verb; deletion verification
//! ledger     the quarantine ledger
//! reconcile  orphan-volume reconciliation (pure)
//! client     outbound HTTPS to the server
//! runner     the poll / execute / report / reconcile loop
//! ```

pub mod client;
pub mod config;
pub mod docker;
pub mod engine;
pub mod executor;
pub mod ledger;
pub mod reconcile;
pub mod runner;
pub mod template;
pub mod testing;
pub mod verbs;
pub mod wire;
