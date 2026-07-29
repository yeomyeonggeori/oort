import Foundation
import Logging
import MomoACPHost

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// =============================================================================
// The inbound half of ADR-0125 D10 (MOMO-655).
//
// #857 landed everything on the host side of the seam — the shell wrapper, the
// 256KiB ring, and `PTYReplayBuffer.connect()`'s retained→replayEnd→live
// ordering — and then stopped, correctly, because a public network listener
// with a credential on it is not something a worker invents. The server half
// was already written (TerminalAttachRoutes: capability mint + host-signed
// validate), and so was the web half (observerStream.ts). This file is the
// missing middle, and it deliberately adds no new authority:
//
//   * it does not decide whether a capability is valid. It asks the server,
//     under its own MomoHost signature, on every connection. Expiry, session
//     end, host revocation, channel membership and observer/controller grade
//     are all the server's single answer.
//   * it does not decide what a client may do. `mode` comes back from that same
//     answer, and an observer's stdin is dropped on the floor at this layer,
//     not in a UI.
//   * it does not terminate TLS. `attachEndpoint` is wss:// because a reverse
//     proxy in front of this listener makes it so; see
//     docs/runbooks/workd-terminal-attach.md. The daemon binds 127.0.0.1 by default
//     precisely so that "no proxy configured" fails closed as unreachable
//     rather than open as plaintext on a LAN.
// =============================================================================

struct TerminalAttachConfig: Sendable, Equatable {
    /// Default is loopback: a listener nobody put a TLS proxy in front of must
    /// not be reachable from the network.
    static let defaultBindAddress = "127.0.0.1"
    static let defaultPort: UInt16 = 28_650
    static let defaultMaxConnections = 32

    let bindAddress: String
    let port: UInt16
    /// The credential-free https/wss URL clients are told to dial. Published to
    /// the server as `attach_endpoint`; it is the proxy's address, not this
    /// socket's, whenever the two differ.
    let publicEndpoint: String
    let maxConnections: Int

    /// Same grammar the server enforces in `RemotePTYBinding.validated`, checked
    /// here so a typo fails at daemon boot instead of as a 400 on the first
    /// spawn.
    static func validatedPublicEndpoint(_ raw: String) -> String? {
        guard raw.count <= 2_048,
              !raw.contains("\0"),
              let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "wss",
              // Foundation reports an empty string, not nil, for "wss:///path".
              let host = components.host, !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else { return nil }
        return raw
    }
}

enum AttachTransportError: Error, Equatable, Sendable {
    case closed
    case peerClosed
    case io
    case timedOut
    /// The peer stopped draining and the outbound queue hit its bound. Same
    /// philosophy as `PTYReplayBuffer`'s `.overflow`: sever, do not grow.
    case backpressure
}

