import AsyncHTTPClient
import Foundation
import JWTKit
import NIOCore
import NIOFoundationCompat
import _CryptoExtras

protocol DriveBackend: Sendable {
    func searchFiles(query: String?, pageSize: Int) async throws -> JSONValue
    func fileMetadata(fileID: String) async throws -> JSONValue
    func exportText(fileID: String, maxBytes: Int) async throws -> JSONValue
}

enum DriveBackendError: Error, Equatable, Sendable {
    case unavailable
    case invalidArguments(String)
    case accessDenied
    case fileNotFound
    case unsupportedContent
    case contentTooLarge
    case upstreamFailure

    var code: String {
        switch self {
        case .unavailable: "momo.drive.backend_unavailable"
        case .invalidArguments: "momo.drive.invalid_arguments"
        case .accessDenied: "momo.drive.access_denied"
        case .fileNotFound: "momo.drive.file_not_found"
        case .unsupportedContent: "momo.drive.unsupported_content"
        case .contentTooLarge: "momo.drive.content_too_large"
        case .upstreamFailure: "momo.drive.upstream_failure"
        }
    }

    var safeMessage: String {
        switch self {
        case .unavailable:
            "Drive backend is not configured"
        case .invalidArguments(let message):
            message
        case .accessDenied:
            "Drive denied access to the requested shared-drive resource"
        case .fileNotFound:
            "Drive file was not found in the configured shared drive"
        case .unsupportedContent:
            "The requested file cannot be exported as text"
        case .contentTooLarge:
            "The exported text exceeds the configured size limit"
        case .upstreamFailure:
            "Google Drive request failed"
        }
    }
}

enum DriveBackendFactory {
    static func validateForBoot(
        environmentName: String,
        environment: [String: String]
    ) throws {
        let mode = normalizedMode(environment["MOMO_DRIVE_BACKEND"])
        if mode == "stub", AgentProviderConfig.requiresStrictExternalProvider(environmentName) {
            throw SecurityConfigurationError(errors: [
                "MOMO_DRIVE_BACKEND=stub is forbidden in \(environmentName)"
            ])
        }
    }

    static func make(
        environmentName: String,
        environment: [String: String],
        httpClient: HTTPClient
    ) async -> any DriveBackend {
        do {
            try validateForBoot(environmentName: environmentName, environment: environment)
            switch normalizedMode(environment["MOMO_DRIVE_BACKEND"]) {
            case "stub":
                return StubDriveBackend()
            case "google", "sa":
                return try await GoogleDriveSABackend.make(
                    keyPath: environment["MOMO_DRIVE_SA_KEY_PATH"],
                    sharedDriveID: environment["MOMO_DRIVE_SHARED_DRIVE_ID"],
                    httpClient: httpClient
                )
            case "":
                guard environment["MOMO_DRIVE_SA_KEY_PATH"] != nil
                        || environment["MOMO_DRIVE_SHARED_DRIVE_ID"] != nil
                else { return UnavailableDriveBackend() }
                return try await GoogleDriveSABackend.make(
                    keyPath: environment["MOMO_DRIVE_SA_KEY_PATH"],
                    sharedDriveID: environment["MOMO_DRIVE_SHARED_DRIVE_ID"],
                    httpClient: httpClient
                )
            default:
                return UnavailableDriveBackend()
            }
        } catch {
            return UnavailableDriveBackend()
        }
    }

    private static func normalizedMode(_ raw: String?) -> String {
        raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }
}

struct UnavailableDriveBackend: DriveBackend {
    func searchFiles(query _: String?, pageSize _: Int) async throws -> JSONValue {
        throw DriveBackendError.unavailable
    }

    func fileMetadata(fileID _: String) async throws -> JSONValue {
        throw DriveBackendError.unavailable
    }

    func exportText(fileID _: String, maxBytes _: Int) async throws -> JSONValue {
        throw DriveBackendError.unavailable
    }
}

