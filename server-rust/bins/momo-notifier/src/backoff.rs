//! Failure backoff for the notifier's polling loops (#3377).
//!
//! In the v0.1.16 incident the share retention loop failed with `permission
//! denied` on **every** tick, and a tick is 300 ms: three error lines and three
//! useless queries a second, forever, until an operator rolled the deploy back.
//! A permission error, a revoked credential or a database that is down does not
//! fix itself in 300 ms, so a loop that keeps failing must slow down.
//!
//! Every loop in `Notifier::run` goes through [`supervise`]: it ticks at its own
//! interval while iterations succeed, and after `n` consecutive failures waits
//! `min(interval * 2^n, MAX_BACKOFF)` before the next attempt. One success resets
//! it. The failure is still logged (at `error`, with the count and the next
//! delay), so a persistent fault stays loud — it is just no longer a flood.

use std::fmt::Display;
use std::future::Future;
use std::time::Duration;

/// The longest a failing loop waits between attempts.
pub const MAX_BACKOFF: Duration = Duration::from_secs(300);

/// Consecutive-failure counter plus the delay it implies.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    cap: Duration,
    failures: u32,
}

impl Backoff {
    pub fn new(base: Duration, cap: Duration) -> Backoff {
        Backoff {
            base,
            cap,
            failures: 0,
        }
    }

    /// An iteration succeeded: the next attempt is one plain interval away.
    pub fn succeeded(&mut self) {
        self.failures = 0;
    }

    /// An iteration failed; returns the wait before the next attempt, counted
    /// from the failure: `min(base * 2^failures, cap)`, never below `base`.
    pub fn failed(&mut self) -> Duration {
        self.failures = self.failures.saturating_add(1);
        self.delay()
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.failures
    }

    fn delay(&self) -> Duration {
        if self.failures == 0 {
            return self.base;
        }
        // 2^20 intervals is far past any cap; the clamp keeps the shift defined.
        let factor = 1u32 << self.failures.min(20);
        self.base
            .saturating_mul(factor)
            .min(self.cap)
            .max(self.base)
    }
}

/// Run `iteration` every `interval` forever, backing off while it fails.
///
/// The task is stopped by aborting it (`Notifier::run` does at shutdown).
pub async fn supervise<F, Fut, T, E>(name: &'static str, interval: Duration, iteration: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: Display,
{
    supervise_capped(name, interval, MAX_BACKOFF, iteration).await
}

/// [`supervise`] with an explicit cap (tests use a few milliseconds).
pub async fn supervise_capped<F, Fut, T, E>(
    name: &'static str,
    interval: Duration,
    cap: Duration,
    mut iteration: F,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: Display,
{
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut backoff = Backoff::new(interval, cap);
    loop {
        ticker.tick().await;
        match iteration().await {
            Ok(_) => backoff.succeeded(),
            Err(error) => {
                let delay = backoff.failed();
                tracing::error!(
                    error = %error,
                    consecutive_failures = backoff.consecutive_failures(),
                    next_attempt_in_ms = delay.as_millis() as u64,
                    "{name} iteration failed"
                );
                // The ticker already accounts for one interval; wait the rest,
                // then restart the cadence so the wait is not followed by a
                // catch-up tick.
                tokio::time::sleep(delay.saturating_sub(interval)).await;
                ticker.reset();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[test]
    fn the_delay_doubles_per_failure_up_to_the_cap_and_resets_on_success() {
        let mut backoff = Backoff::new(Duration::from_millis(300), MAX_BACKOFF);
        let delays: Vec<u64> = (0..12)
            .map(|_| backoff.failed().as_millis() as u64)
            .collect();
        assert_eq!(
            delays,
            vec![
                600, 1_200, 2_400, 4_800, 9_600, 19_200, 38_400, 76_800, 153_600, 300_000, 300_000,
                300_000
            ]
        );
        backoff.succeeded();
        assert_eq!(backoff.consecutive_failures(), 0);
        assert_eq!(backoff.failed(), Duration::from_millis(600));
    }

    #[test]
    fn a_base_above_the_cap_is_never_shortened() {
        let mut backoff = Backoff::new(Duration::from_secs(600), MAX_BACKOFF);
        assert_eq!(backoff.failed(), Duration::from_secs(600));
    }

    #[test]
    fn many_failures_do_not_overflow() {
        let mut backoff = Backoff::new(Duration::from_secs(1), MAX_BACKOFF);
        for _ in 0..1_000 {
            backoff.failed();
        }
        assert_eq!(backoff.failed(), MAX_BACKOFF);
    }

    /// The loop itself, on the wall clock with millisecond numbers: a loop that
    /// fails every time must space its attempts out, and one success must bring
    /// the plain cadence back.
    #[tokio::test]
    async fn a_failing_loop_spaces_its_attempts_and_a_success_resets_them() {
        let attempts: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
        let log = attempts.clone();
        let task = tokio::spawn(supervise_capped(
            "test loop",
            Duration::from_millis(10),
            Duration::from_millis(80),
            move || {
                let log = log.clone();
                async move {
                    let n = {
                        let mut log = log.lock().unwrap();
                        log.push(Instant::now());
                        log.len()
                    };
                    // Fail 5 times, succeed once, then fail forever.
                    if n == 6 {
                        Ok(())
                    } else {
                        Err("permission denied for table work_session_share")
                    }
                }
            },
        ));
        tokio::time::sleep(Duration::from_millis(900)).await;
        task.abort();
        let at = attempts.lock().unwrap().clone();
        let gaps: Vec<u128> = at.windows(2).map(|w| (w[1] - w[0]).as_millis()).collect();
        // Lower bounds only (the scheduler may be late, never early): after
        // failure k the wait is min(10ms * 2^k, 80ms).
        let expected_min = [20u128, 40, 80, 80, 80];
        for (k, floor) in expected_min.iter().enumerate() {
            assert!(
                gaps[k] >= floor - 2,
                "gap after failure {} was {}ms, wanted >= {}ms (gaps: {:?})",
                k + 1,
                gaps[k],
                floor,
                gaps
            );
        }
        // The success (attempt 6) resets: the attempt after it waits one
        // failure's worth (20ms), not the 80ms cap. Compare against the cap.
        assert!(
            gaps[5] < 80,
            "the gap after a success should be back to the doubling start (gaps: {gaps:?})"
        );
        // And the whole thing is not a hot loop: at 10ms plain cadence this
        // window would hold ~90 attempts.
        assert!(at.len() < 25, "{} attempts in 900ms", at.len());
    }
}
