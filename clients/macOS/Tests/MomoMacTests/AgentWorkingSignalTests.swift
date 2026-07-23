import XCTest
import MomoCore
@testable import MomoMac

// MOMO-568: the agentWorkingSignal module is the single source of truth behind the
// sidebar channel-row badge, the composer rotating headline bar, and the timeline
// turn-liveness mark. These tests pin the resolver (pure) plus the ViewModel wiring
// so all three surfaces stay in lockstep, especially the buzz removal rule: a run
// that ends/cancels/fails must drop from every surface (well within the 3s bound).
final class AgentWorkingSignalResolverTests: XCTestCase {
    private let workspace = WorkspaceID()
    private let channel = ChannelID()

    private func agent(
        _ id: MemberID,
        name: String,
        active: Bool = true,
        inChannel: Bool = true
    ) -> Member {
        Member(
            id: id,
            workspaceId: workspace,
            kind: .agent,
            status: active ? .active : .invited,
            displayName: name,
            handle: name.lowercased(),
            channelIds: inChannel ? [channel] : []
        )
    }

    private func status(
        run: RunID,
        agent: MemberID,
        phase: AgentStatusPhase = .streaming,
        runStatus: RunStatus = .running
    ) -> AgentStatus {
        AgentStatus(
            runId: run,
            agentMemberId: agent,
            channelId: channel,
            phase: phase,
            runStatus: runStatus
        )
    }

    // MARK: Primary source

    func testStatusPrimarySourceProducesSignalWithLastLineHeadline() {
        let agentID = MemberID()
        let run = RunID()
        let started = Date(timeIntervalSince1970: 1_000)
        let partial = AgentPartial(
            runId: run,
            channelId: channel,
            textDelta: "MessageListView 구조를 확인했습니다.\n승인 후 Swift 테스트를 실행합니다."
        )

        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [status(run: run, agent: agentID)],
            partials: [run: partial],
            workRuns: [],
            typingAgentIDs: [],
            startTimes: [run: started],
            now: started.addingTimeInterval(12)
        )

