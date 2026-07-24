import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

/// MOMO-582 / ADR-0114 증보1 B — work host engine REST: engine validation,
/// default vs database response projection, closed-world PUT body (ADR-0004),
/// and the operator authorization matrix. All pure-unit (no DB).
///
/// The live HTTP 200/403 roundtrip and the DB upsert roundtrip stay
/// orchestrator-owned (runtime-unverified) because the owner/admin role fallback
/// needs Postgres — they are exercised by `scripts/verify_workhost_engines.sh`.
final class WorkHostEngineTests: XCTestCase {
    // MARK: - Engine validation (invalid -> 400)

    func testValidatedEngineAcceptsAllowedLabels() throws {
        for engine in ["opencode", "goose", "codex-local"] {
            XCTAssertEqual(try WorkHostEngineRoutes.validatedEngine(engine), engine)
        }
        // Surrounding whitespace is trimmed to the canonical label.
        XCTAssertEqual(try WorkHostEngineRoutes.validatedEngine("  goose  "), "goose")
    }

    func testValidatedEngineRejectsUnknownWith400() {
        for bogus in ["", "   ", "opencode-x", "OpenCode", "codex", "goose-local", "cursor"] {
            XCTAssertThrowsError(try WorkHostEngineRoutes.validatedEngine(bogus)) { error in
                XCTAssertEqual(
                    (error as? HTTPError)?.status, .badRequest,
                    "unknown engine '\(bogus)' must be a 400"
                )
            }
        }
    }

    func testAllowedEngineSetMatchesMigrationCheck() {
        // Must stay in lockstep with migration 040's CHECK and WorkEngine.
        XCTAssertEqual(WorkHostEngineRoutes.allowedEngines, ["opencode", "goose", "codex-local"])
        XCTAssertEqual(WorkHostEngineRoutes.defaultEngine, "opencode")
        XCTAssertTrue(WorkHostEngineRoutes.allowedEngines.contains(WorkHostEngineRoutes.defaultEngine))
    }

    // MARK: - Response projection (default opencode vs database)

    func testNilRowProjectsDefaultOpencode() {
        let response = WorkHostEngineRoutes.makeResponse(stored: nil)
        XCTAssertEqual(response.engine, "opencode")
        XCTAssertEqual(response.source, "default")
        XCTAssertNil(response.updatedBy)
        XCTAssertNil(response.updatedAtMs)
        XCTAssertEqual(response.schema, "momo.work_host_engine.v0")
    }

    func testStoredRowProjectsDatabaseSource() {
        let memberID = UUID()
        let stored = StoredWorkHostEngine(
            engine: "goose",
            updatedByMemberID: memberID,
            updatedAtMs: 1_723_456_789_000
        )
        let response = WorkHostEngineRoutes.makeResponse(stored: stored)
        XCTAssertEqual(response.engine, "goose")
        XCTAssertEqual(response.source, "database")
        XCTAssertEqual(response.updatedBy, memberID.uuidString)
        XCTAssertEqual(response.updatedAtMs, 1_723_456_789_000)
        XCTAssertEqual(response.schema, "momo.work_host_engine.v0")
    }

    func testDatabaseResponseEncodesContractShape() throws {
        let memberID = UUID()
        let stored = StoredWorkHostEngine(
            engine: "codex-local",
            updatedByMemberID: memberID,
            updatedAtMs: 42
        )
        let data = try JSONEncoder().encode(WorkHostEngineRoutes.makeResponse(stored: stored))
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(json?["engine"] as? String, "codex-local")
        XCTAssertEqual(json?["source"] as? String, "database")
        XCTAssertEqual(json?["schema"] as? String, "momo.work_host_engine.v0")
        XCTAssertEqual(json?["updatedBy"] as? String, memberID.uuidString)
        XCTAssertEqual((json?["updatedAtMs"] as? NSNumber)?.int64Value, 42)
    }

    /// The default (source:"default") response has no updated_by/updated_at, so the
    /// synthesized encoder omits those optional keys — matching the provider_link
    /// projection convention the GUI already consumes (absent == null).
    func testDefaultResponseOmitsNilOptionals() throws {
        let data = try JSONEncoder().encode(WorkHostEngineRoutes.makeResponse(stored: nil))
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(json?["engine"] as? String, "opencode")
        XCTAssertEqual(json?["source"] as? String, "default")
        XCTAssertEqual(json?["schema"] as? String, "momo.work_host_engine.v0")
        XCTAssertFalse(json?.keys.contains("updatedBy") ?? true)
        XCTAssertFalse(json?.keys.contains("updatedAtMs") ?? true)
    }

    // MARK: - Closed-world PUT body (ADR-0004: no credential/path smuggling)

    func testPutRequestAcceptsEngineOnly() throws {
        let decoder = JSONDecoder()
        let dto = try decoder.decode(
            PutWorkHostEngineRequest.self,
            from: Data(#"{"engine":"opencode"}"#.utf8)
        )
        XCTAssertEqual(dto.engine, "opencode")
    }

    func testPutRequestRejectsSmuggledCredentialAndPathFields() {
        let decoder = JSONDecoder()
        let bodies = [
            #"{"engine":"codex-local","codexPath":"/Users/x/.codex"}"#,
            #"{"engine":"opencode","openai_api_key":"sk-leak"}"#,
            #"{"engine":"goose","bearer":"leak"}"#,
            #"{"engine":"opencode","executable":"/bin/evil"}"#,
        ]
        for body in bodies {
            XCTAssertThrowsError(
                try decoder.decode(PutWorkHostEngineRequest.self, from: Data(body.utf8)),
                "closed-world body must reject: \(body)"
            )
        }
    }

    // MARK: - Operator authorization matrix (200 vs 403)

    /// The engine surface reuses `ProviderLinkRoutes.isOperatorAuthorized`, so the
    /// operator decision (who gets 200 vs 403) cannot drift between the two
    /// surfaces. Human platform:read OR workspace owner/admin -> authorized;
    /// everyone else, and every non-human, -> 403.
    func testOperatorAuthorizationMatrix() {
        typealias R = ProviderLinkRoutes
        XCTAssertTrue(R.isOperatorAuthorized(kind: .human, scopes: ["platform:read"], workspaceRole: nil))
        XCTAssertTrue(R.isOperatorAuthorized(kind: .human, scopes: [], workspaceRole: .owner))
        XCTAssertTrue(R.isOperatorAuthorized(kind: .human, scopes: [], workspaceRole: .admin))
        XCTAssertFalse(R.isOperatorAuthorized(kind: .human, scopes: [], workspaceRole: .member))
        XCTAssertFalse(R.isOperatorAuthorized(kind: .human, scopes: [], workspaceRole: .guest))
        XCTAssertFalse(R.isOperatorAuthorized(kind: .human, scopes: [], workspaceRole: nil))
        XCTAssertFalse(R.isOperatorAuthorized(kind: .agent, scopes: ["platform:read"], workspaceRole: .owner))
        XCTAssertFalse(R.isOperatorAuthorized(kind: .workHost, scopes: ["platform:read"], workspaceRole: .owner))
    }
}
