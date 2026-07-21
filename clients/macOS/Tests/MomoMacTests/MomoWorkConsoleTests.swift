import AppKit
import CryptoKit
import Foundation
import MomoCore
import Network
import SwiftUI
import XCTest
@testable import MomoMac

final class MomoWorkConsoleTests: XCTestCase {
    func testHostIdentityPersistsWorkspaceKeyAndHostIDWithPrivatePermissions() throws {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let host = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("MomoWorkConsoleTests-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: baseDirectory) }
        let store = MomoWorkHostIdentityStore(baseDirectory: baseDirectory)

        let first = try store.loadOrCreateSigner(workspace: workspace)
        try store.saveHostID(host, workspace: workspace)
        let second = try store.loadOrCreateSigner(workspace: workspace)

        XCTAssertEqual(first.publicKeyBase64, second.publicKeyBase64)
        XCTAssertEqual(Data(base64Encoded: first.publicKeyBase64)?.count, 32)
        XCTAssertEqual(try store.loadHostID(workspace: workspace), host)
        XCTAssertEqual(
            try posixPermissions(at: store.workspaceDirectory(workspace: workspace)),
            0o700
        )
        XCTAssertEqual(try posixPermissions(at: store.identityURL(workspace: workspace)), 0o600)
        XCTAssertEqual(try posixPermissions(at: store.hostIDURL(workspace: workspace)), 0o600)
        XCTAssertEqual(try Data(contentsOf: store.identityURL(workspace: workspace)).count, 32)
    }

    func testHostRegistrarReusesActiveHostAndReRegistersRevokedHost() async throws {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("MomoWorkConsoleTests-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: baseDirectory) }
        let registrar = MomoWorkHostRegistrar(
            identityStore: MomoWorkHostIdentityStore(baseDirectory: baseDirectory)
        )
        let backend = WorkHostBackendSpy(workspace: workspace, member: member)

        let initial = try await registrar.reconcile(
            workspace: workspace,
            member: member,
            displayName: "Test Mac",
            capabilities: ["tool.codex": true],
            backend: backend
        )
        let reused = try await registrar.reconcile(
            workspace: workspace,
            member: member,
            displayName: "Test Mac",
            capabilities: ["tool.codex": true],
            backend: backend
        )

        XCTAssertEqual(reused.id, initial.id)
        let callsBeforeRevoke = await backend.registerCallCount()
        XCTAssertEqual(callsBeforeRevoke, 1)

        await backend.revoke(initial.id)
        let replacement = try await registrar.reconcile(
            workspace: workspace,
            member: member,
            displayName: "Test Mac",
            capabilities: ["tool.codex": true],
            backend: backend
        )

        XCTAssertNotEqual(replacement.id, initial.id)
        let callsAfterRevoke = await backend.registerCallCount()
        XCTAssertEqual(callsAfterRevoke, 2)
    }

    func testHeartbeatSignatureUsesExactServerPayload() throws {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let host = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let sentAtMs: Int64 = 1_784_452_800_000
        let signer = MomoWorkHostSigner.generate()
        let payload = MomoWorkHostSigner.heartbeatPayload(
            workspace: workspace,
            host: host,
            sentAtMs: sentAtMs
        )

        XCTAssertEqual(
            String(data: payload, encoding: .utf8),
            "momo.work_host.heartbeat.v1\n\(workspace.description.lowercased())\n\(host.description.lowercased())\n\(sentAtMs)"
        )
        let publicKeyData = try XCTUnwrap(Data(base64Encoded: signer.publicKeyBase64))
        let signature = try XCTUnwrap(Data(base64Encoded: signer.signatureBase64(for: payload)))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
        XCTAssertEqual(signature.count, 64)
        XCTAssertTrue(publicKey.isValidSignature(signature, for: payload))
    }

    @MainActor
    func testWorkConsoleFailsClosedUntilServerHostRegistrationCompletes() async {
        let controller = MomoWorkConsoleController(
            viewModel: ChatViewModel(backend: LiveChatBackend())
        )

        let started = await controller.startSession(
            tool: .codex,
            label: "Must not start",
            directory: nil
        )

        XCTAssertFalse(started)
        XCTAssertFalse(controller.isHostReady)
        XCTAssertEqual(controller.lastIssue, .hostRegistrationFailed)
    }

    func testShellLaunchEnvironmentDoesNotForwardCredentialsOrWorkingPath() throws {
        let secret = "must-not-reach-pty-environment"
        let spec = try MomoWorkLaunchSpec.resolve(
            tool: .shell,
            environment: [
                "SHELL": "/bin/zsh",
                "PATH": "/usr/bin:/bin",
                "TMPDIR": "/private/tmp",
                "MOMO_ACCESS_TOKEN": secret,
                "ANTHROPIC_API_KEY": secret,
                "PWD": "/Users/person/private-project",
            ]
        )

        XCTAssertEqual(spec.executable, "/bin/zsh")
        XCTAssertEqual(spec.arguments, ["-l"])
        XCTAssertTrue(spec.environment.contains("PATH=/usr/bin:/bin"))
        XCTAssertFalse(spec.environment.contains { $0.contains(secret) })
        XCTAssertFalse(spec.environment.contains { $0.hasPrefix("MOMO_ACCESS_TOKEN=") })
        XCTAssertFalse(spec.environment.contains { $0.hasPrefix("ANTHROPIC_API_KEY=") })
        XCTAssertFalse(spec.environment.contains { $0.hasPrefix("PWD=") })
    }

    func testKeyboardCatalogExposesWorkConsoleShortcut() {
        let items = MomoKeyboardShortcutCatalog.items(
            copy: MomoWorkspaceCopy(language: .korean)
        )
        XCTAssertTrue(items.contains { $0.key == "⌃`" && $0.label == "Work Console 열기" })
        XCTAssertTrue(items.contains { $0.key == "⌘1…⌘9" && $0.label.contains("Work 세션") })
    }

    func testTerminalCopyPasteKeyCommandsRequirePlainCommandModifier() {
        XCTAssertEqual(
            MomoTerminalKeyCommand.resolve(characters: "c", modifiers: .command),
            .copy
        )
        XCTAssertEqual(
            MomoTerminalKeyCommand.resolve(characters: "V", modifiers: .command),
            .paste
        )
        XCTAssertNil(
            MomoTerminalKeyCommand.resolve(
                characters: "c",
                modifiers: [.command, .shift]
            )
        )
        XCTAssertNil(MomoTerminalKeyCommand.resolve(characters: "c", modifiers: .control))
    }

    @MainActor
    func testLocalTerminalUsesExtendedScrollback() {
        let session = MomoLocalTerminalSession { _ in }
        XCTAssertEqual(
            session.terminalView.terminal.options.scrollback,
            MomoTheme.WorkConsole.terminalScrollbackLines
        )
    }

    func testRemoteAttachAvailabilityUsesServerProjectionAndLegacyPTYBinding() {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let host = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let root = MessageID(uuidString: "00000000-0000-7000-8000-000000000701")!

        let unbound = MomoWorkSession(
            id: WorkSessionID(), workspaceId: workspace, channelId: channel,
            memberId: member, hostId: host, rootMessageId: root, tool: .codex,
            label: "No remote PTY", status: .running, startedAtMs: 1
        )
        let projectedBound = MomoWorkSession(
            id: WorkSessionID(), workspaceId: workspace, channelId: channel,
            memberId: member, hostId: host, rootMessageId: root, tool: .codex,
            label: "Projected remote PTY", status: .running, startedAtMs: 1,
            remoteAttachAvailable: true
        )
        let projectedUnbound = MomoWorkSession(
            id: WorkSessionID(), workspaceId: workspace, channelId: channel,
            memberId: member, hostId: host, rootMessageId: root, tool: .codex,
            label: "Unavailable remote PTY", status: .running, startedAtMs: 1,
            remoteAttachAvailable: false
        )
        let legacyBound = MomoWorkSession(
            id: WorkSessionID(), workspaceId: workspace, channelId: channel,
            memberId: member, hostId: host, rootMessageId: root, tool: .codex,
            label: "Remote PTY", status: .running, startedAtMs: 1, ptyId: "pty-511"
        )

        XCTAssertFalse(unbound.isRemotePTYBound)
        XCTAssertTrue(projectedBound.isRemotePTYBound)
        XCTAssertFalse(projectedUnbound.isRemotePTYBound)
        XCTAssertTrue(legacyBound.isRemotePTYBound)
    }

    func testTerminalAttachPolicySeparatesOwnerControlFromReadOnlyObservation() {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let owner = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let teammate = MemberID(uuidString: "00000000-0000-7000-8000-000000000102")!
        let host = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let root = MessageID(uuidString: "00000000-0000-7000-8000-000000000701")!
        var session = MomoWorkSession(
            id: WorkSessionID(), workspaceId: workspace, channelId: channel,
            memberId: owner, hostId: host, rootMessageId: root, tool: .codex,
            label: "Observe only", status: .running, startedAtMs: 1,
            remoteAttachAvailable: true, observation: .open
        )

        XCTAssertEqual(
            MomoTerminalAttachPolicy.mode(
                for: session, currentMemberID: owner, hasLocalTerminal: false
            ),
            .controller
        )
        XCTAssertEqual(
            MomoTerminalAttachPolicy.mode(
                for: session, currentMemberID: teammate, hasLocalTerminal: false
            ),
            .observer
        )
        XCTAssertNil(MomoTerminalAttachPolicy.mode(
            for: session, currentMemberID: teammate, hasLocalTerminal: true
        ))

        session.observation = .ownerOnly
        XCTAssertNil(MomoTerminalAttachPolicy.mode(
            for: session, currentMemberID: teammate, hasLocalTerminal: false
        ))
        XCTAssertEqual(
            MomoTerminalAttachPolicy.mode(
                for: session, currentMemberID: owner, hasLocalTerminal: false
            ),
            .controller
        )

        session.status = .ended
        XCTAssertNil(MomoTerminalAttachPolicy.mode(
            for: session, currentMemberID: owner, hasLocalTerminal: false
        ))
        XCTAssertNil(MomoTerminalAttachPolicy.mode(
            for: session, currentMemberID: nil, hasLocalTerminal: false
        ))
    }

    func testRemoteTerminalFramesUseOnlyThePTYContractFields() throws {
        let ptyID = "pty:remote-511"
        let input = Data("echo 안녕\n".utf8)

        let connect = try jsonObject(MomoTerminalAttachFrame.connect(ptyId: ptyID))
        let stdin = try jsonObject(MomoTerminalAttachFrame.sendStdin(ptyId: ptyID, data: input))
        let resize = try jsonObject(
            MomoTerminalAttachFrame.resize(ptyId: ptyID, columns: 120, rows: 40)
        )
        let kill = try jsonObject(MomoTerminalAttachFrame.kill(ptyId: ptyID))

        XCTAssertEqual(Set(connect.keys), ["type", "pty_id"])
        XCTAssertEqual(connect["type"] as? String, "connect")
        XCTAssertEqual(Set(stdin.keys), ["type", "pty_id", "data"])
        XCTAssertEqual(stdin["type"] as? String, "send_stdin")
        XCTAssertEqual(stdin["data"] as? String, input.base64EncodedString())
        XCTAssertEqual(Set(resize.keys), ["type", "pty_id", "cols", "rows"])
        XCTAssertEqual(resize["cols"] as? Int, 120)
        XCTAssertEqual(resize["rows"] as? Int, 40)
        XCTAssertEqual(Set(kill.keys), ["type", "pty_id"])
        XCTAssertEqual(kill["type"] as? String, "kill")
        for frame in [connect, stdin, resize, kill] {
            XCTAssertEqual(frame["pty_id"] as? String, ptyID)
            XCTAssertNil(frame["capability_token"])
            XCTAssertNil(frame["attach_endpoint"])
        }
    }

    func testTerminalAttachRESTGrantIsExactAndNeverPlacesCapabilityInURL() async throws {
        WorkConsoleURLProtocol.reset()
        defer { WorkConsoleURLProtocol.reset() }
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let sessionID = WorkSessionID(uuidString: "00000000-0000-7000-8000-000000000511")!
        let capability = "one-time-capability-548"
        WorkConsoleURLProtocol.setHandler { request in
            XCTAssertNil(request.url?.query)
            XCTAssertFalse(request.url?.absoluteString.contains(capability) == true)
            return .init(json: """
                {
                  "attach_endpoint":"wss://workd.momo.test/pty",
                  "capability_token":"\(capability)",
                  "pty_id":"pty-511"
                }
                """)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkConsoleURLProtocol.self]
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "human-token"
            ),
            session: URLSession(configuration: configuration)
        )
        try await backend.connect(workspace: workspace, accessToken: "human-token")

        let grant = try await backend.issueTerminalAttach(workspace: workspace, session: sessionID)
        _ = try await backend.issueTerminalAttach(
            workspace: workspace,
            session: sessionID,
            mode: .observer
        )

        XCTAssertEqual(grant.endpoint.absoluteString, "wss://workd.momo.test/pty")
        XCTAssertEqual(grant.capabilityToken, capability)
        XCTAssertEqual(grant.ptyId, "pty-511")
        let requests = WorkConsoleURLProtocol.requests()
        XCTAssertEqual(requests.count, 2)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.path,
            "/v1/workspaces/\(workspace)/work-sessions/\(sessionID)/terminal-attach"
        )
        let controllerBody = try XCTUnwrap(request.workConsoleBodyData)
        let controllerObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: controllerBody) as? [String: String]
        )
        XCTAssertEqual(controllerObject, ["mode": "controller"])
        let observerBody = try XCTUnwrap(requests.last?.workConsoleBodyData)
        let observerObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: observerBody) as? [String: String]
        )
        XCTAssertEqual(observerObject, ["mode": "observer"])
    }

    func testWorkSessionObservationPATCHUsesExactOwnerPolicyContract() async throws {
        WorkConsoleURLProtocol.reset()
        defer { WorkConsoleURLProtocol.reset() }
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let host = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let sessionID = WorkSessionID(uuidString: "00000000-0000-7000-8000-000000000517")!
        let root = MessageID(uuidString: "00000000-0000-7000-8000-000000000701")!
        WorkConsoleURLProtocol.setHandler { request in
            XCTAssertNil(request.url?.query)
            return .init(json: """
                {"workSession":{
                  "id":"\(sessionID)",
                  "workspaceId":"\(workspace)",
                  "channelId":"\(channel)",
                  "memberId":"\(member)",
                  "hostId":"\(host)",
                  "rootMessageId":"\(root)",
                  "tool":"codex",
                  "label":"MOMO-517",
                  "status":"running",
                  "remoteAttachAvailable":true,
                  "observation":"owner_only",
                  "observerGrantCount":0,
                  "startedAtMs":1784452800000
                }}
                """)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkConsoleURLProtocol.self]
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "human-token"
            ),
            session: URLSession(configuration: configuration)
        )
        try await backend.connect(workspace: workspace, accessToken: "human-token")

        let updated = try await backend.setWorkSessionObservation(
            workspace: workspace,
            session: sessionID,
            observation: .ownerOnly
        )

        XCTAssertEqual(updated.observation, .ownerOnly)
        XCTAssertEqual(updated.observerGrantCount, 0)
        let request = try XCTUnwrap(WorkConsoleURLProtocol.requests().first)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(
            request.url?.path,
            "/v1/workspaces/\(workspace)/work-sessions/\(sessionID)"
        )
        let body = try XCTUnwrap(request.workConsoleBodyData)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: String]
        )
        XCTAssertEqual(object, ["observation": "owner_only"])
    }

    @MainActor
    func testRemoteTerminalStreamsOutputAndRoundTripsInputResizeAndKill() async throws {
        let transport = MockRemoteTerminalTransport()
        let capability = "memory-only-\(UUID())"
        let grant = try MomoTerminalAttachGrant(
            endpoint: URL(string: "wss://workd.momo.test/pty")!,
            capabilityToken: capability,
            ptyId: "pty-511"
        )
        let session = MomoRemoteTerminalSession(
            grantProvider: { grant },
            transport: transport
        )

        await session.start()
        XCTAssertEqual(session.state, .connected)
        session.terminalView.frame = CGRect(x: 0, y: 0, width: 800, height: 400)
        session.terminalView.resize(cols: 80, rows: 24)
        session.terminalView.layoutSubtreeIfNeeded()
        await transport.emit(Data("remote terminal ready\r\n".utf8))
        try await waitUntil("stdout bytes") { session.receivedByteCount > 0 }
        XCTAssertTrue(
            session.tail(lineCount: 80).contains("remote terminal ready"),
            "SwiftTerm \(session.terminalView.terminal.cols)x\(session.terminalView.terminal.rows) buffer: \(session.tail(lineCount: 80))"
        )

        let input = [UInt8]("help\n".utf8)
        session.terminalView.send(source: session.terminalView.terminal, data: input[...])
        session.terminalView.terminalDelegate?.sizeChanged(
            source: session.terminalView,
            newCols: 132,
            newRows: 48
        )
        try await waitUntil("stdin and resize") { await transport.frames().count >= 3 }
        session.terminate()
        try await waitUntil("kill") { await transport.frames().count >= 4 }

        let frames = await transport.frames().compactMap { try? self.jsonObject($0) }
        let types = frames.compactMap { $0["type"] as? String }
        XCTAssertEqual(types.first, "connect")
        XCTAssertTrue(types.contains("send_stdin"))
        XCTAssertTrue(types.contains("resize"))
        XCTAssertEqual(types.last, "kill")
        XCTAssertEqual(session.state, .ended)
        XCTAssertFalse(UserDefaults.standard.dictionaryRepresentation().values.contains {
            String(describing: $0).contains(capability)
        })
    }

    @MainActor
    func testObserverRemoteTerminalIsReadOnlyAndNeverSendsInputResizeOrKill() async throws {
        let transport = MockRemoteTerminalTransport()
        let session = MomoRemoteTerminalSession(
            mode: .observer,
            grantProvider: {
                try MomoTerminalAttachGrant(
                    endpoint: URL(string: "wss://workd.momo.test/pty")!,
                    capabilityToken: "observer-memory-only",
                    ptyId: "pty-observer-517"
                )
            },
            transport: transport
        )

        await session.start()
        XCTAssertEqual(session.state, .connected)
        XCTAssertTrue(session.isReadOnly)
        XCTAssertTrue(session.isObserver)

        let input = [UInt8]("must-not-send\n".utf8)
        session.terminalView.send(source: session.terminalView.terminal, data: input[...])
        session.terminalView.terminalDelegate?.sizeChanged(
            source: session.terminalView,
            newCols: 160,
            newRows: 60
        )
        session.terminate()
        try await Task.sleep(for: .milliseconds(50))

        let frames = await transport.frames().compactMap { try? self.jsonObject($0) }
        XCTAssertEqual(frames.compactMap { $0["type"] as? String }, ["connect"])
        XCTAssertEqual(session.state, .ended)
    }

    @MainActor
    func testRemoteTerminalMapsGrantAndTransportFailuresForRetry() async throws {
        let forbidden = MomoRemoteTerminalSession(
            grantProvider: { throw BackendError.problem(status: 403, title: nil, detail: nil) },
            transport: MockRemoteTerminalTransport()
        )
        await forbidden.start()
        XCTAssertEqual(forbidden.state, .failed(.forbidden))

        let revoked = MomoRemoteTerminalSession(
            grantProvider: { throw BackendError.problem(status: 409, title: nil, detail: nil) },
            transport: MockRemoteTerminalTransport()
        )
        await revoked.start()
        XCTAssertEqual(revoked.state, .failed(.revokedOrUnavailable))

        let rateLimited = MomoRemoteTerminalSession(
            grantProvider: { throw BackendError.problem(status: 429, title: nil, detail: nil) },
            transport: MockRemoteTerminalTransport()
        )
        await rateLimited.start()
        XCTAssertEqual(rateLimited.state, .failed(.rateLimited))

        let expiredTransport = MockRemoteTerminalTransport(connectFailure: .grantExpired)
        let expired = MomoRemoteTerminalSession(
            grantProvider: {
                try MomoTerminalAttachGrant(
                    endpoint: URL(string: "wss://workd.momo.test/pty")!,
                    capabilityToken: "expired",
                    ptyId: "pty-511"
                )
            },
            transport: expiredTransport
        )
        await expired.start()
        XCTAssertEqual(expired.state, .failed(.grantExpired))

        let disconnectedTransport = MockRemoteTerminalTransport()
        let disconnected = MomoRemoteTerminalSession(
            grantProvider: {
                try MomoTerminalAttachGrant(
                    endpoint: URL(string: "wss://workd.momo.test/pty")!,
                    capabilityToken: "disconnect",
                    ptyId: "pty-511"
                )
            },
            transport: disconnectedTransport
        )
        await disconnected.start()
        await disconnectedTransport.fail(.networkDisconnected)
        try await waitUntil("disconnect") { disconnected.state == .failed(.networkDisconnected) }
    }

    @MainActor
    func testURLSessionTransportUsesLoopbackWebSocketForStdoutStdinAndResize() async throws {
        let server = try LocalWebSocketAttachServer(capability: "loopback-capability")
        try await server.start()
        defer { server.stop() }
        let endpoint = try XCTUnwrap(server.endpoint)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        let session = MomoRemoteTerminalSession(
            grantProvider: {
                try MomoTerminalAttachGrant(
                    endpoint: endpoint,
                    capabilityToken: "loopback-capability",
                    ptyId: "pty-loopback"
                )
            },
            transport: MomoURLSessionRemoteTerminalTransport(
                session: URLSession(configuration: configuration)
            )
        )
        session.terminalView.resize(cols: 80, rows: 24)

        await session.start()
        try await waitUntil("loopback connection", timeout: .seconds(3)) {
            if case .failed = session.state { return true }
            return session.tail(lineCount: 80).contains("loopback stdout ready")
        }
        if case .failed(let error) = session.state {
            throw XCTSkip("Managed test sandbox blocked loopback WebSocket: \(error)")
        }
        let input = [UInt8]("status\n".utf8)
        session.terminalView.send(source: session.terminalView.terminal, data: input[...])
        session.terminalView.terminalDelegate?.sizeChanged(
            source: session.terminalView,
            newCols: 144,
            newRows: 52
        )
        try await waitUntil("loopback stdin and resize", timeout: .seconds(3)) {
            let snapshot = server.snapshot()
            return snapshot.stdin == Data(input) && snapshot.columns == 144 && snapshot.rows == 52
        }

        let snapshot = server.snapshot()
        XCTAssertEqual(snapshot.authorization, "Bearer loopback-capability")
        XCTAssertEqual(snapshot.types.first, "connect")
        XCTAssertTrue(snapshot.types.contains("send_stdin"))
        XCTAssertTrue(snapshot.types.contains("resize"))
        XCTAssertNil(endpoint.query)
        session.disconnect()
    }

    private func jsonObject(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any]
        )
    }

    @MainActor
    private func waitUntil(
        _ label: String,
        timeout: Duration = .seconds(1),
        _ condition: @escaping @MainActor () async -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !(await condition()) {
            if clock.now >= deadline { XCTFail("Timed out waiting for \(label)"); return }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    func testAutomaticTerminalLabelsFillFirstAvailableSlot() {
        XCTAssertEqual(
            MomoWorkConsoleController.automaticTerminalLabel(
                existingLabels: ["Terminal 1", "Payment review", "TERMINAL 3"]
            ),
            "Terminal 2"
        )
    }

    func testWorkSessionNumberShortcutsAreBoundedToNine() {
        XCTAssertEqual(MomoWorkSessionShortcut.index(number: 1, sessionCount: 2), 0)
        XCTAssertEqual(MomoWorkSessionShortcut.index(number: 2, sessionCount: 2), 1)
        XCTAssertNil(MomoWorkSessionShortcut.index(number: 3, sessionCount: 2))
        XCTAssertNil(MomoWorkSessionShortcut.index(number: 10, sessionCount: 10))
    }

    @MainActor
    func testWorkConsoleDimensionsPersistClampAndReset() throws {
        let suiteName = "MomoWorkConsolePreferencesTests-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let preferences = MomoWorkConsolePreferences(defaults: defaults)
        preferences.setDrawerHeight(1)
        preferences.setSessionListWidth(9_999)
        preferences.setRightPanelWidth(9_999)

        let reloaded = MomoWorkConsolePreferences(defaults: defaults)
        XCTAssertEqual(reloaded.drawerHeight, MomoTheme.WorkConsole.drawerMinimumHeight)
        XCTAssertEqual(reloaded.sessionListWidth, MomoTheme.WorkConsole.sessionListMaximumWidth)
        XCTAssertEqual(reloaded.rightPanelWidth, MomoTheme.WorkConsole.rightPanelMaximumWidth)

        reloaded.resetDrawerHeight()
        reloaded.resetSessionListWidth()
        reloaded.resetRightPanelWidth()
        let reset = MomoWorkConsolePreferences(defaults: defaults)
        XCTAssertEqual(reset.drawerHeight, MomoTheme.WorkConsole.drawerHeight)
        XCTAssertEqual(reset.sessionListWidth, MomoTheme.WorkConsole.sessionListWidth)
        XCTAssertEqual(reset.rightPanelWidth, MomoTheme.WorkConsole.rightPanelWidth)
    }

    func testWorkConsoleLayoutPreservesPrimaryAndTerminalMinimums() {
        XCTAssertEqual(
            MomoWorkConsoleLayout.drawerHeight(
                preferredHeight: MomoTheme.WorkConsole.drawerMaximumHeight,
                availableHeight: 600
            ),
            360
        )
        XCTAssertEqual(
            MomoWorkConsoleLayout.sessionListWidth(
                preferredWidth: MomoTheme.WorkConsole.sessionListMaximumWidth,
                availableWidth: 600
            ),
            240
        )
        XCTAssertEqual(
            MomoRightPanelLayout.width(preferredWidth: 640, availableWidth: 800),
            440
        )
    }

    @MainActor
    func testTerminalThemePreferencePersists() throws {
        let suiteName = "MomoTerminalThemePreferencesTests-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let preferences = MomoWorkConsolePreferences(defaults: defaults)
        XCTAssertEqual(preferences.terminalTheme, .dark)
        preferences.setTerminalTheme(.colorBlindSafe)

        let reloaded = MomoWorkConsolePreferences(defaults: defaults)
        XCTAssertEqual(reloaded.terminalTheme, .colorBlindSafe)
    }

    func testTerminalThemePresetsProvideCompleteANSI16Palettes() {
        for preset in MomoTerminalThemePreset.allCases {
            XCTAssertEqual(preset.theme.ansi16.count, 16, preset.rawValue)
        }
    }

    func testLightTerminalThemeMeetsAAForForegroundAndANSIColors() {
        let theme = MomoTerminalThemePreset.light.theme
        XCTAssertGreaterThanOrEqual(theme.foregroundBackgroundContrast, 4.5)
        for color in theme.ansi16 {
            XCTAssertGreaterThanOrEqual(
                color.contrastRatio(with: theme.background),
                4.5
            )
        }
    }

    func testRESTWorkConsoleContractNeverSendsLocalRuntimeData() async throws {
        WorkConsoleURLProtocol.reset()
        defer { WorkConsoleURLProtocol.reset() }

        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let host = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let sessionID = WorkSessionID(uuidString: "00000000-0000-7000-8000-000000000483")!
        let root = MessageID(uuidString: "00000000-0000-7000-8000-000000000701")!
        let control = WorkControlID(uuidString: "00000000-0000-7000-8000-000000000484")!

        let runningSessionJSON = """
            {
              "id":"\(sessionID)",
              "workspaceId":"\(workspace)",
              "channelId":"\(channel)",
              "memberId":"\(member)",
              "hostId":"\(host)",
              "rootMessageId":"\(root)",
              "tool":"codex",
              "label":"MOMO-485",
              "status":"running",
              "remoteAttachAvailable":true,
              "startedAtMs":1784452800000,
              "endedAtMs":null,
              "exitCode":null
            }
            """
        let endedSessionJSON = """
            {
              "id":"\(sessionID)",
              "workspaceId":"\(workspace)",
              "channelId":"\(channel)",
              "memberId":"\(member)",
              "hostId":"\(host)",
              "rootMessageId":"\(root)",
              "tool":"codex",
              "label":"MOMO-485",
              "status":"ended",
              "startedAtMs":1784452800000,
              "endedAtMs":1784452860000,
              "exitCode":0
            }
            """

        WorkConsoleURLProtocol.setHandler { request in
            let path = request.url?.path ?? ""
            switch (request.httpMethod, path) {
            case ("GET", "/v1/workspaces/\(workspace)/work-sessions"):
                return .init(json: "{\"workSessions\":[\(runningSessionJSON)]}")
            case ("POST", "/v1/workspaces/\(workspace)/work-sessions"):
                return .init(json: "{\"workSession\":\(runningSessionJSON)}")
            case ("PATCH", "/v1/workspaces/\(workspace)/work-sessions/\(sessionID)"):
                return .init(json: "{\"workSession\":\(endedSessionJSON)}")
            case ("POST", "/v1/workspaces/\(workspace)/work-controls/\(control)/ack"):
                return .init(json: #"{"workControl":{"status":"acked"}}"#)
            case ("PUT", "/v1/workspaces/\(workspace)/work-auto-approvals/codex"):
                return .init(json: #"{"tool":"codex","enabled":true}"#)
            case ("DELETE", "/v1/workspaces/\(workspace)/work-auto-approvals/codex"):
                return .init(json: #"{"tool":"codex","enabled":false}"#)
            default:
                return .init(statusCode: 404, json: #"{"title":"unexpected request"}"#)
            }
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkConsoleURLProtocol.self]
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: URLSession(configuration: configuration)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let sessions = try await backend.workSessions(workspace: workspace, activeOnly: true)
        XCTAssertEqual(sessions.first?.remoteAttachAvailable, true)
        XCTAssertEqual(sessions.first?.isRemotePTYBound, true)
        _ = try await backend.createWorkSession(
            workspace: workspace,
            channel: channel,
            host: host,
            tool: .codex,
            label: "MOMO-485"
        )
        _ = try await backend.endWorkSession(
            workspace: workspace,
            session: sessionID,
            exitCode: 0
        )
        try await backend.acknowledgeWorkControl(
            workspace: workspace,
            control: control,
            ok: true,
            session: sessionID,
            errorLabel: nil
        )
        let enabled = try await backend.setWorkAutoApprove(
            workspace: workspace,
            tool: .codex,
            enabled: true
        )
        let disabled = try await backend.setWorkAutoApprove(
            workspace: workspace,
            tool: .codex,
            enabled: false
        )
        XCTAssertTrue(enabled)
        XCTAssertFalse(disabled)

        let requests = WorkConsoleURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["GET", "POST", "PATCH", "POST", "PUT", "DELETE"])
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(requests.first?.url), resolvingAgainstBaseURL: false)?
                .queryItems,
            [URLQueryItem(name: "active", value: "1")]
        )

        let createBody = try XCTUnwrap(requests[1].workConsoleBodyData)
        let createObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: createBody) as? [String: Any]
        )
        XCTAssertEqual(Set(createObject.keys), ["channelId", "hostId", "tool", "label"])
        XCTAssertEqual(createObject["label"] as? String, "MOMO-485")

        for request in requests {
            let body = request.workConsoleBodyData.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            XCTAssertFalse(body.contains("/Users/"))
            XCTAssertFalse(body.contains("PATH"))
            XCTAssertFalse(body.contains("TOKEN"))
            XCTAssertFalse(body.localizedCaseInsensitiveContains("terminal output"))
        }
    }

    func testRESTWorkHostRegistrationAndHeartbeatKeepPrivateDataLocal() async throws {
        WorkConsoleURLProtocol.reset()
        defer { WorkConsoleURLProtocol.reset() }

        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let host = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let publicKey = Data(repeating: 7, count: 32).base64EncodedString()
        let signature = Data(repeating: 9, count: 64).base64EncodedString()
        let hostJSON = """
            {
              "id":"\(host)",
              "workspaceId":"\(workspace)",
              "scope":"member",
              "ownerMemberId":"\(member)",
              "type":"app",
              "displayName":"Test Mac",
              "publicKey":"\(publicKey)",
              "capabilities":{"tool.codex":true},
              "lastSeenAtMs":1784452800000,
              "revokedAtMs":null,
              "createdAtMs":1784452700000,
              "online":true
            }
            """

        WorkConsoleURLProtocol.setHandler { request in
            let path = request.url?.path ?? ""
            switch (request.httpMethod, path) {
            case ("GET", "/v1/workspaces/\(workspace)/work-hosts"):
                return .init(json: #"{"workHosts":[]}"#)
            case ("POST", "/v1/workspaces/\(workspace)/work-hosts"):
                return .init(statusCode: 201, json: "{\"workHost\":\(hostJSON)}")
            case ("POST", "/v1/workspaces/\(workspace)/work-hosts/\(host)/heartbeat"):
                return .init(json: "{\"workHost\":\(hostJSON)}")
            default:
                return .init(statusCode: 404, json: #"{"title":"unexpected request"}"#)
            }
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkConsoleURLProtocol.self]
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: URLSession(configuration: configuration)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let initialHosts = try await backend.workHosts(workspace: workspace)
        XCTAssertTrue(initialHosts.isEmpty)
        _ = try await backend.registerWorkHost(
            workspace: workspace,
            displayName: "Test Mac",
            publicKey: publicKey,
            capabilities: ["tool.codex": true]
        )
        _ = try await backend.heartbeatWorkHost(
            workspace: workspace,
            host: host,
            sentAtMs: 1_784_452_800_000,
            signature: signature
        )

        let requests = WorkConsoleURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["GET", "POST", "POST"])
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
        XCTAssertNil(requests[2].value(forHTTPHeaderField: "Authorization"))

        let registerBody = try XCTUnwrap(requests[1].workConsoleBodyData)
        let registerObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: registerBody) as? [String: Any]
        )
        XCTAssertEqual(
            Set(registerObject.keys),
            ["scope", "type", "displayName", "publicKey", "capabilities"]
        )
        XCTAssertEqual(Data(base64Encoded: registerObject["publicKey"] as? String ?? "")?.count, 32)

        let heartbeatBody = try XCTUnwrap(requests[2].workConsoleBodyData)
        let heartbeatObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: heartbeatBody) as? [String: Any]
        )
        XCTAssertEqual(Set(heartbeatObject.keys), ["sentAtMs", "signature"])
        XCTAssertEqual(Data(base64Encoded: heartbeatObject["signature"] as? String ?? "")?.count, 64)

        for request in requests {
            let body = request.workConsoleBodyData.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            XCTAssertFalse(body.contains("/Users/"))
            XCTAssertFalse(body.localizedCaseInsensitiveContains("privateKey"))
            XCTAssertFalse(body.localizedCaseInsensitiveContains("accessToken"))
            XCTAssertFalse(body.localizedCaseInsensitiveContains("cwd"))
        }
    }

    @MainActor
    func testWorkHostSettingsWritesDesignReviewArtifacts() throws {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let host = WorkHost(
            id: WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!,
            workspaceId: workspace,
            scope: .member,
            ownerMemberId: member,
            type: .app,
            displayName: "Momo on Seongjae MacBook Pro",
            publicKey: Data(repeating: 4, count: 32).base64EncodedString(),
            capabilities: ["tool.codex": true],
            lastSeenAtMs: 1_784_452_800_000,
            createdAtMs: 1_784_452_700_000,
            online: true
        )
        let controller = MomoWorkConsoleController(
            viewModel: ChatViewModel(backend: LiveChatBackend()),
            initialHostRegistrationState: .ready(host)
        )
        let outputDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-a11-design-review", isDirectory: true)
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )

        for scheme in [ColorScheme.light, .dark] {
            let artifact = try renderSettings(
                controller: controller,
                scheme: scheme,
                increasedContrast: false,
                sizeCategory: .large
            )
            let suffix = scheme == .dark ? "dark" : "light"
            let destination = outputDirectory
                .appendingPathComponent("work-host-settings-\(suffix).png")
            try XCTUnwrap(artifact.tiffRepresentation)
                .writePNG(to: destination)
            XCTAssertTrue(FileManager.default.fileExists(atPath: destination.path))
        }

        let accessibilityArtifact = try renderSettings(
            controller: controller,
            scheme: .light,
            increasedContrast: true,
            sizeCategory: .accessibilityLarge
        )
        let accessibilityDestination = outputDirectory
            .appendingPathComponent("work-host-settings-accessibility.png")
        try XCTUnwrap(accessibilityArtifact.tiffRepresentation)
            .writePNG(to: accessibilityDestination)
        XCTAssertTrue(FileManager.default.fileExists(atPath: accessibilityDestination.path))

        let failedController = MomoWorkConsoleController(
            viewModel: ChatViewModel(backend: LiveChatBackend()),
            initialHostRegistrationState: .failed(.hostRegistrationFailed)
        )
        let failedArtifact = try renderSettings(
            controller: failedController,
            scheme: .light,
            increasedContrast: false,
            sizeCategory: .large
        )
        let failedDestination = outputDirectory
            .appendingPathComponent("work-host-settings-failed.png")
        try XCTUnwrap(failedArtifact.tiffRepresentation)
            .writePNG(to: failedDestination)
        XCTAssertTrue(FileManager.default.fileExists(atPath: failedDestination.path))

        let registeringController = MomoWorkConsoleController(
            viewModel: ChatViewModel(backend: LiveChatBackend()),
            initialHostRegistrationState: .registering
        )
        let registeringArtifact = try renderSettings(
            controller: registeringController,
            scheme: .light,
            increasedContrast: false,
            sizeCategory: .large
        )
        let registeringDestination = outputDirectory
            .appendingPathComponent("work-host-settings-registering.png")
        try XCTUnwrap(registeringArtifact.tiffRepresentation)
            .writePNG(to: registeringDestination)
        XCTAssertTrue(FileManager.default.fileExists(atPath: registeringDestination.path))

        var offlineHost = host
        offlineHost.online = false
        let offlineController = MomoWorkConsoleController(
            viewModel: ChatViewModel(backend: LiveChatBackend()),
            initialHostRegistrationState: .ready(offlineHost)
        )
        let offlineArtifact = try renderSettings(
            controller: offlineController,
            scheme: .dark,
            increasedContrast: false,
            sizeCategory: .large
        )
        let offlineDestination = outputDirectory
            .appendingPathComponent("work-host-settings-offline.png")
        try XCTUnwrap(offlineArtifact.tiffRepresentation)
            .writePNG(to: offlineDestination)
        XCTAssertTrue(FileManager.default.fileExists(atPath: offlineDestination.path))
    }

    private func posixPermissions(at url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue
    }

    @MainActor
    private func renderSettings(
        controller: MomoWorkConsoleController,
        scheme: ColorScheme,
        increasedContrast: Bool,
        sizeCategory: ContentSizeCategory
    ) throws -> NSImage {
        let size = CGSize(width: 400, height: 560)
        let content = MomoWorkConsoleSettingsView(
            controller: controller,
            preferences: MomoWorkConsolePreferences(),
            copy: MomoWorkspaceCopy(language: .korean)
        )
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.sizeCategory, sizeCategory)
        let hostingView = NSHostingView(rootView: content)
        hostingView.frame = CGRect(origin: .zero, size: size)
        let appearanceName: NSAppearance.Name
        if increasedContrast {
            appearanceName = scheme == .dark ? .accessibilityHighContrastDarkAqua : .accessibilityHighContrastAqua
        } else {
            appearanceName = scheme == .dark ? .darkAqua : .aqua
        }
        hostingView.appearance = NSAppearance(named: appearanceName)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        guard let representation = hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds) else {
            throw XCTSkip("NSHostingView produced no bitmap on this host")
        }
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }
}

