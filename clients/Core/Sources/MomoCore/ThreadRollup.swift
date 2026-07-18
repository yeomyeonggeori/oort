import Foundation

/// Additive summary for a top-level message with at least one reply.
/// `lastReplyAtMs` is epoch milliseconds projected from `thread.last_reply_at`.
public struct ThreadRollup: Codable, Sendable, Hashable {
    public var replyCount: Int
    public var lastReplySeq: Int64
    public var lastReplyAtMs: Int64

    public init(replyCount: Int, lastReplySeq: Int64, lastReplyAtMs: Int64) {
        self.replyCount = replyCount
        self.lastReplySeq = lastReplySeq
        self.lastReplyAtMs = lastReplyAtMs
    }

    private enum CodingKeys: String, CodingKey {
        case replyCount = "reply_count"
        case lastReplySeq = "last_reply_seq"
        case lastReplyAtMs = "last_reply_at"
    }
}

/// `thread.updated` channel projection. It does not mint a new message seq;
/// `lastReplySeq` points at the reply that produced this rollup snapshot.
public struct ThreadRollupDelta: Codable, Sendable, Hashable {
    public var channelId: ChannelID
    public var rootId: MessageID
    public var replyCount: Int
    public var lastReplySeq: Int64
    public var lastReplyAtMs: Int64

    public init(
        channelId: ChannelID,
        rootId: MessageID,
        replyCount: Int,
        lastReplySeq: Int64,
        lastReplyAtMs: Int64
    ) {
        self.channelId = channelId
        self.rootId = rootId
        self.replyCount = replyCount
        self.lastReplySeq = lastReplySeq
        self.lastReplyAtMs = lastReplyAtMs
    }

    public var rollup: ThreadRollup {
        ThreadRollup(
            replyCount: replyCount,
            lastReplySeq: lastReplySeq,
            lastReplyAtMs: lastReplyAtMs
        )
    }

    private enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case rootId = "root_id"
        case replyCount = "reply_count"
        case lastReplySeq = "last_reply_seq"
        case lastReplyAtMs = "last_reply_at"
    }
}
