import CryptoKit
import Darwin
import Foundation
import MomoCore

final class MomoWorkHostSigner: @unchecked Sendable {
    private let privateKey: Curve25519.Signing.PrivateKey

    private init(privateKey: Curve25519.Signing.PrivateKey) {
        self.privateKey = privateKey
    }

    init(rawRepresentation: Data) throws {
        privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawRepresentation)
    }

    static func generate() -> MomoWorkHostSigner {
        MomoWorkHostSigner(privateKey: Curve25519.Signing.PrivateKey())
    }

    fileprivate var privateKeyFileData: Data { privateKey.rawRepresentation }

    var publicKeyBase64: String {
        privateKey.publicKey.rawRepresentation.base64EncodedString()
    }

    func signatureBase64(for payload: Data) throws -> String {
        try privateKey.signature(for: payload).base64EncodedString()
    }

    static func heartbeatPayload(
        workspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64
    ) -> Data {
        Data(
            "momo.work_host.heartbeat.v1\n"
                .appending(workspace.description.lowercased())
                .appending("\n")
                .appending(host.description.lowercased())
                .appending("\n")
                .appending(String(sentAtMs))
                .utf8
        )
    }

    static func requestPayload(
        method: String,
        path: String,
        workspace: WorkspaceID,
        host: WorkHostID,
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
                .appending(workspace.description.lowercased())
                .appending("\n")
                .appending(host.description.lowercased())
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

struct MomoWorkHostIdentityStore: Sendable {
    private let baseDirectory: URL

    init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
    }

    static func applicationSupport(
        fileManager: FileManager = .default
    ) -> MomoWorkHostIdentityStore? {
        guard let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else { return nil }
        return MomoWorkHostIdentityStore(
            baseDirectory: applicationSupport
                .appendingPathComponent("momo", isDirectory: true)
                .appendingPathComponent("work-hosts", isDirectory: true)
        )
    }

    func loadOrCreateSigner(workspace: WorkspaceID) throws -> MomoWorkHostSigner {
        let url = identityURL(workspace: workspace)
        try ensurePrivateDirectory(url.deletingLastPathComponent())
        if FileManager.default.fileExists(atPath: url.path) {
            do {
                try setMode(0o600, at: url)
                let data = try Data(contentsOf: url)
                guard data.count == 32 else {
                    throw MomoWorkConsoleError.hostIdentityUnavailable
                }
                return try MomoWorkHostSigner(rawRepresentation: data)
            } catch let issue as MomoWorkConsoleError {
                throw issue
            } catch {
                throw MomoWorkConsoleError.hostIdentityUnavailable
            }
        }

        let signer = MomoWorkHostSigner.generate()
        try secureWrite(signer.privateKeyFileData, to: url)
        return signer
    }

    func loadHostID(workspace: WorkspaceID) throws -> WorkHostID? {
        let url = hostIDURL(workspace: workspace)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            try setMode(0o600, at: url)
            let value = try String(contentsOf: url, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return WorkHostID(uuidString: value)
        } catch let issue as MomoWorkConsoleError {
            throw issue
        } catch {
            throw MomoWorkConsoleError.hostIdentityUnavailable
        }
    }

    func saveHostID(_ host: WorkHostID, workspace: WorkspaceID) throws {
        let url = hostIDURL(workspace: workspace)
        try ensurePrivateDirectory(url.deletingLastPathComponent())
        try secureWrite(Data((host.description.lowercased() + "\n").utf8), to: url)
    }

    func workspaceDirectory(workspace: WorkspaceID) -> URL {
        baseDirectory.appendingPathComponent(workspace.description.lowercased(), isDirectory: true)
    }

    func identityURL(workspace: WorkspaceID) -> URL {
        workspaceDirectory(workspace: workspace).appendingPathComponent("identity.key")
    }

    func hostIDURL(workspace: WorkspaceID) -> URL {
        workspaceDirectory(workspace: workspace).appendingPathComponent("host.id")
    }

    private func ensurePrivateDirectory(_ url: URL) throws {
        do {
            try FileManager.default.createDirectory(
                at: url,
                withIntermediateDirectories: true
            )
            try setMode(0o700, at: url)
        } catch {
            throw MomoWorkConsoleError.hostIdentityUnavailable
        }
    }

    private func secureWrite(_ data: Data, to url: URL) throws {
        let temporaryURL = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let descriptor = temporaryURL.path.withCString {
            open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        }
        guard descriptor >= 0 else { throw MomoWorkConsoleError.hostIdentityUnavailable }
        var shouldRemoveTemporaryFile = true
        defer {
            close(descriptor)
            if shouldRemoveTemporaryFile {
                temporaryURL.path.withCString { _ = unlink($0) }
            }
        }

        do {
            try data.withUnsafeBytes { buffer in
                guard let baseAddress = buffer.baseAddress else { return }
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(
                        descriptor,
                        baseAddress.advanced(by: offset),
                        buffer.count - offset
                    )
                    guard count > 0 else {
                        throw MomoWorkConsoleError.hostIdentityUnavailable
                    }
                    offset += count
                }
            }
            guard fsync(descriptor) == 0 else {
                throw MomoWorkConsoleError.hostIdentityUnavailable
            }
            let renameResult = temporaryURL.path.withCString { temporaryPath in
                url.path.withCString { destinationPath in
                    rename(temporaryPath, destinationPath)
                }
            }
            guard renameResult == 0 else {
                throw MomoWorkConsoleError.hostIdentityUnavailable
            }
            shouldRemoveTemporaryFile = false
            try setMode(0o600, at: url)
        } catch let issue as MomoWorkConsoleError {
            throw issue
        } catch {
            throw MomoWorkConsoleError.hostIdentityUnavailable
        }
    }

    private func setMode(_ mode: mode_t, at url: URL) throws {
        let result = url.path.withCString { chmod($0, mode) }
        guard result == 0 else { throw MomoWorkConsoleError.hostIdentityUnavailable }
    }
}