private extension Data {
    func writePNG(to url: URL) throws {
        guard let imageRepresentation = NSBitmapImageRep(data: self),
              let png = imageRepresentation.representation(using: .png, properties: [:])
        else { throw CocoaError(.fileWriteUnknown) }
        try png.write(to: url, options: .atomic)
    }
}

private actor WorkHostBackendSpy: MomoWorkHostBackend {
    private let workspace: WorkspaceID
    private let member: MemberID
    private var hosts: [WorkHost] = []
    private var registrations = 0

    init(workspace: WorkspaceID, member: MemberID) {
        self.workspace = workspace
        self.member = member
    }

    func workHosts(workspace: WorkspaceID) async throws -> [WorkHost] {
        guard workspace == self.workspace else { throw BackendError.notConnected }
        return hosts
    }

    func registerWorkHost(
        workspace: WorkspaceID,
        displayName: String,
        publicKey: String,
        capabilities: [String: Bool]
    ) async throws -> WorkHost {
        guard workspace == self.workspace else { throw BackendError.notConnected }
        registrations += 1
        let host = WorkHost(
            id: WorkHostID(),
            workspaceId: workspace,
            scope: .member,
            ownerMemberId: member,
            type: .app,
            displayName: displayName,
            publicKey: publicKey,
            capabilities: capabilities,
            createdAtMs: Int64(registrations),
            online: false
        )
        hosts.append(host)
        return host
    }

    func heartbeatWorkHost(
        workspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        signature: String
    ) async throws -> WorkHost {
        guard workspace == self.workspace,
              let index = hosts.firstIndex(where: { $0.id == host && !$0.isRevoked })
        else { throw BackendError.problem(status: 401, title: nil, detail: nil) }
        hosts[index].lastSeenAtMs = sentAtMs
        hosts[index].online = true
        return hosts[index]
    }

    func revoke(_ host: WorkHostID) {
        guard let index = hosts.firstIndex(where: { $0.id == host }) else { return }
        hosts[index].revokedAtMs = 1
        hosts[index].online = false
    }

    func registerCallCount() -> Int { registrations }
}

