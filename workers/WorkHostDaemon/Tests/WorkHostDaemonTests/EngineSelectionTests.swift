import Foundation
import XCTest
@testable import MomoACPHost
@testable import WorkHostDaemon

// =============================================================================
// EngineSelectionTests — MOMO-579 / WH-1 (B). Locks the engine-selection wiring:
// boot config default = opencode, invalid env fails closed, and the DB > env >
// default precedence of WorkdConfig.resolveEngine.
// =============================================================================
final class EngineSelectionTests: XCTestCase {
    private var baseEnvironment: [String: String] {
        [
            "MOMO_WORKD_SERVER_URL": "https://host.example.test",
            "MOMO_WORKD_WORKSPACE_ID": "00000000-0000-7000-8000-000000000579",
        ]
    }

    func testBootConfigDefaultsToOpencode() throws {
        let config = try WorkdConfig.load(environment: baseEnvironment)
        XCTAssertEqual(config.engine, .opencode)
        XCTAssertEqual(WorkEngine.default, .opencode)
    }

    func testBootConfigHonorsValidEngineEnv() throws {
        var environment = baseEnvironment
        environment["MOMO_WORKD_ENGINE"] = "codex-local"
        let config = try WorkdConfig.load(environment: environment)
        XCTAssertEqual(config.engine, .codexLocal)
    }

    func testBootConfigFailsClosedOnInvalidEngineEnv() {
        var environment = baseEnvironment
        environment["MOMO_WORKD_ENGINE"] = "not-an-engine"
        XCTAssertThrowsError(try WorkdConfig.load(environment: environment))
    }

    func testResolveEnginePrefersDatabaseOverEnv() {
        let engine = WorkdConfig.resolveEngine(
            databaseSetting: "goose",
            environment: ["MOMO_WORKD_ENGINE": "codex-local"]
        )
        XCTAssertEqual(engine, .goose)
    }

    func testResolveEngineFallsBackToEnvThenDefault() {
        XCTAssertEqual(
            WorkdConfig.resolveEngine(databaseSetting: nil, environment: ["MOMO_WORKD_ENGINE": "opencode"]),
            .opencode
        )
        XCTAssertEqual(
            WorkdConfig.resolveEngine(databaseSetting: "  ", environment: [:]),
            .default
        )
        // A garbage DB value degrades to the next tier rather than blocking.
        XCTAssertEqual(
            WorkdConfig.resolveEngine(databaseSetting: "bogus", environment: ["MOMO_WORKD_ENGINE": "goose"]),
            .goose
        )
    }
}