        XCTAssertEqual(signals.count, 1)
        let signal = try? XCTUnwrap(signals.first)
        XCTAssertEqual(signal?.agentId, agentID)
        XCTAssertEqual(signal?.source, .status)
        XCTAssertEqual(signal?.startedAt, started)
        XCTAssertEqual(signal?.elapsed(at: started.addingTimeInterval(12)), 12)
        XCTAssertEqual(signal?.headlines.first, "승인 후 Swift 테스트를 실행합니다.")
        XCTAssertTrue(signal?.hasHeadline == true)
    }

    func testWorkRunUsesOwnStartClockAndTitleHeadline() {
        let agentID = MemberID()
        let run = RunID()
        let workRun = AgentWorkRun(
            id: run,
            workspaceId: workspace,
            agentMemberId: agentID,
            channelId: channel,
            status: .running,
            input: AgentWorkInput(title: "macOS 테스트 실패 수정", brief: "완료 조건을 지키세요."),
            startedAtMs: 5_000_000,
            createdAtMs: 4_000_000,
            updatedAtMs: 5_000_000
        )

        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [],
            partials: [:],
            workRuns: [workRun],
            typingAgentIDs: [],
            startTimes: [:],
            now: Date()
        )

        XCTAssertEqual(signals.count, 1)
        XCTAssertEqual(signals.first?.source, .run)
        XCTAssertEqual(signals.first?.startedAt, Date(timeIntervalSince1970: 5_000))
        XCTAssertEqual(signals.first?.headlines.first, "macOS 테스트 실패 수정")
    }

    // MARK: Removal rule (buzz repro)

    func testTerminalRunProducesNoSignalOnAnySurface() {
        let agentID = MemberID()
        let run = RunID()
        let partial = AgentPartial(runId: run, channelId: channel, textDelta: "stale streaming text")

        for terminal in [RunStatus.succeeded, .failed, .cancelled, .timedOut] {
            let signals = AgentWorkingSignalResolver.resolve(
                channel: channel,
                members: [agent(agentID, name: "빌드봇")],
                statuses: [status(run: run, agent: agentID, phase: .streaming, runStatus: terminal)],
                partials: [run: partial],
                workRuns: [],
                typingAgentIDs: [],
                startTimes: [run: Date()],
                now: Date()
            )
            XCTAssertTrue(signals.isEmpty, "\(terminal) must clear the working signal")
        }
    }

    func testDoneOrErrorPhaseProducesNoSignalEvenIfRunStatusLags() {
        let agentID = MemberID()
        let run = RunID()
        for phase in [AgentStatusPhase.done, .error] {
            let signals = AgentWorkingSignalResolver.resolve(
                channel: channel,
                members: [agent(agentID, name: "빌드봇")],
                statuses: [status(run: run, agent: agentID, phase: phase, runStatus: .running)],
                partials: [:],
                workRuns: [],
                typingAgentIDs: [],
                startTimes: [run: Date()],
                now: Date()
            )
            XCTAssertTrue(signals.isEmpty, "phase \(phase) must clear the working signal")
        }
    }

    func testTerminalWorkRunClearsEvenWithLingeringPartial() {
        let agentID = MemberID()
        let run = RunID()
        let workRun = AgentWorkRun(
            id: run,
            workspaceId: workspace,
            agentMemberId: agentID,
            channelId: channel,
            status: .succeeded,
            input: AgentWorkInput(title: "완료된 작업", brief: "brief"),
            createdAtMs: 1_000,
            updatedAtMs: 2_000
        )
        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [],
            partials: [run: AgentPartial(runId: run, channelId: channel, textDelta: "leftover")],
            workRuns: [workRun],
            typingAgentIDs: [],
            startTimes: [:],
            now: Date()
        )
        XCTAssertTrue(signals.isEmpty)
    }

    // MARK: Multi-agent concurrency

    func testMultipleAgentsProduceSeparateSortedSignals() {
        let first = MemberID()
        let second = MemberID()
        let runA = RunID()
        let runB = RunID()

        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [
                agent(first, name: "Zenbot"),
                agent(second, name: "Apollo"),
            ],
            statuses: [
                status(run: runA, agent: first),
                status(run: runB, agent: second),
            ],
            partials: [:],
            workRuns: [],
            typingAgentIDs: [],
            startTimes: [runA: Date(), runB: Date()],
            now: Date()
        )

        XCTAssertEqual(signals.count, 2)
        XCTAssertEqual(signals.map(\.agentName), ["Apollo", "Zenbot"], "sorted case-insensitively by name")
    }

    func testConcurrentRunsForSameAgentMergeToEarliestStartAndUnionHeadlines() {
        let agentID = MemberID()
        let older = RunID()
        let newer = RunID()
        let earliest = Date(timeIntervalSince1970: 100)
        let later = Date(timeIntervalSince1970: 500)

        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [
                status(run: older, agent: agentID),
                status(run: newer, agent: agentID),
            ],
            partials: [
                older: AgentPartial(runId: older, channelId: channel, textDelta: "첫 번째 작업"),
                newer: AgentPartial(runId: newer, channelId: channel, textDelta: "두 번째 작업"),
            ],
            workRuns: [],
            typingAgentIDs: [],
            startTimes: [older: earliest, newer: later],
            now: later
        )

        XCTAssertEqual(signals.count, 1)
        XCTAssertEqual(signals.first?.startedAt, earliest)
        XCTAssertTrue(signals.first?.headlines.contains("첫 번째 작업") == true)
        XCTAssertTrue(signals.first?.headlines.contains("두 번째 작업") == true)
    }

    // MARK: Headline-less badge vs composer

    func testHeadlinelessRunKeepsBadgeButHidesComposer() {
        let agentID = MemberID()
        let run = RunID()
        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [status(run: run, agent: agentID, phase: .thinking, runStatus: .running)],
            partials: [run: AgentPartial(runId: run, channelId: channel, textDelta: "   \n  ")],
            workRuns: [],
            typingAgentIDs: [],
            startTimes: [run: Date()],
            now: Date()
        )
        XCTAssertEqual(signals.count, 1, "badge surface still shows the agent is live")
        XCTAssertFalse(signals.first?.hasHeadline == true, "composer stays hidden with no headline")
    }

    // MARK: Typing fallback

    func testTypingFallbackOnlyWhenNoRunOrStatus() {
        let agentID = MemberID()
        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [],
            partials: [:],
            workRuns: [],
            typingAgentIDs: [agentID],
            startTimes: [:],
            now: Date()
        )
        XCTAssertEqual(signals.count, 1)
        XCTAssertEqual(signals.first?.source, .typing)
        XCTAssertNil(signals.first?.startedAt)
        XCTAssertFalse(signals.first?.hasHeadline == true)
    }

    func testTypingDoesNotDuplicateAnActiveRunSignal() {
        let agentID = MemberID()
        let run = RunID()
        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [status(run: run, agent: agentID)],
            partials: [:],
            workRuns: [],
            typingAgentIDs: [agentID],
            startTimes: [run: Date()],
            now: Date()
        )
        XCTAssertEqual(signals.count, 1)
        XCTAssertEqual(signals.first?.source, .status, "the run signal wins over the typing fallback")
    }

    // MARK: Membership / kind gating

    func testNonMemberInactiveAndHumanAgentsAreExcluded() {
        let outsider = MemberID()
        let inactive = MemberID()
        let runOut = RunID()
        let runInactive = RunID()

        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [
                agent(outsider, name: "Outsider", inChannel: false),
                agent(inactive, name: "Inactive", active: false),
            ],
            statuses: [
                status(run: runOut, agent: outsider),
                status(run: runInactive, agent: inactive),
            ],
            partials: [:],
            workRuns: [],
            typingAgentIDs: [],
            startTimes: [runOut: Date(), runInactive: Date()],
            now: Date()
        )
        XCTAssertTrue(signals.isEmpty)
    }

    func testOtherChannelStatusIsIgnored() {
        let agentID = MemberID()
        let otherChannel = ChannelID()
        let run = RunID()
        let signals = AgentWorkingSignalResolver.resolve(
            channel: channel,
            members: [agent(agentID, name: "빌드봇")],
            statuses: [
                AgentStatus(
                    runId: run,
                    agentMemberId: agentID,
                    channelId: otherChannel,
                    phase: .streaming,
                    runStatus: .running
                ),
            ],
            partials: [:],
            workRuns: [],
            typingAgentIDs: [],
            startTimes: [run: Date()],
            now: Date()
        )
        XCTAssertTrue(signals.isEmpty)
    }
}

