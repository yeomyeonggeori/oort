import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class MomoHuddleViewModelTests: XCTestCase {
    func testComposerControlDistinguishesHuddleLifecycleStates() {
        XCTAssertEqual(
            MomoHuddleComposerControlPresentation.resolve(
                state: .idle,
                hasActiveHuddle: false,
                isChannelSelected: true
            ),
            .init(systemImage: "waveform", tone: .accent)
        )
        XCTAssertEqual(
            MomoHuddleComposerControlPresentation.resolve(
                state: .idle,
                hasActiveHuddle: true,
                isChannelSelected: true
            ),
            .init(systemImage: "person.wave.2", tone: .accent)
        )
        XCTAssertEqual(
            MomoHuddleComposerControlPresentation.resolve(
                state: .joined,
                hasActiveHuddle: true,
                isChannelSelected: true
            ),
            .init(systemImage: "waveform.circle.fill", tone: .success)
        )
        XCTAssertEqual(
            MomoHuddleComposerControlPresentation.resolve(
                state: .failed("연결 실패"),
                hasActiveHuddle: true,
                isChannelSelected: true
            ),
            .init(systemImage: "arrow.clockwise", tone: .warning)
        )
        XCTAssertEqual(
            MomoHuddleComposerControlPresentation.resolve(
                state: .unavailable("서버 연결 필요"),
                hasActiveHuddle: false,
                isChannelSelected: true
            ),
            .init(systemImage: "waveform.slash", tone: .secondary)
        )
        XCTAssertEqual(
            MomoHuddleComposerControlPresentation.resolve(
                state: .idle,
                hasActiveHuddle: false,
                isChannelSelected: false
            ),
            .init(systemImage: "waveform.slash", tone: .secondary)
        )
    }

    func testComposerControlExposesBlockedReasonsAsKeyboardActions() {
        XCTAssertEqual(
            MomoHuddleComposerControlAction.resolve(
                state: .unavailable("momo 서버에 연결하세요."),
                isChannelSelected: true,
                noChannelReason: "채널을 선택하세요.",
                connectingReason: "허들 연결 중"
            ),
            .explain("momo 서버에 연결하세요.")
        )
        XCTAssertEqual(
            MomoHuddleComposerControlAction.resolve(
                state: .idle,
                isChannelSelected: false,
                noChannelReason: "채널을 선택하세요.",
                connectingReason: "허들 연결 중"
            ),
            .explain("채널을 선택하세요.")
        )
        XCTAssertEqual(
            MomoHuddleComposerControlAction.resolve(
                state: .connecting,
                isChannelSelected: true,
                noChannelReason: "채널을 선택하세요.",
                connectingReason: "허들 연결 중"
            ),
            .explain("허들 연결 중")
        )
        XCTAssertEqual(
            MomoHuddleComposerControlAction.resolve(
                state: .joined,
                isChannelSelected: true,
                noChannelReason: "채널을 선택하세요.",
                connectingReason: "허들 연결 중"
            ),
            .openPanel
        )
        XCTAssertEqual(
            MomoHuddleComposerControlAction.resolve(
                state: .idle,
                isChannelSelected: true,
                noChannelReason: "채널을 선택하세요.",
                connectingReason: "허들 연결 중"
            ),
            .startOrJoin
        )
        XCTAssertEqual(
            MomoHuddleComposerControlAction.resolve(
                state: .failed("연결 실패"),
                isChannelSelected: true,
                noChannelReason: "채널을 선택하세요.",
                connectingReason: "허들 연결 중"
            ),
            .retry
        )
    }

    func testUnavailableAndFailureCopyLocalizesWithoutDiagnosticText() {
        let diagnostic = "Sign in with MOMO_SERVER_BASE_URL credentials."
        let korean = MomoHuddleCopy(language: .korean)
        let english = MomoHuddleCopy(language: .english)

        XCTAssertEqual(
            english.localizedUnavailableReason(MomoHuddleViewModel.serverConnectionRequiredReason),
            "Connect to a momo server to use huddles."
        )
        XCTAssertEqual(
            english.localizedUnavailableReason(MomoHuddleViewModel.authenticationRequiredReason),
            "Huddles are unavailable. Sign in again and retry."
        )
        XCTAssertEqual(
            korean.localizedUnavailableReason(diagnostic),
            "지금은 허들을 사용할 수 없어요. 잠시 후 다시 시도해 주세요."
        )
        XCTAssertFalse(korean.localizedUnavailableReason(diagnostic).contains("MOMO_SERVER_BASE_URL"))
        XCTAssertFalse(english.connectionFailedReason.contains("credentials"))
    }

    func testStartConnectsAudioAndTransitionsToJoined() async {
        let fixture = HuddleFixture()
        let service = MockHuddleService(active: nil, huddle: fixture.huddle)
        let audio = MockHuddleAudioSession()
        let viewModel = MomoHuddleViewModel(service: service, audioSession: audio)

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)
        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.startOrJoin()

        let connectCount = await audio.connectCount()
        XCTAssertEqual(viewModel.state, .joined)
        XCTAssertEqual(viewModel.activeHuddle?.id, fixture.huddle.id)
        XCTAssertEqual(connectCount, 1)
        XCTAssertFalse(viewModel.isMicrophoneMuted)
        await viewModel.shutdown()
    }

    func testComposerStartUsesSingleFlightWhileJoinIsPending() async {
        let fixture = HuddleFixture()
        let service = MockHuddleService(
            active: nil,
            huddle: fixture.huddle,
            joinDelay: .milliseconds(100)
        )
        let audio = MockHuddleAudioSession()
        let viewModel = MomoHuddleViewModel(service: service, audioSession: audio)

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)
        viewModel.beginStartOrJoin()
        viewModel.beginStartOrJoin()
        try? await Task.sleep(for: .milliseconds(150))

        let startCount = await service.startCount()
        let joinCount = await service.joinCount()
        let connectCount = await audio.connectCount()
        XCTAssertEqual(viewModel.state, .joined)
        XCTAssertEqual(startCount, 1)
        XCTAssertEqual(joinCount, 1)
        XCTAssertEqual(connectCount, 1)
        await viewModel.shutdown()
    }

    func testUnconfiguredErrorUsesSafeUserReasonInsteadOfDiagnosticText() async {
        let fixture = HuddleFixture()
        let service = MockHuddleService(
            active: nil,
            huddle: fixture.huddle,
            activeError: MomoHuddleClientError.unavailable(
                "Sign in again or launch with MOMO_SERVER_BASE_URL credentials."
            )
        )
        let viewModel = MomoHuddleViewModel(service: service, audioSession: MockHuddleAudioSession())

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)

        XCTAssertEqual(
            viewModel.state,
            .unavailable(MomoHuddleViewModel.authenticationRequiredReason)
        )
        if case .unavailable(let reason) = viewModel.state {
            XCTAssertFalse(reason.contains("MOMO_SERVER_BASE_URL"))
            XCTAssertFalse(reason.contains("credentials"))
        } else {
            XCTFail("Expected unavailable huddle state")
        }
        await viewModel.shutdown()
    }

    func testMissingServiceAndWorkspaceUseUserFacingKoreanReasons() async {
        let fixture = HuddleFixture()
        let unavailable = MomoHuddleViewModel(service: nil)
        XCTAssertEqual(
            unavailable.state,
            .unavailable(MomoHuddleViewModel.serverConnectionRequiredReason)
        )

        let service = MockHuddleService(active: nil, huddle: fixture.huddle)
        let missingWorkspace = MomoHuddleViewModel(service: service)
        await missingWorkspace.activate(workspace: nil, channel: fixture.channel)
        XCTAssertEqual(
            missingWorkspace.state,
            .unavailable(MomoHuddleViewModel.workspaceRequiredReason)
        )
        await missingWorkspace.shutdown()
    }

    func testEndedRealtimeEventDisconnectsWithoutEndingEventSubscription() async {
        let fixture = HuddleFixture()
        let service = MockHuddleService(active: fixture.huddle, huddle: fixture.huddle)
        let audio = MockHuddleAudioSession()
        let viewModel = MomoHuddleViewModel(service: service, audioSession: audio)

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)
        await viewModel.startOrJoin()
        await viewModel.apply(HuddleDelta(
            action: .ended,
            huddleId: fixture.huddle.id,
            channelId: fixture.channel,
            participantMemberIds: []
        ))

        let disconnectCount = await audio.disconnectCount()
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertNil(viewModel.activeHuddle)
        XCTAssertGreaterThanOrEqual(disconnectCount, 1)
        await viewModel.shutdown()
    }

    func testLeaveDisconnectsAudioEvenWhenRESTLeaveFails() async {
        let fixture = HuddleFixture()
        let service = MockHuddleService(
            active: fixture.huddle,
            huddle: fixture.huddle,
            leaveError: MomoHuddleClientError.http(500, "leave failed")
        )
        let audio = MockHuddleAudioSession()
        let viewModel = MomoHuddleViewModel(service: service, audioSession: audio)

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)
        await viewModel.startOrJoin()
        await viewModel.leave()

        let disconnectCount = await audio.disconnectCount()
        let leaveCount = await service.leaveCount()
        XCTAssertEqual(viewModel.state, .failed("leave failed"))
        XCTAssertGreaterThanOrEqual(disconnectCount, 1)
        XCTAssertEqual(leaveCount, 1)
        await viewModel.shutdown()
    }

    func testShutdownWhileJoinIsPendingNeverConnectsAudio() async {
        let fixture = HuddleFixture()
        let service = MockHuddleService(active: fixture.huddle, huddle: fixture.huddle, joinDelay: .milliseconds(100))
        let audio = MockHuddleAudioSession()
        let viewModel = MomoHuddleViewModel(service: service, audioSession: audio)

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)
        let join = Task { await viewModel.startOrJoin() }
        try? await Task.sleep(for: .milliseconds(10))
        await viewModel.shutdown()
        await join.value

        let connectCount = await audio.connectCount()
        XCTAssertEqual(connectCount, 0)
        XCTAssertFalse(viewModel.isJoined)
    }

    func testPendingChannelActivationCannotResubscribeAfterShutdown() async {
        let fixture = HuddleFixture()
        let nextChannel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000202")!
        let service = MockHuddleService(active: fixture.huddle, huddle: fixture.huddle, joinDelay: .milliseconds(100))
        let viewModel = MomoHuddleViewModel(service: service, audioSession: MockHuddleAudioSession())

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)
        try? await Task.sleep(for: .milliseconds(10))
        let join = Task { await viewModel.startOrJoin() }
        try? await Task.sleep(for: .milliseconds(10))
        let switchChannel = Task { await viewModel.activate(workspace: fixture.workspace, channel: nextChannel) }
        try? await Task.sleep(for: .milliseconds(10))
        await viewModel.shutdown()
        await join.value
        await switchChannel.value

        let eventSubscriptionCount = await service.eventSubscriptionCount()
        XCTAssertEqual(eventSubscriptionCount, 1)
        XCTAssertNil(viewModel.activeHuddle)
        XCTAssertFalse(viewModel.isJoined)
    }
}

