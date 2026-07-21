import Foundation
import Hummingbird

// MARK: - Wire DTOs
//
// Request/response bodies for the REST surface (L4 §5.1). Field names mirror the
// MomoCore client models where practical so the Swift clients can share shapes.
// All timestamps are RFC3339 UTC; epoch-ms variants carry an `_ms` suffix (L4 §5.1).

// ---- Auth ----

/// POST /v1/auth/login request.
struct LoginRequest: Decodable {
    let email: String
    let password: String
    /// Optional, separate platform-admin elevation secret. The account password
    /// still has to pass password_hash verification before this can add scope.
    let platformAdminSecret: String?
    /// Optional explicit workspace; the stub resolves a default if omitted.
    let workspace: String?

    private enum CodingKeys: String, CodingKey {
        case email
        case password
        case platformAdminSecret
        case platformAdminSecretSnake = "platform_admin_secret"
        case workspace
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.email = try c.decode(String.self, forKey: .email)
        self.password = try c.decode(String.self, forKey: .password)
        self.platformAdminSecret = try c.decodeIfPresent(String.self, forKey: .platformAdminSecret)
            ?? c.decodeIfPresent(String.self, forKey: .platformAdminSecretSnake)
        self.workspace = try c.decodeIfPresent(String.self, forKey: .workspace)
    }
}

/// POST /v1/auth/login response.
struct LoginResponse: ResponseEncodable {
    let accessToken: String
    let refreshToken: String
    let member: MemberDTO
    let realtimeWebSocketUrl: String
}

/// POST /v1/auth/refresh request (MOMO-300 rotation).
struct RefreshRequest: Decodable {
    let refreshToken: String
}

/// POST /v1/auth/refresh response — the presented refresh token is revoked
/// (rotation) and a fresh access/refresh pair is issued.
struct RefreshResponse: ResponseEncodable {
    let accessToken: String
    let refreshToken: String
}

/// POST /v1/auth/logout optional request body. The access token comes from the
/// Authorization header; the client may also hand in its refresh token so the
/// whole session dies at once.
struct LogoutRequest: Decodable {
    let refreshToken: String?
}

/// POST /v1/auth/logout response (idempotent — repeat calls return 200 with
/// `alreadyRevoked=true` and revoke nothing new).
struct LogoutResponse: ResponseEncodable {
    let status: String
    let revokedAccess: Bool
    let revokedRefresh: Bool
    let alreadyRevoked: Bool
}

/// POST /v1/auth/realtime-token response.
struct RealtimeTokenResponse: ResponseEncodable, Codable, Sendable {
    let token: String
    let tokenType: String
    let expiresAtMs: Int64
    let ttlSeconds: Int
    let workspaceId: String
    let memberId: String

    private enum CodingKeys: String, CodingKey {
        case token
        case tokenType
        case expiresAtMs
        case ttlSeconds
        case workspaceId
        case memberId
    }
}

struct MemberDTO: ResponseEncodable {
    let id: String
    let workspaceId: String
    let kind: String
    let displayName: String
    let handle: String
}

// ---- Messages ----

/// POST .../messages request body. `clientMsgId` drives idempotency (L4 §3.1).
struct SendMessageRequest: Decodable {
    let clientMsgId: UUID
    let rootId: UUID?
    let type: String?            // defaults to "text"
    let body: String?
    let props: [String: String]? // simplified structured payload for v0 stub
    let runId: UUID?
    let attachmentIds: [UUID]?
}

/// PATCH .../messages/{id} request. The authenticated author is the only
/// mutable actor; author/member ids are deliberately absent from the body.
struct EditMessageRequest: Decodable {
    let body: String
}

/// Additive thread summary projected only on top-level messages with replies.
/// The nested wire keys intentionally mirror the durable `thread` projection.
struct ThreadRollupDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let replyCount: Int
    let lastReplySeq: Int64
    /// Epoch milliseconds for the `thread.last_reply_at` timestamptz.
    let lastReplyAt: Int64

    private enum CodingKeys: String, CodingKey {
        case replyCount = "reply_count"
        case lastReplySeq = "last_reply_seq"
        case lastReplyAt = "last_reply_at"
    }
}