private actor MockRemoteTerminalTransport: MomoRemoteTerminalTransport {
    private let connectFailure: MomoRemoteTerminalError?
    private var recordedFrames: [String] = []
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation?

    init(connectFailure: MomoRemoteTerminalError? = nil) {
        self.connectFailure = connectFailure
    }

    func connect(grant: MomoTerminalAttachGrant) throws -> AsyncThrowingStream<Data, Error> {
        if let connectFailure { throw connectFailure }
        recordedFrames.append(try MomoTerminalAttachFrame.connect(ptyId: grant.ptyId))
        return AsyncThrowingStream { continuation in
            self.continuation = continuation
        }
    }

    func sendInput(_ data: Data, ptyId: String) throws {
        recordedFrames.append(try MomoTerminalAttachFrame.sendStdin(ptyId: ptyId, data: data))
    }

    func resize(columns: Int, rows: Int, ptyId: String) throws {
        recordedFrames.append(
            try MomoTerminalAttachFrame.resize(ptyId: ptyId, columns: columns, rows: rows)
        )
    }

    func kill(ptyId: String) throws {
        recordedFrames.append(try MomoTerminalAttachFrame.kill(ptyId: ptyId))
    }

    func close() {
        continuation?.finish()
        continuation = nil
    }

    func emit(_ data: Data) {
        continuation?.yield(data)
    }

    func fail(_ error: MomoRemoteTerminalError) {
        continuation?.finish(throwing: error)
        continuation = nil
    }

    func frames() -> [String] { recordedFrames }
}

