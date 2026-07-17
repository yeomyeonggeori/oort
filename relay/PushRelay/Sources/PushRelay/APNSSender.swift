import AsyncHTTPClient
import Crypto
import Foundation
import NIOCore
import NIOFoundationCompat

struct APNSResult: Sendable {
    let status: Int
    let reason: String?
    let apnsID: String?
}

protocol APNSSender: Sendable {
    func send(_ dispatch: PushDispatch) async throws -> APNSResult
}

enum APNSSenderError: Error {
    case environmentMismatch
    case responseTooLarge
}

actor APNSProviderTokenCache {
    private let privateKey: P256.Signing.PrivateKey
    private let keyID: String
    private let teamID: String
    private var cached: (token: String, issuedAt: Date)?

    init(privateKey: P256.Signing.PrivateKey, keyID: String, teamID: String) {
        self.privateKey = privateKey
        self.keyID = keyID
        self.teamID = teamID
    }

    func token(now: Date = Date()) throws -> String {
        if let cached, now.timeIntervalSince(cached.issuedAt) < 50 * 60 {
            return cached.token
        }
        let header = try Self.base64URL(JSONSerialization.data(withJSONObject: ["alg": "ES256", "kid": keyID]))
        let claims = try Self.base64URL(JSONSerialization.data(withJSONObject: [
            "iss": teamID,
            "iat": Int(now.timeIntervalSince1970),
        ]))
        let signingInput = "\(header).\(claims)"
        let signature = try privateKey.signature(for: Data(signingInput.utf8))
        let token = "\(signingInput).\(Self.base64URL(signature.rawRepresentation))"
        cached = (token, now)
        return token
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

final class LiveAPNSSender: APNSSender, @unchecked Sendable {
    private let httpClient: HTTPClient
    private let environment: APNSEnvironment
    private let tokenCache: APNSProviderTokenCache
    private static let encoder = JSONEncoder()

    init(
        httpClient: HTTPClient,
        environment: APNSEnvironment,
        keyPath: String,
        keyID: String,
        teamID: String
    ) throws {
        self.httpClient = httpClient
        self.environment = environment
        let pem = try String(contentsOfFile: keyPath, encoding: .utf8)
        let key = try P256.Signing.PrivateKey(pemRepresentation: pem)
        tokenCache = APNSProviderTokenCache(privateKey: key, keyID: keyID, teamID: teamID)
    }

    func send(_ dispatch: PushDispatch) async throws -> APNSResult {
        guard dispatch.apnsEnv == environment.rawValue else { throw APNSSenderError.environmentMismatch }
        let providerToken = try await tokenCache.token()
        let tokenPath = dispatch.apnsToken.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
            ?? dispatch.apnsToken
        var request = HTTPClientRequest(url: "\(environment.endpoint)/3/device/\(tokenPath)")
        request.method = .POST
        request.headers.add(name: "authorization", value: "bearer \(providerToken)")
        request.headers.add(name: "apns-topic", value: dispatch.apnsTopic)
        request.headers.add(name: "apns-push-type", value: "alert")
        request.headers.add(name: "apns-priority", value: "10")
        request.headers.add(name: "apns-collapse-id", value: dispatch.collapseId)
        request.headers.add(name: "content-type", value: "application/json")
        request.body = .bytes(ByteBuffer(data: try Self.encoder.encode(APNSPayload(dispatch: dispatch))))

        // APNs advertises only HTTP/2 over TLS; AsyncHTTPClient negotiates h2
        // through ALPN and pools the resulting HTTP/2 connection.
        let response = try await httpClient.execute(request, timeout: .seconds(10))
        var buffer = try await response.body.collect(upTo: 64 * 1024)
        guard let bytes = buffer.readData(length: buffer.readableBytes) else {
            return APNSResult(status: Int(response.status.code), reason: nil, apnsID: response.headers.first(name: "apns-id"))
        }
        let reason = (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any])?["reason"] as? String
        return APNSResult(
            status: Int(response.status.code),
            reason: reason,
            apnsID: response.headers.first(name: "apns-id")
        )
    }
}

actor StubAPNSSender: APNSSender {
    private let status: Int
    private let reason: String?
    private let capturePath: String?
    private static let encoder = JSONEncoder()

    init(status: Int = 200, reason: String? = nil, capturePath: String? = nil) {
        self.status = status
        self.reason = reason
        self.capturePath = capturePath
    }

    func send(_ dispatch: PushDispatch) async throws -> APNSResult {
        let payload = try Self.encoder.encode(APNSPayload(dispatch: dispatch))
        if let capturePath {
            var line = payload
            line.append(0x0a)
            if !FileManager.default.fileExists(atPath: capturePath) {
                FileManager.default.createFile(atPath: capturePath, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: capturePath))
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
            try handle.close()
        }
        return APNSResult(status: status, reason: reason, apnsID: "stub-apns-id")
    }
}
