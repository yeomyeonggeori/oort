import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

final class MomoChannelCreationTests: XCTestCase {
    func testChannelCreationValidationMatchesServerContract() {
        XCTAssertEqual(
            MomoChannelCreationValidation(name: "", topic: "").nameError,
            .required
        )
        XCTAssertEqual(
            MomoChannelCreationValidation(name: "Product Planning", topic: "").nameError,
            .unsupportedCharacters
        )
        XCTAssertEqual(
            MomoChannelCreationValidation(name: String(repeating: "a", count: 81), topic: "").nameError,
            .tooLong
        )
        XCTAssertEqual(
            MomoChannelCreationValidation(
                name: "product_planning-2",
                topic: String(repeating: "가", count: 281)
            ).topicError,
            .tooLong
        )
        XCTAssertTrue(
            MomoChannelCreationValidation(
                name: "product_planning-2",
                topic: "한국어와 English가 함께 있는 제품 기획"
            ).isValid
        )
        XCTAssertTrue(
            MomoChannelCreationValidation(name: " Product-Planning ", topic: "").isValid
        )
        XCTAssertEqual(
            MomoChannelCreationValidation.normalizedName(" Product-Planning "),
            "product-planning"
        )
    }

    func testChannelCreationCopyIsLocalizedAndActionable() {
        let korean = MomoWorkspaceCopy(language: .korean)
        let english = MomoWorkspaceCopy(language: .english)

        XCTAssertEqual(korean.createChannelAction, "채널 만들기")
        XCTAssertEqual(english.createChannelAction, "Create channel")
        XCTAssertTrue(korean.channelCreateErrorMessage(.duplicateName).contains("다른 이름"))
        XCTAssertTrue(english.channelCreateErrorMessage(.permissionDenied).contains("workspace admin"))
    }

    func testChannelCreationFeedbackClearsWhenAnyInputChanges() {
        for issue in [
            MomoChannelCreateIssue.duplicateName,
            .permissionDenied,
            .connection,
        ] {
            var feedback = MomoChannelCreationFeedback(issue: issue)
            feedback.clearForInputChange()
            XCTAssertNil(feedback.issue)
        }
    }

    func testSubmissionRevisionRejectsDelayedResultAfterInputChange() {
        var submission = MomoChannelCreationSubmissionState()
        let attempt = submission.begin()

        submission.inputDidChange()

        XCTAssertFalse(submission.isCurrent(attempt))
        XCTAssertFalse(submission.finish(attempt))
        XCTAssertNil(submission.attemptID)
    }

    @MainActor
    func testCancelledScheduledSubmissionDoesNotCallCreateOperation() async {
        var createCalls = 0
        let task = Task { @MainActor in
            await MomoChannelCreationSubmitCoordinator.run(
                expectedSessionGeneration: 7,
                isAttemptCurrent: { true },
                currentSessionGeneration: { 7 },
                create: {
                    createCalls += 1
                    return true
                }
            )
        }

        task.cancel()
        let result = await task.value

        XCTAssertNil(result)
        XCTAssertEqual(createCalls, 0)
    }

    func testAuthenticationCompletionDismissesWithoutLocalUnavailableError() {
        XCTAssertEqual(
            MomoChannelCreationCompletion.resolve(
                created: false,
                localIssue: nil,
                connectionIssue: .authenticationExpired
            ),
            .dismiss
        )
        XCTAssertEqual(
            MomoChannelCreationCompletion.resolve(
                created: false,
                localIssue: .duplicateName,
                connectionIssue: nil
            ),
            .showIssue(.duplicateName)
        )
        XCTAssertEqual(
            MomoChannelCreationCompletion.resolve(
                created: false,
                localIssue: nil,
                connectionIssue: nil
            ),
            .ignore
        )
    }

    func testPreexistingAuthenticationExpiryDismissesBeforePresentation() {
        XCTAssertTrue(
            MomoChannelCreationCompletion.shouldDismissBeforePresentation(
                connectionIssue: .authenticationExpired
            )
        )
        XCTAssertFalse(
            MomoChannelCreationCompletion.shouldDismissBeforePresentation(
                connectionIssue: .loadFailed
            )
        )
        XCTAssertFalse(
            MomoChannelCreationCompletion.shouldDismissBeforePresentation(connectionIssue: nil)
        )
    }

