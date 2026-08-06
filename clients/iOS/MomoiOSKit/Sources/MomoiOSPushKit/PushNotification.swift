import Foundation
import Security

public enum MomoPushContract {
    public static let appGroupIdentifier = "group.app.momo.ios"
    public static let keychainAccessGroupInfoKey = "MomoKeychainAccessGroup"
    public static let secureSessionService = "app.momo.ios.session"
    public static let authenticatedSessionAccount = "authenticated-session"
    public static let pushFetchSessionAccount = "push-fetch-session"
    /// Legacy App Group key. Read only during the one-time Keychain migration.
    public static let sessionKey = "momo.ios.dev.session.push-fetch"
    public static let placeholderTitle = "oort"
    public static let placeholderBody = "새 알림"
}

/// Narrow secure-value boundary shared by the app and notification extension.
/// Session credentials never use UserDefaults, URLs, or diagnostic output.
public protocol MomoSecureValueStoring: Sendable {
    func data(for account: String) -> Data?
    @discardableResult func set(_ data: Data, for account: String) -> Bool
    func removeValue(for account: String)
}

public struct MomoKeychainValueStore: MomoSecureValueStoring, Sendable {
    private let service: String
    private let accessGroup: String?

    public init(
        service: String = MomoPushContract.secureSessionService,
        accessGroup: String? = Bundle.main.object(
            forInfoDictionaryKey: MomoPushContract.keychainAccessGroupInfoKey
        ) as? String
    ) {
        self.service = service
        self.accessGroup = accessGroup?.isEmpty == false ? accessGroup : nil
    }

    public func data(for account: String) -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    @discardableResult
    public func set(_ data: Data, for account: String) -> Bool {
        let query = baseQuery(account: account)
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }
        var addition = query
        addition[kSecValueData as String] = data
        addition[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(addition as CFDictionary, nil) == errSecSuccess
    }

    public func removeValue(for account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

public enum MomoPushCategory: String, CaseIterable, Codable, Sendable, Hashable, Identifiable {
    case message = "momo.message"
    case mention = "momo.mention"
    case approval = "momo.approval"
    case work = "momo.work"

    public var id: String { rawValue }
}

public enum MomoPushActionIdentifier {
    public static let quickReply = "momo.action.quick-reply"
    public static let approve = "momo.action.approve"
    public static let reject = "momo.action.reject"
}

public struct PushFetchSession: Codable, Equatable, Sendable {
    public let baseURL: URL
    public let workspaceID: String
    public let accessToken: String

    public init(baseURL: URL, workspaceID: String, accessToken: String) {
        self.baseURL = baseURL
        self.workspaceID = workspaceID
        self.accessToken = accessToken
    }
}

public struct MomoPushEnvelope: Equatable, Hashable, Sendable {
    public let schema: String
    public let serverID: String
    public let workspaceID: String
    public let channelID: String
    public let messageID: String
    public let collapseID: String
    public let reason: String
    public let approvalID: String?
    public let threadID: String
    public let category: MomoPushCategory
    public let badge: Int

    public var threadRootID: String? {
        threadID.lowercased() == channelID.lowercased() ? nil : threadID
    }

    public var deepLinkURL: URL? {
        var components = URLComponents()
        components.scheme = "momo"
        components.host = "push"
        components.path = "/workspaces/\(workspaceID)/channels/\(channelID)/messages/\(messageID)"
        var items = [URLQueryItem(name: "category", value: category.rawValue)]
        if let threadRootID {
            items.append(URLQueryItem(name: "thread", value: threadRootID))
        }
        components.queryItems = items
        return components.url
    }
}

public enum MomoPushParser {
    private struct Root: Decodable {
        struct APS: Decodable {
            let badge: Int
            let threadID: String
            let category: MomoPushCategory

            enum CodingKeys: String, CodingKey {
                case badge
                case threadID = "thread-id"
                case category
            }
        }

        struct Envelope: Decodable {
            let schema: String
            let serverID: String
            let workspaceID: String
            let channelID: String
            let messageID: String
            let collapseID: String
            let reason: String
            let approvalID: String?

            enum CodingKeys: String, CodingKey {
                case schema
                case serverID = "server_id"
                case workspaceID = "workspace_id"
                case channelID = "channel_id"
                case messageID = "message_id"
                case collapseID = "collapse_id"
                case reason
                case approvalID = "approval_id"
            }
        }

        let aps: APS
        let momo: Envelope
    }

    public static func parse(data: Data) throws -> MomoPushEnvelope {
        let root = try JSONDecoder().decode(Root.self, from: data)
        let payload = root.momo
        let approvalID = payload.approvalID?.lowercased()
        guard payload.schema == "momo.push.notification.v2",
              UUID(uuidString: payload.workspaceID) != nil,
              UUID(uuidString: payload.channelID) != nil,
              UUID(uuidString: payload.messageID) != nil,
              UUID(uuidString: root.aps.threadID) != nil,
              !payload.serverID.isEmpty,
              !payload.collapseID.isEmpty,
              root.aps.badge >= 0,
              ["dm", "mention", "approval_request", "resume_offer"].contains(payload.reason),
              (root.aps.category == .approval) == (approvalID.flatMap(UUID.init(uuidString:)) != nil),
              (root.aps.category == .approval || approvalID == nil)
        else {
            throw MomoPushError.invalidEnvelope
        }
        return MomoPushEnvelope(
            schema: payload.schema,
            serverID: payload.serverID,
            workspaceID: payload.workspaceID.lowercased(),
            channelID: payload.channelID.lowercased(),
            messageID: payload.messageID.lowercased(),
            collapseID: payload.collapseID,
            reason: payload.reason,
            approvalID: approvalID,
            threadID: root.aps.threadID.lowercased(),
            category: root.aps.category,
            badge: root.aps.badge
        )
    }

    public static func parse(userInfo: [AnyHashable: Any]) throws -> MomoPushEnvelope {
        try parse(data: JSONSerialization.data(withJSONObject: userInfo))
    }
}

public struct PushDisplayContent: Equatable, Sendable {
    public let title: String
    public let body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }

    public static let placeholder = PushDisplayContent(
        title: MomoPushContract.placeholderTitle,
        body: MomoPushContract.placeholderBody
    )
}

public protocol PushMessageFetching: Sendable {
    func fetch(envelope: MomoPushEnvelope, session: PushFetchSession) async throws -> PushDisplayContent
}

public struct PushNotificationResolver: Sendable {
    private let fetcher: any PushMessageFetching

