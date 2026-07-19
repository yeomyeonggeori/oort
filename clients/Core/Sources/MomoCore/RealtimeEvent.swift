import Foundation

// MARK: - Realtime delta payloads (L4 §5.2 event taxonomy)

/// `reaction.added` / `reaction.removed` on `ch:` / `dm:`.
public struct ReactionDelta: Codable, Sendable, Hashable {
    public enum Action: String, Codable, Sendable, Hashable {
        case added, removed
    }
    public var action: Action
    public var messageId: MessageID
    public var memberId: MemberID
    public var emoji: String

    public init(action: Action, messageId: MessageID, memberId: MemberID, emoji: String) {
        self.action = action
        self.messageId = messageId
        self.memberId = memberId
        self.emoji = emoji
    }

    private enum CodingKeys: String, CodingKey {
        case action
        case messageId = "message_id"
        case memberId = "member_id"
        case emoji
    }
}

/// `typing.start` / `typing.stop` on `ch:` / `dm:`.
public struct TypingDelta: Codable, Sendable, Hashable {
    public var channelId: ChannelID
    public var memberId: MemberID
    public var isTyping: Bool

    public init(channelId: ChannelID, memberId: MemberID, isTyping: Bool) {
        self.channelId = channelId
        self.memberId = memberId
        self.isTyping = isTyping
    }

    private enum CodingKeys: String, CodingKey {
        case channelId = "channel_id"
        case memberId = "member_id"
        case isTyping = "is_typing"
    }
}

/// Centrifugo presence join/leave snapshot delta (L4 §4.2 / §5.2).
public struct PresenceDelta: Codable, Sendable, Hashable {
    public enum Action: String, Codable, Sendable, Hashable {
        case join, leave, update
    }
    public var action: Action
    public var channelId: ChannelID
    public var memberId: MemberID
    public var presence: Presence

    public init(action: Action, channelId: ChannelID, memberId: MemberID, presence: Presence) {
        self.action = action
        self.channelId = channelId
        self.memberId = memberId
        self.presence = presence
    }

    private enum CodingKeys: String, CodingKey {
        case action
        case channelId = "channel_id"
        case memberId = "member_id"
        case presence
    }
}

/// `agent.status` event (queued/thinking/streaming/done/error) on `agent:`.
/// Carries the live run state machine + optional running cost for "cost breathing"
/// (demo B): reserved (estimate) vs spent (reconciled so far), integer micro_usd.
public struct AgentStatus: Codable, Sendable, Hashable {
    public var runId: RunID
    public var agentMemberId: MemberID
    public var channelId: ChannelID
    public var phase: AgentStatusPhase
    public var runStatus: RunStatus
    /// Pre-call reservation (estimate upper bound), integer micro_usd. L4 §8.5.
    public var reservedMicroUSD: Int64?
    /// Reconciled actual spend so far, integer micro_usd.
    public var spentMicroUSD: Int64?

    public init(
        runId: RunID,
        agentMemberId: MemberID,
        channelId: ChannelID,
        phase: AgentStatusPhase,
        runStatus: RunStatus,
        reservedMicroUSD: Int64? = nil,
        spentMicroUSD: Int64? = nil
    ) {
        self.runId = runId
        self.agentMemberId = agentMemberId
        self.channelId = channelId
        self.phase = phase
        self.runStatus = runStatus
        self.reservedMicroUSD = reservedMicroUSD
        self.spentMicroUSD = spentMicroUSD
    }

    private enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case agentMemberId = "agent_member_id"
        case channelId = "channel_id"
        case phase
        case runStatus = "run_status"
        case reservedMicroUSD = "reserved_micro_usd"
        case spentMicroUSD = "spent_micro_usd"
    }
}

/// `agent.partial` event: a streaming delta of a first-class message (L4 §5.2).
/// The `messageId` lets the client coalesce deltas into a single growing bubble.
public struct AgentPartial: Codable, Sendable, Hashable {
    public var runId: RunID
    public var channelId: ChannelID
    /// The (eventual) message id this delta belongs to, if assigned yet.
    public var messageId: MessageID?
    /// Streaming text delta to append.
    public var textDelta: String?
    /// In-progress tool-call info (demo D: live tool-call card).
    public var toolCallName: String?
    public var toolCallArgs: JSON?
    /// Running cost for cost-breathing (demo B), integer micro_usd.
    public var spentMicroUSD: Int64?

    public init(
        runId: RunID,
        channelId: ChannelID,
        messageId: MessageID? = nil,
        textDelta: String? = nil,
        toolCallName: String? = nil,
        toolCallArgs: JSON? = nil,
        spentMicroUSD: Int64? = nil
    ) {
        self.runId = runId
        self.channelId = channelId
        self.messageId = messageId
        self.textDelta = textDelta
        self.toolCallName = toolCallName
        self.toolCallArgs = toolCallArgs
        self.spentMicroUSD = spentMicroUSD
    }

