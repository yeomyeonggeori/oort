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

    /// Authenticated principal, populated by `AuthMiddleware` when a valid app
    /// JWT or agent bearer is present. nil on public routes.
    var principal: AuthPrincipal?

    /// True only for the explicitly enabled shared-secret migration path on
    /// Hermes gateway callbacks. New agent traffic always uses `principal`.
    var usedLegacyAgentGatewaySecret: Bool

    /// Peer socket address (MOMO-300 per-IP rate limiting). Behind the prod
    /// reverse proxy this is the proxy; `RateLimitMiddleware` prefers
    /// `X-Forwarded-For` when present.
    let remoteAddress: SocketAddress?

    init(source: Source) {
        self.coreContext = .init(source: source)
        self.principal = nil
        self.usedLegacyAgentGatewaySecret = false
        self.remoteAddress = source.channel.remoteAddress
    }
}

enum AuthPrincipalKind: String, Sendable {
    case human
    case agent
    case workHost
}

/// The authenticated caller. Human principals come from App JWTs; agent
/// principals come from `token(kind='agent_bearer')` after a sha256 lookup.
struct AuthPrincipal: Sendable {
    let memberID: UUID
    let workspaceID: UUID
    let scopes: [String]
    let kind: AuthPrincipalKind
    let tokenID: UUID
}
