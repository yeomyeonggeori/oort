import Foundation
import AppKit
import Security
import SwiftUI
import MomoCore

// MARK: - Real-server session bootstrap

public struct MomoServerSession: Equatable, Sendable {
    public var baseURL: URL
    public var centrifugoWebSocketURL: URL?
    public var workspace: WorkspaceID
    public var member: Member
    public var accessToken: String
    public var refreshToken: String
    public var email: String
    public var joinedWithInvite: Bool

    public init(
        baseURL: URL,
        centrifugoWebSocketURL: URL? = nil,
        workspace: WorkspaceID,
        member: Member,
        accessToken: String,
        refreshToken: String,
        email: String,
        joinedWithInvite: Bool = false
    ) {
        self.baseURL = baseURL
        self.centrifugoWebSocketURL = centrifugoWebSocketURL
        self.workspace = workspace
        self.member = member
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.email = email
        self.joinedWithInvite = joinedWithInvite
    }

    public var summaryTitle: String {
        "\(member.displayName) @ \(baseURL.host ?? baseURL.absoluteString)"
    }
}

public struct MomoServerSessionForm: Equatable, Sendable {
    public var baseURLString: String
    public var email: String
    public var password: String
    public var inviteCode: String
    public var savePassword: Bool

    public init(
        baseURLString: String = "",
        email: String = "",
        password: String = "",
        inviteCode: String = "",
        savePassword: Bool = false
    ) {
        self.baseURLString = baseURLString
        self.email = email
        self.password = password
        self.inviteCode = inviteCode
        self.savePassword = savePassword
    }

    public var trimmedInviteCode: String {
        inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var onboardingPrimaryAction: MomoSessionPrimaryAction {
        hasCredentialInput ? .signIn : .demo
    }

    var canJoinWithInvite: Bool {
        hasCredentialInput && !trimmedInviteCode.isEmpty
    }

    var canSignIn: Bool {
        hasCredentialInput
    }

    private var hasCredentialInput: Bool {
        !baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
    }

    public func validatedBaseURL() throws -> URL {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil, url.host != nil else {
            throw MomoServerSessionError.validation("Enter a server URL like http://macbook.local:28180.")
        }
        return url
    }

    public func validatedEmail() throws -> String {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("@"), trimmed.contains(".") else {
            throw MomoServerSessionError.validation("Enter the email used by the MomoServer workspace.")
        }
        return trimmed
    }

    public func validatedPassword() throws -> String {
        guard !password.isEmpty else {
            throw MomoServerSessionError.validation("Enter a password for this internal test login.")
        }
        return password
    }
}

enum MomoSessionPrimaryAction: Equatable {
    case demo
    case signIn
}

enum MomoSessionFailureKind: Equatable {
    case offline
    case authentication
    case other
}

public enum MomoServerSessionError: LocalizedError, Equatable, Sendable {
    case validation(String)
    case missingWorkspace(String)
    case problem(status: Int, title: String?, detail: String?)
    case decoding(String)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .validation(let message), .missingWorkspace(let message), .decoding(let message), .transport(let message):
            return message
        case .problem(_, let title, let detail):
            return [title, detail].compactMap { $0 }.joined(separator: ": ")
        }
    }

    var onboardingFailureKind: MomoSessionFailureKind {
        switch self {
        case .transport:
            return .offline
        case .problem(let status, _, _) where status == 401 || status == 403:
            return .authentication
        case .validation, .missingWorkspace, .problem, .decoding:
            return .other
        }
    }
}

public enum MomoServerSessionMode: Equatable, Sendable {
    case demo
    case real

    public var title: String {
        switch self {
        case .demo: return "Demo"
        case .real: return "Real Server"
        }
    }
}

public struct MomoServerSessionSummary: Equatable, Sendable {
    public var mode: MomoServerSessionMode
    public var title: String
    public var detail: String
    public var channelCount: Int
    public var serverURLString: String?
    public var workspaceIDString: String?
    public var memberDisplayName: String?
    public var memberHandle: String?
    public var memberKind: MemberKind?
    public var email: String?

    public init(
        mode: MomoServerSessionMode,
        title: String,
        detail: String,
        channelCount: Int,
        serverURLString: String? = nil,
        workspaceIDString: String? = nil,
        memberDisplayName: String? = nil,
        memberHandle: String? = nil,
        memberKind: MemberKind? = nil,
        email: String? = nil
    ) {
        self.mode = mode
        self.title = title
        self.detail = detail
        self.channelCount = channelCount
        self.serverURLString = serverURLString
        self.workspaceIDString = workspaceIDString
        self.memberDisplayName = memberDisplayName
        self.memberHandle = memberHandle
        self.memberKind = memberKind
        self.email = email
    }

    public var workspaceShortID: String? {
        workspaceIDString.map { String($0.prefix(8)) }
    }

    public var memberLabel: String? {
        guard let memberDisplayName else { return nil }
        if let memberHandle, !memberHandle.isEmpty {
            return "\(memberDisplayName) (@\(memberHandle))"
        }
        return memberDisplayName
    }
}

public enum MomoUILanguage: String, CaseIterable, Identifiable, Sendable {
    case korean = "ko"
    case english = "en"

    public var id: String { rawValue }

    public static var preferredDefault: MomoUILanguage {
        let preferred = Locale.preferredLanguages.first?.lowercased() ?? ""
        return preferred.hasPrefix("ko") ? .korean : .english
    }

    public var displayName: String {
        switch self {
        case .korean: return "한국어"
        case .english: return "English"
        }
    }
}

public struct MomoInviteAdminContext: Equatable, Sendable {
    public var baseURL: URL
    public var workspace: WorkspaceID
    public var accessToken: String

    public init(baseURL: URL, workspace: WorkspaceID, accessToken: String) {
        self.baseURL = baseURL
        self.workspace = workspace
        self.accessToken = accessToken
    }
}

public struct MomoInviteCreateRequest: Equatable, Sendable, Encodable {
    public var role: MembershipRole
    public var maxUses: Int
    public var expiresAtMs: Int64
    public var metadata: [String: String]?

    public init(
        role: MembershipRole = .member,
        maxUses: Int = 1,
        expiresAtMs: Int64,
        metadata: [String: String]? = nil
    ) {
        self.role = role
        self.maxUses = maxUses
        self.expiresAtMs = expiresAtMs
        self.metadata = metadata
    }
}

public struct MomoInviteCode: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var workspaceId: WorkspaceID
    public var codePreview: String
    public var role: MembershipRole
    public var maxUses: Int
    public var usedCount: Int
    public var expiresAtMs: Int64
    public var revokedAtMs: Int64?
    public var revokedBy: MemberID?
    public var revocationReason: String?
    public var createdBy: MemberID
    public var createdAtMs: Int64
    public var updatedAtMs: Int64

    public var isRevoked: Bool { revokedAtMs != nil }
    public var isExhausted: Bool { usedCount >= maxUses }
    public var isExpired: Bool { expiresAtMs <= Int64(Date().timeIntervalSince1970 * 1000) }

    public var statusLabel: String {
        if isRevoked { return "Revoked" }
        if isExpired { return "Expired" }
        if isExhausted { return "Used" }
        return "Active"
    }
}

public struct MomoCreatedInvite: Equatable, Sendable {
    public var invite: MomoInviteCode
    public var code: String
}

