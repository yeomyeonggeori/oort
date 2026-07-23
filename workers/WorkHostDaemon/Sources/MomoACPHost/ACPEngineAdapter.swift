import Foundation

// =============================================================================
// ACPEngineAdapter — the goose (ACP) path of WorkEngineAdapter (MOMO-579 / WH-1).
//
// A thin conformance wrapper over the existing MOMO-487/531 `ACPClient`. It adds
// no protocol behavior of its own: it bridges the unified approval contract onto
// ACP `session/request_permission` and forwards ACPClient's projected events
// unchanged, so the ACP path has zero regression while joining the engine-
// agnostic surface.
// =============================================================================
public final class ACPEngineAdapter: WorkEngineAdapter {
    public let engine: WorkEngine
    private let client: ACPClient

    public init(
        engine: WorkEngine = .goose,
        command: ACPLaunchCommand,
        context: ACPHostContext,
        eventSink: any ACPEventSink,
        approvalHandler: any WorkApprovalHandler = WorkFailClosedApprovalHandler(),
        terminalHandler: any ACPTerminalHandler,
        nowMs: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) {
        self.engine = engine
        self.client = ACPClient(
            command: command,
            context: context,
            eventSink: eventSink,
            permissionHandler: ACPApprovalBridge(engine: engine, handler: approvalHandler),
            terminalHandler: terminalHandler,
            nowMs: nowMs
        )
    }

    public func createSession(title: String?) async throws -> String {
        try await client.startSession()
    }

    @discardableResult
    public func prompt(sessionID: String, text: String) async throws -> WorkTurnResult {
        let result = try await client.prompt(text)
        return WorkTurnResult(sessionID: result.acpSessionID, stopReason: result.stopReason)
    }

    public func shutdown() async {
        await client.terminate()
    }
}

/// Translates one ACP permission request into the unified `WorkApprovalRequest`
/// and the host's `WorkApprovalDecision` back into an `ACPPermissionDecision`.
/// A decision that does not name a valid option collapses to `.cancelled`, which
/// ACPClient additionally re-validates against the offered options (fail closed).
struct ACPApprovalBridge: ACPPermissionHandler {
    let engine: WorkEngine
    let handler: any WorkApprovalHandler

    func decide(_ request: ACPPermissionRequest) async -> ACPPermissionDecision {
        let options = request.options.map {
            WorkApprovalOption(
                optionID: $0.optionID,
                name: $0.name,
                kind: WorkApprovalKind(acpKind: $0.kind)
            )
        }
        let toolCall = request.toolCall.objectValue
        let unified = WorkApprovalRequest(
            engine: engine,
            sessionID: request.acpSessionID,
            requestID: toolCall?["toolCallId"]?.stringValue ?? request.acpSessionID,
            toolName: toolCall?["kind"]?.stringValue,
            title: toolCall?["title"]?.stringValue,
            detail: nil,
            options: options,
            raw: request.toolCall
        )
        switch await handler.decide(unified) {
        case .allow(let optionID):
            return .selected(optionID: optionID)
        case .deny(let optionID):
            if let optionID { return .selected(optionID: optionID) }
            return .cancelled
        case .cancelled:
            return .cancelled
        }
    }
}