actor MomoWorkHostRegistrar {
    private let identityStore: MomoWorkHostIdentityStore?
    private var signers: [WorkspaceID: MomoWorkHostSigner] = [:]

    init(identityStore: MomoWorkHostIdentityStore? = .applicationSupport()) {
        self.identityStore = identityStore
    }

    func reconcile(
        workspace: WorkspaceID,
        member: MemberID,
        displayName: String,
        capabilities: [String: Bool],
        backend: any MomoWorkHostBackend
    ) async throws -> WorkHost {
        guard let identityStore else { throw MomoWorkConsoleError.hostIdentityUnavailable }
        let signer = try identityStore.loadOrCreateSigner(workspace: workspace)
        signers[workspace] = signer
        let persistedHostID = try identityStore.loadHostID(workspace: workspace)

        let hosts: [WorkHost]
        do {
            hosts = try await backend.workHosts(workspace: workspace)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MomoWorkConsoleError.hostRegistrationFailed
        }

        let activeMatches = hosts.filter {
            $0.workspaceId == workspace
                && $0.ownerMemberId == member
                && $0.publicKey == signer.publicKeyBase64
                && $0.momoIsActiveAppHost
        }
        if let existing = activeMatches.first(where: { $0.id == persistedHostID })
            ?? activeMatches.first {
            try identityStore.saveHostID(existing.id, workspace: workspace)
            return existing
        }

        let registered: WorkHost
        do {
            registered = try await backend.registerWorkHost(
                workspace: workspace,
                displayName: Self.normalizedDisplayName(displayName),
                publicKey: signer.publicKeyBase64,
                capabilities: capabilities
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MomoWorkConsoleError.hostRegistrationFailed
        }
        guard registered.workspaceId == workspace,
              registered.ownerMemberId == member,
              registered.publicKey == signer.publicKeyBase64,
              registered.momoIsActiveAppHost
        else { throw MomoWorkConsoleError.hostRegistrationFailed }
        try identityStore.saveHostID(registered.id, workspace: workspace)
        return registered
    }

    func heartbeat(
        workspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        backend: any MomoWorkHostBackend
    ) async throws -> WorkHost {
        guard let identityStore else { throw MomoWorkConsoleError.hostIdentityUnavailable }
        let signer: MomoWorkHostSigner
        if let cached = signers[workspace] {
            signer = cached
        } else {
            signer = try identityStore.loadOrCreateSigner(workspace: workspace)
            signers[workspace] = signer
        }
        let payload = MomoWorkHostSigner.heartbeatPayload(
            workspace: workspace,
            host: host,
            sentAtMs: sentAtMs
        )
        let signature = try signer.signatureBase64(for: payload)
        return try await backend.heartbeatWorkHost(
            workspace: workspace,
            host: host,
            sentAtMs: sentAtMs,
            signature: signature
        )
    }

    func enabledToolProfiles(
        workspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        backend: any MomoWorkHostBackend
    ) async throws -> [MomoWorkToolProfile] {
        guard let identityStore else { throw MomoWorkConsoleError.hostIdentityUnavailable }
        let signer: MomoWorkHostSigner
        if let cached = signers[workspace] {
            signer = cached
        } else {
            signer = try identityStore.loadOrCreateSigner(workspace: workspace)
            signers[workspace] = signer
        }
        let path = "/v1/workspaces/\(workspace.description)/work-tool-profiles"
        let requestID = UUID()
        let payload = MomoWorkHostSigner.requestPayload(
            method: "GET",
            path: path,
            workspace: workspace,
            host: host,
            sentAtMs: sentAtMs,
            bodyDigest: MomoWorkHostSigner.sha256Hex(Data()),
            requestID: requestID
        )
        let signature = try signer.signatureBase64(for: payload)
        let profiles = try await backend.enabledWorkToolProfiles(
            workspace: workspace,
            host: host,
            sentAtMs: sentAtMs,
            requestID: requestID,
            signature: signature
        )
        guard profiles.allSatisfy({ $0.workspaceId == workspace && $0.enabled }) else {
            throw MomoWorkConsoleError.toolProfileUnavailable
        }
        return profiles
    }

    private static func normalizedDisplayName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = trimmed.isEmpty ? "oort for Mac" : trimmed
        return String(fallback.prefix(80))
    }
}
