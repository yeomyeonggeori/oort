import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct WorkstreamDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let channelId: String
    let rootMessageId: String
    let goal: String
    let status: String
    let createdByMemberId: String
    let createdAtMs: Int64
    let updatedAtMs: Int64
    let runCount: Int64
    let activeRunCount: Int64
}

/// One Run of a workstream. ADR-0143 D2: `memberId` is the actor of this Run and
/// is never transferred, so the run list is the actor-independence evidence.
/// Host-local execution state stays out of this projection by design.
struct WorkstreamRunDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let memberId: String
    let hostId: String
    let tool: String
    let label: String
    let status: String
    let startedAtMs: Int64
    let endedAtMs: Int64?
    let exitCode: Int?
    let endReason: String?
    let resumedFromSessionId: String?
}

struct WorkstreamResponse: ResponseEncodable {
    let workstream: WorkstreamDTO
}

struct WorkstreamListResponse: ResponseEncodable {
    let workstreams: [WorkstreamDTO]
}

struct WorkstreamRunListResponse: ResponseEncodable {
    let workstreamId: String
    let runs: [WorkstreamRunDTO]
}

/// ADR-0143 D1/D3 read projections over the goal layer.
///
///   GET /v1/workspaces/{ws}/workstreams?status=&channelId=&sessionId=&limit=
///   GET /v1/workspaces/{ws}/workstreams/{workstream}
///   GET /v1/workspaces/{ws}/workstreams/{workstream}/runs
///
/// Visibility is derived from channel membership exactly like every other
/// channel projection — no workstream-level ACL is invented (D3). Agents are
/// members, so the same predicate covers them. Minimum exposure (#831): the
/// ledger's host-local surface never appears here, and a workstream anchored in
/// a channel the caller does not belong to answers 404 rather than 403, so these
/// reads cannot be used to probe for the existence of other people's work.
struct WorkstreamRoutes: Sendable {
    static let maximumListLimit = 200
    static let defaultListLimit = 50

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/workstreams", use: list)
        group.get("/v1/workspaces/:ws/workstreams/:workstream", use: detail)
        group.get("/v1/workspaces/:ws/workstreams/:workstream/runs", use: runs)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireMemberPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let status = try Self.validatedStatus(
            request.uri.queryParameters["status"].map(String.init)
        )
        let channelID = try Self.optionalUUID(
            request.uri.queryParameters["channelId"].map(String.init),
            label: "channelId"
        )
        let sessionID = try Self.optionalUUID(
            request.uri.queryParameters["sessionId"].map(String.init),
            label: "sessionId"
        )
        let limit = try Self.validatedLimit(
            request.uri.queryParameters["limit"].map(String.init)
        )

