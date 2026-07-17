import Foundation
import MomoCore
@testable import MomoiOSKit
@testable import MomoiOSPushKit
import Testing

@Suite("MomoiOS push")
struct PushTests {
    @Test("momo id-only payload parses and creates a deep link")
    func payloadParsing() throws {
        let envelope = try MomoPushParser.parse(data: Data(Self.payload.utf8))

        #expect(envelope.schema == "momo.push.notification.v1")
        #expect(envelope.channelID == "00000000-0000-0000-0000-000000000010")
        #expect(envelope.deepLinkURL?.absoluteString == "momo://push/workspaces/00000000-0000-0000-0000-000000000001/channels/00000000-0000-0000-0000-000000000010/messages/00000000-0000-0000-0000-000000000020")
        #expect(IOSPushDeepLink(envelope: envelope)?.channelID == fixtureChannel().id)
    }

    @Test("NSE resolver replaces placeholder after fetch")
    func fetchReplacement() async throws {
        let envelope = try MomoPushParser.parse(data: Data(Self.payload.utf8))
        let resolver = PushNotificationResolver(fetcher: SuccessfulPushFetcher())

        let resolved = await resolver.resolve(envelope: envelope, session: pushSession())

        #expect(resolved == PushDisplayContent(title: "김인턴", body: "승인 요청을 확인해 주세요."))
    }

    @Test("NSE resolver keeps placeholder when fetch fails")
    func fetchFailureIsFailOpen() async throws {
        let envelope = try MomoPushParser.parse(data: Data(Self.payload.utf8))
        let resolver = PushNotificationResolver(fetcher: FailingPushFetcher())

        let resolved = await resolver.resolve(envelope: envelope, session: pushSession())

        #expect(resolved == .placeholder)
    }

    @Test("device registration and revocation map the server REST contract")
    func registrationRequestMapping() throws {
        let deviceID = UUID(uuidString: "00000000-0000-0000-0000-000000000099")!
        let request = try MomoPushRegistrationClient.registrationRequest(
            session: fixtureSession(),
            deviceID: deviceID,
            apnsToken: Data(repeating: 0xab, count: 32),
            appBuild: "42"
        )
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])

        #expect(request.httpMethod == "POST")
        #expect(request.url?.path.hasSuffix("/v1/workspaces/00000000-0000-0000-0000-000000000001/devices") == true)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access")
        #expect(json["deviceId"] as? String == deviceID.uuidString)
        #expect(json["platform"] as? String == "ios")
        #expect(json["appBuild"] as? String == "42")
        #expect(json["apnsToken"] as? String == String(repeating: "ab", count: 32))
        #expect(json["env"] as? String == "sandbox")
        #expect(json["topic"] as? String == "app.momo.ios")

        let revoke = MomoPushRegistrationClient.revocationRequest(session: fixtureSession(), deviceID: deviceID)
        #expect(revoke.httpMethod == "DELETE")
        #expect(revoke.url?.path.hasSuffix("/devices/\(deviceID.uuidString)") == true)
    }

    private static let payload = #"{"aps":{"alert":{"title":"momo","body":"새 알림"},"badge":1,"mutable-content":1,"content-available":1},"momo":{"schema":"momo.push.notification.v1","server_id":"server-a","workspace_id":"00000000-0000-0000-0000-000000000001","channel_id":"00000000-0000-0000-0000-000000000010","message_id":"00000000-0000-0000-0000-000000000020","collapse_id":"message-20","reason":"approval_request"}}"#

    private func pushSession() -> PushFetchSession {
        PushFetchSession(
            baseURL: URL(string: "https://momo.example")!,
            workspaceID: fixtureWorkspaceID.description,
            accessToken: "access-token"
        )
    }
}

private struct SuccessfulPushFetcher: PushMessageFetching {
    func fetch(envelope: MomoPushEnvelope, session: PushFetchSession) async throws -> PushDisplayContent {
        PushDisplayContent(title: "김인턴", body: "승인 요청을 확인해 주세요.")
    }
}

private struct FailingPushFetcher: PushMessageFetching {
    func fetch(envelope: MomoPushEnvelope, session: PushFetchSession) async throws -> PushDisplayContent {
        throw MomoPushError.fetchFailed
    }
}

