import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Tenant-scoped workspace identity endpoints.
///
/// Read access requires active workspace membership. Name changes require an
/// owner/admin role and are recorded in the workspace audit ledger.
struct WorkspaceRoutes: Sendable {
    let db: Database

    private enum ReadResult: Sendable {
        case notMember
        case notFound
        case found(WorkspaceDTO)
    }

    private enum UpdateResult: Sendable {
        case notMember
        case adminRequired
        case notFound
        case conflict
        case updated(WorkspaceDTO)
    }

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws", use: get)
        group.patch("/v1/workspaces/:ws", use: update)
    }

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)

        let result: ReadResult = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            try await Self.readWorkspaceForActiveMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
        }

        let workspace: WorkspaceDTO
        switch result {
        case .notMember:
            throw HTTPError(.forbidden, message: "not a workspace member")
        case .notFound:
            throw HTTPError(.notFound, message: "workspace not found")
        case .found(let value):
            workspace = value
        }
        return try WorkspaceResponse(workspace: workspace)
            .response(from: request, context: context)
    }

    @Sendable
    func update(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: UpdateWorkspaceRequest.self, context: context)
        let name = try Self.normalizedName(dto.name)

        let result: UpdateResult = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            guard let role = try await Self.activeWorkspaceRole(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID,
                lockAuthorization: true
            ) else {
                return .notMember
            }
            guard role == "owner" || role == "admin" else {
                return .adminRequired
            }

            let previousRows = try await conn.query(
                """
                SELECT name,
                       floor(extract(epoch from updated_at) * 1000)::bigint
                  FROM workspace
                 WHERE id = \(workspaceID)
                   AND deleted_at IS NULL
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let previousRow = previousRows.first else { return .notFound }
            let (previousName, previousUpdatedAtMs) = try previousRow.decode(
                (String, Int64).self
            )
            guard previousUpdatedAtMs == dto.expectedUpdatedAtMs else {
                return .conflict
            }

            let rows = try await conn.query(
                """
                UPDATE workspace
                   SET name = \(name),
                       updated_at = greatest(
                         clock_timestamp(),
                         updated_at + interval '1 millisecond'
                       )
                 WHERE id = \(workspaceID)
                   AND deleted_at IS NULL
                RETURNING jsonb_build_object(
                            'id', id,
                            'slug', slug,
                            'name', name,
                            'updatedAtMs', floor(extract(epoch from updated_at) * 1000)::bigint
                          )::text
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return .notFound }
            let workspace = try Self.decodeWorkspace(row.decode(String.self))

            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, detail)
                VALUES (
                  \(workspaceID),
                  \(principal.memberID),
                  'workspace.name.updated',
                  'workspace',
                  \(workspaceID),
                  \(principal.tokenID),
                  jsonb_build_object(
                    'schema', 'momo.workspace.name.updated.v1',
                    'previous_name', \(previousName),
                    'new_name', \(workspace.name),
                    'changed', \(previousName) IS DISTINCT FROM \(workspace.name)
                  )
                )
                """,
                logger: db.logger
            )

            return .updated(workspace)
        }

        let workspace: WorkspaceDTO
        switch result {
        case .notMember:
            throw HTTPError(.forbidden, message: "not a workspace member")
        case .adminRequired:
            throw HTTPError(.forbidden, message: "workspace admin required")
        case .notFound:
            throw HTTPError(.notFound, message: "workspace not found")
        case .conflict:
            throw HTTPError(.conflict, message: "workspace changed; reload and try again")
        case .updated(let value):
            workspace = value
        }
        return try WorkspaceResponse(workspace: workspace)
            .response(from: request, context: context)
    }

    static func normalizedName(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(value.count) else {
            throw HTTPError(.badRequest, message: "workspace name must be 1-80 characters")
        }
        guard !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw HTTPError(.badRequest, message: "workspace name contains unsupported characters")
        }
        return value
    }

    private static func readWorkspaceForActiveMember(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws -> ReadResult {
        let rows = try await conn.query(
            """
            SELECT jsonb_build_object(
                     'workspaceExists', EXISTS (
                       SELECT 1
                         FROM workspace AS existing
                        WHERE existing.id = \(workspaceID)
                          AND existing.deleted_at IS NULL
                     ),
                     'workspace', (
                       SELECT jsonb_build_object(
                                'id', w.id,
                                'slug', w.slug,
                                'name', w.name,
                                'updatedAtMs', floor(extract(epoch from w.updated_at) * 1000)::bigint
                              )
                         FROM workspace AS w
                        WHERE w.id = \(workspaceID)
                          AND w.deleted_at IS NULL
                          AND EXISTS (
                            SELECT 1
                              FROM membership AS ms
                              JOIN member AS m
                                ON m.id = ms.member_id
                               AND m.workspace_id = ms.workspace_id
                             WHERE ms.workspace_id = w.id
                               AND ms.member_id = \(memberID)
                               AND ms.left_at IS NULL
                               AND m.status = 'active'
                               AND m.deleted_at IS NULL
                          )
                     )
                   )::text
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return .notFound }
        let json = try row.decode(String.self)
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "workspace JSON encoding failed")
        }
        let envelope: WorkspaceReadEnvelope
        do {
            envelope = try JSONDecoder().decode(WorkspaceReadEnvelope.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "workspace JSON decoding failed")
        }
        if let workspace = envelope.workspace { return .found(workspace) }
        return envelope.workspaceExists ? .notMember : .notFound
    }

    private static func activeWorkspaceRole(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID,
        lockAuthorization: Bool
    ) async throws -> String? {
        let rows: [PostgresRow]
        if lockAuthorization {
            rows = try await conn.query(
                """
                SELECT ms.role::text
                  FROM membership AS ms
                  JOIN member AS m
                    ON m.id = ms.member_id
                   AND m.workspace_id = ms.workspace_id
                 WHERE ms.workspace_id = \(workspaceID)
                   AND ms.member_id = \(memberID)
                   AND ms.left_at IS NULL
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                 ORDER BY CASE ms.role::text
                            WHEN 'owner' THEN 0
                            WHEN 'admin' THEN 1
                            WHEN 'member' THEN 2
                            ELSE 3
                          END
                 LIMIT 1
                 FOR UPDATE OF ms, m
                """,
                logger: logger
            ).collect()
        } else {
            rows = try await conn.query(
                """
                SELECT ms.role::text
                  FROM membership AS ms
                  JOIN member AS m
                    ON m.id = ms.member_id
                   AND m.workspace_id = ms.workspace_id
                 WHERE ms.workspace_id = \(workspaceID)
                   AND ms.member_id = \(memberID)
                   AND ms.left_at IS NULL
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                 ORDER BY CASE ms.role::text
                            WHEN 'owner' THEN 0
                            WHEN 'admin' THEN 1
                            WHEN 'member' THEN 2
                            ELSE 3
                          END
                 LIMIT 1
                """,
                logger: logger
            ).collect()
        }
        return try rows.first?.decode(String.self)
    }

    private static func decodeWorkspace(_ json: String) throws -> WorkspaceDTO {
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "workspace JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode(WorkspaceDTO.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "workspace JSON decoding failed")
        }
    }
}

private struct WorkspaceReadEnvelope: Decodable {
    let workspaceExists: Bool
    let workspace: WorkspaceDTO?
}
