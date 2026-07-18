import Foundation
import MomoCore
import Observation

public protocol IOSConversationBackend: Sendable {
    func snapshot() async throws -> IOSConversationSnapshot
    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message]
    func markRead(channel: ChannelID, through sequence: Int64) async throws
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent>
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus>
    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt
}

struct IOSPendingMessageSend: Sendable, Equatable {
    let draft: DraftMessage
    let clientMsgId: UUID
}

struct IOSPendingApprovalDecision: Sendable, Equatable {
    let request: ApprovalDecisionRequest
}

@MainActor
@Observable
public final class IOSChannelListModel {
    public struct Failure: Equatable {
        public let message: String
        public let isOffline: Bool
    }

    public enum Phase: Equatable {
        case loading
        case loaded
        case failed(Failure)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var sections = IOSChannelSections(channels: [], directMessages: [])
    public private(set) var membersByID: [MemberID: Member] = [:]

    private let currentMemberID: MemberID
    private let backend: any IOSConversationBackend

    public init(currentMemberID: MemberID, backend: any IOSConversationBackend) {
        self.currentMemberID = currentMemberID
        self.backend = backend
    }

    public func load() async {
        phase = .loading
        await refresh()
    }

    public func refresh() async {
        do {
            let snapshot = try await backend.snapshot()
            sections = IOSChannelListMapper.sections(
                channels: snapshot.channels,
                members: snapshot.members,
                readStates: snapshot.readStates,
                currentMemberID: currentMemberID
            )
            membersByID = Dictionary(uniqueKeysWithValues: snapshot.members.map { ($0.id, $0) })
            phase = .loaded
        } catch is CancellationError {
            return
        } catch {
            phase = .failed(Self.failure(for: error))
        }
    }

    private static func failure(for error: Error) -> Failure {
        if let sessionError = error as? SessionError,
           case .transport = sessionError {
            return Failure(
                message: "Could not refresh channels while offline. Check your connection and try again.",
                isOffline: true
            )
        }
        return Failure(message: "Could not refresh channels. Try again.", isOffline: false)
    }
}

@MainActor
@Observable
public final class IOSTimelineModel {
    public struct Failure: Equatable {
        public let message: String
        public let isOffline: Bool
    }

    public enum Phase: Equatable {
        case loading
        case loaded
        case failed(Failure)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var messages: [Message] = []
    public private(set) var realtimeStatus: RealtimeConnectionStatus
    public var composerDraft = ""
    public private(set) var replyTarget: Message?
    public private(set) var isSending = false
    public private(set) var sendFailureMessage: String?
    public private(set) var approvalDecisionsInFlight: Set<ApprovalID> = []
    public private(set) var approvalDecisionFailures: Set<ApprovalID> = []
    public let huddle: IOSHuddleModel

    private let channel: ChannelID
    private let currentMemberID: MemberID
    private let backend: any IOSConversationBackend
    private var eventTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var failedSend: IOSPendingMessageSend?
    private var pendingApprovalDecisions: [ApprovalID: IOSPendingApprovalDecision] = [:]

    public init(
        channel: ChannelID,
        currentMemberID: MemberID,
        backend: any IOSConversationBackend,
        workspace: WorkspaceID? = nil,
        huddleService: (any IOSHuddleService)? = nil,
        huddleAudioSession: (any IOSHuddleAudioSession)? = nil,
        microphonePermission: (any IOSMicrophonePermissionAuthorizing)? = nil
    ) {
        self.channel = channel
        self.currentMemberID = currentMemberID
        self.backend = backend
        self.realtimeStatus = .idle(channel: channel)
        let huddleWorkspace = workspace ?? WorkspaceID()
        let resolvedAudioSession: any IOSHuddleAudioSession
        let resolvedPermission: any IOSMicrophonePermissionAuthorizing
        if let huddleAudioSession {
            resolvedAudioSession = huddleAudioSession
        } else if huddleService != nil {
            resolvedAudioSession = IOSHuddleLiveKitSession()
        } else {
            resolvedAudioSession = IOSUnavailableHuddleAudioSession()
        }
        if let microphonePermission {
            resolvedPermission = microphonePermission
        } else if huddleService != nil {
            resolvedPermission = IOSSystemMicrophonePermissionAuthorizer()
        } else {
            resolvedPermission = IOSUnavailableMicrophonePermissionAuthorizer()
        }
        self.huddle = IOSHuddleModel(
            workspace: huddleWorkspace,
            channel: channel,
            service: workspace == nil ? nil : huddleService,
            audioSession: resolvedAudioSession,
            permissionAuthorizer: resolvedPermission
        )
    }

