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

    @MainActor
    @Test("pending deep link is consumed exactly once for the signed-in workspace")
    func pendingDeepLinkConsumption() throws {
        let router = IOSPushDeepLinkRouter()
        let link = try #require(IOSPushDeepLink(url: Self.deepLinkURL))

        router.route(link: link)

        #expect(router.pending == link)
        #expect(router.consumePending(for: link.workspaceID) == link)
        #expect(router.pending == nil)
        #expect(router.consumePending(for: link.workspaceID) == nil)
    }

    @MainActor
    @Test("pending deep link waits for login before consumption")
    func pendingDeepLinkWaitsForLogin() throws {
        let router = IOSPushDeepLinkRouter()
        let link = try #require(IOSPushDeepLink(url: Self.deepLinkURL))

        router.route(link: link)

        #expect(router.consumePending(for: nil) == nil)
        #expect(router.pending == link)
        #expect(router.consumePending(for: link.workspaceID) == link)
        #expect(router.pending == nil)
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
            appBuild: "42",
            environment: .sandbox
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

    @Test("APNs entitlement values map to server registration environments")
    func registrationEnvironmentMapping() {
        #expect(APNSRegistrationEnvironment.from(apsEnvironment: "development") == .sandbox)
        #expect(APNSRegistrationEnvironment.from(apsEnvironment: "production") == .production)
    }

    @Test("device registration propagates a backend 4xx response")
    func registrationFailurePropagation() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FailingRegistrationURLProtocol.self]
        let client = MomoPushRegistrationClient(urlSession: URLSession(configuration: configuration))

        await #expect(throws: SessionError.server(status: 422, message: "invalid push token")) {
            try await client.register(
                session: fixtureSession(),
                deviceID: UUID(),
                apnsToken: Data(repeating: 0xcd, count: 32),
                appBuild: "42",
                environment: .sandbox
            )
        }
    }

    private static let payload = #"{"aps":{"alert":{"title":"momo","body":"새 알림"},"badge":1,"mutable-content":1,"content-available":1},"momo":{"schema":"momo.push.notification.v1","server_id":"server-a","workspace_id":"00000000-0000-0000-0000-000000000001","channel_id":"00000000-0000-0000-0000-000000000010","message_id":"00000000-0000-0000-0000-000000000020","collapse_id":"message-20","reason":"approval_request"}}"#
    private static let deepLinkURL = URL(
        string: "momo://push/workspaces/00000000-0000-0000-0000-000000000001/channels/00000000-0000-0000-0000-000000000010/messages/00000000-0000-0000-0000-000000000020"
    )!

    private func pushSession() -> PushFetchSession {
        PushFetchSession(
            baseURL: URL(string: "https://momo.example")!,
            workspaceID: fixtureWorkspaceID.description,
            accessToken: "access-token"
        )
    }
}

