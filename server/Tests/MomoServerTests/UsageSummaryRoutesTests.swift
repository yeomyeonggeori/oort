import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

/// MOMO-615 / AX-7 layer 1 — workspace usage summary REST contract.
///
/// In-process coverage: range validation (400 matrix), the wire shape pinned by
/// `docs/planning/handoffs/2026-07-25-usage-summary-contract.md`, the empty-period
/// projection, and the source contract for the membership guard / RLS posture /
/// budget adoption rule. The membership 403, the empty-period 200, and the
/// hand-computed aggregation against a seeded `usage_ledger` are additionally
/// measured end to end by `scripts/verify_usage_summary.sh` (docker).
final class UsageSummaryRoutesTests: XCTestCase {
    private static let now = Date(timeIntervalSince1970: 1_785_000_000) // 2026-07-25T17:20:00Z

    // MARK: - Range validation

    func testRangeDefaultsToThirtyDayDailyWindowEndingNow() throws {
        let window = try UsageSummaryRoutes.validatedWindow(
            from: nil, to: nil, bucket: nil, now: Self.now
        )
        XCTAssertEqual(window.bucket, .day)
        XCTAssertEqual(window.to, Self.now)
        XCTAssertEqual(window.from, Self.now.addingTimeInterval(-30 * 86_400))
        XCTAssertEqual(UsageSummaryRoutes.iso8601(window.to), "2026-07-25T17:20:00Z")
        XCTAssertEqual(UsageSummaryRoutes.iso8601(window.from), "2026-06-25T17:20:00Z")
    }

    func testExplicitToStillAnchorsTheThirtyDayDefaultLookback() throws {
        let window = try UsageSummaryRoutes.validatedWindow(
            from: nil, to: "2026-07-01T00:00:00Z", bucket: "month", now: Self.now
        )
        XCTAssertEqual(window.bucket, .month)
        XCTAssertEqual(UsageSummaryRoutes.iso8601(window.to), "2026-07-01T00:00:00Z")
        XCTAssertEqual(UsageSummaryRoutes.iso8601(window.from), "2026-06-01T00:00:00Z")
    }

    func testTimestampsAcceptFractionalSecondsOffsetsAndBareDates() throws {
        let fractional = try UsageSummaryRoutes.validatedWindow(
            from: "2026-07-01T00:00:00.250Z", to: "2026-07-02T00:00:00Z", bucket: "day",
            now: Self.now
        )
        XCTAssertEqual(UsageSummaryRoutes.iso8601(fractional.from), "2026-07-01T00:00:00Z")

        let offset = try UsageSummaryRoutes.validatedWindow(
            from: "2026-07-01T09:00:00+09:00", to: "2026-07-02T00:00:00Z", bucket: nil,
            now: Self.now
        )
        XCTAssertEqual(UsageSummaryRoutes.iso8601(offset.from), "2026-07-01T00:00:00Z")

        let bareDate = try UsageSummaryRoutes.validatedWindow(
            from: "2026-07-01", to: "2026-07-02", bucket: "week", now: Self.now
        )
        XCTAssertEqual(UsageSummaryRoutes.iso8601(bareDate.from), "2026-07-01T00:00:00Z")
        XCTAssertEqual(UsageSummaryRoutes.iso8601(bareDate.to), "2026-07-02T00:00:00Z")
        XCTAssertEqual(bareDate.bucket, .week)
    }

    func testBucketVocabularyIsExactlyDayWeekMonth() throws {
        XCTAssertEqual(UsageSummaryRoutes.Bucket.allCases.map(\.rawValue), ["day", "week", "month"])
        for raw in ["day", "WEEK", " month "] {
            XCTAssertNoThrow(try UsageSummaryRoutes.validatedWindow(
                from: nil, to: nil, bucket: raw, now: Self.now
            ))
        }
        for raw in ["hour", "year", "daily", "d"] {
            assertBadRequest(
                { try UsageSummaryRoutes.validatedWindow(from: nil, to: nil, bucket: raw, now: Self.now) },
                "bucket \(raw)"
            )
        }
    }