    public func stop() {
        eventTask?.cancel()
        statusTask?.cancel()
        eventTask = nil
        statusTask = nil
    }

    public func load() async {
        guard !isSending else { return }
        phase = .loading
        do {
            let history = try await backend.history(channel: channel, after: nil, limit: 200)
            messages = IOSTimelineReducer.sorted(history)
            phase = .loaded
            if let sequence = messages.compactMap(\.seq).max() {
                try? await backend.markRead(channel: channel, through: sequence)
            }
            subscribe()
            await huddle.activate()
        } catch is CancellationError {
            return
        } catch {
            let isOffline = (error as? SessionError).map {
                if case .transport = $0 { return true }
                return false
            } ?? false
            phase = .failed(Failure(
                message: isOffline
                    ? "Message history is unavailable while offline. Check your connection and try again."
                    : "Could not load message history. Try again.",
                isOffline: isOffline
            ))
        }
    }

    public func retry() async {
        eventTask?.cancel()
        statusTask?.cancel()
        await load()
    }

    public func resume() async {
        guard phase == .loaded else { return }
        subscribe()
        await huddle.activate()
    }

    public func shutdown() async {
        stop()
        await huddle.shutdown()
    }

    func consumeRealtimeEvent(_ event: RealtimeEvent) async {
        if case .huddle(let delta) = event {
            await huddle.apply(delta)
        }
        messages = IOSTimelineReducer.applying(event, to: messages, channel: channel)
    }

    public func selectReply(to message: Message) {
        guard message.channelId == channel, !message.isDeleted else { return }
        replyTarget = message
    }

    public func cancelReply() {
        replyTarget = nil
    }

    /// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
    /// Adds a local echo and reconciles it through the IOS-2 clientMsgId guard.
    public func sendComposerDraft() async {
        let body = composerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard phase == .loaded, !body.isEmpty, !isSending, failedSend == nil else { return }
        let replyToID = replyTarget?.id
        var props: [String: JSON] = [:]
        if let replyToID {
            props["reply_to_id"] = .string(replyToID.description)
        }
        let pending = IOSPendingMessageSend(
            draft: DraftMessage(
                channelId: channel,
                type: .text,
                body: body,
                props: .object(props),
                replyToId: replyToID
            ),
            clientMsgId: UUID()
        )
        composerDraft = ""
        replyTarget = nil
        messages = IOSTimelineReducer.applying(
            .message(optimisticMessage(for: pending)),
            to: messages,
            channel: channel
        )
        await performSend(pending)
    }

    public func retryFailedSend() async {
        guard let failedSend, !isSending else { return }
        updateOptimisticMessage(clientMsgId: failedSend.clientMsgId, state: .sent)
        await performSend(failedSend)
    }

    public func approvalStatus(for message: Message) -> ApprovalStatus {
        guard let raw = message.props["approval_status"]?.stringValue else { return .pending }
        return ApprovalStatus(rawValue: raw) ?? .pending
    }

    public func decideApproval(_ message: Message, approve: Bool) async {
        guard let approvalID = Self.approvalID(for: message),
              !approvalDecisionsInFlight.contains(approvalID) else { return }
        let pending = IOSPendingApprovalDecision(request: ApprovalDecisionRequest(
            approvalId: approvalID,
            approve: approve,
            clientDecisionId: UUID()
        ))
        pendingApprovalDecisions[approvalID] = pending
        await performApprovalDecision(pending)
    }