/// Download-safe attachment metadata projected on a message. Resumable upload
/// URLs and archive provider identifiers are deliberately outside this shape.
struct MessageAttachmentDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let name: String
    let mime: String
    let sizeBytes: Int64
}

/// A message as returned by send/history (L4 §5.3 Message contract).
struct MessageDTO: ResponseEncodable, Codable, Sendable {
    let id: String
    let channelId: String
    let rootId: String?
    let seq: Int64
    let hlcTs: Int64
    let hlcCount: Int
    let authorMemberId: String
    let type: String
    let body: String?
    let props: [String: JSONValue]?
    let runId: String?
    let clientMsgId: String?
    let createdAtMs: Int64
    let state: String?
    let editedAtMs: Int64?
    let deletedAtMs: Int64?
    /// Present only when one or more completed attachments are bound to this message.
    let attachments: [MessageAttachmentDTO]?
    let thread: ThreadRollupDTO?
}

/// The same delta shape consumed by MomoCore's `ReactionDelta` once it is
/// nested in a realtime envelope.
struct ReactionDeltaDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let action: String
    let messageId: String
    let memberId: String
    let emoji: String
}

/// Cold-load projection used by the macOS interaction model. It intentionally
/// encodes as the mapping itself (message id -> emoji -> member ids), without a
/// wrapper key, so the REST contract matches the UI snapshot type exactly.
struct ReactionSnapshotDTO: ResponseEncodable, Encodable, Sendable {
    let snapshot: [String: [String: [String]]]

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(snapshot)
    }
}

/// GET .../messages response (seq-cursor page, L4 §5.1 / §8.2).
struct MessagePage: ResponseEncodable {
    let messages: [MessageDTO]
    /// Cursor to fetch older messages (pass as `before`); nil at start of history.
    let nextBefore: Int64?
}

/// GET .../messages/{root}/replies response. Replies are always ordered by
/// ascending channel seq; pass `nextCursor` back as `cursor` for the next page.
struct ThreadRepliesPage: ResponseEncodable, Codable, Sendable {
    let messages: [MessageDTO]
    let nextCursor: Int64?
}

/// GET workspace search/messages response. Snippets are server-bounded around
/// the first match; `matchOffset` is zero-based within `snippet`.
struct WorkspaceMessageSearchHitDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let channelId: String
    let messageId: String
    let seq: Int64
    let authorMemberId: String
    let createdAtMs: Int64
    let snippet: String
    let matchOffset: Int
}

struct WorkspaceMessageSearchResponse: ResponseEncodable, Codable, Sendable, Equatable {
    let hits: [WorkspaceMessageSearchHitDTO]
    let nextCursor: String?
}

struct ChannelLeaveResponse: ResponseEncodable, Codable, Sendable, Equatable {
    let channelId: String
    let memberId: String
    let archived: Bool
}

// ---- Read state ----

/// PUT .../read-state request. The actor member id intentionally does not exist
/// in this shape; the authenticated principal is the only cursor owner.
struct UpdateReadStateRequestDTO: Decodable, Sendable {
    let lastReadSeq: Int64

    private enum CodingKeys: String, CodingKey {
        case lastReadSeq = "last_read_seq"
    }
}

struct ReadStateDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let channelId: String
    let lastReadSeq: Int64
    let latestSeq: Int64
    let unreadCount: Int64
    let mentionCount: Int

    private enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case lastReadSeq = "last_read_seq"
        case latestSeq = "latest_seq"
        case unreadCount = "unread_count"
        case mentionCount = "mention_count"
    }
}

struct ReadStateListResponseDTO: ResponseEncodable, Codable, Sendable {
    let readStates: [ReadStateDTO]

    private enum CodingKeys: String, CodingKey {
        case readStates = "read_states"
    }
}

// ---- Workspace roster ----

