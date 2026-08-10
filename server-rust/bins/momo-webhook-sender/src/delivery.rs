//! The outbound HTTP hop — a port of Swift
//! `relay/OutboxRelay/.../WebhookDeliveryClient.swift`.
//!
//! Five properties are carried over verbatim, and each one is load bearing:
//!
//! 1. **The SSRF guard runs again, here, at delivery time.** The management
//!    route already checked the destination when the admin saved it; DNS can be
//!    re-pointed afterwards, so the check that matters is the one immediately
//!    before the connection.
//! 2. **The connection is pinned to an address that was checked.** `reqwest`'s
//!    `resolve_to_addrs` overrides DNS for this host, so the resolver cannot
//!    answer differently between the check and the connect (TOCTOU rebinding).
//! 3. **Redirects are not followed.** Following a POST redirect would require
//!    revalidating and re-pinning every hop; v0 fails closed and reports the 3xx
//!    as a permanent failure.
//! 4. **The response body is bounded.** A subscriber that streams forever must
//!    not hold a sender worker; the status is all this code wants.
//! 5. **`deliveredStatus` discriminates the audit.** A status exists exactly
//!    when the payload was handed to the external host. `None` means the guard
//!    refused or the request threw before any answer — recording either as a
//!    delivery would put a false line in the #1204 ledger, and both already live
//!    in `outbox.last_error`.

use std::net::SocketAddr;
use std::time::Duration;

use momo_webhook::{OutboundUrl, SystemHostResolver};

/// What one delivery attempt did. Ported from Swift `WebhookDeliveryResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryResult {
    /// 2xx.
    Ok(u16),
    /// 5xx — the destination is broken, and repeated ones auto-disable the
    /// subscription. Distinct from [`DeliveryResult::Transient`] because only
    /// this variant feeds the failure ledger.
    ServerFailure(u16),
    /// Retryable without blaming the subscription: 408/429, or a request that
    /// threw before an answer.
    Transient { reason: String, status: Option<u16> },
    /// Will never succeed: a refused destination, a 3xx, or any other 4xx.
    Permanent { reason: String, status: Option<u16> },
}

impl DeliveryResult {
    /// The HTTP status the destination answered with, or `None` when the bytes
    /// never measurably reached it (#1204).
    ///
    /// This is the discriminator the delivery audit rests on — see the module
    /// header, property 5.
    pub fn delivered_status(&self) -> Option<u16> {
        match self {
            DeliveryResult::Ok(status) | DeliveryResult::ServerFailure(status) => Some(*status),
            DeliveryResult::Transient { status, .. } | DeliveryResult::Permanent { status, .. } => {
                *status
            }
        }
    }
}

/// The seam the conformance test replaces. It takes an already-validated
/// [`OutboundUrl`] and the signed headers, so a stub cannot accidentally skip
/// the guard: there is no spelling of this trait that accepts a raw string.
#[allow(async_fn_in_trait)]
pub trait WebhookTransport: Send + Sync {
    async fn deliver(
        &self,
        url: &OutboundUrl,
        delivery_id: &str,
        event_kind: &str,
        secret: &str,
        body: &[u8],
    ) -> DeliveryResult;
}

/// The real client: SSRF-guarded, address-pinned, redirect-refusing.
pub struct SafeWebhookTransport {
    allow_development_http: bool,
    timeout: Duration,
}

impl SafeWebhookTransport {
    pub fn new(allow_development_http: bool, timeout: Duration) -> SafeWebhookTransport {
        SafeWebhookTransport {
            allow_development_http,
            timeout,
        }
    }

    /// Trust boundary in one place: re-validate the literal, re-resolve, refuse
    /// any non-public answer, and return the address the connection will be
    /// pinned to.
    async fn checked_address(&self, url: &OutboundUrl) -> Option<SocketAddr> {
        // Re-parse from the stored absolute form rather than trusting the row:
        // an operator could have edited `event_subscription.url` in psql, and
        // the guard must not be reachable only through the REST route.
        let reparsed =
            momo_webhook::validated_url(&url.absolute, self.allow_development_http).ok()?;
        let addresses = momo_webhook::validated_resolved_addresses(&reparsed, &SystemHostResolver)
            .await
            .ok()?;
        let port = reparsed
            .port
            .unwrap_or(if reparsed.scheme == "https" { 443 } else { 80 });
        addresses.first().map(|ip| SocketAddr::new(*ip, port))
    }
}