    public init(fetcher: any PushMessageFetching) {
        self.fetcher = fetcher
    }

    public func resolve(
        envelope: MomoPushEnvelope,
        session: PushFetchSession,
        fallback: PushDisplayContent = .placeholder
    ) async -> PushDisplayContent {
        guard envelope.workspaceID.lowercased() == session.workspaceID.lowercased() else {
            return fallback
        }
        do {
            return try await fetcher.fetch(envelope: envelope, session: session)
        } catch {
            return fallback
        }
    }
}

public actor MomoPushRESTFetcher: PushMessageFetching {
    private struct MessagePage: Decodable {
        let messages: [Message]
    }

    private struct Message: Decodable {
        let id: String
        let authorMemberID: String
        let body: String?

        enum CodingKeys: String, CodingKey {
            case id, body
            case authorMemberID = "authorMemberId"
        }
    }

    private struct Roster: Decodable {
        let members: [Member]
    }

    private struct Member: Decodable {
        let id: String
        let displayName: String
    }

    private let session: URLSession
    private let decoder = JSONDecoder()

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetch(envelope: MomoPushEnvelope, session fetchSession: PushFetchSession) async throws -> PushDisplayContent {
        let root = "/v1/workspaces/\(fetchSession.workspaceID)"
        async let messageData = get(
            root + "/channels/\(envelope.channelID)/messages?limit=200",
            fetchSession: fetchSession
        )
        async let rosterData = get(root + "/roster", fetchSession: fetchSession)
        let page = try decoder.decode(MessagePage.self, from: try await messageData)
        let roster = try decoder.decode(Roster.self, from: try await rosterData)
        guard let message = page.messages.first(where: { $0.id.lowercased() == envelope.messageID.lowercased() }),
              let body = message.body?.trimmingCharacters(in: .whitespacesAndNewlines),
              !body.isEmpty,
              let author = roster.members.first(where: {
                  $0.id.lowercased() == message.authorMemberID.lowercased()
              }),
              !author.displayName.isEmpty
        else {
            throw MomoPushError.messageUnavailable
        }
        return PushDisplayContent(title: author.displayName, body: body)
    }

    private func get(_ path: String, fetchSession: PushFetchSession) async throws -> Data {
        guard let url = URL(string: path, relativeTo: fetchSession.baseURL)?.absoluteURL else {
            throw MomoPushError.invalidURL
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(fetchSession.accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw MomoPushError.fetchFailed
        }
        return data
    }
}

public enum MomoPushError: Error {
    case invalidEnvelope
    case invalidURL
    case messageUnavailable
    case fetchFailed
}
