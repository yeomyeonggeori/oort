import XCTest
@testable import MomoCore

final class MomoCoreTests: XCTestCase {

    // MARK: - Identifiers

    func testIdentifierCodableRoundTripsAsBareUUID() throws {
        let id = MessageID()
        let data = try JSONEncoder.momo.encode(id)
        // Encodes as a bare JSON string (a quoted UUID), not an object.
        let raw = String(data: data, encoding: .utf8)!
        XCTAssertEqual(raw, "\"\(id.rawValue.uuidString)\"")
        let back = try JSONDecoder.momo.decode(MessageID.self, from: data)
        XCTAssertEqual(id, back)
    }

    func testIdentifierLosslessString() {
        let s = "018f8b2c-0000-7000-8000-000000000000"
        let id = ChannelID(s)
        XCTAssertNotNil(id)
        XCTAssertEqual(id?.description.lowercased(), s)
        XCTAssertNil(ChannelID("not-a-uuid"))
    }

    // MARK: - JSON

    func testJSONRoundTrip() throws {
        let json: JSON = [
            "name": "search_repo",
            "args": ["query": "channel_seq", "limit": 10],
            "nested": ["a": true, "b": .null, "c": 3.5],
        ]
        let data = try JSONEncoder.momo.encode(json)
        let back = try JSONDecoder.momo.decode(JSON.self, from: data)
        XCTAssertEqual(json, back)
        XCTAssertEqual(json["name"]?.stringValue, "search_repo")
        XCTAssertEqual(json["args"]?["limit"]?.intValue, 10)
        XCTAssertEqual(json["nested"]?["c"]?.doubleValue, 3.5)
    }

    // MARK: - Enum wire mapping (must match schema_v0.sql ENUM text)