private final class FailingRegistrationURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: 422,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
              )
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("invalid push token".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
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
                    handle: "hermes",
                    presence: .working
                ),
            ],
            readStates: [
                ChannelReadState(channelId: channel.id, lastReadSeq: 8, latestSeq: 13, unreadCount: 5, mentionCount: 2),
                ChannelReadState(channelId: dmID, lastReadSeq: 3, latestSeq: 10, unreadCount: 7, mentionCount: 1),
            ],
            channelMuteStates: [channel.id: true],
            memberPresenceStates: [teammateID: .working]
        )
        let model = IOSChannelListModel(
            currentMemberID: fixtureMemberID,
            backend: MockConversationBackend(snapshot: snapshot)
        )

        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.sections.channels.first?.badgeLabel == "2")
        #expect(model.sections.channels.first?.unreadCount == 5)
        #expect(model.sections.channels.first?.latestSequence == 13)
        #expect(model.sections.channels.first?.isMuted == true)
        #expect(model.sections.directMessages.first?.title == "김인턴 Research Agent")
        #expect(model.sections.directMessages.first?.badgeLabel == "7")
        #expect(model.sections.directMessages.first?.directMessagePresence == .working)
        #expect(model.totalMentionCount == 3)
    }

    @Test("channel search filters channels and direct messages without changing source order")
    func channelSearch() {
        let directMessage = IOSChannelListItem(
            channel: Channel(
                id: ChannelID(),
                workspaceId: fixtureWorkspaceID,
                kind: .dm
            ),
            title: "김인턴 Research Agent",
            unreadCount: 0,
            mentionCount: 0
        )
        let general = IOSChannelListItem(
            channel: fixtureChannel(),
            title: "general",
            unreadCount: 0,
            mentionCount: 0
        )

        #expect(IOSChannelSearch.filter([general, directMessage], query: "  research ") == [directMessage])
        #expect(IOSChannelSearch.filter([general, directMessage], query: "") == [general, directMessage])
        #expect(IOSAppTab.allCases == [.home, .search, .activity, .work, .profile])
    }

    @Test("channel mute and mark-read actions use server projections")
    @MainActor
    func channelActions() async {
        let channel = fixtureChannel()
        let snapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [
                ChannelReadState(
                    channelId: channel.id,
                    lastReadSeq: 8,
                    latestSeq: 13,
                    unreadCount: 5,
                    mentionCount: 2
                ),
            ]
        )
        let backend = RecordingConversationBackend(snapshot: snapshot)
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        await model.setChannelMuted(channel.id, muted: true)
        await model.markRead(channel.id)

        #expect(model.sections.channels.first?.isMuted == true)
        #expect(model.sections.channels.first?.unreadCount == 0)
        #expect(model.sections.channels.first?.mentionCount == 0)
        #expect(await backend.muteCalls == [.init(channel: channel.id, muted: true)])
        #expect(await backend.markReadCalls == [.init(channel: channel.id, sequence: 13)])
        #expect(model.actionFailureMessage == nil)
    }

    @Test("failed channel action restores the projected state")
    @MainActor
    func channelActionRollback() async {
        let channel = fixtureChannel()
        let snapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [],
            channelMuteStates: [channel.id: false]
        )
        let backend = RecordingConversationBackend(snapshot: snapshot, failFirstMute: true)
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        await model.setChannelMuted(channel.id, muted: true)

        #expect(model.sections.channels.first?.isMuted == false)
        #expect(model.actionFailureMessage != nil)
    }

    @Test("failed mark-read restores unread and mention counts")
    @MainActor
    func markReadRollback() async {
        let channel = fixtureChannel()
        let snapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [
                ChannelReadState(
                    channelId: channel.id,
                    lastReadSeq: 8,
                    latestSeq: 13,
                    unreadCount: 5,
                    mentionCount: 2
                ),
            ]
        )
        let backend = RecordingConversationBackend(snapshot: snapshot, failFirstRead: true)
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        await model.markRead(channel.id)

        #expect(model.sections.channels.first?.unreadCount == 5)
        #expect(model.sections.channels.first?.mentionCount == 2)
        #expect(await backend.markReadCalls == [.init(channel: channel.id, sequence: 13)])
        #expect(model.actionFailureMessage != nil)
    }

    @Test("failed mark-read keeps a newer read projection received during the request")
    @MainActor
    func markReadFailureAfterRefresh() async {
        let channel = fixtureChannel()
        let initialSnapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [
                ChannelReadState(
                    channelId: channel.id,
                    lastReadSeq: 8,
                    latestSeq: 13,
                    unreadCount: 5,
                    mentionCount: 2
                ),
            ]
        )
        let refreshedSnapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [
                ChannelReadState(
                    channelId: channel.id,
                    lastReadSeq: 8,
                    latestSeq: 14,
                    unreadCount: 6,
                    mentionCount: 3
                ),
            ]
        )
        let backend = SuspendedReadConversationBackend(
            initialSnapshot: initialSnapshot,
            refreshedSnapshot: refreshedSnapshot
        )
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        let mutation = Task { await model.markRead(channel.id) }
        await backend.waitUntilReadStarts()
        await model.refresh()

        #expect(model.sections.channels.first?.latestSequence == 13)
        #expect(model.sections.channels.first?.unreadCount == 0)

        await backend.failRead()
        await mutation.value

        #expect(model.sections.channels.first?.latestSequence == 14)
        #expect(model.sections.channels.first?.unreadCount == 6)
        #expect(model.sections.channels.first?.mentionCount == 3)
        #expect(model.actionFailureMessage != nil)
    }

    @Test("channel list ignores stale read responses that arrive out of order")
    @MainActor
    func staleReadResponseIsIgnored() async {
        let channel = fixtureChannel()
        let model = IOSChannelListModel(
            currentMemberID: fixtureMemberID,
            backend: MockConversationBackend(
                snapshot: IOSConversationSnapshot(
                    channels: [channel],
                    members: [],
                    readStates: [
                        ChannelReadState(
                            channelId: channel.id,
                            lastReadSeq: 8,
                            latestSeq: 13,
                            unreadCount: 5,
                            mentionCount: 2
                        ),
                    ]
                )
            )
        )
        await model.load()

        model.applyReadState(ChannelReadState(
            channelId: channel.id,
            lastReadSeq: 14,
            latestSeq: 14,
            unreadCount: 0,
            mentionCount: 0
        ))
        model.applyReadState(ChannelReadState(
            channelId: channel.id,
            lastReadSeq: 13,
            latestSeq: 13,
            unreadCount: 1,
            mentionCount: 1
        ))

        #expect(model.sections.channels.first?.latestSequence == 14)
        #expect(model.sections.channels.first?.unreadCount == 0)
        #expect(model.sections.channels.first?.mentionCount == 0)
    }

    @Test("a newer refresh wins over a read callback received while refresh was waiting")
    @MainActor
    func newerRefreshWinsOverCallback() async {
        let channel = fixtureChannel()
        let initialSnapshot = readSnapshot(
            channel: channel,
            lastRead: 8,
            latest: 13,
            unread: 5,
            mentions: 2
        )
        let refreshedSnapshot = readSnapshot(
            channel: channel,
            lastRead: 13,
            latest: 14,
            unread: 1,
            mentions: 1
        )
        let backend = SuspendedMuteConversationBackend(
            initialSnapshot: initialSnapshot,
            refreshedSnapshot: refreshedSnapshot,
            suspendsRefresh: true
        )
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        let refresh = Task { await model.refresh() }
        await backend.waitUntilRefreshStarts()
        model.applyReadState(ChannelReadState(
            channelId: channel.id,
            lastReadSeq: 13,
            latestSeq: 13,
            unreadCount: 0,
            mentionCount: 0
        ))
        await backend.finishRefresh()
        await refresh.value

        #expect(model.sections.channels.first?.latestSequence == 14)
        #expect(model.sections.channels.first?.unreadCount == 1)
        #expect(model.sections.channels.first?.mentionCount == 1)
    }

    @Test("crossed read projections trigger one canonical refresh")
    @MainActor
    func crossedReadProjectionReconciles() async {
        let channel = fixtureChannel()
        let backend = SuspendedMuteConversationBackend(
            initialSnapshot: readSnapshot(
                channel: channel,
                lastRead: 8,
                latest: 13,
                unread: 5,
                mentions: 2
            ),
            refreshedSnapshot: readSnapshot(
                channel: channel,
                lastRead: 8,
                latest: 14,
                unread: 6,
                mentions: 3
            ),
            reconciliationSnapshot: readSnapshot(
                channel: channel,
                lastRead: 13,
                latest: 14,
                unread: 1,
                mentions: 1
            ),
            suspendsRefresh: true
        )
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        let refresh = Task { await model.refresh() }
        await backend.waitUntilRefreshStarts()
        model.applyReadState(ChannelReadState(
            channelId: channel.id,
            lastReadSeq: 13,
            latestSeq: 13,
            unreadCount: 0,
            mentionCount: 0
        ))
        await backend.finishRefresh()
        await refresh.value

        #expect(await backend.snapshotCalls == 3)
        #expect(model.sections.channels.first?.latestSequence == 14)
        #expect(model.sections.channels.first?.unreadCount == 1)
        #expect(model.sections.channels.first?.mentionCount == 1)
    }

    @Test("refresh preserves an in-flight mute until the server response arrives")
    @MainActor
    func refreshDuringMute() async {
        let channel = fixtureChannel()
        let initialSnapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [
                ChannelReadState(
                    channelId: channel.id,
                    lastReadSeq: 0,
                    latestSeq: 1,
                    unreadCount: 1,
                    mentionCount: 0
                ),
            ],
            channelMuteStates: [channel.id: false]
        )
        let refreshedSnapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [
                ChannelReadState(
                    channelId: channel.id,
                    lastReadSeq: 0,
                    latestSeq: 7,
                    unreadCount: 7,
                    mentionCount: 2
                ),
            ],
            channelMuteStates: [channel.id: false]
        )
        let backend = SuspendedMuteConversationBackend(
            initialSnapshot: initialSnapshot,
            refreshedSnapshot: refreshedSnapshot
        )
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        let mutation = Task { await model.setChannelMuted(channel.id, muted: true) }
        await backend.waitUntilMuteStarts()
        await model.refresh()

        #expect(model.sections.channels.first?.isMuted == true)
        #expect(model.sections.channels.first?.unreadCount == 7)
        #expect(model.sections.channels.first?.mentionCount == 2)

        await backend.finishMute()
        await mutation.value
        #expect(model.sections.channels.first?.isMuted == true)
    }

    @Test("a late refresh cannot overwrite a completed mute")
    @MainActor
    func lateRefreshAfterMute() async {
        let channel = fixtureChannel()
        let snapshot = IOSConversationSnapshot(
            channels: [channel],
            members: [],
            readStates: [],
            channelMuteStates: [channel.id: false]
        )
        let backend = SuspendedMuteConversationBackend(
            initialSnapshot: snapshot,
            refreshedSnapshot: snapshot,
            suspendsRefresh: true
        )
        let model = IOSChannelListModel(currentMemberID: fixtureMemberID, backend: backend)
        await model.load()

        let refresh = Task { await model.refresh() }
        await backend.waitUntilRefreshStarts()
        let mutation = Task { await model.setChannelMuted(channel.id, muted: true) }
        await backend.waitUntilMuteStarts()
        await backend.finishMute()
        await mutation.value

        await backend.finishRefresh()
        await refresh.value

        #expect(model.sections.channels.first?.isMuted == true)
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

    @Test("timeline layout groups adjacent authors within five minutes and inserts dates")
    func timelineV2Layout() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        let base = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 20,
            hour: 12
        )))
        let baseMs = Int64(base.timeIntervalSince1970 * 1_000)
        let otherMemberID = try #require(MemberID(uuidString: "00000000-0000-0000-0000-000000000099"))

        var first = fixtureMessage(sequence: 1)
        first.createdAtMs = baseMs
        var continuation = fixtureMessage(sequence: 2)
        continuation.createdAtMs = baseMs + 4 * 60 * 1_000
        continuation.props = [
            "mention_member_ids": .array([.string(fixtureMemberID.description)])
        ]
        var outsideWindow = fixtureMessage(sequence: 3)
        outsideWindow.createdAtMs = continuation.createdAtMs! + 6 * 60 * 1_000
        var otherAuthor = fixtureMessage(sequence: 4)
        otherAuthor.createdAtMs = outsideWindow.createdAtMs! + 60 * 1_000
        otherAuthor.authorMemberId = otherMemberID
        var nextDay = fixtureMessage(sequence: 5)
        nextDay.createdAtMs = baseMs + 24 * 60 * 60 * 1_000

        let rows = IOSTimelineLayout.rows(
            for: [first, continuation, outsideWindow, otherAuthor, nextDay],
            currentMemberID: fixtureMemberID,
            calendar: calendar
        )
        let messageRows = rows.compactMap { row -> (MessageID, Bool, Bool)? in
            guard case .message(let message, let startsGroup, let mentionsMember, _) = row.content else {
                return nil
            }
            return (message.id, startsGroup, mentionsMember)
        }

        #expect(rows.filter { if case .date = $0.content { true } else { false } }.count == 2)
        #expect(messageRows.map(\.1) == [true, false, true, true, true])
        #expect(messageRows.map(\.2) == [false, true, false, false, false])
        #expect(Set(messageRows.map(\.0)).count == 5)
    }

    @Test("timeline presentation precomputes stable rows for more than two hundred messages")
    func timelineV2LargeHistory() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        let base = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 20,
            hour: 9
        )))
        let baseMs = Int64(base.timeIntervalSince1970 * 1_000)
        let messages = (1...205).map { sequence -> Message in
            var message = fixtureMessage(sequence: Int64(sequence))
            message.createdAtMs = baseMs + Int64(sequence) * 10_000
            return message
        }

        let rows = IOSTimelineLayout.rows(
            for: messages,
            currentMemberID: fixtureMemberID,
            calendar: calendar
        )
        let messageIDs = rows.compactMap { row -> MessageID? in
            guard case .message(let message, _, _, _) = row.content else { return nil }
            return message.id
        }

        #expect(rows.count == 206)
        #expect(messageIDs.count == 205)
        #expect(Set(messageIDs).count == 205)
    }

    @Test("timeline body separates fenced code from link prose")
    func timelineV2BodyParsing() throws {
        let segments = IOSMessageBodyParser.segments(in: """
        Review the [message contract](https://momo.example/docs).
        ```swift
        let state = MessageState.edited
        ```
        """)

        #expect(segments.count == 2)
        #expect(segments[0].kind == .prose)
        #expect(segments[0].text.contains("https://momo.example/docs"))
        #expect(segments[1].kind == .code(language: "swift"))
        #expect(segments[1].text == "let state = MessageState.edited")
    }

    @Test("iOS history DTO preserves edited and deleted projections")
    func timelineV2HistoryProjection() throws {
        let editedData = Data("""
        {
          "id": "00000000-0000-0000-0001-000000000071",
          "channelId": "00000000-0000-0000-0000-000000000010",
          "seq": 71,
          "hlcTs": 1710000000000,
          "hlcCount": 0,
          "authorMemberId": "00000000-0000-0000-0000-000000000002",
          "type": "text",
          "body": "Updated deployment note",
          "props": {},
          "clientMsgId": null,
          "createdAtMs": 1710000000000,
          "thread": null,
          "state": "edited",
          "editedAtMs": 1710000005000,
          "deletedAtMs": null
        }
        """.utf8)
        let deletedData = Data("""
        {
          "id": "00000000-0000-0000-0001-000000000072",
          "channelId": "00000000-0000-0000-0000-000000000010",
          "seq": 72,
          "hlcTs": 1710000001000,
          "hlcCount": 0,
          "authorMemberId": "00000000-0000-0000-0000-000000000002",
          "type": "text",
          "body": null,
          "props": {},
          "clientMsgId": null,
          "createdAtMs": 1710000001000,
          "thread": null,
          "state": "deleted",
          "editedAtMs": null,
          "deletedAtMs": 1710000006000
        }
        """.utf8)

        let edited = try JSONDecoder().decode(IOSMessageDTO.self, from: editedData).value()
        let deleted = try JSONDecoder().decode(IOSMessageDTO.self, from: deletedData).value()

        #expect(edited.state == .edited)
        #expect(edited.editedAtMs == 1_710_000_005_000)
        #expect(!edited.isDeleted)
        #expect(deleted.state == .deleted)
        #expect(deleted.deletedAtMs == 1_710_000_006_000)
        #expect(deleted.isDeleted)
        #expect(deleted.body == nil)
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

    @Test("interaction sheet actions fail closed for pending messages and restrict author actions")
    @MainActor
    func interactionSheetAvailability() async throws {
        let backend = InteractionConversationBackend(message: fixtureMessage(sequence: 51))
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        await model.load()
        let ownMessage = try #require(model.messages.first)
        var otherMessage = ownMessage
        otherMessage.authorMemberId = MemberID(uuidString: "00000000-0000-0000-0000-000000000099")!
        var pendingMessage = ownMessage
        pendingMessage.seq = nil

        #expect(model.availableInteractionActions(for: ownMessage) == [.react, .reply, .edit, .delete, .copy])
        #expect(model.availableInteractionActions(for: otherMessage) == [.react, .reply, .copy])
        #expect(model.availableInteractionActions(for: pendingMessage).isEmpty)
        #expect(!model.canPresentInteractionSheet(for: pendingMessage))
        model.stop()
    }

    @Test("reaction toggle waits for the authoritative response and guards duplicate requests")
    @MainActor
    func reactionToggleRoundTrip() async throws {
        let message = fixtureMessage(sequence: 52)
        let backend = InteractionConversationBackend(message: message, suspendsReaction: true)
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        await model.load()

        let firstToggle = Task { await model.toggleReaction("👍", on: message) }
        await backend.waitUntilReactionStarts()
        #expect(model.reactions(for: message).isEmpty)
        #expect(model.isReactionMutationInFlight(message: message, emoji: "👍"))
        await model.toggleReaction("👍", on: message)
        #expect(await backend.reactionCallCount == 1)

        await backend.finishReaction()
        await firstToggle.value
        #expect(model.reactions(for: message).first?.count == 1)
        #expect(model.reactions(for: message).first?.isSelectedByCurrentMember == true)
        #expect(!model.isReactionMutationInFlight(message: message, emoji: "👍"))
        model.stop()
    }

    @Test("realtime edit delete and reaction deltas update the interaction projection")
    @MainActor
    func realtimeMessageInteractions() async throws {
        let message = fixtureMessage(sequence: 53)
        let backend = InteractionConversationBackend(message: message)
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        await model.load()
        var edited = message
        edited.body = "수정 완료 / Edited remotely"
        edited.state = .edited
        edited.editedAtMs = 99

        await model.consumeRealtimeEvent(.messageEdited(edited))
        await model.consumeRealtimeEvent(.reaction(ReactionDelta(
            action: .added,
            messageId: message.id,
            memberId: fixtureMemberID,
            emoji: "🎉"
        )))
        #expect(model.messages.first?.body == "수정 완료 / Edited remotely")
        #expect(model.reactions(for: message).first?.emoji == "🎉")

        await model.consumeRealtimeEvent(.reaction(ReactionDelta(
            action: .removed,
            messageId: message.id,
            memberId: fixtureMemberID,
            emoji: "🎉"
        )))
        #expect(model.reactions(for: message).isEmpty)
        await model.consumeRealtimeEvent(.messageDeleted(message.id))
        #expect(model.messages.first?.isDeleted == true)
        #expect(model.reactions(for: message).isEmpty)
        model.stop()
    }

    @Test("reaction REST DTO decodes the server camel-case response")
    func reactionRESTProjection() throws {
        let data = Data("""
        {
          "action": "added",
          "messageId": "00000000-0000-0000-0001-000000000053",
          "memberId": "00000000-0000-0000-0000-000000000002",
          "emoji": "👍"
        }
        """.utf8)

        let delta = try JSONDecoder().decode(IOSReactionDeltaDTO.self, from: data).value()

        #expect(delta.action == .added)
        #expect(delta.messageId == MessageID(uuidString: "00000000-0000-0000-0001-000000000053"))
        #expect(delta.memberId == fixtureMemberID)
        #expect(delta.emoji == "👍")
    }

    @Test("cold load restores the server reaction snapshot")
    @MainActor
    func reactionColdLoad() async throws {
        let message = fixtureMessage(sequence: 55)
        let teammateID = MemberID(uuidString: "00000000-0000-0000-0000-000000000099")!
        let backend = InteractionConversationBackend(
            message: message,
            reactionSnapshot: [message.id: ["👀": [fixtureMemberID, teammateID]]]
        )
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )

        await model.load()

        let reaction = try #require(model.reactions(for: message).first)
        #expect(reaction.emoji == "👀")
        #expect(reaction.count == 2)
        #expect(reaction.isSelectedByCurrentMember)
        model.stop()
    }

    @Test("author edit and delete apply only server-returned messages")
    @MainActor
    func editAndDeleteRoundTrip() async throws {
        let message = fixtureMessage(sequence: 54)
        let backend = InteractionConversationBackend(message: message)
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: backend
        )
        await model.load()

        #expect(await model.editMessage(message, body: "서버 확정 수정 / Server confirmed edit"))
        let edited = try #require(model.messages.first)
        #expect(edited.body == "서버 확정 수정 / Server confirmed edit")
        #expect(edited.state == .edited)
        #expect(await model.deleteMessage(edited))
        #expect(model.messages.first?.isDeleted == true)
        #expect(model.messages.first?.body == nil)
        #expect(await backend.editCallCount == 1)
        #expect(await backend.deleteCallCount == 1)
        model.stop()
    }
}

