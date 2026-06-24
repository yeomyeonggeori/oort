import Foundation
import HTTPTypes
import Hummingbird

/// Authenticates requests bearing an `Authorization: Bearer <app-jwt>` header.
///
/// On a valid access token it populates `context.principal` (member_id /
/// workspace_id / scopes) so downstream handlers and the RLS layer can scope
/// queries. On a missing/invalid token it throws 401 (L4 §7).
///
/// Public routes (`/health`, `/v1/auth/login`) are mounted on a router group
/// WITHOUT this middleware, so they remain reachable unauthenticated.
struct AuthMiddleware: RouterMiddleware {
    typealias Context = AppRequestContext

    let jwt: JWTService

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        guard let header = request.headers[.authorization],
              header.lowercased().hasPrefix("bearer ")
        else {
            throw HTTPError(.unauthorized, message: "missing bearer token")
        }
        let token = String(header.dropFirst("bearer ".count)).trimmingCharacters(in: .whitespaces)

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

        var context = context
        context.principal = AuthPrincipal(
            memberID: memberID, workspaceID: workspaceID, scopes: payload.scopes
        )
        return try await next(request, context)
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
