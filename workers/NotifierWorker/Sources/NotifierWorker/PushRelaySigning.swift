import Crypto
import Foundation

/// Ed25519 signing material for the Dawn PushRelay request boundary. Key bytes
/// are loaded once at boot and are never logged.
struct PushRelayRequestSigner: Sendable {
    private let privateKey: Curve25519.Signing.PrivateKey

    init(path: String) throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        privateKey = try Curve25519.Signing.PrivateKey(
            rawRepresentation: Self.rawSeed(from: data)
        )
    }

    init(rawSeed: Data) throws {
        privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawSeed)
    }

    func signatureBase64(for body: Data) throws -> String {
        try privateKey.signature(for: body).base64EncodedString()
    }

    /// OpenSSL `genpkey -algorithm ED25519` emits RFC 8410 PKCS#8:
    /// `302e020100300506032b657004220420 || 32-byte seed`.
    /// Raw 32-byte seeds are accepted for operators using an HSM/export tool.
    private static func rawSeed(from fileData: Data) throws -> Data {
        if fileData.count == 32 { return fileData }
        guard let text = String(data: fileData, encoding: .utf8),
              let begin = text.range(of: "-----BEGIN PRIVATE KEY-----"),
              let end = text.range(of: "-----END PRIVATE KEY-----")
        else { throw PushRelaySigningError.invalidPrivateKey }
        let base64 = text[begin.upperBound..<end.lowerBound]
            .filter { !$0.isWhitespace }
        guard let der = Data(base64Encoded: String(base64)) else {
            throw PushRelaySigningError.invalidPrivateKey
        }
        let prefix = Data([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
                           0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
        guard der.count == prefix.count + 32, der.starts(with: prefix) else {
            throw PushRelaySigningError.invalidPrivateKey
        }
        return der.suffix(32)
    }
}

enum PushRelaySigningError: Error {
    case invalidPrivateKey
}