/// Workspace member roster entry for client/agent surfaces.
///
/// Human-only and agent-only fields are intentionally sparse. The tenant roster
/// exposes identity and routing metadata plus the public capability projection,
/// not agent secrets or the rest of the execution config.
struct RosterMemberDTO: ResponseEncodable, Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let status: String
    let displayName: String
    let handle: String
    let avatarUrl: String?
    let role: String?
    let channelCount: Int
    let channelIds: [String]
    let capabilities: [String]
    let email: String?
    let timeZone: String?
    let agentModel: String?
    let ownerHumanId: String?
    let maxConcurrentRuns: Int?
    let maxRunSteps: Int?
    let createdAtMs: Int64
    let updatedAtMs: Int64

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId
        case kind
        case status
        case displayName
        case handle
        case avatarUrl
        case role
        case channelCount
        case channelIds
        case capabilities
        case email
        case timeZone
        case agentModel
        case ownerHumanId
        case maxConcurrentRuns
        case maxRunSteps
        case createdAtMs
        case updatedAtMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.workspaceId = try c.decode(String.self, forKey: .workspaceId)
        self.kind = try c.decode(String.self, forKey: .kind)
        self.status = try c.decode(String.self, forKey: .status)
        self.displayName = try c.decode(String.self, forKey: .displayName)
        self.handle = try c.decode(String.self, forKey: .handle)
        self.avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        self.role = try c.decodeIfPresent(String.self, forKey: .role)
        self.channelCount = try c.decode(Int.self, forKey: .channelCount)
        self.channelIds = try c.decodeIfPresent([String].self, forKey: .channelIds) ?? []
        self.capabilities = try c.decodeIfPresent([String].self, forKey: .capabilities) ?? []
        self.email = try c.decodeIfPresent(String.self, forKey: .email)
        self.timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone)
        self.agentModel = try c.decodeIfPresent(String.self, forKey: .agentModel)
        self.ownerHumanId = try c.decodeIfPresent(String.self, forKey: .ownerHumanId)
        self.maxConcurrentRuns = try c.decodeIfPresent(Int.self, forKey: .maxConcurrentRuns)
        self.maxRunSteps = try c.decodeIfPresent(Int.self, forKey: .maxRunSteps)
        self.createdAtMs = try c.decode(Int64.self, forKey: .createdAtMs)
        self.updatedAtMs = try c.decode(Int64.self, forKey: .updatedAtMs)
    }
}

struct WorkspaceRosterResponse: ResponseEncodable {
    let members: [RosterMemberDTO]
    let humanCount: Int
    let agentCount: Int
}

// ---- Membership lifecycle (ADR-0128) ----

struct ChangeMembershipRoleRequest: Decodable {
    let role: String
}

struct MembershipRoleResponse: ResponseEncodable, Codable, Sendable {
    let memberId: String
    let scope: String
    let role: String
}

struct MembershipLifecycleResponse: ResponseEncodable, Codable, Sendable {
    let memberId: String
    let status: String
}

struct RemoveWorkspaceMemberRequest: Decodable {
    let ban: Bool?
    let reason: String?
}

struct CreateWorkspaceBanRequest: Decodable {
    let email: String?
    let handle: String?
    let reason: String?
}

struct WorkspaceBanDTO: ResponseEncodable, Codable, Sendable {
    let id: String
    let email: String?
    let handle: String?
    let createdBy: String
    let reason: String?
    let createdAtMs: Int64
}

struct WorkspaceBanResponse: ResponseEncodable, Codable, Sendable {
    let ban: WorkspaceBanDTO
}

struct WorkspaceBanListResponse: ResponseEncodable, Codable, Sendable {
    let bans: [WorkspaceBanDTO]
}

// ---- Workspace channels ----

/// Workspace channel entry visible to the authenticated member.
struct ChannelDTO: ResponseEncodable, Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let name: String?
    let topic: String?
    let dmKey: String?
    /// Active participants for DM channels. Empty for public/private channels.
    let memberIds: [String]?
    let createdBy: String?
    let archivedAtMs: Int64?
    /// Server-owned push suppression for the authenticated member.
    let muted: Bool
}

