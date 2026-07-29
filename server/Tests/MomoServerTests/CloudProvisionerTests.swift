import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

final class CloudProvisionerTests: XCTestCase {
    func testCloudCreditTopupRejectsPlatformReadWithoutWriteScope() {
        XCTAssertFalse(CloudCreditRoutes.isCreditWriter(
            kind: .human,
            scopes: ["platform:read"]
        ))
        XCTAssertTrue(CloudCreditRoutes.isCreditWriter(
            kind: .human,
            scopes: ["platform:read", CloudCreditRoutes.writeScope]
        ))
        XCTAssertFalse(CloudCreditRoutes.isCreditWriter(
            kind: .agent,
            scopes: [CloudCreditRoutes.writeScope]
        ))
    }

    func testT3IsDisabledByDefaultEvenWhenE2BConfigurationExists() {
        let config = CloudProvisionerConfig.load(environment: [
            "E2B_API_KEY": "operator-secret",
            "E2B_TEMPLATE_ID": "momo-workd",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test",
        ])
        XCTAssertFalse(config.enabled)
        XCTAssertThrowsError(try config.requireReady()) { error in
            XCTAssertEqual(error as? CloudProvisionerError, .disabled)
        }
        XCTAssertThrowsError(try CloudProvisionerRoutes.readyConfig(config)) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .serviceUnavailable)
        }
    }

    func testExplicitT3OptInStillRequiresE2BKey() {
        let config = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_ENABLED": "1",
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
            "MOMO_T3_ENABLED": "1",
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
            "MOMO_T3_ENABLED": "1",
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

    func testCrashSafeBootstrapTokenIsStableForProvisionId() {
        let provisionID = UUID(uuidString: "00000000-0000-7000-8000-000000000876")!
        let first = CloudProvisionerRoutes.bootstrapToken(
            provisionID: provisionID, apiKey: "operator-test-key"
        )
        let replay = CloudProvisionerRoutes.bootstrapToken(
            provisionID: provisionID, apiKey: "operator-test-key"
        )
        XCTAssertEqual(first, replay)
        XCTAssertNotEqual(first, "operator-test-key")
        XCTAssertNotEqual(
            first,
            CloudProvisionerRoutes.bootstrapToken(
                provisionID: UUID(), apiKey: "operator-test-key"
            )
        )
    }

    func testLifecycleRepairMigrationNamesEveryStructuralGate() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let settlementSQL = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/049_t3_lifecycle_settlement.sql"
            ),
            encoding: .utf8
        )
        let constraintSQL = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/051_t3_unsettled_usage_constraint.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(constraintSQL.contains("work_host_usage_one_unsettled_per_host_idx"))
        XCTAssertTrue(constraintSQL.contains("cannot enforce one unsettled T3 usage per host"))
        XCTAssertTrue(constraintSQL.contains("lower(host_id::text)"))
        XCTAssertTrue(settlementSQL.contains("CREATE FUNCTION settle_t3_work_session"))
        XCTAssertTrue(settlementSQL.contains("ON CONFLICT (workspace_id, reason, ref_id) DO NOTHING"))
        XCTAssertTrue(settlementSQL.contains("'pausing', 'paused', 'resuming'"))
        XCTAssertTrue(settlementSQL.contains("'destroy_pending'"))
        XCTAssertFalse(settlementSQL.contains("ALTER TABLE usage_ledger"))
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
