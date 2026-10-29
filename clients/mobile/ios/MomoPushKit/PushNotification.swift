// =============================================================================
// INHERITED SOURCE — the origin is GONE: `clients/iOS` was deleted 2026-08-10 (W-S1, #1215),
// so this file is now the ONLY copy and `scripts/verify_push_kit_inheritance.sh` SKIPs it.
// Edit it here, and keep the SENTINEL line below (the verifier still requires it).
//
// Edited after the inheritance, on purpose (each is a behaviour the frozen kit never had):
//   - #4294: a message sent with files and no text is announced by its attachment count
//     (`PushAttachmentCopy`: 「사진 1장」, 「파일 2개」, same sentences as the core's
//     `ATTACH_PREVIEW_COPY`), not left on the relay's 「새 알림」 placeholder. Only `dm` / `mention`
//     pushes: an approval keeps ADR-0204 D7's rule (no body → no 승인·거절 buttons).
//   - #4316: the REST read also says WHO wrote the message (`PushResolution.author`: id, name, human or
//     agent, and the roster's avatar content path when it is exactly this member's — never any other
//     URL), so `PushCommunication.swift` can dress the push as a communication notification. `fetch`
//     still answers with the display alone, byte for byte as before.
//
// Origin: clients/iOS/MomoiOSKit/Sources/MomoiOSPushKit/PushNotification.swift
// Inherited by: goal RN-N1 (ADR-0137 이행 순서 5), 2026-08-03.
//
// Everything below the SENTINEL line WAS a BYTE-FOR-BYTE copy of the origin
// (`scripts/verify_push_kit_inheritance.sh` failed the build if the two drifted).
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
    /// ADR-0204 D7: an approval the lock screen must not decide (it mints a value shown once,
    /// or asks which host). One 「열어서 결정」 button, no 승인·거절. Names its approval like `.approval`.
    case approvalOpen = "momo.approval.open"
    case work = "momo.work"

    public var id: String { rawValue }

    /// Both approval categories carry an `approval_id`; no other category does.
    public var carriesApprovalID: Bool { self == .approval || self == .approvalOpen }
}

/// ADR-0204 D7: 본문을 못 받은(자리표시로 남은) 승인 알림은 잠금 화면에서 승인·거부할 수 없다.
/// 무엇인지 모르는 것에 [승인]/[거부] 버튼을 두지 않고 「열어서 결정」 하나로 낮춘다. 순수 함수라
/// 확장 밖에서 시험된다 (`sim-check`). 승인 카테고리가 아니면 손대지 않는다.
public enum MomoPushCategoryDemotion {
    /// - Parameters:
    ///   - current: 알림이 지금 들고 있는 `categoryIdentifier`.
    ///   - resolved: 확장이 보낸 사람·본문을 실제로 채웠는가.
    public static func categoryIdentifier(current: String, resolved: Bool) -> String {
        guard !resolved, current == MomoPushCategory.approval.rawValue else { return current }
        return MomoPushCategory.approvalOpen.rawValue
    }
}

public enum MomoPushActionIdentifier {
    public static let quickReply = "momo.action.quick-reply"
    public static let approve = "momo.action.approve"
    public static let reject = "momo.action.reject"
    /// The single button of `.approvalOpen`: opens the app on the approval's card. Decides nothing.
    public static let openApproval = "momo.action.open-approval"
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
              ["dm", "mention", "approval_request", "resume_offer", "work_session_idle", "work_run_done"].contains(payload.reason),
              root.aps.category.carriesApprovalID == (approvalID.flatMap(UUID.init(uuidString:)) != nil),
              (root.aps.category.carriesApprovalID || approvalID == nil)
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

/// The picture the roster names for a member: a path on THIS server the push-fetch session's workspace
/// owns, shaped exactly `/v1/workspaces/{ws}/members/{member}/avatar/content?v={version}`.
///
/// The roster's `avatarUrl` is not always that: an older member may carry any string at all (a legacy
/// `avatar_url`, even an address on another host). The extension sends a bearer, so it takes ONLY the
/// one shape it can prove is this workspace's, this member's picture, and builds the request itself from
/// the session's base URL — it never follows a string it was handed. `?v=` is required: the version is
/// what keys the cache, and a picture without one cannot be told from a replaced one.
public struct PushAvatarReference: Equatable, Sendable {
    public let path: String
    public let version: String

