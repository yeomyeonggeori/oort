import Foundation
import Logging
import PostgresNIO

enum T3LifecycleLock {
    /// Notifier-side ADR-0140 stages 0...2. The host advisory remains the first
    /// statement, followed by the optional workspace-credit row and cloud host.
    static func acquirePrelude(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID?,
        cloudHostID: UUID,
        lockWorkspaceCredit: Bool = false
    ) async throws {
        _ = try await conn.query(
            "SELECT acquire_t3_lifecycle_lock(\(cloudHostID))",
            logger: logger
        ).collect()
        if lockWorkspaceCredit {
            guard let workspaceID else {
                preconditionFailure("workspace credit lock requires workspace id")
            }
            _ = try await conn.query(
                """
                SELECT workspace_id
                  FROM workspace_credit
                 WHERE workspace_id = \(workspaceID)
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
        }
        if let workspaceID {
            _ = try await conn.query(
                """
                SELECT id
                  FROM work_cloud_host
                 WHERE workspace_id = \(workspaceID)
                   AND id = \(cloudHostID)
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
        } else {
            _ = try await conn.query(
                "SELECT id FROM work_cloud_host WHERE id = \(cloudHostID) FOR UPDATE",
                logger: logger
            ).collect()
        }
    }
}
