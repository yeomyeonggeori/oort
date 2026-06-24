import Foundation
import NIOCore

/// Incremental Server-Sent Events framing parser (L4 §6.2 SSE relay).
///
/// AsyncHTTPClient delivers the response body as arbitrary `ByteBuffer` chunks
/// that do NOT respect SSE event boundaries — a single `data:` line can be split
/// across two network reads, or several events can arrive in one read. This
/// parser buffers bytes, splits on the SSE record separator (a blank line, i.e.
/// `\n\n`), and returns one `SSEEvent` per complete record. Incomplete trailing
/// bytes are retained for the next `consume` call.
///
/// We only need the `data:` field (OpenAI Chat Completions emits `data: {json}`
/// per chunk and a terminal `data: [DONE]`); `event:`/`id:` lines are parsed but
/// unused here.
struct SSEByteParser {
    private var buffer = Data()

    /// A parsed SSE record. `dataLine` is the concatenation of all `data:` fields
    /// (OpenAI uses exactly one per event), trimmed of the leading space.
    struct SSEEvent {
        let dataLine: String?
    }

    /// Feed a network chunk; return any complete events it (plus buffered bytes)
    /// now forms. Partial trailing data stays buffered.
    mutating func consume(_ chunk: ByteBuffer) -> [SSEEvent] {
        var chunk = chunk
        if let bytes = chunk.readBytes(length: chunk.readableBytes) {
            buffer.append(contentsOf: bytes)
        }
        return drainComplete()
    }

    /// Split buffered bytes on the blank-line record separator, parsing each
    /// complete record. Handles both `\n\n` and `\r\n\r\n` separators.
    private mutating func drainComplete() -> [SSEEvent] {
        var events: [SSEEvent] = []
        while let range = nextSeparatorRange() {
            let recordData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            if let event = parseRecord(recordData) {
                events.append(event)
            }
        }
        return events
    }

    /// Find the first `\n\n` or `\r\n\r\n` record separator in the buffer.
    private func nextSeparatorRange() -> Range<Data.Index>? {
        let lf2 = Data([0x0A, 0x0A])              // \n\n
        let crlf2 = Data([0x0D, 0x0A, 0x0D, 0x0A]) // \r\n\r\n
        let a = buffer.range(of: lf2)
        let b = buffer.range(of: crlf2)
        switch (a, b) {
        case let (a?, b?): return a.lowerBound <= b.lowerBound ? a : b
        case let (a?, nil): return a
        case let (nil, b?): return b
        case (nil, nil): return nil
        }
    }

    /// Parse one SSE record into its concatenated `data:` payload.
    private func parseRecord(_ data: Data) -> SSEEvent? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        var dataParts: [String] = []
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : String(rawLine)
            if line.hasPrefix(":") { continue }   // SSE comment / heartbeat
            guard let colon = line.firstIndex(of: ":") else { continue }
            let field = String(line[line.startIndex..<colon])
            var value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
            if field == "data" { dataParts.append(value) }
        }
        guard !dataParts.isEmpty else { return nil }
        return SSEEvent(dataLine: dataParts.joined(separator: "\n"))
    }
}
