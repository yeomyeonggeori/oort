@preconcurrency import Crypto
import Foundation

/// Cryptographic primitives for ADR-0115 webhook ingress.
///
/// Native secrets are deterministic only from `(server master key, secretRef)`.
/// The database stores the random reference, never the derived secret. Slack
/// URL tokens are independently random and only their SHA-256 digest is stored.
enum WebhookCrypto {
    static let nativeSecretPrefix = "momo_whsec_v1"
    static let outboundSecretPrefix = "momo_evtsec_v1"
    static let slackTokenPrefix = "momo_hook_v1"

    static func randomReference() -> String {
        base64URL(randomBytes(count: 32))
    }

    static func nativeSecret(masterKey: String, secretRef: String) -> String {
        let key = SymmetricKey(data: Data(masterKey.utf8))
        let material = Data("momo.webhook.native.v1\n\(secretRef)".utf8)
        let code = HMAC<SHA256>.authenticationCode(for: material, using: key)
        return "\(nativeSecretPrefix).\(base64URL(Data(code)))"
    }

    static func outboundSecret(masterKey: String, secretRef: String) -> String {
        let key = SymmetricKey(data: Data(masterKey.utf8))
        let material = Data("momo.webhook.outbound.v1\n\(secretRef)".utf8)
        let code = HMAC<SHA256>.authenticationCode(for: material, using: key)
        return "\(outboundSecretPrefix).\(base64URL(Data(code)))"
    }

    static func slackToken(workspaceID: UUID) -> String {
        "\(slackTokenPrefix).\(workspaceID.uuidString.lowercased()).\(randomReference())"
    }

    static func workspaceID(fromSlackToken token: String) -> UUID? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0] == Substring(slackTokenPrefix),
              parts[2].count == 43
        else { return nil }
        return UUID(uuidString: String(parts[1]))
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func tokenHash(_ token: String) -> String {
        "sha256:\(sha256Hex(Data(token.utf8)))"
    }

    static func signature(secret: String, base: String) -> String {
        let key = SymmetricKey(data: Data(secret.utf8))
        let code = HMAC<SHA256>.authenticationCode(for: Data(base.utf8), using: key)
        return Data(code).map { String(format: "%02x", $0) }.joined()
    }

    static func canonicalSignatureBase(
        workspaceID: UUID,
        installationID: UUID,
        timestamp: String,
        deliveryID: String,
        bodySHA256: String
    ) -> String {
        let workspace = workspaceID.uuidString.lowercased()
        let installation = installationID.uuidString.lowercased()
        return [
            "v1",
            "POST",
            "/v1/webhooks/\(workspace)/\(installation)",
            installation,
            timestamp,
            deliveryID,
            bodySHA256,
        ].joined(separator: "\n")
    }

    static func deterministicClientMessageID(_ components: [String]) -> UUID {
        var bytes = Array(SHA256.hash(data: Data(components.joined(separator: "\n").utf8)).prefix(16))
        // RFC 4122-compatible UUID envelope. The value is an idempotency key,
        // not a claim that SHA-256 is the UUIDv5 algorithm.
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let formatted = "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-\(hex.dropFirst(12).prefix(4))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20))"
        return UUID(uuidString: formatted)!
    }

    private static func randomBytes(count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
