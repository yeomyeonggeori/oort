import Foundation
import MomoACPHost

enum ToolLifecycleEvent: Sendable, Equatable {
    case running
    case idle(exitCode: Int)
}

struct ShellWrappedPTYLaunch: Sendable {
    let shellExecutable: String
    let shellArguments: [String]
    let bootstrap: Data
    let markerNonce: String

    static func make(
        template: CommandTemplate,
        environment: [String: String],
        nonce: String = UUID().uuidString.lowercased()
    ) -> ShellWrappedPTYLaunch {
        let requestedShell = environment["SHELL"].flatMap { path in
            FileManager.default.isExecutableFile(atPath: path) ? path : nil
        }
        let shell = requestedShell ?? ["/bin/zsh", "/bin/bash", "/bin/sh"]
            .first(where: FileManager.default.isExecutableFile(atPath:)) ?? "/bin/sh"
        let commandName: String
        if template.executable == "/usr/bin/env", let first = template.arguments.first {
            commandName = URL(fileURLWithPath: first).lastPathComponent
        } else {
            commandName = URL(fileURLWithPath: template.executable).lastPathComponent
        }
        let functionName = commandName.wholeMatch(of: /^[A-Za-z_][A-Za-z0-9_.-]*$/) != nil
            ? commandName
            : "momo_tool"
        let command = ([template.executable] + template.arguments)
            .map(shellQuote)
            .joined(separator: " ")
        let marker = "momo-tool-\(nonce)"

        // "Tool" deliberately means the configured profile launch command,
        // not every child of the interactive shell. Only this wrapper function
        // emits lifecycle markers, so `ls`, prompt helpers, and shell startup
        // scripts do not flap a work_session running↔idle. Re-running the same
        // canonical command name after attach calls the persistent function and
        // produces the next running/idle pair.
        let script = """
        stty -echo
        \(functionName)() {
          printf '\\033]777;\(marker):running\\007'
          command \(command) "$@"
          __momo_tool_exit=$?
          printf '\\033]777;\(marker):idle:%s\\007' "$__momo_tool_exit"
          return "$__momo_tool_exit"
        }
        stty echo
        \(functionName)

        """
        return ShellWrappedPTYLaunch(
            shellExecutable: shell,
            shellArguments: ["-l"],
            bootstrap: Data(script.utf8),
            markerNonce: nonce
        )
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}

final class ShellPTYOutputState: @unchecked Sendable {
    private let consumeLock = NSLock()
    private let lock = NSLock()
    private let markerPrefix: Data
    private let output: FileHandle
    let replay: PTYReplayBuffer
    private var undecoded = Data()
    private var lifecycleEvents: [ToolLifecycleEvent] = []

    init(
        markerNonce: String,
        output: FileHandle,
        capacityBytes: Int,
        subscriberQueueBytes: Int? = nil
    ) {
        markerPrefix = Data("\u{1B}]777;momo-tool-\(markerNonce):".utf8)
        self.output = output
        replay = PTYReplayBuffer(
            capacityBytes: capacityBytes,
            subscriberQueueBytes: subscriberQueueBytes
        )
    }

    func consume(_ incoming: Data) {
        consumeLock.withLock {
            consumeInOrder(incoming)
        }
    }

    private func consumeInOrder(_ incoming: Data) {
        let decoded = lock.withLock { () -> (chunks: [Data], events: [ToolLifecycleEvent]) in
            undecoded.append(incoming)
            var chunks: [Data] = []
            var events: [ToolLifecycleEvent] = []
            while let markerRange = undecoded.range(of: markerPrefix) {
                if markerRange.lowerBound > undecoded.startIndex {
                    chunks.append(Data(undecoded[..<markerRange.lowerBound]))
                }
                undecoded.removeSubrange(undecoded.startIndex..<markerRange.upperBound)
                guard let terminator = undecoded.firstIndex(of: 0x07) else {
                    undecoded.insert(contentsOf: markerPrefix, at: undecoded.startIndex)
                    lifecycleEvents.append(contentsOf: events)
                    return (chunks, events)
                }
                let payload = String(decoding: undecoded[..<terminator], as: UTF8.self)
                undecoded.removeSubrange(undecoded.startIndex...terminator)
                if payload == "running" {
                    events.append(.running)
                } else if payload.hasPrefix("idle:"),
                          let code = Int(payload.dropFirst("idle:".count))
                {
                    events.append(.idle(exitCode: code))
                }
            }
            let keep = markerPrefixSuffixLength(in: undecoded)
            let emitCount = undecoded.count - keep
            if emitCount > 0 {
                chunks.append(Data(undecoded.prefix(emitCount)))
                undecoded.removeFirst(emitCount)
            }
            lifecycleEvents.append(contentsOf: events)
            return (chunks, events)
        }
        for chunk in decoded.chunks where !chunk.isEmpty {
            try? output.write(contentsOf: chunk)
            replay.append(chunk)
        }
    }

    func drainLifecycleEvents() -> [ToolLifecycleEvent] {
        lock.withLock {
            defer { lifecycleEvents.removeAll(keepingCapacity: true) }
            return lifecycleEvents
        }
    }

    func close() {
        replay.finish()
        try? output.close()
    }

    private func markerPrefixSuffixLength(in data: Data) -> Int {
        let maximum = min(data.count, max(0, markerPrefix.count - 1))
        guard maximum > 0 else { return 0 }
        for length in stride(from: maximum, through: 1, by: -1) {
            if data.suffix(length).elementsEqual(markerPrefix.prefix(length)) {
                return length
            }
        }
        return 0
    }
}