final class AgentWorkingElapsedFormatTests: XCTestCase {
    func testFormatsClockDigits() {
        XCTAssertEqual(AgentWorkingElapsedFormat.string(0), "0:00")
        XCTAssertEqual(AgentWorkingElapsedFormat.string(5), "0:05")
        XCTAssertEqual(AgentWorkingElapsedFormat.string(83), "1:23")
        XCTAssertEqual(AgentWorkingElapsedFormat.string(600), "10:00")
        XCTAssertEqual(AgentWorkingElapsedFormat.string(3723), "1:02:03")
    }

    func testNegativeElapsedClampsToZero() {
        XCTAssertEqual(AgentWorkingElapsedFormat.string(-42), "0:00")
    }
}

@MainActor
final class AgentWorkingSignalViewModelTests: XCTestCase {
    func testRunAppearsFromRealtimeThenClearsWhenTerminal() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = MemberID()
        let agent = MemberID()
        let run = RunID()
        let members = [
            Member(id: human, workspaceId: workspace, kind: .human, displayName: "성재", handle: "sungjae", channelIds: [channel]),
            Member(id: agent, workspaceId: workspace, kind: .agent, displayName: "빌드봇", handle: "buildbot", channelIds: [channel]),
        ]
        let channels = [Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human)]

        // Live run: running status + a streaming partial.
        let liveBackend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: members,
            channels: channels,
            history: [channel: []],
            events: [
                .agentStatus(AgentStatus(runId: run, agentMemberId: agent, channelId: channel, phase: .streaming, runStatus: .running)),
                .agentPartial(AgentPartial(runId: run, channelId: channel, textDelta: "테스트를 실행하는 중입니다.")),
            ]
        )
        let liveModel = ChatViewModel(chat: liveBackend, agentTransport: FailingDecisionAgentTransport())
        await liveModel.bootstrap(workspace: workspace, accessToken: "token")
        await liveModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(60))

        let liveSignals = liveModel.agentWorkingSignals(in: channel)
        XCTAssertEqual(liveSignals.count, 1)
        XCTAssertEqual(liveSignals.first?.agentId, agent)
        XCTAssertEqual(liveSignals.first?.headlines.first, "테스트를 실행하는 중입니다.")
        XCTAssertNotNil(liveSignals.first?.startedAt, "mention/status runs get a first-seen clock")

        // Same run reaching a terminal status must clear every surface.
        let terminalBackend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: members,
            channels: channels,
            history: [channel: []],
            events: [
                .agentStatus(AgentStatus(runId: run, agentMemberId: agent, channelId: channel, phase: .streaming, runStatus: .running)),
                .agentStatus(AgentStatus(runId: run, agentMemberId: agent, channelId: channel, phase: .done, runStatus: .succeeded)),
            ]
        )
        let terminalModel = ChatViewModel(chat: terminalBackend, agentTransport: FailingDecisionAgentTransport())
        await terminalModel.bootstrap(workspace: workspace, accessToken: "token")
        await terminalModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(80))

        XCTAssertTrue(
            terminalModel.agentWorkingSignals(in: channel).isEmpty,
            "a terminal run must clear the working signal from every surface"
        )
    }

    func testMultipleConcurrentAgentsSurfaceInChannel() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = MemberID()
        let first = MemberID()
        let second = MemberID()
        let runA = RunID()
        let runB = RunID()
        let members = [
            Member(id: human, workspaceId: workspace, kind: .human, displayName: "성재", handle: "sungjae", channelIds: [channel]),
            Member(id: first, workspaceId: workspace, kind: .agent, displayName: "Apollo", handle: "apollo", channelIds: [channel]),
            Member(id: second, workspaceId: workspace, kind: .agent, displayName: "Zenbot", handle: "zenbot", channelIds: [channel]),
        ]
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: members,
            channels: [Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human)],
            history: [channel: []],
            events: [
                .agentStatus(AgentStatus(runId: runA, agentMemberId: first, channelId: channel, phase: .streaming, runStatus: .running)),
                .agentPartial(AgentPartial(runId: runA, channelId: channel, textDelta: "린트를 정리하는 중")),
                .agentStatus(AgentStatus(runId: runB, agentMemberId: second, channelId: channel, phase: .thinking, runStatus: .running)),
                .agentPartial(AgentPartial(runId: runB, channelId: channel, textDelta: "스키마를 확인하는 중")),
            ]
        )
        let model = ChatViewModel(chat: backend, agentTransport: FailingDecisionAgentTransport())
        await model.bootstrap(workspace: workspace, accessToken: "token")
        await model.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(80))

        let signals = model.agentWorkingSignals(in: channel)
        XCTAssertEqual(signals.count, 2, "each concurrent agent surfaces its own signal")
        XCTAssertEqual(Set(signals.map(\.agentId)), [first, second])
    }
}