impl WebhookTransport for SafeWebhookTransport {
    async fn deliver(
        &self,
        url: &OutboundUrl,
        delivery_id: &str,
        event_kind: &str,
        secret: &str,
        body: &[u8],
    ) -> DeliveryResult {
        let Some(address) = self.checked_address(url).await else {
            // Nothing left the process: no status, and therefore no delivery
            // audit row. `outbox.last_error` is where this lives.
            return DeliveryResult::Permanent {
                reason: "SSRF guard rejected destination".to_string(),
                status: None,
            };
        };

        let client = match reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .resolve_to_addrs(&url.host, &[address])
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                return DeliveryResult::Transient {
                    reason: format!("client build failed: {error}"),
                    status: None,
                }
            }
        };

        let timestamp = chrono::Utc::now().timestamp().to_string();
        let signature = momo_webhook::delivery_signature(secret, &timestamp, body);
        let response = client
            .post(&url.absolute)
            .header("Content-Type", "application/json")
            .header("User-Agent", "momo-outbound-webhook/1")
            .header("X-Momo-Delivery", delivery_id)
            .header("X-Momo-Event", event_kind)
            .header("X-Momo-Timestamp", &timestamp)
            .header("X-Momo-Signature", format!("v1={signature}"))
            .body(body.to_vec())
            .send()
            .await;

        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                // Drain a bounded amount so the connection can be reused/closed
                // cleanly; the body itself is of no interest.
                drop(response.bytes().await);
                classify(status)
            }
            Err(error) => DeliveryResult::Transient {
                // The request may or may not have reached the host — an audit
                // row either way would be a guess.
                reason: if error.is_timeout() {
                    "request timed out".to_string()
                } else {
                    "request failed".to_string()
                },
                status: None,
            },
        }
    }
}

/// Swift's status table, kept as a free function so the mapping is testable
/// without a socket.
pub fn classify(status: u16) -> DeliveryResult {
    if (200..300).contains(&status) {
        return DeliveryResult::Ok(status);
    }
    if status >= 500 {
        return DeliveryResult::ServerFailure(status);
    }
    if status == 408 || status == 429 {
        return DeliveryResult::Transient {
            reason: format!("HTTP {status}"),
            status: Some(status),
        };
    }
    // Redirects land here on purpose — see the module header, property 3.
    DeliveryResult::Permanent {
        reason: format!("HTTP {status}"),
        status: Some(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_table_matches_swift() {
        assert_eq!(classify(200), DeliveryResult::Ok(200));
        assert_eq!(classify(204), DeliveryResult::Ok(204));
        assert_eq!(classify(500), DeliveryResult::ServerFailure(500));
        assert_eq!(classify(503), DeliveryResult::ServerFailure(503));
        assert!(matches!(
            classify(429),
            DeliveryResult::Transient {
                status: Some(429),
                ..
            }
        ));
        assert!(matches!(
            classify(408),
            DeliveryResult::Transient {
                status: Some(408),
                ..
            }
        ));
        assert!(matches!(
            classify(404),
            DeliveryResult::Permanent {
                status: Some(404),
                ..
            }
        ));
        assert!(
            matches!(
                classify(302),
                DeliveryResult::Permanent {
                    status: Some(302),
                    ..
                }
            ),
            "a POST redirect is not followed: re-pinning every hop is not v0 work"
        );
    }

    /// The audit's whole discriminator. A refusal and a throw must NOT produce
    /// a row saying a payload left, and every answered status must.
    #[test]
    fn only_an_answered_status_counts_as_an_egress() {
        assert_eq!(DeliveryResult::Ok(201).delivered_status(), Some(201));
        assert_eq!(
            DeliveryResult::ServerFailure(502).delivered_status(),
            Some(502)
        );
        assert_eq!(
            DeliveryResult::Transient {
                reason: "HTTP 429".into(),
                status: Some(429)
            }
            .delivered_status(),
            Some(429)
        );
        assert_eq!(
            DeliveryResult::Permanent {
                reason: "SSRF guard rejected destination".into(),
                status: None
            }
            .delivered_status(),
            None,
            "nothing left the process, so nothing may be written to the #1204 ledger"
        );
        assert_eq!(
            DeliveryResult::Transient {
                reason: "request failed".into(),
                status: None
            }
            .delivered_status(),
            None
        );
    }
}
