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

/// Client intent for deciding an `approval_request` checkpoint through the
/// ChatBackend REST contract. The server owns the final audit/resume semantics;
/// clients send only the human decision intent.
public struct ApprovalDecisionRequest: Codable, Sendable, Hashable {
    public var approvalId: ApprovalID
    public var approve: Bool
    public var reason: String?
    public var clientDecisionId: UUID

    public init(
        approvalId: ApprovalID,
        approve: Bool,
        reason: String? = nil,
        clientDecisionId: UUID = UUID()
    ) {
        self.approvalId = approvalId
        self.approve = approve
        self.reason = reason
        self.clientDecisionId = clientDecisionId
    }

    public var status: ApprovalStatus {
        approve ? .approved : .rejected
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case approve
        case reason
        case clientDecisionId = "client_decision_id"
    }
}

/// Minimal acknowledgement returned after the backend records an approval
/// decision. Live transports may enrich this later with audit ids or resume job
/// ids without changing the client's decision intent.
public struct ApprovalDecisionReceipt: Codable, Sendable, Hashable {
    public var approvalId: ApprovalID
    public var status: ApprovalStatus
    public var decidedBy: MemberID?
    public var decidedAtMs: Int64?
    public var decisionReason: String?

    public init(
        approvalId: ApprovalID,
        status: ApprovalStatus,
        decidedBy: MemberID? = nil,
        decidedAtMs: Int64? = nil,
        decisionReason: String? = nil
    ) {
        self.approvalId = approvalId
        self.status = status
        self.decidedBy = decidedBy
        self.decidedAtMs = decidedAtMs
        self.decisionReason = decisionReason
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case status
        case decidedBy = "decided_by"
        case decidedAtMs = "decided_at_ms"
        case decisionReason = "decision_reason"
    }
}

/// Server-owned approval inbox projection. Clients use this read model for the
/// initial C inbox load, then reconcile by `approval_id` from receipts and
/// `approval.decided` realtime events.
public struct ApprovalPage: Codable, Sendable, Hashable {
    public var approvals: [Approval]

    public init(approvals: [Approval]) {
        self.approvals = approvals
    }
}

public extension Approval {
    var eventProjection: ApprovalEvent {
        ApprovalEvent(
            action: status == .pending ? .requested : .decided,
            approvalId: id,
            runId: runId,
            channelId: channelId,
            requestedBy: requestedBy,
            onBehalfOf: onBehalfOf,
            actionType: actionType,
            status: status,
            payload: payload,
            estimatedMicroUSD: estimatedMicroUSD,
            isReversible: isReversible,
            decidedBy: decidedBy,
            decisionReason: decisionReason
        )
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

/// Server-owned limit state for "cost breathing" (demo B, L4 §8.5).
public enum CostLimitState: String, Codable, Sendable, Hashable, CaseIterable {
    case normal
    case softLimit = "soft_limit"
    case hardLimit = "hard_limit"
}

/// A server-owned two-phase cost snapshot for "cost breathing" (demo B, L4 §8.5).
/// Integer micro_usd accumulation avoids float drift.
public struct CostSnapshot: Codable, Sendable, Hashable {
    public var runId: RunID
    /// Pre-call reservation (estimate upper bound).
    public var reservedMicroUSD: Int64
    /// Reconciled actual spend.
    public var spentMicroUSD: Int64
    /// Soft-limit warning threshold for the matched budget grain.
    public var softLimitMicroUSD: Int64?
    /// Hard-limit threshold for the matched budget grain.
    public var hardLimitMicroUSD: Int64?
    /// True once the worker has written usage_ledger for this run.
    public var isReconciled: Bool
    /// True if usage was estimated (SSE usage chunk missing).
    public var wasEstimated: Bool
    /// Server-projected state after applying reserved + spent against limits.
    public var limitState: CostLimitState

    public init(
        runId: RunID,
        reservedMicroUSD: Int64,
        spentMicroUSD: Int64,
        softLimitMicroUSD: Int64? = nil,
        hardLimitMicroUSD: Int64? = nil,
        isReconciled: Bool = false,
        wasEstimated: Bool = false,
        limitState: CostLimitState = .normal
    ) {
        self.runId = runId
        self.reservedMicroUSD = reservedMicroUSD
        self.spentMicroUSD = spentMicroUSD
        self.softLimitMicroUSD = softLimitMicroUSD
        self.hardLimitMicroUSD = hardLimitMicroUSD
        self.isReconciled = isReconciled
        self.wasEstimated = wasEstimated
        self.limitState = limitState
    }

    /// Convenience: micro_usd → USD (display only; never use for accounting math).
    public var spentUSD: Double { Double(spentMicroUSD) / 1_000_000.0 }
    public var reservedUSD: Double { Double(reservedMicroUSD) / 1_000_000.0 }

    private enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case reservedMicroUSD = "reserved_micro_usd"
        case spentMicroUSD = "spent_micro_usd"
        case softLimitMicroUSD = "soft_limit_micro_usd"
        case hardLimitMicroUSD = "hard_limit_micro_usd"
        case isReconciled = "is_reconciled"
        case wasEstimated = "was_estimated"
        case limitState = "limit_state"
    }
}

/// REST response for a channel's client-visible cost projection.
public struct CostSnapshotPage: Codable, Sendable, Hashable {
    public var schema: String
    public var channelId: ChannelID
    public var snapshots: [CostSnapshot]
    public var asOfMs: Int64

    public init(
        schema: String = "momo.cost_snapshot.channel.v0",
        channelId: ChannelID,
        snapshots: [CostSnapshot],
        asOfMs: Int64
    ) {
        self.schema = schema
        self.channelId = channelId
        self.snapshots = snapshots
        self.asOfMs = asOfMs
    }

    private enum CodingKeys: String, CodingKey {
        case schema
        case channelId = "channel_id"
        case snapshots
        case asOfMs = "as_of_ms"
    }
}
