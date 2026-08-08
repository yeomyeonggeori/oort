//! The ephemeral Centrifugo writer — `POST {api_url}/publish` with `X-API-Key`.
//!
//! This is the **second** Centrifugo writer in the workspace, and ADR-0149 is
//! the decision that admits it. The first is `momo-relay`, which publishes what
//! a drained `outbox` row tells it to; this one publishes what a REST request
//! asked for, without touching Postgres on the way.
//!
//! The two differ in exactly the ways the decision requires:
//!
//! | | relay | this |
//! |---|---|---|
//! | source | an `outbox` row (durable) | a REST call (nothing persisted) |
//! | payload | forwarded verbatim | built from [`EphemeralSignal`], never from caller JSON |
//! | `version` / `idempotency_key` | `message.seq` / `<channel>:<seq>` | **neither** — no history, no dedup |
//! | retry | the outbox re-claims the row | none: a lost 「작성 중」 is re-sent 3 seconds later by the client |
//! | timeout | 10s | 2s — a typing publish must never hold a request open |
//!
//! The last row is the reason there is no retry loop here at all. A durable
//! broadcast that fails must eventually arrive, so the relay owns backoff and
//! attempts. An ephemeral signal that fails is simply **stale**: the client is
//! already scheduled to send a fresher one, and retrying would deliver a
//! 「작성 중」 that is no longer true.

use serde::Serialize;
use std::time::Duration;

use crate::signal::EphemeralSignal;

/// How long the server waits on Centrifugo before giving up.
///
/// Deliberately far below the relay's 10s: this call sits inside a client
/// request that repeats every 3 seconds, so a slow broker must degrade into a
/// dropped hint rather than into a queue of held-open API requests.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(2);

/// Outcome of one ephemeral publish attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EphemeralPublishOutcome {
    /// Accepted by Centrifugo.
    Ok,
    /// The broker could not be reached or refused transiently. The caller
    /// answers 502; the client's next republish is the retry.
    Unavailable(String),
    /// Centrifugo understood and refused (4xx, or a `{"error":{…}}` envelope in
    /// a 200 body). Retrying cannot help, so this is a server fault to log.
    Rejected(String),
}

/// The Centrifugo publish body. **No `version`, no `idempotency_key`** — see
/// the module table.
#[derive(Debug, Serialize)]
struct EphemeralPublishRequest<'a> {
    channel: &'a str,
    data: &'a serde_json::Value,
}

/// The only object in `momo-server`'s reach that can talk to Centrifugo.
///
/// Its whole API is [`publish`](Self::publish), and `publish` takes an
/// [`EphemeralSignal`] — not a channel, not a `serde_json::Value`. That is
/// ADR-0149 guard 2 expressed as a type: there is no call this crate exposes
/// that could put arbitrary data on an arbitrary channel.
#[derive(Debug, Clone)]
pub struct EphemeralPublisher {
    http: reqwest::Client,
    publish_url: String,
    api_key: String,
}

impl EphemeralPublisher {
    pub fn new(api_url: &str, api_key: impl Into<String>) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(PUBLISH_TIMEOUT)
            .build()?;
        Ok(EphemeralPublisher {
            http,
            publish_url: format!("{}/publish", api_url.trim_end_matches('/')),
            api_key: api_key.into(),
        })
    }

    /// Publish one ephemeral signal. Never returns `Err`: every failure is
    /// classified so the caller always answers the client.
    pub async fn publish(&self, signal: &EphemeralSignal) -> EphemeralPublishOutcome {
        let channel = signal.channel();
        let data = signal.data();
        let body = EphemeralPublishRequest {
            channel: &channel,
            data: &data,
        };
        let response = self
            .http
            .post(&self.publish_url)
            .header("X-API-Key", &self.api_key)
            .json(&body)
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                return EphemeralPublishOutcome::Unavailable(format!("publish failed: {error}"))
            }
        };

        let status = response.status();
        if status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return match logical_error(&text) {
                Some(error) => EphemeralPublishOutcome::Rejected(format!("centrifugo: {error}")),
                None => EphemeralPublishOutcome::Ok,
            };
        }
        if status.as_u16() == 429 || status.is_server_error() {
            EphemeralPublishOutcome::Unavailable(format!("HTTP {}", status.as_u16()))
        } else {
            EphemeralPublishOutcome::Rejected(format!("HTTP {}", status.as_u16()))
        }
    }
}

/// Decode a Centrifugo `{"error":{"code":…,"message":…}}` envelope.
///
/// Centrifugo answers **200** for logical failures such as "unknown channel",
/// so a naive `status.is_success()` would report a dropped publish as a
/// success. Same rule as `momo-relay`, and it is one of the two behaviours the
/// two writers must agree on.
fn logical_error(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?.as_object()?;
    let message = error
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let code = error
        .get("code")
        .map(|code| code.to_string())
        .unwrap_or_else(|| "?".to_string());
    Some(format!("code={code} message={message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::{TypingSignal, TYPING_SIGNAL_TTL_MS};
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn a_200_with_an_error_envelope_is_a_rejection_not_a_success() {
        assert_eq!(
            logical_error(r#"{"error":{"code":102,"message":"unknown channel"}}"#),
            Some("code=102 message=unknown channel".to_string())
        );
        assert!(logical_error("").is_none());
        assert!(logical_error(r#"{"result":{}}"#).is_none());
    }

    /// The publish body is the guard, restated on the wire: a channel this
    /// crate computed and a payload this crate built. Nothing the caller wrote
    /// appears verbatim.
    #[test]
    fn the_publish_body_carries_only_a_signal_this_crate_shaped() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let member = Uuid::new_v4();
        let signal = EphemeralSignal::Typing(TypingSignal::starting_at(
            workspace,
            channel,
            member,
            1_700_000_000_000,
            TYPING_SIGNAL_TTL_MS,
        ));
        let name = signal.channel();
        let data = signal.data();
        let body = serde_json::to_value(EphemeralPublishRequest {
            channel: &name,
            data: &data,
        })
        .expect("serialize");

        assert_eq!(body["channel"], json!(signal.channel()));
        assert_eq!(body["data"]["type"], json!("ephemeral.typing"));
        // The relay sends both of these; this writer must send neither.
        assert!(body.get("version").is_none(), "{body}");
        assert!(body.get("idempotency_key").is_none(), "{body}");
    }

    /// A slow broker must not be able to pin a request open for the relay's
    /// ten seconds — this call is on a 3-second client loop.
    #[test]
    fn the_publish_timeout_is_short_enough_for_a_three_second_loop() {
        assert!(PUBLISH_TIMEOUT <= Duration::from_secs(3));
    }
}
