import Foundation
import XCTest
@testable import MomoACPHost
@testable import WorkHostDaemon

// =============================================================================
// WorkEngineAdapterTests — MOMO-579 / WH-1. Proves the three WorkEngineAdapter
// implementations conform to the same lifecycle + unified approval contract:
//   * ACPEngineAdapter (goose) over real stdio (mock_acp_agent.py)
//   * OpenCodeHTTPAdapter over a scripted mock transport
//   * CodexJSONRPCAdapter over real stdio (mock_codex_app_server.py)
// Each asserts normalization of engine-native approvals onto WorkApprovalRequest
// / WorkApprovalDecision, and fail-closed rejection when no bridge decides.
// =============================================================================
final class WorkEngineAdapterTests: XCTestCase {

    // MARK: - ACPEngineAdapter (goose)

    func testACPEngineAdapterNormalizesApprovalAndRunsApprovedBranch() async throws {
        let sink = WorkEventRecorder()
        let approvals = WorkApprovalRecorder(decision: .allow(optionID: "allow-once"))
        let terminals = WorkTerminalRecorder()
        let adapter = ACPEngineAdapter(
            command: try mockACPCommand(),
            context: sampleContext,
            eventSink: sink,
            approvalHandler: approvals,
            terminalHandler: terminals,
            nowMs: { 1_784_678_400_000 }
        )

        let sessionID = try await adapter.createSession(title: nil)
        XCTAssertEqual(sessionID, "mock-acp-session")
        let result = try await adapter.prompt(sessionID: sessionID, text: "prove goose approval")
        await adapter.shutdown()

        XCTAssertEqual(result.stopReason, "end_turn")
        let requests = await approvals.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].engine, .goose)
        XCTAssertEqual(Set(requests[0].options.map(\.optionID)), ["allow-once", "reject-once"])
        XCTAssertEqual(requests[0].options.first(where: { $0.optionID == "allow-once" })?.kind, .allowOnce)
        XCTAssertEqual(requests[0].options.first(where: { $0.optionID == "reject-once" })?.kind, .rejectOnce)
        let calls = await terminals.calls
        XCTAssertEqual(calls, ["create:printf", "output", "wait", "release"])
        let decided = await sink.events.first { $0.type == "approval.decided" }
        XCTAssertEqual(decided?.payload.objectValue?["status"]?.stringValue, "approved")
    }

    func testACPEngineAdapterFailsClosedWithoutBridge() async throws {
        let sink = WorkEventRecorder()
        let terminals = WorkTerminalRecorder()
        let adapter = ACPEngineAdapter(
            command: try mockACPCommand(),
            context: sampleContext,
            eventSink: sink,
            approvalHandler: WorkFailClosedApprovalHandler(),
            terminalHandler: terminals
        )

        let result = try await adapter.prompt(sessionID: "ignored", text: "prove rejection")
        await adapter.shutdown()

        XCTAssertEqual(result.stopReason, "refused")
        let calls = await terminals.calls
        XCTAssertEqual(calls, [])
        let decided = await sink.events.first { $0.type == "approval.decided" }
        XCTAssertEqual(decided?.payload.objectValue?["status"]?.stringValue, "rejected")
    }

    // MARK: - OpenCodeHTTPAdapter

    func testOpenCodeAdapterPostsApprovalResponseAndCompletesTurn() async throws {
        let transport = MockOpenCodeTransport()
        let sink = WorkEventRecorder()
        let adapter = OpenCodeHTTPAdapter(
            transport: transport,
            context: sampleContext,
            eventSink: sink,
            approvalHandler: WorkStaticApprovalHandler(.allow(optionID: "once")),
            nowMs: { 1_784_678_400_000 }
        )

        let sessionID = try await adapter.createSession(title: "WH-1 opencode smoke")
        XCTAssertEqual(sessionID, "ses_mock_wh1")
        let result = try await adapter.prompt(sessionID: sessionID, text: "prove opencode approval")
        await adapter.shutdown()

        XCTAssertEqual(result.stopReason, "end_turn")
        let posts = await transport.permissionPostsSnapshot()
        XCTAssertEqual(posts.count, 1)
        XCTAssertTrue(posts[0].path.hasSuffix("/permissions/perm-1"))
        XCTAssertEqual(posts[0].body.objectValue?["response"]?.stringValue, "once")

        let requested = await sink.events.first { $0.type == "approval.requested" }
        XCTAssertEqual(requested?.payload.objectValue?["engine"]?.stringValue, "opencode")
        let optionIDs = requested?.payload.objectValue?["options"]?.arrayValue?
            .compactMap { $0.objectValue?["option_id"]?.stringValue }
        XCTAssertEqual(optionIDs, ["once", "always", "reject"])
        let delta = await sink.events.first { $0.type == "agent.partial" }
        XCTAssertEqual(delta?.payload.objectValue?["text_delta"]?.stringValue, "mock opencode progress")
        let decided = await sink.events.first { $0.type == "approval.decided" }
        XCTAssertEqual(decided?.payload.objectValue?["status"]?.stringValue, "approved")
    }

    func testOpenCodeAdapterFailsClosedRejectsPermission() async throws {
        let transport = MockOpenCodeTransport()
        let sink = WorkEventRecorder()
        let adapter = OpenCodeHTTPAdapter(
            transport: transport,
            context: sampleContext,
            eventSink: sink,
            approvalHandler: WorkFailClosedApprovalHandler(),
            nowMs: { 1_784_678_400_000 }
        )

        let sessionID = try await adapter.createSession(title: nil)
        let result = try await adapter.prompt(sessionID: sessionID, text: "prove opencode rejection")
        await adapter.shutdown()

        XCTAssertEqual(result.stopReason, "end_turn")
        let posts = await transport.permissionPostsSnapshot()
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts[0].body.objectValue?["response"]?.stringValue, "reject")
        let decided = await sink.events.first { $0.type == "approval.decided" }
        XCTAssertEqual(decided?.payload.objectValue?["status"]?.stringValue, "rejected")
    }

    // MARK: - CodexJSONRPCAdapter

    func testCodexAdapterHandshakeStreamAndApprovedTurn() async throws {
        let sink = WorkEventRecorder()
        let adapter = CodexJSONRPCAdapter(
            command: try mockCodexCommand(),
            context: sampleContext,
            eventSink: sink,
            approvalHandler: WorkStaticApprovalHandler(.allow(optionID: "approved")),
            nowMs: { 1_784_678_400_000 }
        )

        let threadID = try await adapter.createSession(title: nil)
        XCTAssertEqual(threadID, "mock-codex-thread")
        let result = try await adapter.prompt(sessionID: threadID, text: "prove codex approval")
        await adapter.shutdown()

        XCTAssertEqual(result.stopReason, "end_turn")
        let requested = await sink.events.first { $0.type == "approval.requested" }
        XCTAssertEqual(requested?.payload.objectValue?["engine"]?.stringValue, "codex-local")
        let optionIDs = requested?.payload.objectValue?["options"]?.arrayValue?
            .compactMap { $0.objectValue?["option_id"]?.stringValue }
        XCTAssertEqual(optionIDs, ["approved", "approved_for_session", "denied"])
        let deltas = await sink.events.filter { $0.type == "agent.partial" }
            .compactMap { $0.payload.objectValue?["text_delta"]?.stringValue }
        XCTAssertTrue(deltas.contains("mock codex progress"))
        XCTAssertTrue(deltas.contains("approved branch executed"))
        let decided = await sink.events.first { $0.type == "approval.decided" }
        XCTAssertEqual(decided?.payload.objectValue?["status"]?.stringValue, "approved")
    }

    func testCodexAdapterFailsClosedDeniesTurn() async throws {
        let sink = WorkEventRecorder()
        let adapter = CodexJSONRPCAdapter(
            command: try mockCodexCommand(),
            context: sampleContext,
            eventSink: sink,
            approvalHandler: WorkFailClosedApprovalHandler()
        )

        let threadID = try await adapter.createSession(title: nil)
        let result = try await adapter.prompt(sessionID: threadID, text: "prove codex rejection")
        await adapter.shutdown()

        XCTAssertEqual(result.stopReason, "refused")
        let decided = await sink.events.first { $0.type == "approval.decided" }
        XCTAssertEqual(decided?.payload.objectValue?["status"]?.stringValue, "rejected")
    }

    // MARK: - Fixtures

    private var sampleContext: ACPHostContext {
        ACPHostContext(
            workSessionID: UUID(uuidString: "00000000-0000-7000-8000-000000000579")!,
            channelID: UUID(uuidString: "00000000-0000-7000-8000-000000000202")!
        )
    }

    private func mockACPCommand() throws -> ACPLaunchCommand {
        try mockCommand(
            envKey: "MOMO_ACP_MOCK_AGENT",
            relativePath: "scripts/mock_acp_agent.py"
        )
    }

    private func mockCodexCommand() throws -> ACPLaunchCommand {
        try mockCommand(
            envKey: "MOMO_CODEX_MOCK_AGENT",
            relativePath: "scripts/mock_codex_app_server.py"
        )
    }

    private func mockCommand(envKey: String, relativePath: String) throws -> ACPLaunchCommand {
        let configured = ProcessInfo.processInfo.environment[envKey]
        let script = configured ?? URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // WorkHostDaemonTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // WorkHostDaemon
            .deletingLastPathComponent() // workers
            .deletingLastPathComponent() // repo root
            .appendingPathComponent(relativePath).path
        guard FileManager.default.fileExists(atPath: script) else {
            throw XCTSkip("mock agent not found at \(script)")
        }
        return ACPLaunchCommand(
            executable: "/usr/bin/python3",
            arguments: [script],
            workingDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        )
    }
}