    func testChannelCreationIssuesClassifyRESTAndConnectionFailures() {
        XCTAssertEqual(
            ChatViewModel.channelCreateIssue(
                for: BackendError.problem(status: 409, title: "Conflict", detail: nil)
            ),
            .duplicateName
        )
        XCTAssertEqual(
            ChatViewModel.channelCreateIssue(
                for: BackendError.problem(status: 403, title: "Forbidden", detail: nil)
            ),
            .permissionDenied
        )
        XCTAssertEqual(
            ChatViewModel.channelCreateIssue(for: BackendError.realtime("offline")),
            .connection
        )
        XCTAssertNil(
            ChatViewModel.channelCreateIssue(
                for: BackendError.problem(status: 401, title: "Unauthorized", detail: nil)
            )
        )
        XCTAssertNil(ChatViewModel.channelCreateIssue(for: BackendError.notConnected))
    }

    @MainActor
    func testChannelCreationNormalizesLikeServerAndKeepsFailureLocal() async {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "test")
        viewModel.setChannels(seed.channels)

        let created = await viewModel.createChannel(
            kind: .publicChannel,
            name: " Product-Planning "
        )
        XCTAssertTrue(created)
        XCTAssertEqual(viewModel.selectedChannel?.name, "product-planning")

        let duplicate = await viewModel.createChannel(kind: .publicChannel, name: " GENERAL ")
        XCTAssertFalse(duplicate)
        XCTAssertEqual(viewModel.channelCreateIssue, .duplicateName)
        XCTAssertNil(viewModel.connectionError)
        XCTAssertNil(viewModel.connectionIssue)
    }

    @MainActor
    func testDelayedSuccessCannotOverwriteRebootstrappedSessionOrNewInFlightState() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let staleChannelID = ChannelID(uuidString: "00000000-0000-7000-8000-000000384101")!
        let currentChannelID = ChannelID(uuidString: "00000000-0000-7000-8000-000000384102")!
        let backend = ControlledChannelCreateBackend(
            base: liveBackend,
            outcomes: [
                .success(Self.createResult(workspace: seed.workspace, channel: staleChannelID, name: "stale")),
                .success(Self.createResult(workspace: seed.workspace, channel: currentChannelID, name: "current")),
            ]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "old-session")

        let staleCreate = Task {
            await viewModel.createChannel(kind: .publicChannel, name: "stale")
        }
        await backend.waitForCreateCall(1)
        XCTAssertTrue(viewModel.channelCreateInFlight)

        await viewModel.clearSessionSensitiveState()
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "new-session")
        let currentCreate = Task {
            await viewModel.createChannel(kind: .privateChannel, name: "current")
        }
        await backend.waitForCreateCall(2)
        XCTAssertTrue(viewModel.channelCreateInFlight)

        await backend.releaseCreateCall(1)
        let staleCreated = await staleCreate.value
        XCTAssertFalse(staleCreated)
        XCTAssertTrue(viewModel.channelCreateInFlight, "stale defer must not clear the new session operation")
        XCTAssertFalse(viewModel.channels.contains { $0.id == staleChannelID })

        await backend.releaseCreateCall(2)
        let currentCreated = await currentCreate.value
        XCTAssertTrue(currentCreated)
        XCTAssertFalse(viewModel.channelCreateInFlight)
        XCTAssertEqual(viewModel.selectedChannelId, currentChannelID)
        XCTAssertTrue(viewModel.channels.contains { $0.id == currentChannelID })
    }

    @MainActor
    func testDelayedConflictIsIgnoredAfterSheetInputCancellation() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let backend = ControlledChannelCreateBackend(
            base: liveBackend,
            outcomes: [.failure(.problem(status: 409, title: "Conflict", detail: "duplicate"))]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "session")

        let create = Task {
            await viewModel.createChannel(kind: .publicChannel, name: "duplicate")
        }
        await backend.waitForCreateCall(1)
        viewModel.cancelChannelCreation()
        await backend.releaseCreateCall(1)

        let didCreate = await create.value
        XCTAssertFalse(didCreate)
        XCTAssertFalse(viewModel.channelCreateInFlight)
        XCTAssertNil(viewModel.channelCreateIssue)
        XCTAssertNil(viewModel.connectionIssue)
    }

    @MainActor
    func testDelayedErrorCannotPublishIntoClearedAndRebootstrappedSession() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let backend = ControlledChannelCreateBackend(
            base: liveBackend,
            outcomes: [.failure(.problem(status: 409, title: "Conflict", detail: "stale duplicate"))]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "old-session")

        let create = Task {
            await viewModel.createChannel(kind: .publicChannel, name: "stale-error")
        }
        await backend.waitForCreateCall(1)
        await viewModel.clearSessionSensitiveState()
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "new-session")
        await backend.releaseCreateCall(1)

        let didCreate = await create.value
        XCTAssertFalse(didCreate)
        XCTAssertFalse(viewModel.channelCreateInFlight)
        XCTAssertNil(viewModel.channelCreateIssue)
        XCTAssertNil(viewModel.connectionIssue)
    }

    @MainActor
    func testUnauthorizedCreateUsesGlobalAuthenticationRecoveryOnly() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let backend = ControlledChannelCreateBackend(
            base: liveBackend,
            outcomes: [.failure(.problem(status: 401, title: "Unauthorized", detail: "expired"))]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "expired")

        let create = Task {
            await viewModel.createChannel(kind: .publicChannel, name: "auth-test")
        }
        await backend.waitForCreateCall(1)
        await backend.releaseCreateCall(1)

        let didCreate = await create.value
        XCTAssertFalse(didCreate)
        XCTAssertNil(viewModel.channelCreateIssue)
        XCTAssertEqual(viewModel.connectionIssue, .authenticationExpired)
        XCTAssertFalse(viewModel.channelCreateInFlight)
    }

    @MainActor
    func testNotConnectedCreateUsesGlobalAuthenticationRecoveryOnly() async {
        let backend = LiveChatBackend()
        let viewModel = ChatViewModel(backend: backend)

        let didCreate = await viewModel.createChannel(kind: .publicChannel, name: "auth-test")

        XCTAssertFalse(didCreate)
        XCTAssertNil(viewModel.channelCreateIssue)
        XCTAssertEqual(viewModel.connectionIssue, .authenticationExpired)
        XCTAssertFalse(viewModel.channelCreateInFlight)
    }

    @MainActor
    func testCreateDoesNotReachBackendWhileSessionClearIsPending() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let backend = ControlledChannelCreateBackend(
            base: liveBackend,
            outcomes: [],
            blockClear: true
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "session")

        let clear = Task { await viewModel.clearSessionSensitiveState() }
        await backend.waitForClearCall()

        let didCreate = await viewModel.createChannel(kind: .publicChannel, name: "during-clear")
        let createCalls = await backend.createCalls()

        XCTAssertFalse(didCreate)
        XCTAssertEqual(createCalls, 0)
        XCTAssertNil(viewModel.channelCreateIssue)
        await backend.releaseClearCall()
        await clear.value
    }

    @MainActor
    func testCreateDoesNotReachBackendDuringSameWorkspaceRebootstrap() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let backend = ControlledChannelCreateBackend(
            base: liveBackend,
            outcomes: [],
            blockedChannelsCall: 2
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "first-session")

        let rebootstrap = Task {
            await viewModel.bootstrap(workspace: seed.workspace, accessToken: "second-session")
        }
        await backend.waitForChannelsCall(2)

        let didCreate = await viewModel.createChannel(kind: .publicChannel, name: "during-bootstrap")
        let createCalls = await backend.createCalls()

        XCTAssertFalse(didCreate)
        XCTAssertEqual(createCalls, 0)
        XCTAssertNil(viewModel.channelCreateIssue)
        await backend.releaseChannelsCall(2)
        await rebootstrap.value
    }

    private static func createResult(
        workspace: WorkspaceID,
        channel: ChannelID,
        name: String
    ) -> ChannelCreateResult {
        ChannelCreateResult(
            channel: Channel(
                id: channel,
                workspaceId: workspace,
                kind: .publicChannel,
                name: name,
                createdBy: .demoHuman
            ),
            creatorMembership: ChannelMembership(
                workspaceId: workspace,
                channelId: channel,
                memberId: .demoHuman,
                role: .owner,
                joinedAtMs: 1
            )
        )
    }

    func testQuickTooltipPlacementStaysInsideWindowScreenAndPrefersBelow() {
        let visible = CGRect(x: 0, y: 0, width: 1_200, height: 800)
        let tooltip = CGSize(width: 240, height: 40)
        let nearRightPaneBoundary = CGRect(x: 1_170, y: 620, width: 24, height: 24)
        let origin = MomoQuickTooltipPlacement.origin(
            anchor: nearRightPaneBoundary,
            tooltipSize: tooltip,
            visibleFrame: visible
        )

        XCTAssertLessThanOrEqual(origin.x + tooltip.width, visible.maxX - 8)
        XCTAssertEqual(origin.y, nearRightPaneBoundary.maxY + 8)

        let nearBottom = CGRect(x: 12, y: 770, width: 24, height: 24)
        let fallback = MomoQuickTooltipPlacement.origin(
            anchor: nearBottom,
            tooltipSize: tooltip,
            visibleFrame: visible
        )
        XCTAssertGreaterThanOrEqual(fallback.x, visible.minX + 8)
        XCTAssertLessThan(fallback.y, nearBottom.minY)
    }

    func testQuickTooltipPlacementUsesTheSameRootCoordinatesAcrossWindowSizes() {
        let tooltip = CGSize(width: 280, height: 64)
        for windowSize in [
            CGSize(width: 980, height: 620),
            CGSize(width: 1_180, height: 760),
            CGSize(width: 1_980, height: 1_270),
        ] {
            let visible = CGRect(origin: .zero, size: windowSize)
            let anchor = CGRect(x: 260, y: 120, width: 24, height: 24)
            let origin = MomoQuickTooltipPlacement.origin(
                anchor: anchor,
                tooltipSize: tooltip,
                visibleFrame: visible
            )
            XCTAssertGreaterThanOrEqual(origin.x, 8)
            XCTAssertGreaterThanOrEqual(origin.y, 8)
            XCTAssertLessThanOrEqual(origin.x + tooltip.width, windowSize.width - 8)
            XCTAssertLessThanOrEqual(origin.y + tooltip.height, windowSize.height - 8)
            XCTAssertEqual(origin.y, anchor.maxY + 8)
        }
    }

    @MainActor
    func testQuickTooltipPresenterRestoresFocusedSourceAfterHoveredSourceLeaves() {
        let presenter = MomoQuickTooltipPresenter()
        let first = UUID()
        let second = UUID()
        presenter.update(
            sourceID: first,
            text: "새 채널",
            anchor: CGRect(x: 10, y: 10, width: 24, height: 24),
            isHovering: false,
            isFocused: true
        )
        presenter.present(sourceID: first)
        presenter.update(
            sourceID: second,
            text: "멤버 초대",
            anchor: CGRect(x: 40, y: 10, width: 24, height: 24),
            isHovering: true,
            isFocused: false
        )
        presenter.present(sourceID: second)

        XCTAssertEqual(presenter.item?.sourceID, second)
        XCTAssertEqual(presenter.item?.text, "멤버 초대")

        presenter.update(
            sourceID: second,
            text: "멤버 초대",
            anchor: CGRect(x: 40, y: 10, width: 24, height: 24),
            isHovering: false,
            isFocused: false
        )
        XCTAssertEqual(presenter.item?.sourceID, first)
        XCTAssertEqual(presenter.item?.text, "새 채널")
    }

    @MainActor
    func testQuickTooltipPresenterUpdatesVisibleCopyAndDismissesEmptyCopy() {
        let presenter = MomoQuickTooltipPresenter()
        let source = UUID()
        let anchor = CGRect(x: 10, y: 10, width: 24, height: 24)
        presenter.update(
            sourceID: source,
            text: "새 채널",
            anchor: anchor,
            isHovering: true,
            isFocused: false
        )
        presenter.present(sourceID: source)

        presenter.update(
            sourceID: source,
            text: "Create channel",
            anchor: anchor,
            isHovering: true,
            isFocused: false
        )
        XCTAssertEqual(presenter.item?.text, "Create channel")

        presenter.update(
            sourceID: source,
            text: "",
            anchor: anchor,
            isHovering: true,
            isFocused: false
        )
        XCTAssertNil(presenter.item)
    }

    @MainActor
    func testShortTooltipUsesCompactIntrinsicWidth() {
        let hostingView = NSHostingView(
            rootView: MomoQuickTooltipLabel(text: "새 채널")
        )
        hostingView.layoutSubtreeIfNeeded()
        let intrinsicSize = hostingView.fittingSize

        XCTAssertLessThan(intrinsicSize.width, 120)
        XCTAssertEqual(
            MomoQuickTooltipMeasurement.constrainedWidth(for: intrinsicSize.width),
            intrinsicSize.width
        )
        XCTAssertEqual(
            MomoQuickTooltipMeasurement.constrainedWidth(for: 640),
            MomoTheme.QuickTooltip.maximumWidth
        )
    }

    @MainActor
    func testLongMixedLanguageTooltipWrapsWithoutVerticalClipping() {
        let hostingView = NSHostingView(
            rootView: MomoQuickTooltipLabel(
                text: "전체 멤버 디렉터리를 열고 한국어와 English가 함께 있는 긴 설명을 세 줄 안에서 확인합니다"
            )
            .frame(width: MomoTheme.QuickTooltip.maximumWidth)
        )
        hostingView.layoutSubtreeIfNeeded()
        let size = hostingView.fittingSize

        XCTAssertLessThanOrEqual(size.width, MomoTheme.QuickTooltip.maximumWidth)
        XCTAssertGreaterThan(size.height, 32)
    }

    @MainActor
    func testVisualTooltipLabelIsHiddenFromAccessibilityTree() {
        let hostingView = NSHostingView(rootView: MomoQuickTooltipLabel(text: "새 채널"))
        hostingView.frame = CGRect(x: 0, y: 0, width: 120, height: 40)
        hostingView.layoutSubtreeIfNeeded()

        XCTAssertTrue(hostingView.accessibilityChildren()?.isEmpty ?? true)
    }
}

