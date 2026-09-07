//! Idempotent replay cache: an already-accepted signed body is not sent twice.
//!
//! The notifier may retry the same candidate after a lost 200. Re-sending that
//! to APNs would double-notify the device. A hit returns the original receipt
//! and does not consume a rate-limit slot or call the sender.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::sender::PushReceipt;

pub struct ReplayCache {
    window: Duration,
    entries: HashMap<String, (Instant, PushReceipt)>,
}

impl ReplayCache {
    pub fn new() -> Self {
        ReplayCache {
            window: Duration::from_secs(60),
            entries: HashMap::new(),
        }
    }

    fn key(server_id: &str, body: &[u8]) -> String {
        let digest = Sha256::digest(body);
        format!("{server_id}:{}", hex::encode(digest))
    }

    pub fn lookup(&mut self, server_id: &str, body: &[u8], now: Instant) -> Option<PushReceipt> {
        self.prune(now);
        self.entries
            .get(&Self::key(server_id, body))
            .map(|(_, receipt)| receipt.clone())
    }

    pub fn remember(&mut self, server_id: &str, body: &[u8], receipt: PushReceipt, now: Instant) {
        self.prune(now);
        self.entries
            .insert(Self::key(server_id, body), (now, receipt));
    }

    fn prune(&mut self, now: Instant) {
        let cutoff = now.checked_sub(self.window).unwrap_or(now);
        self.entries.retain(|_, (stamp, _)| *stamp > cutoff);
    }
}

impl Default for ReplayCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remembered_body_is_returned_until_the_window_expires() {
        let mut cache = ReplayCache::new();
        let now = Instant::now();
        let receipt = PushReceipt {
            apns_status: 200,
            apns_reason: None,
            apns_id: Some("stub-apns-id".into()),
        };
        cache.remember("server-a", b"body", receipt.clone(), now);
        assert_eq!(cache.lookup("server-a", b"body", now), Some(receipt));
        assert!(cache.lookup("server-a", b"other", now).is_none());
        assert!(cache
            .lookup("server-a", b"body", now + Duration::from_secs(61))
            .is_none());
    }
}
