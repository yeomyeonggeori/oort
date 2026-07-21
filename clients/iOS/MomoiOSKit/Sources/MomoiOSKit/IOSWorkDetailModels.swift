import Foundation
import MomoCore
import Observation

public protocol IOSWorkPreferencesBackend: Sendable {
    func workAutoApprovalTools() async throws -> Set<IOSWorkSessionTool>
    func setWorkAutoApproval(tool: IOSWorkSessionTool, enabled: Bool) async throws -> Bool
}

@MainActor
@Observable
public final class IOSWorkAutoApprovalModel {
    public private(set) var enabledTools: Set<IOSWorkSessionTool> = []
    public private(set) var hasLoadedSnapshot = false
    public private(set) var isLoading = true
    public private(set) var mutationInFlight: IOSWorkSessionTool?
    public private(set) var inlineFailureMessage: String?

    private let backend: any IOSWorkPreferencesBackend

    public init(backend: any IOSWorkPreferencesBackend) {
        self.backend = backend
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            enabledTools = try await backend.workAutoApprovalTools()
            hasLoadedSnapshot = true
            inlineFailureMessage = nil
        } catch is CancellationError {
            return
        } catch {
            inlineFailureMessage = "Could not load the auto-approve setting. Try again."
        }
    }

    public func set(_ tool: IOSWorkSessionTool, enabled: Bool) async {
        guard mutationInFlight == nil else { return }
        mutationInFlight = tool
        inlineFailureMessage = nil
        defer { mutationInFlight = nil }
        do {
            let effective = try await backend.setWorkAutoApproval(tool: tool, enabled: enabled)
            guard effective == enabled else {
                throw SessionError.decoding("The server returned a different auto-approve setting.")
            }
            if effective { enabledTools.insert(tool) } else { enabledTools.remove(tool) }
        } catch is CancellationError {
            return
        } catch {
            inlineFailureMessage = "Auto-approve was not changed. Try again."
        }
    }
}

@MainActor
@Observable
public final class IOSWorkApprovalInboxModel {
    public private(set) var messages: [Message] = []
    public private(set) var isLoading = true
    public private(set) var inlineFailureMessage: String?
    public private(set) var decisionsInFlight: Set<ApprovalID> = []
    public private(set) var decisionFailures: Set<ApprovalID> = []

    private let backend: any IOSConversationBackend
    private var pendingDecisions: [ApprovalID: IOSPendingApprovalDecision] = [:]

    public init(backend: any IOSConversationBackend) {
        self.backend = backend
    }

    public func start(channelIDs: [ChannelID]) async {
        await refresh(channelIDs: channelIDs)
        let backend = backend
        await withTaskGroup(of: Void.self) { group in
            for channelID in Set(channelIDs) {
                group.addTask { [weak self] in
                    do {
                        let events = try await backend.subscribe(channel: channelID)
                        for await event in events {
                            guard !Task.isCancelled else { return }
                            await self?.consume(event)
                        }
                    } catch is CancellationError {
                        return
                    } catch {
                        await self?.recordRealtimeFailure()
                    }
                }
            }
            await group.waitForAll()
        }
    }

    public func refresh(channelIDs: [ChannelID]) async {
        isLoading = messages.isEmpty
        defer { isLoading = false }
        do {
            let backend = backend
            let pages = try await withThrowingTaskGroup(of: [Message].self) { group in
                for channelID in Set(channelIDs) {
                    group.addTask {
                        try await backend.history(channel: channelID, after: nil, limit: 200)
                    }
                }
                var result: [[Message]] = []
                for try await page in group { result.append(page) }
                return result
            }
            messages = pages.flatMap { $0 }
                .filter(Self.isPendingWorkApproval)
                .sorted { ($0.createdAtMs ?? 0) > ($1.createdAtMs ?? 0) }
            inlineFailureMessage = nil
        } catch is CancellationError {
            return
        } catch {
            inlineFailureMessage = "Could not refresh Work approvals. Existing items are still shown."
        }
    }

    public func status(for message: Message) -> ApprovalStatus {
        guard let raw = message.props["approval_status"]?.stringValue else { return .pending }
        return ApprovalStatus(rawValue: raw) ?? .pending
    }