    func testRangeValidationRejectsUnparsableInvertedAndOverlongWindows() {
        assertBadRequest({
            try UsageSummaryRoutes.validatedWindow(
                from: "yesterday", to: nil, bucket: nil, now: Self.now
            )
        }, "unparsable from")
        assertBadRequest({
            try UsageSummaryRoutes.validatedWindow(
                from: nil, to: "1785000000", bucket: nil, now: Self.now
            )
        }, "epoch seconds are not ISO8601")
        assertBadRequest({
            try UsageSummaryRoutes.validatedWindow(
                from: "2026-07-02T00:00:00Z", to: "2026-07-01T00:00:00Z", bucket: nil, now: Self.now
            )
        }, "inverted range")
        assertBadRequest({
            try UsageSummaryRoutes.validatedWindow(
                from: "2026-01-01T00:00:00Z", to: "2026-07-01T00:00:01Z", bucket: nil, now: Self.now
            )
        }, "range longer than 93 days")
    }

    func testNinetyThreeDayBoundaryIsInclusiveAndOneSecondOverIsRejected() throws {
        let to = Date(timeIntervalSince1970: 1_785_000_000)
        let exact = to.addingTimeInterval(-93 * 86_400)
        let window = try UsageSummaryRoutes.validatedWindow(
            from: UsageSummaryRoutes.iso8601(exact),
            to: UsageSummaryRoutes.iso8601(to),
            bucket: "day",
            now: Self.now
        )
        XCTAssertEqual(window.to.timeIntervalSince(window.from), 93 * 86_400)
        XCTAssertEqual(UsageSummaryRoutes.maxRangeSeconds, 93 * 86_400)
        XCTAssertEqual(UsageSummaryRoutes.defaultLookbackSeconds, 30 * 86_400)

        assertBadRequest({
            try UsageSummaryRoutes.validatedWindow(
                from: UsageSummaryRoutes.iso8601(exact.addingTimeInterval(-1)),
                to: UsageSummaryRoutes.iso8601(to),
                bucket: "day",
                now: Self.now
            )
        }, "93 days + 1 second")
    }

    // MARK: - Wire shape

    func testResponseShapeMatchesHandoffContractExactly() throws {
        let payload = UsageSummaryDTO(
            range: UsageSummaryRangeDTO(
                from: "2026-06-25T00:00:00Z", to: "2026-07-25T00:00:00Z", bucket: "day"
            ),
            totals: UsageSummaryTotalsDTO(
                costMicroUsd: 123_456, estimatedMicroUsd: 2_345,
                promptTokens: 900, completionTokens: 120
            ),
            buckets: [UsageSummaryBucketDTO(
                start: "2026-07-01T00:00:00Z", costMicroUsd: 100,
                promptTokens: 10, completionTokens: 2
            )],
            byModel: [UsageSummaryModelDTO(
                model: "hermes-default", costMicroUsd: 100, promptTokens: 10, completionTokens: 2
            )],
            byAgent: [UsageSummaryAgentDTO(
                agentMemberId: "00000000-0000-7000-8000-000000000301",
                displayName: "김인턴", costMicroUsd: 100, promptTokens: 10, completionTokens: 2
            )],
            budget: UsageSummaryBudgetDTO(
                grain: "workspace", limitMicroUsd: 1_000_000, spentMicroUsd: 500_000,
                reservedMicroUsd: 0, state: "normal", periodStart: "2026-07-25T00:00:00Z"
            )
        )
        let json = try Self.encodeObject(payload)

        XCTAssertEqual(Set(json.keys), ["range", "totals", "buckets", "byModel", "byAgent", "budget"])
        XCTAssertEqual(Set((json["range"] as? [String: Any] ?? [:]).keys), ["from", "to", "bucket"])
        XCTAssertEqual(
            Set((json["totals"] as? [String: Any] ?? [:]).keys),
            ["costMicroUsd", "estimatedMicroUsd", "promptTokens", "completionTokens"]
        )
        let bucket = (json["buckets"] as? [[String: Any]])?.first ?? [:]
        XCTAssertEqual(
            Set(bucket.keys), ["start", "costMicroUsd", "promptTokens", "completionTokens"]
        )
        let model = (json["byModel"] as? [[String: Any]])?.first ?? [:]
        XCTAssertEqual(
            Set(model.keys), ["model", "costMicroUsd", "promptTokens", "completionTokens"]
        )
        let agent = (json["byAgent"] as? [[String: Any]])?.first ?? [:]
        XCTAssertEqual(
            Set(agent.keys),
            ["agentMemberId", "displayName", "costMicroUsd", "promptTokens", "completionTokens"]
        )
        XCTAssertEqual(
            Set((json["budget"] as? [String: Any] ?? [:]).keys),
            ["grain", "limitMicroUsd", "spentMicroUsd", "reservedMicroUsd", "state", "periodStart"]
        )
        // Agent identity is a lowercase UUID string so web can join it to roster ids.
        let agentID = agent["agentMemberId"] as? String
        XCTAssertEqual(agentID, agentID?.lowercased())
    }