/// One accepted connection's file descriptor, made safe to use from a reader
/// task and a writer task at once.
///
/// Both directions are non-blocking and retried around `Task.sleep`, so a stuck
/// peer costs one suspended task and never a blocked thread from the cooperative
/// pool. Writes are serialized through a single drain loop: two tasks
/// interleaving partial writes would splice two WebSocket frames into garbage.
actor AttachSocket {
    private static let retryInterval = Duration.milliseconds(5)

    private let descriptor: Int32
    private let maxPendingBytes: Int
    private let writeTimeout: Duration
    private var pending: [Data] = []
    private var pendingBytes = 0
    private var draining = false
    private var closed = false

    init(
        descriptor: Int32,
        maxPendingBytes: Int = 4 * 1_024 * 1_024,
        writeTimeout: Duration = .seconds(15)
    ) {
        self.descriptor = descriptor
        self.maxPendingBytes = maxPendingBytes
        self.writeTimeout = writeTimeout
    }

    func send(_ data: Data) async throws {
        guard !closed else { throw AttachTransportError.closed }
        guard !data.isEmpty else { return }
        guard pendingBytes + data.count <= maxPendingBytes else {
            close()
            throw AttachTransportError.backpressure
        }
        pending.append(data)
        pendingBytes += data.count
        try await drain()
    }

    func receive(maxBytes: Int = 16 * 1_024) async throws -> Data {
        var buffer = [UInt8](repeating: 0, count: maxBytes)
        while true {
            guard !closed else { throw AttachTransportError.closed }
            let count = buffer.withUnsafeMutableBytes { raw in
                read(descriptor, raw.baseAddress, maxBytes)
            }
            if count > 0 { return Data(buffer[0..<count]) }
            if count == 0 { throw AttachTransportError.peerClosed }
            switch errno {
            case EAGAIN, EWOULDBLOCK:
                try await Task.sleep(for: Self.retryInterval)
            case EINTR:
                continue
            default:
                throw AttachTransportError.io
            }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        pending.removeAll()
        pendingBytes = 0
        shutdown(descriptor, Int32(SHUT_RDWR))
        _ = systemCloseDescriptor(descriptor)
    }

    private func drain() async throws {
        // Another call already owns the write loop; it will pick up what this
        // one queued. Errors surface to whoever holds the loop, and to everyone
        // else through `closed` on their next send.
        guard !draining else { return }
        draining = true
        defer { draining = false }
        let deadline = ContinuousClock.now.advanced(by: writeTimeout)
        while !pending.isEmpty {
            guard !closed else { throw AttachTransportError.closed }
            let chunk = pending[0]
            let written = chunk.withUnsafeBytes { raw -> Int in
                #if canImport(Darwin)
                return Darwin.send(descriptor, raw.baseAddress, chunk.count, 0)
                #else
                return Glibc.send(
                    descriptor, raw.baseAddress, chunk.count, Int32(MSG_NOSIGNAL)
                )
                #endif
            }
            if written > 0 {
                pendingBytes -= written
                if written == chunk.count {
                    pending.removeFirst()
                } else {
                    pending[0] = chunk.dropFirst(written)
                }
                continue
            }
            if written < 0, errno == EINTR { continue }
            if written < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                guard ContinuousClock.now < deadline else {
                    close()
                    throw AttachTransportError.timedOut
                }
                try await Task.sleep(for: Self.retryInterval)
                continue
            }
            close()
            throw AttachTransportError.io
        }
    }
}

/// Result of the server-side capability check, as this daemon uses it.
struct TerminalAttachGrant: Sendable, Equatable {
    let workSessionID: UUID
    let ptyID: String
    let mode: ProcessManager.AttachMode
}

final class TerminalAttachServer: @unchecked Sendable {
    private let config: TerminalAttachConfig
    private let hostID: UUID
    private let api: any WorkHostAPI
    private let processes: ProcessManager
    private let logger: Logger
    private let connections = ConnectionCounter()

    init(
        config: TerminalAttachConfig,
        hostID: UUID,
        api: any WorkHostAPI,
        processes: ProcessManager,
        logger: Logger
    ) {
        self.config = config
        self.hostID = hostID
        self.api = api
        self.processes = processes
        self.logger = logger
    }

    /// Binds and serves until cancelled. Throws only on a bind/listen failure,
    /// which is a configuration fact the operator has to see at boot.
    func run() async throws {
        let listener = try Self.listen(
            address: config.bindAddress,
            port: config.port
        )
        defer { _ = systemCloseDescriptor(listener) }
        logger.info("terminal attach listener ready", metadata: [
            "bind": .string("\(config.bindAddress):\(config.port)"),
            "public_endpoint": .string(config.publicEndpoint),
        ])
        while !Task.isCancelled {
            let accepted = accept(listener, nil, nil)
            if accepted < 0 {
                switch errno {
                case EAGAIN, EWOULDBLOCK:
                    try? await Task.sleep(for: .milliseconds(25))
                case EINTR, ECONNABORTED:
                    continue
                default:
                    logger.warning("terminal attach accept failed", metadata: [
                        "errno": .stringConvertible(errno),
                    ])
                    try? await Task.sleep(for: .milliseconds(200))
                }
                continue
            }
            Self.prepare(accepted)
            guard await connections.acquire(limit: config.maxConnections) else {
                // Refusing is the honest answer; a queued socket on a host with
                // no headroom would just time out at the client's 15s deadline.
                _ = systemCloseDescriptor(accepted)
                logger.warning("terminal attach connection refused", metadata: [
                    "reason": .string("max_connections"),
                ])
                continue
            }
            Task { [weak self] in
                guard let self else { return }
                await serve(descriptor: accepted)
                await connections.release()
            }
        }
    }

