import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Workspace roster read endpoints.
///
///   GET /v1/workspaces/{ws}/roster
///   GET /v1/workspaces/{ws}/members  (compat alias)
///
/// The handler uses the normal tenant connection path (`SET LOCAL
/// app.workspace_id`) and an active workspace membership guard. It must never use
/// BYPASSRLS; cross-tenant inspection belongs to `PlatformAdminRoutes`.
struct RosterRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/roster", use: roster)
        group.get("/v1/workspaces/:ws/members", use: roster)
    }

    @Sendable
    func roster(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let kindFilter = try Self.validatedKindFilter(
            (request.uri.queryParameters["kind"] ?? request.uri.queryParameters["member_kind"])
                .map(String.init)
        )
        let limit = Self.validatedLimit(request.uri.queryParameters["limit"].map(String.init))

        let result: (isMember: Bool, members: [RosterMemberDTO]) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let role = try await InviteRoutes.activeWorkspaceRole(
                conn: conn,
                logger: db.logger,
                memberID: principal.memberID
            )
            guard role != nil else { return (false, []) }

            if let kindFilter {
                let members = try await Self.fetchRoster(
                    conn: conn,
                    logger: db.logger,
                    kindFilter: kindFilter,
                    limit: limit
                )
                return (true, members)
            }
            let members = try await Self.fetchRoster(
                conn: conn,
                logger: db.logger,
                limit: limit
            )
            return (true, members)
        }
        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }

        let response = WorkspaceRosterResponse(
            members: result.members,
            humanCount: result.members.filter { $0.kind == "human" }.count,
            agentCount: result.members.filter { $0.kind == "agent" }.count
        )
        return try response.response(from: request, context: context)
    }

    static func validatedKindFilter(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty else { return nil }
        guard value == "human" || value == "agent" else {
            throw HTTPError(.badRequest, message: "kind must be human or agent")
        }
        return value
    }

    static func validatedLimit(_ raw: String?) -> Int {
        min(max(raw.flatMap { Int($0) } ?? 200, 1), 500)
    }

    private static func fetchRoster(
        conn: PostgresConnection,
        logger: Logger,
        kindFilter: String? = nil,
        limit: Int
    ) async throws -> [RosterMemberDTO] {
        let rows: [PostgresRow]
        if let kindFilter {
            rows = try await conn.query(
                """
                SELECT COALESCE(json_agg(row_json ORDER BY row_json->>'kind', row_json->>'handle')::text, '[]') AS payload
                  FROM (
                    SELECT json_build_object(
                             'id', m.id,
                             'workspaceId', m.workspace_id,
                             'kind', m.kind::text,
                             'status', m.status::text,
                             'displayName', m.display_name,
                             'handle', m.handle,
                             'avatarUrl', m.avatar_url,
                             'role', r.role,
                             'channelCount', COALESCE(cc.channel_count, 0),
                             'channelIds', COALESCE(ch.channel_ids, ARRAY[]::uuid[]),
                             'capabilities', COALESCE((
                               SELECT jsonb_agg(
                                        capability.value #>> '{}'
                                        ORDER BY capability.ordinality
                                      )
                                 FROM jsonb_array_elements(
                                   CASE
                                     WHEN jsonb_typeof(a.config->'capabilities') = 'array'
                                       THEN a.config->'capabilities'
                                     ELSE '[]'::jsonb
                                   END
                                 ) WITH ORDINALITY AS capability(value, ordinality)
                                WHERE jsonb_typeof(capability.value) = 'string'
                             ), '[]'::jsonb),
                             'email', h.email,
                             'timeZone', h.tz,
                             'agentModel', a.model,
                             'ownerHumanId', a.owner_human_id,
                             'maxConcurrentRuns', a.max_concurrent_runs,
                             'maxRunSteps', a.max_run_steps,
                             'createdAtMs', floor(extract(epoch from m.created_at) * 1000)::bigint,
                             'updatedAtMs', floor(extract(epoch from m.updated_at) * 1000)::bigint
                           ) AS row_json
                      FROM member m
                      LEFT JOIN human h ON h.member_id = m.id
                      LEFT JOIN agent a ON a.member_id = m.id
                      LEFT JOIN LATERAL (
                        SELECT role::text
                          FROM membership ms
                         WHERE ms.member_id = m.id
                           AND ms.left_at IS NULL
                         ORDER BY CASE role::text
                                    WHEN 'owner' THEN 0
                                    WHEN 'admin' THEN 1
                                    WHEN 'member' THEN 2
                                    ELSE 3
                                  END
                         LIMIT 1
                      ) r ON true
                      LEFT JOIN LATERAL (
                        SELECT count(*)::int AS channel_count
                          FROM membership ms
                         WHERE ms.member_id = m.id
                           AND ms.left_at IS NULL
                      ) cc ON true
                      LEFT JOIN LATERAL (
                        SELECT COALESCE(array_agg(ms.channel_id ORDER BY ms.joined_at, ms.channel_id), ARRAY[]::uuid[]) AS channel_ids
                          FROM membership ms
                         WHERE ms.member_id = m.id
                           AND ms.left_at IS NULL
                      ) ch ON true
                     WHERE m.deleted_at IS NULL
                       AND m.status = 'active'
                       AND m.kind = \(kindFilter)::member_kind
                       AND EXISTS (
                         SELECT 1
                           FROM membership active_ms
                          WHERE active_ms.member_id = m.id
                            AND active_ms.left_at IS NULL
                       )
                     LIMIT \(limit)
                  ) rows
                """,
                logger: logger
            ).collect()
        } else {
            rows = try await conn.query(
                """
                SELECT COALESCE(json_agg(row_json ORDER BY row_json->>'kind', row_json->>'handle')::text, '[]') AS payload
                  FROM (
                    SELECT json_build_object(
                             'id', m.id,
                             'workspaceId', m.workspace_id,
                             'kind', m.kind::text,
                             'status', m.status::text,
                             'displayName', m.display_name,
                             'handle', m.handle,
                             'avatarUrl', m.avatar_url,
                             'role', r.role,
                             'channelCount', COALESCE(cc.channel_count, 0),
                             'channelIds', COALESCE(ch.channel_ids, ARRAY[]::uuid[]),
                             'capabilities', COALESCE((
                               SELECT jsonb_agg(
                                        capability.value #>> '{}'
                                        ORDER BY capability.ordinality
                                      )
                                 FROM jsonb_array_elements(
                                   CASE
                                     WHEN jsonb_typeof(a.config->'capabilities') = 'array'
                                       THEN a.config->'capabilities'
                                     ELSE '[]'::jsonb
                                   END
                                 ) WITH ORDINALITY AS capability(value, ordinality)
                                WHERE jsonb_typeof(capability.value) = 'string'
                             ), '[]'::jsonb),
                             'email', h.email,
                             'timeZone', h.tz,
                             'agentModel', a.model,
                             'ownerHumanId', a.owner_human_id,
                             'maxConcurrentRuns', a.max_concurrent_runs,
                             'maxRunSteps', a.max_run_steps,
                             'createdAtMs', floor(extract(epoch from m.created_at) * 1000)::bigint,
                             'updatedAtMs', floor(extract(epoch from m.updated_at) * 1000)::bigint
                           ) AS row_json
                      FROM member m
                      LEFT JOIN human h ON h.member_id = m.id
                      LEFT JOIN agent a ON a.member_id = m.id
                      LEFT JOIN LATERAL (
                        SELECT role::text
                          FROM membership ms
                         WHERE ms.member_id = m.id
                           AND ms.left_at IS NULL
                         ORDER BY CASE role::text
                                    WHEN 'owner' THEN 0
                                    WHEN 'admin' THEN 1
                                    WHEN 'member' THEN 2
                                    ELSE 3
                                  END
                         LIMIT 1
                      ) r ON true
                      LEFT JOIN LATERAL (
                        SELECT count(*)::int AS channel_count
                          FROM membership ms
                         WHERE ms.member_id = m.id
                           AND ms.left_at IS NULL
                      ) cc ON true
                      LEFT JOIN LATERAL (
                        SELECT COALESCE(array_agg(ms.channel_id ORDER BY ms.joined_at, ms.channel_id), ARRAY[]::uuid[]) AS channel_ids
                          FROM membership ms
                         WHERE ms.member_id = m.id
                           AND ms.left_at IS NULL
                      ) ch ON true
                     WHERE m.deleted_at IS NULL
                       AND m.status = 'active'
                       AND EXISTS (
                         SELECT 1
                           FROM membership active_ms
                          WHERE active_ms.member_id = m.id
                            AND active_ms.left_at IS NULL
                       )
                     LIMIT \(limit)
                  ) rows
                """,
                logger: logger
            ).collect()
        }
        return try decodeRosterList(from: rows.first)
    }

    private static func decodeRosterList(from row: PostgresRow?) throws -> [RosterMemberDTO] {
        guard let row else { return [] }
        let json = try row.decode(String.self)
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "roster JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode([RosterMemberDTO].self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "roster JSON decoding failed")
        }
    }
}
