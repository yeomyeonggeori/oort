import Foundation

/// Server-owned per-channel read cursor projection (ADR-0109).
///
/// Bulk REST and personal realtime events share this shape. Clients may use
/// `receivingMessage` for immediate badge feedback, but a subsequent server
/// projection always replaces that local estimate.
public struct ChannelReadState: Codable, Sendable, Hashable {
    public var channelId: ChannelID
    public var lastReadSeq: Int64
    public var latestSeq: Int64
    public var unreadCount: Int64
    public var mentionCount: Int

    public init(
        channelId: ChannelID,
        lastReadSeq: Int64,
        latestSeq: Int64,
        unreadCount: Int64,
        mentionCount: Int
    ) {
        self.channelId = channelId
        self.lastReadSeq = lastReadSeq
        self.latestSeq = latestSeq
        self.unreadCount = unreadCount
        self.mentionCount = mentionCount
    }

    public var hasUnread: Bool {
        unreadCount > 0
    }

    public var hasMentions: Bool {
        mentionCount > 0
    }

    /// Local-only incoming-message estimate. The server's next bulk or
    /// personal-event projection replaces this value wholesale.
    public func receivingMessage(sequence: Int64, mentionsCurrentMember: Bool) -> Self {
        guard sequence > latestSeq else { return self }
        var updated = self
        updated.latestSeq = sequence
        updated.unreadCount = max(0, sequence - lastReadSeq)
        if mentionsCurrentMember, sequence > lastReadSeq {
            updated.mentionCount += 1
        }
        return updated
    }

    private enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case lastReadSeq = "last_read_seq"
        case latestSeq = "latest_seq"
        case unreadCount = "unread_count"
        case mentionCount = "mention_count"
    }
}

/// Optional capability implemented by backends that support ADR-0109.
/// Keeping it separate from `ChatBackend` preserves compatibility with older
/// fixtures and third-party transports while the read-state surface rolls out.
public protocol ReadStateBackend: Sendable {
    func readStates(workspace: WorkspaceID) async throws -> [ChannelReadState]
    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState
    func subscribeReadStates(member: MemberID) async throws -> AsyncThrowingStream<ChannelReadState, Error>
}