struct WorkspaceChannelsResponse: ResponseEncodable, Decodable {
    let channels: [ChannelDTO]
}

/// PUT /v1/workspaces/{ws}/channels/{ch}/notification-pref request body.
struct UpdateNotificationPrefRequest: Decodable {
    let muted: Bool
}

struct NotificationPrefResponse: ResponseEncodable, Decodable {
    let muted: Bool
}

/// POST /v1/workspaces/{ws}/dms request body.
struct OpenDirectMessageRequest: Decodable {
    let memberId: UUID

    private enum CodingKeys: String, CodingKey {
        case memberId
        case memberIdSnake = "member_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.memberId = try c.decodeIfPresent(UUID.self, forKey: .memberId)
            ?? c.decode(UUID.self, forKey: .memberIdSnake)
    }
}

struct OpenDirectMessageResponse: ResponseEncodable, Decodable {
    let channel: ChannelDTO
    let created: Bool
}

/// POST /v1/workspaces/{ws}/channels request body.
struct CreateChannelRequest: Decodable {
    let kind: String
    let name: String
    let topic: String?

    private enum CodingKeys: String, CodingKey {
        case kind
        case name
        case topic
    }
}

struct CreateChannelResponse: ResponseEncodable, Decodable {
    let channel: ChannelDTO
    let creatorMembership: ChannelMembershipDTO
}

/// POST /v1/workspaces/{ws}/channels/{ch}/members request body.
struct AddChannelMemberRequest: Decodable {
    let memberId: UUID
    let role: String?

    private enum CodingKeys: String, CodingKey {
        case memberId
        case memberIdSnake = "member_id"
        case role
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.memberId = try c.decodeIfPresent(UUID.self, forKey: .memberId)
            ?? c.decode(UUID.self, forKey: .memberIdSnake)
        self.role = try c.decodeIfPresent(String.self, forKey: .role)
    }
}

/// Channel membership management result.
struct ChannelMembershipDTO: ResponseEncodable, Decodable {
    let id: String
    let workspaceId: String
    let channelId: String
    let memberId: String
    let role: String
    let joinedAtMs: Int64
    let leftAtMs: Int64?
}

struct ChannelMembershipResponse: ResponseEncodable, Decodable {
    let membership: ChannelMembershipDTO
}

// ---- Cost projection ----

/// Server-owned B surface projection. Clients render this and do not calculate
/// budget state directly from ledger/window tables.
struct CostSnapshotDTO: ResponseEncodable, Codable, Sendable {
    let runId: String
    let reservedMicroUSD: Int64
    let spentMicroUSD: Int64
    let softLimitMicroUSD: Int64?
    let hardLimitMicroUSD: Int64?
    let isReconciled: Bool
    let wasEstimated: Bool
    let limitState: String

    private enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case reservedMicroUSD = "reserved_micro_usd"
        case spentMicroUSD = "spent_micro_usd"
        case softLimitMicroUSD = "soft_limit_micro_usd"
        case hardLimitMicroUSD = "hard_limit_micro_usd"
        case isReconciled = "is_reconciled"
        case wasEstimated = "was_estimated"
        case limitState = "limit_state"
    }
}

struct CostSnapshotPageDTO: ResponseEncodable, Codable, Sendable {
    let schema: String
    let channelId: String
    let snapshots: [CostSnapshotDTO]
    let asOfMs: Int64

    private enum CodingKeys: String, CodingKey {
        case schema
        case channelId = "channel_id"
        case snapshots
        case asOfMs = "as_of_ms"
    }
}

// ---- Approval decisions ----

/// POST /v1/workspaces/{ws}/approvals/{approval}/decision request body.
struct ApprovalDecisionRequestDTO: Decodable {
    let approvalId: UUID
    let approve: Bool
    let reason: String?
    let clientDecisionId: UUID

    private enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case approve
        case reason
        case clientDecisionId = "client_decision_id"
    }
}