// MARK: - Recorders + scripted transport

private actor WorkEventRecorder: ACPEventSink {
    private(set) var events: [ACPProjectedEvent] = []
    func emit(_ event: ACPProjectedEvent) async { events.append(event) }
}

private actor WorkApprovalRecorder: WorkApprovalHandler {
    private let decision: WorkApprovalDecision
    private(set) var requests: [WorkApprovalRequest] = []
    init(decision: WorkApprovalDecision) { self.decision = decision }
    func decide(_ request: WorkApprovalRequest) async -> WorkApprovalDecision {
        requests.append(request)
        return decision
    }
}

private actor WorkTerminalRecorder: ACPTerminalHandler {
    private(set) var calls: [String] = []
    func create(_ request: ACPTerminalCreateRequest) async throws -> String {
        calls.append("create:\(request.command)")
        return "mock-terminal-id"
    }
    func output(terminalID: String) async throws -> ACPTerminalOutput {
        calls.append("output")
        return ACPTerminalOutput(output: "mock-terminal", truncated: false, exitCode: nil)
    }
    func waitForExit(terminalID: String) async throws -> Int {
        calls.append("wait")
        return 0
    }
    func kill(terminalID: String) async throws { calls.append("kill") }
    func release(terminalID: String) async { calls.append("release") }
}

