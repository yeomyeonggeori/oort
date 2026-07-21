import AsyncHTTPClient
import Crypto
import Foundation

struct S3ArchiveConfiguration: Sendable, Equatable {
    let endpoint: URL
    let region: String
    let bucket: String
    let accessKey: String
    let secretKey: String
    let forcePathStyle: Bool

    static func load(_ environment: [String: String]) -> S3ArchiveConfiguration? {
        func value(_ key: String) -> String? {
            guard let value = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty else { return nil }
            return value
        }
        guard let endpointRaw = value("MOMO_S3_ENDPOINT"),
              let endpoint = URL(string: endpointRaw),
              ["http", "https"].contains(endpoint.scheme?.lowercased() ?? ""),
              endpoint.host != nil, endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil,
              let region = value("MOMO_S3_REGION"),
              region.wholeMatch(of: /^[A-Za-z0-9-]{1,63}$/) != nil,
              let bucket = value("MOMO_S3_BUCKET"),
              bucket.wholeMatch(of: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/) != nil,
              !bucket.contains(".."),
              let accessKey = value("MOMO_S3_ACCESS_KEY"),
              let secretKey = value("MOMO_S3_SECRET_KEY")
        else { return nil }
        return S3ArchiveConfiguration(
            endpoint: endpoint,
            region: region,
            bucket: bucket,
            accessKey: accessKey,
            secretKey: secretKey,
            forcePathStyle: value("MOMO_S3_FORCE_PATH_STYLE") == "1"
        )
    }
}

enum ArchiveClientFactory {
    static func validateForBoot(environmentName: String, environment: [String: String]) throws {
        if resolvedBackend(environment) == "drive" {
            try DriveArchiveClientFactory.validateForBoot(
                environmentName: environmentName,
                environment: environment
            )
        }
    }

    static func make(
        environmentName: String,
        environment: [String: String],
        httpClient: HTTPClient,
        stubBaseURL: String
    ) async -> any DriveArchiveClient {
        switch resolvedBackend(environment) {
        case "drive":
            return await DriveArchiveClientFactory.make(
                environmentName: environmentName,
                environment: environment,
                httpClient: httpClient,
                stubBaseURL: stubBaseURL
            )
        case "s3":
            guard let configuration = S3ArchiveConfiguration.load(environment) else {
                return UnavailableDriveArchiveClient()
            }
            return S3ArchiveClient(configuration: configuration, httpClient: httpClient)
        default:
            return UnavailableDriveArchiveClient()
        }
    }

