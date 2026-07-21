import Foundation
import MomoCore
import SwiftCentrifuge

/// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
/// REST writes and Centrifugo reads for the iOS companion.
public actor MomoServerConversationClient: IOSConversationBackend {
    private let authenticated: IOSSession
    private let urlSession: URLSession
    private let decoder = JSONDecoder()
    private let realtimeDriver: (any RealtimeSubscriptionDriver)?
    private var lastKnownSequenceByChannel: [ChannelID: Int64] = [:]

    public init(authenticated: IOSSession, urlSession: URLSession = .shared) {
        self.authenticated = authenticated
        self.urlSession = urlSession
        if let endpoint = authenticated.realtimeWebSocketURL {
            let tokenProvider = IOSRealtimeTokenProvider(
                baseURL: authenticated.baseURL,
                accessToken: authenticated.accessToken,
                urlSession: urlSession
            )
            let transport = IOSCentrifugoTransport(
                endpoint: endpoint,
                workspace: authenticated.workspaceID,
                tokenProvider: tokenProvider
            )
            self.realtimeDriver = DefaultRealtimeSubscriptionDriver(transport: transport)
        } else {
            self.realtimeDriver = nil
        }
    }

    public func snapshot() async throws -> IOSConversationSnapshot {
        let workspacePath = "/v1/workspaces/\(authenticated.workspaceID.description)"
        async let channelsData = get(workspacePath + "/channels")
        async let membersData = get(workspacePath + "/roster")
        async let readStatesData = get(workspacePath + "/read-state")
        do {
            let channelDTOs = try decoder.decode(IOSChannelsResponse.self, from: try await channelsData).channels
            let channels = try channelDTOs.map { try $0.value() }
            let memberDTOs = try decoder.decode(IOSRosterResponse.self, from: try await membersData).members
            let members = try memberDTOs.map { try $0.value() }
            let states = try decoder.decode(IOSReadStateResponse.self, from: try await readStatesData).readStates
            let muteStates = try Dictionary(uniqueKeysWithValues: channelDTOs.map { dto in
                (try dto.channelID(), dto.muted)
            })
            let presencePairs: [(MemberID, Presence)] = try memberDTOs.compactMap { dto in
                guard let presence = dto.presence.flatMap(Presence.init(rawValue:)) else { return nil }
                return (try dto.memberID(), presence)
            }
            let presenceStates = Dictionary(uniqueKeysWithValues: presencePairs)
            return IOSConversationSnapshot(
                channels: channels,
                members: members,
                readStates: states,
                channelMuteStates: muteStates,
                memberPresenceStates: presenceStates
            )
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned channel data this app could not read.")
        }
    }

    public func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] {
        var components = URLComponents(
            url: authenticated.baseURL.appendingPathComponent(
                "/v1/workspaces/\(authenticated.workspaceID.description)/channels/\(channel.description)/messages"
            ),
            resolvingAgainstBaseURL: false
        )
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let sequence { query.append(URLQueryItem(name: "after", value: String(sequence))) }
        components?.queryItems = query
        guard let url = components?.url else {
            throw SessionError.decoding("Could not create the message history request.")
        }
        do {
            let data = try await execute(url: url)
            let messages = try decoder.decode(IOSMessagePage.self, from: data)
                .messages.map { try $0.value() }
                .sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
            if let latest = messages.compactMap(\.seq).max() {
                lastKnownSequenceByChannel[channel] = max(lastKnownSequenceByChannel[channel] ?? 0, latest)
            }
            return messages
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned message history this app could not read.")
        }
    }

    public func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/channels/\(channel.description)/read-state"
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "PUT"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(IOSMarkReadRequest(lastReadSequence: sequence))
        do {
            return try decoder.decode(ChannelReadState.self, from: try await execute(request: request))
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned an invalid read state.")
        }
    }

    public func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/channels/\(channel.description)/notification-pref"
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "PUT"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(IOSUpdateNotificationPreferenceRequest(muted: muted))
        do {
            let response = try decoder.decode(
                IOSNotificationPreferenceResponse.self,
                from: try await execute(request: request)
            )
            guard response.muted == muted else {
                throw SessionError.decoding("The server returned a different channel notification setting.")
            }
            return response.muted
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned an invalid channel notification setting.")
        }
    }

    public func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        guard let realtimeDriver else {
            return AsyncStream { $0.finish() }
        }
        return try await realtimeDriver.subscribe(
            channel: channel,
            startingAfter: lastKnownSequenceByChannel[channel] ?? 0,
            backfill: { [weak self] after, limit in
                guard let self else { return [] }
                return try await self.history(channel: channel, after: after, limit: limit)
            }
        )
    }

    public func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        guard let provider = realtimeDriver as? any RealtimeStatusProvidingDriver else {
            return AsyncStream { continuation in
                continuation.yield(.restFallback(channel: channel))
                continuation.finish()
            }
        }
        return await provider.realtimeStatus(channel: channel)
    }

    /// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
    /// Uses the existing REST-only single write path with client_msg_id idempotency.
    public func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/channels/\(draft.channelId.description)/messages"
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(IOSSendMessageRequest(
            clientMsgId: clientMsgId,
            type: draft.type.rawValue,
            body: draft.body,
            props: draft.props.objectValue?.compactMapValues(\.stringValue),
            runId: nil
        ))
        do {
            var message = try decoder.decode(IOSMessageDTO.self, from: try await execute(request: request)).value()
            message.clientMsgId = clientMsgId
            message.replyToId = draft.replyToId
            return message
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned a sent message this app could not read.")
        }
    }

    public func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/channels/\(channel.description)/reactions"
        do {
            let raw = try decoder.decode([String: [String: [String]]].self, from: try await get(path))
            var snapshot: [MessageID: [String: Set<MemberID>]] = [:]
            for (rawMessageID, reactions) in raw {
                guard let messageID = MessageID(uuidString: rawMessageID) else {
                    throw SessionError.decoding("The server returned an invalid reaction message identity.")
                }
                var decoded: [String: Set<MemberID>] = [:]
                for (emoji, rawMemberIDs) in reactions {
                    guard !emoji.isEmpty else {
                        throw SessionError.decoding("The server returned an invalid reaction emoji.")
                    }
                    let memberIDs = try rawMemberIDs.map { rawMemberID in
                        guard let memberID = MemberID(uuidString: rawMemberID) else {
                            throw SessionError.decoding("The server returned an invalid reaction member identity.")
                        }
                        return memberID
                    }
                    decoded[emoji] = Set(memberIDs)
                }
                snapshot[messageID] = decoded
            }
            return snapshot
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned reactions this app could not read.")
        }
    }

    public func addReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta {
        try await mutateReaction(id, emoji: emoji, method: "PUT", expectedAction: .added)
    }

    public func removeReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta {
        try await mutateReaction(id, emoji: emoji, method: "DELETE", expectedAction: .removed)
    }

    public func editMessage(_ id: MessageID, body: String) async throws -> Message {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/messages/\(id.description)"
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(IOSEditMessageRequest(body: body))
        return try decoder.decode(IOSMessageDTO.self, from: try await execute(request: request)).value()
    }

    public func deleteMessage(_ id: MessageID) async throws -> Message {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/messages/\(id.description)"
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        return try decoder.decode(IOSMessageDTO.self, from: try await execute(request: request)).value()
    }

    /// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
    /// Retries preserve ApprovalDecisionRequest.clientDecisionId.
    public func decideApproval(_ decision: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        let path = "/v1/workspaces/\(authenticated.workspaceID.description)/approvals/\(decision.approvalId.description)/decision"
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(decision)
        do {
            return try decoder.decode(IOSApprovalDecisionReceiptDTO.self, from: try await execute(request: request)).value()
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned an approval decision this app could not read.")
        }
    }

    private func get(_ path: String) async throws -> Data {
        try await execute(url: authenticated.baseURL.appendingPathComponent(path))
    }

    private func execute(url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        return try await execute(request: request)
    }

    private func execute(request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw SessionError.transport("The server did not return an HTTP response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let problem = try? decoder.decode(IOSProblemResponse.self, from: data)
                let message = problem?.detail ?? problem?.message ?? problem?.title
                    ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                throw SessionError.server(status: http.statusCode, message: message)
            }
            return data
        } catch let error as SessionError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SessionError.transport("Could not reach the momo server. Check your connection and try again.")
        }
    }

    private func mutateReaction(
        _ id: MessageID,
        emoji: String,
        method: String,
        expectedAction: ReactionDelta.Action
    ) async throws -> ReactionDelta {
        let collectionPath = "/v1/workspaces/\(authenticated.workspaceID.description)/messages/\(id.description)/reactions"
        let collectionURL = authenticated.baseURL.appendingPathComponent(collectionPath)
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        guard !emoji.isEmpty,
              let encodedEmoji = emoji.addingPercentEncoding(withAllowedCharacters: unreserved),
              var components = URLComponents(url: collectionURL, resolvingAgainstBaseURL: false)
        else { throw SessionError.decoding("Could not create the message reaction request.") }
        components.percentEncodedPath += "/\(encodedEmoji)"
        guard let url = components.url else {
            throw SessionError.decoding("Could not create the message reaction request.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        let delta = try decoder.decode(
            IOSReactionDeltaDTO.self,
            from: try await execute(request: request)
        ).value()
        guard delta.action == expectedAction, delta.messageId == id, delta.emoji == emoji else {
            throw SessionError.decoding("The server returned a different message reaction.")
        }
        return delta
    }
}

