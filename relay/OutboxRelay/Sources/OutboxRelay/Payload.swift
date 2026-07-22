import Foundation

/// A faithfully round-trippable JSON value. The relay decodes the outbox
/// `payload.data` (an arbitrary event envelope built by the API, L4 §5.2) and
/// re-encodes it verbatim when publishing to Centrifugo — it never reshapes the
/// app's event payload, only forwards it.
enum AnyJSON: Codable, Sendable {
    case string(String)
    case int(Int64)
    case double(Double)
    case bool(Bool)
    case null
    case object([String: AnyJSON])
    case array([AnyJSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Int64.self) {
            self = .int(v)
        } else if let v = try? c.decode(Double.self) {
            self = .double(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([String: AnyJSON].self) {
            self = .object(v)
        } else if let v = try? c.decode([AnyJSON].self) {
            self = .array(v)
        } else {
            throw DecodingError.dataCorruptedError(
                in: c, debugDescription: "unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        }
    }
}

/// The decoded shape of a broadcast outbox row's `payload` column.
///
/// Built by the API in the send transaction (L4 §8.1, see server MessageRoutes):
///   { "channel": "...", "data": {<event envelope>},
///     "version": <seq>, "idempotency_key": "<channel>:<seq>" }
struct BroadcastPayload: Decodable, Sendable {
    let channel: String
    let data: AnyJSON
    let version: Int64?
    let idempotencyKey: String?

    enum CodingKeys: String, CodingKey {
        case channel
        case data
        case version
        case idempotencyKey = "idempotency_key"
    }
}

struct WebhookDeliveryPayload: Decodable, Sendable {
    let schema: String
    let subscriptionID: UUID
    let event: AnyJSON

    enum CodingKeys: String, CodingKey {
        case schema
        case subscriptionID = "subscription_id"
        case event
    }
}
