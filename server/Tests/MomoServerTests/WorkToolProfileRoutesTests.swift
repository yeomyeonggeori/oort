import Foundation
import XCTest
@testable import MomoServer

final class WorkToolProfileRoutesTests: XCTestCase {
    func testToolKeysAreRegistryExtensibleButPathSafe() throws {
        XCTAssertEqual(try WorkToolProfileRoutes.validatedToolKey("KIMI"), "kimi")
        XCTAssertEqual(try WorkToolProfileRoutes.validatedToolKey("claude-agent"), "claude-agent")
        XCTAssertThrowsError(try WorkToolProfileRoutes.validatedToolKey("x"))
        XCTAssertThrowsError(try WorkToolProfileRoutes.validatedToolKey("/bin/sh"))
        XCTAssertThrowsError(try WorkToolProfileRoutes.validatedToolKey("tool key"))
    }

    func testMigrationKeepsCatalogTenantAndCredentialBoundaries() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sql = try String(
            contentsOf: root.appendingPathComponent("Migrations/029_work_tool_profile.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(sql.contains("CREATE TABLE work_tool_profile"))
        XCTAssertTrue(sql.contains("ALTER TABLE work_tool_profile FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(sql.contains("CREATE POLICY ws_isolation ON work_tool_profile"))
        XCTAssertTrue(sql.contains("ALTER TABLE work_control DROP CONSTRAINT work_control_payload_ck"))
        XCTAssertTrue(sql.contains("momo_seed_work_tool_profiles"))
        for key in ["'claude'", "'codex'", "'opencode'", "'shell'"] {
            XCTAssertTrue(sql.contains(key))
        }
        for forbidden in ["api_key", "access_token", "oauth_token", "executable_path"] {
            XCTAssertFalse(sql.lowercased().contains(forbidden))
        }
    }

    func testWorkHostAuthAllowsOnlyProfileProjectionRead() {
        let path = "/v1/workspaces/00000000-0000-7000-8000-000000000001/work-tool-profiles"
        XCTAssertTrue(WorkHostAuthenticator.isAllowed(method: "GET", path: path))
        XCTAssertFalse(WorkHostAuthenticator.isAllowed(method: "POST", path: path))
        XCTAssertFalse(WorkHostAuthenticator.isAllowed(method: "PUT", path: path + "/codex"))
        XCTAssertFalse(WorkHostAuthenticator.isAllowed(method: "DELETE", path: path + "/codex"))
    }

    func testEnvironmentPolicyAcceptsNamesButNeverValuesOrWorkdControlKeys() throws {
        XCTAssertNoThrow(try WorkToolProfileRoutes.validatedEnvironmentPolicy(.object([
            "mode": .string("allowlist"),
            "passthrough": .array([.string("GH_TOKEN"), .string("CUSTOM_TOOL_HOME")]),
        ])))
        XCTAssertThrowsError(try WorkToolProfileRoutes.validatedEnvironmentPolicy(.object([
            "passthrough": .array([.string("GH_TOKEN=secret")]),
        ])))
        XCTAssertThrowsError(try WorkToolProfileRoutes.validatedEnvironmentPolicy(.object([
            "passthrough": .array([.string("MOMO_WORKD_SERVER_URL")]),
        ])))
        XCTAssertThrowsError(try WorkToolProfileRoutes.validatedEnvironmentPolicy(.object([
            "mode": .string("unsafe"),
        ])))
    }

    func testEnvironmentPolicyMigrationStoresNamesOnly() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sql = try String(
            contentsOf: root.appendingPathComponent("Migrations/034_work_tool_profile_env_policy.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(sql.contains("ADD COLUMN env_policy jsonb"))
        XCTAssertTrue(sql.contains("jsonb_typeof(env_policy) = 'object'"))
        XCTAssertFalse(sql.lowercased().contains("env_value"))
    }
}
