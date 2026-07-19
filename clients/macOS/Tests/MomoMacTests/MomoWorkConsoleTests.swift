import Foundation
import MomoCore
import XCTest
@testable import MomoMac

final class MomoWorkConsoleTests: XCTestCase {
    func testHostIdentityPrefersEnvironmentAndPersistsOnlyOpaqueIdentifier() throws {
        let configured = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let suiteName = "MomoWorkConsoleTests.\(UUID())"
        let suite = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { suite.removePersistentDomain(forName: suiteName) }

        XCTAssertEqual(
            MomoWorkHostIdentity.resolve(
                environment: ["MOMO_WORK_HOST_ID": configured.description],
                defaults: suite
            ),
            configured
        )
        XCTAssertNil(suite.string(forKey: MomoWorkHostIdentity.defaultsKey))

        let generated = MomoWorkHostIdentity.resolve(environment: [:], defaults: suite)
        XCTAssertEqual(
            MomoWorkHostIdentity.resolve(environment: [:], defaults: suite),
            generated
        )
        let persisted = try XCTUnwrap(suite.string(forKey: MomoWorkHostIdentity.defaultsKey))
        XCTAssertNotNil(UUID(uuidString: persisted))
        XCTAssertFalse(persisted.contains("/"))
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
