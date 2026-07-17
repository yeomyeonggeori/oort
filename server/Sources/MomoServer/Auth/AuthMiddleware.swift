import Foundation
import HTTPTypes
import Hummingbird

/// Authenticates requests bearing an App JWT or per-agent bearer credential.
///
/// Agent bearer routes are allowlisted here and each route requires one of the
/// allowlisted ADR-0101/0109 scopes. A valid credential cannot reach another
/// protected human/admin surface merely because it has a bearer shape.
///
/// MOMO-300: beyond signature/exp, every access token is checked against the
/// `token` table — a token that is unknown, revoked (`revoked_at`), or expired
/// there is rejected with 401. Fail-closed: tokens issued before revocation
/// support (no row) stop working; clients re-login.
///
/// Public routes (`/health`, `/v1/auth/login`) are mounted on a router group
/// WITHOUT this middleware, so they remain reachable unauthenticated.
struct AuthMiddleware: RouterMiddleware {
    typealias Context = AppRequestContext

    let jwt: JWTService
    let tokenStore: TokenStore
    let legacyGatewayConfig: AgentGatewayConfig?

    init(
        jwt: JWTService,
        tokenStore: TokenStore,
        legacyGatewayConfig: AgentGatewayConfig? = nil
    ) {
        self.jwt = jwt
        self.tokenStore = tokenStore
        self.legacyGatewayConfig = legacyGatewayConfig
    }

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        guard let header = request.headers[.authorization],
              header.lowercased().hasPrefix("bearer ")
        else {
            if let legacyGatewayConfig,
               legacyGatewayConfig.legacySecretEnabled,
               let presented = request.headers[AgentGatewayRoutes.gatewaySecretHeader],
               ConstantTime.equals(presented, legacyGatewayConfig.secret)
            {
                context.logger.warning(
                    "deprecated agent gateway shared secret accepted; rotate to agent_bearer"
                )
                var context = context
                context.usedLegacyAgentGatewaySecret = true
                return try await next(request, context)
            }
            throw HTTPError(.unauthorized, message: "missing bearer token")
        }
        let token = String(header.dropFirst("bearer ".count)).trimmingCharacters(in: .whitespaces)

        if AgentBearerToken.workspaceID(from: token) != nil {
            guard let requiredScope = Self.requiredAgentScope(
                method: request.method.rawValue,
                path: request.uri.path
            ) else {
                throw HTTPError(.forbidden, message: "agent bearer is not allowed for this route")
            }
            let identity = try await tokenStore.authenticateAgentBearer(
                rawToken: token,
                requiredScope: requiredScope,
                method: request.method.rawValue,
                path: request.uri.path
            )
            var context = context
            context.principal = AuthPrincipal(
                memberID: identity.memberID,
                workspaceID: identity.workspaceID,
                scopes: identity.scopes,
                kind: .agent,
                tokenID: identity.tokenID
            )
            return try await next(request, context)
        }

        let payload: AppJWTPayload
        do {
            payload = try await jwt.verify(token)
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

        // Revocation check (MOMO-300): the signature only proves issuance; the
        // token row proves the session is still alive. 401 on revoked/unknown.
        let tokenID = try await tokenStore.requireActive(
            rawToken: token,
            workspaceID: workspaceID
        )

        var context = context
        context.principal = AuthPrincipal(
            memberID: memberID,
            workspaceID: workspaceID,
            scopes: payload.scopes,
            kind: .human,
            tokenID: tokenID
        )
        return try await next(request, context)
    }

    /// Exact route-to-scope map for ADR-0101 Phase 1. Unknown routes return nil
    /// and are therefore unavailable to agent bearers.
    static func requiredAgentScope(method: String, path: String) -> String? {
        let method = method.uppercased()
        let segments = path.split(separator: "/").map(String.init)
        if method == "POST", path == "/v1/auth/realtime-token" {
            return "realtime:subscribe"
        }
        if method == "POST",
           segments.count == 6,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "channels",
           segments[5] == "messages"
        {
            return "messages:write"
        }
        if method == "GET",
           segments.count == 4,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "read-state"
        {
            return "messages:read"
        }
        if method == "POST", path == "/v1/mcp/drive" {
            return "messages:read"
        }
        if method == "GET",
           segments.count == 4,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "plugins"
        {
            return "messages:read"
        }
        if method == "PUT",
           segments.count == 6,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "channels",
           segments[5] == "read-state"
        {
            return "messages:read"
        }
        if method == "GET",
           segments.count == 8,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "agents",
           segments[5] == "gateway",
           segments[6] == "jobs",
           segments[7] == "pending"
        {
            return "agent:jobs:read"
        }
        if method == "POST",
           segments.count == 10,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "agents",
           segments[5] == "gateway",
           segments[6] == "jobs",
           segments[8] == "lease",
           segments[9] == "renew" || segments[9] == "release"
        {
            return "agent:jobs:read"
        }
        if method == "POST",
           segments.count == 7,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "agent-runs",
           segments[5] == "gateway",
           segments[6] == "events" || segments[6] == "complete"
        {
            return "agent:runs:callback"
        }
        return nil
    }
}

extension AppRequestContext {
    /// The authenticated principal or a 401 if absent (used inside protected handlers).
    func requirePrincipal() throws -> AuthPrincipal {
        guard let principal else {
            throw HTTPError(.unauthorized, message: "authentication required")
        }
        return principal
    }
}
