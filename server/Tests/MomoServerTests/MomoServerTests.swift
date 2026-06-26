import XCTest
@testable import MomoServer

final class MomoServerTests: XCTestCase {
    func testSmoke() {
        XCTAssertEqual("MomoServer", "MomoServer")
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
}