/// A committed approval decision acknowledgement.
struct ApprovalDecisionReceiptDTO: ResponseEncodable, Codable, Sendable {
    let approvalId: String
    let status: String
    let decidedBy: String?
    let decidedAtMs: Int64?
    let decisionReason: String?

    private enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case status
        case decidedBy = "decided_by"
        case decidedAtMs = "decided_at_ms"
        case decisionReason = "decision_reason"
    }
}

/// GET /v1/workspaces/{ws}/approvals?status=pending item.
struct ApprovalProjectionDTO: ResponseEncodable, Codable, Sendable {
    let id: String
    let workspaceId: String
    let runId: String
    let channelId: String
    let requestMessageId: String?
    let requestedBy: String
    let onBehalfOf: String?
    let actionType: String
    let payload: JSONValue
    let status: String
    let estimatedMicroUSD: Int64?
    let isReversible: Bool?
    let decidedBy: String?
    let decidedAtMs: Int64?
    let decisionReason: String?
    let expiresAtMs: Int64?

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case runId = "run_id"
        case channelId = "channel_id"
        case requestMessageId = "request_message_id"
        case requestedBy = "requested_by"
        case onBehalfOf = "on_behalf_of"
        case actionType = "action_type"
        case payload
        case status
        case estimatedMicroUSD = "estimated_micro_usd"
        case isReversible = "is_reversible"
        case decidedBy = "decided_by"
        case decidedAtMs = "decided_at_ms"
        case decisionReason = "decision_reason"
        case expiresAtMs = "expires_at_ms"
    }
}

struct ApprovalProjectionPageDTO: ResponseEncodable, Codable, Sendable {
    let approvals: [ApprovalProjectionDTO]
}

// ---- Invites ----

/// POST /v1/workspaces/{ws}/invites request body.
struct CreateInviteRequest: Decodable {
    let role: String?
    let maxUses: Int?
    /// Epoch milliseconds. Defaults server-side to seven days from creation.
    let expiresAtMs: Int64?
    let metadata: [String: String]?

    private enum CodingKeys: String, CodingKey {
        case role
        case maxUses
        case maxUsesSnake = "max_uses"
        case expiresAtMs
        case expiresAtMsSnake = "expires_at_ms"
        case metadata
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.role = try c.decodeIfPresent(String.self, forKey: .role)
        self.maxUses = try c.decodeIfPresent(Int.self, forKey: .maxUses)
            ?? c.decodeIfPresent(Int.self, forKey: .maxUsesSnake)
        self.expiresAtMs = try c.decodeIfPresent(Int64.self, forKey: .expiresAtMs)
            ?? c.decodeIfPresent(Int64.self, forKey: .expiresAtMsSnake)
        self.metadata = try c.decodeIfPresent([String: String].self, forKey: .metadata)
    }
}

/// POST /v1/workspaces/{ws}/invites/{invite}/revoke request body.
struct RevokeInviteRequest: Decodable {
    let reason: String?
}

/// POST /v1/workspaces/{ws}/invites/redeem request body.
struct RedeemInviteRequest: Decodable {
    let code: String
    let email: String?
}

/// Invite metadata returned by list/revoke/redeem. The raw code is intentionally
/// absent; it is only returned once in CreateInviteResponse.
struct InviteCodeDTO: ResponseEncodable, Decodable {
    let id: String
    let workspaceId: String
    let codePreview: String
    let role: String
    let maxUses: Int
    let usedCount: Int
    let expiresAtMs: Int64
    let revokedAtMs: Int64?
    let revokedBy: String?
    let revocationReason: String?
    let createdBy: String
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct CreateInviteResponse: ResponseEncodable {
    let invite: InviteCodeDTO
    /// High-entropy bearer secret. Store/display client-side; server stores only hash.
    let code: String
}

struct InviteListResponse: ResponseEncodable {
    let invites: [InviteCodeDTO]
}

struct RedeemInviteResponse: ResponseEncodable {
    let invite: InviteCodeDTO
    let redemptionId: String
}

// ---- Workspace identity ----

struct UpdateWorkspaceRequest: Decodable {
    let name: String
    let expectedUpdatedAtMs: Int64
}

struct WorkspaceDTO: ResponseEncodable, Decodable {
    let id: String
    let slug: String
    let name: String
    let updatedAtMs: Int64
}

struct WorkspaceResponse: ResponseEncodable, Decodable {
    let workspace: WorkspaceDTO
}

// ---- Public join ----

/// POST /v1/join request body.
///
struct JoinRequest: Decodable {
    let code: String
    let email: String
    let displayName: String
    let handle: String?
    let password: String?
    let timeZone: String?

