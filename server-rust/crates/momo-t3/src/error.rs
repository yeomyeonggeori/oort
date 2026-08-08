//! The T3 domain error surface — and, more importantly, the **translation table
//! from a database rejection to a named domain outcome**.
//!
//! ADR-0140's premise is that the final enforcement already lives in PostgreSQL:
//! the transition table trigger, the `settled_at` seal, the one-unsettled-per-
//! host partial unique index. An application that swallowed those rejections as
//! anonymous `DbError`s would satisfy the letter of the invariant and lose its
//! meaning at the API boundary, so every enforcement point gets a variant here
//! and [`classify_pg`] is the single place that maps SQLSTATE + message onto it.
//!
//! Nothing in this module *decides* anything — reverting a trigger in the schema
//! would simply stop producing the error these variants name, which is exactly
//! what the conformance red tests assert.

use momo_db::DbError;
use momo_provider::CloudProviderError;

/// `check_violation` — the SQLSTATE the ADR-0140 triggers raise explicitly
/// (053:63, 053:81) as well as the one plain CHECK constraints use.
const SQLSTATE_CHECK_VIOLATION: &str = "23514";
/// `unique_violation` — carries `work_host_usage_one_unsettled_per_host_idx`
/// (051:33), the v0 "one paid session per cloud host" rule.
const SQLSTATE_UNIQUE_VIOLATION: &str = "23505";

