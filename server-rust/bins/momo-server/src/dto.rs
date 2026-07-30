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

/// `POST /v1/auth/refresh` request (Swift `RefreshRequest`, `DTOs.swift:49-51`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    pub refresh_token: String,
}

/// `POST /v1/auth/refresh` response (Swift `RefreshResponse`, `DTOs.swift:55-58`)
/// — the presented refresh token is revoked (rotation) and a fresh pair issued.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResponse {
    pub access_token: String,
    pub refresh_token: String,
}

/// `POST /v1/auth/logout` optional request body (Swift `LogoutRequest`,
/// `DTOs.swift:63-65`). The access token comes from `Authorization`; the client
/// may also hand in its refresh token so the whole session dies at once.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutRequest {
    #[serde(default)]
    pub refresh_token: Option<String>,
}

/// `POST /v1/auth/logout` response (Swift `LogoutResponse`, `DTOs.swift:69-74`).
/// Idempotent: a repeat call is 200 with `alreadyRevoked=true` and revokes
/// nothing new.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResponse {
    pub status: &'static str,
    pub revoked_access: bool,
    pub revoked_refresh: bool,
    pub already_revoked: bool,
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

// ---------------------------------------------------------------------------
// work hosts (B2.2 — Swift `WorkHostRoutes.swift`)
// ---------------------------------------------------------------------------

/// `POST …/work-hosts` and `POST …/work-hosts/cloud/register` request
/// (Swift `RegisterWorkHostRequest`, :7-13).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterWorkHostRequest {
    pub scope: String,
    #[serde(rename = "type")]
    pub host_type: String,
    pub display_name: String,
    pub public_key: String,
    #[serde(default)]
    pub capabilities: Option<BTreeMap<String, bool>>,
}

/// `POST …/work-hosts/{host}/heartbeat` request (Swift, :15-18).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkHostHeartbeatRequest {
    pub sent_at_ms: i64,
    pub signature: String,
}

/// Swift `WorkHostDTO` (:20-33). `lastSeenAtMs`/`revokedAtMs` are `Int64?` in a
/// synthesized `Encodable`, so a null is **omitted**, not emitted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHostDto {
    pub id: String,
    pub workspace_id: String,
    pub scope: String,
    pub owner_member_id: String,
    #[serde(rename = "type")]
    pub host_type: String,
    pub display_name: String,
    pub public_key: String,
    /// Boolean availability flags only — never paths, credentials or state.
    pub capabilities: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub online: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHostResponse {
    pub work_host: WorkHostDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHostListResponse {
    pub work_hosts: Vec<WorkHostDto>,
}

// ---------------------------------------------------------------------------
// cloud hosts (B2.2 — Swift `CloudProvisionerRoutes.swift`)
// ---------------------------------------------------------------------------

/// `POST …/work-hosts/byoc/enrollments` request (Swift `EnrollBYOCHostRequest`,
/// :18-22). `scope` is accepted only so a personal request can be refused *by
/// name* rather than silently promoted to a workspace-wide host.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollByocHostRequest {
    pub display_name: String,
    #[serde(default)]
    pub scope: Option<String>,
    pub idempotency_ref: String,
}

/// Swift `BYOCEnrollmentDTO` (:24-32). `bootstrapToken` is shown exactly once;
/// only its digest ever reached PostgreSQL.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByocEnrollmentDto {
    pub provision_id: String,
    pub provider: String,
    pub state: String,
    pub bootstrap_token: String,
    pub bootstrap_expires_at_ms: i64,
    pub register_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByocEnrollmentResponse {
    pub enrollment: ByocEnrollmentDto,
}

/// Swift `CloudHostDTO` (:38-44).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHostDto {
    pub provision_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub state: String,
    pub provider: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHostResponse {
    pub cloud_host: CloudHostDto,
}

// ---------------------------------------------------------------------------
// work sessions (B2.2 — Swift `WorkSessionRoutes.swift`)
// ---------------------------------------------------------------------------