    private func serve(descriptor: Int32) async {
        let socket = AttachSocket(descriptor: descriptor)
        do {
            let (handshake, pipelined) = try await readHandshake(socket)
            let grant = try await validate(handshake.capabilityToken)
            try await socket.send(handshake.response)
            try await stream(socket: socket, grant: grant, pipelined: pipelined)
        } catch let rejection as TerminalAttachHandshake.Rejection {
            try? await socket.send(TerminalAttachHandshake.rejection(rejection))
        } catch {
            // Everything past the upgrade is a WebSocket-level ending; the
            // helpers below have already sent the close frame that names it.
        }
        await socket.close()
    }

    /// Reads exactly the request head, then hands the rest of the buffer to the
    /// frame decoder — a client may pipeline its `connect` frame right behind
    /// the upgrade and RFC 6455 allows it.
    private var handshakeTimeout: Duration { .seconds(15) }

    private func readHandshake(
        _ socket: AttachSocket
    ) async throws -> (TerminalAttachHandshake, Data) {
        var head = Data()
        let deadline = ContinuousClock.now.advanced(by: handshakeTimeout)
        while true {
            guard ContinuousClock.now < deadline else {
                throw TerminalAttachHandshake.Rejection.badRequest
            }
            guard head.count <= HTTPUpgradeRequest.maxHeadBytes else {
                throw TerminalAttachHandshake.Rejection.badRequest
            }
            let chunk = try await socket.receive()
            head.append(chunk)
            guard let terminator = head.range(of: Data("\r\n\r\n".utf8)) else {
                continue
            }
            // Anything after CRLFCRLF is already WebSocket framing; this
            // endpoint reads it back off the socket in order, so a head that is
            // followed by a pipelined frame is rejected only if it is malformed.
            let headBytes = head[head.startIndex..<terminator.lowerBound]
            guard let request = HTTPUpgradeRequest.parse(Data(headBytes)) else {
                throw TerminalAttachHandshake.Rejection.badRequest
            }
            return (
                try TerminalAttachHandshake.accept(request),
                Data(head[terminator.upperBound...])
            )
        }
    }

    private func validate(_ token: String) async throws -> TerminalAttachGrant {
        do {
            return try await api.validateTerminalAttach(
                hostID: hostID,
                capabilityToken: token
            )
        } catch {
            logger.info("terminal attach capability rejected", metadata: [
                "error_label": .string(WorkDaemon.label(for: error)),
            ])
            throw TerminalAttachHandshake.Rejection.unauthorized
        }
    }

    private func stream(
        socket: AttachSocket,
        grant: TerminalAttachGrant,
        pipelined: Data
    ) async throws {
        var decoder = WebSocketFrameDecoder()
        decoder.append(pipelined)

        // The client must name the pty it believes it was granted before a
        // single byte moves. It is not an authorization step — the grant above
        // already decided that — it is the check that this socket and this
        // grant are talking about the same terminal.
        guard try await awaitConnect(socket: socket, decoder: &decoder, grant: grant) else {
            return
        }
        let replay: AsyncStream<PTYReplayEvent>
        do {
            replay = try await processes.connect(ptyID: grant.ptyID)
        } catch {
            try? await socket.send(WebSocketWire.closeFrame(
                code: 1_011,
                reason: "session ended"
            ))
            return
        }

        await withTaskGroup(of: Void.self) { group in
            group.addTask { [self] in
                await pump(replay, to: socket)
            }
            group.addTask { [self, decoder] in
                var decoder = decoder
                await read(socket: socket, decoder: &decoder, grant: grant)
            }
            await group.next()
            group.cancelAll()
            await socket.close()
            await group.waitForAll()
        }
    }

