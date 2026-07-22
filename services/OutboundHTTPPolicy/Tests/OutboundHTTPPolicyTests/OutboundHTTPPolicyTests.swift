import Foundation
import XCTest
@testable import OutboundHTTPPolicy

final class OutboundHTTPPolicyTests: XCTestCase {
    func testProviderEndpointTrustSeparatesLocalSelfHostedAndExternal() {
        XCTAssertEqual(
            ProviderEndpointTrustPolicy.classify(
                providerMode: "local-mock", baseURL: "https://api.openai.com/v1"
            ),
            .localMock
        )
        for url in [
            "http://127.0.0.1:8088/v1",
            "http://10.20.30.40:8088/v1",
            "http://172.31.4.5/v1",
            "https://192.168.1.4/v1",
            "http://[::1]:8088/v1",
            "http://[fd00::1]/v1",
        ] {
            XCTAssertEqual(
                ProviderEndpointTrustPolicy.classify(
                    providerMode: "external-hermes", baseURL: url
                ),
                .selfHosted,
                url
            )
        }
        XCTAssertEqual(
            ProviderEndpointTrustPolicy.classify(
                providerMode: "external-hermes", baseURL: "https://api.openai.com/v1"
            ),
            .external
        )
        XCTAssertEqual(
            ProviderEndpointTrustPolicy.classify(
                providerMode: "external-hermes", baseURL: "not-a-url"
            ),
            .external
        )
    }

    func testPrivateLinkLocalAndMappedAddressesAreDenied() {
        for address in [
            "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "127.0.0.1", "169.254.169.254", "::1", "fe80::1", "fc00::1",
            "::ffff:127.0.0.1",
        ] {
            XCTAssertTrue(OutboundURLPolicy.isDeniedAddress(address), address)
        }
        XCTAssertFalse(OutboundURLPolicy.isDeniedAddress("93.184.216.34"))
    }

    func testMixedPublicPrivateDNSAnswerFailsClosed() async throws {
        let url = URL(string: "https://hooks.example/events")!
        do {
            _ = try await OutboundURLPolicy.validatedResolvedAddresses(
                for: url,
                resolver: StubResolver(addresses: ["93.184.216.34", "127.0.0.1"])
            )
            XCTFail("mixed DNS answers must fail closed")
        } catch {
            XCTAssertEqual(error as? OutboundURLPolicyError, .privateAddress)
        }
    }

    func testURLRejectsCredentialsFragmentsAndPlainHTTP() throws {
        XCTAssertThrowsError(
            try OutboundURLPolicy.validatedURL(
                URL(string: "https://user:pass@hooks.example/events")!,
                allowDevelopmentHTTP: false
            )
        )
        XCTAssertThrowsError(
            try OutboundURLPolicy.validatedURL(
                URL(string: "https://hooks.example/events#secret")!,
                allowDevelopmentHTTP: false
            )
        )
        XCTAssertThrowsError(
            try OutboundURLPolicy.validatedURL(
                URL(string: "http://hooks.example/events")!,
                allowDevelopmentHTTP: false
            )
        )
    }
}

private struct StubResolver: OutboundHostResolving {
    let addresses: [String]
    func resolve(host: String) async throws -> [String] { addresses }
}
