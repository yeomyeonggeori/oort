import Foundation
import MomoCore

// MARK: - MomoServer REST ChatBackend

/// REST-backed v0 `ChatBackend` for the SwiftPM macOS development app.
///
/// Scope is intentionally narrow: auth/login, history, and send use MomoServer
/// REST. Realtime can be composed with a `RealtimeSubscriptionDriver`, while the
/// default remains an empty stream until a real SwiftCentrifuge adapter is wired.
public actor MomoServerRESTChatBackend: ChatBackend, AgentTransport, MomoAgentCredentialBackend, RealtimeStatusProvidingBackend, AgentRuntimeStatusProviding, MomoSessionSensitiveStateClearing, ServerRosterSourceOfTruth {
    public let config: MomoServerRESTChatBackendConfig
    public private(set) var realtimeWebSocketURL: URL?

    private let session: URLSession
    private var realtimeDriver: (any RealtimeSubscriptionDriver)?
    private var hasExplicitRealtimeDriver: Bool
    private var agentRealtimeTransport: (any AgentRealtimeEnvelopeSubscriptionTransport)?
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var workspace: WorkspaceID?
    private var accessToken: String?
    private var authenticatedMember: Member?
    private var cachedChannels: [Channel]?
    private var cachedMembers: [Member]?
    private var lastKnownSeqByChannel: [ChannelID: Int64] = [:]
    private var realtimeStatusByChannel: [ChannelID: RealtimeConnectionStatus] = [:]
    private var realtimeStatusStreams: [ChannelID: [UUID: AsyncStream<RealtimeConnectionStatus>.Continuation]] = [:]

    public init(
        config: MomoServerRESTChatBackendConfig,
        session: URLSession = .shared,
        realtimeDriver: (any RealtimeSubscriptionDriver)? = nil
    ) {
        self.config = config
        self.realtimeWebSocketURL = config.centrifugoWebSocketURL
        self.session = session
        self.realtimeDriver = realtimeDriver
        self.hasExplicitRealtimeDriver = realtimeDriver != nil
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        self.decoder.keyDecodingStrategy = .useDefaultKeys
    }

    public func connect(workspace: WorkspaceID, accessToken: String) async throws {
        self.workspace = workspace
        if !accessToken.isEmpty {
            self.accessToken = accessToken
            try configureRealtime(config.centrifugoWebSocketURL?.absoluteString)
            return
        }
        if let configured = config.accessToken, !configured.isEmpty {
            self.accessToken = configured
            try configureRealtime(config.centrifugoWebSocketURL?.absoluteString)
            return
        }

        let login = try await post(
            "/v1/auth/login",
            body: LoginRequest(
                email: config.login.email,
                password: config.login.password,
                workspace: workspace.description
            ),
            authorized: false,
            response: LoginResponse.self
        )
        self.accessToken = login.accessToken
        self.authenticatedMember = try login.member.member()
        try configureRealtime(
            login.realtimeWebSocketUrl ?? config.centrifugoWebSocketURL?.absoluteString
        )
    }

    public func setRealtimeDriver(_ realtimeDriver: (any RealtimeSubscriptionDriver)?) {
        self.realtimeDriver = realtimeDriver
        hasExplicitRealtimeDriver = true
    }

    public func setAgentRealtimeTransport(
        _ transport: (any AgentRealtimeEnvelopeSubscriptionTransport)?
    ) {
        agentRealtimeTransport = transport
    }

    public func requireAccessToken() throws -> String {
        guard let accessToken, !accessToken.isEmpty else { throw BackendError.notConnected }
        return accessToken
    }

    public func clearSessionSensitiveState() async {
        workspace = nil
        accessToken = nil
        authenticatedMember = nil
        cachedChannels = nil
        cachedMembers = nil
        lastKnownSeqByChannel = [:]
        realtimeStatusByChannel = [:]
        for continuations in realtimeStatusStreams.values {
            for continuation in continuations.values {
                continuation.finish()
            }
        }
        realtimeStatusStreams = [:]
        realtimeWebSocketURL = config.centrifugoWebSocketURL
    }

    public func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        guard let workspace else { throw BackendError.notConnected }
        let request = SendMessageRequest(
            clientMsgId: clientMsgId,
            type: draft.type.rawValue,
            body: draft.body,
            props: draft.props.flatStringObject,
            runId: nil
        )
        var message = try await post(
            "/v1/workspaces/\(workspace.description)/channels/\(draft.channelId.description)/messages",
            body: request,
            authorized: true,
            response: MessageDTO.self
        ).message
        message.clientMsgId = clientMsgId
        message.props = draft.props
        message.rootId = draft.rootId
        message.replyToId = draft.replyToId
        return message
    }

    public func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        guard accessToken != nil else { throw BackendError.notConnected }
        var streams: [AsyncStream<RealtimeEvent>] = []
        if let realtimeDriver {
            emitRealtimeStatus(RealtimeConnectionStatus(
                channelId: channel,
                connection: .connecting,
                subscription: .subscribing,
                canRetry: false,
                message: "Subscribing to channel realtime."
            ))
            let startingSeq = lastKnownSeqByChannel[channel] ?? 0
            streams.append(try await realtimeDriver.subscribe(
                channel: channel,
                startingAfter: startingSeq,
                backfill: { [weak self] after, limit in
                    guard let self else { return [] }
                    return try await self.history(channel: channel, after: after, limit: limit)
                }
            ))
        }

        if let agentRealtimeTransport {
            let members = cachedMembers ?? []
            let agents = members.filter {
                $0.kind == .agent && $0.status == .active && $0.channelIds.contains(channel)
            }
            for agent in agents {
                if let stream = try? await Self.agentRealtimeEvents(
                    transport: agentRealtimeTransport,
                    agent: agent.id,
                    channel: channel
                ) {
                    streams.append(stream)
                }
            }
        }

        guard !streams.isEmpty else {
            emitRealtimeStatus(.restFallback(channel: channel))
            return AsyncStream { continuation in
                continuation.finish()
            }
        }
        return Self.mergeRealtimeStreams(streams)
    }

    public func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        if let statusDriver = realtimeDriver as? any RealtimeStatusProvidingDriver {
            return await statusDriver.realtimeStatus(channel: channel)
        }

        return AsyncStream { continuation in
            let token = UUID()
            continuation.yield(realtimeStatusByChannel[channel] ?? .restFallback(channel: channel))
            realtimeStatusStreams[channel, default: [:]][token] = continuation
            continuation.onTermination = { _ in
                Task { await self.unregisterRealtimeStatus(channel: channel, token: token) }
            }
        }
    }

    public func retryRealtime(channel: ChannelID) async {
        emitRealtimeStatus(RealtimeConnectionStatus(
            channelId: channel,
            connection: realtimeDriver == nil ? .disabled : .reconnecting,
            subscription: realtimeDriver == nil ? .disabled : .recovering,
            fallback: .restHistory,
            canRetry: realtimeDriver == nil,
            message: realtimeDriver == nil
                ? "Realtime is not configured; REST history is active."
                : "Retry requested."
        ))
    }

    public func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        guard let workspace else { throw BackendError.notConnected }
        var items = [
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let seq {
            items.append(URLQueryItem(name: "after", value: String(seq)))
        }

        let page = try await get(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages",
            queryItems: items,
            response: MessagePage.self
        )
        let messages = page.messages.map(\.message).sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        rememberLastKnownSeq(messages, channel: channel)
        return messages
    }

    public func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        (cachedMembers ?? []).filter {
            $0.status == .active && $0.channelIds.contains(channel)
        }.map {
            PresenceEntry(memberId: $0.id, channelId: channel, presence: $0.presence)
        }
    }

    public func members(workspace: WorkspaceID) async throws -> [Member] {
        let response = try await get(
            "/v1/workspaces/\(workspace.description)/roster",
            queryItems: [],
            response: WorkspaceRosterResponse.self
        )
        var all = try response.members.map { try $0.member() }
        if let authenticatedMember, !all.contains(where: { $0.id == authenticatedMember.id }) {
            all.insert(authenticatedMember, at: 0)
        }
        cachedMembers = all
        return all
    }

    public func channels(workspace: WorkspaceID) async throws -> [Channel] {
        let response = try await get(
            "/v1/workspaces/\(workspace.description)/channels",
            queryItems: [],
            response: WorkspaceChannelsResponse.self
        )
        let channels = try response.channels.map { try $0.channel() }
        cachedChannels = channels
        return channels
    }

    public func createChannel(
        workspace: WorkspaceID,
        kind: ChannelKind,
        name: String,
        topic: String?
    ) async throws -> ChannelCreateResult {
        let response = try await post(
            "/v1/workspaces/\(workspace.description)/channels",
            body: CreateChannelRequest(kind: kind.rawValue, name: name, topic: topic),
            authorized: true,
            response: CreateChannelResponseDTO.self
        )
        let result = try response.result()
        cachedChannels = (cachedChannels ?? []) + [result.channel]
        return result
    }

    public func addMember(
        _ member: MemberID,
        to channel: ChannelID,
        role: MembershipRole = .member
    ) async throws -> ChannelMembership {
        guard let workspace else { throw BackendError.notConnected }
        return try await post(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/members",
            body: AddChannelMemberRequest(memberId: member.rawValue, role: role.rawValue),
            authorized: true,
            response: ChannelMembershipResponseDTO.self
        ).membership.membership()
    }

    public func removeMember(_ member: MemberID, from channel: ChannelID) async throws -> ChannelMembership {
        guard let workspace else { throw BackendError.notConnected }
        return try await delete(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/members/\(member.description)",
            authorized: true,
            response: ChannelMembershipResponseDTO.self
        ).membership.membership()
    }

    func agentCredentials(
        workspace: WorkspaceID,
        agent: MemberID
    ) async throws -> [MomoAgentCredential] {
        let response = try await get(
            "/v1/workspaces/\(workspace.description)/agents/\(agent.description)/credentials",
            queryItems: [],
            response: AgentCredentialListResponseDTO.self
        )
        return response.credentials.map(\.credential)
    }

    func issueAgentCredential(
        workspace: WorkspaceID,
        agent: MemberID,
        rotationGraceSeconds: Int = 24 * 60 * 60
    ) async throws -> MomoAgentCredentialReveal {
        let response = try await post(
            "/v1/workspaces/\(workspace.description)/agents/\(agent.description)/credentials",
            body: CreateAgentCredentialRequestDTO(
                scopes: nil,
                label: "Hermes gateway",
                expiresAtMs: nil,
                rotationGraceSeconds: rotationGraceSeconds
            ),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: CreateAgentCredentialResponseDTO.self
        )
        return response.reveal
    }

    func revokeAgentCredential(
        _ credential: UUID,
        workspace: WorkspaceID,
        agent: MemberID
    ) async throws -> MomoAgentCredential {
        try await post(
            "/v1/workspaces/\(workspace.description)/agents/\(agent.description)/credentials/\(credential.uuidString)/revoke",
            body: RevokeAgentCredentialRequestDTO(reason: "revoked from macOS pairing"),
            authorized: true,
            response: RevokeAgentCredentialResponseDTO.self
        ).credential.credential
    }

    public func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        guard let workspace else { throw BackendError.notConnected }
        let page = try await get(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/cost-snapshots",
            queryItems: [],
            response: CostSnapshotPage.self
        )
        return page.snapshots
    }

    public func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        var results: [Message] = []
        let searchableChannels: [Channel]
        if let cachedChannels {
            searchableChannels = cachedChannels
        } else {
            searchableChannels = try await channels(workspace: workspace)
        }
        for channel in searchableChannels where channel.workspaceId == workspace {
            let messages = try await history(channel: channel.id, after: nil, limit: 200)
            results += messages.filter { ($0.body ?? "").localizedCaseInsensitiveContains(query) }
        }
        return results.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
    }

    public func setTyping(channel: ChannelID, isTyping: Bool) async {}

    public func editMessage(_ id: MessageID, body: String) async throws -> Message {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "REST edit is out of scope for MOMO-177")
    }

    public func addReaction(_ id: MessageID, emoji: String) async throws {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "REST reactions are out of scope for MOMO-177")
    }

    public func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        let page = try await get(
            "/v1/workspaces/\(workspace.description)/approvals",
            queryItems: [URLQueryItem(name: "status", value: status.rawValue)],
            response: ApprovalPageDTO.self
        )
        return page.approvals.map(\.approval)
    }

    public func agentRuntimeStatus() async throws -> AgentRuntimeStatus {
        try await get(
            "/v1/agent-runtime/status",
            queryItems: [],
            response: AgentRuntimeStatusDTO.self
        ).status
    }

    public func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        guard let workspace else { throw BackendError.notConnected }
        return try await post(
            "/v1/workspaces/\(workspace.description)/approvals/\(request.approvalId.description)/decision",
            body: ApprovalDecisionRequestDTO(
                approvalId: request.approvalId.rawValue,
                approve: request.approve,
                reason: request.reason,
                clientDecisionId: request.clientDecisionId
            ),
            authorized: true,
            response: ApprovalDecisionReceiptDTO.self
        ).receipt
    }

    // MARK: AgentTransport compatibility

    public func observe(agent: MemberID, channel: ChannelID) async throws -> AsyncStream<AgentEvent> {
        guard let agentRealtimeTransport else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let events = try await Self.agentRealtimeEvents(
            transport: agentRealtimeTransport,
            agent: agent,
            channel: channel
        )
        return AsyncStream { continuation in
            let task = Task {
                for await event in events {
                    switch event {
                    case .agentStatus(let status):
                        continuation.yield(.status(status.runId, status.runStatus))
                    case .agentPartial(let partial):
                        if let delta = partial.textDelta {
                            continuation.yield(.textDelta(partial.runId, delta))
                        } else if let name = partial.toolCallName {
                            continuation.yield(.toolCall(
                                partial.runId,
                                name: name,
                                args: partial.toolCallArgs ?? .object([:])
                            ))
                        }
                    default:
                        continue
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func invoke(
        agent: MemberID,
        channel: ChannelID,
        prompt: String,
        idempotencyKey: UUID
    ) async throws -> RunID {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "Agent invoke is out of scope for MOMO-177")
    }

    public func decideApproval(_ id: ApprovalID, approve: Bool, reason: String?) async throws {
        _ = try await decideApproval(ApprovalDecisionRequest(approvalId: id, approve: approve, reason: reason))
    }

    public func cancelRun(_ id: RunID) async throws {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "Agent cancel is out of scope for MOMO-177")
    }

    // MARK: HTTP

    private func get<T: Decodable>(
        _ path: String,
        queryItems: [URLQueryItem],
        response: T.Type
    ) async throws -> T {
        var components = URLComponents(url: config.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !queryItems.isEmpty {
            components?.queryItems = queryItems
        }
        guard let url = components?.url else {
            throw BackendError.problem(status: 400, title: "bad url", detail: path)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        try authorize(&request)
        return try await execute(request, response: response)
    }

    private func post<RequestBody: Encodable, ResponseBody: Decodable>(
        _ path: String,
        body: RequestBody,
        authorized: Bool,
        cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(
            url: config.baseURL.appendingPathComponent(path),
            cachePolicy: cachePolicy
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        if authorized {
            try authorize(&request)
        }
        return try await execute(request, response: response)
    }

    private func delete<ResponseBody: Decodable>(
        _ path: String,
        authorized: Bool,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = "DELETE"
        if authorized {
            try authorize(&request)
        }
        return try await execute(request, response: response)
    }

    private func authorize(_ request: inout URLRequest) throws {
        guard let accessToken else { throw BackendError.notConnected }
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    }

    private func execute<T: Decodable>(_ request: URLRequest, response: T.Type) async throws -> T {
        do {
            let (data, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else {
                throw BackendError.realtime("non-HTTP response")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw problemError(status: http.statusCode, data: data)
            }
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw BackendError.decoding(String(describing: error))
            }
        } catch let error as BackendError {
            throw error
        } catch {
            throw BackendError.realtime(error.localizedDescription)
        }
    }

    private func problemError(status: Int, data: Data) -> BackendError {
        if let problem = try? decoder.decode(ProblemResponse.self, from: data) {
            return .problem(status: status, title: problem.title, detail: problem.detail ?? problem.message)
        }
        return .problem(status: status, title: HTTPURLResponse.localizedString(forStatusCode: status), detail: nil)
    }

    private func rememberLastKnownSeq(_ messages: [Message], channel: ChannelID) {
        guard let maxSeq = messages.compactMap(\.seq).max() else {
            return
        }
        lastKnownSeqByChannel[channel] = max(lastKnownSeqByChannel[channel] ?? 0, maxSeq)
    }

    private func emitRealtimeStatus(_ status: RealtimeConnectionStatus) {
        realtimeStatusByChannel[status.channelId] = status
        guard let continuations = realtimeStatusStreams[status.channelId]?.values else {
            return
        }
        for continuation in continuations {
            continuation.yield(status)
        }
    }

    private func unregisterRealtimeStatus(channel: ChannelID, token: UUID) {
        realtimeStatusStreams[channel]?[token] = nil
    }

    private func configureRealtime(_ rawURL: String?) throws {
        guard let rawURL else { return }
        guard let endpoint = URL(string: rawURL),
              endpoint.host != nil,
              endpoint.scheme == "ws" || endpoint.scheme == "wss"
        else {
            throw BackendError.decoding("invalid server realtime WebSocket URL")
        }
        realtimeWebSocketURL = endpoint
        guard !hasExplicitRealtimeDriver else { return }
        let tokenProvider = MomoServerRealtimeTokenProvider(
            baseURL: config.baseURL,
            accessTokenProvider: { [weak self] in
                guard let self else { throw BackendError.notConnected }
                return try await self.requireAccessToken()
            }
        )
        let transport = SwiftCentrifugeRealtimeSubscriptionTransport(
            endpoint: endpoint,
            workspace: workspace ?? config.workspace,
            tokenProvider: tokenProvider
        )
        realtimeDriver = DefaultRealtimeSubscriptionDriver(transport: transport)
        agentRealtimeTransport = transport
    }

    private static func agentRealtimeEvents(
        transport: any AgentRealtimeEnvelopeSubscriptionTransport,
        agent: MemberID,
        channel: ChannelID
    ) async throws -> AsyncStream<RealtimeEvent> {
        let envelopes = try await transport.envelopes(agent: agent, channel: channel)
        return AsyncStream { continuation in
            let task = Task {
                do {
                    for try await envelope in envelopes {
                        switch try envelope.decodeEvent() {
                        case .agentStatus(let status) where status.agentMemberId == agent
                            && status.channelId == channel:
                            continuation.yield(.agentStatus(status))
                        case .agentPartial(let partial)
                            where partial.channelId == channel
                            && envelope.payload["agent_member_id"]?.stringValue?.lowercased()
                                == agent.description.lowercased():
                            continuation.yield(.agentPartial(partial))
                        default:
                            continue
                        }
                    }
                } catch {
                    // Durable final messages still arrive on ch:/REST history.
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func mergeRealtimeStreams(
        _ streams: [AsyncStream<RealtimeEvent>]
    ) -> AsyncStream<RealtimeEvent> {
        AsyncStream { continuation in
            let task = Task {
                await withTaskGroup(of: Void.self) { group in
                    for stream in streams {
                        group.addTask {
                            for await event in stream {
                                continuation.yield(event)
                            }
                        }
                    }
                    await group.waitForAll()
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - Configuration

public struct MomoServerRESTChatBackendConfig: Sendable, Hashable {
    public var baseURL: URL
    public var centrifugoWebSocketURL: URL?
    public var accessToken: String?
    public var login: Login
    public var workspace: WorkspaceID
    public var defaultChannel: ChannelID

    public init(
        baseURL: URL,
        centrifugoWebSocketURL: URL? = nil,
        accessToken: String? = nil,
        login: Login = .demo,
        workspace: WorkspaceID = .demo,
        defaultChannel: ChannelID = .demoGeneral
    ) {
        self.baseURL = baseURL
        self.centrifugoWebSocketURL = centrifugoWebSocketURL
        self.accessToken = accessToken
        self.login = login
        self.workspace = workspace
        self.defaultChannel = defaultChannel
    }

    public struct Login: Sendable, Hashable {
        public var email: String
        public var password: String

        public init(email: String, password: String) {
            self.email = email
            self.password = password
        }

        public static let demo = Login(email: "demo@momo.local", password: "dev-password")
    }

    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Self? {
        guard let rawBaseURL = environment["MOMO_SERVER_BASE_URL"],
              let baseURL = URL(string: rawBaseURL),
              baseURL.scheme != nil,
              baseURL.host != nil
        else {
            return nil
        }

        let workspace = environment["MOMO_WORKSPACE_ID"].flatMap { WorkspaceID(uuidString: $0) } ?? .demo
        let defaultChannel = environment["MOMO_CHANNEL_ID"].flatMap { ChannelID(uuidString: $0) } ?? .demoGeneral
        let token = environment["MOMO_ACCESS_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        let centrifugoWebSocketURL = Self.centrifugoWebSocketURL(from: environment)
        let login = Login(
            email: environment["MOMO_LOGIN_EMAIL"] ?? Login.demo.email,
            password: environment["MOMO_LOGIN_PASSWORD"] ?? Login.demo.password
        )
        return Self(
            baseURL: baseURL,
            centrifugoWebSocketURL: centrifugoWebSocketURL,
            accessToken: token,
            login: login,
            workspace: workspace,
            defaultChannel: defaultChannel
        )
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

public extension MomoServerRESTChatBackendConfig {
    var isDemoSeedWorkspace: Bool { workspace == .demo }
}

public extension WorkspaceID {
    static let demo = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
}

public extension MemberID {
    static let demoHuman = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
    static let demoAgent = MemberID(uuidString: "00000000-0000-7000-8000-000000000102")!
}

public extension ChannelID {
    static let demoGeneral = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
    static let demoAgentLab = ChannelID(uuidString: "00000000-0000-7000-8000-000000000202")!
}

// MARK: - DTOs

private struct LoginRequest: Encodable {
    let email: String
    let password: String
    let workspace: String
}

private struct LoginResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let member: MemberDTO
    let realtimeWebSocketUrl: String?
}

private struct CreateAgentCredentialRequestDTO: Encodable {
    let scopes: [String]?
    let label: String?
    let expiresAtMs: Int64?
    let rotationGraceSeconds: Int
}

private struct RevokeAgentCredentialRequestDTO: Encodable {
    let reason: String
}

private struct AgentCredentialDTO: Decodable {
    let id: UUID
    let agentMemberId: MemberID
    let status: String
    let scopes: [String]
    let label: String?
    let lastUsedAtMs: Int64?
    let expiresAtMs: Int64?
    let revokedAtMs: Int64?
    let createdAtMs: Int64

    var credential: MomoAgentCredential {
        MomoAgentCredential(
            id: id,
            agentMemberId: agentMemberId,
            serverStatus: status,
            scopes: scopes,
            label: label,
            lastUsedAtMs: lastUsedAtMs,
            expiresAtMs: expiresAtMs,
            revokedAtMs: revokedAtMs,
            createdAtMs: createdAtMs
        )
    }
}

private struct AgentCredentialListResponseDTO: Decodable {
    let credentials: [AgentCredentialDTO]
}

private struct CreateAgentCredentialResponseDTO: Decodable {
    let credential: AgentCredentialDTO
    let token: String
    let tokenType: String
    let rotatedCredentialCount: Int
    let rotationGraceEndsAtMs: Int64?

    var reveal: MomoAgentCredentialReveal {
        MomoAgentCredentialReveal(
            credential: credential.credential,
            token: token,
            tokenType: tokenType,
            rotatedCredentialCount: rotatedCredentialCount,
            rotationGraceEndsAtMs: rotationGraceEndsAtMs
        )
    }
}

private struct RevokeAgentCredentialResponseDTO: Decodable {
    let credential: AgentCredentialDTO
    let revokedNow: Bool
    let alreadyRevoked: Bool
}

private struct MemberDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let status: String?
    let displayName: String
    let handle: String
    let avatarUrl: String?
    let channelIds: [String]?
    let capabilities: [String]?

    func member() throws -> Member {
        guard let memberID = MemberID(uuidString: id),
              let workspaceID = WorkspaceID(uuidString: workspaceId)
        else {
            throw BackendError.decoding("invalid roster member identity")
        }
        return Member(
            id: memberID,
            workspaceId: workspaceID,
            kind: MemberKind(rawValue: kind) ?? .human,
            status: status.flatMap(MemberStatus.init(rawValue:)) ?? .active,
            displayName: displayName,
            handle: handle,
            avatarURL: avatarUrl.flatMap(URL.init(string:)),
            channelIds: (channelIds ?? []).compactMap { ChannelID(uuidString: $0) },
            capabilities: capabilities ?? [],
            presence: .online
        )
    }
}

private struct WorkspaceRosterResponse: Decodable {
    let members: [MemberDTO]
}

private struct SendMessageRequest: Encodable {
    let clientMsgId: UUID
    let type: String
    let body: String?
    let props: [String: String]?
    let runId: UUID?
}

private struct MessagePage: Decodable {
    let messages: [MessageDTO]
    let nextBefore: Int64?
}

private struct WorkspaceChannelsResponse: Decodable {
    let channels: [ChannelDTO]
}

private struct ChannelDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let name: String?
    let topic: String?
    let dmKey: String?
    let createdBy: String?
    let archivedAtMs: Int64?

    func channel() throws -> Channel {
        guard let id = ChannelID(uuidString: id) else {
            throw BackendError.decoding("invalid channel id")
        }
        guard let workspaceId = WorkspaceID(uuidString: workspaceId) else {
            throw BackendError.decoding("invalid channel workspace id")
        }
        guard let kind = ChannelKind(rawValue: kind) else {
            throw BackendError.decoding("invalid channel kind")
        }
        return Channel(
            id: id,
            workspaceId: workspaceId,
            kind: kind,
            name: name,
            topic: topic,
            dmKey: dmKey,
            createdBy: createdBy.flatMap { MemberID(uuidString: $0) },
            archivedAtMs: archivedAtMs
        )
    }
}

private struct CreateChannelRequest: Encodable {
    let kind: String
    let name: String
    let topic: String?
}

private struct CreateChannelResponseDTO: Decodable {
    let channel: ChannelDTO
    let creatorMembership: ChannelMembershipDTO

    func result() throws -> ChannelCreateResult {
        ChannelCreateResult(
            channel: try channel.channel(),
            creatorMembership: try creatorMembership.membership()
        )
    }
}

private struct AddChannelMemberRequest: Encodable {
    let memberId: UUID
    let role: String
}

private struct ChannelMembershipDTO: Decodable {
    let id: String
    let workspaceId: String
    let channelId: String
    let memberId: String
    let role: String
    let joinedAtMs: Int64
    let leftAtMs: Int64?

    func membership() throws -> ChannelMembership {
        guard let id = UUID(uuidString: id) else {
            throw BackendError.decoding("invalid membership id")
        }
        guard let workspaceId = WorkspaceID(uuidString: workspaceId) else {
            throw BackendError.decoding("invalid membership workspace id")
        }
        guard let channelId = ChannelID(uuidString: channelId) else {
            throw BackendError.decoding("invalid membership channel id")
        }
        guard let memberId = MemberID(uuidString: memberId) else {
            throw BackendError.decoding("invalid membership member id")
        }
        return ChannelMembership(
            id: id,
            workspaceId: workspaceId,
            channelId: channelId,
            memberId: memberId,
            role: MembershipRole(rawValue: role) ?? .member,
            joinedAtMs: joinedAtMs,
            leftAtMs: leftAtMs
        )
    }
}

private struct ChannelMembershipResponseDTO: Decodable {
    let membership: ChannelMembershipDTO
}

private struct MessageDTO: Decodable {
    let id: String
    let channelId: String
    let seq: Int64
    let hlcTs: Int64
    let hlcCount: Int32
    let authorMemberId: String
    let type: String
    let body: String?
    let props: JSON?
    let runId: String?
    let clientMsgId: UUID?
    let createdAtMs: Int64

    var message: Message {
        Message(
            id: MessageID(uuidString: id) ?? MessageID(),
            channelId: ChannelID(uuidString: channelId) ?? .demoGeneral,
            seq: seq,
            hlcTs: hlcTs,
            hlcCount: hlcCount,
            authorMemberId: MemberID(uuidString: authorMemberId) ?? .demoHuman,
            type: MessageType(rawValue: type) ?? .text,
            state: .sent,
            body: body,
            props: props ?? .object([:]),
            runId: runId.flatMap { RunID(uuidString: $0) },
            clientMsgId: clientMsgId,
            createdAtMs: createdAtMs
        )
    }
}

private struct AgentRuntimeStatusDTO: Decodable {
    let schema: String
    let agentHandle: String
    let displayName: String
    let mode: String
    let availability: String
    let model: String
    let endpointLabel: String
    let keyConfigured: Bool
    let degradedReason: String?
    let diagnostics: [String]

    var status: AgentRuntimeStatus {
        AgentRuntimeStatus(
            schema: schema,
            agentHandle: agentHandle,
            displayName: displayName,
            mode: AgentProviderMode(rawValue: mode) ?? .localMock,
            availability: AgentAvailability(rawValue: availability) ?? .unknown,
            model: model,
            endpointLabel: endpointLabel,
            keyConfigured: keyConfigured,
            degradedReason: degradedReason,
            diagnostics: diagnostics
        )
    }
}

private struct ApprovalDecisionRequestDTO: Encodable {
    let approvalId: UUID
    let approve: Bool
    let reason: String?
    let clientDecisionId: UUID

    private enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case approve
        case reason
        case clientDecisionId = "client_decision_id"
    }
}

private struct ApprovalDecisionReceiptDTO: Decodable {
    let approvalId: String
    let status: String
    let decidedBy: String?
    let decidedAtMs: Int64?
    let decisionReason: String?

    var receipt: ApprovalDecisionReceipt {
        ApprovalDecisionReceipt(
            approvalId: ApprovalID(uuidString: approvalId) ?? ApprovalID(),
            status: ApprovalStatus(rawValue: status) ?? .pending,
            decidedBy: decidedBy.flatMap { MemberID(uuidString: $0) },
            decidedAtMs: decidedAtMs,
            decisionReason: decisionReason
        )
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case status
        case decidedBy = "decided_by"
        case decidedAtMs = "decided_at_ms"
        case decisionReason = "decision_reason"
    }
}

private struct ApprovalPageDTO: Decodable {
    let approvals: [ApprovalDTO]
}

private struct ApprovalDTO: Decodable {
    let id: String
    let workspaceId: String
    let runId: String
    let channelId: String
    let requestMessageId: String?
    let requestedBy: String
    let onBehalfOf: String?
    let actionType: String
    let payload: JSON
    let status: String
    let estimatedMicroUSD: Int64?
    let isReversible: Bool?
    let decidedBy: String?
    let decidedAtMs: Int64?
    let decisionReason: String?
    let expiresAtMs: Int64?

    var approval: Approval {
        Approval(
            id: ApprovalID(uuidString: id) ?? ApprovalID(),
            workspaceId: WorkspaceID(uuidString: workspaceId) ?? .demo,
            runId: RunID(uuidString: runId) ?? RunID(),
            channelId: ChannelID(uuidString: channelId) ?? .demoGeneral,
            requestMessageId: requestMessageId.flatMap { MessageID(uuidString: $0) },
            requestedBy: MemberID(uuidString: requestedBy) ?? .demoAgent,
            onBehalfOf: onBehalfOf.flatMap { MemberID(uuidString: $0) },
            actionType: actionType,
            payload: payload,
            status: ApprovalStatus(rawValue: status) ?? .pending,
            estimatedMicroUSD: estimatedMicroUSD,
            isReversible: isReversible,
            decidedBy: decidedBy.flatMap { MemberID(uuidString: $0) },
            decidedAtMs: decidedAtMs,
            decisionReason: decisionReason,
            expiresAtMs: expiresAtMs
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case runId = "run_id"
        case channelId = "channel_id"
        case requestMessageId = "request_message_id"
        case requestedBy = "requested_by"
        case onBehalfOf = "on_behalf_of"
        case actionType = "action_type"
        case payload
        case status
        case estimatedMicroUSD = "estimated_micro_usd"
        case isReversible = "is_reversible"
        case decidedBy = "decided_by"
        case decidedAtMs = "decided_at_ms"
        case decisionReason = "decision_reason"
        case expiresAtMs = "expires_at_ms"
    }
}

private struct ProblemResponse: Decodable {
    let title: String?
    let detail: String?
    let message: String?
}

private extension JSON {
    var flatStringObject: [String: String]? {
        guard case .object(let values) = self else { return nil }
        let flattened = values.compactMapValues { value -> String? in
            switch value {
            case .string(let string):
                return string
            case .int(let int):
                return String(int)
            case .double(let double):
                return String(double)
            case .bool(let bool):
                return String(bool)
            case .null:
                return nil
            case .array, .object:
                return nil
            }
        }
        return flattened.isEmpty ? nil : flattened
    }
}
