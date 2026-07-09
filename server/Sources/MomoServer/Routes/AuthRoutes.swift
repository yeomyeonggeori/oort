import Foundation
import HTTPTypes
import Hummingbird
import PostgresNIO

/// Auth endpoints (L4 §5.1 / §7.1).
///
///   POST /v1/auth/login   → access(15m) + refresh(30d) HS256 JWT + member.
///   POST /v1/auth/refresh → rotate a refresh token into a new pair (MOMO-300).
///   POST /v1/auth/logout  → revoke the presented session tokens (MOMO-300).
///   POST /v1/auth/realtime-token → short-lived Centrifugo connection JWT.
///
/// Login resolves a human member by email and verifies the submitted password
/// through PostgreSQL pgcrypto (`momo_password_verify`). Issued tokens are
/// persisted (hashed) in the `token` table so `revoked_at` can kill them.
struct AuthRoutes: Sendable {
    let db: Database
    let jwt: JWTService
    let tokenStore: TokenStore
    let platformAdminEmails: [String]
    let platformAdminLoginSecret: String?

    /// The demo workspace seeded by `server/Migrations/002_seed.sql`. Used when a
    /// login request omits an explicit workspace (single-tenant v0).
    static let demoWorkspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!

    func add(to router: Router<AppRequestContext>) {
        // Public routes — NOT behind AuthMiddleware.
        router.post("/v1/auth/login", use: login)
        // refresh/logout verify the presented JWT themselves. logout skips the
        // revocation check on purpose: revoking an already-revoked token must
        // stay a 200 (idempotency), not a 401.
        router.post("/v1/auth/refresh", use: refresh)
        router.post("/v1/auth/logout", use: logout)
    }

    func addProtected(to router: RouterGroup<AppRequestContext>) {
        // Protected route — requires a valid app access token via AuthMiddleware.
        router.post("/v1/auth/realtime-token", use: realtimeToken)
    }

    @Sendable
    func login(_ request: Request, context: AppRequestContext) async throws -> Response {
        let dto = try await request.decode(as: LoginRequest.self, context: context)
        let workspaceID = dto.workspace.flatMap { UUID(uuidString: $0) } ?? Self.demoWorkspaceID
        guard !dto.password.isEmpty else {
            throw HTTPError(.unauthorized, message: "invalid credentials")
        }

        // Resolve the human member by email within the tenant (RLS-scoped) and
        // verify the password inside Postgres so v0 does not add Swift crypto deps.
        let member: MemberDTO? = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT m.id, m.workspace_id, m.kind::text, m.display_name, m.handle,
                       momo_password_verify(\(dto.password), h.password_hash) AS password_ok
                  FROM human h
                  JOIN member m ON m.id = h.member_id
                 WHERE h.email = \(dto.email)
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (id, ws, kind, displayName, handle, passwordOK) =
                try row.decode((UUID, UUID, String, String, String, Bool).self)
            guard passwordOK else { return nil }
            return MemberDTO(
                id: id.uuidString, workspaceId: ws.uuidString, kind: kind,
                displayName: displayName, handle: handle
            )
        }

        guard let member, let memberID = UUID(uuidString: member.id) else {
            throw HTTPError(.unauthorized, message: "invalid credentials")
        }

        // Coarse v0 scopes; a real impl derives these from membership/role (L4 §7.2).
        var scopes = ["messages:write", "messages:read"]
        if Self.shouldGrantPlatformRead(
            email: dto.email,
            platformAdminSecret: dto.platformAdminSecret,
            platformAdminEmails: platformAdminEmails,
            platformAdminLoginSecret: platformAdminLoginSecret
        ) {
            scopes.append("platform:read")
        }
        let access = try await jwt.signAccess(
            memberID: memberID, workspaceID: workspaceID, scopes: scopes)
        let refresh = try await jwt.signRefresh(
            memberID: memberID, workspaceID: workspaceID, scopes: scopes)
        try await Self.recordSessionTokens(
            tokenStore: tokenStore,
            access: access,
            refresh: refresh,
            memberID: memberID,
            workspaceID: workspaceID,
            scopes: scopes
        )

