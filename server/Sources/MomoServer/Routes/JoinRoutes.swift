import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Public invite self-signup.
///
/// POST /v1/join is intentionally mounted outside AuthMiddleware: the caller only
/// has a high-entropy invite code. A fixed-search-path, EXECUTE-only database
/// function maps that exact code hash to one workspace id without returning any
/// tenant row. Every subsequent read and the actual join writes run under that
/// workspace's SET LOCAL scope.
struct JoinRoutes: Sendable {
    let db: Database
    let jwt: JWTService
    let tokenStore: TokenStore
    let realtimeWebSocketURL: String

    func add(to router: Router<AppRequestContext>) {
        router.post("/v1/join", use: join)
    }

    @Sendable
    func join(_ request: Request, context: AppRequestContext) async throws -> Response {
        let dto = try await request.decode(as: JoinRequest.self, context: context)
        let code = try InviteRoutes.normalizedCode(dto.code)
        let email = try Self.normalizedEmail(dto.email)
        let displayName = try Self.normalizedDisplayName(dto.displayName)
        let requestedHandle = try Self.normalizedRequestedHandle(dto.handle)
        let fallbackHandle = try Self.fallbackHandle(email: email)
        let password = try Self.normalizedPassword(dto.password)
        let timeZone = try Self.normalizedTimeZone(dto.timeZone)
        let userAgent = request.headers[.userAgent]

        let lookup = try await findInvite(code: code)
        try Self.throwIfInviteStatusFailed(lookup.status)
        try await assertNotDuplicateJoin(
            workspaceID: lookup.workspaceID,
            inviteID: lookup.inviteID,
            email: email
        )
        try await assertNoPublicRoleEscalation(
            workspaceID: lookup.workspaceID,
            email: email,
            inviteRole: lookup.role
        )

        let joined: JoinTransactionResult = try await db.withTenantTransaction(
            workspaceID: lookup.workspaceID
        ) { conn in
            let lockedInvite = try await Self.lockInvite(
                conn: conn,
                logger: db.logger,
                inviteID: lookup.inviteID
            )
            try Self.throwIfInviteStatusFailed(lockedInvite.status)
            try Self.assertPublicJoinRole(lockedInvite.role)

            let existing = try await Self.findExistingHuman(
                conn: conn,
                logger: db.logger,
                email: email
            )
            let memberState: MemberState
            if let existing {
                try Self.assertReusableMember(existing)
                memberState = .existing(existing)
            } else {
                memberState = .created(try await Self.createHumanMember(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: lookup.workspaceID,
                    email: email,
                    displayName: displayName,
                    requestedHandle: requestedHandle,
                    fallbackHandle: fallbackHandle,
                    password: password,
                    timeZone: timeZone
                ))
            }

            let member = memberState.member
            try await Self.assertNotDuplicateRedemption(
                conn: conn,
                logger: db.logger,
                inviteID: lookup.inviteID,
                memberID: member.id
            )
            try await Self.assertNoPublicRoleEscalation(
                conn: conn,
                logger: db.logger,
                memberID: member.id,
                inviteRole: lockedInvite.role
            )

            let memberships = try await Self.createPublicChannelMemberships(
                conn: conn,
                logger: db.logger,
                workspaceID: lookup.workspaceID,
                memberID: member.id,
                role: lockedInvite.role
            )

            try await Self.incrementInviteUsage(
                conn: conn,
                logger: db.logger,
                inviteID: lookup.inviteID
            )
            let redemptionID = try await Self.insertRedemption(
                conn: conn,
                logger: db.logger,
                workspaceID: lookup.workspaceID,
                inviteID: lookup.inviteID,
                memberID: member.id,
                email: email,
                userAgent: userAgent
            )
            try await Self.insertAuditLog(
                conn: conn,
                logger: db.logger,
                workspaceID: lookup.workspaceID,
                inviteID: lookup.inviteID,
                memberID: member.id,
                redemptionID: redemptionID,
                inviteRole: lockedInvite.role,
                userAgent: userAgent
            )

            let invite = try await Self.loadInviteDTO(
                conn: conn,
                logger: db.logger,
                inviteID: lookup.inviteID
            )
            return JoinTransactionResult(
                member: member.dto,
                memberships: memberships,
                invite: invite,
                redemptionID: redemptionID,
                createdMember: memberState.created
            )
        }

        let memberID = try UUID(uuidString: joined.member.id).unwrapJoinInternal()
        let scopes = ["messages:write", "messages:read"]
        let access = try await jwt.signAccess(
            memberID: memberID,
            workspaceID: lookup.workspaceID,
            scopes: scopes
        )
        let refresh = try await jwt.signRefresh(
            memberID: memberID,
            workspaceID: lookup.workspaceID,
            scopes: scopes
        )
        try await AuthRoutes.recordSessionTokens(
            tokenStore: tokenStore,
            access: access,
            refresh: refresh,
            memberID: memberID,
            workspaceID: lookup.workspaceID,
            scopes: scopes
        )

        let body = JoinResponse(
            accessToken: access.token,
            refreshToken: refresh.token,
            workspaceId: lookup.workspaceID.uuidString,
            member: joined.member,
            realtimeWebSocketUrl: realtimeWebSocketURL,
            memberships: joined.memberships,
            invite: joined.invite,
            redemptionId: joined.redemptionID.uuidString,
            createdMember: joined.createdMember
        )
        var response = try body.response(from: request, context: context)
        response.status = joined.createdMember ? .created : .ok
        return response
    }

