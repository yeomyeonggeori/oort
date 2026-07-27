import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

final class CloudProvisionerTests: XCTestCase {
    func testMissingE2BKeyFailsOnlyCloudConfigClosed() {
        let config = CloudProvisionerConfig.load(environment: [
            "E2B_TEMPLATE_ID": "momo-workd",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test",
        ])
        XCTAssertThrowsError(try config.requireReady()) { error in
            XCTAssertEqual(error as? CloudProvisionerError, .missingAPIKey)
        }
        XCTAssertThrowsError(try CloudProvisionerRoutes.readyConfig(config)) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .serviceUnavailable)
        }
    }

    func testCloudConfigClampsAndRequiresPublicHTTPS() throws {
        let valid = CloudProvisionerConfig.load(environment: [
            "E2B_API_KEY": "operator-secret",
            "E2B_TEMPLATE_ID": "momo-workd",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test/",
            "E2B_SANDBOX_TIMEOUT_SECONDS": "1",
            "MOMO_T3_RATE_MICRO_USD_PER_SECOND": "0",
        ])
        let ready = try valid.requireReady()
        XCTAssertEqual(ready.sandboxTimeoutSeconds, 60)
        XCTAssertEqual(ready.unitRateMicroUSDSecond, 1)
        XCTAssertEqual(ready.publicServerURL, "https://momo.example.test")

        let insecure = CloudProvisionerConfig.load(environment: [
            "E2B_API_KEY": "operator-secret",
            "E2B_TEMPLATE_ID": "momo-workd",
            "MOMO_PUBLIC_BASE_URL": "http://momo.example.test",
        ])
        XCTAssertThrowsError(try insecure.requireReady()) { error in
            XCTAssertEqual(error as? CloudProvisionerError, .invalidPublicServerURL)
        }
    }

    func testBootstrapTokenDigestIsDeterministicWithoutRawToken() {
        let token = "test-bootstrap-token-that-is-never-stored-raw"
        let digest = CloudProvisionerRoutes.tokenDigest(token)
        XCTAssertEqual(digest.count, 64)
        XCTAssertNotEqual(digest, token)
        XCTAssertEqual(digest, CloudProvisionerRoutes.tokenDigest(token))
    }

    func testT3MigrationSeparatesTokenAndActiveTimeLedgers() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sql = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/045_t3_provisioner_credit_ledger.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(sql.contains("CREATE TABLE work_host_usage"))
        XCTAssertTrue(sql.contains("CREATE TABLE work_host_usage_interval"))
        XCTAssertTrue(sql.contains("WHEN state = 'active' AND ended_at IS NOT NULL"))
        XCTAssertTrue(sql.contains("ELSE 0"))
        XCTAssertTrue(sql.contains("CREATE TABLE workspace_credit"))
        XCTAssertTrue(sql.contains("CREATE TABLE credit_entry"))
        XCTAssertTrue(sql.contains("ALTER TABLE %I FORCE ROW LEVEL SECURITY"))
        XCTAssertFalse(sql.contains("ALTER TABLE usage_ledger"))
    }
}
