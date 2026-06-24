import Foundation
import Hummingbird

// MARK: - Wire DTOs
//
// Request/response bodies for the REST surface (L4 §5.1). Field names mirror the
// MomoCore client models where practical so the Swift clients can share shapes.
// All timestamps are RFC3339 UTC; epoch-ms variants carry an `_ms` suffix (L4 §5.1).

// ---- Auth ----

/// POST /v1/auth/login request.
struct LoginRequest: Decodable {
    let email: String
    let password: String
    /// Optional explicit workspace; the stub resolves a default if omitted.
    let workspace: String?
}

/// POST /v1/auth/login response (stub-issued HS256 tokens).
struct LoginResponse: ResponseEncodable {
    let accessToken: String
    let refreshToken: String
    let member: MemberDTO
}

struct MemberDTO: ResponseEncodable {
    let id: String
    let workspaceId: String
    let kind: String
    let displayName: String
    let handle: String
}

// ---- Messages ----

/// POST .../messages request body. `clientMsgId` drives idempotency (L4 §3.1).
struct SendMessageRequest: Decodable {
    let clientMsgId: UUID
    let type: String?            // defaults to "text"
    let body: String?
    let props: [String: String]? // simplified structured payload for v0 stub
    let runId: UUID?
}

/// A message as returned by send/history (L4 §5.3 Message contract).
struct MessageDTO: ResponseEncodable {
    let id: String
    let channelId: String
    let seq: Int64
    let hlcTs: Int64
    let hlcCount: Int
    let authorMemberId: String
    let type: String
    let body: String?
    let createdAtMs: Int64
}

/// GET .../messages response (seq-cursor page, L4 §5.1 / §8.2).
struct MessagePage: ResponseEncodable {
    let messages: [MessageDTO]
    /// Cursor to fetch older messages (pass as `before`); nil at start of history.
    let nextBefore: Int64?
}

// ---- Centrifugo subscribe proxy ----

/// Request body Centrifugo sends to the subscribe proxy endpoint (L4 §4.3).
/// Only the fields we authorize on are modeled; unknowns are ignored.
struct SubscribeProxyRequest: Decodable {
    let client: String?
    let user: String?
    let channel: String
}

/// Subscribe proxy success/deny envelope (Centrifugo proxy protocol).
/// Allow → `{"result": {}}`; deny → `{"error": {"code": .., "message": ..}}`.
struct SubscribeProxyResponse: ResponseEncodable {
    struct Result: ResponseEncodable {}
    struct ProxyError: ResponseEncodable {
        let code: Int
        let message: String
    }
    let result: Result?
    let error: ProxyError?

    static func allow() -> SubscribeProxyResponse { .init(result: .init(), error: nil) }
    static func deny(_ message: String) -> SubscribeProxyResponse {
        .init(result: nil, error: .init(code: 403, message: message))
    }
}

// ---- Health ----

struct HealthResponse: ResponseEncodable {
    let status: String
    let service: String
}