    private func awaitConnect(
        socket: AttachSocket,
        decoder: inout WebSocketFrameDecoder,
        grant: TerminalAttachGrant
    ) async throws -> Bool {
        let deadline = ContinuousClock.now.advanced(by: handshakeTimeout)
        while ContinuousClock.now < deadline {
            while let message = try decoder.next() {
                switch message.opcode {
                case .text, .binary:
                    guard case .connect(let ptyID)? =
                        TerminalAttachClientFrame.decode(message.payload)
                    else {
                        try? await socket.send(WebSocketWire.closeFrame(
                            code: 1_002,
                            reason: "connect frame expected"
                        ))
                        return false
                    }
                    guard ptyID == grant.ptyID else {
                        try? await socket.send(WebSocketWire.closeFrame(
                            code: 1_008,
                            reason: "forbidden pty"
                        ))
                        return false
                    }
                    return true
                case .ping:
                    try await socket.send(WebSocketWire.encode(
                        opcode: .pong,
                        payload: message.payload
                    ))
                case .close:
                    return false
                default:
                    continue
                }
            }
            decoder.append(try await socket.receive())
        }
        try? await socket.send(WebSocketWire.closeFrame(
            code: 1_008,
            reason: "connect frame timeout"
        ))
        return false
    }

    /// Host→client. This is the only place the #857 replay contract meets a
    /// wire, and the mapping is the whole point of the ticket: PTY bytes are
    /// BINARY frames, the two markers are TEXT frames carrying the exact JSON
    /// the `PTYReplayEndFrame` / `PTYReplayOverflowFrame` shapes pin down. A
    /// marker written as terminal text would be printed into the user's xterm,
    /// which is the bug the wire-shape test exists to prevent.
    private func pump(_ replay: AsyncStream<PTYReplayEvent>, to socket: AttachSocket) async {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        do {
            for await event in replay {
                switch event {
                case .bytes(let data):
                    try await socket.send(
                        WebSocketWire.encode(opcode: .binary, payload: data)
                    )
                case .replayEnd(let byteOffset):
                    let frame = try encoder.encode(
                        PTYReplayEndFrame(byteOffset: byteOffset)
                    )
                    try await socket.send(
                        WebSocketWire.encode(opcode: .text, payload: frame)
                    )
                case .overflow(let byteOffset):
                    let frame = try encoder.encode(
                        PTYReplayOverflowFrame(byteOffset: byteOffset)
                    )
                    try await socket.send(
                        WebSocketWire.encode(opcode: .text, payload: frame)
                    )
                    // MOMO-661 severs the subscriber here; the client's contract
                    // is "resynchronize with a fresh attach", so the socket ends
                    // with a code that is not a plain clean close.
                    try? await socket.send(WebSocketWire.closeFrame(
                        code: 1_001,
                        reason: "replay overflow"
                    ))
                    return
                }
            }
            try? await socket.send(WebSocketWire.closeFrame(
                code: 1_000,
                reason: "session ended"
            ))
        } catch {
            logger.info("terminal attach stream ended", metadata: [
                "reason": .string("\(error)"),
            ])
        }
    }

    /// Client→host. An observer has no write path at all: its stdin is dropped
    /// here, one layer below any UI that could be made to offer it (ADR-0126
    /// D1). `ProcessManager.write(_:toPTY:mode:)` refuses it a second time.
    private func read(
        socket: AttachSocket,
        decoder: inout WebSocketFrameDecoder,
        grant: TerminalAttachGrant
    ) async {
        do {
            while !Task.isCancelled {
                while let message = try decoder.next() {
                    switch message.opcode {
                    case .close:
                        return
                    case .ping:
                        try await socket.send(WebSocketWire.encode(
                            opcode: .pong,
                            payload: message.payload
                        ))
                    case .pong:
                        continue
                    case .text, .binary:
                        try await apply(message.payload, grant: grant, socket: socket)
                    case .continuation:
                        continue
                    }
                }
                decoder.append(try await socket.receive())
            }
        } catch let error as WebSocketWireError {
            try? await socket.send(WebSocketWire.closeFrame(
                code: error == .messageTooLarge ? 1_009 : 1_002,
                reason: "protocol error"
            ))
        } catch {
            // Peer hung up or the socket died; the group tears the rest down.
        }
    }

