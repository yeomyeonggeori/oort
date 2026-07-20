import AppKit
import CryptoKit
import Foundation
import MomoCore
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

        _ = try await backend.workSessions(workspace: workspace, activeOnly: true)
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
