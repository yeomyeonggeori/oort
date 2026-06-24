import Foundation
import Hummingbird
import PostgresNIO

/// Centrifugo subscribe-proxy authorization callback (L4 §4.3 / §7.2).
///
///   POST /v1/centrifugo/subscribe   → allow/deny a client's channel subscription.
///
/// Centrifugo calls this on every subscribe attempt; returning allow/deny means
/// an eviction (membership removed) takes effect immediately (L4 §C4). The check
/// is a `membership` lookup: parse the workspace + channel out of the Centrifugo
/// channel name, then confirm the user is an active member.
///
/// v0 STUB scope: this endpoint is unauthenticated at the HTTP layer (Centrifugo
/// is trusted on the private network and authenticated separately). The user id
/// arrives in the proxy body; we trust it for v0. // TODO: verify the proxy
/// request HMAC / shared secret before trusting `user`.
struct CentrifugoRoutes: Sendable {
    let db: Database

    func add(to router: Router<AppRequestContext>) {
        // Public (internal) route — Centrifugo → API. NOT behind AuthMiddleware.
        router.post("/v1/centrifugo/subscribe", use: subscribe)
    }

    @Sendable
    func subscribe(
        _ request: Request, context: AppRequestContext
    ) async throws -> SubscribeProxyResponse {
        let dto = try await request.decode(as: SubscribeProxyRequest.self, context: context)

        // Channel naming (L4 §4.1): "<namespace>:ws<workspaceUUID>.<resourceUUID>".
        // We encode workspace + channel UUIDs into the name; parse them back here.
        guard let parsed = Self.parseChannel(dto.channel) else {
            // Unknown channel shape → deny (fail closed).
            return .deny("unrecognized channel")
        }

        // user channel ("#u_...") is server-side subscription, not proxied here.
        guard let userMemberID = dto.user.flatMap({ UUID(uuidString: $0) }) else {
            return .deny("missing or invalid user")
        }

        // Membership check under the tenant's RLS scope (L4 §7.2).
        let allowed: Bool = try await db.withTenantConnection(workspaceID: parsed.workspace) { conn in
            let rows = try await conn.query(
                """
                SELECT 1
                  FROM membership
                 WHERE channel_id = \(parsed.channel)
                   AND member_id = \(userMemberID)
                   AND left_at IS NULL
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return !rows.isEmpty
        }

        return allowed ? .allow() : .deny("not a member of this channel")
    }

    /// Parse "ch:ws<UUID>.<UUID>" -> (workspace, channel). Tolerant of the `ch`/`dm`
    /// namespace prefix. Returns nil if it can't extract two UUIDs.
    static func parseChannel(_ name: String) -> (workspace: UUID, channel: UUID)? {
        // Expected form produced by the server: "<ns>:ws<wsUUID>.<channelUUID>".
        let parts = name.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let body = parts[1] // e.g. "ws<wsUUID>.<channelUUID>"
        guard body.hasPrefix("ws") else { return nil }
        let afterWS = body.dropFirst(2) // "<wsUUID>.<channelUUID>"
        let segs = afterWS.split(separator: ".", maxSplits: 1)
        if segs.count == 2, let ws = UUID(uuidString: String(segs[0])),
           let ch = UUID(uuidString: String(segs[1])) {
            return (ws, ch)
        }
        // Legacy fallback "ws.<channelUUID>" remains only for pre-bootstrap demo clients.
        // Runtime e2e must use the workspace-qualified form above.
        if segs.count == 2, segs[0].isEmpty, let ch = UUID(uuidString: String(segs[1])) {
            return (AuthRoutes.demoWorkspaceID, ch)
        }
        return nil
    }
}
