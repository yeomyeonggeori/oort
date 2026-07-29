import CloudProviderKit
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

    /// ADR-0142 D4: a fully configured managed provider still stays shut until
    /// the operator opts in. Configuration presence is not consent.
    func testT3IsDisabledByDefaultEvenWhenProviderConfigurationExists() {
        let config = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_PROVIDER": "mock-a",
            "MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL": "https://provider.example.test",
            "MOMO_T3_PROVIDER_MOCK_A_API_KEY": "operator-secret",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test",
        ])
        XCTAssertFalse(config.enabled)
        XCTAssertThrowsError(try config.requireReady()) { error in
            XCTAssertEqual(error as? CloudProvisionerConfigError, .disabled)
        }
        XCTAssertThrowsError(try CloudProvisionerRoutes.readyConfig(config)) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .serviceUnavailable)
        }
    }

    /// A managed provider with no endpoint fails closed by name rather than
    /// booting a T3 surface that would 500 on first use.
    func testManagedProviderOptInStillRequiresItsOwnEndpoint() {
        let config = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "mock-a",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test",
        ])
        XCTAssertThrowsError(try config.requireReady()) { error in
            XCTAssertEqual(
                error as? CloudProvisionerConfigError, .missingEndpoint("mock-a")
            )
        }
        XCTAssertThrowsError(try CloudProvisionerRoutes.readyConfig(config)) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .serviceUnavailable)
        }
    }

    /// A provider identifier outside the adapter registry is refused at load,
    /// not discovered later by a reconciler holding an unroutable host row.
    func testUnknownProviderFailsClosed() {
        let config = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "not-a-registered-substrate",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test",
        ])
        XCTAssertThrowsError(try config.requireReady()) { error in
            XCTAssertEqual(
                error as? CloudProvisionerConfigError,
                .unknownProvider("not-a-registered-substrate")
            )
        }
    }

    /// ADR-0142 D1: BYOC is the base form and needs no operator credential —
    /// `enabled` plus a public HTTPS URL is a complete T3 configuration.
    func testBYOCIsReadyWithoutAnyProviderCredential() throws {
        let config = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test",
        ])
        XCTAssertEqual(config.defaultProviderID, CloudProviderRegistry.byocProviderID)
        let ready = try config.requireReady()
        XCTAssertFalse(ready.defaultCapabilities.managesInstanceLifetime)
        XCTAssertFalse(ready.defaultCapabilities.supports(.create))
    }

    func testCloudConfigClampsAndRequiresPublicHTTPS() throws {
        let valid = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "mock-a",
            "MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL": "https://provider.example.test/",
            "MOMO_T3_PROVIDER_MOCK_A_API_KEY": "operator-secret",
            "MOMO_T3_PROVIDER_MOCK_A_INSTANCE_TIMEOUT_SECONDS": "1",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test/",
            "MOMO_T3_RATE_MICRO_USD_PER_SECOND": "0",
        ])
        let ready = try valid.requireReady()
        XCTAssertEqual(ready.endpoints["mock-a"]?.instanceTimeoutSeconds, 60)
        XCTAssertEqual(ready.endpoints["mock-a"]?.apiBaseURL, "https://provider.example.test")
        XCTAssertEqual(ready.unitRateMicroUSDSecond, 1)
        XCTAssertEqual(ready.publicServerURL, "https://momo.example.test")

        let insecure = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_PUBLIC_BASE_URL": "http://momo.example.test",
        ])
        XCTAssertThrowsError(try insecure.requireReady()) { error in
            XCTAssertEqual(
                error as? CloudProvisionerConfigError, .invalidPublicServerURL
            )
        }
    }

    /// A host provisioned before the operator switched `MOMO_T3_PROVIDER` must
    /// stay actionable: the reconciler addresses adapters by the stored
    /// `work_cloud_host.provider`, not by today's default.
    func testNonDefaultRegisteredProviderStaysAddressable() throws {
        let config = CloudProvisionerConfig.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "mock-b",
            "MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL": "https://a.example.test",
            "MOMO_T3_PROVIDER_MOCK_A_API_KEY": "a-secret",
            "MOMO_T3_PROVIDER_MOCK_B_API_BASE_URL": "https://b.example.test",
            "MOMO_T3_PROVIDER_MOCK_B_API_KEY": "b-secret",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example.test",
        ])
        let ready = try config.requireReady()
        XCTAssertEqual(ready.defaultProviderID, "mock-b")
        XCTAssertNotNil(ready.endpoints["mock-a"])
        XCTAssertTrue(try ready.capabilities(for: "mock-a").supports(.pause))
        XCTAssertFalse(try ready.capabilities(for: "mock-b").supports(.pause))
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
            provisionID: provisionID, secret: "operator-test-key"
        )
        let replay = CloudProvisionerRoutes.bootstrapToken(
            provisionID: provisionID, secret: "operator-test-key"
        )
        XCTAssertEqual(first, replay)
        XCTAssertNotEqual(first, "operator-test-key")
        XCTAssertNotEqual(
            first,
            CloudProvisionerRoutes.bootstrapToken(
                provisionID: UUID(), secret: "operator-test-key"
            )
        )
    }

    /// ADR-0142 D4: the single-vendor CHECK from 045:103 is gone and the
    /// column is an adapter registry identifier. The shape constraint and the
    /// dropped default are both load-bearing — a row with an unstated provider
    /// is a row no reconciler can route.
    func testProviderRegistryMigrationRemovesTheSingleVendorConstraint() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sql = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/054_t3_provider_registry.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(sql.contains("DROP CONSTRAINT work_cloud_host_provider_ck"))
        XCTAssertTrue(sql.contains("CHECK (provider ~ '^[a-z0-9][a-z0-9-]{0,31}$')"))
        XCTAssertTrue(sql.contains("ALTER COLUMN provider DROP DEFAULT"))
        XCTAssertFalse(sql.contains("CHECK (provider = "))
    }

    /// The env namespace is derived, not hand-maintained: a registry id with a
    /// hyphen must still produce a legal environment variable prefix.
    func testProviderEnvironmentNamespaceIsDerivedFromRegistryID() {
        XCTAssertEqual(
            CloudProviderSettings.environmentNamespace(for: "mock-a"),
            "MOMO_T3_PROVIDER_MOCK_A"
        )
        XCTAssertEqual(
            CloudProviderSettings.environmentNamespace(for: "byoc"),
            "MOMO_T3_PROVIDER_BYOC"
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
        let canonicalSQL = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/053_t3_lifecycle_canonicalization.sql"
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
        XCTAssertTrue(canonicalSQL.contains("CREATE FUNCTION t3_terminate"))
        XCTAssertTrue(canonicalSQL.contains("t3 settlement must go through t3_terminate"))
        XCTAssertTrue(canonicalSQL.contains("illegal cloud host transition % -> %"))
        XCTAssertTrue(canonicalSQL.contains("CREATE TABLE work_cloud_host_transition"))
        XCTAssertTrue(canonicalSQL.contains("settled_reason = p_reason"))
        XCTAssertTrue(canonicalSQL.contains("reason=destroyed"))
        XCTAssertFalse(settlementSQL.contains("ALTER TABLE usage_ledger"))
        XCTAssertFalse(canonicalSQL.contains("ALTER TABLE usage_ledger"))
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
