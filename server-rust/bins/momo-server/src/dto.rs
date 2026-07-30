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
