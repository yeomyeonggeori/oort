import Foundation

final class ManagedProcess: @unchecked Sendable {
    let process: Process
    let stdin: FileHandle
    let output: FileHandle
    var acknowledged = false
    var endReported = false

    init(process: Process, stdin: FileHandle, output: FileHandle) {
        self.process = process
        self.stdin = stdin
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

    func start(sessionID: UUID, tool: String) throws {
        guard sessions[sessionID] == nil,
              let template = templates[tool],
              FileManager.default.isExecutableFile(atPath: template.executable)
        else { throw WorkdFailure.processStart }
        do {
            try SecureLocalStore.ensurePrivateDirectory(outputDirectory)
            let outputURL = outputDirectory.appendingPathComponent(
                "\(sessionID.uuidString.lowercased()).log"
            )
            if !FileManager.default.createFile(atPath: outputURL.path, contents: nil) {
                throw WorkdFailure.processStart
            }
            try SecureLocalStore.setMode(0o600, at: outputURL)
            let output = try FileHandle(forWritingTo: outputURL)
            let input = Pipe()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: template.executable)
            process.arguments = template.arguments
            process.standardInput = input
            process.standardOutput = output
            process.standardError = output
            process.environment = ProcessInfo.processInfo.environment.filter {
                !$0.key.hasPrefix("MOMO_WORKD_")
            }
            try process.run()
            sessions[sessionID] = ManagedProcess(
                process: process,
                stdin: input.fileHandleForWriting,
                output: output
            )
        } catch {
            throw WorkdFailure.processStart
        }
    }

    func write(_ text: String, to sessionID: UUID) throws {
        guard let managed = sessions[sessionID], managed.process.isRunning else {
            throw WorkdFailure.stdinUnavailable
        }
        do {
            try managed.stdin.write(contentsOf: Data(text.utf8))
        } catch {
            throw WorkdFailure.stdinUnavailable
        }
    }

    func terminate(_ sessionID: UUID) async throws -> Int {
        guard let managed = sessions[sessionID] else {
            throw WorkdFailure.processTerminate
        }
        if managed.process.isRunning { managed.process.terminate() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while managed.process.isRunning, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard !managed.process.isRunning else { throw WorkdFailure.processTerminate }
        return Int(managed.process.terminationStatus)
    }

    func markAcknowledged(_ sessionID: UUID) {
        sessions[sessionID]?.acknowledged = true
    }

    func endedSessions() -> [EndedSession] {
        sessions.compactMap { sessionID, managed in
            guard managed.acknowledged, !managed.endReported, !managed.process.isRunning else {
                return nil
            }
            return EndedSession(
                sessionID: sessionID,
                exitCode: Int(managed.process.terminationStatus)
            )
        }
    }

    func markEndReported(_ sessionID: UUID) {
        guard let managed = sessions[sessionID] else { return }
        managed.endReported = true
        try? managed.stdin.close()
        try? managed.output.close()
    }

    func outputURL(for sessionID: UUID) -> URL {
        outputDirectory.appendingPathComponent("\(sessionID.uuidString.lowercased()).log")
    }
}
