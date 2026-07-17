import Foundation
import MomoCore
@testable import MomoiOSKit
import Testing

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

private let fixtureWorkspaceID = WorkspaceID(uuidString: "00000000-0000-0000-0000-000000000001")!
private let fixtureMemberID = MemberID(uuidString: "00000000-0000-0000-0000-000000000002")!