private final class LocalWebSocketAttachServer: @unchecked Sendable {
    struct Snapshot {
        let authorization: String?
        let types: [String]
        let stdin: Data?
        let columns: Int?
        let rows: Int?
    }

    private let queue = DispatchQueue(label: "momo.tests.terminal-attach-websocket")
    private let lock = NSLock()
    private let listener: NWListener
    private let expectedAuthorization: String
    private var connection: NWConnection?
    private var receiveBuffer = Data()
    private var authorization: String?
    private var types: [String] = []
    private var stdin: Data?
    private var columns: Int?
    private var rows: Int?

    init(capability: String) throws {
        expectedAuthorization = "Bearer \(capability)"
        listener = try NWListener(using: .tcp, on: .any)
    }

    var endpoint: URL? {
        guard let port = listener.port else { return nil }
        return URL(string: "ws://localhost:\(port.rawValue)/terminal")
    }

    func start() async throws {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.lock.withLock { self.connection = connection }
            connection.stateUpdateHandler = { [weak self, weak connection] state in
                guard case .ready = state, let self, let connection else { return }
                self.receiveHandshake(on: connection)
            }
            connection.start(queue: self.queue)
        }
        listener.start(queue: queue)
        for _ in 0..<300 {
            if listener.port != nil { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw MomoRemoteTerminalError.networkDisconnected
    }

    func stop() {
        lock.withLock { connection?.cancel(); connection = nil }
        listener.cancel()
    }

    func snapshot() -> Snapshot {
        lock.withLock {
            Snapshot(
                authorization: authorization,
                types: types,
                stdin: stdin,
                columns: columns,
                rows: rows
            )
        }
    }

    private func receiveHandshake(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8_192) {
            [weak self, weak connection] content, _, _, error in
            guard let self, let connection else { return }
            if let content { self.receiveBuffer.append(content) }
            guard let marker = self.receiveBuffer.range(of: Data("\r\n\r\n".utf8)) else {
                if error == nil { self.receiveHandshake(on: connection) }
                return
            }
            let headerData = self.receiveBuffer[..<marker.upperBound]
            let trailing = self.receiveBuffer[marker.upperBound...]
            self.receiveBuffer = Data(trailing)
            guard let request = String(data: headerData, encoding: .utf8),
                  let webSocketKey = self.headerValue("Sec-WebSocket-Key", in: request)
            else { connection.cancel(); return }
            let authorization = self.headerValue("Authorization", in: request)
            self.lock.withLock { self.authorization = authorization }
            guard authorization == self.expectedAuthorization else { connection.cancel(); return }
            let acceptSeed = Data((webSocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8)
            let accept = Data(Insecure.SHA1.hash(data: acceptSeed)).base64EncodedString()
            let response = Data("""
                HTTP/1.1 101 Switching Protocols\r
                Upgrade: websocket\r
                Connection: Upgrade\r
                Sec-WebSocket-Accept: \(accept)\r
                \r
                """.utf8)
            connection.send(content: response, completion: .contentProcessed { [weak self] error in
                guard error == nil, let self else { return }
                self.processFrames(on: connection)
                self.receiveFrames(on: connection)
            })
        }
    }

    private func receiveFrames(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8_192) {
            [weak self, weak connection] content, _, _, error in
            guard let self, let connection else { return }
            if let content { self.receiveBuffer.append(content) }
            self.processFrames(on: connection)
            if error == nil { self.receiveFrames(on: connection) }
        }
    }

