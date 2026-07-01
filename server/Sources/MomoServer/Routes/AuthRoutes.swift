import Foundation
import Hummingbird
import PostgresNIO

/// Auth endpoints (L4 §5.1 / §7.1).
///
///   POST /v1/auth/login   → access(15m) + refresh(30d) HS256 JWT + member.
///   POST /v1/auth/realtime-token → short-lived Centrifugo connection JWT.
///
/// Login resolves a human member by email and verifies the submitted password
/// through PostgreSQL pgcrypto (`momo_password_verify`).
struct AuthRoutes: Sendable {
    let db: Database
    let jwt: JWTService
    let platformAdminEmails: [String]
    let platformAdminLoginSecret: String?

    /// The demo workspace seeded by `server/Migrations/002_seed.sql`. Used when a
    /// login request omits an explicit workspace (single-tenant v0).
    static let demoWorkspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!

    func add(to router: Router<AppRequestContext>) {
        // Public route — NOT behind AuthMiddleware.
        router.post("/v1/auth/login", use: login)
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

        let body = LoginResponse(accessToken: access, refreshToken: refresh, member: member)
        return try body.response(from: request, context: context)
    }

    @Sendable
    func realtimeToken(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.scopes.contains("messages:read") else {
            throw HTTPError(.forbidden, message: "messages:read scope required")
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
        return platformAdminEmails.contains(email.lowercased())
            && platformAdminSecret == platformAdminLoginSecret
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
