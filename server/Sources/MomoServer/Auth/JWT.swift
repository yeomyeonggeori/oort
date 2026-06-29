import Foundation
import JWTKit

/// App JWT payload (REST auth). L4 §7.1: HS256, sub=member_id, ws, scopes.
///
/// `access` tokens live 15m, `refresh` tokens 30d (rotation). The `typ` claim
/// lets the refresh endpoint reject access tokens and vice-versa.
struct AppJWTPayload: JWTPayload {
    /// sub = member_id (UUID string).
    var sub: SubjectClaim
    /// exp = expiry.
    var exp: ExpirationClaim
    /// iat = issued-at.
    var iat: IssuedAtClaim
    /// ws = workspace_id (UUID string) — tenant scope for RLS.
    var ws: String
    /// scopes — coarse capability grants (e.g. messages:write).
    var scopes: [String]
    /// typ — "access" | "refresh".
    var typ: String

    func verify(using _: some JWTAlgorithm) async throws {
        // Standard exp check; JWTKit verifies signature before this is called.
        try exp.verifyNotExpired()
    }
}

/// Extra JSON attached to Centrifugo's connection token `info` claim.
///
/// Centrifugo uses `sub` as the client user id. momo also carries the workspace
/// boundary in `ws` and in `info` so server/client logs can correlate the
/// connection without allowing channel access by token alone.
struct RealtimeTokenInfo: Codable, Equatable, Sendable {
    let schema: String
    let workspaceId: String
    let memberId: String

    enum CodingKeys: String, CodingKey {
        case schema
        case workspaceId = "workspace_id"
        case memberId = "member_id"
    }
}

/// Centrifugo connection JWT payload.
///
/// Required Centrifugo claims: `sub` and `exp`. momo-specific workspace claim:
/// `ws`. The `info` string is JSON so Centrifugo can pass it through as client
/// info without giving it authorization power.
struct CentrifugoConnectionJWTPayload: JWTPayload {
    var sub: SubjectClaim
    var exp: ExpirationClaim
    var iat: IssuedAtClaim
    var ws: String
    var info: String

    func verify(using _: some JWTAlgorithm) async throws {
        try exp.verifyNotExpired()
    }
}

struct RealtimeTokenIssueResult: Sendable {
    let token: String
    let expiresAt: Date
    let ttlSeconds: Int
}

/// Issues and verifies App JWTs (HS256) and Centrifugo connection JWTs (HMAC).
///
/// Wraps a single `JWTKeyCollection`. The app secret and the Centrifugo token
/// secret are distinct (L4 §7.1) and registered under separate kids.
struct JWTService: Sendable {
    private let keys: JWTKeyCollection
    private let config: Config

    static let appKID = JWKIdentifier(string: "app")
    static let centKID = JWKIdentifier(string: "cent")

    init(config: Config) async {
        self.config = config
        let keys = JWTKeyCollection()
        await keys.add(hmac: HMACKey(stringLiteral: config.jwtHMAC),
                       digestAlgorithm: .sha256, kid: Self.appKID)
        await keys.add(hmac: HMACKey(stringLiteral: config.centTokenHMAC),
                       digestAlgorithm: .sha256, kid: Self.centKID)
        self.keys = keys
    }

    /// Sign an access token (15m). L4 §7.1.
    func signAccess(memberID: UUID, workspaceID: UUID, scopes: [String]) async throws -> String {
        try await sign(memberID: memberID, workspaceID: workspaceID,
                       scopes: scopes, ttl: config.accessTokenTTL, typ: "access")
    }

    /// Sign a refresh token (30d, rotated on use). L4 §7.1.
    func signRefresh(memberID: UUID, workspaceID: UUID, scopes: [String]) async throws -> String {
        try await sign(memberID: memberID, workspaceID: workspaceID,
                       scopes: scopes, ttl: config.refreshTokenTTL, typ: "refresh")
    }

    private func sign(
        memberID: UUID, workspaceID: UUID, scopes: [String], ttl: TimeInterval, typ: String
    ) async throws -> String {
        let now = Date()
        let payload = AppJWTPayload(
            sub: SubjectClaim(value: memberID.uuidString),
            exp: ExpirationClaim(value: now.addingTimeInterval(ttl)),
            iat: IssuedAtClaim(value: now),
            ws: workspaceID.uuidString,
            scopes: scopes,
            typ: typ
        )
        return try await keys.sign(payload, kid: Self.appKID)
    }

    /// Verify an App JWT and return its payload (signature + exp checked).
    func verify(_ token: String) async throws -> AppJWTPayload {
        try await keys.verify(token, as: AppJWTPayload.self)
    }

    /// Sign a short-lived Centrifugo connection token for the authenticated member.
    ///
    /// Channel authorization is deliberately not embedded here. Normal `ch:`/`dm:`
    /// subscriptions still pass through `/v1/centrifugo/subscribe`, which checks
    /// membership under tenant RLS.
    func signCentrifugoConnection(
        memberID: UUID,
        workspaceID: UUID,
        ttl: TimeInterval? = nil
    ) async throws -> RealtimeTokenIssueResult {
        let ttlSeconds = Int(ttl ?? config.centConnectionTokenTTL)
        let now = Date()
        let expiresAt = now.addingTimeInterval(TimeInterval(ttlSeconds))
        let info = try Self.realtimeInfoString(memberID: memberID, workspaceID: workspaceID)
        let payload = CentrifugoConnectionJWTPayload(
            sub: SubjectClaim(value: memberID.uuidString),
            exp: ExpirationClaim(value: expiresAt),
            iat: IssuedAtClaim(value: now),
            ws: workspaceID.uuidString,
            info: info
        )
        let token = try await keys.sign(payload, kid: Self.centKID)
        return RealtimeTokenIssueResult(token: token, expiresAt: expiresAt, ttlSeconds: ttlSeconds)
    }

    /// Test/debug verifier for tokens signed with the Centrifugo HMAC key.
    func verifyCentrifugoConnection(_ token: String) async throws -> CentrifugoConnectionJWTPayload {
        try await keys.verify(token, as: CentrifugoConnectionJWTPayload.self)
    }

    static func realtimeInfoString(memberID: UUID, workspaceID: UUID) throws -> String {
        let info = RealtimeTokenInfo(
            schema: "momo.realtime.connection.v0",
            workspaceId: workspaceID.uuidString,
            memberId: memberID.uuidString
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(info), as: UTF8.self)
    }
}