@Suite("iOS huddle")
struct IOSHuddleTests {
    @Test("timeline consumes the typed huddle event")
    @MainActor
    func timelineConsumesHuddleEvent() async {
        let huddle = fixtureHuddle()
        let service = RecordingHuddleService(activeHuddle: huddle)
        let model = IOSTimelineModel(
            channel: fixtureChannel().id,
            currentMemberID: fixtureMemberID,
            backend: MockConversationBackend(
                snapshot: IOSConversationSnapshot(channels: [fixtureChannel()], members: [], readStates: [])
            ),
            workspace: fixtureWorkspaceID,
            huddleService: service,
            huddleAudioSession: RecordingHuddleAudioSession(),
            microphonePermission: FixedMicrophonePermission(granted: true)
        )

        await model.consumeRealtimeEvent(.huddle(HuddleDelta(
            action: .started,
            huddleId: huddle.id,
            channelId: fixtureChannel().id,
            participantMemberIds: [fixtureMemberID]
        )))

        #expect(model.huddle.activeHuddle?.id == huddle.id)
        #expect(model.huddle.participantCount == 1)
    }

    @Test("join mute and leave preserve the audio lifecycle")
    @MainActor
    func joinMuteAndLeave() async {
        let huddle = fixtureHuddle()
        let service = RecordingHuddleService(activeHuddle: huddle)
        let audio = RecordingHuddleAudioSession()
        let model = IOSHuddleModel(
            workspace: fixtureWorkspaceID,
            channel: fixtureChannel().id,
            service: service,
            audioSession: audio,
            permissionAuthorizer: FixedMicrophonePermission(granted: true)
        )

        await model.activate()
        await model.join()
        #expect(model.state == .joined)
        #expect(model.isJoined)

        await model.toggleMicrophone()
        #expect(model.isMicrophoneMuted)

        await model.leave()
        #expect(model.state == .idle)
        #expect(!model.isJoined)
        #expect(await service.leaveCalls == [huddle.id])
        #expect(await audio.disconnectCount == 1)
        #expect(await audio.muteValues == [true])
    }

