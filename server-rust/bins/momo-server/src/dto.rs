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
/// never a silently dropped field. The keys this server still does not serve
/// (`runId`, `attachmentIds`, `routing`) are decoded so the handler can reject
/// them **visibly** instead of accepting the request and dropping the intent on
/// the floor. `rootId` left that list in B4.1 — it is served now.
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
    /// ADR-0146 provenance: base64 Ed25519 signature over the
    /// `momo.provenance.message.v1` bytes (`momo_wire::provenance`).
    ///
    /// Optional by design — an unsigned send is the unchanged path. There is no
    /// companion `publicKey` field and there must never be one: the key is
    /// resolved server-side from the sender's registration, because a key the
    /// request supplies verifies its own signature and proves nothing.
    #[serde(default)]
    pub signature: Option<String>,
}

/// The reply rollup embedded in a message (Swift `ThreadRollupDTO`,
/// `DTOs.swift:186-197`).
///
/// **snake_case inside a camelCase body.** That is not an oversight on either
/// side: Swift spells this DTO's `CodingKeys` with underscores, and the web
/// client reads `message.thread.reply_count` literally
/// (`clients/web/src/lib/api.ts:165-171`, `threadRollup()`). Renaming it to
/// camelCase here would leave every thread badge silently unrendered, because
/// the client's normaliser returns `null` when `reply_count` is missing.
#[derive(Debug, Serialize)]
pub struct ThreadRollupDto {
    pub reply_count: i32,
    pub last_reply_seq: i64,
    /// Epoch milliseconds. Swift names this key `last_reply_at` (not `…AtMs`)
    /// even though the value is milliseconds; the client reads that spelling.
    pub last_reply_at: i64,
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
    /// Present only on a root message that has replies (B4.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadRollupDto>,
}

/// `GET …/channels/{ch}/messages/{root}/replies` response (Swift
/// `ThreadRepliesPage`, `DTOs.swift:261-264`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRepliesPage {
    pub messages: Vec<MessageDto>,
    /// Omitted at the end of a thread, matching Swift's `Int64?` encoding — the
    /// client reads `nextCursor === undefined` as "no more".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<i64>,
}

/// Query string of the replies page. `limit` is lenient (a bad page size has a
/// safe default), `cursor` is strict (a bad cursor does not) — Swift's own
/// asymmetry, kept because silently restarting a replay from 0 re-delivers a
/// whole thread as if it were new.
#[derive(Debug, Default, Deserialize)]
pub struct RepliesQuery {
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
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
// session reattach + replay (B2.4 — ADR-0139)
// ---------------------------------------------------------------------------

/// Query string of `GET …/work-sessions/{session}/reattach`.
///
/// The names are `MessageRoutes.replies`' (`cursor`, `limit`, :528-530) because
/// the replay half **is** that surface, scoped to one session's thread. The two
/// parsers keep Swift's asymmetry, which is not an oversight: `limit` is read
/// leniently (`Int($0) ?? 50`, then clamped) because a bad page size has a safe
/// default, while `cursor` is strict (400 on garbage) because a bad cursor has
/// no safe default — silently restarting a replay from 0 would re-deliver a
/// whole session's events as if they were new.
#[derive(Debug, Default, Deserialize)]
pub struct ReattachQuery {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

impl ReattachQuery {
    pub fn limit(&self) -> Option<i64> {
        self.limit.as_deref().and_then(|raw| raw.parse().ok())
    }
}

/// `GET …/work-sessions/{session}/reattach` response.
///
/// One round trip answers the three questions a returning client has, and the
/// verdict is server-side on purpose (ADR-0139 D3): "이어서 보기" and "새
/// 호스트에서 재개" are different acts with different consequences, so the
/// server names which one applies rather than letting each client re-derive it
/// from `status` + host liveness and drift.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionReattachResponse {
    pub work_session: WorkSessionDto,
    /// `"reattach"` | `"resume_lineage"` | `"replay_only"` — snake_case values,
    /// like every other closed vocabulary on this wire (`owner_only`,
    /// `idle_timeout`).
    pub verdict: &'static str,
    /// The host heartbeated inside its 90s window. **Advisory**: it never
    /// changes `verdict`, because exactly one endpoint writes `last_seen_at` and
    /// hosts that are demonstrably relaying have been measured reporting
    /// `online: false` (web `workSessionModel.ts:630-648`).
    pub host_online: bool,
    pub host_revoked: bool,
    /// The card's `seq` — the anchor for a client holding no cursor.
    pub root_message_seq: i64,
    /// Highest `seq` in the thread; `null` when the card has no replies yet. A
    /// client already holding this value is up to date.
    pub last_event_seq: Option<i64>,
    /// The replayed thread page, oldest-first, strictly after the cursor.
    pub events: Vec<MessageDto>,
    /// Next `cursor`, or `null` when this page reached the end. Encoded even
    /// when null, matching Swift `ThreadRepliesPage`.
    pub next_cursor: Option<i64>,
}

// ---------------------------------------------------------------------------
// terminal attach capability (B2.4 — Swift `TerminalAttachRoutes.swift`)
// ---------------------------------------------------------------------------

/// `POST …/work-sessions/{session}/terminal-attach` request (Swift
/// `IssueTerminalAttachRequest`, :68-70).
///
/// The body is optional in every shape — absent, empty, or `{}` all mean
/// `controller` (Swift `issueMode` returns `.controller` on a zero-byte body,
/// :423-424) — so this is decoded by hand in the handler rather than through
/// `Json<…>`, which rejects an empty body.
#[derive(Debug, Default, Deserialize)]
pub struct IssueTerminalAttachRequest {
    #[serde(default)]
    pub mode: Option<String>,
}

/// `POST …/terminal-attach` response (Swift `TerminalAttachCapabilityResponse`,
/// :51-61).
///
/// **snake_case, unlike every camelCase body above.** That is the Swift
/// contract the mac and web clients already consume (`api.ts:1340-1348`
/// documents it explicitly); renaming it here would break both to satisfy a
/// style rule.
#[derive(Debug, Serialize)]
pub struct TerminalAttachCapabilityResponse {
    /// The HOST's own endpoint. momo never proxies it.
    pub attach_endpoint: String,
    /// The opaque 60-second bearer. Returned once; only its SHA-256 is stored.
    pub capability_token: String,
    pub pty_id: String,
}

/// `POST …/work-hosts/{host}/terminal-attach/validate` request (Swift
/// `ValidateTerminalAttachRequest`, :72-97).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidateTerminalAttachRequest {
    pub capability_token: String,
    /// `true` = the host is re-checking a socket it already serves. Relaxes the
    /// expiry clause and **only** the expiry clause (MOMO-674).
    #[serde(default)]
    pub stream: Option<bool>,
}

