import Foundation
import HTTPTypes
import Hummingbird
import PostgresNIO

/// Centrifugo subscribe-proxy authorization callback (L4 §4.3 / §7.2).
///
///   POST /v1/centrifugo/subscribe   → allow/deny a client's channel subscription.
///
/// Centrifugo calls this on every subscribe attempt; returning allow/deny means
/// an eviction (membership removed) takes effect immediately (L4 §C4). `ch:`/`dm:`
/// subscriptions check direct channel membership. `agent:` subscriptions check
/// that the observer and target agent are active members with at least one shared
/// channel in the workspace. Clients still never publish directly to Centrifugo.
///
/// MOMO-300 hardening (old v0 stub resolved):
///   1. Proxy authentication — Centrifugo attaches a shared secret
///      (`X-Centrifugo-Proxy-Secret` static header, `CENT_PROXY_SECRET` env,
///      see infra/centrifugo*.json). Requests without the exact secret are
///      rejected 401 before the body is trusted; network position alone no
///      longer authenticates the callback.
///   2. Session liveness — the subscribing member must still hold at least one
///      unrevoked session token (`token.revoked_at IS NULL`), so logout also
///      cuts off new realtime subscriptions even while a short-lived
///      connection JWT is technically still valid.
struct CentrifugoRoutes: Sendable {
    let db: Database
    let tokenStore: TokenStore
    /// Shared secret expected on every proxy callback (Config.centProxySecret).
    let proxySecret: String

    static let proxySecretHeader = HTTPField.Name("X-Centrifugo-Proxy-Secret")!

    func add(to router: Router<AppRequestContext>) {
        // Public (internal) route — Centrifugo → API. NOT behind AuthMiddleware;
        // authenticated by the shared-secret header instead.
        router.post("/v1/centrifugo/subscribe", use: subscribe)
    }

    @Sendable
    func subscribe(
        _ request: Request, context: AppRequestContext
    ) async throws -> SubscribeProxyResponse {
        // 1. Authenticate the proxy caller before trusting anything in the body.
        guard let presented = request.headers[Self.proxySecretHeader],
              Self.constantTimeEquals(presented, proxySecret)
        else {
            context.logger.warning("centrifugo subscribe proxy: missing/invalid proxy secret")
            throw HTTPError(.unauthorized, message: "invalid or missing proxy secret")
        }

        let dto = try await request.decode(as: SubscribeProxyRequest.self, context: context)

        // Channel naming (L4 §4.1): "<namespace>:ws<workspaceUUID>.<resourceUUID>".
        // For ch:/dm: resource=channel_id. For agent: resource=agent_member_id.
        guard let parsed = Self.parseChannel(dto.channel) else {
            // Unknown channel shape → deny (fail closed).
            return .deny("unrecognized channel")
        }

        // user channel ("#u_...") is server-side subscription, not proxied here.
        guard let userMemberID = dto.user.flatMap({ UUID(uuidString: $0) }) else {
            return .deny("missing or invalid user")
        }

        // 2. Revocation: a member whose sessions were all revoked (logout) may
        // not open new subscriptions (MOMO-300; coarse per-member semantics,
        // see TokenStore.hasActiveSessionToken).
        guard try await tokenStore.hasActiveSessionToken(
            memberID: userMemberID, workspaceID: parsed.workspaceID
        ) else {
            return .deny("no active session for this member")
        }

        let allowed: Bool = switch parsed {
        case .channel(let workspace, let channel):
            try await isMember(userMemberID, of: channel, in: workspace)
        case .agent(let workspace, let agentMemberID):
            try await canObserveAgent(
                observerMemberID: userMemberID,
                agentMemberID: agentMemberID,
                workspaceID: workspace
            )
        }

        return allowed ? .allow() : .deny(parsed.denyReason)
    }

    /// Constant-time string equality (avoids leaking the secret via timing).
    /// Length is compared first — leaking length is acceptable for this secret.
    static func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8)
        let b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count {
            diff |= a[i] ^ b[i]
        }
        return diff == 0
    }

    private func isMember(_ memberID: UUID, of channelID: UUID, in workspaceID: UUID) async throws -> Bool {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT 1
                  FROM membership
                 WHERE channel_id = \(channelID)
                   AND member_id = \(memberID)
                   AND left_at IS NULL
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return !rows.isEmpty
        }
    }

    private func canObserveAgent(
        observerMemberID: UUID,
        agentMemberID: UUID,
        workspaceID: UUID
    ) async throws -> Bool {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT 1
                  FROM member agent_member
                  JOIN member observer_member
                    ON observer_member.id = \(observerMemberID)
                   AND observer_member.workspace_id = \(workspaceID)
                   AND observer_member.status = 'active'
                 WHERE agent_member.id = \(agentMemberID)
                   AND agent_member.workspace_id = \(workspaceID)
                   AND agent_member.kind = 'agent'
                   AND agent_member.status = 'active'
                   AND EXISTS (
                     SELECT 1
                       FROM membership observer_ms
                       JOIN membership agent_ms
                         ON agent_ms.channel_id = observer_ms.channel_id
                        AND agent_ms.member_id = agent_member.id
                        AND agent_ms.left_at IS NULL
                       JOIN channel shared_channel
                         ON shared_channel.id = observer_ms.channel_id
                        AND shared_channel.workspace_id = \(workspaceID)
                        AND shared_channel.archived_at IS NULL
                      WHERE observer_ms.workspace_id = \(workspaceID)
                        AND observer_ms.member_id = observer_member.id
                        AND observer_ms.left_at IS NULL
                   )
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return !rows.isEmpty
        }
    }

    enum ParsedChannel: Equatable {
        case channel(workspace: UUID, channel: UUID)
        case agent(workspace: UUID, agentMember: UUID)

        var workspaceID: UUID {
            switch self {
            case .channel(let workspace, _), .agent(let workspace, _):
                return workspace
            }
        }

        var denyReason: String {
            switch self {
            case .channel:
                return "not a member of this channel"
            case .agent:
                return "not allowed to observe this agent"
            }
        }
    }

    /// Parse "<namespace>:ws<UUID>.<UUID>". Only `ch`, `dm`, and `agent` are
    /// client-subscribe namespaces for this proxy.
    static func parseChannel(_ name: String) -> ParsedChannel? {
        // Expected form produced by the server: "<ns>:ws<wsUUID>.<channelUUID>".
        let parts = name.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let namespace = String(parts[0])
        let body = parts[1] // e.g. "ws<wsUUID>.<channelUUID>"
        guard body.hasPrefix("ws") else { return nil }
        let afterWS = body.dropFirst(2) // "<wsUUID>.<channelUUID>"
        let segs = afterWS.split(separator: ".", maxSplits: 1)
        if segs.count == 2, let ws = UUID(uuidString: String(segs[0])),
           let resource = UUID(uuidString: String(segs[1])) {
            switch namespace {
            case "ch", "dm":
                return .channel(workspace: ws, channel: resource)
            case "agent":
                return .agent(workspace: ws, agentMember: resource)
            default:
                return nil
            }
        }
        // Legacy fallback "ws.<channelUUID>" remains only for pre-bootstrap demo clients.
        // Runtime e2e must use the workspace-qualified form above.
        if (namespace == "ch" || namespace == "dm"),
           segs.count == 2, segs[0].isEmpty, let ch = UUID(uuidString: String(segs[1])) {
            return .channel(workspace: AuthRoutes.demoWorkspaceID, channel: ch)
        }
        return nil
    }
}