/// Scripts one opencode turn: POST /session -> id; POST /message streams a delta
/// + a permission request over SSE; POST /permissions records the decision and
/// then streams session.idle so the turn completes only after the approval.
private actor MockOpenCodeTransport: OpenCodeTransport {
    private let stream: AsyncThrowingStream<ACPValue, any Error>
    private let continuation: AsyncThrowingStream<ACPValue, any Error>.Continuation
    private var permissionPosts: [(path: String, body: ACPValue)] = []
    private let sessionID = "ses_mock_wh1"

    init() {
        var captured: AsyncThrowingStream<ACPValue, any Error>.Continuation!
        stream = AsyncThrowingStream { captured = $0 }
        continuation = captured
    }

    func permissionPostsSnapshot() -> [(path: String, body: ACPValue)] {
        permissionPosts
    }

    func send(_ request: OpenCodeHTTPRequest) async throws -> OpenCodeHTTPResponse {
        if request.method == "POST", request.path == "/session" {
            return OpenCodeHTTPResponse(status: 200, body: .object(["id": .string(sessionID)]))
        }
        if request.method == "POST", request.path == "/session/\(sessionID)/message" {
            continuation.yield(.object([
                "type": .string("message.part.updated"),
                "properties": .object([
                    "sessionID": .string(sessionID),
                    "part": .object(["text": .string("mock opencode progress")]),
                ]),
            ]))
            continuation.yield(.object([
                "type": .string("permission.updated"),
                "properties": .object([
                    "sessionID": .string(sessionID),
                    "permissionID": .string("perm-1"),
                    "title": .string("Run mock command"),
                    "tool": .string("bash"),
                ]),
            ]))
            return OpenCodeHTTPResponse(status: 200, body: .object(["status": .string("ok")]))
        }
        if request.method == "POST", request.path.hasPrefix("/session/\(sessionID)/permissions/") {
            permissionPosts.append((request.path, request.body ?? .object([:])))
            continuation.yield(.object([
                "type": .string("session.idle"),
                "properties": .object(["sessionID": .string(sessionID)]),
            ]))
            continuation.finish()
            return OpenCodeHTTPResponse(status: 200, body: .object([:]))
        }
        return OpenCodeHTTPResponse(status: 404, body: .object([:]))
    }

    func events() async throws -> AsyncThrowingStream<ACPValue, any Error> {
        stream
    }
}
