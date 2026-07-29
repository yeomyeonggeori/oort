import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// ADR-0140 D4 ③ — the stale-response guard, server side.
///
/// The predicate itself lives in migration 057 (`t3_lifecycle_intent_is_current`)
/// rather than here: MomoServer and NotifierWorker both confirm provider
/// responses, and the T3LifecycleLock precedent shows what two Swift copies of
/// one rule do to it over time. This type is only the call.
enum T3LifecycleIntent {
    /// True when the durable intent the in-flight provider response was issued
    /// for is still the current one. Takes the cloud-host row lock (ladder
    /// stage 2) and holds it for the caller's transaction, so a `true` answer
    /// stays true until commit.
    static func isCurrent(
        conn: PostgresConnection,
        logger: Logger,
        cloudHostID: UUID,
        operationID: UUID,
        version: Int64,
        expectedState: String
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT t3_lifecycle_intent_is_current(
              \(cloudHostID), \(operationID), \(version), \(expectedState)
            )
            """,
            logger: logger
        ).collect()
        return try rows.first?.decode(Bool.self) ?? false
    }

    /// The conflict a discarded response produces. It is not a failure of the
    /// operation — the operation may well have happened at the provider — it is
    /// a statement that momo will not apply an answer to a superseded question.
    static var staleResponse: HTTPError {
        HTTPError(
            .conflict,
            message: "momo Cloud 호스트 상태가 변경되어 provider 응답을 폐기했습니다."
        )
    }
}
