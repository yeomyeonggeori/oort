import XCTest
import MomoCore
@testable import MomoMac

final class ChannelNotificationPreferenceTests: XCTestCase {
    @MainActor
    func testLiveBackendCapabilityTogglesMuteWithoutChangingUnreadProjection() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo-token")
        let channel = try XCTUnwrap(seed.channels.first)
        let unreadBefore = viewModel.readStatesByChannel[channel.id]

        XCTAssertTrue(viewModel.supportsChannelNotificationSettings)
        XCTAssertFalse(viewModel.isChannelMuted(channel.id))

        let didMute = await viewModel.setChannelMuted(channel.id, muted: true)
        XCTAssertTrue(didMute)
        XCTAssertTrue(viewModel.isChannelMuted(channel.id))
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id], unreadBefore)
        XCTAssertNil(viewModel.channelNotificationErrors[channel.id])

        let didUnmute = await viewModel.toggleChannelMuted(channel.id)
        XCTAssertTrue(didUnmute)
        XCTAssertFalse(viewModel.isChannelMuted(channel.id))
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id], unreadBefore)
    }

    @MainActor
    func testSessionClearRemovesChannelNotificationSidecars() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo-token")
        let channel = try XCTUnwrap(seed.channels.first)
        let didMute = await viewModel.setChannelMuted(channel.id, muted: true)
        XCTAssertTrue(didMute)

        await viewModel.clearSessionSensitiveState()

        XCTAssertTrue(viewModel.channelMuteStates.isEmpty)
        XCTAssertTrue(viewModel.channelMuteMutationIds.isEmpty)
        XCTAssertTrue(viewModel.channelNotificationErrors.isEmpty)
    }

    @MainActor
    func testCancelledMuteRequestRollsBackOptimisticStateWithoutShowingFailure() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let backend = CancelledChannelNotificationBackend(base: liveBackend)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo-token")
        let channel = try XCTUnwrap(seed.channels.first)

        let didMute = await viewModel.setChannelMuted(channel.id, muted: true)

        XCTAssertFalse(didMute)
        XCTAssertFalse(viewModel.isChannelMuted(channel.id))
        XCTAssertNil(viewModel.channelNotificationErrors[channel.id])
        XCTAssertNil(viewModel.connectionIssue)
    }

    @MainActor
    func testOpeningExistingMutedDirectMessagePreservesAuthoritativeMuteState() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo-token")
        let target = try XCTUnwrap(seed.agents.first)

        let existingDirectMessage = try await backend.openDirectMessage(
            workspace: seed.workspace,
            with: target.id
        )
        _ = try await backend.setChannelMuted(existingDirectMessage.id, muted: true)
        XCTAssertFalse(viewModel.channels.contains(where: { $0.id == existingDirectMessage.id }))

        let outcome = await viewModel.startDirectMessage(with: target.id)

        XCTAssertEqual(outcome, .opened(existingDirectMessage.id))
        XCTAssertTrue(viewModel.channels.contains(where: { $0.id == existingDirectMessage.id }))
        XCTAssertTrue(viewModel.isChannelMuted(existingDirectMessage.id))
    }
}

private actor CancelledChannelNotificationBackend: ChatBackend, MomoChannelNotificationBackend {
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

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }

    func channelMuteSnapshot(workspace: WorkspaceID) async -> [ChannelID: Bool] {
        await base.channelMuteSnapshot(workspace: workspace)
    }

    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool {
        throw CancellationError()
    }
}
