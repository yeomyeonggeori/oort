//! The one definition of "my Mac is online" (ADR-0198 T4, #3569).
//!
//! A `work_host` is online when it is unrevoked **and** its last signed
//! heartbeat (`work_host.last_seen_at`, the only writer is the heartbeat
//! endpoint) is no older than [`ONLINE_WINDOW_SECONDS`]. `momo-workd` beats every
//! 30 s by default (`heartbeat_interval_ms`), so 90 s tolerates two lost beats
//! and still turns a closed lid into "offline" within a minute and a half.
//!
//! Every server place that decides online — the work-hosts read (`online`), the
//! spawn target check, the spawn host candidates, the session reattach
//! `host_online` — builds its SQL from [`work_host_online_sql`] so the window,
//! the boundary (`>=`) and the NULL / revoked handling cannot drift apart.
//! Clients never compute it: they read the server's `online`.
//!
//! This lives in `momo-wire` because both `momo-auth` and `momo-t3` already
//! depend on it and neither depends on the other. The subscription agent's
//! `hostOnline` (active token used within 10 min) is a different question
//! ("is an agent process dialing in?") and must not be used for harness
//! routing.

/// Seconds a heartbeat keeps a host online (3 x the 30 s workd default period).
pub const ONLINE_WINDOW_SECONDS: i64 = 90;

/// SQL boolean expression: unrevoked and heartbeated within the window.
/// `alias` is the `work_host` table alias (`"h"`), or `""` when unaliased.
/// Evaluates to `false` (never NULL) for a host that has not beaten yet.
pub fn work_host_online_sql(alias: &str) -> String {
    debug_assert!(
        alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "alias must be a plain SQL identifier"
    );
    let p = if alias.is_empty() {
        String::new()
    } else {
        format!("{alias}.")
    };
    format!(
        "({p}revoked_at IS NULL \
         AND COALESCE({p}last_seen_at >= clock_timestamp() \
                        - make_interval(secs => {ONLINE_WINDOW_SECONDS}), false))"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expression_names_window_revocation_and_null_handling() {
        let sql = work_host_online_sql("h");
        assert!(sql.contains("h.revoked_at IS NULL"));
        assert!(sql.contains("COALESCE(h.last_seen_at >= clock_timestamp()"));
        assert!(sql.contains("make_interval(secs => 90)"));
        assert!(work_host_online_sql("").starts_with("(revoked_at IS NULL"));
    }
}
