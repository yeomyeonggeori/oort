// @preconcurrency: Linux swift-crypto exposes `SymmetricKey`/`SealedBox` as
// non-Sendable, unlike Apple CryptoKit. The worker builds on Linux containers,
// so the import is annotated to keep the v6 concurrency checker green (matches
// NotifierWorker/WorkHostDaemon — 562 Linux verifier contract).
@preconcurrency import Crypto
import Foundation

/// Worker-side copy of the ADR-0004 증보 1 provider bearer decryption
/// (MOMO-573 / P-1b).
///
/// **DRIFT INVARIANT — this MUST stay byte-identical with the server copy at
/// `server/Sources/MomoServer/Provider/ProviderLinkCrypto.swift`.** The server
/// (`momo_app`) seals the bearer on the REST PUT path; the worker (`momo_worker`,
/// BYPASSRLS) reads and opens it at job time. If the key-derivation string
/// (`"momo.provider_link.key.v1\n"`), the sealed-box version byte (`0x01`), or the
/// AES-GCM combined framing (nonce(12) || ciphertext || tag(16)) diverge between
/// the two, the worker silently fails to decrypt and falls back to env — which is
/// exactly the bug this ticket closes. The two live as separate copies (rather
/// than a shared module) because the server and worker are independent SwiftPM
/// packages whose e2e/prod images copy source subtrees selectively; a shared
/// `services/*` package would have to be threaded through every compose copy-list.
/// Every other worker (NotifierWorker/WorkHostDaemon) already owns its crypto the
/// same way. Any change here or on the server side must be mirrored on the other.
///
/// The plaintext bearer lives only transiently in memory on the decrypt boundary
/// — it never enters logs, agent_job payloads, Context Packets, audit rows, or
/// gate evidence (ADR-0004 Rules #2 / #5).
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
    /// (combined = nonce(12) || ciphertext || tag(16)). Present so the worker
    /// test suite can round-trip and pin a golden interop vector; the runtime
    /// path only uses `open`.
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
}
