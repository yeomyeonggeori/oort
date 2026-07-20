import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct UpdateWorkPoolRequest: Decodable {
    let maxActive: Int
    let includedActiveHours: Int?
    let perMemberSoftLimit: Int
}

struct WorkPoolDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let workspaceId: String
    let maxActive: Int
    let includedActiveHours: Int?
    let perMemberSoftLimit: Int
    let activeSessions: Int
    let memberActiveSessions: Int
}

struct WorkPoolResponse: ResponseEncodable {
    let workPool: WorkPoolDTO
}

/// ADR-0125 D5 workspace-shared billing/quota pool.
///
/// GET exposes settings plus aggregate and caller usage to an active human
/// workspace member. PUT replaces settings for an owner/admin and records the
/// change in audit_log in the same tenant transaction. Usage is always derived
/// from running work_session rows; this surface owns no mutable counter.
///
/// Pool exhaustion returns only a structured HTTP 409 in v0. Automatic queue
/// start and its waiting-card UX are follow-up work, as is any warm VM pool.
struct WorkPoolRoutes: Sendable {
    struct Settings: Sendable, Equatable {
        let maxActive: Int
        let includedActiveHours: Int?
        let perMemberSoftLimit: Int
    }

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/work-pool", use: get)
        group.put("/v1/workspaces/:ws/work-pool", use: update)
    }

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)

        let pool = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            _ = try await Self.requireActiveWorkspaceRole(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
            try await Self.ensureDefaultPool(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID
            )
            return try await Self.loadPool(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
        }

        return try WorkPoolResponse(workPool: pool)
            .response(from: request, context: context)
    }

    @Sendable
    func update(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let requestDTO = try await request.decode(
            as: UpdateWorkPoolRequest.self,
            context: context
        )
        let settings = try Self.validatedSettings(
            maxActive: requestDTO.maxActive,
            includedActiveHours: requestDTO.includedActiveHours,
            perMemberSoftLimit: requestDTO.perMemberSoftLimit
        )

        let pool = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let role = try await Self.requireActiveWorkspaceRole(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role == "owner" || role == "admin" else {
                throw HTTPError(.forbidden, message: "workspace admin required")
            }
            try await Self.ensureDefaultPool(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID
            )

            let previousRows = try await conn.query(
                """
                SELECT max_active, included_active_hours, per_member_soft_limit
                  FROM work_pool
                 WHERE workspace_id = \(workspaceID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let previousRow = previousRows.first else {
                throw HTTPError(.internalServerError, message: "work pool is unavailable")
            }
            let previous = try previousRow.decode((Int, Int?, Int).self)

            _ = try await conn.query(
                """
                UPDATE work_pool
                   SET max_active = \(settings.maxActive),
                       included_active_hours = \(settings.includedActiveHours),
                       per_member_soft_limit = \(settings.perMemberSoftLimit)
                 WHERE workspace_id = \(workspaceID)
                """,
                logger: db.logger
            )

            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, detail)
                VALUES (
                  \(workspaceID),
                  \(principal.memberID),
                  'work.pool.updated',
                  'work_pool',
                  \(workspaceID),
                  \(principal.tokenID),
                  jsonb_build_object(
                    'schema', 'momo.work_pool.updated.v1',
                    'previous', jsonb_build_object(
                      'max_active', \(previous.0),
                      -- Explicit cast: a NULL optional bound inside
                      -- jsonb_build_object has no inferable type and 500s.
                      'included_active_hours', \(previous.1)::int,
                      'per_member_soft_limit', \(previous.2)
                    ),
                    'new', jsonb_build_object(
                      'max_active', \(settings.maxActive),
                      'included_active_hours', \(settings.includedActiveHours)::int,
                      'per_member_soft_limit', \(settings.perMemberSoftLimit)
                    ),
                    'max_active_increased', \(settings.maxActive > previous.0)
                  )
                )
                """,
                logger: db.logger
            )

            return try await Self.loadPool(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
        }

        return try WorkPoolResponse(workPool: pool)
            .response(from: request, context: context)
    }

    /// Serializes all slot acquisitions for a workspace on its work_pool row.
    /// The lock is held by the caller's existing tenant transaction through the
    /// subsequent work_session INSERT, so concurrent creates cannot exceed cap.
    static func acquireSlot(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws {
        try await ensureDefaultPool(conn: conn, logger: logger, workspaceID: workspaceID)
        let settingsRows = try await conn.query(
            """
            SELECT max_active, per_member_soft_limit
              FROM work_pool
             WHERE workspace_id = \(workspaceID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let settingsRow = settingsRows.first else {
            throw HTTPError(.internalServerError, message: "work pool is unavailable")
        }
        let (maxActive, memberLimit) = try settingsRow.decode((Int, Int).self)

        let usageRows = try await conn.query(
            """
            SELECT count(*)::int AS active_sessions,
                   (count(*) FILTER (WHERE member_id = \(memberID)))::int
                     AS member_active_sessions
              FROM work_session
             WHERE workspace_id = \(workspaceID)
               AND status = 'running'
            """,
            logger: logger
        ).collect()
        guard let usageRow = usageRows.first else {
            throw HTTPError(.internalServerError, message: "work pool usage is unavailable")
        }
        let (activeSessions, memberActiveSessions) = try usageRow.decode((Int, Int).self)
        guard activeSessions < maxActive else {
            throw HTTPError(.conflict, message: "pool_exhausted")
        }
        guard memberActiveSessions < memberLimit else {
            throw HTTPError(.conflict, message: "member_limit")
        }
    }

    static func validatedSettings(
        maxActive: Int,
        includedActiveHours: Int?,
        perMemberSoftLimit: Int
    ) throws -> Settings {
        guard (1...1000).contains(maxActive) else {
            throw HTTPError(.badRequest, message: "maxActive must be 1...1000")
        }
        if let includedActiveHours,
           !(0...1_000_000).contains(includedActiveHours) {
            throw HTTPError(
                .badRequest,
                message: "includedActiveHours must be null or 0...1000000"
            )
        }
        guard (1...maxActive).contains(perMemberSoftLimit) else {
            throw HTTPError(
                .badRequest,
                message: "perMemberSoftLimit must be 1...maxActive"
            )
        }
        return Settings(
            maxActive: maxActive,
            includedActiveHours: includedActiveHours,
            perMemberSoftLimit: perMemberSoftLimit
        )
    }

    private static func requireHumanPrincipal(
        _ context: AppRequestContext
    ) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "work pool management requires a human member")
        }
        return principal
    }

    private static func requireActiveWorkspaceRole(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws -> String {
        let rows = try await conn.query(
            """
            SELECT ms.role::text
              FROM membership ms
              JOIN member m
                ON m.id = ms.member_id
               AND m.workspace_id = ms.workspace_id
             WHERE ms.workspace_id = \(workspaceID)
               AND ms.member_id = \(memberID)
               AND ms.left_at IS NULL
               AND m.kind = 'human'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             ORDER BY CASE ms.role::text
                        WHEN 'owner' THEN 0
                        WHEN 'admin' THEN 1
                        WHEN 'member' THEN 2
                        ELSE 3
                      END
             LIMIT 1
             FOR SHARE OF ms, m
            """,
            logger: logger
        ).collect()
        guard let role = try rows.first?.decode(String.self) else {
            throw HTTPError(.forbidden, message: "active workspace membership required")
        }
        return role
    }

    private static func ensureDefaultPool(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO work_pool (workspace_id)
            VALUES (\(workspaceID))
            ON CONFLICT (workspace_id) DO NOTHING
            """,
            logger: logger
        )
    }

    private static func loadPool(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws -> WorkPoolDTO {
        let rows = try await conn.query(
            """
            SELECT p.workspace_id, p.max_active, p.included_active_hours,
                   p.per_member_soft_limit,
                   count(ws.id)::int AS active_sessions,
                   (count(ws.id) FILTER (WHERE ws.member_id = \(memberID)))::int
                     AS member_active_sessions
              FROM work_pool p
              LEFT JOIN work_session ws
                ON ws.workspace_id = p.workspace_id
               AND ws.status = 'running'
             WHERE p.workspace_id = \(workspaceID)
             GROUP BY p.workspace_id, p.max_active, p.included_active_hours,
                      p.per_member_soft_limit
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "work pool is unavailable")
        }
        let decoded = try row.decode((UUID, Int, Int?, Int, Int, Int).self)
        return WorkPoolDTO(
            workspaceId: decoded.0.uuidString,
            maxActive: decoded.1,
            includedActiveHours: decoded.2,
            perMemberSoftLimit: decoded.3,
            activeSessions: decoded.4,
            memberActiveSessions: decoded.5
        )
    }

    private func withTenantTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await db.withTenantTransaction(workspaceID: workspaceID, body)
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }
}
