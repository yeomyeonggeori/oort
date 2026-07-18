import Foundation
import MomoCore

public actor MomoHuddleRESTService: MomoHuddleService {
    private struct Credential: Sendable {
        var workspace: WorkspaceID
        var token: String
        var realtimeURL: URL?
    }

    private struct HuddleResponse: Decodable { var huddle: MomoHuddle }
    private struct ActiveResponse: Decodable { var huddle: MomoHuddle? }
    private struct JoinResponse: Decodable {
        var huddle: MomoHuddle
        var livekitUrl: String
        var token: String
        var expiresAtMs: Int64
    }
    private struct ProblemResponse: Decodable {
        var title: String?
        var detail: String?
        var message: String?
    }
    private struct EmptyBody: Encodable {}

    private let baseURL: URL
    private let session: URLSession
    private let environment: [String: String]
    private let sessionStore: MomoServerSessionStore
    private var credential: Credential?

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        sessionStore: MomoServerSessionStore = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
        self.environment = environment
        self.sessionStore = sessionStore
    }

    public func active(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle? {
        try await get(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/huddles/active",
            workspace: workspace,
            response: ActiveResponse.self
        ).huddle
    }

    public func start(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle {
        try await post(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/huddles",
            workspace: workspace,
            response: HuddleResponse.self
        ).huddle
    }

    public func join(workspace: WorkspaceID, huddle: UUID) async throws -> MomoHuddleJoin {
        let response = try await post(
            "/v1/workspaces/\(workspace.description)/huddles/\(huddle.uuidString)/join",
            workspace: workspace,
            response: JoinResponse.self
        )
        guard let url = URL(string: response.livekitUrl), url.scheme != nil else {
            throw MomoHuddleClientError.invalidResponse
        }
        return MomoHuddleJoin(
            huddle: response.huddle,
            liveKitURL: url,
            token: response.token,
            expiresAt: Date(timeIntervalSince1970: TimeInterval(response.expiresAtMs) / 1_000)
        )
    }

    public func leave(workspace: WorkspaceID, huddle: UUID) async throws {
        _ = try await post(
            "/v1/workspaces/\(workspace.description)/huddles/\(huddle.uuidString)/leave",
            workspace: workspace,
            response: HuddleResponse.self
        )
    }

    public func events(
        workspace: WorkspaceID,
        channel: ChannelID
    ) async throws -> AsyncStream<HuddleDelta> {
        let credential = try await credential(for: workspace)
        guard let realtimeURL = credential.realtimeURL else {
            return AsyncStream { $0.finish() }
        }
        let token = credential.token
        let provider = MomoServerRealtimeTokenProvider(baseURL: baseURL, session: session) { token }
        let transport = SwiftCentrifugeRealtimeSubscriptionTransport(
            endpoint: realtimeURL,
            workspace: workspace,
            tokenProvider: provider
        )
        let driver = DefaultRealtimeSubscriptionDriver(transport: transport)
        let stream = try await driver.subscribe(channel: channel, startingAfter: 0) { _, _ in [] }
        return AsyncStream { continuation in
            let task = Task {
                for await event in stream {
                    if case .huddle(let delta) = event { continuation.yield(delta) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func credential(for workspace: WorkspaceID) async throws -> Credential {
        if let credential, credential.workspace == workspace { return credential }

        if let config = MomoServerRESTChatBackendConfig.fromEnvironment(environment),
           config.baseURL == baseURL,
           let token = config.accessToken {
            let value = Credential(
                workspace: workspace,
                token: token,
                realtimeURL: config.centrifugoWebSocketURL
            )
            credential = value
            return value
        }

        var form = sessionStore.load()
        if let config = MomoServerRESTChatBackendConfig.fromEnvironment(environment), config.baseURL == baseURL {
            form.baseURLString = config.baseURL.absoluteString
            form.email = config.login.email
            form.password = config.login.password
        }
        guard URL(string: form.baseURLString) == baseURL, form.canSignIn else {
            throw MomoHuddleClientError.unavailable(
                "Sign in again or launch the development app with MOMO_SERVER_BASE_URL credentials."
            )
        }
        let authenticated = try await MomoServerSessionClient(session: session, environment: environment)
            .login(form: form, workspace: workspace)
        let value = Credential(
            workspace: authenticated.workspace,
            token: authenticated.accessToken,
            realtimeURL: authenticated.centrifugoWebSocketURL
        )
        credential = value
        return value
    }

    private func get<T: Decodable>(
        _ path: String,
        workspace: WorkspaceID,
        response: T.Type
    ) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        request.setValue("Bearer \(try await credential(for: workspace).token)", forHTTPHeaderField: "Authorization")
        return try await execute(request, response: response)
    }

    private func post<T: Decodable>(
        _ path: String,
        workspace: WorkspaceID,
        response: T.Type
    ) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(EmptyBody())
        request.setValue("Bearer \(try await credential(for: workspace).token)", forHTTPHeaderField: "Authorization")
        return try await execute(request, response: response)
    }

    private func execute<T: Decodable>(_ request: URLRequest, response: T.Type) async throws -> T {
        let (data, urlResponse) = try await session.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse else {
            throw MomoHuddleClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let problem = try? JSONDecoder().decode(ProblemResponse.self, from: data)
            throw MomoHuddleClientError.http(
                http.statusCode,
                problem?.detail ?? problem?.message ?? problem?.title ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MomoHuddleClientError.invalidResponse
        }
    }
}