    @Test("microphone denial is an explicit state and does not join")
    @MainActor
    func microphoneDenied() async {
        let service = RecordingHuddleService(activeHuddle: fixtureHuddle())
        let model = IOSHuddleModel(
            workspace: fixtureWorkspaceID,
            channel: fixtureChannel().id,
            service: service,
            audioSession: RecordingHuddleAudioSession(),
            permissionAuthorizer: FixedMicrophonePermission(granted: false)
        )

        await model.activate()
        await model.join()

        #expect(model.state == .permissionDenied)
        #expect(await service.joinCount == 0)
    }

    @Test("server 503 hides the active huddle")
    @MainActor
    func unconfiguredServer() async {
        let model = IOSHuddleModel(
            workspace: fixtureWorkspaceID,
            channel: fixtureChannel().id,
            service: UnconfiguredHuddleService(),
            audioSession: RecordingHuddleAudioSession(),
            permissionAuthorizer: FixedMicrophonePermission(granted: true)
        )

        await model.activate()

        #expect(model.state == .unavailable)
        #expect(model.activeHuddle == nil)
    }

    @Test("shutdown leaves the server and disconnects audio")
    @MainActor
    func shutdownLifecycle() async {
        let huddle = fixtureHuddle()
        let service = RecordingHuddleService(activeHuddle: huddle)
        let audio = RecordingHuddleAudioSession()
        let model = IOSHuddleModel(
            workspace: fixtureWorkspaceID,
            channel: fixtureChannel().id,
            service: service,
            audioSession: audio,
            permissionAuthorizer: FixedMicrophonePermission(granted: true)
        )

        await model.activate()
        await model.join()
        await model.shutdown()

        #expect(await service.leaveCalls == [huddle.id])
        #expect(await audio.disconnectCount == 1)
        #expect(!model.isJoined)
    }
}

