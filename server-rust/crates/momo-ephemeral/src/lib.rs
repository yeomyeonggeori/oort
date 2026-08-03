//! `momo-ephemeral` — the 휘발 신호 path (ADR-0149, goal SRV-T2).
//!
//! ```text
//! 영속:  클라 → REST → PG → outbox → relay → Centrifugo     (기존, 불변)
//! 휘발:  클라 → REST → ─────────────────────→ Centrifugo     (이 crate)
//! ```
//!
//! Until this crate existed, every road in momo went through Postgres and
//! `FORCE ROW LEVEL SECURITY` made tenant isolation free. **This is the first
//! road that does not**, which is why the crate is shaped the way it is:
//!
//! | ADR-0149 guard | how it is a property of this crate rather than a rule |
//! |---|---|
//! | 1 — separate namespace, `history_size: 0` | [`signal::ephemeral_channel`] is the only channel name this crate can produce, and it is never `ch:`/`dm:` |
//! | 2 — sealed payload type | [`publisher::EphemeralPublisher::publish`] takes [`signal::EphemeralSignal`]; there is no `publish(channel, value)` to reach for |
//! | 3 — no Postgres | **this crate has no `momo-db` and no `sqlx`**, asserted below against its own manifest |
//! | 4 — no server-held state | [`signal::TypingSignal`] carries `expires_at`; there is no map, no timer, no `&mut self` anywhere here |
//! | 5 — server-side rate limit | not here: the limiter needs the caller's identity, so it lives in the route (`momo_server::routes::ephemeral`) |
//!
//! **Authorization is not this crate's job and deliberately cannot be.** It
//! holds no connection, so it cannot ask who is in a channel; the route proves
//! that first and only then hands a signal down. Keeping the check out of here
//! is what keeps guard 3 true.

pub mod publisher;
pub mod signal;

pub use publisher::{EphemeralPublishOutcome, EphemeralPublisher};
pub use signal::{
    ephemeral_channel, now_epoch_ms, EphemeralSignal, TypingSignal, EPHEMERAL_NAMESPACE,
    TYPING_AGGREGATE_THRESHOLD, TYPING_EVENT_TYPE, TYPING_REPUBLISH_INTERVAL_MS,
    TYPING_SIGNAL_TTL_MS,
};

#[cfg(test)]
mod manifest_tests {
    /// **ADR-0149 guard 3, as a build-time fact rather than a review promise.**
    ///
    /// The red test the packet asks for — "휘발 경로 처리 중 PG 쿼리 0건, docker
    /// 없이 도는 형태" — has two halves. This is the static one: the publisher
    /// cannot issue a query because it cannot link a driver. Adding `sqlx` or
    /// `momo-db` to this manifest to "just read one row" turns this red before
    /// the row is ever read.
    ///
    /// The dynamic half is `momo-server`'s
    /// `tests/ephemeral_typing_touches_no_pg.rs`, which drives the real handler
    /// against a database that refuses every connection.
    #[test]
    fn the_publisher_has_no_database_dependency() {
        let manifest = include_str!("../Cargo.toml");
        // Comments explain *why* there is no DB dependency and name the crates,
        // so only real dependency lines are examined.
        for line in manifest
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with('#'))
        {
            for forbidden in [
                "sqlx",
                "momo-db",
                "momo-messaging",
                "postgres",
                "tokio-postgres",
            ] {
                assert!(
                    !line.starts_with(forbidden),
                    "momo-ephemeral must not depend on {forbidden}: the ephemeral path \
                     touches Postgres zero times (ADR-0149 guard 3) — found {line:?}"
                );
            }
        }
    }
}