/// Deterministic verifier-only backend. It is reachable only through the
/// explicit `MOMO_DRIVE_BACKEND=stub` opt-in and boot validation rejects that
/// mode in staging/prod/internal-host environments.
struct StubDriveBackend: DriveBackend {
    private static let files: [String: (name: String, mimeType: String, text: String?)] = [
        "stub-text-1": ("readme.txt", "text/plain", "momo Drive stub text"),
        "stub-doc-1": ("Team handbook", "application/vnd.google-apps.document", "momo Drive stub document"),
        "stub-json-1": ("status.json", "application/json", #"{"status":"ok"}"#),
    ]

    func searchFiles(query: String?, pageSize: Int) async throws -> JSONValue {
        let normalized = query?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matches = Self.files.keys.sorted().compactMap { id -> JSONValue? in
            guard let file = Self.files[id],
                  normalized == nil || normalized!.isEmpty || file.name.lowercased().contains(normalized!)
            else { return nil }
            return Self.metadata(id: id, file: file)
        }
        return .object([
            "files": .array(Array(matches.prefix(pageSize))),
            "nextPageToken": .null,
        ])
    }

    func fileMetadata(fileID: String) async throws -> JSONValue {
        guard let file = Self.files[fileID] else { throw DriveBackendError.fileNotFound }
        return Self.metadata(id: fileID, file: file)
    }

    func exportText(fileID: String, maxBytes: Int) async throws -> JSONValue {
        guard let file = Self.files[fileID] else { throw DriveBackendError.fileNotFound }
        guard let content = file.text else { throw DriveBackendError.unsupportedContent }
        guard content.utf8.count <= maxBytes else { throw DriveBackendError.contentTooLarge }
        return .object([
            "file": Self.metadata(id: fileID, file: file),
            "text": .string(content),
            "byteCount": .int(content.utf8.count),
            "truncated": .bool(false),
        ])
    }

    private static func metadata(
        id: String,
        file: (name: String, mimeType: String, text: String?)
    ) -> JSONValue {
        .object([
            "id": .string(id),
            "name": .string(file.name),
            "mimeType": .string(file.mimeType),
            "driveId": .string("stub-shared-drive"),
            "modifiedTime": .string("2026-07-17T00:00:00Z"),
            "webViewLink": .string("https://drive.google.com/open?id=\(id)"),
        ])
    }
}

struct GoogleDriveSABackend: DriveBackend {
    private static let driveAPIBase = "https://www.googleapis.com/drive/v3"
    private static let metadataFields = "id,name,mimeType,modifiedTime,size,webViewLink,driveId"

    let sharedDriveID: String
    let httpClient: HTTPClient
    private let tokenProvider: GoogleServiceAccountTokenProvider

    static func make(
        keyPath: String?,
        sharedDriveID: String?,
        httpClient: HTTPClient
    ) async throws -> GoogleDriveSABackend {
        guard let keyPath = nonempty(keyPath), let sharedDriveID = nonempty(sharedDriveID) else {
            throw DriveBackendError.unavailable
        }
        guard FileManager.default.isReadableFile(atPath: keyPath), validDriveID(sharedDriveID) else {
            throw DriveBackendError.unavailable
        }
        let keyData: Data
        do {
            keyData = try Data(contentsOf: URL(fileURLWithPath: keyPath), options: .mappedIfSafe)
        } catch {
            throw DriveBackendError.unavailable
        }
        let credentials: GoogleServiceAccountCredentials
        do {
            credentials = try JSONDecoder().decode(GoogleServiceAccountCredentials.self, from: keyData)
        } catch {
            throw DriveBackendError.unavailable
        }
        guard credentials.type == "service_account",
              credentials.tokenURI == "https://oauth2.googleapis.com/token",
              credentials.clientEmail.contains("@"),
              !credentials.privateKey.isEmpty
        else { throw DriveBackendError.unavailable }

        return GoogleDriveSABackend(
            sharedDriveID: sharedDriveID,
            httpClient: httpClient,
            tokenProvider: try await GoogleServiceAccountTokenProvider(
                credentials: credentials,
                httpClient: httpClient
            )
        )
    }

