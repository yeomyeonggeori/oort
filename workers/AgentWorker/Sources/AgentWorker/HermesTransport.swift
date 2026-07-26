import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import NIOFoundationCompat

/// HTTP implementation of the `AgentTransport` over the hermes OpenAI-compatible
/// gateway (L4 §0.3 / §6.1 / §6.2).
///
/// `POST /v1/chat/completions` with `stream=true` +
/// `stream_options.include_usage=true` (Bearer auth). The response is an SSE
/// stream of `chat.completion.chunk` objects; we parse `choices[].delta.content`
/// (text) and `choices[].delta.tool_calls[]` (function calls), plus the trailing
/// `usage` object (OpenAI emits usage only in the LAST chunk when
/// include_usage=true), and the `[DONE]` sentinel.
///
/// **Non-stream fallback (L4 §6.3, §10.1):** some gateways drop `tool_calls`
/// deltas when text + tool_call are mixed in one streamed turn (LiteLLM-class
/// bug). On any SSE parse/transport failure — or when explicitly requested — the
/// transport re-issues the same request with `stream=false` and parses the single
/// JSON completion, so tool calls are never lost.
///
/// Runtime verification status is tracked in STATUS.md. The MOMO-004 gate
/// exercises this with `scripts/mock_hermes.py` when real hermes is unavailable.
struct HermesTransport: Sendable {
    let httpClient: HTTPClient
    let baseURL: String   // e.g. http://hermes:8088/v1
    let apiKey: String    // Bearer
    let logger: Logger

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    // MARK: - Request shapes (OpenAI-compatible)

    struct ChatMessage: Encodable, Sendable, Equatable {
        let role: String
        let content: String
    }

    struct ChatRequest: Encodable, Sendable {
        let model: String
        let messages: [ChatMessage]
        let stream: Bool
        let stream_options: StreamOptions?
        let tools: JSONValue?     // OpenAI function/tool defs (pass-through), may be nil
        let max_tokens: Int?

        struct StreamOptions: Encodable, Sendable {
            let include_usage: Bool
        }
    }

    // MARK: - Public API (AgentTransport contract, L4 §6.1)

