import Foundation

public enum WorkHostScope: String, Codable, Sendable, Hashable {
    case member
    case workspace
}

public enum WorkHostType: String, Codable, Sendable, Hashable {
    case app
    case workd
    case cloud
}

/// REST projection of an ADR-0125 execution host.
///
/// This is intentionally not a realtime event. v0 clients poll the registry
/// list and use the server-computed `online` window. Capabilities contain only
/// boolean tool-availability flags; private keys, credentials, paths, process
/// state, and provider material are never represented here.
public struct WorkHost: Identifiable, Codable, Sendable, Hashable {
    public let id: WorkHostID
    public var workspaceId: WorkspaceID
    public var scope: WorkHostScope
    public var ownerMemberId: MemberID
    public var type: WorkHostType
    public var displayName: String
    public var publicKey: String
    public var capabilities: [String: Bool]
    public var lastSeenAtMs: Int64?
    public var revokedAtMs: Int64?
    public var createdAtMs: Int64
    public var online: Bool

    public init(
        id: WorkHostID,
        workspaceId: WorkspaceID,
        scope: WorkHostScope,
        ownerMemberId: MemberID,
        type: WorkHostType,
        displayName: String,
        publicKey: String,
        capabilities: [String: Bool] = [:],
        lastSeenAtMs: Int64? = nil,
        revokedAtMs: Int64? = nil,
        createdAtMs: Int64,
        online: Bool
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.scope = scope
        self.ownerMemberId = ownerMemberId
        self.type = type
        self.displayName = displayName
        self.publicKey = publicKey
        self.capabilities = capabilities
        self.lastSeenAtMs = lastSeenAtMs
        self.revokedAtMs = revokedAtMs
        self.createdAtMs = createdAtMs
        self.online = online
    }

    public var isRevoked: Bool { revokedAtMs != nil }

    private enum CodingKeys: String, CodingKey {
        case id, workspaceId, scope, ownerMemberId, type, displayName, publicKey
        case capabilities, lastSeenAtMs, revokedAtMs, createdAtMs, online
    }
}

public struct WorkHostListResponse: Codable, Sendable, Hashable {
    public var workHosts: [WorkHost]

    public init(workHosts: [WorkHost]) {
        self.workHosts = workHosts
    }
}
