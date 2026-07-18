import Foundation
import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class MessageInteractionBootstrapRaceTests: XCTestCase {
    func testSessionClearWhileHistoryIsBlockedCannotRepopulateTimeline() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let channel = try XCTUnwrap(seed.channels.first)
        let staleMessage = Message(
            id: MessageID(),
            channelId: channel.id,
            seq: 1,
            hlcTs: 1_700_000_000_000,
            authorMemberId: seed.human.id,
            body: "must not survive session clear",
            createdAtMs: 1_700_000_000_000
        )
        let backend = BlockedInteractionBootstrapBackend(
            base: liveBackend,
            history: [staleMessage]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo-token")

        let selection = Task { await viewModel.selectChannel(channel.id) }
        await backend.waitForHistoryCall()

        await viewModel.clearSessionSensitiveState()
        await backend.releaseHistory()
        await selection.value

        XCTAssertNil(viewModel.workspaceId)
        XCTAssertNil(viewModel.selectedChannelId)
        XCTAssertTrue(viewModel.messagesByChannel.isEmpty)
        XCTAssertTrue(viewModel.messageInteractionErrors.isEmpty)
        XCTAssertTrue(viewModel.reactions(for: staleMessage).isEmpty)

        await backend.finishSubscriptions()
    }

    func testRealtimeEditAndDeleteSurviveBlockedHistoryAndReactionSnapshot() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let channel = try XCTUnwrap(seed.channels.first)
        let author = seed.human.id
        let editedMessageID = MessageID()
        let deletedMessageID = MessageID()
        let originalEditedMessage = Message(
            id: editedMessageID,
            channelId: channel.id,
            seq: 1,
            hlcTs: 1_700_000_000_000,
            authorMemberId: author,
            body: "history edit body",
            createdAtMs: 1_700_000_000_000
        )
        let originalDeletedMessage = Message(
            id: deletedMessageID,
            channelId: channel.id,
            seq: 2,
            hlcTs: 1_700_000_000_100,
            authorMemberId: author,
            body: "history delete body",
            createdAtMs: 1_700_000_000_100
        )
        let backend = BlockedInteractionBootstrapBackend(
            base: liveBackend,
            history: [originalEditedMessage, originalDeletedMessage]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo-token")

        let selection = Task { await viewModel.selectChannel(channel.id) }
        await backend.waitForHistoryCall()

        var realtimeEditedMessage = originalEditedMessage
        realtimeEditedMessage.body = "realtime edited body"
        realtimeEditedMessage.state = .edited
        realtimeEditedMessage.editedAtMs = 1_700_000_001_000
        await backend.emit(.messageEdited(realtimeEditedMessage), channel: channel.id)
        await backend.emit(
            .typing(TypingDelta(
                channelId: channel.id,
                memberId: seed.human.id,
                isTyping: true
            )),
            channel: channel.id
        )
        let consumedEdit = await eventually {
            viewModel.typingStates[channel.id]?[seed.human.id] != nil
        }
        XCTAssertTrue(consumedEdit, "the edit must enter the realtime consumer before history resumes")

        await backend.releaseHistory()
        await backend.waitForReactionSnapshotCall()

        await backend.emit(.messageDeleted(deletedMessageID), channel: channel.id)
        await backend.emit(
            .typing(TypingDelta(
                channelId: channel.id,
                memberId: seed.agents[0].id,
                isTyping: true
            )),
            channel: channel.id
        )
        let consumedDelete = await eventually {
            viewModel.typingStates[channel.id]?[seed.agents[0].id] != nil
        }
        XCTAssertTrue(consumedDelete, "the delete must enter the realtime consumer before the snapshot resumes")

        await backend.releaseReactionSnapshot()
        await selection.value

        let messages = try XCTUnwrap(viewModel.messagesByChannel[channel.id])
        let edited = try XCTUnwrap(messages.first { $0.id == editedMessageID })
        XCTAssertEqual(edited.body, "realtime edited body")
        XCTAssertEqual(edited.state, .edited)
        XCTAssertEqual(edited.editedAtMs, 1_700_000_001_000)

        let deleted = try XCTUnwrap(messages.first { $0.id == deletedMessageID })
        XCTAssertEqual(deleted.state, .deleted)
        XCTAssertNil(deleted.body)

        await backend.finishSubscriptions()
    }

    private func eventually(_ predicate: () -> Bool) async -> Bool {
        for _ in 0..<1_000 {
            if predicate() { return true }
            await Task.yield()
        }
        return predicate()
    }
}