private protocol IOSRealtimeConnectionTokenProvider: Sendable {
    func token() async throws -> String
}

private actor IOSRealtimeTokenProvider: IOSRealtimeConnectionTokenProvider {
    private let baseURL: URL
    private let accessToken: String
    private let urlSession: URLSession

    init(baseURL: URL, accessToken: String, urlSession: URLSession) {
        self.baseURL = baseURL
        self.accessToken = accessToken
        self.urlSession = urlSession
    }

    func token() async throws -> String {
        var request = URLRequest(url: baseURL.appendingPathComponent("/v1/auth/realtime-token"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SessionError.transport("Could not connect to realtime updates.")
        }
        return try JSONDecoder().decode(IOSRealtimeTokenResponse.self, from: data).token
    }
}

private final class IOSCentrifugoTransport: RealtimeStatusReportingEnvelopeSubscriptionTransport {
    private let endpoint: URL
    private let workspace: WorkspaceID
    private let tokenProvider: any IOSRealtimeConnectionTokenProvider

    init(endpoint: URL, workspace: WorkspaceID, tokenProvider: any IOSRealtimeConnectionTokenProvider) {
        self.endpoint = endpoint
        self.workspace = workspace
        self.tokenProvider = tokenProvider
    }

    func envelopes(channel: ChannelID) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        try await envelopes(channel: channel) { _ in }
    }

    func envelopes(
        channel: ChannelID,
        statusHandler: @escaping RealtimeStatusHandler
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        let tokenProvider = tokenProvider
        let endpoint = endpoint.absoluteString
        let channelName = "ch:ws\(workspace.description).\(channel.description)"
        return AsyncThrowingStream { continuation in
            let delegate = IOSCentrifugoDelegate(
                channelID: channel,
                continuation: continuation,
                statusHandler: statusHandler
            )
            let config = CentrifugeClientConfig(
                name: "momo-ios",
                tokenGetter: { _, completion in
                    let completion = IOSRealtimeTokenCompletion(completion)
                    Task {
                        do { completion.succeed(try await tokenProvider.token()) }
                        catch { completion.fail(error) }
                    }
                }
            )
            let client = CentrifugeClient(endpoint: endpoint, config: config, delegate: delegate)
            do {
                let subscription = try client.newSubscription(channel: channelName, delegate: delegate)
                let lifetime = IOSCentrifugoLifetime(client: client, subscription: subscription, delegate: delegate)
                delegate.lifetime = lifetime
                continuation.onTermination = { _ in lifetime.close() }
                statusHandler(RealtimeConnectionStatus(
                    channelId: channel,
                    connection: .connecting,
                    subscription: .subscribing,
                    message: "Connecting to realtime."
                ))
                client.connect()
                subscription.subscribe()
            } catch {
                statusHandler(.restFallback(channel: channel, message: "Realtime updates are unavailable."))
                continuation.finish(throwing: error)
            }
        }
    }
}

