import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

final class AgentRunHistoryTests: XCTestCase {
    func testAgentRunHistoryCursorAndLimitValidation() throws {
        let cursor = UUID(uuidString: "00000000-0000-7000-8000-000000000653")!
        XCTAssertNil(try AgentRunRoutes.validatedCursor(nil))
        XCTAssertEqual(
            try AgentRunRoutes.validatedCursor(cursor.uuidString.lowercased()),
            cursor
        )
        XCTAssertThrowsError(try AgentRunRoutes.validatedCursor("not-a-run-id")) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }

        XCTAssertEqual(AgentRunRoutes.validatedLimit(nil), 50)
        XCTAssertEqual(AgentRunRoutes.validatedLimit("0"), 1)
        XCTAssertEqual(AgentRunRoutes.validatedLimit("201"), 200)
    }

    func testRunSummaryProjectionIsBoundedAndCredentialFree() {
        let projection = AgentRunRoutes.runSummaryFieldsSQL(alias: "r")
        for field in [
            "'id'", "'channelId'", "'triggerMessageId'", "'triggerSummary'",
            "'status'", "'startedAtMs'", "'finishedAtMs'", "'createdAtMs'", "'updatedAtMs'",
        ] {
            XCTAssertTrue(projection.contains(field), "missing shared summary field \(field)")
        }
        XCTAssertTrue(projection.contains("left(nullif(btrim(r.input->>'title'), ''), 200)"))
        XCTAssertTrue(projection.contains("left(nullif(btrim(r.input->>'prompt'), ''), 200)"))
        for excluded in ["'input'", "'output'", "'error'", "'workspaceId'", "'agentMemberId'"] {
            XCTAssertFalse(projection.contains(excluded), "summary leaked \(excluded)")
        }
    }

    func testAgentRunSummaryWireShapeExcludesDetailPayloads() throws {
        let run = AgentRunSummaryDTO(
            id: "00000000-0000-7000-8000-000000000653",
            channelId: "00000000-0000-7000-8000-000000000202",
            triggerMessageId: nil,
            triggerSummary: "Release notes",
            status: "succeeded",
            startedAtMs: 1_000,
            finishedAtMs: 2_000,
            createdAtMs: 900,
            updatedAtMs: 2_000
        )
        let page = AgentRunSummaryPageDTO(runs: [run], nextCursor: nil)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(page)) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), ["runs"])
        let runs = try XCTUnwrap(object["runs"] as? [[String: Any]])
        let wire = try XCTUnwrap(runs.first)
        XCTAssertEqual(
            Set(wire.keys),
            [
                "id", "channelId", "triggerSummary", "status",
                "startedAtMs", "finishedAtMs", "createdAtMs", "updatedAtMs",
            ]
        )
        for excluded in [
            "input", "output", "error", "workspaceId", "agentMemberId",
            "idempotencyKey", "payload", "transcript",
        ] {
            XCTAssertNil(wire[excluded], "summary wire leaked \(excluded)")
        }
    }
}
