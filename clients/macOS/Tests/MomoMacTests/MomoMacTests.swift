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
}