    /// Invoke the model and stream `AgentEvent`s. Streaming first; an untouched
    /// stream may fall back to non-stream for parse/protocol errors only. Once a
    /// content event was emitted, replaying the prompt would append a whole second
    /// response to an already-visible partial answer.
    ///
    /// Returns an `AsyncThrowingStream` the worker loop consumes to drive
    /// `agent.partial` publishes + the final `message` write.
    func invoke(
        model: String,
        messages: [ChatMessage],
        tools: JSONValue?,
        maxTokens: Int?,
        /// The remaining *cascade-wide* wall-clock allowance, if this invocation
        /// belongs to a provider chain. Nil keeps the legacy 120s transport limit.
        timeout: Duration? = nil
    ) -> AsyncThrowingStream<AgentEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let emissionTracker = ContentEmissionTracker()
                do {
                    try await streamCompletion(
                        model: model, messages: messages, tools: tools,
                        maxTokens: maxTokens, timeout: timeout,
                        didEmitContent: { emissionTracker.mark() }, into: continuation)
                    continuation.finish()
                } catch {
                    // A non-stream replay is safe only before any text/tool/usage
                    // event, and only for a parse/protocol failure. Availability
                    // failures are for the cascade to classify and fall over.
                    guard !emissionTracker.hasEmitted, Self.isProtocolFailure(error) else {
                        continuation.finish(throwing: error)
                        return
                    }
                    logger.warning("hermes stream failed; falling back to non-stream", metadata: [
                        "error": .string(String(describing: error)),
                    ])
                    do {
                        try await nonStreamCompletion(
                            model: model, messages: messages, tools: tools,
                            maxTokens: maxTokens, timeout: timeout, into: continuation)
                        continuation.finish()
                    } catch {
                        continuation.yield(.error("hermes fallback failed: \(error)"))
                        continuation.finish(throwing: error)
                    }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Streaming path (SSE)

    private func streamCompletion(
        model: String,
        messages: [ChatMessage],
        tools: JSONValue?,
        maxTokens: Int?,
        timeout: Duration?,
        didEmitContent: @escaping @Sendable () -> Void,
        into continuation: AsyncThrowingStream<AgentEvent, Error>.Continuation
    ) async throws {
        let body = ChatRequest(
            model: model, messages: messages, stream: true,
            stream_options: .init(include_usage: true),
            tools: tools, max_tokens: maxTokens)

        var request = HTTPClientRequest(url: "\(baseURL)/chat/completions")
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/json")
        request.headers.add(name: "Accept", value: "text/event-stream")
        request.headers.add(name: "Authorization", value: "Bearer \(apiKey)")
        request.body = .bytes(ByteBuffer(data: try Self.encoder.encode(body)))

        let response = try await httpClient.execute(request, timeout: Self.requestTimeout(timeout))
        guard response.status == .ok else {
            throw TransportError.httpStatus(Int(response.status.code))
        }

        continuation.yield(.status(.streaming))

        // Accumulators: tool_calls arrive across many deltas keyed by index; the
        // function name comes in the first delta, arguments stream char-by-char.
        var toolCallBuffers: [Int: (id: String, name: String, args: String)] = [:]

        var sse = SSEByteParser()
        for try await chunk in response.body {
            if Task.isCancelled { break }
            let events = sse.consume(chunk)
            for event in events {
                guard let dataLine = event.dataLine else { continue }
                if dataLine == "[DONE]" {
                    // Flush any buffered tool calls (defensive: usually flushed by
                    // finish_reason, but [DONE] is the hard stop).
                    flushToolCalls(&toolCallBuffers, didEmitContent: didEmitContent, into: continuation)
                    return
                }
                try parseStreamChunk(
                    dataLine, toolCalls: &toolCallBuffers,
                    didEmitContent: didEmitContent, into: continuation)
            }
        }
        // Stream ended without [DONE] (some gateways just close) → flush.
        flushToolCalls(&toolCallBuffers, didEmitContent: didEmitContent, into: continuation)
    }

    /// Decode one `chat.completion.chunk` JSON line and emit deltas.
    private func parseStreamChunk(
        _ json: String,
        toolCalls: inout [Int: (id: String, name: String, args: String)],
        didEmitContent: @escaping @Sendable () -> Void,
        into continuation: AsyncThrowingStream<AgentEvent, Error>.Continuation
    ) throws {
        let chunk = try Self.decoder.decode(ChatCompletionChunk.self, from: Data(json.utf8))

        // usage (last chunk only, when include_usage=true) → reconcile basis (§8.5).
        if let u = chunk.usage {
            didEmitContent()
            continuation.yield(.usage(
                promptTokens: u.prompt_tokens ?? 0,
                completionTokens: u.completion_tokens ?? 0,
                cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
                reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0))
        }

        guard let choice = chunk.choices?.first else { return }

        if let content = choice.delta?.content, !content.isEmpty {
            didEmitContent()
            continuation.yield(.textDelta(content))
        }

        // tool_calls stream incrementally; accumulate by index then emit on finish.
        if let deltas = choice.delta?.tool_calls {
            for tc in deltas {
                let idx = tc.index ?? 0
                var entry = toolCalls[idx] ?? (id: "", name: "", args: "")
                if let id = tc.id { entry.id = id }
                if let name = tc.function?.name { entry.name = name }
                if let args = tc.function?.arguments { entry.args += args }
                toolCalls[idx] = entry
            }
        }

        if let reason = choice.finish_reason, reason == "tool_calls" {
            flushToolCalls(&toolCalls, didEmitContent: didEmitContent, into: continuation)
        }
    }

    private func flushToolCalls(
        _ toolCalls: inout [Int: (id: String, name: String, args: String)],
        didEmitContent: @escaping @Sendable () -> Void,
        into continuation: AsyncThrowingStream<AgentEvent, Error>.Continuation
    ) {
        for (_, tc) in toolCalls.sorted(by: { $0.key < $1.key }) where !tc.name.isEmpty {
            didEmitContent()
            continuation.yield(.toolCall(id: tc.id, name: tc.name, arguments: tc.args))
        }
        toolCalls.removeAll()
    }

    // MARK: - Non-stream fallback path (L4 §6.3)

    private func nonStreamCompletion(
        model: String,
        messages: [ChatMessage],
        tools: JSONValue?,
        maxTokens: Int?,
        timeout: Duration?,
        into continuation: AsyncThrowingStream<AgentEvent, Error>.Continuation
    ) async throws {
        let body = ChatRequest(
            model: model, messages: messages, stream: false,
            stream_options: nil, tools: tools, max_tokens: maxTokens)

        var request = HTTPClientRequest(url: "\(baseURL)/chat/completions")
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/json")
        request.headers.add(name: "Authorization", value: "Bearer \(apiKey)")
        request.body = .bytes(ByteBuffer(data: try Self.encoder.encode(body)))

        let response = try await httpClient.execute(request, timeout: Self.requestTimeout(timeout))
        guard response.status == .ok else {
            throw TransportError.httpStatus(Int(response.status.code))
        }
        var buffer = try await response.body.collect(upTo: 4 * 1024 * 1024)
        let data = buffer.readData(length: buffer.readableBytes) ?? Data()

        let completion = try Self.decoder.decode(ChatCompletion.self, from: data)
        if let choice = completion.choices?.first {
            if let content = choice.message?.content, !content.isEmpty {
                continuation.yield(.textDelta(content))   // whole body as one delta
            }
            if let toolCalls = choice.message?.tool_calls {
                for tc in toolCalls {
                    continuation.yield(.toolCall(
                        id: tc.id ?? "",
                        name: tc.function?.name ?? "",
                        arguments: tc.function?.arguments ?? "{}"))
                }
            }
        }
        if let u = completion.usage {
            continuation.yield(.usage(
                promptTokens: u.prompt_tokens ?? 0,
                completionTokens: u.completion_tokens ?? 0,
                cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
                reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0))
        }
    }

    enum TransportError: Error, Sendable {
        case httpStatus(Int)
    }

    private static func isProtocolFailure(_ error: any Error) -> Bool {
        error is DecodingError
    }

    private static func requestTimeout(_ budget: Duration?) -> TimeAmount {
        guard let budget else { return .seconds(120) }
        let components = budget.components
        let milliseconds = components.seconds * 1_000
            + components.attoseconds / 1_000_000_000_000_000
        return .milliseconds(max(milliseconds, 1))
    }
}

/// `HermesTransport.invoke`'s producer and parser closures are Sendable. The
/// parser is the only writer, but this lock keeps the fallback guard race-free
/// without turning the hot SSE path into an actor hop.
private final class ContentEmissionTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var emitted = false

