import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import NIOFoundationCompat

/// AgentWorker-owned bridge from OpenAI-compatible `work_*` function calls to
/// the ADR-0114 / MOMO-484 work-control REST ledger.
///
/// The model never chooses a host or an arbitrary channel. The current run
/// fixes the channel and the worker's local configuration fixes the v0 host;
/// the tool arguments can only repeat the current channel (spawn) or name a
/// session already protected by the server's requester-lineage check.
struct WorkToolDispatcher: Sendable {
    enum Kind: String, CaseIterable, Sendable {
        case spawn = "work_spawn"
        case input = "work_input"
        case read = "work_read"
        case kill = "work_kill"

        var controlKind: String {
            switch self {
            case .spawn: "spawn"
            case .input: "input"
            case .read: "read"
            case .kill: "kill"
            }
        }
    }

    struct Call: Equatable, Sendable {
        let kind: Kind
        let runID: UUID
        let channelID: UUID
        let targetHostID: UUID
        let sessionID: UUID?
        let payload: JSONValue
    }

    enum ValidationError: Error, Equatable, CustomStringConvertible, Sendable {
        case unknownTool(String)
        case invalidJSON
        case argumentsMustBeObject
        case unsupportedFields(kind: Kind)
        case missingRunID
        case invalidUUID(field: String)
        case channelMismatch
        case unsupportedWorkTool
        case invalidLabel
        case invalidText

        var description: String {
            switch self {
            case .unknownTool(let name):
                "unknown work tool: \(name)"
            case .invalidJSON:
                "tool arguments must be valid JSON"
            case .argumentsMustBeObject:
                "tool arguments must be a JSON object"
            case .unsupportedFields(let kind):
                "\(kind.rawValue) contains unsupported fields"
            case .missingRunID:
                "work tools require an agent run id"
            case .invalidUUID(let field):
                "\(field) must be a UUID"
            case .channelMismatch:
                "work_spawn channel must match the current run channel"
            case .unsupportedWorkTool:
                "tool must be claude, codex, opencode, or shell"
            case .invalidLabel:
                "label must contain 1...120 characters"
            case .invalidText:
                "text must contain 1...4000 characters"
            }
        }
    }

    static let pendingApprovalMessage = "작업 세션 생성 요청이 승인 대기 중입니다. 승인 후 세션 카드에서 진행 상황을 확인할 수 있습니다."

    static func recognizes(_ name: String) -> Bool {
        Kind(rawValue: name) != nil
    }

    static func parse(
        name: String,
        arguments: String,
        currentChannelID: UUID,
        runID: UUID?,
        targetHostID: UUID
    ) throws -> Call {
        guard let kind = Kind(rawValue: name) else {
            throw ValidationError.unknownTool(name)
        }
        guard let runID else { throw ValidationError.missingRunID }
        guard let data = arguments.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data)
        else {
            throw ValidationError.invalidJSON
        }
        guard let object = decoded.objectValue else {
            throw ValidationError.argumentsMustBeObject
        }

        func requireExactKeys(_ expected: Set<String>) throws {
            guard Set(object.keys) == expected else {
                throw ValidationError.unsupportedFields(kind: kind)
            }
        }
        func requireUUID(_ field: String) throws -> UUID {
            guard let raw = object[field]?.stringValue,
                  let value = UUID(uuidString: raw)
            else {
                throw ValidationError.invalidUUID(field: field)
            }
            return value
        }

        let sessionID: UUID?
        let payload: JSONValue
        switch kind {
        case .spawn:
            try requireExactKeys(["tool", "label", "channel"])
            let channelID = try requireUUID("channel")
            guard channelID == currentChannelID else {
                throw ValidationError.channelMismatch
            }
            guard let tool = object["tool"]?.stringValue,
                  ["claude", "codex", "opencode", "shell"].contains(tool)
            else {
                throw ValidationError.unsupportedWorkTool
            }
            guard let rawLabel = object["label"]?.stringValue else {
                throw ValidationError.invalidLabel
            }
            let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, label.count <= 120 else {
                throw ValidationError.invalidLabel
            }
            sessionID = nil
            payload = .object(["tool": .string(tool), "label": .string(label)])

        case .input:
            try requireExactKeys(["session_id", "text"])
            sessionID = try requireUUID("session_id")
            guard let text = object["text"]?.stringValue,
                  !text.isEmpty, text.count <= 4_000
            else {
                throw ValidationError.invalidText
            }
            payload = .object(["text": .string(text)])

        case .read:
            try requireExactKeys(["session_id"])
            sessionID = try requireUUID("session_id")
            payload = .object([:])

        case .kill:
            try requireExactKeys(["session_id"])
            sessionID = try requireUUID("session_id")
            payload = .object([:])
        }