/// Errors returned by the T3 lifecycle and billing API.
#[derive(Debug, thiserror::Error)]
pub enum T3Error {
    /// A database / transaction failure with no T3-specific meaning.
    #[error(transparent)]
    Db(#[from] DbError),

    /// [`crate::lifecycle::with_t3_lifecycle_tx`] was called with no cloud host.
    /// A T3 lifecycle transaction without a host advisory is precisely the
    /// unserialized path ADR-0140 D2 removes, so it is refused rather than
    /// silently degraded to a plain tenant transaction.
    #[error("t3 lifecycle transaction requires at least one cloud host id")]
    EmptyLockLadder,

    /// `work_cloud_host_transition_guard` (053:68) refused the state change:
    /// the `(from_state, to_state)` pair is not in `work_cloud_host_transition`.
    #[error("illegal cloud host state transition: {0}")]
    IllegalTransition(String),

    /// `work_host_usage_settlement_guard` (053:86) refused a direct
    /// `settled_at` write. Settlement only exists inside `t3_terminate`.
    #[error("t3 settlement must go through t3_terminate")]
    SettlementSealed,

    /// `t3_terminate` rejected the reason (058:133). The reason vocabulary is
    /// ADR-0140 D3's canonical list.
    #[error("invalid t3 termination reason")]
    InvalidTerminationReason,

    /// `t3_terminate` found a usage row whose host has no `work_cloud_host`
    /// binding (058:157) — a T3 ledger row that is not on a T3 host.
    #[error("t3 usage row has no cloud host binding")]
    CloudHostMissing,

    /// `t3_terminate` found no `workspace_credit` row (058:169). The ledger is
    /// provisioned before a paid session may start, so this is fail-closed.
    #[error("workspace credit ledger missing")]
    CreditLedgerMissing,

    /// Pre-flight balance check (not part of `t3_terminate`): the workspace has
    /// no credit to start a paid session with.
    #[error("workspace has no oort Cloud credit")]
    InsufficientCredit,

    /// `work_host_usage_one_unsettled_per_host_idx` (051:33): this cloud host
    /// already carries an unsettled paid session.
    #[error("cloud host already has an unsettled t3 session")]
    HostAlreadyBilling,

    /// All workspace slots are occupied (`work_pool.max_active`).
    #[error("oort Cloud slots exhausted ({occupied}/{max_active})")]
    SlotsExhausted { occupied: i32, max_active: i32 },

    /// The requesting member is at their own concurrent-instance limit.
    #[error("member oort Cloud limit reached ({occupied}/{limit})")]
    MemberSlotLimit { occupied: i32, limit: i32 },

    /// The cloud host is not in a state that can carry a running session.
    #[error("cloud host is not runnable (state {0})")]
    CloudHostNotRunnable(String),

    /// No unsettled `work_host_usage` row for this host/session.
    #[error("no open t3 usage for this cloud host")]
    NoOpenUsage,

    /// The active/paused interval was not in the expected state — another
    /// writer moved it first.
    #[error("t3 usage interval state changed concurrently")]
    IntervalStateConflict,

    #[error("work session not found")]
    SessionNotFound,

    /// B2.3 sweep: `t3_terminate` settled the ledger, and the session row was
    /// then moved by someone else before the transition could apply. Returned so
    /// the transaction rolls back — an invoice must not stand for a session this
    /// process did not actually end.
    #[error("t3 session {0} changed after settlement")]
    StaleAfterSettlement(uuid::Uuid),

    #[error("cloud host not found")]
    CloudHostNotFound,

    /// `work_pool` row missing for the workspace.
    #[error("work pool settings missing")]
    WorkPoolMissing,

    /// The `work_cloud_host.provider` registry key has no adapter (ADR-0142 D4:
    /// an unknown provider fails closed at config load).
    #[error("unknown t3 provider: {0}")]
    UnknownProvider(String),

    #[error(transparent)]
    Provider(#[from] CloudProviderError),
}

/// Map a PostgreSQL `(SQLSTATE, message)` pair onto the domain outcome the
/// database was enforcing, or `None` when it carries no T3 meaning.
///
/// Split out as a pure function so the mapping is unit-testable without a live
/// database: the message prefixes below are copied from migrations 051/053/058
/// and a drift in either direction is caught by the DB conformance suite.
pub(crate) fn classify_pg(sqlstate: &str, message: &str) -> Option<T3Error> {
    match sqlstate {
        SQLSTATE_CHECK_VIOLATION => {
            if message.starts_with("illegal cloud host transition") {
                Some(T3Error::IllegalTransition(message.to_string()))
            } else if message.starts_with("t3 settlement must go through") {
                Some(T3Error::SettlementSealed)
            } else if message.starts_with("invalid t3 termination reason") {
                Some(T3Error::InvalidTerminationReason)
            } else if message.starts_with("t3 usage ") && message.contains("has no cloud host") {
                Some(T3Error::CloudHostMissing)
            } else if message.starts_with("t3 workspace credit ledger missing") {
                Some(T3Error::CreditLedgerMissing)
            } else {
                None
            }
        }
        SQLSTATE_UNIQUE_VIOLATION => {
            if message.contains("work_host_usage_one_unsettled_per_host_idx") {
                Some(T3Error::HostAlreadyBilling)
            } else {
                None
            }
        }
        _ => None,
    }
}

impl From<sqlx::Error> for T3Error {
    /// Every `?` on a sqlx result inside this crate runs through the ADR-0140
    /// translation table, so a DB-enforced rejection can never reach a caller as
    /// an anonymous database error.
    fn from(err: sqlx::Error) -> Self {
        if let Some(db) = err.as_database_error() {
            if let Some(code) = db.code() {
                if let Some(mapped) = classify_pg(code.as_ref(), db.message()) {
                    return mapped;
                }
            }
        }
        T3Error::Db(DbError::from(err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_guard_rejection_is_named() {
        let err = classify_pg("23514", "illegal cloud host transition ready -> paused")
            .expect("transition guard rejection must map to a domain error");
        assert!(matches!(err, T3Error::IllegalTransition(_)));
    }

    #[test]
    fn settlement_seal_rejection_is_named() {
        let err = classify_pg("23514", "t3 settlement must go through t3_terminate")
            .expect("settlement seal rejection must map to a domain error");
        assert!(matches!(err, T3Error::SettlementSealed));
    }

    #[test]
    fn one_unsettled_per_host_is_named() {
        let err = classify_pg(
            "23505",
            "duplicate key value violates unique constraint \
             \"work_host_usage_one_unsettled_per_host_idx\"",
        )
        .expect("one-unsettled-per-host violation must map to a domain error");
        assert!(matches!(err, T3Error::HostAlreadyBilling));
    }

    #[test]
    fn terminate_preconditions_are_named() {
        assert!(matches!(
            classify_pg("23514", "invalid t3 termination reason: nope"),
            Some(T3Error::InvalidTerminationReason)
        ));
        assert!(matches!(
            classify_pg(
                "23514",
                "t3 usage 0189d3f0-0000-7000-8000-000000000000 has no cloud host"
            ),
            Some(T3Error::CloudHostMissing)
        ));
        assert!(matches!(
            classify_pg(
                "23514",
                "t3 workspace credit ledger missing for workspace 0189d3f0-0000-7000-8000-000000000000"
            ),
            Some(T3Error::CreditLedgerMissing)
        ));
    }

    #[test]
    fn unrelated_failures_stay_generic() {
        // An ordinary CHECK constraint keeps its generic shape: only the
        // ADR-0140 enforcement points earn a named variant.
        assert!(classify_pg("23514", "new row violates check constraint \"x_ck\"").is_none());
        assert!(classify_pg("23503", "foreign key violation").is_none());
        assert!(classify_pg("40P01", "deadlock detected").is_none());
    }
}