    func mark() {
        lock.lock()
        emitted = true
        lock.unlock()
    }

    var hasEmitted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return emitted
    }
}

// MARK: - OpenAI response decode shapes (shared by stream + non-stream)

/// One streamed delta object (`object: "chat.completion.chunk"`).
private struct ChatCompletionChunk: Decodable {
    let choices: [Choice]?
    let usage: Usage?

    struct Choice: Decodable {
        let delta: Delta?
        let finish_reason: String?
    }
    struct Delta: Decodable {
        let content: String?
        let tool_calls: [ToolCallDelta]?
    }
}

/// One full completion object (non-stream fallback).
private struct ChatCompletion: Decodable {
    let choices: [Choice]?
    let usage: Usage?

    struct Choice: Decodable {
        let message: Message?
        let finish_reason: String?
    }
    struct Message: Decodable {
        let content: String?
        let tool_calls: [ToolCallDelta]?
    }
}

/// tool_calls element — identical shape in stream deltas and full messages.
private struct ToolCallDelta: Decodable {
    let index: Int?
    let id: String?
    let type: String?
    let function: FunctionCall?

    struct FunctionCall: Decodable {
        let name: String?
        let arguments: String?
    }
}

/// OpenAI usage object (last streamed chunk when include_usage=true, or whole
/// completion in non-stream). Drives the §8.5 reconcile step.
private struct Usage: Decodable {
    let prompt_tokens: Int?
    let completion_tokens: Int?
    let total_tokens: Int?
    let prompt_tokens_details: PromptDetails?
    let completion_tokens_details: CompletionDetails?

    struct PromptDetails: Decodable { let cached_tokens: Int? }
    struct CompletionDetails: Decodable { let reasoning_tokens: Int? }
}