    private func findInvite(code: String) async throws -> InviteLookup {
        let workspaceID: UUID? = try await db.client.withConnection { conn in
            let rows = try await conn.query(
                """
                SELECT momo_join_private.invite_workspace_id(\(code))
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(UUID?.self)
        }
        guard let workspaceID else {
            throw HTTPError(.notFound, message: "invite code is invalid")
        }

        let lookup: InviteLookup? = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT i.id,
                       i.workspace_id,
                       i.role::text,
                       CASE
                         WHEN i.role::text = 'owner' THEN 'role_escalation'
                         WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                         WHEN i.expires_at <= now() THEN 'expired'
                         WHEN i.used_count >= i.max_uses THEN 'exhausted'
                         ELSE 'valid'
                       END AS status
                  FROM invite_code i
                 WHERE i.code_hash = momo_invite_code_hash(\(code))
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (inviteID, decodedWorkspaceID, role, status) =
                try row.decode((UUID, UUID, String, String).self)
            guard decodedWorkspaceID == workspaceID else { return nil }
            return InviteLookup(
                inviteID: inviteID,
                workspaceID: decodedWorkspaceID,
                role: role,
                status: status
            )
        }

        guard let lookup else {
            throw HTTPError(.notFound, message: "invite code is invalid")
        }
        return lookup
    }

    private func assertNotDuplicateJoin(
        workspaceID: UUID,
        inviteID: UUID,
        email: String
    ) async throws {
        let duplicate = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT EXISTS (
                  SELECT 1
                    FROM invite_code_redemption r
                    JOIN human h ON h.member_id = r.member_id
                   WHERE r.invite_code_id = \(inviteID)
                     AND h.email = \(email)
                )
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(Bool.self) ?? false
        }
        if duplicate {
            throw HTTPError(.conflict, message: "invite code was already redeemed by this member")
        }
    }

    private func assertNoPublicRoleEscalation(
        workspaceID: UUID,
        email: String,
        inviteRole: String
    ) async throws {
        let currentRole = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT ms.role::text
                  FROM human h
                  JOIN membership ms ON ms.member_id = h.member_id
                 WHERE h.email = \(email)
                   AND ms.left_at IS NULL
                 ORDER BY CASE ms.role::text
                            WHEN 'owner' THEN 0
                            WHEN 'admin' THEN 1
                            WHEN 'member' THEN 2
                            ELSE 3
                          END
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(String.self)
        }
        guard let currentRole else { return }
        if Self.roleRank(inviteRole) < Self.roleRank(currentRole) {
            throw HTTPError(.forbidden, message: "public join cannot escalate an existing member role")
        }
    }

    // MARK: - Transaction helpers

    private static func lockInvite(
        conn: PostgresConnection,
        logger: Logger,
        inviteID: UUID
    ) async throws -> LockedInvite {
        let rows = try await conn.query(
            """
            SELECT i.role::text,
                   CASE
                     WHEN i.role::text = 'owner' THEN 'role_escalation'
                     WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                     WHEN i.expires_at <= now() THEN 'expired'
                     WHEN i.used_count >= i.max_uses THEN 'exhausted'
                     ELSE 'valid'
                   END AS status
              FROM invite_code i
             WHERE i.id = \(inviteID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.notFound, message: "invite code is invalid")
        }
        let (role, status) = try row.decode((String, String).self)
        return LockedInvite(role: role, status: status)
    }

    private static func findExistingHuman(
        conn: PostgresConnection,
        logger: Logger,
        email: String
    ) async throws -> JoinMember? {
        let rows = try await conn.query(
            """
            SELECT m.id, m.workspace_id, m.kind::text, m.status::text,
                   m.display_name, m.handle
              FROM human h
              JOIN member m ON m.id = h.member_id
             WHERE h.email = \(email)
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let (id, workspaceID, kind, status, displayName, decodedHandle) =
            try row.decode((UUID, UUID, String, String, String, String).self)
        return JoinMember(
            id: id,
            workspaceID: workspaceID,
            kind: kind,
            status: status,
            displayName: displayName,
            handle: decodedHandle
        )
    }

    private static func createHumanMember(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        email: String,
        displayName: String,
        requestedHandle: String?,
        fallbackHandle: String,
        password: String,
        timeZone: String
    ) async throws -> JoinMember {
        let handle = requestedHandle ?? fallbackHandle
        let rows = try await conn.query(
            """
            WITH inserted_member AS (
              INSERT INTO member (workspace_id, kind, status, display_name, handle)
              SELECT \(workspaceID), 'human', 'active', \(displayName), \(handle)
               WHERE NOT EXISTS (
                 SELECT 1
                   FROM member
                  WHERE handle = \(handle)
                    AND deleted_at IS NULL
               )
              RETURNING id, workspace_id, kind::text, status::text, display_name, handle
            ),
            inserted_human AS (
              INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
              SELECT id, workspace_id, \(email), false, momo_password_hash(\(password)), \(timeZone)
                FROM inserted_member
              RETURNING member_id
            )
            SELECT m.id, m.workspace_id, m.kind, m.status, m.display_name, m.handle
              FROM inserted_member m
              JOIN inserted_human h ON h.member_id = m.id
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "handle is already in use")
        }
        let (id, workspaceID, kind, status, displayName, decodedHandle) =
            try row.decode((UUID, UUID, String, String, String, String).self)
        return JoinMember(
            id: id,
            workspaceID: workspaceID,
            kind: kind,
            status: status,
            displayName: displayName,
            handle: decodedHandle
        )
    }

