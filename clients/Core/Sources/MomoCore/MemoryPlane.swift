import Foundation

public enum MemoryScope: String, Codable, CaseIterable, Sendable, Hashable {
    case workspace
    case member
    case agent
    case conversation
}

public enum MemoryKind: String, Codable, CaseIterable, Sendable, Hashable {
    case profile
    case fact
    case episode
    case procedure
}

public struct MemorySourceReference: Codable, Sendable, Hashable {
    public let messageId: MessageID
    public let channelId: ChannelID

    public init(messageId: MessageID, channelId: ChannelID) {
        self.messageId = messageId
        self.channelId = channelId
    }
}

public struct MemoryEntry: Identifiable, Codable, Sendable, Hashable {
    public let id: UUID
    public let workspaceId: WorkspaceID
    public let scope: MemoryScope
    public let subjectMemberId: MemberID?
    public let agentMemberId: MemberID?
    public let channelId: ChannelID?
    public let kind: MemoryKind
    public let body: String
    public let confidence: Double
    public let validAtMs: Int64
    public let invalidAtMs: Int64?
    public let invalidatedByMemoryId: UUID?
    public let createdByKind: String
    public let createdByMemberId: MemberID?
    public let createdAtMs: Int64
    public let updatedAtMs: Int64
    public let sourceRefs: [MemorySourceReference]

    public init(
        id: UUID,
        workspaceId: WorkspaceID,
        scope: MemoryScope,
        subjectMemberId: MemberID? = nil,
        agentMemberId: MemberID? = nil,
        channelId: ChannelID? = nil,
        kind: MemoryKind,
        body: String,
        confidence: Double,
        validAtMs: Int64,
        invalidAtMs: Int64? = nil,
        invalidatedByMemoryId: UUID? = nil,
        createdByKind: String,
        createdByMemberId: MemberID? = nil,
        createdAtMs: Int64,
        updatedAtMs: Int64,
        sourceRefs: [MemorySourceReference]
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.scope = scope
        self.subjectMemberId = subjectMemberId
        self.agentMemberId = agentMemberId
        self.channelId = channelId
        self.kind = kind
        self.body = body
        self.confidence = confidence
        self.validAtMs = validAtMs
        self.invalidAtMs = invalidAtMs
        self.invalidatedByMemoryId = invalidatedByMemoryId
        self.createdByKind = createdByKind
        self.createdByMemberId = createdByMemberId
        self.createdAtMs = createdAtMs
        self.updatedAtMs = updatedAtMs
        self.sourceRefs = sourceRefs
    }

    public var isActive: Bool { invalidAtMs == nil }
}

public struct MemorySearchHit: Codable, Sendable, Hashable {
    public let memory: MemoryEntry
    public let score: Double
    public let ftsRank: Int?
    public let vectorRank: Int?
    public let vectorDistance: Double?

    public init(
        memory: MemoryEntry,
        score: Double,
        ftsRank: Int? = nil,
        vectorRank: Int? = nil,
        vectorDistance: Double? = nil
    ) {
        self.memory = memory
        self.score = score
        self.ftsRank = ftsRank
        self.vectorRank = vectorRank
        self.vectorDistance = vectorDistance
    }
}

public struct WorkspaceMemoryPolicy: Codable, Sendable, Hashable {
    public let workspaceId: WorkspaceID
    public let enabled: Bool
    public let updatedBy: MemberID?
    public let updatedAtMs: Int64?

    public init(
        workspaceId: WorkspaceID,
        enabled: Bool,
        updatedBy: MemberID? = nil,
        updatedAtMs: Int64? = nil
    ) {
        self.workspaceId = workspaceId
        self.enabled = enabled
        self.updatedBy = updatedBy
        self.updatedAtMs = updatedAtMs
    }
}

public struct ContextPacketSnapshot: Codable, Sendable, Hashable {
    public let packetId: UUID
    public let runId: RunID
    public let workspaceId: WorkspaceID
    public let createdAtMs: Int64
    public let expiresAtMs: Int64
    public let expired: Bool
    public let content: JSON

    public init(
        packetId: UUID,
        runId: RunID,
        workspaceId: WorkspaceID,
        createdAtMs: Int64,
        expiresAtMs: Int64,
        expired: Bool,
        content: JSON
    ) {
        self.packetId = packetId
        self.runId = runId
        self.workspaceId = workspaceId
        self.createdAtMs = createdAtMs
        self.expiresAtMs = expiresAtMs
        self.expired = expired
        self.content = content
    }
}

/// Optional Memory Plane capability. Implementations must use server REST as the
/// authority; clients never rebuild Context Packets or persist capability data.
public protocol MemoryPlaneBackend: Sendable {
    func memories(
        workspace: WorkspaceID,
        scope: MemoryScope?,
        agent: MemberID?,
        includeInvalid: Bool,
        limit: Int
    ) async throws -> [MemoryEntry]

    func searchMemories(
        workspace: WorkspaceID,
        query: String,
        scope: MemoryScope?,
        agent: MemberID?,
        limit: Int
    ) async throws -> [MemorySearchHit]

    func updateMemory(
        workspace: WorkspaceID,
        memory: UUID,
        body: String,
        confidence: Double
    ) async throws -> MemoryEntry

    func invalidateMemory(workspace: WorkspaceID, memory: UUID) async throws -> MemoryEntry
    func memoryPolicy(workspace: WorkspaceID) async throws -> WorkspaceMemoryPolicy
    func setMemoryPolicy(workspace: WorkspaceID, enabled: Bool) async throws -> WorkspaceMemoryPolicy
    func contextPacket(workspace: WorkspaceID, packet: UUID) async throws -> ContextPacketSnapshot
}
