import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Workspace channel read endpoints.
///
///   GET /v1/workspaces/{ws}/channels
///
/// The handler uses the normal tenant read path (`SET LOCAL app.workspace_id`)
/// and an active workspace membership guard. It returns only channels where the
/// authenticated member has active channel membership.
struct ChannelRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/channels", use: list)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let includeArchived = request.uri.queryParameters["include_archived"] == "true"
            || request.uri.queryParameters["includeArchived"] == "true"
        let limit = Self.validatedLimit(request.uri.queryParameters["limit"].map(String.init))

        let result: (isMember: Bool, channels: [ChannelDTO]) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let role = try await InviteRoutes.activeWorkspaceRole(
                conn: conn,
                logger: db.logger,
                memberID: principal.memberID
            )
            guard role != nil else { return (false, []) }

            let channels = try await Self.fetchChannels(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID,
                includeArchived: includeArchived,
                limit: limit
            )
            return (true, channels)
        }

        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }
        return try WorkspaceChannelsResponse(channels: result.channels)
            .response(from: request, context: context)
    }

    static func validatedLimit(_ raw: String?) -> Int {
        min(max(raw.flatMap { Int($0) } ?? 200, 1), 500)
    }

    static func decodeChannelList(from row: PostgresRow?) throws -> [ChannelDTO] {
        guard let row else { return [] }
        let json = try row.decode(String.self)
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "channel JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode([ChannelDTO].self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "channel JSON decoding failed")
        }
    }

    private static func fetchChannels(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID,
        includeArchived: Bool,
        limit: Int
    ) async throws -> [ChannelDTO] {
        let rows = try await conn.query(
            """
            SELECT COALESCE(json_agg(row_json ORDER BY sort_key, lower(COALESCE(row_json->>'name', '')))::text, '[]') AS payload
              FROM (
                SELECT json_build_object(
                         'id', c.id,
                         'workspaceId', c.workspace_id,
                         'kind', c.kind::text,
                         'name', c.name,
                         'topic', c.topic,
                         'dmKey', c.dm_key,
                         'createdBy', c.created_by,
                         'archivedAtMs',
                           CASE WHEN c.archived_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from c.archived_at) * 1000)::bigint
                           END
                       ) AS row_json,
                       CASE c.kind::text
                         WHEN 'public' THEN 0
                         WHEN 'private' THEN 1
                         ELSE 2
                       END AS sort_key
                  FROM channel c
                  JOIN membership ms
                    ON ms.channel_id = c.id
                   AND ms.member_id = \(memberID)
                   AND ms.left_at IS NULL
                 WHERE c.workspace_id = \(workspaceID)
                   AND (\(includeArchived) OR c.archived_at IS NULL)
                 ORDER BY sort_key, lower(COALESCE(c.name, ''))
                 LIMIT \(limit)
              ) rows
            """,
            logger: logger
        ).collect()
        return try decodeChannelList(from: rows.first)
    }
}
