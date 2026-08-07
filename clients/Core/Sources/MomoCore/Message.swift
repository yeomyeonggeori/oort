import Foundation

/// A message is the central object. Mirrors the `message` table (schema_v0.sql:155).
///
/// Ordering authority is `(channelId, seq)`: a per-channel monotonic gapless BIGINT
/// (L4 §1.2 #3, §3.1). HLC is stored decomposed (`hlcTs` physical ms + `hlcCount`
/// logical) for causal ordering across producers (L4 §3.2 / spec C5).
///
/// `clientMsgId` is the optimistic-send idempotency key (L4 §5.3 `sendOptimistic`):
/// a local echo carries it; the server reconciles by returning the authoritative
/// `seq`. Messages with a nil `seq` are local-only optimistic echoes not yet acked.
public struct Message: Identifiable, Codable, Sendable, Hashable {
    public let id: MessageID
    public var channelId: ChannelID
    /// Authoritative per-channel order. `nil` only for un-acked optimistic echoes.
    public var seq: Int64?
    /// Hybrid Logical Clock physical component (wall-clock ms).
    public var hlcTs: Int64
    /// Hybrid Logical Clock logical counter.
    public var hlcCount: Int32
    /// Author, human or agent, symmetric.
    public var authorMemberId: MemberID
    public var type: MessageType
    public var state: MessageState
    /// Rendered text (text/system); may be nil for structured types.
    public var body: String?
    /// Type-specific structured payload (tool_call/tool_result/diff/artifact/approval_request).
    public var props: JSON
    /// Thread root (`nil` = top-level; else the thread's root message id).
    public var rootId: MessageID?
    /// Server-authoritative reply summary; present only on top-level messages
    /// with one or more replies. Missing on older payloads for compatibility.
    public var thread: ThreadRollup?
    /// Completed attachments bound to this message. Missing when there are no
    /// attachments or when decoding an older server/realtime payload.
    public var attachments: [MessageAttachment]?
    /// Direct reply target.
    public var replyToId: MessageID?
    /// Agent provenance: which run produced this message.
    public var runId: RunID?
    /// Client idempotency key for retried/optimistic sends.
    public var clientMsgId: UUID?
    /// Creation time, ms since epoch UTC (L4 §5.1 `_ms`).
    public var createdAtMs: Int64?
    public var editedAtMs: Int64?
    public var deletedAtMs: Int64?

    public init(
        id: MessageID,
        channelId: ChannelID,
        seq: Int64? = nil,
        hlcTs: Int64,
        hlcCount: Int32 = 0,
        authorMemberId: MemberID,
        type: MessageType = .text,
        state: MessageState = .sent,
        body: String? = nil,
        props: JSON = .object([:]),
        rootId: MessageID? = nil,
        thread: ThreadRollup? = nil,
        attachments: [MessageAttachment]? = nil,
        replyToId: MessageID? = nil,
        runId: RunID? = nil,
        clientMsgId: UUID? = nil,
        createdAtMs: Int64? = nil,
        editedAtMs: Int64? = nil,
        deletedAtMs: Int64? = nil
    ) {
        self.id = id
        self.channelId = channelId
        self.seq = seq
        self.hlcTs = hlcTs
        self.hlcCount = hlcCount
        self.authorMemberId = authorMemberId
        self.type = type
        self.state = state
        self.body = body
        self.props = props
        self.rootId = rootId
        self.thread = thread
        self.attachments = attachments
        self.replyToId = replyToId
        self.runId = runId
        self.clientMsgId = clientMsgId
        self.createdAtMs = createdAtMs
        self.editedAtMs = editedAtMs
        self.deletedAtMs = deletedAtMs
    }

    /// True while this is a local optimistic echo awaiting server `seq` reconcile.
    public var isPendingAck: Bool { seq == nil }

    /// Tombstone check (L4 §5.1 DELETE = tombstone).
    public var isDeleted: Bool { state == .deleted || deletedAtMs != nil }

    /// The server-owned props key a streaming assembly writes into (#1130 전제①).
    public static let streamPropsKey = "momo.stream"

    /// The producer's revision for this message; `nil` if it never streamed.
    ///
    /// **Not a `seq`.** It orders one message's own slices and nothing else; the
    /// channel's order is still `seq`, which a growing body never consumes. Its
    /// only consumer is the staleness drop in `RealtimeSubscriptionDriver`.
    public var streamRev: Int64? {
        props[Message.streamPropsKey]?["rev"]?.intValue
    }

