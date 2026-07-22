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

    func testBorrowedAgentScopeAuditPredicateOnlyFlagsAnotherAgent() {
        let caller = UUID(uuidString: "00000000-0000-7000-8000-000000000510")!
        let otherAgent = UUID(uuidString: "00000000-0000-7000-8000-000000000511")!

        XCTAssertFalse(MemoryRoutes.isBorrowedAgentScope(callerMemberID: caller, agentID: nil))
        XCTAssertFalse(MemoryRoutes.isBorrowedAgentScope(callerMemberID: caller, agentID: caller))
        XCTAssertTrue(
            MemoryRoutes.isBorrowedAgentScope(callerMemberID: caller, agentID: otherAgent)
        )
    }

    func testGatewayMemoryDeliveryReceiptValidatesObservableFields() throws {
        let receipt = try JSONDecoder().decode(
            AgentMemoryDeliveryReceipt.self,
            from: Data(#"{"included_count":2,"injected":true}"#.utf8)
        )

        XCTAssertNoThrow(try receipt.validated())
        XCTAssertEqual(receipt.asObject()["included_count"] as? Int, 2)
        XCTAssertEqual(receipt.asObject()["injected"] as? Bool, true)

        let invalid = try JSONDecoder().decode(
            AgentMemoryDeliveryReceipt.self,
            from: Data(#"{"included_count":0,"injected":true}"#.utf8)
        )
        XCTAssertThrowsError(try invalid.validated())
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
            "operationId: getMemoryExternalProviderConsent",
            "operationId: putMemoryExternalProviderConsent",
        ] {
            XCTAssertTrue(openAPI.contains(operation))
        }

        let consentMigration = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/035_memory_external_provider_consent.sql"
            ),
            encoding: .utf8
        )
        for contract in [
            "memory_external_provider_consent boolean NOT NULL DEFAULT false",
            "memory_external_provider_consent_updated_by",
            "memory.extraction.consent_required",
            "CREATE UNIQUE INDEX audit_log_memory_extraction_consent_required_once",
        ] {
            XCTAssertTrue(consentMigration.contains(contract), "missing \(contract)")
        }
    }

    func testContextPacketMigrationAndRoutesKeepImmutableGrantAwareContract() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/030_context_packet.sql"),
            encoding: .utf8
        )
        for contract in [
            "CREATE TABLE context_packet", "packet_id    uuid PRIMARY KEY DEFAULT uuidv7()",
            "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY",
            "CREATE POLICY ws_isolation", "context_packet_immutable",
            "memory_visibility_grant", "revoked_at IS NULL",
            "grantee_kind = 'member'", "grantee_kind = 'agent'",
            "CREATE OR REPLACE FUNCTION memory_search_hybrid",
        ] {
            XCTAssertTrue(migration.contains(contract), "missing \(contract)")
        }
        XCTAssertFalse(migration.contains("SECURITY DEFINER"))
        XCTAssertFalse(migration.contains("BYPASSRLS"))

        let messageRoutes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/MessageRoutes.swift"
            ), encoding: .utf8
        )
        XCTAssertTrue(messageRoutes.contains("plugin_capability_projection"))
        XCTAssertTrue(messageRoutes.contains("memory_search_hybrid("))
        XCTAssertTrue(messageRoutes.contains("actor_channel_member"))
        XCTAssertTrue(messageRoutes.contains("\"memory_refs\": issuedPacket.memoryRefs"))
        XCTAssertFalse(messageRoutes.contains("mock-github@"))

        let openAPI = try String(
            contentsOf: serverRoot.deletingLastPathComponent()
                .appendingPathComponent("docs/api/openapi.yaml"), encoding: .utf8
        )
        XCTAssertTrue(openAPI.contains("operationId: getContextPacket"))
        XCTAssertTrue(openAPI.contains("ContextPacketResponse:"))
    }
}
