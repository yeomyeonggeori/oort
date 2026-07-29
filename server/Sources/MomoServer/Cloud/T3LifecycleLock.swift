import Foundation
import Logging
import PostgresNIO

enum T3LifecycleLock {
    /// Must be the first lifecycle statement in a T3 mutation transaction.
    /// Transactions spanning multiple cloud hosts acquire their IDs in ascending
    /// order before making any lifecycle read or write.
    static func acquire(
        conn: PostgresConnection,
        logger: Logger,
        cloudHostID: UUID
    ) async throws {
        _ = try await conn.query(
            "SELECT acquire_t3_lifecycle_lock(\(cloudHostID))",
            logger: logger
        ).collect()
    }
}