    private static func assertNotDuplicateRedemption(
        conn: PostgresConnection,
        logger: Logger,
        inviteID: UUID,
        memberID: UUID
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT EXISTS (
              SELECT 1
                FROM invite_code_redemption
               WHERE invite_code_id = \(inviteID)
                 AND member_id = \(memberID)
            )
            """,
            logger: logger
        ).collect()
        let exists = try rows.first?.decode(Bool.self) ?? false
        if exists {
            throw HTTPError(.conflict, message: "invite code was already redeemed by this member")
        }
    }

    private static func assertNoPublicRoleEscalation(
        conn: PostgresConnection,
        logger: Logger,
        memberID: UUID,
        inviteRole: String
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT role::text
              FROM membership
             WHERE member_id = \(memberID)
               AND left_at IS NULL
             ORDER BY CASE role::text
                        WHEN 'owner' THEN 0
                        WHEN 'admin' THEN 1
                        WHEN 'member' THEN 2
                        ELSE 3
                      END
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let currentRole = try rows.first?.decode(String.self) else { return }
        if roleRank(inviteRole) < roleRank(currentRole) {
            throw HTTPError(.forbidden, message: "public join cannot escalate an existing member role")
        }
    }

    private static func createPublicChannelMemberships(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID,
        role: String
    ) async throws -> [JoinMembershipDTO] {
        let rows = try await conn.query(
            """
            WITH public_channels AS (
              SELECT id
                FROM channel
               WHERE workspace_id = \(workspaceID)
                 AND kind = 'public'
                 AND archived_at IS NULL
            ),
            inserted AS (
              INSERT INTO membership (workspace_id, channel_id, member_id, role)
              SELECT \(workspaceID), id, \(memberID), \(role)::membership_role
                FROM public_channels
              ON CONFLICT (channel_id, member_id) DO UPDATE
                 SET left_at = NULL,
                     role = CASE
                              WHEN membership.left_at IS NULL
                              THEN membership.role
                              ELSE EXCLUDED.role
                            END
              RETURNING id, channel_id, role::text
            )
            SELECT id, channel_id, role
              FROM inserted
             ORDER BY channel_id
            """,
            logger: logger
        ).collect()
        let memberships = try rows.map { row in
            let (id, channelID, role) = try row.decode((UUID, UUID, String).self)
            return JoinMembershipDTO(
                id: id.uuidString,
                channelId: channelID.uuidString,
                role: role
            )
        }
        if memberships.isEmpty {
            throw HTTPError(.conflict, message: "workspace has no joinable public channels")
        }
        return memberships
    }

    private static func incrementInviteUsage(
        conn: PostgresConnection,
        logger: Logger,
        inviteID: UUID
    ) async throws {
        let rows = try await conn.query(
            """
            UPDATE invite_code
               SET used_count = used_count + 1,
                   last_used_at = now(),
                   updated_at = now()
             WHERE id = \(inviteID)
               AND revoked_at IS NULL
               AND expires_at > now()
               AND used_count < max_uses
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard rows.first != nil else {
            throw HTTPError(.conflict, message: "invite code is exhausted")
        }
    }

