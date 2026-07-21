import Foundation
import XCTest
import Hummingbird
@testable import MomoServer

final class MemoryRoutesTests: XCTestCase {
    private let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000501")!
    private let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000502")!
    private let messageID = UUID(uuidString: "00000000-0000-7000-8000-000000000503")!
    private let memoryID = UUID(uuidString: "00000000-0000-7000-8000-000000000504")!

    func testCreateValidationAcceptsConversationMemoryWithSourceLink() throws {
        let input = CreateMemoryRequest(
            scope: "conversation",
            subjectMemberId: nil,
            agentMemberId: nil,
            channelId: channelID,
            kind: "fact",
            body: "  Launch review happens on Thursday.  ",
            confidence: 0.85,
            validAtMs: 1_750_000_000_000,
            sourceRefs: [.init(messageId: messageID, channelId: channelID)]
        )

        let value = try MemoryRoutes.validateCreate(input)
        XCTAssertEqual(value.body, "Launch review happens on Thursday.")
        XCTAssertEqual(value.scope, "conversation")
        XCTAssertEqual(value.sourceRefs.count, 1)
    }

    func testCreateValidationRejectsDuplicateSourceAndInvalidScopeShape() {
        let source = MemorySourceRefRequest(messageId: messageID, channelId: channelID)
        XCTAssertThrowsError(try MemoryRoutes.validateCreate(.init(
            scope: "workspace", subjectMemberId: nil, agentMemberId: nil,
            channelId: channelID, kind: "fact", body: "bounded", confidence: 1,
            validAtMs: nil, sourceRefs: [source]
        )))
        XCTAssertThrowsError(try MemoryRoutes.validateCreate(.init(
            scope: "conversation", subjectMemberId: nil, agentMemberId: nil,
            channelId: channelID, kind: "fact", body: "bounded", confidence: 1,
            validAtMs: nil, sourceRefs: [source, source]
        )))
    }

    func testConfidenceAndBodyValidationFailClosed() {
        XCTAssertThrowsError(try MemoryRoutes.validatedConfidence(-0.01))
        XCTAssertThrowsError(try MemoryRoutes.validatedConfidence(.infinity))
        XCTAssertThrowsError(try MemoryRoutes.validatedBody("   \n"))
        XCTAssertNoThrow(try MemoryRoutes.validatedConfidence(0))
        XCTAssertNoThrow(try MemoryRoutes.validatedConfidence(1))
    }

    func testMemoryUpdatedBroadcastCarriesCanonicalChannelAndNoBody() throws {
        let json = MemoryRoutes.broadcastPayload(
            workspaceID: workspaceID,
            channelID: channelID,
            memoryID: memoryID,
            eventType: "memory.updated",
            action: "invalidated",
            timestampMs: 1234
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        XCTAssertEqual(
            object["channel"] as? String,
            "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        )
        let data = try XCTUnwrap(object["data"] as? [String: Any])
        XCTAssertEqual(data["type"] as? String, "memory.updated")
        let payload = try XCTUnwrap(data["payload"] as? [String: Any])
        XCTAssertEqual(payload["memory_id"] as? String, memoryID.uuidString)
        XCTAssertNil(payload["body"])
        XCTAssertNil(object["credential"])
    }

    func testDeterministicMemoryEmbeddingIsBoundedNormalizedAndStable() throws {
        let first = MemoryEmbedding.deterministic("한국어 launch planning")
        let second = MemoryEmbedding.deterministic("한국어 launch planning")
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.count, 384)
        XCTAssertEqual(sqrt(first.reduce(0) { $0 + $1 * $1 }), 1, accuracy: 0.000_001)
        let literal = try MemoryEmbedding.vectorLiteral(first)
        XCTAssertTrue(literal.hasPrefix("["))
        XCTAssertTrue(literal.hasSuffix("]"))
        XCTAssertEqual(literal.filter { $0 == "," }.count, 383)
    }

    func testMemoryMigrationAndRoutesKeepSecurityContracts() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/027_memory_plane.sql"),
            encoding: .utf8
        )
        for table in [
            "memory_item", "memory_source_ref", "memory_lifecycle_event",
            "memory_candidate", "memory_extraction_cursor", "workspace_memory_policy",
        ] {
            XCTAssertTrue(migration.contains("'\(table)'"))
        }
        XCTAssertTrue(migration.contains("ENABLE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("CREATE POLICY ws_isolation"))
        XCTAssertFalse(migration.contains("message_body"))

        let searchMigration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/028_memory_search.sql"),
            encoding: .utf8
        )
        for contract in [
            "CREATE EXTENSION IF NOT EXISTS vector", "embedding vector(384)",
            "USING hnsw", "USING gin", "memory_search_hybrid",
            "p_actor_member_id", "p_query_embedding IS NOT NULL",
        ] {
            XCTAssertTrue(searchMigration.contains(contract), "missing \(contract)")
        }
        XCTAssertFalse(searchMigration.contains("SECURITY DEFINER"))
        XCTAssertFalse(searchMigration.contains("BYPASSRLS"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/MemoryRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("memory.updated"))
        XCTAssertTrue(routes.contains("memory_lifecycle_event"))
        XCTAssertTrue(routes.contains("memories/search"))
        XCTAssertTrue(routes.contains("::vector(384)"))
        XCTAssertTrue(routes.contains("INSERT INTO outbox"))
        XCTAssertTrue(routes.contains("WorkspaceAuthorization.requireAdmin"))
        XCTAssertFalse(routes.contains("BYPASSRLS"))
        XCTAssertFalse(routes.contains("/:memory\", use: delete"))

        let openAPI = try String(
            contentsOf: serverRoot
                .deletingLastPathComponent()
                .appendingPathComponent("docs/api/openapi.yaml"),
            encoding: .utf8
        )
        for operation in [
            "operationId: listMemories", "operationId: createMemory",
            "operationId: searchMemories",
            "operationId: updateMemory", "operationId: invalidateMemory",
            "operationId: disableAndDeleteAllMemories", "operationId: putMemoryPolicy",
        ] {
            XCTAssertTrue(openAPI.contains(operation))
        }
    }
}
