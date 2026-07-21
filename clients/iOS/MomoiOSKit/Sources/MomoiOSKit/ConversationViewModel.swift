import Foundation
import MomoCore
import Observation

public protocol IOSConversationBackend: Sendable {
    func snapshot() async throws -> IOSConversationSnapshot
    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message]
    func historyBefore(channel: ChannelID, before sequence: Int64, limit: Int) async throws -> [Message]
    func searchMessages(
        query: String,
        cursor: String?,
        limit: Int
    ) async throws -> IOSWorkspaceMessageSearchPage
    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState
    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent>
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus>
    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message
    func uploadAttachment(fileURL: URL, to channel: ChannelID) async throws -> MessageAttachment
    func downloadAttachment(_ attachment: MessageAttachment, from channel: ChannelID) async throws -> URL
    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]]
    func addReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta
    func removeReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta
    func editMessage(_ id: MessageID, body: String) async throws -> Message
    func deleteMessage(_ id: MessageID) async throws -> Message
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt
    func threadReplies(
        channel: ChannelID,
        root: MessageID,
        cursor: Int64?,
        limit: Int
    ) async throws -> IOSThreadRepliesPage
}

public struct IOSThreadRepliesPage: Sendable, Hashable {
    public let messages: [Message]
    public let nextCursor: Int64?

    public init(messages: [Message], nextCursor: Int64?) {
        self.messages = messages
        self.nextCursor = nextCursor
    }
}

public extension IOSConversationBackend {
    func historyBefore(channel: ChannelID, before sequence: Int64, limit: Int) async throws -> [Message] {
        try await history(channel: channel, after: nil, limit: limit)
    }
    func searchMessages(
        query: String,
        cursor: String?,
        limit: Int
    ) async throws -> IOSWorkspaceMessageSearchPage {
        throw SessionError.server(status: 501, message: "Workspace message search is unavailable.")
    }
    func uploadAttachment(fileURL: URL, to channel: ChannelID) async throws -> MessageAttachment {
        throw IOSAttachmentTransferIssue.unavailable
    }
    func downloadAttachment(_ attachment: MessageAttachment, from channel: ChannelID) async throws -> URL {
        throw IOSAttachmentTransferIssue.unavailable
    }
    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] { [:] }
    func addReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta {
        throw SessionError.server(status: 501, message: "Message reactions are unavailable.")
    }
    func removeReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta {
        throw SessionError.server(status: 501, message: "Message reactions are unavailable.")
    }
    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        throw SessionError.server(status: 501, message: "Message editing is unavailable.")
    }
    func deleteMessage(_ id: MessageID) async throws -> Message {
        throw SessionError.server(status: 501, message: "Message deletion is unavailable.")
    }
    func threadReplies(
        channel: ChannelID,
        root: MessageID,
        cursor: Int64?,
        limit: Int
    ) async throws -> IOSThreadRepliesPage {
        let history = try await history(channel: channel, after: cursor, limit: limit)
        return IOSThreadRepliesPage(
            messages: history.filter { $0.rootId == root },
            nextCursor: history.count == limit ? history.compactMap(\.seq).max() : nil
        )
    }
}

struct IOSPendingMessageSend: Sendable, Equatable {
    let draft: DraftMessage
    let clientMsgId: UUID
    let attachments: [MessageAttachment]
}

struct IOSPendingApprovalDecision: Sendable, Equatable {
    let request: ApprovalDecisionRequest
}

public struct IOSAgentPartialProjection: Identifiable, Sendable, Hashable {
    public let id: RunID
    public var text: String
    public var toolCallName: String?
    public var spentMicroUSD: Int64?

    public init(id: RunID, text: String = "", toolCallName: String? = nil, spentMicroUSD: Int64? = nil) {
        self.id = id
        self.text = text
        self.toolCallName = toolCallName
        self.spentMicroUSD = spentMicroUSD
    }
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
public final class IOSThreadInboxModel {
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
    public private(set) var items: [IOSThreadListItem] = []
    public private(set) var refreshFailureMessage: String?

    private let currentMemberID: MemberID
    private let backend: any IOSConversationBackend

    public init(currentMemberID: MemberID, backend: any IOSConversationBackend) {
        self.currentMemberID = currentMemberID
        self.backend = backend
    }

