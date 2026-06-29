import Foundation
import Hummingbird
import PostgresNIO

/// Read-only cross-tenant inspection endpoints for internal platform operators.
///
/// The guard is token-scope based (`platform:read`) and the DB path uses a
/// separate BYPASSRLS role in a read-only transaction. Normal tenant routes must
/// keep using `Database.withTenantTransaction` / `withTenantConnection`.
struct PlatformAdminRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/platform/workspaces", use: workspaces)
        group.get("/v1/platform/members", use: members)
        group.get("/v1/platform/invites", use: invites)
    }

    @Sendable
    func workspaces(_ request: Request, context: AppRequestContext) async throws -> Response {
        try Self.requirePlatformRead(context)
        let items: [PlatformWorkspaceDTO] = try await db.withPlatformReadConnection { conn in
            let rows = try await conn.query(
                """
                SELECT COALESCE(json_agg(row_json ORDER BY row_json->>'slug')::text, '[]') AS payload
                  FROM (
                    SELECT json_build_object(
                             'id', w.id,
                             'slug', w.slug,
                             'name', w.name,
                             'createdAtMs', (extract(epoch FROM w.created_at) * 1000)::bigint,
                             'updatedAtMs', (extract(epoch FROM w.updated_at) * 1000)::bigint,
                             'memberCount', COALESCE(ms.member_count, 0),
                             'humanCount', COALESCE(ms.human_count, 0),
                             'agentCount', COALESCE(ms.agent_count, 0),
                             'activeMemberCount', COALESCE(ms.active_member_count, 0),
                             'inviteCodeCount', COALESCE(inv.invite_code_count, 0),
                             'activeInviteCodeCount', COALESCE(inv.active_invite_code_count, 0),
                             'inviteRedemptionCount', COALESCE(inv.invite_redemption_count, 0),
                             'lastInviteUsedAtMs',
                               CASE WHEN inv.last_invite_used_at IS NULL THEN NULL
                                    ELSE (extract(epoch FROM inv.last_invite_used_at) * 1000)::bigint
                               END
                           ) AS row_json
                      FROM workspace w
                      LEFT JOIN LATERAL (
                        SELECT count(*)::int AS member_count,
                               count(*) FILTER (WHERE kind = 'human')::int AS human_count,
                               count(*) FILTER (WHERE kind = 'agent')::int AS agent_count,
                               count(*) FILTER (WHERE status = 'active' AND deleted_at IS NULL)::int
                                 AS active_member_count
                          FROM member m
                         WHERE m.workspace_id = w.id
                      ) ms ON true
                      LEFT JOIN LATERAL (
                        SELECT count(i.id)::int AS invite_code_count,
                               count(i.id) FILTER (
                                 WHERE i.revoked_at IS NULL
                                   AND i.expires_at > now()
                                   AND i.used_count < i.max_uses
                               )::int AS active_invite_code_count,
                               count(r.id)::int AS invite_redemption_count,
                               max(i.last_used_at) AS last_invite_used_at
                          FROM invite_code i
                          LEFT JOIN invite_code_redemption r ON r.invite_code_id = i.id
                         WHERE i.workspace_id = w.id
                      ) inv ON true
                  ) rows
                """,
                logger: db.logger
            ).collect()
            return try Self.decodeJSONList(from: rows.first)
        }
        return try PlatformWorkspaceListResponse(workspaces: items)
            .response(from: request, context: context)
    }

    @Sendable
    func members(_ request: Request, context: AppRequestContext) async throws -> Response {
        try Self.requirePlatformRead(context)
        let items: [PlatformMemberDTO] = try await db.withPlatformReadConnection { conn in
            let rows = try await conn.query(
                """
                SELECT COALESCE(json_agg(row_json ORDER BY row_json->>'workspaceSlug', row_json->>'handle')::text, '[]') AS payload
                  FROM (
                    SELECT json_build_object(
                             'id', m.id,
                             'workspaceId', m.workspace_id,
                             'workspaceSlug', w.slug,
                             'kind', m.kind::text,
                             'status', m.status::text,
                             'displayName', m.display_name,
                             'handle', m.handle,
                             'email', h.email,
                             'agentModel', a.model,
                             'membershipCount', COALESCE(ms.membership_count, 0),
                             'inviteRedemptionCount', COALESCE(rs.invite_redemption_count, 0),
                             'createdAtMs', (extract(epoch FROM m.created_at) * 1000)::bigint,
                             'updatedAtMs', (extract(epoch FROM m.updated_at) * 1000)::bigint
                           ) AS row_json
                      FROM member m
                      JOIN workspace w ON w.id = m.workspace_id
                      LEFT JOIN human h ON h.member_id = m.id
                      LEFT JOIN agent a ON a.member_id = m.id
                      LEFT JOIN LATERAL (
                        SELECT count(*)::int AS membership_count
                          FROM membership ms
                         WHERE ms.member_id = m.id
                           AND ms.left_at IS NULL
                      ) ms ON true
                      LEFT JOIN LATERAL (
                        SELECT count(*)::int AS invite_redemption_count
                          FROM invite_code_redemption r
                         WHERE r.member_id = m.id
                      ) rs ON true
                  ) rows
                """,
                logger: db.logger
            ).collect()
            return try Self.decodeJSONList(from: rows.first)
        }
        return try PlatformMemberListResponse(members: items)
            .response(from: request, context: context)
    }

    @Sendable
    func invites(_ request: Request, context: AppRequestContext) async throws -> Response {
        try Self.requirePlatformRead(context)
        let items: [PlatformInviteDTO] = try await db.withPlatformReadConnection { conn in
            let rows = try await conn.query(
                """
                SELECT COALESCE(json_agg(row_json ORDER BY row_json->>'workspaceSlug', row_json->>'createdAtMs' DESC)::text, '[]') AS payload
                  FROM (
                    SELECT json_build_object(
                             'id', i.id,
                             'workspaceId', i.workspace_id,
                             'workspaceSlug', w.slug,
                             'codePreview', i.code_preview,
                             'role', i.role::text,
                             'maxUses', i.max_uses,
                             'usedCount', i.used_count,
                             'redemptionCount', COALESCE(rs.redemption_count, 0),
                             'expiresAtMs', (extract(epoch FROM i.expires_at) * 1000)::bigint,
                             'revokedAtMs',
                               CASE WHEN i.revoked_at IS NULL THEN NULL
                                    ELSE (extract(epoch FROM i.revoked_at) * 1000)::bigint
                               END,
                             'revokedBy', i.revoked_by,
                             'createdBy', i.created_by,
                             'lastUsedAtMs',
                               CASE WHEN i.last_used_at IS NULL THEN NULL
                                    ELSE (extract(epoch FROM i.last_used_at) * 1000)::bigint
                               END,
                             'createdAtMs', (extract(epoch FROM i.created_at) * 1000)::bigint,
                             'updatedAtMs', (extract(epoch FROM i.updated_at) * 1000)::bigint
                           ) AS row_json
                      FROM invite_code i
                      JOIN workspace w ON w.id = i.workspace_id
                      LEFT JOIN LATERAL (
                        SELECT count(*)::int AS redemption_count
                          FROM invite_code_redemption r
                         WHERE r.invite_code_id = i.id
                      ) rs ON true
                  ) rows
                """,
                logger: db.logger
            ).collect()
            return try Self.decodeJSONList(from: rows.first)
        }
        return try PlatformInviteListResponse(invites: items)
            .response(from: request, context: context)
    }

    private static func requirePlatformRead(_ context: AppRequestContext) throws {
        let principal = try context.requirePrincipal()
        guard principal.scopes.contains("platform:read") else {
            throw HTTPError(.forbidden, message: "platform:read scope required")
        }
    }

    private static func decodeJSONList<T: Decodable>(from row: PostgresRow?) throws -> [T] {
        guard let row else { return [] }
        let json = try row.decode(String.self)
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "platform JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode([T].self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "platform JSON decoding failed")
        }
    }
}
