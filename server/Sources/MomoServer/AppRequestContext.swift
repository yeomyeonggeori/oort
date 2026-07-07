import Foundation
import Hummingbird
import NIOCore

/// Per-request context for the momo API.
///
/// Hummingbird threads one of these through every handler. Beyond the core
/// storage it carries the authenticated principal (decoded from the App JWT) so
/// downstream handlers and the RLS layer can read `member_id` / `workspace_id`
/// without re-parsing the token.
///
/// L4 §1.3: tenant isolation is enforced by `SET LOCAL app.workspace_id` per
/// transaction (see `Database.withTenantTransaction`). The context provides the
/// workspace/member identity that drives it.
struct AppRequestContext: RequestContext, RemoteAddressRequestContext {
    var coreContext: CoreRequestContextStorage

    /// Authenticated principal, populated by `AuthMiddleware` when a valid
    /// `Authorization: Bearer <app-jwt>` is present. nil on public routes.
    var principal: AuthPrincipal?

    /// Peer socket address (MOMO-300 per-IP rate limiting). Behind the prod
    /// reverse proxy this is the proxy; `RateLimitMiddleware` prefers
    /// `X-Forwarded-For` when present.
    let remoteAddress: SocketAddress?

    init(source: Source) {
        self.coreContext = .init(source: source)
        self.principal = nil
        self.remoteAddress = source.channel.remoteAddress
    }
}

/// The authenticated caller, derived from the App JWT (L4 §7.1: sub=member_id, ws, scopes).
struct AuthPrincipal: Sendable {
    let memberID: UUID
    let workspaceID: UUID
    let scopes: [String]
}