/// `POST …/terminal-attach/validate` response (Swift
/// `TerminalAttachValidationResponse`, :99-111). snake_case, same reason.
#[derive(Debug, Serialize)]
pub struct TerminalAttachValidationResponse {
    pub work_session_id: String,
    pub pty_id: String,
    /// ISO-8601 with fractional seconds, rendered by PostgreSQL.
    pub expires_at: String,
    /// `"controller"` | `"observer"`.
    pub mode: &'static str,
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

// ---------------------------------------------------------------------------
// agent runs + agent gateway (B2.6)
//
// NOTE the asymmetry, which is measured and not a mistake: the gateway
// *request* bodies are snake_case (`job_id`, `lease_id`, `text_delta` —
// `AgentGatewayRoutes.swift:1865-1874`, :2237-2245) because a Python/Node
// adapter writes them, while every *response* stays camelCase like the rest of
// the API. Spelling both out beats one `rename_all` that would silently break
// one side.
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/channels/{ch}/agent-runs` (Swift
/// `CreateAgentRunRequest` :1072-1091).
///
/// `deny_unknown_fields` is the port of Swift's explicit `allowedKeys` check: a
/// typo'd field must be a 400, not a silently ignored instruction.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateAgentRunRequest {
    #[serde(alias = "agent_member_id")]
    pub agent_member_id: Uuid,
    #[serde(alias = "client_run_id")]
    pub client_run_id: Uuid,
    pub input: Value,
    #[serde(default)]
    pub routing: Option<Value>,
}

/// Swift `AgentRunDTO` (:1245-1264).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResponse {
    pub id: String,
    pub workspace_id: String,
    pub agent_member_id: String,
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    pub status: String,
    pub step_count: i32,
    pub max_steps: i32,
    pub depth: i32,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// `?limit=` on the pending-jobs claim.
#[derive(Debug, Deserialize)]
pub struct PendingJobsQuery {
    #[serde(default)]
    pub limit: Option<String>,
}

impl PendingJobsQuery {
    /// Swift parses with `Int($0)` and clamps; an unparsable value falls back to
    /// the default rather than 400ing, matching the `flatMap` there (:64).
    pub fn limit(&self) -> Option<i64> {
        self.limit
            .as_deref()
            .and_then(|raw| raw.trim().parse().ok())
    }
}

/// Swift `AgentGatewayPendingJobDTO` (:2362-2369).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGatewayPendingJob {
    pub id: i64,
    pub run_id: String,
    pub payload: Value,
    pub created_at_ms: i64,
    pub lease_id: String,
    pub lease_expires_at_ms: i64,
}

/// Swift `AgentGatewayPendingJobsResponse` (:2371-2373).
#[derive(Debug, Serialize)]
pub struct AgentGatewayPendingJobsResponse {
    pub jobs: Vec<AgentGatewayPendingJob>,
}

/// Swift `AgentGatewayLeaseRequest` (:2380-2398).
#[derive(Debug, Default, Deserialize)]
pub struct AgentGatewayLeaseRequest {
    #[serde(default, rename = "job_id")]
    pub job_id: Option<i64>,
    #[serde(default, rename = "lease_id")]
    pub lease_id: Option<Uuid>,
}

/// Swift `AgentGatewayLeaseResponse` (:2400-2405).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGatewayLeaseResponse {
    pub status: &'static str,
    pub job_id: i64,
    pub lease_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_expires_at_ms: Option<i64>,
}

/// Swift `AgentGatewayEventRequest` (:1852-1874), minus the `tool_call` and
/// `approval_request` branches this batch does not port.
#[derive(Debug, Default, Deserialize)]
pub struct AgentGatewayEventRequest {
    #[serde(default, rename = "event_id")]
    pub event_id: Option<Uuid>,
    #[serde(default, rename = "job_id")]
    pub job_id: Option<i64>,
    #[serde(default, rename = "lease_id")]
    pub lease_id: Option<Uuid>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default, rename = "text_delta")]
    pub text_delta: Option<String>,
}

/// Swift `AgentGatewayEventResponse` (:2349-2353). `workControl` is omitted
/// rather than null — Swift's synthesized `Encodable` uses `encodeIfPresent`, and
/// this batch never produces one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGatewayEventResponse {
    pub status: &'static str,
    pub run_id: String,
}

/// Swift `AgentGatewayCompleteRequest` (:2228-2258), minus `memory_delivery`.
#[derive(Debug, Default, Deserialize)]
pub struct AgentGatewayCompleteRequest {
    #[serde(default, rename = "job_id")]
    pub job_id: Option<i64>,
    #[serde(default, rename = "lease_id")]
    pub lease_id: Option<Uuid>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub usage: Option<AgentGatewayUsageDto>,
}

/// Swift `AgentGatewayUsage` (:2287-2347).
///
/// Every token field accepts **both** spellings because Swift's hand-written
/// `init(from:)` tries the camelCase key and then the snake_case one; an adapter
/// that sends `prompt_tokens` and one that sends `promptTokens` must produce the
/// same ledger row, not one row and one zero.
#[derive(Debug, Default, Deserialize)]
pub struct AgentGatewayUsageDto {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default, alias = "prompt_tokens")]
    pub prompt_tokens: Option<i32>,
    #[serde(default, alias = "completion_tokens")]
    pub completion_tokens: Option<i32>,
    #[serde(default, alias = "cached_tokens")]
    pub cached_tokens: Option<i32>,
    #[serde(default, alias = "reasoning_tokens")]
    pub reasoning_tokens: Option<i32>,
    #[serde(default, alias = "cost_micro_usd")]
    pub cost_micro_usd: Option<i64>,
    #[serde(default, alias = "was_estimated")]
    pub was_estimated: Option<bool>,
}

/// Swift `AgentGatewayCompleteResponse` (:2355-2360).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGatewayCompleteResponse {
    pub status: &'static str,
    pub run_id: String,
    pub message_id: String,
    pub seq: i64,
}

// ---------------------------------------------------------------------------
// usage summary (Swift UsageSummaryRoutes.swift:356-426)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct UsageSummaryQuery {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub bucket: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UsageSummaryRange {
    pub from: String,
    pub to: String,
    pub bucket: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryTotals {
    pub cost_micro_usd: i64,
    pub estimated_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryBucket {
    pub start: String,
    pub cost_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryModel {
    pub model: String,
    pub cost_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryAgent {
    pub agent_member_id: String,
    pub display_name: String,
    pub cost_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryBudget {
    pub grain: String,
    pub limit_micro_usd: i64,
    pub spent_micro_usd: i64,
    pub reserved_micro_usd: i64,
    pub state: &'static str,
    pub period_start: String,
}

/// The `budget` key is **never** omitted: Swift hand-writes `encode(to:)`
/// precisely so `"budget": null` survives (`UsageSummaryRoutes.swift:414-425`),
/// and a client that reads `budget === undefined` as "no budget configured"
/// would break if the key vanished.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryResponse {
    pub range: UsageSummaryRange,
    pub totals: UsageSummaryTotals,
    pub buckets: Vec<UsageSummaryBucket>,
    pub by_model: Vec<UsageSummaryModel>,
    pub by_agent: Vec<UsageSummaryAgent>,
    pub budget: Option<UsageSummaryBudget>,
}

// ---------------------------------------------------------------------------
// direct messages (B1.2 — Swift `DMRoutes.swift` + `DTOs.swift:456-503`)
// ---------------------------------------------------------------------------

/// Swift `ChannelDTO` (:456-469). Optionals are omitted when null, matching the
/// synthesized `encodeIfPresent`; `muted` is always present because it is a
/// `Bool`, not an optional, on the Swift side too.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDto {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dm_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    /// Always `None` on the DM surface: `list` filters archived channels out and
    /// `open` un-archives before returning (Swift hardcodes `NULL` for the same
    /// reason). **Set** on the B4 channel list when `include_archived=true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at_ms: Option<i64>,
    pub muted: bool,
}

