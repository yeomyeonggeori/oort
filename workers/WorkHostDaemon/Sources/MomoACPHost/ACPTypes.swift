import Foundation

public enum ACPHostError: Error, Sendable, Equatable {
    case alreadyRunning
    case notRunning
    case launchFailed
    case transportClosed
    case malformedMessage
    case protocolError(code: Int, message: String)
    case invalidResponse(String)
    case terminalUnavailable
}

public struct ACPLaunchCommand: Sendable, Equatable {
    public let executable: String
    public let arguments: [String]
    public let workingDirectory: URL
    public let environment: [String: String]

    public init(
        executable: String,
        arguments: [String] = [],
        workingDirectory: URL,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

public struct ACPHostContext: Sendable, Equatable {
    public let workSessionID: UUID
    public let channelID: UUID
    public let agentMemberID: UUID?

    public init(workSessionID: UUID, channelID: UUID, agentMemberID: UUID? = nil) {
        self.workSessionID = workSessionID
        self.channelID = channelID
        self.agentMemberID = agentMemberID
    }
}

/// Host-local event shaped like momo's existing realtime envelopes. The raw ACP
/// extension data is retained only below `payload._meta.acp`; publishing or
/// persisting it is the caller's explicit responsibility.
public struct ACPProjectedEvent: Codable, Sendable, Equatable {
    public let id: UUID
    public let type: String
    public let version: Int
    public let timestampMs: Int64
    public let payload: ACPValue

    public init(
        id: UUID = UUID(),
        type: String,
        timestampMs: Int64,
        payload: ACPValue
    ) {
        self.id = id
        self.type = type
        version = 1
        self.timestampMs = timestampMs
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case id = "event_id"
        case type
        case version = "v"
        case timestampMs = "ts"
        case payload
    }
}

public protocol ACPEventSink: Sendable {
    func emit(_ event: ACPProjectedEvent) async
}

public actor ACPCompositeEventSink: ACPEventSink {
    private let sinks: [any ACPEventSink]

    public init(_ sinks: [any ACPEventSink]) {
        self.sinks = sinks
    }

    public func emit(_ event: ACPProjectedEvent) async {
        // The durable local JSONL sink is installed first. A relay failure must
        // never prevent the raw host-local record from being written.
        for sink in sinks {
            await sink.emit(event)
        }
    }
}

/// Sends only the bounded normalized summary. The original event (including
/// `_meta.acp`) remains available to the preceding host-local JSONL sink.
public actor ACPServerRelaySink: ACPEventSink {
    public typealias Sender = @Sendable (ACPProjectedEvent) async throws -> Void

    public static let maximumEncodedBytes = 65_536
    public static let maximumAttempts = 3

    private let sender: Sender
    private let retryDelay: @Sendable (Int) async -> Void

    public init(
        sender: @escaping Sender,
        retryDelay: @escaping @Sendable (Int) async -> Void = { attempt in
            try? await Task.sleep(for: .milliseconds(100 * (1 << attempt)))
        }
    ) {
        self.sender = sender
        self.retryDelay = retryDelay
    }

    public func emit(_ event: ACPProjectedEvent) async {
        guard let summary = event.serverSummary(),
              let encoded = try? JSONEncoder().encode(summary),
              encoded.count <= Self.maximumEncodedBytes
        else { return }
        for attempt in 0..<Self.maximumAttempts {
            do {
                try await sender(summary)
                return
            } catch {
                guard attempt + 1 < Self.maximumAttempts else { return }
                await retryDelay(attempt)
            }
        }
    }
}

public struct ACPPermissionOption: Sendable, Equatable {
    public let optionID: String
    public let name: String
    public let kind: String?

    public init(optionID: String, name: String, kind: String?) {
        self.optionID = optionID
        self.name = name
        self.kind = kind
    }
}

public struct ACPPermissionRequest: Sendable, Equatable {
    public let acpSessionID: String
    public let toolCall: ACPValue
    public let options: [ACPPermissionOption]

    public init(acpSessionID: String, toolCall: ACPValue, options: [ACPPermissionOption]) {
        self.acpSessionID = acpSessionID
        self.toolCall = toolCall
        self.options = options
    }
}

public enum ACPPermissionDecision: Sendable, Equatable {
    case selected(optionID: String)
    case cancelled
}

public protocol ACPPermissionHandler: Sendable {
    func decide(_ request: ACPPermissionRequest) async -> ACPPermissionDecision
}

/// Absence of an approval bridge is always a rejection. This is the default in
/// workd until an existing momo approval-card owner supplies a decision sink.
public struct ACPFailClosedPermissionHandler: ACPPermissionHandler {
    public init() {}
    public func decide(_ request: ACPPermissionRequest) async -> ACPPermissionDecision { .cancelled }
}

public struct ACPTerminalCreateRequest: Sendable, Equatable {
    public let command: String
    public let arguments: [String]
    public let workingDirectory: String?
    public let environment: [String: String]
}

public struct ACPTerminalOutput: Sendable, Equatable {
    public let output: String
    public let truncated: Bool
    public let exitCode: Int?

    public init(output: String, truncated: Bool, exitCode: Int?) {
        self.output = output
        self.truncated = truncated
        self.exitCode = exitCode
    }
}

public protocol ACPTerminalHandler: Sendable {
    func create(_ request: ACPTerminalCreateRequest) async throws -> String
    func output(terminalID: String) async throws -> ACPTerminalOutput
    func waitForExit(terminalID: String) async throws -> Int
    func kill(terminalID: String) async throws
    func release(terminalID: String) async
}

public struct ACPPromptResult: Sendable, Equatable {
    public let acpSessionID: String
    public let stopReason: String?
}