        return Call(
            kind: kind,
            runID: runID,
            channelID: currentChannelID,
            targetHostID: targetHostID,
            sessionID: sessionID,
            payload: payload
        )
    }

    /// Canonical schemas override same-named agent-local definitions so a stale
    /// or permissive `agent.tool_schema` cannot widen the MOMO-486 arguments.
    static func mergedToolDefinitions(into existing: JSONValue?) -> JSONValue {
        var values: [JSONValue]
        if case .array(let array) = existing {
            values = array.filter { value in
                guard case .object(let outer) = value,
                      case .object(let function)? = outer["function"],
                      let name = function["name"]?.stringValue
                else { return true }
                return !recognizes(name)
            }
        } else {
            values = []
        }
        values.append(contentsOf: toolDefinitions)
        return .array(values)
    }

    static func systemInstruction(channelID: UUID) -> HermesTransport.ChatMessage {
        .init(
            role: "system",
            content: """
            momo work controls are available through work_spawn, work_input, work_read, and work_kill. \
            The current channel UUID is \(channelID.uuidString). work_spawn must repeat exactly that UUID. \
            Never claim that a control succeeded unless the tool result says so. A pending spawn is only awaiting human approval; \
            later dispatched/acked/failed events and the session thread card are the source of truth. Only work_read results may be quoted in a normal response.
            """
        )
    }

    static func responseText(for result: WorkControlClient.Result, kind: Kind) -> String? {
        if result.status == "pending_approval" {
            return pendingApprovalMessage
        }
        if kind == .read {
            return "work_read 결과: \(result.responseBody)"
        }
        return nil
    }

    static func rejectionText(for error: Error) -> String {
        if let failure = error as? WorkControlClient.Failure {
            switch failure {
            case .unavailable(let reason):
                return "작업 도구 요청을 실행할 수 없습니다: \(reason)"
            case .http(let status, let message):
                return "작업 도구 요청이 거부되었습니다 (HTTP \(status)): \(message)"
            case .invalidResponse(let reason):
                return "작업 도구 응답을 확인할 수 없습니다: \(reason)"
            }
        }
        return "작업 도구 요청을 거부했습니다: \(error)"
    }

    private static let toolDefinitions: [JSONValue] = [
        functionDefinition(
            name: Kind.spawn.rawValue,
            description: "Request a host-owned CLI session. Human approval may be required.",
            properties: [
                "tool": .object([
                    "type": .string("string"),
                    "enum": .array(["claude", "codex", "opencode", "shell"].map(JSONValue.string)),
                ]),
                "label": .object([
                    "type": .string("string"),
                    "minLength": .int(1),
                    "maxLength": .int(120),
                ]),
                "channel": .object([
                    "type": .string("string"),
                    "format": .string("uuid"),
                ]),
            ],
            required: ["tool", "label", "channel"]
        ),
        functionDefinition(
            name: Kind.input.rawValue,
            description: "Send text to a running session in this agent's approved lineage.",
            properties: [
                "session_id": uuidSchema,
                "text": .object([
                    "type": .string("string"),
                    "minLength": .int(1),
                    "maxLength": .int(4_000),
                ]),
            ],
            required: ["session_id", "text"]
        ),
        functionDefinition(
            name: Kind.read.rawValue,
            description: "Request the current host-local output for an approved session.",
            properties: ["session_id": uuidSchema],
            required: ["session_id"]
        ),
        functionDefinition(
            name: Kind.kill.rawValue,
            description: "Stop a running session in this agent's approved lineage.",
            properties: ["session_id": uuidSchema],
            required: ["session_id"]
        ),
    ]

    private static let uuidSchema: JSONValue = .object([
        "type": .string("string"),
        "format": .string("uuid"),
    ])

    private static func functionDefinition(
        name: String,
        description: String,
        properties: [String: JSONValue],
        required: [String]
    ) -> JSONValue {
        .object([
            "type": .string("function"),
            "function": .object([
                "name": .string(name),
                "description": .string(description),
                "parameters": .object([
                    "type": .string("object"),
                    "additionalProperties": .bool(false),
                    "properties": .object(properties),
                    "required": .array(required.map(JSONValue.string)),
                ]),
            ]),
        ])
    }
}

