import Foundation
import MomoCore

// MARK: - MomoServer REST ChatBackend

/// REST-backed v0 `ChatBackend` for the SwiftPM macOS development app.
///
/// Scope is intentionally narrow: auth/login, history, and send use MomoServer
/// REST. Realtime can be composed with a `RealtimeSubscriptionDriver`, while the
/// default remains an empty stream until a real SwiftCentrifuge adapter is wired.
public actor MomoServerRESTChatBackend: ChatBackend, AgentTransport {
    public let config: MomoServerRESTChatBackendConfig

    private let session: URLSession
    private let realtimeDriver: (any RealtimeSubscriptionDriver)?
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var workspace: WorkspaceID?
    private var accessToken: String?
    private var authenticatedMember: Member?
    private var cachedChannels: [Channel]?
    private var lastKnownSeqByChannel: [ChannelID: Int64] = [:]

    public init(
        config: MomoServerRESTChatBackendConfig,
        session: URLSession = .shared,
        realtimeDriver: (any RealtimeSubscriptionDriver)? = nil
    ) {
        self.config = config
        self.session = session
        self.realtimeDriver = realtimeDriver
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        self.decoder.keyDecodingStrategy = .useDefaultKeys
    }

    public func connect(workspace: WorkspaceID, accessToken: String) async throws {
        self.workspace = workspace
        if !accessToken.isEmpty {
            self.accessToken = accessToken
            return
        }
        if let configured = config.accessToken, !configured.isEmpty {
            self.accessToken = configured
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
        self.authenticatedMember = login.member.member
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
        guard let realtimeDriver else {
            return AsyncStream { continuation in
                continuation.finish()
            }
        }

        let startingSeq = lastKnownSeqByChannel[channel] ?? 0
        return try await realtimeDriver.subscribe(
            channel: channel,
            startingAfter: startingSeq,
            backfill: { [weak self] after, limit in
                guard let self else { return [] }
                return try await self.history(channel: channel, after: after, limit: limit)
            }
        )
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
        config.members.map {
            PresenceEntry(memberId: $0.id, channelId: channel, presence: $0.presence)
        }
    }

    public func members(workspace: WorkspaceID) async throws -> [Member] {
        var all = config.members
        if let authenticatedMember, !all.contains(where: { $0.id == authenticatedMember.id }) {
            all.insert(authenticatedMember, at: 0)
        }
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
        AsyncStream { continuation in continuation.finish() }
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
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
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
}

// MARK: - Configuration

public struct MomoServerRESTChatBackendConfig: Sendable, Hashable {
    public var baseURL: URL
    public var accessToken: String?
    public var login: Login
    public var workspace: WorkspaceID
    public var channels: [Channel]
    public var members: [Member]
    public var defaultChannel: ChannelID

    public init(
        baseURL: URL,
        accessToken: String? = nil,
        login: Login = .demo,
        workspace: WorkspaceID = .demo,
        channels: [Channel]? = nil,
        members: [Member]? = nil,
        defaultChannel: ChannelID = .demoGeneral
    ) {
        self.baseURL = baseURL
        self.accessToken = accessToken
        self.login = login
        self.workspace = workspace
        self.channels = channels ?? Self.demoChannels(workspace: workspace)
        self.members = members ?? Self.demoMembers(workspace: workspace)
        self.defaultChannel = defaultChannel
    }

    public struct Login: Sendable, Hashable {
        public var email: String
        public var password: String

        public init(email: String, password: String) {
            self.email = email
            self.password = password
        }

        public static let demo = Login(email: "demo@momo.local", password: "demo")
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
        let login = Login(
            email: environment["MOMO_LOGIN_EMAIL"] ?? Login.demo.email,
            password: environment["MOMO_LOGIN_PASSWORD"] ?? Login.demo.password
        )
        let channels = Self.demoChannels(workspace: workspace)
        return Self(
            baseURL: baseURL,
            accessToken: token,
            login: login,
            workspace: workspace,
            channels: channels,
            members: Self.demoMembers(workspace: workspace),
            defaultChannel: channels.contains(where: { $0.id == defaultChannel }) ? defaultChannel : channels[0].id
        )
    }

    public static func demoChannels(workspace: WorkspaceID = .demo) -> [Channel] {
        [
            Channel(
                id: .demoGeneral,
                workspaceId: workspace,
                kind: .publicChannel,
                name: "general",
                topic: "팀 일반 채널",
                createdBy: .demoHuman
            ),
            Channel(
                id: .demoAgentLab,
                workspaceId: workspace,
                kind: .publicChannel,
                name: "agent-lab",
                topic: "에이전트 실험실 - 김인턴 데모(D/B/C)",
                createdBy: .demoHuman
            ),
        ]
    }

    public static func demoMembers(workspace: WorkspaceID = .demo) -> [Member] {
        [
            Member(
                id: .demoHuman,
                workspaceId: workspace,
                kind: .human,
                displayName: "데모 사용자",
                handle: "demo",
                presence: .online
            ),
            Member(
                id: .demoAgent,
                workspaceId: workspace,
                kind: .agent,
                displayName: "김인턴",
                handle: "kim-intern",
                presence: .working
            ),
        ]
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
}

private struct MemberDTO: Decodable {
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

private struct MessageDTO: Decodable {
    let id: String
    let channelId: String
    let seq: Int64
    let hlcTs: Int64
    let hlcCount: Int32
    let authorMemberId: String
    let type: String
    let body: String?
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
            createdAtMs: createdAtMs
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
