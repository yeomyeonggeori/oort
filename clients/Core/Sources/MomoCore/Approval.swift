import Foundation

/// A human-in-the-loop approval gate for an agent action (L4 §3.3 G6, §6.1).
/// Mirrors the `approval` table (schema_v0.sql:307). Backs demo C (approval inbox).
public struct Approval: Identifiable, Codable, Sendable, Hashable {
    public let id: ApprovalID
    public var workspaceId: WorkspaceID
    public var runId: RunID
    public var channelId: ChannelID
    /// The `approval_request` first-class message.
    public var requestMessageId: MessageID?
    /// The agent that requested (actor).
    public var requestedBy: MemberID
    /// Human on whose behalf the agent acts (subject), if delegated (L4 §7.3).
    public var onBehalfOf: MemberID?
    /// 'tool_call' / 'deploy' / 'spend' etc.
    public var actionType: String
    public var payload: JSON
    public var status: ApprovalStatus
    /// Estimated cost of the gated action, integer micro_usd (inbox card).
    public var estimatedMicroUSD: Int64?
    /// Reversible vs irreversible — risk badge in the batch inbox (demo C).
    public var isReversible: Bool?
    public var decidedBy: MemberID?
    public var decidedAtMs: Int64?
    public var decisionReason: String?
    public var expiresAtMs: Int64?

    public init(
        id: ApprovalID,
        workspaceId: WorkspaceID,
        runId: RunID,
        channelId: ChannelID,
        requestMessageId: MessageID? = nil,
        requestedBy: MemberID,
        onBehalfOf: MemberID? = nil,
        actionType: String,
        payload: JSON = .object([:]),
        status: ApprovalStatus = .pending,
        estimatedMicroUSD: Int64? = nil,
        isReversible: Bool? = nil,
        decidedBy: MemberID? = nil,
        decidedAtMs: Int64? = nil,
        decisionReason: String? = nil,
        expiresAtMs: Int64? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.runId = runId
        self.channelId = channelId
        self.requestMessageId = requestMessageId
        self.requestedBy = requestedBy
        self.onBehalfOf = onBehalfOf
        self.actionType = actionType
        self.payload = payload
        self.status = status
        self.estimatedMicroUSD = estimatedMicroUSD
        self.isReversible = isReversible
        self.decidedBy = decidedBy
        self.decidedAtMs = decidedAtMs
        self.decisionReason = decisionReason
        self.expiresAtMs = expiresAtMs
    }

    public var isPending: Bool { status == .pending }

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case runId = "run_id"
        case channelId = "channel_id"
        case requestMessageId = "request_message_id"
        case requestedBy = "requested_by"
        case onBehalfOf = "on_behalf_of"
        case actionType = "action_type"
        case payload
        case status
        case estimatedMicroUSD = "estimated_micro_usd"
        case isReversible = "is_reversible"
        case decidedBy = "decided_by"
        case decidedAtMs = "decided_at_ms"
        case decisionReason = "decision_reason"
        case expiresAtMs = "expires_at_ms"
    }
}

/// An agent invocation/turn — the run state machine (L4 §3, §6).
/// Mirrors the `agent_run` table (schema_v0.sql:267) at the fields a client needs.
public struct AgentRun: Identifiable, Codable, Sendable, Hashable {
    public let id: RunID
    public var workspaceId: WorkspaceID
    public var agentMemberId: MemberID
    public var channelId: ChannelID
    public var triggerMessageId: MessageID?
    public var parentRunId: RunID?
    public var status: RunStatus
    public var stepCount: Int
    public var maxSteps: Int
    /// A2A hop depth (loop safety: capped at MAX_DEPTH, L4 §3.4).
    public var depth: Int
    public var output: JSON?
    public var error: JSON?
    public var startedAtMs: Int64?
    public var finishedAtMs: Int64?

    public init(
        id: RunID,
        workspaceId: WorkspaceID,
        agentMemberId: MemberID,
        channelId: ChannelID,
        triggerMessageId: MessageID? = nil,
        parentRunId: RunID? = nil,
        status: RunStatus = .queued,
        stepCount: Int = 0,
        maxSteps: Int = 50,
        depth: Int = 0,
        output: JSON? = nil,
        error: JSON? = nil,
        startedAtMs: Int64? = nil,
        finishedAtMs: Int64? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.agentMemberId = agentMemberId
        self.channelId = channelId
        self.triggerMessageId = triggerMessageId
        self.parentRunId = parentRunId
        self.status = status
        self.stepCount = stepCount
        self.maxSteps = maxSteps
        self.depth = depth
        self.output = output
        self.error = error
        self.startedAtMs = startedAtMs
        self.finishedAtMs = finishedAtMs
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case agentMemberId = "agent_member_id"
        case channelId = "channel_id"
        case triggerMessageId = "trigger_message_id"
        case parentRunId = "parent_run_id"
        case status
        case stepCount = "step_count"
        case maxSteps = "max_steps"
        case depth
        case output
        case error
        case startedAtMs = "started_at_ms"
        case finishedAtMs = "finished_at_ms"
    }
}

/// A two-phase cost snapshot for "cost breathing" (demo B, L4 §8.5).
/// Integer micro_usd accumulation avoids float drift.
public struct CostSnapshot: Codable, Sendable, Hashable {
    public var runId: RunID
    /// Pre-call reservation (estimate upper bound).
    public var reservedMicroUSD: Int64
    /// Reconciled actual spend.
    public var spentMicroUSD: Int64
    /// Soft-limit warning threshold for the matched budget grain.
    public var softLimitMicroUSD: Int64?
    /// True if usage was estimated (SSE usage chunk missing).
    public var wasEstimated: Bool

    public init(
        runId: RunID,
        reservedMicroUSD: Int64,
        spentMicroUSD: Int64,
        softLimitMicroUSD: Int64? = nil,
        wasEstimated: Bool = false
    ) {
        self.runId = runId
        self.reservedMicroUSD = reservedMicroUSD
        self.spentMicroUSD = spentMicroUSD
        self.softLimitMicroUSD = softLimitMicroUSD
        self.wasEstimated = wasEstimated
    }

    /// Convenience: micro_usd → USD (display only; never use for accounting math).
    public var spentUSD: Double { Double(spentMicroUSD) / 1_000_000.0 }
    public var reservedUSD: Double { Double(reservedMicroUSD) / 1_000_000.0 }

    private enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case reservedMicroUSD = "reserved_micro_usd"
        case spentMicroUSD = "spent_micro_usd"
        case softLimitMicroUSD = "soft_limit_micro_usd"
        case wasEstimated = "was_estimated"
    }
}
