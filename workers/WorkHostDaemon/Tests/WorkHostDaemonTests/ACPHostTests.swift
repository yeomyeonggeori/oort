import Foundation
import XCTest
@testable import MomoACPHost
@testable import WorkHostDaemon

final class ACPHostTests: XCTestCase {
    func testApprovalProjectsUpdatesAndDelegatesTerminal() async throws {
        let sink = EventRecorder()
        let permissions = PermissionRecorder(decision: .selected(optionID: "allow-once"))
        let terminals = TerminalRecorder()
        let client = ACPClient(
            command: try mockCommand(),
            context: ACPHostContext(
                workSessionID: UUID(uuidString: "00000000-0000-7000-8000-000000000531")!,
                channelID: UUID(uuidString: "00000000-0000-7000-8000-000000000202")!
            ),
            eventSink: sink,
            permissionHandler: permissions,
            terminalHandler: terminals,
            nowMs: { 1_784_678_400_000 }
        )

        let result = try await client.prompt("prove the ACP approval branch")
        await client.terminate()

        XCTAssertEqual(result.acpSessionID, "mock-acp-session")
        XCTAssertEqual(result.stopReason, "end_turn")
        let events = await sink.events
        XCTAssertEqual(events.map(\.type), [
            "agent.partial", "agent.status", "approval.requested",
            "approval.decided", "agent.partial",
        ])
        XCTAssertEqual(events[0].payload.objectValue?["text_delta"]?.stringValue, "mock progress")
        XCTAssertEqual(events[1].payload.objectValue?["has_plan"], .bool(true))
        XCTAssertNotNil(events[1].payload.objectValue?["_meta"]?.objectValue?["acp"])
        XCTAssertEqual(events[3].payload.objectValue?["status"]?.stringValue, "approved")
        XCTAssertEqual(events[4].payload.objectValue?["text_delta"]?.stringValue, "approved branch executed")
        let permissionRequests = await permissions.requests
        let terminalCalls = await terminals.calls
        XCTAssertEqual(permissionRequests.count, 1)
        XCTAssertEqual(terminalCalls, ["create:printf", "output", "wait", "release"])
    }

    func testPermissionDefaultsToFailClosedAndDoesNotRunTerminal() async throws {
        let sink = EventRecorder()
        let terminals = TerminalRecorder()
        let client = ACPClient(
            command: try mockCommand(),
            context: ACPHostContext(workSessionID: UUID(), channelID: UUID()),
            eventSink: sink,
            terminalHandler: terminals
        )

        let result = try await client.prompt("prove rejection")
        await client.terminate()

        XCTAssertEqual(result.stopReason, "refused")
        let events = await sink.events
        XCTAssertEqual(events.first(where: { $0.type == "approval.decided" })?
            .payload.objectValue?["status"]?.stringValue, "rejected")
        XCTAssertEqual(events.last?.payload.objectValue?["text_delta"]?.stringValue, "rejected branch stopped")
        let terminalCalls = await terminals.calls
        XCTAssertEqual(terminalCalls, [])
    }

    func testProfileTransportIsProjectionDrivenAndUnknownValuesFailClosed() throws {
        let workspaceID = UUID()
        let acp = profile(workspaceID: workspaceID, transport: "acp")
        let templates = try WorkdConfig.commandTemplates(profiles: [acp], localOverrides: [:])
        XCTAssertEqual(templates["mock-acp"]?.transport, .acp)

        let unknown = profile(workspaceID: workspaceID, transport: "custom-wire")
        XCTAssertThrowsError(try WorkdConfig.commandTemplates(profiles: [unknown], localOverrides: [:]))
    }

    func testHostPTYProvidesInteractiveTTYInsteadOfPipe() async throws {
        let process = try HostPTYProcess.launch(
            executable: "/bin/sh",
            arguments: ["-c", "test -t 0 && test -t 1 && printf pty-ok"]
        )
        let recorder = DataRecorder()
        process.onOutput { data in Task { await recorder.append(data) } }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while process.isRunning, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(process.exitCode, 0)
        let output = await recorder.string
        XCTAssertTrue(output.contains("pty-ok"))
        process.close()
    }

    private func mockCommand() throws -> ACPLaunchCommand {
        let configured = ProcessInfo.processInfo.environment["MOMO_ACP_MOCK_AGENT"]
        let script = configured ?? URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("scripts/mock_acp_agent.py").path
        guard FileManager.default.fileExists(atPath: script) else {
            throw XCTSkip("mock ACP agent not found")
        }
        return ACPLaunchCommand(
            executable: "/usr/bin/python3",
            arguments: [script],
            workingDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        )
    }

    private func profile(workspaceID: UUID, transport: String) -> WorkToolProfile {
        WorkToolProfile(
            id: UUID(), workspaceId: workspaceID, toolKey: "mock-acp", displayName: "Mock ACP",
            launchTemplate: WorkToolLaunchTemplate(command: "mock-acp", arguments: []),
            tierDefaults: .object(["transport": .string(transport)]), enabled: true,
            createdBy: UUID(), updatedBy: UUID(), createdAtMs: 1, updatedAtMs: 1
        )
    }
}

private actor EventRecorder: ACPEventSink {
    private(set) var events: [ACPProjectedEvent] = []
    func emit(_ event: ACPProjectedEvent) async { events.append(event) }
}

private actor PermissionRecorder: ACPPermissionHandler {
    private let decision: ACPPermissionDecision
    private(set) var requests: [ACPPermissionRequest] = []
    init(decision: ACPPermissionDecision) { self.decision = decision }
    func decide(_ request: ACPPermissionRequest) async -> ACPPermissionDecision {
        requests.append(request)
        return decision
    }
}

private actor TerminalRecorder: ACPTerminalHandler {
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

private actor DataRecorder {
    private var data = Data()
    var string: String { String(decoding: data, as: UTF8.self) }
    func append(_ value: Data) { data.append(value) }
}
