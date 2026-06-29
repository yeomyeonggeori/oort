import Foundation
import Hummingbird
import PostgresNIO

/// Auth endpoints (L4 §5.1 / §7.1).
///
///   POST /v1/auth/login   → access(15m) + refresh(30d) HS256 JWT + member.
///
/// v0 is a STUB: it resolves the member by email (looking up `human`/`member`)
/// and issues tokens WITHOUT verifying the password. The password-hash check is
/// a // TODO below; everything else (token shape, claims, member resolution) is
/// real so the client flow works end-to-end against a seeded DB.
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

    @Sendable
    func login(_ request: Request, context: AppRequestContext) async throws -> Response {
        let dto = try await request.decode(as: LoginRequest.self, context: context)
        let workspaceID = dto.workspace.flatMap { UUID(uuidString: $0) } ?? Self.demoWorkspaceID

        // Resolve the human member by email within the tenant (RLS-scoped).
        let member: MemberDTO? = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT m.id, m.workspace_id, m.kind::text, m.display_name, m.handle,
                       h.password_hash
                  FROM human h
                  JOIN member m ON m.id = h.member_id
                 WHERE h.email = \(dto.email)
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (id, ws, kind, displayName, handle, _passwordHash) =
                try row.decode((UUID, UUID, String, String, String, String?).self)
            // TODO: verify password against `_passwordHash` (e.g. bcrypt/argon2).
            //       v0 stub trusts the email — DO NOT ship to production.
            _ = _passwordHash
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
            password: dto.password,
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

    static func shouldGrantPlatformRead(
        email: String,
        password: String,
        platformAdminEmails: [String],
        platformAdminLoginSecret: String?
    ) -> Bool {
        guard let platformAdminLoginSecret, !platformAdminLoginSecret.isEmpty else {
            return false
        }
        return platformAdminEmails.contains(email.lowercased())
            && password == platformAdminLoginSecret
    }
}