    private static func insertRedemption(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        inviteID: UUID,
        memberID: UUID,
        email: String,
        userAgent: String?
    ) async throws -> UUID {
        let rows = try await conn.query(
            """
            INSERT INTO invite_code_redemption
              (workspace_id, invite_code_id, member_id, email, user_agent)
            VALUES (\(workspaceID), \(inviteID), \(memberID), \(email), \(userAgent))
            ON CONFLICT (invite_code_id, member_id) DO NOTHING
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "invite code was already redeemed by this member")
        }
        return try row.decode(UUID.self)
    }

    private static func insertAuditLog(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        inviteID: UUID,
        memberID: UUID,
        redemptionID: UUID,
        inviteRole: String,
        userAgent: String?
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, detail)
            VALUES (
              \(workspaceID),
              \(memberID),
              \(memberID),
              'invite.join',
              'invite_code',
              \(inviteID),
              jsonb_build_object(
                'redemption_id', \(redemptionID)::text,
                'role', \(inviteRole),
                'user_agent', \(userAgent)
              )
            )
            """,
            logger: logger
        )
    }

    private static func loadInviteDTO(
        conn: PostgresConnection,
        logger: Logger,
        inviteID: UUID
    ) async throws -> InviteCodeDTO {
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
             WHERE i.id = \(inviteID)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "invite code disappeared")
        }
        return try InviteRoutes.decodeInvite(row.decode(String.self))
    }

    // MARK: - Validation

    static func normalizedEmail(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.count >= 3, value.count <= 320,
              value.contains("@"),
              !value.hasPrefix("@"),
              !value.hasSuffix("@")
        else {
            throw HTTPError(.badRequest, message: "email is invalid")
        }
        return value
    }

    static func normalizedDisplayName(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 100 else {
            throw HTTPError(.badRequest, message: "displayName is required")
        }
        return value
    }

    static func normalizedRequestedHandle(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isValidHandle(value) else {
            throw HTTPError(.badRequest, message: "handle must be 2-32 chars of a-z, 0-9, _ or -")
        }
        return value
    }

    static func fallbackHandle(email: String) throws -> String {
        let local = email.split(separator: "@", maxSplits: 1).first.map(String.init) ?? "member"
        let lowered = local.lowercased()
        var output = ""
        var previousWasDash = false
        for scalar in lowered.unicodeScalars {
            let char = Character(scalar)
            if ("a"..."z").contains(char) || ("0"..."9").contains(char) {
                output.append(char)
                previousWasDash = false
            } else if !previousWasDash {
                output.append("-")
                previousWasDash = true
            }
        }
        output = output.trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
        if output.count > 32 {
            output = String(output.prefix(32)).trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
        }
        if output.count < 2 {
            output = "member"
        }
        guard isValidHandle(output) else {
            throw HTTPError(.badRequest, message: "handle could not be derived from email")
        }
        return output
    }

    static func normalizedTimeZone(_ raw: String?) throws -> String {
        let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value, !value.isEmpty else { return "UTC" }
        guard value.count <= 64 else {
            throw HTTPError(.badRequest, message: "timeZone is too long")
        }
        return value
    }

    static func normalizedPassword(_ raw: String?) throws -> String {
        guard let value = raw, !value.isEmpty else {
            throw HTTPError(.badRequest, message: "password is required")
        }
        guard value.count <= 1024 else {
            throw HTTPError(.badRequest, message: "password is too long")
        }
        return value
    }

    private static func isValidHandle(_ value: String) -> Bool {
        guard (2...32).contains(value.count) else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_-")
        return value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func assertReusableMember(_ member: JoinMember) throws {
        guard member.kind == "human" else {
            throw HTTPError(.forbidden, message: "invite can only join human members")
        }
        guard member.status == "active" || member.status == "invited" else {
            throw HTTPError(.forbidden, message: "human is not eligible to join")
        }
    }

    private static func assertPublicJoinRole(_ role: String) throws {
        guard ["admin", "member", "guest"].contains(role) else {
            throw HTTPError(.forbidden, message: "public join cannot grant owner or platform admin")
        }
    }

    private static func throwIfInviteStatusFailed(_ status: String) throws {
        switch status {
        case "valid":
            return
        case "expired":
            throw HTTPError(.gone, message: "invite code is expired")
        case "revoked":
            throw HTTPError(.gone, message: "invite code is revoked")
        case "exhausted":
            throw HTTPError(.conflict, message: "invite code is exhausted")
        case "role_escalation":
            throw HTTPError(.forbidden, message: "public join cannot grant owner or platform admin")
        default:
            throw HTTPError(.notFound, message: "invite code is invalid")
        }
    }

    private static func roleRank(_ role: String) -> Int {
        switch role {
        case "owner": 0
        case "admin": 1
        case "member": 2
        default: 3
        }
    }
}

