import Foundation
import MomoACPHost

final class ManagedProcess: @unchecked Sendable {
    enum Runtime: Sendable {
        case pty(HostPTYProcess)
        case acp(ACPClient)
    }

    let runtime: Runtime
    let output: FileHandle
    var exitCode: Int?
    var acknowledged = false
    var endReported = false

    init(runtime: Runtime, output: FileHandle) {
        self.runtime = runtime
        self.output = output
    }
}

actor ProcessManager {
    struct EndedSession: Sendable, Equatable {
        let sessionID: UUID
        let exitCode: Int
    }

    private var templates: [String: CommandTemplate]
    private let outputDirectory: URL
    private var sessions: [UUID: ManagedProcess] = [:]

    init(templates: [String: CommandTemplate], outputDirectory: URL) {
        self.templates = templates
        self.outputDirectory = outputDirectory
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
                let process = try HostPTYProcess.launch(
                    executable: template.executable,
                    arguments: template.arguments,
                    environment: hostEnvironment()
                )
                process.onOutput { data in try? output.write(contentsOf: data) }
                sessions[sessionID] = ManagedProcess(runtime: .pty(process), output: output)
            case .acp:
                let eventURL = outputDirectory.appendingPathComponent(
                    "\(sessionID.uuidString.lowercased()).acp-events.jsonl"
                )
                let sink = try ACPJSONLinesFileSink(url: eventURL)
                let terminals = LocalPTYTerminalManager(
                    defaultWorkingDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
                    baseEnvironment: hostEnvironment()
                )
                let client = ACPClient(
                    command: ACPLaunchCommand(
                        executable: template.executable,
                        arguments: template.arguments,
                        workingDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
                        environment: hostEnvironment()
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

    func terminate(_ sessionID: UUID) async throws -> Int {
        guard let managed = sessions[sessionID] else {
            throw WorkdFailure.processTerminate
        }
        switch managed.runtime {
        case .pty(let process):
            process.terminate()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while process.isRunning, ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(50))
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

    func markEndReported(_ sessionID: UUID) {
        guard let managed = sessions[sessionID] else { return }
        managed.endReported = true
        if case .pty(let process) = managed.runtime { process.close() }
        try? managed.output.close()
    }

    func outputURL(for sessionID: UUID) -> URL {
        outputDirectory.appendingPathComponent("\(sessionID.uuidString.lowercased()).log")
    }

    private func markACPFinished(sessionID: UUID, exitCode: Int) {
        guard let managed = sessions[sessionID], managed.exitCode == nil else { return }
        managed.exitCode = exitCode
    }

    private func hostEnvironment() -> [String: String] {
        ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("MOMO_WORKD_") }
    }
}