/// `POST …/work-sessions` request (Swift `CreateWorkSessionRequest`, :8-16).
///
/// `controlId`/`ptyId`/`attachEndpoint` are decoded so they can be refused
/// **visibly** (ADR-0134 D1): each belongs to a work-host-signed path this batch
/// does not serve, and accepting-then-dropping them would silently change what
/// the caller asked for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkSessionRequest {
    pub channel_id: Uuid,
    pub host_id: Uuid,
    pub tool: String,
    pub label: String,
    #[serde(default)]
    pub control_id: Option<Uuid>,
    #[serde(default)]
    pub pty_id: Option<String>,
    #[serde(default)]
    pub attach_endpoint: Option<String>,
}

/// `PATCH …/work-sessions/{session}` request (Swift `UpdateWorkSessionRequest`,
/// :23-38). This batch serves `status: "ended"`; the other arms
/// (idle/running transitions, ACP events, observation, remote-PTY binding) are
/// work-host-signed or B2.3 surfaces and are refused by name.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateWorkSessionRequest {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub observation: Option<String>,
    #[serde(default)]
    pub event: Option<Value>,
    #[serde(default)]
    pub pty_id: Option<String>,
    #[serde(default)]
    pub attach_endpoint: Option<String>,
}

/// `POST …/work-sessions/{session}/resume` request (Swift, :53-55).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeWorkSessionRequest {
    pub target_host_id: Uuid,
}

/// Swift `WorkSessionDTO` (:57-75).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionDto {
    pub id: String,
    pub workspace_id: String,
    pub channel_id: String,
    pub member_id: String,
    pub host_id: String,
    pub root_message_id: String,
    pub tool: String,
    pub label: String,
    pub status: String,
    pub observation: String,
    pub observer_grant_count: i64,
    pub remote_attach_available: bool,
    pub started_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed_from_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionResponse {
    pub work_session: WorkSessionDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionListResponse {
    pub work_sessions: Vec<WorkSessionDto>,
}

/// Query string of `GET …/work-sessions` (`activeFilter`, :2107-2113): only
/// `"0"`, `"1"` or absent — anything else is a 400, deliberately stricter than
/// the message-history parser.
#[derive(Debug, Default, Deserialize)]
pub struct WorkSessionListQuery {
    #[serde(default)]
    pub active: Option<String>,
}

// ---------------------------------------------------------------------------
// cloud credit (B2.2 — Swift `CloudCreditRoutes.swift`)
// ---------------------------------------------------------------------------

/// `POST /v1/admin/workspaces/{ws}/credits/topups` request (Swift, :5-8).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudCreditTopupRequest {
    pub amount_micro_usd: i64,
    pub idempotency_ref: String,
}

