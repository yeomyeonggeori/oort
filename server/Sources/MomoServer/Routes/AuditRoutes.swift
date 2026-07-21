import Foundation
import Hummingbird
import PostgresNIO

/// Owner/admin read projection over the existing tenant-scoped audit ledger.
/// The UUID cursor identifies the final row of the previous `(created_at, id)`
/// descending page; no audit data or credentials are encoded into the cursor.
struct AuditRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/audit", use: list)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "audit access requires a human workspace admin")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let query = request.uri.queryParameters
        let filters = try Self.filters(
            actions: query["actions"].map(String.init),
            targetMember: (query["target_member_id"] ?? query["targetMemberId"] ?? query["member"])
                .map(String.init),
            fromMs: (query["from_ms"] ?? query["fromMs"] ?? query["from"]).map(String.init),
            toMs: (query["to_ms"] ?? query["toMs"] ?? query["to"]).map(String.init),
            cursor: query["cursor"].map(String.init),
            limit: query["limit"].map(String.init)
        )

        let page: AuditPageResponse = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            if let cursor = filters.cursor {
                let cursorRows = try await conn.query(
                    "SELECT 1 FROM audit_log WHERE workspace_id = \(workspaceID) AND id = \(cursor)::uuid",
                    logger: db.logger
                ).collect()
                guard !cursorRows.isEmpty else {
                    throw HTTPError(.badRequest, message: "audit cursor was not found")
                }
            }

            let rows = try await conn.query(
                """
                SELECT a.id, a.actor_member_id, a.subject_member_id, a.action,
                       a.target_type, a.target_id, a.via_token_id, a.run_id,
                       a.detail::text, a.created_at
                  FROM audit_log a
                 WHERE a.workspace_id = \(workspaceID)
                   AND (\(!filters.actionPrefixes.isEmpty) = false OR EXISTS (
                         SELECT 1 FROM unnest(\(filters.actionPrefixes)::text[]) prefix
                          WHERE a.action LIKE prefix || '%'
                       ))
                   AND (\(filters.targetMember)::uuid IS NULL
                        OR a.subject_member_id = \(filters.targetMember)::uuid)
                   AND (\(filters.fromMs)::bigint IS NULL
                        OR a.created_at >= to_timestamp(\(filters.fromMs)::double precision / 1000.0))
                   AND (\(filters.toMs)::bigint IS NULL
                        OR a.created_at <= to_timestamp(\(filters.toMs)::double precision / 1000.0))
                   AND (\(filters.cursor)::uuid IS NULL OR (a.created_at, a.id) < (
                         SELECT cursor_row.created_at, cursor_row.id
                           FROM audit_log cursor_row
                          WHERE cursor_row.workspace_id = \(workspaceID)
                            AND cursor_row.id = \(filters.cursor)::uuid
                       ))
                 ORDER BY a.created_at DESC, a.id DESC
                 LIMIT \(filters.limit + 1)
                """,
                logger: db.logger
            ).collect()
            let decoded = try rows.map(Self.decode)
            let hasMore = decoded.count > filters.limit
            let events = Array(decoded.prefix(filters.limit))
            return AuditPageResponse(
                events: events,
                nextCursor: hasMore ? events.last?.id : nil
            )
        }
        return try page.response(from: request, context: context)
    }

    struct Filters: Equatable, Sendable {
        let actionPrefixes: [String]
        let targetMember: UUID?
        let fromMs: Int64?
        let toMs: Int64?
        let cursor: UUID?
        let limit: Int
    }

    static func filters(
        actions: String?,
        targetMember: String?,
        fromMs: String?,
        toMs: String?,
        cursor: String?,
        limit: String?
    ) throws -> Filters {
        let prefixes = actions?.split(separator: ",", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        } ?? []
        guard prefixes.count <= 20,
              prefixes.allSatisfy({ !$0.isEmpty && $0.count <= 120 })
        else {
            throw HTTPError(.badRequest, message: "actions must contain 1...20 comma-separated prefixes")
        }
        let targetID = try optionalUUID(targetMember, label: "target member")
        let cursorID = try optionalUUID(cursor, label: "audit cursor")
        let lower = try optionalEpochMs(fromMs, label: "from")
        let upper = try optionalEpochMs(toMs, label: "to")
        if let lower, let upper, lower > upper {
            throw HTTPError(.badRequest, message: "from must not be later than to")
        }
        let pageSize: Int
        if let limit {
            guard let parsed = Int(limit), (1...200).contains(parsed) else {
                throw HTTPError(.badRequest, message: "limit must be between 1 and 200")
            }
            pageSize = parsed
        } else {
            pageSize = 50
        }
        return Filters(
            actionPrefixes: prefixes,
            targetMember: targetID,
            fromMs: lower,
            toMs: upper,
            cursor: cursorID,
            limit: pageSize
        )
    }

    private static func optionalUUID(_ raw: String?, label: String) throws -> UUID? {
        guard let raw else { return nil }
        guard let value = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid \(label)")
        }
        return value
    }

    private static func optionalEpochMs(_ raw: String?, label: String) throws -> Int64? {
        guard let raw else { return nil }
        guard let value = Int64(raw), value >= 0 else {
            throw HTTPError(.badRequest, message: "\(label) must be a non-negative epoch millisecond value")
        }
        return value
    }

    private static func decode(_ row: PostgresRow) throws -> AuditEventDTO {
        let (id, actorID, subjectID, action, targetType, targetID, tokenID, runID, detail, createdAt) =
            try row.decode((UUID, UUID?, UUID?, String, String?, UUID?, UUID?, UUID?, String, Date).self)
        let detailValue = try JSONDecoder().decode(JSONValue.self, from: Data(detail.utf8))
        return AuditEventDTO(
            id: id.uuidString,
            actorMemberId: actorID?.uuidString,
            subjectMemberId: subjectID?.uuidString,
            action: action,
            targetType: targetType,
            targetId: targetID?.uuidString,
            viaTokenId: tokenID?.uuidString,
            runId: runID?.uuidString,
            detail: detailValue,
            createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
        )
    }
}

struct AuditEventDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let actorMemberId: String?
    let subjectMemberId: String?
    let action: String
    let targetType: String?
    let targetId: String?
    let viaTokenId: String?
    let runId: String?
    let detail: JSONValue
    let createdAtMs: Int64
}

struct AuditPageResponse: ResponseEncodable, Codable, Sendable, Equatable {
    let events: [AuditEventDTO]
    let nextCursor: String?
}
