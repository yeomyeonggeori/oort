import Foundation

// =============================================================================
// CodexJSONRPCAdapter — the local Codex (app-server JSON-RPC / stdio) path of
// WorkEngineAdapter (MOMO-579 / WH-1, ADR-0114 증보1 D4/D5).
//
// WH-0 실측: `codex app-server` speaks newline-delimited JSON-RPC 2.0 over stdio
// WITHOUT the "jsonrpc" field. Lifecycle:
//   initialize (req) -> result ; initialized (notification)
//   thread/start (req) -> { threadId }
//   turn/start (req) -> stream (item/agentMessage/delta, item/commandExecution/
//     outputDelta) + server->client approval requests (*ApprovalParams) which we
//     answer with an *ApprovalResponse ; turn completion via the turn/start
//     response OR a turn-completed notification.
//
// Codex is NEVER bundled (ADR-0114 증보1): this connects to the user host's own
// `codex` install. ADR-0004: the ChatGPT/OAuth boundary lives entirely in the
// user host's Codex (~/.codex / keychain); nothing here reads or forwards it.
// stderr is drained and never projected (may carry credential detail).
// =============================================================================
public actor CodexJSONRPCAdapter: WorkEngineAdapter {
    public nonisolated let engine: WorkEngine = .codexLocal

    private struct RPCMessage: Codable {
        let id: RPCID?
        let method: String?
        let params: ACPValue?
        let result: ACPValue?
        let error: RPCError?
    }

    private struct RPCError: Codable {
        let code: Int
        let message: String
    }

    // Codex ids may be int or string; keep both without lossy coercion.
    private enum RPCID: Codable, Hashable {
        case int(Int)
        case string(String)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(Int.self) { self = .int(value) }
            else if let value = try? container.decode(String.self) { self = .string(value) }
            else { throw WorkEngineError.invalidResponse("rpc id") }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .int(let value): try container.encode(value)
            case .string(let value): try container.encode(value)
            }
        }
    }

    private struct OutboundRequest: Encodable {
        let id: RPCID
        let method: String
        let params: ACPValue
    }

    private struct OutboundNotification: Encodable {
        let method: String
        let params: ACPValue
    }

    private struct OutboundResponse: Encodable {
        let id: RPCID
        let result: ACPValue
    }

    private let command: ACPLaunchCommand
    private let context: ACPHostContext
    private let eventSink: any ACPEventSink
    private let approvalHandler: any WorkApprovalHandler
    private let nowMs: @Sendable () -> Int64
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var errorOutput: FileHandle?
    private var readBuffer = Data()
    private var nextRequestID = 1
    private var pending: [Int: CheckedContinuation<ACPValue, any Error>] = [:]
    private var threadID: String?

    private var turnContinuation: CheckedContinuation<String?, any Error>?
    private var turnRequestID: Int?
    private var turnFinished = false

    public init(
        command: ACPLaunchCommand,
        context: ACPHostContext,
        eventSink: any ACPEventSink,
        approvalHandler: any WorkApprovalHandler = WorkFailClosedApprovalHandler(),
        nowMs: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) {
        self.command = command
        self.context = context
        self.eventSink = eventSink
        self.approvalHandler = approvalHandler
        self.nowMs = nowMs
    }

    public func createSession(title: String?) async throws -> String {
        if let threadID { return threadID }
        try start()
        _ = try await call(method: "initialize", params: .object([
            "clientInfo": .object([
                "name": .string("momo-work-host"),
                "title": .string("momo"),
                "version": .string("0.1.0"),
            ]),
            "capabilities": .object([:]),
        ]))
        try writeNotification(method: "initialized", params: .object([:]))
        var params: [String: ACPValue] = [
            "cwd": .string(command.workingDirectory.path),
        ]
        if let title { params["title"] = .string(title) }
        let started = try await call(method: "thread/start", params: .object(params))
        guard let id = threadID(from: started) else {
            throw WorkEngineError.invalidResponse("thread/start.threadId")
        }
        threadID = id
        return id
    }

    @discardableResult
    public func prompt(sessionID: String, text: String) async throws -> WorkTurnResult {
        let thread = try await createSession(title: nil)
        guard process?.isRunning == true else { throw WorkEngineError.notStarted }
        let id = nextRequestID
        nextRequestID += 1
        turnRequestID = id
        turnFinished = false

        let stopReason = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String?, any Error>) in
            turnContinuation = continuation
            do {
                try write(OutboundRequest(
                    id: .int(id),
                    method: "turn/start",
                    params: .object([
                        "threadId": .string(thread),
                        "input": .array([
                            .object(["type": .string("text"), "text": .string(text)]),
                        ]),
                    ])
                ))
            } catch {
                turnContinuation = nil
                turnRequestID = nil
                continuation.resume(throwing: error)
            }
        }
        return WorkTurnResult(sessionID: thread, stopReason: stopReason ?? "end_turn")
    }

    public func shutdown() async {
        process?.terminate()
    }

    public func terminate() {
        process?.terminate()
    }

    // MARK: - Transport

    private func start() throws {
        guard process == nil else { throw WorkEngineError.transport("already running") }
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        let child = Process()
        child.executableURL = URL(fileURLWithPath: command.executable)
        child.arguments = command.arguments
        child.currentDirectoryURL = command.workingDirectory
        child.environment = command.environment.filter { !$0.key.hasPrefix("MOMO_") }
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = stderrPipe
        do {
            try child.run()
        } catch {
            throw WorkEngineError.transport("launch failed")
        }
        process = child
        input = stdinPipe.fileHandleForWriting
        output = stdoutPipe.fileHandleForReading
        errorOutput = stderrPipe.fileHandleForReading

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { await self?.receive(data) }
        }
        // Codex stderr may contain raw model/credential detail; drain, never forward.
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }
        child.terminationHandler = { [weak self] _ in
            Task { await self?.transportEnded() }
        }
    }

    private func call(method: String, params: ACPValue) async throws -> ACPValue {
        guard process?.isRunning == true else { throw WorkEngineError.notStarted }
        let id = nextRequestID
        nextRequestID += 1
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                try write(OutboundRequest(id: .int(id), method: method, params: params))
            } catch {
                pending.removeValue(forKey: id)
                continuation.resume(throwing: error)
            }
        }
    }

    private func receive(_ data: Data) async {
        guard !data.isEmpty else {
            await transportEnded()
            return
        }
        readBuffer.append(data)
        while let newline = readBuffer.firstIndex(of: 0x0A) {
            let line = readBuffer[..<newline]
            readBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            do {
                let message = try decoder.decode(RPCMessage.self, from: Data(line))
                await route(message)
            } catch {
                failAll(with: WorkEngineError.invalidResponse("malformed message"))
                process?.terminate()
            }
        }
    }

    private func route(_ message: RPCMessage) async {
        // Response to one of our requests.
        if let id = message.id, message.method == nil {
            if case .int(let intID) = id {
                if intID == turnRequestID {
                    if let error = message.error {
                        finishTurn(throwing: WorkEngineError.transport(error.message))
                    } else {
                        finishTurn(stopReason: message.result.flatMap(stopReason(from:)))
                    }
                    return
                }
                guard let continuation = pending.removeValue(forKey: intID) else { return }
                if let error = message.error {
                    continuation.resume(throwing: WorkEngineError.transport(error.message))
                } else {
                    continuation.resume(returning: message.result ?? .object([:]))
                }
            }
            return
        }
        guard let method = message.method else { return }
        // Server -> client request (has id): approval hooks.
        if let id = message.id {
            await handleServerRequest(id: id, method: method, params: message.params ?? .object([:]))
            return
        }
        // Notification (no id): stream deltas + turn lifecycle.
        await handleNotification(method: method, params: message.params ?? .object([:]))
    }

    private func handleNotification(method: String, params: ACPValue) async {
        let lower = method.lowercased()
        if lower.contains("delta") || lower.contains("agentmessage") || lower.contains("outputdelta") {
            if let text = deltaText(from: params) {
                await eventSink.emit(WorkEngineEvents.messageDelta(
                    text, engine: engine, context: context, nowMs: nowMs(), raw: params
                ))
            }
            return
        }
        if lower.contains("turn") && (lower.contains("complet") || lower.contains("finish") || lower.contains("end")) {
            finishTurn(stopReason: stopReason(from: params))
            return
        }
        // Other item/status notifications become a generic status projection.
        await eventSink.emit(WorkEngineEvents.status(
            detail: method, engine: engine, context: context, nowMs: nowMs(), raw: params
        ))
    }

    private func handleServerRequest(id: RPCID, method: String, params: ACPValue) async {
        let lower = method.lowercased()
        let object = params.objectValue ?? [:]
        let looksLikeApproval = lower.contains("approval")
            || object["options"] != nil
            || object["command"] != nil
            || object["patch"] != nil
        guard looksLikeApproval else {
            // Unknown server request: fail closed with an empty result.
            try? write(OutboundResponse(id: id, result: .object([:])))
            return
        }
        let options = [
            WorkApprovalOption(optionID: "approved", name: "Approve", kind: .allowOnce),
            WorkApprovalOption(optionID: "approved_for_session", name: "Approve for session", kind: .allowAlways),
            WorkApprovalOption(optionID: "denied", name: "Deny", kind: .rejectOnce),
        ]
        let title = object["command"].flatMap(commandString(from:))
            ?? object["reason"]?.stringValue
            ?? object["title"]?.stringValue
        let request = WorkApprovalRequest(
            engine: engine,
            sessionID: threadID ?? "",
            requestID: rpcIDString(id),
            toolName: object["tool"]?.stringValue ?? method,
            title: title,
            detail: object["reason"]?.stringValue,
            options: options,
            raw: params
        )
        await eventSink.emit(WorkEngineEvents.approvalRequested(
            request, context: context, nowMs: nowMs()
        ))
        let decision = normalize(await approvalHandler.decide(request), options: options)
        await eventSink.emit(WorkEngineEvents.approvalDecided(
            decision, engine: engine, context: context, nowMs: nowMs()
        ))
        let codexDecision: String
        switch decision {
        case .allow(let optionID): codexDecision = (optionID == "approved_for_session") ? "approved_for_session" : "approved"
        case .deny, .cancelled: codexDecision = "denied"
        }
        try? write(OutboundResponse(id: id, result: .object(["decision": .string(codexDecision)])))
    }

    private func normalize(
        _ decision: WorkApprovalDecision,
        options: [WorkApprovalOption]
    ) -> WorkApprovalDecision {
        switch decision {
        case .allow(let optionID) where options.contains(where: { $0.optionID == optionID }):
            return .allow(optionID: optionID)
        case .deny(let optionID?) where options.contains(where: { $0.optionID == optionID }):
            return .deny(optionID: optionID)
        case .deny:
            return .deny(optionID: "denied")
        default:
            return .cancelled
        }
    }

    private func finishTurn(stopReason: String?) {
        guard !turnFinished, let continuation = turnContinuation else { return }
        turnFinished = true
        turnContinuation = nil
        turnRequestID = nil
        continuation.resume(returning: stopReason)
    }

    private func finishTurn(throwing error: any Error) {
        guard !turnFinished, let continuation = turnContinuation else { return }
        turnFinished = true
        turnContinuation = nil
        turnRequestID = nil
        continuation.resume(throwing: error)
    }

    private func write<T: Encodable>(_ message: T) throws {
        guard let input else { throw WorkEngineError.transport("transport closed") }
        var data = try encoder.encode(message)
        data.append(0x0A)
        do { try input.write(contentsOf: data) }
        catch { throw WorkEngineError.transport("write failed") }
    }

    private func writeNotification(method: String, params: ACPValue) throws {
        try write(OutboundNotification(method: method, params: params))
    }

    private func transportEnded() async {
        output?.readabilityHandler = nil
        errorOutput?.readabilityHandler = nil
        failAll(with: WorkEngineError.transport("transport closed"))
    }

    private func failAll(with error: any Error) {
        let continuations = pending.values
        pending.removeAll()
        for continuation in continuations { continuation.resume(throwing: error) }
        finishTurn(throwing: error)
    }

    // MARK: - Payload extraction (tolerant across v1/v2 schemas)

    private func threadID(from value: ACPValue) -> String? {
        let object = value.objectValue
        return object?["threadId"]?.stringValue
            ?? object?["thread"]?.objectValue?["id"]?.stringValue
            ?? object?["id"]?.stringValue
    }

    private func deltaText(from params: ACPValue) -> String? {
        let object = params.objectValue ?? [:]
        if let text = object["delta"]?.stringValue, !text.isEmpty { return text }
        if let text = object["text"]?.stringValue, !text.isEmpty { return text }
        if let item = object["item"]?.objectValue {
            if let text = item["delta"]?.stringValue, !text.isEmpty { return text }
            if let text = item["text"]?.stringValue, !text.isEmpty { return text }
        }
        return nil
    }

    private func stopReason(from value: ACPValue) -> String? {
        let object = value.objectValue
        return object?["stopReason"]?.stringValue
            ?? object?["status"]?.stringValue
            ?? object?["turn"]?.objectValue?["status"]?.stringValue
    }

    private func commandString(from value: ACPValue) -> String? {
        if let text = value.stringValue { return text }
        if let array = value.arrayValue {
            let parts = array.compactMap { $0.stringValue }
            return parts.isEmpty ? nil : parts.joined(separator: " ")
        }
        return nil
    }

    private func rpcIDString(_ id: RPCID) -> String {
        switch id {
        case .int(let value): return String(value)
        case .string(let value): return value
        }
    }
}
