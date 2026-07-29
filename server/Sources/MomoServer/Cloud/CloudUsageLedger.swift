import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// ADR-0136 T3-only credit and active-time ledger.
///
/// Token request accounting remains in `usage_ledger`. This ledger owns one T3
/// session and its active/paused intervals; lifecycle callers acquire the
/// cloud-host advisory before entering this file's existing row-lock ladder.
enum CloudUsageLedger {
    static func reserveProvisioningSlot(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO work_pool (workspace_id)
            VALUES (\(workspaceID))
            ON CONFLICT (workspace_id) DO NOTHING
            """,
            logger: logger
        )
        let poolRows = try await conn.query(
            """
            SELECT max_active, per_member_soft_limit
              FROM work_pool
             WHERE workspace_id = \(workspaceID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let poolRow = poolRows.first else {
            throw HTTPError(.internalServerError, message: "momo Cloud 슬롯 설정을 읽을 수 없습니다.")
        }
        let (maxActive, memberLimit) = try poolRow.decode((Int, Int).self)

        let creditRows = try await conn.query(
            """
            SELECT balance_micro_usd
              FROM workspace_credit
             WHERE workspace_id = \(workspaceID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let creditRow = creditRows.first else {
            throw HTTPError(
                .conflict,
                message: "momo Cloud 크레딧 원장이 없어 시작할 수 없습니다. 운영자에게 크레딧 할당을 요청하세요."
            )
        }
        let balance = try creditRow.decode(Int64.self)
        guard balance > 0 else {
            throw HTTPError(
                .conflict,
                message: "momo Cloud 크레딧이 없어 시작할 수 없습니다. 크레딧을 충전한 뒤 다시 시도하세요."
            )
        }

        let usageRows = try await conn.query(
            """
            SELECT
              (
                SELECT count(*)::int
                  FROM work_session ws
                  JOIN work_host h ON h.id = ws.host_id
                 WHERE ws.workspace_id = \(workspaceID)
                   AND ws.status IN ('running', 'idle')
                   AND h.type <> 'cloud'
              )
              +
              (
                SELECT count(*)::int
                  FROM work_cloud_host ch
                 WHERE ch.workspace_id = \(workspaceID)
                   AND ch.state IN ('provisioning', 'ready', 'running', 'paused')
              ) AS occupied,
              (
                SELECT count(*)::int
                  FROM work_cloud_host ch
                 WHERE ch.workspace_id = \(workspaceID)
                   AND ch.requester_member_id = \(memberID)
                   AND ch.state IN ('provisioning', 'ready', 'running', 'paused')
              ) AS member_occupied
            """,
            logger: logger
        ).collect()
        guard let usageRow = usageRows.first else {
            throw HTTPError(.internalServerError, message: "momo Cloud 슬롯 사용량을 읽을 수 없습니다.")
        }
        let (occupied, memberOccupied) = try usageRow.decode((Int, Int).self)
        guard occupied < maxActive else {
            throw HTTPError(
                .conflict,
                message: "momo Cloud 슬롯이 모두 사용 중입니다. 현재 \(occupied)/\(maxActive)개입니다."
            )
        }
        guard memberOccupied < memberLimit else {
            throw HTTPError(
                .conflict,
                message: "내 momo Cloud 동시 실행 한도 \(memberLimit)개를 모두 사용 중입니다."
            )
        }
    }

    static func start(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        sessionID: UUID,
        hostID: UUID
    ) async throws {
        let cloudRows = try await conn.query(
            """
            SELECT id, unit_rate_micro_usd_second, state
              FROM work_cloud_host
             WHERE workspace_id = \(workspaceID)
               AND host_id = \(hostID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let cloudRow = cloudRows.first else { return }
        let (_, unitRate, state) = try cloudRow.decode((UUID, Int64, String).self)
        guard state == "ready" || state == "running" else {
            throw HTTPError(
                .conflict,
                message: "momo Cloud 호스트가 실행 준비 상태가 아닙니다. 현재 상태: \(state)"
            )
        }
        let existingRows = try await conn.query(
            """
            SELECT session_id
              FROM work_host_usage
             WHERE workspace_id = \(workspaceID)
               AND host_id = \(hostID)
               AND settled_at IS NULL
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard existingRows.first == nil else {
            throw HTTPError(
                .conflict,
                message: "이 momo Cloud 호스트에는 이미 정산 전 세션이 있습니다."
            )
        }

        let usageRows = try await conn.query(
            """
            INSERT INTO work_host_usage
              (session_id, host_id, workspace_id, unit_rate_micro_usd_second)
            VALUES
              (\(sessionID), \(hostID), \(workspaceID), \(unitRate))
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard let usageID = try usageRows.first?.decode(UUID.self) else {
            throw HTTPError(.internalServerError, message: "momo Cloud 활성시간 원장을 시작하지 못했습니다.")
        }
        _ = try await conn.query(
            """
            INSERT INTO work_host_usage_interval (usage_id, workspace_id, state)
            VALUES (\(usageID), \(workspaceID), 'active')
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            UPDATE work_cloud_host
               SET state = 'running', updated_at = clock_timestamp()
             WHERE workspace_id = \(workspaceID)
               AND host_id = \(hostID)
            """,
            logger: logger
        )
    }

    static func pause(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        hostID: UUID
    ) async throws -> UUID {
        let usage = try await lockOpenUsage(
            conn: conn, logger: logger, workspaceID: workspaceID, hostID: hostID,
            sessionID: nil
        )
        try await transitionInterval(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            usageID: usage.id,
            expected: "active",
            next: "paused"
        )
        return usage.sessionID
    }

    static func pause(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        hostID: UUID,
        sessionID: UUID
    ) async throws {
        let usage = try await lockOpenUsage(
            conn: conn, logger: logger, workspaceID: workspaceID, hostID: hostID,
            sessionID: sessionID
        )
        try await transitionInterval(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            usageID: usage.id,
            expected: "active",
            next: "paused"
        )
    }

    static func resume(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        hostID: UUID
    ) async throws -> UUID {
        let usage = try await lockOpenUsage(
            conn: conn, logger: logger, workspaceID: workspaceID, hostID: hostID,
            sessionID: nil
        )
        try await transitionInterval(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            usageID: usage.id,
            expected: "paused",
            next: "active"
        )
        return usage.sessionID
    }

    static func resume(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        hostID: UUID,
        sessionID: UUID
    ) async throws {
        let usage = try await lockOpenUsage(
            conn: conn, logger: logger, workspaceID: workspaceID, hostID: hostID,
            sessionID: sessionID
        )
        try await transitionInterval(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            usageID: usage.id,
            expected: "paused",
            next: "active"
        )
    }

    static func settle(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        sessionID: UUID
    ) async throws {
        _ = try await conn.query(
            "SELECT settle_t3_work_session(\(workspaceID), \(sessionID))",
            logger: logger
        ).collect()
    }

    private struct OpenUsage: Sendable {
        let id: UUID
        let sessionID: UUID
    }

    private static func lockOpenUsage(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        hostID: UUID,
        sessionID: UUID?
    ) async throws -> OpenUsage {
        let rows: [PostgresRow]
        if let sessionID {
            rows = try await conn.query(
                """
                SELECT id, session_id
                  FROM work_host_usage
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND session_id = \(sessionID)
                   AND settled_at IS NULL
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
        } else {
            rows = try await conn.query(
                """
                SELECT id, session_id
                  FROM work_host_usage
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND settled_at IS NULL
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
        }
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "실행 중인 momo Cloud 세션이 없습니다.")
        }
        let decoded = try row.decode((UUID, UUID).self)
        return OpenUsage(id: decoded.0, sessionID: decoded.1)
    }

    private static func transitionInterval(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        usageID: UUID,
        expected: String,
        next: String
    ) async throws {
        let rows = try await conn.query(
            """
            UPDATE work_host_usage_interval
               SET ended_at = clock_timestamp()
             WHERE usage_id = \(usageID)
               AND state = \(expected)
               AND ended_at IS NULL
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard rows.first != nil else {
            throw HTTPError(
                .conflict,
                message: "momo Cloud 세션 상태가 이미 변경되었습니다. 새로고침 후 다시 시도하세요."
            )
        }
        _ = try await conn.query(
            """
            INSERT INTO work_host_usage_interval
              (usage_id, workspace_id, state, started_at)
            VALUES
              (\(usageID), \(workspaceID), \(next), clock_timestamp())
            """,
            logger: logger
        )
    }
}
