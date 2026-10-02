// =============================================================================
// INHERITED SOURCE — DO NOT EDIT HERE, AND DO NOT EDIT THE ORIGINAL EITHER.
//
// Origin: clients/iOS/MomoiOSKit/Sources/MomoiOSPushKit/PushNotification.swift
// Inherited by: goal RN-N1 (ADR-0137 이행 순서 5), 2026-08-03.
//
// Everything below the SENTINEL line is a BYTE-FOR-BYTE copy of the origin.
// `scripts/verify_push_kit_inheritance.sh` fails the build if the two drift.
//
// Why copied rather than referenced as the `MomoiOSPushKit` SPM product
// (audit 2026-08-02 §3.1 left the choice open; these are the reasons for copy):
//
//   1. Package.swift declares PACKAGE-level dependencies on ../../Core,
//      centrifuge-swift and LiveKit. SwiftPM resolves the whole manifest graph
//      even when only the dependency-free `MomoiOSPushKit` PRODUCT is linked, so
//      referencing it would drag LiveKit/WebRTC resolution into every clean
//      build of an app that links none of it.
//   2. That package declares platforms: [.iOS(.v17)]. This app targets 15.1.
//      A package cannot be consumed below its own floor, and clients/iOS is
//      read-only in this batch, so the floor cannot be lowered.
//   3. ADR-0137 D8 freezes clients/iOS and RETIRES it once RN reaches parity.
//      A build-time reference would put the shipping app's build graph on a
//      directory scheduled for deletion.
//   4. The NSE must not inherit the RN Pods graph (audit §3.1). A plain source
//      copy has zero package-manager surface; an SPM reference does not.
//
// The cost of copying is drift. That cost is paid by the verifier named above,
// which is why this file must stay byte-identical rather than being "tidied".
//
// ===== SENTINEL: INHERITED BYTES BEGIN =====
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
              ["dm", "mention", "approval_request", "resume_offer", "work_session_idle"].contains(payload.reason),
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

/// 「작업 끝남」 알림의 문구 (ADR-0120 부록 A, #3342). 순수 함수라 네트워크 없이 시험된다.
///
/// 제목은 「작업이 끝났어요」이고, 세션 이름을 알면 ` · 이름`을 붙인다. 본문은 끝난 턴의 길이다
/// (`ran_ms` — 서버가 60초 이상일 때만 이 알림을 보낸다). 이름이나 길이를 모르면 **있는 만큼만**
/// 말한다: 모르는 것을 지어내는 것보다 짧은 문장이 낫다.
public enum PushWorkCompleteCopy {
    public static let title = "작업이 끝났어요"
    public static let fallbackBody = "작업이 끝나 대기 중이에요"

    public static func display(label: String?, ranMs: Int64?) -> PushDisplayContent {
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = trimmed.isEmpty ? Self.title : "\(Self.title) · \(trimmed)"
        guard let ranMs, ranMs >= 60_000 else {
            return PushDisplayContent(title: title, body: fallbackBody)
        }
        let minutes = Int(ranMs / 60_000)
        let span: String
        if minutes >= 60 {
            let hours = minutes / 60
            let rest = minutes % 60
            span = rest == 0 ? "\(hours)시간" : "\(hours)시간 \(rest)분"
        } else {
            span = "\(minutes)분"
        }
        return PushDisplayContent(title: title, body: "\(span) 만에 끝났어요")
    }
}

public actor MomoPushRESTFetcher: PushMessageFetching {
    private struct MessagePage: Decodable {
        let messages: [Message]
    }

    /// 카드 `props` 에서 이 파일이 읽는 세 키. 하나라도 모양이 달라도(문자열이 아니거나 없거나)
    /// 메시지 전체를 버리지 않는다 — 각 키를 따로, 실패하면 nil 로 읽는다.
    private struct Props: Decodable {
        let kind: String?
        let ranMs: Int64?
        let label: String?

        enum CodingKeys: String, CodingKey {
            case kind, label
            case ranMs = "ran_ms"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = try? container.decode(String.self, forKey: .kind)
            ranMs = try? container.decode(Int64.self, forKey: .ranMs)
            label = try? container.decode(String.self, forKey: .label)
        }
    }

    private struct Message: Decodable {
        let id: String
        let authorMemberID: String
        let body: String?
        let rootID: String?
        let props: Props?

        enum CodingKeys: String, CodingKey {
            case id, body, props
            case authorMemberID = "authorMemberId"
            case rootID = "rootId"
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
        let page = try decoder.decode(MessagePage.self, from: try await messageData)
        // 「작업 끝남」 카드의 작성자는 **받는 사람 본인**(세션을 시작한 사람)이라, 아래의
        // 「작성자 이름 + 본문」 규칙을 타면 「내 이름 / 작업 완료 — idle 대기」가 된다.
        // 카드가 말하는 것은 사람이 아니라 세션이므로 문구를 따로 짓는다. 이름 목록은
        // 이 갈래에서 읽지 않는다.
        if envelope.reason == "work_session_idle",
           let card = page.messages.first(where: { $0.id.lowercased() == envelope.messageID.lowercased() }),
           card.props?.kind == "work_session_idle" {
            // 세션 이름은 카드가 아니라 **루트 카드**의 `props.label` 에 있다. 같은 쪽(최근
            // 200개)에 있을 때만 쓴다 — 없으면 이름 없이 말한다.
            let rootLabel = page.messages
                .first(where: { $0.id.lowercased() == (card.rootID ?? "").lowercased() })?
                .props?.label
            return PushWorkCompleteCopy.display(label: rootLabel, ranMs: card.props?.ranMs)
        }
        let roster = try decoder.decode(Roster.self, from: try await get(root + "/roster", fetchSession: fetchSession))
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