@Suite("MomoiOSKit session")
struct SessionTests {
    @Test("session form validates and trims input")
    func formValidation() throws {
        let form = SessionForm(
            serverURL: "  http://127.0.0.1:28180  ",
            email: "  demo@momo.local  ",
            password: "dev-password",
            inviteCode: "  INVITE-1  "
        )
        let validated = try form.validated()
        #expect(validated.baseURL.absoluteString == "http://127.0.0.1:28180")
        #expect(validated.email == "demo@momo.local")
        #expect(validated.inviteCode == "INVITE-1")

        #expect(throws: SessionError.self) {
            try SessionForm(serverURL: "not a url").validated()
        }
        #expect(throws: SessionError.self) {
            try SessionForm(email: "invalid").validated()
        }
        #expect(throws: SessionError.self) {
            try SessionForm(password: "").validated()
        }
    }

    @Test("UserDefaults form and session round trip")
    func storeRoundTrip() throws {
        let suiteName = "MomoiOSKitTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = SessionStore(defaults: defaults, prefix: "test.")
        let form = SessionForm(serverURL: "https://momo.example", email: "dev@momo.local", password: "plain-dev", inviteCode: "CODE")
        let session = fixtureSession()

        store.save(form: form)
        store.save(session: session)
        #expect(store.loadForm() == form)
        #expect(store.loadSession() == session)

        store.clearSession()
        #expect(store.loadSession() == nil)
        #expect(store.loadForm() == form)
    }

    @Test("legacy standard defaults migrate to the App Group once")
    func appGroupMigration() throws {
        let groupName = "MomoiOSKitTests.group.\(UUID().uuidString)"
        let legacyName = "MomoiOSKitTests.legacy.\(UUID().uuidString)"
        let group = try #require(UserDefaults(suiteName: groupName))
        let legacy = try #require(UserDefaults(suiteName: legacyName))
        defer {
            group.removePersistentDomain(forName: groupName)
            legacy.removePersistentDomain(forName: legacyName)
        }
        let form = SessionForm(serverURL: "https://legacy.example", email: "legacy@momo.local")
        let session = fixtureSession()
        legacy.set(try JSONEncoder().encode(form), forKey: "momo.ios.dev.session.form")
        legacy.set(try JSONEncoder().encode(session), forKey: "momo.ios.dev.session.authenticated")
        let store = SessionStore(defaults: group, legacyDefaults: legacy)

        #expect(store.loadForm() == form)
        let pushData = try #require(group.data(forKey: MomoPushContract.sessionKey))
        let pushSession = try JSONDecoder().decode(PushFetchSession.self, from: pushData)
        #expect(pushSession.baseURL == session.baseURL)
        #expect(pushSession.workspaceID == session.workspaceID.description)
        #expect(pushSession.accessToken == session.accessToken)
        legacy.set(try JSONEncoder().encode(SessionForm()), forKey: "momo.ios.dev.session.form")
        let second = SessionStore(defaults: group, legacyDefaults: legacy)
        #expect(second.loadForm() == form)
    }

    @Test("bootstrap response maps workspace and channels")
    func bootstrapResponseMapping() throws {
        let workspaceData = Data(#"{"workspace":{"id":"00000000-0000-0000-0000-000000000001","slug":"momo","name":"momo Team","updatedAtMs":42}}"#.utf8)
        let channelsData = Data(#"{"channels":[{"id":"00000000-0000-0000-0000-000000000010","workspaceId":"00000000-0000-0000-0000-000000000001","kind":"public","name":"general","topic":null,"dmKey":null,"memberIds":[],"createdBy":"00000000-0000-0000-0000-000000000002","archivedAtMs":null}]}"#.utf8)

        let result = try MomoServerSessionClient.mapBootstrap(
            workspaceData: workspaceData,
            channelsData: channelsData
        )
        #expect(result.workspace.name == "momo Team")
        #expect(result.channels.count == 1)
        #expect(result.channels.first?.name == "general")
    }

    @Test("app model uses mock backend for login and bootstrap")
    @MainActor
    func mockBackendLogin() async throws {
        let suiteName = "MomoiOSKitTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = SessionStore(defaults: defaults, prefix: "model.")
        let bootstrap = WorkspaceBootstrap(
            workspace: Workspace(id: fixtureWorkspaceID, slug: "momo", name: "momo Team"),
            channels: [fixtureChannel()]
        )
        let model = MomoiOSAppModel(store: store, backend: MockBackend(session: fixtureSession(), bootstrap: bootstrap))

        await model.authenticate()

        guard case .signedIn(let session, let mapped) = model.phase else {
            Issue.record("Expected a signed-in phase")
            return
        }
        #expect(session.email == "demo@momo.local")
        #expect(mapped.workspace.name == "momo Team")
        #expect(mapped.channels.count == 1)
    }

    @Test("app model exposes an offline failure state")
    @MainActor
    func offlineFailure() async throws {
        let suiteName = "MomoiOSKitTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = MomoiOSAppModel(
            store: SessionStore(defaults: defaults, prefix: "offline."),
            backend: OfflineBackend()
        )

        await model.authenticate()

        #expect(model.phase == .signedOut)
        #expect(model.failureKind == .offline)
    }
}

