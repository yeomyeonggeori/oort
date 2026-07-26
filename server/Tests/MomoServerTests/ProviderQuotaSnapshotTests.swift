import Foundation
import XCTest
@testable import MomoServer

/// MOMO-623 / ADR-0135 D2 — quota snapshot ingest schema policing, scope
/// binding, and the 043 migration contract. Pure unit (no DB); the live
/// upsert/RLS/REST roundtrip is asserted by scripts/verify_quota_snapshot.sh.
final class ProviderQuotaSnapshotTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_785_000_000)  // 2026-07-25T…Z

    private func body(
        providerRef: JSONValue? = .string("codex"),
        window: JSONValue? = .string("short"),
        remainingRatio: JSONValue? = .double(0.42),
        resetsAt: JSONValue? = .string("2026-07-26T00:00:00Z"),
        probedAt: JSONValue? = nil,
        extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        var object: [String: JSONValue] = [:]
        if let providerRef { object["providerRef"] = providerRef }
        if let window { object["window"] = window }
        if let remainingRatio { object["remainingRatio"] = remainingRatio }
        if let resetsAt { object["resetsAt"] = resetsAt }
        object["probedAt"] = probedAt ?? .string(UsageSummaryRoutes.iso8601(now))
        for (key, value) in extra { object[key] = value }
        return .object(object)
    }

    // MARK: - Happy path

    func testAcceptsNumbersAndTimestampsOnly() throws {
        let parsed = try ProviderQuotaSnapshotRoutes.validated(body: body(), now: now)
        XCTAssertEqual(parsed.providerRef, "codex")
        XCTAssertEqual(parsed.window, "short")
        XCTAssertEqual(parsed.remainingRatio, 0.42, accuracy: 0.0001)
        XCTAssertEqual(parsed.probedAt.timeIntervalSince1970, now.timeIntervalSince1970, accuracy: 1)
        XCTAssertNotNil(parsed.resetsAt)
    }

    /// ADR-0135 writes the contract in snake_case; the rest of momo is camelCase.
    /// Both spellings must land on the same field — and only those.
    func testAcceptsAdrSnakeCaseSpellings() throws {
        let parsed = try ProviderQuotaSnapshotRoutes.validated(
            body: .object([
                "provider_ref": .string("Hermes-Primary"),
                "window": .string("WEEKLY"),
                "remaining_ratio": .int(1),
                "resets_at": .null,
                "probed_at": .string(UsageSummaryRoutes.iso8601(now)),
            ]),
            now: now
        )
        XCTAssertEqual(parsed.providerRef, "hermes-primary")
        XCTAssertEqual(parsed.window, "weekly")
        XCTAssertEqual(parsed.remainingRatio, 1)
        XCTAssertNil(parsed.resetsAt, "explicit null resetsAt means the provider reported none")
    }

    func testOmittedResetsAtIsAccepted() throws {
        let parsed = try ProviderQuotaSnapshotRoutes.validated(
            body: body(resetsAt: nil),
            now: now
        )
        XCTAssertNil(parsed.resetsAt)
    }

    func testRejectsDuplicateSpellingsOfTheSameField() {
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: .object([
                "providerRef": .string("codex"),
                "provider_ref": .string("claude"),
                "window": .string("short"),
                "remainingRatio": .double(0.5),
                "probedAt": .string(UsageSummaryRoutes.iso8601(now)),
            ]),
            now: now
        ))
    }

    // MARK: - ADR-0004: credential-shaped payloads never enter momo

    func testRejectsCredentialShapedFields() {
        for key in ["authorization", "bearer", "apiKey", "api_key", "accessToken", "oauthToken"] {
            XCTAssertThrowsError(
                try ProviderQuotaSnapshotRoutes.validated(
                    body: body(extra: [key: .string("value")]),
                    now: now
                ),
                "credential-shaped field \(key) must be rejected"
            )
        }
    }

    func testRejectsTokenShapedStringValues() {
        let tokenShaped = [
            "sk-live-9f3a2b7c1d8e4f60aa11",
            "Bearer abc123",
            "momo_agent_v1.00000000-0000-7000-8000-000000000001.aaaaaaaa",
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "AKIAIOSFODNN7EXAMPLE",
            "cHJvdmlkZXJzZWNyZXQwMTIzNDU2Nzg5YWJjZGVm",
        ]
        for value in tokenShaped {
            XCTAssertThrowsError(
                try ProviderQuotaSnapshotRoutes.validated(
                    body: body(providerRef: .string(value)),
                    now: now
                ),
                "token-shaped providerRef \(value) must be rejected"
            )
        }
    }

    func testOrdinaryProviderLabelsAreNotFlagged() {
        for label in [
            "codex",
            "claude",
            "hermes-primary",
            "kim.intern",
            "provider_2",
            // Long but SEPARATED: the blob heuristic keys on an unbroken
            // alphanumeric run, not raw length, so descriptive labels survive.
            "hermes-primary-eu-west-1-fallback",
            "2026-07-26T09:00:00Z",
        ] {
            XCTAssertFalse(
                ProviderQuotaSnapshotRoutes.isProviderKeyShaped(label),
                "\(label) is a legitimate label/timestamp, not a credential"
            )
        }
        // Unbroken 24+ alphanumeric run = opaque secret.
        XCTAssertTrue(
            ProviderQuotaSnapshotRoutes.isProviderKeyShaped(
                "cHJvdmlkZXJzZWNyZXQwMTIzNDU2Nzg5YWJjZGVm"
            )
        )
    }

    // MARK: - Schema policing: numbers and timestamps only

    func testRejectsRatioOutsideUnitInterval() {
        for ratio in [JSONValue.double(-0.01), .double(1.01), .double(42), .int(-1)] {
            XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
                body: body(remainingRatio: ratio), now: now
            ))
        }
        XCTAssertNoThrow(try ProviderQuotaSnapshotRoutes.validated(
            body: body(remainingRatio: .int(0)), now: now
        ))
        XCTAssertNoThrow(try ProviderQuotaSnapshotRoutes.validated(
            body: body(remainingRatio: .int(1)), now: now
        ))
    }

    func testRejectsNonNumericRatio() {
        for ratio in [JSONValue.string("0.5"), .bool(true), .null, .array([.double(0.5)])] {
            XCTAssertThrowsError(
                try ProviderQuotaSnapshotRoutes.validated(body: body(remainingRatio: ratio), now: now),
                "a quoted/typed-wrong ratio must 400 rather than be coerced"
            )
        }
    }

    func testRejectsUnknownWindow() {
        for window in [JSONValue.string("daily"), .string("monthly"), .string(""), .int(1), .null] {
            XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
                body: body(window: window), now: now
            ))
        }
    }

    func testRejectsMalformedOrImplausibleTimestamps() {
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(probedAt: .string("yesterday")), now: now
        ))
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(probedAt: .int(1_785_000_000)), now: now
        ))
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(resetsAt: .string("next tuesday")), now: now
        ))
        // Beyond the tolerated clock skew the sender's clock is wrong.
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(probedAt: .string(UsageSummaryRoutes.iso8601(now.addingTimeInterval(3_600)))),
            now: now
        ))
        // A month-old ratio is not a gauge.
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(probedAt: .string(UsageSummaryRoutes.iso8601(now.addingTimeInterval(-40 * 86_400)))),
            now: now
        ))
        // Inside the skew allowance it is accepted.
        XCTAssertNoThrow(try ProviderQuotaSnapshotRoutes.validated(
            body: body(probedAt: .string(UsageSummaryRoutes.iso8601(now.addingTimeInterval(60)))),
            now: now
        ))
    }

    func testRejectsMissingRequiredFieldsAndNonObjectBodies() {
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(providerRef: nil), now: now
        ))
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(window: nil), now: now
        ))
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: body(remainingRatio: nil), now: now
        ))
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: .array([body()]), now: now
        ))
        XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
            body: .string("codex"), now: now
        ))
    }

    func testRejectsProviderRefShapesThatAreNotSlugs() {
        for ref in [
            JSONValue.string(""),
            .string("https://provider.example.test/v1"),
            .string("has space"),
            .string("-leading-dash"),
            .int(7),
        ] {
            XCTAssertThrowsError(try ProviderQuotaSnapshotRoutes.validated(
                body: body(providerRef: ref), now: now
            ))
        }
    }

    // MARK: - Scope binding (adapter credential convention)

    func testIngestScopeIsPinnedToPostOnly() {
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "POST",
                path: ProviderQuotaSnapshotRoutes.path
            ),
            "provider:quota:write"
        )
        // The read side is not reachable by an adapter credential.
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "GET",
            path: ProviderQuotaSnapshotRoutes.path
        ))
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "POST",
            path: "/v1/provider/link"
        ))
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "POST",
            path: "/v1/provider/quota-snapshots/extra"
        ))
    }

    func testIngestScopeIsGrantableButNeverDefault() throws {
        XCTAssertFalse(
            AgentCredentialRoutes.defaultScopes.contains(ProviderQuotaSnapshotRoutes.ingestScope),
            "an ordinary agent credential must not silently gain the instance-global ingest"
        )
        XCTAssertFalse(
            try AgentCredentialRoutes.normalizedScopes(nil)
                .contains(ProviderQuotaSnapshotRoutes.ingestScope)
        )
        XCTAssertEqual(
            try AgentCredentialRoutes.normalizedScopes(["provider:quota:write"]),
            ["provider:quota:write"]
        )
        XCTAssertThrowsError(try AgentCredentialRoutes.normalizedScopes(["provider:quota:read"]))
    }

    // MARK: - Projection

    func testProjectionReportsSnapshotAgeAndNullResets() throws {
        let row = ProviderQuotaSnapshotRoutes.StoredQuotaSnapshot(
            providerRef: "codex",
            window: "weekly",
            remainingRatio: 0.25,
            resetsAt: nil,
            probedAt: now.addingTimeInterval(-90),
            ingestedAt: now.addingTimeInterval(-89)
        )
        let dto = ProviderQuotaSnapshotRoutes.projection(row, now: now)
        XCTAssertEqual(dto.ageSeconds, 90)
        XCTAssertNil(dto.resetsAt)
        let encoded = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(dto)
        ) as? [String: Any]
        XCTAssertTrue(
            encoded?.keys.contains("resetsAt") ?? false,
            "resetsAt is contractually string|null and must survive encoding"
        )
        XCTAssertTrue(encoded?["resetsAt"] is NSNull)
    }

    // MARK: - Migration 043 contract

    func testMigrationPinsLatestOnlyShapeAndCredentialFreeColumns() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sql = try String(
            contentsOf: root.appendingPathComponent("Migrations/043_quota_snapshot.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(sql.contains("CREATE TABLE quota_snapshot"))
        XCTAssertTrue(sql.contains("PRIMARY KEY (provider_ref, quota_window)"))
        XCTAssertTrue(sql.contains("quota_window IN ('short', 'weekly')"))
        XCTAssertTrue(sql.contains("remaining_ratio >= 0 AND remaining_ratio <= 1"))
        XCTAssertTrue(sql.contains("ALTER TABLE quota_snapshot ENABLE ROW LEVEL SECURITY"))
        XCTAssertTrue(sql.contains("ALTER TABLE quota_snapshot FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(sql.contains("app.provider_quota_admin"))
        // ADR-0004: no credential column may exist on this table. Prose (header
        // and COMMENT ON) legitimately NAMES the banned things, so the screen is
        // scoped to the column list of the CREATE TABLE statement itself.
        guard let tableStart = sql.range(of: "CREATE TABLE quota_snapshot"),
              let tableEnd = sql.range(of: "\n);", range: tableStart.upperBound..<sql.endIndex)
        else {
            return XCTFail("043 must contain a terminated CREATE TABLE quota_snapshot")
        }
        let columns = sql[tableStart.lowerBound..<tableEnd.lowerBound]
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("--") }
            .joined(separator: "\n")
            .lowercased()
        for forbidden in [
            "bearer", "token", "api_key", "apikey", "access_key", "oauth", "password",
            "ciphertext", "secret", "authorization",
        ] {
            XCTAssertFalse(
                columns.contains(forbidden),
                "043 must not introduce a \(forbidden) column"
            )
        }
        // Migration-only: the canonical schema is never rewritten in place.
        XCTAssertFalse(sql.contains("ALTER TABLE message"))
    }
}
