@preconcurrency import Crypto
import Foundation

// =============================================================================
// RFC 6455 server half, as pure functions over bytes (MOMO-655).
//
// Nothing here opens a socket, reads a clock, or knows what a work session is:
// every decision this file makes is a value in and a value out, so the parts of
// the attach adapter that are easy to get subtly wrong (the accept key, the
// mask, a 64-bit length, a fragmented message, a bearer that arrived through a
// subprotocol list instead of a header) are the parts covered by unit tests
// rather than by a live terminal.
//
// Why hand-rolled instead of a dependency: momo-workd currently links
// swift-crypto and swift-log only, ships as a --static-swift-stdlib binary in
// the work host image, and needs exactly one server-side endpoint that speaks
// text/binary/close/ping. TLS is NOT in this file and not in this daemon —
// ADR-0125 D10 keeps bytes off the server, not off an operator's own reverse
// proxy, and the self-host reality is that the proxy already terminating TLS
// for the momo deployment is the honest place for a host certificate too
// (docs/runbooks/workd-terminal-attach.md).
// =============================================================================

enum WebSocketOpcode: UInt8, Sendable, Equatable {
    case continuation = 0x0
    case text = 0x1
    case binary = 0x2
    case close = 0x8
    case ping = 0x9
    case pong = 0xA

    var isControl: Bool { rawValue & 0x8 != 0 }
}

enum WebSocketWireError: Error, Equatable, Sendable {
    /// The peer broke framing (reserved bits, unknown opcode, unmasked client
    /// frame, a fragmented control frame, or a continuation with nothing to
    /// continue). Always fatal for the connection: RFC 6455 close code 1002.
    case protocolError
    /// A single message exceeded the configured bound. Close code 1009.
    case messageTooLarge
}

/// One complete application message (control frames arrive whole by definition).
struct WebSocketMessage: Sendable, Equatable {
    let opcode: WebSocketOpcode
    let payload: Data
}

enum WebSocketWire {
    /// RFC 6455 §1.3.
    static let handshakeGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    static func acceptKey(for key: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data((key + handshakeGUID).utf8))
        return Data(digest).base64EncodedString()
    }

    /// Server-to-client frames are never masked (RFC 6455 §5.1) and this
    /// endpoint never fragments: every message it sends is one FIN frame, which
    /// is what keeps the replay ordering contract (`PTYReplayBuffer.connect`)
    /// visible on the wire instead of spread across continuations.
    static func encode(opcode: WebSocketOpcode, payload: Data) -> Data {
        var out = Data([0x80 | opcode.rawValue])
        let count = payload.count
        if count < 126 {
            out.append(UInt8(count))
        } else if count <= 0xFFFF {
            out.append(126)
            out.append(UInt8(truncatingIfNeeded: count >> 8))
            out.append(UInt8(truncatingIfNeeded: count))
        } else {
            out.append(127)
            let value = UInt64(count)
            for shift in stride(from: 56, through: 0, by: -8) {
                out.append(UInt8(truncatingIfNeeded: value >> UInt64(shift)))
            }
        }
        out.append(payload)
        return out
    }

    /// A close frame carrying the code the peer classifies on. The reason is the
    /// contract with the clients that already exist: the web
    /// (`classifyClose` in observerStream.ts) and the mac
    /// (`MomoURLSessionRemoteTerminalTransport.classify`) both read this string
    /// for "expired", "revoked"/"ended", "forbidden"/"unauthorized", so the
    /// vocabulary below is not free-form prose.
    static func closeFrame(code: UInt16, reason: String) -> Data {
        var payload = Data([
            UInt8(truncatingIfNeeded: code >> 8),
            UInt8(truncatingIfNeeded: code),
        ])
        var reasonBytes = Data(reason.utf8)
        if reasonBytes.count > 123 { reasonBytes = reasonBytes.prefix(123) }
        payload.append(reasonBytes)
        return encode(opcode: .close, payload: payload)
    }
}

/// Incremental client-frame reader. Feed it whatever `read()` returned; take
/// whole messages out until it says it needs more bytes.
struct WebSocketFrameDecoder {
    /// A terminal attach client sends keystrokes and a connect frame. A
    /// megabyte is already three orders of magnitude more than that; anything
    /// beyond it is a peer to disconnect, not a buffer to grow.
    static let defaultMaxMessageBytes = 1 << 20

    private let maxMessageBytes: Int
    private var buffer: [UInt8] = []
    private var fragmentOpcode: WebSocketOpcode?
    private var fragment: [UInt8] = []

    init(maxMessageBytes: Int = WebSocketFrameDecoder.defaultMaxMessageBytes) {
        self.maxMessageBytes = max(125, maxMessageBytes)
    }

    /// Bytes held for an incomplete frame; a test asserts this returns to zero.
    var bufferedByteCount: Int { buffer.count + fragment.count }

    mutating func append(_ data: Data) {
        buffer.append(contentsOf: data)
    }

