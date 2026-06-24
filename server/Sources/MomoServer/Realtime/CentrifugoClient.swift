import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import NIOFoundationCompat

/// Client for Centrifugo's server HTTP API (`POST /api/publish`, `X-API-Key`).
///
/// L4 §4.3: only the server side publishes; clients never publish directly. The
/// canonical write path is REST → PG commit → outbox → **relay** publishes. This
/// client exists for (a) the relay-equivalent helper and (b) any direct
/// server-initiated publishes. For each publish we pass `version = message.seq`
/// (history dedup) and `idempotency_key = "<channel>:<seq>"` (5-min cache) so the
/// at-least-once relay can't produce duplicates or reordering (L4 §4.3).
///
/// runtime-unverified (no Centrifugo running): request shape matches Centrifugo
/// v6 server API but is not exercised against a live broker in this build env.
struct CentrifugoClient: Sendable {
    let httpClient: HTTPClient
    let apiURL: String   // e.g. http://centrifugo:8000/api
    let apiKey: String
    let logger: Logger

    private static let encoder = JSONEncoder()

    /// Publish `data` to `channel`. `version`/`idempotencyKey` enable dedup (L4 §4.3).
    @discardableResult
    func publish(
        channel: String,
        data: [String: AnyJSON],
        version: Int64? = nil,
        idempotencyKey: String? = nil
    ) async throws -> Bool {
        let body = PublishRequest(
            channel: channel,
            data: data,
            version: version.map(Int.init),
            idempotency_key: idempotencyKey
        )
        var request = HTTPClientRequest(url: "\(apiURL)/publish")
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/json")
        // Centrifugo v6 server API auth: `X-API-Key` header (L4 §4.2 http_api.key).
        request.headers.add(name: "X-API-Key", value: apiKey)
        let payload = try Self.encoder.encode(body)
        request.body = .bytes(ByteBuffer(data: payload))

        let response = try await httpClient.execute(request, timeout: .seconds(10))
        guard response.status == .ok else {
            logger.warning("centrifugo publish non-200", metadata: [
                "channel": .string(channel), "status": .stringConvertible(response.status.code),
            ])
            return false
        }
        return true
    }

    private struct PublishRequest: Encodable {
        let channel: String
        let data: [String: AnyJSON]
        let version: Int?
        let idempotency_key: String?
    }
}

/// A tiny JSON value used to build Centrifugo publish payloads without pulling a
/// heavyweight any-codable dependency. Covers the cases the event envelope needs.
enum AnyJSON: Encodable, Sendable {
    case string(String)
    case int(Int)
    case int64(Int64)
    case double(Double)
    case bool(Bool)
    case null
    case object([String: AnyJSON])
    case array([AnyJSON])

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .int64(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        }
    }
}
