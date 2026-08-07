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

    func testWorkSessionToolPreservesRegistryDefinedValues() throws {
        let data = Data(#""gemini-cli""#.utf8)
        let tool = try JSONDecoder().decode(WorkSessionDelta.Tool.self, from: data)

        XCTAssertEqual(tool.rawValue, "gemini-cli")
        XCTAssertEqual(try JSONEncoder().encode(tool), data)
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

    func testArtifactPresentationParsesUnifiedDiffByFile() throws {
        let patch = """
        diff --git a/Sources/App.swift b/Sources/App.swift
        index 1111111..2222222 100644
        --- a/Sources/App.swift
        +++ b/Sources/App.swift
        @@ -1,2 +1,3 @@
         import SwiftUI
        -let title = "Old"
        +let title = "New"
        +let enabled = true
        diff --git a/README.md b/README.md
        --- a/README.md
        +++ b/README.md
        @@ -1 +1 @@
        -Old copy
        +New copy
        """
        let message = artifactMessage(
            type: .diff,
            props: ["artifact_kind": "diff", "title": "App polish", "patch": .string(patch)]
        )

        guard case .diff(let presentation) = MessageArtifactPresentation.resolve(message: message) else {
            return XCTFail("Expected a diff presentation")
        }

        XCTAssertEqual(presentation.title, "App polish")
        XCTAssertEqual(presentation.files.map(\.path), ["Sources/App.swift", "README.md"])
        XCTAssertEqual(presentation.additions, 3)
        XCTAssertEqual(presentation.deletions, 2)
        XCTAssertEqual(presentation.files[0].additions, 2)
        XCTAssertEqual(presentation.files[0].deletions, 1)
    }

    func testArtifactPresentationConservativelyDetectsFencedDiff() throws {
        let message = artifactMessage(
            type: .text,
            body: """
            ```diff
            --- a/a.txt
            +++ b/a.txt
            @@ -1 +1 @@
            -before
            +after
            ```
            """
        )

        guard case .diff(let presentation) = MessageArtifactPresentation.resolve(message: message) else {
            return XCTFail("Expected a detected diff presentation")
        }
        XCTAssertEqual(presentation.files.first?.path, "a.txt")
        XCTAssertEqual(presentation.additions, 1)
        XCTAssertEqual(presentation.deletions, 1)
    }

    func testArtifactPresentationLeavesGeneralCodeAndOversizedDiffToFallback() throws {
        let code = artifactMessage(type: .text, body: "```swift\nlet value = 1\n```")
        XCTAssertNil(MessageArtifactPresentation.resolve(message: code))

        let proseWithDiff = artifactMessage(
            type: .text,
            body: "Here is the requested explanation.\n```diff\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-before\n+after\n```"
        )
        XCTAssertNil(
            MessageArtifactPresentation.resolve(message: proseWithDiff),
            "Auto-detection must not replace prose surrounding a diff excerpt"
        )

        let oversizedPatch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-" + String(repeating: "x", count: 200_001)
        let oversized = artifactMessage(
            type: .diff,
            props: ["artifact_kind": "diff", "patch": .string(oversizedPatch)]
        )
        XCTAssertNil(MessageArtifactPresentation.resolve(message: oversized))
    }

    func testArtifactPresentationTruncatesLargeDiffAndReportsHonestCounts() throws {
        let additionCount = 1_200
        var patchLines = [
            "diff --git a/Sources/BigTable.swift b/Sources/BigTable.swift",
            "--- a/Sources/BigTable.swift",
            "+++ b/Sources/BigTable.swift",
            "@@ -0,0 +1,\(additionCount) @@",
        ]
        for index in 1...additionCount {
            patchLines.append("+let row\(index) = \(index)")
        }
        let patch = patchLines.joined(separator: "\n")
        // 4 header/hunk lines + one line per addition, all in a single file.
        let expectedTotalLines = patchLines.count

        let message = artifactMessage(
            type: .diff,
            props: ["artifact_kind": "diff", "title": "대용량 diff 렌더", "patch": .string(patch)]
        )

        guard case .diff(let presentation) = MessageArtifactPresentation.resolve(message: message) else {
            return XCTFail("Expected a diff presentation")
        }

        XCTAssertTrue(presentation.isTruncated)
        XCTAssertEqual(presentation.totalLineCount, expectedTotalLines)
        XCTAssertEqual(presentation.displayedLineCount, 500)
        XCTAssertEqual(
            presentation.files.reduce(0) { $0 + $1.lines.count },
            500,
            "Rendered body must hold exactly the display cap"
        )
        // Summary counts stay honest even though the body is truncated.
        XCTAssertEqual(presentation.additions, additionCount)
        XCTAssertEqual(presentation.deletions, 0)
        XCTAssertEqual(presentation.files.first?.additions, additionCount)
        XCTAssertFalse(presentation.rawPatch.isEmpty)
    }

    func testArtifactPresentationDoesNotTruncateSmallDiff() throws {
        let patch = """
        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1 +1 @@
        -before
        +after
        """
        let message = artifactMessage(
            type: .diff,
            props: ["artifact_kind": "diff", "patch": .string(patch)]
        )
        guard case .diff(let presentation) = MessageArtifactPresentation.resolve(message: message) else {
            return XCTFail("Expected a diff presentation")
        }
        XCTAssertFalse(presentation.isTruncated)
        XCTAssertEqual(presentation.totalLineCount, presentation.displayedLineCount)
    }

    func testArtifactLinkPresentationAcceptsOnlyCredentialSafeHTTPS() throws {
        let pullRequest = artifactMessage(
            type: .artifact,
            props: [
                "artifact_kind": "pr",
                "title": "Ship artifact cards",
                "branch": "feat/artifacts",
                "status": "ready",
                "repository": "Dawn-kim-official/momo",
                "url": "https://github.com/Dawn-kim-official/momo/pull/592",
            ]
        )
        guard case .link(let safe) = MessageArtifactPresentation.resolve(message: pullRequest) else {
            return XCTFail("Expected a link presentation")
        }
        XCTAssertEqual(safe.kind, .pr)
        XCTAssertEqual(safe.url?.absoluteString, "https://github.com/Dawn-kim-official/momo/pull/592")

        let unsafe = artifactMessage(
            type: .artifact,
            props: [
                "artifact_kind": "commit",
                "url": "https://example.com/commit/abc?capability=secret",
            ]
        )
        guard case .link(let rejectedURL) = MessageArtifactPresentation.resolve(message: unsafe) else {
            return XCTFail("Expected metadata to remain renderable")
        }
        XCTAssertNil(rejectedURL.url)
    }

    private func artifactMessage(
        type: MessageType,
        body: String? = nil,
        props: JSON = .object([:])
    ) -> Message {
        Message(
            id: MessageID(),
            channelId: ChannelID(),
            seq: 1,
            hlcTs: 1,
            authorMemberId: MemberID(),
            type: type,
            body: body,
            props: props
        )
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
        XCTAssertNil(msg.thread, "legacy payloads without a thread projection stay decodable")
        XCTAssertNil(msg.attachments, "legacy payloads without attachments stay decodable")
        XCTAssertFalse(msg.isPendingAck)
        XCTAssertFalse(msg.isDeleted)
    }

    func testMessageThreadRollupDecodesAndRoundTripsAdditively() throws {
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
          "body": "thread root",
          "props": {},
          "created_at_ms": 1718000000123,
          "thread": {
            "reply_count": 3,
            "last_reply_seq": 47,
            "last_reply_at": 1718000000999
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder.momo.decode(Message.self, from: wire)
        XCTAssertEqual(decoded.thread?.replyCount, 3)
        XCTAssertEqual(decoded.thread?.lastReplySeq, 47)
        XCTAssertEqual(decoded.thread?.lastReplyAtMs, 1_718_000_000_999)

        let roundTripped = try JSONDecoder.momo.decode(
            Message.self,
            from: JSONEncoder.momo.encode(decoded)
        )
        XCTAssertEqual(roundTripped, decoded)
    }

    func testMessageAttachmentMetadataDecodesAndRoundTripsAdditively() throws {
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
          "body": "attachment",
          "props": {},
          "created_at_ms": 1718000000123,
          "attachments": [{
            "id": "018f8b2c-0000-7000-8000-000000000004",
            "name": "evidence.txt",
            "mime": "text/plain",
            "sizeBytes": 19
          }]
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder.momo.decode(Message.self, from: wire)
        let attachment = try XCTUnwrap(decoded.attachments?.first)
        let expectedID = try XCTUnwrap(
            FileID(uuidString: "018f8b2c-0000-7000-8000-000000000004")
        )
        XCTAssertEqual(attachment.id, expectedID)
        XCTAssertEqual(attachment.name, "evidence.txt")
        XCTAssertEqual(attachment.mime, "text/plain")
        XCTAssertEqual(attachment.sizeBytes, 19)

        let roundTripped = try JSONDecoder.momo.decode(
            Message.self,
            from: JSONEncoder.momo.encode(decoded)
        )
        XCTAssertEqual(roundTripped, decoded)
        let encoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder.momo.encode(decoded)) as? [String: Any]
        )
        let metadata = try XCTUnwrap((encoded["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(metadata["sizeBytes"] as? Int, 19)
        XCTAssertNil(metadata["uploadUrl"])
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
                "attachments": [[
                    "id": "018f8b2c-0000-7000-8000-000000000013",
                    "name": "realtime.txt",
                    "mime": "text/plain",
                    "sizeBytes": 8,
                ]],
            ]
        )
        let event = try envelope.decodeEvent()
        guard case .message(let m) = event else {
            return XCTFail("expected .message, got \(event)")
        }
        XCTAssertEqual(m.seq, 7)
        XCTAssertEqual(m.body, "hi")
        XCTAssertEqual(m.attachments?.first?.name, "realtime.txt")
        XCTAssertEqual(m.attachments?.first?.sizeBytes, 8)
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

    func testEnvelopeMapsThreadUpdatedWithoutChangingUnknownTypeBehavior() throws {
        let channelID = "018f8b2c-0000-7000-8000-000000000021"
        let rootID = "018f8b2c-0000-7000-8000-000000000020"
        let event = try RealtimeEnvelope(
            type: "thread.updated",
            ts: 1_718_000_000_999,
            seq: 47,
            payload: [
                "channel_id": .string(channelID),
                "root_id": .string(rootID),
                "reply_count": .int(3),
                "last_reply_seq": .int(47),
                "last_reply_at": .int(1_718_000_000_999),
            ]
        ).decodeEvent()

        guard case .threadUpdated(let delta) = event else {
            return XCTFail("expected .threadUpdated")
        }
        XCTAssertEqual(delta.channelId.description.lowercased(), channelID)
        XCTAssertEqual(delta.rootId.description.lowercased(), rootID)
        XCTAssertEqual(delta.rollup, ThreadRollup(
            replyCount: 3,
            lastReplySeq: 47,
            lastReplyAtMs: 1_718_000_000_999
        ))

        XCTAssertThrowsError(
            try RealtimeEnvelope(type: "thread.future", ts: 1, payload: [:]).decodeEvent()
        ) { error in
            guard case RealtimeEnvelope.DecodeError.unknownType("thread.future") = error else {
                return XCTFail("expected unknownType, got \(error)")
            }
        }
    }

    func testThreadUpdatedSharingReplySeqDoesNotAdvanceOrGetDroppedByReplay() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let root = MessageID(uuidString: "00000000-0000-7000-8000-000000000020")!
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 47)
        let envelope = RealtimeEnvelope(
            type: "thread.updated",
            ts: 100,
            seq: 47,
            payload: [
                "channel_id": .string(channel.description),
                "root_id": .string(root.description),
                "reply_count": .int(2),
                "last_reply_seq": .int(47),
                "last_reply_at": .int(100),
            ]
        )

        let events = try await controller.process(envelope) { _, _ in [] }
        guard case .threadUpdated(let delta) = events.first else {
            return XCTFail("thread projection sharing an applied reply seq must be delivered")
        }
        XCTAssertEqual(delta.replyCount, 2)
        let snapshot = await controller.snapshot()
        XCTAssertEqual(snapshot.lastAppliedSeq, 47)
    }

    func testWorkHostListDecodesRESTProjectionWithoutRealtimeKind() throws {
        let wire = Data("""
        {
          "workHosts": [{
            "id": "00000000-0000-7000-8000-000000000487",
            "workspaceId": "00000000-0000-7000-8000-000000000001",
            "scope": "workspace",
            "ownerMemberId": "00000000-0000-7000-8000-000000000101",
            "type": "workd",
            "displayName": "Team VPS",
            "publicKey": "11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c=",
            "capabilities": {"tool.codex": true, "tool.shell": false},
            "lastSeenAtMs": 1784582400000,
            "createdAtMs": 1784582300000,
            "online": true
          }]
        }
        """.utf8)
        let response = try JSONDecoder.momo.decode(WorkHostListResponse.self, from: wire)
        let host = try XCTUnwrap(response.workHosts.first)
        XCTAssertEqual(host.id.description.lowercased(), "00000000-0000-7000-8000-000000000487")
        XCTAssertEqual(host.scope, .workspace)
        XCTAssertEqual(host.type, .workd)
        XCTAssertEqual(host.displayName, "Team VPS")
        XCTAssertEqual(host.capabilities, ["tool.codex": true, "tool.shell": false])
        XCTAssertTrue(host.online)
        XCTAssertFalse(host.isRevoked)

        XCTAssertThrowsError(
            try RealtimeEnvelope(type: "work.host.updated", ts: 1, payload: [:]).decodeEvent()
        ) { error in
            guard case RealtimeEnvelope.DecodeError.unknownType("work.host.updated") = error else {
                return XCTFail("work hosts must remain REST-polled in v0, got \(error)")
            }
        }
    }

    func testWorkSessionEnvelopeKindsRoundTripSnakeCasePayload() throws {
        let sessionID = "00000000-0000-7000-8000-000000000483"
        let channelID = "00000000-0000-7000-8000-000000000201"
        let rootID = "00000000-0000-7000-8000-000000000701"
        let memberID = "00000000-0000-7000-8000-000000000101"
        let hostID = "00000000-0000-7000-8000-000000000901"
        let fixtures: [(String, String, Int64?, Int64?, Int?)] = [
            ("work.session.started", "started", 1_782_463_200_000, nil, nil),
            ("work.session.ended", "ended", nil, 1_782_463_260_000, 0),
        ]

        for (type, action, startedAt, endedAt, exitCode) in fixtures {
            var payload: [String: JSON] = [
                "session_id": .string(sessionID),
                "channel_id": .string(channelID),
                "root_message_id": .string(rootID),
                "member_id": .string(memberID),
                "host_id": .string(hostID),
                "tool": "codex",
                "label": "MOMO-483",
            ]
            if let startedAt { payload["started_at"] = .int(startedAt) }
            if let endedAt { payload["ended_at"] = .int(endedAt) }
            if let exitCode { payload["exit_code"] = .int(Int64(exitCode)) }
            let encoded = try JSONEncoder.momo.encode(RealtimeEnvelope(
                type: type,
                ts: endedAt ?? startedAt ?? 0,
                seq: 43,
                payload: .object(payload)
            ))
            let decoded = try JSONDecoder.momo.decode(RealtimeEnvelope.self, from: encoded)
            guard case .workSession(let delta) = try decoded.decodeEvent() else {
                return XCTFail("expected .workSession")
            }
            XCTAssertEqual(delta.action.rawValue, action)
            XCTAssertEqual(delta.sessionId.description.lowercased(), sessionID)
            XCTAssertEqual(delta.channelId.description.lowercased(), channelID)
            XCTAssertEqual(delta.rootMessageId.description.lowercased(), rootID)
            XCTAssertEqual(delta.memberId.description.lowercased(), memberID)
            XCTAssertEqual(delta.hostId.description.lowercased(), hostID)
            XCTAssertEqual(delta.tool, .codex)
            XCTAssertEqual(delta.label, "MOMO-483")
            XCTAssertEqual(delta.startedAtMs, startedAt)
            XCTAssertEqual(delta.endedAtMs, endedAt)
            XCTAssertEqual(delta.exitCode, exitCode)
        }
    }

    func testWorkSessionEventsSharingCardSeqPassThroughWithoutAdvancingReplay() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let session = "00000000-0000-7000-8000-000000000483"
        let root = "00000000-0000-7000-8000-000000000701"
        let member = "00000000-0000-7000-8000-000000000101"
        let host = "00000000-0000-7000-8000-000000000901"
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 43)
        let base: [String: JSON] = [
            "session_id": .string(session),
            "channel_id": .string(channel.description),
            "root_message_id": .string(root),
            "member_id": .string(member),
            "host_id": .string(host),
            "tool": "shell",
            "label": "Observe only",
        ]
        var started = base
        started["started_at"] = .int(100)
        var ended = base
        ended["ended_at"] = .int(200)
        ended["exit_code"] = .int(0)

        let envelopes = [
            RealtimeEnvelope(
                type: "work.session.started", ts: 100, seq: 43, payload: .object(started)
            ),
            RealtimeEnvelope(
                type: "work.session.ended", ts: 200, seq: 43, payload: .object(ended)
            ),
        ]
        var events: [RealtimeEvent] = []
        for envelope in envelopes {
            events += try await controller.process(envelope) { _, _ in [] }
            let snapshot = await controller.snapshot()
            XCTAssertEqual(snapshot.lastAppliedSeq, 43)
        }
        XCTAssertEqual(events.count, 2)
        guard case .workSession(let startedDelta) = events[0],
              case .workSession(let endedDelta) = events[1]
        else { return XCTFail("both lifecycle kinds must pass through") }
        XCTAssertEqual(startedDelta.action, .started)
        XCTAssertEqual(endedDelta.action, .ended)
        XCTAssertEqual(endedDelta.exitCode, 0)
    }

    func testWorkControlEnvelopeKindsRoundTripSnakeCasePayload() throws {
        let controlID = "00000000-0000-7000-8000-000000000484"
        let channelID = "00000000-0000-7000-8000-000000000201"
        let requesterID = "00000000-0000-7000-8000-000000000103"
        let hostID = "00000000-0000-7000-8000-000000000901"
        let sessionID = "00000000-0000-7000-8000-000000000483"
        let fixtures: [(String, String, String?, Bool?)] = [
            ("work.control.dispatched", "dispatched", nil, nil),
            ("work.control.acked", "acked", "acked", true),
        ]

        for (type, action, status, ok) in fixtures {
            var payload: [String: JSON] = [
                "control_id": .string(controlID),
                "channel_id": .string(channelID),
                "requester_member_id": .string(requesterID),
                "target_host_id": .string(hostID),
                "session_id": .string(sessionID),
                "kind": .string("spawn"),
                "payload": .object([
                    "tool": .string("codex"),
                    "label": .string("MOMO-484"),
                ]),
            ]
            if let status { payload["status"] = .string(status) }
            if let ok { payload["ok"] = .bool(ok) }
            let encoded = try JSONEncoder.momo.encode(RealtimeEnvelope(
                type: type,
                ts: 1_784_452_800_000,
                payload: .object(payload)
            ))
            let decoded = try JSONDecoder.momo.decode(RealtimeEnvelope.self, from: encoded)
            guard case .workControl(let delta) = try decoded.decodeEvent() else {
                return XCTFail("expected .workControl")
            }
            XCTAssertEqual(delta.action.rawValue, action)
            XCTAssertEqual(delta.controlId.description.lowercased(), controlID)
            XCTAssertEqual(delta.channelId.description.lowercased(), channelID)
            XCTAssertEqual(delta.requesterMemberId.description.lowercased(), requesterID)
            XCTAssertEqual(delta.targetHostId.description.lowercased(), hostID)
            XCTAssertEqual(delta.sessionId?.description.lowercased(), sessionID)
            XCTAssertEqual(delta.kind, .spawn)
            XCTAssertEqual(delta.payload["tool"]?.stringValue, "codex")
            XCTAssertEqual(delta.payload["label"]?.stringValue, "MOMO-484")
            XCTAssertEqual(delta.status, status)
            XCTAssertEqual(delta.ok, ok)
        }
    }

    func testWorkControlEventsNeverAdvanceMessageReplayCursor() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 43)
        let base: [String: JSON] = [
            "control_id": .string("00000000-0000-7000-8000-000000000484"),
            "channel_id": .string(channel.description),
            "requester_member_id": .string("00000000-0000-7000-8000-000000000103"),
            "target_host_id": .string("00000000-0000-7000-8000-000000000901"),
            "session_id": .null,
            "kind": .string("spawn"),
            "payload": .object([
                "tool": .string("codex"),
                "label": .string("MOMO-484"),
            ]),
        ]
        let envelopes = [
            RealtimeEnvelope(
                type: "work.control.dispatched", ts: 100, seq: nil, payload: .object(base)
            ),
            RealtimeEnvelope(
                type: "work.control.acked", ts: 200, seq: 999,
                payload: .object(base.merging([
                    "status": .string("failed"),
                    "ok": .bool(false),
                    "error_label": .string("host_unavailable"),
                ]) { _, new in new })
            ),
        ]
        var events: [RealtimeEvent] = []
        for envelope in envelopes {
            events += try await controller.process(envelope) { _, _ in [] }
            let snapshot = await controller.snapshot()
            XCTAssertEqual(snapshot.lastAppliedSeq, 43)
        }
        XCTAssertEqual(events.count, 2)
        guard case .workControl(let dispatched) = events[0],
              case .workControl(let acked) = events[1]
        else { return XCTFail("both work control kinds must pass through") }
        XCTAssertEqual(dispatched.action, .dispatched)
        XCTAssertEqual(acked.action, .acked)
        XCTAssertEqual(acked.ok, false)
        XCTAssertEqual(acked.errorLabel, "host_unavailable")
    }

    func testInteractionEventsSharingAppliedMessageSeqDeliverWithoutAdvancingReplayCursor() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let reactor = MemberID(uuidString: "00000000-0000-7000-8000-000000000102")!
        let original = Self.message(channel: channel, author: author, seq: 48, body: "original")
        let edited = Message(
            id: original.id,
            channelId: channel,
            seq: 48,
            hlcTs: 48,
            authorMemberId: author,
            state: .edited,
            body: "edited",
            editedAtMs: 100
        )
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 47)
        let backfill = BackfillScript(pages: [:])

        let messageEvents = try await controller.process(Self.envelope(original)) { after, limit in
            await backfill.backfill(after: after, limit: limit)
        }
        XCTAssertEqual(messageEvents.messageSeqs, [48])

        let envelopes = [
            Self.envelope(edited, type: RealtimeEnvelope.EventType.messageEdited.rawValue),
            RealtimeEnvelope(
                type: RealtimeEnvelope.EventType.reactionAdded.rawValue,
                ts: 101,
                seq: 48,
                payload: [
                    "action": "added",
                    "message_id": .string(original.id.description),
                    "member_id": .string(reactor.description),
                    "emoji": "👍",
                ]
            ),
            RealtimeEnvelope(
                type: RealtimeEnvelope.EventType.reactionRemoved.rawValue,
                ts: 102,
                seq: 48,
                payload: [
                    "action": "removed",
                    "message_id": .string(original.id.description),
                    "member_id": .string(reactor.description),
                    "emoji": "👍",
                ]
            ),
            RealtimeEnvelope(
                type: RealtimeEnvelope.EventType.messageDeleted.rawValue,
                ts: 103,
                seq: 48,
                payload: ["message_id": .string(original.id.description)]
            ),
        ]

        var interactionEvents: [RealtimeEvent] = []
        for envelope in envelopes {
            interactionEvents += try await controller.process(envelope) { after, limit in
                await backfill.backfill(after: after, limit: limit)
            }
            let snapshot = await controller.snapshot()
            XCTAssertEqual(snapshot.lastAppliedSeq, 48)
        }

        XCTAssertEqual(interactionEvents.count, 4)
        guard case .messageEdited(let deliveredEdit) = interactionEvents[0] else {
            return XCTFail("old-seq message.edited must be delivered")
        }
        XCTAssertEqual(deliveredEdit.body, "edited")
        guard case .reaction(let added) = interactionEvents[1] else {
            return XCTFail("old-seq reaction.added must be delivered")
        }
        XCTAssertEqual(added.action, .added)
        guard case .reaction(let removed) = interactionEvents[2] else {
            return XCTFail("old-seq reaction.removed must be delivered")
        }
        XCTAssertEqual(removed.action, .removed)
        guard case .messageDeleted(let deletedID) = interactionEvents[3] else {
            return XCTFail("old-seq message.deleted must be delivered")
        }
        XCTAssertEqual(deletedID, original.id)
        let backfillCalls = await backfill.calls()
        XCTAssertTrue(backfillCalls.isEmpty)
    }

    // MARK: - #1130 전제① — the growing body

    private static func streamed(
        _ base: Message,
        body: String,
        rev: Int64,
        streaming: Bool = true
    ) -> Message {
        var message = base
        message.body = body
        message.props = .object([
            Message.streamPropsKey: .object([
                "rev": .int(rev),
                "streaming": .bool(streaming),
            ])
        ])
        return message
    }

    /// A growing agent answer is one message and one seq, delivered as slices on
    /// the **non-sequenced** `message.edited` rail — and each slice carries the
    /// whole body, so nothing is re-read to render it.
    ///
    /// The measured shape (#1120 prime 스파이크 §2): 17 writes for one answer.
    /// Were every slice a `message.new`, this assertion would read 17 seqs.
    func testStreamingSlicesGrowOneMessageWithoutConsumingASeq() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let opening = Self.message(channel: channel, author: author, seq: 12, body: "1번째")
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 11)
        let backfill = BackfillScript(pages: [:])

        var events = try await controller.process(Self.envelope(opening)) { after, limit in
            await backfill.backfill(after: after, limit: limit)
        }
        XCTAssertEqual(events.messageSeqs, [12])

        var accumulated = "1번째"
        for rev in Int64(1)...16 {
            accumulated += " \(rev + 1)번째"
            let slice = Self.streamed(
                opening,
                body: accumulated,
                rev: rev,
                streaming: rev != 16
            )
            events += try await controller.process(
                Self.envelope(slice, type: RealtimeEnvelope.EventType.messageEdited.rawValue)
            ) { after, limit in
                await backfill.backfill(after: after, limit: limit)
            }
        }

        let snapshot = await controller.snapshot()
        XCTAssertEqual(snapshot.lastAppliedSeq, 12, "16 slices must not advance the cursor")
        XCTAssertEqual(events.count, 17, "one open + 16 slices, none suppressed")
        guard case .messageEdited(let last) = events.last else {
            return XCTFail("the last event is the final slice")
        }
        XCTAssertEqual(last.body, accumulated, "the frame carries the whole body — nothing is re-read")
        XCTAssertEqual(last.streamRev, 16)
        XCTAssertFalse(last.isStreamingBody, "the final slice says the text stopped arriving")
        XCTAssertNil(last.editedAtMs, "an answer arriving is not a revision of itself")
        let backfillCalls = await backfill.calls()
        XCTAssertTrue(backfillCalls.isEmpty, "a slice never triggers a backfill")
    }

    /// **RED.** `message.edited` skips the replay cursor by design, so nothing
    /// but this rule orders two slices of the same message. Drop
    /// `admitStreamSlice` and a slice that lost the race to its own successor
    /// rewinds the body on screen mid-sentence.
    func testAStaleOrReplayedStreamSliceIsDroppedAndTheBodyNeverRewinds() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let opening = Self.message(channel: channel, author: author, seq: 5, body: "하나")
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 4)
        let backfill = BackfillScript(pages: [:])
        func feed(_ message: Message, type: String) async throws -> [RealtimeEvent] {
            try await controller.process(Self.envelope(message, type: type)) { after, limit in
                await backfill.backfill(after: after, limit: limit)
            }
        }

        _ = try await feed(opening, type: "message.new")
        let edited = RealtimeEnvelope.EventType.messageEdited.rawValue
        _ = try await feed(Self.streamed(opening, body: "하나 둘", rev: 1), type: edited)
        _ = try await feed(Self.streamed(opening, body: "하나 둘 셋", rev: 2), type: edited)

        // A replay of rev 2, then rev 1 arriving late with a body that is a
        // prefix of the truth. Both must vanish.
        let replay = try await feed(Self.streamed(opening, body: "하나 둘 셋", rev: 2), type: edited)
        XCTAssertTrue(replay.isEmpty, "a replayed slice is dropped")
        let overtaken = try await feed(Self.streamed(opening, body: "하나 둘", rev: 1), type: edited)
        XCTAssertTrue(overtaken.isEmpty, "a slice that lost the race to its successor is dropped")

        let forward = try await feed(Self.streamed(opening, body: "하나 둘 셋 넷", rev: 3), type: edited)
        XCTAssertEqual(forward.count, 1, "…but the stream itself never stalls")
    }

    /// **RED, and the reason `isStreamSlice` reads two fields instead of one.**
    ///
    /// A streamed message keeps its `momo.stream` props forever, so a person
    /// later correcting it arrives carrying the *same* revision. A staleness
    /// rule that only compared revisions would swallow their correction — the
    /// user would watch their own edit disappear. `editedAtMs` is what tells the
    /// two apart, and the server's asymmetry (stamped on every edit, on no
    /// slice) is what makes that reliable.
    func testAHumanEditAfterAStreamIsNeverDroppedAsStale() async throws {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let opening = Self.message(channel: channel, author: author, seq: 5, body: "초안")
        let controller = RealtimeReplayController(channel: channel, lastAppliedSeq: 4)
        let backfill = BackfillScript(pages: [:])
        let edited = RealtimeEnvelope.EventType.messageEdited.rawValue
        func feed(_ message: Message) async throws -> [RealtimeEvent] {
            try await controller.process(Self.envelope(message, type: edited)) { after, limit in
                await backfill.backfill(after: after, limit: limit)
            }
        }

        _ = try await controller.process(Self.envelope(opening)) { after, limit in
            await backfill.backfill(after: after, limit: limit)
        }
        _ = try await feed(Self.streamed(opening, body: "초안 완성", rev: 3, streaming: false))

        var correction = Self.streamed(opening, body: "사람이 고친 문장", rev: 3, streaming: false)
        correction.state = .edited
        correction.editedAtMs = 1_700_000_000_000
        XCTAssertFalse(correction.isStreamSlice, "a stamped edit clock is never a slice")

        let delivered = try await feed(correction)
        XCTAssertEqual(delivered.count, 1, "a person's correction is never dropped as stale")
        guard case .messageEdited(let message) = delivered[0] else {
            return XCTFail("expected message.edited")
        }
        XCTAssertEqual(message.body, "사람이 고친 문장")
        XCTAssertEqual(message.state, .edited)
    }

    /// A message that never streamed reads as no revision at all, and a message
    /// mid-stream says so. Both are what a renderer branches on.
    func testStreamMarkersAreAbsentUntilAMessageStreams() {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let plain = Self.message(channel: channel, author: author, seq: 1, body: "사람이 쓴 글")
        XCTAssertNil(plain.streamRev)
        XCTAssertFalse(plain.isStreamingBody)
        XCTAssertFalse(plain.isStreamSlice)

        let mid = Self.streamed(plain, body: "답이 자라는 중", rev: 4)
        XCTAssertEqual(mid.streamRev, 4)
        XCTAssertTrue(mid.isStreamingBody)
        XCTAssertTrue(mid.isStreamSlice)

        let settled = Self.streamed(plain, body: "답", rev: 5, streaming: false)
        XCTAssertEqual(settled.streamRev, 5)
        XCTAssertFalse(settled.isStreamingBody, "the text stopped arriving")
        XCTAssertTrue(
            settled.isStreamSlice,
            "…but the final slice is still a slice, so its own replay is still droppable"
        )
    }

    func testBackfillProjectionCanReapplyDuplicateInteractionEventsIdempotently() {
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let author = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let reactor = MemberID(uuidString: "00000000-0000-7000-8000-000000000102")!
        let editedFromHistory = Message(
            id: MessageID(uuidString: "00000000-0000-7000-8000-000000000201")!,
            channelId: channel,
            seq: 48,
            hlcTs: 48,
            authorMemberId: author,
            state: .edited,
            body: "history edit",
            editedAtMs: 100
        )
        var projection = RealtimeProjectionFixture()

        projection.apply(.message(editedFromHistory))
        projection.apply(.messageEdited(editedFromHistory))
        projection.apply(.messageEdited(editedFromHistory))
        XCTAssertEqual(projection.messages[editedFromHistory.id]?.body, "history edit")
        XCTAssertEqual(projection.messages[editedFromHistory.id]?.state, .edited)

        let add = RealtimeEvent.reaction(ReactionDelta(
            action: .added,
            messageId: editedFromHistory.id,
            memberId: reactor,
            emoji: "👍"
        ))
        projection.apply(add)
        projection.apply(add)
        XCTAssertEqual(projection.reactions[editedFromHistory.id]?["👍"], Set([reactor]))

        let remove = RealtimeEvent.reaction(ReactionDelta(
            action: .removed,
            messageId: editedFromHistory.id,
            memberId: reactor,
            emoji: "👍"
        ))
        projection.apply(remove)
        projection.apply(remove)
        XCTAssertNil(projection.reactions[editedFromHistory.id])

        let delete = RealtimeEvent.messageDeleted(editedFromHistory.id)
        projection.apply(delete)
        projection.apply(delete)
        XCTAssertEqual(projection.messages[editedFromHistory.id]?.state, .deleted)
        XCTAssertNil(projection.messages[editedFromHistory.id]?.body)
    }

    func testServerMessageInteractionPayloadsDecodeAllFourKinds() throws {
        let messageID = "018f8b2c-0000-7000-8000-000000000020"
        let channelID = "018f8b2c-0000-7000-8000-000000000021"
        let memberID = "018f8b2c-0000-7000-8000-000000000022"
        let fixtures = [
            """
            {"type":"message.edited","v":1,"ts":1718000000100,"seq":7,"payload":{
              "id":"\(messageID)","channel_id":"\(channelID)","seq":7,
              "hlc_ts":1718000000000,"hlc_count":0,"author_member_id":"\(memberID)",
              "type":"text","state":"edited","body":"edited","props":{},
              "root_id":null,"run_id":null,"client_msg_id":null,
              "created_at_ms":1718000000000,"edited_at_ms":1718000000100,
              "deleted_at_ms":null}}
            """,
            """
            {"type":"message.deleted","v":1,"ts":1718000000200,"seq":7,
             "payload":{"message_id":"\(messageID)"}}
            """,
            """
            {"type":"reaction.added","v":1,"ts":1718000000300,"seq":7,"payload":{
              "action":"added","message_id":"\(messageID)",
              "member_id":"\(memberID)","emoji":"👍"}}
            """,
            """
            {"type":"reaction.removed","v":1,"ts":1718000000400,"seq":7,"payload":{
              "action":"removed","message_id":"\(messageID)",
              "member_id":"\(memberID)","emoji":"👍"}}
            """,
        ]
        let decoder = JSONDecoder.momo
        let events = try fixtures.map {
            try decoder.decode(RealtimeEnvelope.self, from: Data($0.utf8)).decodeEvent()
        }

        guard case .messageEdited(let edited) = events[0] else {
            return XCTFail("expected message.edited")
        }
        XCTAssertEqual(edited.body, "edited")
        XCTAssertEqual(edited.state, .edited)
        XCTAssertEqual(edited.editedAtMs, 1718000000100)

        guard case .messageDeleted(let deletedID) = events[1] else {
            return XCTFail("expected message.deleted")
        }
        XCTAssertEqual(deletedID.description.lowercased(), messageID)

        for (index, expectedAction) in [(2, ReactionDelta.Action.added), (3, .removed)] {
            guard case .reaction(let delta) = events[index] else {
                return XCTFail("expected reaction delta at index \(index)")
            }
            XCTAssertEqual(delta.action, expectedAction)
            XCTAssertEqual(delta.messageId.description.lowercased(), messageID)
            XCTAssertEqual(delta.memberId.description.lowercased(), memberID)
            XCTAssertEqual(delta.emoji, "👍")
        }
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
            RealtimeEnvelope(
                type: "agent.partial",
                ts: 3,
                payload: [
                    "run_id": "00000000-0000-7000-8000-000000000030",
                    "channel_id": .string(channel.description),
                    "text_delta": "still connected",
                ]
            ),
        ])
        let driver = DefaultRealtimeSubscriptionDriver(transport: transport)
        let stream = try await driver.subscribe(channel: channel, startingAfter: 0) { _, _ in [] }

        var received: [RealtimeEvent] = []
        for await event in stream { received.append(event) }

        XCTAssertEqual(received.count, 2)
        guard case .huddle(let delta) = received.first else {
            return XCTFail("known event after unknown envelope must still be delivered")
        }
        XCTAssertEqual(delta.action, .started)
        guard case .agentPartial(let partial) = received.last else {
            return XCTFail("existing realtime events must still be delivered after an unknown type")
        }
        XCTAssertEqual(partial.textDelta, "still connected")
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
        let attachmentID = FileID()
        let draft = DraftMessage(
            channelId: ChannelID(),
            type: .text,
            body: "yo",
            attachmentIds: [attachmentID]
        )
        let data = try JSONEncoder.momo.encode(draft)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNotNil(obj["channel_id"])
        XCTAssertEqual(obj["body"] as? String, "yo")
        XCTAssertEqual(obj["attachmentIds"] as? [String], [attachmentID.description])
        XCTAssertNil(obj["attachment_ids"])

        let legacy = """
        {"channel_id":"018f8b2c-0000-7000-8000-000000000002","type":"text","body":"old","props":{}}
        """.data(using: .utf8)!
        XCTAssertNil(try JSONDecoder.momo.decode(DraftMessage.self, from: legacy).attachmentIds)
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

    private static func envelope(_ message: Message, type: String = "message.new") -> RealtimeEnvelope {
        var payload: [String: JSON] = [
            "id": .string(message.id.description),
            "channel_id": .string(message.channelId.description),
            "seq": .int(message.seq ?? 0),
            "hlc_ts": .int(message.hlcTs),
            "hlc_count": .int(Int64(message.hlcCount)),
            "author_member_id": .string(message.authorMemberId.description),
            "type": .string(message.type.rawValue),
            "state": .string(message.state.rawValue),
            "body": message.body.map(JSON.string) ?? .null,
            "props": message.props,
        ]
        if let editedAtMs = message.editedAtMs {
            payload["edited_at_ms"] = .int(editedAtMs)
        }
        if let deletedAtMs = message.deletedAtMs {
            payload["deleted_at_ms"] = .int(deletedAtMs)
        }
        return RealtimeEnvelope(
            type: type,
            ts: message.hlcTs,
            seq: message.seq,
            payload: .object(payload)
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

private struct RealtimeProjectionFixture {
    var messages: [MessageID: Message] = [:]
    var reactions: [MessageID: [String: Set<MemberID>]] = [:]

    mutating func apply(_ event: RealtimeEvent) {
        switch event {
        case .message(let message), .messageEdited(let message):
            messages[message.id] = message
        case .messageDeleted(let id):
            if var message = messages[id] {
                message.state = .deleted
                message.body = nil
                messages[id] = message
            }
            reactions[id] = nil
        case .reaction(let delta):
            var byEmoji = reactions[delta.messageId] ?? [:]
            var members = byEmoji[delta.emoji] ?? []
            switch delta.action {
            case .added: members.insert(delta.memberId)
            case .removed: members.remove(delta.memberId)
            }
            byEmoji[delta.emoji] = members.isEmpty ? nil : members
            reactions[delta.messageId] = byEmoji.isEmpty ? nil : byEmoji
        case .threadUpdated, .typing, .presence, .agentStatus, .agentPartial, .approval, .huddle,
             .workSession, .workControl:
            break
        }
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