    public func retryApprovalDecision(for message: Message) async {
        guard let approvalID = Self.approvalID(for: message),
              let pending = pendingApprovalDecisions[approvalID],
              !approvalDecisionsInFlight.contains(approvalID) else { return }
        await performApprovalDecision(pending)
    }

    public static func approvalID(for message: Message) -> ApprovalID? {
        guard message.type == .approvalRequest,
              let raw = message.props["approval_id"]?.stringValue else { return nil }
        return ApprovalID(raw)
    }

    private func performSend(_ pending: IOSPendingMessageSend) async {
        isSending = true
        sendFailureMessage = nil
        defer { isSending = false }
        do {
            var acknowledged = try await backend.send(pending.draft, clientMsgId: pending.clientMsgId)
            acknowledged.clientMsgId = pending.clientMsgId
            acknowledged.replyToId = pending.draft.replyToId
            messages = IOSTimelineReducer.applying(.message(acknowledged), to: messages, channel: channel)
            failedSend = nil
            if let sequence = acknowledged.seq {
                try? await backend.markRead(channel: channel, through: sequence)
            }
        } catch is CancellationError {
            return
        } catch {
            failedSend = pending
            updateOptimisticMessage(clientMsgId: pending.clientMsgId, state: .failed)
            sendFailureMessage = "Message not sent. Retry sending it."
        }
    }

    private func performApprovalDecision(_ pending: IOSPendingApprovalDecision) async {
        let approvalID = pending.request.approvalId
        approvalDecisionFailures.remove(approvalID)
        approvalDecisionsInFlight.insert(approvalID)
        defer { approvalDecisionsInFlight.remove(approvalID) }
        do {
            let receipt = try await backend.decideApproval(pending.request)
            applyApprovalStatus(receipt.status, approvalID: approvalID)
            pendingApprovalDecisions.removeValue(forKey: approvalID)
        } catch is CancellationError {
            return
        } catch {
            approvalDecisionFailures.insert(approvalID)
        }
    }

    private func optimisticMessage(for pending: IOSPendingMessageSend) -> Message {
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        return Message(
            id: MessageID(),
            channelId: channel,
            seq: nil,
            hlcTs: now,
            authorMemberId: currentMemberID,
            type: .text,
            body: pending.draft.body,
            props: pending.draft.props,
            replyToId: pending.draft.replyToId,
            clientMsgId: pending.clientMsgId,
            createdAtMs: now
        )
    }

    private func updateOptimisticMessage(clientMsgId: UUID, state: MessageState) {
        guard let index = messages.firstIndex(where: { $0.clientMsgId == clientMsgId }) else { return }
        messages[index].state = state
    }

    private func applyApprovalStatus(_ status: ApprovalStatus, approvalID: ApprovalID) {
        for index in messages.indices where Self.approvalID(for: messages[index]) == approvalID {
            var props = messages[index].props.objectValue ?? [:]
            props["approval_status"] = .string(status.rawValue)
            messages[index].props = .object(props)
        }
    }

    private func subscribe() {
        eventTask?.cancel()
        statusTask?.cancel()
        let backend = backend
        let channel = channel
        statusTask = Task { [weak self] in
            let statuses = await backend.realtimeStatus(channel: channel)
            for await status in statuses {
                guard !Task.isCancelled else { return }
                self?.realtimeStatus = status
            }
        }
        eventTask = Task { [weak self] in
            do {
                let events = try await backend.subscribe(channel: channel)
                for await event in events {
                    guard !Task.isCancelled, let self else { return }
                    await consumeRealtimeEvent(event)
                }
            } catch is CancellationError {
                return
            } catch {
                self?.realtimeStatus = .restFallback(
                    channel: channel,
                    message: "Realtime updates are unavailable. Pull to reload message history."
                )
            }
        }
    }
}
