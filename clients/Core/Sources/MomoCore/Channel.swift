import Foundation

/// A channel. Mirrors the `channel` table (schema_v0.sql:93).
public struct Channel: Identifiable, Codable, Sendable, Hashable {
    public let id: ChannelID
    public var workspaceId: WorkspaceID
    public var kind: ChannelKind
    /// Display name; nil only for DMs.
    public var name: String?
    public var topic: String?
    /// Canonical hash of sorted member ids — guarantees one DM per pair/group.
    public var dmKey: String?
    public var createdBy: MemberID?
    public var archivedAtMs: Int64?

    public init(
        id: ChannelID,
        workspaceId: WorkspaceID,
        kind: ChannelKind,
        name: String? = nil,
        topic: String? = nil,
        dmKey: String? = nil,
        createdBy: MemberID? = nil,
        archivedAtMs: Int64? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.kind = kind
        self.name = name
        self.topic = topic
        self.dmKey = dmKey
        self.createdBy = createdBy
        self.archivedAtMs = archivedAtMs
    }

    public var isArchived: Bool { archivedAtMs != nil }

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case kind
        case name
        case topic
        case dmKey = "dm_key"
        case createdBy = "created_by"
        case archivedAtMs = "archived_at_ms"
    }
}

/// Active or recently-removed membership for one member in one channel.
public struct ChannelMembership: Identifiable, Codable, Sendable, Hashable {
    public let id: UUID
    public var workspaceId: WorkspaceID
    public var channelId: ChannelID
    public var memberId: MemberID
    public var role: MembershipRole
    public var joinedAtMs: Int64
    public var leftAtMs: Int64?

    public init(
        id: UUID = UUID(),
        workspaceId: WorkspaceID,
        channelId: ChannelID,
        memberId: MemberID,
        role: MembershipRole = .member,
        joinedAtMs: Int64,
        leftAtMs: Int64? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.channelId = channelId
        self.memberId = memberId
        self.role = role
        self.joinedAtMs = joinedAtMs
        self.leftAtMs = leftAtMs
    }

    public var isActive: Bool { leftAtMs == nil }

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case channelId = "channel_id"
        case memberId = "member_id"
        case role
        case joinedAtMs = "joined_at_ms"
        case leftAtMs = "left_at_ms"
    }
}

public struct ChannelCreateResult: Codable, Sendable, Hashable {
    public var channel: Channel
    public var creatorMembership: ChannelMembership

    public init(channel: Channel, creatorMembership: ChannelMembership) {
        self.channel = channel
        self.creatorMembership = creatorMembership
    }
}

/// A workspace (tenant root). Mirrors `workspace` (schema_v0.sql:28).
public struct Workspace: Identifiable, Codable, Sendable, Hashable {
    public let id: WorkspaceID
    public var slug: String
    public var name: String

    public init(id: WorkspaceID, slug: String, name: String) {
        self.id = id
        self.slug = slug
        self.name = name
    }
}