@Suite("MomoiOSKit conversations")
struct ConversationTests {
    @Test("channel list maps channel mentions and DM unread from mock backend")
    @MainActor
    func channelListMapping() async throws {
        let dmID = ChannelID(uuidString: "00000000-0000-0000-0000-000000000011")!
        let teammateID = MemberID(uuidString: "00000000-0000-0000-0000-000000000003")!
        let channel = fixtureChannel()
        let dm = Channel(
            id: dmID,
            workspaceId: fixtureWorkspaceID,
            kind: .dm,
            dmMemberIds: [fixtureMemberID, teammateID]
        )
        let snapshot = IOSConversationSnapshot(
            channels: [dm, channel],
            members: [
                fixtureSession().member,
                Member(
                    id: teammateID,
                    workspaceId: fixtureWorkspaceID,
                    kind: .agent,
                    displayName: "김인턴 Research Agent",
                    handle: "hermes"
                ),
            ],
            readStates: [
                ChannelReadState(channelId: channel.id, lastReadSeq: 8, latestSeq: 13, unreadCount: 5, mentionCount: 2),
                ChannelReadState(channelId: dmID, lastReadSeq: 3, latestSeq: 10, unreadCount: 7, mentionCount: 1),
            ]
        )
        let model = IOSChannelListModel(
            currentMemberID: fixtureMemberID,
            backend: MockConversationBackend(snapshot: snapshot)
        )

        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.sections.channels.first?.badgeLabel == "2")
        #expect(model.sections.channels.first?.unreadCount == 5)
        #expect(model.sections.directMessages.first?.title == "김인턴 Research Agent")
        #expect(model.sections.directMessages.first?.badgeLabel == "7")
    }

    @Test("timeline history from mock backend is ordered by seq")
    @MainActor
    func timelineHistoryOrder() async {
        let channel = fixtureChannel()
        let backend = MockConversationBackend(
            snapshot: IOSConversationSnapshot(channels: [channel], members: [], readStates: []),
            history: [fixtureMessage(sequence: 4), fixtureMessage(sequence: 2)]
        )
        let model = IOSTimelineModel(channel: channel.id, currentMemberID: fixtureMemberID, backend: backend)

        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.messages.compactMap(\.seq) == [2, 4])
        model.stop()
    }

    @Test("timeline append keeps seq order and drops replay duplicates")
    func timelineAppendOrderAndDeduplication() {
        let channel = fixtureChannel().id
        let first = fixtureMessage(sequence: 1)
        let third = fixtureMessage(sequence: 3)
        let second = fixtureMessage(sequence: 2)
        var messages = IOSTimelineReducer.sorted([third, first])

        messages = IOSTimelineReducer.applying(.message(second), to: messages, channel: channel)
        messages = IOSTimelineReducer.applying(.message(second), to: messages, channel: channel)
        messages = IOSTimelineReducer.applying(
            .message(fixtureMessage(sequence: 2, idSeed: 99)),
            to: messages,
            channel: channel
        )

        #expect(messages.compactMap(\.seq) == [1, 2, 3])
        #expect(messages.count == 3)
    }

    @Test("unread badge caps large server counts")
    func unreadBadgeCap() {
        let sections = IOSChannelListMapper.sections(
            channels: [fixtureChannel()],
            members: [],
            readStates: [
                ChannelReadState(
                    channelId: fixtureChannel().id,
                    lastReadSeq: 1,
                    latestSeq: 151,
                    unreadCount: 150,
                    mentionCount: 120
                ),
            ],
            currentMemberID: fixtureMemberID
        )
        #expect(sections.channels.first?.badgeLabel == "99+")
    }

    @Test("optimistic send reconciles by client message ID")
    @MainActor
    func optimisticSendReconciliation() async {
        let backend = RecordingConversationBackend()
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        await model.load()
        model.composerDraft = "Ship the iOS reply path"

        await model.sendComposerDraft()

        let calls = await backend.sendCalls
        #expect(calls.count == 1)
        #expect(model.messages.count == 1)
        #expect(model.messages.first?.seq == 41)
        #expect(model.messages.first?.clientMsgId == calls.first?.clientMsgId)
        #expect(model.sendFailureMessage == nil)
    }

    @Test("failed send retries with the same idempotency key")
    @MainActor
    func failedSendRetry() async {
        let backend = RecordingConversationBackend(failFirstSend: true)
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        await model.load()
        model.composerDraft = "Retry this exact request"

        await model.sendComposerDraft()
        #expect(model.messages.first?.state == .failed)
        #expect(model.sendFailureMessage != nil)
        await model.retryFailedSend()

        let calls = await backend.sendCalls
        #expect(calls.count == 2)
        #expect(calls[0].clientMsgId == calls[1].clientMsgId)
        #expect(model.messages.count == 1)
        #expect(model.messages.first?.seq == 41)
        #expect(model.sendFailureMessage == nil)
    }

    @Test("reply send preserves the quoted message field")
    @MainActor
    func replySend() async {
        let backend = RecordingConversationBackend()
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        await model.load()
        let quoted = fixtureMessage(sequence: 7)
        model.selectReply(to: quoted)
        model.composerDraft = "Proceed with the reviewed plan"

        await model.sendComposerDraft()

        let call = await backend.sendCalls.first
        #expect(call?.draft.replyToId == quoted.id)
        #expect(call?.draft.props["reply_to_id"]?.stringValue == quoted.id.description)
        #expect(model.messages.first?.replyToId == quoted.id)
    }

    @Test("approval retry preserves decision ID and updates card status")
    @MainActor
    func approvalDecisionRetry() async {
        let backend = RecordingConversationBackend(failFirstApproval: true)
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        let approval = fixtureApprovalMessage()
        await backend.setHistory([approval])
        await model.load()

        await model.decideApproval(approval, approve: true)
        guard let approvalID = IOSTimelineModel.approvalID(for: approval) else {
            Issue.record("Expected an approval ID")
            return
        }
        #expect(model.approvalDecisionFailures.contains(approvalID))
        await model.retryApprovalDecision(for: approval)

        let calls = await backend.approvalCalls
        #expect(calls.count == 2)
        #expect(calls[0].clientDecisionId == calls[1].clientDecisionId)
        #expect(model.approvalStatus(for: model.messages[0]) == .approved)
        #expect(!model.approvalDecisionFailures.contains(approvalID))
        model.stop()
    }
}