        let workstreams: [WorkstreamDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT \(unescaped: Self.projectionSQL)
                  FROM workstream w
                 WHERE w.workspace_id = \(workspaceID)
                   AND (\(status)::text IS NULL OR w.status = \(status))
                   AND (\(channelID)::uuid IS NULL OR w.channel_id = \(channelID))
                   AND (
                     \(sessionID)::uuid IS NULL
                     OR EXISTS (
                       SELECT 1
                         FROM work_session run
                        WHERE run.workspace_id = w.workspace_id
                          AND run.workstream_id = w.id
                          AND run.id = \(sessionID)
                     )
                   )
                   AND EXISTS (
                     SELECT 1
                       FROM channel c
                       JOIN membership ms
                         ON ms.workspace_id = c.workspace_id
                        AND ms.channel_id = c.id
                        AND ms.member_id = \(principal.memberID)
                        AND ms.left_at IS NULL
                       JOIN member m
                         ON m.id = ms.member_id
                        AND m.workspace_id = c.workspace_id
                        AND m.status = 'active'
                        AND m.deleted_at IS NULL
                      WHERE c.workspace_id = w.workspace_id
                        AND c.id = w.channel_id
                        AND c.archived_at IS NULL
                   )
                 ORDER BY w.created_at DESC, w.id DESC
                 LIMIT \(limit)
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeWorkstream)
        }
        return try WorkstreamListResponse(workstreams: workstreams)
            .response(from: request, context: context)
    }

    @Sendable
    func detail(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireMemberPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let workstreamID = try Self.workstreamID(context)

        let workstream: WorkstreamDTO? = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT \(unescaped: Self.projectionSQL)
                  FROM workstream w
                 WHERE w.workspace_id = \(workspaceID)
                   AND w.id = \(workstreamID)
                   AND EXISTS (
                     SELECT 1
                       FROM channel c
                       JOIN membership ms
                         ON ms.workspace_id = c.workspace_id
                        AND ms.channel_id = c.id
                        AND ms.member_id = \(principal.memberID)
                        AND ms.left_at IS NULL
                       JOIN member m
                         ON m.id = ms.member_id
                        AND m.workspace_id = c.workspace_id
                        AND m.status = 'active'
                        AND m.deleted_at IS NULL
                      WHERE c.workspace_id = w.workspace_id
                        AND c.id = w.channel_id
                        AND c.archived_at IS NULL
                   )
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            return try Self.decodeWorkstream(row)
        }
        guard let workstream else {
            throw HTTPError(.notFound, message: "workstream not found")
        }
        return try WorkstreamResponse(workstream: workstream)
            .response(from: request, context: context)
    }

    @Sendable
    func runs(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireMemberPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let workstreamID = try Self.workstreamID(context)

        let runs: [WorkstreamRunDTO]? = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            // The membership predicate is evaluated on the workstream, not on
            // the runs, so a non-member cannot learn the run count either.
            let visible = try await conn.query(
                """
                SELECT 1
                  FROM workstream w
                 WHERE w.workspace_id = \(workspaceID)
                   AND w.id = \(workstreamID)
                   AND EXISTS (
                     SELECT 1
                       FROM channel c
                       JOIN membership ms
                         ON ms.workspace_id = c.workspace_id
                        AND ms.channel_id = c.id
                        AND ms.member_id = \(principal.memberID)
                        AND ms.left_at IS NULL
                       JOIN member m
                         ON m.id = ms.member_id
                        AND m.workspace_id = c.workspace_id
                        AND m.status = 'active'
                        AND m.deleted_at IS NULL
                      WHERE c.workspace_id = w.workspace_id
                        AND c.id = w.channel_id
                        AND c.archived_at IS NULL
                   )
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard visible.first != nil else { return nil }

            let rows = try await conn.query(
                """
                SELECT run.id, run.member_id, run.host_id, run.tool, run.label,
                       run.status, run.started_at, run.ended_at, run.exit_code,
                       run.end_reason, run.resumed_from_session_id
                  FROM work_session run
                 WHERE run.workspace_id = \(workspaceID)
                   AND run.workstream_id = \(workstreamID)
                 ORDER BY run.started_at ASC, run.id ASC
                 LIMIT \(Self.maximumListLimit)
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeRun)
        }
        guard let runs else {
            throw HTTPError(.notFound, message: "workstream not found")
        }
        return try WorkstreamRunListResponse(
            workstreamId: workstreamID.uuidString,
            runs: runs
        ).response(from: request, context: context)
    }

    // MARK: - SQL fragments

    private static let projectionSQL = """
        w.id, w.workspace_id, w.channel_id, w.root_message_id, w.goal,
        w.status, w.created_by_member_id, w.created_at, w.updated_at,
        (SELECT count(*) FROM work_session run
          WHERE run.workspace_id = w.workspace_id AND run.workstream_id = w.id)
          AS run_count,
        (SELECT count(*) FROM work_session run
          WHERE run.workspace_id = w.workspace_id AND run.workstream_id = w.id
            AND run.status IN ('running', 'idle')) AS active_run_count
        """

    // MARK: - Decoding

    private static func decodeWorkstream(_ row: PostgresRow) throws -> WorkstreamDTO {
        let decoded = try row.decode(
            (UUID, UUID, UUID, UUID, String, String, UUID, Date, Date, Int64, Int64).self
        )
        return WorkstreamDTO(
            id: decoded.0.uuidString,
            workspaceId: decoded.1.uuidString,
            channelId: decoded.2.uuidString,
            rootMessageId: decoded.3.uuidString,
            goal: decoded.4,
            status: decoded.5,
            createdByMemberId: decoded.6.uuidString,
            createdAtMs: Int64(decoded.7.timeIntervalSince1970 * 1000),
            updatedAtMs: Int64(decoded.8.timeIntervalSince1970 * 1000),
            runCount: decoded.9,
            activeRunCount: decoded.10
        )
    }

    private static func decodeRun(_ row: PostgresRow) throws -> WorkstreamRunDTO {
        let decoded = try row.decode(
            (UUID, UUID, UUID, String, String, String, Date, Date?, Int?, String?, UUID?).self
        )
        return WorkstreamRunDTO(
            id: decoded.0.uuidString,
            memberId: decoded.1.uuidString,
            hostId: decoded.2.uuidString,
            tool: decoded.3,
            label: decoded.4,
            status: decoded.5,
            startedAtMs: Int64(decoded.6.timeIntervalSince1970 * 1000),
            endedAtMs: decoded.7.map { Int64($0.timeIntervalSince1970 * 1000) },
            exitCode: decoded.8,
            endReason: decoded.9,
            resumedFromSessionId: decoded.10?.uuidString
        )
    }

    // MARK: - Input validation

    static let allowedStatuses = ["active", "paused", "done", "cancelled"]

    static func validatedStatus(_ raw: String?) throws -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        guard allowedStatuses.contains(raw) else {
            throw HTTPError(.badRequest, message: "invalid workstream status filter")
        }
        return raw
    }

    static func validatedLimit(_ raw: String?) throws -> Int {
        guard let raw, !raw.isEmpty else { return defaultListLimit }
        guard let value = Int(raw), value > 0, value <= maximumListLimit else {
            throw HTTPError(.badRequest, message: "invalid workstream limit")
        }
        return value
    }

    static func optionalUUID(_ raw: String?, label: String) throws -> UUID? {
        guard let raw, !raw.isEmpty else { return nil }
        guard let value = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid \(label)")
        }
        return value
    }

    private static func workstreamID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("workstream")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid workstream id")
        }
        return id
    }

    private static func requireMemberPrincipal(
        _ context: AppRequestContext
    ) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human || principal.kind == .agent else {
            throw HTTPError(.forbidden, message: "workstream reads require a member bearer")
        }
        return principal
    }
}
