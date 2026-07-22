import Foundation
import XCTest
@testable import MomoServer

final class AgentCardRoutesTests: XCTestCase {
    func testPrivateAndLinkLocalAddressesAreDenied() {
        for address in [
            "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "127.0.0.1", "169.254.169.254", "::1", "fe80::1", "fc00::1",
            "::ffff:127.0.0.1",
        ] {
            XCTAssertTrue(
                TestFetcher.isDeniedAddress(address),
                "expected \(address) to be denied"
            )
        }
        XCTAssertFalse(TestFetcher.isDeniedAddress("93.184.216.34"))
        XCTAssertFalse(TestFetcher.isDeniedAddress("2606:2800:220:1:248:1893:25c8:1946"))
    }

    func testDNSRebindingCandidateWithAnyPrivateAnswerIsDenied() async throws {
        let fetcher = TestFetcher(
            resolver: StubResolver(addresses: ["93.184.216.34", "127.0.0.1"]),
            transport: ScriptedTransport(responses: [:]),
            allowDevelopmentHTTP: false
        )
        do {
            _ = try await fetcher.validateResolvedTarget(URL(string: "https://agent.example/card")!)
            XCTFail("mixed public/private DNS answer must fail closed")
        } catch {
            XCTAssertEqual(error as? AgentCardFetchError, .privateAddress)
        }
    }

    func testRedirectHopIsRevalidatedBeforeSecondRequest() async throws {
        let start = "https://agent.example/.well-known/agent-card.json"
        let transport = ScriptedTransport(responses: [
            start: .init(status: 302, location: "http://127.0.0.1/card", body: Data()),
        ])
        let fetcher = TestFetcher(
            resolver: StubResolver(addresses: ["93.184.216.34"]),
            transport: transport,
            allowDevelopmentHTTP: true
        )
        do {
            _ = try await fetcher.fetch(sourceURL: "https://agent.example")
            XCTFail("redirect to loopback must fail closed")
        } catch {
            XCTAssertEqual(error as? AgentCardFetchError, .privateAddress)
        }
        let requested = await transport.requestedURLs()
        XCTAssertEqual(requested, [start])
    }

    func testRedirectLimitIsTwoAndEachPublicHopSucceeds() async throws {
        let first = "https://one.example/.well-known/agent-card.json"
        let second = "https://two.example/card"
        let third = "https://three.example/card"
        let transport = ScriptedTransport(responses: [
            first: .init(status: 302, location: second, body: Data()),
            second: .init(status: 307, location: third, body: Data()),
            third: .init(status: 301, location: "https://four.example/card", body: Data()),
        ])
        let fetcher = TestFetcher(
            resolver: StubResolver(addresses: ["93.184.216.34"]),
            transport: transport,
            allowDevelopmentHTTP: false
        )
        do {
            _ = try await fetcher.fetch(sourceURL: "https://one.example")
            XCTFail("third redirect must be rejected")
        } catch {
            XCTAssertEqual(error as? AgentCardFetchError, .tooManyRedirects)
        }
        let requested = await transport.requestedURLs()
        XCTAssertEqual(requested, [first, second, third])
    }

    func testMinimumV03CardParsesSecuritySummaryWithoutSecretMaterial() throws {
        let data = Data(#"""
        {
          "name":"Research Agent",
          "description":"Searches public sources",
          "url":"https://agent.example/a2a",
          "capabilities":{"streaming":true,"pushNotifications":false},
          "securitySchemes":{"bearer":{"type":"http","scheme":"bearer","bearerFormat":"JWT"}},
          "security":[{"bearer":[]}],
          "skills":[]
        }
        """#.utf8)
        let card = try TestFetcher.parse(data, allowDevelopmentHTTP: false)
        XCTAssertEqual(card.name, "Research Agent")
        XCTAssertEqual(card.agentURL, "https://agent.example/a2a")
        XCTAssertEqual(card.capabilities.objectValue?["streaming"], .bool(true))
        XCTAssertNotNil(card.securitySummary.objectValue?["schemes"])
    }

    func testCardContainingCredentialShapedValueIsRejected() throws {
        let data = Data(#"""
        {
          "name":"Bad Agent",
          "url":"https://agent.example/a2a",
          "capabilities":{},
          "clientSecret":"must-not-persist"
        }
        """#.utf8)
        XCTAssertThrowsError(try TestFetcher.parse(data, allowDevelopmentHTTP: false)) {
            guard case .invalidCard(let reason) = $0 as? AgentCardFetchError else {
                return XCTFail("unexpected error: \($0)")
            }
            XCTAssertTrue(reason.contains("credential-shaped"))
        }
    }

    func testRegistrationRequestRejectsUnknownFields() throws {
        let decoder = JSONDecoder()
        XCTAssertNoThrow(
            try decoder.decode(
                RegisterAgentCardRequest.self,
                from: Data(#"{"url":"https://agent.example"}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try decoder.decode(
                RegisterAgentCardRequest.self,
                from: Data(#"{"url":"https://agent.example","token":"secret"}"#.utf8)
            )
        )
    }

    func testMigrationKeepsTenantAndSecretBoundaries() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sql = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/032_agent_card_registration.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(sql.contains("CREATE TABLE agent_card_registration"))
        let normalizedSQL = sql.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        XCTAssertTrue(normalizedSQL.contains("workspace_id uuid NOT NULL"))
        XCTAssertTrue(normalizedSQL.contains("raw_card jsonb NOT NULL"))
        XCTAssertTrue(sql.contains("ENABLE ROW LEVEL SECURITY"))
        XCTAssertTrue(sql.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(sql.contains("CREATE POLICY ws_isolation ON agent_card_registration"))
        for forbidden in ["client_secret", "access_token", "private_key", "credential_ciphertext"] {
            XCTAssertFalse(sql.lowercased().contains(forbidden))
        }
    }
}

private typealias TestFetcher = SafeAgentCardFetcher<StubResolver, ScriptedTransport>

private struct StubResolver: AgentCardHostResolving {
    let addresses: [String]
    func resolve(host: String) async throws -> [String] { addresses }
}

private actor ScriptedTransport: AgentCardHTTPTransport {
    private let responses: [String: AgentCardHTTPResponse]
    private var requested: [String] = []

    init(responses: [String: AgentCardHTTPResponse]) {
        self.responses = responses
    }

    func get(_ url: URL, resolvedAddress: String) async throws -> AgentCardHTTPResponse {
        _ = resolvedAddress
        requested.append(url.absoluteString)
        guard let response = responses[url.absoluteString] else {
            throw AgentCardFetchError.requestFailed
        }
        return response
    }

    func requestedURLs() -> [String] { requested }
}
