//! Per-registered-server sliding 60-second window (ADR-0120 D5 / Zulip model).

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub struct ServerRateLimiter {
    limit: usize,
    window: Duration,
    accepted_at: HashMap<String, Vec<Instant>>,
}

impl ServerRateLimiter {
    pub fn new(limit: u32) -> Self {
        ServerRateLimiter {
            limit: limit as usize,
            window: Duration::from_secs(60),
            accepted_at: HashMap::new(),
        }
    }

    pub fn allow(&mut self, server_id: &str, now: Instant) -> bool {
        let cutoff = now.checked_sub(self.window).unwrap_or(now);
        let timestamps = self.accepted_at.entry(server_id.to_string()).or_default();
        timestamps.retain(|stamp| *stamp > cutoff);
        if timestamps.len() >= self.limit {
            return false;
        }
        timestamps.push(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sliding_window_is_per_server() {
        let mut limiter = ServerRateLimiter::new(2);
        let now = Instant::now();
        assert!(limiter.allow("a", now));
        assert!(limiter.allow("a", now));
        assert!(!limiter.allow("a", now));
        assert!(limiter.allow("b", now));
        assert!(limiter.allow("a", now + Duration::from_secs(61)));
    }
}
