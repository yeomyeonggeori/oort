import Foundation

/// Worker-side approval checkpoint semantics for MOMO-161.
///
/// The DB remains the source of truth. This type only keeps the worker's branch
/// decisions testable without requiring a live Postgres/Centrifugo runtime.
struct ApprovalRuntime: Sendable {
    struct ToolCall: Equatable, Sendable {
        var callID: String
        var name: String
        var arguments: String
    }

    struct PausePlan: Equatable, Sendable {
        var runStatus: RunStatus
        var approvalStatus: String
        var messageType: String
        var auditAction: String
        var actionType: String
        var toolCall: ToolCall
    }

    enum Decision: String, Equatable, Sendable {
        case approved
        case rejected
        case expired
        case cancelled
    }

    enum DecisionOutcome: Equatable, Sendable {
        case resumeSameRun(nextStatus: RunStatus)
        case terminateRun(finalStatus: RunStatus, auditAction: String)
    }

    static func pausePlan(for toolCall: ToolCall) -> PausePlan {
        PausePlan(
            runStatus: .awaitingApproval,
            approvalStatus: "pending",
            messageType: "approval_request",
            auditAction: "approval.requested",
            actionType: "tool_call",
            toolCall: toolCall
        )
    }

    static func outcome(for decision: Decision) -> DecisionOutcome {
        switch decision {
        case .approved:
            return .resumeSameRun(nextStatus: .queued)
        case .rejected:
            return .terminateRun(finalStatus: .cancelled, auditAction: "approval.rejected")
        case .expired:
            return .terminateRun(finalStatus: .timedOut, auditAction: "approval.expired")
        case .cancelled:
            return .terminateRun(finalStatus: .cancelled, auditAction: "approval.cancelled")
        }
    }
}
