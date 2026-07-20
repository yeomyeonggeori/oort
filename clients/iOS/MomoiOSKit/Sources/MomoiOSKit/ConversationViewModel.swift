import Foundation
import MomoCore
import Observation

public protocol IOSConversationBackend: Sendable {
    func snapshot() async throws -> IOSConversationSnapshot
    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message]
    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState
    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool
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
    private enum ReadProjectionRelation {
        case currentOrNewer
        case stale
        case crossed
    }

    private struct ReadProjectionWatermark {
        let lastReadSequence: Int64
        let latestSequence: Int64
    }

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
    public private(set) var channelMutationIDs: Set<ChannelID> = []
    public private(set) var actionFailureMessage: String?

    public var allItems: [IOSChannelListItem] {
        sections.channels + sections.directMessages
    }

    public var totalMentionCount: Int {
        sections.channels.reduce(0) { $0 + $1.mentionCount }
            + sections.directMessages.reduce(0) { $0 + $1.mentionCount }
    }

    private let currentMemberID: MemberID
    private let backend: any IOSConversationBackend
    private var projectionRevision: UInt64 = 0
    private var muteRevisionByChannel: [ChannelID: UInt64] = [:]
    private var readRevisionByChannel: [ChannelID: UInt64] = [:]
    private var activeMuteChannelIDs: Set<ChannelID> = []
    private var activeReadChannelIDs: Set<ChannelID> = []
    private var deferredReadStatesByChannel: [ChannelID: ChannelReadState] = [:]
    private var readProjectionWatermarksByChannel: [ChannelID: ReadProjectionWatermark] = [:]

    public init(currentMemberID: MemberID, backend: any IOSConversationBackend) {
        self.currentMemberID = currentMemberID
        self.backend = backend
    }

    public func load() async {
        phase = .loading
        await refresh()
    }

    public func refresh() async {
        await refresh(allowsReadReconciliation: true)
    }

    private func refresh(allowsReadReconciliation: Bool) async {
        let refreshRevision = projectionRevision
        do {
            let snapshot = try await backend.snapshot()
            let acceptedReadStates = snapshot.readStates.filter {
                readProjectionRelation(to: $0) == .currentOrNewer
            }
            let crossedReadChannelIDs = Set(
                snapshot.readStates
                    .filter { readProjectionRelation(to: $0) == .crossed }
                    .map(\.channelId)
            )
            let staleReadChannelIDs = Set(
                snapshot.readStates
                    .filter { readProjectionRelation(to: $0) != .currentOrNewer }
                    .map(\.channelId)
            )
            for state in acceptedReadStates {
                advanceReadProjectionWatermark(with: state)
            }
            for state in acceptedReadStates where activeReadChannelIDs.contains(state.channelId) {
                let deferred = deferredReadStatesByChannel[state.channelId]
                let shouldStore = if let deferred {
                    state.latestSeq > deferred.latestSeq
                        || (state.latestSeq == deferred.latestSeq && state.lastReadSeq >= deferred.lastReadSeq)
                } else {
                    true
                }
                if shouldStore {
                    deferredReadStatesByChannel[state.channelId] = state
                }
            }
            let refreshedSections = IOSChannelListMapper.sections(
                channels: snapshot.channels,
                members: snapshot.members,
                readStates: snapshot.readStates,
                channelMuteStates: snapshot.channelMuteStates,
                memberPresenceStates: snapshot.memberPresenceStates,
                currentMemberID: currentMemberID
            )
            sections = mergingLocalProjectionChanges(
                into: refreshedSections,
                since: refreshRevision,
                preservingRead: staleReadChannelIDs,
                applyingRefreshedRead: Set(acceptedReadStates.map(\.channelId))
            )
            membersByID = Dictionary(uniqueKeysWithValues: snapshot.members.map { ($0.id, $0) })
            phase = .loaded
            if allowsReadReconciliation, !crossedReadChannelIDs.isEmpty {
                await refresh(allowsReadReconciliation: false)
            }
        } catch is CancellationError {
            return
        } catch {
            phase = .failed(Self.failure(for: error))
        }
    }

    public func setChannelMuted(_ channelID: ChannelID, muted: Bool) async {
        guard let previous = item(channelID),
              !channelMutationIDs.contains(channelID)
        else { return }

        beginMuteMutation(channelID)
        actionFailureMessage = nil
        var optimistic = previous
        optimistic.isMuted = muted
        replace(optimistic)
        defer { finishMuteMutation(channelID) }

        do {
            let authoritative = try await backend.setChannelMuted(channelID, muted: muted)
            guard authoritative == muted else {
                throw SessionError.decoding("The server returned a different channel notification setting.")
            }
            if var updated = item(channelID) {
                updated.isMuted = authoritative
                replace(updated)
            }
        } catch is CancellationError {
            restoreMuteState(from: previous)
        } catch {
            restoreMuteState(from: previous)
            actionFailureMessage = "The channel notification setting was not changed. Try again."
        }
    }

    public func markRead(_ channelID: ChannelID) async {
        guard let previous = item(channelID),
              previous.hasUnread,
              previous.latestSequence > 0,
              !channelMutationIDs.contains(channelID)
        else { return }

        beginReadMutation(channelID)
        actionFailureMessage = nil
        var optimistic = previous
        optimistic.unreadCount = 0
        optimistic.mentionCount = 0
        replace(optimistic)

        do {
            let authoritative = try await backend.markRead(
                channel: channelID,
                through: previous.latestSequence
            )
            applyReadState(authoritative)
        } catch is CancellationError {
            restoreReadState(from: previous, deferred: deferredReadStatesByChannel[channelID])
        } catch {
            restoreReadState(from: previous, deferred: deferredReadStatesByChannel[channelID])
            actionFailureMessage = "The conversation was not marked as read. Try again."
        }

        let needsReconciliation = finishReadMutation(channelID)
        if needsReconciliation {
            await refresh()
        }
    }

    public func clearActionFailure() {
        actionFailureMessage = nil
    }

    public func applyReadState(_ state: ChannelReadState) {
        guard acceptsReadProjection(state),
              var updated = item(state.channelId)
        else { return }
        advanceReadProjectionWatermark(with: state)
        updated.unreadCount = state.unreadCount
        updated.mentionCount = state.mentionCount
        updated.latestSequence = state.latestSeq
        replace(updated)
        recordReadProjectionChange(state.channelId)
    }

    public func isMutating(_ channelID: ChannelID) -> Bool {
        channelMutationIDs.contains(channelID)
    }

    private func item(_ channelID: ChannelID) -> IOSChannelListItem? {
        allItems.first(where: { $0.id == channelID })
    }

    private func replace(_ item: IOSChannelListItem) {
        if let index = sections.channels.firstIndex(where: { $0.id == item.id }) {
            sections.channels[index] = item
        }
        if let index = sections.directMessages.firstIndex(where: { $0.id == item.id }) {
            sections.directMessages[index] = item
        }
    }

    private func mergingLocalProjectionChanges(
        into refreshed: IOSChannelSections,
        since refreshRevision: UInt64,
        preservingRead forcedReadChannelIDs: Set<ChannelID> = [],
        applyingRefreshedRead refreshedReadChannelIDs: Set<ChannelID> = []
    ) -> IOSChannelSections {
        var result = refreshed
        for channelID in allItems.map(\.id) {
            guard let current = item(channelID) else { continue }
            let preservesMute = activeMuteChannelIDs.contains(channelID)
                || (muteRevisionByChannel[channelID] ?? 0) > refreshRevision
            let preservesRead = forcedReadChannelIDs.contains(channelID)
                || activeReadChannelIDs.contains(channelID)
                || (
                    !refreshedReadChannelIDs.contains(channelID)
                        && (readRevisionByChannel[channelID] ?? 0) > refreshRevision
                )
            guard preservesMute || preservesRead else { continue }

            if let index = result.channels.firstIndex(where: { $0.id == channelID }) {
                result.channels[index] = merging(
                    current,
                    into: result.channels[index],
                    preservesMute: preservesMute,
                    preservesRead: preservesRead
                )
            }
            if let index = result.directMessages.firstIndex(where: { $0.id == channelID }) {
                result.directMessages[index] = merging(
                    current,
                    into: result.directMessages[index],
                    preservesMute: preservesMute,
                    preservesRead: preservesRead
                )
            }
        }
        return result
    }

    private func merging(
        _ current: IOSChannelListItem,
        into refreshed: IOSChannelListItem,
        preservesMute: Bool,
        preservesRead: Bool
    ) -> IOSChannelListItem {
        var merged = refreshed
        if preservesMute {
            merged.isMuted = current.isMuted
        }
        if preservesRead {
            merged.unreadCount = current.unreadCount
            merged.mentionCount = current.mentionCount
            merged.latestSequence = current.latestSequence
        }
        return merged
    }

    private func beginMuteMutation(_ channelID: ChannelID) {
        channelMutationIDs.insert(channelID)
        activeMuteChannelIDs.insert(channelID)
        recordMuteProjectionChange(channelID)
    }

    private func finishMuteMutation(_ channelID: ChannelID) {
        activeMuteChannelIDs.remove(channelID)
        channelMutationIDs.remove(channelID)
        recordMuteProjectionChange(channelID)
    }

    private func beginReadMutation(_ channelID: ChannelID) {
        channelMutationIDs.insert(channelID)
        activeReadChannelIDs.insert(channelID)
        recordReadProjectionChange(channelID)
    }

    private func finishReadMutation(_ channelID: ChannelID) -> Bool {
        activeReadChannelIDs.remove(channelID)
        channelMutationIDs.remove(channelID)
        recordReadProjectionChange(channelID)
        return deferredReadStatesByChannel.removeValue(forKey: channelID) != nil
    }

    private func recordMuteProjectionChange(_ channelID: ChannelID) {
        projectionRevision &+= 1
        muteRevisionByChannel[channelID] = projectionRevision
    }

    private func recordReadProjectionChange(_ channelID: ChannelID) {
        projectionRevision &+= 1
        readRevisionByChannel[channelID] = projectionRevision
    }

    private func acceptsReadProjection(_ state: ChannelReadState) -> Bool {
        readProjectionRelation(to: state) == .currentOrNewer
    }

    private func readProjectionRelation(to state: ChannelReadState) -> ReadProjectionRelation {
        guard let watermark = readProjectionWatermarksByChannel[state.channelId] else {
            return .currentOrNewer
        }
        let readIsCurrentOrNewer = state.lastReadSeq >= watermark.lastReadSequence
        let latestIsCurrentOrNewer = state.latestSeq >= watermark.latestSequence
        if readIsCurrentOrNewer, latestIsCurrentOrNewer {
            return .currentOrNewer
        }
        if state.lastReadSeq <= watermark.lastReadSequence,
           state.latestSeq <= watermark.latestSequence
        {
            return .stale
        }
        return .crossed
    }

    private func advanceReadProjectionWatermark(with state: ChannelReadState) {
        guard acceptsReadProjection(state) else { return }
        readProjectionWatermarksByChannel[state.channelId] = ReadProjectionWatermark(
            lastReadSequence: state.lastReadSeq,
            latestSequence: state.latestSeq
        )
    }

    private func restoreMuteState(from previous: IOSChannelListItem) {
        guard var current = item(previous.id) else { return }
        current.isMuted = previous.isMuted
        replace(current)
    }

    private func restoreReadState(
        from previous: IOSChannelListItem,
        deferred: ChannelReadState? = nil
    ) {
        if let deferred {
            applyReadState(deferred)
            return
        }
        guard var current = item(previous.id) else { return }
        current.unreadCount = previous.unreadCount
        current.mentionCount = previous.mentionCount
        current.latestSequence = previous.latestSequence
        replace(current)
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
    public private(set) var messages: [Message] = [] {
        didSet {
            presentationRows = IOSTimelineLayout.rows(
                for: messages,
                currentMemberID: currentMemberID
            )
        }
    }
    private(set) var presentationRows: [IOSTimelineDisplayRow] = []
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
    private let onReadState: ((ChannelReadState) -> Void)?
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
        microphonePermission: (any IOSMicrophonePermissionAuthorizing)? = nil,
        onReadState: ((ChannelReadState) -> Void)? = nil
    ) {
        self.channel = channel
        self.currentMemberID = currentMemberID
        self.backend = backend
        self.onReadState = onReadState
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
                if let state = try? await backend.markRead(channel: channel, through: sequence) {
                    onReadState?(state)
                }
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
                if let state = try? await backend.markRead(channel: channel, through: sequence) {
                    onReadState?(state)
                }
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