/// Swift `WorkspaceChannelsResponse` (:471-473) — the body of `GET …/dms` and
/// (B4) `GET …/channels`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChannelsResponse {
    pub channels: Vec<ChannelDto>,
}

// ---------------------------------------------------------------------------
// channel writes (B4.1 — Swift `ChannelRoutes.create` + `updateNotificationPref`)
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/channels` request (Swift `CreateChannelRequest`,
/// `DTOs.swift:506-516`; client `CreateChannelInput`, `lib/api.ts:736-742`).
///
/// Closed-world: Swift's synthesized decoder has exactly these three keys, and a
/// client that sent a fourth (a member list, an archive flag) would otherwise
/// have it silently dropped.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateChannelRequest {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub topic: Option<String>,
}

/// Swift `ChannelMembershipDTO` (`DTOs.swift:543-556`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMembershipDto {
    pub id: String,
    pub workspace_id: String,
    pub channel_id: String,
    pub member_id: String,
    pub role: String,
    pub joined_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_at_ms: Option<i64>,
}

/// Swift `CreateChannelResponse` (`DTOs.swift:518-521`).
///
/// The creator's membership travels with the channel so the client knows it is
/// already inside — `CreatedChannel` in `lib/api.ts:723-731` reads exactly this
/// pair, and a client that had to re-list to discover its own membership would
/// briefly render a channel it appears not to belong to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChannelResponse {
    pub channel: ChannelDto,
    pub creator_membership: ChannelMembershipDto,
}

/// `PUT …/channels/{ch}/notification-pref` request (Swift
/// `UpdateNotificationPrefRequest`, `DTOs.swift:476-478`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateNotificationPrefRequest {
    pub muted: bool,
}

/// Swift `NotificationPrefResponse` (`DTOs.swift:480-482`) — the server's
/// answer, not an echo: the caller re-reads its own state from this.
#[derive(Debug, Serialize)]
pub struct NotificationPrefResponse {
    pub muted: bool,
}

// ---------------------------------------------------------------------------
// roster (B4.1 — Swift `RosterRoutes.swift` + `DTOs.swift:332-406`)
// ---------------------------------------------------------------------------

/// Swift `RosterMemberDTO` (`DTOs.swift:332-352`).
///
/// The web client validates a subset of these keys before accepting a row
/// (`isRosterMember`, `lib/api.ts:91-108`) and **drops** any row that fails —
/// so `channelIds`, `capabilities`, `channelCount`, `createdAtMs` and
/// `updatedAtMs` are emitted unconditionally rather than skipped when empty. A
/// skipped `capabilities: []` would silently delete that member from the
/// timeline's name table.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterMemberDto {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub status: String,
    pub display_name: String,
    pub handle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub channel_count: i32,
    pub channel_ids: Vec<String>,
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_human_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_concurrent_runs: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_run_steps: Option<i32>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Swift `WorkspaceRosterResponse` (`DTOs.swift:402-406`). The two counts are
/// computed over the returned page, exactly as Swift computes them — they
/// describe what was sent, not what exists.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRosterResponse {
    pub members: Vec<RosterMemberDto>,
    pub human_count: usize,
    pub agent_count: usize,
}

/// `GET …/roster` query string. Swift reads `kind` and falls back to
/// `member_kind` (`RosterRoutes.swift:27-28`), and parses `limit` leniently.
#[derive(Debug, Default, Deserialize)]
pub struct RosterQuery {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub member_kind: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

// ---------------------------------------------------------------------------
// workspace identity (B4.1 — Swift `WorkspaceRoutes.get` + `DTOs.swift:770-779`)
// ---------------------------------------------------------------------------

/// Swift `WorkspaceDTO` (`DTOs.swift:770-775`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub slug: String,
    pub name: String,
    /// The rename endpoint's optimistic-concurrency token, so the read hands out
    /// the exact value a later write compares against.
    pub updated_at_ms: i64,
}

/// Swift `WorkspaceResponse` (`DTOs.swift:777-779`). The client unwraps
/// `res.workspace` and errors if it is absent (`settings/api.ts:399-408`), so
/// the envelope is part of the contract, not decoration.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceResponse {
    pub workspace: WorkspaceDto,
}

// ---------------------------------------------------------------------------
// realtime (B4 — Swift `AuthRoutes.realtimeToken` + `CentrifugoRoutes.swift`)
// ---------------------------------------------------------------------------

/// `POST /v1/auth/realtime-token` response (Swift `RealtimeTokenResponse`,
/// `DTOs.swift:76-84`).
///
/// `token` is a Centrifugo **connection** token and nothing else: it names the
/// connecting member and carries no channel grant, so it is useless without the
/// per-subscribe proxy decision. The web client reads only `token`
/// (`clients/web/src/lib/api.ts:698-703`); the other five fields are what let a
/// client reason about renewal without decoding a JWT it does not own.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTokenResponse {
    pub token: String,
    pub token_type: &'static str,
    pub expires_at_ms: i64,
    pub ttl_seconds: i64,
    pub workspace_id: String,
    pub member_id: String,
}

/// Centrifugo subscribe-proxy callback body (Swift `SubscribeProxyRequest`,
/// `DTOs.swift:906-911`).
///
/// `meta` arrives only because `include_connection_meta` is on in
/// `infra/centrifugo.json`; it is the connection token's `meta` claim, which is
/// how a subscribe is bound back to the credential that opened the connection.
#[derive(Debug, Default, Deserialize)]
pub struct SubscribeProxyRequest {
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    pub channel: String,
    #[serde(default)]
    pub meta: Option<SubscribeProxyMeta>,
}

/// The `meta` object forwarded from the connection token (Swift
/// `RealtimeTokenMeta`). Only `token_id` is read; `schema` is accepted so a
/// future version can be told apart from a missing field.
#[derive(Debug, Clone, Deserialize)]
pub struct SubscribeProxyMeta {
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default, rename = "token_id")]
    pub token_id: Option<String>,
}

/// Centrifugo proxy allow/deny envelope (Swift `SubscribeProxyResponse`,
/// `DTOs.swift:913-928`).
///
/// **A deny is a 200 with an `error` object, not an HTTP error status.** That is
/// the Centrifugo proxy protocol: a non-2xx is read as *the proxy is broken*
/// (which Centrifugo may retry or fail open on, depending on config), while
/// `{"error":{...}}` is read as *this subscription is refused*. Answering 403
/// here would turn every ordinary permission decision into a transport fault.
#[derive(Debug, Serialize)]
pub struct SubscribeProxyResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<SubscribeProxyResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SubscribeProxyError>,
}

#[derive(Debug, Serialize)]
pub struct SubscribeProxyResult {}

#[derive(Debug, Serialize)]
pub struct SubscribeProxyError {
    pub code: u32,
    pub message: String,
}

impl SubscribeProxyResponse {
    pub fn allow() -> Self {
        SubscribeProxyResponse {
            result: Some(SubscribeProxyResult {}),
            error: None,
        }
    }

    pub fn deny(message: impl Into<String>) -> Self {
        SubscribeProxyResponse {
            result: None,
            error: Some(SubscribeProxyError {
                code: 403,
                message: message.into(),
            }),
        }
    }
}

/// `POST …/dms` request (Swift `OpenDirectMessageRequest`, :485-498), which
/// hand-rolls a decoder accepting either spelling of the key. `alias` is the
/// same contract.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDirectMessageRequest {
    #[serde(alias = "member_id")]
    pub member_id: Uuid,
}

/// `POST …/dms` response (Swift `OpenDirectMessageResponse`, :500-503).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDirectMessageResponse {
    pub channel: ChannelDto,
    /// `true` only when this call created the channel — the 201/200 split.
    pub created: bool,
}

// ---------------------------------------------------------------------------
// read state (B1.2 — Swift `ReadStateRoutes.swift` + `DTOs.swift:291-322`)
// ---------------------------------------------------------------------------

/// `PUT …/channels/{ch}/read-state` request (Swift `UpdateReadStateRequestDTO`).
///
/// **snake_case, not camelCase** — this DTO is one of the few places the Swift
/// server spells its keys with underscores, and the clients already send that.
/// There is deliberately no actor field: the cursor's owner is the
/// authenticated principal and nothing else.
#[derive(Debug, Deserialize)]
pub struct UpdateReadStateRequestDto {
    pub last_read_seq: i64,
}

/// Swift `ReadStateDTO` (:301-315) — snake_case for the same reason.
#[derive(Debug, Serialize)]
pub struct ReadStateDto {
    pub channel_id: String,
    pub last_read_seq: i64,
    pub latest_seq: i64,
    pub unread_count: i64,
    pub mention_count: i32,
}

/// Swift `ReadStateListResponseDTO` (:317-322).
#[derive(Debug, Serialize)]
pub struct ReadStateListResponseDto {
    pub read_states: Vec<ReadStateDto>,
}

// ---------------------------------------------------------------------------
// message search (B1.2 — Swift `SearchRoutes.swift` + `DTOs.swift:266-281`)
// ---------------------------------------------------------------------------

/// `GET …/search/messages` query string. Parsed leniently like
/// [`HistoryQuery`]: a garbage `limit` falls back to the default rather than
/// 400-ing, matching Swift's `Int($0) ?? 20`. `q` and `cursor` *are* validated,
/// because an unusable value there changes which rows come back.
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
}

impl SearchQuery {
    pub fn limit(&self) -> Option<i64> {
        self.limit.as_deref().and_then(|raw| raw.parse().ok())
    }
}

/// Swift `WorkspaceMessageSearchHitDTO` (:268-276). `createdAtMs` is
/// milliseconds on the wire even though the cursor keeps microseconds.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMessageSearchHitDto {
    pub channel_id: String,
    pub message_id: String,
    pub seq: i64,
    pub author_member_id: String,
    pub created_at_ms: i64,
    pub snippet: String,
    /// Zero-based offset of the match inside `snippet`.
    pub match_offset: i32,
}

/// Swift `WorkspaceMessageSearchResponse` (:278-281).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMessageSearchResponse {
    pub hits: Vec<WorkspaceMessageSearchHitDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

// ---------------------------------------------------------------------------
// settings — 설정 표면 (B4.2)
//
// Contract sources: `clients/web/src/features/settings/api.ts` (the interfaces
// the panel decodes) checked against the Swift routes each one transcribes.
//
// One rule runs through every DTO below and is worth stating once: **no field
// here can hold a provider credential.** The provider bearer is write-only —
// accepted in a PUT body, never echoed — and the only thing that comes back is a
// masked 4-character tail plus a boolean (ADR-0004 Rules #1-#2).
// ---------------------------------------------------------------------------

/// `GET|PUT|DELETE /v1/provider/link` response (Swift `ProviderLinkResponse`,
/// `ProviderLinkRoutes.swift:427-441`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLinkResponse {
    pub schema: &'static str,
    /// A usable row exists in this instance's database (as opposed to the env
    /// fallback being in force).
    pub configured: bool,
    /// `database` | `environment` — which tier won the ADR-0004 증보 1
    /// precedence.
    pub source: String,
    pub mode: String,
    pub base_url: String,
    pub endpoint_label: String,
    pub bearer_configured: bool,
    /// Last 4 characters of the stored bearer. Absent unless `source=database`,
    /// and absent for any secret shorter than 8 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearer_last4: Option<String>,
    pub availability: String,
    pub key_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    pub diagnostics: Vec<String>,
}

/// Closed-world `PUT /v1/provider/link` body (Swift `PutProviderLinkRequest`
/// :494-520). `deny_unknown_fields` is the ADR-0004 Rules #1-#2 enforcement
/// point: no `codex_oauth_*` / `openai_*` / raw-provider-key field can ever be
/// introduced through this API by a client that simply sends one.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutProviderLinkRequest {
    pub base_url: String,
    /// Write-only. Never read back by any surface.
    pub bearer: String,
    #[serde(default)]
    pub mode: Option<String>,
}

/// One hop of the cascade as projected to the operator (Swift
/// `ProviderChainEntryDTO`, `ProviderLinkChainRoutes.swift:353-367`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChainEntryDto {
    /// 0 is the `provider_link` singleton; fallback hops start at 1.
    pub position: i32,
    /// `provider_link` | `environment` | `chain`.
    pub source: String,
    pub mode: String,
    pub base_url: String,
    pub endpoint_label: String,
    pub enabled: bool,
    pub bearer_configured: bool,
    /// The row exists but its ciphertext will not open with the configured
    /// master key. It stays visible so a replace-all PUT cannot erase it.
    pub bearer_unavailable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearer_last4: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

/// `GET|PUT|DELETE /v1/provider/link/chain` response (Swift
/// `ProviderChainResponse` :341-349).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChainResponse {
    pub schema: &'static str,
    /// The whole cascade in attempt order, position 0 first.
    pub entries: Vec<ProviderChainEntryDto>,
    /// Configured fallback hops — everything beyond position 0.
    pub fallback_count: usize,
    /// Hops a real turn would attempt (enabled AND usable), **position 0
    /// included**. Two live fallbacks behind a live head answer 3, not 2.
    pub attemptable_count: usize,
}

/// Closed-world `PUT /v1/provider/link/chain` body (Swift
/// `PutProviderChainRequest` :385-454).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutProviderChainRequest {
    pub entries: Vec<PutProviderChainEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutProviderChainEntry {
    pub position: i32,
    pub base_url: String,
    /// Write-only, and **optional**: absent means "keep the bearer already
    /// stored at this position", so an operator can reorder or park a hop
    /// without re-typing a secret the API can never show them again.
    #[serde(default)]
    pub bearer: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// `POST /v1/provider/link/test` per-hop probe result (Swift
/// `ProviderChainProbeDTO`, `ProviderLinkRoutes.swift:480-489`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChainProbeDto {
    pub position: i32,
    pub source: String,
    pub mode: String,
    pub endpoint_label: String,
    pub enabled: bool,
    pub ok: bool,
    /// Machine label, not user copy — the client maps it
    /// (`features/settings/chainModel.ts:probeReasonCopy`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `ok` | `fall_over` | `propagate` | `skipped`.
    pub disposition: String,
}

/// `POST /v1/provider/link/test` response (Swift `ProviderLinkTestResponse`
/// :447-459). The first seven fields describe **position 0** and keep their
/// exact MOMO-572 meaning; `cascadeOk`/`entries` are the ADR-0135 D1 extension.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLinkTestResponse {
    pub schema: &'static str,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub source: String,
    pub mode: String,
    pub endpoint_label: String,
    pub checked_at_ms: i64,
    pub cascade_ok: bool,
    pub entries: Vec<ProviderChainProbeDto>,
}

/// `GET|PUT /v1/provider/work-host-engine` response (Swift
/// `WorkHostEngineResponse`, `WorkHostEngineRoutes.swift:189-195`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHostEngineResponse {
    pub engine: String,
    /// `database` once a workspace has chosen; `default` means no row exists and
    /// the boot default applies **without any write**.
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
    pub schema: &'static str,
}

/// Closed-world `PUT /v1/provider/work-host-engine` body (Swift
/// `PutWorkHostEngineRequest` :200-221) — engine label only, so no credential or
/// host-local path can be smuggled through (ADR-0004).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutWorkHostEngineRequest {
    pub engine: String,
}

/// `GET /v1/provider/effort-table` (Swift `ProviderEffortTableResponse`,
/// `ProviderEffortTableRoutes.swift:192-197`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEffortTableResponse {
    pub schema: &'static str,
    /// The canonical superset, ascending.
    pub levels: Vec<&'static str>,
    pub fallback: ProviderEffortFallbackDto,
    pub providers: Vec<ProviderEffortProviderDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEffortFallbackDto {
    pub efforts: Vec<&'static str>,
    pub default_effort: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEffortProviderDto {
    pub provider: &'static str,
    pub models: Vec<ProviderEffortModelDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEffortModelDto {
    pub model: &'static str,
    pub efforts: Vec<&'static str>,
    pub default_effort: &'static str,
}

/// One provider quota gauge (Swift `ProviderQuotaSnapshotDTO`,
/// `ProviderQuotaSnapshotRoutes.swift:487-513`).
///
/// `resetsAt` is contractually `string | null`, so unlike every other optional in
/// this file it is **emitted as null** rather than omitted — Swift hand-writes
/// `encode` for exactly that reason.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaSnapshotDto {
    pub provider_ref: String,
    /// ADR-0135's wire name; the column is `quota_window` (reserved keyword).
    pub window: String,
    /// 0..1 **remaining**, never consumed.
    pub remaining_ratio: f64,
    pub resets_at: Option<String>,
    pub probed_at: String,
    pub ingested_at: String,
    /// Computed on the server clock, never derivable by the client from
    /// `probedAt` (the two clocks are the adapter's and a browser's).
    pub age_seconds: i64,
}

/// `GET /v1/provider/quota-snapshots` (Swift
/// `ProviderQuotaSnapshotListResponse` :522-526).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaSnapshotListResponse {
    pub schema: &'static str,
    pub observed_at: String,
    pub snapshots: Vec<ProviderQuotaSnapshotDto>,
}

/// Swift `WorkTierPolicyDTO` (`WorkTierPolicyRoutes.swift:11-18`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTierPolicyDto {
    pub workspace_id: String,
    /// Absent on the workspace default row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_target: Option<String>,
    /// No member row exists and the workspace default is what is in force — so
    /// the panel says that instead of implying a saved override.
    pub inherited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
}

/// Swift `WorkTierPolicyResponse` (:20-22). The client unwraps
/// `res.workTierPolicy` and rejects a body without it
/// (`settings/api.ts:316-322`), so the envelope is contract.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTierPolicyResponse {
    pub work_tier_policy: WorkTierPolicyDto,
}

/// Swift `PutWorkTierPolicyRequest` (:6-9).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutWorkTierPolicyRequest {
    pub mode: String,
    #[serde(default)]
    pub auto_target: Option<String>,
}

/// Swift `InviteCodeDTO`, as the settings panel decodes it
/// (`features/settings/api.ts:413-428`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteCodeDto {
    pub id: String,
    pub workspace_id: String,
    /// Last 6 characters of the code. The code itself is returned exactly once,
    /// by the create call, and never stored in plaintext.
    pub code_preview: String,
    pub role: String,
    pub max_uses: i32,
    pub used_count: i32,
    pub expires_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revocation_reason: Option<String>,
    pub created_by: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// `GET /v1/workspaces/{ws}/invites` (Swift `InviteListResponse`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteListResponse {
    pub invites: Vec<InviteCodeDto>,
}

/// `POST /v1/workspaces/{ws}/invites` (Swift `CreateInviteResponse`) — the only
/// response in the API that ever carries a raw invite code.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteResponse {
    pub invite: InviteCodeDto,
    pub code: String,
}

/// Swift `CreateInviteRequest`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteRequest {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub max_uses: Option<i32>,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
}

// ---------------------------------------------------------------------------
// public join (B4.3 — Swift `JoinRoutes` + `DTOs.swift:781-836`)
// ---------------------------------------------------------------------------

/// `POST /v1/join` request (Swift `JoinRequest`, `DTOs.swift:785-818`).
///
/// Swift hand-writes this decoder to accept two spellings of `displayName` and
/// three of `timeZone`, so the aliases below are contract, not convenience — an
/// onboarding form that posts `display_name` must not silently create a member
/// with an empty name.
///
/// Unlike the message DTOs this one is **not** `deny_unknown_fields`: Swift's
/// keyed container ignores unknown keys, and a public onboarding form is exactly
/// where a stray extra field is likeliest to appear. Rejecting one would break a
/// client the Swift server accepts.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    pub code: String,
    pub email: String,
    /// Absent decodes to `""`, which the validator answers 400 for — the same
    /// path Swift takes (`?? ""` then `normalizedDisplayName`).
    #[serde(default, alias = "display_name")]
    pub display_name: String,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default, alias = "time_zone", alias = "tz")]
    pub time_zone: Option<String>,
}

/// One channel the join put the new member into (Swift `JoinMembershipDTO`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinMembershipDto {
    pub id: String,
    pub channel_id: String,
    pub role: String,
}

/// `POST /v1/join` response (Swift `JoinResponse`, `DTOs.swift:826-836`).
///
/// It is a login response plus the redemption record: the client is signed in
/// when this returns, which is the point of the endpoint — an onboarding flow
/// that had to follow the join with a separate login would be two chances to
/// fail instead of one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub workspace_id: String,
    pub member: MemberDto,
    /// ADR-0110: the only authority for the realtime WebSocket address.
    pub realtime_web_socket_url: String,
    pub memberships: Vec<JoinMembershipDto>,
    pub invite: InviteCodeDto,
    pub redemption_id: String,
    /// `true` when this join created the account (201), `false` when an existing
    /// human rejoined (200).
    pub created_member: bool,
}

/// Swift `CreateWorkspaceRequest` (`WorkspaceRoutes.swift`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceRequest {
    pub slug: String,
    pub name: String,
}

/// `POST /v1/workspaces` 201 body (Swift `CreateWorkspaceResponse` :246-251).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceResponse {
    pub schema: &'static str,
    pub workspace_id: String,
    pub slug: String,
    pub name: String,
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
            thread: None,
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
        assert!(json.get("thread").is_none());
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

    /// The B1.2 read-state DTOs are the API's snake_case island. Renaming them
    /// to the camelCase every neighbouring DTO uses would break every shipped
    /// client silently — the keys simply would not be found.
    #[test]
    fn read_state_dtos_stay_snake_case() {
        let json = serde_json::to_value(ReadStateListResponseDto {
            read_states: vec![ReadStateDto {
                channel_id: "c".into(),
                last_read_seq: 1,
                latest_seq: 2,
                unread_count: 1,
                mention_count: 0,
            }],
        })
        .expect("serialize");
        assert!(json.get("read_states").is_some(), "{json}");
        assert!(json.get("readStates").is_none(), "{json}");
        assert_eq!(json["read_states"][0]["channel_id"], "c");
        assert_eq!(json["read_states"][0]["last_read_seq"], 1);
    }

    #[test]
    fn search_query_parses_leniently_like_history() {
        let query = SearchQuery {
            q: Some("needle".into()),
            limit: Some("nonsense".into()),
            cursor: None,
        };
        assert_eq!(
            query.limit(),
            None,
            "garbage limit falls back to the default"
        );
        let sized = SearchQuery {
            q: None,
            limit: Some("7".into()),
            cursor: None,
        };
        assert_eq!(sized.limit(), Some(7));
    }

    /// Swift's hand-written join decoder accepts two spellings of `displayName`
    /// and three of `timeZone`. A form that posts the snake_case one must not
    /// create a member with an empty display name.
    #[test]
    fn the_join_request_accepts_every_spelling_swift_accepts() {
        let camel: JoinRequest = serde_json::from_value(serde_json::json!({
            "code": "abc",
            "email": "ada@example.com",
            "displayName": "Ada",
            "timeZone": "Asia/Seoul",
            "password": "hunter2",
        }))
        .expect("camelCase decodes");
        assert_eq!(camel.display_name, "Ada");
        assert_eq!(camel.time_zone.as_deref(), Some("Asia/Seoul"));

        let snake: JoinRequest = serde_json::from_value(serde_json::json!({
            "code": "abc",
            "email": "ada@example.com",
            "display_name": "Ada",
            "time_zone": "Asia/Seoul",
        }))
        .expect("snake_case decodes");
        assert_eq!(snake.display_name, "Ada");
        assert_eq!(snake.time_zone.as_deref(), Some("Asia/Seoul"));

        let tz: JoinRequest = serde_json::from_value(serde_json::json!({
            "code": "abc",
            "email": "ada@example.com",
            "displayName": "Ada",
            "tz": "Asia/Seoul",
        }))
        .expect("the third timeZone spelling decodes");
        assert_eq!(tz.time_zone.as_deref(), Some("Asia/Seoul"));

        // Absent display name decodes to "" so the validator answers 400 with
        // Swift's wording, rather than serde answering with its own.
        let bare: JoinRequest = serde_json::from_value(serde_json::json!({
            "code": "abc",
            "email": "ada@example.com",
        }))
        .expect("an absent display name is a validation problem, not a decode one");
        assert_eq!(bare.display_name, "");
        assert!(bare.password.is_none());
        assert!(bare.handle.is_none());

        // A public onboarding form may carry extra keys; Swift ignores them.
        assert!(
            serde_json::from_value::<JoinRequest>(serde_json::json!({
                "code": "abc",
                "email": "ada@example.com",
                "displayName": "Ada",
                "utmSource": "newsletter",
            }))
            .is_ok(),
            "an unknown key must not 400 a request the Swift server accepts"
        );
    }

    /// The response carries the redemption record and never the code that
    /// produced it.
    #[test]
    fn the_join_response_omits_nothing_the_client_needs_and_carries_no_code() {
        let json = serde_json::to_value(JoinResponse {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            workspace_id: "ws".into(),
            member: MemberDto {
                id: "m".into(),
                workspace_id: "ws".into(),
                kind: "human".into(),
                display_name: "Ada".into(),
                handle: "ada".into(),
            },
            realtime_web_socket_url: "ws://localhost:8000/connection/websocket".into(),
            memberships: vec![JoinMembershipDto {
                id: "ms".into(),
                channel_id: "c".into(),
                role: "member".into(),
            }],
            invite: InviteCodeDto {
                id: "i".into(),
                workspace_id: "ws".into(),
                code_preview: "aB3-x9".into(),
                role: "member".into(),
                max_uses: 5,
                used_count: 1,
                expires_at_ms: 1_700_000_000_000,
                revoked_at_ms: None,
                revoked_by: None,
                revocation_reason: None,
                created_by: "o".into(),
                created_at_ms: 1_600_000_000_000,
                updated_at_ms: 1_600_000_000_000,
            },
            redemption_id: "r".into(),
            created_member: true,
        })
        .expect("serialize");
        assert_eq!(json["accessToken"], "access");
        assert_eq!(json["createdMember"], serde_json::json!(true));
        assert_eq!(json["memberships"][0]["channelId"], "c");
        assert_eq!(json["redemptionId"], "r");
        assert_eq!(json["invite"]["codePreview"], "aB3-x9");
        assert!(
            json["invite"].get("code").is_none(),
            "the raw code leaves the server exactly once, from the create call: {json}"
        );
    }
}
