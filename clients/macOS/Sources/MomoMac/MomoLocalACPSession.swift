import Foundation
import MomoACPHost
import SwiftUI

private actor MomoLocalACPEventSink: ACPEventSink {
    private let receiver: @Sendable (ACPProjectedEvent) async -> Void

    init(receiver: @escaping @Sendable (ACPProjectedEvent) async -> Void) {
        self.receiver = receiver
    }

    func emit(_ event: ACPProjectedEvent) async {
        await receiver(event)
    }
}

private actor MomoLocalACPApprovalBroker: ACPPermissionHandler {
    private var pending: CheckedContinuation<ACPPermissionDecision, Never>?

    func decide(_ request: ACPPermissionRequest) async -> ACPPermissionDecision {
        guard pending == nil else { return .cancelled }
        return await withCheckedContinuation { continuation in
            pending = continuation
        }
    }

    func resolve(_ decision: ACPPermissionDecision) {
        pending?.resume(returning: decision)
        pending = nil
    }

    func cancel() {
        resolve(.cancelled)
    }
}

/// App-hosted counterpart to workd's ACP session. It deliberately accepts the
/// existing approval and PTY owners as injected handlers: ACP bytes and raw
/// terminal output stay on this Mac, while only projected card events reach the
/// app's session thread state.
@MainActor
final class MomoLocalACPSession: ObservableObject {
    @Published private(set) var events: [ACPProjectedEvent] = []
    @Published private(set) var isRunning = false
    @Published private(set) var stopReason: String?
    @Published private(set) var errorLabel: String?

    private var client: ACPClient?
    private var task: Task<Void, Never>?
    private let approvalBroker = MomoLocalACPApprovalBroker()

    func start(
        command: ACPLaunchCommand,
        context: ACPHostContext,
        prompt: String,
        permissionHandler: (any ACPPermissionHandler)? = nil,
        terminalHandler: any ACPTerminalHandler
    ) {
        guard !isRunning else { return }
        events = []
        stopReason = nil
        errorLabel = nil
        let sink = MomoLocalACPEventSink { [weak self] event in
            await MainActor.run { self?.events.append(event) }
        }
        let client = ACPClient(
            command: command,
            context: context,
            eventSink: sink,
            permissionHandler: permissionHandler ?? approvalBroker,
            terminalHandler: terminalHandler
        )
        self.client = client
        isRunning = true
        task = Task { [weak self] in
            do {
                let result = try await client.prompt(prompt)
                guard let self else { return }
                self.stopReason = result.stopReason
                self.isRunning = false
            } catch {
                guard let self else { return }
                self.errorLabel = "acp_session_failed"
                self.isRunning = false
            }
        }
    }

    func sendPrompt(_ prompt: String) {
        guard isRunning, let client else { return }
        task = Task { [weak self] in
            do {
                let result = try await client.prompt(prompt)
                guard let self else { return }
                self.stopReason = result.stopReason
            } catch {
                self?.errorLabel = "acp_session_failed"
            }
        }
    }

    func terminate() {
        task?.cancel()
        Task { await approvalBroker.cancel() }
        guard let client else {
            isRunning = false
            return
        }
        Task { await client.terminate() }
        isRunning = false
    }

    /// Called only after the existing immutable momo approval card records the
    /// human decision. Until this method is invoked the ACP request remains
    /// suspended inside `session/request_permission`.
    func resolvePermission(optionID: String?) {
        let decision = optionID.map(ACPPermissionDecision.selected(optionID:)) ?? .cancelled
        Task { await approvalBroker.resolve(decision) }
    }
}