    public func load(channels: [IOSChannelListItem]) async {
        if items.isEmpty { phase = .loading }
        refreshFailureMessage = nil
        do {
            var collected: [IOSThreadListItem] = []
            for channel in channels {
                try Task.checkCancellation()
                let history = try await backend.history(channel: channel.id, after: nil, limit: 200)
                let roots = history.filter {
                    $0.rootId == nil && !$0.isDeleted && ($0.thread?.replyCount ?? 0) > 0
                }
                var participantsByRoot: [MessageID: [MemberID]] = [:]
                for root in roots {
                    participantsByRoot[root.id] = try await participantMemberIDs(
                        channel: channel.id,
                        root: root.id
                    )
                }
                collected.append(contentsOf: IOSThreadListAggregator.participatingThreads(
                    channel: channel,
                    messages: roots,
                    participantsByRoot: participantsByRoot,
                    currentMemberID: currentMemberID
                ))
            }
            items = IOSThreadListAggregator.sorted(collected)
            phase = .loaded
        } catch is CancellationError {
            return
        } catch {
            let failure = Self.failure(for: error)
            if items.isEmpty {
                phase = .failed(failure)
            } else {
                phase = .loaded
                refreshFailureMessage = failure.message
            }
        }
    }

    public func clearRefreshFailure() {
        refreshFailureMessage = nil
    }

    private func participantMemberIDs(channel: ChannelID, root: MessageID) async throws -> [MemberID] {
        var result: [MemberID] = []
        var seenMembers = Set<MemberID>()
        var cursor: Int64?
        var seenCursors = Set<Int64>()
        for _ in 0..<20 {
            let page = try await backend.threadReplies(
                channel: channel,
                root: root,
                cursor: cursor,
                limit: 200
            )
            for message in page.messages where seenMembers.insert(message.authorMemberId).inserted {
                result.append(message.authorMemberId)
            }
            guard let next = page.nextCursor,
                  next != cursor,
                  seenCursors.insert(next).inserted else { break }
            cursor = next
        }
        return result
    }

