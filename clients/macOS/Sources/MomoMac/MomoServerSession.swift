import Foundation
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
        baseURLString: String = "http://127.0.0.1:8080",
        email: String = "demo@momo.local",
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

    public func validatedBaseURL() throws -> URL {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil, url.host != nil else {
            throw MomoServerSessionError.validation("Enter a server URL like http://127.0.0.1:8080.")
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

public actor MomoServerSessionClient {
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(session: URLSession = .shared) {
        self.session = session
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
        let member = response.member.member
        return MomoServerSession(
            baseURL: baseURL,
            centrifugoWebSocketURL: Self.centrifugoWebSocketURL(from: ProcessInfo.processInfo.environment),
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
            centrifugoWebSocketURL: Self.centrifugoWebSocketURL(from: ProcessInfo.processInfo.environment),
            workspace: workspace,
            member: response.member.member,
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
}

// MARK: - Session storage

public final class MomoServerSessionStore: @unchecked Sendable {
    public static let shared = MomoServerSessionStore()

    private let defaults: UserDefaults
    private let keychain: MomoKeychainPasswordStore
    private let prefix: String

    public init(
        defaults: UserDefaults = .standard,
        keychain: MomoKeychainPasswordStore = .init(),
        prefix: String = "momo.mac.session."
    ) {
        self.defaults = defaults
        self.keychain = keychain
        self.prefix = prefix
    }

    public func load() -> MomoServerSessionForm {
        let baseURL = defaults.string(forKey: key("baseURL")) ?? "http://127.0.0.1:8080"
        let email = defaults.string(forKey: key("email")) ?? "demo@momo.local"
        let inviteCode = defaults.string(forKey: key("inviteCode")) ?? ""
        let savePassword = defaults.bool(forKey: key("savePassword"))
        let password = savePassword ? (keychain.password(account: email) ?? "") : ""
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
        if form.savePassword {
            keychain.setPassword(form.password, account: email)
        } else {
            keychain.deletePassword(account: email)
        }
    }

    public func clearSessionSensitiveState(email: String? = nil) {
        let account = email ?? defaults.string(forKey: key("email"))
        if let account, !account.isEmpty {
            keychain.deletePassword(account: account)
        }
        defaults.set(false, forKey: key("savePassword"))
    }

    private func key(_ name: String) -> String { prefix + name }
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
        case connected(ChatViewModel, MomoServerSessionSummary)
        case failed(String)
    }

    @Published public var form: MomoServerSessionForm
    @Published public private(set) var phase: Phase = .choosing
    @Published public private(set) var sessionNotice: String?

    private let store: MomoServerSessionStore
    private let client: MomoServerSessionClient
    private var didAttemptEnvironmentAutoconnect = false

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
        phase = .connecting("Connecting to \(config.baseURL.absoluteString)")
        let viewModel = await MomoMacDemo.makeRESTViewModel(config: config)
        if let error = viewModel.connectionError {
            phase = .failed(error)
            return
        }
        sessionNotice = nil
        phase = .connected(viewModel, MomoServerSessionSummary(
            mode: .real,
            title: config.baseURL.absoluteString,
            detail: "Environment session",
            channelCount: viewModel.channels.count,
            serverURLString: config.baseURL.absoluteString,
            workspaceIDString: config.workspace.description,
            email: config.login.email
        ))
    }

    public func openDemo() async {
        phase = .connecting("Opening demo workspace")
        let viewModel = await MomoMacDemo.makeViewModel()
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
        ))
    }

    public func connectRealServer() async {
        await establishRealSession(useInvite: false)
    }

    public func joinAndConnect() async {
        await establishRealSession(useInvite: true)
    }

    public func resetToChooser() async {
        await clearActiveSessionState()
        phase = .choosing
        sessionNotice = "Choose a server or account. Previous realtime state was cleared."
    }

    public func switchSession() async {
        await clearActiveSessionState()
        form = store.load()
        form.password = ""
        phase = .choosing
        sessionNotice = "Choose another server or account. Previous token, realtime subscription, and channel cache were cleared."
    }

    public func logout() async {
        let email = connectedEmail ?? form.email
        await clearActiveSessionState()
        form.password = ""
        store.clearSessionSensitiveState(email: email)
        form.savePassword = false
        phase = .choosing
        sessionNotice = "Logged out. Access token, saved password, realtime subscription, and session cache were cleared."
    }

    private func establishRealSession(useInvite: Bool) async {
        phase = .connecting(useInvite ? "Joining workspace" : "Signing in")
        do {
            store.save(form)
            let session = try await (useInvite ? client.join(form: form) : client.login(form: form))
            let viewModel = await makeViewModel(session: session, password: form.password)
            form.password = ""
            if let error = viewModel.connectionError {
                phase = .failed(error)
                return
            }
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
            ))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func makeViewModel(session: MomoServerSession, password: String) async -> ChatViewModel {
        let config = MomoServerRESTChatBackendConfig(
            baseURL: session.baseURL,
            centrifugoWebSocketURL: session.centrifugoWebSocketURL,
            accessToken: session.accessToken,
            login: .init(email: session.email, password: password),
            workspace: session.workspace,
            channels: [],
            members: [session.member]
        )
        return await MomoMacDemo.makeRESTViewModel(config: config)
    }

    private var connectedViewModel: ChatViewModel? {
        if case .connected(let viewModel, _) = phase {
            return viewModel
        }
        return nil
    }

    private var connectedEmail: String? {
        if case .connected(_, let summary) = phase {
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

    public init(controller: @autoclosure @escaping () -> MomoServerSessionController = MomoServerSessionController()) {
        _controller = StateObject(wrappedValue: controller())
    }

    public var body: some View {
        Group {
            switch controller.phase {
            case .choosing:
                MomoServerSessionChooser(controller: controller)
            case .connecting(let message):
                VStack(spacing: 12) {
                    ProgressView()
                    Text(message)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .connected(let viewModel, let summary):
                MomoMacRootView(existingViewModel: viewModel)
                    .safeAreaInset(edge: .top, spacing: 0) {
                        SessionStatusBar(
                            summary: summary,
                            viewModel: viewModel,
                            switchSession: {
                                Task { await controller.switchSession() }
                            },
                            logout: {
                                Task { await controller.logout() }
                            }
                        )
                    }
            case .failed(let message):
                MomoServerSessionChooser(controller: controller, errorMessage: message)
            }
        }
        .task {
            await controller.autoConnectFromEnvironmentIfAvailable()
        }
    }
}

private struct MomoServerSessionChooser: View {
    @ObservedObject var controller: MomoServerSessionController
    var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("momo")
                        .font(.largeTitle.bold())
                    Text("Choose a demo workspace or connect to a MomoServer.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    Task { await controller.openDemo() }
                } label: {
                    Label("Open Demo", systemImage: "sparkles")
                }
            }

            Divider()

            if let notice = controller.sessionNotice {
                Label(notice, systemImage: "checkmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .textSelection(.enabled)
            }

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                GridRow {
                    Text("Server URL").foregroundStyle(.secondary)
                    TextField("http://127.0.0.1:8080", text: $controller.form.baseURLString)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Email").foregroundStyle(.secondary)
                    TextField("demo@momo.local", text: $controller.form.email)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Password").foregroundStyle(.secondary)
                    SecureField("Password", text: $controller.form.password)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Invite code").foregroundStyle(.secondary)
                    TextField("Optional", text: $controller.form.inviteCode)
                        .textFieldStyle(.roundedBorder)
                }
            }

            Toggle(isOn: $controller.form.savePassword) {
                Text("Save password in Keychain")
            }
            .toggleStyle(.checkbox)

            HStack {
                Button {
                    Task { await controller.connectRealServer() }
                } label: {
                    Label("Sign In", systemImage: "server.rack")
                }
                .keyboardShortcut(.defaultAction)

                Button {
                    Task { await controller.joinAndConnect() }
                } label: {
                    Label("Join with Invite", systemImage: "person.badge.plus")
                }
                .disabled(controller.form.trimmedInviteCode.isEmpty)

                Spacer()

                Text("Real-server mode stores server URL, email, invite code, and optional Keychain password.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(28)
        .frame(maxWidth: 720, maxHeight: .infinity, alignment: .center)
    }
}

private struct SessionStatusBar: View {
    var summary: MomoServerSessionSummary
    @ObservedObject var viewModel: ChatViewModel
    var switchSession: () -> Void
    var logout: () -> Void
    @State private var showDetails = false

    var body: some View {
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
                Label("No channels", systemImage: "tray")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.costAmber)
            }
            Button {
                showDetails.toggle()
            } label: {
                Label("Details", systemImage: "info.circle")
            }
            .popover(isPresented: $showDetails) {
                SessionDetailPopover(summary: summary, realtimeStatus: viewModel.selectedRealtimeStatus)
            }
            .controlSize(.small)
            Button(action: switchSession) {
                Label("Switch", systemImage: "arrow.left.arrow.right")
            }
            .controlSize(.small)
            Button(role: .destructive, action: logout) {
                Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .controlSize(.small)
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

    private var realtimePill: some View {
        let status = viewModel.selectedRealtimeStatus
        let title: String
        let icon: String
        let color: Color
        if let status, status.isLive {
            title = "Live"
            icon = "dot.radiowaves.left.and.right"
            color = .green
        } else if let status, status.connection == .reconnecting || status.subscription == .recovering {
            title = "Reconnecting"
            icon = "arrow.triangle.2.circlepath"
            color = .blue
        } else if let status, status.fallback == .restHistory {
            title = "REST fallback"
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

private struct SessionDetailPopover: View {
    var summary: MomoServerSessionSummary
    var realtimeStatus: RealtimeConnectionStatus?

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
}

private struct SessionMemberDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let displayName: String
    let handle: String

    var member: Member {
        Member(
            id: MemberID(uuidString: id) ?? .demoHuman,
            workspaceId: WorkspaceID(uuidString: workspaceId) ?? .demo,
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