/// Swift `CloudCreditTopupResponse` (:10-15).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCreditTopupResponse {
    pub workspace_id: String,
    pub amount_micro_usd: i64,
    pub idempotency_ref: String,
    pub balance_micro_usd: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_host_dto_omits_null_timestamps_like_swift() {
        let dto = WorkHostDto {
            id: "h".into(),
            workspace_id: "w".into(),
            scope: "workspace".into(),
            owner_member_id: "m".into(),
            host_type: "cloud".into(),
            display_name: "box".into(),
            public_key: "k".into(),
            capabilities: serde_json::json!({"terminal_attach": true}),
            last_seen_at_ms: None,
            revoked_at_ms: None,
            created_at_ms: 7,
            online: false,
        };
        let json = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(json["ownerMemberId"], "m");
        assert_eq!(json["type"], "cloud", "`type` is not renamed to hostType");
        assert_eq!(json["capabilities"]["terminal_attach"], true);
        assert_eq!(json["createdAtMs"], 7);
        assert!(json.get("lastSeenAtMs").is_none());
        assert!(json.get("revokedAtMs").is_none());
    }

    #[test]
    fn work_session_dto_uses_swift_keys() {
        let dto = WorkSessionDto {
            id: "s".into(),
            workspace_id: "w".into(),
            channel_id: "c".into(),
            member_id: "m".into(),
            host_id: "h".into(),
            root_message_id: "r".into(),
            tool: "claude".into(),
            label: "run".into(),
            status: "running".into(),
            observation: "open".into(),
            observer_grant_count: 0,
            remote_attach_available: false,
            started_at_ms: 5,
            ended_at_ms: None,
            exit_code: None,
            end_reason: None,
            resumed_from_session_id: None,
        };
        let json = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(json["rootMessageId"], "r");
        assert_eq!(json["observerGrantCount"], 0);
        assert_eq!(json["remoteAttachAvailable"], false);
        assert_eq!(json["startedAtMs"], 5);
        assert!(json.get("endedAtMs").is_none());
        assert!(json.get("exitCode").is_none());
    }

    #[test]
    fn work_session_requests_are_closed_world() {
        let ok: CreateWorkSessionRequest = serde_json::from_value(serde_json::json!({
            "channelId": Uuid::nil(),
            "hostId": Uuid::nil(),
            "tool": "claude",
            "label": "run",
        }))
        .expect("known keys decode");
        assert_eq!(ok.tool, "claude");
        assert!(ok.control_id.is_none());

        let rejected: Result<CreateWorkSessionRequest, _> =
            serde_json::from_value(serde_json::json!({
                "channelId": Uuid::nil(),
                "hostId": Uuid::nil(),
                "tool": "claude",
                "label": "run",
                "labell": "typo",
            }));
        assert!(rejected.is_err(), "a typo must fail loudly");
    }

    #[test]
    fn enrollment_dto_uses_swift_keys() {
        let json = serde_json::to_value(ByocEnrollmentResponse {
            enrollment: ByocEnrollmentDto {
                provision_id: "p".into(),
                provider: "byoc".into(),
                state: "provisioning".into(),
                bootstrap_token: "t".into(),
                bootstrap_expires_at_ms: 9,
                register_url: "https://x/register".into(),
            },
        })
        .expect("serialize");
        assert_eq!(json["enrollment"]["provisionId"], "p");
        assert_eq!(json["enrollment"]["bootstrapToken"], "t");
        assert_eq!(json["enrollment"]["bootstrapExpiresAtMs"], 9);
        assert_eq!(json["enrollment"]["registerUrl"], "https://x/register");
    }

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
    fn refresh_dtos_use_swift_keys() {
        let request: RefreshRequest =
            serde_json::from_value(serde_json::json!({"refreshToken": "r"})).expect("decode");
        assert_eq!(request.refresh_token, "r");

        let json = serde_json::to_value(RefreshResponse {
            access_token: "a".into(),
            refresh_token: "r2".into(),
        })
        .expect("serialize");
        assert_eq!(json["accessToken"], "a");
        assert_eq!(json["refreshToken"], "r2");
    }

    #[test]
    fn logout_body_is_optional_in_every_shape() {
        // Swift decodes the body with `try?`: an empty object, a null, or an
        // absent refreshToken all mean "revoke the access token only".
        let empty: LogoutRequest =
            serde_json::from_value(serde_json::json!({})).expect("empty object");
        assert_eq!(empty.refresh_token, None);
        let null: LogoutRequest =
            serde_json::from_value(serde_json::json!({"refreshToken": null})).expect("null");
        assert_eq!(null.refresh_token, None);
        let given: LogoutRequest =
            serde_json::from_value(serde_json::json!({"refreshToken": "r"})).expect("given");
        assert_eq!(given.refresh_token.as_deref(), Some("r"));
    }

    #[test]
    fn logout_response_uses_swift_keys() {
        let json = serde_json::to_value(LogoutResponse {
            status: "ok",
            revoked_access: true,
            revoked_refresh: false,
            already_revoked: false,
        })
        .expect("serialize");
        assert_eq!(json["status"], "ok");
        assert_eq!(json["revokedAccess"], true);
        assert_eq!(json["revokedRefresh"], false);
        assert_eq!(json["alreadyRevoked"], false);
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
