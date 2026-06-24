import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import NIOFoundationCompat

/// Client for Centrifugo's server HTTP API (`POST /api/publish`, `X-API-Key`).
///
/// L4 §4.3: only the server side publishes; clients never publish directly. The
/// relay is THE publisher in the canonical write path — REST → PG commit →
/// outbox → relay publishes. For each publish we forward `version = message.seq`
/// (history dedup) and `idempotency_key = "<channel>:<seq>"` (Centrifugo 5-min
/// cache) so this at-least-once relay can't produce duplicates or reordering
/// (L4 §4.3, §8.1).
///
/// runtime-unverified (no Centrifugo running): request shape matches Centrifugo
/// v6 server API but is not exercised against a live broker in this build env.
struct CentrifugoClient: Sendable {
    let httpClient: HTTPClient
    let apiURL: String   // e.g. http://centrifugo:8000/api
    let apiKey: String
    let logger: Logger

    private static let encoder = JSONEncoder()

    /// Outcome of a publish attempt. `.permanentFailure` (4xx other than 429)
    /// should not be retried indefinitely; `.transientFailure` is retryable.
    enum PublishResult: Sendable {
        case ok
        case transientFailure(String)
        case permanentFailure(String)
    }

    /// Publish a pre-built outbox payload `{channel, data, version, idempotency_key}`.
    func publish(_ payload: BroadcastPayload) async throws -> PublishResult {
        let body = PublishRequest(
            channel: payload.channel,
            data: payload.data,
            version: payload.version.map(Int.init),
            idempotency_key: payload.idempotencyKey
        )
        var request = HTTPClientRequest(url: "\(apiURL)/publish")
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/json")
        // Centrifugo v6 server API auth: `X-API-Key` header (L4 §4.2 http_api.key).
        request.headers.add(name: "X-API-Key", value: apiKey)
        let encoded = try Self.encoder.encode(body)
        request.body = .bytes(ByteBuffer(data: encoded))

        let response = try await httpClient.execute(request, timeout: .seconds(10))
        let code = response.status.code
        if response.status == .ok {
            // Centrifugo returns 200 even for logical errors → inspect the body.
            var buffer = try await response.body.collect(upTo: 64 * 1024)
            let bytes = buffer.readData(length: buffer.readableBytes) ?? Data()
            if let err = Self.decodeError(bytes) {
                // e.g. {"error":{"code":102,"message":"unknown channel"}} → not retryable.
                return .permanentFailure("centrifugo error: \(err)")
            }
            return .ok
        }
        // HTTP-level non-200: 429/5xx transient, other 4xx permanent.
        if code == 429 || code >= 500 {
            return .transientFailure("HTTP \(code)")
        }
        return .permanentFailure("HTTP \(code)")
    }

    /// Decode a Centrifugo `{ "error": {...} }` envelope if present; nil = success.
    private static func decodeError(_ data: Data) -> String? {
        guard !data.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let err = obj["error"] as? [String: Any]
        else { return nil }
        let msg = (err["message"] as? String) ?? "unknown"
        let codeVal = (err["code"] as? Int).map(String.init) ?? "?"
        return "code=\(codeVal) message=\(msg)"
    }

    private struct PublishRequest: Encodable {
        let channel: String
        let data: AnyJSON
        let version: Int?
        let idempotency_key: String?
    }
}
