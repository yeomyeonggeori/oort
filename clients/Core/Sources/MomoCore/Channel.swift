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