    /// The next complete message, or nil when more bytes are needed.
    mutating func next() throws -> WebSocketMessage? {
        while true {
            guard let frame = try parseFrame() else { return nil }
            if frame.opcode.isControl {
                guard frame.fin, frame.payload.count <= 125 else {
                    throw WebSocketWireError.protocolError
                }
                return WebSocketMessage(
                    opcode: frame.opcode,
                    payload: Data(frame.payload)
                )
            }
            switch frame.opcode {
            case .continuation:
                guard let opcode = fragmentOpcode else {
                    throw WebSocketWireError.protocolError
                }
                guard fragment.count + frame.payload.count <= maxMessageBytes else {
                    throw WebSocketWireError.messageTooLarge
                }
                fragment.append(contentsOf: frame.payload)
                guard frame.fin else { continue }
                let payload = Data(fragment)
                fragment.removeAll(keepingCapacity: false)
                fragmentOpcode = nil
                return WebSocketMessage(opcode: opcode, payload: payload)
            case .text, .binary:
                guard fragmentOpcode == nil else {
                    throw WebSocketWireError.protocolError
                }
                if frame.fin {
                    return WebSocketMessage(
                        opcode: frame.opcode,
                        payload: Data(frame.payload)
                    )
                }
                fragmentOpcode = frame.opcode
                fragment = frame.payload
            default:
                throw WebSocketWireError.protocolError
            }
        }
    }

    private struct RawFrame {
        let fin: Bool
        let opcode: WebSocketOpcode
        let payload: [UInt8]
    }

    private mutating func parseFrame() throws -> RawFrame? {
        guard buffer.count >= 2 else { return nil }
        let first = buffer[0]
        let second = buffer[1]
        guard first & 0x70 == 0 else { throw WebSocketWireError.protocolError }
        guard let opcode = WebSocketOpcode(rawValue: first & 0x0F) else {
            throw WebSocketWireError.protocolError
        }
        // RFC 6455 §5.1: a client MUST mask. An unmasked client frame is a
        // proxy rewriting the stream or a peer that is not a browser; either
        // way it is not something to decode on a credentialed socket.
        guard second & 0x80 != 0 else { throw WebSocketWireError.protocolError }
        var length = Int(second & 0x7F)
        var offset = 2
        if length == 126 {
            guard buffer.count >= offset + 2 else { return nil }
            length = Int(buffer[offset]) << 8 | Int(buffer[offset + 1])
            offset += 2
        } else if length == 127 {
            guard buffer.count >= offset + 8 else { return nil }
            var value: UInt64 = 0
            for index in 0..<8 {
                value = value << 8 | UInt64(buffer[offset + index])
            }
            guard value <= UInt64(maxMessageBytes) else {
                throw WebSocketWireError.messageTooLarge
            }
            length = Int(value)
            offset += 8
        }
        guard length <= maxMessageBytes else {
            throw WebSocketWireError.messageTooLarge
        }
        guard buffer.count >= offset + 4 + length else { return nil }
        let mask = Array(buffer[offset..<(offset + 4)])
        offset += 4
        var payload = Array(buffer[offset..<(offset + length)])
        for index in 0..<length { payload[index] ^= mask[index % 4] }
        buffer.removeFirst(offset + length)
        return RawFrame(fin: first & 0x80 != 0, opcode: opcode, payload: payload)
    }
}

/// The upgrade request, reduced to what this endpoint decides on.
struct HTTPUpgradeRequest: Sendable, Equatable {
    let method: String
    let target: String
    /// Header names lowercased; repeats joined with ", " as RFC 9110 allows.
    let headers: [String: String]

    /// Largest request head accepted before the peer is hung up on. A legitimate
    /// upgrade is a few hundred bytes; this bound is what stops a socket that
    /// never sends CRLFCRLF from becoming daemon memory.
    static let maxHeadBytes = 16 * 1_024

    static func parse(_ head: Data) -> HTTPUpgradeRequest? {
        guard let text = String(data: head, encoding: .utf8) else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        while lines.last?.isEmpty == true { lines.removeLast() }
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2].hasPrefix("HTTP/1.") else { return nil }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { return nil }
            let name = line[line.startIndex..<colon]
                .trimmingCharacters(in: .whitespaces)
                .lowercased()
            let value = line[line.index(after: colon)...]
                .trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return nil }
            if let existing = headers[name] {
                headers[name] = existing + ", " + value
            } else {
                headers[name] = value
            }
        }
        return HTTPUpgradeRequest(
            method: String(parts[0]),
            target: String(parts[1]),
            headers: headers
        )
    }
}

/// How a client presented its capability bearer, and what must be echoed back.
///
/// Two transports, one credential. The mac sends `Authorization: Bearer`, which
/// a browser cannot set on a WebSocket handshake; the web sends the token as a
/// second subprotocol beside `momo.terminal.v1` (observerStream.ts documents why
/// the query parameter alternative is worse). This host accepts either and
/// invents no third grammar — the token itself is the same
/// `momo_terminal_attach_v1.<43>` the server minted.
struct TerminalAttachHandshake: Sendable, Equatable {
    static let subprotocol = "momo.terminal.v1"
    static let capabilityPrefix = "momo_terminal_attach_v1"