private struct MockBackend: SessionBackend {
    let session: IOSSession
    let bootstrap: WorkspaceBootstrap

    func authenticate(form: SessionForm) async throws -> IOSSession { session }
    func bootstrap(session: IOSSession) async throws -> WorkspaceBootstrap { bootstrap }
}

private struct FixedMicrophonePermission: IOSMicrophonePermissionAuthorizing {
    let granted: Bool
    func requestPermission() async -> Bool { granted }
}

private actor RecordingHuddleService: IOSHuddleService {
    let activeHuddle: IOSHuddle?
    private(set) var joinCount = 0
    private(set) var leaveCalls: [UUID] = []

    init(activeHuddle: IOSHuddle?) {
        self.activeHuddle = activeHuddle
    }

    func active(workspace: WorkspaceID, channel: ChannelID) async throws -> IOSHuddle? { activeHuddle }

    func join(workspace: WorkspaceID, huddle: UUID) async throws -> IOSHuddleJoin {
        joinCount += 1
        return IOSHuddleJoin(
            huddle: activeHuddle!,
            liveKitURL: URL(string: "wss://livekit.example.test")!,
            token: "test-token",
            expiresAt: Date().addingTimeInterval(3_600)
        )
    }

    func leave(workspace: WorkspaceID, huddle: UUID) async throws {
        leaveCalls.append(huddle)
    }
}