private struct InviteLookup: Sendable {
    let inviteID: UUID
    let workspaceID: UUID
    let role: String
    let status: String
}

private struct LockedInvite: Sendable {
    let role: String
    let status: String
}

private struct JoinMember: Sendable {
    let id: UUID
    let workspaceID: UUID
    let kind: String
    let status: String
    let displayName: String
    let handle: String

    var dto: MemberDTO {
        MemberDTO(
            id: id.uuidString,
            workspaceId: workspaceID.uuidString,
            kind: kind,
            displayName: displayName,
            handle: handle
        )
    }
}

private enum MemberState: Sendable {
    case existing(JoinMember)
    case created(JoinMember)

    var member: JoinMember {
        switch self {
        case .existing(let member), .created(let member):
            return member
        }
    }

    var created: Bool {
        switch self {
        case .existing:
            return false
        case .created:
            return true
        }
    }
}

private struct JoinTransactionResult: Sendable {
    let member: MemberDTO
    let memberships: [JoinMembershipDTO]
    let invite: InviteCodeDTO
    let redemptionID: UUID
    let createdMember: Bool
}

private extension Optional where Wrapped == UUID {
    func unwrapJoinInternal() throws -> UUID {
        guard let self else {
            throw HTTPError(.internalServerError, message: "member id encoding failed")
        }
        return self
    }
}
