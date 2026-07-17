import XCTest
@testable import LinkShort

final class LinkShortTests: XCTestCase {
    func testRedirectLocationAssembly() throws {
        let redirector = Redirector(targetBaseURL: "https://chat.example.test")
        XCTAssertEqual(
            try redirector.location(for: "Abc_123-xy.z~"),
            "https://chat.example.test/join/Abc_123-xy.z~"
        )
    }

    func testInvalidCodeIsRejected() {
        let redirector = Redirector(targetBaseURL: "https://chat.example.test")
        XCTAssertThrowsError(try redirector.location(for: "bad!code")) { error in
            XCTAssertEqual(error as? RedirectError, .invalidCode)
        }
    }

    func testMissingTargetEnvironmentIsRejected() {
        XCTAssertThrowsError(try Config.load(environment: [:])) { error in
            XCTAssertEqual(error as? ConfigError, .missingTargetBaseURL)
        }
    }

    func testDefaultPortAndTrailingSlashNormalization() throws {
        let config = try Config.load(environment: [
            "MOMO_LINKSHORT_TARGET_BASE_URL": "https://chat.example.test///"
        ])
        XCTAssertEqual(config.targetBaseURL, "https://chat.example.test")
        XCTAssertEqual(config.port, 28_190)
    }
}