private struct UnconfiguredHuddleService: IOSHuddleService {
    func active(workspace: WorkspaceID, channel: ChannelID) async throws -> IOSHuddle? {
        throw IOSHuddleClientError.http(503, "Huddles are not configured")
    }
    func join(workspace: WorkspaceID, huddle: UUID) async throws -> IOSHuddleJoin {
        throw IOSHuddleClientError.http(503, "Huddles are not configured")
    }
    func leave(workspace: WorkspaceID, huddle: UUID) async throws {}
}

private actor RecordingHuddleAudioSession: IOSHuddleAudioSession {
    private(set) var disconnectCount = 0
    private(set) var muteValues: [Bool] = []

    func connect(url: URL, token: String) async throws {}
    func disconnect() async { disconnectCount += 1 }
    func setMicrophoneMuted(_ muted: Bool) async throws { muteValues.append(muted) }
    func participantUpdates() async -> AsyncStream<[IOSHuddleAudioParticipant]> {
        AsyncStream { continuation in
            continuation.yield([
                IOSHuddleAudioParticipant(id: "local", displayName: "Demo User", isSpeaking: false, isLocal: true),
            ])
            continuation.finish()
        }
    }
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

    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        ChannelReadState(
            channelId: channel,
            lastReadSeq: sequence,
            latestSeq: sequence,
            unreadCount: 0,
            mentionCount: 0
        )
    }

    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool { muted }

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

    struct MarkReadCall: Sendable, Equatable {
        let channel: ChannelID
        let sequence: Int64
    }

    struct MuteCall: Sendable, Equatable {
        let channel: ChannelID
        let muted: Bool
    }

    private var historyValue: [Message] = []
    private let snapshotValue: IOSConversationSnapshot
    private let failFirstSend: Bool
    private let failFirstApproval: Bool
    private let failFirstMute: Bool
    private let failFirstRead: Bool
    private(set) var sendCalls: [SendCall] = []
    private(set) var approvalCalls: [ApprovalDecisionRequest] = []
    private(set) var markReadCalls: [MarkReadCall] = []
    private(set) var muteCalls: [MuteCall] = []

    init(
        snapshot: IOSConversationSnapshot? = nil,
        failFirstSend: Bool = false,
        failFirstApproval: Bool = false,
        failFirstMute: Bool = false,
        failFirstRead: Bool = false
    ) {
        self.snapshotValue = snapshot ?? IOSConversationSnapshot(
            channels: [fixtureChannel()],
            members: [],
            readStates: []
        )
        self.failFirstSend = failFirstSend
        self.failFirstApproval = failFirstApproval
        self.failFirstMute = failFirstMute
        self.failFirstRead = failFirstRead
    }

    func setHistory(_ messages: [Message]) { historyValue = messages }
    func snapshot() async throws -> IOSConversationSnapshot { snapshotValue }
    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] { historyValue }
    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        markReadCalls.append(MarkReadCall(channel: channel, sequence: sequence))
        if failFirstRead, markReadCalls.count == 1 { throw SessionError.transport("offline") }
        return ChannelReadState(
            channelId: channel,
            lastReadSeq: sequence,
            latestSeq: sequence,
            unreadCount: 0,
            mentionCount: 0
        )
    }
    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool {
        muteCalls.append(MuteCall(channel: channel, muted: muted))
        if failFirstMute, muteCalls.count == 1 { throw SessionError.transport("offline") }
        return muted
    }
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

