import Foundation

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public final class HostPTYProcess: @unchecked Sendable {
    public let process: Process
    private let input: FileHandle
    private let output: FileHandle

    private init(process: Process, input: FileHandle, output: FileHandle) {
        self.process = process
        self.input = input
        self.output = output
    }

    public static func launch(
        executable: String,
        arguments: [String],
        workingDirectory: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> HostPTYProcess {
        let (master, slave) = try openPseudoTerminal()
        guard let inputDescriptor = Optional(dup(master)), inputDescriptor >= 0 else {
            systemClose(master)
            systemClose(slave)
            throw ACPHostError.terminalUnavailable
        }
        let masterInput = FileHandle(fileDescriptor: inputDescriptor, closeOnDealloc: true)
        let masterOutput = FileHandle(fileDescriptor: master, closeOnDealloc: true)
        let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: true)
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = arguments
        child.currentDirectoryURL = workingDirectory
        child.environment = environment
        child.standardInput = slaveHandle
        child.standardOutput = slaveHandle
        child.standardError = slaveHandle
        do {
            try child.run()
            try? slaveHandle.close()
            return HostPTYProcess(process: child, input: masterInput, output: masterOutput)
        } catch {
            try? masterInput.close()
            try? masterOutput.close()
            try? slaveHandle.close()
            throw ACPHostError.launchFailed
        }
    }

    public var isRunning: Bool { process.isRunning }

    public var exitCode: Int? {
        guard !process.isRunning else { return nil }
        return Int(process.terminationStatus)
    }

    public func write(_ data: Data) throws {
        try input.write(contentsOf: data)
    }

    public func onOutput(_ handler: @escaping @Sendable (Data) -> Void) {
        output.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            handler(data)
        }
    }

    public func terminate() {
        if process.isRunning { process.terminate() }
    }

    public func close() {
        output.readabilityHandler = nil
        try? input.close()
        try? output.close()
    }
}

private func systemClose(_ descriptor: Int32) {
#if canImport(Darwin)
    _ = Darwin.close(descriptor)
#else
    _ = Glibc.close(descriptor)
#endif
}

private func openPseudoTerminal() throws -> (master: Int32, slave: Int32) {
#if canImport(Darwin)
    var master: Int32 = -1
    var slave: Int32 = -1
    guard Darwin.openpty(&master, &slave, nil, nil, nil) == 0 else {
        throw ACPHostError.terminalUnavailable
    }
    return (master, slave)
#else
    let master = Glibc.posix_openpt(O_RDWR | O_NOCTTY)
    guard master >= 0,
          Glibc.grantpt(master) == 0,
          Glibc.unlockpt(master) == 0,
          let slaveName = Glibc.ptsname(master)
    else {
        if master >= 0 { systemClose(master) }
        throw ACPHostError.terminalUnavailable
    }
    let slave = Glibc.open(slaveName, O_RDWR | O_NOCTTY)
    guard slave >= 0 else {
        systemClose(master)
        throw ACPHostError.terminalUnavailable
    }
    return (master, slave)
#endif
}

public actor LocalPTYTerminalManager: ACPTerminalHandler {
    private final class Terminal: @unchecked Sendable {
        let process: HostPTYProcess
        var buffer = Data()
        var truncated = false

        init(process: HostPTYProcess) { self.process = process }
    }

    private let defaultWorkingDirectory: URL
    private let baseEnvironment: [String: String]
    private let maxBufferedBytes: Int
    private var terminals: [String: Terminal] = [:]

    public init(
        defaultWorkingDirectory: URL,
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        maxBufferedBytes: Int = 1_048_576
    ) {
        self.defaultWorkingDirectory = defaultWorkingDirectory
        self.baseEnvironment = baseEnvironment
        self.maxBufferedBytes = max(4_096, maxBufferedBytes)
    }

    public func create(_ request: ACPTerminalCreateRequest) async throws -> String {
        let cwd = request.workingDirectory.map(URL.init(fileURLWithPath:)) ?? defaultWorkingDirectory
        var environment = baseEnvironment
        for (key, value) in request.environment { environment[key] = value }
        let process = try HostPTYProcess.launch(
            executable: "/usr/bin/env",
            arguments: [request.command] + request.arguments,
            workingDirectory: cwd,
            environment: environment
        )
        let id = UUID().uuidString.lowercased()
        let terminal = Terminal(process: process)
        terminals[id] = terminal
        process.onOutput { [weak self] data in
            Task { await self?.append(data, terminalID: id) }
        }
        return id
    }

    public func output(terminalID: String) async throws -> ACPTerminalOutput {
        guard let terminal = terminals[terminalID] else {
            throw ACPHostError.terminalUnavailable
        }
        let data = terminal.buffer
        terminal.buffer.removeAll(keepingCapacity: true)
        let wasTruncated = terminal.truncated
        terminal.truncated = false
        return ACPTerminalOutput(
            output: String(decoding: data, as: UTF8.self),
            truncated: wasTruncated,
            exitCode: terminal.process.exitCode
        )
    }

    public func waitForExit(terminalID: String) async throws -> Int {
        guard let terminal = terminals[terminalID] else {
            throw ACPHostError.terminalUnavailable
        }
        while terminal.process.isRunning {
            try await Task.sleep(for: .milliseconds(25))
        }
        return terminal.process.exitCode ?? -1
    }

    public func kill(terminalID: String) async throws {
        guard let terminal = terminals[terminalID] else {
            throw ACPHostError.terminalUnavailable
        }
        terminal.process.terminate()
    }

    public func release(terminalID: String) async {
        guard let terminal = terminals.removeValue(forKey: terminalID) else { return }
        terminal.process.terminate()
        terminal.process.close()
    }

    private func append(_ data: Data, terminalID: String) {
        guard let terminal = terminals[terminalID] else { return }
        terminal.buffer.append(data)
        if terminal.buffer.count > maxBufferedBytes {
            terminal.buffer.removeFirst(terminal.buffer.count - maxBufferedBytes)
            terminal.truncated = true
        }
    }
}