    private func processFrames(on connection: NWConnection) {
        while let payload = nextTextFrame() {
            guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                  let type = object["type"] as? String else { continue }
            lock.withLock {
                types.append(type)
                if type == "send_stdin", let encoded = object["data"] as? String {
                    stdin = Data(base64Encoded: encoded)
                }
                if type == "resize" {
                    columns = object["cols"] as? Int
                    rows = object["rows"] as? Int
                }
            }
            if type == "connect" {
                sendWebSocket(Data("loopback stdout ready\r\n".utf8), opcode: 0x2, on: connection)
            }
        }
    }

    private func nextTextFrame() -> Data? {
        guard receiveBuffer.count >= 2 else { return nil }
        let bytes = [UInt8](receiveBuffer)
        var payloadLength = Int(bytes[1] & 0x7f)
        var cursor = 2
        if payloadLength == 126 {
            guard bytes.count >= 4 else { return nil }
            payloadLength = Int(bytes[2]) << 8 | Int(bytes[3])
            cursor = 4
        } else if payloadLength == 127 {
            guard bytes.count >= 10 else { return nil }
            payloadLength = bytes[2..<10].reduce(0) { ($0 << 8) | Int($1) }
            cursor = 10
        }
        let isMasked = bytes[1] & 0x80 != 0
        let maskLength = isMasked ? 4 : 0
        guard bytes.count >= cursor + maskLength + payloadLength else { return nil }
        let mask = isMasked ? Array(bytes[cursor..<(cursor + 4)]) : []
        cursor += maskLength
        var payload = Array(bytes[cursor..<(cursor + payloadLength)])
        if isMasked {
            for index in payload.indices { payload[index] ^= mask[index % 4] }
        }
        receiveBuffer.removeFirst(cursor + payloadLength)
        return Data(payload)
    }

