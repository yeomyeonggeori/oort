import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// ADR-0128 D2/D3 workspace and channel role changes, suspension, removal,
/// and the durable workspace ban ledger. Every mutation is tenant-scoped and
/// records its audit row in the same transaction.
struct MemberLifecycleRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.patch("/v1/workspaces/:ws/members/:member/role", use: changeWorkspaceRole)
        group.patch("/v1/workspaces/:ws/channels/:ch/members/:member/role", use: changeChannelRole)
        group.post("/v1/workspaces/:ws/members/:member/suspend", use: suspend)
        group.post("/v1/workspaces/:ws/members/:member/reinstate", use: reinstate)
        group.delete("/v1/workspaces/:ws/members/:member", use: remove)
        group.post("/v1/workspaces/:ws/bans", use: createBan)
        group.get("/v1/workspaces/:ws/bans", use: listBans)
        group.delete("/v1/workspaces/:ws/bans/:ban", use: deleteBan)
    }

    @Sendable
    func changeWorkspaceRole(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID, targetID) = try Self.scope(context)
        let requested = try WorkspaceRole.parse(
            try await request.decode(as: ChangeMembershipRoleRequest.self, context: context).role
        )
        let response: MembershipRoleResponse = try await transaction(workspaceID) { conn in
            let actorRole = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let target = try await Self.target(
                conn: conn, logger: db.logger, workspaceID: workspaceID, memberID: targetID
            )
            if target.role == .owner, requested != .owner {
                try await Self.requireAnotherOwner(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, excluding: targetID
                )
            }
            try Self.requireCanManage(
                actorID: principal.memberID, actorRole: actorRole,
                targetID: targetID, targetRole: target.role, requestedRole: requested
            )
            _ = try await conn.query(
                """
                UPDATE workspace_membership
                   SET role = \(requested.rawValue)::membership_role, updated_at = now()
                 WHERE workspace_id = \(workspaceID) AND member_id = \(targetID)
                """,
                logger: db.logger
            )
            try await Self.audit(
                conn: conn, logger: db.logger, workspaceID: workspaceID, principal: principal,
                subjectID: targetID, action: "role.changed", targetType: "workspace_membership",
                targetID: target.membershipID,
                detail: ["scope": "workspace", "old": target.role.rawValue, "new": requested.rawValue]
            )
            return MembershipRoleResponse(
                memberId: targetID.uuidString, scope: "workspace", role: requested.rawValue
            )
        }
        return try response.response(from: request, context: context)
    }

    @Sendable
    func changeChannelRole(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID, targetID) = try Self.scope(context)
        let channelID = try ChannelRoutes.channelID(context)
        let requested = try WorkspaceRole.parse(
            try await request.decode(as: ChangeMembershipRoleRequest.self, context: context).role
        )
        let response: MembershipRoleResponse = try await transaction(workspaceID) { conn in
            let workspaceRole = try await WorkspaceAuthorization.requireMember(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let rows = try await conn.query(
                """
                SELECT target.id, target.role::text, actor.role::text
                  FROM membership target
                  JOIN channel c
                    ON c.id = target.channel_id AND c.workspace_id = target.workspace_id
                  LEFT JOIN membership actor
                    ON actor.channel_id = target.channel_id
                   AND actor.member_id = \(principal.memberID)
                   AND actor.left_at IS NULL
                 WHERE target.workspace_id = \(workspaceID)
                   AND target.channel_id = \(channelID)
                   AND target.member_id = \(targetID)
                   AND target.left_at IS NULL
                   AND c.archived_at IS NULL
                 FOR UPDATE OF target
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "active channel membership not found")
            }
            let (membershipID, targetRaw, channelActorRaw) =
                try row.decode((UUID, String, String?).self)
            guard let targetRole = WorkspaceRole(rawValue: targetRaw) else {
                throw HTTPError(.internalServerError, message: "invalid stored channel role")
            }
            let actorRole: WorkspaceRole
            if workspaceRole.isAdmin {
                actorRole = workspaceRole
            } else if let channelActorRaw,
                      let channelRole = WorkspaceRole(rawValue: channelActorRaw),
                      channelRole.isAdmin {
                actorRole = channelRole
            } else {
                throw HTTPError(.forbidden, message: "channel admin required")
            }
            try Self.requireCanManage(
                actorID: principal.memberID, actorRole: actorRole,
                targetID: targetID, targetRole: targetRole, requestedRole: requested
            )
            _ = try await conn.query(
                "UPDATE membership SET role = \(requested.rawValue)::membership_role WHERE id = \(membershipID)",
                logger: db.logger
            )
            try await Self.audit(
                conn: conn, logger: db.logger, workspaceID: workspaceID, principal: principal,
                subjectID: targetID, action: "role.changed", targetType: "membership",
                targetID: membershipID,
                detail: [
                    "scope": "channel", "channel_id": channelID.uuidString,
                    "old": targetRole.rawValue, "new": requested.rawValue,
                ]
            )
            return MembershipRoleResponse(
                memberId: targetID.uuidString, scope: "channel", role: requested.rawValue
            )
        }
        return try response.response(from: request, context: context)
    }

    @Sendable
    func suspend(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await setStatus(request, context: context, expected: "active", next: "suspended", action: "member.suspended")
    }

    @Sendable
    func reinstate(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await setStatus(request, context: context, expected: "suspended", next: "active", action: "member.reinstated")
    }

    private func setStatus(
        _ request: Request,
        context: AppRequestContext,
        expected: String,
        next: String,
        action: String
    ) async throws -> Response {
        let (principal, workspaceID, targetID) = try Self.scope(context)
        let response: MembershipLifecycleResponse = try await transaction(workspaceID) { conn in
            let actorRole = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let target = try await Self.target(
                conn: conn, logger: db.logger, workspaceID: workspaceID, memberID: targetID
            )
            if target.role == .owner, next != "active" {
                try await Self.requireAnotherOwner(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, excluding: targetID
                )
            }
            try Self.requireCanManage(
                actorID: principal.memberID, actorRole: actorRole,
                targetID: targetID, targetRole: target.role, requestedRole: nil
            )
            guard target.status == expected else {
                throw HTTPError(.conflict, message: "member status must be \(expected)")
            }
            _ = try await conn.query(
                "UPDATE member SET status = \(next)::member_status, updated_at = now() WHERE id = \(targetID)",
                logger: db.logger
            )
            if next == "suspended" {
                try await Self.revokeTokens(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, memberID: targetID
                )
            }
            try await Self.audit(
                conn: conn, logger: db.logger, workspaceID: workspaceID, principal: principal,
                subjectID: targetID, action: action, targetType: "member", targetID: targetID,
                detail: ["old": expected, "new": next]
            )
            return MembershipLifecycleResponse(memberId: targetID.uuidString, status: next)
        }
        return try response.response(from: request, context: context)
    }

    @Sendable
    func remove(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID, targetID) = try Self.scope(context)
        let dto = try? await request.decode(as: RemoveWorkspaceMemberRequest.self, context: context)
        let reason = Self.normalizedReason(dto?.reason)
        let response: MembershipLifecycleResponse = try await transaction(workspaceID) { conn in
            let actorRole = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let target = try await Self.target(
                conn: conn, logger: db.logger, workspaceID: workspaceID, memberID: targetID
            )
            if target.role == .owner {
                try await Self.requireAnotherOwner(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, excluding: targetID
                )
            }
            try Self.requireCanManage(
                actorID: principal.memberID, actorRole: actorRole,
                targetID: targetID, targetRole: target.role, requestedRole: nil
            )
            if dto?.ban == true {
                _ = try await Self.insertBan(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    principal: principal, email: target.email, handle: target.handle, reason: reason
                )
            }
            try await Self.revokeTokens(
                conn: conn, logger: db.logger, workspaceID: workspaceID, memberID: targetID
            )
            _ = try await conn.query(
                "DELETE FROM membership WHERE workspace_id = \(workspaceID) AND member_id = \(targetID)",
                logger: db.logger
            )
            _ = try await conn.query(
                "DELETE FROM workspace_membership WHERE workspace_id = \(workspaceID) AND member_id = \(targetID)",
                logger: db.logger
            )
            _ = try await conn.query(
                "UPDATE member SET status = 'deleted', updated_at = now() WHERE id = \(targetID)",
                logger: db.logger
            )
            try await Self.audit(
                conn: conn, logger: db.logger, workspaceID: workspaceID, principal: principal,
                subjectID: targetID, action: "member.removed", targetType: "member", targetID: targetID,
                detail: ["old": target.status, "new": "deleted", "ban": dto?.ban == true ? "true" : "false"]
            )
            return MembershipLifecycleResponse(memberId: targetID.uuidString, status: "deleted")
        }
        return try response.response(from: request, context: context)
    }

    @Sendable
    func createBan(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: CreateWorkspaceBanRequest.self, context: context)
        let email = try dto.email.map(JoinRoutes.normalizedEmail)
        let handle = try dto.handle.map { try JoinRoutes.normalizedRequestedHandle($0)! }
        guard email != nil || handle != nil else {
            throw HTTPError(.badRequest, message: "email or handle is required")
        }
        let ban: WorkspaceBanDTO = try await transaction(workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            return try await Self.insertBan(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, email: email, handle: handle,
                reason: Self.normalizedReason(dto.reason)
            )
        }
        var response = try WorkspaceBanResponse(ban: ban).response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func listBans(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let bans: [WorkspaceBanDTO] = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT id, email_norm, handle_norm, created_by, reason, created_at
                  FROM workspace_ban
                 WHERE workspace_id = \(workspaceID)
                 ORDER BY created_at DESC, id
                 LIMIT 500
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeBan)
        }
        return try WorkspaceBanListResponse(bans: bans).response(from: request, context: context)
    }

    @Sendable
    func deleteBan(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let raw = try context.parameters.require("ban")
        guard let banID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid ban id")
        }
        let ban: WorkspaceBanDTO = try await transaction(workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let rows = try await conn.query(
                """
                DELETE FROM workspace_ban
                 WHERE workspace_id = \(workspaceID) AND id = \(banID)
                RETURNING id, email_norm, handle_norm, created_by, reason, created_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "ban not found")
            }
            let ban = try Self.decodeBan(row)
            try await Self.audit(
                conn: conn, logger: db.logger, workspaceID: workspaceID, principal: principal,
                subjectID: nil, action: "ban.deleted", targetType: "workspace_ban", targetID: banID,
                detail: ["email": ban.email ?? "", "handle": ban.handle ?? ""]
            )
            return ban
        }
        return try WorkspaceBanResponse(ban: ban).response(from: request, context: context)
    }

    private func transaction<Result: Sendable>(
        _ workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await db.withTenantTransaction(workspaceID: workspaceID, body)
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    private static func scope(_ context: AppRequestContext) throws -> (AuthPrincipal, UUID, UUID) {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "membership management requires a human member")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let raw = try context.parameters.require("member")
        guard let memberID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid member id")
        }
        return (principal, workspaceID, memberID)
    }

    private struct Target: Sendable {
        let membershipID: UUID
        let role: WorkspaceRole
        let status: String
        let email: String?
        let handle: String
    }

    private static func target(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws -> Target {
        let rows = try await conn.query(
            """
            SELECT wm.id, wm.role::text, m.status::text, h.email, m.handle
              FROM workspace_membership wm
              JOIN member m ON m.workspace_id = wm.workspace_id AND m.id = wm.member_id
              LEFT JOIN human h ON h.workspace_id = m.workspace_id AND h.member_id = m.id
             WHERE wm.workspace_id = \(workspaceID) AND wm.member_id = \(memberID)
             FOR UPDATE OF wm, m
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.notFound, message: "workspace member not found")
        }
        let (membershipID, roleRaw, status, email, handle) =
            try row.decode((UUID, String, String, String?, String).self)
        guard let role = WorkspaceRole(rawValue: roleRaw) else {
            throw HTTPError(.internalServerError, message: "invalid stored workspace role")
        }
        return Target(
            membershipID: membershipID, role: role, status: status, email: email, handle: handle
        )
    }

    private static func requireCanManage(
        actorID: UUID,
        actorRole: WorkspaceRole,
        targetID: UUID,
        targetRole: WorkspaceRole,
        requestedRole: WorkspaceRole?
    ) throws {
        guard actorID != targetID else {
            throw HTTPError(.forbidden, message: "members cannot manage themselves")
        }
        guard targetRole.rank > actorRole.rank else {
            throw HTTPError(.forbidden, message: "cannot manage an equal or higher role")
        }
        if actorRole == .admin, let requestedRole, requestedRole.rank <= WorkspaceRole.admin.rank {
            throw HTTPError(.forbidden, message: "admins cannot grant admin or owner")
        }
    }

    private static func requireAnotherOwner(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        excluding memberID: UUID
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT EXISTS (
              SELECT 1 FROM workspace_membership wm
              JOIN member m ON m.workspace_id = wm.workspace_id AND m.id = wm.member_id
               WHERE wm.workspace_id = \(workspaceID)
                 AND wm.role = 'owner'
                 AND wm.member_id <> \(memberID)
                 AND m.status = 'active' AND m.deleted_at IS NULL
            )
            """,
            logger: logger
        ).collect()
        guard try rows.first?.decode(Bool.self) == true else {
            throw HTTPError(.conflict, message: "workspace must retain at least one owner")
        }
    }

    private static func revokeTokens(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws {
        _ = try await conn.query(
            """
            UPDATE token SET revoked_at = COALESCE(revoked_at, now())
             WHERE workspace_id = \(workspaceID)
               AND (actor_member_id = \(memberID) OR subject_member_id = \(memberID))
               AND revoked_at IS NULL
            """,
            logger: logger
        )
    }

    private static func insertBan(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        email: String?,
        handle: String?,
        reason: String?
    ) async throws -> WorkspaceBanDTO {
        let duplicate = try await conn.query(
            """
            SELECT EXISTS (
              SELECT 1 FROM workspace_ban
               WHERE workspace_id = \(workspaceID)
                 AND ((\(email) IS NOT NULL AND email_norm = \(email))
                   OR (\(handle) IS NOT NULL AND handle_norm = \(handle)))
            )
            """,
            logger: logger
        ).collect()
        if try duplicate.first?.decode(Bool.self) == true {
            throw HTTPError(.conflict, message: "matching workspace ban already exists")
        }
        let rows = try await conn.query(
            """
            INSERT INTO workspace_ban (workspace_id, email_norm, handle_norm, created_by, reason)
            VALUES (\(workspaceID), \(email), \(handle), \(principal.memberID), \(reason))
            RETURNING id, email_norm, handle_norm, created_by, reason, created_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "ban creation failed")
        }
        let ban = try decodeBan(row)
        try await audit(
            conn: conn, logger: logger, workspaceID: workspaceID, principal: principal,
            subjectID: nil, action: "ban.created", targetType: "workspace_ban",
            targetID: UUID(uuidString: ban.id)!,
            detail: ["email": ban.email ?? "", "handle": ban.handle ?? "", "reason": reason ?? ""]
        )
        return ban
    }

    private static func decodeBan(_ row: PostgresRow) throws -> WorkspaceBanDTO {
        let (id, email, handle, createdBy, reason, createdAt) =
            try row.decode((UUID, String?, String?, UUID, String?, Date).self)
        return WorkspaceBanDTO(
            id: id.uuidString, email: email, handle: handle,
            createdBy: createdBy.uuidString, reason: reason,
            createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
        )
    }

    private static func normalizedReason(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return String(value.prefix(500))
    }

    private static func audit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        subjectID: UUID?,
        action: String,
        targetType: String,
        targetID: UUID,
        detail: [String: String]
    ) async throws {
        let data = try JSONSerialization.data(withJSONObject: detail)
        guard let json = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "audit detail encoding failed")
        }
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES (\(workspaceID), \(principal.memberID), \(subjectID), \(action),
                    \(targetType), \(targetID), \(principal.tokenID), \(json)::jsonb)
            """,
            logger: logger
        )
    }
}