    let capabilityToken: String
    let acceptKey: String
    /// Non-nil only when the bearer arrived through the subprotocol list, in
    /// which case RFC 6455 requires the server to name the one it selected.
    let selectedSubprotocol: String?

    enum Rejection: Error, Equatable, Sendable {
        case badRequest
        case unauthorized

        var status: (code: Int, text: String) {
            switch self {
            case .badRequest: (400, "Bad Request")
            case .unauthorized: (401, "Unauthorized")
            }
        }
    }

    static func accept(_ request: HTTPUpgradeRequest) throws -> TerminalAttachHandshake {
        guard request.method == "GET" else { throw Rejection.badRequest }
        guard let upgrade = request.headers["upgrade"]?.lowercased(),
              upgrade.split(separator: ",").contains(where: {
                  $0.trimmingCharacters(in: .whitespaces) == "websocket"
              }),
              let connection = request.headers["connection"]?.lowercased(),
              connection.split(separator: ",").contains(where: {
                  $0.trimmingCharacters(in: .whitespaces) == "upgrade"
              }),
              request.headers["sec-websocket-version"] == "13",
              let key = request.headers["sec-websocket-key"],
              isValidHandshakeKey(key)
        else { throw Rejection.badRequest }

        let offered = (request.headers["sec-websocket-protocol"] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        if let authorization = request.headers["authorization"] {
            let parts = authorization.split(separator: " ", maxSplits: 1)
            guard parts.count == 2,
                  parts[0].lowercased() == "bearer",
                  isValidCapabilityToken(String(parts[1]))
            else { throw Rejection.unauthorized }
            return TerminalAttachHandshake(
                capabilityToken: String(parts[1]),
                acceptKey: WebSocketWire.acceptKey(for: key),
                selectedSubprotocol: offered.contains(subprotocol) ? subprotocol : nil
            )
        }

        guard offered.contains(subprotocol),
              let token = offered.first(where: isValidCapabilityToken)
        else { throw Rejection.unauthorized }
        return TerminalAttachHandshake(
            capabilityToken: token,
            acceptKey: WebSocketWire.acceptKey(for: key),
            selectedSubprotocol: subprotocol
        )
    }

    /// Syntax only. Authority is the server's: the daemon never decides that a
    /// well-formed token is a valid grant (ADR-0125 D10 — this host has no
    /// membership, expiry, or revocation state to decide it with).
    static func isValidCapabilityToken(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == Substring(capabilityPrefix) else {
            return false
        }
        return parts[1].wholeMatch(of: /^[A-Za-z0-9_-]{43}$/) != nil
    }

    static func isValidHandshakeKey(_ value: String) -> Bool {
        guard value.count == 24, let decoded = Data(base64Encoded: value) else {
            return false
        }
        return decoded.count == 16
    }

    var response: Data {
        var lines = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Accept: \(acceptKey)",
        ]
        if let selectedSubprotocol {
            lines.append("Sec-WebSocket-Protocol: \(selectedSubprotocol)")
        }
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    static func rejection(_ rejection: Rejection) -> Data {
        let (code, text) = rejection.status
        let body = "\(text)\n"
        let head = [
            "HTTP/1.1 \(code) \(text)",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Length: \(body.utf8.count)",
            "Connection: close",
        ].joined(separator: "\r\n")
        return Data((head + "\r\n\r\n" + body).utf8)
    }
}

/// The client frames this host understands, decoded from the exact JSON the mac
/// (`MomoTerminalAttachFrame`) and the web (`connectFrame`) already emit.
enum TerminalAttachClientFrame: Sendable, Equatable {
    case connect(ptyID: String)
    case sendStdin(ptyID: String, data: Data)
    case resize(ptyID: String, columns: Int, rows: Int)
    case kill(ptyID: String)
    /// A frame this host does not act on. Tolerated rather than fatal: a client
    /// that learns a new verb before this daemon does must not lose its stream
    /// over it.
    case unsupported(type: String)

    static func decode(_ payload: Data) -> TerminalAttachClientFrame? {
        guard let object = try? JSONSerialization.jsonObject(with: payload),
              let dictionary = object as? [String: Any],
              let type = dictionary["type"] as? String
        else { return nil }
        let ptyID = dictionary["pty_id"] as? String
        switch type {
        case "connect":
            guard let ptyID else { return nil }
            return .connect(ptyID: ptyID)
        case "send_stdin":
            guard let ptyID,
                  let encoded = dictionary["data"] as? String,
                  let data = Data(base64Encoded: encoded)
            else { return nil }
            return .sendStdin(ptyID: ptyID, data: data)
        case "resize":
            guard let ptyID,
                  let columns = dictionary["cols"] as? Int,
                  let rows = dictionary["rows"] as? Int,
                  columns > 0, rows > 0
            else { return nil }
            return .resize(ptyID: ptyID, columns: columns, rows: rows)
        case "kill":
            guard let ptyID else { return nil }
            return .kill(ptyID: ptyID)
        default:
            return .unsupported(type: type)
        }
    }
}