private actor ControlledChannelCreateBackend: ChatBackend, MomoSessionSensitiveStateClearing {
    enum Outcome: Sendable {
        case success(ChannelCreateResult)
        case failure(BackendError)
    }

    private let base: LiveChatBackend
    private let outcomes: [Outcome]
    private let blockClear: Bool
    private let blockedChannelsCall: Int?
    private var createCallCount = 0
    private var channelsCallCount = 0
    private var arrivedCalls: Set<Int> = []
    private var arrivalWaiters: [Int: [CheckedContinuation<Void, Never>]] = [:]
    private var releaseWaiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var clearArrived = false
    private var clearArrivalWaiters: [CheckedContinuation<Void, Never>] = []
    private var clearReleaseWaiter: CheckedContinuation<Void, Never>?
    private var arrivedChannelsCalls: Set<Int> = []
    private var channelsArrivalWaiters: [Int: [CheckedContinuation<Void, Never>]] = [:]
    private var channelsReleaseWaiters: [Int: CheckedContinuation<Void, Never>] = [:]

    init(
        base: LiveChatBackend,
        outcomes: [Outcome],
        blockClear: Bool = false,
        blockedChannelsCall: Int? = nil
    ) {
        self.base = base
        self.outcomes = outcomes
        self.blockClear = blockClear
        self.blockedChannelsCall = blockedChannelsCall
    }

    func createCalls() -> Int { createCallCount }

    func waitForClearCall() async {
        if clearArrived { return }
        await withCheckedContinuation { continuation in
            clearArrivalWaiters.append(continuation)
        }
    }

    func releaseClearCall() {
        clearReleaseWaiter?.resume()
        clearReleaseWaiter = nil
    }

    func waitForChannelsCall(_ call: Int) async {
        if arrivedChannelsCalls.contains(call) { return }
        await withCheckedContinuation { continuation in
            channelsArrivalWaiters[call, default: []].append(continuation)
        }
    }

    func releaseChannelsCall(_ call: Int) {
        channelsReleaseWaiters.removeValue(forKey: call)?.resume()
    }

    func waitForCreateCall(_ call: Int) async {
        if arrivedCalls.contains(call) { return }
        await withCheckedContinuation { continuation in
            arrivalWaiters[call, default: []].append(continuation)
        }
    }

    func releaseCreateCall(_ call: Int) {
        releaseWaiters.removeValue(forKey: call)?.resume()
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
        channelsCallCount += 1
        let call = channelsCallCount
        arrivedChannelsCalls.insert(call)
        let waiters = channelsArrivalWaiters.removeValue(forKey: call) ?? []
        waiters.forEach { $0.resume() }
        if blockedChannelsCall == call {
            await withCheckedContinuation { continuation in
                channelsReleaseWaiters[call] = continuation
            }
        }
        return try await base.channels(workspace: workspace)
    }

    func clearSessionSensitiveState() async {
        clearArrived = true
        clearArrivalWaiters.forEach { $0.resume() }
        clearArrivalWaiters = []
        if blockClear {
            await withCheckedContinuation { continuation in
                clearReleaseWaiter = continuation
            }
        }
        await base.clearSessionSensitiveState()
    }

    func createChannel(
        workspace: WorkspaceID,
        kind: ChannelKind,
        name: String,
        topic: String?
    ) async throws -> ChannelCreateResult {
        createCallCount += 1
        let call = createCallCount
        arrivedCalls.insert(call)
        let waiters = arrivalWaiters.removeValue(forKey: call) ?? []
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { continuation in
            releaseWaiters[call] = continuation
        }
        switch outcomes[call - 1] {
        case .success(let result):
            return result
        case .failure(let error):
            throw error
        }
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

@MainActor
final class MomoChannelCreationSnapshotTests: XCTestCase {
    override nonisolated func invokeTest() {
        if ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" {
            withSnapshotTesting(record: .all) {
                super.invokeTest()
            }
        } else {
            super.invokeTest()
        }
    }

    private func render(
        language: MomoUILanguage,
        scheme: ColorScheme,
        increasedContrast: Bool = false,
        dynamicTypeSize: DynamicTypeSize = .large,
        size: CGSize = CGSize(width: 560, height: 480)
    ) async throws -> NSImage {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot")
        viewModel.setChannels(seed.channels)

        let hostingView = NSHostingView(
            rootView: MomoChannelCreationSheet(
                viewModel: viewModel,
                copy: MomoWorkspaceCopy(language: language),
                dismiss: {}
            )
            .frame(width: size.width, height: size.height)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, dynamicTypeSize)
        )
        hostingView.frame = CGRect(origin: .zero, size: size)
        let appearanceName: NSAppearance.Name
        if increasedContrast {
            appearanceName = scheme == .dark ? .accessibilityHighContrastDarkAqua : .accessibilityHighContrastAqua
        } else {
            appearanceName = scheme == .dark ? .darkAqua : .aqua
        }
        hostingView.appearance = NSAppearance(named: appearanceName)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * 2),
            pixelsHigh: Int(size.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            throw XCTSkip("NSHostingView produced no channel creation bitmap")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    func testChannelCreationSheetKoreanLightSnapshot() async throws {
        let image = try await render(language: .korean, scheme: .light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "korean-light"
        )
    }

    func testChannelCreationSheetEnglishDarkSnapshot() async throws {
        let image = try await render(language: .english, scheme: .dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "english-dark"
        )
    }

    func testChannelCreationSheetKoreanIncreasedContrastSnapshot() async throws {
        let image = try await render(
            language: .korean,
            scheme: .light,
            increasedContrast: true
        )
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "korean-increased-contrast"
        )
    }

    func testChannelCreationSheetEnglishLargeTextSnapshot() async throws {
        let image = try await render(
            language: .english,
            scheme: .dark,
            dynamicTypeSize: .accessibility2,
            size: CGSize(width: 680, height: 600)
        )
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "english-large-text"
        )
    }
}
