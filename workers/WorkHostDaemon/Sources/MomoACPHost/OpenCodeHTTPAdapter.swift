import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// =============================================================================
// OpenCodeHTTPAdapter — the opencode (HTTP + SSE) path of WorkEngineAdapter
// (MOMO-579 / WH-1, ADR-0114 증보1 D1/D5).
//
// WH-0 실측 표면:
//   POST /session {title?}                    -> {id}
//   POST /session/{id}/message (parts…)       -> turn ack (streamed over SSE)
//   GET  /event                               -> SSE assistant/tool/permission
//   POST /session/{id}/permissions/{permID}   -> {response: once|always|reject}
//   GET  /doc                                 -> OpenAPI 3.1
//   auth opt-in: OPENCODE_SERVER_PASSWORD (HTTP basic, user=opencode)
//
// opencode does not enumerate approval option ids the way ACP does — it takes a
// single `response` literal. The adapter synthesizes the unified option set and
// maps the host's decision back to that literal, so the work console sees the
// same WorkApprovalRequest/Decision as every other engine.
//
// The transport is a seam (`OpenCodeTransport`) so the adapter is unit-tested
// with a scripted mock; the real URLSession transport is a runtime concern and
// the docker verifier exercises the real opencode surface directly.
// =============================================================================

public struct OpenCodeHTTPRequest: Sendable, Equatable {
    public let method: String
    public let path: String
    public let body: ACPValue?

    public init(method: String, path: String, body: ACPValue? = nil) {
        self.method = method
        self.path = path
        self.body = body
    }
}

public struct OpenCodeHTTPResponse: Sendable, Equatable {
    public let status: Int
    public let body: ACPValue

    public init(status: Int, body: ACPValue) {
        self.status = status
        self.body = body
    }
}

public protocol OpenCodeTransport: Sendable {
    /// One JSON request/response round trip against the opencode server.
    func send(_ request: OpenCodeHTTPRequest) async throws -> OpenCodeHTTPResponse
    /// The GET /event server-sent stream, each element one parsed JSON object.
    func events() async throws -> AsyncThrowingStream<ACPValue, any Error>
}

public final class OpenCodeHTTPAdapter: WorkEngineAdapter {
    public let engine: WorkEngine = .opencode

    private let transport: any OpenCodeTransport
    private let context: ACPHostContext
    private let eventSink: any ACPEventSink
    private let approvalHandler: any WorkApprovalHandler
    private let model: String?
    private let agent: String?
    private let nowMs: @Sendable () -> Int64

    public init(
        transport: any OpenCodeTransport,
        context: ACPHostContext,
        eventSink: any ACPEventSink,
        approvalHandler: any WorkApprovalHandler = WorkFailClosedApprovalHandler(),
        model: String? = nil,
        agent: String? = nil,
        nowMs: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) {
        self.transport = transport
        self.context = context
        self.eventSink = eventSink
        self.approvalHandler = approvalHandler
        self.model = model
        self.agent = agent
        self.nowMs = nowMs
    }

    public func createSession(title: String?) async throws -> String {
        var body: [String: ACPValue] = [:]
        if let title { body["title"] = .string(title) }
        let response = try await transport.send(
            OpenCodeHTTPRequest(method: "POST", path: "/session", body: .object(body))
        )
        guard (200..<300).contains(response.status),
              let id = response.body.objectValue?["id"]?.stringValue, !id.isEmpty
        else { throw WorkEngineError.invalidResponse("POST /session.id") }
        await eventSink.emit(WorkEngineEvents.status(
            detail: "opencode session created", phase: "starting",
            engine: engine, context: context, nowMs: nowMs()
        ))
        return id
    }

    @discardableResult
    public func prompt(sessionID: String, text: String) async throws -> WorkTurnResult {
        // Subscribe before dispatching the message so no mid-turn permission or
        // delta is lost between the POST and the first stream read.
        let stream = try await transport.events()

        let parts: [ACPValue] = [.object([
            "type": .string("text"),
            "text": .string(text),
        ])]
        var messageBody: [String: ACPValue] = ["parts": .array(parts)]
        if let model { messageBody["model"] = .string(model) }
        if let agent { messageBody["agent"] = .string(agent) }

        let messageResponse = try await transport.send(OpenCodeHTTPRequest(
            method: "POST",
            path: "/session/\(sessionID)/message",
            body: .object(messageBody)
        ))
        guard (200..<300).contains(messageResponse.status) else {
            throw WorkEngineError.invalidResponse("POST /session/message status=\(messageResponse.status)")
        }

        var stopReason: String?
        for try await raw in stream {
            guard eventBelongs(raw, to: sessionID) else { continue }
            switch classify(raw) {
            case .delta(let textDelta):
                await eventSink.emit(WorkEngineEvents.messageDelta(
                    textDelta, engine: engine, context: context, nowMs: nowMs(), raw: raw
                ))
            case .permission(let permissionID, let title, let toolName):
                try await resolvePermission(
                    sessionID: sessionID,
                    permissionID: permissionID,
                    title: title,
                    toolName: toolName,
                    raw: raw
                )
            case .idle(let reason):
                stopReason = reason ?? "end_turn"
            case .error(let detail):
                await eventSink.emit(WorkEngineEvents.status(
                    detail: detail, phase: "error",
                    engine: engine, context: context, nowMs: nowMs(), raw: raw
                ))
                stopReason = "error"
            case .ignored:
                continue
            }
            if stopReason != nil { break }
        }
        return WorkTurnResult(sessionID: sessionID, stopReason: stopReason)
    }

