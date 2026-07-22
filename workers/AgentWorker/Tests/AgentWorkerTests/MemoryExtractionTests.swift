import Foundation
import XCTest
@testable import AgentWorker

final class MemoryExtractionTests: XCTestCase {
    actor RecordingMemorySleeper: MemoryWorkerSleeping {
        private(set) var durations: [Duration] = []

        func sleep(for duration: Duration) async {
            durations.append(duration)
        }
    }

    func testMemoryBatchRetryBacksOffCapsAndResetsAfterSuccess() {
        var retry = MemoryBatchRetryState<String>(
            baseDelay: .seconds(5), maximumDelay: .seconds(300), poisonThreshold: 20
        )
        let delays = (0..<8).map { _ in retry.recordFailure(for: "batch-a").delay }
        XCTAssertEqual(
            delays,
            [.seconds(5), .seconds(10), .seconds(20), .seconds(40),
             .seconds(80), .seconds(160), .seconds(300), .seconds(300)]
        )

        retry.recordSuccess(for: "batch-a")
        let reset = retry.recordFailure(for: "batch-a")
        XCTAssertEqual(reset.delay, .seconds(5))
        XCTAssertEqual(reset.failureCount, 1)
    }

    func testMemoryBatchRetryPoisonsOnlySameBatchAtThreshold() {
        var retry = MemoryBatchRetryState<String>(
            baseDelay: .seconds(1), poisonThreshold: 5
        )
        for expected in 1...4 {
            let decision = retry.recordFailure(for: "batch-a")
            XCTAssertEqual(decision.failureCount, expected)
            XCTAssertFalse(decision.shouldPoison)
        }
        let otherBatch = retry.recordFailure(for: "batch-b")
        XCTAssertEqual(otherBatch.failureCount, 1)
        XCTAssertFalse(otherBatch.shouldPoison)
        XCTAssertTrue(retry.recordFailure(for: "batch-a").shouldPoison)
    }

    func testMemoryWorkerSleeperIsInjectableWithoutWallClockDelay() async {
        let sleeper = RecordingMemorySleeper()
        await sleeper.sleep(for: .seconds(5))
        await sleeper.sleep(for: .seconds(10))
        let durations = await sleeper.durations
        XCTAssertEqual(durations, [.seconds(5), .seconds(10)])
    }

