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

    func testMemberCapabilitiesNormalizeForDisplayAndMatching() throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .agent,
            displayName: "Hermes",
            handle: "hermes",
            capabilities: [" Code ", "TERMINAL", "code", "  "]
        )

        XCTAssertEqual(member.normalizedCapabilities, ["code", "terminal"])
        XCTAssertTrue(member.hasCapability(" CODE "))
        XCTAssertFalse(member.hasCapability("docs"))

        let legacyWire = Data("""
        {
          "id": "\(member.id.description)",
          "workspace_id": "\(workspace.description)",
          "kind": "agent",
          "display_name": "Legacy Agent",
          "handle": "legacy"
        }
        """.utf8)
        let legacyMember = try JSONDecoder.momo.decode(Member.self, from: legacyWire)
        XCTAssertEqual(legacyMember.capabilities, [])
    }

    func testDirectMessageChannelDecodesParticipantsAndLegacyDefault() throws {
        let participant = MemberID(uuidString: "00000000-0000-7000-8000-000000000103")!
        let wire = Data("""
        {
          "id":"00000000-0000-7000-8000-000000000299",
          "workspace_id":"00000000-0000-7000-8000-000000000001",
          "kind":"dm",
          "dm_key":"pair-hash",
          "dm_member_ids":["\(participant.description)"]
        }
        """.utf8)
        let channel = try JSONDecoder.momo.decode(Channel.self, from: wire)
        XCTAssertEqual(channel.kind, .dm)
        XCTAssertEqual(channel.dmMemberIds, [participant])

        let legacyWire = Data("""
        {
          "id":"00000000-0000-7000-8000-000000000298",
          "workspace_id":"00000000-0000-7000-8000-000000000001",
          "kind":"dm",
          "dm_key":"legacy-pair"
        }
        """.utf8)
        let legacy = try JSONDecoder.momo.decode(Channel.self, from: legacyWire)
        XCTAssertEqual(legacy.dmMemberIds, [])
    }

    func testAgentWorkRunDecodesMOMO362Projection() throws {
        let wire = Data("""
        {
          "id":"00000000-0000-7000-8000-000000000364",
          "workspaceId":"00000000-0000-7000-8000-000000000001",
          "agentMemberId":"00000000-0000-7000-8000-000000000103",
          "channelId":"00000000-0000-7000-8000-000000000202",
          "triggerMessageId":null,
          "parentRunId":null,
          "status":"awaiting_approval",
          "stepCount":3,
          "maxSteps":50,
          "depth":0,
          "input":{"type":"work","title":"Ship Work UI","brief":"Build and test the macOS surface."},
          "output":{"diff_summary":"3 Swift files changed","exit_code":0},
          "error":null,
          "startedAtMs":1783910401000,
          "finishedAtMs":null,
          "createdAtMs":1783910400000,
          "updatedAtMs":1783910402000
        }
        """.utf8)

        let run = try JSONDecoder.momo.decode(AgentWorkRun.self, from: wire)

        XCTAssertEqual(run.status, .awaitingApproval)
        XCTAssertEqual(run.input.title, "Ship Work UI")
        XCTAssertEqual(run.output?["exit_code"]?.intValue, 0)
        XCTAssertEqual(run.stepCount, 3)
    }

    func testAgentWorkInputRejectsNonWorkType() {
        let wire = Data(#"{"type":"chat","title":"No","brief":"Wrong contract"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder.momo.decode(AgentWorkInput.self, from: wire))
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

    func testEnvelopeMapsHuddleLifecycleEvents() throws {
        let huddleID = "018f8b2c-0000-7000-8000-000000000040"
        let channelID = "018f8b2c-0000-7000-8000-000000000041"
        let memberID = "018f8b2c-0000-7000-8000-000000000042"
        let fixtures: [(String, HuddleDelta.Action)] = [
            ("huddle_started", .started),
            ("huddle_participants_changed", .participantsChanged),
            ("huddle_ended", .ended),
        ]

        for (type, expectedAction) in fixtures {
            let event = try RealtimeEnvelope(
                type: type,
                ts: 1,
                payload: [
                    "huddle_id": .string(huddleID),
                    "channel_id": .string(channelID),
                    "participant_member_ids": .array([.string(memberID)]),
                ]
            ).decodeEvent()
            guard case .huddle(let delta) = event else {
                return XCTFail("expected .huddle for \(type)")
            }
            XCTAssertEqual(delta.action, expectedAction)
            XCTAssertEqual(delta.huddleId.uuidString.lowercased(), huddleID)
            XCTAssertEqual(delta.channelId.description.lowercased(), channelID)
            XCTAssertEqual(delta.participantMemberIds.map { $0.description.lowercased() }, [memberID])
        }
    }

    func testRealtimeDriverSkipsUnknownTypeWithoutEndingStream() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let huddleID = "00000000-0000-7000-8000-000000000020"
        let transport = RealtimeEnvelopeFixtureTransport(envelopes: [
            RealtimeEnvelope(type: "future.event", ts: 1, payload: [:]),
            RealtimeEnvelope(
                type: "huddle_started",
                ts: 2,
                payload: [
                    "huddle_id": .string(huddleID),
                    "channel_id": .string(channel.description),
                    "participant_member_ids": .array([]),
                ]
            ),
        ])
        let driver = DefaultRealtimeSubscriptionDriver(transport: transport)
        let stream = try await driver.subscribe(channel: channel, startingAfter: 0) { _, _ in [] }

        var received: [RealtimeEvent] = []
        for await event in stream { received.append(event) }

        XCTAssertEqual(received.count, 1)
        guard case .huddle(let delta) = received.first else {
            return XCTFail("known event after unknown envelope must still be delivered")
        }
        XCTAssertEqual(delta.action, .started)
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

    func testCostSnapshotEncodesServerOwnedSnakeCaseContract() throws {
        let run = RunID(uuidString: "00000000-0000-7000-8000-000000000904")!
        let snapshot = CostSnapshot(
            runId: run,
            reservedMicroUSD: 0,
            spentMicroUSD: 6,
            softLimitMicroUSD: 900_000,
            hardLimitMicroUSD: 1_000_000,
            isReconciled: true,
            wasEstimated: false,
            limitState: .normal
        )
        let page = CostSnapshotPage(
            channelId: ChannelID(uuidString: "00000000-0000-7000-8000-000000000202")!,
            snapshots: [snapshot],
            asOfMs: 1_782_463_260_000
        )

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder.momo.encode(page)
        ) as? [String: Any]
        let snapshots = object?["snapshots"] as? [[String: Any]]
        let item = snapshots?.first

        XCTAssertEqual(object?["schema"] as? String, "momo.cost_snapshot.channel.v0")
        XCTAssertEqual(item?["run_id"] as? String, run.description)
        XCTAssertEqual(item?["reserved_micro_usd"] as? Int, 0)
        XCTAssertEqual(item?["spent_micro_usd"] as? Int, 6)
        XCTAssertEqual(item?["is_reconciled"] as? Bool, true)
        XCTAssertEqual(item?["was_estimated"] as? Bool, false)
        XCTAssertEqual(item?["limit_state"] as? String, "normal")
        XCTAssertNil(item?["reservedMicroUSD"])
    }

    // MARK: - Read state (ADR-0109)

    func testChannelReadStateDecodesServerSnakeCaseProjection() throws {
        let channel = ChannelID()
        let data = Data("""
        {
          "channel_id": "\(channel.description)",
          "last_read_seq": 7,
          "latest_seq": 12,
          "unread_count": 5,
          "mention_count": 2
        }
        """.utf8)

        let state = try JSONDecoder.momo.decode(ChannelReadState.self, from: data)

        XCTAssertEqual(state.channelId, channel)
        XCTAssertEqual(state.lastReadSeq, 7)
        XCTAssertEqual(state.latestSeq, 12)
        XCTAssertEqual(state.unreadCount, 5)
        XCTAssertEqual(state.mentionCount, 2)
        XCTAssertTrue(state.hasUnread)
        XCTAssertTrue(state.hasMentions)
    }

    func testChannelReadStateIncomingEstimateIsMonotonicAndMentionAware() {
        let channel = ChannelID()
        let state = ChannelReadState(
            channelId: channel,
            lastReadSeq: 7,
            latestSeq: 9,
            unreadCount: 2,
            mentionCount: 1
        )

        XCTAssertEqual(
            state.receivingMessage(sequence: 9, mentionsCurrentMember: true),
            state,
            "duplicate realtime delivery must not increment unread or mentions"
        )
        let updated = state.receivingMessage(sequence: 10, mentionsCurrentMember: true)
        XCTAssertEqual(updated.latestSeq, 10)
        XCTAssertEqual(updated.unreadCount, 3)
        XCTAssertEqual(updated.mentionCount, 2)
        XCTAssertEqual(updated.lastReadSeq, 7)
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

private struct RealtimeEnvelopeFixtureTransport: RealtimeEnvelopeSubscriptionTransport {
    let storedEnvelopes: [RealtimeEnvelope]

    init(envelopes: [RealtimeEnvelope]) {
        storedEnvelopes = envelopes
    }

    func envelopes(channel: ChannelID) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        let storedEnvelopes = self.storedEnvelopes
        return AsyncThrowingStream { continuation in
            for envelope in storedEnvelopes { continuation.yield(envelope) }
            continuation.finish()
        }
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