    public func shutdown() async {
        // opencode sessions are server-side and reclaimed by the sidecar teardown;
        // nothing host-local to release here.
    }

    // MARK: - Permission normalization

    private func resolvePermission(
        sessionID: String,
        permissionID: String,
        title: String?,
        toolName: String?,
        raw: ACPValue
    ) async throws {
        // opencode takes a single response literal; present the unified option set.
        let options = [
            WorkApprovalOption(optionID: "once", name: "Allow once", kind: .allowOnce),
            WorkApprovalOption(optionID: "always", name: "Allow always", kind: .allowAlways),
            WorkApprovalOption(optionID: "reject", name: "Reject", kind: .rejectOnce),
        ]
        let request = WorkApprovalRequest(
            engine: engine,
            sessionID: sessionID,
            requestID: permissionID,
            toolName: toolName,
            title: title,
            detail: nil,
            options: options,
            raw: raw
        )
        await eventSink.emit(WorkEngineEvents.approvalRequested(
            request, context: context, nowMs: nowMs()
        ))
        let decision = normalize(await approvalHandler.decide(request), options: options)
        await eventSink.emit(WorkEngineEvents.approvalDecided(
            decision, engine: engine, context: context, nowMs: nowMs()
        ))
        let responseLiteral: String
        switch decision {
        case .allow(let optionID):
            responseLiteral = (optionID == "always") ? "always" : "once"
        case .deny, .cancelled:
            responseLiteral = "reject"
        }
        let ack = try await transport.send(OpenCodeHTTPRequest(
            method: "POST",
            path: "/session/\(sessionID)/permissions/\(permissionID)",
            body: .object(["response": .string(responseLiteral)])
        ))
        guard (200..<300).contains(ack.status) else {
            throw WorkEngineError.invalidResponse("POST /permissions status=\(ack.status)")
        }
    }

    /// A decision must name an offered option, else it fails closed to reject.
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
            return .deny(optionID: "reject")
        default:
            return .cancelled
        }
    }

    // MARK: - Tolerant SSE classification
    //
    // opencode's event field names are version-dependent; the classifier reads
    // the union of the observed shapes and ignores anything it does not model.

    private enum EventClass {
        case delta(String)
        case permission(permissionID: String, title: String?, toolName: String?)
        case idle(reason: String?)
        case error(String)
        case ignored
    }

    private func classify(_ raw: ACPValue) -> EventClass {
        let object = raw.objectValue ?? [:]
        let type = (object["type"]?.stringValue ?? "").lowercased()
        let properties = object["properties"]?.objectValue ?? object

        if type.contains("permission") {
            let permissionID = properties["permissionID"]?.stringValue
                ?? properties["permissionId"]?.stringValue
                ?? properties["id"]?.stringValue
                ?? object["id"]?.stringValue
            if let permissionID {
                let title = properties["title"]?.stringValue
                    ?? properties["metadata"]?.objectValue?["title"]?.stringValue
                let toolName = properties["tool"]?.stringValue
                    ?? properties["type"]?.stringValue
                return .permission(permissionID: permissionID, title: title, toolName: toolName)
            }
            return .ignored
        }

        if type.contains("idle") || type == "session.idle" {
            return .idle(reason: properties["reason"]?.stringValue)
        }
        if type.contains("error") {
            let detail = properties["message"]?.stringValue
                ?? properties["error"]?.stringValue
                ?? "opencode error"
            return .error(detail)
        }
        if type.contains("message") || type.contains("part") {
            if let text = extractDelta(from: properties) ?? extractDelta(from: object) {
                return .delta(text)
            }
        }
        return .ignored
    }

    private func extractDelta(from object: [String: ACPValue]) -> String? {
        if let text = object["text"]?.stringValue, !text.isEmpty { return text }
        if let part = object["part"]?.objectValue,
           let text = part["text"]?.stringValue, !text.isEmpty { return text }
        if let delta = object["delta"]?.stringValue, !delta.isEmpty { return delta }
        return nil
    }

    private func eventBelongs(_ raw: ACPValue, to sessionID: String) -> Bool {
        let object = raw.objectValue ?? [:]
        let properties = object["properties"]?.objectValue ?? object
        let candidates = [
            properties["sessionID"]?.stringValue,
            properties["sessionId"]?.stringValue,
            object["sessionID"]?.stringValue,
            object["sessionId"]?.stringValue,
        ].compactMap { $0 }
        // Server-wide lifecycle events carry no session id; do not filter them out.
        return candidates.isEmpty || candidates.contains(sessionID)
    }
}

