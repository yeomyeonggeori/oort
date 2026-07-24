import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Tenant-scoped workspace identity endpoints.
///
/// Read access requires active workspace membership. Name changes require an
/// owner/admin role and are recorded in the workspace audit ledger.
///
/// Creation (POST /v1/workspaces, MOMO-589 / ADR-0117 §D1-A) is the in-app
/// surface for the migrate-image `workspace-create` command. It is gated on the
/// **instance operator** authority (MOMO-583 model, reused verbatim from
/// `ProviderLinkRoutes.isProviderLinkOperatorAuthorized`): a human carrying the
/// `platform:read` cross-tenant scope, or a workspace owner/admin whose verified
/// email is listed in `PLATFORM_ADMIN_EMAILS`. Provisioning a workspace mints a
/// tenant on the shared instance, so an ordinary workspace owner must not be able
/// to do it — same trust boundary as the instance-global provider link.
struct WorkspaceRoutes: Sendable {
    let db: Database
    /// MOMO-583: lowercased instance-operator allowlist (PLATFORM_ADMIN_EMAILS).
    let platformAdminEmails: [String]

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
        group.post("/v1/workspaces", use: create)
        group.get("/v1/workspaces/:ws", use: get)
        group.patch("/v1/workspaces/:ws", use: update)
    }

    // MARK: - POST /v1/workspaces (create)

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        // Instance-operator authority is human-only; agent/work-host tokens can
        // never mint a tenant (mirrors ProviderLinkRoutes.requireOperator).
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human operator required")
        }

        let dto = try await request.decode(as: CreateWorkspaceRequest.self, context: context)
        let slug = try Self.normalizedSlug(dto.slug)
        let name = try Self.normalizedName(dto.name)

        // One transaction provisions the whole tenant. It opens under the acting
        // operator's home workspace so the authorization read and the credential
        // snapshot pass RLS, then re-binds `app.workspace_id` to the NEW workspace
        // for every seed INSERT (ADR-0117 §D1-A: 신규 WS GUC 경유). The owner's
        // password_hash is copied entirely inside SQL (temp table) — it never
        // transits the app, matching the codebase's momo_password_* discipline.
        let created: CreateWorkspaceResponse = try await db.withTenantTransaction(
            workspaceID: principal.workspaceID
        ) { conn in
            // 1) Authorization data + active-human guard (home RLS scope).
            let authRows = try await conn.query(
                """
                SELECT wm.role::text, h.email, h.email_verified
                  FROM member m
                  JOIN human h
                    ON h.member_id = m.id
                   AND h.workspace_id = m.workspace_id
                  LEFT JOIN workspace_membership wm
                    ON wm.workspace_id = m.workspace_id
                   AND wm.member_id = m.id
                 WHERE m.id = \(principal.memberID)
                   AND m.workspace_id = \(principal.workspaceID)
                   AND m.kind = 'human'
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard let authRow = authRows.first else {
                throw HTTPError(.forbidden, message: "operator account not found")
            }
            let (roleRaw, email, emailVerified) =
                try authRow.decode((String?, String, Bool).self)
            let role = roleRaw.flatMap { WorkspaceRole(rawValue: $0) }

            guard ProviderLinkRoutes.isProviderLinkOperatorAuthorized(
                kind: principal.kind,
                scopes: principal.scopes,
                workspaceRole: role,
                verifiedEmail: emailVerified ? email : nil,
                platformAdminEmails: platformAdminEmails
            ) else {
                throw HTTPError(
                    .forbidden,
                    message: "platform:read scope or listed instance operator required"
                )
            }

            // 2) Pre-generate the tenant identifiers (uuidv7 for time-ordering,
            //    matching create_workspace.sql). The workspace id must exist before
            //    the GUC re-bind because the workspace RLS policy is id-based.
            let idRows = try await conn.query(
                "SELECT uuidv7(), uuidv7(), uuidv7()", logger: db.logger
            ).collect()
            guard let idRow = idRows.first else {
                throw HTTPError(.internalServerError, message: "id generation failed")
            }
            let (newWorkspaceID, ownerID, channelID) =
                try idRow.decode((UUID, UUID, UUID).self)

            // 3) Snapshot the operator's member/human identity for replication.
            //    ON COMMIT DROP so the copied password_hash lives only inside this
            //    transaction and is never exposed outside SQL (ADR-0117 §D5-A).
            _ = try await conn.query(
                """
                CREATE TEMP TABLE momo_ws_seed ON COMMIT DROP AS
                SELECT m.display_name, m.handle,
                       h.email, h.email_verified, h.password_hash
                  FROM member m
                  JOIN human h
                    ON h.member_id = m.id
                   AND h.workspace_id = m.workspace_id
                 WHERE m.id = \(principal.memberID)
                   AND m.workspace_id = \(principal.workspaceID)
                   AND m.kind = 'human'
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                """,
                logger: db.logger
            )

            // 4) Re-bind the RLS scope to the new tenant for every seed INSERT.
            _ = try await conn.query(
                "SELECT set_config('app.workspace_id', \(newWorkspaceID.uuidString), true)",
                logger: db.logger
            )

            // 5) Workspace row. slug re-use policy: EXPLICIT REFUSAL (409). The
            //    workspace_slug_uniq constraint is the authoritative, race-free
            //    detector — a cross-tenant SELECT would see nothing under RLS.
            do {
                _ = try await conn.query(
                    """
                    INSERT INTO workspace (id, slug, name)
                    VALUES (\(newWorkspaceID), \(slug), \(name))
                    """,
                    logger: db.logger
                )
            } catch let error as PSQLError where error.serverInfo?[.sqlState] == "23505" {
                throw HTTPError(.conflict, message: "workspace slug already exists")
            }

            // 6) Owner member + human profile (D5-A: same email + password hash).
            _ = try await conn.query(
                """
                INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
                SELECT \(ownerID), \(newWorkspaceID), 'human', 'active',
                       s.display_name, s.handle
                  FROM momo_ws_seed s
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO human
                  (member_id, workspace_id, email, email_verified, password_hash)
                SELECT \(ownerID), \(newWorkspaceID), s.email, s.email_verified,
                       s.password_hash
                  FROM momo_ws_seed s
                """,
                logger: db.logger
            )

            // 7) Workspace-level owner role (ADR-0128).
            _ = try await conn.query(
                """
                INSERT INTO workspace_membership (workspace_id, member_id, role)
                VALUES (\(newWorkspaceID), \(ownerID), 'owner')
                """,
                logger: db.logger
            )

            // 8) Default #general channel + gapless seq counter + owner membership.
            _ = try await conn.query(
                """
                INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
                VALUES (\(channelID), \(newWorkspaceID), 'public', 'general',
                        'Team general channel', \(ownerID))
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
                VALUES (\(channelID), \(newWorkspaceID), 0)
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO membership (workspace_id, channel_id, member_id, role)
                VALUES (\(newWorkspaceID), \(channelID), \(ownerID), 'owner')
                """,
                logger: db.logger
            )

            // 9) Audit trail. Attributed to the new owner; the creating operator's
            //    identity is recorded in detail (via_token_id is left NULL because
            //    the authorizing token belongs to a different workspace).
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type, target_id, detail)
                VALUES (
                  \(newWorkspaceID), \(ownerID), 'workspace.created', 'workspace',
                  \(newWorkspaceID),
                  jsonb_build_object(
                    'schema', 'momo.workspace.created.v1',
                    'slug', \(slug)::text,
                    'default_channel', 'general',
                    'source', 'momo-rest',
                    'created_by_workspace_id', \(principal.workspaceID.uuidString)::text,
                    'created_by_member_id', \(principal.memberID.uuidString)::text
                  )
                )
                """,
                logger: db.logger
            )

            return CreateWorkspaceResponse(
                schema: "momo.workspace.created.v1",
                workspaceId: newWorkspaceID.uuidString,
                slug: slug,
                name: name
            )
        }

        var response = try created.response(from: request, context: context)
        response.status = .created
        return response
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

    /// Slug rule matches `infra/prod/create_workspace.sql`: 1..63 chars of
    /// lowercase letters, digits, or hyphens, with no leading/trailing hyphen.
    /// The value is lowercased and trimmed before validation so the REST surface
    /// and the migrate-image command accept identical inputs.
    static func normalizedSlug(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.wholeMatch(of: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/) != nil else {
            throw HTTPError(
                .badRequest,
                message: "workspace slug must be 1-63 chars of lowercase letters, "
                    + "digits, or hyphens (no leading or trailing hyphen)"
            )
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
                              FROM workspace_membership AS wm
                              JOIN member AS m
                                ON m.id = wm.member_id
                               AND m.workspace_id = wm.workspace_id
                             WHERE wm.workspace_id = w.id
                               AND wm.member_id = \(memberID)
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
        try await WorkspaceAuthorization.activeRole(
            conn: conn, logger: logger, workspaceID: workspaceID,
            memberID: memberID, forUpdate: lockAuthorization
        )?.rawValue
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
