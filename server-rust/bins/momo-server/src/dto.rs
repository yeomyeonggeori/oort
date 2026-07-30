//! Wire DTOs — request/response bodies, field-for-field with the Swift server.
//!
//! Parity sources: `server/Sources/MomoServer/Routes/DTOs.swift` and
//! `docs/api/openapi.yaml`. Two rules keep the clients unchanged:
//!   * keys are camelCase (`clientMsgId`, `createdAtMs`, `realtimeWebSocketUrl`);
//!   * `null` optionals are **omitted**, because Swift's synthesized `Encodable`
//!     uses `encodeIfPresent` — an emitted `null` would be a contract change.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
    /// `"ok"` once the DB round-trip succeeds — the packet's DB ping.
    pub database: &'static str,
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/// `POST /v1/auth/login` request (Swift `LoginRequest`). `platformAdminSecret`
/// keeps its snake_case alias so both spellings decode.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    #[serde(default, alias = "platform_admin_secret")]
    pub platform_admin_secret: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
}

/// `POST /v1/auth/login` response (Swift `LoginResponse`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub member: MemberDto,
    /// ADR-0110: the only authority for the realtime WebSocket address.
    pub realtime_web_socket_url: String,
}

/// Swift `MemberDTO`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDto {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub display_name: String,
    pub handle: String,
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/// `POST …/messages` request (Swift `SendMessageRequest`).
///
/// Closed-world like the Swift decoder (ADR-0134 D1): an unknown key is a 400,
/// never a silently dropped field. The keys this batch does not serve
/// (`rootId`, `runId`, `attachmentIds`, `routing`) are decoded so the handler can
/// reject them **visibly** instead of accepting the request and dropping the
/// intent on the floor.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMessageRequest {
    pub client_msg_id: Uuid,
    #[serde(default)]
    pub root_id: Option<Uuid>,
    #[serde(default, rename = "type")]
    pub message_type: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    /// Flat string→string map in v0 (Swift `[String: String]?`).
    #[serde(default)]
    pub props: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub run_id: Option<Uuid>,
    #[serde(default)]
    pub attachment_ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub routing: Option<Value>,
}

/// A message on the wire (Swift `MessageDTO` / openapi `Message`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    pub seq: i64,
    pub hlc_ts: i64,
    pub hlc_count: i32,
    pub author_member_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_msg_id: Option<String>,
    pub created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

/// `GET …/messages` response (Swift `MessagePage`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<MessageDto>,
    /// Cursor for the next (older) page; `null` at the start of history. Swift
    /// encodes this key even when nil, so it is NOT skipped here.
    pub next_before: Option<i64>,
}

/// Query string of `GET …/messages`. Values are parsed leniently (Swift uses
/// `Int($0)` and ignores garbage) so a malformed cursor degrades to the default
/// page instead of a 400.
#[derive(Debug, Default, Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub after: Option<String>,
}

impl HistoryQuery {
    pub fn limit(&self) -> Option<i64> {
        self.limit.as_deref().and_then(|raw| raw.parse().ok())
    }

    pub fn before(&self) -> Option<i64> {
        self.before.as_deref().and_then(|raw| raw.parse().ok())
    }

    pub fn after(&self) -> Option<i64> {
        self.after.as_deref().and_then(|raw| raw.parse().ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_dto_omits_null_optionals_like_swift() {
        let dto = MessageDto {
            id: "m".into(),
            channel_id: "c".into(),
            root_id: None,
            seq: 3,
            hlc_ts: 12,
            hlc_count: 0,
            author_member_id: "a".into(),
            message_type: "text".into(),
            body: Some("hi".into()),
            props: None,
            client_msg_id: None,
            created_at_ms: 99,
            state: None,
        };
        let json = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(json["seq"], 3);
        assert_eq!(json["hlcTs"], 12);
        assert_eq!(json["hlcCount"], 0);
        assert_eq!(json["authorMemberId"], "a");
        assert_eq!(json["type"], "text");
        assert_eq!(json["createdAtMs"], 99);
        assert!(json.get("rootId").is_none(), "nil optionals are omitted");
        assert!(json.get("props").is_none());
        assert!(json.get("state").is_none());
    }

    #[test]
    fn login_response_uses_swift_camel_case_keys() {
        let json = serde_json::to_value(LoginResponse {
            access_token: "a".into(),
            refresh_token: "r".into(),
            member: MemberDto {
                id: "m".into(),
                workspace_id: "w".into(),
                kind: "human".into(),
                display_name: "Name".into(),
                handle: "name".into(),
            },
            realtime_web_socket_url: "ws://host/connection/websocket".into(),
        })
        .expect("serialize");
        assert_eq!(json["accessToken"], "a");
        assert_eq!(json["refreshToken"], "r");
        assert_eq!(
            json["realtimeWebSocketUrl"],
            "ws://host/connection/websocket"
        );
        assert_eq!(json["member"]["workspaceId"], "w");
        assert_eq!(json["member"]["displayName"], "Name");
    }

    #[test]
    fn send_request_is_closed_world() {
        let ok: Result<SendMessageRequest, _> = serde_json::from_value(serde_json::json!({
            "clientMsgId": Uuid::nil(),
            "type": "text",
            "body": "hello",
            "props": {"k": "v"},
        }));
        let ok = ok.expect("known keys decode");
        assert_eq!(ok.body.as_deref(), Some("hello"));
        assert_eq!(ok.props.unwrap().get("k").map(String::as_str), Some("v"));

        let rejected: Result<SendMessageRequest, _> = serde_json::from_value(serde_json::json!({
            "clientMsgId": Uuid::nil(),
            // ADR-0134 D1: a typo must fail loudly, not be silently dropped.
            "routting": {"model": "x"},
        }));
        assert!(rejected.is_err(), "unknown key must be rejected");
    }

    #[test]
    fn login_request_accepts_both_admin_secret_spellings() {
        let camel: LoginRequest = serde_json::from_value(serde_json::json!({
            "email": "a@b.c", "password": "p", "platformAdminSecret": "s",
        }))
        .expect("camelCase");
        assert_eq!(camel.platform_admin_secret.as_deref(), Some("s"));
        let snake: LoginRequest = serde_json::from_value(serde_json::json!({
            "email": "a@b.c", "password": "p", "platform_admin_secret": "s",
        }))
        .expect("snake_case");
        assert_eq!(snake.platform_admin_secret.as_deref(), Some("s"));
    }

    #[test]
    fn history_query_parses_leniently() {
        let query = HistoryQuery {
            limit: Some("25".into()),
            before: Some("nonsense".into()),
            after: None,
        };
        assert_eq!(query.limit(), Some(25));
        assert_eq!(query.before(), None, "garbage cursor is ignored, not a 400");
        assert_eq!(query.after(), None);
    }
}
