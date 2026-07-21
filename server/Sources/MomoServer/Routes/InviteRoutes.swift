import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Invite-code endpoints for the M2 onboarding slice.
///
///   POST /v1/workspaces/{ws}/invites                  owner/admin create
///   GET  /v1/workspaces/{ws}/invites                  owner/admin list
///   POST /v1/workspaces/{ws}/invites/{invite}/revoke  owner/admin revoke
///   POST /v1/workspaces/{ws}/invites/{invite}/regenerate owner/admin atomic replace
///   POST /v1/workspaces/{ws}/invites/redeem           member redeem for self
///
/// Every handler verifies the path workspace matches the JWT workspace, then
/// uses `Database.withTenantTransaction` so FORCE RLS remains scoped by
/// `SET LOCAL app.workspace_id`.
struct InviteRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/invites", use: create)
        group.get("/v1/workspaces/:ws/invites", use: list)
        group.post("/v1/workspaces/:ws/invites/redeem", use: redeem)
        group.post("/v1/workspaces/:ws/invites/:invite/revoke", use: revoke)
        group.post("/v1/workspaces/:ws/invites/:invite/regenerate", use: regenerate)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: CreateInviteRequest.self, context: context)
        let role = try Self.normalizedRole(dto.role)
        let maxUses = try Self.validatedMaxUses(dto.maxUses)
        let expiresAtMs = try Self.validatedExpiresAtMs(dto.expiresAtMs)
        let metadataJSON = Self.encodeMetadata(dto.metadata)

        let created: CreateInviteResponse = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireWorkspaceAdmin(conn: conn, logger: db.logger, principal: principal)

            let rows = try await conn.query(
                """
                WITH generated AS (
                  SELECT momo_generate_invite_code() AS raw_code
                ),
                inserted AS (
                  INSERT INTO invite_code
                    (workspace_id, code_hash, code_preview, role, max_uses,
                     expires_at, created_by, metadata)
                  SELECT \(workspaceID),
                         momo_invite_code_hash(raw_code),
                         right(raw_code, 6),
                         \(role)::membership_role,
                         \(maxUses),
                         COALESCE(
                           to_timestamp(\(expiresAtMs) / 1000.0),
                           now() + interval '7 days'
                         ),
                         \(principal.memberID),
                         \(metadataJSON)::jsonb
                    FROM generated
                  RETURNING *
                )
                SELECT jsonb_build_object(
                         'id', i.id,
                         'workspaceId', i.workspace_id,
                         'codePreview', i.code_preview,
                         'role', i.role::text,
                         'maxUses', i.max_uses,
                         'usedCount', i.used_count,
                         'expiresAtMs', floor(extract(epoch from i.expires_at) * 1000)::bigint,
                         'revokedAtMs',
                           CASE WHEN i.revoked_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from i.revoked_at) * 1000)::bigint
                           END,
                         'revokedBy', i.revoked_by,
                         'revocationReason', i.revocation_reason,
                         'createdBy', i.created_by,
                         'createdAtMs', floor(extract(epoch from i.created_at) * 1000)::bigint,
                         'updatedAtMs', floor(extract(epoch from i.updated_at) * 1000)::bigint
                       )::text AS invite_json,
                       g.raw_code
                  FROM inserted i
                  CROSS JOIN generated g
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "invite code creation failed")
            }
            let (inviteJSON, rawCode) = try row.decode((String, String).self)
            let invite = try Self.decodeInvite(inviteJSON)
            try await Self.insertInviteAudit(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                actorMemberID: principal.memberID,
                action: "invite.created",
                targetID: try Self.uuid(invite.id, label: "created invite"),
                detailJSON: Self.encodeAuditDetail(["role": role, "max_uses": maxUses])
            )
            return CreateInviteResponse(
                invite: invite,
                code: rawCode
            )
        }

        var response = try created.response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let q = request.uri.queryParameters
        let includeRevoked = q["include_revoked"] == "true" || q["includeRevoked"] == "true"
        let limit = min(max(q["limit"].flatMap { Int($0) } ?? 50, 1), 200)

        let invites: [InviteCodeDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireWorkspaceAdmin(conn: conn, logger: db.logger, principal: principal)
            let rows = try await conn.query(
                """
                SELECT jsonb_build_object(
                         'id', i.id,
                         'workspaceId', i.workspace_id,
                         'codePreview', i.code_preview,
                         'role', i.role::text,
                         'maxUses', i.max_uses,
                         'usedCount', i.used_count,
                         'expiresAtMs', floor(extract(epoch from i.expires_at) * 1000)::bigint,
                         'revokedAtMs',
                           CASE WHEN i.revoked_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from i.revoked_at) * 1000)::bigint
                           END,
                         'revokedBy', i.revoked_by,
                         'revocationReason', i.revocation_reason,
                         'createdBy', i.created_by,
                         'createdAtMs', floor(extract(epoch from i.created_at) * 1000)::bigint,
                         'updatedAtMs', floor(extract(epoch from i.updated_at) * 1000)::bigint
                       )::text AS invite_json
                  FROM invite_code i
                 WHERE (\(includeRevoked) OR i.revoked_at IS NULL)
                 ORDER BY i.created_at DESC
                 LIMIT \(limit)
                """,
                logger: db.logger
            ).collect()
            return try rows.map { row in
                try Self.decodeInvite(row.decode(String.self))
            }
        }

        return try InviteListResponse(invites: invites).response(from: request, context: context)
    }

    @Sendable
    func revoke(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let inviteID = try Self.inviteID(context)
        let dto = try await request.decode(as: RevokeInviteRequest.self, context: context)
        let reason = dto.reason?.trimmingCharacters(in: .whitespacesAndNewlines)

        let invite: InviteCodeDTO = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireWorkspaceAdmin(conn: conn, logger: db.logger, principal: principal)
            let rows = try await conn.query(
                """
                WITH matched AS (
                  SELECT id, revoked_at
                    FROM invite_code
                   WHERE id = \(inviteID)
                   FOR UPDATE
                ),
                updated AS (
                  UPDATE invite_code i
                     SET revoked_at = COALESCE(i.revoked_at, now()),
                         revoked_by = COALESCE(i.revoked_by, \(principal.memberID)),
                         revocation_reason = COALESCE(i.revocation_reason, \(reason)),
                         updated_at = now()
                    FROM matched m
                   WHERE i.id = m.id
                  RETURNING i.*, (m.revoked_at IS NULL) AS newly_revoked
                )
                SELECT jsonb_build_object(
                         'id', u.id,
                         'workspaceId', u.workspace_id,
                         'codePreview', u.code_preview,
                         'role', u.role::text,
                         'maxUses', u.max_uses,
                         'usedCount', u.used_count,
                         'expiresAtMs', floor(extract(epoch from u.expires_at) * 1000)::bigint,
                         'revokedAtMs',
                           CASE WHEN u.revoked_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from u.revoked_at) * 1000)::bigint
                           END,
                         'revokedBy', u.revoked_by,
                         'revocationReason', u.revocation_reason,
                         'createdBy', u.created_by,
                         'createdAtMs', floor(extract(epoch from u.created_at) * 1000)::bigint,
                         'updatedAtMs', floor(extract(epoch from u.updated_at) * 1000)::bigint
                       )::text AS invite_json,
                       u.newly_revoked
                  FROM updated u
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "invite code not found")
            }
            let (inviteJSON, newlyRevoked) = try row.decode((String, Bool).self)
            let invite = try Self.decodeInvite(inviteJSON)
            if newlyRevoked {
                try await Self.insertInviteAudit(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    actorMemberID: principal.memberID,
                    action: "invite.revoked",
                    targetID: inviteID,
                    detailJSON: Self.encodeAuditDetail(["reason": reason ?? NSNull()])
                )
            }
            return invite
        }

        return try invite.response(from: request, context: context)
    }

    @Sendable
    func regenerate(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let inviteID = try Self.inviteID(context)

        let created: CreateInviteResponse = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireWorkspaceAdmin(conn: conn, logger: db.logger, principal: principal)

            let rows = try await conn.query(
                """
                WITH locked AS (
                  SELECT *
                    FROM invite_code
                   WHERE id = \(inviteID)
                     AND revoked_at IS NULL
                   FOR UPDATE
                ),
                revoked AS (
                  UPDATE invite_code i
                     SET revoked_at = now(),
                         revoked_by = \(principal.memberID),
                         revocation_reason = 'regenerated',
                         updated_at = now()
                    FROM locked l
                   WHERE i.id = l.id
                  RETURNING l.*
                ),
                generated AS (
                  SELECT momo_generate_invite_code() AS raw_code
                ),
                inserted AS (
                  INSERT INTO invite_code
                    (workspace_id, code_hash, code_preview, role, max_uses,
                     expires_at, created_by, metadata)
                  SELECT r.workspace_id,
                         momo_invite_code_hash(g.raw_code),
                         right(g.raw_code, 6),
                         r.role,
                         r.max_uses,
                         now() + interval '7 days',
                         \(principal.memberID),
                         r.metadata
                    FROM revoked r
                    CROSS JOIN generated g
                  RETURNING *
                )
                SELECT jsonb_build_object(
                         'id', i.id,
                         'workspaceId', i.workspace_id,
                         'codePreview', i.code_preview,
                         'role', i.role::text,
                         'maxUses', i.max_uses,
                         'usedCount', i.used_count,
                         'expiresAtMs', floor(extract(epoch from i.expires_at) * 1000)::bigint,
                         'revokedAtMs', NULL,
                         'revokedBy', NULL,
                         'revocationReason', NULL,
                         'createdBy', i.created_by,
                         'createdAtMs', floor(extract(epoch from i.created_at) * 1000)::bigint,
                         'updatedAtMs', floor(extract(epoch from i.updated_at) * 1000)::bigint
                       )::text AS invite_json,
                       g.raw_code
                  FROM inserted i
                  CROSS JOIN generated g
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.conflict, message: "invite code not found or already revoked")
            }
            let (inviteJSON, rawCode) = try row.decode((String, String).self)
            let invite = try Self.decodeInvite(inviteJSON)
            let newInviteID = try Self.uuid(invite.id, label: "regenerated invite")
            try await Self.insertInviteAudit(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                actorMemberID: principal.memberID,
                action: "invite.regenerated",
                targetID: inviteID,
                detailJSON: Self.encodeAuditDetail([
                    "new_invite_id": newInviteID.uuidString,
                    "role": invite.role,
                    "max_uses": invite.maxUses,
                ])
            )
            return CreateInviteResponse(invite: invite, code: rawCode)
        }

        var response = try created.response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func redeem(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: RedeemInviteRequest.self, context: context)
        let code = try Self.normalizedCode(dto.code)
        let email = dto.email?.trimmingCharacters(in: .whitespacesAndNewlines)

        let redeemed: RedeemInviteResponse = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireWorkspaceMember(conn: conn, logger: db.logger, principal: principal)
            let identityRows = try await conn.query(
                """
                SELECT h.email, m.handle
                  FROM member m
                  LEFT JOIN human h
                    ON h.workspace_id = m.workspace_id AND h.member_id = m.id
                 WHERE m.workspace_id = \(workspaceID) AND m.id = \(principal.memberID)
                """,
                logger: db.logger
            ).collect()
            guard let identityRow = identityRows.first else {
                throw HTTPError(.forbidden, message: "not a workspace member")
            }
            let (storedEmail, handle) = try identityRow.decode((String?, String).self)
            try await JoinRoutes.requireNotBanned(
                conn: conn, logger: db.logger,
                email: storedEmail ?? email, handle: handle
            )
            let rows = try await conn.query(
                """
                WITH matched AS (
                  SELECT i.id
                    FROM invite_code i
                   WHERE i.code_hash = momo_invite_code_hash(\(code))
                     AND i.revoked_at IS NULL
                     AND i.expires_at > now()
                     AND i.used_count < i.max_uses
                     AND NOT EXISTS (
                       SELECT 1
                         FROM invite_code_redemption r
                        WHERE r.invite_code_id = i.id
                          AND r.member_id = \(principal.memberID)
                     )
                   FOR UPDATE
                ),
                updated AS (
                  UPDATE invite_code i
                     SET used_count = i.used_count + 1,
                         last_used_at = now(),
                         updated_at = now()
                    FROM matched m
                   WHERE i.id = m.id
                  RETURNING i.*
                ),
                redemption AS (
                  INSERT INTO invite_code_redemption
                    (workspace_id, invite_code_id, member_id, email)
                  SELECT \(workspaceID), u.id, \(principal.memberID), \(email)
                    FROM updated u
                  RETURNING id
                )
                SELECT jsonb_build_object(
                         'id', u.id,
                         'workspaceId', u.workspace_id,
                         'codePreview', u.code_preview,
                         'role', u.role::text,
                         'maxUses', u.max_uses,
                         'usedCount', u.used_count,
                         'expiresAtMs', floor(extract(epoch from u.expires_at) * 1000)::bigint,
                         'revokedAtMs',
                           CASE WHEN u.revoked_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from u.revoked_at) * 1000)::bigint
                           END,
                         'revokedBy', u.revoked_by,
                         'revocationReason', u.revocation_reason,
                         'createdBy', u.created_by,
                         'createdAtMs', floor(extract(epoch from u.created_at) * 1000)::bigint,
                         'updatedAtMs', floor(extract(epoch from u.updated_at) * 1000)::bigint
                       )::text AS invite_json,
                       r.id
                  FROM updated u
                  JOIN redemption r ON true
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(
                    .badRequest,
                    message: "invite code is invalid, expired, exhausted, revoked, or already redeemed"
                )
            }
            let (inviteJSON, redemptionID) = try row.decode((String, UUID).self)
            return try RedeemInviteResponse(
                invite: Self.decodeInvite(inviteJSON),
                redemptionId: redemptionID.uuidString
            )
        }

        return try redeemed.response(from: request, context: context)
    }

    // MARK: - Guard helpers

    static func workspaceID(
        _ context: AppRequestContext,
        principal: AuthPrincipal
    ) throws -> UUID {
        let wsParam = try context.parameters.require("ws")
        guard let ws = UUID(uuidString: wsParam) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        guard ws == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return ws
    }

    static func inviteID(_ context: AppRequestContext) throws -> UUID {
        let inviteParam = try context.parameters.require("invite")
        guard let invite = UUID(uuidString: inviteParam) else {
            throw HTTPError(.badRequest, message: "invalid invite id")
        }
        return invite
    }

    static func normalizedRole(_ role: String?) throws -> String {
        let value = (role ?? "member")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard ["admin", "member", "guest"].contains(value) else {
            throw HTTPError(.badRequest, message: "invite role must be admin, member, or guest")
        }
        return value
    }

    static func validatedMaxUses(_ maxUses: Int?) throws -> Int {
        let value = maxUses ?? 1
        guard (1...10_000).contains(value) else {
            throw HTTPError(.badRequest, message: "maxUses must be between 1 and 10000")
        }
        return value
    }

    static func validatedExpiresAtMs(_ expiresAtMs: Int64?) throws -> Int64? {
        guard let expiresAtMs else { return nil }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        guard expiresAtMs > nowMs else {
            throw HTTPError(.badRequest, message: "expiresAtMs must be in the future")
        }
        return expiresAtMs
    }

    static func normalizedCode(_ code: String) throws -> String {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 256 else {
            throw HTTPError(.badRequest, message: "invite code is invalid")
        }
        return value
    }

    static func requireWorkspaceAdmin(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws {
        _ = try await WorkspaceAuthorization.requireAdmin(
            conn: conn, logger: logger, principal: principal
        )
    }

    static func requireWorkspaceMember(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws {
        _ = try await WorkspaceAuthorization.requireMember(
            conn: conn, logger: logger, principal: principal
        )
    }

    // MARK: - JSON mapping

    static func decodeInvite(_ json: String) throws -> InviteCodeDTO {
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "invite JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode(InviteCodeDTO.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "invite JSON decoding failed")
        }
    }

    static func encodeMetadata(_ metadata: [String: String]?) -> String {
        guard let metadata, !metadata.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: metadata),
              let str = String(data: data, encoding: .utf8)
        else { return "{}" }
        return str
    }

    static func uuid(_ raw: String, label: String) throws -> UUID {
        guard let value = UUID(uuidString: raw) else {
            throw HTTPError(.internalServerError, message: "\(label) id is invalid")
        }
        return value
    }

    static func encodeAuditDetail(_ detail: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let value = String(data: data, encoding: .utf8)
        else { return "{}" }
        return value
    }

    static func insertInviteAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        action: String,
        targetID: UUID,
        detailJSON: String
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id, detail)
            VALUES (
              \(workspaceID),
              \(actorMemberID),
              \(action),
              'invite_code',
              \(targetID),
              \(detailJSON)::jsonb
            )
            """,
            logger: logger
        )
    }
}