    func testMockEmbeddingIsStableNormalizedAnd384Dimensional() throws {
        let first = WorkerMemoryEmbedding.deterministic("한국어 launch planning")
        let second = WorkerMemoryEmbedding.deterministic("한국어 launch planning")
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.count, 384)
        XCTAssertEqual(sqrt(first.reduce(0) { $0 + $1 * $1 }), 1, accuracy: 0.000_001)
        XCTAssertNoThrow(try WorkerMemoryEmbedding.literal(first))
    }

    private let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000601")!
    private let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000602")!
    private let authorID = UUID(uuidString: "00000000-0000-7000-8000-000000000603")!
    private let messageID = UUID(uuidString: "00000000-0000-7000-8000-000000000604")!
    private let memoryID = UUID(uuidString: "00000000-0000-7000-8000-000000000605")!

    func testMockExtractorParsesFourBranchGrammar() async throws {
        let messages = [
            message("[memory:add kind=fact confidence=0.9] Team uses Swift 6."),
            message("[memory:update id=\(memoryID) kind=procedure confidence=0.8] Run focused tests first."),
            message("[memory:invalidate id=\(memoryID)] Superseded."),
            message("[memory:noop] Not durable."),
            message("ordinary chat must not become memory"),
        ]
        let result = try await MockMemoryExtractor().extract(batch(messages: messages))
        XCTAssertEqual(result.map(\.operation), [.add, .update, .invalidate, .noop])
        XCTAssertEqual(result[0].kind, "fact")
        XCTAssertEqual(result[0].confidence, 0.9)
        XCTAssertEqual(result[1].targetMemoryID, memoryID)
        XCTAssertEqual(result[0].sourceMessageIDs, [messageID])
    }

    func testComparisonTurnsDuplicateAndMissingTargetIntoNoop() {
        let existing = ExistingMemory(
            id: memoryID, kind: "fact", body: "Team uses Swift 6.", confidence: 0.9
        )
        let proposals = [
            MemoryProposal(
                operation: .add, targetMemoryID: nil, kind: "fact",
                body: "team USES swift 6.", confidence: 0.7,
                sourceMessageIDs: [messageID]
            ),
            MemoryProposal(
                operation: .update, targetMemoryID: UUID(), kind: "fact",
                body: "new", confidence: 0.7, sourceMessageIDs: [messageID]
            ),
            MemoryProposal(
                operation: .invalidate, targetMemoryID: memoryID, kind: "fact",
                body: "old", confidence: 0.7, sourceMessageIDs: [messageID]
            ),
        ]
        let result = MemoryExtractionService.compare(proposals, existing: [existing])
        XCTAssertEqual(result.map(\.operation), [.noop, .noop, .invalidate])
        XCTAssertEqual(result[0].targetMemoryID, memoryID)
    }

    func testMockExtractorRejectsOperationTargetShapeMismatch() async throws {
        let messages = [
            message("[memory:add id=\(memoryID)] invalid add"),
            message("[memory:update] missing target"),
            message("[memory:invalidate] missing target"),
        ]
        let result = try await MockMemoryExtractor().extract(batch(messages: messages))
        XCTAssertTrue(result.isEmpty)
    }

    func testHermesDecoderRejectsUnknownSourcesAndInvalidKind() throws {
        let unknown = UUID()
        let json = """
        [
          {"operation":"ADD","kind":"fact","body":"bounded","confidence":0.8,
           "sourceMessageIds":["\(messageID.uuidString)"]},
          {"operation":"ADD","kind":"secret","body":"reject","confidence":0.8,
           "sourceMessageIds":["\(messageID.uuidString)"]},
          {"operation":"ADD","kind":"fact","body":"unknown source","confidence":0.8,
           "sourceMessageIds":["\(unknown.uuidString)"]}
        ]
        """
        let result = try HermesMemoryExtractor.decode(json, allowedSources: [messageID])
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].body, "bounded")
    }

    func testHermesDecoderRejectsOperationTargetShapeMismatch() throws {
        let json = """
        [
          {"operation":"ADD","targetMemoryId":"\(memoryID.uuidString)","kind":"fact",
           "body":"invalid add","confidence":0.8,"sourceMessageIds":["\(messageID.uuidString)"]},
          {"operation":"UPDATE","kind":"fact","body":"missing target","confidence":0.8,
           "sourceMessageIds":["\(messageID.uuidString)"]},
          {"operation":"INVALIDATE","kind":"fact","body":"missing target","confidence":0.8,
           "sourceMessageIds":["\(messageID.uuidString)"]}
        ]
        """
        let result = try HermesMemoryExtractor.decode(json, allowedSources: [messageID])
        XCTAssertTrue(result.isEmpty)
    }

    func testMemoryUpdatedPayloadContainsNoRawTextOrCredential() throws {
        let json = MemoryExtractionService.broadcastPayload(
            workspaceID: workspaceID, channelID: channelID, memoryID: memoryID,
            action: "add", timestampMs: 1234
        )
        XCTAssertTrue(json.contains("memory.updated"))
        XCTAssertTrue(json.contains(memoryID.uuidString))
        XCTAssertFalse(json.contains("body"))
        XCTAssertFalse(json.contains("token"))
        XCTAssertFalse(json.contains("credential"))
    }

    private func message(_ body: String) -> MemoryExtractionMessage {
        .init(id: messageID, seq: 1, authorMemberID: authorID, body: body)
    }

    private func batch(messages: [MemoryExtractionMessage]) -> MemoryExtractionBatch {
        .init(
            workspaceID: workspaceID, channelID: channelID,
            agentMemberID: authorID, model: "mock", messages: messages, existing: []
        )
    }
}
