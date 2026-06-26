import XCTest
import MomoCore
@testable import MomoMac

final class MomoMacTests: XCTestCase {

    // MARK: seq ordering (L4 §1.2 #3 — ordering authority is Message.seq)

    func testSeqOrderingPutsAckedBeforeOptimistic() {
        let ws = WorkspaceID()
        let ch = ChannelID()
        let author = MemberID()
        func msg(_ seq: Int64?, hlc: Int64) -> Message {
            Message(id: MessageID(), channelId: ch, seq: seq, hlcTs: hlc, hlcCount: 0,
                    authorMemberId: author)
        }
        let acked2 = msg(2, hlc: 200)
        let acked1 = msg(1, hlc: 100)
        let optimistic = msg(nil, hlc: 300)

        let sorted = [optimistic, acked2, acked1].sorted(by: ChatViewModel.seqOrder)
        XCTAssertEqual(sorted.map { $0.seq }, [1, 2, nil])
        _ = ws
    }

    // MARK: CostFormat (experience B, display only)

    func testCostFormatMicroUSD() {
        XCTAssertEqual(CostFormat.usd(280_000), "$0.2800")
        XCTAssertEqual(CostFormat.usdCompact(3_100_000), "$3.10")
    }

    // MARK: in-memory backend round-trip (proves ChatBackend conformance)

    func testBackendSeedAndHistory() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        XCTAssertEqual(seed.channels.count, 2)
        XCTAssertEqual(seed.agents.count, 2)

        let history = try await backend.history(channel: seed.channels[0].id, after: nil, limit: 50)
        XCTAssertGreaterThan(history.count, 0)
        // Seeded messages must be gapless seq from 1.
        let seqs = history.compactMap { $0.seq }
        XCTAssertEqual(seqs, Array(1...Int64(seqs.count)))
    }

    func testDemoAgentProtocolCardsCarryContextMemoryCapabilityMetadata() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        var messages: [Message] = []
        for channel in seed.channels {
            messages += try await backend.history(channel: channel.id, after: nil, limit: 50)
        }

        for type in [MessageType.toolCall, .toolResult, .artifact, .approvalRequest] {
            guard let message = messages.first(where: { $0.type == type }) else {
                return XCTFail("demo should seed \(type.rawValue)")
            }
            XCTAssertNotNil(message.props["context_packet"], "\(type.rawValue) should cite Context Packet projection")
            XCTAssertGreaterThan(message.props["source_badges"]?.arrayValue?.count ?? 0, 0,
                                 "\(type.rawValue) should show at least one source badge")
        }

        let toolCall = try XCTUnwrap(messages.first(where: { $0.type == .toolCall }))
        XCTAssertEqual(toolCall.props["capability"]?["tool_name"]?.stringValue, "github.search_issues")
        XCTAssertEqual(toolCall.props["memory_citations"]?.arrayValue?.count, 1)
        XCTAssertNotNil(toolCall.props["estimated_micro_usd"]?.intValue)

        let approval = try XCTUnwrap(messages.first(where: { $0.type == .approvalRequest }))
        XCTAssertEqual(approval.props["capability"]?["approval_policy"]?.stringValue, "always")
        XCTAssertEqual(approval.props["memory_citations"]?.arrayValue?.count, 1)

        let result = try XCTUnwrap(messages.first(where: { $0.type == .toolResult }))
        XCTAssertEqual(result.props["artifact_ref"]?["kind"]?.stringValue, "search_results")
        XCTAssertNotNil(result.props["spent_micro_usd"]?.intValue)
    }

    func testOptimisticSendIsIdempotent() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "t")
        let ch = seed.channels[0].id
        let cid = UUID()
        let draft = DraftMessage(channelId: ch, type: .text, body: "hi")
        let first = try await backend.sendOptimistic(draft, clientMsgId: cid)
        let second = try await backend.sendOptimistic(draft, clientMsgId: cid)
        XCTAssertEqual(first.id, second.id, "same clientMsgId must dedupe (L4 §3.1)")
    }

    @MainActor
    func testDemoRealtimeReplayIsIdempotentAcrossResubscribe() async throws {
        let viewModel = await MomoMacDemo.makeViewModel()
        try await Task.sleep(for: .milliseconds(50))

        guard let general = viewModel.selectedChannelId else {
            return XCTFail("demo should select the first channel")
        }
        guard let other = viewModel.channels.dropFirst().first?.id else {
            return XCTFail("demo should seed at least two channels")
        }
        let initialPartialText = viewModel.partials.values.first?.textDelta
        XCTAssertNotNil(initialPartialText)

        guard let approval = viewModel.pendingApprovals.first else {
            return XCTFail("demo should seed one pending approval")
        }
        await viewModel.decideApproval(approval.approvalId, approve: true)
        XCTAssertEqual(viewModel.approvals[approval.approvalId]?.status, .approved)
        XCTAssertTrue(viewModel.pendingApprovals.isEmpty)

        await viewModel.selectChannel(other)
        await viewModel.selectChannel(general)
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(viewModel.partials.values.first?.textDelta, initialPartialText)
        XCTAssertEqual(viewModel.approvals[approval.approvalId]?.status, .approved)
        XCTAssertTrue(viewModel.pendingApprovals.isEmpty)
    }
}
