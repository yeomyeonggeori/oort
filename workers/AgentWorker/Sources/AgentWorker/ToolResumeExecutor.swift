import Foundation

/// Minimal approved-tool resume executor for MOMO-178.
///
/// v0 deliberately executes only deterministic in-process tools. External
/// providers stay out of scope until a capability-specific runtime lands.
struct ToolResumeExecutor: Sendable {
    struct ValidatedRequest: Sendable {
        let runID: UUID
        let approvalID: UUID
        let toolCall: ApprovedToolCallPayload
        let policyEvidence: ToolGrantMetadata
    }

    struct Result: Sendable {
        let output: JSONValue
        let body: String
        let isError: Bool
    }

    enum Failure: Error, Equatable, CustomStringConvertible, Sendable {
        case missingRunID
        case missingApprovalID
        case missingToolCall
        case emptyCallID
        case emptyToolName
        case missingPolicyEvidence
        case policyToolMismatch(expected: String, actual: String)
        case policyDoesNotRequireApproval(String?)
        case conflictingRiskAliases
        case missingFrozenPayloadToken
        case decisionNotApproved(String?)
        case decisionApprovalMismatch(expected: UUID, actual: String)
        case unsupportedTool(String)

        var description: String {
            switch self {
            case .missingRunID:
                return "resume_approval requires run_id"
            case .missingApprovalID:
                return "resume_approval requires resume_from_approval_id"
            case .missingToolCall:
                return "resume_approval requires approved_tool_call"
            case .emptyCallID:
                return "approved_tool_call.call_id is empty"
            case .emptyToolName:
                return "approved_tool_call.name is empty"
            case .missingPolicyEvidence:
                return "resume_approval requires policy_evidence"
            case .policyToolMismatch(let expected, let actual):
                return "policy_evidence.tool_name mismatch: expected \(expected), got \(actual)"
            case .policyDoesNotRequireApproval(let policy):
                return "policy_evidence.approval_policy is not approval-required: \(policy ?? "nil")"
            case .conflictingRiskAliases:
                return "policy_evidence risk aliases conflict"
            case .missingFrozenPayloadToken:
                return "approved_tool_call.payload_sha256 must be a non-empty sha256 token"
            case .decisionNotApproved(let status):
                return "approval_decision is not approved: \(status ?? "missing")"
            case .decisionApprovalMismatch(let expected, let actual):
                return "approval_decision.approval_id mismatch: expected \(expected.uuidString), got \(actual)"
            case .unsupportedTool(let name):
                return "unsupported deterministic resume tool: \(name)"
            }
        }
    }

    private let allowedToolNames: Set<String>

    init(allowedToolNames: Set<String> = [
        "mock.echo",
        "momo.mock.echo",
        "deterministic.echo",
    ]) {
        self.allowedToolNames = Set(allowedToolNames.map(ToolGrantMetadata.normalize))
    }

    func validate(_ payload: AgentJobPayload) throws -> ValidatedRequest {
        guard let runID = payload.runID else { throw Failure.missingRunID }
        guard let approvalID = payload.resumeFromApprovalID else { throw Failure.missingApprovalID }
        guard let toolCall = payload.approvedToolCall else { throw Failure.missingToolCall }

        let callID = toolCall.callID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !callID.isEmpty else { throw Failure.emptyCallID }

        let toolName = toolCall.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !toolName.isEmpty else { throw Failure.emptyToolName }

        guard let policyEvidence = payload.policyEvidence else {
            throw Failure.missingPolicyEvidence
        }
        guard !policyEvidence.riskAliasesConflict else {
            throw Failure.conflictingRiskAliases
        }
        if !policyEvidence.toolName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           policyEvidence.normalizedToolName != ToolGrantMetadata.normalize(toolName)
        {
            throw Failure.policyToolMismatch(
                expected: toolName,
                actual: policyEvidence.toolName
            )
        }
        guard Self.isApprovalRequiredPolicy(policyEvidence.normalizedApprovalPolicy) else {
            throw Failure.policyDoesNotRequireApproval(policyEvidence.approvalPolicy)
        }
        guard let payloadSHA256 = toolCall.payloadSHA256?.trimmingCharacters(in: .whitespacesAndNewlines),
              payloadSHA256.hasPrefix("sha256:"),
              payloadSHA256.count > "sha256:".count
        else {
            throw Failure.missingFrozenPayloadToken
        }

        try validateDecision(payload.approvalDecision, approvalID: approvalID)
        return ValidatedRequest(
            runID: runID,
            approvalID: approvalID,
            toolCall: toolCall,
            policyEvidence: policyEvidence
        )
    }

    func execute(_ request: ValidatedRequest) throws -> Result {
        let normalized = ToolGrantMetadata.normalize(request.toolCall.name)
        guard allowedToolNames.contains(normalized) else {
            throw Failure.unsupportedTool(request.toolCall.name)
        }

        return Result(
            output: .object([
                "ok": .bool(true),
                "tool_name": .string(request.toolCall.name),
                "call_id": .string(request.toolCall.callID),
                "arguments": request.toolCall.arguments,
            ]),
            body: "Deterministic tool executed: \(request.toolCall.name)",
            isError: false
        )
    }

    private func validateDecision(_ decision: JSONValue?, approvalID: UUID) throws {
        guard let decision else { return }
        let status = decision["status"]?.stringValue
            ?? decision["decision"]?.stringValue
        guard status == "approved" else {
            throw Failure.decisionNotApproved(status)
        }
        if let decisionApprovalID = decision["approval_id"]?.stringValue,
           decisionApprovalID.lowercased() != approvalID.uuidString.lowercased()
        {
            throw Failure.decisionApprovalMismatch(
                expected: approvalID,
                actual: decisionApprovalID
            )
        }
    }

    private static func isApprovalRequiredPolicy(_ policy: String?) -> Bool {
        switch policy {
        case "require_approval", "requires_approval", "approval_required", "always", "required":
            return true
        default:
            return false
        }
    }
}