    private static func failure(for error: Error) -> Failure {
        let isOffline = (error as? SessionError).map {
            if case .transport = $0 { return true }
            return false
        } ?? false
        return Failure(
            message: isOffline
                ? "Threads could not be refreshed while offline. Existing results are preserved."
                : "Threads could not be refreshed. Existing results are preserved.",
            isOffline: isOffline
        )
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
    public private(set) var attachmentFailureMessage: String?
    public private(set) var attachmentDrafts: [IOSAttachmentDraft] = []
    public private(set) var attachmentDownloadStates: [FileID: IOSAttachmentDownloadState] = [:]
    public private(set) var reactionMembers: [MessageID: [String: Set<MemberID>]] = [:]
    public private(set) var reactionMutationsInFlight: Set<String> = []
    public private(set) var messageMutationsInFlight: Set<MessageID> = []
    public private(set) var interactionFailureMessage: String?
    public private(set) var recentReactionEmojis = ["👍", "❤️", "😂", "🎉", "👀"]
    public private(set) var approvalDecisionsInFlight: Set<ApprovalID> = []
    public private(set) var approvalDecisionFailures: Set<ApprovalID> = []
    public private(set) var agentPartials: [IOSAgentPartialProjection] = []
    public private(set) var threadParticipantIDs: [MessageID: [MemberID]] = [:]
    public let huddle: IOSHuddleModel

    private let channel: ChannelID
    private let currentMemberID: MemberID
    private let backend: any IOSConversationBackend
    private let threadRoot: MessageID?
    private let initialThreadRootMessage: Message?
    private let initialBeforeSequence: Int64?
    private var workAgentMemberID: MemberID?
    private var workAgentHandle: String?
    private let workSessionID: WorkSessionID?
    private let onReadState: ((ChannelReadState) -> Void)?
    private var eventTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var isLoadingTimelineProjection = false
    private var bufferedRealtimeEvents: [RealtimeEvent] = []
    private var failedSend: IOSPendingMessageSend?
    private var pendingApprovalDecisions: [ApprovalID: IOSPendingApprovalDecision] = [:]
    private var activeWorkRunIDs: Set<RunID> = []
    private var partialsByRunID: [RunID: IOSAgentPartialProjection] = [:]
    private var nextWorkCommandIsRead = false

    public init(
        channel: ChannelID,
        currentMemberID: MemberID,
        backend: any IOSConversationBackend,
        workspace: WorkspaceID? = nil,
        huddleService: (any IOSHuddleService)? = nil,
        huddleAudioSession: (any IOSHuddleAudioSession)? = nil,
        microphonePermission: (any IOSMicrophonePermissionAuthorizing)? = nil,
        threadRoot: MessageID? = nil,
        initialThreadRootMessage: Message? = nil,
        initialBeforeSequence: Int64? = nil,
        workAgentMemberID: MemberID? = nil,
        workAgentHandle: String? = nil,
        workSessionID: WorkSessionID? = nil,
        onReadState: ((ChannelReadState) -> Void)? = nil
    ) {
        self.channel = channel
        self.currentMemberID = currentMemberID
        self.backend = backend
        self.threadRoot = threadRoot
        self.initialThreadRootMessage = initialThreadRootMessage
        self.initialBeforeSequence = initialBeforeSequence
        self.workAgentMemberID = workAgentMemberID
        self.workAgentHandle = workAgentHandle
        self.workSessionID = workSessionID
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

    public func configureWorkAgent(_ member: Member?) {
        guard member?.kind == .agent else {
            workAgentMemberID = nil
            workAgentHandle = nil
            activeWorkRunIDs = []
            partialsByRunID = [:]
            agentPartials = []
            return
        }
        workAgentMemberID = member?.id
        workAgentHandle = member?.handle
    }

    public func load() async {
        guard !isSending else { return }
        phase = .loading
        isLoadingTimelineProjection = true
        bufferedRealtimeEvents = []
        subscribe()
        do {
            async let historyRequest = initialMessages()
            async let reactionRequest = backend.reactionSnapshot(channel: channel)
            let (history, reactions) = try await (historyRequest, reactionRequest)
            messages = IOSTimelineReducer.sorted(history)
            reactionMembers = reactions
            let bufferedEvents = bufferedRealtimeEvents
            bufferedRealtimeEvents = []
            isLoadingTimelineProjection = false
            for event in bufferedEvents {
                await applyRealtimeEvent(event)
            }
            phase = .loaded
            if let sequence = messages.compactMap(\.seq).max() {
                if let state = try? await backend.markRead(channel: channel, through: sequence) {
                    onReadState?(state)
                }
            }
            if threadRoot == nil { await huddle.activate() }
        } catch is CancellationError {
            isLoadingTimelineProjection = false
            bufferedRealtimeEvents = []
            return
        } catch {
            isLoadingTimelineProjection = false
            bufferedRealtimeEvents = []
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
        if threadRoot == nil { await huddle.activate() }
    }

    public func shutdown() async {
        stop()
        await huddle.shutdown()
    }

    func consumeRealtimeEvent(_ event: RealtimeEvent) async {
        if isLoadingTimelineProjection {
            bufferedRealtimeEvents.append(event)
            return
        }
        await applyRealtimeEvent(event)
    }

    private func applyRealtimeEvent(_ event: RealtimeEvent) async {
        if threadRoot == nil, case .huddle(let delta) = event {
            await huddle.apply(delta)
        }
        applyAgentProjection(event)
        if threadRoot == nil,
           case .message(let message) = event,
           let rootID = message.rootId
        {
            var participants = threadParticipantIDs[rootID] ?? []
            if !participants.contains(message.authorMemberId) {
                participants.append(message.authorMemberId)
                threadParticipantIDs[rootID] = participants
            }
        }
        guard belongsToCurrentTimeline(event) else { return }
        messages = IOSTimelineReducer.applying(event, to: messages, channel: channel)
        switch event {
        case .reaction(let delta):
            guard messages.contains(where: { $0.id == delta.messageId && !$0.isDeleted }) else { return }
            reactionMembers = IOSReactionReducer.applying(delta, to: reactionMembers)
        case .messageDeleted(let id):
            reactionMembers[id] = nil
        default:
            break
        }
        if case .message(let message) = event, let runID = message.runId {
            partialsByRunID[runID] = nil
            agentPartials = partialsByRunID.values.sorted { $0.id.description < $1.id.description }
        }
    }

    public func availableInteractionActions(for message: Message) -> Set<IOSMessageInteractionAction> {
        guard canPresentInteractionSheet(for: message) else { return [] }
        var actions: Set<IOSMessageInteractionAction> = [.react, .reply, .copy]
        if message.authorMemberId == currentMemberID {
            actions.formUnion([.edit, .delete])
        }
        return actions
    }

    public func canPresentInteractionSheet(for message: Message) -> Bool {
        message.channelId == channel && message.seq != nil && !message.isDeleted
    }

    public func reactions(for message: Message) -> [IOSMessageReaction] {
        (reactionMembers[message.id] ?? [:])
            .map { emoji, memberIDs in
                IOSMessageReaction(
                    emoji: emoji,
                    memberIDs: memberIDs,
                    isSelectedByCurrentMember: memberIDs.contains(currentMemberID)
                )
            }
            .filter { $0.count > 0 }
            .sorted { lhs, rhs in
                lhs.count == rhs.count ? lhs.emoji < rhs.emoji : lhs.count > rhs.count
            }
    }

    public func message(id: MessageID) -> Message? {
        messages.first(where: { $0.id == id })
    }

    public func isReactionMutationInFlight(message: Message, emoji: String) -> Bool {
        reactionMutationsInFlight.contains(reactionMutationKey(message: message, emoji: emoji))
    }

    public func toggleReaction(_ emoji: String, on message: Message) async {
        let normalized = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canPresentInteractionSheet(for: message), !normalized.isEmpty else { return }
        let key = reactionMutationKey(message: message, emoji: normalized)
        guard !reactionMutationsInFlight.contains(key), !messageMutationsInFlight.contains(message.id) else { return }
        reactionMutationsInFlight.insert(key)
        interactionFailureMessage = nil
        defer { reactionMutationsInFlight.remove(key) }

        do {
            let selected = reactionMembers[message.id]?[normalized]?.contains(currentMemberID) == true
            let delta = if selected {
                try await backend.removeReaction(message.id, emoji: normalized)
            } else {
                try await backend.addReaction(message.id, emoji: normalized)
            }
            guard delta.messageId == message.id,
                  delta.memberId == currentMemberID,
                  delta.emoji == normalized,
                  delta.action == (selected ? .removed : .added),
                  messages.contains(where: { $0.id == message.id && !$0.isDeleted })
            else {
                throw SessionError.decoding("The server returned a different message reaction.")
            }
            reactionMembers = IOSReactionReducer.applying(delta, to: reactionMembers)
            rememberReaction(normalized)
        } catch is CancellationError {
            return
        } catch {
            interactionFailureMessage = "반응을 저장하지 못했습니다. 연결을 확인하고 다시 시도하세요. / Could not save the reaction. Check your connection and try again."
        }
    }

    public func editMessage(_ message: Message, body: String) async -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard availableInteractionActions(for: message).contains(.edit),
              !trimmed.isEmpty,
              !messageMutationsInFlight.contains(message.id)
        else { return false }
        messageMutationsInFlight.insert(message.id)
        interactionFailureMessage = nil
        defer { messageMutationsInFlight.remove(message.id) }
        do {
            let updated = try await backend.editMessage(message.id, body: trimmed)
            guard updated.id == message.id,
                  updated.channelId == channel,
                  updated.authorMemberId == currentMemberID,
                  !updated.isDeleted,
                  updated.body == trimmed
            else { throw SessionError.decoding("The server returned a different edited message.") }
            messages = IOSTimelineReducer.applying(.messageEdited(updated), to: messages, channel: channel)
            return true
        } catch is CancellationError {
            return false
        } catch {
            interactionFailureMessage = "메시지를 수정하지 못했습니다. 다시 시도하세요. / Could not edit the message. Try again."
            return false
        }
    }

    public func deleteMessage(_ message: Message) async -> Bool {
        guard availableInteractionActions(for: message).contains(.delete),
              !messageMutationsInFlight.contains(message.id)
        else { return false }
        messageMutationsInFlight.insert(message.id)
        interactionFailureMessage = nil
        defer { messageMutationsInFlight.remove(message.id) }
        do {
            let tombstone = try await backend.deleteMessage(message.id)
            guard tombstone.id == message.id,
                  tombstone.channelId == channel,
                  tombstone.authorMemberId == currentMemberID,
                  tombstone.isDeleted,
                  tombstone.body == nil
            else { throw SessionError.decoding("The server returned a different deleted message.") }
            messages = IOSTimelineReducer.applying(.messageEdited(tombstone), to: messages, channel: channel)
            reactionMembers[message.id] = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            interactionFailureMessage = "메시지를 삭제하지 못했습니다. 다시 시도하세요. / Could not delete the message. Try again."
            return false
        }
    }

    public func clearInteractionFailure() {
        interactionFailureMessage = nil
    }

    public func selectReply(to message: Message) {
        guard message.channelId == channel, !message.isDeleted else { return }
        replyTarget = message
    }

    public func loadThreadParticipants(for message: Message) async {
        guard message.rootId == nil,
              (message.thread?.replyCount ?? 0) > 0,
              threadParticipantIDs[message.id] == nil
        else { return }
        do {
            let page = try await backend.threadReplies(
                channel: channel,
                root: message.id,
                cursor: nil,
                limit: 50
            )
            var seen = Set<MemberID>()
            threadParticipantIDs[message.id] = page.messages
                .map(\.authorMemberId)
                .filter { seen.insert($0).inserted }
        } catch is CancellationError {
            return
        } catch {
            return
        }
    }

    public func cancelReply() {
        replyTarget = nil
    }

    public func stageAttachment(fileURL: URL) throws {
        let draft = try IOSAttachmentFileBoundary.draft(for: fileURL)
        guard !attachmentDrafts.contains(where: { $0.fileURL.standardizedFileURL == fileURL.standardizedFileURL }) else {
            return
        }
        attachmentDrafts.append(draft)
        attachmentFailureMessage = nil
    }

    public func removeAttachmentDraft(_ id: UUID) {
        guard attachmentDrafts.first(where: { $0.id == id })?.state != .uploading else { return }
        attachmentDrafts.removeAll { $0.id == id }
        if !attachmentDrafts.contains(where: { if case .failed = $0.state { return true }; return false }) {
            attachmentFailureMessage = nil
        }
    }

    public func retryAttachmentDraft(_ id: UUID) async {
        guard !isSending,
              let index = attachmentDrafts.firstIndex(where: { $0.id == id }),
              case .failed = attachmentDrafts[index].state else { return }
        isSending = true
        defer { isSending = false }
        attachmentDrafts[index].state = .uploading
        do {
            let uploaded = try await backend.uploadAttachment(fileURL: attachmentDrafts[index].fileURL, to: channel)
            guard let currentIndex = attachmentDrafts.firstIndex(where: { $0.id == id }) else { return }
            attachmentDrafts[currentIndex].state = .uploaded(uploaded)
            if !attachmentDrafts.contains(where: { if case .failed = $0.state { return true }; return false }) {
                attachmentFailureMessage = nil
            }
        } catch is CancellationError {
            if let currentIndex = attachmentDrafts.firstIndex(where: { $0.id == id }) {
                attachmentDrafts[currentIndex].state = .ready
            }
        } catch {
            markAttachmentDraftFailed(id, error: error)
        }
    }

    public func attachmentDownloadState(for attachment: MessageAttachment) -> IOSAttachmentDownloadState? {
        attachmentDownloadStates[attachment.id]
    }

    public func cachedAttachmentURL(for attachment: MessageAttachment) -> URL? {
        guard case .completed(let url) = attachmentDownloadStates[attachment.id] else { return nil }
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    @discardableResult
    public func downloadAttachment(_ attachment: MessageAttachment) async -> URL? {
        if let cached = cachedAttachmentURL(for: attachment) { return cached }
        guard attachmentDownloadStates[attachment.id] != .downloading else { return nil }
        attachmentDownloadStates[attachment.id] = .downloading
        do {
            let url = try await backend.downloadAttachment(attachment, from: channel)
            attachmentDownloadStates[attachment.id] = .completed(url)
            return url
        } catch is CancellationError {
            attachmentDownloadStates[attachment.id] = nil
            return nil
        } catch {
            attachmentDownloadStates[attachment.id] = .failed
            return nil
        }
    }

    /// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
    /// Adds a local echo and reconciles it through the IOS-2 clientMsgId guard.
    public func sendComposerDraft() async {
        let body = composerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard phase == .loaded,
              !isSending,
              failedSend == nil,
              !body.isEmpty || !attachmentDrafts.isEmpty else { return }
        guard workSessionID == nil || workAgentHandle != nil else {
            sendFailureMessage = "Choose the agent that owns this Work session before sending input."
            return
        }
        isSending = true
        defer { isSending = false }
        guard let uploadedAttachments = await uploadPendingAttachments() else { return }
        let preparedBody = body.isEmpty ? nil : workInstructionBody(for: body, requestsRead: nextWorkCommandIsRead)
        nextWorkCommandIsRead = false
        let replyToID = replyTarget?.id ?? threadRoot
        var props: [String: JSON] = [:]
        if let replyToID {
            props["reply_to_id"] = .string(replyToID.description)
        }
        let pending = IOSPendingMessageSend(
            draft: DraftMessage(
                channelId: channel,
                type: .text,
                body: preparedBody,
                props: .object(props),
                rootId: threadRoot,
                replyToId: replyToID,
                attachmentIds: uploadedAttachments.map(\.id)
            ),
            clientMsgId: UUID(),
            attachments: uploadedAttachments
        )
        composerDraft = ""
        replyTarget = nil
        attachmentDrafts = []
        messages = IOSTimelineReducer.applying(
            .message(optimisticMessage(for: pending)),
            to: messages,
            channel: channel
        )
        await performSend(pending)
    }

    public func requestCurrentWorkOutput() async {
        guard threadRoot != nil else { return }
        nextWorkCommandIsRead = true
        composerDraft = "현재 출력을 검토 가능한 발췌로 이 스레드에 공유해줘."
        await sendComposerDraft()
    }

    public func retryFailedSend() async {
        guard let failedSend, !isSending else { return }
        isSending = true
        defer { isSending = false }
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
        sendFailureMessage = nil
        do {
            var acknowledged = try await backend.send(pending.draft, clientMsgId: pending.clientMsgId)
            acknowledged.clientMsgId = pending.clientMsgId
            acknowledged.rootId = pending.draft.rootId
            acknowledged.replyToId = pending.draft.replyToId
            if acknowledged.attachments == nil || acknowledged.attachments?.isEmpty == true {
                acknowledged.attachments = pending.attachments
            }
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

    private func uploadPendingAttachments() async -> [MessageAttachment]? {
        attachmentFailureMessage = nil
        var uploaded: [MessageAttachment] = []
        for id in attachmentDrafts.map(\.id) {
            guard let index = attachmentDrafts.firstIndex(where: { $0.id == id }) else { continue }
            if case .uploaded(let attachment) = attachmentDrafts[index].state {
                uploaded.append(attachment)
                continue
            }
            attachmentDrafts[index].state = .uploading
            do {
                let attachment = try await backend.uploadAttachment(
                    fileURL: attachmentDrafts[index].fileURL,
                    to: channel
                )
                guard let currentIndex = attachmentDrafts.firstIndex(where: { $0.id == id }) else { return nil }
                attachmentDrafts[currentIndex].state = .uploaded(attachment)
                uploaded.append(attachment)
            } catch is CancellationError {
                if let currentIndex = attachmentDrafts.firstIndex(where: { $0.id == id }) {
                    attachmentDrafts[currentIndex].state = .ready
                }
                return nil
            } catch {
                markAttachmentDraftFailed(id, error: error)
                return nil
            }
        }
        return uploaded
    }

    private func markAttachmentDraftFailed(_ id: UUID, error: Error) {
        guard let index = attachmentDrafts.firstIndex(where: { $0.id == id }) else { return }
        if let issue = error as? IOSAttachmentTransferIssue, issue == .fileTooLarge {
            attachmentDrafts[index].state = .failed(.fileTooLarge)
            attachmentFailureMessage = "Attachments must be 100 MB or smaller. Remove this file or choose another."
        } else {
            attachmentDrafts[index].state = .failed(.unavailable)
            attachmentFailureMessage = "Attachment upload failed. Retry the failed file."
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
            rootId: pending.draft.rootId,
            attachments: pending.attachments,
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

    private func reactionMutationKey(message: Message, emoji: String) -> String {
        "\(message.id.description):\(emoji)"
    }

    private func rememberReaction(_ emoji: String) {
        recentReactionEmojis.removeAll(where: { $0 == emoji })
        recentReactionEmojis.insert(emoji, at: 0)
        if recentReactionEmojis.count > 5 {
            recentReactionEmojis.removeLast(recentReactionEmojis.count - 5)
        }
    }

    private func initialMessages() async throws -> [Message] {
        guard let threadRoot else {
            if let initialBeforeSequence {
                return try await backend.historyBefore(
                    channel: channel,
                    before: initialBeforeSequence,
                    limit: 200
                )
                .filter { $0.rootId == nil }
            }
            return try await backend.history(channel: channel, after: nil, limit: 200)
                .filter { $0.rootId == nil }
        }
        var messages: [Message] = initialThreadRootMessage.map { [$0] } ?? []
        var cursor: Int64?
        var seenCursors: Set<Int64> = []
        for _ in 0..<20 {
            let page = try await backend.threadReplies(
                channel: channel,
                root: threadRoot,
                cursor: cursor,
                limit: 200
            )
            messages.append(contentsOf: page.messages)
            guard let next = page.nextCursor,
                  next != cursor,
                  seenCursors.insert(next).inserted else { break }
            cursor = next
        }
        return messages
    }

    private func belongsToCurrentTimeline(_ event: RealtimeEvent) -> Bool {
        guard let threadRoot else {
            switch event {
            case .message(let message), .messageEdited(let message):
                return message.rootId == nil
            case .messageDeleted(let id):
                return messages.contains(where: { $0.id == id })
            case .reaction(let delta):
                return messages.contains(where: { $0.id == delta.messageId })
            default:
                return true
            }
        }
        switch event {
        case .message(let message), .messageEdited(let message):
            return message.id == threadRoot || message.rootId == threadRoot
        case .messageDeleted(let id):
            return messages.contains(where: { $0.id == id })
        case .reaction(let delta):
            return messages.contains(where: { $0.id == delta.messageId })
        case .approval(let approval):
            return messages.contains(where: { Self.approvalID(for: $0) == approval.approvalId })
        case .agentStatus, .agentPartial:
            return false
        case .threadUpdated(let delta):
            return delta.rootId == threadRoot
        case .typing, .presence, .huddle, .workSession, .workControl:
            return false
        }
    }

    private func applyAgentProjection(_ event: RealtimeEvent) {
        guard workAgentMemberID != nil else { return }
        switch event {
        case .agentStatus(let status):
            guard status.agentMemberId == workAgentMemberID,
                  status.channelId == channel else { return }
            if status.runStatus.isTerminal {
                activeWorkRunIDs.remove(status.runId)
                partialsByRunID[status.runId] = nil
                agentPartials = partialsByRunID.values.sorted { $0.id.description < $1.id.description }
            } else {
                activeWorkRunIDs.insert(status.runId)
            }
        case .agentPartial(let partial):
            guard partial.channelId == channel,
                  activeWorkRunIDs.contains(partial.runId) else { return }
            var projection = partialsByRunID[partial.runId]
                ?? IOSAgentPartialProjection(id: partial.runId)
            if let delta = partial.textDelta { projection.text += delta }
            if let toolCallName = partial.toolCallName { projection.toolCallName = toolCallName }
            if let spent = partial.spentMicroUSD { projection.spentMicroUSD = spent }
            partialsByRunID[partial.runId] = projection
            agentPartials = partialsByRunID.values.sorted { $0.id.description < $1.id.description }
        default:
            break
        }
    }

    private func workInstructionBody(for body: String, requestsRead: Bool) -> String {
        guard let handle = workAgentHandle,
              let workSessionID else { return body }
        if requestsRead {
            return "@\(handle) work_read 세션 \(workSessionID.description.lowercased())의 현재 출력을 검토 가능한 발췌로 이 스레드에 공유해줘."
        }
        return "@\(handle) work_input 세션 \(workSessionID.description.lowercased())에 다음 요청을 반영해줘:\n\n\(body)"
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
