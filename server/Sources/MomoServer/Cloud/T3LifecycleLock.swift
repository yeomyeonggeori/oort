import Foundation
import Logging
import PostgresNIO

enum T3LifecycleLock {
    /// Canonical ADR-0140 stages 0...2. This method owns the only server-side
    /// prelude shape: every host advisory first, optional workspace rows next,
    /// then every cloud-host row in the same UUID order.
    static func acquirePrelude(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        orderedCloudHostIDs: [UUID],
        lockWorkPool: Bool,
        lockWorkspaceCredit: Bool
    ) async throws {
        for cloudHostID in orderedCloudHostIDs {
            _ = try await conn.query(
                "SELECT acquire_t3_lifecycle_lock(\(cloudHostID))",
                logger: logger
            ).collect()
        }

        _ = try await conn.query(
            "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
            logger: logger
        )

        if lockWorkPool {
            _ = try await conn.query(
                """
                INSERT INTO work_pool (workspace_id)
                VALUES (\(workspaceID))
                ON CONFLICT (workspace_id) DO NOTHING
                """,
                logger: logger
            )
            _ = try await conn.query(
                """
                SELECT workspace_id
                  FROM work_pool
                 WHERE workspace_id = \(workspaceID)
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
        }

        if lockWorkspaceCredit {
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

        for cloudHostID in orderedCloudHostIDs {
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
        }
    }
}
