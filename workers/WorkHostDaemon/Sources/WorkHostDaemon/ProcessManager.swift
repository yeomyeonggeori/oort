import Foundation
import MomoACPHost

final class ManagedProcess: @unchecked Sendable {
    enum Runtime: Sendable {
        case pty(HostPTYProcess)
        case acp(ACPClient)
    }

    let runtime: Runtime
    let output: FileHandle
    let ptyOutputState: ShellPTYOutputState?
    var exitCode: Int?
    var acknowledged = false
    var endReported = false
    var toolState: ToolState = .running
    var pendingTransitions: [ProcessManager.ToolTransition] = []

    enum ToolState {
        case running
        case idle
    }

    init(
        runtime: Runtime,
        output: FileHandle,
        ptyOutputState: ShellPTYOutputState? = nil
    ) {
        self.runtime = runtime
        self.output = output
        self.ptyOutputState = ptyOutputState
    }
}

actor ProcessManager {
    struct EndedSession: Sendable, Equatable {
        let sessionID: UUID
        let exitCode: Int
    }

    struct ToolTransition: Sendable, Equatable {
        enum Status: Sendable, Equatable {
            case running
            case idle(exitCode: Int)
        }

        let sessionID: UUID
        let status: Status
    }

    enum AttachMode: Sendable {
        case controller
        case observer
    }

    private var templates: [String: CommandTemplate]
    private let outputDirectory: URL
    private let hostEnvironment: [String: String]
    private let ringBufferBytes: Int
    private let acpEventRelay: (@Sendable (UUID, ACPProjectedEvent) async throws -> Void)?
    private var sessions: [UUID: ManagedProcess] = [:]

    init(
        templates: [String: CommandTemplate],
        outputDirectory: URL,
        hostEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        ringBufferBytes: Int = PTYReplayBuffer.defaultCapacityBytes,
        acpEventRelay: (@Sendable (UUID, ACPProjectedEvent) async throws -> Void)? = nil
    ) {
        self.templates = templates
        self.outputDirectory = outputDirectory
        self.hostEnvironment = hostEnvironment
        self.ringBufferBytes = max(1, ringBufferBytes)
        self.acpEventRelay = acpEventRelay
    }

    func replaceTemplates(_ templates: [String: CommandTemplate]) {
        self.templates = templates
    }

    func start(sessionID: UUID, channelID: UUID, tool: String, prompt: String) throws {
        guard sessions[sessionID] == nil,
              let template = templates[tool],
              FileManager.default.isExecutableFile(atPath: template.executable)
        else { throw WorkdFailure.processStart }
        do {
            try SecureLocalStore.ensurePrivateDirectory(outputDirectory)
            let outputURL = outputURL(for: sessionID)
            if !FileManager.default.createFile(atPath: outputURL.path, contents: nil) {
                throw WorkdFailure.processStart
            }
            try SecureLocalStore.setMode(0o600, at: outputURL)
            let output = try FileHandle(forWritingTo: outputURL)
            switch template.transport {
            case .pty:
                let environment = childEnvironment(for: template)
                let launch = ShellWrappedPTYLaunch.make(
                    template: template,
                    environment: environment
                )
                let process = try HostPTYProcess.launch(
                    executable: launch.shellExecutable,
                    arguments: launch.shellArguments,
                    environment: environment
                )
                let outputState = ShellPTYOutputState(
                    markerNonce: launch.markerNonce,
                    output: output,
                    capacityBytes: ringBufferBytes
                )
                process.onOutput { data in outputState.consume(data) }
                sessions[sessionID] = ManagedProcess(
                    runtime: .pty(process),
                    output: output,
                    ptyOutputState: outputState
                )
                try process.write(launch.bootstrap)
            case .acp:
                let eventURL = outputDirectory.appendingPathComponent(
                    "\(sessionID.uuidString.lowercased()).acp-events.jsonl"
                )
                let localSink = try ACPJSONLinesFileSink(url: eventURL)
                let sink: any ACPEventSink
                if let acpEventRelay {
                    let relaySink = ACPServerRelaySink { event in
                        try await acpEventRelay(sessionID, event)
                    }
                    sink = ACPCompositeEventSink([localSink, relaySink])
                } else {
                    sink = localSink
                }
                let terminals = LocalPTYTerminalManager(
                    defaultWorkingDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
                    baseEnvironment: childEnvironment(for: template)
                )
                let client = ACPClient(
                    command: ACPLaunchCommand(
                        executable: template.executable,
                        arguments: template.arguments,
                        workingDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
                        environment: childEnvironment(for: template)
                    ),
                    context: ACPHostContext(workSessionID: sessionID, channelID: channelID),
                    eventSink: sink,
                    // workd has no authority to decide on behalf of a human.
                    // An app approval bridge can inject a handler; daemon-only
                    // execution remains rejected until that existing owner does.
                    permissionHandler: ACPFailClosedPermissionHandler(),
                    terminalHandler: terminals
                )
                sessions[sessionID] = ManagedProcess(runtime: .acp(client), output: output)
                Task { [weak self] in
                    let exitCode: Int
                    do {
                        _ = try await client.prompt(prompt)
                        exitCode = 0
                    } catch {
                        exitCode = -1
                    }
                    await client.terminate()
                    await self?.markACPFinished(sessionID: sessionID, exitCode: exitCode)
                }
            }
        } catch {
            throw WorkdFailure.processStart
        }
    }

    func write(_ text: String, to sessionID: UUID) async throws {
        guard let managed = sessions[sessionID], managed.exitCode == nil else {
            throw WorkdFailure.stdinUnavailable
        }
        do {
            switch managed.runtime {
            case .pty(let process):
                try process.write(Data(text.utf8))
            case .acp(let client):
                _ = try await client.prompt(text)
            }
        } catch {
            throw WorkdFailure.stdinUnavailable
        }
    }

    func connect(ptyID: String) throws -> AsyncStream<PTYReplayEvent> {
        guard let sessionID = UUID(uuidString: ptyID),
              let managed = sessions[sessionID],
              let state = managed.ptyOutputState
        else { throw WorkdFailure.stdinUnavailable }
        return state.replay.connect()
    }

    func write(_ data: Data, toPTY ptyID: String, mode: AttachMode) throws {
        guard mode == .controller,
              let sessionID = UUID(uuidString: ptyID),
              let managed = sessions[sessionID],
              case .pty(let process) = managed.runtime
        else { throw WorkdFailure.stdinUnavailable }
        try process.write(data)
    }

    func ptyID(for sessionID: UUID) -> String? {
        guard sessions[sessionID]?.ptyOutputState != nil else { return nil }
        return sessionID.uuidString.lowercased()
    }

    func terminate(_ sessionID: UUID) async throws -> Int {
        guard let managed = sessions[sessionID] else {
            throw WorkdFailure.processTerminate
        }
        switch managed.runtime {
        case .pty(let process):
            // An interactive login shell may intentionally ignore SIGTERM.
            // Interrupt its current foreground tool, then ask the shell to
            // leave through its PTY so logout hooks and the working directory
            // are released cleanly; fall back to terminate.
            try? process.write(Data([0x03]))
            try? await Task.sleep(for: .milliseconds(50))
            try? process.write(Data("exit\n".utf8))
            let gracefulDeadline = ContinuousClock.now.advanced(by: .milliseconds(500))
            while process.isRunning, ContinuousClock.now < gracefulDeadline {
                try? await Task.sleep(for: .milliseconds(25))
            }
            if process.isRunning { process.terminate() }
            let deadline = ContinuousClock.now.advanced(by: .seconds(2))
            while process.isRunning, ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(50))
            }
            if process.isRunning {
                process.forceTerminate()
                let forcedDeadline = ContinuousClock.now.advanced(by: .seconds(1))
                while process.isRunning, ContinuousClock.now < forcedDeadline {
                    try? await Task.sleep(for: .milliseconds(25))
                }
            }
            guard !process.isRunning else { throw WorkdFailure.processTerminate }
            let code = process.exitCode ?? -1
            managed.exitCode = code
            return code
        case .acp(let client):
            await client.terminate()
            managed.exitCode = 143
            return 143
        }
    }

    func markAcknowledged(_ sessionID: UUID) {
        sessions[sessionID]?.acknowledged = true
    }

    func endedSessions() -> [EndedSession] {
        sessions.compactMap { sessionID, managed in
            let code: Int?
            switch managed.runtime {
            case .pty(let process): code = managed.exitCode ?? process.exitCode
            case .acp: code = managed.exitCode
            }
            guard managed.acknowledged, !managed.endReported, let code else { return nil }
            return EndedSession(sessionID: sessionID, exitCode: code)
        }
    }

    func toolTransitions() -> [ToolTransition] {
        for (sessionID, managed) in sessions {
            guard managed.acknowledged, let outputState = managed.ptyOutputState else { continue }
            for event in outputState.drainLifecycleEvents() {
                switch (managed.toolState, event) {
                case (.running, .idle(let exitCode)):
                    managed.toolState = .idle
                    managed.pendingTransitions.append(ToolTransition(
                        sessionID: sessionID,
                        status: .idle(exitCode: exitCode)
                    ))
                case (.idle, .running):
                    managed.toolState = .running
                    managed.pendingTransitions.append(ToolTransition(
                        sessionID: sessionID,
                        status: .running
                    ))
                case (.running, .running), (.idle, .idle):
                    break
                }
            }
        }
        return sessions.values.flatMap(\.pendingTransitions)
    }

    func markTransitionReported(_ transition: ToolTransition) {
        guard let managed = sessions[transition.sessionID],
              managed.pendingTransitions.first == transition
        else { return }
        managed.pendingTransitions.removeFirst()
    }

    func markEndReported(_ sessionID: UUID) {
        guard let managed = sessions.removeValue(forKey: sessionID) else { return }
        managed.endReported = true
        if case .pty(let process) = managed.runtime { process.close() }
        if let state = managed.ptyOutputState {
            state.close()
        } else {
            try? managed.output.close()
        }
    }

    func outputURL(for sessionID: UUID) -> URL {
        outputDirectory.appendingPathComponent("\(sessionID.uuidString.lowercased()).log")
    }

    private func markACPFinished(sessionID: UUID, exitCode: Int) {
        guard let managed = sessions[sessionID], managed.exitCode == nil else { return }
        managed.exitCode = exitCode
    }

    private func childEnvironment(for template: CommandTemplate) -> [String: String] {
        template.environmentPolicy.filtered(hostEnvironment)
    }
}
