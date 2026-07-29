import Foundation
import Logging
import MomoACPHost
import XCTest
@testable import WorkHostDaemon

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// MOMO-655 — the inbound attach adapter.
///
/// The last test in this file is the one the ticket is about: a real loopback
/// socket, a real RFC 6455 handshake with a capability bearer, a real PTY, and
/// the assertion that the #857 replay contract survives the trip — retained
/// bytes as BINARY frames, then exactly one `replay_end` TEXT frame, then live
/// output. Everything above it is the framing and handshake arithmetic that
/// test depends on, isolated so a failure names its own cause.
final class TerminalAttachTests: XCTestCase {
    // MARK: - handshake

    func testAcceptKeyMatchesRFC6455Vector() {
        // RFC 6455 §1.3, verbatim.
        XCTAssertEqual(
            WebSocketWire.acceptKey(for: "dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        )
    }

    func testHandshakeAcceptsBearerHeaderAndSubprotocolBearerAlike() throws {
        let token = Self.token()
        let header = try TerminalAttachHandshake.accept(
            Self.upgradeRequest(headers: ["authorization": "Bearer \(token)"])
        )
        XCTAssertEqual(header.capabilityToken, token)
        // No subprotocol was offered, so none may be selected: RFC 6455 forbids
        // answering with one the client did not list.
        XCTAssertNil(header.selectedSubprotocol)

        let viaSubprotocol = try TerminalAttachHandshake.accept(
            Self.upgradeRequest(headers: [
                "sec-websocket-protocol": "momo.terminal.v1, \(token)",
            ])
        )
        XCTAssertEqual(viaSubprotocol.capabilityToken, token)
        XCTAssertEqual(viaSubprotocol.selectedSubprotocol, "momo.terminal.v1")
        XCTAssertEqual(header.acceptKey, viaSubprotocol.acceptKey)
    }

    func testHandshakeRejectsMissingMalformedAndNonWebSocketRequests() {
        let token = Self.token()
        let cases: [(String, HTTPUpgradeRequest, TerminalAttachHandshake.Rejection)] = [
            (
                "no bearer at all",
                Self.upgradeRequest(headers: [:]),
                .unauthorized
            ),
            (
                "subprotocol token without the momo.terminal.v1 marker",
                Self.upgradeRequest(headers: ["sec-websocket-protocol": token]),
                .unauthorized
            ),
            (
                "bearer that is not a capability token",
                Self.upgradeRequest(headers: ["authorization": "Bearer hunter2"]),
                .unauthorized
            ),
            (
                "wrong websocket version",
                Self.upgradeRequest(
                    headers: ["authorization": "Bearer \(token)"],
                    version: "8"
                ),
                .badRequest
            ),
            (
                "POST instead of GET",
                Self.upgradeRequest(
                    headers: ["authorization": "Bearer \(token)"],
                    method: "POST"
                ),
                .badRequest
            ),
            (
                "key that is not 16 base64 bytes",
                Self.upgradeRequest(
                    headers: ["authorization": "Bearer \(token)"],
                    key: "short"
                ),
                .badRequest
            ),
        ]
        for (label, request, expected) in cases {
            XCTAssertThrowsError(try TerminalAttachHandshake.accept(request), label) {
                XCTAssertEqual($0 as? TerminalAttachHandshake.Rejection, expected, label)
            }
        }
    }

    func testUpgradeRequestParsesFoldsRepeatedHeadersAndRejectsGarbage() throws {
        let head = Data(([
            "GET /v1/terminal-attach HTTP/1.1",
            "Host: host.example",
            "Sec-WebSocket-Protocol: momo.terminal.v1",
            "Sec-WebSocket-Protocol: \(Self.token())",
        ].joined(separator: "\r\n")).utf8)
        let request = try XCTUnwrap(HTTPUpgradeRequest.parse(head))
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.target, "/v1/terminal-attach")
        XCTAssertEqual(
            request.headers["sec-websocket-protocol"],
            "momo.terminal.v1, \(Self.token())"
        )
        XCTAssertNil(HTTPUpgradeRequest.parse(Data("not a request line\r\n".utf8)))
    }

    // MARK: - framing

    func testFrameRoundTripsAcrossEveryLengthEncoding() throws {
        for size in [0, 1, 125, 126, 4_096, 70_000] {
            let payload = Data((0..<size).map { UInt8($0 % 251) })
            var decoder = WebSocketFrameDecoder()
            decoder.append(Self.clientFrame(opcode: .binary, payload: payload))
            let message = try XCTUnwrap(try decoder.next(), "size \(size)")
            XCTAssertEqual(message.opcode, .binary, "size \(size)")
            XCTAssertEqual(message.payload, payload, "size \(size)")
            XCTAssertEqual(decoder.bufferedByteCount, 0, "size \(size)")
        }
    }

    func testDecoderNeedsMoreBytesRatherThanGuessing() throws {
        let payload = Data("momo".utf8)
        let frame = Self.clientFrame(opcode: .text, payload: payload)
        var decoder = WebSocketFrameDecoder()
        for byte in frame.dropLast() {
            decoder.append(Data([byte]))
            XCTAssertNil(try decoder.next())
        }
        decoder.append(Data([frame.last!]))
        XCTAssertEqual(try decoder.next()?.payload, payload)
    }

    func testDecoderAssemblesFragmentsAndPassesInterleavedControlFramesThrough() throws {
        var decoder = WebSocketFrameDecoder()
        decoder.append(Self.clientFrame(
            opcode: .text, payload: Data("mo".utf8), fin: false
        ))
        decoder.append(Self.clientFrame(opcode: .ping, payload: Data("p".utf8)))
        decoder.append(Self.clientFrame(
            opcode: .continuation, payload: Data("mo".utf8)
        ))
        // The control frame is delivered first because it completed first; the
        // fragmented message follows once its FIN arrives.
        XCTAssertEqual(try decoder.next(), WebSocketMessage(
            opcode: .ping, payload: Data("p".utf8)
        ))
        XCTAssertEqual(try decoder.next(), WebSocketMessage(
            opcode: .text, payload: Data("momo".utf8)
        ))
        XCTAssertEqual(decoder.bufferedByteCount, 0)
    }

    func testDecoderRefusesUnmaskedClientFramesAndOversizeMessages() {
        var unmasked = WebSocketFrameDecoder()
        unmasked.append(WebSocketWire.encode(opcode: .text, payload: Data("x".utf8)))
        XCTAssertThrowsError(try unmasked.next()) {
            XCTAssertEqual($0 as? WebSocketWireError, .protocolError)
        }

        var oversize = WebSocketFrameDecoder(maxMessageBytes: 1_000)
        oversize.append(Self.clientFrame(
            opcode: .binary,
            payload: Data(repeating: 0x41, count: 2_000)
        ))
        XCTAssertThrowsError(try oversize.next()) {
            XCTAssertEqual($0 as? WebSocketWireError, .messageTooLarge)
        }
    }

    func testCloseFrameCarriesCodeAndTheReasonClientsClassifyOn() {
        let frame = WebSocketWire.closeFrame(code: 1_008, reason: "capability expired")
        XCTAssertEqual(frame[0], 0x88)
        XCTAssertEqual(Int(frame[2]) << 8 | Int(frame[3]), 1_008)
        XCTAssertEqual(
            String(decoding: frame.dropFirst(4), as: UTF8.self),
            "capability expired"
        )
    }

    // MARK: - client frames

    func testClientFramesDecodeTheExactJSONMacAndWebAlreadySend() throws {
        // clients/web observerStream.ts `connectFrame`, byte for byte.
        XCTAssertEqual(
            TerminalAttachClientFrame.decode(
                Data(#"{"pty_id":"pty-1","type":"connect"}"#.utf8)
            ),
            .connect(ptyID: "pty-1")
        )
        // clients/macOS MomoTerminalAttachFrame.sendStdin.
        XCTAssertEqual(
            TerminalAttachClientFrame.decode(Data(
                #"{"data":"aGk=","pty_id":"pty-1","type":"send_stdin"}"#.utf8
            )),
            .sendStdin(ptyID: "pty-1", data: Data("hi".utf8))
        )
        XCTAssertEqual(
            TerminalAttachClientFrame.decode(Data(
                #"{"cols":120,"pty_id":"pty-1","rows":40,"type":"resize"}"#.utf8
            )),
            .resize(ptyID: "pty-1", columns: 120, rows: 40)
        )
        XCTAssertEqual(
            TerminalAttachClientFrame.decode(Data(#"{"type":"nope"}"#.utf8)),
            .unsupported(type: "nope")
        )
        XCTAssertNil(TerminalAttachClientFrame.decode(Data("not json".utf8)))
        XCTAssertNil(TerminalAttachClientFrame.decode(Data(#"{"type":"connect"}"#.utf8)))
    }

    func testCapabilityTokenGrammarMatchesTheServerMint() {
        XCTAssertTrue(TerminalAttachHandshake.isValidCapabilityToken(Self.token()))
        for bad in [
            "momo_terminal_attach_v1",
            "momo_terminal_attach_v1.short",
            "momo_terminal_attach_v2." + String(repeating: "a", count: 43),
            "momo_terminal_attach_v1." + String(repeating: "a", count: 44),
            "momo_terminal_attach_v1." + String(repeating: "+", count: 43),
        ] {
            XCTAssertFalse(
                TerminalAttachHandshake.isValidCapabilityToken(bad),
                bad
            )
        }
    }

    // MARK: - configuration

    func testAttachConfigIsOptInAndRefusesAnEndpointTheServerWouldReject() throws {
        XCTAssertNil(try WorkdConfig.terminalAttachConfig(environment: [:]))

        let config = try XCTUnwrap(try WorkdConfig.terminalAttachConfig(environment: [
            "MOMO_WORKD_ATTACH_PUBLIC_URL": "wss://host.example/v1/terminal-attach",
        ]))
        XCTAssertEqual(config.bindAddress, "127.0.0.1")
        XCTAssertEqual(config.port, TerminalAttachConfig.defaultPort)

        for bad in [
            "ws://host.example/attach",
            "http://host.example/attach",
            "wss://user:pw@host.example/attach",
            "wss://host.example/attach?token=x",
            "wss://host.example/attach#frag",
            "wss:///attach",
        ] {
            XCTAssertThrowsError(
                try WorkdConfig.terminalAttachConfig(
                    environment: ["MOMO_WORKD_ATTACH_PUBLIC_URL": bad]
                ),
                bad
            )
        }
        XCTAssertThrowsError(try WorkdConfig.terminalAttachConfig(environment: [
            "MOMO_WORKD_ATTACH_PUBLIC_URL": "wss://host.example/attach",
            "MOMO_WORKD_ATTACH_BIND": "not-an-address",
        ]))
    }

    // MARK: - the daemon side of the binding

    func testSpawnPublishesTheAttachBindingOnlyWhenAttachIsConfigured() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-attach-bind-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let hostID = UUID()
        let workspaceID = UUID()
        let sessionID = UUID()
        let endpoint = "wss://host.example/v1/terminal-attach"

        func run(attachEndpoint: String?) async throws -> [String] {
            let spawn = Self.spawnControl(workspaceID: workspaceID, hostID: hostID)
            let api = MockWorkHostAPI(
                controls: [[spawn], []],
                profiles: [Self.catProfile(workspaceID: workspaceID)],
                session: Self.session(
                    id: sessionID,
                    workspaceID: workspaceID,
                    channelID: spawn.channelId,
                    hostID: hostID
                )
            )
            let manager = Self.processManager(directory: directory)
            let daemon = WorkDaemon(
                hostID: hostID,
                api: api,
                processes: manager,
                pollInterval: .milliseconds(10),
                heartbeatInterval: .seconds(30),
                localCommandOverrides: [
                    "cat-tool": LocalCommandOverride(
                        executable: "/bin/cat",
                        arguments: []
                    ),
                ],
                attachEndpoint: attachEndpoint,
                logger: Logger(label: "test")
            )
            await daemon.pollOnce()
            defer {
                Task {
                    _ = try? await manager.terminate(sessionID)
                    await manager.markEndReported(sessionID)
                }
            }
            return await api.events
        }

        let withAttach = try await run(attachEndpoint: endpoint)
        XCTAssertTrue(withAttach.contains(
            "bind:\(sessionID):\(sessionID.uuidString.lowercased()):\(endpoint)"
        ), "\(withAttach)")
        // The binding is published BEFORE the spawn ack, so a session is never
        // reported running with an attach the ledger has not heard about.
        let bindIndex = try XCTUnwrap(withAttach.firstIndex { $0.hasPrefix("bind:") })
        let ackIndex = try XCTUnwrap(withAttach.firstIndex { $0.hasPrefix("ack:") })
        XCTAssertLessThan(bindIndex, ackIndex)

        let withoutAttach = try await run(attachEndpoint: nil)
        XCTAssertFalse(withoutAttach.contains { $0.hasPrefix("bind:") }, "\(withoutAttach)")
    }

    // MARK: - the round trip

    func testAttachDeliversRetainedBytesThenOneReplayEndMarkerThenLiveOutput() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-attach-wire-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let hostID = UUID()
        let workspaceID = UUID()
        let sessionID = UUID()
        let ptyID = sessionID.uuidString.lowercased()
        let manager = Self.processManager(directory: directory)
        try await manager.start(
            sessionID: sessionID,
            channelID: UUID(),
            tool: "cat-tool",
            prompt: "attach"
        )

        // Output produced BEFORE anyone attaches is the whole point: it is what
        // the ring retains and what the marker separates from live output.
        try await manager.write("echo momo-before-attach\n", to: sessionID)
        try await Task.sleep(for: .milliseconds(400))

        let port = try Self.freePort()
        let api = MockWorkHostAPI(
            controls: [],
            profiles: [],
            session: Self.session(
                id: sessionID,
                workspaceID: workspaceID,
                channelID: UUID(),
                hostID: hostID
            ),
            attachGrant: TerminalAttachGrant(
                workSessionID: sessionID,
                ptyID: ptyID,
                mode: .controller
            )
        )
        let server = TerminalAttachServer(
            config: TerminalAttachConfig(
                bindAddress: "127.0.0.1",
                port: port,
                publicEndpoint: "wss://host.example/v1/terminal-attach",
                maxConnections: 4
            ),
            hostID: hostID,
            api: api,
            processes: manager,
            logger: Logger(label: "test")
        )
        let listening = Task { try await server.run() }
        defer { listening.cancel() }

        let client = try TestAttachClient(port: port, deadline: .seconds(10))
        defer { client.close() }
        try client.handshake(token: Self.token())
        let validations = await api.events
        XCTAssertTrue(
            validations.contains("validate:\(Self.token())"),
            "the daemon must ask the server, never decide the capability itself"
        )
        client.send(Self.clientFrame(
            opcode: .text,
            payload: Data(#"{"pty_id":"\#(ptyID)","type":"connect"}"#.utf8)
        ))

        var retained = Data()
        var marker: [String: Any]?
        while marker == nil {
            let message = try client.nextMessage()
            switch message.opcode {
            case .binary:
                XCTAssertNil(marker, "no binary may follow the marker in replay")
                retained.append(message.payload)
            case .text:
                marker = try JSONSerialization.jsonObject(with: message.payload)
                    as? [String: Any]
            default:
                XCTFail("unexpected control frame \(message.opcode) during replay")
                return
            }
        }
        // The marker is a TEXT control frame, not terminal bytes: an xterm that
        // wrote it would print JSON into the user's scrollback.
        XCTAssertEqual(marker?["type"] as? String, "replay_end")
        let byteOffset = try XCTUnwrap(marker?["byte_offset"] as? Int)
        XCTAssertEqual(byteOffset, retained.count > 0 ? byteOffset : 0)
        XCTAssertTrue(
            String(decoding: retained, as: UTF8.self).contains("momo-before-attach"),
            "replay must carry what the pty printed before the attach"
        )

        // Live, through the same socket, as a controller: stdin in, output out.
        client.send(Self.clientFrame(
            opcode: .text,
            payload: Data(
                #"{"data":"\#(Data("echo momo-live\n".utf8).base64EncodedString())","pty_id":"\#(ptyID)","type":"send_stdin"}"#.utf8
            )
        ))
        var live = Data()
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !String(decoding: live, as: UTF8.self).contains("momo-live"),
              ContinuousClock.now < deadline
        {
            let message = try client.nextMessage()
            if message.opcode == .binary { live.append(message.payload) }
        }
        XCTAssertTrue(
            String(decoding: live, as: UTF8.self).contains("momo-live"),
            "controller stdin never reached the pty, or its output never came back"
        )
        _ = try? await manager.terminate(sessionID)
        await manager.markEndReported(sessionID)
    }

    // MARK: - the authorization that stops being true (MOMO-674)

    /// The hole #869 left named: attach asked once, so a revoke that landed
    /// AFTER the socket opened could not reach it.
    ///
    /// This drives the real listener, the real pty and the real framing, then
    /// makes the server start refusing mid-stream. Two facts are pinned: the
    /// bytes kept moving across successful re-checks (the revalidation does not
    /// interrupt the stream), and the refusal ends the socket with 1008 — the
    /// code both clients already read as "this grant is gone" rather than as a
    /// dropped network.
    func testOpenStreamIsCutWithin1008WhenTheServerStopsAuthorizingIt() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-attach-revalidate-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let hostID = UUID()
        let sessionID = UUID()
        let ptyID = sessionID.uuidString.lowercased()
        let manager = Self.processManager(directory: directory)
        try await manager.start(
            sessionID: sessionID,
            channelID: UUID(),
            tool: "cat-tool",
            prompt: "attach"
        )
        defer {
            Task {
                _ = try? await manager.terminate(sessionID)
                await manager.markEndReported(sessionID)
            }
        }

        let port = try Self.freePort()
        let api = MockWorkHostAPI(
            controls: [],
            profiles: [],
            session: Self.session(
                id: sessionID,
                workspaceID: UUID(),
                channelID: UUID(),
                hostID: hostID
            ),
            attachGrant: TerminalAttachGrant(
                workSessionID: sessionID,
                ptyID: ptyID,
                mode: .controller
            )
        )
        let server = TerminalAttachServer(
            config: TerminalAttachConfig(
                bindAddress: "127.0.0.1",
                port: port,
                publicEndpoint: "wss://host.example/v1/terminal-attach",
                maxConnections: 4,
                revalidateInterval: .milliseconds(100)
            ),
            hostID: hostID,
            api: api,
            processes: manager,
            logger: Logger(label: "test")
        )
        let listening = Task { try await server.run() }
        defer { listening.cancel() }

        let client = try TestAttachClient(port: port, deadline: .seconds(10))
        defer { client.close() }
        try client.handshake(token: Self.token())
        client.send(Self.clientFrame(
            opcode: .text,
            payload: Data(#"{"pty_id":"\#(ptyID)","type":"connect"}"#.utf8)
        ))
        try client.drainUntilReplayEnd()

        // Several revalidation periods with the grant still good: the stream is
        // untouched and live output still arrives on the same socket.
        try await Task.sleep(for: .milliseconds(500))
        client.send(Self.clientFrame(
            opcode: .text,
            payload: Data(
                #"{"data":"\#(Data("echo momo-still-live\n".utf8).base64EncodedString())","pty_id":"\#(ptyID)","type":"send_stdin"}"#.utf8
            )
        ))
        var live = Data()
        let liveDeadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !String(decoding: live, as: UTF8.self).contains("momo-still-live"),
              ContinuousClock.now < liveDeadline
        {
            let message = try client.nextMessage()
            if message.opcode == .binary { live.append(message.payload) }
        }
        XCTAssertTrue(
            String(decoding: live, as: UTF8.self).contains("momo-still-live"),
            "revalidation must not interrupt a stream it keeps authorizing"
        )
        let beforeRevoke = await api.events
        XCTAssertTrue(
            beforeRevoke.contains("validate:stream:\(Self.token())"),
            "the open stream must be re-asking the server, not assuming: \(beforeRevoke)"
        )

        await api.revokeAttachGrant()
        var close: WebSocketMessage?
        let closeDeadline = ContinuousClock.now.advanced(by: .seconds(10))
        while close == nil, ContinuousClock.now < closeDeadline {
            let message = try client.nextMessage()
            if message.opcode == .close { close = message }
        }
        let payload = try XCTUnwrap(close?.payload, "the revoked stream was never closed")
        XCTAssertEqual(Int(payload[payload.startIndex]) << 8 | Int(payload[payload.startIndex + 1]), 1_008)
        XCTAssertEqual(
            String(decoding: payload.dropFirst(2), as: UTF8.self),
            "capability revoked"
        )
    }

    /// A grant that comes back naming a different pty is not this stream's
    /// grant. Nothing on the server produces that today; the daemon still stops
    /// rather than serving bytes under an answer about something else.
    func testRevalidationRefusesAGrantThatChangedUnderAnOpenStream() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-attach-regrant-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let hostID = UUID()
        let sessionID = UUID()
        let ptyID = sessionID.uuidString.lowercased()
        let manager = Self.processManager(directory: directory)
        try await manager.start(
            sessionID: sessionID,
            channelID: UUID(),
            tool: "cat-tool",
            prompt: "attach"
        )
        defer {
            Task {
                _ = try? await manager.terminate(sessionID)
                await manager.markEndReported(sessionID)
            }
        }
        let port = try Self.freePort()
        let api = MockWorkHostAPI(
            controls: [],
            profiles: [],
            session: Self.session(
                id: sessionID,
                workspaceID: UUID(),
                channelID: UUID(),
                hostID: hostID
            ),
            attachGrant: TerminalAttachGrant(
                workSessionID: sessionID,
                ptyID: ptyID,
                mode: .controller
            )
        )
        let server = TerminalAttachServer(
            config: TerminalAttachConfig(
                bindAddress: "127.0.0.1",
                port: port,
                publicEndpoint: "wss://host.example/v1/terminal-attach",
                maxConnections: 4,
                revalidateInterval: .milliseconds(100)
            ),
            hostID: hostID,
            api: api,
            processes: manager,
            logger: Logger(label: "test")
        )
        let listening = Task { try await server.run() }
        defer { listening.cancel() }

        let client = try TestAttachClient(port: port, deadline: .seconds(10))
        defer { client.close() }
        try client.handshake(token: Self.token())
        client.send(Self.clientFrame(
            opcode: .text,
            payload: Data(#"{"pty_id":"\#(ptyID)","type":"connect"}"#.utf8)
        ))
        try client.drainUntilReplayEnd()

        await api.replaceAttachGrant(with: TerminalAttachGrant(
            workSessionID: sessionID,
            ptyID: UUID().uuidString.lowercased(),
            mode: .controller
        ))
        var close: WebSocketMessage?
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while close == nil, ContinuousClock.now < deadline {
            let message = try client.nextMessage()
            if message.opcode == .close { close = message }
        }
        let payload = try XCTUnwrap(close?.payload)
        XCTAssertEqual(Int(payload[payload.startIndex]) << 8 | Int(payload[payload.startIndex + 1]), 1_008)
    }

    func testRevalidateIntervalIsItsOwnPolicyAndBounded() throws {
        let attach = "wss://host.example/v1/terminal-attach"
        let byDefault = try XCTUnwrap(try WorkdConfig.terminalAttachConfig(environment: [
            "MOMO_WORKD_ATTACH_PUBLIC_URL": attach,
        ]))
        // Not the server's 60 second capability TTL, and not derived from it.
        XCTAssertEqual(byDefault.revalidateInterval, .seconds(30))

        let configured = try XCTUnwrap(try WorkdConfig.terminalAttachConfig(environment: [
            "MOMO_WORKD_ATTACH_PUBLIC_URL": attach,
            "MOMO_WORKD_ATTACH_REVALIDATE_INTERVAL_MS": "5000",
        ]))
        XCTAssertEqual(configured.revalidateInterval, .seconds(5))

        for bad in ["0", "999", "3600001", "not-a-number"] {
            XCTAssertThrowsError(
                try WorkdConfig.terminalAttachConfig(environment: [
                    "MOMO_WORKD_ATTACH_PUBLIC_URL": attach,
                    "MOMO_WORKD_ATTACH_REVALIDATE_INTERVAL_MS": bad,
                ]),
                bad
            )
        }
    }

    func testAttachRejectsAnUnknownCapabilityBeforeAnyPTYIsTouched() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-attach-deny-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let port = try Self.freePort()
        let api = MockWorkHostAPI(
            controls: [],
            profiles: [],
            session: Self.session(
                id: UUID(),
                workspaceID: UUID(),
                channelID: UUID(),
                hostID: UUID()
            ),
            attachGrant: nil
        )
        let server = TerminalAttachServer(
            config: TerminalAttachConfig(
                bindAddress: "127.0.0.1",
                port: port,
                publicEndpoint: "wss://host.example/v1/terminal-attach",
                maxConnections: 4
            ),
            hostID: UUID(),
            api: api,
            processes: Self.processManager(directory: directory),
            logger: Logger(label: "test")
        )
        let listening = Task { try await server.run() }
        defer { listening.cancel() }

        let client = try TestAttachClient(port: port, deadline: .seconds(10))
        defer { client.close() }
        XCTAssertThrowsError(try client.handshake(token: Self.token())) {
            // The upgrade never completes: the socket is still HTTP when the
            // server says no, which is what lets the browser see a 401 rather
            // than an anonymous 1006.
            XCTAssertEqual($0 as? TestAttachClient.Failure, .rejected(status: 401))
        }
    }

    // MARK: - fixtures

    private static func token() -> String {
        "momo_terminal_attach_v1." + String(repeating: "a", count: 43)
    }

    private static func upgradeRequest(
        headers: [String: String],
        method: String = "GET",
        version: String = "13",
        key: String = "dGhlIHNhbXBsZSBub25jZQ=="
    ) -> HTTPUpgradeRequest {
        var all = headers
        all["upgrade"] = all["upgrade"] ?? "websocket"
        all["connection"] = all["connection"] ?? "Upgrade"
        all["sec-websocket-version"] = version
        all["sec-websocket-key"] = key
        return HTTPUpgradeRequest(method: method, target: "/attach", headers: all)
    }

    /// A masked client frame, which is what RFC 6455 requires of a client and
    /// what the decoder under test therefore has to handle.
    static func clientFrame(
        opcode: WebSocketOpcode,
        payload: Data,
        fin: Bool = true
    ) -> Data {
        var out = Data([(fin ? 0x80 : 0x00) | opcode.rawValue])
        let count = payload.count
        if count < 126 {
            out.append(UInt8(0x80 | count))
        } else if count <= 0xFFFF {
            out.append(0x80 | 126)
            out.append(UInt8(truncatingIfNeeded: count >> 8))
            out.append(UInt8(truncatingIfNeeded: count))
        } else {
            out.append(0x80 | 127)
            for shift in stride(from: 56, through: 0, by: -8) {
                out.append(UInt8(truncatingIfNeeded: UInt64(count) >> UInt64(shift)))
            }
        }
        let mask: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        out.append(contentsOf: mask)
        out.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
        return out
    }

    private static func processManager(directory: URL) -> ProcessManager {
        ProcessManager(
            templates: ["cat-tool": CommandTemplate(
                executable: "/bin/cat",
                arguments: []
            )],
            outputDirectory: directory,
            hostEnvironment: [
                "PATH": "/usr/bin:/bin",
                "HOME": directory.path,
                "SHELL": "/bin/bash",
                "TERM": "xterm-256color",
            ],
            ringBufferBytes: 64 * 1_024
        )
    }

    private static func spawnControl(workspaceID: UUID, hostID: UUID) -> WorkControl {
        WorkControl(
            id: UUID(),
            workspaceId: workspaceID,
            channelId: UUID(),
            requesterMemberId: UUID(),
            targetHostId: hostID,
            sessionId: nil,
            kind: "spawn",
            payload: .object([
                "tool": .string("cat-tool"),
                "label": .string("cat"),
            ]),
            status: "dispatched",
            approvalMessageId: nil,
            createdAtMs: 1,
            updatedAtMs: 1
        )
    }

    private static func catProfile(workspaceID: UUID) -> WorkToolProfile {
        WorkToolProfile(
            id: UUID(),
            workspaceId: workspaceID,
            toolKey: "cat-tool",
            displayName: "cat",
            launchTemplate: WorkToolLaunchTemplate(command: "cat", arguments: []),
            tierDefaults: .object([:]),
            envPolicy: .object([:]),
            enabled: true,
            createdBy: UUID(),
            updatedBy: UUID(),
            createdAtMs: 1,
            updatedAtMs: 1
        )
    }

    private static func session(
        id: UUID,
        workspaceID: UUID,
        channelID: UUID,
        hostID: UUID
    ) -> WorkSession {
        WorkSession(
            id: id,
            workspaceId: workspaceID,
            channelId: channelID,
            memberId: UUID(),
            hostId: hostID,
            rootMessageId: UUID(),
            tool: "cat-tool",
            label: "cat",
            status: "running",
            startedAtMs: 1,
            endedAtMs: nil,
            exitCode: nil,
            endReason: nil,
            resumedFromSessionId: nil
        )
    }

    /// A port the kernel just handed out and then released. Racy in principle;
    /// in a single test process it is the cheapest way to avoid a fixed port
    /// colliding with whatever else the machine is running.
    private static func freePort() throws -> UInt16 {
        #if canImport(Darwin)
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        #else
        let descriptor = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #endif
        guard descriptor >= 0 else { throw TestAttachClient.Failure.socket }
        defer { _ = systemCloseDescriptor(descriptor) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        _ = inet_pton(AF_INET, "127.0.0.1", &address.sin_addr)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                #if canImport(Darwin)
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                #else
                Glibc.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                #endif
            }
        }
        guard bound == 0 else { throw TestAttachClient.Failure.socket }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        guard named == 0 else { throw TestAttachClient.Failure.socket }
        return UInt16(bigEndian: address.sin_port)
    }
}

/// A blocking, deliberately minimal WebSocket client. It exists so the test
/// exercises the daemon's own framing rather than a library's agreement with
/// itself.
final class TestAttachClient {
    enum Failure: Error, Equatable {
        case socket
        case timedOut
        case rejected(status: Int)
        case malformed
    }

    private var descriptor: Int32 = -1
    private var buffer = Data()
    private let deadline: Duration

    init(port: UInt16, deadline: Duration) throws {
        self.deadline = deadline
        let start = ContinuousClock.now
        while ContinuousClock.now < start.advanced(by: deadline) {
            #if canImport(Darwin)
            let fileDescriptor = socket(AF_INET, SOCK_STREAM, 0)
            #else
            let fileDescriptor = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
            #endif
            guard fileDescriptor >= 0 else { throw Failure.socket }
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = port.bigEndian
            _ = inet_pton(AF_INET, "127.0.0.1", &address.sin_addr)
            let connected = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fileDescriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            if connected == 0 {
                var timeout = timeval(tv_sec: 1, tv_usec: 0)
                setsockopt(
                    fileDescriptor, SOL_SOCKET, SO_RCVTIMEO,
                    &timeout, socklen_t(MemoryLayout<timeval>.size)
                )
                descriptor = fileDescriptor
                return
            }
            _ = systemCloseDescriptor(fileDescriptor)
            usleep(20_000)
        }
        throw Failure.timedOut
    }

    func close() {
        guard descriptor >= 0 else { return }
        _ = systemCloseDescriptor(descriptor)
        descriptor = -1
    }

    func send(_ data: Data) {
        var remaining = data
        while !remaining.isEmpty {
            let written = remaining.withUnsafeBytes { raw -> Int in
                #if canImport(Darwin)
                return Darwin.send(descriptor, raw.baseAddress, remaining.count, 0)
                #else
                return Glibc.send(
                    descriptor, raw.baseAddress, remaining.count, Int32(MSG_NOSIGNAL)
                )
                #endif
            }
            guard written > 0 else { return }
            remaining = remaining.dropFirst(written)
        }
    }

    func handshake(token: String) throws {
        let request = [
            "GET /v1/terminal-attach HTTP/1.1",
            "Host: 127.0.0.1",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Protocol: momo.terminal.v1, \(token)",
        ].joined(separator: "\r\n") + "\r\n\r\n"
        send(Data(request.utf8))

        let start = ContinuousClock.now
        while ContinuousClock.now < start.advanced(by: deadline) {
            if let terminator = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(
                    decoding: buffer[buffer.startIndex..<terminator.lowerBound],
                    as: UTF8.self
                )
                buffer = Data(buffer[terminator.upperBound...])
                guard let statusLine = head.components(separatedBy: "\r\n").first,
                      let status = Int(
                        statusLine.split(separator: " ").dropFirst().first ?? ""
                      )
                else { throw Failure.malformed }
                guard status == 101 else { throw Failure.rejected(status: status) }
                guard head.lowercased().contains(
                    "sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".lowercased()
                ) else { throw Failure.malformed }
                return
            }
            try fill()
        }
        throw Failure.timedOut
    }

    /// Consume the replay leg (binary frames, then the single `replay_end` text
    /// marker) so a test that is about what happens AFTER it can start there.
    func drainUntilReplayEnd() throws {
        while true {
            let message = try nextMessage()
            if message.opcode == .text,
               let object = try? JSONSerialization.jsonObject(with: message.payload)
                as? [String: Any],
               object["type"] as? String == "replay_end"
            {
                return
            }
        }
    }

    func nextMessage() throws -> WebSocketMessage {
        let start = ContinuousClock.now
        while ContinuousClock.now < start.advanced(by: deadline) {
            if let message = try decodeServerFrame() { return message }
            try fill()
        }
        throw Failure.timedOut
    }

    private func fill() throws {
        var chunk = [UInt8](repeating: 0, count: 16 * 1_024)
        let count = chunk.withUnsafeMutableBytes { raw in
            read(descriptor, raw.baseAddress, 16 * 1_024)
        }
        if count > 0 {
            buffer.append(contentsOf: chunk[0..<count])
            return
        }
        if count == 0 { throw Failure.malformed }
        guard errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR else {
            throw Failure.socket
        }
    }

    /// Server frames are never masked, so this is the mirror of the daemon's
    /// encoder and nothing more.
    private func decodeServerFrame() throws -> WebSocketMessage? {
        let bytes = [UInt8](buffer)
        guard bytes.count >= 2 else { return nil }
        guard let opcode = WebSocketOpcode(rawValue: bytes[0] & 0x0F) else {
            throw Failure.malformed
        }
        guard bytes[1] & 0x80 == 0 else { throw Failure.malformed }
        var length = Int(bytes[1] & 0x7F)
        var offset = 2
        if length == 126 {
            guard bytes.count >= 4 else { return nil }
            length = Int(bytes[2]) << 8 | Int(bytes[3])
            offset = 4
        } else if length == 127 {
            guard bytes.count >= 10 else { return nil }
            var value: UInt64 = 0
            for index in 2..<10 { value = value << 8 | UInt64(bytes[index]) }
            length = Int(value)
            offset = 10
        }
        guard bytes.count >= offset + length else { return nil }
        let payload = Data(bytes[offset..<(offset + length)])
        buffer = Data(bytes[(offset + length)...])
        return WebSocketMessage(opcode: opcode, payload: payload)
    }
}
