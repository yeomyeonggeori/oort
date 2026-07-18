import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class MomoHuddleViewModelTests: XCTestCase {
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

    func testUnconfigured503TransitionsToUnavailableWithReason() async {
        let fixture = HuddleFixture()
        let service = MockHuddleService(
            active: nil,
            huddle: fixture.huddle,
            activeError: MomoHuddleClientError.http(503, "허들 미구성")
        )
        let viewModel = MomoHuddleViewModel(service: service, audioSession: MockHuddleAudioSession())

        await viewModel.activate(workspace: fixture.workspace, channel: fixture.channel)

        XCTAssertEqual(viewModel.state, .unavailable("허들 미구성"))
        await viewModel.shutdown()
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
    private var recordedLeaveCount = 0

    init(active: MomoHuddle?, huddle: MomoHuddle, activeError: Error? = nil, leaveError: Error? = nil) {
        activeValue = active
        self.huddle = huddle
        self.activeError = activeError
        self.leaveError = leaveError
    }

    func active(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle? {
        if let activeError { throw activeError }
        return activeValue
    }

    func start(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle {
        activeValue = huddle
        return huddle
    }

    func join(workspace: WorkspaceID, huddle: UUID) async throws -> MomoHuddleJoin {
        MomoHuddleJoin(
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
        AsyncStream { _ in }
    }

    func leaveCount() -> Int { recordedLeaveCount }
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
