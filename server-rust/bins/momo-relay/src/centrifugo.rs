//! Centrifugo server-API client — `POST {api_url}/publish` (and `/broadcast` for a room frame
//! diverted to personal channels, ADR-0177 증보 D17) with `X-API-Key`.
//!
//! Invariant #2 in one file: **this is the only Centrifugo writer in the
//! workspace.** Domain crates and `momo-server` have no HTTP client at all, so
//! nothing but a drained outbox row can reach a subscriber.
//!
//! Parity with Swift `CentrifugoClient.publish`
//! (`relay/OutboxRelay/.../CentrifugoClient.swift`):
//!   * body = `{channel, data, version, idempotency_key}` taken verbatim from the
//!     outbox row — the relay never reshapes the app's event payload (a diverted
//!     room frame only gains its room's name, [`crate::audience::ROOM_CHANNEL_KEY`]);
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

/// `POST /api/broadcast` — one frame to several channels (ADR-0177 증보 D17: a room frame
/// diverted to its audience's personal channels). No `version`: a personal channel carries frames
/// of many rooms, so a room's seq is not an order there.
#[derive(Debug, Serialize)]
struct BroadcastRequest<'a> {
    channels: &'a [String],
    data: &'a serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    idempotency_key: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct CentrifugoClient {
    http: reqwest::Client,
    publish_url: String,
    broadcast_url: String,
    api_key: String,
}

impl CentrifugoClient {
    pub fn new(api_url: &str, api_key: impl Into<String>) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        let base = api_url.trim_end_matches('/');
        Ok(CentrifugoClient {
            http,
            publish_url: format!("{base}/publish"),
            broadcast_url: format!("{base}/broadcast"),
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
        self.send(&self.publish_url, &body, logical_error).await
    }

    /// Publish one frame to `channels` in one call. A per-channel error in the answer is not a
    /// success: the row is settled by the worst of them (see [`broadcast_error`]).
    pub async fn broadcast(
        &self,
        channels: &[String],
        data: &serde_json::Value,
        idempotency_key: Option<&str>,
    ) -> PublishOutcome {
        let body = BroadcastRequest {
            channels,
            data,
            idempotency_key,
        };
        self.send(&self.broadcast_url, &body, broadcast_error).await
    }

    async fn send<B: Serialize>(
        &self,
        url: &str,
        body: &B,
        read_error: fn(&str) -> Option<BodyError>,
    ) -> PublishOutcome {
        let response = self
            .http
            .post(url)
            .header("X-API-Key", &self.api_key)
            .json(body)
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
            return match read_error(&text) {
                Some(BodyError::Permanent(error)) => {
                    PublishOutcome::Permanent(format!("centrifugo error: {error}"))
                }
                Some(BodyError::Transient(error)) => {
                    PublishOutcome::Transient(format!("centrifugo error: {error}"))
                }
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

/// An error a 200 answer carried.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BodyError {
    Permanent(String),
    Transient(String),
}

/// Centrifugo's internal-error code — the one error a retry can fix.
const CODE_INTERNAL: u64 = 100;

/// The publish answer's error, if any: every logical error is permanent (Swift parity).
fn logical_error(body: &str) -> Option<BodyError> {
    error_text(body).map(BodyError::Permanent)
}

/// The broadcast answer's error, if any. A top-level error is permanent like a publish's. The
/// answer also holds one response per channel (`result.responses[i]`); an internal error in any
/// of them is transient (the retry re-sends to every channel, and the idempotency key, which acts
/// per channel, keeps the ones that landed from landing twice), any other is permanent.
fn broadcast_error(body: &str) -> Option<BodyError> {
    if let Some(error) = error_text(body) {
        return Some(BodyError::Permanent(error));
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let responses = value.pointer("/result/responses")?.as_array()?;
    let mut worst: Option<BodyError> = None;
    for response in responses {
        let Some(error) = response.get("error").and_then(|e| e.as_object()) else {
            continue;
        };
        let code = error.get("code").and_then(|code| code.as_u64());
        let text = format!(
            "code={} message={}",
            code.map(|code| code.to_string())
                .unwrap_or_else(|| "?".to_string()),
            error
                .get("message")
                .and_then(|message| message.as_str())
                .unwrap_or("unknown")
        );
        if code == Some(CODE_INTERNAL) {
            if worst.is_none() {
                worst = Some(BodyError::Transient(text));
            }
        } else {
            return Some(BodyError::Permanent(text));
        }
    }
    worst
}

/// Decode a Centrifugo `{"error":{"code":…,"message":…}}` envelope; `None` when
/// the body carries no error (i.e. a real success).
fn error_text(body: &str) -> Option<String> {
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
        assert_eq!(
            error,
            BodyError::Permanent("code=102 message=unknown channel".into())
        );
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
    fn a_broadcast_answer_is_read_channel_by_channel() {
        assert_eq!(
            broadcast_error(r#"{"result":{"responses":[{"result":{}},{"result":{}}]}}"#),
            None
        );
        assert_eq!(
            broadcast_error(
                r#"{"result":{"responses":[{"result":{}},{"error":{"code":100,"message":"internal server error"}}]}}"#
            ),
            Some(BodyError::Transient(
                "code=100 message=internal server error".into()
            ))
        );
        assert_eq!(
            broadcast_error(
                r#"{"result":{"responses":[{"error":{"code":100,"message":"internal"}},{"error":{"code":102,"message":"unknown channel"}}]}}"#
            ),
            Some(BodyError::Permanent(
                "code=102 message=unknown channel".into()
            )),
            "a permanent error anywhere settles the row as failed"
        );
        assert_eq!(
            broadcast_error(r#"{"error":{"code":107,"message":"bad request"}}"#),
            Some(BodyError::Permanent("code=107 message=bad request".into()))
        );
    }

    #[test]
    fn a_broadcast_body_has_no_version() {
        let data = json!({"type": "message.edited", "seq": 3});
        let channels = vec!["user:read-state#A".to_string()];
        let body = serde_json::to_value(BroadcastRequest {
            channels: &channels,
            data: &data,
            idempotency_key: Some("ch:wsA.B:message.edited:K"),
        })
        .expect("serialize");
        assert_eq!(
            body,
            json!({
                "channels": ["user:read-state#A"],
                "data": {"type": "message.edited", "seq": 3},
                "idempotency_key": "ch:wsA.B:message.edited:K",
            })
        );
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