private actor InteractionConversationBackend: IOSConversationBackend {
    private var storedMessage: Message
    private let reactionSnapshotValue: [MessageID: [String: Set<MemberID>]]
    private let suspendsReaction: Bool
    private var reactionDidStart = false
    private var reactionStartWaiter: CheckedContinuation<Void, Never>?
    private var reactionFinishWaiter: CheckedContinuation<Void, Never>?
    private(set) var reactionCallCount = 0
    private(set) var editCallCount = 0
    private(set) var deleteCallCount = 0

    init(
        message: Message,
        reactionSnapshot: [MessageID: [String: Set<MemberID>]] = [:],
        suspendsReaction: Bool = false
    ) {
        self.storedMessage = message
        self.reactionSnapshotValue = reactionSnapshot
        self.suspendsReaction = suspendsReaction
    }

    func snapshot() async throws -> IOSConversationSnapshot {
        IOSConversationSnapshot(channels: [fixtureChannel()], members: [], readStates: [])
    }

    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] {
        [storedMessage]
    }

    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] {
        reactionSnapshotValue
    }

    func addReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta {
        reactionCallCount += 1
        reactionDidStart = true
        reactionStartWaiter?.resume()
        reactionStartWaiter = nil
        if suspendsReaction {
            await withCheckedContinuation { continuation in
                reactionFinishWaiter = continuation
            }
        }
        return ReactionDelta(action: .added, messageId: id, memberId: fixtureMemberID, emoji: emoji)
    }

    func removeReaction(_ id: MessageID, emoji: String) async throws -> ReactionDelta {
        reactionCallCount += 1
        return ReactionDelta(action: .removed, messageId: id, memberId: fixtureMemberID, emoji: emoji)
    }

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        editCallCount += 1
        storedMessage.body = body
        storedMessage.state = .edited
        storedMessage.editedAtMs = 100
        return storedMessage
    }

    func deleteMessage(_ id: MessageID) async throws -> Message {
        deleteCallCount += 1
        storedMessage.body = nil
        storedMessage.state = .deleted
        storedMessage.deletedAtMs = 101
        return storedMessage
    }

    func waitUntilReactionStarts() async {
        guard !reactionDidStart else { return }
        await withCheckedContinuation { continuation in
            reactionStartWaiter = continuation
        }
    }

    func finishReaction() {
        reactionFinishWaiter?.resume()
        reactionFinishWaiter = nil
    }

    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        ChannelReadState(
            channelId: channel,
            lastReadSeq: sequence,
            latestSeq: sequence,
            unreadCount: 0,
            mentionCount: 0
        )
    }

    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool { muted }
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> { AsyncStream { $0.finish() } }
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        AsyncStream { $0.finish() }
    }
    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message { storedMessage }
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        ApprovalDecisionReceipt(approvalId: request.approvalId, status: request.status)
    }
}