    public static func parse(_ raw: String?, workspaceID: String, memberID: String) -> PushAvatarReference? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let prefix = "/v1/workspaces/\(workspaceID.lowercased())/members/\(memberID.lowercased())/avatar/content?v="
        guard raw.lowercased().hasPrefix(prefix) else { return nil }
        let version = String(raw.dropFirst(prefix.count)).lowercased()
        guard isValidVersion(version) else { return nil }
        return PushAvatarReference(path: prefix + version, version: version)
    }

    /// A media id's alphabet and nothing else, so no separator, dot or percent-escape can ride in.
    static func isValidVersion(_ version: String) -> Bool {
        !version.isEmpty && version.count <= 64 && version.unicodeScalars.allSatisfy {
            ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x61 && $0.value <= 0x7A) || $0 == "-" || $0 == "_"
        }
    }
}

/// Who wrote the message, as far as the roster says. Identity only: the text is `PushResolution.display`.
public struct PushResolvedAuthor: Equatable, Sendable {
    public let memberID: String
    public let displayName: String
    public let isAgent: Bool
    /// Nil when the member has no uploaded picture, or when the roster's value is not the one shape above.
    public let avatar: PushAvatarReference?

    public init(memberID: String, displayName: String, isAgent: Bool, avatar: PushAvatarReference?) {
        self.memberID = memberID
        self.displayName = displayName
        self.isAgent = isAgent
        self.avatar = avatar
    }
}

/// What one REST read of a push says: the lines to show and, when a person or an agent wrote the message,
/// who. `author == nil` for the fixed-copy pushes (`work_*`) and whenever the extension fell back.
public struct PushResolution: Equatable, Sendable {
    public let display: PushDisplayContent
    public let author: PushResolvedAuthor?

    public init(display: PushDisplayContent, author: PushResolvedAuthor?) {
        self.display = display
        self.author = author
    }
}

public protocol PushMessageResolving: Sendable {
    func resolve(envelope: MomoPushEnvelope, session: PushFetchSession) async throws -> PushResolution
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

