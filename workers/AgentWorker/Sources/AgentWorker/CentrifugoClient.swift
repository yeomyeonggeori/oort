import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import NIOFoundationCompat

/// Client for Centrifugo's server HTTP API (`POST /api/publish`, `X-API-Key`).
///
/// The worker publishes agent lifecycle + streaming events on the `agent:`
/// channel (L4 §4.1 / §5.2): `agent.status` (queued/thinking/streaming/done/error)
/// and `agent.partial` (1st-class streaming text deltas). These are agent-stream
/// events, not the canonical message write path — the final message still flows
/// REST/outbox → relay. `agent.status` publish is the authoritative working
/// indicator (presence is at-most-once fallback, L4 §5.2).
///
/// runtime-unverified (no Centrifugo running): request shape matches Centrifugo
/// v6 server API but is not exercised against a live broker in this build env.
struct CentrifugoClient: Sendable {
    let httpClient: HTTPClient
    let apiURL: String   // e.g. http://centrifugo:8000/api
    let apiKey: String
    let logger: Logger

    private static let encoder = JSONEncoder()

    /// Publish a single-envelope event `{type, v, ts, seq?, payload}` (L4 §5.2)
    /// to `channel`. Best-effort: agent-stream events are ephemeral progress, so a
    /// transient publish failure is logged, not fatal (the durable message still
    /// lands via the outbox/relay path).
    @discardableResult
    func publish(channel: String, data: JSONValue) async -> Bool {
        do {
            let body = PublishRequest(channel: channel, data: data)
            var request = HTTPClientRequest(url: "\(apiURL)/publish")
            request.method = .POST
            request.headers.add(name: "Content-Type", value: "application/json")
            // Centrifugo v6 server API auth: `X-API-Key` header (L4 §4.2 http_api.key).
            request.headers.add(name: "X-API-Key", value: apiKey)
            request.body = .bytes(ByteBuffer(data: try Self.encoder.encode(body)))

            let response = try await httpClient.execute(request, timeout: .seconds(10))
            guard response.status == .ok else {
                logger.warning("centrifugo publish non-200", metadata: [
                    "channel": .string(channel),
                    "status": .stringConvertible(response.status.code),
                ])
                return false
            }
            return true
        } catch {
            logger.warning("centrifugo publish failed", metadata: [
                "channel": .string(channel),
                "error": .string(String(describing: error)),
            ])
            return false
        }
    }

    private struct PublishRequest: Encodable {
        let channel: String
        let data: JSONValue
    }
}
