import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class MessageInteractionTests: XCTestCase {
    private func fixture() async throws -> (ChatViewModel, Message, Message) {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let message = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "작성자 메시지"
        )
        let otherMessage = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.agents[0].id,
            body: "다른 작성자 메시지"
        )
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        return (viewModel, message, otherMessage)
    }

    func testReactionToggleMaintainsMemberCountAndSelection() async throws {
        let (viewModel, message, _) = try await fixture()

        await viewModel.toggleReaction("👍", on: message)
        XCTAssertEqual(viewModel.reactions(for: message).first?.count, 1)
        XCTAssertEqual(viewModel.reactions(for: message).first?.isSelectedByCurrentMember, true)

        await viewModel.toggleReaction("👍", on: message)
        XCTAssertTrue(viewModel.reactions(for: message).isEmpty)
    }

    func testReplyIsKeptOutOfRootAndDiscoverableByThread() async throws {
        let (viewModel, root, _) = try await fixture()

        let didSend = await viewModel.sendReply(body: "스레드 답글", to: root)
        XCTAssertTrue(didSend)

        let replies = viewModel.replies(to: root)
        XCTAssertEqual(replies.last?.body, "스레드 답글")
        XCTAssertEqual(replies.last?.rootId, root.id)
        XCTAssertFalse(viewModel.visibleMessages.filter { $0.rootId == nil }.contains { $0.body == "스레드 답글" })
    }

    func testThreadRollupDrivesBadgeAndRepliesLoadOutsideChannelHistorySlice() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let root = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "배포 체크리스트 스레드"
        )
        _ = await liveBackend.seedDemoMessage(
            channel: root.channelId,
            author: seed.agents[0].id,
            body: "과거 답글 1",
            rootId: root.id
        )
        _ = await liveBackend.seedDemoMessage(
            channel: root.channelId,
            author: seed.human.id,
            body: "과거 답글 2",
            rootId: root.id
        )
        let backend = RootOnlyHistoryThreadBackend(base: liveBackend, pageLimit: 1)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)

        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await viewModel.selectChannel(root.channelId)
        let loadedRoot = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == root.id })
        XCTAssertTrue(viewModel.replies(to: loadedRoot).isEmpty)
        XCTAssertEqual(viewModel.threadReplyCount(for: loadedRoot), 2)

        await viewModel.loadThreadReplies(for: loadedRoot)
        XCTAssertEqual(viewModel.replies(to: loadedRoot).map(\.body), ["과거 답글 1"])
        XCTAssertTrue(viewModel.canLoadMoreThreadReplies(for: loadedRoot))

        await viewModel.loadMoreThreadReplies(for: loadedRoot)
        XCTAssertEqual(viewModel.replies(to: loadedRoot).map(\.body), ["과거 답글 1", "과거 답글 2"])
        XCTAssertFalse(viewModel.canLoadMoreThreadReplies(for: loadedRoot))
        XCTAssertFalse(viewModel.threadRepliesFailedRootIDs.contains(root.id))

        _ = await liveBackend.seedDemoMessage(
            channel: root.channelId,
            author: seed.agents[0].id,
            body: "실시간 답글 3",
            rootId: root.id
        )
        for _ in 0..<20 {
            await Task.yield()
            guard let realtimeRoot = viewModel.visibleMessages.first(where: { $0.id == root.id }),
                  viewModel.threadReplyCount(for: realtimeRoot) < 3 else { break }
        }
        let realtimeRoot = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == root.id })
        XCTAssertEqual(viewModel.threadReplyCount(for: realtimeRoot), 3)
        XCTAssertEqual(viewModel.replies(to: realtimeRoot).last?.body, "실시간 답글 3")
    }

    func testThreadReplyLoadFailureCanRetryWithoutLosingServerRollup() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let root = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "장애 복구 스레드"
        )
        _ = await liveBackend.seedDemoMessage(
            channel: root.channelId,
            author: seed.agents[0].id,
            body: "복구 후 보이는 답글",
            rootId: root.id
        )
        let backend = RootOnlyHistoryThreadBackend(
            base: liveBackend,
            threadRepliesFailuresRemaining: 1
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)

        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await viewModel.selectChannel(root.channelId)
        let loadedRoot = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == root.id })

        await viewModel.loadThreadReplies(for: loadedRoot)
        XCTAssertTrue(viewModel.replies(to: loadedRoot).isEmpty)
        XCTAssertTrue(viewModel.threadRepliesFailedRootIDs.contains(root.id))
        XCTAssertEqual(viewModel.threadReplyCount(for: loadedRoot), 1)

        await viewModel.retryThreadReplies(for: loadedRoot)
        XCTAssertEqual(viewModel.replies(to: loadedRoot).map(\.body), ["복구 후 보이는 답글"])
        XCTAssertFalse(viewModel.threadRepliesFailedRootIDs.contains(root.id))
        XCTAssertFalse(viewModel.threadRepliesLoadingRootIDs.contains(root.id))
    }

    func testAuthorCanEditAndDeleteThroughCompleteBackendCapability() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let message = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "작성자 메시지"
        )
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")

        XCTAssertTrue(viewModel.supportsMessageInteractions)
        let didEdit = await viewModel.editMessage(message, body: "수정한 메시지")
        XCTAssertTrue(didEdit)
        let edited = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id })
        XCTAssertEqual(edited.body, "수정한 메시지")
        XCTAssertEqual(edited.state, .edited)

        let didDelete = await viewModel.deleteMessage(edited)
        XCTAssertTrue(didDelete)
        XCTAssertTrue(try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id }).isDeleted)
        let persistedHistory = try await backend.history(
            channel: message.channelId,
            after: nil,
            limit: 100
        )
        XCTAssertTrue(try XCTUnwrap(persistedHistory.first { $0.id == message.id }).isDeleted)
    }

    func testNonAuthorCannotEditOrDelete() async throws {
        let (viewModel, _, otherMessage) = try await fixture()

        let didEdit = await viewModel.editMessage(otherMessage, body: "허용되지 않음")
        XCTAssertFalse(didEdit)
        let didDelete = await viewModel.deleteMessage(otherMessage)
        XCTAssertFalse(didDelete)
        XCTAssertFalse(otherMessage.isDeleted)
    }

    func testPendingAndDeletedMessagesRejectServerInteractions() async throws {
        let (viewModel, message, _) = try await fixture()
        var pendingMessage = message
        pendingMessage.seq = nil

        XCTAssertFalse(viewModel.canInteractWithMessage(pendingMessage))
        XCTAssertFalse(viewModel.canModifyMessage(pendingMessage))
        let didEditPending = await viewModel.editMessage(pendingMessage, body: "아직 전송 중")
        let didDeletePending = await viewModel.deleteMessage(pendingMessage)
        XCTAssertFalse(didEditPending)
        XCTAssertFalse(didDeletePending)
        await viewModel.toggleReaction("👍", on: pendingMessage)
        XCTAssertTrue(viewModel.reactions(for: pendingMessage).isEmpty)

        var deletedMessage = message
        deletedMessage.state = .deleted
        deletedMessage.body = nil
        deletedMessage.deletedAtMs = 1

        XCTAssertFalse(viewModel.canInteractWithMessage(deletedMessage))
        XCTAssertFalse(viewModel.canModifyMessage(deletedMessage))
        let didEditDeleted = await viewModel.editMessage(deletedMessage, body: "복구 시도")
        let didDeleteDeleted = await viewModel.deleteMessage(deletedMessage)
        XCTAssertFalse(didEditDeleted)
        XCTAssertFalse(didDeleteDeleted)
        await viewModel.toggleReaction("👍", on: deletedMessage)
        XCTAssertTrue(viewModel.reactions(for: deletedMessage).isEmpty)
    }

    func testSessionClearRemovesReactionAndInteractionErrorSidecars() async throws {
        let (viewModel, message, _) = try await fixture()
        await viewModel.toggleReaction("👍", on: message)
        XCTAssertFalse(viewModel.reactions(for: message).isEmpty)

        await viewModel.clearSessionSensitiveState()

        XCTAssertTrue(viewModel.reactions(for: message).isEmpty)
        XCTAssertTrue(viewModel.messageInteractionErrors.isEmpty)
    }

    func testDeleteSupersedesInFlightEditWithoutResurrectingTombstone() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let message = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "original"
        )
        let backend = ControlledMessageInteractionBackend(base: liveBackend)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")

        let editTask = Task {
            await viewModel.editMessage(message, body: "stale edit response")
        }
        await backend.waitForEditResponse()

        let didDelete = await viewModel.deleteMessage(message)
        XCTAssertTrue(didDelete)
        XCTAssertEqual(
            try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id }).state,
            .deleted
        )

        await backend.releaseEditResponse()
        let didApplyLateEdit = await editTask.value

        XCTAssertFalse(didApplyLateEdit)
        let finalMessage = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id })
        XCTAssertEqual(finalMessage.state, .deleted)
        XCTAssertNil(finalMessage.body)
        XCTAssertNil(viewModel.messageInteractionErrors[message.id])
    }

    func testDeleteInvalidatesInFlightReactionAndIgnoresLateRealtimeReaction() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let message = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "delete wins over reaction"
        )
        let backend = ControlledMessageInteractionBackend(base: liveBackend)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await viewModel.selectChannel(message.channelId)

        let reactionTask = Task {
            await viewModel.toggleReaction("👍", on: message)
        }
        await backend.waitForReactionRequest()
        XCTAssertEqual(viewModel.reactions(for: message).first?.count, 1)

        let didDelete = await viewModel.deleteMessage(message)
        XCTAssertTrue(didDelete)
        await backend.cancelReactionRequest()
        await reactionTask.value
        await backend.emitLateReaction(message.id, emoji: "👍")
        await Task.yield()

        let tombstone = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id })
        XCTAssertTrue(tombstone.isDeleted)
        XCTAssertTrue(viewModel.reactions(for: tombstone).isEmpty)
        XCTAssertNil(viewModel.messageInteractionErrors[message.id])
    }

    func testFailedDeleteKeepsInFlightReactionTokenSoFailureCanRollbackOptimisticAdd() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let message = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "failed delete must preserve reaction rollback"
        )
        let backend = ControlledMessageInteractionBackend(base: liveBackend)
        await backend.failDeleteRequests()
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await viewModel.selectChannel(message.channelId)

        let reactionTask = Task {
            await viewModel.toggleReaction("👍", on: message)
        }
        await backend.waitForReactionRequest()
        XCTAssertEqual(viewModel.reactions(for: message).first?.count, 1)

        let didDelete = await viewModel.deleteMessage(message)
        XCTAssertFalse(didDelete)
        await backend.failReactionRequest()
        await reactionTask.value

        let retainedMessage = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id })
        XCTAssertFalse(retainedMessage.isDeleted)
        XCTAssertTrue(viewModel.reactions(for: retainedMessage).isEmpty)
        XCTAssertEqual(viewModel.messageInteractionErrors[message.id], .reactionFailed)
    }

    func testServerRosterWithoutAuthoritativeIdentityHidesInteractionControls() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let message = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "identity must be authoritative"
        )
        let backend = MissingAuthoritativeIdentityBackend(base: liveBackend)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)

        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")

        XCTAssertTrue(viewModel.supportsMessageInteractions)
        XCTAssertFalse(viewModel.canInteractWithMessage(message))
        XCTAssertFalse(viewModel.canModifyMessage(message))
        await viewModel.toggleReaction("👍", on: message)
        XCTAssertTrue(viewModel.reactions(for: message).isEmpty)
    }

    func testCancelledReactionCompletionAfterSessionClearDoesNotRestoreSidecarsOrErrors() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let message = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "session-scoped reaction"
        )
        let backend = ControlledMessageInteractionBackend(base: liveBackend)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")

        let reactionTask = Task {
            await viewModel.toggleReaction("👍", on: message)
        }
        await backend.waitForReactionRequest()
        XCTAssertEqual(viewModel.reactions(for: message).first?.count, 1)

        await viewModel.clearSessionSensitiveState()
        await backend.cancelReactionRequest()
        await reactionTask.value

        XCTAssertTrue(viewModel.reactions(for: message).isEmpty)
        XCTAssertTrue(viewModel.messageInteractionErrors.isEmpty)
        XCTAssertNil(viewModel.connectionIssue)
        XCTAssertTrue(viewModel.messagesByChannel.isEmpty)
    }

    func testReactionSnapshotRestoresFromDemoBackendSourceOfTruth() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let message = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "반응 복구 메시지"
        )
        let firstViewModel = ChatViewModel(backend: backend)
        await firstViewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await firstViewModel.toggleReaction("👍", on: message)
        XCTAssertEqual(firstViewModel.reactions(for: message).first?.count, 1)

        let restoredViewModel = ChatViewModel(backend: backend)
        await restoredViewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await restoredViewModel.selectChannel(message.channelId)
        XCTAssertEqual(restoredViewModel.reactions(for: message).first?.count, 1)
        XCTAssertTrue(restoredViewModel.reactions(for: message).first?.isSelectedByCurrentMember == true)
    }
}

