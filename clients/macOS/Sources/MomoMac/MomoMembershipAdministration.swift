import Foundation
import MomoCore

public struct MomoWorkspaceAuditEvent: Identifiable, Sendable, Equatable, Decodable {
    public let id: UUID
    public let actorMemberId: MemberID?
    public let subjectMemberId: MemberID?
    public let action: String
    public let targetType: String?
    public let targetId: UUID?
    public let detail: JSON
    public let createdAtMs: Int64
}

public struct MomoWorkspaceAuditPage: Sendable, Equatable {
    public let events: [MomoWorkspaceAuditEvent]
    public let nextCursor: UUID?
}

public struct MomoWorkspaceAuditFilter: Sendable, Equatable {
    public var actionPrefixes: [String]
    public var targetMember: MemberID?
    public var fromMs: Int64?
    public var toMs: Int64?

    public static let all = MomoWorkspaceAuditFilter(
        actionPrefixes: [],
        targetMember: nil,
        fromMs: nil,
        toMs: nil
    )
}

public protocol MomoMembershipAdministrationBackend: Sendable {
    func changeWorkspaceRole(member: MemberID, role: MembershipRole) async throws
    func suspendWorkspaceMember(_ member: MemberID) async throws
    func reinstateWorkspaceMember(_ member: MemberID) async throws
    func removeWorkspaceMember(_ member: MemberID, ban: Bool, reason: String?) async throws
    func leaveWorkspace() async throws
    func leaveChannel(_ channel: ChannelID) async throws
    func workspaceAudit(
        cursor: UUID?,
        limit: Int,
        filter: MomoWorkspaceAuditFilter
    ) async throws -> MomoWorkspaceAuditPage
}

enum MomoMembershipAdministrationPolicy {
    static func assignableRoles(actor: Member?, target: Member) -> [MembershipRole] {
        guard actor?.status == .active, actor?.id != target.id else { return [] }
        switch actor?.workspaceRole {
        case .owner where target.workspaceRole != .owner:
            return [.owner, .admin, .member, .guest]
        case .admin where target.workspaceRole == .member || target.workspaceRole == .guest:
            return [.member, .guest]
        default:
            return []
        }
    }

    static func canChangeLifecycle(actor: Member?, target: Member) -> Bool {
        guard actor?.status == .active, actor?.id != target.id else { return false }
        switch (actor?.workspaceRole, target.workspaceRole) {
        case (.owner, .admin), (.owner, .member), (.owner, .guest),
             (.admin, .member), (.admin, .guest):
            return true
        default:
            return false
        }
    }
}