private final class IOSCentrifugoLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var client: CentrifugeClient?
    private var subscription: CentrifugeSubscription?
    private var delegate: IOSCentrifugoDelegate?

    init(client: CentrifugeClient, subscription: CentrifugeSubscription, delegate: IOSCentrifugoDelegate) {
        self.client = client
        self.subscription = subscription
        self.delegate = delegate
    }

    func close() {
        let retained = lock.withLock {
            let retained = (client, subscription, delegate)
            client = nil
            subscription = nil
            delegate = nil
            return retained
        }
        retained.1?.unsubscribe()
        retained.0?.disconnect()
    }
}

private struct IOSRealtimeTokenCompletion: @unchecked Sendable {
    private let completion: (Result<String, Error>) -> Void

    init(_ completion: @escaping (Result<String, Error>) -> Void) { self.completion = completion }
    func succeed(_ token: String) { completion(.success(token)) }
    func fail(_ error: Error) { completion(.failure(error)) }
}

private final class IOSCentrifugoDelegate: CentrifugeClientDelegate, CentrifugeSubscriptionDelegate, @unchecked Sendable {
    let channelID: ChannelID
    weak var lifetime: IOSCentrifugoLifetime?
    private let continuation: AsyncThrowingStream<RealtimeEnvelope, Error>.Continuation
    private let statusHandler: RealtimeStatusHandler