    private enum CodingKeys: String, CodingKey {
        case code
        case email
        case displayName
        case displayNameSnake = "display_name"
        case handle
        case password
        case timeZone
        case timeZoneSnake = "time_zone"
        case tz
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.code = try c.decode(String.self, forKey: .code)
        self.email = try c.decode(String.self, forKey: .email)
        self.displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
            ?? c.decodeIfPresent(String.self, forKey: .displayNameSnake)
            ?? ""
        self.handle = try c.decodeIfPresent(String.self, forKey: .handle)
        self.password = try c.decodeIfPresent(String.self, forKey: .password)
        self.timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone)
            ?? c.decodeIfPresent(String.self, forKey: .timeZoneSnake)
            ?? c.decodeIfPresent(String.self, forKey: .tz)
    }
}

struct JoinMembershipDTO: ResponseEncodable, Decodable {
    let id: String
    let channelId: String
    let role: String
}

struct JoinResponse: ResponseEncodable {
    let accessToken: String
    let refreshToken: String
    let workspaceId: String
    let member: MemberDTO
    let realtimeWebSocketUrl: String
    let memberships: [JoinMembershipDTO]
    let invite: InviteCodeDTO
    let redemptionId: String
    let createdMember: Bool
}

// ---- Platform admin read-only inspection ----

struct PlatformWorkspaceDTO: ResponseEncodable, Decodable {
    let id: String
    let slug: String
    let name: String
    let createdAtMs: Int64
    let updatedAtMs: Int64
    let memberCount: Int
    let humanCount: Int
    let agentCount: Int
    let activeMemberCount: Int
    let inviteCodeCount: Int
    let activeInviteCodeCount: Int
    let inviteRedemptionCount: Int
    let lastInviteUsedAtMs: Int64?
}

struct PlatformWorkspaceListResponse: ResponseEncodable {
    let workspaces: [PlatformWorkspaceDTO]
}

struct PlatformMemberDTO: ResponseEncodable, Decodable {
    let id: String
    let workspaceId: String
    let workspaceSlug: String
    let kind: String
    let status: String
    let displayName: String
    let handle: String
    let email: String?
    let agentModel: String?
    let membershipCount: Int
    let inviteRedemptionCount: Int
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct PlatformMemberListResponse: ResponseEncodable {
    let members: [PlatformMemberDTO]
}

struct PlatformInviteDTO: ResponseEncodable, Decodable {
    let id: String
    let workspaceId: String
    let workspaceSlug: String
    let codePreview: String
    let role: String
    let maxUses: Int
    let usedCount: Int
    let redemptionCount: Int
    let expiresAtMs: Int64
    let revokedAtMs: Int64?
    let revokedBy: String?
    let createdBy: String
    let lastUsedAtMs: Int64?
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct PlatformInviteListResponse: ResponseEncodable {
    let invites: [PlatformInviteDTO]
}

// ---- Centrifugo subscribe proxy ----

/// Request body Centrifugo sends to the subscribe proxy endpoint (L4 §4.3).
/// Only the fields we authorize on are modeled; unknowns are ignored.
struct SubscribeProxyRequest: Decodable {
    let client: String?
    let user: String?
    let channel: String
    let meta: RealtimeTokenMeta?
}

/// Subscribe proxy success/deny envelope (Centrifugo proxy protocol).
/// Allow → `{"result": {}}`; deny → `{"error": {"code": .., "message": ..}}`.
struct SubscribeProxyResponse: ResponseEncodable {
    struct Result: ResponseEncodable {}
    struct ProxyError: ResponseEncodable {
        let code: Int
        let message: String
    }
    let result: Result?
    let error: ProxyError?