private struct HuddleFixture {
    let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
    let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
    let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!

    var huddle: MomoHuddle {
        MomoHuddle(
            id: UUID(uuidString: "00000000-0000-7000-8000-000000000501")!,
            workspaceId: workspace,
            channelId: channel,
            startedBy: member,
            startedAtMs: 1,
            endedAtMs: nil,
            participants: [MomoHuddleParticipant(memberId: member, displayName: "성재", joinedAtMs: 1)]
        )
    }
}

private actor MockHuddleService: MomoHuddleService {
    private var activeValue: MomoHuddle?
    private let huddle: MomoHuddle
    private let activeError: Error?
    private let leaveError: Error?
    private let joinDelay: Duration?
    private var recordedLeaveCount = 0
    private var recordedEventSubscriptionCount = 0
    private var recordedStartCount = 0
    private var recordedJoinCount = 0

    init(
        active: MomoHuddle?,
        huddle: MomoHuddle,
        activeError: Error? = nil,
        leaveError: Error? = nil,
        joinDelay: Duration? = nil
    ) {
        activeValue = active
        self.huddle = huddle
        self.activeError = activeError
        self.leaveError = leaveError
        self.joinDelay = joinDelay
    }

    func active(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle? {
        if let activeError { throw activeError }
        return activeValue
    }

    func start(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle {
        recordedStartCount += 1
        activeValue = huddle
        return huddle
    }

    func join(workspace: WorkspaceID, huddle: UUID) async throws -> MomoHuddleJoin {
        recordedJoinCount += 1
        if let joinDelay {
            await Task.detached { try? await Task.sleep(for: joinDelay) }.value
        }
        return MomoHuddleJoin(
            huddle: self.huddle,
            liveKitURL: URL(string: "ws://127.0.0.1:7880")!,
            token: "fixture-token",
            expiresAt: Date().addingTimeInterval(600)
        )
    }

    func leave(workspace: WorkspaceID, huddle: UUID) async throws {
        recordedLeaveCount += 1
        if let leaveError { throw leaveError }
        activeValue = nil
    }

    func events(workspace: WorkspaceID, channel: ChannelID) async throws -> AsyncStream<HuddleDelta> {
        recordedEventSubscriptionCount += 1
        return AsyncStream<HuddleDelta> { _ in }
    }

    func leaveCount() -> Int { recordedLeaveCount }
    func eventSubscriptionCount() -> Int { recordedEventSubscriptionCount }
    func startCount() -> Int { recordedStartCount }
    func joinCount() -> Int { recordedJoinCount }
}

private actor MockHuddleAudioSession: MomoHuddleAudioSession {
    private var recordedConnectCount = 0
    private var recordedDisconnectCount = 0
    private var muted = false

    func connect(url: URL, token: String) async throws {
        recordedConnectCount += 1
    }

    func disconnect() async {
        recordedDisconnectCount += 1
    }

    func setMicrophoneMuted(_ muted: Bool) async throws {
        self.muted = muted
    }

    func participantUpdates() async -> AsyncStream<[MomoHuddleAudioParticipant]> {
        AsyncStream { continuation in
            continuation.yield([])
        }
    }

    func connectCount() -> Int { recordedConnectCount }
    func disconnectCount() -> Int { recordedDisconnectCount }
}
