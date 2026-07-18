import Foundation

/// Exact `momo.push.dispatch.v1` wire contract. This is intentionally a closed
/// field set: accepting an extra `body`, display name, or channel name would
/// silently widen ADR-0120's content boundary.
struct PushDispatch: Codable, Sendable {
    static let allowedKeys: Set<String> = [
        "schema", "server_id", "workspace_id", "device_id", "device_platform",
        "apns_token", "apns_env", "apns_topic", "collapse_id", "badge", "reason",
        "channel_id", "message_id",
    ]

    let schema: String
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

    enum CodingKeys: String, CodingKey {
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

    static func decodeClosed(_ data: Data) throws -> PushDispatch {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == allowedKeys
        else { throw DispatchValidationError.invalidFieldSet }
        let dispatch = try JSONDecoder().decode(PushDispatch.self, from: data)
        try dispatch.validate()
        return dispatch
    }

    func validate() throws {
        guard schema == "momo.push.dispatch.v1" else { throw DispatchValidationError.schema }
        guard !serverId.isEmpty, !workspaceId.isEmpty, !deviceId.isEmpty,
              !apnsToken.isEmpty, !apnsTopic.isEmpty, !collapseId.isEmpty,
              !channelId.isEmpty, !messageId.isEmpty
        else { throw DispatchValidationError.missingValue }
        guard devicePlatform == "ios" || devicePlatform == "macos" else {
            throw DispatchValidationError.devicePlatform
        }
        guard APNSEnvironment(rawValue: apnsEnv) != nil else { throw DispatchValidationError.apnsEnvironment }
        guard ["dm", "mention", "approval_request"].contains(reason) else { throw DispatchValidationError.reason }
        guard badge >= 0 else { throw DispatchValidationError.badge }
        guard (16...512).contains(apnsToken.count),
              apnsToken.allSatisfy({ $0.isHexDigit && $0.isASCII })
        else { throw DispatchValidationError.apnsToken }
        guard apnsTopic.count <= 256,
              apnsTopic.allSatisfy({ character in
                  !character.isWhitespace && character.unicodeScalars.allSatisfy {
                      $0.value >= 0x20 && $0.value != 0x7f
                  }
              })
        else { throw DispatchValidationError.apnsTopic }
        guard collapseId.utf8.count <= 64 else { throw DispatchValidationError.collapseId }
    }
}

enum DispatchValidationError: Error {
    case invalidFieldSet, schema, missingValue, devicePlatform, apnsEnvironment, reason, badge
    case apnsToken, apnsTopic, collapseId
}

struct APNSPayload: Encodable, Sendable {
    struct APS: Encodable, Sendable {
        struct Alert: Encodable, Sendable {
            let title = "momo"
            let body = "새 알림"
        }

        let alert = Alert()
        let badge: Int
        let mutableContent = 1
        let contentAvailable = 1

        enum CodingKeys: String, CodingKey {
            case alert
            case badge
            case mutableContent = "mutable-content"
            case contentAvailable = "content-available"
        }
    }

    struct MomoEnvelope: Encodable, Sendable {
        let schema = "momo.push.notification.v1"
        let serverId: String
        let workspaceId: String
        let channelId: String
        let messageId: String
        let collapseId: String
        let reason: String

        enum CodingKeys: String, CodingKey {
            case schema
            case serverId = "server_id"
            case workspaceId = "workspace_id"
            case channelId = "channel_id"
            case messageId = "message_id"
            case collapseId = "collapse_id"
            case reason
        }
    }

    let aps: APS
    let momo: MomoEnvelope

    init(dispatch: PushDispatch) {
        aps = APS(badge: dispatch.badge)
        momo = MomoEnvelope(
            serverId: dispatch.serverId,
            workspaceId: dispatch.workspaceId,
            channelId: dispatch.channelId,
            messageId: dispatch.messageId,
            collapseId: dispatch.collapseId,
            reason: dispatch.reason
        )
    }
}