    static func allow() -> SubscribeProxyResponse { .init(result: .init(), error: nil) }
    static func deny(_ message: String) -> SubscribeProxyResponse {
        .init(result: nil, error: .init(code: 403, message: message))
    }
}

// ---- APNs devices (MOMO-403, ADR-0120 D4) ----

/// POST /v1/workspaces/{ws}/devices request body.
struct RegisterDeviceRequest: Decodable {
    /// Client-generated stable device identity (UUID). Re-sending the same id
    /// is the idempotent re-registration / token-rotation path.
    let deviceId: String
    /// `ios` or `macos` (`device_platform` enum).
    let platform: String
    let appBuild: String?
    /// Hex APNs device token. Stored, never echoed back — responses carry
    /// only the trailing suffix.
    let apnsToken: String
    /// `sandbox` or `production` (`push_env` enum).
    let env: String
    /// APNs topic (app bundle id).
    let topic: String

    private enum CodingKeys: String, CodingKey {
        case deviceId
        case deviceIdSnake = "device_id"
        case platform
        case appBuild
        case appBuildSnake = "app_build"
        case apnsToken
        case apnsTokenSnake = "apns_token"
        case env
        case topic
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId)
            ?? c.decodeIfPresent(String.self, forKey: .deviceIdSnake)
        else {
            throw DecodingError.keyNotFound(
                CodingKeys.deviceId,
                .init(codingPath: decoder.codingPath, debugDescription: "deviceId is required")
            )
        }
        guard let apnsToken = try c.decodeIfPresent(String.self, forKey: .apnsToken)
            ?? c.decodeIfPresent(String.self, forKey: .apnsTokenSnake)
        else {
            throw DecodingError.keyNotFound(
                CodingKeys.apnsToken,
                .init(codingPath: decoder.codingPath, debugDescription: "apnsToken is required")
            )
        }
        self.deviceId = deviceId
        self.apnsToken = apnsToken
        self.platform = try c.decode(String.self, forKey: .platform)
        self.appBuild = try c.decodeIfPresent(String.self, forKey: .appBuild)
            ?? c.decodeIfPresent(String.self, forKey: .appBuildSnake)
        self.env = try c.decode(String.self, forKey: .env)
        self.topic = try c.decode(String.self, forKey: .topic)
    }
}

/// Push token as returned by the device routes. The raw apns_token is
/// intentionally absent — `apnsTokenSuffix` (trailing 8 hex chars) is the
/// only registration receipt (MOMO-403: no raw token in responses).
struct PushTokenDTO: ResponseEncodable, Decodable {
    let id: String
    let deviceId: String
    let env: String
    let topic: String
    let apnsTokenSuffix: String
    let invalidatedAtMs: Int64?
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct DeviceDTO: ResponseEncodable, Decodable {
    let id: String
    let workspaceId: String
    let memberId: String
    let platform: String
    let appBuild: String?
    let lastSeenAtMs: Int64
    let createdAtMs: Int64
    let pushTokens: [PushTokenDTO]
}

struct RegisterDeviceResponse: ResponseEncodable {
    let device: DeviceDTO
}

struct DeviceListResponse: ResponseEncodable {
    let devices: [DeviceDTO]
}

struct RevokeDeviceResponse: ResponseEncodable {
    let device: DeviceDTO
    /// Number of tokens flipped to invalidated by THIS call (0 = idempotent
    /// repeat). Rows are never deleted.
    let invalidatedCount: Int
}

// ---- Health ----

struct HealthResponse: ResponseEncodable {
    let status: String
    let service: String
    let agentRuntime: AgentRuntimeStatusResponse
}

struct AgentRuntimeStatusResponse: ResponseEncodable {
    let schema: String
    let agentHandle: String
    let displayName: String
    let mode: String
    let availability: String
    let model: String
    let endpointLabel: String
    let keyConfigured: Bool
    let degradedReason: String?
    let diagnostics: [String]
}