    init(
        channelID: ChannelID,
        continuation: AsyncThrowingStream<RealtimeEnvelope, Error>.Continuation,
        statusHandler: @escaping RealtimeStatusHandler
    ) {
        self.channelID = channelID
        self.continuation = continuation
        self.statusHandler = statusHandler
    }

    func onConnected(_ client: CentrifugeClient, _ event: CentrifugeConnectedEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelID,
            connection: .connected,
            subscription: .subscribing,
            message: "Realtime connection established."
        ))
    }

    func onConnecting(_ client: CentrifugeClient, _ event: CentrifugeConnectingEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelID,
            connection: .reconnecting,
            subscription: .recovering,
            fallback: .restHistory,
            message: event.reason
        ))
    }

    func onDisconnected(_ client: CentrifugeClient, _ event: CentrifugeDisconnectedEvent) {
        statusHandler(.restFallback(channel: channelID, message: event.reason))
    }

    func onSubscribed(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscribedEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelID,
            connection: .connected,
            subscription: .subscribed,
            message: event.recovered ? "Realtime recovered missed messages." : "Realtime subscribed."
        ))
    }

    func onSubscribing(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscribingEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelID,
            connection: .connected,
            subscription: .recovering,
            fallback: .restHistory,
            message: event.reason
        ))
    }

    func onPublication(_ sub: CentrifugeSubscription, _ event: CentrifugePublicationEvent) {
        do { continuation.yield(try JSONDecoder.momo.decode(RealtimeEnvelope.self, from: event.data)) }
        catch {
            continuation.finish(throwing: error)
            lifetime?.close()
        }
    }

    func onUnsubscribed(_ sub: CentrifugeSubscription, _ event: CentrifugeUnsubscribedEvent) {
        statusHandler(.restFallback(channel: channelID, message: event.reason))
        continuation.finish()
        lifetime?.close()
    }

    func onError(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscriptionErrorEvent) {
        statusHandler(.restFallback(channel: channelID, message: String(describing: event.error)))
        continuation.finish(throwing: event.error)
        lifetime?.close()
    }

    func onError(_ client: CentrifugeClient, _ event: CentrifugeErrorEvent) {
        statusHandler(.restFallback(channel: channelID, message: String(describing: event.error)))
        continuation.finish(throwing: event.error)
        lifetime?.close()
    }
}

private struct IOSRealtimeTokenResponse: Decodable { let token: String }
private struct IOSSendMessageRequest: Encodable {
    let clientMsgId: UUID
    let type: String
    let body: String?
    let props: [String: String]?
    let runId: UUID?

    private enum CodingKeys: String, CodingKey {
        case clientMsgId = "client_msg_id"
        case type
        case body
        case props
        case runId = "run_id"
    }
}
private struct IOSEditMessageRequest: Encodable { let body: String }
struct IOSReactionDeltaDTO: Decodable {
    let action: String
    let messageId: String
    let memberId: String
    let emoji: String

    func value() throws -> ReactionDelta {
        guard let action = ReactionDelta.Action(rawValue: action),
              let messageID = MessageID(uuidString: messageId),
              let memberID = MemberID(uuidString: memberId),
              !emoji.isEmpty
        else {
            throw SessionError.decoding("The server returned an invalid message reaction.")
        }
        return ReactionDelta(action: action, messageId: messageID, memberId: memberID, emoji: emoji)
    }
}
private struct IOSApprovalDecisionReceiptDTO: Decodable {
    let approvalId: String
    let status: String
    let decidedBy: String?
    let decidedAtMs: Int64?
    let decisionReason: String?

