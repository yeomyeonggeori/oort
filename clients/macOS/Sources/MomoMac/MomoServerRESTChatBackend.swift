import Foundation
import MomoCore
import UniformTypeIdentifiers

// MARK: - MomoServer REST ChatBackend

/// REST-backed v0 `ChatBackend` for the SwiftPM macOS development app.
///
/// Scope is intentionally narrow: auth/login, history, and send use MomoServer
/// REST. Realtime can be composed with a `RealtimeSubscriptionDriver`, while the
/// default remains an empty stream until a real SwiftCentrifuge adapter is wired.
public actor MomoServerRESTChatBackend: ChatBackend, WorkspaceBackend, AgentTransport, AgentWorkRunBackend, ReadStateBackend, AuthenticatedMemberIDProvidingBackend, WorkspaceIdentityCacheScopeProviding, MomoAgentCredentialBackend, RealtimeStatusProvidingBackend, AgentRuntimeStatusProviding, MomoSessionSensitiveStateClearing, ServerRosterSourceOfTruth, MomoWorkspaceMessageSearchBackend, MomoChannelNotificationBackend, MomoMessageInteractionBackend, MomoThreadRepliesBackend, MomoAttachmentTransferBackend, MomoWorkConsoleBackend, MomoWorkHostBackend, MemoryPlaneBackend, MomoMembershipAdministrationBackend {
    public let config: MomoServerRESTChatBackendConfig
    public private(set) var realtimeWebSocketURL: URL?

    private let session: URLSession
    private let directUploadSession: URLSession
    private var realtimeDriver: (any RealtimeSubscriptionDriver)?
    private var hasExplicitRealtimeDriver: Bool
    private var agentRealtimeTransport: (any AgentRealtimeEnvelopeSubscriptionTransport)?
    private var readStateRealtimeTransport: (any ReadStateRealtimeEnvelopeSubscriptionTransport)?
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var workspace: WorkspaceID?
    private var accessToken: String?
    private var authenticatedMember: Member?
    private var connectionGeneration: UInt64 = 0
    private var cachedChannels: [Channel]?
    private var cachedChannelMuteStates: [ChannelID: Bool] = [:]
    private var cachedMembers: [Member]?
    private var lastKnownSeqByChannel: [ChannelID: Int64] = [:]
    private var realtimeStatusByChannel: [ChannelID: RealtimeConnectionStatus] = [:]
    private var realtimeStatusStreams: [ChannelID: [UUID: AsyncStream<RealtimeConnectionStatus>.Continuation]] = [:]

    public init(
        config: MomoServerRESTChatBackendConfig,
        session: URLSession = .shared,
        directUploadSession: URLSession? = nil,
        realtimeDriver: (any RealtimeSubscriptionDriver)? = nil
    ) {
        self.config = config
        self.realtimeWebSocketURL = config.centrifugoWebSocketURL
        self.session = session
        self.directUploadSession = directUploadSession ?? Self.makeDirectUploadSession()
        self.realtimeDriver = realtimeDriver
        self.hasExplicitRealtimeDriver = realtimeDriver != nil
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        self.decoder.keyDecodingStrategy = .useDefaultKeys
    }

    private static func makeDirectUploadSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }

    public func connect(workspace: WorkspaceID, accessToken: String) async throws {
        connectionGeneration &+= 1
        let generation = connectionGeneration
        resetSessionState(workspace: workspace)
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
        guard connectionGeneration == generation, self.workspace == workspace else {
            throw CancellationError()
        }
        let member = try login.member.member()
        guard connectionGeneration == generation, self.workspace == workspace else {
            throw CancellationError()
        }
        self.accessToken = login.accessToken
        self.authenticatedMember = member
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

    public func setReadStateRealtimeTransport(
        _ transport: (any ReadStateRealtimeEnvelopeSubscriptionTransport)?
    ) {
        readStateRealtimeTransport = transport
    }

    public func requireAccessToken() throws -> String {
        guard let accessToken, !accessToken.isEmpty else { throw BackendError.notConnected }
        return accessToken
    }

    func authenticatedMemberID() async -> MemberID? {
        authenticatedMember?.id ?? accessToken.flatMap(Self.memberIDFromJWT)
    }

    func workspaceIdentityCacheServerScope() async -> String {
        config.baseURL.absoluteString
    }

    public func clearSessionSensitiveState() async {
        connectionGeneration &+= 1
        resetSessionState(workspace: nil)
    }

    private func resetSessionState(workspace: WorkspaceID?) {
        self.workspace = workspace
        accessToken = nil
        authenticatedMember = nil
        cachedChannels = nil
        cachedChannelMuteStates = [:]
        cachedMembers = nil
        lastKnownSeqByChannel = [:]
        readStateRealtimeTransport = nil
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
            runId: nil,
            rootId: draft.rootId,
            attachmentIds: draft.attachmentIds
        )
        let response = try await post(
            "/v1/workspaces/\(workspace.description)/channels/\(draft.channelId.description)/messages",
            body: request,
            authorized: true,
            response: MessageDTO.self
        )
        var message = try response.message()
        guard message.rootId == draft.rootId else {
            throw BackendError.decoding("message response thread root mismatch")
        }
        message.clientMsgId = clientMsgId
        message.props = draft.props
        return message
    }

    // MARK: Attachment transfer

    func uploadAttachment(fileURL: URL, to channel: ChannelID) async throws -> MessageAttachment {
        let context = try requireSessionContext()
        let didAccess = fileURL.startAccessingSecurityScopedResource()
        defer {
            if didAccess { fileURL.stopAccessingSecurityScopedResource() }
        }

        let values: URLResourceValues
        do {
            values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        } catch {
            throw MomoAttachmentTransferIssue.invalidFile
        }
        guard fileURL.isFileURL,
              values.isRegularFile == true,
              let fileSize = values.fileSize,
              fileSize >= 0 else {
            throw MomoAttachmentTransferIssue.invalidFile
        }
        guard Int64(fileSize) <= MomoAttachmentFileBoundary.maximumSizeBytes else {
            throw MomoAttachmentTransferIssue.fileTooLarge
        }

        let name = MomoAttachmentFileBoundary.sanitizedFileName(fileURL.lastPathComponent)
        let mime = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        let createPath = "/v1/workspaces/\(context.workspace.description)/channels/\(channel.description)/attachments/uploads"
        let created = try await post(
            createPath,
            body: CreateAttachmentUploadRequestDTO(
                name: name,
                mime: mime,
                size: Int64(fileSize)
            ),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: AttachmentUploadResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard created.status == "pending",
              let attachmentID = FileID(uuidString: created.id),
              let capabilityURL = URL(string: created.uploadUrl),
              isAllowedUploadCapabilityURL(capabilityURL) else {
            throw BackendError.decoding("invalid attachment upload response")
        }

        var uploadRequest = URLRequest(
            url: capabilityURL,
            cachePolicy: .reloadIgnoringLocalCacheData
        )
        uploadRequest.httpMethod = "PUT"
        uploadRequest.setValue(mime, forHTTPHeaderField: "Content-Type")
        uploadRequest.setValue(String(fileSize), forHTTPHeaderField: "Content-Length")
        do {
            let (_, response) = try await directUploadSession.upload(
                for: uploadRequest,
                fromFile: fileURL
            )
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 502
                throw BackendError.problem(
                    status: status,
                    title: "attachment upload failed",
                    detail: nil
                )
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as BackendError {
            throw error
        } catch {
            // Capability URLs are secrets. Never include the underlying request
            // description or localized URLSession error in surfaced diagnostics.
            throw BackendError.realtime("Attachment upload failed.")
        }
        try ensureSessionCurrent(context)

        let completed = try await postEmpty(
            "/v1/workspaces/\(context.workspace.description)/channels/\(channel.description)/attachments/\(attachmentID.description)/complete",
            authorized: true,
            response: AttachmentResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard completed.status == "complete",
              completed.id.lowercased() == attachmentID.description.lowercased(),
              completed.channelId.lowercased() == channel.description.lowercased(),
              completed.name == name,
              completed.mime == mime,
              completed.size == Int64(fileSize) else {
            throw BackendError.decoding("attachment completion response mismatch")
        }
        return MessageAttachment(id: attachmentID, name: name, mime: mime, sizeBytes: Int64(fileSize))
    }

    func downloadAttachment(
        _ attachment: MessageAttachment,
        from channel: ChannelID,
        to destinationURL: URL
    ) async throws {
        let context = try requireSessionContext()
        let path = "/v1/workspaces/\(context.workspace.description)/channels/\(channel.description)/attachments/\(attachment.id.description)/content"
        var request = URLRequest(
            url: config.baseURL.appendingPathComponent(path),
            cachePolicy: .reloadIgnoringLocalCacheData
        )
        request.httpMethod = "GET"
        try authorize(&request)

        let temporaryURL: URL
        let response: URLResponse
        do {
            (temporaryURL, response) = try await session.download(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw BackendError.realtime("Attachment download failed.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw BackendError.realtime("Attachment download returned a non-HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let data = (try? Data(contentsOf: temporaryURL, options: .mappedIfSafe)) ?? Data()
            throw problemError(status: http.statusCode, data: data)
        }
        try ensureSessionCurrent(context)

        let downloadedSize = try temporaryURL.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let downloadedSize,
              Int64(downloadedSize) == attachment.sizeBytes,
              Int64(downloadedSize) <= MomoAttachmentFileBoundary.maximumSizeBytes else {
            throw BackendError.decoding("attachment download size mismatch")
        }
        do {
            try FileManager.default.copyItem(at: temporaryURL, to: destinationURL)
        } catch {
            throw MomoAttachmentTransferIssue.unavailable
        }
    }

    private func isAllowedUploadCapabilityURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), url.host != nil else { return false }
        if scheme == "https" { return true }
        guard scheme == config.baseURL.scheme?.lowercased(),
              url.host?.lowercased() == config.baseURL.host?.lowercased(),
              url.port == config.baseURL.port else {
            return false
        }
        return scheme == "http"
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
        let messages = try page.messages.map { try $0.message() }
            .sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        rememberLastKnownSeq(messages, channel: channel)
        return messages
    }

    func threadReplies(
        channel: ChannelID,
        root: MessageID,
        cursor: Int64?,
        limit: Int
    ) async throws -> MomoThreadRepliesPage {
        guard let workspace else { throw BackendError.notConnected }
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor {
            items.append(URLQueryItem(name: "cursor", value: String(cursor)))
        }

        let page = try await get(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages/\(root.description)/replies",
            queryItems: items,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: ThreadRepliesPageDTO.self
        )
        let messages = try page.messages.map { try $0.message() }
            .sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        guard messages.allSatisfy({ $0.channelId == channel && $0.rootId == root }) else {
            throw BackendError.decoding("thread replies escaped the requested root")
        }
        rememberLastKnownSeq(messages, channel: channel)
        return MomoThreadRepliesPage(messages: messages, nextCursor: page.nextCursor)
    }

    public func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        (cachedMembers ?? []).filter {
            $0.status == .active && $0.channelIds.contains(channel)
        }.map {
            PresenceEntry(memberId: $0.id, channelId: channel, presence: $0.presence)
        }
    }

    public func members(workspace: WorkspaceID) async throws -> [Member] {
        guard let sessionWorkspace = self.workspace,
              sessionWorkspace == workspace,
              accessToken != nil
        else {
            throw BackendError.notConnected
        }
        let generation = connectionGeneration
        let response = try await get(
            "/v1/workspaces/\(workspace.description)/roster",
            queryItems: [],
            response: WorkspaceRosterResponse.self
        )
        var all = try response.members.map { try $0.member() }
        guard connectionGeneration == generation, self.workspace == sessionWorkspace else {
            throw CancellationError()
        }
        if let authenticatedMember, !all.contains(where: { $0.id == authenticatedMember.id }) {
            all.insert(authenticatedMember, at: 0)
        }
        cachedMembers = all
        return all
    }

    public func changeWorkspaceRole(member: MemberID, role: MembershipRole) async throws {
        guard let workspace else { throw BackendError.notConnected }
        _ = try await patch(
            "/v1/workspaces/\(workspace.description)/members/\(member.description)/role",
            body: MembershipRoleRequestDTO(role: role.rawValue),
            response: MembershipRoleResponseDTO.self
        )
        cachedMembers = nil
    }

    public func suspendWorkspaceMember(_ member: MemberID) async throws {
        try await changeWorkspaceMemberStatus(member, action: "suspend")
    }

    public func reinstateWorkspaceMember(_ member: MemberID) async throws {
        try await changeWorkspaceMemberStatus(member, action: "reinstate")
    }

    public func removeWorkspaceMember(_ member: MemberID, ban: Bool, reason: String?) async throws {
        guard let workspace else { throw BackendError.notConnected }
        _ = try await delete(
            "/v1/workspaces/\(workspace.description)/members/\(member.description)",
            body: RemoveWorkspaceMemberRequestDTO(ban: ban, reason: reason),
            response: MembershipLifecycleResponseDTO.self
        )
        cachedMembers = nil
    }

    public func leaveWorkspace() async throws {
        guard let workspace else { throw BackendError.notConnected }
        _ = try await delete(
            "/v1/workspaces/\(workspace.description)/members/me",
            authorized: true,
            response: MembershipLifecycleResponseDTO.self
        )
        await clearSessionSensitiveState()
    }

    public func leaveChannel(_ channel: ChannelID) async throws {
        guard let workspace else { throw BackendError.notConnected }
        _ = try await delete(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/members/me",
            authorized: true,
            response: ChannelLeaveResponseDTO.self
        )
        cachedChannels = nil
        cachedMembers = nil
    }

    public func workspaceAudit(
        cursor: UUID?,
        limit: Int,
        filter: MomoWorkspaceAuditFilter
    ) async throws -> MomoWorkspaceAuditPage {
        guard let workspace else { throw BackendError.notConnected }
        var query = [URLQueryItem(name: "limit", value: String(max(1, min(limit, 100))))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor.uuidString.lowercased())) }
        if !filter.actionPrefixes.isEmpty {
            query.append(URLQueryItem(name: "actions", value: filter.actionPrefixes.joined(separator: ",")))
        }
        if let target = filter.targetMember {
            query.append(URLQueryItem(name: "target_member_id", value: target.description.lowercased()))
        }
        if let fromMs = filter.fromMs {
            query.append(URLQueryItem(name: "from_ms", value: String(fromMs)))
        }
        if let toMs = filter.toMs {
            query.append(URLQueryItem(name: "to_ms", value: String(toMs)))
        }
        let page = try await get(
            "/v1/workspaces/\(workspace.description)/audit",
            queryItems: query,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: WorkspaceAuditPageDTO.self
        )
        return MomoWorkspaceAuditPage(
            events: page.events,
            nextCursor: page.nextCursor.flatMap(UUID.init(uuidString:))
        )
    }

    private func changeWorkspaceMemberStatus(_ member: MemberID, action: String) async throws {
        guard let workspace else { throw BackendError.notConnected }
        _ = try await postEmpty(
            "/v1/workspaces/\(workspace.description)/members/\(member.description)/\(action)",
            authorized: true,
            response: MembershipLifecycleResponseDTO.self
        )
        cachedMembers = nil
    }

    public func channels(workspace: WorkspaceID) async throws -> [Channel] {
        guard let sessionWorkspace = self.workspace,
              sessionWorkspace == workspace,
              accessToken != nil
        else {
            throw BackendError.notConnected
        }
        let generation = connectionGeneration
        let response = try await get(
            "/v1/workspaces/\(workspace.description)/channels",
            queryItems: [],
            response: WorkspaceChannelsResponse.self
        )
        let decodedChannels = try response.channels.map { dto in
            (channel: try dto.channel(), muted: dto.muted)
        }
        guard connectionGeneration == generation, self.workspace == sessionWorkspace else {
            throw CancellationError()
        }
        let channels = decodedChannels.map(\.channel)
        cachedChannels = channels
        cachedChannelMuteStates = Dictionary(
            uniqueKeysWithValues: decodedChannels.map { ($0.channel.id, $0.muted) }
        )
        return channels
    }

    func channelMuteSnapshot(workspace: WorkspaceID) async -> [ChannelID: Bool] {
        guard self.workspace == workspace, accessToken != nil else { return [:] }
        return cachedChannelMuteStates
    }

    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool {
        guard let sessionWorkspace = workspace,
              let sessionAccessToken = accessToken,
              !sessionAccessToken.isEmpty
        else {
            throw BackendError.notConnected
        }
        let generation = connectionGeneration
        let response = try await put(
            "/v1/workspaces/\(sessionWorkspace.description)/channels/\(channel.description)/notification-pref",
            body: UpdateNotificationPrefRequestDTO(muted: muted),
            response: NotificationPrefResponseDTO.self
        )
        guard connectionGeneration == generation,
              workspace == sessionWorkspace,
              accessToken == sessionAccessToken
        else {
            throw CancellationError()
        }
        guard response.muted == muted else {
            throw BackendError.decoding("channel notification preference response mismatch")
        }
        cachedChannelMuteStates[channel] = response.muted
        return response.muted
    }

    public func workspace(id: WorkspaceID) async throws -> Workspace {
        try await get(
            "/v1/workspaces/\(id.description)",
            queryItems: [],
            response: WorkspaceResponseDTO.self
        ).workspace.workspace
    }

    public func updateWorkspaceName(
        workspace: WorkspaceID,
        name: String,
        expectedUpdatedAtMs: Int64
    ) async throws -> Workspace {
        try await patch(
            "/v1/workspaces/\(workspace.description)",
            body: UpdateWorkspaceRequestDTO(
                name: name,
                expectedUpdatedAtMs: expectedUpdatedAtMs
            ),
            response: WorkspaceResponseDTO.self
        ).workspace.workspace
    }

    public func openDirectMessage(
        workspace: WorkspaceID,
        with member: MemberID
    ) async throws -> Channel {
        guard let sessionWorkspace = self.workspace,
              sessionWorkspace == workspace,
              let sessionAccessToken = accessToken,
              !sessionAccessToken.isEmpty
        else {
            throw BackendError.notConnected
        }
        let generation = connectionGeneration
        guard let currentMemberID = authenticatedMember?.id ?? Self.memberIDFromJWT(sessionAccessToken) else {
            throw BackendError.notConnected
        }
        guard member != currentMemberID else {
            throw BackendError.decoding("direct message target must differ from current member")
        }
        let responseData: Data
        do {
            responseData = try await postData(
                "/v1/workspaces/\(workspace.description)/dms",
                body: OpenDirectMessageRequestDTO(memberId: member.rawValue),
                authorized: true
            )
        } catch {
            guard connectionGeneration == generation,
                  self.workspace == sessionWorkspace,
                  accessToken == sessionAccessToken
            else {
                throw CancellationError()
            }
            throw error
        }
        guard connectionGeneration == generation,
              self.workspace == sessionWorkspace,
              accessToken == sessionAccessToken
        else {
            throw CancellationError()
        }
        let response: OpenDirectMessageResponseDTO
        do {
            response = try decoder.decode(OpenDirectMessageResponseDTO.self, from: responseData)
        } catch {
            throw BackendError.decoding(String(describing: error))
        }
        let participantIDs = try response.channel.directMessageParticipantIDs()
        let channel = try response.channel.channel()
        guard channel.workspaceId == sessionWorkspace,
              channel.kind == .dm,
              Set(participantIDs) == Set([currentMemberID, member])
        else {
            throw BackendError.decoding("direct message response scope mismatch")
        }
        if let index = cachedChannels?.firstIndex(where: { $0.id == channel.id }) {
            cachedChannels?[index] = channel
        } else {
            cachedChannels = (cachedChannels ?? []) + [channel]
        }
        cachedChannelMuteStates[channel.id] = response.channel.muted
        return channel
    }

    public func createWorkRun(
        agent: MemberID,
        channel: ChannelID,
        input: AgentWorkInput,
        clientRunId: UUID
    ) async throws -> AgentWorkRun {
        guard let workspace else { throw BackendError.notConnected }
        return try await post(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/agent-runs",
            body: CreateAgentWorkRunRequest(
                agentMemberId: agent,
                clientRunId: clientRunId,
                input: input
            ),
            authorized: true,
            response: AgentWorkRun.self
        )
    }

    public func workRuns(channel: ChannelID, limit: Int = 50) async throws -> [AgentWorkRun] {
        guard let workspace else { throw BackendError.notConnected }
        let page = try await get(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/agent-runs",
            queryItems: [
                URLQueryItem(name: "type", value: "work"),
                URLQueryItem(name: "limit", value: String(min(max(limit, 1), 200))),
            ],
            response: AgentWorkRunPage.self
        )
        return page.runs
    }

    public func workRun(id: RunID) async throws -> AgentWorkRun {
        guard let workspace else { throw BackendError.notConnected }
        return try await get(
            "/v1/workspaces/\(workspace.description)/agent-runs/\(id.description)",
            queryItems: [],
            response: AgentWorkRun.self
        )
    }

    // MARK: Memory Plane (ADR-0129)

    public func memories(
        workspace requestedWorkspace: WorkspaceID,
        scope: MemoryScope?,
        agent: MemberID?,
        includeInvalid: Bool,
        limit: Int
    ) async throws -> [MemoryEntry] {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        var queryItems = [
            URLQueryItem(name: "includeInvalid", value: includeInvalid ? "true" : "false"),
            URLQueryItem(name: "limit", value: String(min(max(limit, 1), 200))),
        ]
        if let scope { queryItems.append(URLQueryItem(name: "scope", value: scope.rawValue)) }
        if let agent { queryItems.append(URLQueryItem(name: "agent", value: agent.description.lowercased())) }
        let page = try await get(
            "/v1/workspaces/\(requestedWorkspace.description)/memories",
            queryItems: queryItems,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MemoryPageResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return page.memories
    }

    public func searchMemories(
        workspace requestedWorkspace: WorkspaceID,
        query: String,
        scope: MemoryScope?,
        agent: MemberID?,
        limit: Int
    ) async throws -> [MemorySearchHit] {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        var queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(min(max(limit, 1), 50))),
        ]
        if let scope { queryItems.append(URLQueryItem(name: "scope", value: scope.rawValue)) }
        if let agent { queryItems.append(URLQueryItem(name: "agent", value: agent.description.lowercased())) }
        let response = try await get(
            "/v1/workspaces/\(requestedWorkspace.description)/memories/search",
            queryItems: queryItems,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MemorySearchResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.hits
    }

    public func updateMemory(
        workspace requestedWorkspace: WorkspaceID,
        memory: UUID,
        body: String,
        confidence: Double
    ) async throws -> MemoryEntry {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await patch(
            "/v1/workspaces/\(requestedWorkspace.description)/memories/\(memory.uuidString.lowercased())",
            body: UpdateMemoryRequestDTO(body: body, confidence: confidence),
            response: MemoryItemResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.memory
    }

    public func invalidateMemory(
        workspace requestedWorkspace: WorkspaceID,
        memory: UUID
    ) async throws -> MemoryEntry {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/memories/\(memory.uuidString.lowercased())/invalidate",
            body: InvalidateMemoryRequestDTO(invalidatedByMemoryId: nil),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MemoryItemResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.memory
    }

    public func memoryPolicy(
        workspace requestedWorkspace: WorkspaceID
    ) async throws -> WorkspaceMemoryPolicy {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await get(
            "/v1/workspaces/\(requestedWorkspace.description)/memory-policy",
            queryItems: [],
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MemoryPolicyResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.memoryPolicy
    }

    public func setMemoryPolicy(
        workspace requestedWorkspace: WorkspaceID,
        enabled: Bool
    ) async throws -> WorkspaceMemoryPolicy {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await put(
            "/v1/workspaces/\(requestedWorkspace.description)/memory-policy",
            body: PutMemoryPolicyRequestDTO(enabled: enabled),
            response: MemoryPolicyResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.memoryPolicy
    }

    public func contextPacket(
        workspace requestedWorkspace: WorkspaceID,
        packet: UUID
    ) async throws -> ContextPacketSnapshot {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await get(
            "/v1/workspaces/\(requestedWorkspace.description)/context-packets/\(packet.uuidString.lowercased())",
            queryItems: [],
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: ContextPacketSnapshot.self
        )
        try ensureSessionCurrent(context)
        guard response.packetId == packet,
              response.workspaceId == requestedWorkspace else {
            throw BackendError.decoding("context packet response scope mismatch")
        }
        return response
    }

    // MARK: Read state (ADR-0109)

    public func readStates(workspace: WorkspaceID) async throws -> [ChannelReadState] {
        let states = try await get(
            "/v1/workspaces/\(workspace.description)/read-state",
            queryItems: [],
            response: ReadStateListResponseDTO.self
        ).readStates
        for state in states {
            lastKnownSeqByChannel[state.channelId] = max(
                lastKnownSeqByChannel[state.channelId] ?? 0,
                state.latestSeq
            )
        }
        return states
    }

    public func markRead(
        channel: ChannelID,
        through sequence: Int64
    ) async throws -> ChannelReadState {
        guard let workspace else { throw BackendError.notConnected }
        return try await put(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/read-state",
            body: UpdateReadStateRequestDTO(lastReadSeq: sequence),
            response: ChannelReadState.self
        )
    }

    public func subscribeReadStates(member: MemberID) async throws -> AsyncThrowingStream<ChannelReadState, Error> {
        guard let workspace else { throw BackendError.notConnected }
        guard let readStateRealtimeTransport else {
            return AsyncThrowingStream { continuation in
                continuation.finish(throwing: BackendError.realtime("Read-state realtime is unavailable."))
            }
        }
        let envelopes = try await readStateRealtimeTransport.readStateEnvelopes(member: member)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await envelope in envelopes {
                        guard envelope.type == "read_state",
                              envelope.payload["workspace_id"]?.stringValue?.lowercased()
                                == workspace.description.lowercased(),
                              envelope.payload["member_id"]?.stringValue?.lowercased()
                                == member.description.lowercased()
                        else {
                            continue
                        }
                        let data = try JSONEncoder.momo.encode(envelope.payload)
                        continuation.yield(try JSONDecoder.momo.decode(ChannelReadState.self, from: data))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func createChannel(
        workspace: WorkspaceID,
        kind: ChannelKind,
        name: String,
        topic: String?
    ) async throws -> ChannelCreateResult {
        guard let sessionWorkspace = self.workspace,
              sessionWorkspace == workspace,
              let sessionAccessToken = accessToken,
              !sessionAccessToken.isEmpty
        else {
            throw BackendError.notConnected
        }
        let generation = connectionGeneration
        let responseData: Data
        do {
            responseData = try await postData(
                "/v1/workspaces/\(workspace.description)/channels",
                body: CreateChannelRequest(kind: kind.rawValue, name: name, topic: topic),
                authorized: true
            )
        } catch {
            guard connectionGeneration == generation,
                  self.workspace == sessionWorkspace,
                  accessToken == sessionAccessToken
            else {
                throw CancellationError()
            }
            throw error
        }
        guard connectionGeneration == generation,
              self.workspace == sessionWorkspace,
              accessToken == sessionAccessToken
        else {
            throw CancellationError()
        }
        let response: CreateChannelResponseDTO
        do {
            response = try decoder.decode(CreateChannelResponseDTO.self, from: responseData)
        } catch {
            throw BackendError.decoding(String(describing: error))
        }
        let result = try response.result()
        guard result.channel.workspaceId == sessionWorkspace,
              result.creatorMembership.workspaceId == sessionWorkspace,
              result.creatorMembership.channelId == result.channel.id
        else {
            throw BackendError.decoding("channel create response scope mismatch")
        }
        var updatedChannels = cachedChannels ?? []
        if !updatedChannels.contains(where: { $0.id == result.channel.id }) {
            updatedChannels.append(result.channel)
        }
        cachedChannels = updatedChannels
        cachedChannelMuteStates[result.channel.id] = response.channel.muted
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
        try await searchWorkspaceMessages(
            workspace: workspace,
            query: query,
            cursor: nil,
            limit: 20
        ).messages
    }

    func searchWorkspaceMessages(
        workspace: WorkspaceID,
        query: String,
        cursor: String?,
        limit: Int
    ) async throws -> MomoWorkspaceMessageSearchPage {
        guard let sessionWorkspace = self.workspace,
              sessionWorkspace == workspace,
              accessToken != nil
        else {
            throw BackendError.notConnected
        }
        let generation = connectionGeneration
        let response: WorkspaceMessageSearchResponseDTO
        do {
            var queryItems = [
                URLQueryItem(name: "q", value: query),
                URLQueryItem(name: "limit", value: String(min(max(limit, 1), 50))),
            ]
            if let cursor, !cursor.isEmpty {
                queryItems.append(URLQueryItem(name: "cursor", value: cursor))
            }
            response = try await get(
                "/v1/workspaces/\(workspace.description)/search/messages",
                queryItems: queryItems,
                cachePolicy: .reloadIgnoringLocalCacheData,
                response: WorkspaceMessageSearchResponseDTO.self
            )
        } catch {
            guard connectionGeneration == generation,
                  self.workspace == sessionWorkspace
            else {
                throw CancellationError()
            }
            throw error
        }
        guard connectionGeneration == generation,
              self.workspace == sessionWorkspace
        else {
            throw CancellationError()
        }
        return try MomoWorkspaceMessageSearchPage(
            messages: response.hits.map { try $0.message() },
            nextCursor: response.nextCursor
        )
    }

    public func setTyping(channel: ChannelID, isTyping: Bool) async {}

    public func editMessage(_ id: MessageID, body: String) async throws -> Message {
        let context = try requireSessionContext()
        let response = try await patch(
            "/v1/workspaces/\(context.workspace.description)/messages/\(id.description)",
            body: EditMessageRequestDTO(body: body),
            response: MessageDTO.self
        )
        try ensureSessionCurrent(context)
        let message = try response.message()
        guard message.id == id,
              responseBelongsToAuthenticatedMember(message.authorMemberId),
              message.state == .edited,
              message.body == body,
              message.editedAtMs != nil,
              message.deletedAtMs == nil
        else {
            throw BackendError.decoding("message edit response mismatch")
        }
        return message
    }

    public func addReaction(_ id: MessageID, emoji: String) async throws {
        let context = try requireSessionContext()
        let url = try reactionRequestURL(
            workspace: context.workspace,
            message: id,
            emoji: emoji
        )
        let response = try await putEmpty(
            url,
            response: ReactionDeltaResponseDTO.self
        )
        try ensureSessionCurrent(context)
        try validateReactionDelta(response, expectedAction: "added", message: id, emoji: emoji)
    }

    func removeReaction(_ id: MessageID, emoji: String) async throws {
        let context = try requireSessionContext()
        let url = try reactionRequestURL(
            workspace: context.workspace,
            message: id,
            emoji: emoji
        )
        let response = try await delete(
            url,
            authorized: true,
            response: ReactionDeltaResponseDTO.self
        )
        try ensureSessionCurrent(context)
        try validateReactionDelta(response, expectedAction: "removed", message: id, emoji: emoji)
    }

    func deleteMessage(_ id: MessageID) async throws -> Message {
        let context = try requireSessionContext()
        let response = try await delete(
            "/v1/workspaces/\(context.workspace.description)/messages/\(id.description)",
            authorized: true,
            response: MessageDTO.self
        )
        try ensureSessionCurrent(context)
        let message = try response.message()
        guard message.id == id,
              responseBelongsToAuthenticatedMember(message.authorMemberId),
              message.state == .deleted,
              message.body == nil,
              message.deletedAtMs != nil
        else {
            throw BackendError.decoding("message delete response mismatch")
        }
        return message
    }

    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] {
        let context = try requireSessionContext()
        let response = try await get(
            "/v1/workspaces/\(context.workspace.description)/channels/\(channel.description)/reactions",
            queryItems: [],
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: [String: [String: [String]]].self
        )
        try ensureSessionCurrent(context)
        var snapshot: [MessageID: [String: Set<MemberID>]] = [:]
        for (rawMessageID, reactions) in response {
            guard let messageID = MessageID(uuidString: rawMessageID) else {
                throw BackendError.decoding("invalid reaction snapshot message id")
            }
            var decodedReactions: [String: Set<MemberID>] = [:]
            for (emoji, rawMemberIDs) in reactions {
                guard !emoji.isEmpty else {
                    throw BackendError.decoding("invalid reaction snapshot emoji")
                }
                let memberIDs = try rawMemberIDs.map { rawMemberID in
                    guard let memberID = MemberID(uuidString: rawMemberID) else {
                        throw BackendError.decoding("invalid reaction snapshot member id")
                    }
                    return memberID
                }
                decodedReactions[emoji] = Set(memberIDs)
            }
            snapshot[messageID] = decodedReactions
        }
        return snapshot
    }

    private func validateReactionDelta(
        _ response: ReactionDeltaResponseDTO,
        expectedAction: String,
        message: MessageID,
        emoji: String
    ) throws {
        guard response.action == expectedAction,
              response.messageId.lowercased() == message.description.lowercased(),
              response.emoji == emoji,
              let memberID = MemberID(uuidString: response.memberId)
        else {
            throw BackendError.decoding("reaction response mismatch")
        }
        if let expectedMemberID = authenticatedMember?.id ?? accessToken.flatMap(Self.memberIDFromJWT),
           memberID != expectedMemberID {
            throw BackendError.decoding("reaction response member mismatch")
        }
    }

    private func requireSessionContext() throws -> (
        workspace: WorkspaceID,
        accessToken: String,
        generation: UInt64
    ) {
        guard let workspace, let accessToken, !accessToken.isEmpty else {
            throw BackendError.notConnected
        }
        return (workspace, accessToken, connectionGeneration)
    }

    private func ensureSessionCurrent(
        _ context: (workspace: WorkspaceID, accessToken: String, generation: UInt64)
    ) throws {
        guard connectionGeneration == context.generation,
              workspace == context.workspace,
              accessToken == context.accessToken
        else {
            throw CancellationError()
        }
    }

    private func responseBelongsToAuthenticatedMember(_ memberID: MemberID) -> Bool {
        guard let expectedMemberID = authenticatedMember?.id
                ?? accessToken.flatMap(Self.memberIDFromJWT)
        else {
            return true
        }
        return memberID == expectedMemberID
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

    // MARK: Interactive Work Console

    func workHosts(workspace requestedWorkspace: WorkspaceID) async throws -> [WorkHost] {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await get(
            "/v1/workspaces/\(requestedWorkspace.description)/work-hosts",
            queryItems: [],
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkHostListResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.workHosts
    }

    func registerWorkHost(
        workspace requestedWorkspace: WorkspaceID,
        displayName: String,
        publicKey: String,
        capabilities: [String: Bool]
    ) async throws -> WorkHost {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/work-hosts",
            body: MomoRegisterWorkHostRequestDTO(
                scope: "member",
                type: "app",
                displayName: displayName,
                publicKey: publicKey,
                capabilities: capabilities
            ),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkHostResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.workHost
    }

    func heartbeatWorkHost(
        workspace requestedWorkspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        signature: String
    ) async throws -> WorkHost {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/work-hosts/\(host.description)/heartbeat",
            body: MomoWorkHostHeartbeatRequestDTO(
                sentAtMs: sentAtMs,
                signature: signature
            ),
            authorized: false,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkHostResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workHost.id == host,
              response.workHost.workspaceId == requestedWorkspace,
              response.workHost.revokedAtMs == nil
        else { throw BackendError.decoding("work host heartbeat response mismatch") }
        return response.workHost
    }

    func enabledWorkToolProfiles(
        workspace requestedWorkspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        signature: String
    ) async throws -> [MomoWorkToolProfile] {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let path = "/v1/workspaces/\(requestedWorkspace.description)/work-tool-profiles"
        var request = URLRequest(
            url: config.baseURL.appendingPathComponent(path),
            cachePolicy: .reloadIgnoringLocalCacheData
        )
        request.httpMethod = "GET"
        request.setValue("MomoHost \(host.description.lowercased())", forHTTPHeaderField: "Authorization")
        request.setValue(String(sentAtMs), forHTTPHeaderField: "X-Momo-Work-Host-Sent-At")
        request.setValue(signature, forHTTPHeaderField: "X-Momo-Work-Host-Signature")
        let response = try await execute(request, response: MomoWorkToolProfilesResponseDTO.self)
        try ensureSessionCurrent(context)
        guard response.workToolProfiles.allSatisfy({
            $0.workspaceId == requestedWorkspace && $0.enabled
        }) else { throw BackendError.decoding("enabled work tool profile scope mismatch") }
        return response.workToolProfiles
    }

    func workSessions(
        workspace requestedWorkspace: WorkspaceID,
        activeOnly: Bool
    ) async throws -> [MomoWorkSession] {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await get(
            "/v1/workspaces/\(requestedWorkspace.description)/work-sessions",
            queryItems: activeOnly ? [URLQueryItem(name: "active", value: "1")] : [],
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkSessionListResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.workSessions
    }

    func createWorkSession(
        workspace requestedWorkspace: WorkspaceID,
        channel: ChannelID,
        host: WorkHostID,
        tool: MomoWorkTool,
        label: String
    ) async throws -> MomoWorkSession {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/work-sessions",
            body: MomoCreateWorkSessionRequestDTO(
                channelId: channel,
                hostId: host,
                tool: tool,
                label: label
            ),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkSessionResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.workSession
    }

    func endWorkSession(
        workspace requestedWorkspace: WorkspaceID,
        session workSessionID: WorkSessionID,
        exitCode: Int?
    ) async throws -> MomoWorkSession {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await patch(
            "/v1/workspaces/\(requestedWorkspace.description)/work-sessions/\(workSessionID.description)",
            body: MomoEndWorkSessionRequestDTO(status: "ended", exitCode: exitCode),
            response: MomoWorkSessionResponseDTO.self
        )
        try ensureSessionCurrent(context)
        return response.workSession
    }

    func issueTerminalAttach(
        workspace requestedWorkspace: WorkspaceID,
        session workSessionID: WorkSessionID,
        mode: MomoTerminalAttachMode
    ) async throws -> MomoTerminalAttachGrant {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/work-sessions/\(workSessionID.description)/terminal-attach",
            body: MomoTerminalAttachRequestDTO(mode: mode),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoTerminalAttachCapabilityDTO.self
        )
        try ensureSessionCurrent(context)
        return try response.grant
    }

    func setWorkSessionObservation(
        workspace requestedWorkspace: WorkspaceID,
        session workSessionID: WorkSessionID,
        observation: MomoWorkSessionObservation
    ) async throws -> MomoWorkSession {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await patch(
            "/v1/workspaces/\(requestedWorkspace.description)/work-sessions/\(workSessionID.description)",
            body: MomoUpdateWorkSessionObservationRequestDTO(observation: observation),
            response: MomoWorkSessionResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workSession.id == workSessionID,
              response.workSession.workspaceId == requestedWorkspace,
              response.workSession.observation == observation
        else { throw BackendError.decoding("work session observation response mismatch") }
        return response.workSession
    }

    func resumeWorkSession(
        workspace requestedWorkspace: WorkspaceID,
        session workSessionID: WorkSessionID,
        targetHost: WorkHostID
    ) async throws -> MomoWorkSession {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/work-sessions/\(workSessionID.description)/resume",
            body: MomoResumeWorkSessionRequestDTO(targetHostId: targetHost),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkSessionResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workSession.workspaceId == requestedWorkspace,
              response.workSession.resumedFromSessionId == workSessionID,
              response.workSession.hostId == targetHost,
              response.workSession.isRunning
        else { throw BackendError.decoding("resumed work session response mismatch") }
        return response.workSession
    }

    func workTierPolicy(
        workspace requestedWorkspace: WorkspaceID,
        scope: MomoWorkTierPolicyScope
    ) async throws -> MomoWorkTierPolicy {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let response = try await get(
            workTierPolicyPath(workspace: requestedWorkspace, scope: scope),
            queryItems: [],
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkTierPolicyResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workTierPolicy.workspaceId == requestedWorkspace else {
            throw BackendError.decoding("work tier policy workspace mismatch")
        }
        return response.workTierPolicy
    }

    func setWorkTierPolicy(
        workspace requestedWorkspace: WorkspaceID,
        scope: MomoWorkTierPolicyScope,
        mode: MomoWorkTierPolicyMode,
        autoTarget: String?
    ) async throws -> MomoWorkTierPolicy {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let normalizedTarget = autoTarget?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard (mode == .auto) == (normalizedTarget?.isEmpty == false) else {
            throw BackendError.problem(
                status: 400,
                title: "invalid work tier policy",
                detail: "auto mode requires one target and other modes forbid it"
            )
        }
        let response = try await put(
            workTierPolicyPath(workspace: requestedWorkspace, scope: scope),
            body: MomoPutWorkTierPolicyRequestDTO(
                mode: mode,
                autoTarget: mode == .auto ? normalizedTarget : nil
            ),
            response: MomoWorkTierPolicyResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workTierPolicy.workspaceId == requestedWorkspace,
              response.workTierPolicy.mode == mode
        else { throw BackendError.decoding("work tier policy response mismatch") }
        return response.workTierPolicy
    }

    private func workTierPolicyPath(
        workspace: WorkspaceID,
        scope: MomoWorkTierPolicyScope
    ) -> String {
        let base = "/v1/workspaces/\(workspace.description)/work-tier-policy"
        return scope == .member ? "\(base)/me" : base
    }

    func acknowledgeWorkControl(
        workspace requestedWorkspace: WorkspaceID,
        control: WorkControlID,
        ok: Bool,
        session workSessionID: WorkSessionID?,
        errorLabel: String?
    ) async throws {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        _ = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/work-controls/\(control.description)/ack",
            body: MomoWorkControlAckRequestDTO(
                ok: ok,
                sessionId: workSessionID,
                errorLabel: errorLabel
            ),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkControlAckResponseDTO.self
        )
        try ensureSessionCurrent(context)
    }

    func setWorkAutoApprove(
        workspace requestedWorkspace: WorkspaceID,
        tool: MomoWorkTool,
        enabled: Bool
    ) async throws -> Bool {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else {
            throw BackendError.notConnected
        }
        let path = "/v1/workspaces/\(requestedWorkspace.description)/work-auto-approvals/\(tool.rawValue)"
        let response: MomoWorkAutoApproveResponseDTO
        if enabled {
            response = try await putEmpty(path, response: MomoWorkAutoApproveResponseDTO.self)
        } else {
            response = try await delete(
                path,
                authorized: true,
                response: MomoWorkAutoApproveResponseDTO.self
            )
        }
        try ensureSessionCurrent(context)
        guard response.tool == tool, response.enabled == enabled else {
            throw BackendError.decoding("work auto-approve response mismatch")
        }
        return response.enabled
    }

    func workToolProfiles(
        workspace requestedWorkspace: WorkspaceID
    ) async throws -> [MomoWorkToolProfile] {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await get(
            "/v1/workspaces/\(requestedWorkspace.description)/work-tool-profiles",
            queryItems: [],
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkToolProfilesResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workToolProfiles.allSatisfy({ $0.workspaceId == requestedWorkspace }) else {
            throw BackendError.decoding("work tool profile workspace mismatch")
        }
        return response.workToolProfiles
    }

    func createWorkToolProfile(
        workspace requestedWorkspace: WorkspaceID,
        draft: MomoWorkToolProfileDraft
    ) async throws -> MomoWorkToolProfile {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await post(
            "/v1/workspaces/\(requestedWorkspace.description)/work-tool-profiles",
            body: MomoCreateWorkToolProfileRequestDTO(draft: draft),
            authorized: true,
            cachePolicy: .reloadIgnoringLocalCacheData,
            response: MomoWorkToolProfileResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workToolProfile.workspaceId == requestedWorkspace,
              response.workToolProfile.toolKey == draft.toolKey.lowercased()
        else { throw BackendError.decoding("work tool profile response mismatch") }
        return response.workToolProfile
    }

    func updateWorkToolProfile(
        workspace requestedWorkspace: WorkspaceID,
        tool: MomoWorkTool,
        draft: MomoWorkToolProfileDraft
    ) async throws -> MomoWorkToolProfile {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await put(
            "/v1/workspaces/\(requestedWorkspace.description)/work-tool-profiles/\(tool.rawValue)",
            body: MomoUpdateWorkToolProfileRequestDTO(draft: draft),
            response: MomoWorkToolProfileResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workToolProfile.workspaceId == requestedWorkspace,
              response.workToolProfile.tool == tool
        else { throw BackendError.decoding("updated work tool profile response mismatch") }
        return response.workToolProfile
    }

    func deleteWorkToolProfile(
        workspace requestedWorkspace: WorkspaceID,
        tool: MomoWorkTool
    ) async throws -> MomoWorkToolProfile {
        let context = try requireSessionContext()
        guard context.workspace == requestedWorkspace else { throw BackendError.notConnected }
        let response = try await delete(
            "/v1/workspaces/\(requestedWorkspace.description)/work-tool-profiles/\(tool.rawValue)",
            authorized: true,
            response: MomoWorkToolProfileResponseDTO.self
        )
        try ensureSessionCurrent(context)
        guard response.workToolProfile.workspaceId == requestedWorkspace,
              response.workToolProfile.tool == tool
        else { throw BackendError.decoding("deleted work tool profile response mismatch") }
        return response.workToolProfile
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

    private func reactionRequestURL(
        workspace: WorkspaceID,
        message: MessageID,
        emoji: String
    ) throws -> URL {
        let collectionPath = "/v1/workspaces/\(workspace.description)/messages/\(message.description)/reactions"
        let collectionURL = config.baseURL.appendingPathComponent(collectionPath)
        let unreservedPathSegmentCharacters = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        )
        guard !emoji.isEmpty,
              let encodedEmoji = emoji.addingPercentEncoding(
                withAllowedCharacters: unreservedPathSegmentCharacters
              ),
              var components = URLComponents(
                url: collectionURL,
                resolvingAgainstBaseURL: false
              )
        else {
            throw BackendError.problem(status: 400, title: "bad url", detail: collectionPath)
        }
        components.percentEncodedPath += "/\(encodedEmoji)"
        guard let url = components.url else {
            throw BackendError.problem(status: 400, title: "bad url", detail: collectionPath)
        }
        return url
    }

    private func get<T: Decodable>(
        _ path: String,
        queryItems: [URLQueryItem],
        cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy,
        response: T.Type
    ) async throws -> T {
        var components = URLComponents(url: config.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !queryItems.isEmpty {
            components?.queryItems = queryItems
        }
        guard let url = components?.url else {
            throw BackendError.problem(status: 400, title: "bad url", detail: path)
        }
        var request = URLRequest(url: url, cachePolicy: cachePolicy)
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

    private func postData<RequestBody: Encodable>(
        _ path: String,
        body: RequestBody,
        authorized: Bool,
        cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy
    ) async throws -> Data {
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
        return try await executeData(request)
    }

    private func postEmpty<ResponseBody: Decodable>(
        _ path: String,
        authorized: Bool,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(
            url: config.baseURL.appendingPathComponent(path),
            cachePolicy: .reloadIgnoringLocalCacheData
        )
        request.httpMethod = "POST"
        if authorized {
            try authorize(&request)
        }
        return try await execute(request, response: response)
    }

    private func put<RequestBody: Encodable, ResponseBody: Decodable>(
        _ path: String,
        body: RequestBody,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        try authorize(&request)
        return try await execute(request, response: response)
    }

    private func putEmpty<ResponseBody: Decodable>(
        _ path: String,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        try await putEmpty(
            config.baseURL.appendingPathComponent(path),
            response: response
        )
    }

    private func putEmpty<ResponseBody: Decodable>(
        _ url: URL,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        try authorize(&request)
        return try await execute(request, response: response)
    }

    private func patch<RequestBody: Encodable, ResponseBody: Decodable>(
        _ path: String,
        body: RequestBody,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        try authorize(&request)
        return try await execute(request, response: response)
    }

    private func delete<ResponseBody: Decodable>(
        _ path: String,
        authorized: Bool,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        try await delete(
            config.baseURL.appendingPathComponent(path),
            authorized: authorized,
            response: response
        )
    }

    private func delete<ResponseBody: Decodable>(
        _ url: URL,
        authorized: Bool,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        if authorized {
            try authorize(&request)
        }
        return try await execute(request, response: response)
    }

    private func delete<RequestBody: Encodable, ResponseBody: Decodable>(
        _ path: String,
        body: RequestBody,
        response: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        try authorize(&request)
        return try await execute(request, response: response)
    }

    private func authorize(_ request: inout URLRequest) throws {
        guard let accessToken else { throw BackendError.notConnected }
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    }

    private func execute<T: Decodable>(_ request: URLRequest, response: T.Type) async throws -> T {
        let data = try await executeData(request)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw BackendError.decoding(String(describing: error))
        }
    }

    private func executeData(_ request: URLRequest) async throws -> Data {
        do {
            let (data, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else {
                throw BackendError.realtime("non-HTTP response")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw problemError(status: http.statusCode, data: data)
            }
            return data
        } catch let error as BackendError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw BackendError.realtime(error.localizedDescription)
        }
    }

    private func problemError(status: Int, data: Data) -> BackendError {
        if let problem = try? decoder.decode(ProblemResponse.self, from: data) {
            return .problem(
                status: status,
                title: problem.title ?? problem.error?.code,
                detail: problem.detail ?? problem.message ?? problem.error?.message
            )
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
        readStateRealtimeTransport = transport
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

    private static func memberIDFromJWT(_ token: String) -> MemberID? {
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        var payload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = payload.count % 4
        if remainder != 0 {
            payload += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let subject = object["sub"] as? String
        else {
            return nil
        }
        return MemberID(subject)
    }
}

private struct MemoryPageResponseDTO: Decodable {
    let memories: [MemoryEntry]
}

private struct MemorySearchResponseDTO: Decodable {
    let hits: [MemorySearchHit]
}

private struct MemoryItemResponseDTO: Decodable {
    let memory: MemoryEntry
}

private struct MemoryPolicyResponseDTO: Decodable {
    let memoryPolicy: WorkspaceMemoryPolicy
}

private struct UpdateMemoryRequestDTO: Encodable {
    let body: String
    let confidence: Double
}

private struct InvalidateMemoryRequestDTO: Encodable {
    let invalidatedByMemoryId: UUID?
}

private struct PutMemoryPolicyRequestDTO: Encodable {
    let enabled: Bool
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
    let role: String?
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
            workspaceRole: role.flatMap(MembershipRole.init(rawValue:)),
            channelIds: (channelIds ?? []).compactMap { ChannelID(uuidString: $0) },
            capabilities: capabilities ?? [],
            presence: .online
        )
    }
}

private struct WorkspaceRosterResponse: Decodable {
    let members: [MemberDTO]
}

private struct MembershipRoleRequestDTO: Encodable {
    let role: String
}

private struct RemoveWorkspaceMemberRequestDTO: Encodable {
    let ban: Bool
    let reason: String?
}

private struct MembershipRoleResponseDTO: Decodable {
    let memberId: String
    let scope: String
    let role: String
}

private struct MembershipLifecycleResponseDTO: Decodable {
    let memberId: String
    let status: String
}

private struct ChannelLeaveResponseDTO: Decodable {
    let channelId: String
    let memberId: String
    let archived: Bool
}

private struct WorkspaceAuditPageDTO: Decodable {
    let events: [MomoWorkspaceAuditEvent]
    let nextCursor: String?
}

private struct ReadStateListResponseDTO: Decodable {
    let readStates: [ChannelReadState]

    private enum CodingKeys: String, CodingKey {
        case readStates = "read_states"
    }
}

private struct UpdateReadStateRequestDTO: Encodable {
    let lastReadSeq: Int64

    private enum CodingKeys: String, CodingKey {
        case lastReadSeq = "last_read_seq"
    }
}

private struct SendMessageRequest: Encodable {
    let clientMsgId: UUID
    let type: String
    let body: String?
    let props: [String: String]?
    let runId: UUID?
    let rootId: MessageID?
    let attachmentIds: [FileID]?
}

private struct CreateAttachmentUploadRequestDTO: Encodable {
    let name: String
    let mime: String
    let size: Int64
}

private struct AttachmentUploadResponseDTO: Decodable {
    let id: String
    let status: String
    let uploadUrl: String
}

private struct AttachmentResponseDTO: Decodable {
    let id: String
    let channelId: String
    let name: String
    let mime: String
    let size: Int64
    let status: String
}

private struct MessagePage: Decodable {
    let messages: [MessageDTO]
    let nextBefore: Int64?
}

private struct ThreadRepliesPageDTO: Decodable {
    let messages: [MessageDTO]
    let nextCursor: Int64?
}

private struct WorkspaceMessageSearchResponseDTO: Decodable {
    let hits: [WorkspaceMessageSearchHitDTO]
    let nextCursor: String?
}

private struct WorkspaceMessageSearchHitDTO: Decodable {
    let channelId: String
    let messageId: String
    let seq: Int64
    let authorMemberId: String
    let createdAtMs: Int64
    let snippet: String
    let matchOffset: Int

    func message() throws -> Message {
        guard let channelID = ChannelID(uuidString: channelId),
              let messageID = MessageID(uuidString: messageId),
              let authorID = MemberID(uuidString: authorMemberId)
        else {
            throw BackendError.decoding("invalid workspace search hit identity")
        }
        return Message(
            id: messageID,
            channelId: channelID,
            seq: seq,
            hlcTs: createdAtMs,
            authorMemberId: authorID,
            type: .text,
            state: .sent,
            body: snippet,
            props: ["search_match_offset": .int(Int64(matchOffset))],
            createdAtMs: createdAtMs
        )
    }
}

private struct WorkspaceChannelsResponse: Decodable {
    let channels: [ChannelDTO]
}

private struct UpdateWorkspaceRequestDTO: Encodable {
    let name: String
    let expectedUpdatedAtMs: Int64
}

private struct WorkspaceResponseDTO: Decodable {
    let workspace: WorkspaceDTO
}

private struct WorkspaceDTO: Decodable {
    let id: WorkspaceID
    let slug: String
    let name: String
    let updatedAtMs: Int64

    var workspace: Workspace {
        Workspace(id: id, slug: slug, name: name, updatedAtMs: updatedAtMs)
    }
}

private struct ChannelDTO: Decodable {
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

    func directMessageParticipantIDs() throws -> [MemberID] {
        guard let memberIds, memberIds.count == 2 else {
            throw BackendError.decoding("direct message response scope mismatch")
        }
        let participants = try memberIds.map { rawMemberID in
            guard let memberID = MemberID(uuidString: rawMemberID) else {
                throw BackendError.decoding("direct message response scope mismatch")
            }
            return memberID
        }
        guard Set(participants).count == 2 else {
            throw BackendError.decoding("direct message response scope mismatch")
        }
        return participants
    }

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
            dmMemberIds: (memberIds ?? []).compactMap { MemberID(uuidString: $0) },
            createdBy: createdBy.flatMap { MemberID(uuidString: $0) },
            archivedAtMs: archivedAtMs
        )
    }
}

private struct UpdateNotificationPrefRequestDTO: Encodable {
    let muted: Bool
}

private struct NotificationPrefResponseDTO: Decodable {
    let muted: Bool
}

private struct EditMessageRequestDTO: Encodable {
    let body: String
}

private struct ReactionDeltaResponseDTO: Decodable {
    let action: String
    let messageId: String
    let memberId: String
    let emoji: String
}

private struct OpenDirectMessageRequestDTO: Encodable {
    let memberId: UUID
}

private struct OpenDirectMessageResponseDTO: Decodable {
    let channel: ChannelDTO
    let created: Bool
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
    let rootId: String?
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
    let attachments: [MessageAttachment]?
    let state: String?
    let editedAtMs: Int64?
    let deletedAtMs: Int64?

    func message() throws -> Message {
        guard let decodedID = MessageID(uuidString: id),
              let decodedChannelID = ChannelID(uuidString: channelId),
              let decodedAuthorID = MemberID(uuidString: authorMemberId),
              let decodedType = MessageType(rawValue: type)
        else {
            throw BackendError.decoding("invalid message identity")
        }
        let decodedRootID: MessageID?
        if let rootId {
            guard let rootID = MessageID(uuidString: rootId) else {
                throw BackendError.decoding("invalid message thread root id")
            }
            decodedRootID = rootID
        } else {
            decodedRootID = nil
        }
        let decodedState: MessageState
        if let state {
            guard let messageState = MessageState(rawValue: state) else {
                throw BackendError.decoding("invalid message state")
            }
            decodedState = messageState
        } else {
            decodedState = .sent
        }
        let decodedRunID: RunID?
        if let runId {
            guard let parsedRunID = RunID(uuidString: runId) else {
                throw BackendError.decoding("invalid message run id")
            }
            decodedRunID = parsedRunID
        } else {
            decodedRunID = nil
        }
        return Message(
            id: decodedID,
            channelId: decodedChannelID,
            seq: seq,
            hlcTs: hlcTs,
            hlcCount: hlcCount,
            authorMemberId: decodedAuthorID,
            type: decodedType,
            state: decodedState,
            body: body,
            props: props ?? .object([:]),
            rootId: decodedRootID,
            thread: thread,
            attachments: attachments,
            runId: decodedRunID,
            clientMsgId: clientMsgId,
            createdAtMs: createdAtMs,
            editedAtMs: editedAtMs,
            deletedAtMs: deletedAtMs
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

private struct MomoWorkSessionListResponseDTO: Decodable {
    let workSessions: [MomoWorkSession]
}

private struct MomoWorkHostListResponseDTO: Decodable {
    let workHosts: [WorkHost]
}

private struct MomoWorkHostResponseDTO: Decodable {
    let workHost: WorkHost
}

private struct MomoRegisterWorkHostRequestDTO: Encodable {
    let scope: String
    let type: String
    let displayName: String
    let publicKey: String
    let capabilities: [String: Bool]
}

private struct MomoWorkHostHeartbeatRequestDTO: Encodable {
    let sentAtMs: Int64
    let signature: String
}

private struct MomoWorkSessionResponseDTO: Decodable {
    let workSession: MomoWorkSession
}

private struct MomoTerminalAttachCapabilityDTO: Decodable {
    let attachEndpoint: String
    let capabilityToken: String
    let ptyId: String

    enum CodingKeys: String, CodingKey {
        case attachEndpoint = "attach_endpoint"
        case capabilityToken = "capability_token"
        case ptyId = "pty_id"
    }

    var grant: MomoTerminalAttachGrant {
        get throws {
            guard let endpoint = URL(string: attachEndpoint) else {
                throw BackendError.decoding("invalid terminal attach endpoint")
            }
            return try MomoTerminalAttachGrant(
                endpoint: endpoint,
                capabilityToken: capabilityToken,
                ptyId: ptyId
            )
        }
    }
}

private struct MomoTerminalAttachRequestDTO: Encodable {
    let mode: MomoTerminalAttachMode
}

private struct MomoCreateWorkSessionRequestDTO: Encodable {
    let channelId: ChannelID
    let hostId: WorkHostID
    let tool: MomoWorkTool
    let label: String
}

private struct MomoEndWorkSessionRequestDTO: Encodable {
    let status: String
    let exitCode: Int?
}

private struct MomoUpdateWorkSessionObservationRequestDTO: Encodable {
    let observation: MomoWorkSessionObservation
}

private struct MomoResumeWorkSessionRequestDTO: Encodable {
    let targetHostId: WorkHostID
}

private struct MomoPutWorkTierPolicyRequestDTO: Encodable {
    let mode: MomoWorkTierPolicyMode
    let autoTarget: String?
}

private struct MomoWorkTierPolicyResponseDTO: Decodable {
    let workTierPolicy: MomoWorkTierPolicy
}

private struct MomoWorkControlAckRequestDTO: Encodable {
    let ok: Bool
    let sessionId: WorkSessionID?
    let errorLabel: String?
}

private struct MomoWorkControlAckResponseDTO: Decodable {
    struct WorkControl: Decodable {
        let status: String
    }

    let workControl: WorkControl
}

private struct MomoWorkAutoApproveResponseDTO: Decodable {
    let tool: MomoWorkTool
    let enabled: Bool
}

private struct MomoWorkToolProfilesResponseDTO: Decodable {
    let workToolProfiles: [MomoWorkToolProfile]
}

private struct MomoWorkToolProfileResponseDTO: Decodable {
    let workToolProfile: MomoWorkToolProfile
}

private struct MomoCreateWorkToolProfileRequestDTO: Encodable {
    let toolKey: String
    let displayName: String
    let launchTemplate: MomoWorkToolLaunchTemplate
    let tierDefaults: [String: JSON]
    let enabled: Bool

    init(draft: MomoWorkToolProfileDraft) {
        toolKey = draft.toolKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        displayName = draft.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        launchTemplate = MomoWorkToolLaunchTemplate(
            command: draft.command.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            arguments: draft.arguments
        )
        tierDefaults = [
            "transport": .string(draft.transport.rawValue),
            "permission_policy": .string(draft.permissionPolicy.rawValue),
            "risk": .string(draft.risk.rawValue),
        ]
        enabled = draft.enabled
    }
}

private struct MomoUpdateWorkToolProfileRequestDTO: Encodable {
    let displayName: String
    let launchTemplate: MomoWorkToolLaunchTemplate
    let tierDefaults: [String: JSON]
    let enabled: Bool

    init(draft: MomoWorkToolProfileDraft) {
        displayName = draft.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        launchTemplate = MomoWorkToolLaunchTemplate(
            command: draft.command.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            arguments: draft.arguments
        )
        tierDefaults = [
            "transport": .string(draft.transport.rawValue),
            "permission_policy": .string(draft.permissionPolicy.rawValue),
            "risk": .string(draft.risk.rawValue),
        ]
        enabled = draft.enabled
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
    let error: ServerError?

    struct ServerError: Decodable {
        let code: String?
        let message: String?
    }
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
