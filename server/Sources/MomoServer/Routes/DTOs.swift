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
    /// Optional explicit workspace; the stub resolves a default if omitted.
    let workspace: String?
}

/// POST /v1/auth/login response (stub-issued HS256 tokens).
struct LoginResponse: ResponseEncodable {
    let accessToken: String
    let refreshToken: String
    let member: MemberDTO
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
    let type: String?            // defaults to "text"
    let body: String?
    let props: [String: String]? // simplified structured payload for v0 stub
    let runId: UUID?
}

/// A message as returned by send/history (L4 §5.3 Message contract).
struct MessageDTO: ResponseEncodable {
    let id: String
    let channelId: String
    let seq: Int64
    let hlcTs: Int64
    let hlcCount: Int
    let authorMemberId: String
    let type: String
    let body: String?
    let createdAtMs: Int64
}

/// GET .../messages response (seq-cursor page, L4 §5.1 / §8.2).
struct MessagePage: ResponseEncodable {
    let messages: [MessageDTO]
    /// Cursor to fetch older messages (pass as `before`); nil at start of history.
    let nextBefore: Int64?
}

// ---- Workspace roster ----

/// Workspace member roster entry for client/agent surfaces.
///
/// Human-only and agent-only fields are intentionally sparse. The tenant roster
/// exposes identity and routing metadata, not agent secrets or execution config.
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
    let email: String?
    let timeZone: String?
    let agentModel: String?
    let ownerHumanId: String?
    let maxConcurrentRuns: Int?
    let maxRunSteps: Int?
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct WorkspaceRosterResponse: ResponseEncodable {
    let members: [RosterMemberDTO]
    let humanCount: Int
    let agentCount: Int
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

// ---- Public join ----

/// POST /v1/join request body.
///
/// Password auth is intentionally still a stub in v0: the join path records the
/// human identity and returns app tokens, while AuthRoutes continues to ignore
/// password_hash until the real auth ticket lands.
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

// ---- Health ----

struct HealthResponse: ResponseEncodable {
    let status: String
    let service: String
}
