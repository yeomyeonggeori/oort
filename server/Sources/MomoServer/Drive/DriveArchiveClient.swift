import AsyncHTTPClient
import Foundation
import Hummingbird
import JWTKit
import NIOCore
import NIOFoundationCompat
import _CryptoExtras

struct DriveArchiveUploadSession: Sendable, Equatable {
    let driveFileID: String
    let uploadURL: String
}

struct DriveArchiveFile: Sendable, Equatable {
    let driveFileID: String
    let name: String
    let mime: String
    let sizeBytes: Int64
}

struct DriveArchiveContent: Sendable {
    let mime: String
    let sizeBytes: Int
    let body: ResponseBody
}

protocol DriveArchiveClient: Sendable {
    var acceptsStubUploads: Bool { get }
    func createResumableUpload(
        channelID: UUID,
        name: String,
        mime: String,
        sizeBytes: Int64
    ) async throws -> DriveArchiveUploadSession
    func fileMetadata(fileID: String) async throws -> DriveArchiveFile
    func fileContent(fileID: String, maxBytes: Int) async throws -> DriveArchiveContent
    func acceptStubUpload(token: String, mime: String?, bytes: Data) async throws
}

enum DriveArchiveError: Error, Equatable, Sendable {
    case unavailable
    case invalidArguments(String)
    case accessDenied
    case fileNotFound
    case contentTooLarge
    case upstreamFailure

    var safeMessage: String {
        switch self {
        case .unavailable: "Drive archive is not configured"
        case .invalidArguments(let message): message
        case .accessDenied: "Drive denied access to the workspace archive"
        case .fileNotFound: "Drive attachment was not found"
        case .contentTooLarge: "Drive attachment exceeds the allowed size"
        case .upstreamFailure: "Google Drive request failed"
        }
    }
}

enum DriveArchiveClientFactory {
    static func validateForBoot(
        environmentName: String,
        environment: [String: String]
    ) throws {
        let mode = resolvedMode(environment)
        if mode == "stub", AgentProviderConfig.requiresStrictExternalProvider(environmentName) {
            throw SecurityConfigurationError(errors: [
                "MOMO_DRIVE_ARCHIVE_BACKEND=stub is forbidden in \(environmentName)"
            ])
        }
    }

    static func make(
        environmentName: String,
        environment: [String: String],
        httpClient: HTTPClient,
        stubBaseURL: String
    ) async -> any DriveArchiveClient {
        do {
            try validateForBoot(environmentName: environmentName, environment: environment)
            switch resolvedMode(environment) {
            case "stub":
                return StubDriveArchiveClient(baseURL: stubBaseURL)
            case "google", "sa":
                return try await GoogleDriveArchiveClient.make(
                    keyPath: environment["MOMO_DRIVE_SA_KEY_PATH"],
                    sharedDriveID: environment["MOMO_DRIVE_SHARED_DRIVE_ID"],
                    httpClient: httpClient
                )
            case "":
                guard environment["MOMO_DRIVE_SA_KEY_PATH"] != nil
                        || environment["MOMO_DRIVE_SHARED_DRIVE_ID"] != nil
                else { return UnavailableDriveArchiveClient() }
                return try await GoogleDriveArchiveClient.make(
                    keyPath: environment["MOMO_DRIVE_SA_KEY_PATH"],
                    sharedDriveID: environment["MOMO_DRIVE_SHARED_DRIVE_ID"],
                    httpClient: httpClient
                )
            default:
                return UnavailableDriveArchiveClient()
            }
        } catch {
            return UnavailableDriveArchiveClient()
        }
    }

