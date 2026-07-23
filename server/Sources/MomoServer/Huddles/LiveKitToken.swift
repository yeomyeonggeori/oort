@preconcurrency import Crypto
import Foundation

struct LiveKitVideoGrant: Codable, Equatable, Sendable {
    let room: String
    let roomJoin: Bool
    let canPublish: Bool
    let canSubscribe: Bool
}

struct LiveKitAccessClaims: Codable, Equatable, Sendable {
    let iss: String
    let sub: String
    let exp: Int64
    let nbf: Int64
    let video: LiveKitVideoGrant
    let name: String
}

struct IssuedLiveKitToken: Sendable {
    let token: String
    let claims: LiveKitAccessClaims
    let expiresAt: Date
    let ttlSeconds: Int
}

/// Minimal LiveKit access-token issuer. The LiveKit API secret is used only as
/// the HS256 key and is never included in claims, responses, audit, or logs.
enum LiveKitTokenService {
    static let ttlSeconds = 10 * 60

    static func issue(
        config: LiveKitConfig,
        roomID: UUID,
        memberID: UUID,
        displayName: String,
        now: Date = Date()
    ) throws -> IssuedLiveKitToken {
        let nowSeconds = Int64(now.timeIntervalSince1970)
        let expiresAt = Date(timeIntervalSince1970: TimeInterval(nowSeconds + Int64(ttlSeconds)))
        let claims = LiveKitAccessClaims(
            iss: config.apiKey,
            sub: memberID.uuidString,
            exp: nowSeconds + Int64(ttlSeconds),
            nbf: nowSeconds,
            video: LiveKitVideoGrant(
                room: roomID.uuidString,
                roomJoin: true,
                canPublish: true,
                canSubscribe: true
            ),
            name: displayName
        )
        let header = ["alg": "HS256", "typ": "JWT"]
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encodedHeader = base64URL(try encoder.encode(header))
        let encodedClaims = base64URL(try encoder.encode(claims))
        let signingInput = "\(encodedHeader).\(encodedClaims)"
        let key = SymmetricKey(data: Data(config.apiSecret.utf8))
        let signature = HMAC<SHA256>.authenticationCode(
            for: Data(signingInput.utf8), using: key
        )
        return IssuedLiveKitToken(
            token: "\(signingInput).\(base64URL(Data(signature)))",
            claims: claims,
            expiresAt: expiresAt,
            ttlSeconds: ttlSeconds
        )
    }

    static func hasValidSignature(_ token: String, secret: String) -> Bool {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let signature = base64URLData(String(parts[2])) else { return false }
        let input = "\(parts[0]).\(parts[1])"
        let key = SymmetricKey(data: Data(secret.utf8))
        return HMAC<SHA256>.isValidAuthenticationCode(
            signature, authenticating: Data(input.utf8), using: key
        )
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func base64URLData(_ value: String) -> Data? {
        var standard = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
        return Data(base64Encoded: standard)
    }
}