// =============================================================================
// URLSessionOpenCodeTransport — real HTTP+SSE transport (runtime path).
//
// Not on the unit-tested path: adapters are proven with a scripted mock, and the
// docker verifier drives the real opencode server over curl. This is the runtime
// implementation the daemon uses in the sidecar. Portable across macOS/Linux by
// using completion-handler data tasks + a data delegate for SSE (no reliance on
// the availability-gated async URLSession API).
// =============================================================================
public final class URLSessionOpenCodeTransport: OpenCodeTransport, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let authorization: String?

    public init(baseURL: URL, serverPassword: String? = nil) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60
        self.session = URLSession(configuration: configuration)
        if let serverPassword {
            let raw = "opencode:\(serverPassword)"
            let encoded = Data(raw.utf8).base64EncodedString()
            self.authorization = "Basic \(encoded)"
        } else {
            self.authorization = nil
        }
    }

    public func send(_ request: OpenCodeHTTPRequest) async throws -> OpenCodeHTTPResponse {
        guard let url = URL(string: request.path, relativeTo: baseURL) else {
            throw WorkEngineError.transport("bad url \(request.path)")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        if let authorization { urlRequest.setValue(authorization, forHTTPHeaderField: "Authorization") }
        if let body = request.body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try JSONEncoder().encode(body)
        }
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: urlRequest) { data, response, error in
                if let error {
                    continuation.resume(throwing: WorkEngineError.transport(error.localizedDescription))
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let value: ACPValue
                if let data, !data.isEmpty,
                   let decoded = try? JSONDecoder().decode(ACPValue.self, from: data) {
                    value = decoded
                } else {
                    value = .object([:])
                }
                continuation.resume(returning: OpenCodeHTTPResponse(status: status, body: value))
            }
            task.resume()
        }
    }

    public func events() async throws -> AsyncThrowingStream<ACPValue, any Error> {
        guard let url = URL(string: "/event", relativeTo: baseURL) else {
            throw WorkEngineError.transport("bad url /event")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let authorization { urlRequest.setValue(authorization, forHTTPHeaderField: "Authorization") }
        let delegate = SSEDelegate()
        let stream = delegate.stream
        let sseSession = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let task = sseSession.dataTask(with: urlRequest)
        delegate.onTerminate = { task.cancel() }
        task.resume()
        return stream
    }
}

/// Buffers the SSE byte stream, extracts `data:` payloads on frame boundaries,
/// parses each as JSON, and yields it. Errors and completion end the stream.
private final class SSEDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let stream: AsyncThrowingStream<ACPValue, any Error>
    private let continuation: AsyncThrowingStream<ACPValue, any Error>.Continuation
    private var buffer = Data()
    var onTerminate: (@Sendable () -> Void)?

    override init() {
        var capturedContinuation: AsyncThrowingStream<ACPValue, any Error>.Continuation!
        stream = AsyncThrowingStream { capturedContinuation = $0 }
        continuation = capturedContinuation
        super.init()
        continuation.onTermination = { [weak self] _ in self?.onTerminate?() }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        // SSE frames are separated by a blank line ("\n\n").
        while let range = buffer.range(of: Data([0x0A, 0x0A])) {
            let frame = buffer[..<range.lowerBound]
            buffer.removeSubrange(..<range.upperBound)
            emitFrame(frame)
        }
    }

    private func emitFrame(_ frame: Data) {
        guard let text = String(data: frame, encoding: .utf8) else { return }
        var payload = ""
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix("data:") {
                let value = line.dropFirst("data:".count)
                    .drop(while: { $0 == " " })
                payload += value
            }
        }
        guard !payload.isEmpty, let data = payload.data(using: .utf8),
              let value = try? JSONDecoder().decode(ACPValue.self, from: data)
        else { return }
        continuation.yield(value)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        if let error {
            continuation.finish(throwing: WorkEngineError.transport(error.localizedDescription))
        } else {
            continuation.finish()
        }
    }
}