private struct MockBackend: SessionBackend {
    let session: IOSSession
    let bootstrap: WorkspaceBootstrap

    func authenticate(form: SessionForm) async throws -> IOSSession { session }
    func bootstrap(session: IOSSession) async throws -> WorkspaceBootstrap { bootstrap }
}

private struct OfflineBackend: SessionBackend {
    func authenticate(form: SessionForm) async throws -> IOSSession {
        throw SessionError.transport("offline")
    }

    func bootstrap(session: IOSSession) async throws -> WorkspaceBootstrap {
        throw SessionError.transport("offline")
    }
}

private struct MockConversationBackend: IOSConversationBackend {
    let snapshotValue: IOSConversationSnapshot
    let historyValue: [Message]

    init(snapshot: IOSConversationSnapshot, history: [Message] = []) {
        self.snapshotValue = snapshot
        self.historyValue = history
    }

    func snapshot() async throws -> IOSConversationSnapshot { snapshotValue }

    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] {
        historyValue
    }

    func markRead(channel: ChannelID, through sequence: Int64) async throws {}

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        AsyncStream { $0.finish() }
    }

    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        AsyncStream { continuation in
            continuation.yield(.restFallback(channel: channel))
            continuation.finish()
        }
    }

    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        fixtureMessage(sequence: 1)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        ApprovalDecisionReceipt(approvalId: request.approvalId, status: request.status)
    }
}