    private static func resolvedBackend(_ environment: [String: String]) -> String {
        let value = environment["MOMO_ARCHIVE_BACKEND"] ?? "drive"
        return value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct S3ArchiveSigner: Sendable {
    static let defaultExpirationSeconds = 900
    static let service = "s3"
    static let unsignedPayload = "UNSIGNED-PAYLOAD"

    let configuration: S3ArchiveConfiguration

    func presignedURL(
        method: String,
        objectKey: String,
        now: Date = Date(),
        expires: Int = defaultExpirationSeconds
    ) throws -> URL {
        guard (1...604_800).contains(expires) else {
            throw DriveArchiveError.invalidArguments("S3 presign expiration is invalid")
        }
        let target = try objectURL(objectKey: objectKey)
        let timestamp = Self.timestamp(now)
        let date = String(timestamp.prefix(8))
        let scope = "\(date)/\(configuration.region)/\(Self.service)/aws4_request"
        let host = try Self.hostHeader(target)
        var query = [
            ("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
            ("X-Amz-Credential", "\(configuration.accessKey)/\(scope)"),
            ("X-Amz-Date", timestamp),
            ("X-Amz-Expires", String(expires)),
            ("X-Amz-SignedHeaders", "host"),
        ]
        let canonicalQuery = Self.canonicalQuery(query)
        let canonicalRequest = [
            method,
            Self.canonicalURI(target.path),
            canonicalQuery,
            "host:\(host)\n",
            "host",
            Self.unsignedPayload,
        ].joined(separator: "\n")
        let stringToSign = [
            "AWS4-HMAC-SHA256",
            timestamp,
            scope,
            Self.sha256Hex(Data(canonicalRequest.utf8)),
        ].joined(separator: "\n")
        let signature = Self.signature(
            secretKey: configuration.secretKey,
            date: date,
            region: configuration.region,
            service: Self.service,
            stringToSign: stringToSign
        )
        query.append(("X-Amz-Signature", signature))
        guard var components = URLComponents(url: target, resolvingAgainstBaseURL: false) else {
            throw DriveArchiveError.invalidArguments("S3 endpoint is invalid")
        }
        components.percentEncodedQuery = Self.canonicalQuery(query)
        guard let url = components.url else { throw DriveArchiveError.upstreamFailure }
        return url
    }

    func signedRequest(
        method: String,
        objectKey: String,
        now: Date = Date()
    ) throws -> HTTPClientRequest {
        let target = try objectURL(objectKey: objectKey)
        let timestamp = Self.timestamp(now)
        let date = String(timestamp.prefix(8))
        let scope = "\(date)/\(configuration.region)/\(Self.service)/aws4_request"
        let host = try Self.hostHeader(target)
        let payloadHash = Self.sha256Hex(Data())
        let canonicalHeaders = "host:\(host)\nx-amz-content-sha256:\(payloadHash)\nx-amz-date:\(timestamp)\n"
        let signedHeaders = "host;x-amz-content-sha256;x-amz-date"
        let canonicalRequest = [
            method,
            Self.canonicalURI(target.path),
            "",
            canonicalHeaders,
            signedHeaders,
            payloadHash,
        ].joined(separator: "\n")
        let stringToSign = [
            "AWS4-HMAC-SHA256",
            timestamp,
            scope,
            Self.sha256Hex(Data(canonicalRequest.utf8)),
        ].joined(separator: "\n")
        let signature = Self.signature(
            secretKey: configuration.secretKey,
            date: date,
            region: configuration.region,
            service: Self.service,
            stringToSign: stringToSign
        )
        var request = HTTPClientRequest(url: target.absoluteString)
        switch method {
        case "HEAD": request.method = .HEAD
        case "DELETE": request.method = .DELETE
        default: throw DriveArchiveError.invalidArguments("S3 request method is invalid")
        }
        request.headers.add(name: "Host", value: host)
        request.headers.add(name: "x-amz-content-sha256", value: payloadHash)
        request.headers.add(name: "x-amz-date", value: timestamp)
        request.headers.add(
            name: "Authorization",
            value: "AWS4-HMAC-SHA256 Credential=\(configuration.accessKey)/\(scope), SignedHeaders=\(signedHeaders), Signature=\(signature)"
        )
        return request
    }

    func objectURL(objectKey: String) throws -> URL {
        guard !objectKey.isEmpty, !objectKey.hasPrefix("/"), !objectKey.contains("..") else {
            throw DriveArchiveError.invalidArguments("S3 object key is invalid")
        }
        guard var components = URLComponents(
            url: configuration.endpoint,
            resolvingAgainstBaseURL: false
        ) else { throw DriveArchiveError.invalidArguments("S3 endpoint is invalid") }
        let basePath = components.percentEncodedPath.trimmingCharacters(
            in: CharacterSet(charactersIn: "/")
        )
        let encodedKey = Self.canonicalURI(objectKey).dropFirst()
        if configuration.forcePathStyle {
            components.percentEncodedPath = "/" + [basePath, Self.encode(configuration.bucket), String(encodedKey)]
                .filter { !$0.isEmpty }.joined(separator: "/")
        } else {
            guard let host = components.host else { throw DriveArchiveError.upstreamFailure }
            components.host = "\(configuration.bucket).\(host)"
            components.percentEncodedPath = "/" + [basePath, String(encodedKey)]
                .filter { !$0.isEmpty }.joined(separator: "/")
        }
        guard let url = components.url else { throw DriveArchiveError.upstreamFailure }
        return url
    }

    static func canonicalQuery(_ items: [(String, String)]) -> String {
        let encoded: [(String, String)] = items.map { item in
            (encode(item.0), encode(item.1))
        }
        let sorted = encoded.sorted { lhs, rhs in
            lhs.0 == rhs.0 ? lhs.1 < rhs.1 : lhs.0 < rhs.0
        }
        return sorted.map { item in item.0 + "=" + item.1 }.joined(separator: "&")
    }

    static func canonicalURI(_ path: String) -> String {
        let raw = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return "/" + raw.split(separator: "/", omittingEmptySubsequences: false)
            .map { encode(String($0)) }.joined(separator: "/")
    }

    static func signature(
        secretKey: String,
        date: String,
        region: String,
        service: String,
        stringToSign: String
    ) -> String {
        let dateKey = hmac(key: Data("AWS4\(secretKey)".utf8), message: date)
        let regionKey = hmac(key: dateKey, message: region)
        let serviceKey = hmac(key: regionKey, message: service)
        let signingKey = hmac(key: serviceKey, message: "aws4_request")
        return hmac(key: signingKey, message: stringToSign)
            .map { String(format: "%02x", $0) }.joined()
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func hmac(key: Data, message: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(
            for: Data(message.utf8),
            using: SymmetricKey(data: key)
        ))
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter.string(from: date)
    }

    private static func hostHeader(_ url: URL) throws -> String {
        guard let host = url.host else { throw DriveArchiveError.upstreamFailure }
        guard let port = url.port else { return host }
        if (url.scheme == "http" && port == 80) || (url.scheme == "https" && port == 443) {
            return host
        }
        return "\(host):\(port)"
    }

    private static func encode(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

struct S3ArchiveClient: DriveArchiveClient {
    let acceptsStubUploads = false
    let configuration: S3ArchiveConfiguration
    let httpClient: HTTPClient
    private let signer: S3ArchiveSigner

    init(configuration: S3ArchiveConfiguration, httpClient: HTTPClient) {
        self.configuration = configuration
        self.httpClient = httpClient
        self.signer = S3ArchiveSigner(configuration: configuration)
    }

    func createResumableUpload(
        channelID: UUID,
        name: String,
        mime _: String,
        sizeBytes _: Int64
    ) async throws -> DriveArchiveUploadSession {
        let encodedName = Data(name.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let key = "channels/\(channelID.uuidString.lowercased())/\(UUID().uuidString.lowercased())/\(encodedName)"
        let url = try signer.presignedURL(method: "PUT", objectKey: key)
        return DriveArchiveUploadSession(driveFileID: key, uploadURL: url.absoluteString)
    }

    func fileMetadata(fileID: String) async throws -> DriveArchiveFile {
        let response = try await execute(try signer.signedRequest(method: "HEAD", objectKey: fileID))
        guard response.status.code == 200 else { throw Self.mappedError(response.status.code) }
        guard let rawSize = response.headers.first(name: "Content-Length"),
              let size = Int64(rawSize),
              let mime = response.headers.first(name: "Content-Type"),
              let encodedName = fileID.split(separator: "/").last,
              let nameData = Self.decodeBase64URL(String(encodedName)),
              let name = String(data: nameData, encoding: .utf8)
        else { throw DriveArchiveError.upstreamFailure }
        return DriveArchiveFile(driveFileID: fileID, name: name, mime: mime, sizeBytes: size)
    }

    func fileContent(fileID: String, maxBytes: Int) async throws -> DriveArchiveContent {
        let metadata = try await fileMetadata(fileID: fileID)
        guard metadata.sizeBytes <= Int64(maxBytes),
              let size = Int(exactly: metadata.sizeBytes)
        else { throw DriveArchiveError.contentTooLarge }
        let url = try signer.presignedURL(method: "GET", objectKey: fileID)
        return DriveArchiveContent(mime: metadata.mime, sizeBytes: size, redirectURL: url.absoluteString)
    }

    func deleteFile(fileID: String) async throws {
        let response = try await execute(try signer.signedRequest(method: "DELETE", objectKey: fileID))
        guard response.status.code == 204 else { throw Self.mappedError(response.status.code) }
    }

    func acceptStubUpload(token _: String, mime _: String?, bytes _: Data) async throws {
        throw DriveArchiveError.fileNotFound
    }

    private func execute(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
        do { return try await httpClient.execute(request, timeout: .seconds(15)) }
        catch { throw DriveArchiveError.upstreamFailure }
    }

    private static func mappedError(_ status: UInt) -> DriveArchiveError {
        switch status {
        case 401, 403: .accessDenied
        case 404: .fileNotFound
        default: .upstreamFailure
        }
    }

    private static func decodeBase64URL(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }
}
