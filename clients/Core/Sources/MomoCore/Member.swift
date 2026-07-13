import Foundation

/// A principal in a workspace — human OR agent, fully symmetric (L4 §1.2 #4).
/// Mirrors the `member` table (schema_v0.sql:45) plus realtime-derived `presence`.
public struct Member: Identifiable, Codable, Sendable, Hashable {
    public let id: MemberID
    public var workspaceId: WorkspaceID
    /// Discriminates human vs agent. Agents are first-class members.
    public var kind: MemberKind
    public var status: MemberStatus
    public var displayName: String
    /// `@handle`, unique per workspace (schema member_handle_uniq).
    public var handle: String
    public var avatarURL: URL?
    /// Active channel memberships from roster projections. Login payloads may
    /// omit this and default to an empty list.
    public var channelIds: [ChannelID]
    /// Public routing hints read through from `agent.config.capabilities`.
    /// Humans and legacy roster payloads use an empty list.
    public var capabilities: [String]
    /// Realtime presence (not persisted on `member`; merged from Centrifugo).
    public var presence: Presence

    public init(
        id: MemberID,
        workspaceId: WorkspaceID,
        kind: MemberKind,
        status: MemberStatus = .active,
        displayName: String,
        handle: String,
        avatarURL: URL? = nil,
        channelIds: [ChannelID] = [],
        capabilities: [String] = [],
        presence: Presence = .offline
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.kind = kind
        self.status = status
        self.displayName = displayName
        self.handle = handle
        self.avatarURL = avatarURL
        self.channelIds = channelIds
        self.capabilities = capabilities
        self.presence = presence
    }

    public var isAgent: Bool { kind == .agent }

    /// Stable, display-ready capability identifiers. Matching is deliberately
    /// case-insensitive while the raw read-through array remains available.
    public var normalizedCapabilities: [String] {
        var seen = Set<String>()
        return capabilities.compactMap { capability in
            guard let normalized = Self.normalizedCapability(capability),
                  seen.insert(normalized).inserted
            else { return nil }
            return normalized
        }
    }

    public func hasCapability(_ capability: String) -> Bool {
        guard let normalized = Self.normalizedCapability(capability) else { return false }
        return normalizedCapabilities.contains(normalized)
    }

    public static func normalizedCapability(_ capability: String) -> String? {
        let normalized = capability
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case kind
        case status
        case displayName = "display_name"
        case handle
        case avatarURL = "avatar_url"
        case channelIds = "channel_ids"
        case capabilities
        case presence
    }

    // presence is realtime-derived and may be absent in REST payloads.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(MemberID.self, forKey: .id)
        self.workspaceId = try c.decode(WorkspaceID.self, forKey: .workspaceId)
        self.kind = try c.decode(MemberKind.self, forKey: .kind)
        self.status = try c.decodeIfPresent(MemberStatus.self, forKey: .status) ?? .active
        self.displayName = try c.decode(String.self, forKey: .displayName)
        self.handle = try c.decode(String.self, forKey: .handle)
        self.avatarURL = try c.decodeIfPresent(URL.self, forKey: .avatarURL)
        self.channelIds = try c.decodeIfPresent([ChannelID].self, forKey: .channelIds) ?? []
        self.capabilities = try c.decodeIfPresent([String].self, forKey: .capabilities) ?? []
        self.presence = try c.decodeIfPresent(Presence.self, forKey: .presence) ?? .offline
    }
}

/// One participant's live presence on a channel (return of `ChatBackend.presence`).
public struct PresenceEntry: Identifiable, Codable, Sendable, Hashable {
    public var id: MemberID { memberId }
    public let memberId: MemberID
    public var channelId: ChannelID
    public var presence: Presence
    /// Last activity timestamp (ms since epoch, UTC) — L4 §5.1 `_ms` convention.
    public var lastSeenAtMs: Int64?
    /// Centrifugo connection id (for distinguishing multiple sessions of one member).
    public var connectionId: String?

    public init(
        memberId: MemberID,
        channelId: ChannelID,
        presence: Presence,
        lastSeenAtMs: Int64? = nil,
        connectionId: String? = nil
    ) {
        self.memberId = memberId
        self.channelId = channelId
        self.presence = presence
        self.lastSeenAtMs = lastSeenAtMs
        self.connectionId = connectionId
    }

    private enum CodingKeys: String, CodingKey {
        case memberId = "member_id"
        case channelId = "channel_id"
        case presence
        case lastSeenAtMs = "last_seen_at_ms"
        case connectionId = "connection_id"
    }
}