public actor MomoInviteAdminClient {
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func createInvite(
        context: MomoInviteAdminContext,
        request body: MomoInviteCreateRequest
    ) async throws -> MomoCreatedInvite {
        try await post(
            "/v1/workspaces/\(context.workspace.description)/invites",
            context: context,
            body: body,
            response: CreateInviteResponse.self
        ).createdInvite
    }

    public func listInvites(
        context: MomoInviteAdminContext,
        includeRevoked: Bool = true,
        limit: Int = 50
    ) async throws -> [MomoInviteCode] {
        var components = URLComponents(
            url: context.baseURL.appendingPathComponent("/v1/workspaces/\(context.workspace.description)/invites"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "include_revoked", value: includeRevoked ? "true" : "false"),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else {
            throw MomoServerSessionError.validation("Invalid invite list URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        authorize(&request, token: context.accessToken)
        return try await execute(request, response: InviteListResponse.self).invites.map(\.invite)
    }

    public func revokeInvite(
        context: MomoInviteAdminContext,
        inviteID: UUID,
        reason: String?
    ) async throws -> MomoInviteCode {
        try await post(
            "/v1/workspaces/\(context.workspace.description)/invites/\(inviteID.uuidString)/revoke",
            context: context,
            body: RevokeInviteRequest(reason: reason),
            response: InviteCodeDTO.self
        ).invite
    }

    private func post<RequestBody: Encodable, ResponseBody: Decodable>(
        _ path: String,
        context: MomoInviteAdminContext,
        body: RequestBody,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: context.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        authorize(&request, token: context.accessToken)
        return try await execute(request, response: response)
    }

    private func authorize(_ request: inout URLRequest, token: String) {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    private func execute<T: Decodable>(_ request: URLRequest, response: T.Type) async throws -> T {
        do {
            let (data, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else {
                throw MomoServerSessionError.transport("Server did not return an HTTP response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw problemError(status: http.statusCode, data: data)
            }
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw MomoServerSessionError.decoding(String(describing: error))
            }
        } catch let error as MomoServerSessionError {
            throw error
        } catch {
            throw MomoServerSessionError.transport(error.localizedDescription)
        }
    }

    private func problemError(status: Int, data: Data) -> MomoServerSessionError {
        if let problem = try? decoder.decode(ProblemResponse.self, from: data) {
            return .problem(status: status, title: problem.title, detail: problem.detail ?? problem.message)
        }
        return .problem(status: status, title: HTTPURLResponse.localizedString(forStatusCode: status), detail: nil)
    }
}

public actor MomoServerSessionClient {
    private let session: URLSession
    private let environment: [String: String]
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        session: URLSession = .shared,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.session = session
        self.environment = environment
    }

    public func login(form: MomoServerSessionForm, workspace: WorkspaceID? = nil) async throws -> MomoServerSession {
        let baseURL = try form.validatedBaseURL()
        let email = try form.validatedEmail()
        let password = try form.validatedPassword()
        let response = try await post(
            LoginRequest(email: email, password: password, workspace: workspace?.description),
            to: baseURL.appendingPathComponent("/v1/auth/login"),
            response: LoginResponse.self
        )
        let member = try response.member.member()
        return MomoServerSession(
            baseURL: baseURL,
            centrifugoWebSocketURL: try Self.preferredRealtimeWebSocketURL(
                serverValue: response.realtimeWebSocketUrl,
                environment: environment
            ),
            workspace: member.workspaceId,
            member: member,
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            email: email,
            joinedWithInvite: false
        )
    }

    public func join(form: MomoServerSessionForm) async throws -> MomoServerSession {
        let baseURL = try form.validatedBaseURL()
        let email = try form.validatedEmail()
        let password = try form.validatedPassword()
        let code = form.trimmedInviteCode
        guard !code.isEmpty else {
            throw MomoServerSessionError.validation("Enter an invite code or use login.")
        }
        let response = try await post(
            JoinRequest(
                code: code,
                email: email,
                displayName: Self.displayName(from: email),
                handle: Self.handle(from: email),
                password: password,
                timeZone: TimeZone.current.identifier
            ),
            to: baseURL.appendingPathComponent("/v1/join"),
            response: JoinResponse.self
        )
        guard let workspace = WorkspaceID(uuidString: response.workspaceId) else {
            throw MomoServerSessionError.missingWorkspace("Join succeeded but returned an invalid workspace id.")
        }
        return MomoServerSession(
            baseURL: baseURL,
            centrifugoWebSocketURL: try Self.preferredRealtimeWebSocketURL(
                serverValue: response.realtimeWebSocketUrl,
                environment: environment
            ),
            workspace: workspace,
            member: try response.member.member(),
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            email: email,
            joinedWithInvite: true
        )
    }

    private func post<RequestBody: Encodable, ResponseBody: Decodable>(
        _ body: RequestBody,
        to url: URL,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)

        do {
            let (data, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else {
                throw MomoServerSessionError.transport("Server did not return an HTTP response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw problemError(status: http.statusCode, data: data)
            }
            do {
                return try decoder.decode(ResponseBody.self, from: data)
            } catch {
                throw MomoServerSessionError.decoding(String(describing: error))
            }
        } catch let error as MomoServerSessionError {
            throw error
        } catch {
            throw MomoServerSessionError.transport(error.localizedDescription)
        }
    }

    private func problemError(status: Int, data: Data) -> MomoServerSessionError {
        if let problem = try? decoder.decode(ProblemResponse.self, from: data) {
            return .problem(status: status, title: problem.title, detail: problem.detail ?? problem.message)
        }
        return .problem(status: status, title: HTTPURLResponse.localizedString(forStatusCode: status), detail: nil)
    }

    private static func displayName(from email: String) -> String {
        let local = email.split(separator: "@").first.map(String.init) ?? email
        return local
            .split(separator: ".")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    private static func handle(from email: String) -> String {
        let local = email.split(separator: "@").first.map(String.init) ?? email
        let allowed = local.lowercased().map { character -> Character in
            character.isLetter || character.isNumber || character == "-" ? character : "-"
        }
        let handle = String(allowed).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return handle.isEmpty ? "momo-user" : handle
    }

    private static func centrifugoWebSocketURL(from environment: [String: String]) -> URL? {
        if let raw = environment["MOMO_CENTRIFUGO_WS_URL"], !raw.isEmpty {
            return URL(string: raw)
        }
        if let rawPort = environment["CENT_PORT"], let port = Int(rawPort), port > 0 {
            return URL(string: "ws://127.0.0.1:\(port)/connection/websocket")
        }
        return nil
    }

    private static func preferredRealtimeWebSocketURL(
        serverValue: String?,
        environment: [String: String]
    ) throws -> URL? {
        if let serverValue {
            guard let url = URL(string: serverValue),
                  url.host != nil,
                  url.scheme == "ws" || url.scheme == "wss"
            else {
                throw MomoServerSessionError.decoding("Server returned an invalid realtime WebSocket URL.")
            }
            return url
        }
        return centrifugoWebSocketURL(from: environment)
    }
}

// MARK: - Session storage

public final class MomoServerSessionStore: @unchecked Sendable {
    public static let shared = MomoServerSessionStore()

    private static let developmentBundleIdentifier = "app.momo.dev.MomoMacDevApp"

    private let defaults: UserDefaults
    private let keychain: MomoKeychainPasswordStore
    private let prefix: String
    private let usesDevelopmentPasswordStorage: Bool

    public init(
        defaults: UserDefaults = .standard,
        keychain: MomoKeychainPasswordStore = .init(),
        prefix: String = "momo.mac.session.",
        bundleIdentifier: String? = Bundle.main.bundleIdentifier
    ) {
        self.defaults = defaults
        self.keychain = keychain
        self.prefix = prefix
        self.usesDevelopmentPasswordStorage = bundleIdentifier == Self.developmentBundleIdentifier
    }

    public func load() -> MomoServerSessionForm {
        // W-O4: shipped builds start with neutral, empty fields (the credential
        // form shows example placeholders). Only the local development app keeps
        // the seeded demo defaults so day-to-day dev testing stays one launch away.
        let baseURL = defaults.string(forKey: key("baseURL")) ?? defaultBaseURL
        let email = defaults.string(forKey: key("email")) ?? defaultEmail
        let inviteCode = defaults.string(forKey: key("inviteCode")) ?? ""
        let savePassword = defaults.bool(forKey: key("savePassword"))
        let password: String
        if usesDevelopmentPasswordStorage {
            let storedPassword = savePassword ? defaults.string(forKey: key("password")) : nil
            password = storedPassword ?? "dev-password"
        } else {
            password = savePassword ? (keychain.password(account: email) ?? "") : ""
        }
        return MomoServerSessionForm(
            baseURLString: baseURL,
            email: email,
            password: password,
            inviteCode: inviteCode,
            savePassword: savePassword
        )
    }

    public func save(_ form: MomoServerSessionForm) {
        let email = form.email.trimmingCharacters(in: .whitespacesAndNewlines)
        defaults.set(form.baseURLString.trimmingCharacters(in: .whitespacesAndNewlines), forKey: key("baseURL"))
        defaults.set(email, forKey: key("email"))
        defaults.set(form.trimmedInviteCode, forKey: key("inviteCode"))
        defaults.set(form.savePassword, forKey: key("savePassword"))
        if usesDevelopmentPasswordStorage {
            // Dev-only decision (성재, 2026-07-17): avoid ad-hoc app rebuilds invalidating Keychain ACLs.
            if form.savePassword {
                defaults.set(form.password, forKey: key("password"))
            } else {
                defaults.removeObject(forKey: key("password"))
            }
        } else if form.savePassword {
            keychain.setPassword(form.password, account: email)
        } else {
            keychain.deletePassword(account: email)
        }
    }

    public func clearSessionSensitiveState(email: String? = nil) {
        if usesDevelopmentPasswordStorage {
            defaults.removeObject(forKey: key("password"))
        } else {
            let account = email ?? defaults.string(forKey: key("email"))
            if let account, !account.isEmpty {
                keychain.deletePassword(account: account)
            }
        }
        defaults.set(false, forKey: key("savePassword"))
    }

    private func key(_ name: String) -> String { prefix + name }

    private var defaultBaseURL: String {
        usesDevelopmentPasswordStorage ? "http://127.0.0.1:28180" : ""
    }

    private var defaultEmail: String {
        usesDevelopmentPasswordStorage ? "demo@momo.local" : ""
    }
}

public struct MomoKeychainPasswordStore: Sendable {
    private let service: String

    public init(service: String = "momo.mac.dev.session") {
        self.service = service
    }

    public func password(account: String) -> String? {
        guard !account.isEmpty else { return nil }
        var query = baseQuery(account: account)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public func setPassword(_ password: String, account: String) {
        guard !account.isEmpty else { return }
        let data = Data(password.utf8)
        var query = baseQuery(account: account)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            query[kSecValueData as String] = data
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    public func deletePassword(account: String) {
        guard !account.isEmpty else { return }
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

// MARK: - Session controller and root UI

@MainActor
public final class MomoServerSessionController: ObservableObject {
    public enum Phase {
        case choosing
        case connecting(String)
        case connected(ChatViewModel, MomoServerSessionSummary, MomoInviteAdminContext?)
        case failed(String)
    }

    /// A one-shot request to move the chooser onto a path with prefilled fields,
    /// carried from `momo://` deep links (W-O1). The `token` makes repeated links
    /// to the same path distinct so the chooser re-navigates each time.
    struct DeepLinkPrefillIntent: Equatable {
        var path: MomoOnboardingPath
        var token: Int
    }

    @Published public var form: MomoServerSessionForm
    @Published public private(set) var phase: Phase = .choosing {
        // W-O1 design-review M5: a deep link that arrived mid-connect is queued,
        // not dropped — deliver it as soon as the connect settles either way.
        didSet { deliverPendingDeepLinkIfNeeded() }
    }
    @Published public private(set) var sessionNotice: String?
    @Published private(set) var sessionFailureKind: MomoSessionFailureKind?
    @Published private(set) var onboardingPath: MomoOnboardingPath?
    /// Set when a deep link arrives before a session is live; consumed by the chooser.
    @Published private(set) var deepLinkPrefillIntent: DeepLinkPrefillIntent?
    /// Set when a deep link arrives while a session is already connected; drives
    /// the dismissible banner that offers to switch workspaces.
    @Published private(set) var deepLinkWhileConnected: MomoDeepLink?
    /// One-shot (MOMO-590): the workspace whose session should open the invite flow
    /// as soon as it lands, so a just-created workspace flows straight into inviting
    /// the team. Cleared once the sidebar consumes it.
    @Published public private(set) var pendingInviteWorkspace: WorkspaceID?

    private let store: MomoServerSessionStore
    private let client: MomoServerSessionClient
    private var didAttemptEnvironmentAutoconnect = false
    private var deepLinkPrefillToken = 0
    /// Deep link received while `phase == .connecting`; delivered on settle (M5).
    private var pendingDeepLink: MomoDeepLink?

    public init(
        store: MomoServerSessionStore = .shared,
        client: MomoServerSessionClient = MomoServerSessionClient()
    ) {
        self.store = store
        self.client = client
        self.form = store.load()
    }

    public func autoConnectFromEnvironmentIfAvailable() async {
        guard !didAttemptEnvironmentAutoconnect else { return }
        didAttemptEnvironmentAutoconnect = true
        guard let config = MomoServerRESTChatBackendConfig.fromEnvironment() else {
            return
        }
        onboardingPath = .signIn
        sessionFailureKind = nil
        phase = .connecting("Connecting to \(config.baseURL.absoluteString)")
        if config.accessToken == nil {
            await establishEnvironmentLoginSession(config: config)
            return
        }

        let viewModel = await MomoMacDemo.makeRESTViewModel(config: config)
        if let error = viewModel.connectionError {
            await viewModel.clearSessionSensitiveState()
            sessionFailureKind = .offline
            phase = .failed(error)
            return
        }
        let inviteAdmin = config.accessToken.map {
            MomoInviteAdminContext(baseURL: config.baseURL, workspace: config.workspace, accessToken: $0)
        }
        sessionNotice = nil
        phase = .connected(viewModel, MomoServerSessionSummary(
            mode: .real,
            title: config.baseURL.absoluteString,
            detail: "Environment session",
            channelCount: viewModel.channels.count,
            serverURLString: config.baseURL.absoluteString,
            workspaceIDString: config.workspace.description,
            memberDisplayName: viewModel.authenticatedMember?.displayName,
            memberHandle: viewModel.authenticatedMember?.handle,
            email: config.login.email
        ), inviteAdmin)
    }

    public func openDemo() async {
        guard !isConnecting else { return }
        onboardingPath = nil
        sessionFailureKind = nil
        phase = .connecting("Opening demo workspace")
        let viewModel = await MomoMacDemo.makeLocalDemoViewModel()
        sessionNotice = nil
        phase = .connected(viewModel, MomoServerSessionSummary(
            mode: .demo,
            title: "Offline demo",
            detail: "LiveChatBackend stub",
            channelCount: viewModel.channels.count,
            serverURLString: "local demo",
            workspaceIDString: viewModel.workspaceId?.description,
            memberDisplayName: viewModel.members.first(where: { $0.kind == .human })?.displayName,
            memberHandle: viewModel.members.first(where: { $0.kind == .human })?.handle,
            memberKind: .human,
            email: "demo"
        ), nil)
    }

    public func connectRealServer() async {
        await establishRealSession(useInvite: false)
    }

    public func joinAndConnect() async {
        await establishRealSession(useInvite: true)
    }

    func beginOnboarding(_ path: MomoOnboardingPath) {
        onboardingPath = path
    }

    /// Routes an incoming `momo://` URL (W-O1). Behavior by session state:
    /// - before a session is live (`choosing`/`failed`): prefill the join path;
    /// - while a connect is in flight (`connecting`): ignore so it is not disrupted;
    /// - while connected: keep the live session and surface a dismissible banner.
    func handleIncomingURL(_ url: URL) {
        guard let link = MomoDeepLinkParser.parseJoin(url) else { return }
        switch phase {
        case .connected:
            deepLinkWhileConnected = link
        case .connecting:
            // M5: never drop a click silently — queue and deliver on settle.
            pendingDeepLink = link
        case .choosing, .failed:
            applyJoinPrefill(link)
        }
    }

    /// Delivers a deep link that was queued during `.connecting` once the
    /// connect settles: connected → banner, chooser/failed → join prefill.
    private func deliverPendingDeepLinkIfNeeded() {
        guard let link = pendingDeepLink else { return }
        switch phase {
        case .connecting:
            return
        case .connected:
            pendingDeepLink = nil
            deepLinkWhileConnected = link
        case .choosing, .failed:
            pendingDeepLink = nil
            applyJoinPrefill(link)
        }
    }

    /// The chooser calls this once it has applied the prefill navigation so a
    /// later `switchSession()` does not re-open the join path with a stale link.
    func consumeDeepLinkPrefillIntent() {
        deepLinkPrefillIntent = nil
    }

    /// Dismisses the "join link received while connected" banner.
    func dismissConnectedDeepLink() {
        deepLinkWhileConnected = nil
    }

    /// Leaves the live session and prefills the join path with the deep link that
    /// arrived while connected, reusing the existing switch-session teardown.
    func switchSessionForConnectedDeepLink() async {
        guard let link = deepLinkWhileConnected else { return }
        deepLinkWhileConnected = nil
        await switchSession()
        applyJoinPrefill(link)
    }

    private func applyJoinPrefill(_ link: MomoDeepLink) {
        if case .failed = phase {
            phase = .choosing // Clear the stale error surface before prefilling.
        }
        if !link.serverURLString.isEmpty {
            form.baseURLString = link.serverURLString
        }
        if !link.inviteCode.isEmpty {
            form.inviteCode = link.inviteCode
        }
        form.password = ""
        onboardingPath = .join
        sessionFailureKind = nil
        deepLinkPrefillToken += 1
        deepLinkPrefillIntent = DeepLinkPrefillIntent(path: .join, token: deepLinkPrefillToken)
    }

    public func resetToChooser() async {
        await clearActiveSessionState()
        onboardingPath = nil
        sessionFailureKind = nil
        phase = .choosing
        sessionNotice = "Choose a server or account. Previous realtime state was cleared."
    }

    public func switchSession() async {
        await clearActiveSessionState()
        form = store.load()
        form.password = ""
        onboardingPath = nil
        sessionFailureKind = nil
        phase = .choosing
        sessionNotice = "Choose another server or account. Previous token, realtime subscription, and channel cache were cleared."
    }

    /// Clears the one-shot invite prompt after the sidebar has opened the invite
    /// flow for a freshly created workspace (MOMO-590).
    public func consumePendingInviteWorkspace() {
        pendingInviteWorkspace = nil
    }

    /// Switches the live session into a workspace the operator just created
    /// (MOMO-590). The operator App JWT is workspace-scoped, so landing in the new
    /// workspace means re-authenticating there. When the current credentials are
    /// still in hand (a saved password), the switch lands seamlessly; otherwise it
    /// returns to the chooser with a notice so the operator signs in to the new
    /// workspace. Full multi-workspace switching without re-auth is W-4 backlog.
    func switchToCreatedWorkspace(_ created: MomoCreatedWorkspace, requestInvite: Bool) async {
        await clearActiveSessionState()
        pendingInviteWorkspace = nil
        var reloaded = store.load()
        reloaded.inviteCode = ""
        form = reloaded
        onboardingPath = nil
        sessionFailureKind = nil

        let hasCredentials = !reloaded.password.isEmpty
            && (try? reloaded.validatedBaseURL()) != nil
            && (try? reloaded.validatedEmail()) != nil

        if hasCredentials {
            phase = .connecting("Switching to \(created.name)")
            do {
                let session = try await client.login(form: reloaded, workspace: created.workspaceId)
                let viewModel = await makeViewModel(session: session, password: reloaded.password)
                if let error = viewModel.connectionError {
                    await viewModel.clearSessionSensitiveState()
                    sessionFailureKind = .offline
                    phase = .failed(error)
                    return
                }
                form.password = ""
                sessionNotice = nil
                if requestInvite {
                    pendingInviteWorkspace = session.workspace
                }
                phase = .connected(viewModel, MomoServerSessionSummary(
                    mode: .real,
                    title: session.summaryTitle,
                    detail: "New workspace",
                    channelCount: viewModel.channels.count,
                    serverURLString: session.baseURL.absoluteString,
                    workspaceIDString: session.workspace.description,
                    memberDisplayName: session.member.displayName,
                    memberHandle: session.member.handle,
                    memberKind: session.member.kind,
                    email: session.email
                ), MomoInviteAdminContext(
                    baseURL: session.baseURL,
                    workspace: session.workspace,
                    accessToken: session.accessToken
                ))
                return
            } catch {
                // Fall through to the chooser hand-off below.
            }
        }

        form.password = ""
        phase = .choosing
        sessionNotice = "Created the '\(created.name)' workspace. Sign in to move into it."
    }

    public func logout() async {
        let email = connectedEmail ?? form.email
        await clearActiveSessionState()
        form.password = ""
        store.clearSessionSensitiveState(email: email)
        form.savePassword = false
        onboardingPath = nil
        sessionFailureKind = nil
        phase = .choosing
        sessionNotice = "Logged out. Access token, saved password, realtime subscription, and session cache were cleared."
    }

    private func establishRealSession(useInvite: Bool) async {
        guard !isConnecting else { return }
        if onboardingPath == nil {
            onboardingPath = useInvite ? .join : .signIn
        }
        sessionFailureKind = nil
        phase = .connecting(useInvite ? "Joining workspace" : "Signing in")
        do {
            let submittedForm = form
            let session = try await (useInvite ? client.join(form: submittedForm) : client.login(form: submittedForm))
            let viewModel = await makeViewModel(session: session, password: submittedForm.password)
            if let error = viewModel.connectionError {
                await viewModel.clearSessionSensitiveState()
                if useInvite {
                    // The server has already redeemed the invite and created the member.
                    // Recovery must sign in with that account instead of replaying /join.
                    onboardingPath = .signIn
                    form.inviteCode = ""
                }
                sessionFailureKind = .offline
                phase = .failed(error)
                return
            }
            var storedForm = submittedForm
            storedForm.inviteCode = ""
            store.save(storedForm)
            form.inviteCode = ""
            form.password = ""
            onboardingPath = nil
            sessionNotice = nil
            phase = .connected(viewModel, MomoServerSessionSummary(
                mode: .real,
                title: session.summaryTitle,
                detail: session.joinedWithInvite ? "Joined with invite code" : "Signed in",
                channelCount: viewModel.channels.count,
                serverURLString: session.baseURL.absoluteString,
                workspaceIDString: session.workspace.description,
                memberDisplayName: session.member.displayName,
                memberHandle: session.member.handle,
                memberKind: session.member.kind,
                email: session.email
            ), MomoInviteAdminContext(
                baseURL: session.baseURL,
                workspace: session.workspace,
                accessToken: session.accessToken
            ))
        } catch {
            presentFailure(error)
        }
    }

    private func establishEnvironmentLoginSession(config: MomoServerRESTChatBackendConfig) async {
        do {
            let session = try await client.login(form: MomoServerSessionForm(
                baseURLString: config.baseURL.absoluteString,
                email: config.login.email,
                password: config.login.password
            ), workspace: config.workspace)
            let viewModel = await makeViewModel(session: session, password: config.login.password)
            if let error = viewModel.connectionError {
                await viewModel.clearSessionSensitiveState()
                sessionFailureKind = .offline
                phase = .failed(error)
                return
            }
            sessionNotice = nil
            phase = .connected(viewModel, MomoServerSessionSummary(
                mode: .real,
                title: session.summaryTitle,
                detail: "Environment login session",
                channelCount: viewModel.channels.count,
                serverURLString: session.baseURL.absoluteString,
                workspaceIDString: session.workspace.description,
                memberDisplayName: session.member.displayName,
                memberHandle: session.member.handle,
                memberKind: session.member.kind,
                email: session.email
            ), MomoInviteAdminContext(
                baseURL: session.baseURL,
                workspace: session.workspace,
                accessToken: session.accessToken
            ))
        } catch {
            presentFailure(error)
        }
    }

    private func presentFailure(_ error: Error) {
        sessionFailureKind = (error as? MomoServerSessionError)?.onboardingFailureKind ?? .other
        phase = .failed(error.localizedDescription)
    }

    private func makeViewModel(session: MomoServerSession, password: String) async -> ChatViewModel {
        let config = MomoServerRESTChatBackendConfig(
            baseURL: session.baseURL,
            centrifugoWebSocketURL: session.centrifugoWebSocketURL,
            accessToken: session.accessToken,
            login: .init(email: session.email, password: password),
            workspace: session.workspace
        )
        return await MomoMacDemo.makeRESTViewModel(config: config)
    }

    private var connectedViewModel: ChatViewModel? {
        if case .connected(let viewModel, _, _) = phase {
            return viewModel
        }
        return nil
    }

    private var isConnecting: Bool {
        if case .connecting = phase { return true }
        return false
    }

    private var connectedEmail: String? {
        if case .connected(_, let summary, _) = phase {
            return summary.email
        }
        return nil
    }

    private func clearActiveSessionState() async {
        guard let viewModel = connectedViewModel else { return }
        await viewModel.clearSessionSensitiveState()
    }
}

public struct MomoMacSessionRootView: View {
    @StateObject private var controller: MomoServerSessionController
    private let onOpenMemberDirectory: MomoMemberDirectoryHook?
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue

    public init(
        controller: @autoclosure @escaping () -> MomoServerSessionController = MomoServerSessionController(),
        onOpenMemberDirectory: MomoMemberDirectoryHook? = nil
    ) {
        _controller = StateObject(wrappedValue: controller())
        self.onOpenMemberDirectory = onOpenMemberDirectory
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    public var body: some View {
        Group {
            switch controller.phase {
            case .choosing:
                MomoServerSessionChooser(controller: controller)
                    .frame(
                        minWidth: MomoTheme.Onboarding.minimumWindowWidth,
                        minHeight: MomoTheme.Onboarding.minimumWindowHeight
                    )
            case .connecting(let message):
                MomoLaunchLoadingView(message: message)
                    .frame(
                        minWidth: MomoTheme.Onboarding.minimumWindowWidth,
                        minHeight: MomoTheme.Onboarding.minimumWindowHeight
                    )
            case .connected(let viewModel, let summary, let inviteAdmin):
                MomoMacRootView(
                    existingViewModel: viewModel,
                    sessionChrome: MomoSessionChrome(
                        summary: summary,
                        inviteAdminContext: inviteAdmin,
                        switchSession: {
                            Task { await controller.switchSession() }
                        },
                        logout: {
                            Task { await controller.logout() }
                        },
                        switchToCreatedWorkspace: { created, requestInvite in
                            Task {
                                await controller.switchToCreatedWorkspace(created, requestInvite: requestInvite)
                            }
                        },
                        presentInviteOnLanding: inviteAdmin?.workspace != nil
                            && controller.pendingInviteWorkspace == inviteAdmin?.workspace,
                        consumeInvitePrompt: {
                            controller.consumePendingInviteWorkspace()
                        }
                    ),
                    onOpenMemberDirectory: onOpenMemberDirectory
                )
                .frame(
                    minWidth: MomoTheme.Onboarding.connectedMinimumWindowWidth,
                    minHeight: MomoTheme.Onboarding.minimumWindowHeight
                )
                .overlay(alignment: .top) {
                    if let link = controller.deepLinkWhileConnected {
                        MomoDeepLinkConnectedBanner(
                            serverURLString: link.serverURLString,
                            language: language,
                            switchAction: { Task { await controller.switchSessionForConnectedDeepLink() } },
                            dismissAction: { controller.dismissConnectedDeepLink() }
                        )
                        .padding(.horizontal, MomoTheme.Onboarding.blockSpacing)
                        // Design-review B1: the connected shell owns the window from
                        // y=0 and its first `controlBandHeight` points are the unified
                        // titlebar band — drop the banner below it so chrome controls
                        // and window dragging stay clickable (MomoDownloadsPanelView
                        // precedent).
                        .padding(.top, MomoWindowChromeLayout.controlBandHeight + 8)
                    }
                }
            case .failed(let message):
                MomoServerSessionChooser(
                    controller: controller,
                    errorMessage: message,
                    failureKind: controller.sessionFailureKind,
                    initialPath: controller.onboardingPath
                )
                .frame(
                    minWidth: MomoTheme.Onboarding.minimumWindowWidth,
                    minHeight: MomoTheme.Onboarding.minimumWindowHeight
                )
            }
        }
        .task {
            await controller.autoConnectFromEnvironmentIfAvailable()
        }
        .onOpenURL { url in
            controller.handleIncomingURL(url)
        }
    }
}

enum MomoSessionField: Hashable {
    case serverURL
    case email
    case password
    case inviteCode
}

enum MomoOnboardingPath: String, CaseIterable, Identifiable {
    case join
    case signIn
    case localDemo
    case operatorSetup

    var id: String { rawValue }
}

enum MomoOnboardingLayout: Equatable {
    case compact
    case stacked
    case split

    static func resolve(width: CGFloat) -> Self {
        if width < MomoTheme.Onboarding.compactBreakpoint { return .compact }
        if width < MomoTheme.Onboarding.wideBreakpoint { return .stacked }
        return .split
    }
}

struct MomoServerSessionChooser: View {
    @ObservedObject var controller: MomoServerSessionController
    var errorMessage: String?
    var failureKind: MomoSessionFailureKind?
    var initialFocus: MomoSessionField?
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focusedField: MomoSessionField?
    @State private var selectedPath: MomoOnboardingPath?
    @StateObject private var discovery: MomoServerDiscoveryModel

    init(
        controller: MomoServerSessionController,
        errorMessage: String? = nil,
        failureKind: MomoSessionFailureKind? = nil,
        initialFocus: MomoSessionField? = nil,
        initialPath: MomoOnboardingPath? = nil,
        discovery: MomoServerDiscoveryModel? = nil
    ) {
        self.controller = controller
        self.errorMessage = errorMessage
        self.failureKind = failureKind
        self.initialFocus = initialFocus
        _selectedPath = State(initialValue: initialPath)
        _discovery = StateObject(wrappedValue: discovery ?? MomoServerDiscoveryModel())
    }

    var body: some View {
        let copy = MomoSessionCopy(language: language)

        ZStack {
            MomoLaunchBackdrop()

            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    languageMenu(copy: copy)
                }
                .padding(.horizontal, MomoTheme.Onboarding.blockSpacing)
                .padding(.top, MomoTheme.Onboarding.blockSpacing)

                GeometryReader { geometry in
                    let layout = MomoOnboardingLayout.resolve(width: geometry.size.width)
                    ScrollView {
                        Group {
                            if layout == .split {
                                HStack(alignment: .center, spacing: MomoTheme.Onboarding.edgeInset) {
                                    launchHero(copy: copy, compact: false)
                                        .frame(maxWidth: MomoTheme.Onboarding.heroMaximumWidth, alignment: .leading)
                                    entrySurface(copy: copy)
                                        .frame(maxWidth: MomoTheme.Onboarding.choiceMaximumWidth)
                                }
                                .frame(maxWidth: MomoTheme.Onboarding.splitContentMaximumWidth)
                            } else {
                                VStack(spacing: MomoTheme.Onboarding.blockSpacing) {
                                    launchHero(copy: copy, compact: layout == .compact)
                                    entrySurface(copy: copy)
                                        .frame(maxWidth: MomoTheme.Onboarding.detailMaximumWidth)
                                }
                            }
                        }
                        .padding(.horizontal, MomoTheme.Onboarding.edgeInset)
                        .padding(.top, layout == .compact
                            ? MomoTheme.Onboarding.sectionSpacing
                            : MomoTheme.Onboarding.blockSpacing)
                        .padding(.bottom, MomoTheme.Onboarding.edgeInset)
                        .frame(
                            maxWidth: .infinity,
                            minHeight: geometry.size.height,
                            alignment: .center
                        )
                    }
                    // Design-review B2: with the discovery strip the chooser can
                    // exceed the default height — keep the affordance visible.
                    .scrollIndicators(.automatic)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .tint(MomoTheme.humanAccent)
        .onExitCommand {
            if focusedField != nil {
                focusedField = nil
            } else {
                selectedPath = nil
            }
        }
        .onAppear {
            prepareLocalAlphaDefaults()
            if let intent = controller.deepLinkPrefillIntent {
                applyDeepLinkPrefill(intent)
                return
            }
            focusedField = initialFocus ?? recoveryFocus
            if selectedPath == nil, errorMessage != nil || initialFocus != nil {
                selectedPath = controller.form.trimmedInviteCode.isEmpty ? .signIn : .join
            }
            discovery.start()
        }
        .onDisappear {
            discovery.stop()
        }
        .onChange(of: controller.deepLinkPrefillIntent) { _, intent in
            guard let intent else { return }
            applyDeepLinkPrefill(intent)
        }
    }

    /// Moves the chooser onto the deep-linked path and focuses the first field the
    /// person still has to fill (the link already prefilled server and code).
    private func applyDeepLinkPrefill(_ intent: MomoServerSessionController.DeepLinkPrefillIntent) {
        selectedPath = intent.path
        focusedField = deepLinkPrefillFocus()
        controller.consumeDeepLinkPrefillIntent()
    }

    private func deepLinkPrefillFocus() -> MomoSessionField {
        if controller.form.baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .serverURL
        }
        if controller.form.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .email
        }
        return .password
    }

    private var recoveryFocus: MomoSessionField? {
        guard errorMessage != nil else { return nil }
        switch selectedPath {
        case .join:
            return .inviteCode
        case .signIn, .operatorSetup:
            return .password
        case .localDemo, .none:
            return nil
        }
    }

    private func launchHero(copy: MomoSessionCopy, compact: Bool) -> some View {
        VStack(alignment: compact ? .center : .leading, spacing: MomoTheme.Onboarding.sectionSpacing) {
            MomoMarkView(usesSignalForeground: true)
            Text(copy.heroTitle)
                .font(.title.bold())
                .foregroundStyle(MomoTheme.Onboarding.signalForeground(colorScheme: colorScheme))
                .multilineTextAlignment(compact ? .center : .leading)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            if !compact {
                Text(copy.heroSubtitle)
                    .font(.title3)
                    .foregroundStyle(MomoTheme.Onboarding.signalSecondaryForeground(colorScheme: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                    MomoLaunchStatusPill(icon: "text.bubble", title: copy.timelinePill)
                    MomoLaunchStatusPill(icon: "person.2", title: copy.agentPill)
                    MomoLaunchStatusPill(icon: "lock.shield", title: copy.localPill)
                }
            }
        }
        .frame(
            maxWidth: compact ? MomoTheme.Onboarding.detailMaximumWidth : MomoTheme.Onboarding.heroMaximumWidth,
            alignment: compact ? .center : .leading
        )
    }

    @Environment(\.colorScheme) private var colorScheme

    @ViewBuilder
    private func entrySurface(copy: MomoSessionCopy) -> some View {
        if let selectedPath {
            credentialSurface(path: selectedPath, copy: copy)
        } else {
            VStack(spacing: MomoTheme.Onboarding.sectionSpacing) {
                if !discovery.servers.isEmpty {
                    MomoDiscoveredServerCard(
                        servers: discovery.servers,
                        copy: copy,
                        onSelect: selectDiscoveredServer
                    )
                    .transition(.opacity)
                }
                pathChooser(copy: copy)
            }
            .animation(reduceMotion ? nil : .snappy, value: discovery.servers)
        }
    }

    private func selectDiscoveredServer(_ server: MomoDiscoveredServer) {
        controller.form.baseURLString = server.baseURLString
        discovery.stop()
        selectedPath = .signIn
        focusedField = .email
    }

    private func pathChooser(copy: MomoSessionCopy) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.Onboarding.sectionSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                Text(copy.choiceTitle)
                    .font(.title2.bold())
                Text(copy.choiceSubtitle)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 0) {
                pathButton(.join, copy: copy, shortcut: "1")
                Divider()
                pathButton(.signIn, copy: copy, shortcut: "2")
                Divider()
                pathButton(.localDemo, copy: copy, shortcut: "3")
                Divider()
                pathButton(.operatorSetup, copy: copy, shortcut: "4")
            }

            Text(copy.choiceFootnote)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(MomoTheme.Onboarding.blockSpacing)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            .regularMaterial,
            in: RoundedRectangle(cornerRadius: MomoTheme.cornerLarge, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.cornerLarge, style: .continuous)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
    }

    private func pathButton(
        _ path: MomoOnboardingPath,
        copy: MomoSessionCopy,
        shortcut: KeyEquivalent
    ) -> some View {
        MomoOnboardingPathButton(
            title: copy.pathTitle(path),
            detail: copy.pathDetail(path),
            systemImage: copy.pathIcon(path),
            badge: path == .operatorSetup ? copy.operatorBadge : nil
        ) {
            if path == .localDemo {
                Task { await controller.openDemo() }
            } else {
                selectedPath = path
                focusedField = path == .join ? .inviteCode : .serverURL
            }
        }
        .keyboardShortcut(shortcut, modifiers: [.command])
    }

    private func credentialSurface(path: MomoOnboardingPath, copy: MomoSessionCopy) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.Onboarding.sectionSpacing) {
            HStack(alignment: .firstTextBaseline, spacing: MomoTheme.Onboarding.contentSpacing) {
                Button {
                    focusedField = nil
                    selectedPath = nil
                } label: {
                    Label(copy.backToChoices, systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)

                Spacer()

                if path == .operatorSetup {
                    Text(copy.operatorBadge)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, MomoTheme.Onboarding.standardSpacing)
                        .padding(.vertical, MomoTheme.Onboarding.compactSpacing)
                        .background(.thinMaterial, in: Capsule())
                }
            }

            VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                Text(copy.pathTitle(path))
                    .font(.title2.bold())
                Text(copy.detailSubtitle(path))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let notice = controller.sessionNotice {
                MomoLaunchNotice(
                    title: developerMode ? notice : copy.sessionChanged,
                    detail: developerMode ? copy.noticeDetail : copy.sessionChangedDetail,
                    systemImage: "checkmark.circle.fill",
                    tint: MomoTheme.reversibleGreen
                )
            }

            if let errorMessage {
                MomoLaunchNotice(
                    title: failureTitle(copy: copy, fallback: errorMessage),
                    detail: failureRecovery(copy: copy),
                    systemImage: "exclamationmark.triangle.fill",
                    tint: MomoTheme.irreversibleRed
                )

                if failureKind == .offline {
                    Button {
                        Task { await controller.openDemo() }
                    } label: {
                        Label(copy.openOfflineDemo, systemImage: "play")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(MomoTheme.humanAccent)
                }
            }

            VStack(spacing: MomoTheme.Onboarding.contentSpacing) {
                if path == .join {
                    MomoLaunchTextField(
                        title: copy.inviteCode,
                        placeholder: copy.inviteCodePlaceholder,
                        text: $controller.form.inviteCode,
                        systemImage: "ticket",
                        field: .inviteCode,
                        focusedField: $focusedField,
                        onSubmit: { submit(path: path) },
                        isPreviewFocused: initialFocus == .inviteCode
                    )
                }
                MomoLaunchTextField(
                    title: copy.serverURL,
                    placeholder: "http://macbook.local:28180",
                    text: $controller.form.baseURLString,
                    systemImage: "network",
                    field: .serverURL,
                    focusedField: $focusedField,
                    onSubmit: { submit(path: path) },
                    isPreviewFocused: initialFocus == .serverURL
                )
                MomoLaunchTextField(
                    title: copy.email,
                    placeholder: "you@yourteam.com",
                    text: $controller.form.email,
                    systemImage: "envelope",
                    field: .email,
                    focusedField: $focusedField,
                    onSubmit: { submit(path: path) },
                    isPreviewFocused: initialFocus == .email
                )
                MomoLaunchSecureField(
                    title: copy.password,
                    placeholder: copy.passwordPlaceholder,
                    text: $controller.form.password,
                    systemImage: "key",
                    field: .password,
                    focusedField: $focusedField,
                    onSubmit: { submit(path: path) },
                    isPreviewFocused: initialFocus == .password
                )
            }

            HStack(alignment: .firstTextBaseline, spacing: MomoTheme.Onboarding.contentSpacing) {
                if developerMode {
                    Button {
                        useLocalAlphaPreset()
                        focusedField = .password
                    } label: {
                        Label(copy.useLocalAlpha, systemImage: "bolt")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }

                Spacer()

                Toggle(isOn: $controller.form.savePassword) {
                    Text(copy.savePassword)
                }
                .toggleStyle(.checkbox)
                .controlSize(.small)
            }

            HStack(spacing: MomoTheme.Onboarding.contentSpacing) {
                Spacer()
                Button {
                    submit(path: path)
                } label: {
                    Label(copy.actionTitle(path), systemImage: copy.actionIcon(path))
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
                .disabled(path == .join ? !controller.form.canJoinWithInvite : !controller.form.canSignIn)
            }

            if developerMode {
                Text(copy.storageNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(MomoTheme.Onboarding.blockSpacing)
        .frame(maxWidth: .infinity)
        .background(
            .regularMaterial,
            in: RoundedRectangle(cornerRadius: MomoTheme.cornerLarge, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.cornerLarge, style: .continuous)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func languageMenu(copy: MomoSessionCopy) -> some View {
        Menu {
            ForEach(MomoUILanguage.allCases) { option in
                Button {
                    languageRaw = option.rawValue
                } label: {
                    Label(option.displayName, systemImage: language == option ? "checkmark" : "circle")
                }
            }
        } label: {
            HStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                Image(systemName: "globe")
                    .font(.callout.weight(.semibold))
                Text(language.displayName)
                    .font(.callout.weight(.semibold))
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, MomoTheme.Onboarding.contentSpacing)
            .padding(.vertical, MomoTheme.Onboarding.standardSpacing)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule()
                    .stroke(MomoTheme.subtleBorder, lineWidth: 1)
            }
        }
        .menuStyle(.borderlessButton)
        .buttonStyle(.plain)
    }

    private func useLocalAlphaPreset() {
        controller.form.baseURLString = "http://127.0.0.1:28180"
        controller.form.email = "demo@momo.local"
        controller.form.password = "dev-password"
        controller.form.inviteCode = ""
    }

    private func submit(path: MomoOnboardingPath) {
        guard path == .join
            ? controller.form.canJoinWithInvite
            : controller.form.canSignIn
        else { return }
        controller.beginOnboarding(path)
        Task {
            if path == .join {
                await controller.joinAndConnect()
            } else {
                await controller.connectRealServer()
            }
        }
    }

    private func failureTitle(copy: MomoSessionCopy, fallback: String) -> String {
        switch failureKind {
        case .offline: return copy.offlineTitle
        case .authentication: return copy.authenticationTitle
        case .other, nil: return fallback
        }
    }

    private func failureRecovery(copy: MomoSessionCopy) -> String {
        switch failureKind {
        case .offline: return copy.offlineRecovery
        case .authentication: return copy.authenticationRecovery
        case .other, nil: return copy.errorRecovery
        }
    }

    private func prepareLocalAlphaDefaults() {
        let baseURL = controller.form.baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = controller.form.email.trimmingCharacters(in: .whitespacesAndNewlines)
        let isLocalAlpha = (baseURL == "http://127.0.0.1:8080" || baseURL == "http://127.0.0.1:28180")
            && email == "demo@momo.local"
            && controller.form.inviteCode.isEmpty
        guard isLocalAlpha else { return }
        if baseURL == "http://127.0.0.1:8080" {
            controller.form.baseURLString = "http://127.0.0.1:28180"
        }
    }
}

private struct MomoOnboardingPathButton: View {
    var title: String
    var detail: String
    var systemImage: String
    var badge: String?
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovering = false
    @FocusState private var isFocused: Bool

    var body: some View {
        Button(action: action) {
            HStack(spacing: MomoTheme.Onboarding.contentSpacing) {
                Image(systemName: systemImage)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
                    .frame(width: 32, height: 32)

                VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                    HStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                        Text(title)
                            .font(.body.weight(.semibold))
                        if let badge {
                            Text(badge)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: MomoTheme.Onboarding.standardSpacing)

                Image(systemName: "chevron.right")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(MomoTheme.Onboarding.contentSpacing)
            .contentShape(Rectangle())
            .background(
                isHovering
                    ? MomoTheme.Onboarding.choiceHover(colorScheme: colorScheme)
                    : Color.clear,
                in: RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
            )
            .overlay {
                if isFocused {
                    RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
                        .stroke(MomoTheme.Onboarding.focusBorder, lineWidth: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .focusable()
        .focused($isFocused)
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityHint(detail)
    }
}

/// A quiet suggestion shown above the path chooser only when a momo server was
/// found on the local network (MOMO-587). When nothing is found the card is
/// absent, so not-found / denied / timed-out are all rendered as silence.
private struct MomoDiscoveredServerCard: View {
    var servers: [MomoDiscoveredServer]
    var copy: MomoSessionCopy
    var onSelect: (MomoDiscoveredServer) -> Void

    var body: some View {
        // Design-review B2: a quiet suggestion, not a second card stack. One
        // caption header + the row list — no outer material card, no inline
        // privacy paragraph (moved to .help) — so the four primary paths and the
        // chooser footer stay on screen at the default window size.
        VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
            HStack(spacing: MomoTheme.Onboarding.compactSpacing) {
                Image(systemName: "wifi")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
                Text(copy.discoveryTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 0) {
                ForEach(Array(servers.enumerated()), id: \.element.id) { index, server in
                    if index > 0 {
                        Divider()
                    }
                    MomoDiscoveredServerRow(
                        host: server.displayHost,
                        actionLabel: copy.discoveryUseAction
                    ) {
                        onSelect(server)
                    }
                }
            }
            .background(
                MomoTheme.Onboarding.fieldBackground,
                in: RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
                    .stroke(MomoTheme.subtleBorder, lineWidth: 1)
            }
            .help(copy.discoveryPrivacyNote)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MomoDiscoveredServerRow: View {
    var host: String
    var actionLabel: String
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovering = false
    @FocusState private var isFocused: Bool

    var body: some View {
        Button(action: action) {
            HStack(spacing: MomoTheme.Onboarding.contentSpacing) {
                Image(systemName: "server.rack")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
                    .frame(width: 24, height: 24)

                Text(host)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: MomoTheme.Onboarding.standardSpacing)

                Text(actionLabel)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
            }
            .padding(.horizontal, MomoTheme.Onboarding.contentSpacing)
            .padding(.vertical, MomoTheme.Onboarding.standardSpacing)
            .contentShape(Rectangle())
            .background(
                isHovering
                    ? MomoTheme.Onboarding.choiceHover(colorScheme: colorScheme)
                    : Color.clear,
                in: RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
            )
            .overlay {
                if isFocused {
                    RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
                        .stroke(MomoTheme.Onboarding.focusBorder, lineWidth: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .focusable()
        .focused($isFocused)
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(host), \(actionLabel)")
    }
}

private struct MomoLaunchLoadingView: View {
    var message: String
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue

    var body: some View {
        let copy = MomoSessionCopy(language: language)

        ZStack {
            MomoLaunchBackdrop()
            VStack(spacing: MomoTheme.Onboarding.blockSpacing) {
                MomoMarkView()
                VStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                    Text(copy.loadingTitle)
                        .font(.title2.bold())
                    Text(localizedMessage(copy: copy))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                ProgressView()
                    .controlSize(.large)
                HStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                    MomoLaunchStatusPill(icon: "checkmark.circle", title: copy.loadingServer)
                    MomoLaunchStatusPill(icon: "ellipsis.message", title: copy.loadingTimeline)
                    MomoLaunchStatusPill(icon: "sparkles", title: copy.loadingAgents)
                }
            }
            .padding(MomoTheme.Onboarding.edgeInset)
            .frame(maxWidth: MomoTheme.Onboarding.detailMaximumWidth)
            .background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                    .stroke(MomoTheme.subtleBorder, lineWidth: 1)
            }
            .padding(.horizontal, MomoTheme.Onboarding.edgeInset)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func localizedMessage(copy: MomoSessionCopy) -> String {
        switch message {
        case "Opening demo workspace":
            return copy.openingDemo
        case "Joining workspace":
            return copy.joiningWorkspace
        case "Signing in":
            return copy.signingIn
        default:
            if message.hasPrefix("Connecting to ") {
                return copy.connectingTo(message.replacingOccurrences(of: "Connecting to ", with: ""))
            }
            return message
        }
    }
}

private struct MomoLaunchBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        // Canvas keeps the architectural artwork crisp across every window size.
        Canvas { context, size in
            let background = MomoTheme.Onboarding.signalBackground(colorScheme: colorScheme)
            let grid = MomoTheme.Onboarding.signalGrid(colorScheme: colorScheme)
            let rail = MomoTheme.Onboarding.signalRail(colorScheme: colorScheme)
            let plane = MomoTheme.Onboarding.signalPlane(colorScheme: colorScheme)

            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(background))

            var gridPath = Path()
            for column in 0...12 {
                let x = size.width * CGFloat(column) / 12
                gridPath.move(to: CGPoint(x: x, y: 0))
                gridPath.addLine(to: CGPoint(x: x, y: size.height))
            }
            for row in 0...8 {
                let y = size.height * CGFloat(row) / 8
                gridPath.move(to: CGPoint(x: 0, y: y))
                gridPath.addLine(to: CGPoint(x: size.width, y: y))
            }
            context.stroke(gridPath, with: .color(grid), lineWidth: 1)

            var coralPlane = Path()
            coralPlane.move(to: CGPoint(x: 0, y: 0))
            coralPlane.addLine(to: CGPoint(x: size.width * 0.34, y: 0))
            coralPlane.addLine(to: CGPoint(x: size.width * 0.22, y: size.height * 0.30))
            coralPlane.addLine(to: CGPoint(x: 0, y: size.height * 0.38))
            coralPlane.closeSubpath()
            context.fill(coralPlane, with: .color(plane.opacity(0.48)))

            var lowerPlane = Path()
            lowerPlane.move(to: CGPoint(x: size.width * 0.42, y: size.height))
            lowerPlane.addLine(to: CGPoint(x: size.width * 0.66, y: size.height * 0.70))
            lowerPlane.addLine(to: CGPoint(x: size.width * 0.88, y: size.height))
            lowerPlane.closeSubpath()
            context.fill(lowerPlane, with: .color(plane.opacity(0.16)))

            var signalRail = Path()
            signalRail.move(to: CGPoint(x: 0, y: size.height * 0.72))
            signalRail.addLine(to: CGPoint(x: size.width * 0.27, y: size.height * 0.72))
            signalRail.addLine(to: CGPoint(x: size.width * 0.42, y: size.height * 0.48))
            signalRail.addLine(to: CGPoint(x: size.width * 0.68, y: size.height * 0.48))
            signalRail.addLine(to: CGPoint(x: size.width * 0.82, y: size.height * 0.30))
            signalRail.addLine(to: CGPoint(x: size.width, y: size.height * 0.30))
            context.stroke(signalRail, with: .color(rail.opacity(0.28)), lineWidth: 2)

            var secondaryRail = Path()
            secondaryRail.move(to: CGPoint(x: size.width * 0.16, y: size.height))
            secondaryRail.addLine(to: CGPoint(x: size.width * 0.16, y: size.height * 0.58))
            secondaryRail.addLine(to: CGPoint(x: size.width * 0.52, y: size.height * 0.58))
            secondaryRail.addLine(to: CGPoint(x: size.width * 0.52, y: 0))
            context.stroke(secondaryRail, with: .color(rail.opacity(0.12)), lineWidth: 1)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

private struct MomoMarkView: View {
    var usesSignalForeground = false
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: MomoTheme.Onboarding.contentSpacing) {
            ZStack {
                RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                    .fill(.regularMaterial)
                RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                    .stroke(MomoTheme.subtleBorder, lineWidth: 1)
                Text("m")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(
                        usesSignalForeground
                            ? MomoTheme.Onboarding.signalForeground(colorScheme: colorScheme)
                            : Color.primary
                    )
            }
            .frame(width: MomoTheme.Onboarding.markSize, height: MomoTheme.Onboarding.markSize)

            VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                Text("momo")
                    .font(.title3.bold())
                    .foregroundStyle(
                        usesSignalForeground
                            ? MomoTheme.Onboarding.signalForeground(colorScheme: colorScheme)
                            : Color.primary
                    )
                if developerMode {
                    Text("local alpha")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(
                            usesSignalForeground
                                ? MomoTheme.Onboarding.signalSecondaryForeground(colorScheme: colorScheme)
                                : Color.secondary
                        )
                }
            }
        }
    }
}

private struct MomoLaunchStatusPill: View {
    var icon: String
    var title: String

    var body: some View {
        Label(title, systemImage: icon)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, MomoTheme.Onboarding.contentSpacing)
            .padding(.vertical, MomoTheme.Onboarding.compactSpacing)
            .background(.thinMaterial, in: Capsule())
            .overlay {
                Capsule().stroke(MomoTheme.subtleBorder, lineWidth: 1)
            }
    }
}

private struct MomoLaunchNotice: View {
    var title: String
    var detail: String
    var systemImage: String
    var tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: MomoTheme.Onboarding.contentSpacing) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .textSelection(.enabled)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(MomoTheme.Onboarding.contentSpacing)
        .background(
            tint.opacity(0.10),
            in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
        )
    }
}

/// Shown over a live session when a `momo://join` link arrives (W-O1). The active
/// session is never interrupted; the person decides whether to switch workspaces.
private struct MomoDeepLinkConnectedBanner: View {
    var serverURLString: String
    var language: MomoUILanguage
    var switchAction: () -> Void
    var dismissAction: () -> Void

    var body: some View {
        let copy = MomoSessionCopy(language: language)
        HStack(alignment: .top, spacing: MomoTheme.Onboarding.contentSpacing) {
            Image(systemName: "link")
                .foregroundStyle(MomoTheme.humanAccent)
            VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                Text(copy.deepLinkConnectedTitle)
                    .font(.callout.weight(.semibold))
                Text(copy.deepLinkConnectedDetail(server: serverURLString))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                    Button(copy.deepLinkSwitchAndJoin, action: switchAction)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    // Design-review H3/N7: single close affordance with an Esc
                    // path — the extra xmark icon button was redundant.
                    Button(copy.deepLinkDismiss, action: dismissAction)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .keyboardShortcut(.cancelAction)
                }
                .padding(.top, MomoTheme.Onboarding.compactSpacing)
            }
            Spacer(minLength: MomoTheme.Onboarding.standardSpacing)
        }
        .padding(MomoTheme.Onboarding.blockSpacing)
        .frame(maxWidth: MomoTheme.Onboarding.detailMaximumWidth)
        .background(
            .regularMaterial,
            in: RoundedRectangle(cornerRadius: MomoTheme.cornerLarge, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.cornerLarge, style: .continuous)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
    }
}

private struct MomoLaunchTextField: View {
    var title: String
    var placeholder: String
    @Binding var text: String
    var systemImage: String
    var field: MomoSessionField
    var focusedField: FocusState<MomoSessionField?>.Binding
    var onSubmit: () -> Void
    var isPreviewFocused = false

    var body: some View {
        MomoLaunchFieldFrame(
            title: title,
            systemImage: systemImage,
            isFocused: focusedField.wrappedValue == field || isPreviewFocused
        ) {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .focused(focusedField, equals: field)
                .accessibilityLabel(title)
                .onSubmit(onSubmit)
        }
    }
}

private struct MomoLaunchSecureField: View {
    var title: String
    var placeholder: String
    @Binding var text: String
    var systemImage: String
    var field: MomoSessionField
    var focusedField: FocusState<MomoSessionField?>.Binding
    var onSubmit: () -> Void
    var isPreviewFocused = false

    var body: some View {
        MomoLaunchFieldFrame(
            title: title,
            systemImage: systemImage,
            isFocused: focusedField.wrappedValue == field || isPreviewFocused
        ) {
            SecureField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .focused(focusedField, equals: field)
                .accessibilityLabel(title)
                .onSubmit(onSubmit)
        }
    }
}

private struct MomoLaunchFieldFrame<Content: View>: View {
    var title: String
    var systemImage: String
    var isFocused: Bool
    var content: Content

    init(
        title: String,
        systemImage: String,
        isFocused: Bool,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isFocused = isFocused
        self.content = content()
    }

    var body: some View {
        // Native fields cannot share one titled icon frame and 2 pt focus ring, so only their chrome is wrapped.
        HStack(spacing: MomoTheme.Onboarding.contentSpacing) {
            Image(systemName: systemImage)
                .foregroundStyle(isFocused ? MomoTheme.Onboarding.focusBorder : .secondary)
            VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                content
                    .font(.body.weight(.medium))
            }
        }
        .padding(.horizontal, MomoTheme.Onboarding.contentSpacing)
        .frame(minHeight: MomoTheme.Onboarding.fieldMinimumHeight)
        .background(
            MomoTheme.Onboarding.fieldBackground,
            in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                .stroke(
                    isFocused ? MomoTheme.Onboarding.focusBorder : MomoTheme.Onboarding.fieldBorder,
                    lineWidth: isFocused ? 2 : 1
                )
        }
    }
}

private struct MomoSessionCopy {
    var language: MomoUILanguage

    var heroTitle: String {
        switch language {
        case .korean: return "사람과 에이전트가 같은 신호 위에서 일합니다"
        case .english: return "People and agents work on the same signal"
        }
    }

    var heroSubtitle: String {
        switch language {
        case .korean: return "대화, 승인, 실행 결과를 한 타임라인에 남기는 팀 메신저입니다."
        case .english: return "A team messenger where conversation, approval, and execution share one timeline."
        }
    }

    var timelinePill: String {
        switch language {
        case .korean: return "실행 타임라인"
        case .english: return "Execution timeline"
        }
    }

    var choiceTitle: String {
        switch language {
        case .korean: return "momo에서 시작하기"
        case .english: return "Start with momo"
        }
    }

    var choiceSubtitle: String {
        switch language {
        case .korean: return "지금의 상황에 맞는 시작 방법을 선택하세요."
        case .english: return "Choose the path that matches where you are now."
        }
    }

    var choiceFootnote: String {
        switch language {
        case .korean: return "서버 주소와 계정 정보는 필요한 단계에서만 입력합니다."
        case .english: return "Server and account details appear only when they are needed."
        }
    }

    var discoveryTitle: String {
        switch language {
        case .korean: return "같은 네트워크에서 momo 서버를 찾았습니다"
        case .english: return "Found a momo server on your network"
        }
    }

    var discoverySubtitle: String {
        switch language {
        case .korean: return "선택하면 서버 주소를 채우고 로그인 단계로 넘어갑니다."
        case .english: return "Pick one to fill its address and move to sign in."
        }
    }

    var discoveryUseAction: String {
        switch language {
        case .korean: return "주소 채우기"
        case .english: return "Use address"
        }
    }

    var discoveryPrivacyNote: String {
        switch language {
        case .korean: return "같은 와이파이의 momo 서버만 찾습니다. 주소는 자동으로 저장되지 않습니다."
        case .english: return "Only momo servers on your Wi-Fi appear here. Nothing is saved automatically."
        }
    }

    var operatorBadge: String {
        switch language {
        case .korean: return "운영자"
        case .english: return "Operator"
        }
    }

    var backToChoices: String {
        switch language {
        case .korean: return "시작 방법"
        case .english: return "Start options"
        }
    }

    var inviteCodePlaceholder: String {
        switch language {
        case .korean: return "받은 초대 코드 입력"
        case .english: return "Enter your invite code"
        }
    }

    var deepLinkConnectedTitle: String {
        switch language {
        case .korean: return "초대 링크를 받았습니다"
        case .english: return "Invite link received"
        }
    }

    func deepLinkConnectedDetail(server: String) -> String {
        switch language {
        case .korean:
            if server.isEmpty {
                return "지금은 다른 워크스페이스에 연결되어 있습니다. 세션을 바꾸면 초대 코드로 참여할 수 있습니다."
            }
            return "지금은 다른 워크스페이스에 연결되어 있습니다. \(server)에 참여하려면 세션을 바꾸세요."
        case .english:
            if server.isEmpty {
                return "You are connected to another workspace. Switch session to join with this invite code."
            }
            return "You are connected to another workspace. Switch session to join \(server)."
        }
    }

    var deepLinkSwitchAndJoin: String {
        switch language {
        case .korean: return "세션 바꿔서 참여"
        case .english: return "Switch and Join"
        }
    }

    var deepLinkDismiss: String {
        switch language {
        case .korean: return "닫기"
        case .english: return "Dismiss"
        }
    }

    func pathTitle(_ path: MomoOnboardingPath) -> String {
        switch (language, path) {
        case (.korean, .join): return "초대받은 팀에 참여"
        case (.english, .join): return "Join an invited team"
        case (.korean, .signIn): return "기존 워크스페이스 로그인"
        case (.english, .signIn): return "Sign in to a workspace"
        case (.korean, .localDemo): return "이 Mac에서 체험하기"
        case (.english, .localDemo): return "Explore on this Mac"
        case (.korean, .operatorSetup): return "self-hosted 서버에 연결"
        case (.english, .operatorSetup): return "Connect a self-hosted server"
        }
    }

    func pathDetail(_ path: MomoOnboardingPath) -> String {
        switch (language, path) {
        case (.korean, .join): return "초대 코드로 팀의 워크스페이스에 합류합니다."
        case (.english, .join): return "Use an invite code to join your team's workspace."
        case (.korean, .signIn): return "이미 운영 중인 momo 서버로 돌아갑니다."
        case (.english, .signIn): return "Return to a momo server that is already running."
        case (.korean, .localDemo): return "서버 없이 사람과 에이전트의 협업 흐름을 둘러봅니다."
        case (.english, .localDemo): return "Preview the people and agent workflow without a server."
        case (.korean, .operatorSetup): return "이미 설치한 momo 서버의 워크스페이스에 연결합니다."
        case (.english, .operatorSetup): return "Connect to a workspace on a momo server you already installed."
        }
    }

    func detailSubtitle(_ path: MomoOnboardingPath) -> String {
        switch (language, path) {
        case (.korean, .join): return "초대 코드와 팀 서버의 계정 정보를 입력하세요."
        case (.english, .join): return "Enter the invite code and your team server credentials."
        case (.korean, .signIn): return "워크스페이스 서버와 계정 정보를 입력하세요."
        case (.english, .signIn): return "Enter your workspace server and account details."
        case (.korean, .localDemo): return "서버 없이 로컬 데모를 엽니다."
        case (.english, .localDemo): return "Open the local demo without a server."
        case (.korean, .operatorSetup): return "현재 앱은 설치 완료된 self-hosted 서버 연결을 지원합니다."
        case (.english, .operatorSetup): return "The app currently connects to an installed self-hosted server."
        }
    }

    func pathIcon(_ path: MomoOnboardingPath) -> String {
        switch path {
        case .join: return "person.badge.plus"
        case .signIn: return "rectangle.and.pencil.and.ellipsis"
        case .localDemo: return "laptopcomputer"
        case .operatorSetup: return "server.rack"
        }
    }

    func actionTitle(_ path: MomoOnboardingPath) -> String {
        switch (language, path) {
        case (.korean, .join): return "팀에 참여"
        case (.english, .join): return "Join Team"
        case (.korean, .operatorSetup): return "서버에 연결"
        case (.english, .operatorSetup): return "Connect Server"
        case (.korean, _): return "로그인"
        case (.english, _): return "Sign In"
        }
    }

    func actionIcon(_ path: MomoOnboardingPath) -> String {
        path == .join ? "person.badge.plus" : "arrow.right.circle.fill"
    }

    var serverPill: String {
        switch language {
        case .korean: return "Local Server"
        case .english: return "Local Server"
        }
    }

    var agentPill: String {
        switch language {
        case .korean: return "Hermes"
        case .english: return "Hermes"
        }
    }

    var localPill: String {
        switch language {
        case .korean: return "Self-hosted"
        case .english: return "Self-hosted"
        }
    }

    var cardTitle: String {
        switch language {
        case .korean: return "워크스페이스에 들어가기"
        case .english: return "Enter a workspace"
        }
    }

    var cardSubtitle: String {
        switch language {
        case .korean: return "데모로 둘러보거나, 실행 중인 MomoServer에 연결하세요."
        case .english: return "Open the demo or connect to a running MomoServer."
        }
    }

    var openDemo: String {
        switch language {
        case .korean: return "데모 열기"
        case .english: return "Open Demo"
        }
    }

    var noticeDetail: String {
        switch language {
        case .korean: return "이전 세션 정보를 불러왔습니다. 바로 연결하거나 값을 바꿀 수 있습니다."
        case .english: return "Previous session details are loaded. Connect now or adjust them."
        }
    }

    var sessionChanged: String {
        switch language {
        case .korean: return "세션을 정리했습니다"
        case .english: return "Session cleared"
        }
    }

    var sessionChangedDetail: String {
        switch language {
        case .korean: return "다른 계정으로 로그인하거나 데모를 열 수 있습니다."
        case .english: return "Sign in with another account or open the demo."
        }
    }

    var errorRecovery: String {
        switch language {
        case .korean: return "서버, 계정, 비밀번호, 초대 코드를 확인한 뒤 다시 시도하세요."
        case .english: return "Check the server, account, password, or invite code and try again."
        }
    }

    var serverURL: String {
        switch language {
        case .korean: return "서버 URL"
        case .english: return "Server URL"
        }
    }

    var email: String {
        switch language {
        case .korean: return "이메일"
        case .english: return "Email"
        }
    }

    var password: String {
        switch language {
        case .korean: return "비밀번호"
        case .english: return "Password"
        }
    }

    var passwordPlaceholder: String {
        switch language {
        case .korean: return "비밀번호"
        case .english: return "Password"
        }
    }

    var inviteCode: String {
        switch language {
        case .korean: return "초대 코드"
        case .english: return "Invite code"
        }
    }

    var optional: String {
        switch language {
        case .korean: return "선택 사항"
        case .english: return "Optional"
        }
    }

    var savePassword: String {
        switch language {
        case .korean: return "비밀번호 저장"
        case .english: return "Save password"
        }
    }

    var useLocalAlpha: String {
        switch language {
        case .korean: return "로컬 알파 정보 채우기"
        case .english: return "Fill Local Alpha Details"
        }
    }

    var signIn: String {
        switch language {
        case .korean: return "로그인"
        case .english: return "Sign In"
        }
    }

    var joinWithInvite: String {
        switch language {
        case .korean: return "초대로 참여"
        case .english: return "Join with Invite"
        }
    }

    var demoActionDetail: String {
        switch language {
        case .korean: return "자격 정보를 입력하기 전에는 서버 없이 데모를 둘러봅니다."
        case .english: return "Until credentials are entered, open the demo without a server."
        }
    }

    var signInActionDetail: String {
        switch language {
        case .korean: return "Enter를 누르면 입력한 서버와 계정으로 로그인합니다."
        case .english: return "Press Enter to sign in with the server and account above."
        }
    }

    var inviteDisabledReason: String {
        switch language {
        case .korean: return "초대 코드를 입력하면 새 워크스페이스에 참여할 수 있습니다."
        case .english: return "Enter an invite code to join a new workspace."
        }
    }

    var credentialsDisabledReason: String {
        switch language {
        case .korean: return "참여하려면 서버 URL, 이메일, 비밀번호를 모두 입력하세요."
        case .english: return "Enter a server URL, email, and password before joining."
        }
    }

    var offlineTitle: String {
        switch language {
        case .korean: return "서버에 연결할 수 없습니다"
        case .english: return "Could not reach the server"
        }
    }

    var offlineRecovery: String {
        switch language {
        case .korean: return "네트워크와 서버 주소를 확인해 다시 로그인하거나, 서버 없이 데모를 둘러보세요."
        case .english: return "Check the network and server address, then sign in again or explore the demo without a server."
        }
    }

    var authenticationTitle: String {
        switch language {
        case .korean: return "로그인 정보를 확인하세요"
        case .english: return "Check your sign-in details"
        }
    }

    var authenticationRecovery: String {
        switch language {
        case .korean: return "이메일과 비밀번호를 확인한 뒤 다시 로그인하세요."
        case .english: return "Check the email and password, then sign in again."
        }
    }

    var openOfflineDemo: String {
        switch language {
        case .korean: return "서버 없이 데모 열기"
        case .english: return "Open Demo Without Server"
        }
    }

    var storageNote: String {
        switch language {
        case .korean: return "로컬 알파 모드는 서버 URL, 이메일, 초대 코드와 선택한 경우 비밀번호를 저장합니다."
        case .english: return "Local alpha mode stores the server URL, email, invite code, and password when selected."
        }
    }

    var loadingTitle: String {
        switch language {
        case .korean: return "momo 여는 중"
        case .english: return "Opening momo"
        }
    }

    var loadingServer: String {
        switch language {
        case .korean: return "서버"
        case .english: return "Server"
        }
    }

    var loadingTimeline: String {
        switch language {
        case .korean: return "타임라인"
        case .english: return "Timeline"
        }
    }

    var loadingAgents: String {
        switch language {
        case .korean: return "에이전트"
        case .english: return "Agents"
        }
    }

    var openingDemo: String {
        switch language {
        case .korean: return "데모 워크스페이스를 준비하고 있습니다."
        case .english: return "Preparing the demo workspace."
        }
    }

    var joiningWorkspace: String {
        switch language {
        case .korean: return "초대 코드로 워크스페이스에 참여하고 있습니다."
        case .english: return "Joining the workspace with your invite code."
        }
    }

    var signingIn: String {
        switch language {
        case .korean: return "로컬 서버에 로그인하고 있습니다."
        case .english: return "Signing in to the local server."
        }
    }

    func connectingTo(_ server: String) -> String {
        switch language {
        case .korean: return "\(server)에 연결하고 있습니다."
        case .english: return "Connecting to \(server)."
        }
    }
}

private struct SessionStatusBar: View {
    var summary: MomoServerSessionSummary
    @ObservedObject var viewModel: ChatViewModel
    var inviteAdminContext: MomoInviteAdminContext?
    var switchSession: () -> Void
    var logout: () -> Void
    @State private var showDetails = false
    @State private var showInvites = false
    @State private var showUpdates = false
    @State private var inviteDismissLocked = false
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue

    var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        HStack(spacing: 10) {
            Label(summary.mode.title, systemImage: summary.mode == .real ? "server.rack" : "shippingbox")
                .font(.caption.bold())
            sessionPill(summary.title, systemImage: "network")
            if let workspace = summary.workspaceShortID {
                sessionPill("ws \(workspace)", systemImage: "square.grid.2x2")
            }
            if let member = summary.memberLabel {
                sessionPill(member, systemImage: summary.memberKind == .agent ? "cpu" : "person.crop.circle")
            }
            realtimePill
            Spacer()
            if summary.channelCount == 0 {
                Label(copy.noChannels, systemImage: "tray")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.costAmber)
            }
            languageMenu(copy: copy)
                .disabled(inviteDismissLocked)
            Button {
                showDetails.toggle()
            } label: {
                Label(copy.detail, systemImage: "info.circle")
            }
            .popover(isPresented: $showDetails) {
                SessionDetailPopover(
                    summary: summary,
                    realtimeStatus: viewModel.selectedRealtimeStatus,
                    agentStatus: viewModel.agentRuntimeStatus
                )
            }
            .controlSize(.small)
            .disabled(inviteDismissLocked)
            Button {
                showUpdates.toggle()
            } label: {
                Label(copy.updates, systemImage: "arrow.down.circle")
            }
            .popover(isPresented: $showUpdates) {
                MomoMacUpdateChannelView()
            }
            .controlSize(.small)
            .disabled(inviteDismissLocked)
            if let inviteAdminContext, viewModel.canManageWorkspace {
                Button {
                    guard !showInvites || !inviteDismissLocked else { return }
                    showInvites.toggle()
                } label: {
                    Label(copy.invites, systemImage: "person.badge.key")
                }
                .popover(isPresented: invitePopoverPresentation) {
                    InviteAdminPopover(
                        context: inviteAdminContext,
                        language: language,
                        dismissLocked: $inviteDismissLocked
                    )
                }
                .controlSize(.small)
            }
            Button(action: switchSession) {
                Label(copy.switchSession, systemImage: "arrow.left.arrow.right")
            }
            .controlSize(.small)
            .disabled(inviteDismissLocked)
            Button(role: .destructive, action: logout) {
                Label(copy.logout, systemImage: "rectangle.portrait.and.arrow.right")
            }
            .controlSize(.small)
            .disabled(inviteDismissLocked)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
    }

    private func sessionPill(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .lineLimit(1)
            .foregroundStyle(.secondary)
    }

    private var invitePopoverPresentation: Binding<Bool> {
        Binding(
            get: { showInvites },
            set: { isPresented in
                guard isPresented || !inviteDismissLocked else { return }
                showInvites = isPresented
            }
        )
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func languageMenu(copy: MomoWorkspaceCopy) -> some View {
        Menu {
            ForEach(MomoUILanguage.allCases) { option in
                Button {
                    languageRaw = option.rawValue
                } label: {
                    Label(option.displayName, systemImage: language == option ? "checkmark" : "circle")
                }
            }
        } label: {
            Label(language.displayName, systemImage: "globe")
        }
        .controlSize(.small)
        .help(copy.languageLabel)
    }

    private var realtimePill: some View {
        let copy = MomoWorkspaceCopy(language: language)
        let status = viewModel.selectedRealtimeStatus
        let title: String
        let icon: String
        let color: Color
        if let status, status.isLive {
            title = copy.live
            icon = "dot.radiowaves.left.and.right"
            color = .green
        } else if let status, status.connection == .reconnecting || status.subscription == .recovering {
            title = copy.reconnecting
            icon = "arrow.triangle.2.circlepath"
            color = .blue
        } else if let status, status.fallback == .restHistory {
            title = copy.restFallback
            icon = "clock.arrow.circlepath"
            color = .secondary
        } else if let status {
            title = status.connection.rawValue
            icon = "antenna.radiowaves.left.and.right"
            color = .secondary
        } else {
            title = "Realtime pending"
            icon = "antenna.radiowaves.left.and.right"
            color = .secondary
        }
        return Label(title, systemImage: icon)
            .font(.caption)
            .lineLimit(1)
            .foregroundStyle(color)
    }
}

enum MomoInviteAdminOperation: Equatable {
    case idle
    case refreshing
    case creating
    case revoking(UUID)

    var isWorking: Bool {
        switch self {
        case .idle:
            return false
        case .refreshing, .creating, .revoking:
            return true
        }
    }

    var statusText: String? {
        switch self {
        case .idle:
            return nil
        case .refreshing:
            return "Refreshing invites"
        case .creating:
            return "Creating invite"
        case .revoking:
            return "Revoking invite"
        }
    }
}

enum MomoInviteAdminRetryAction: Equatable {
    case refresh
    case create(role: MembershipRole, maxUsesText: String, expiresInDaysText: String)
    case revoke(invite: MomoInviteCode, reason: String)
}

enum MomoInviteShortLinkConfiguration {
    static let publicBaseURLEnvironmentKey = "MOMO_LINKSHORT_PUBLIC_BASE_URL"

    static func publicBaseURL(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL? {
        guard let rawValue = environment[publicBaseURLEnvironmentKey],
              let url = URL(string: rawValue),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              url.path.isEmpty || url.path == "/",
              scheme == "https" || (
                scheme == "http"
                    && ["localhost", "127.0.0.1", "::1"].contains(host)
              )
        else {
            return nil
        }
        return url
    }

    static func shortURL(code: String, publicBaseURL: URL?) -> URL? {
        let trimmedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCode.isEmpty, let publicBaseURL else { return nil }
        return publicBaseURL
            .appendingPathComponent("i", isDirectory: true)
            .appendingPathComponent(trimmedCode, isDirectory: false)
    }
}

struct MomoInviteOneTimeCopy {
    let language: MomoUILanguage

    var newInviteCode: String {
        language == .korean ? "새 초대 코드" : "New invite code"
    }

    var copyCode: String {
        language == .korean ? "코드 복사" : "Copy Code"
    }

    var copyShortLink: String {
        language == .korean ? "단축 링크 복사" : "Copy Short Link"
    }

    var savedIt: String {
        language == .korean ? "저장했습니다" : "I Saved It"
    }

    var saveNowHint: String {
        language == .korean
            ? "지금 코드나 단축 링크를 저장하세요. 기존 초대 목록에는 마스킹된 미리보기만 남아 원본 코드를 다시 확인할 수 없습니다."
            : "Save the code or short link now. Existing invites only expose a masked preview, so the raw code cannot be recovered later."
    }

    func inviteCreated(role: MembershipRole) -> String {
        let roleName: String
        switch (language, role) {
        case (.korean, .owner): roleName = "소유자"
        case (.korean, .admin): roleName = "관리자"
        case (.korean, .member): roleName = "멤버"
        case (.korean, .guest): roleName = "게스트"
        case (.english, .owner): roleName = "owner"
        case (.english, .admin): roleName = "admin"
        case (.english, .member): roleName = "member"
        case (.english, .guest): roleName = "guest"
        }
        return language == .korean
            ? "\(roleName) 초대를 만들었습니다. 지금 원본 코드나 단축 링크를 저장하세요."
            : "Invite created for \(roleName). Save the raw code or short link now."
    }

    var inviteCreatedRefreshFailed: String {
        language == .korean
            ? "초대는 만들었지만 목록을 새로고치지 못했습니다. 코드를 먼저 저장한 뒤 다시 불러오세요."
            : "The invite was created, but the list could not be refreshed. Save the code first, then reload the list."
    }

    var createBeforeCopyingCode: String {
        language == .korean
            ? "원본 코드를 복사하려면 먼저 초대를 만드세요."
            : "Create an invite before copying the raw code."
    }

    var inviteCodeCopied: String {
        language == .korean
            ? "초대 코드를 복사했습니다. 이 화면을 닫으면 마스킹된 미리보기만 남습니다."
            : "Invite code copied. Only the masked preview remains after this flow."
    }

    var shortLinkUnavailable: String {
        language == .korean
            ? "공개 초대 링크 도메인이 설정되지 않았습니다. 원본 코드를 대신 복사하세요."
            : "A public invite link domain is not configured. Copy the raw code instead."
    }

    var createBeforeCopyingShortLink: String {
        language == .korean
            ? "단축 링크를 복사하려면 먼저 초대를 만드세요."
            : "Create an invite before copying the short link."
    }

    var shortLinkCopied: String {
        language == .korean
            ? "단축 초대 링크를 복사했습니다. 원본 코드는 이 화면에서만 확인할 수 있습니다."
            : "Short invite link copied. The raw invite code remains visible only in this flow."
    }
}

@MainActor
final class MomoInviteAdminViewModel: ObservableObject {
    @Published var invites: [MomoInviteCode] = []
    @Published var createdCode: String?
    @Published var notice: String?
    @Published var errorMessage: String?
    @Published var operation: MomoInviteAdminOperation = .idle
    @Published private(set) var lastFailedAction: MomoInviteAdminRetryAction?

    var isWorking: Bool { operation.isWorking }
    var canRetry: Bool { lastFailedAction != nil && !operation.isWorking }

    private let context: MomoInviteAdminContext
    private let client: MomoInviteAdminClient
    private let copyInviteCode: @MainActor (String) -> Void
    private let publicShortLinkBaseURL: URL?
    private let copyInviteLink: @MainActor (String) -> Void
    private let oneTimeCopy: MomoInviteOneTimeCopy

    init(
        context: MomoInviteAdminContext,
        client: MomoInviteAdminClient = MomoInviteAdminClient(),
        copyInviteCode: @escaping @MainActor (String) -> Void = MomoInviteAdminViewModel.copyToPasteboard,
        publicShortLinkBaseURL: URL? = MomoInviteShortLinkConfiguration.publicBaseURL(),
        copyInviteLink: @escaping @MainActor (String) -> Void = MomoInviteAdminViewModel.copyToPasteboard,
        language: MomoUILanguage = .preferredDefault
    ) {
        self.context = context
        self.client = client
        self.copyInviteCode = copyInviteCode
        self.publicShortLinkBaseURL = publicShortLinkBaseURL
        self.copyInviteLink = copyInviteLink
        self.oneTimeCopy = MomoInviteOneTimeCopy(language: language)
    }

    func refreshInvites(showNotice: Bool = false) async {
        guard operation == .idle else { return }
        operation = .refreshing
        defer { operation = .idle }
        do {
            invites = try await loadInvites()
            errorMessage = nil
            lastFailedAction = nil
            if showNotice {
                notice = "Invite list refreshed."
            }
        } catch {
            errorMessage = error.localizedDescription
            lastFailedAction = .refresh
        }
    }

    func createInvite(role: MembershipRole, maxUsesText: String, expiresInDaysText: String) async {
        guard operation == .idle else { return }
        let maxUses = Int(maxUsesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 1
        let expiresInDays = Int(expiresInDaysText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 7
        let clampedMaxUses = min(max(maxUses, 1), 10_000)
        let clampedDays = min(max(expiresInDays, 1), 90)
        let expiresAtMs = Int64(Date().addingTimeInterval(TimeInterval(clampedDays * 24 * 60 * 60)).timeIntervalSince1970 * 1000)

        operation = .creating
        defer { operation = .idle }
        do {
            let created = try await client.createInvite(
                context: context,
                request: MomoInviteCreateRequest(
                    role: role,
                    maxUses: clampedMaxUses,
                    expiresAtMs: expiresAtMs,
                    metadata: ["source": "macos-internal-alpha"]
                )
            )
            createdCode = created.code
            notice = oneTimeCopy.inviteCreated(role: created.invite.role)
            errorMessage = nil
            lastFailedAction = nil
            invites.removeAll { $0.id == created.invite.id }
            invites.insert(created.invite, at: 0)
            do {
                invites = try await loadInvites()
            } catch {
                errorMessage = oneTimeCopy.inviteCreatedRefreshFailed
                lastFailedAction = .refresh
            }
        } catch {
            errorMessage = error.localizedDescription
            lastFailedAction = .create(role: role, maxUsesText: maxUsesText, expiresInDaysText: expiresInDaysText)
        }
    }

    func revoke(_ invite: MomoInviteCode, reason: String) async {
        guard operation == .idle else { return }
        operation = .revoking(invite.id)
        defer { operation = .idle }
        do {
            let revoked = try await client.revokeInvite(
                context: context,
                inviteID: invite.id,
                reason: reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : reason
            )
            notice = "Invite \(revoked.codePreview) revoked."
            errorMessage = nil
            lastFailedAction = nil
            if let index = invites.firstIndex(where: { $0.id == revoked.id }) {
                invites[index] = revoked
            } else {
                invites.insert(revoked, at: 0)
            }
        } catch {
            errorMessage = error.localizedDescription
            lastFailedAction = .revoke(invite: invite, reason: reason)
        }
    }

    func copyCreatedCode() {
        guard let createdCode, !createdCode.isEmpty else {
            errorMessage = oneTimeCopy.createBeforeCopyingCode
            return
        }
        copyInviteCode(createdCode)
        notice = oneTimeCopy.inviteCodeCopied
        errorMessage = nil
    }

    var createdShortLink: URL? {
        guard let createdCode else { return nil }
        return MomoInviteShortLinkConfiguration.shortURL(
            code: createdCode,
            publicBaseURL: publicShortLinkBaseURL
        )
    }

    func copyCreatedShortLink() {
        guard let createdCode, !createdCode.isEmpty else {
            errorMessage = oneTimeCopy.createBeforeCopyingShortLink
            return
        }
        guard let createdShortLink else {
            errorMessage = oneTimeCopy.shortLinkUnavailable
            return
        }
        copyInviteLink(createdShortLink.absoluteString)
        notice = oneTimeCopy.shortLinkCopied
        errorMessage = nil
    }

    func discardCreatedCode() {
        createdCode = nil
    }

    func retryLastFailure() async {
        guard let lastFailedAction, operation == .idle else { return }
        switch lastFailedAction {
        case .refresh:
            await refreshInvites(showNotice: true)
        case let .create(role, maxUsesText, expiresInDaysText):
            await createInvite(role: role, maxUsesText: maxUsesText, expiresInDaysText: expiresInDaysText)
        case let .revoke(invite, reason):
            await revoke(invite, reason: reason)
        }
    }

    func isRevoking(_ invite: MomoInviteCode) -> Bool {
        operation == .revoking(invite.id)
    }

    private func loadInvites() async throws -> [MomoInviteCode] {
        try await client.listInvites(context: context, includeRevoked: true, limit: 50)
    }

    private static func copyToPasteboard(_ code: String) {
        let pasteboard = NSPasteboard.general
        let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
        let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
        pasteboard.declareTypes([.string, concealedType, transientType], owner: nil)
        pasteboard.setString(code, forType: .string)
    }
}

struct InviteAdminPopover: View {
    @StateObject private var model: MomoInviteAdminViewModel
    @Binding private var dismissLocked: Bool
    @State private var role: MembershipRole = .member
    @State private var maxUses = "1"
    @State private var expiresInDays = "7"
    @State private var revocationReasons: [UUID: String] = [:]
    private let oneTimeCopy: MomoInviteOneTimeCopy

    init(
        context: MomoInviteAdminContext,
        language: MomoUILanguage = .preferredDefault,
        dismissLocked: Binding<Bool> = .constant(false)
    ) {
        _dismissLocked = dismissLocked
        _model = StateObject(wrappedValue: MomoInviteAdminViewModel(context: context, language: language))
        oneTimeCopy = MomoInviteOneTimeCopy(language: language)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Invites")
                    .font(.headline)
                Spacer()
                if model.operation == .refreshing {
                    ProgressView()
                        .controlSize(.small)
                }
                Button {
                    Task { await model.refreshInvites(showNotice: true) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(model.isWorking)
                .help("Refresh")
            }

            createControls
            feedbackRows

            Divider()

            inviteList
        }
        .padding(16)
        .frame(width: 460, height: 520, alignment: .topLeading)
        .task {
            if model.invites.isEmpty {
                await model.refreshInvites()
            }
        }
        .onChange(of: model.operation) { _, _ in
            synchronizeDismissLock()
        }
        .onChange(of: model.createdCode) { _, _ in
            synchronizeDismissLock()
        }
        .onDisappear {
            model.discardCreatedCode()
            dismissLocked = false
        }
    }

    private var createControls: some View {
        Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 8) {
            GridRow {
                Text("Role").foregroundStyle(.secondary)
                Picker("Role", selection: $role) {
                    Text("Member").tag(MembershipRole.member)
                    Text("Admin").tag(MembershipRole.admin)
                    Text("Guest").tag(MembershipRole.guest)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .disabled(model.isWorking)
            }
            GridRow {
                Text("Uses").foregroundStyle(.secondary)
                TextField("1", text: $maxUses)
                    .textFieldStyle(.roundedBorder)
                    .disabled(model.isWorking)
            }
            GridRow {
                Text("Days").foregroundStyle(.secondary)
                TextField("7", text: $expiresInDays)
                    .textFieldStyle(.roundedBorder)
                    .disabled(model.isWorking)
            }
            GridRow {
                Color.clear
                Button {
                    dismissLocked = true
                    Task {
                        await model.createInvite(
                            role: role,
                            maxUsesText: maxUses,
                            expiresInDaysText: expiresInDays
                        )
                        synchronizeDismissLock()
                    }
                } label: {
                    if model.operation == .creating {
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Creating")
                        }
                    } else {
                        Label("Create Invite", systemImage: "plus.circle")
                    }
                }
                .disabled(model.isWorking || model.createdCode != nil)
            }
        }
        .font(.caption)
    }

    @ViewBuilder
    private var feedbackRows: some View {
        if let code = model.createdCode {
            VStack(alignment: .leading, spacing: 6) {
                Text(oneTimeCopy.newInviteCode)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Text(code)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .privacySensitive()
                    Spacer()
                    Button {
                        model.copyCreatedCode()
                    } label: {
                        Label(oneTimeCopy.copyCode, systemImage: "doc.on.doc")
                    }
                    .controlSize(.small)
                    .disabled(model.isWorking)
                }
                if let shortLink = model.createdShortLink {
                    HStack(spacing: 8) {
                        Label(shortLink.absoluteString, systemImage: "link")
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .textSelection(.enabled)
                            .privacySensitive()
                        Spacer()
                        Button {
                            model.copyCreatedShortLink()
                        } label: {
                            Text(oneTimeCopy.copyShortLink)
                        }
                        .controlSize(.small)
                        .disabled(model.isWorking)
                    }
                }
                HStack {
                    Spacer()
                    Button(oneTimeCopy.savedIt) {
                        model.discardCreatedCode()
                        synchronizeDismissLock()
                    }
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.isWorking)
                }
                Text(oneTimeCopy.saveNowHint)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(MomoTheme.reversibleGreen.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }

        if let status = model.operation.statusText {
            Label(status, systemImage: "hourglass")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let notice = model.notice {
            Label(notice, systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(MomoTheme.reversibleGreen)
                .textSelection(.enabled)
        }
        if let error = model.errorMessage {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .textSelection(.enabled)
                Spacer()
                if model.canRetry {
                    Button {
                        dismissLocked = true
                        Task {
                            await model.retryLastFailure()
                            synchronizeDismissLock()
                        }
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                    }
                    .controlSize(.small)
                    .disabled(model.isWorking)
                }
            }
        }
    }

    private var inviteList: some View {
        List(model.invites) { invite in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("••••\(invite.codePreview)")
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                    Spacer()
                    Text(invite.statusLabel)
                        .font(.caption2.bold())
                        .foregroundStyle(invite.isRevoked ? MomoTheme.irreversibleRed : .secondary)
                }
                HStack(spacing: 10) {
                    Label(invite.role.rawValue, systemImage: "person.crop.circle.badge.checkmark")
                    Label("\(invite.usedCount)/\(invite.maxUses)", systemImage: "number")
                    Text(expiryText(invite.expiresAtMs))
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                if !invite.isRevoked {
                    HStack {
                        TextField("Reason", text: revocationReasonBinding(for: invite))
                            .textFieldStyle(.roundedBorder)
                            .disabled(model.isWorking)
                        Button(role: .destructive) {
                            Task { await model.revoke(invite, reason: revocationReason(for: invite)) }
                        } label: {
                            if model.isRevoking(invite) {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "xmark.circle")
                            }
                        }
                        .buttonStyle(.borderless)
                        .disabled(model.isWorking)
                        .help("Revoke")
                    }
                } else if let reason = invite.revocationReason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
        .overlay {
            if model.invites.isEmpty && model.operation == .refreshing {
                ProgressView()
            } else if model.invites.isEmpty && !model.isWorking {
                ContentUnavailableView("No invites", systemImage: "person.badge.key")
            }
        }
    }

    private func revocationReason(for invite: MomoInviteCode) -> String {
        revocationReasons[invite.id] ?? "internal alpha cleanup"
    }

    private func revocationReasonBinding(for invite: MomoInviteCode) -> Binding<String> {
        Binding(
            get: { revocationReason(for: invite) },
            set: { revocationReasons[invite.id] = $0 }
        )
    }

    private func synchronizeDismissLock() {
        dismissLocked = model.operation == .creating || model.createdCode != nil
    }

    private func expiryText(_ expiresAtMs: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(expiresAtMs) / 1000)
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

struct SessionDetailPopover: View {
    var summary: MomoServerSessionSummary
    var realtimeStatus: RealtimeConnectionStatus?
    var agentStatus: AgentRuntimeStatus

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
            row("Mode", summary.mode.title)
            row("Server", summary.serverURLString ?? summary.title)
            row("Workspace", summary.workspaceIDString ?? "Not connected")
            row("Member", summary.memberLabel ?? "Unknown")
            row("Email", summary.email ?? "Not stored")
            row("Session", summary.detail)
            row("Channels", String(summary.channelCount))
            row("Realtime", realtimeDescription)
            row("Kim Intern", agentDescription)
        }
        .padding(16)
        .frame(minWidth: 360, alignment: .leading)
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label)
                .foregroundStyle(.secondary)
            Text(value)
                .textSelection(.enabled)
        }
        .font(.caption)
    }

    private var realtimeDescription: String {
        guard let realtimeStatus else {
            return "Waiting for channel selection"
        }
        var parts = [realtimeStatus.connection.rawValue, realtimeStatus.subscription.rawValue]
        if realtimeStatus.fallback == .restHistory {
            parts.append("REST history fallback")
        }
        if let message = realtimeStatus.message, !message.isEmpty {
            parts.append(message)
        }
        return parts.joined(separator: " · ")
    }

    private var agentDescription: String {
        var parts = [
            agentStatus.availability.label,
            agentStatus.mode.internalAlphaLabel,
            agentStatus.endpointLabel,
        ]
        if !agentStatus.keyConfigured {
            parts.append("key not configured")
        }
        if let diagnostic = agentStatus.diagnostics.first, !diagnostic.isEmpty {
            parts.append(diagnostic)
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Session DTOs

private struct LoginRequest: Encodable {
    let email: String
    let password: String
    let workspace: String?
}

private struct LoginResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let member: SessionMemberDTO
    let realtimeWebSocketUrl: String?
}

private struct JoinRequest: Encodable {
    let code: String
    let email: String
    let displayName: String
    let handle: String
    let password: String
    let timeZone: String
}

private struct JoinResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let workspaceId: String
    let member: SessionMemberDTO
    let realtimeWebSocketUrl: String?
}

private struct CreateInviteResponse: Decodable {
    let invite: InviteCodeDTO
    let code: String

    var createdInvite: MomoCreatedInvite {
        MomoCreatedInvite(invite: invite.invite, code: code)
    }
}

private struct InviteListResponse: Decodable {
    let invites: [InviteCodeDTO]
}

private struct RevokeInviteRequest: Encodable {
    let reason: String?
}

private struct InviteCodeDTO: Decodable {
    let id: String
    let workspaceId: String
    let codePreview: String
    let role: String
    let maxUses: Int
    let usedCount: Int
    let expiresAtMs: Int64
    let revokedAtMs: Int64?
    let revokedBy: String?
    let revocationReason: String?
    let createdBy: String
    let createdAtMs: Int64
    let updatedAtMs: Int64

    var invite: MomoInviteCode {
        MomoInviteCode(
            id: UUID(uuidString: id) ?? UUID(),
            workspaceId: WorkspaceID(uuidString: workspaceId) ?? .demo,
            codePreview: codePreview,
            role: MembershipRole(rawValue: role) ?? .member,
            maxUses: maxUses,
            usedCount: usedCount,
            expiresAtMs: expiresAtMs,
            revokedAtMs: revokedAtMs,
            revokedBy: revokedBy.flatMap { MemberID(uuidString: $0) },
            revocationReason: revocationReason,
            createdBy: MemberID(uuidString: createdBy) ?? .demoHuman,
            createdAtMs: createdAtMs,
            updatedAtMs: updatedAtMs
        )
    }
}

private struct SessionMemberDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let displayName: String
    let handle: String

    func member() throws -> Member {
        guard let memberID = MemberID(uuidString: id),
              let workspaceID = WorkspaceID(uuidString: workspaceId)
        else {
            throw MomoServerSessionError.decoding("Server returned an invalid session member identity.")
        }
        return Member(
            id: memberID,
            workspaceId: workspaceID,
            kind: MemberKind(rawValue: kind) ?? .human,
            displayName: displayName,
            handle: handle,
            presence: .online
        )
    }
}

private struct ProblemResponse: Decodable {
    let title: String?
    let detail: String?
    let message: String?
}
