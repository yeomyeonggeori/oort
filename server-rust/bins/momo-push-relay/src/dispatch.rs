//! Closed `momo.push.dispatch.v2` envelope and the id-only APNs payload.
//!
//! Accepting an extra `body`, display name, or channel name would silently
//! widen ADR-0120's content boundary. `decode_closed` compares the JSON key
//! set exactly against the whitelist.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DISPATCH_SCHEMA: &str = "momo.push.dispatch.v2";
pub const NOTIFICATION_SCHEMA: &str = "momo.push.notification.v2";

const REQUIRED_KEYS: &[&str] = &[
    "schema",
    "server_id",
    "workspace_id",
    "device_id",
    "device_platform",
    "apns_token",
    "apns_env",
    "apns_topic",
    "collapse_id",
    "badge",
    "reason",
    "thread_id",
    "category",
    "channel_id",
    "message_id",
];

const ALLOWED_REASONS: &[&str] = &["dm", "mention", "approval_request", "resume_offer"];
const ALLOWED_CATEGORIES: &[&str] = &["momo.message", "momo.mention", "momo.approval", "momo.work"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushDispatch {
    pub schema: String,
    pub server_id: String,
    pub workspace_id: String,
    pub device_id: String,
    pub device_platform: String,
    pub apns_token: String,
    pub apns_env: String,
    pub apns_topic: String,
    pub collapse_id: String,
    pub badge: i64,
    pub reason: String,
    pub thread_id: String,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    pub channel_id: String,
    pub message_id: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DispatchError {
    #[error("invalid momo.push.dispatch.v2 payload")]
    InvalidFieldSet,
    #[error("invalid momo.push.dispatch.v2 payload")]
    Schema,
    #[error("invalid momo.push.dispatch.v2 payload")]
    MissingValue,
    #[error("invalid momo.push.dispatch.v2 payload")]
    DevicePlatform,
    #[error("invalid momo.push.dispatch.v2 payload")]
    ApnsEnvironment,
    #[error("invalid momo.push.dispatch.v2 payload")]
    Reason,
    #[error("invalid momo.push.dispatch.v2 payload")]
    Category,
    #[error("invalid momo.push.dispatch.v2 payload")]
    Badge,
    #[error("invalid momo.push.dispatch.v2 payload")]
    ApprovalId,
    #[error("invalid momo.push.dispatch.v2 payload")]
    ApnsToken,
    #[error("invalid momo.push.dispatch.v2 payload")]
    ApnsTopic,
    #[error("invalid momo.push.dispatch.v2 payload")]
    CollapseId,
}

#[cfg(test)]
pub(crate) const TEST_DISPATCH_JSON: &str = r#"{"schema":"momo.push.dispatch.v2","server_id":"server-a","workspace_id":"11111111-1111-1111-1111-111111111111","device_id":"22222222-2222-2222-2222-222222222222","device_platform":"ios","apns_token":"deadbeefdeadbeef","apns_env":"sandbox","apns_topic":"com.momo.app","collapse_id":"msg-1","badge":1,"reason":"mention","thread_id":"33333333-3333-3333-3333-333333333333","category":"momo.mention","channel_id":"33333333-3333-3333-3333-333333333333","message_id":"44444444-4444-4444-4444-444444444444"}"#;

impl PushDispatch {
    pub fn decode_closed(raw: &[u8]) -> Result<Self, DispatchError> {
        let value: Value =
            serde_json::from_slice(raw).map_err(|_| DispatchError::InvalidFieldSet)?;
        let object = value.as_object().ok_or(DispatchError::InvalidFieldSet)?;
        let dispatch: PushDispatch =
            serde_json::from_value(value.clone()).map_err(|_| DispatchError::InvalidFieldSet)?;
        let mut expected: BTreeSet<&str> = REQUIRED_KEYS.iter().copied().collect();
        if dispatch.category == "momo.approval" {
            expected.insert("approval_id");
        }
        let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        if actual != expected {
            return Err(DispatchError::InvalidFieldSet);
        }
        dispatch.validate()?;
        Ok(dispatch)
    }

    fn validate(&self) -> Result<(), DispatchError> {
        if self.schema != DISPATCH_SCHEMA {
            return Err(DispatchError::Schema);
        }
        if self.server_id.is_empty()
            || self.workspace_id.is_empty()
            || self.device_id.is_empty()
            || self.apns_token.is_empty()
            || self.apns_topic.is_empty()
            || self.collapse_id.is_empty()
            || self.thread_id.is_empty()
            || self.channel_id.is_empty()
            || self.message_id.is_empty()
        {
            return Err(DispatchError::MissingValue);
        }
        if self.device_platform != "ios" && self.device_platform != "macos" {
            return Err(DispatchError::DevicePlatform);
        }
        if self.apns_env != "sandbox" && self.apns_env != "production" {
            return Err(DispatchError::ApnsEnvironment);
        }
        if !ALLOWED_REASONS.contains(&self.reason.as_str()) {
            return Err(DispatchError::Reason);
        }
        if !ALLOWED_CATEGORIES.contains(&self.category.as_str()) {
            return Err(DispatchError::Category);
        }
        let approval_present = self.approval_id.is_some();
        if (self.category == "momo.approval") != approval_present {
            return Err(DispatchError::ApprovalId);
        }
        if let Some(approval_id) = &self.approval_id {
            if uuid::Uuid::parse_str(approval_id).is_err() {
                return Err(DispatchError::ApprovalId);
            }
        }
        if self.badge < 0 {
            return Err(DispatchError::Badge);
        }
        let token_len = self.apns_token.len();
        if !(16..=512).contains(&token_len)
            || !self.apns_token.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err(DispatchError::ApnsToken);
        }
        if self.apns_topic.len() > 256
            || self.apns_topic.chars().any(|c| {
                c.is_whitespace() || {
                    let value = c as u32;
                    value < 0x20 || value == 0x7f
                }
            })
        {
            return Err(DispatchError::ApnsTopic);
        }
        if self.collapse_id.len() > 64 {
            return Err(DispatchError::CollapseId);
        }
        Ok(())
    }
}

/// The APNs HTTP/2 body. Static placeholder alert only — the device NSE
/// fetches the real content from its own server.
#[derive(Debug, Serialize)]
pub struct ApnsPayload {
    pub aps: Aps,
    pub momo: MomoEnvelope,
}

#[derive(Debug, Serialize)]
pub struct Aps {
    pub alert: ApsAlert,
    pub badge: i64,
    #[serde(rename = "thread-id")]
    pub thread_id: String,
    pub category: String,
    #[serde(rename = "mutable-content")]
    pub mutable_content: u8,
    #[serde(rename = "content-available")]
    pub content_available: u8,
}

#[derive(Debug, Serialize)]
pub struct ApsAlert {
    pub title: &'static str,
    pub body: &'static str,
}

#[derive(Debug, Serialize)]
pub struct MomoEnvelope {
    pub schema: &'static str,
    pub server_id: String,
    pub workspace_id: String,
    pub channel_id: String,
    pub message_id: String,
    pub collapse_id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
}

impl ApnsPayload {
    pub fn from_dispatch(dispatch: &PushDispatch) -> Self {
        ApnsPayload {
            aps: Aps {
                alert: ApsAlert {
                    title: "oort",
                    body: "새 알림",
                },
                badge: dispatch.badge,
                thread_id: dispatch.thread_id.clone(),
                category: dispatch.category.clone(),
                mutable_content: 1,
                content_available: 1,
            },
            momo: MomoEnvelope {
                schema: NOTIFICATION_SCHEMA,
                server_id: dispatch.server_id.clone(),
                workspace_id: dispatch.workspace_id.clone(),
                channel_id: dispatch.channel_id.clone(),
                message_id: dispatch.message_id.clone(),
                collapse_id: dispatch.collapse_id.clone(),
                reason: dispatch.reason.clone(),
                approval_id: dispatch.approval_id.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const DISPATCH_JSON: &str = TEST_DISPATCH_JSON;

    #[test]
    fn closed_dispatch_and_apns_payload_use_only_static_placeholder_content() {
        let dispatch = PushDispatch::decode_closed(DISPATCH_JSON.as_bytes()).unwrap();
        let encoded = serde_json::to_vec(&ApnsPayload::from_dispatch(&dispatch)).unwrap();
        let object: serde_json::Map<String, Value> = serde_json::from_slice(&encoded).unwrap();
        let keys: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        assert_eq!(keys, BTreeSet::from(["aps", "momo"]));

        let aps = object["aps"].as_object().unwrap();
        let aps_keys: BTreeSet<&str> = aps.keys().map(String::as_str).collect();
        assert_eq!(
            aps_keys,
            BTreeSet::from([
                "alert",
                "badge",
                "thread-id",
                "category",
                "mutable-content",
                "content-available",
            ])
        );
        assert_eq!(aps["thread-id"], "33333333-3333-3333-3333-333333333333");
        assert_eq!(aps["category"], "momo.mention");
        let alert = aps["alert"].as_object().unwrap();
        let alert_keys: BTreeSet<&str> = alert.keys().map(String::as_str).collect();
        assert_eq!(alert_keys, BTreeSet::from(["title", "body"]));
        assert_eq!(alert["title"], "oort");
        assert_eq!(alert["body"], "새 알림");

        let momo = object["momo"].as_object().unwrap();
        let momo_keys: BTreeSet<&str> = momo.keys().map(String::as_str).collect();
        assert_eq!(
            momo_keys,
            BTreeSet::from([
                "schema",
                "server_id",
                "workspace_id",
                "channel_id",
                "message_id",
                "collapse_id",
                "reason",
            ])
        );
        assert_eq!(momo["schema"], "momo.push.notification.v2");
        assert!(!momo.contains_key("approval_id"));

        let text = String::from_utf8(encoded).unwrap();
        for forbidden in [
            "message_body",
            "display_name",
            "handle",
            "channel_name",
            "apns_token",
        ] {
            assert!(
                !text.contains(forbidden),
                "id-only payload contained {forbidden}"
            );
        }
    }

    #[test]
    fn closed_dispatch_rejects_extra_body_field() {
        let widened = format!(
            "{},\"body\":\"secret\"}}",
            DISPATCH_JSON.trim_end_matches('}')
        );
        assert_eq!(
            PushDispatch::decode_closed(widened.as_bytes()).unwrap_err(),
            DispatchError::InvalidFieldSet
        );
    }

    #[test]
    fn approval_payload_carries_approval_id_only_for_approval_category() {
        let approval_id = "55555555-5555-5555-5555-555555555555";
        let json = DISPATCH_JSON
            .replace(
                "\"category\":\"momo.mention\"",
                "\"category\":\"momo.approval\"",
            )
            .replace(
                "\"channel_id\"",
                &format!("\"approval_id\":\"{approval_id}\",\"channel_id\""),
            );
        let dispatch = PushDispatch::decode_closed(json.as_bytes()).unwrap();
        let encoded = serde_json::to_vec(&ApnsPayload::from_dispatch(&dispatch)).unwrap();
        let object: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(object["momo"]["approval_id"], approval_id);

        let invalid = DISPATCH_JSON.replace(
            "\"channel_id\"",
            &format!("\"approval_id\":\"{approval_id}\",\"channel_id\""),
        );
        assert!(PushDispatch::decode_closed(invalid.as_bytes()).is_err());
    }

    #[test]
    fn resume_offer_is_an_allowed_work_dispatch() {
        let json = DISPATCH_JSON
            .replace("\"reason\":\"mention\"", "\"reason\":\"resume_offer\"")
            .replace(
                "\"category\":\"momo.mention\"",
                "\"category\":\"momo.work\"",
            );
        assert!(PushDispatch::decode_closed(json.as_bytes()).is_ok());
    }

    /// Pins ADR-0120 부록 A (미결): judgment can emit `work_session_idle`,
    /// the relay still takes only the other four reasons.
    #[test]
    fn work_session_idle_is_rejected_even_though_its_category_is_allowed() {
        let json = DISPATCH_JSON
            .replace("\"reason\":\"mention\"", "\"reason\":\"work_session_idle\"")
            .replace(
                "\"category\":\"momo.mention\"",
                "\"category\":\"momo.work\"",
            );
        assert_eq!(
            PushDispatch::decode_closed(json.as_bytes()).unwrap_err(),
            DispatchError::Reason
        );
    }
}