    public func decide(_ message: Message, approve: Bool) async {
        guard let approvalID = IOSTimelineModel.approvalID(for: message),
              !decisionsInFlight.contains(approvalID) else { return }
        let pending = IOSPendingApprovalDecision(request: ApprovalDecisionRequest(
            approvalId: approvalID,
            approve: approve,
            clientDecisionId: UUID()
        ))
        pendingDecisions[approvalID] = pending
        await perform(pending)
    }

    public func retry(_ message: Message) async {
        guard let approvalID = IOSTimelineModel.approvalID(for: message),
              let pending = pendingDecisions[approvalID],
              !decisionsInFlight.contains(approvalID) else { return }
        await perform(pending)
    }

    private func perform(_ pending: IOSPendingApprovalDecision) async {
        let approvalID = pending.request.approvalId
        decisionFailures.remove(approvalID)
        decisionsInFlight.insert(approvalID)
        defer { decisionsInFlight.remove(approvalID) }
        do {
            let receipt = try await backend.decideApproval(pending.request)
            apply(status: receipt.status, approvalID: approvalID)
            pendingDecisions[approvalID] = nil
        } catch is CancellationError {
            return
        } catch {
            decisionFailures.insert(approvalID)
        }
    }

    private func consume(_ event: RealtimeEvent) {
        switch event {
        case .message(let message), .messageEdited(let message):
            guard message.type == .approvalRequest,
                  message.props["kind"]?.stringValue == "work_control_approval" else { return }
            if Self.isPendingWorkApproval(message) {
                if let index = messages.firstIndex(where: { $0.id == message.id }) {
                    messages[index] = message
                } else {
                    messages.insert(message, at: 0)
                }
            } else {
                messages.removeAll(where: { $0.id == message.id })
            }
        case .approval(let approval):
            apply(status: approval.status, approvalID: approval.approvalId)
        default:
            break
        }
    }

    private func apply(status: ApprovalStatus, approvalID: ApprovalID) {
        guard let index = messages.firstIndex(where: {
            IOSTimelineModel.approvalID(for: $0) == approvalID
        }) else { return }
        if status == .pending {
            var props = messages[index].props.objectValue ?? [:]
            props["approval_status"] = .string(status.rawValue)
            messages[index].props = .object(props)
        } else {
            messages.remove(at: index)
        }
    }

    private func recordRealtimeFailure() {
        guard !messages.isEmpty else { return }
        inlineFailureMessage = "Live Work approvals are unavailable. Pull to refresh."
    }

    private static func isPendingWorkApproval(_ message: Message) -> Bool {
        message.type == .approvalRequest
            && message.props["kind"]?.stringValue == "work_control_approval"
            && (message.props["approval_status"]?.stringValue ?? "pending") == ApprovalStatus.pending.rawValue
    }
}

extension MomoServerConversationClient: IOSWorkPreferencesBackend {
    public func workAutoApprovalTools() async throws -> Set<IOSWorkSessionTool> {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/work-auto-approvals"
        do {
            return Set(try decoder.decode(IOSWorkAutoApprovalsDTO.self, from: try await get(path)).tools)
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned invalid auto-approve settings.")
        }
    }

    public func setWorkAutoApproval(tool: IOSWorkSessionTool, enabled: Bool) async throws -> Bool {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/work-auto-approvals/\(tool.rawValue)"
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = enabled ? "PUT" : "DELETE"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        do {
            let response = try decoder.decode(
                IOSWorkAutoApprovalDTO.self,
                from: try await execute(request: request)
            )
            guard response.tool == tool, response.enabled == enabled else {
                throw SessionError.decoding("The server returned a different auto-approve setting.")
            }
            return response.enabled
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned an invalid auto-approve setting.")
        }
    }
}

private struct IOSWorkAutoApprovalsDTO: Decodable {
    let tools: [IOSWorkSessionTool]
}

private struct IOSWorkAutoApprovalDTO: Decodable {
    let tool: IOSWorkSessionTool
    let enabled: Bool
}
