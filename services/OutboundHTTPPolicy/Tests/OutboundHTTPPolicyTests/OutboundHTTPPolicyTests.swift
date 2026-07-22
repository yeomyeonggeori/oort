import Foundation
import XCTest
@testable import OutboundHTTPPolicy

final class OutboundHTTPPolicyTests: XCTestCase {
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