    func searchFiles(query: String?, pageSize: Int) async throws -> JSONValue {
        var terms = ["trashed = false"]
        if let query, !query.isEmpty {
            terms.append("fullText contains '\(Self.escapeDriveQuery(query))'")
        }
        let url = try Self.url(
            path: "/files",
            items: [
                .init(name: "corpora", value: "drive"),
                .init(name: "driveId", value: sharedDriveID),
                .init(name: "includeItemsFromAllDrives", value: "true"),
                .init(name: "supportsAllDrives", value: "true"),
                .init(name: "q", value: terms.joined(separator: " and ")),
                .init(name: "pageSize", value: String(pageSize)),
                .init(name: "fields", value: "nextPageToken,files(\(Self.metadataFields))"),
            ]
        )
        return try await executeJSON(url: url)
    }

    func fileMetadata(fileID: String) async throws -> JSONValue {
        try Self.requireFileID(fileID)
        let url = try Self.url(
            path: "/files/\(fileID)",
            items: [
                .init(name: "supportsAllDrives", value: "true"),
                .init(name: "fields", value: Self.metadataFields),
            ]
        )
        let metadata = try await executeJSON(url: url)
        guard metadata.objectValue?["driveId"]?.stringValue == sharedDriveID else {
            throw DriveBackendError.accessDenied
        }
        return metadata
    }

    func exportText(fileID: String, maxBytes: Int) async throws -> JSONValue {
        let metadata = try await fileMetadata(fileID: fileID)
        guard let mimeType = metadata.objectValue?["mimeType"]?.stringValue else {
            throw DriveBackendError.upstreamFailure
        }

        let url: URL
        if let exportMime = Self.exportMimeType(for: mimeType) {
            url = try Self.url(
                path: "/files/\(fileID)/export",
                items: [.init(name: "mimeType", value: exportMime)]
            )
        } else {
            guard Self.isTextMimeType(mimeType) else { throw DriveBackendError.unsupportedContent }
            url = try Self.url(
                path: "/files/\(fileID)",
                items: [
                    .init(name: "alt", value: "media"),
                    .init(name: "supportsAllDrives", value: "true"),
                ]
            )
        }

        let data = try await executeBytes(url: url, limit: maxBytes)
        guard let text = String(data: data, encoding: .utf8) else {
            throw DriveBackendError.unsupportedContent
        }
        return .object([
            "file": metadata,
            "text": .string(text),
            "byteCount": .int(data.count),
            "truncated": .bool(false),
        ])
    }

    private func executeJSON(url: URL) async throws -> JSONValue {
        let data = try await executeBytes(url: url, limit: 2 * 1024 * 1024)
        do {
            return try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw DriveBackendError.upstreamFailure
        }
    }

    private func executeBytes(url: URL, limit: Int) async throws -> Data {
        let token = try await tokenProvider.accessToken()
        var request = HTTPClientRequest(url: url.absoluteString)
        request.method = .GET
        request.headers.add(name: "Authorization", value: "Bearer \(token)")
        let response: HTTPClientResponse
        do {
            response = try await httpClient.execute(request, timeout: .seconds(15))
        } catch {
            throw DriveBackendError.upstreamFailure
        }
        switch response.status.code {
        case 200:
            do {
                var buffer = try await response.body.collect(upTo: limit)
                return buffer.readData(length: buffer.readableBytes) ?? Data()
            } catch {
                throw DriveBackendError.contentTooLarge
            }
        case 403:
            throw DriveBackendError.accessDenied
        case 404:
            throw DriveBackendError.fileNotFound
        default:
            throw DriveBackendError.upstreamFailure
        }
    }