    private func apply(
        _ payload: Data,
        grant: TerminalAttachGrant,
        socket: AttachSocket
    ) async throws {
        guard let frame = TerminalAttachClientFrame.decode(payload) else {
            try await socket.send(WebSocketWire.closeFrame(
                code: 1_002,
                reason: "protocol error"
            ))
            throw AttachTransportError.closed
        }
        switch frame {
        case .connect:
            // A second connect on a live stream would silently mean "replay
            // again"; it does not, so it is refused rather than half-honored.
            try await socket.send(WebSocketWire.closeFrame(
                code: 1_002,
                reason: "already connected"
            ))
            throw AttachTransportError.closed
        case .sendStdin(let ptyID, let data):
            guard ptyID == grant.ptyID, grant.mode == .controller else {
                if grant.mode == .observer {
                    try await socket.send(WebSocketWire.closeFrame(
                        code: 1_008,
                        reason: "forbidden for observer"
                    ))
                    throw AttachTransportError.closed
                }
                return
            }
            try? await processes.write(data, toPTY: ptyID, mode: .controller)
        case .resize, .kill:
            // Deliberately inert in MOMO-655. `HostPTYProcess` exposes no
            // winsize or attach-side kill today, and faking an ack for either
            // would be worse than ignoring it: the observer surface already
            // documents the fixed 80-column host width (HOST_COLUMNS), and kill
            // has a real, audited path through the work_control ledger.
            return
        case .unsupported:
            return
        }
    }

    // MARK: - socket setup

    private static func listen(address: String, port: UInt16) throws -> Int32 {
        let descriptor = socket(AF_INET, sockStreamType, 0)
        guard descriptor >= 0 else { throw WorkdFailure.configuration }
        var enable: Int32 = 1
        setsockopt(
            descriptor, SOL_SOCKET, SO_REUSEADDR,
            &enable, socklen_t(MemoryLayout<Int32>.size)
        )
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        guard inet_pton(AF_INET, address, &addr.sin_addr) == 1 else {
            _ = systemCloseDescriptor(descriptor)
            throw WorkdFailure.configuration
        }
        let bound = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Glibc_listen(descriptor, 64) == 0 else {
            _ = systemCloseDescriptor(descriptor)
            throw WorkdFailure.configuration
        }
        setNonBlocking(descriptor)
        return descriptor
    }

    private static func prepare(_ descriptor: Int32) {
        setNonBlocking(descriptor)
        var enable: Int32 = 1
        setsockopt(
            descriptor, Int32(IPPROTO_TCP), TCP_NODELAY,
            &enable, socklen_t(MemoryLayout<Int32>.size)
        )
        #if canImport(Darwin)
        // Without this a write to a socket the peer already closed raises
        // SIGPIPE and takes the whole daemon with it.
        setsockopt(
            descriptor, SOL_SOCKET, SO_NOSIGPIPE,
            &enable, socklen_t(MemoryLayout<Int32>.size)
        )
        #endif
    }

    private static func setNonBlocking(_ descriptor: Int32) {
        let flags = fcntl(descriptor, F_GETFL, 0)
        guard flags >= 0 else { return }
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    }
}

private actor ConnectionCounter {
    private var live = 0

    func acquire(limit: Int) -> Bool {
        guard live < limit else { return false }
        live += 1
        return true
    }

    func release() {
        live = max(0, live - 1)
    }
}

// SOCK_STREAM is an enum on Linux and an Int32 on Darwin; `listen` also collides
// with the method name above. Both are normalized here rather than at each use.
private var sockStreamType: Int32 {
    #if canImport(Darwin)
    return SOCK_STREAM
    #else
    return Int32(SOCK_STREAM.rawValue)
    #endif
}

private func Glibc_listen(_ descriptor: Int32, _ backlog: Int32) -> Int32 {
    #if canImport(Darwin)
    return Darwin.listen(descriptor, backlog)
    #else
    return Glibc.listen(descriptor, backlog)
    #endif
}

func systemCloseDescriptor(_ descriptor: Int32) -> Int32 {
    #if canImport(Darwin)
    return Darwin.close(descriptor)
    #else
    return Glibc.close(descriptor)
    #endif
}