private actor RecordingConversationBackend: IOSConversationBackend {
    struct SendCall: Sendable {
        let draft: DraftMessage
        let clientMsgId: UUID
    }

    private var historyValue: [Message] = []
    private let failFirstSend: Bool
    private let failFirstApproval: Bool
    private(set) var sendCalls: [SendCall] = []
    private(set) var approvalCalls: [ApprovalDecisionRequest] = []

    init(failFirstSend: Bool = false, failFirstApproval: Bool = false) {
        self.failFirstSend = failFirstSend
        self.failFirstApproval = failFirstApproval
    }

    func setHistory(_ messages: [Message]) { historyValue = messages }
    func snapshot() async throws -> IOSConversationSnapshot {
        IOSConversationSnapshot(channels: [fixtureChannel()], members: [], readStates: [])
    }
    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] { historyValue }
    func markRead(channel: ChannelID, through sequence: Int64) async throws {}
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> { AsyncStream { $0.finish() } }
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        AsyncStream { $0.finish() }
    }
    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        sendCalls.append(SendCall(draft: draft, clientMsgId: clientMsgId))
        if failFirstSend, sendCalls.count == 1 { throw SessionError.transport("offline") }
        let now: Int64 = 41
        return Message(
            id: MessageID(uuidString: "00000000-0000-0000-0001-000000000041")!,
            channelId: draft.channelId,
            seq: 41,
            hlcTs: now,
            authorMemberId: fixtureMemberID,
            type: draft.type,
            body: draft.body,
            props: draft.props,
            replyToId: draft.replyToId,
            clientMsgId: clientMsgId,
            createdAtMs: now
        )
    }
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        approvalCalls.append(request)
        if failFirstApproval, approvalCalls.count == 1 { throw SessionError.transport("offline") }
        return ApprovalDecisionReceipt(approvalId: request.approvalId, status: request.status)
    }
}

private func fixtureSession() -> IOSSession {
    IOSSession(
        baseURL: URL(string: "http://127.0.0.1:28180")!,
        workspaceID: fixtureWorkspaceID,
        member: Member(
            id: fixtureMemberID,
            workspaceId: fixtureWorkspaceID,
            kind: .human,
            displayName: "Demo User",
            handle: "demo"
        ),
        accessToken: "access",
        refreshToken: "refresh",
        realtimeWebSocketURL: URL(string: "ws://127.0.0.1:28000/connection/websocket"),
        email: "demo@momo.local"
    )
}

private func fixtureChannel() -> Channel {
    Channel(
        id: ChannelID(uuidString: "00000000-0000-0000-0000-000000000010")!,
        workspaceId: fixtureWorkspaceID,
        kind: .publicChannel,
        name: "general"
    )
}

private func fixtureMessage(sequence: Int64, idSeed: Int64? = nil) -> Message {
    let seed = idSeed ?? sequence
    let suffix = String(format: "%012lld", seed)
    return Message(
        id: MessageID(uuidString: "00000000-0000-0000-0001-\(suffix)")!,
        channelId: fixtureChannel().id,
        seq: sequence,
        hlcTs: sequence,
        authorMemberId: fixtureMemberID,
        body: "긴 한국어와 English가 함께 있는 메시지로 세 줄 레이아웃을 검증합니다. Timeline content stays readable at larger Dynamic Type sizes."
    )
}

private func fixtureApprovalMessage() -> Message {
    Message(
        id: MessageID(uuidString: "00000000-0000-0000-0001-000000000088")!,
        channelId: fixtureChannel().id,
        seq: 8,
        hlcTs: 8,
        authorMemberId: fixtureMemberID,
        type: .approvalRequest,
        body: "Deploy the production migration after reviewing the rollback plan.",
        props: [
            "approval_id": "00000000-0000-0000-0002-000000000001",
            "approval_status": "pending",
            "action_type": "deploy",
            "is_reversible": false,
        ]
    )
}

private let fixtureWorkspaceID = WorkspaceID(uuidString: "00000000-0000-0000-0000-000000000001")!
private let fixtureMemberID = MemberID(uuidString: "00000000-0000-0000-0000-000000000002")!
