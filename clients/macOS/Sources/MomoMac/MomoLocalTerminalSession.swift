import AppKit
import Foundation
import SwiftTerm
import SwiftUI

enum MomoWorkHostRuntime {
    static var isAppSandboxed: Bool {
        ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil
    }
}

struct MomoWorkLaunchSpec: Equatable {
    let executable: String
    let arguments: [String]
    let environment: [String]

    static func resolve(
        tool: MomoWorkTool,
        environment source: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) throws -> MomoWorkLaunchSpec {
        guard !MomoWorkHostRuntime.isAppSandboxed else {
            throw MomoWorkConsoleError.sandboxRestricted
        }

        let executable: String
        let arguments: [String]
        switch tool {
        case .shell:
            let candidate = source["SHELL"] ?? "/bin/zsh"
            executable = candidate.hasPrefix("/") && fileManager.isExecutableFile(atPath: candidate)
                ? candidate
                : "/bin/zsh"
            arguments = ["-l"]
        case .claude, .codex, .opencode:
            guard let resolved = resolveExecutable(
                named: tool.rawValue,
                environment: source,
                fileManager: fileManager
            ) else {
                throw MomoWorkConsoleError.executableUnavailable(tool)
            }
            executable = resolved
            arguments = []
        }

        return MomoWorkLaunchSpec(
            executable: executable,
            arguments: arguments,
            environment: allowedEnvironment(source)
        )
    }

    private static func resolveExecutable(
        named name: String,
        environment: [String: String],
        fileManager: FileManager
    ) -> String? {
        let home = environment["HOME"] ?? fileManager.homeDirectoryForCurrentUser.path
        let conventional = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.local/bin",
            "\(home)/.npm-global/bin",
        ]
        let pathEntries = (environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        for directory in pathEntries + conventional where !directory.isEmpty {
            let candidate = URL(fileURLWithPath: directory)
                .appendingPathComponent(name, isDirectory: false)
                .path
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private static func allowedEnvironment(_ source: [String: String]) -> [String] {
        var values = Terminal.getEnvironmentVariables(termName: "xterm-256color")
        for key in ["PATH", "SHELL", "TMPDIR"] {
            if let value = source[key], !value.isEmpty {
                values.removeAll { $0.hasPrefix("\(key)=") }
                values.append("\(key)=\(value)")
            }
        }
        return values
    }
}

@MainActor
final class MomoLocalTerminalSession: ObservableObject, Identifiable {
    let id = UUID()
    let terminalView: LocalProcessTerminalView
    @Published private(set) var isRunning = false
    @Published private(set) var exitCode: Int?

    private let onTermination: @MainActor (Int?) -> Void
    private var processBridge: ProcessBridge!
    private var didReportTermination = false

    init(onTermination: @escaping @MainActor (Int?) -> Void) {
        self.onTermination = onTermination
        terminalView = LocalProcessTerminalView(frame: .zero)
        processBridge = ProcessBridge { [weak self] code in
            guard let self, !self.didReportTermination else { return }
            self.didReportTermination = true
            self.isRunning = false
            self.exitCode = code
            self.onTermination(code)
        }
        terminalView.processDelegate = processBridge
        terminalView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        terminalView.optionAsMetaKey = true
        applyTheme(.defaultPreset)
    }

    func start(tool: MomoWorkTool, directory: URL?) throws {
        let spec = try MomoWorkLaunchSpec.resolve(tool: tool)
        terminalView.startProcess(
            executable: spec.executable,
            args: spec.arguments,
            environment: spec.environment,
            currentDirectory: directory?.path
        )
        guard terminalView.process.running else {
            throw MomoWorkConsoleError.localLaunchFailed
        }
        isRunning = true
    }

    func sendInput(_ text: String, appendNewline: Bool = true) {
        guard isRunning else { return }
        let payload = appendNewline && !text.hasSuffix("\n") ? text + "\n" : text
        let bytes = [UInt8](payload.utf8)
        terminalView.send(source: terminalView, data: bytes[...])
    }

    func terminate() {
        guard isRunning else { return }
        terminalView.terminate()
        isRunning = false
    }

    func focus() {
        terminalView.window?.makeFirstResponder(terminalView)
    }

    func applyTheme(_ preset: MomoTerminalThemePreset) {
        preset.theme.apply(to: terminalView)
    }

    func tail(lineCount: Int) -> String {
        let boundedCount = max(1, min(lineCount, 9_999))
        let data = terminalView.terminal.getBufferAsData(kind: .active)
        guard let text = String(data: data, encoding: .utf8) else { return "" }
        return text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .suffix(boundedCount)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private final class ProcessBridge: NSObject, LocalProcessTerminalViewDelegate, @unchecked Sendable {
        private let onTermination: @MainActor (Int?) -> Void

        init(onTermination: @escaping @MainActor (Int?) -> Void) {
            self.onTermination = onTermination
        }

        func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

        func processTerminated(source: TerminalView, exitCode: Int32?) {
            let normalized = exitCode.map(Self.normalizedExitCode)
            Task { @MainActor [onTermination] in
                onTermination(normalized)
            }
        }

        private static func normalizedExitCode(_ status: Int32) -> Int {
            let signal = Int(status & 0x7f)
            return signal == 0 ? Int((status >> 8) & 0xff) : 128 + signal
        }
    }
}

struct MomoSwiftTermView: NSViewRepresentable {
    @ObservedObject var session: MomoLocalTerminalSession
    let theme: MomoTerminalThemePreset

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        session.applyTheme(theme)
        return session.terminalView
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {
        session.applyTheme(theme)
    }
}