    private enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case channelId = "channel_id"
        case messageId = "message_id"
        case textDelta = "text_delta"
        case toolCallName = "tool_call_name"
        case toolCallArgs = "tool_call_args"
        case spentMicroUSD = "spent_micro_usd"
    }
}

/// `approval.requested` / `approval.decided` on `ch:` (L4 §5.2).
/// Backs demo C (approval inbox) — first-class, batchable, with delegation badge.
public struct ApprovalEvent: Codable, Sendable, Hashable {
    public enum Action: String, Codable, Sendable, Hashable {
        case requested, decided
    }
    public var action: Action
    public var approvalId: ApprovalID
    public var runId: RunID
    public var channelId: ChannelID
    /// The agent that requested (actor).
    public var requestedBy: MemberID
    /// Human on whose behalf the agent acts (subject), if delegated. L4 §7.3.
    public var onBehalfOf: MemberID?
    /// 'tool_call' / 'deploy' / 'spend' etc.
    public var actionType: String
    public var status: ApprovalStatus
    public var payload: JSON
    /// Estimated cost of the gated action, integer micro_usd (cost in the inbox card).
    public var estimatedMicroUSD: Int64?
    /// Whether the gated action is reversible (risk badge in demo C money-shot).
    public var isReversible: Bool?
    public var decidedBy: MemberID?
    public var decisionReason: String?

    public init(
        action: Action,
        approvalId: ApprovalID,
        runId: RunID,
        channelId: ChannelID,
        requestedBy: MemberID,
        onBehalfOf: MemberID? = nil,
        actionType: String,
        status: ApprovalStatus,
        payload: JSON = .object([:]),
        estimatedMicroUSD: Int64? = nil,
        isReversible: Bool? = nil,
        decidedBy: MemberID? = nil,
        decisionReason: String? = nil
    ) {
        self.action = action
        self.approvalId = approvalId
        self.runId = runId
        self.channelId = channelId
        self.requestedBy = requestedBy
        self.onBehalfOf = onBehalfOf
        self.actionType = actionType
        self.status = status
        self.payload = payload
        self.estimatedMicroUSD = estimatedMicroUSD
        self.isReversible = isReversible
        self.decidedBy = decidedBy
        self.decisionReason = decisionReason
    }

    private enum CodingKeys: String, CodingKey {
        case action
        case approvalId = "approval_id"
        case runId = "run_id"
        case channelId = "channel_id"
        case requestedBy = "requested_by"
        case onBehalfOf = "on_behalf_of"
        case actionType = "action_type"
        case status
        case payload
        case estimatedMicroUSD = "estimated_micro_usd"
        case isReversible = "is_reversible"
        case decidedBy = "decided_by"
        case decisionReason = "decision_reason"
    }
}

/// Voice-huddle lifecycle delta on a channel subscription (ADR-0122 V-3).
public struct HuddleDelta: Codable, Sendable, Hashable {
    public enum Action: String, Codable, Sendable, Hashable {
        case started
        case participantsChanged = "participants_changed"
        case ended
    }

    public var action: Action
    public var huddleId: UUID
    public var channelId: ChannelID
    public var participantMemberIds: [MemberID]

    public init(
        action: Action,
        huddleId: UUID,
        channelId: ChannelID,
        participantMemberIds: [MemberID]
    ) {
        self.action = action
        self.huddleId = huddleId
        self.channelId = channelId
        self.participantMemberIds = participantMemberIds
    }

    private enum CodingKeys: String, CodingKey {
        case action
        case huddleId = "huddle_id"
        case channelId = "channel_id"
        case participantMemberIds = "participant_member_ids"
    }
}

// MARK: - RealtimeEvent (L4 §5.3)

/// Decoded realtime event delivered on a channel stream. Exactly the cases from
/// the L4 §5.3 `ChatBackend` contract.
public enum RealtimeEvent: Sendable, Hashable {
    case message(Message)            // message.new
    case messageEdited(Message)      // message.edited
    case messageDeleted(MessageID)   // message.deleted (tombstone)
    case threadUpdated(ThreadRollupDelta)
    case reaction(ReactionDelta)
    case typing(TypingDelta)
    case presence(PresenceDelta)
    case agentStatus(AgentStatus)    // queued/thinking/streaming/done/error
    case agentPartial(AgentPartial)  // first-class streaming delta
    case approval(ApprovalEvent)
    case huddle(HuddleDelta)
    case workSession(WorkSessionDelta)
}
