@preconcurrency import Crypto
import Foundation

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

final class WorkHostSigner: @unchecked Sendable {
    private let privateKey: Curve25519.Signing.PrivateKey

    init(rawRepresentation: Data) throws {
        privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawRepresentation)
    }

    var rawRepresentation: Data { privateKey.rawRepresentation }
    var publicKeyBase64: String {
        privateKey.publicKey.rawRepresentation.base64EncodedString()
    }

    func signatureBase64(for payload: Data) throws -> String {
        try privateKey.signature(for: payload).base64EncodedString()
    }

    func heartbeatPayload(workspaceID: UUID, hostID: UUID, sentAtMs: Int64) -> Data {
        Data(
            "momo.work_host.heartbeat.v1\n"
                .appending(workspaceID.uuidString.lowercased())
                .appending("\n")
                .appending(hostID.uuidString.lowercased())
                .appending("\n")
                .appending(String(sentAtMs))
                .utf8
        )
    }

    func requestPayload(
        method: String,
        path: String,
        workspaceID: UUID,
        hostID: UUID,
        sentAtMs: Int64,
        bodyDigest: String,
        requestID: UUID
    ) -> Data {
        Data(
            "momo.work_host.request.v2\n"
                .appending(method.uppercased())
                .appending("\n")
                .appending(path)
                .appending("\n")
                .appending(workspaceID.uuidString.lowercased())
                .appending("\n")
                .appending(hostID.uuidString.lowercased())
                .appending("\n")
                .appending(String(sentAtMs))
                .appending("\n")
                .appending(bodyDigest)
                .appending("\n")
                .appending(requestID.uuidString.lowercased())
                .utf8
        )
    }

    static func sha256Hex(_ body: Data) -> String {
        SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
    }
}

enum SecureLocalStore {
    static func loadOrCreateSigner(at url: URL) throws -> WorkHostSigner {
        try ensurePrivateDirectory(url.deletingLastPathComponent())
        if FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url)
            guard data.count == 32 else { throw WorkdFailure.keyStore }
            try setMode(0o600, at: url)
            return try WorkHostSigner(rawRepresentation: data)
        }
        let key = Curve25519.Signing.PrivateKey()
        try secureWrite(key.rawRepresentation, to: url)
        return try WorkHostSigner(rawRepresentation: key.rawRepresentation)
    }

    static func loadHostID(at url: URL) throws -> UUID? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        try setMode(0o600, at: url)
        let raw = try String(contentsOf: url, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let id = UUID(uuidString: raw) else { throw WorkdFailure.keyStore }
        return id
    }

    static func saveHostID(_ hostID: UUID, at url: URL) throws {
        try ensurePrivateDirectory(url.deletingLastPathComponent())
        try secureWrite(Data((hostID.uuidString.lowercased() + "\n").utf8), to: url)
    }

    static func readOptionalSecret(at url: URL) throws -> String? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let permissions = attributes[.posixPermissions] as? NSNumber,
              permissions.uint16Value & 0o077 == 0
        else { throw WorkdFailure.keyStore }
        let value = try String(contentsOf: url, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw WorkdFailure.keyStore }
        return value
    }

    static func removeConsumedSecret(at url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            throw WorkdFailure.keyStore
        }
    }

    static func ensurePrivateDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true
        )
        try setMode(0o700, at: url)
    }

    static func secureWrite(_ data: Data, to url: URL) throws {
        do {
            try data.write(to: url, options: .atomic)
            try setMode(0o600, at: url)
        } catch {
            throw WorkdFailure.keyStore
        }
    }

    static func setMode(_ mode: mode_t, at url: URL) throws {
        let result = url.path.withCString { chmod($0, mode) }
        guard result == 0 else { throw WorkdFailure.keyStore }
    }
}
