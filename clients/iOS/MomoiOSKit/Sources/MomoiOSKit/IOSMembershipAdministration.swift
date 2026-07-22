import Foundation
import MomoCore
import Observation

public struct IOSWorkspaceAuditEvent: Identifiable, Sendable, Equatable, Decodable {
    public let id: UUID
    public let actorMemberId: MemberID?
    public let subjectMemberId: MemberID?
    public let action: String
    public let targetType: String?
    public let targetId: UUID?
    public let detail: JSON
    public let createdAtMs: Int64
}

public struct IOSWorkspaceAuditPage: Sendable, Equatable {
    public let events: [IOSWorkspaceAuditEvent]
    public let nextCursor: UUID?
}

public struct IOSWorkspaceAuditFilter: Sendable, Equatable {
    public var actionPrefixes: [String]
    public var targetMember: MemberID?
    public var fromMs: Int64?
    public var toMs: Int64?

    public static let all = IOSWorkspaceAuditFilter(
        actionPrefixes: [],
        targetMember: nil,
        fromMs: nil,
        toMs: nil
    )
}

enum IOSMembershipAdministrationPolicy {
    static func assignableRoles(actor: Member?, target: Member) -> [MembershipRole] {
        guard actor?.status == .active, actor?.id != target.id else { return [] }
        switch actor?.workspaceRole {
        case .owner where target.workspaceRole != .owner:
            return [.owner, .admin, .member, .guest]
        case .admin where target.workspaceRole == .member || target.workspaceRole == .guest:
            return [.member, .guest]
        default: return []
        }
    }

    static func canChangeLifecycle(actor: Member?, target: Member) -> Bool {
        guard actor?.status == .active, actor?.id != target.id else { return false }
        switch (actor?.workspaceRole, target.workspaceRole) {
        case (.owner, .admin), (.owner, .member), (.owner, .guest),
             (.admin, .member), (.admin, .guest): return true
        default: return false
        }
    }
}

extension MomoServerConversationClient {
    public func changeWorkspaceRole(member: MemberID, role: MembershipRole) async throws {
        _ = try await membershipRequest(
            path: "/v1/workspaces/\(authenticated.workspaceID.description)/members/\(member.description)/role",
            method: "PATCH",
            body: IOSMembershipRoleRequest(role: role.rawValue),
            response: IOSMembershipRoleResponse.self
        )
    }

    public func suspendWorkspaceMember(_ member: MemberID) async throws {
        try await changeMemberStatus(member, action: "suspend")
    }

    public func reinstateWorkspaceMember(_ member: MemberID) async throws {
        try await changeMemberStatus(member, action: "reinstate")
    }

    public func removeWorkspaceMember(_ member: MemberID, ban: Bool, reason: String?) async throws {
        _ = try await membershipRequest(
            path: "/v1/workspaces/\(authenticated.workspaceID.description)/members/\(member.description)",
            method: "DELETE",
            body: IOSRemoveWorkspaceMemberRequest(ban: ban, reason: reason),
            response: IOSMembershipLifecycleResponse.self
        )
    }

    public func leaveWorkspace() async throws {
        _ = try await membershipRequest(
            path: "/v1/workspaces/\(authenticated.workspaceID.description)/members/me",
            method: "DELETE",
            response: IOSMembershipLifecycleResponse.self
        )
    }

    public func leaveChannel(_ channel: ChannelID) async throws {
        _ = try await membershipRequest(
            path: "/v1/workspaces/\(authenticated.workspaceID.description)/channels/\(channel.description)/members/me",
            method: "DELETE",
            response: IOSChannelLeaveResponse.self
        )
    }

    public func workspaceAudit(
        cursor: UUID?,
        limit: Int = 50,
        filter: IOSWorkspaceAuditFilter = .all
    ) async throws -> IOSWorkspaceAuditPage {
        var components = URLComponents(
            url: authenticated.baseURL.appendingPathComponent(
                "/v1/workspaces/\(authenticated.workspaceID.description)/audit"
            ),
            resolvingAgainstBaseURL: false
        )
        var query = [URLQueryItem(name: "limit", value: String(max(1, min(limit, 100))))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor.uuidString.lowercased())) }
        if !filter.actionPrefixes.isEmpty {
            query.append(URLQueryItem(name: "actions", value: filter.actionPrefixes.joined(separator: ",")))
        }
        if let target = filter.targetMember {
            query.append(URLQueryItem(name: "target_member_id", value: target.description.lowercased()))
        }
        if let fromMs = filter.fromMs {
            query.append(URLQueryItem(name: "from_ms", value: String(fromMs)))
        }
        if let toMs = filter.toMs {
            query.append(URLQueryItem(name: "to_ms", value: String(toMs)))
        }
        components?.queryItems = query
        guard let url = components?.url else {
            throw SessionError.validation("Could not create the audit request.")
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        let page = try decoder.decode(IOSWorkspaceAuditPageResponse.self, from: try await execute(request: request))
        return IOSWorkspaceAuditPage(
            events: page.events,
            nextCursor: page.nextCursor.flatMap(UUID.init(uuidString:))
        )
    }

    private func changeMemberStatus(_ member: MemberID, action: String) async throws {
        _ = try await membershipRequest(
            path: "/v1/workspaces/\(authenticated.workspaceID.description)/members/\(member.description)/\(action)",
            method: "POST",
            response: IOSMembershipLifecycleResponse.self
        )
    }

    private func membershipRequest<Response: Decodable>(
        path: String,
        method: String,
        response: Response.Type
    ) async throws -> Response {
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        return try decoder.decode(Response.self, from: try await execute(request: request))
    }

    private func membershipRequest<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body,
        response: Response.Type
    ) async throws -> Response {
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try decoder.decode(Response.self, from: try await execute(request: request))
    }
}