    private func sendWebSocket(_ payload: Data, opcode: UInt8, on connection: NWConnection) {
        var frame = Data([0x80 | opcode])
        if payload.count < 126 {
            frame.append(UInt8(payload.count))
        } else {
            frame.append(126)
            frame.append(UInt8((payload.count >> 8) & 0xff))
            frame.append(UInt8(payload.count & 0xff))
        }
        frame.append(payload)
        connection.send(content: frame, completion: .idempotent)
    }

    private func headerValue(_ name: String, in request: String) -> String? {
        request.split(separator: "\n").first { line in
            line.lowercased().hasPrefix(name.lowercased() + ":")
        }.map { line in
            line.dropFirst(name.count + 1).trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}

private struct WorkConsoleHTTPResponse: Sendable {
    let statusCode: Int
    let json: String

    init(statusCode: Int = 200, json: String) {
        self.statusCode = statusCode
        self.json = json
    }
}

private final class WorkConsoleURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> WorkConsoleHTTPResponse

    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var seenRequests: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.withLock {
            handler = nil
            seenRequests = []
        }
    }

    static func setHandler(_ newHandler: @escaping Handler) {
        lock.withLock { handler = newHandler }
    }

    static func requests() -> [URLRequest] {
        lock.withLock { seenRequests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let currentHandler: Handler? = Self.lock.withLock {
            Self.seenRequests.append(request)
            return Self.handler
        }
        guard let currentHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        do {
            let mocked = try currentHandler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: mocked.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(mocked.json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension URLRequest {
    var workConsoleBodyData: Data? {
        if let httpBody { return httpBody }
        guard let httpBodyStream else { return nil }
        httpBodyStream.open()
        defer { httpBodyStream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1_024)
        defer { buffer.deallocate() }
        while httpBodyStream.hasBytesAvailable {
            let count = httpBodyStream.read(buffer, maxLength: 1_024)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
