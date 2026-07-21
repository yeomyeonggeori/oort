import Foundation

/// Exact `momo.push.dispatch.v2` wire contract. This is intentionally a closed
/// field set: accepting an extra `body`, display name, or channel name would
/// silently widen ADR-0120's content boundary.
struct PushDispatch: Codable, Sendable {
    static let requiredKeys: Set<String> = [
        "schema", "server_id", "workspace_id", "device_id", "device_platform",
        "apns_token", "apns_env", "apns_topic", "collapse_id", "badge", "reason",
        "thread_id", "category", "channel_id", "message_id",
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
    let threadId: String
    let category: String
    let approvalId: String?
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
        case threadId = "thread_id"
        case category
        case approvalId = "approval_id"
        case channelId = "channel_id"
        case messageId = "message_id"
    }

    static func decodeClosed(_ data: Data) throws -> PushDispatch {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw DispatchValidationError.invalidFieldSet }
        let dispatch = try JSONDecoder().decode(PushDispatch.self, from: data)
        let expectedKeys = requiredKeys.union(dispatch.category == "momo.approval" ? ["approval_id"] : [])
        guard Set(object.keys) == expectedKeys else {
            throw DispatchValidationError.invalidFieldSet
        }
        try dispatch.validate()
        return dispatch
    }

    func validate() throws {
        guard schema == "momo.push.dispatch.v2" else { throw DispatchValidationError.schema }
        guard !serverId.isEmpty, !workspaceId.isEmpty, !deviceId.isEmpty,
              !apnsToken.isEmpty, !apnsTopic.isEmpty, !collapseId.isEmpty,
              !threadId.isEmpty, !channelId.isEmpty, !messageId.isEmpty
        else { throw DispatchValidationError.missingValue }
        guard devicePlatform == "ios" || devicePlatform == "macos" else {
            throw DispatchValidationError.devicePlatform
        }
        guard APNSEnvironment(rawValue: apnsEnv) != nil else { throw DispatchValidationError.apnsEnvironment }
        guard ["dm", "mention", "approval_request", "resume_offer"].contains(reason) else {
            throw DispatchValidationError.reason
        }
        guard ["momo.message", "momo.mention", "momo.approval", "momo.work"].contains(category)
        else { throw DispatchValidationError.category }
        guard (category == "momo.approval") == (approvalId != nil),
              approvalId.map({ UUID(uuidString: $0) != nil }) ?? true
        else {
            throw DispatchValidationError.approvalID
        }
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
    case invalidFieldSet, schema, missingValue, devicePlatform, apnsEnvironment, reason, category, badge
    case approvalID, apnsToken, apnsTopic, collapseId
}

struct APNSPayload: Encodable, Sendable {
    struct APS: Encodable, Sendable {
        struct Alert: Encodable, Sendable {
            let title = "momo"
            let body = "새 알림"
        }

        let alert = Alert()
        let badge: Int
        let threadId: String
        let category: String
        let mutableContent = 1
        let contentAvailable = 1

        enum CodingKeys: String, CodingKey {
            case alert
            case badge
            case threadId = "thread-id"
            case category
            case mutableContent = "mutable-content"
            case contentAvailable = "content-available"
        }
    }

    struct MomoEnvelope: Encodable, Sendable {
        let schema = "momo.push.notification.v2"
        let serverId: String
        let workspaceId: String
        let channelId: String
        let messageId: String
        let collapseId: String
        let reason: String
        let approvalId: String?

        enum CodingKeys: String, CodingKey {
            case schema
            case serverId = "server_id"
            case workspaceId = "workspace_id"
            case channelId = "channel_id"
            case messageId = "message_id"
            case collapseId = "collapse_id"
            case reason
            case approvalId = "approval_id"
        }
    }

    let aps: APS
    let momo: MomoEnvelope

    init(dispatch: PushDispatch) {
        aps = APS(
            badge: dispatch.badge,
            threadId: dispatch.threadId,
            category: dispatch.category)
        momo = MomoEnvelope(
            serverId: dispatch.serverId,
            workspaceId: dispatch.workspaceId,
            channelId: dispatch.channelId,
            messageId: dispatch.messageId,
            collapseId: dispatch.collapseId,
            reason: dispatch.reason,
            approvalId: dispatch.approvalId
        )
    }
}
