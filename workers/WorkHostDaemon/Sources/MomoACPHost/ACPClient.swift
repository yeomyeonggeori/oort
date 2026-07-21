import Foundation

public actor ACPClient {
    private struct RPCMessage: Codable {
        let jsonrpc: String
        let id: Int?
        let method: String?
        let params: ACPValue?
        let result: ACPValue?
        let error: RPCError?
    }

    private struct RPCError: Codable {
        let code: Int
        let message: String
    }

    private struct OutboundRequest: Encodable {
        let jsonrpc = "2.0"
        let id: Int
        let method: String
        let params: ACPValue
    }

    private struct OutboundResponse: Encodable {
        let jsonrpc = "2.0"
        let id: Int
        let result: ACPValue?
        let error: RPCError?
    }

    private let command: ACPLaunchCommand
    private let context: ACPHostContext
    private let eventSink: any ACPEventSink
    private let permissionHandler: any ACPPermissionHandler
    private let terminalHandler: any ACPTerminalHandler
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
    private var acpSessionID: String?

    public init(
        command: ACPLaunchCommand,
        context: ACPHostContext,
        eventSink: any ACPEventSink,
        permissionHandler: any ACPPermissionHandler = ACPFailClosedPermissionHandler(),
        terminalHandler: any ACPTerminalHandler,
        nowMs: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) {
        self.command = command
        self.context = context
        self.eventSink = eventSink
        self.permissionHandler = permissionHandler
        self.terminalHandler = terminalHandler
        self.nowMs = nowMs
    }

    deinit {
        process?.terminate()
        try? input?.close()
        try? output?.close()
        try? errorOutput?.close()
    }

    /// Starts one ACP subprocess and performs the v0 lifecycle in protocol
    /// order. Incoming requests and notifications continue to be serviced while
    /// each response is awaited.
    public func prompt(_ text: String) async throws -> ACPPromptResult {
        let acpSessionID = try await ensureSession()

        let result = try await call(
            method: "session/prompt",
            params: .object([
                "sessionId": .string(acpSessionID),
                "prompt": .array([
                    .object(["type": .string("text"), "text": .string(text)]),
                ]),
            ])
        )
        return ACPPromptResult(
            acpSessionID: acpSessionID,
            stopReason: result.objectValue?["stopReason"]?.stringValue
        )
    }

    private func ensureSession() async throws -> String {
        if let acpSessionID { return acpSessionID }
        try start()
        _ = try await call(
            method: "initialize",
            params: .object([
                "protocolVersion": .int(1),
                "clientCapabilities": .object([
                    "fs": .object([
                        "readTextFile": .bool(false),
                        "writeTextFile": .bool(false),
                    ]),
                    "terminal": .bool(true),
                ]),
                "clientInfo": .object([
                    "name": .string("momo-acp-host"),
                    "title": .string("momo"),
                    "version": .string("0.1.0"),
                ]),
            ])
        )
        let newSession = try await call(
            method: "session/new",
            params: .object([
                "cwd": .string(command.workingDirectory.path),
                "mcpServers": .array([]),
            ])
        )
        guard let id = newSession.objectValue?["sessionId"]?.stringValue, !id.isEmpty else {
            throw ACPHostError.invalidResponse("session/new.sessionId")
        }
        acpSessionID = id
        return id
    }

    public func terminate() {
        process?.terminate()
    }

    private func start() throws {
        guard process == nil else { throw ACPHostError.alreadyRunning }
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
            throw ACPHostError.launchFailed
        }
        process = child
        input = stdinPipe.fileHandleForWriting
        output = stdoutPipe.fileHandleForReading
        errorOutput = stderrPipe.fileHandleForReading

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { await self?.receive(data) }
        }
        // Agent stderr is intentionally drained but never forwarded to the
        // server/event sink: it may contain raw terminal or credential detail.
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }
        child.terminationHandler = { [weak self] _ in
            Task { await self?.transportEnded() }
        }
    }

    private func call(method: String, params: ACPValue) async throws -> ACPValue {
        guard process?.isRunning == true else { throw ACPHostError.notRunning }
        let id = nextRequestID
        nextRequestID += 1
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                try write(OutboundRequest(id: id, method: method, params: params))
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
                failPending(with: ACPHostError.malformedMessage)
                process?.terminate()
            }
        }
    }

    private func route(_ message: RPCMessage) async {
        guard message.jsonrpc == "2.0" else {
            failPending(with: ACPHostError.malformedMessage)
            return
        }
        if let id = message.id, message.method == nil {
            guard let continuation = pending.removeValue(forKey: id) else { return }
            if let error = message.error {
                continuation.resume(throwing: ACPHostError.protocolError(
                    code: error.code, message: error.message
                ))
            } else if let result = message.result {
                continuation.resume(returning: result)
            } else {
                continuation.resume(throwing: ACPHostError.malformedMessage)
            }
            return
        }
        guard let method = message.method else { return }
        if method == "session/update" {
            let event = ACPEventProjection.sessionUpdate(
                message.params ?? .object([:]), context: context, nowMs: nowMs()
            )
            await eventSink.emit(event)
            return
        }
        guard let id = message.id else { return }
        await handleClientRequest(id: id, method: method, params: message.params ?? .object([:]))
    }

    private func handleClientRequest(id: Int, method: String, params: ACPValue) async {
        do {
            let result: ACPValue
            switch method {
            case "session/request_permission":
                result = try await permissionResult(params)
            case "terminal/create":
                result = try await terminalCreate(params)
            case "terminal/output":
                result = try await terminalOutput(params)
            case "terminal/wait_for_exit":
                result = try await terminalWait(params)
            case "terminal/kill":
                result = try await terminalKill(params)
            case "terminal/release":
                result = await terminalRelease(params)
            default:
                try write(OutboundResponse(
                    id: id,
                    result: nil,
                    error: RPCError(code: -32601, message: "method not supported")
                ))
                return
            }
            try write(OutboundResponse(id: id, result: result, error: nil))
        } catch {
            try? write(OutboundResponse(
                id: id,
                result: nil,
                error: RPCError(code: -32000, message: "host request failed")
            ))
        }
    }

    private func permissionResult(_ params: ACPValue) async throws -> ACPValue {
        let object = params.objectValue ?? [:]
        guard let sessionID = object["sessionId"]?.stringValue,
              let toolCall = object["toolCall"],
              let rawOptions = object["options"]?.arrayValue
        else { throw ACPHostError.malformedMessage }
        let options = try rawOptions.map { value -> ACPPermissionOption in
            guard let item = value.objectValue,
                  let optionID = item["optionId"]?.stringValue,
                  let name = item["name"]?.stringValue
            else { throw ACPHostError.malformedMessage }
            return ACPPermissionOption(
                optionID: optionID, name: name, kind: item["kind"]?.stringValue
            )
        }
        let request = ACPPermissionRequest(
            acpSessionID: sessionID, toolCall: toolCall, options: options
        )
        await eventSink.emit(ACPEventProjection.permission(
            request, context: context, nowMs: nowMs()
        ))
        let proposed = await permissionHandler.decide(request)
        let decision: ACPPermissionDecision
        switch proposed {
        case .selected(let optionID) where options.contains(where: { $0.optionID == optionID }):
            decision = proposed
        default:
            decision = .cancelled
        }
        await eventSink.emit(ACPEventProjection.permissionDecision(
            decision, context: context, nowMs: nowMs()
        ))
        switch decision {
        case .selected(let optionID):
            return .object(["outcome": .object([
                "outcome": .string("selected"),
                "optionId": .string(optionID),
            ])])
        case .cancelled:
            return .object(["outcome": .object(["outcome": .string("cancelled")])])
        }
    }

    private func terminalCreate(_ params: ACPValue) async throws -> ACPValue {
        let object = params.objectValue ?? [:]
        guard let command = object["command"]?.stringValue else {
            throw ACPHostError.malformedMessage
        }
        let arguments = object["args"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let environment = object["env"]?.arrayValue?.reduce(into: [String: String]()) { result, value in
            guard let item = value.objectValue,
                  let name = item["name"]?.stringValue,
                  let content = item["value"]?.stringValue
            else { return }
            result[name] = content
        } ?? [:]
        let terminalID = try await terminalHandler.create(ACPTerminalCreateRequest(
            command: command,
            arguments: arguments,
            workingDirectory: object["cwd"]?.stringValue,
            environment: environment
        ))
        return .object(["terminalId": .string(terminalID)])
    }

    private func terminalOutput(_ params: ACPValue) async throws -> ACPValue {
        let terminalID = try terminalID(from: params)
        let value = try await terminalHandler.output(terminalID: terminalID)
        var object: [String: ACPValue] = [
            "output": .string(value.output),
            "truncated": .bool(value.truncated),
        ]
        if let exitCode = value.exitCode { object["exitStatus"] = .object(["exitCode": .int(exitCode)]) }
        return .object(object)
    }

    private func terminalWait(_ params: ACPValue) async throws -> ACPValue {
        let code = try await terminalHandler.waitForExit(terminalID: terminalID(from: params))
        return .object(["exitCode": .int(code)])
    }

    private func terminalKill(_ params: ACPValue) async throws -> ACPValue {
        try await terminalHandler.kill(terminalID: terminalID(from: params))
        return .object([:])
    }

    private func terminalRelease(_ params: ACPValue) async -> ACPValue {
        if let terminalID = try? terminalID(from: params) {
            await terminalHandler.release(terminalID: terminalID)
        }
        return .object([:])
    }

    private func terminalID(from params: ACPValue) throws -> String {
        guard let id = params.objectValue?["terminalId"]?.stringValue, !id.isEmpty else {
            throw ACPHostError.malformedMessage
        }
        return id
    }

    private func write<T: Encodable>(_ message: T) throws {
        guard let input else { throw ACPHostError.transportClosed }
        var data = try encoder.encode(message)
        data.append(0x0A)
        do { try input.write(contentsOf: data) }
        catch { throw ACPHostError.transportClosed }
    }

    private func transportEnded() async {
        output?.readabilityHandler = nil
        errorOutput?.readabilityHandler = nil
        failPending(with: ACPHostError.transportClosed)
    }

    private func failPending(with error: any Error) {
        let continuations = pending.values
        pending.removeAll()
        for continuation in continuations { continuation.resume(throwing: error) }
    }
}