    /// `resolve`, plus the author when the fetcher can say who it is. Same guard and same fallback: a read
    /// that fails is the fallback with no author, which the caller shows exactly as it always has.
    public func resolveDetailed(
        envelope: MomoPushEnvelope,
        session: PushFetchSession,
        fallback: PushDisplayContent = .placeholder
    ) async -> PushResolution {
        guard envelope.workspaceID.lowercased() == session.workspaceID.lowercased() else {
            return PushResolution(display: fallback, author: nil)
        }
        do {
            if let resolving = fetcher as? any PushMessageResolving {
                return try await resolving.resolve(envelope: envelope, session: session)
            }
            return PushResolution(display: try await fetcher.fetch(envelope: envelope, session: session), author: nil)
        } catch {
            return PushResolution(display: fallback, author: nil)
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

/// 「작업 끝남」 — 호스팅 에이전트의 작업(run)이 끝났을 때 (ADR-0162 증보 3 D14, `work_run_done`).
///
/// 문구는 **고정**이다. 이 알림을 부르는 메시지는 에이전트의 답(성공) 또는 오류 시스템
/// 메시지(실패)라서 일반 경로를 타면 그 본문이 잠금 화면에 그대로 뜬다. 제목·산출물·답·
/// 오류는 싣지 않고, 메시지 본문도 읽지 않는다(성공·실패 구분 없이 같은 문구).
public enum PushWorkRunDoneCopy {
    public static let title = "작업이 끝났어요"
    public static let body = "요청한 작업이 끝났어요"

    public static func display() -> PushDisplayContent {
        PushDisplayContent(title: title, body: body)
    }
}

/// 글 없이 사진·파일만 보낸 메시지의 알림 본문 (#4294).
///
/// 서버는 푸시에 본문을 싣지 않고 확장이 REST 로 메시지를 읽어 짓는다(ADR-0204). 그런데 확장은 본문이
/// 빈 메시지를 「읽을 수 없는 메시지」로 던져 relay 자리표시(「oort / 새 알림」)로 떨어졌고, 그러면 승인
/// 버튼도 같이 뗐다. 첨부가 있으면 그 개수로 말한다: 코어 `attachmentPreviewLine` 과 **같은 문장**이다
/// (`packages/momo-core/src/features/attachments/model.ts`). 폰 시험이 이 소스의 문구를 코어 출력과
/// 맞대고, `sim-check` 가 이 함수와 REST 읽기를 실제로 돌린다. 파일 이름은 싣지 않는다: 이름은 사람이 쓴
/// 글이라 잠금 화면에서 본문과 같은 노출이다.
public enum PushAttachmentCopy {
    public static func photos(_ count: Int) -> String { "사진 \(count)장" }
    public static func files(_ count: Int) -> String { "파일 \(count)개" }
    public static let separator = ", "

    /// 어느 알림이 이 문구를 본문으로 쓰는가: 사람·에이전트가 보낸 메시지(`dm`·`mention`)뿐이다.
    /// 승인 알림은 쓰지 않는다. 확장은 본문을 채우면 승인 버튼을 원래대로 되돌려 놓는데(`NotificationService`,
    /// ADR-0204 D7), 「사진 1장」은 무엇을 승인하는지 말해 주지 않는다 — 무엇인지 모르는 것을 잠금 화면에서
    /// 승인하게 두지 않는다는 D7 을 개수 문구가 새 입력으로 풀면 안 된다. 그래서 승인·재개·작업 알림의 빈
    /// 본문은 예전처럼 자리표시로 남고 버튼은 떼어진다. 서버가 짝지은 카테고리가 승인이면 이유가 무엇이든
    /// 같다(파서는 이유와 카테고리를 서로 묶지 않는다).
    public static func announces(_ envelope: MomoPushEnvelope) -> Bool {
        (envelope.reason == "dm" || envelope.reason == "mention") && !envelope.category.carriesApprovalID
    }

    /// 「사진」으로 세는 것: 사진으로 그려지는 래스터 이미지. SVG 는 타임라인이 카드로 세우므로 파일이다.
    public static func isPhoto(mime: String) -> Bool {
        let lowered = mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lowered.hasPrefix("image/") && !lowered.hasPrefix("image/svg")
    }

    /// 첨부 한 묶음의 한 줄: 「사진 1장」, 「사진 3장」, 「파일 2개」, 「사진 1장, 파일 1개」. 없으면 nil.
    public static func line(mimeTypes: [String]) -> String? {
        guard !mimeTypes.isEmpty else { return nil }
        let photoCount = mimeTypes.filter { isPhoto(mime: $0) }.count
        let fileCount = mimeTypes.count - photoCount
        var parts: [String] = []
        if photoCount > 0 { parts.append(photos(photoCount)) }
        if fileCount > 0 { parts.append(files(fileCount)) }
        return parts.joined(separator: separator)
    }
}

public actor MomoPushRESTFetcher: PushMessageFetching, PushMessageResolving {
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

    /// 첨부 목록에서 이 파일이 읽는 것은 종류(`mime`)뿐이다. 배열이 아니거나 항목이 깨져도 메시지 전체를
    /// 버리지 않는다(`Props` 와 같은 규율): 깨진 항목은 종류를 모르는 파일 하나로 센다.
    private struct Attachments: Decodable {
        let mimeTypes: [String]

        private struct Entry: Decodable {
            let mime: String?

            enum CodingKeys: String, CodingKey { case mime }

            init(from decoder: Decoder) throws {
                let container = try? decoder.container(keyedBy: CodingKeys.self)
                mime = try? container?.decode(String.self, forKey: .mime)
            }
        }

        init(from decoder: Decoder) throws {
            var mimes: [String] = []
            if var list = try? decoder.unkeyedContainer() {
                while !list.isAtEnd {
                    mimes.append(((try? list.decode(Entry.self))?.mime) ?? "")
                }
            }
            mimeTypes = mimes
        }
    }

    /// 문자열 한 칸을 읽되 모양이 어긋나도(숫자·객체) 던지지 않는다: 한 칸 때문에 메시지 페이지 전체를 잃지
    /// 않는다(`Props`·`Attachments` 와 같은 규율).
    private struct LenientText: Decodable {
        let value: String?

        init(from decoder: Decoder) throws {
            value = try? decoder.singleValueContainer().decode(String.self)
        }
    }

    private struct Message: Decodable {
        let id: String
        let authorMemberID: String
        let body: String?
        let rootID: String?
        let props: Props?
        let attachments: Attachments?
        /// 「지워진 메시지」를 가리는 데만 쓴다(`"deleted"`). 서버는 삭제 때 글은 비우지만 첨부 목록은 그대로 싣는다.
        let state: LenientText?

        enum CodingKeys: String, CodingKey {
            case id, body, props, attachments, state
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
        /// Read as leniently as `Props` and `Attachments` (#4316): a member whose `kind` or `avatarUrl` has an
        /// odd shape costs the notification its picture, never its name.
        let kind: LenientText?
        let avatarUrl: LenientText?
    }

    private let session: URLSession
    private let decoder = JSONDecoder()

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetch(envelope: MomoPushEnvelope, session fetchSession: PushFetchSession) async throws -> PushDisplayContent {
        try await resolve(envelope: envelope, session: fetchSession).display
    }

    public func resolve(envelope: MomoPushEnvelope, session fetchSession: PushFetchSession) async throws -> PushResolution {
        let root = "/v1/workspaces/\(fetchSession.workspaceID)"
        async let messageData = get(
            root + "/channels/\(envelope.channelID)/messages?limit=200",
            fetchSession: fetchSession
        )
        // 이름 목록은 메시지 쪽과 **동시에** 읽는다(#4316: 왕복 하나를 아낀다) — 그 목록이 늘 필요한 푸시만.
        // `work_*` 두 갈래는 아래 주석대로 목록을 읽지 않거나 카드를 본 뒤에야 안다.
        let readsRosterAlways = envelope.reason != "work_run_done" && envelope.reason != "work_session_idle"
        async let earlyRoster: Data? = readsRosterAlways ? get(root + "/roster", fetchSession: fetchSession) : nil
        // `work_run_done` 은 메시지를 읽기 전에 고정 문구로 끝낸다: 본문(에이전트의 답·오류)을
        // 디코드하지도 않는다. 일반 경로로 새면 잠금 화면에 답 전문이 뜬다.
        if envelope.reason == "work_run_done" {
            _ = try await messageData
            return PushResolution(display: PushWorkRunDoneCopy.display(), author: nil)
        }
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
            return PushResolution(
                display: PushWorkCompleteCopy.display(label: rootLabel, ranMs: card.props?.ranMs), author: nil)
        }
        let rosterData: Data
        if let early = try await earlyRoster {
            rosterData = early
        } else {
            rosterData = try await get(root + "/roster", fetchSession: fetchSession)
        }
        let roster = try decoder.decode(Roster.self, from: rosterData)
        guard let message = page.messages.first(where: { $0.id.lowercased() == envelope.messageID.lowercased() }),
              let body = Self.displayBody(of: message, for: envelope),
              let author = roster.members.first(where: {
                  $0.id.lowercased() == message.authorMemberID.lowercased()
              }),
              !author.displayName.isEmpty
        else {
            throw MomoPushError.messageUnavailable
        }
        return PushResolution(
            display: PushDisplayContent(title: author.displayName, body: body),
            author: PushResolvedAuthor(
                memberID: author.id.lowercased(),
                displayName: author.displayName,
                isAgent: author.kind?.value == "agent",
                avatar: PushAvatarReference.parse(
                    author.avatarUrl?.value, workspaceID: fetchSession.workspaceID, memberID: author.id)))
    }

    /// 알림 본문: 글이 있으면 글. 글 없이 첨부만 있으면 개수 문구(#4294) — `PushAttachmentCopy.announces`
    /// 가 허락한 알림(`dm`·`mention`)에서만, 그리고 지워지지 않은 메시지에서만. 지워진 메시지는 서버가 첨부
    /// 목록을 그대로 실어 보내도 개수를 말하지 않는다(보낸 사람이 거둔 것을 잠금 화면에 올리지 않는다; 코어의
    /// 인박스·배너도 삭제를 먼저 본다). 그 밖이거나 첨부도 없으면 nil(자리표시로 남는다).
    private static func displayBody(of message: Message, for envelope: MomoPushEnvelope) -> String? {
        let text = message.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !text.isEmpty { return text }
        guard PushAttachmentCopy.announces(envelope), message.state?.value != "deleted" else { return nil }
        return PushAttachmentCopy.line(mimeTypes: message.attachments?.mimeTypes ?? [])
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
