import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import NIOFoundationCompat

/// The id-only dispatch payload sent to the push relay (ADR-0120 D2 hard
/// contract).
///
/// This struct is the ONLY shape that ever leaves the notifier toward the
/// relay. It carries routing/identity data exclusively:
///   - server/workspace/device/token identity + APNs env/topic (routing)
///   - channel_id/message_id (the client fetches content from ITS OWN server
///     to complete the notification — iOS Notification Service Extension, P-4)
///   - collapse_id (APNs dedup/replace key) + badge (approximate count)
///   - reason ("dm" | "mention" | "approval_request") — judgment metadata
///
/// Conversation content — message body, sender display name/handle, channel
/// name, approval summary — MUST NEVER be added here. The runtime gate
/// (scripts/verify_push_notifier.sh) asserts body/display-name absence on the
/// relay's received payloads; treat any new field as an ADR-0120 change.
struct PushDispatch: Encodable, Sendable {
    let schema = "momo.push.dispatch.v1"
    let serverId: String
    let workspaceId: String
    let deviceId: String
    let devicePlatform: String
    let apnsToken: String
    let apnsEnv: String
    let apnsTopic: String
    let collapseId: String
    let badge: Int
    let reason: String
    let channelId: String
    let messageId: String

    private enum CodingKeys: String, CodingKey {
        case schema
        case serverId = "server_id"
        case workspaceId = "workspace_id"
        case deviceId = "device_id"
        case devicePlatform = "device_platform"
        case apnsToken = "apns_token"
        case apnsEnv = "apns_env"
        case apnsTopic = "apns_topic"
        case collapseId = "collapse_id"
        case badge
        case reason
        case channelId = "channel_id"
        case messageId = "message_id"
    }
}

/// Client for the push relay dispatch endpoint (mock_push_relay.py in e2e;
/// the Dawn-operated PushRelay in P-3). Mirrors CentrifugoClient's outcome
/// taxonomy so NotifierService can reuse the relay's retry/backoff semantics.
struct PushRelayClient: Sendable {
    let httpClient: HTTPClient
    let dispatchURL: String   // e.g. http://mock-push-relay:8090/v1/push
    let logger: Logger
    let serverID: String
    let requestSigner: PushRelayRequestSigner?

    private static let encoder = JSONEncoder()

    /// Outcome of one dispatch attempt. `accepted` carries the APNs status
    /// contract fields recorded into push_dispatch_log (apns_status/reason —
    /// 001_init.sql:532-543; 410/400 → push_token.invalidated_at handling is
    /// the P-3 real-send contract — recorded here, acted on in P-3).
    enum DispatchResult: Sendable {
        case accepted(apnsStatus: Int, apnsReason: String?)
        case transientFailure(String)
        case permanentFailure(relayHTTPStatus: Int, reason: String)
    }

    func dispatch(_ payload: PushDispatch) async throws -> DispatchResult {
        var request = HTTPClientRequest(url: dispatchURL)
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/json")
        let encoded = try Self.encoder.encode(payload)
        if let requestSigner {
            request.headers.add(name: "X-Momo-Server-Id", value: serverID)
            request.headers.add(
                name: "X-Momo-Push-Signature",
                value: try requestSigner.signatureBase64(for: encoded)
            )
        }
        request.body = .bytes(ByteBuffer(data: encoded))

        let response = try await httpClient.execute(request, timeout: .seconds(10))
        let code = response.status.code
        if response.status == .ok {
            var buffer = try await response.body.collect(upTo: 64 * 1024)
            let bytes = buffer.readData(length: buffer.readableBytes) ?? Data()
            let (status, reason) = Self.decodeReceipt(bytes)
            return .accepted(apnsStatus: status, apnsReason: reason)
        }
        // HTTP-level non-200 from the relay itself: 429/5xx transient, other
        // 4xx permanent (a malformed dispatch will never succeed on retry).
        if code == 429 || code >= 500 {
            return .transientFailure("HTTP \(code)")
        }
        return .permanentFailure(relayHTTPStatus: Int(code), reason: "HTTP \(code)")
    }

    /// Decode the relay receipt `{apns_status, apns_reason?}`; a 200 with an
    /// unparseable body still counts as accepted (status recorded as 200).
    private static func decodeReceipt(_ data: Data) -> (Int, String?) {
        guard !data.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return (200, nil) }
        let status = (obj["apns_status"] as? Int) ?? 200
        let reason = obj["apns_reason"] as? String
        return (status, reason)
    }
}