private actor BlockedInteractionBootstrapBackend: ChatBackend, MomoMessageInteractionBackend {
    private let base: LiveChatBackend
    private let historyResult: [Message]
    private var subscriptions: [ChannelID: [AsyncStream<RealtimeEvent>.Continuation]] = [:]

    private var historyArrived = false
    private var historyArrivalWaiters: [CheckedContinuation<Void, Never>] = []
    private var historyRelease: CheckedContinuation<Void, Never>?
    private var historyIsReleased = false

    private var reactionSnapshotArrived = false
    private var reactionSnapshotArrivalWaiters: [CheckedContinuation<Void, Never>] = []
    private var reactionSnapshotRelease: CheckedContinuation<Void, Never>?
    private var reactionSnapshotIsReleased = false

    init(base: LiveChatBackend, history: [Message]) {
        self.base = base
        self.historyResult = history
    }

    func waitForHistoryCall() async {
        if historyArrived { return }
        await withCheckedContinuation { continuation in
            historyArrivalWaiters.append(continuation)
        }
    }

    func releaseHistory() {
        historyIsReleased = true
        historyRelease?.resume()
        historyRelease = nil
    }

    func waitForReactionSnapshotCall() async {
        if reactionSnapshotArrived { return }
        await withCheckedContinuation { continuation in
            reactionSnapshotArrivalWaiters.append(continuation)
        }
    }

    func releaseReactionSnapshot() {
        reactionSnapshotIsReleased = true
        reactionSnapshotRelease?.resume()
        reactionSnapshotRelease = nil
    }

    func emit(_ event: RealtimeEvent, channel: ChannelID) {
        for continuation in subscriptions[channel] ?? [] {
            continuation.yield(event)
        }
    }

    func finishSubscriptions() {
        for continuations in subscriptions.values {
            for continuation in continuations {
                continuation.finish()
            }
        }
        subscriptions = [:]
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        let pair = AsyncStream<RealtimeEvent>.makeStream()
        subscriptions[channel, default: []].append(pair.continuation)
        return pair.stream
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        historyArrived = true
        historyArrivalWaiters.forEach { $0.resume() }
        historyArrivalWaiters = []
        if !historyIsReleased {
            await withCheckedContinuation { continuation in
                historyRelease = continuation
            }
        }
        return historyResult
    }

    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] {
        reactionSnapshotArrived = true
        reactionSnapshotArrivalWaiters.forEach { $0.resume() }
        reactionSnapshotArrivalWaiters = []
        if !reactionSnapshotIsReleased {
            await withCheckedContinuation { continuation in
                reactionSnapshotRelease = continuation
            }
        }
        return [:]
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        try await base.presence(channel: channel)
    }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        try await base.members(workspace: workspace)
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        try await base.channels(workspace: workspace)
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        try await base.costSnapshots(channel: channel)
    }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        try await base.search(workspace: workspace, query: query)
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {
        await base.setTyping(channel: channel, isTyping: isTyping)
    }

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        try await base.editMessage(id, body: body)
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {
        try await base.addReaction(id, emoji: emoji)
    }

    func removeReaction(_ id: MessageID, emoji: String) async throws {
        try await base.removeReaction(id, emoji: emoji)
    }

    func deleteMessage(_ id: MessageID) async throws -> Message {
        try await base.deleteMessage(id)
    }

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }
}