    func testEmptyPeriodProjectionIsZeroValuedWithExplicitNullBudget() throws {
        let payload = UsageSummaryDTO(
            range: UsageSummaryRangeDTO(
                from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", bucket: "day"
            ),
            totals: UsageSummaryTotalsDTO(
                costMicroUsd: 0, estimatedMicroUsd: 0, promptTokens: 0, completionTokens: 0
            ),
            buckets: [], byModel: [], byAgent: [], budget: nil
        )
        let data = try JSONEncoder().encode(payload)
        let json = try Self.decodeObject(data)

        XCTAssertEqual((json["totals"] as? [String: Any])?["costMicroUsd"] as? Int, 0)
        XCTAssertEqual((json["buckets"] as? [Any])?.count, 0)
        XCTAssertEqual((json["byModel"] as? [Any])?.count, 0)
        XCTAssertEqual((json["byAgent"] as? [Any])?.count, 0)
        // `budget` must be present-and-null, not absent — synthesized Encodable
        // would drop the key with `encodeIfPresent`.
        XCTAssertTrue(json.keys.contains("budget"))
        XCTAssertTrue(json["budget"] is NSNull)
    }

    /// The exact projection `scripts/verify_usage_summary.sh` asserts against its
    /// seeded ledger. Keeping the hand-computed numbers here pins the DTO layer to
    /// the same arithmetic the docker verifier measures.
    func testSeededLedgerHandCalculationRoundTripsThroughTheDTO() throws {
        let fixture = """
        {
          "range": {"from":"2026-07-01T00:00:00Z","to":"2026-07-31T00:00:00Z","bucket":"day"},
          "totals": {"costMicroUsd":186000,"estimatedMicroUsd":66000,
                     "promptTokens":6100,"completionTokens":1210},
          "buckets": [
            {"start":"2026-07-05T00:00:00Z","costMicroUsd":40000,
             "promptTokens":1000,"completionTokens":200},
            {"start":"2026-07-06T00:00:00Z","costMicroUsd":125000,
             "promptTokens":4500,"completionTokens":900},
            {"start":"2026-07-13T00:00:00Z","costMicroUsd":21000,
             "promptTokens":600,"completionTokens":110}
          ],
          "byModel": [
            {"model":"hermes-default","costMicroUsd":120000,
             "promptTokens":4000,"completionTokens":800},
            {"model":"hermes-lite","costMicroUsd":66000,
             "promptTokens":2100,"completionTokens":410}
          ],
          "byAgent": [
            {"agentMemberId":"61500000-0000-7000-8000-000000000901","displayName":"Usage Agent A",
             "costMicroUsd":120000,"promptTokens":4000,"completionTokens":800},
            {"agentMemberId":"61500000-0000-7000-8000-000000000902","displayName":"Usage Agent B",
             "costMicroUsd":66000,"promptTokens":2100,"completionTokens":410}
          ],
          "budget": {"grain":"workspace","limitMicroUsd":200000,"spentMicroUsd":186000,
                     "reservedMicroUsd":0,"state":"soft_limit","periodStart":"2026-07-25T00:00:00Z"}
        }
        """
        let decoded = try JSONDecoder().decode(UsageSummaryDTO.self, from: Data(fixture.utf8))
        for slice in [
            decoded.buckets.map(\.costMicroUsd),
            decoded.byModel.map(\.costMicroUsd),
            decoded.byAgent.map(\.costMicroUsd),
        ] {
            XCTAssertEqual(decoded.totals.costMicroUsd, slice.reduce(0, +))
        }
        XCTAssertEqual(
            decoded.totals.promptTokens, decoded.buckets.map(\.promptTokens).reduce(0, +)
        )
        XCTAssertEqual(
            decoded.totals.completionTokens, decoded.buckets.map(\.completionTokens).reduce(0, +)
        )
        // was_estimated rows are a subset of the total, never an extra addend.
        XCTAssertLessThan(decoded.totals.estimatedMicroUsd, decoded.totals.costMicroUsd)
        // Descending cost order for byModel/byAgent.
        XCTAssertEqual(decoded.byModel.map(\.costMicroUsd), [120_000, 66_000])
        XCTAssertEqual(decoded.byAgent.map(\.costMicroUsd), [120_000, 66_000])
        XCTAssertEqual(decoded.byAgent.map(\.agentMemberId).map { $0.lowercased() },
                       decoded.byAgent.map(\.agentMemberId))
        XCTAssertEqual(try Self.encodeObject(decoded).keys.count, 6)
    }

