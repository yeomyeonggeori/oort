@preconcurrency import Crypto
import Foundation

/// Reversible symmetric encryption for the ADR-0004 증보 1 provider bearer.
///
/// Unlike `WebhookCrypto` — which derives *deterministic* HMAC secrets that oort
/// itself generates and never needs to recover — the provider bearer is an opaque
/// operator-supplied value we must store and later replay as an `Authorization`
/// header. That requires authenticated, reversible encryption (AES-GCM).
///
/// The key is domain-separated from every other master key: it is derived from a
/// dedicated `PROVIDER_LINK_MASTER_KEY` and must never reuse
/// `OUTBOUND_WEBHOOK_MASTER_KEY` or `JWT_HMAC` (enforced in `Config`). The
/// plaintext bearer lives only transiently in memory on the encrypt/decrypt
/// boundary — it never enters logs, Context Packets, audit rows, or gate evidence
/// (ADR-0004 Rules #2 / #5).
enum ProviderLinkCrypto {
    /// Sealed-box format version. Byte 0 of the stored `bytea`.
    static let version: UInt8 = 0x01

    enum CryptoError: Error, Equatable {
        case emptyPlaintext
        case badVersion
        case malformedCiphertext
        case invalidUTF8
    }

    /// 256-bit key derived from the operator master key, domain-separated so a
    /// leak of one master key never cross-contaminates the webhook signing keys.
    static func symmetricKey(masterKey: String) -> SymmetricKey {
        let material = Data("momo.provider_link.key.v1\n\(masterKey)".utf8)
        let digest = SHA256.hash(data: material)
        return SymmetricKey(data: Data(digest))
    }

    /// Encrypt a plaintext bearer. Returns `version || AES-GCM combined`
    /// (combined = nonce(12) || ciphertext || tag(16)).
    static func seal(_ plaintext: String, masterKey: String) throws -> Data {
        let trimmed = plaintext.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw CryptoError.emptyPlaintext }
        let key = symmetricKey(masterKey: masterKey)
        let sealed = try AES.GCM.seal(Data(trimmed.utf8), using: key)
        guard let combined = sealed.combined else {
            throw CryptoError.malformedCiphertext
        }
        var out = Data([version])
        out.append(combined)
        return out
    }

    /// Decrypt a stored ciphertext back to the plaintext bearer.
    static func open(_ ciphertext: Data, masterKey: String) throws -> String {
        guard let first = ciphertext.first else { throw CryptoError.malformedCiphertext }
        guard first == version else { throw CryptoError.badVersion }
        let body = ciphertext.dropFirst()
        // nonce(12) + tag(16) = 28 bytes of framing minimum.
        guard body.count > 28 else { throw CryptoError.malformedCiphertext }
        let key = symmetricKey(masterKey: masterKey)
        let box = try AES.GCM.SealedBox(combined: Data(body))
        let opened = try AES.GCM.open(box, using: key)
        guard let string = String(data: opened, encoding: .utf8) else {
            throw CryptoError.invalidUTF8
        }
        return string
    }

    /// Non-secret masked tail for the GET surface. Returns at most the last four
    /// characters; shorter secrets are fully masked so we never leak a whole
    /// short token (ADR-0004: re-exposure is forbidden beyond the masked tail).
    static func maskedTail(_ bearer: String) -> String? {
        let trimmed = bearer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 8 else { return nil }
        return String(trimmed.suffix(4))
    }
}