    func testMessageTypeWireValues() throws {
        XCTAssertEqual(MessageType.toolCall.rawValue, "tool_call")
        XCTAssertEqual(MessageType.approvalRequest.rawValue, "approval_request")
        let data = "\"tool_result\"".data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder.momo.decode(MessageType.self, from: data), .toolResult)
    }

    func testRunStatusWireValues() {
        XCTAssertEqual(RunStatus.awaitingApproval.rawValue, "awaiting_approval")
        XCTAssertEqual(RunStatus.timedOut.rawValue, "timed_out")
        XCTAssertEqual(AgentRunLifecycleStatus.inputRequired.rawValue, "input_required")
        XCTAssertEqual(RunStatus.paused.lifecycleStatus, .inputRequired)
        XCTAssertEqual(RunStatus.timedOut.lifecycleStatus, .failed)
        XCTAssertTrue(RunStatus.succeeded.isTerminal)
        XCTAssertFalse(RunStatus.awaitingApproval.isTerminal)
    }

    func testChannelKindWireValues() {
        XCTAssertEqual(ChannelKind.publicChannel.rawValue, "public")
        XCTAssertEqual(ChannelKind.privateChannel.rawValue, "private")
    }

    // MARK: - Message decode (snake_case wire → model)

    func testMessageDecodesSnakeCase() throws {
        let wire = """
        {
          "id": "018f8b2c-0000-7000-8000-000000000001",
          "channel_id": "018f8b2c-0000-7000-8000-000000000002",
          "seq": 42,
          "hlc_ts": 1718000000000,
          "hlc_count": 0,
          "author_member_id": "018f8b2c-0000-7000-8000-000000000003",
          "type": "text",
          "state": "sent",
          "body": "hello",
          "props": {},
          "created_at_ms": 1718000000123
        }
        """.data(using: .utf8)!
        let msg = try JSONDecoder.momo.decode(Message.self, from: wire)
        XCTAssertEqual(msg.seq, 42)
        XCTAssertEqual(msg.body, "hello")
        XCTAssertEqual(msg.type, .text)
        XCTAssertFalse(msg.isPendingAck)
        XCTAssertFalse(msg.isDeleted)
    }

    func testOptimisticEchoIsPendingAck() {
        let m = Message(
            id: MessageID(),
            channelId: ChannelID(),
            seq: nil,
            hlcTs: 0,
            authorMemberId: MemberID(),
            clientMsgId: UUID()
        )
        XCTAssertTrue(m.isPendingAck)
    }

    // MARK: - Realtime envelope mapping

    func testEnvelopeMapsMessageNew() throws {
        let envelope = RealtimeEnvelope(
            type: "message.new",
            ts: 1718000000000,
            seq: 7,
            payload: [
                "id": "018f8b2c-0000-7000-8000-000000000010",
                "channel_id": "018f8b2c-0000-7000-8000-000000000011",
                "seq": 7,
                "hlc_ts": 1718000000000,
                "hlc_count": 0,
                "author_member_id": "018f8b2c-0000-7000-8000-000000000012",
                "type": "text",
                "state": "sent",
                "body": "hi",
                "props": [:],
            ]
        )
        let event = try envelope.decodeEvent()
        guard case .message(let m) = event else {
            return XCTFail("expected .message, got \(event)")
        }
        XCTAssertEqual(m.seq, 7)
        XCTAssertEqual(m.body, "hi")
    }

    func testEnvelopeMapsMessageDeleted() throws {
        let envelope = RealtimeEnvelope(
            type: "message.deleted",
            ts: 1,
            payload: ["message_id": "018f8b2c-0000-7000-8000-000000000020"]
        )
        let event = try envelope.decodeEvent()
        guard case .messageDeleted(let id) = event else {
            return XCTFail("expected .messageDeleted")
        }
        XCTAssertEqual(id.description.lowercased(), "018f8b2c-0000-7000-8000-000000000020")
    }

    func testEnvelopeUnknownTypeThrows() {
        let envelope = RealtimeEnvelope(type: "wat.unknown", ts: 1, payload: [:])
        XCTAssertThrowsError(try envelope.decodeEvent()) { err in
            guard case RealtimeEnvelope.DecodeError.unknownType(let t) = err else {
                return XCTFail("expected unknownType, got \(err)")
            }
            XCTAssertEqual(t, "wat.unknown")
        }
    }

    func testEnvelopeMapsAgentPartial() throws {
        let envelope = RealtimeEnvelope(
            type: "agent.partial",
            ts: 1,
            payload: [
                "run_id": "018f8b2c-0000-7000-8000-000000000030",
                "channel_id": "018f8b2c-0000-7000-8000-000000000031",
                "text_delta": "search",
                "spent_micro_usd": 2100,
            ]
        )
        let event = try envelope.decodeEvent()
        guard case .agentPartial(let p) = event else {
            return XCTFail("expected .agentPartial")
        }
        XCTAssertEqual(p.textDelta, "search")
        XCTAssertEqual(p.spentMicroUSD, 2100)
    }

    func testRealtimeReplayControllerDropsDuplicateMessageSeq() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let message = Self.message(channel: channel, author: author, seq: 40, body: "duplicate")
        let controller = RealtimeReplayController(
            channel: channel,
            lastAppliedSeq: 40,
            seenMessageIDs: [message.id]
        )

        let emitted = try await controller.process(Self.envelope(message)) { _, _ in [] }

        XCTAssertTrue(emitted.isEmpty)
        let snapshot = await controller.snapshot()
        XCTAssertEqual(snapshot.lastAppliedSeq, 40)
        XCTAssertTrue(snapshot.pendingSeqs.isEmpty)
    }

    func testRealtimeReplayControllerBackfillsGapAndDrainsBufferedLiveEvent() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let live43 = Self.message(channel: channel, author: author, seq: 43, body: "live 43")
        let backfill41 = Self.message(channel: channel, author: author, seq: 41, body: "backfill 41")
        let backfill42 = Self.message(channel: channel, author: author, seq: 42, body: "backfill 42")
        let backfill = BackfillScript(pages: [40: [backfill41, backfill42]])
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 40)

        let emitted = try await controller.process(Self.envelope(live43)) { after, limit in
            await backfill.backfill(after: after, limit: limit)
        }

        XCTAssertEqual(emitted.messageSeqs, [41, 42, 43])
        XCTAssertEqual(emitted.messageBodies, ["backfill 41", "backfill 42", "live 43"])
        let calls = await backfill.calls()
        XCTAssertEqual(calls, [BackfillCall(after: 40, limit: 200)])
        let snapshot = await controller.snapshot()
        XCTAssertEqual(snapshot.lastAppliedSeq, 43)
        XCTAssertTrue(snapshot.pendingSeqs.isEmpty)
    }

    func testRealtimeReplayControllerDedupesBufferedEventAlreadyReturnedByBackfill() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let live43 = Self.message(channel: channel, author: author, seq: 43, body: "live 43")
        let backfill41 = Self.message(channel: channel, author: author, seq: 41, body: "backfill 41")
        let backfill42 = Self.message(channel: channel, author: author, seq: 42, body: "backfill 42")
        let backfill43 = Message(
            id: live43.id,
            channelId: channel,
            seq: 43,
            hlcTs: 43,
            authorMemberId: author,
            body: "backfill 43"
        )
        let backfill = BackfillScript(pages: [40: [backfill41, backfill42, backfill43]])
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 40)

        let emitted = try await controller.process(Self.envelope(live43)) { after, limit in
            await backfill.backfill(after: after, limit: limit)
        }

        XCTAssertEqual(emitted.messageSeqs, [41, 42, 43])
        XCTAssertEqual(emitted.messageBodies, ["backfill 41", "backfill 42", "backfill 43"])
        let snapshot = await controller.snapshot()
        XCTAssertEqual(snapshot.lastAppliedSeq, 43)
        XCTAssertTrue(snapshot.pendingSeqs.isEmpty)
    }

    // MARK: - Cost snapshot

    func testCostSnapshotUSDConversion() {
        let c = CostSnapshot(runId: RunID(), reservedMicroUSD: 400_000, spentMicroUSD: 2_100)
        XCTAssertEqual(c.reservedUSD, 0.4, accuracy: 1e-9)
        XCTAssertEqual(c.spentUSD, 0.0021, accuracy: 1e-9)
    }

    // MARK: - DraftMessage

    func testDraftMessageEncodesSnakeCase() throws {
        let draft = DraftMessage(channelId: ChannelID(), type: .text, body: "yo")
        let data = try JSONEncoder.momo.encode(draft)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNotNil(obj["channel_id"])
        XCTAssertEqual(obj["body"] as? String, "yo")
    }

    private static func message(
        channel: ChannelID,
        author: MemberID,
        seq: Int64,
        body: String
    ) -> Message {
        Message(
            id: MessageID(),
            channelId: channel,
            seq: seq,
            hlcTs: seq,
            authorMemberId: author,
            body: body
        )
    }

    private static func envelope(_ message: Message) -> RealtimeEnvelope {
        RealtimeEnvelope(
            type: "message.new",
            ts: message.hlcTs,
            seq: message.seq,
            payload: [
                "id": .string(message.id.description),
                "channel_id": .string(message.channelId.description),
                "seq": .int(message.seq ?? 0),
                "hlc_ts": .int(message.hlcTs),
                "hlc_count": .int(Int64(message.hlcCount)),
                "author_member_id": .string(message.authorMemberId.description),
                "type": .string(message.type.rawValue),
                "state": .string(message.state.rawValue),
                "body": .string(message.body ?? ""),
                "props": .object([:]),
            ]
        )
    }
}

private struct BackfillCall: Equatable, Sendable {
    var after: Int64
    var limit: Int
}

private actor BackfillScript {
    private var pages: [Int64: [Message]]
    private var recordedCalls: [BackfillCall] = []

    init(pages: [Int64: [Message]]) {
        self.pages = pages
    }

    func backfill(after: Int64, limit: Int) -> [Message] {
        recordedCalls.append(BackfillCall(after: after, limit: limit))
        return pages[after] ?? []
    }

    func calls() -> [BackfillCall] {
        recordedCalls
    }
}

private extension Array where Element == RealtimeEvent {
    var messageSeqs: [Int64] {
        compactMap { event in
            guard case .message(let message) = event else { return nil }
            return message.seq
        }
    }

    var messageBodies: [String] {
        compactMap { event in
            guard case .message(let message) = event else { return nil }
            return message.body
        }
    }
}