    func testLimitStateReuseMatchesCostProjectionThresholds() {
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 186_000, softLimitMicroUSD: 150_000, hardLimitMicroUSD: 200_000
            ),
            "soft_limit"
        )
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 200_000, softLimitMicroUSD: 150_000, hardLimitMicroUSD: 200_000
            ),
            "hard_limit"
        )
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 10, softLimitMicroUSD: nil, hardLimitMicroUSD: 200_000
            ),
            "normal"
        )
    }

    // MARK: - Source contract

    func testRouteKeepsWorkspaceMembershipGuardRLSPostureAndBudgetAdoption() throws {
        let source = try Self.sourceText("Sources/MomoServer/Routes/UsageSummaryRoutes.swift")

        XCTAssertTrue(source.contains("/v1/workspaces/:ws/usage/summary"))
        // Membership: path ws == JWT ws, then the central active-role authority.
        XCTAssertTrue(source.contains("InviteRoutes.workspaceID(context, principal: principal)"))
        XCTAssertTrue(source.contains("WorkspaceAuthorization.activeRole("))
        XCTAssertTrue(source.contains("not a workspace member"))
        // RLS FORCE posture: tenant connection only, never a bypass or an escape hatch.
        XCTAssertTrue(source.contains("db.withTenantConnection("))
        for forbidden in ["BYPASSRLS", "row_security = off", "set_config('app.workspace_id"] {
            XCTAssertFalse(source.contains(forbidden), "route must not contain \(forbidden)")
        }
        // Read-only route: no migration, no writes.
        for forbidden in ["INSERT INTO", "UPDATE ", "DELETE FROM"] {
            XCTAssertFalse(source.contains(forbidden), "route must stay read-only (\(forbidden))")
        }
        // Aggregation contract.
        XCTAssertTrue(source.contains("FROM usage_ledger"))
        XCTAssertTrue(source.contains("FILTER (WHERE was_estimated)"))
        XCTAssertTrue(source.contains("AT TIME ZONE 'UTC'"))
        XCTAssertTrue(source.contains("ORDER BY cost_micro_usd DESC, model ASC"))
        XCTAssertTrue(source.contains("ORDER BY cost_micro_usd DESC, u.agent_member_id ASC"))
        XCTAssertTrue(source.contains("agentID.uuidString.lowercased()"))
        // Budget: workspace grain arm of the CostProjectionRoutes matcher + MIN(limit).
        XCTAssertTrue(source.contains("b.grain::text = 'workspace'"))
        XCTAssertTrue(source.contains("ORDER BY b.limit_micro_usd ASC, b.id ASC"))
        XCTAssertTrue(source.contains("CostProjectionRoutes.limitState("))
        XCTAssertTrue(source.contains("floor(extract(epoch from now()) / b.period_seconds)"))
    }

    func testRouteIsMountedOnTheAuthenticatedGroup() throws {
        let source = try Self.sourceText("Sources/MomoServer/App.swift")
        XCTAssertTrue(source.contains("UsageSummaryRoutes(db: db).add(to: authed)"))
    }

    func testDockerVerifierExistsAndAssertsTheRuntimeObligations() throws {
        let script = try Self.repoText("scripts/verify_usage_summary.sh")
        for expectation in [
            "/usr/bin/env bash",
            "docker compose",
            "usage/summary",
            "down -v",
            "usage_ledger",
        ] {
            XCTAssertTrue(script.contains(expectation), "verifier must cover \(expectation)")
        }
    }

    // MARK: - Helpers

    private func assertBadRequest<T>(
        _ body: () throws -> T,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try body(), label, file: file, line: line) { error in
            XCTAssertEqual(
                (error as? HTTPError)?.status, .badRequest,
                "\(label) must be HTTP 400", file: file, line: line
            )
        }
    }

    private static func encodeObject(_ value: some Encodable) throws -> [String: Any] {
        try decodeObject(JSONEncoder().encode(value))
    }

    private struct NotAJSONObject: Error {}

    private static func decodeObject(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NotAJSONObject()
        }
        return object
    }

    private static func serverRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func sourceText(_ relativePath: String) throws -> String {
        try String(
            contentsOf: serverRoot().appendingPathComponent(relativePath), encoding: .utf8
        )
    }

    private static func repoText(_ relativePath: String) throws -> String {
        try String(
            contentsOf: serverRoot().deletingLastPathComponent()
                .appendingPathComponent(relativePath),
            encoding: .utf8
        )
    }
}