@MainActor
@Observable
public final class IOSMembershipAdministrationModel {
    public private(set) var mutationMemberIDs: Set<MemberID> = []
    public private(set) var errorMessage: String?
    public private(set) var auditEvents: [IOSWorkspaceAuditEvent] = []
    public private(set) var auditNextCursor: UUID?
    public private(set) var auditIsLoading = false
    public private(set) var auditFilter = IOSWorkspaceAuditFilter.all

    private let backend: MomoServerConversationClient

    public init(backend: MomoServerConversationClient) {
        self.backend = backend
    }

    public func assignableRoles(actor: Member?, target: Member) -> [MembershipRole] {
        IOSMembershipAdministrationPolicy.assignableRoles(actor: actor, target: target)
    }

    public func canChangeLifecycle(actor: Member?, target: Member) -> Bool {
        IOSMembershipAdministrationPolicy.canChangeLifecycle(actor: actor, target: target)
    }

    public func changeRole(member: Member, actor: Member?, role: MembershipRole) async -> Bool {
        guard assignableRoles(actor: actor, target: member).contains(role) else { return false }
        return await mutate(member.id) { try await backend.changeWorkspaceRole(member: member.id, role: role) }
    }

    public func setSuspended(_ suspended: Bool, member: Member, actor: Member?) async -> Bool {
        guard canChangeLifecycle(actor: actor, target: member) else { return false }
        return await mutate(member.id) {
            if suspended { try await backend.suspendWorkspaceMember(member.id) }
            else { try await backend.reinstateWorkspaceMember(member.id) }
        }
    }

    public func remove(member: Member, actor: Member?, ban: Bool, reason: String) async -> Bool {
        guard canChangeLifecycle(actor: actor, target: member) else { return false }
        let normalized = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return await mutate(member.id) {
            try await backend.removeWorkspaceMember(
                member.id,
                ban: ban,
                reason: normalized.isEmpty ? nil : normalized
            )
        }
    }

    public func loadAudit(reset: Bool = false, filter: IOSWorkspaceAuditFilter? = nil) async {
        guard !auditIsLoading else { return }
        if reset {
            auditNextCursor = nil
            if let filter { auditFilter = filter }
        }
        auditIsLoading = true
        errorMessage = nil
        defer { auditIsLoading = false }
        do {
            let page = try await backend.workspaceAudit(
                cursor: reset ? nil : auditNextCursor,
                filter: auditFilter
            )
            if reset {
                auditEvents = page.events
            } else {
                let known = Set(auditEvents.map(\.id))
                auditEvents.append(contentsOf: page.events.filter { !known.contains($0.id) })
            }
            auditNextCursor = page.nextCursor
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func clearError() { errorMessage = nil }

    private func mutate(_ memberID: MemberID, operation: () async throws -> Void) async -> Bool {
        guard !mutationMemberIDs.contains(memberID) else { return false }
        mutationMemberIDs.insert(memberID)
        errorMessage = nil
        defer { mutationMemberIDs.remove(memberID) }
        do { try await operation(); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }
}

private struct IOSMembershipRoleRequest: Encodable { let role: String }
private struct IOSRemoveWorkspaceMemberRequest: Encodable { let ban: Bool; let reason: String? }
private struct IOSMembershipRoleResponse: Decodable { let memberId: String; let scope: String; let role: String }
private struct IOSMembershipLifecycleResponse: Decodable { let memberId: String; let status: String }
private struct IOSChannelLeaveResponse: Decodable { let channelId: String; let memberId: String; let archived: Bool }
private struct IOSWorkspaceAuditPageResponse: Decodable { let events: [IOSWorkspaceAuditEvent]; let nextCursor: String? }