    func value() throws -> ApprovalDecisionReceipt {
        guard let approvalID = ApprovalID(uuidString: approvalId),
              let status = ApprovalStatus(rawValue: status) else {
            throw SessionError.decoding("The server returned an invalid approval decision.")
        }
        return ApprovalDecisionReceipt(
            approvalId: approvalID,
            status: status,
            decidedBy: decidedBy.flatMap(MemberID.init(uuidString:)),
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
private struct IOSMarkReadRequest: Encodable {
    let lastReadSequence: Int64
    private enum CodingKeys: String, CodingKey { case lastReadSequence = "last_read_seq" }
}
private struct IOSUpdateNotificationPreferenceRequest: Encodable { let muted: Bool }
private struct IOSNotificationPreferenceResponse: Decodable { let muted: Bool }
private struct IOSProblemResponse: Decodable { let title: String?; let detail: String?; let message: String? }
private struct IOSReadStateResponse: Decodable {
    let readStates: [ChannelReadState]
    private enum CodingKeys: String, CodingKey { case readStates = "read_states" }
}
private struct IOSChannelsResponse: Decodable { let channels: [IOSChannelDTO] }
private struct IOSRosterResponse: Decodable { let members: [IOSMemberDTO] }
private struct IOSMessagePage: Decodable { let messages: [IOSMessageDTO] }

private struct IOSChannelDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let name: String?
    let topic: String?
    let dmKey: String?
    let memberIds: [String]?
    let createdBy: String?
    let archivedAtMs: Int64?
    let muted: Bool

    func channelID() throws -> ChannelID {
        guard let id = ChannelID(uuidString: id) else {
            throw SessionError.decoding("The server returned an invalid channel identity.")
        }
        return id
    }

    func value() throws -> Channel {
        guard let workspaceID = WorkspaceID(uuidString: workspaceId),
              let kind = ChannelKind(rawValue: kind) else {
            throw SessionError.decoding("The server returned an invalid channel.")
        }
        return Channel(
            id: try channelID(),
            workspaceId: workspaceID,
            kind: kind,
            name: name,
            topic: topic,
            dmKey: dmKey,
            dmMemberIds: (memberIds ?? []).compactMap { MemberID(uuidString: $0) },
            createdBy: createdBy.flatMap { MemberID(uuidString: $0) },
            archivedAtMs: archivedAtMs
        )
    }
}

private struct IOSMemberDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let status: String?
    let displayName: String
    let handle: String
    let avatarUrl: String?
    let role: String?
    let channelIds: [String]?
    let capabilities: [String]?
    let presence: String?

    func memberID() throws -> MemberID {
        guard let id = MemberID(uuidString: id) else {
            throw SessionError.decoding("The server returned an invalid member identity.")
        }
        return id
    }

    func value() throws -> Member {
        guard let workspaceID = WorkspaceID(uuidString: workspaceId) else {
            throw SessionError.decoding("The server returned an invalid member.")
        }
        return Member(
            id: try memberID(),
            workspaceId: workspaceID,
            kind: MemberKind(rawValue: kind) ?? .human,
            status: status.flatMap(MemberStatus.init(rawValue:)) ?? .active,
            displayName: displayName,
            handle: handle,
            avatarURL: avatarUrl.flatMap(URL.init(string:)),
            workspaceRole: role.flatMap(MembershipRole.init(rawValue:)),
            channelIds: (channelIds ?? []).compactMap { ChannelID(uuidString: $0) },
            capabilities: capabilities ?? [],
            presence: presence.flatMap(Presence.init(rawValue:)) ?? .offline
        )
    }
}

struct IOSMessageDTO: Decodable {
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
    let thread: ThreadRollup?
    let state: String?
    let editedAtMs: Int64?
    let deletedAtMs: Int64?

    func value() throws -> Message {
        guard let id = MessageID(uuidString: id),
              let channelID = ChannelID(uuidString: channelId),
              let authorID = MemberID(uuidString: authorMemberId) else {
            throw SessionError.decoding("The server returned an invalid message identity.")
        }
        let decodedState: MessageState
        if let state {
            guard let messageState = MessageState(rawValue: state) else {
                throw SessionError.decoding("The server returned an invalid message state.")
            }
            decodedState = messageState
        } else {
            decodedState = .sent
        }
        return Message(
            id: id,
            channelId: channelID,
            seq: seq,
            hlcTs: hlcTs,
            hlcCount: hlcCount,
            authorMemberId: authorID,
            type: MessageType(rawValue: type) ?? .text,
            state: decodedState,
            body: body,
            props: props ?? .object([:]),
            thread: thread,
            runId: runId.flatMap { RunID(uuidString: $0) },
            clientMsgId: clientMsgId,
            createdAtMs: createdAtMs,
            editedAtMs: editedAtMs,
            deletedAtMs: deletedAtMs
        )
    }
}
