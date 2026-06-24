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
}