    private static func url(path: String, items: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(string: driveAPIBase + path) else {
            throw DriveBackendError.upstreamFailure
        }
        components.queryItems = items
        guard let url = components.url else { throw DriveBackendError.upstreamFailure }
        return url
    }

    private static func exportMimeType(for mimeType: String) -> String? {
        switch mimeType {
        case "application/vnd.google-apps.document", "application/vnd.google-apps.presentation":
            "text/plain"
        case "application/vnd.google-apps.spreadsheet":
            "text/csv"
        default:
            nil
        }
    }

    private static func isTextMimeType(_ mimeType: String) -> Bool {
        mimeType.hasPrefix("text/") || [
            "application/json", "application/xml", "application/yaml",
            "application/x-yaml", "application/javascript",
        ].contains(mimeType)
    }

    private static func escapeDriveQuery(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
    }

    static func requireFileID(_ fileID: String) throws {
        guard fileID.wholeMatch(of: /^[A-Za-z0-9_-]{1,200}$/) != nil else {
            throw DriveBackendError.invalidArguments("fileId is invalid")
        }
    }

    private static func validDriveID(_ value: String) -> Bool {
        value.wholeMatch(of: /^[A-Za-z0-9_-]{1,200}$/) != nil
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

private struct GoogleServiceAccountCredentials: Decodable, Sendable {
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

private struct GoogleServiceAccountAssertion: JWTPayload {
    let iss: String
    let scope: String
    let aud: String
    let iat: IssuedAtClaim
    let exp: ExpirationClaim

    func verify(using _: some JWTAlgorithm) async throws {}
}

private actor GoogleServiceAccountTokenProvider {
    private let credentials: GoogleServiceAccountCredentials
    private let httpClient: HTTPClient
    private let keys: JWTKeyCollection
    private var cached: (token: String, expiresAt: Date)?

    init(credentials: GoogleServiceAccountCredentials, httpClient: HTTPClient) async throws {
        self.credentials = credentials
        self.httpClient = httpClient
        self.keys = try await JWTKeyCollection().add(
            rsa: Insecure.RSA.PrivateKey(pem: credentials.privateKey),
            digestAlgorithm: .sha256
        )
    }

    func accessToken(now: Date = Date()) async throws -> String {
        if let cached, cached.expiresAt.timeIntervalSince(now) > 60 { return cached.token }

        let assertion = GoogleServiceAccountAssertion(
            iss: credentials.clientEmail,
            scope: "https://www.googleapis.com/auth/drive.readonly",
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
        guard let form = components.percentEncodedQuery else { throw DriveBackendError.upstreamFailure }

        var request = HTTPClientRequest(url: credentials.tokenURI)
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/x-www-form-urlencoded")
        request.body = .bytes(ByteBuffer(string: form))
        let response: HTTPClientResponse
        do {
            response = try await httpClient.execute(request, timeout: .seconds(10))
        } catch {
            throw DriveBackendError.upstreamFailure
        }
        guard response.status == .ok else { throw DriveBackendError.upstreamFailure }
        let data: Data
        do {
            var buffer = try await response.body.collect(upTo: 1024 * 1024)
            data = buffer.readData(length: buffer.readableBytes) ?? Data()
        } catch {
            throw DriveBackendError.upstreamFailure
        }
        let token: GoogleAccessTokenResponse
        do {
            token = try JSONDecoder().decode(GoogleAccessTokenResponse.self, from: data)
        } catch {
            throw DriveBackendError.upstreamFailure
        }
        guard token.tokenType.lowercased() == "bearer", !token.accessToken.isEmpty else {
            throw DriveBackendError.upstreamFailure
        }
        cached = (token.accessToken, now.addingTimeInterval(TimeInterval(max(token.expiresIn, 60))))
        return token.accessToken
    }
}

private struct GoogleAccessTokenResponse: Decodable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
    }
}
