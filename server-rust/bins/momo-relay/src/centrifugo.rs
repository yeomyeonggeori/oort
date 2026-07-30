//! Centrifugo server-API client — `POST {api_url}/publish` with `X-API-Key`.
//!
//! Invariant #2 in one file: **this is the only Centrifugo writer in the
//! workspace.** Domain crates and `momo-server` have no HTTP client at all, so
//! nothing but a drained outbox row can reach a subscriber.
//!
//! Parity with Swift `CentrifugoClient.publish`
//! (`relay/OutboxRelay/.../CentrifugoClient.swift`):
//!   * body = `{channel, data, version, idempotency_key}` taken verbatim from the
//!     outbox row — the relay never reshapes the app's event payload;
//!   * `version = message.seq` (history dedup) and
//!     `idempotency_key = "<channel>:<seq>"` (Centrifugo's 5-minute cache) are
//!     what make this at-least-once relay safe to retry (L4 §4.3);
//!   * Centrifugo answers 200 even for logical errors, so a `{"error":{…}}`
//!     envelope in a 200 body is a **permanent** failure;
//!   * 429/5xx are transient (retry with backoff), other 4xx permanent.

use std::time::Duration;

use momo_wire::payload::BroadcastPayload;
use serde::Serialize;

/// Outcome of one publish attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishOutcome {
    /// Accepted by Centrifugo.
    Ok,
    /// Retryable (network, timeout, 429, 5xx).
    Transient(String),
    /// Never going to succeed (4xx, logical error envelope, malformed row).
    Permanent(String),
}

#[derive(Debug, Serialize)]
struct PublishRequest<'a> {
    channel: &'a str,
    data: &'a serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    idempotency_key: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct CentrifugoClient {
    http: reqwest::Client,
    publish_url: String,
    api_key: String,
}

impl CentrifugoClient {
    pub fn new(api_url: &str, api_key: impl Into<String>) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(CentrifugoClient {
            http,
            publish_url: format!("{}/publish", api_url.trim_end_matches('/')),
            api_key: api_key.into(),
        })
    }

    /// Publish one broadcast payload. Never returns `Err`: every failure is
    /// classified into [`PublishOutcome`] so the caller always settles the row.
    pub async fn publish(&self, payload: &BroadcastPayload) -> PublishOutcome {
        let body = PublishRequest {
            channel: &payload.channel,
            data: &payload.data,
            version: payload.version,
            idempotency_key: payload.idempotency_key.as_deref(),
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
            // Network/timeout — the row goes back to pending with backoff.
            Err(error) => return PublishOutcome::Transient(format!("publish failed: {error}")),
        };

        let status = response.status();
        if status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return match logical_error(&text) {
                Some(error) => PublishOutcome::Permanent(format!("centrifugo error: {error}")),
                None => PublishOutcome::Ok,
            };
        }
        if status.as_u16() == 429 || status.is_server_error() {
            PublishOutcome::Transient(format!("HTTP {}", status.as_u16()))
        } else {
            PublishOutcome::Permanent(format!("HTTP {}", status.as_u16()))
        }
    }
}

/// Decode a Centrifugo `{"error":{"code":…,"message":…}}` envelope; `None` when
/// the body carries no error (i.e. a real success).
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
    use serde_json::json;

    #[test]
    fn a_200_with_an_error_envelope_is_a_logical_failure() {
        // Centrifugo answers 200 for "unknown channel"; treating that as success
        // would silently drop the broadcast.
        let error = logical_error(r#"{"error":{"code":102,"message":"unknown channel"}}"#)
            .expect("error envelope detected");
        assert_eq!(error, "code=102 message=unknown channel");
    }

    #[test]
    fn an_empty_or_plain_result_body_is_success() {
        assert!(logical_error("").is_none());
        assert!(logical_error("{}").is_none());
        assert!(logical_error(r#"{"result":{}}"#).is_none());
    }

    #[test]
    fn publish_body_forwards_version_and_idempotency_key() {
        let payload = BroadcastPayload {
            channel: "ch:wsA.B".to_string(),
            data: json!({"type": "message.new", "seq": 7}),
            version: Some(7),
            idempotency_key: Some("ch:wsA.B:7".to_string()),
        };
        let body = serde_json::to_value(PublishRequest {
            channel: &payload.channel,
            data: &payload.data,
            version: payload.version,
            idempotency_key: payload.idempotency_key.as_deref(),
        })
        .expect("serialize");
        assert_eq!(body["channel"], json!("ch:wsA.B"));
        assert_eq!(body["version"], json!(7), "version = message.seq");
        assert_eq!(body["idempotency_key"], json!("ch:wsA.B:7"));
        // The event envelope is forwarded verbatim, not reshaped.
        assert_eq!(body["data"], payload.data);
    }

    #[test]
    fn absent_version_and_key_are_omitted_like_swift() {
        let data = json!({});
        let body = serde_json::to_value(PublishRequest {
            channel: "ch",
            data: &data,
            version: None,
            idempotency_key: None,
        })
        .expect("serialize");
        assert!(body.get("version").is_none());
        assert!(body.get("idempotency_key").is_none());
    }
}