    /// True while more text is still arriving for this message.
    ///
    /// A renderer uses it for the "still arriving" affordance. It is `false` —
    /// not absent — once the final slice lands, so a client that only ever saw
    /// the last frame still knows this message was assembled rather than typed.
    public var isStreamingBody: Bool {
        props[Message.streamPropsKey]?["streaming"]?.boolValue ?? false
    }

    /// True when this payload is a **slice of a growing answer** rather than a
    /// human's revision (#1130 전제①).
    ///
    /// Both halves are required and the second is the load-bearing one. A
    /// streamed message keeps its `momo.stream` props forever, so a *person*
    /// later correcting that message arrives carrying the same `rev` — and a
    /// staleness rule that only looked at the revision would swallow their
    /// correction. The server never stamps `editedAtMs` on a slice and always
    /// stamps it on an edit, so that absence is what tells the two apart.
    public var isStreamSlice: Bool {
        streamRev != nil && editedAtMs == nil
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case channelId = "channel_id"
        case seq
        case hlcTs = "hlc_ts"
        case hlcCount = "hlc_count"
        case authorMemberId = "author_member_id"
        case type
        case state
        case body
        case props
        case rootId = "root_id"
        case thread
        case attachments
        case replyToId = "reply_to_id"
        case runId = "run_id"
        case clientMsgId = "client_msg_id"
        case createdAtMs = "created_at_ms"
        case editedAtMs = "edited_at_ms"
        case deletedAtMs = "deleted_at_ms"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(MessageID.self, forKey: .id)
        self.channelId = try c.decode(ChannelID.self, forKey: .channelId)
        self.seq = try c.decodeIfPresent(Int64.self, forKey: .seq)
        self.hlcTs = try c.decodeIfPresent(Int64.self, forKey: .hlcTs) ?? 0
        self.hlcCount = try c.decodeIfPresent(Int32.self, forKey: .hlcCount) ?? 0
        self.authorMemberId = try c.decode(MemberID.self, forKey: .authorMemberId)
        self.type = try c.decodeIfPresent(MessageType.self, forKey: .type) ?? .text
        self.state = try c.decodeIfPresent(MessageState.self, forKey: .state) ?? .sent
        self.body = try c.decodeIfPresent(String.self, forKey: .body)
        self.props = try c.decodeIfPresent(JSON.self, forKey: .props) ?? .object([:])
        self.rootId = try c.decodeIfPresent(MessageID.self, forKey: .rootId)
        self.thread = try c.decodeIfPresent(ThreadRollup.self, forKey: .thread)
        self.attachments = try c.decodeIfPresent([MessageAttachment].self, forKey: .attachments)
        self.replyToId = try c.decodeIfPresent(MessageID.self, forKey: .replyToId)
        self.runId = try c.decodeIfPresent(RunID.self, forKey: .runId)
        self.clientMsgId = try c.decodeIfPresent(UUID.self, forKey: .clientMsgId)
        self.createdAtMs = try c.decodeIfPresent(Int64.self, forKey: .createdAtMs)
        self.editedAtMs = try c.decodeIfPresent(Int64.self, forKey: .editedAtMs)
        self.deletedAtMs = try c.decodeIfPresent(Int64.self, forKey: .deletedAtMs)
    }
}

/// A not-yet-sent message composed on the client. Carried into
/// `ChatBackend.sendOptimistic(_:clientMsgId:)` (L4 §5.3).
public struct DraftMessage: Codable, Sendable, Hashable {
    public var channelId: ChannelID
    public var type: MessageType
    public var body: String?
    public var props: JSON
    /// Reply / thread targeting (optional).
    public var rootId: MessageID?
    public var replyToId: MessageID?
    /// Completed upload ids retained by the composer until the send request.
    public var attachmentIds: [FileID]?

    public init(
        channelId: ChannelID,
        type: MessageType = .text,
        body: String? = nil,
        props: JSON = .object([:]),
        rootId: MessageID? = nil,
        replyToId: MessageID? = nil,
        attachmentIds: [FileID]? = nil
    ) {
        self.channelId = channelId
        self.type = type
        self.body = body
        self.props = props
        self.rootId = rootId
        self.replyToId = replyToId
        self.attachmentIds = attachmentIds
    }

    private enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case type
        case body
        case props
        case rootId = "root_id"
        case replyToId = "reply_to_id"
        case attachmentIds
    }
}
