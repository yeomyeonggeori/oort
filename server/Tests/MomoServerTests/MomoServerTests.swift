import XCTest
@testable import MomoServer

final class MomoServerTests: XCTestCase {
    func testSmoke() {
        XCTAssertEqual("MomoServer", "MomoServer")
    }

    func testInviteRoleValidationDefaultsAndRejectsOwner() throws {
        XCTAssertEqual(try InviteRoutes.normalizedRole(nil), "member")
        XCTAssertEqual(try InviteRoutes.normalizedRole(" ADMIN "), "admin")
        XCTAssertEqual(try InviteRoutes.normalizedRole("guest"), "guest")
        XCTAssertThrowsError(try InviteRoutes.normalizedRole("owner"))
        XCTAssertThrowsError(try InviteRoutes.normalizedRole("agent"))
    }

    func testInviteMaxUsesValidationMatchesMigrationConstraint() throws {
        XCTAssertEqual(try InviteRoutes.validatedMaxUses(nil), 1)
        XCTAssertEqual(try InviteRoutes.validatedMaxUses(10_000), 10_000)
        XCTAssertThrowsError(try InviteRoutes.validatedMaxUses(0))
        XCTAssertThrowsError(try InviteRoutes.validatedMaxUses(10_001))
    }

    func testInboundMCPToolSurfaceMatchesMOMO163() {
        let names = InboundMCPToolRegistry.tools.map(\.name)
        XCTAssertEqual(
            names,
            [.searchMessages, .fetchThread, .postMessage, .createToolCall]
        )
    }

    func testInboundMCPPoliciesRequireRLSAndExpectedScopes() {
        let policies = Dictionary(
            uniqueKeysWithValues: InboundMCPToolRegistry.tools.map { ($0.name, $0.policy) }
        )

        XCTAssertEqual(policies[.searchMessages]?.requiredScopes, [.read])
        XCTAssertEqual(policies[.fetchThread]?.requiredScopes, [.read])
        XCTAssertEqual(policies[.postMessage]?.requiredScopes, [.post])
        XCTAssertEqual(policies[.createToolCall]?.requiredScopes, [.toolPropose])

        for policy in policies.values {
            XCTAssertTrue(policy.requiresRLS)
            XCTAssertTrue(policy.requiresChannelMembership)
            XCTAssertFalse(policy.executesProviderTool)
            XCTAssertFalse(policy.auditAction.isEmpty)
        }

        XCTAssertEqual(
            policies[.postMessage]?.canonicalWritePath,
            "channel_seq_bump_message_insert_outbox_insert"
        )
        XCTAssertEqual(
            policies[.createToolCall]?.writes,
            ["message:tool_call", "approval", "message:approval_request", "outbox", "audit_log"]
        )
    }

    func testInboundMCPDiscoveryIsCodable() throws {
        let discovery = InboundMCPToolRegistry.discoveryResponse()
        let data = try JSONEncoder().encode(discovery)
        let decoded = try JSONDecoder().decode(InboundMCPDiscoveryResponse.self, from: data)

        XCTAssertEqual(decoded.schema, "momo.inbound_mcp.discovery_snapshot.v0")
        XCTAssertEqual(decoded.server.protocolVersion, "2025-06-18")
        XCTAssertTrue(decoded.server.capabilities.tools.listChanged)
        XCTAssertTrue(decoded.runtimeStatus.contains("runtime-unverified"))
    }

    func testSearchMessagesRequiresBoundedChannelIDsInDescriptor() throws {
        let descriptor = InboundMCPToolRegistry.descriptor(named: .searchMessages)
        let schema = try XCTUnwrap(descriptor.inputSchema.objectValue)
        let required = try XCTUnwrap(schema["required"]?.arrayValue)
            .compactMap(\.stringValue)
        let properties = try XCTUnwrap(schema["properties"]?.objectValue)
        let channelIDs = try XCTUnwrap(properties["channel_ids"]?.objectValue)

        XCTAssertTrue(required.contains("channel_ids"))
        XCTAssertEqual(channelIDs["maxItems"], .int(InboundMCPToolRegistry.searchMessagesMaxChannelIDs))
    }

    func testSearchMessagesChannelIDsFailClosedBeforeDBPreflight() throws {
        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: ["workspace_id": .string("00000000-0000-7000-8000-000000000001")]
        ))

        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: [
                "channel_ids": .array([])
            ]
        ))

        let tooMany = (0...InboundMCPToolRegistry.searchMessagesMaxChannelIDs)
            .map { JSONValue.string(String(format: "00000000-0000-7000-8000-%012d", $0)) }
        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: [
                "channel_ids": .array(tooMany)
            ]
        ))
    }
}