struct WorkControlClient: Sendable {
    struct Result: Equatable, Sendable {
        let controlID: UUID
        let status: String
        let responseBody: String
    }

    enum Failure: Error, Equatable, CustomStringConvertible, Sendable {
        case unavailable(String)
        case http(status: Int, message: String)
        case invalidResponse(String)

        var description: String {
            switch self {
            case .unavailable(let reason): reason
            case .http(let status, let message): "HTTP \(status): \(message)"
            case .invalidResponse(let reason): reason
            }
        }
    }

    let httpClient: HTTPClient
    let baseURL: String
    let agentToken: String?
    let targetHostID: UUID?
    let logger: Logger

    func dispatch(
        name: String,
        arguments: String,
        workspaceID: UUID,
        channelID: UUID,
        runID: UUID?
    ) async throws -> (WorkToolDispatcher.Kind, Result) {
        guard let agentToken, !agentToken.isEmpty else {
            throw Failure.unavailable("MOMO_AGENT_TOKEN is not configured")
        }
        guard let targetHostID else {
            throw Failure.unavailable("MOMO_WORK_HOST_ID is not a UUID")
        }
        let call = try WorkToolDispatcher.parse(
            name: name,
            arguments: arguments,
            currentChannelID: channelID,
            runID: runID,
            targetHostID: targetHostID
        )
        let body = CreateRequest(
            channelId: call.channelID,
            runId: call.runID,
            targetHostId: call.targetHostID,
            sessionId: call.sessionID,
            kind: call.kind.controlKind,
            payload: call.payload
        )

        let normalizedBaseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        var request = HTTPClientRequest(
            url: "\(normalizedBaseURL)/v1/workspaces/\(workspaceID.uuidString)/work-controls"
        )
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/json")
        request.headers.add(name: "Authorization", value: "Bearer \(agentToken)")
        request.body = .bytes(ByteBuffer(data: try JSONEncoder().encode(body)))

        let response = try await httpClient.execute(request, timeout: .seconds(30))
        var buffer = try await response.body.collect(upTo: 1 * 1024 * 1024)
        let data = buffer.readData(length: buffer.readableBytes) ?? Data()
        let rawBody = String(data: data, encoding: .utf8) ?? ""
        guard response.status.code == 201 else {
            throw Failure.http(
                status: Int(response.status.code),
                message: Self.serverMessage(data: data, fallback: rawBody)
            )
        }
        guard let envelope = try? JSONDecoder().decode(ResponseEnvelope.self, from: data),
              let controlID = UUID(uuidString: envelope.workControl.id),
              !envelope.workControl.status.isEmpty
        else {
            logger.warning("work control response decode failed", metadata: [
                "status": .stringConvertible(response.status.code),
            ])
            throw Failure.invalidResponse("workControl id/status is missing")
        }
        return (
            call.kind,
            Result(
                controlID: controlID,
                status: envelope.workControl.status,
                responseBody: envelope.workControl.payload.jsonString()
            )
        )
    }

    static func serverMessage(data: Data, fallback: String) -> String {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let object = value.objectValue
        else {
            let trimmed = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "empty server response" : String(trimmed.prefix(1_000))
        }
        if let message = object["message"]?.stringValue { return message }
        if let error = object["error"]?.objectValue?["message"]?.stringValue { return error }
        if let error = object["error"]?.stringValue { return error }
        return String(value.jsonString().prefix(1_000))
    }

    private struct CreateRequest: Encodable {
        let channelId: UUID
        let runId: UUID
        let targetHostId: UUID
        let sessionId: UUID?
        let kind: String
        let payload: JSONValue
    }

    private struct ResponseEnvelope: Decodable {
        let workControl: Control

        struct Control: Decodable {
            let id: String
            let status: String
            let payload: JSONValue
        }
    }
}