private actor RootOnlyHistoryThreadBackend: ChatBackend, MomoThreadRepliesBackend {
    private let base: LiveChatBackend
    private let pageLimit: Int?
    private var threadRepliesFailuresRemaining: Int

    init(
        base: LiveChatBackend,
        pageLimit: Int? = nil,
        threadRepliesFailuresRemaining: Int = 0
    ) {
        self.base = base
        self.pageLimit = pageLimit
        self.threadRepliesFailuresRemaining = threadRepliesFailuresRemaining
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        try await base.history(channel: channel, after: seq, limit: limit)
            .filter { $0.rootId == nil }
    }

    func threadReplies(
        channel: ChannelID,
        root: MessageID,
        cursor: Int64?,
        limit: Int
    ) async throws -> MomoThreadRepliesPage {
        if threadRepliesFailuresRemaining > 0 {
            threadRepliesFailuresRemaining -= 1
            throw ThreadRepliesTestError.unavailable
        }
        return try await base.threadReplies(
            channel: channel,
            root: root,
            cursor: cursor,
            limit: min(limit, pageLimit ?? limit)
        )
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

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }
}

private enum ThreadRepliesTestError: Error {
    case unavailable
}

private actor ControlledMessageInteractionBackend: ChatBackend, MomoMessageInteractionBackend {
    private let base: LiveChatBackend
    private var editResponseArrived = false
    private var editArrivalWaiters: [CheckedContinuation<Void, Never>] = []
    private var editResponseRelease: CheckedContinuation<Void, Never>?
    private var reactionRequestArrived = false
    private var reactionArrivalWaiters: [CheckedContinuation<Void, Never>] = []
    private var reactionRequestRelease: CheckedContinuation<Void, Never>?
    private var reactionRequestShouldFail = false
    private var deleteRequestsShouldFail = false

    init(base: LiveChatBackend) {
        self.base = base
    }

    func waitForEditResponse() async {
        if editResponseArrived { return }
        await withCheckedContinuation { continuation in
            editArrivalWaiters.append(continuation)
        }
    }

    func releaseEditResponse() {
        editResponseRelease?.resume()
        editResponseRelease = nil
    }

    func waitForReactionRequest() async {
        if reactionRequestArrived { return }
        await withCheckedContinuation { continuation in
            reactionArrivalWaiters.append(continuation)
        }
    }

    func cancelReactionRequest() {
        reactionRequestRelease?.resume()
        reactionRequestRelease = nil
    }

    func failReactionRequest() {
        reactionRequestShouldFail = true
        reactionRequestRelease?.resume()
        reactionRequestRelease = nil
    }

    func failDeleteRequests() {
        deleteRequestsShouldFail = true
    }

    func emitLateReaction(_ id: MessageID, emoji: String) async {
        try? await base.addReaction(id, emoji: emoji)
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        try await base.history(channel: channel, after: seq, limit: limit)
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
        let edited = try await base.editMessage(id, body: body)
        editResponseArrived = true
        editArrivalWaiters.forEach { $0.resume() }
        editArrivalWaiters = []
        await withCheckedContinuation { continuation in
            editResponseRelease = continuation
        }
        return edited
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {
        reactionRequestArrived = true
        reactionArrivalWaiters.forEach { $0.resume() }
        reactionArrivalWaiters = []
        await withCheckedContinuation { continuation in
            reactionRequestRelease = continuation
        }
        if reactionRequestShouldFail {
            throw ControlledMessageInteractionError.reactionFailed
        }
        throw CancellationError()
    }

    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] {
        try await base.reactionSnapshot(channel: channel)
    }

    func removeReaction(_ id: MessageID, emoji: String) async throws {
        try await base.removeReaction(id, emoji: emoji)
    }

    func deleteMessage(_ id: MessageID) async throws -> Message {
        if deleteRequestsShouldFail {
            throw ControlledMessageInteractionError.deleteFailed
        }
        return try await base.deleteMessage(id)
    }

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }
}

private enum ControlledMessageInteractionError: Error {
    case reactionFailed
    case deleteFailed
}

private actor MissingAuthoritativeIdentityBackend: ChatBackend, MomoMessageInteractionBackend, ServerRosterSourceOfTruth {
    private let base: LiveChatBackend

    init(base: LiveChatBackend) {
        self.base = base
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        try await base.history(channel: channel, after: seq, limit: limit)
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

    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] {
        try await base.reactionSnapshot(channel: channel)
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