        let body = LoginResponse(
            accessToken: access.token, refreshToken: refresh.token, member: member)
        return try body.response(from: request, context: context)
    }

    /// POST /v1/auth/refresh — rotate a refresh token (MOMO-300).
    ///
    /// The presented refresh token must verify (signature/exp), be typ=refresh,
    /// be unrevoked in the `token` table, and belong to a still-active member.
    /// On success the old refresh token is revoked (single-use rotation) and a
    /// new access/refresh pair is issued and recorded.
    @Sendable
    func refresh(_ request: Request, context: AppRequestContext) async throws -> Response {
        let dto = try await request.decode(as: RefreshRequest.self, context: context)

        let payload: AppJWTPayload
        do {
            payload = try await jwt.verify(dto.refreshToken)
        } catch {
            throw HTTPError(.unauthorized, message: "invalid or expired refresh token")
        }
        guard payload.typ == "refresh" else {
            throw HTTPError(.unauthorized, message: "not a refresh token")
        }
        guard let memberID = UUID(uuidString: payload.sub.value),
              let workspaceID = UUID(uuidString: payload.ws)
        else {
            throw HTTPError(.unauthorized, message: "malformed token claims")
        }

        // Revocation pre-check — a logged-out/rotated refresh token is dead.
        // (Advisory only for precise error messages; the atomic gate is the
        // revoke below.)
        try await tokenStore.requireActive(rawToken: dto.refreshToken, workspaceID: workspaceID)

        guard try await Self.isActiveMember(db: db, workspaceID: workspaceID, memberID: memberID)
        else {
            throw HTTPError(.forbidden, message: "member is not active in this workspace")
        }

        // Rotation: the old refresh token can never be replayed. The revoke's
        // `UPDATE … WHERE revoked_at IS NULL RETURNING` is the atomic
        // single-use gate — under concurrent refreshes with the same token,
        // exactly one request flips the row (`revokedNow == true`) and may
        // mint a new pair; every loser sees `revokedNow == false` and gets a
        // 401 (MOMO-300 review fix: previously the result was discarded, so
        // the requireActive() pre-check raced TOCTOU-style and N concurrent
        // replays could all rotate successfully).
        let rotation = try await tokenStore.revoke(
            rawToken: dto.refreshToken, workspaceID: workspaceID)
        guard rotation.revokedNow else {
            throw HTTPError(.unauthorized, message: "refresh token already used or revoked")
        }

        let scopes = payload.scopes
        let access = try await jwt.signAccess(
            memberID: memberID, workspaceID: workspaceID, scopes: scopes)
        let refresh = try await jwt.signRefresh(
            memberID: memberID, workspaceID: workspaceID, scopes: scopes)
        try await Self.recordSessionTokens(
            tokenStore: tokenStore,
            access: access,
            refresh: refresh,
            memberID: memberID,
            workspaceID: workspaceID,
            scopes: scopes
        )

        let body = RefreshResponse(accessToken: access.token, refreshToken: refresh.token)
        return try body.response(from: request, context: context)
    }

    /// POST /v1/auth/logout — revoke the presented session tokens (MOMO-300).
    ///
    /// Requires a signature-valid access token in Authorization (revocation
    /// state is NOT required — logging out twice stays a 200, idempotent). An
    /// optional body `refreshToken` belonging to the same member/workspace is
    /// revoked alongside. Writes one `audit_log` row (`auth.logout`) when the
    /// call actually transitions a token to revoked.
    @Sendable
    func logout(_ request: Request, context: AppRequestContext) async throws -> Response {
        guard let header = request.headers[.authorization],
              header.lowercased().hasPrefix("bearer ")
        else {
            throw HTTPError(.unauthorized, message: "missing bearer token")
        }
        let rawAccess = String(header.dropFirst("bearer ".count))
            .trimmingCharacters(in: .whitespaces)

        let payload: AppJWTPayload
        do {
            payload = try await jwt.verify(rawAccess)
        } catch {
            throw HTTPError(.unauthorized, message: "invalid or expired token")
        }
        guard payload.typ == "access" else {
            throw HTTPError(.unauthorized, message: "not an access token")
        }
        guard let memberID = UUID(uuidString: payload.sub.value),
              let workspaceID = UUID(uuidString: payload.ws)
        else {
            throw HTTPError(.unauthorized, message: "malformed token claims")
        }

        // Optional body — tolerate an empty/absent JSON body. Validate the
        // refresh token BEFORE revoking anything so a mismatched body cannot
        // leave the session half-revoked with an error response.
        let dto = try? await request.decode(as: LogoutRequest.self, context: context)
        var rawRefreshToRevoke: String?
        if let rawRefresh = dto?.refreshToken, !rawRefresh.isEmpty {
            // The refresh token must be the same member's, same workspace.
            guard let refreshPayload = try? await jwt.verify(rawRefresh),
                  refreshPayload.typ == "refresh",
                  refreshPayload.sub.value == payload.sub.value,
                  refreshPayload.ws == payload.ws
            else {
                throw HTTPError(.forbidden, message: "refresh token does not match this session")
            }
            rawRefreshToRevoke = rawRefresh
        }

        let accessResult = try await tokenStore.revoke(
            rawToken: rawAccess, workspaceID: workspaceID)

        var refreshResult: (id: UUID?, revokedNow: Bool) = (nil, false)
        if let rawRefreshToRevoke {
            refreshResult = try await tokenStore.revoke(
                rawToken: rawRefreshToRevoke, workspaceID: workspaceID)
        }

        let revokedNow = accessResult.revokedNow || refreshResult.revokedNow
        if revokedNow {
            try await Self.insertLogoutAudit(
                db: db,
                workspaceID: workspaceID,
                memberID: memberID,
                accessTokenID: accessResult.id,
                revokedAccess: accessResult.revokedNow,
                revokedRefresh: refreshResult.revokedNow
            )
        }

        let body = LogoutResponse(
            status: "ok",
            revokedAccess: accessResult.revokedNow,
            revokedRefresh: refreshResult.revokedNow,
            alreadyRevoked: !revokedNow
        )
        return try body.response(from: request, context: context)
    }

    @Sendable
    func realtimeToken(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let requiredScope = principal.kind == .agent
            ? "realtime:subscribe"
            : "messages:read"
        guard principal.scopes.contains(requiredScope) else {
            throw HTTPError(.forbidden, message: "\(requiredScope) scope required")
        }

        let active = try await Self.isActiveMember(
            db: db,
            workspaceID: principal.workspaceID,
            memberID: principal.memberID
        )
        guard active else {
            throw HTTPError(.forbidden, message: "member is not active in this workspace")
        }

        let issued = try await jwt.signCentrifugoConnection(
            memberID: principal.memberID,
            workspaceID: principal.workspaceID
        )
        let body = RealtimeTokenResponse(
            token: issued.token,
            tokenType: "centrifugo.connection.jwt",
            expiresAtMs: Int64(issued.expiresAt.timeIntervalSince1970 * 1000),
            ttlSeconds: issued.ttlSeconds,
            workspaceId: principal.workspaceID.uuidString,
            memberId: principal.memberID.uuidString
        )
        return try body.response(from: request, context: context)
    }

    static func shouldGrantPlatformRead(
        email: String,
        platformAdminSecret: String?,
        platformAdminEmails: [String],
        platformAdminLoginSecret: String?
    ) -> Bool {
        guard let platformAdminLoginSecret, !platformAdminLoginSecret.isEmpty else {
            return false
        }
        guard let platformAdminSecret, !platformAdminSecret.isEmpty else {
            return false
        }
        // MOMO-300 review fix: secret comparison must be constant-time —
        // a plain `==` short-circuits and leaks match-prefix length via timing.
        return platformAdminEmails.contains(email.lowercased())
            && ConstantTime.equals(platformAdminSecret, platformAdminLoginSecret)
    }

    /// Persist a freshly issued access/refresh pair for revocation (MOMO-300).
    static func recordSessionTokens(
        tokenStore: TokenStore,
        access: IssuedAppToken,
        refresh: IssuedAppToken,
        memberID: UUID,
        workspaceID: UUID,
        scopes: [String]
    ) async throws {
        try await tokenStore.record(
            rawToken: access.token, label: "access", memberID: memberID,
            workspaceID: workspaceID, scopes: scopes, expiresAt: access.expiresAt)
        try await tokenStore.record(
            rawToken: refresh.token, label: "refresh", memberID: memberID,
            workspaceID: workspaceID, scopes: scopes, expiresAt: refresh.expiresAt)
    }

    private static func insertLogoutAudit(
        db: Database,
        workspaceID: UUID,
        memberID: UUID,
        accessTokenID: UUID?,
        revokedAccess: Bool,
        revokedRefresh: Bool
    ) async throws {
        let detail = """
        {"revoked_access":\(revokedAccess),"revoked_refresh":\(revokedRefresh)}
        """
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type, target_id,
                   via_token_id, detail)
                VALUES
                  (\(workspaceID), \(memberID), 'auth.logout', 'token',
                   \(accessTokenID), \(accessTokenID), \(detail)::jsonb)
                """,
                logger: db.logger
            )
        }
    }

    static func isActiveMember(db: Database, workspaceID: UUID, memberID: UUID) async throws -> Bool {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT 1
                  FROM member
                 WHERE id = \(memberID)
                   AND workspace_id = \(workspaceID)
                   AND status = 'active'
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return !rows.isEmpty
        }
    }
}