private actor SuspendedMuteConversationBackend: IOSConversationBackend {
    private let initialSnapshot: IOSConversationSnapshot
    private let refreshedSnapshot: IOSConversationSnapshot
    private let reconciliationSnapshot: IOSConversationSnapshot?
    private let suspendsRefresh: Bool
    private var snapshotCallCount = 0
    private var muteDidStart = false
    private var refreshDidStart = false
    private var muteStartWaiter: CheckedContinuation<Void, Never>?
    private var muteFinishWaiter: CheckedContinuation<Void, Never>?
    private var refreshStartWaiter: CheckedContinuation<Void, Never>?
    private var refreshFinishWaiter: CheckedContinuation<Void, Never>?

    init(
        initialSnapshot: IOSConversationSnapshot,
        refreshedSnapshot: IOSConversationSnapshot,
        reconciliationSnapshot: IOSConversationSnapshot? = nil,
        suspendsRefresh: Bool = false
    ) {
        self.initialSnapshot = initialSnapshot
        self.refreshedSnapshot = refreshedSnapshot
        self.reconciliationSnapshot = reconciliationSnapshot
        self.suspendsRefresh = suspendsRefresh
    }

    var snapshotCalls: Int { snapshotCallCount }

    func snapshot() async throws -> IOSConversationSnapshot {
        snapshotCallCount += 1
        guard snapshotCallCount > 1 else { return initialSnapshot }
        if suspendsRefresh, snapshotCallCount == 2 {
            refreshDidStart = true
            refreshStartWaiter?.resume()
            refreshStartWaiter = nil
            await withCheckedContinuation { continuation in
                refreshFinishWaiter = continuation
            }
        }
        if snapshotCallCount > 2, let reconciliationSnapshot {
            return reconciliationSnapshot
        }
        return refreshedSnapshot
    }
    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] { [] }
    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        ChannelReadState(
            channelId: channel,
            lastReadSeq: sequence,
            latestSeq: sequence,
            unreadCount: 0,
            mentionCount: 0
        )
    }
    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool {
        muteDidStart = true
        muteStartWaiter?.resume()
        muteStartWaiter = nil
        await withCheckedContinuation { continuation in
            muteFinishWaiter = continuation
        }
        return muted
    }
    func waitUntilMuteStarts() async {
        guard !muteDidStart else { return }
        await withCheckedContinuation { continuation in
            muteStartWaiter = continuation
        }
    }
    func finishMute() {
        muteFinishWaiter?.resume()
        muteFinishWaiter = nil
    }
    func waitUntilRefreshStarts() async {
        guard !refreshDidStart else { return }
        await withCheckedContinuation { continuation in
            refreshStartWaiter = continuation
        }
    }
    func finishRefresh() {
        refreshFinishWaiter?.resume()
        refreshFinishWaiter = nil
    }
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> { AsyncStream { $0.finish() } }
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        AsyncStream { $0.finish() }
    }
    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        fixtureMessage(sequence: 1)
    }
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        ApprovalDecisionReceipt(approvalId: request.approvalId, status: request.status)
    }
}

private func readSnapshot(
    channel: Channel,
    lastRead: Int64,
    latest: Int64,
    unread: Int64,
    mentions: Int
) -> IOSConversationSnapshot {
    IOSConversationSnapshot(
        channels: [channel],
        members: [],
        readStates: [
            ChannelReadState(
                channelId: channel.id,
                lastReadSeq: lastRead,
                latestSeq: latest,
                unreadCount: unread,
                mentionCount: mentions
            ),
        ]
    )
}

private actor SuspendedReadConversationBackend: IOSConversationBackend {
    private let initialSnapshot: IOSConversationSnapshot
    private let refreshedSnapshot: IOSConversationSnapshot
    private var snapshotCallCount = 0
    private var readDidStart = false
    private var readStartWaiter: CheckedContinuation<Void, Never>?
    private var readFinishWaiter: CheckedContinuation<Void, Never>?

    init(
        initialSnapshot: IOSConversationSnapshot,
        refreshedSnapshot: IOSConversationSnapshot
    ) {
        self.initialSnapshot = initialSnapshot
        self.refreshedSnapshot = refreshedSnapshot
    }

    func snapshot() async throws -> IOSConversationSnapshot {
        snapshotCallCount += 1
        return snapshotCallCount == 1 ? initialSnapshot : refreshedSnapshot
    }

    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] { [] }

    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        readDidStart = true
        readStartWaiter?.resume()
        readStartWaiter = nil
        await withCheckedContinuation { continuation in
            readFinishWaiter = continuation
        }
        throw SessionError.transport("offline")
    }

    func waitUntilReadStarts() async {
        guard !readDidStart else { return }
        await withCheckedContinuation { continuation in
            readStartWaiter = continuation
        }
    }

    func failRead() {
        readFinishWaiter?.resume()
        readFinishWaiter = nil
    }

    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool { muted }
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> { AsyncStream { $0.finish() } }
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        AsyncStream { $0.finish() }
    }
    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        fixtureMessage(sequence: 1)
    }
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        ApprovalDecisionReceipt(approvalId: request.approvalId, status: request.status)
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

private func fixtureHuddle() -> IOSHuddle {
    IOSHuddle(
        id: UUID(uuidString: "00000000-0000-0000-0003-000000000001")!,
        workspaceId: fixtureWorkspaceID,
        channelId: fixtureChannel().id,
        startedBy: fixtureMemberID,
        startedAtMs: 1,
        endedAtMs: nil,
        participants: [
            IOSHuddleParticipant(memberId: fixtureMemberID, displayName: "Demo User", joinedAtMs: 1),
        ]
    )
}

private let fixtureWorkspaceID = WorkspaceID(uuidString: "00000000-0000-0000-0000-000000000001")!
private let fixtureMemberID = MemberID(uuidString: "00000000-0000-0000-0000-000000000002")!
