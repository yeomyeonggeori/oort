import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class AgentWorkSurfaceTests: XCTestCase {
    func testWorkCommandRecognizesOnlyExactCommandBoundary() {
        XCTAssertEqual(AgentWorkCommandParser.parse("/work")?.brief, "")
        let draft = "  /work   macOS 빌드 오류를 수정해줘  "
        XCTAssertEqual(AgentWorkCommandParser.parse(draft)?.brief, "macOS 빌드 오류를 수정해줘")
        XCTAssertEqual(AgentWorkCommandParser.parse(draft)?.draftToRestore, draft)
        XCTAssertNil(AgentWorkCommandParser.parse("/worker should stay a message"))
        XCTAssertNil(AgentWorkCommandParser.parse("please /work later"))
    }

    func testDurableTerminalWorkStatusWinsOverHydratedApprovalSidecar() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let channel = try XCTUnwrap(seed.channels.first)
        try await backend.connect(workspace: seed.workspace, accessToken: "token")
        let history = try await backend.history(channel: channel.id, after: nil, limit: 200)
        let approvalMessage = try XCTUnwrap(history.first { $0.type == .approvalRequest })
        let runId = try XCTUnwrap(approvalMessage.runId)
        let run = AgentWorkRun(
            id: runId,
            workspaceId: seed.workspace,
            agentMemberId: approvalMessage.authorMemberId,
            channelId: channel.id,
            status: .succeeded,
            input: AgentWorkInput(
                title: "승인 완료 후 Work",
                brief: "재방문해도 완료 상태를 유지하세요."
            ),
            output: .object(["summary": .string("승인 후 실행을 완료했습니다.")]),
            finishedAtMs: 1_783_910_460_000,
            createdAtMs: 1_783_910_400_000,
            updatedAtMs: 1_783_910_460_000
        )
        await backend.seedDemoWorkRun(run)
        let viewModel = ChatViewModel(backend: backend)

        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "token")
        await viewModel.selectChannel(channel.id)

        let loadedRun = try XCTUnwrap(viewModel.workRun(runId))
        XCTAssertEqual(viewModel.agentStatuses[runId]?.runStatus, .awaitingApproval)
        XCTAssertEqual(viewModel.effectiveWorkStatus(for: loadedRun), .succeeded)

        try await Task.sleep(for: .milliseconds(50))
        let runAfterReplay = try XCTUnwrap(viewModel.workRun(runId))
        XCTAssertEqual(runAfterReplay.status, .succeeded)
        XCTAssertEqual(viewModel.effectiveWorkStatus(for: runAfterReplay), .succeeded)
    }

    func testWorkErrorsUseBilingualCopy() {
        let korean = MomoWorkspaceCopy(language: .korean)
        let english = MomoWorkspaceCopy(language: .english)

        for error in AgentWorkSurfaceError.allCases {
            XCTAssertFalse(korean.workError(error).isEmpty)
            XCTAssertFalse(english.workError(error).isEmpty)
            XCTAssertNotEqual(korean.workError(error), english.workError(error))
        }
        XCTAssertEqual(korean.workError(.historyFailed), "Work 기록을 불러오지 못했습니다. 다시 불러오세요.")
        XCTAssertEqual(english.workError(.detailFailed), "Work details could not load. Refresh the details and try again.")
    }

    func testCancelledWorkResultUsesNeutralPresentation() {
        XCTAssertEqual(AgentWorkResultPresentation.tone(for: .cancelled), .neutral)
        XCTAssertEqual(AgentWorkResultPresentation.tone(for: .succeeded), .success)
        XCTAssertEqual(AgentWorkResultPresentation.tone(for: .failed), .failure)
    }

    func testKeyboardHelpIncludesStartWorkShortcut() {
        let copy = MomoWorkspaceCopy(language: .korean)
        XCTAssertTrue(
            MomoKeyboardShortcutCatalog.items(copy: copy).contains {
                $0.key == "⇧⌘W" && $0.label == copy.startWork
            }
        )
    }

    func testWorkResultParsesDiffExitLinkAndTranscript() throws {
        let run = fixtureRun(
            status: .succeeded,
            output: .object([
                "summary": .string("Build와 단위 테스트를 통과했습니다."),
                "diff_summary": .string("Work 카드와 상세 페인을 추가했습니다."),
                "changed_files": .array([.string("A.swift"), .string("B.swift")]),
                "exit_code": .int(0),
                "pr_url": .string("https://github.com/Dawn-kim-official/momo/pull/364"),
                "transcript": .array([
                    .string("프로젝트 구조를 확인했습니다."),
                    .object(["text": .string("swift test를 실행했습니다.")]),
                ]),
            ])
        )
        let partial = AgentPartial(
            runId: run.id,
            channelId: run.channelId,
            textDelta: "마지막 결과를 정리했습니다."
        )

        let result = AgentWorkResultSummary(run: run, messages: [], partial: partial)

        XCTAssertEqual(result.summary, "Build와 단위 테스트를 통과했습니다.")
        XCTAssertEqual(result.diffSummary, "Work 카드와 상세 페인을 추가했습니다.")
        XCTAssertEqual(result.changedFileCount, 2)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.pullRequestURL?.lastPathComponent, "364")
        XCTAssertEqual(result.transcript.count, 3)
    }

    func testWorkTimelineAnchorsCardAtFirstLedgerEventAndRestartsGrouping() throws {
        let runId = RunID()
        let channel = ChannelID()
        let author = MemberID()
        let before = Message(
            id: MessageID(), channelId: channel, seq: 1, hlcTs: 1,
            authorMemberId: author, body: "Before Work"
        )
        let approval = Message(
            id: MessageID(), channelId: channel, seq: 2, hlcTs: 2,
            authorMemberId: author, type: .approvalRequest, runId: runId
        )
        let text = Message(
            id: MessageID(), channelId: channel, seq: 3, hlcTs: 3,
            authorMemberId: author, body: "Keep final narrative", runId: runId
        )
        let unrelated = Message(
            id: MessageID(), channelId: channel, seq: 4, hlcTs: 4,
            authorMemberId: author, type: .toolResult, runId: RunID()
        )
        let run = AgentWorkRun(
            id: runId,
            workspaceId: WorkspaceID(),
            agentMemberId: author,
            channelId: channel,
            status: .awaitingApproval,
            input: AgentWorkInput(title: "Ledger anchor", brief: "Keep the seq position."),
            createdAtMs: 1,
            updatedAtMs: 2
        )

        let entries = AgentWorkTimelinePolicy.entries(
            messages: [before, approval, text, unrelated],
            runs: [run]
        )

        XCTAssertEqual(
            entries.map(\.id),
            [
                "message-\(before.id.description)",
                "work-\(runId.description)",
                "message-\(text.id.description)",
                "message-\(unrelated.id.description)",
            ]
        )
        guard case .message(let narrativeItem) = entries[2] else {
            return XCTFail("Expected narrative message after Work card")
        }
        XCTAssertTrue(narrativeItem.startsGroup)
        XCTAssertFalse(narrativeItem.startsDay)
        guard case .work(_, _, let workStartsDay) = entries[1] else {
            return XCTFail("Expected Work card at durable event anchor")
        }
        XCTAssertFalse(workStartsDay)
    }

    func testWorkTimelinePlacesRunWithoutEventsByCreationTime() {
        let channel = ChannelID()
        let author = MemberID()
        let before = Message(
            id: MessageID(), channelId: channel, seq: 1, hlcTs: 10,
            authorMemberId: author, body: "Before"
        )
        let after = Message(
            id: MessageID(), channelId: channel, seq: 2, hlcTs: 30,
            authorMemberId: author, body: "After"
        )
        let work = AgentWorkRun(
            id: RunID(),
            workspaceId: WorkspaceID(),
            agentMemberId: author,
            channelId: channel,
            status: .queued,
            input: AgentWorkInput(title: "Queued Work", brief: "No event yet."),
            createdAtMs: 20,
            updatedAtMs: 20
        )

        let entries = AgentWorkTimelinePolicy.entries(messages: [before, after], runs: [work])

        XCTAssertEqual(
            entries.map(\.id),
            [
                "message-\(before.id.description)",
                "work-\(work.id.description)",
                "message-\(after.id.description)",
            ]
        )
        guard case .work(_, _, let workStartsDay) = entries[1],
              case .message(let afterItem) = entries[2] else {
            return XCTFail("Expected Work card between surrounding messages")
        }
        XCTAssertFalse(workStartsDay)
        XCTAssertFalse(afterItem.startsDay)
    }

    func testWorkResultReadsCommittedStructuredResultMessage() {
        let run = fixtureRun(status: .succeeded, output: nil)
        let resultMessage = Message(
            id: MessageID(),
            channelId: run.channelId,
            seq: 9,
            hlcTs: 9,
            authorMemberId: run.agentMemberId,
            type: .toolResult,
            props: .object([
                "output": .object([
                    "summary": .string("PR을 열었습니다."),
                    "diff_summary": .string("SwiftUI Work surface 추가"),
                    "changed_file_count": .int(7),
                    "exit_code": .int(0),
                    "pr_url": .string("https://github.com/Dawn-kim-official/momo/pull/359"),
                ]),
            ]),
            runId: run.id
        )

        let result = AgentWorkResultSummary(run: run, messages: [resultMessage], partial: nil)

        XCTAssertEqual(result.summary, "PR을 열었습니다.")
        XCTAssertEqual(result.diffSummary, "SwiftUI Work surface 추가")
        XCTAssertEqual(result.changedFileCount, 7)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.pullRequestURL?.lastPathComponent, "359")
    }

    func testLiveBackendCreatesListsAndDeduplicatesWorkRun() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "token")
        let channel = seed.channels[0].id
        let agent = try XCTUnwrap(seed.agents.first { $0.channelIds.contains(channel) })
        let clientRunId = UUID()
        let input = AgentWorkInput(
            title: "MOMO-364 UI",
            brief: "컴포저, 카드, 상세 페인을 구현하고 테스트하세요."
        )

        let first = try await backend.createWorkRun(
            agent: agent.id,
            channel: channel,
            input: input,
            clientRunId: clientRunId
        )
        let second = try await backend.createWorkRun(
            agent: agent.id,
            channel: channel,
            input: input,
            clientRunId: clientRunId
        )

        let listed = try await backend.workRuns(channel: channel, limit: 50)
        let detailed = try await backend.workRun(id: first.id)
        XCTAssertEqual(first.id, second.id)
        XCTAssertEqual(listed.map(\.id), [first.id])
        XCTAssertEqual(detailed, first)
    }

    func testViewModelStartsWorkWithInvitedActiveAgent() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "token")
        let channel = seed.channels[0].id
        await viewModel.selectChannel(channel)
        let agent = try XCTUnwrap(viewModel.workTargetAgents.first)

        let startedRunId = await viewModel.startWork(
            agent: agent.id,
            title: "Work surface 검증",
            brief: "한국어와 English가 섞인 긴 설명으로 UI와 테스트를 검증하세요."
        )
        let runId = try XCTUnwrap(startedRunId)

        XCTAssertEqual(viewModel.visibleWorkRuns.map(\.id), [runId])
        XCTAssertEqual(viewModel.visibleWorkRuns.first?.status, .queued)
        XCTAssertNil(viewModel.workCreationError)
    }

    private func fixtureRun(status: RunStatus, output: JSON?) -> AgentWorkRun {
        AgentWorkRun(
            id: RunID(),
            workspaceId: WorkspaceID(),
            agentMemberId: MemberID(),
            channelId: ChannelID(),
            status: status,
            input: AgentWorkInput(
                title: "Work surface",
                brief: "Build the macOS Work surface."
            ),
            output: output,
            createdAtMs: 1_783_910_400_000,
            updatedAtMs: 1_783_910_460_000
        )
    }
}