    private static func resolvedMode(_ environment: [String: String]) -> String {
        let raw = environment["MOMO_DRIVE_ARCHIVE_BACKEND"]
            ?? environment["MOMO_DRIVE_BACKEND"]
            ?? ""
        return raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct UnavailableDriveArchiveClient: DriveArchiveClient {
    let acceptsStubUploads = false
    func createResumableUpload(
        channelID _: UUID, name _: String, mime _: String, sizeBytes _: Int64
    ) async throws -> DriveArchiveUploadSession { throw DriveArchiveError.unavailable }
    func fileMetadata(fileID _: String) async throws -> DriveArchiveFile {
        throw DriveArchiveError.unavailable
    }
    func fileContent(fileID _: String, maxBytes _: Int) async throws -> DriveArchiveContent {
        throw DriveArchiveError.unavailable
    }
    func acceptStubUpload(token _: String, mime _: String?, bytes _: Data) async throws {
        throw DriveArchiveError.fileNotFound
    }
}

/// Deterministic verifier-only Drive archive. The upload URL is deliberately
/// uncredentialed like Google's resumable session URL, but contains a random
/// capability token and is unreachable when the stub is not selected.
actor StubDriveArchiveClient: DriveArchiveClient {
    nonisolated let acceptsStubUploads = true
    private struct Pending: Sendable {
        let fileID: String
        let name: String
        let mime: String
        let sizeBytes: Int64
        var bytes: Data?
    }

    private let baseURL: String
    private var sessions: [String: Pending] = [:]
    private var fileToken: [String: String] = [:]

    init(baseURL: String) {
        self.baseURL = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    func createResumableUpload(
        channelID _: UUID,
        name: String,
        mime: String,
        sizeBytes: Int64
    ) async throws -> DriveArchiveUploadSession {
        let token = UUID().uuidString.lowercased()
        let fileID = "stub-\(UUID().uuidString.lowercased())"
        sessions[token] = Pending(
            fileID: fileID, name: name, mime: mime, sizeBytes: sizeBytes, bytes: nil
        )
        fileToken[fileID] = token
        return DriveArchiveUploadSession(
            driveFileID: fileID,
            uploadURL: "\(baseURL)/__momo_stub/drive/uploads/\(token)"
        )
    }

    func acceptStubUpload(token: String, mime: String?, bytes: Data) async throws {
        guard var pending = sessions[token] else { throw DriveArchiveError.fileNotFound }
        guard Int64(bytes.count) == pending.sizeBytes else {
            throw DriveArchiveError.invalidArguments("uploaded size does not match the session")
        }
        if let mime, !mime.isEmpty, mime != pending.mime {
            throw DriveArchiveError.invalidArguments("uploaded mime does not match the session")
        }
        pending.bytes = bytes
        sessions[token] = pending
    }

    func fileMetadata(fileID: String) async throws -> DriveArchiveFile {
        guard let token = fileToken[fileID], let pending = sessions[token], pending.bytes != nil else {
            throw DriveArchiveError.fileNotFound
        }
        return DriveArchiveFile(
            driveFileID: fileID,
            name: pending.name,
            mime: pending.mime,
            sizeBytes: pending.sizeBytes
        )
    }

    func fileContent(fileID: String, maxBytes: Int) async throws -> DriveArchiveContent {
        guard let token = fileToken[fileID],
              let pending = sessions[token],
              let bytes = pending.bytes
        else { throw DriveArchiveError.fileNotFound }
        guard bytes.count <= maxBytes else { throw DriveArchiveError.contentTooLarge }
        return DriveArchiveContent(
            mime: pending.mime,
            sizeBytes: bytes.count,
            body: ResponseBody(byteBuffer: ByteBuffer(data: bytes))
        )
    }
}

struct GoogleDriveArchiveClient: DriveArchiveClient {
    let acceptsStubUploads = false
    private enum ArchiveMethod { case get, post }
    private static let driveAPIBase = "https://www.googleapis.com/drive/v3"
    private static let uploadAPIBase = "https://www.googleapis.com/upload/drive/v3"
    private static let folderMime = "application/vnd.google-apps.folder"

    let sharedDriveID: String
    let httpClient: HTTPClient
    private let tokenProvider: DriveArchiveTokenProvider
    private let folderCache: DriveArchiveFolderCache

    static func make(
        keyPath: String?,
        sharedDriveID: String?,
        httpClient: HTTPClient
    ) async throws -> GoogleDriveArchiveClient {
        guard let keyPath = nonempty(keyPath), let sharedDriveID = nonempty(sharedDriveID),
              validDriveID(sharedDriveID), FileManager.default.isReadableFile(atPath: keyPath)
        else { throw DriveArchiveError.unavailable }
        let data: Data
        do {
            data = try Data(contentsOf: URL(fileURLWithPath: keyPath), options: .mappedIfSafe)
        } catch { throw DriveArchiveError.unavailable }
        let credentials: DriveArchiveCredentials
        do {
            credentials = try JSONDecoder().decode(DriveArchiveCredentials.self, from: data)
        } catch { throw DriveArchiveError.unavailable }
        guard credentials.type == "service_account",
              credentials.tokenURI == "https://oauth2.googleapis.com/token",
              credentials.clientEmail.contains("@"),
              !credentials.privateKey.isEmpty
        else { throw DriveArchiveError.unavailable }
        return GoogleDriveArchiveClient(
            sharedDriveID: sharedDriveID,
            httpClient: httpClient,
            tokenProvider: try await DriveArchiveTokenProvider(
                credentials: credentials, httpClient: httpClient
            ),
            folderCache: DriveArchiveFolderCache()
        )
    }

    func createResumableUpload(
        channelID: UUID,
        name: String,
        mime: String,
        sizeBytes: Int64
    ) async throws -> DriveArchiveUploadSession {
        let parentID = try await channelFolderID(channelID: channelID)
        let fileID = try await generateFileID()
        let metadata: [String: Any] = [
            "id": fileID,
            "name": name,
            "parents": [parentID],
            "mimeType": mime,
        ]
        let body = try JSONSerialization.data(withJSONObject: metadata)
        let url = try Self.url(
            base: Self.uploadAPIBase,
            path: "/files",
            items: [
                .init(name: "uploadType", value: "resumable"),
                .init(name: "supportsAllDrives", value: "true"),
            ]
        )
        var request = try await authorizedRequest(url: url, method: .post)
        request.headers.add(name: "Content-Type", value: "application/json; charset=UTF-8")
        request.headers.add(name: "X-Upload-Content-Type", value: mime)
        request.headers.add(name: "X-Upload-Content-Length", value: String(sizeBytes))
        request.body = .bytes(ByteBuffer(data: body))
        let response = try await execute(request, timeoutSeconds: 15)
        guard response.status.code == 200,
              let location = response.headers.first(name: "Location"),
              location.hasPrefix("https://www.googleapis.com/")
        else { throw Self.mappedError(response.status.code) }
        return DriveArchiveUploadSession(driveFileID: fileID, uploadURL: location)
    }

    func fileMetadata(fileID: String) async throws -> DriveArchiveFile {
        try Self.requireFileID(fileID)
        let url = try Self.url(
            base: Self.driveAPIBase,
            path: "/files/\(fileID)",
            items: [
                .init(name: "supportsAllDrives", value: "true"),
                .init(name: "fields", value: "id,name,mimeType,size,driveId,trashed"),
            ]
        )
        let object = try await executeJSON(url: url, method: .get, body: nil)
        guard let values = object.objectValue,
              values["driveId"]?.stringValue == sharedDriveID,
              values["trashed"] != .bool(true),
              let id = values["id"]?.stringValue,
              let name = values["name"]?.stringValue,
              let mime = values["mimeType"]?.stringValue,
              let sizeString = values["size"]?.stringValue,
              let size = Int64(sizeString)
        else { throw DriveArchiveError.accessDenied }
        return DriveArchiveFile(driveFileID: id, name: name, mime: mime, sizeBytes: size)
    }

    func fileContent(fileID: String, maxBytes: Int) async throws -> DriveArchiveContent {
        let metadata = try await fileMetadata(fileID: fileID)
        let url = try Self.url(
            base: Self.driveAPIBase,
            path: "/files/\(fileID)",
            items: [
                .init(name: "alt", value: "media"),
                .init(name: "supportsAllDrives", value: "true"),
            ]
        )
        let request = try await authorizedRequest(url: url, method: .get)
        let response = try await execute(request, timeoutSeconds: 60)
        guard response.status.code == 200 else { throw Self.mappedError(response.status.code) }
        guard metadata.sizeBytes <= Int64(maxBytes),
              let contentLength = Int(exactly: metadata.sizeBytes)
        else { throw DriveArchiveError.contentTooLarge }
        let upstreamBody = response.body
        let body = ResponseBody(contentLength: contentLength) { writer in
            var received = 0
            for try await buffer in upstreamBody {
                received += buffer.readableBytes
                guard received <= maxBytes else { throw DriveArchiveError.contentTooLarge }
                try await writer.write(buffer)
            }
            try await writer.finish(nil)
        }
        return DriveArchiveContent(mime: metadata.mime, sizeBytes: contentLength, body: body)
    }

    func acceptStubUpload(token _: String, mime _: String?, bytes _: Data) async throws {
        throw DriveArchiveError.fileNotFound
    }

    private func channelFolderID(channelID: UUID) async throws -> String {
        if let cached = await folderCache.value(for: channelID) { return cached }
        let channelsID = try await findOrCreateFolder(name: "channels", parentID: sharedDriveID)
        let folderID = try await findOrCreateFolder(
            name: channelID.uuidString.lowercased(), parentID: channelsID
        )
        await folderCache.set(folderID, for: channelID)
        return folderID
    }

    private func findOrCreateFolder(name: String, parentID: String) async throws -> String {
        let escapedName = Self.escapeQuery(name)
        let escapedParent = Self.escapeQuery(parentID)
        let query = "name = '\(escapedName)' and '\(escapedParent)' in parents and mimeType = '\(Self.folderMime)' and trashed = false"
        let searchURL = try Self.url(
            base: Self.driveAPIBase,
            path: "/files",
            items: [
                .init(name: "corpora", value: "drive"),
                .init(name: "driveId", value: sharedDriveID),
                .init(name: "includeItemsFromAllDrives", value: "true"),
                .init(name: "supportsAllDrives", value: "true"),
                .init(name: "q", value: query),
                .init(name: "pageSize", value: "1"),
                .init(name: "fields", value: "files(id)"),
            ]
        )
        let found = try await executeJSON(url: searchURL, method: .get, body: nil)
        if let files = found.objectValue?["files"]?.arrayValue,
           let id = files.first?.objectValue?["id"]?.stringValue
        {
            return id
        }
        let createURL = try Self.url(
            base: Self.driveAPIBase,
            path: "/files",
            items: [
                .init(name: "supportsAllDrives", value: "true"),
                .init(name: "fields", value: "id"),
            ]
        )
        let body = try JSONSerialization.data(withJSONObject: [
            "name": name, "parents": [parentID], "mimeType": Self.folderMime,
        ])
        let created = try await executeJSON(url: createURL, method: .post, body: body)
        guard let id = created.objectValue?["id"]?.stringValue else {
            throw DriveArchiveError.upstreamFailure
        }
        return id
    }

    private func generateFileID() async throws -> String {
        let url = try Self.url(
            base: Self.driveAPIBase,
            path: "/files/generateIds",
            items: [.init(name: "count", value: "1"), .init(name: "space", value: "drive")]
        )
        let object = try await executeJSON(url: url, method: .get, body: nil)
        guard let id = object.objectValue?["ids"]?.arrayValue?.first?.stringValue else {
            throw DriveArchiveError.upstreamFailure
        }
        return id
    }

    private func executeJSON(
        url: URL,
        method: ArchiveMethod,
        body: Data?
    ) async throws -> JSONValue {
        var request = try await authorizedRequest(url: url, method: method)
        if let body {
            request.headers.add(name: "Content-Type", value: "application/json; charset=UTF-8")
            request.body = .bytes(ByteBuffer(data: body))
        }
        let response = try await execute(request, timeoutSeconds: 15)
        guard (200..<300).contains(response.status.code) else {
            throw Self.mappedError(response.status.code)
        }
        let data: Data
        do {
            var buffer = try await response.body.collect(upTo: 2 * 1024 * 1024)
            data = buffer.readData(length: buffer.readableBytes) ?? Data()
        } catch { throw DriveArchiveError.upstreamFailure }
        guard let object = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            throw DriveArchiveError.upstreamFailure
        }
        return object
    }

    private func authorizedRequest(
        url: URL,
        method: ArchiveMethod
    ) async throws -> HTTPClientRequest {
        let token = try await tokenProvider.accessToken()
        var request = HTTPClientRequest(url: url.absoluteString)
        switch method {
        case .get: request.method = .GET
        case .post: request.method = .POST
        }
        request.headers.add(name: "Authorization", value: "Bearer \(token)")
        return request
    }

    private func execute(
        _ request: HTTPClientRequest,
        timeoutSeconds: Int64
    ) async throws -> HTTPClientResponse {
        do {
            return try await httpClient.execute(request, timeout: .seconds(timeoutSeconds))
        } catch { throw DriveArchiveError.upstreamFailure }
    }

    private static func mappedError(_ status: UInt) -> DriveArchiveError {
        switch status {
        case 403: .accessDenied
        case 404: .fileNotFound
        default: .upstreamFailure
        }
    }

    private static func url(base: String, path: String, items: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(string: base + path) else {
            throw DriveArchiveError.upstreamFailure
        }
        components.queryItems = items
        guard let url = components.url else { throw DriveArchiveError.upstreamFailure }
        return url
    }

    private static func escapeQuery(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
    }

    private static func requireFileID(_ fileID: String) throws {
        guard fileID.wholeMatch(of: /^[A-Za-z0-9_-]{1,200}$/) != nil else {
            throw DriveArchiveError.invalidArguments("Drive file id is invalid")
        }
    }

    private static func validDriveID(_ value: String) -> Bool {
        value.wholeMatch(of: /^[A-Za-z0-9_-]{1,200}$/) != nil
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

private actor DriveArchiveFolderCache {
    private var values: [UUID: String] = [:]
    func value(for channelID: UUID) -> String? { values[channelID] }
    func set(_ value: String, for channelID: UUID) { values[channelID] = value }
}

private struct DriveArchiveCredentials: Decodable, Sendable {
    let type: String
    let clientEmail: String
    let privateKey: String
    let tokenURI: String

    enum CodingKeys: String, CodingKey {
        case type
        case clientEmail = "client_email"
        case privateKey = "private_key"
        case tokenURI = "token_uri"
    }
}

private struct DriveArchiveAssertion: JWTPayload {
    let iss: String
    let scope: String
    let aud: String
    let iat: IssuedAtClaim
    let exp: ExpirationClaim
    func verify(using _: some JWTAlgorithm) async throws {}
}

private actor DriveArchiveTokenProvider {
    private let credentials: DriveArchiveCredentials
    private let httpClient: HTTPClient
    private let keys: JWTKeyCollection
    private var cached: (token: String, expiresAt: Date)?

    init(credentials: DriveArchiveCredentials, httpClient: HTTPClient) async throws {
        self.credentials = credentials
        self.httpClient = httpClient
        self.keys = try await JWTKeyCollection().add(
            rsa: Insecure.RSA.PrivateKey(pem: credentials.privateKey),
            digestAlgorithm: .sha256
        )
    }

    func accessToken(now: Date = Date()) async throws -> String {
        if let cached, cached.expiresAt.timeIntervalSince(now) > 60 { return cached.token }
        let assertion = DriveArchiveAssertion(
            iss: credentials.clientEmail,
            scope: "https://www.googleapis.com/auth/drive.file",
            aud: credentials.tokenURI,
            iat: .init(value: now),
            exp: .init(value: now.addingTimeInterval(3600))
        )
        let signed = try await keys.sign(assertion)
        var components = URLComponents()
        components.queryItems = [
            .init(name: "grant_type", value: "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            .init(name: "assertion", value: signed),
        ]
        guard let form = components.percentEncodedQuery else {
            throw DriveArchiveError.upstreamFailure
        }
        var request = HTTPClientRequest(url: credentials.tokenURI)
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/x-www-form-urlencoded")
        request.body = .bytes(ByteBuffer(string: form))
        let response: HTTPClientResponse
        do {
            response = try await httpClient.execute(request, timeout: .seconds(10))
        } catch { throw DriveArchiveError.upstreamFailure }
        guard response.status.code == 200 else { throw DriveArchiveError.upstreamFailure }
        let data: Data
        do {
            var buffer = try await response.body.collect(upTo: 1024 * 1024)
            data = buffer.readData(length: buffer.readableBytes) ?? Data()
        } catch { throw DriveArchiveError.upstreamFailure }
        guard let token = try? JSONDecoder().decode(DriveArchiveAccessToken.self, from: data),
              token.tokenType.lowercased() == "bearer", !token.accessToken.isEmpty
        else { throw DriveArchiveError.upstreamFailure }
        cached = (token.accessToken, now.addingTimeInterval(TimeInterval(max(token.expiresIn, 60))))
        return token.accessToken
    }
}

private struct DriveArchiveAccessToken: Decodable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int
    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
    }
}
