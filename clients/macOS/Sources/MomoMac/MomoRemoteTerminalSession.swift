import AppKit
import Foundation
import MomoCore
import SwiftTerm
import SwiftUI

struct MomoTerminalAttachGrant: Sendable, Equatable {
    let endpoint: URL
    let capabilityToken: String
    let ptyId: String

    init(endpoint: URL, capabilityToken: String, ptyId: String) throws {
        guard let components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              ["ws", "wss", "http", "https"].contains(components.scheme?.lowercased() ?? ""),
              !capabilityToken.isEmpty,
              MomoTerminalAttachFrame.isValidPTYID(ptyId)
        else { throw MomoRemoteTerminalError.invalidGrant }
        self.endpoint = endpoint
        self.capabilityToken = capabilityToken
        self.ptyId = ptyId
    }

    var webSocketEndpoint: URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            return nil
        }
        if components.scheme == "https" { components.scheme = "wss" }
        if components.scheme == "http" { components.scheme = "ws" }
        return components.url
    }
}

enum MomoTerminalAttachFrame {
    static func connect(ptyId: String) throws -> String {
        try encode(["type": "connect", "pty_id": ptyId])
    }

    static func sendStdin(ptyId: String, data: Data) throws -> String {
        try encode([
            "type": "send_stdin",
            "pty_id": ptyId,
            "data": data.base64EncodedString(),
        ])
    }

    static func resize(ptyId: String, columns: Int, rows: Int) throws -> String {
        guard columns > 0, rows > 0 else { throw MomoRemoteTerminalError.invalidFrame }
        return try encode([
            "type": "resize",
            "pty_id": ptyId,
            "cols": columns,
            "rows": rows,
        ])
    }

    static func kill(ptyId: String) throws -> String {
        try encode(["type": "kill", "pty_id": ptyId])
    }

    static func isValidPTYID(_ value: String) -> Bool {
        guard (1...128).contains(value.utf8.count),
              value.first?.isLetter == true || value.first?.isNumber == true
        else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber || "._:-".contains($0) }
    }

    private static func encode(_ object: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw MomoRemoteTerminalError.invalidFrame
        }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let value = String(data: data, encoding: .utf8) else {
            throw MomoRemoteTerminalError.invalidFrame
        }
        return value
    }
}

enum MomoRemoteTerminalError: Error, Equatable, Sendable {
    case invalidGrant
    case invalidFrame
    case grantExpired
    case forbidden
    case revokedOrUnavailable
    case rateLimited
    case networkDisconnected
}

protocol MomoRemoteTerminalTransport: Sendable {
    func connect(grant: MomoTerminalAttachGrant) async throws -> AsyncThrowingStream<Data, Error>
    func sendInput(_ data: Data, ptyId: String) async throws
    func resize(columns: Int, rows: Int, ptyId: String) async throws
    func kill(ptyId: String) async throws
    func close() async
}

actor MomoURLSessionRemoteTerminalTransport: MomoRemoteTerminalTransport {
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?

    init(session: URLSession = .shared) {
        self.session = session
    }

    func connect(grant: MomoTerminalAttachGrant) async throws -> AsyncThrowingStream<Data, Error> {
        guard socket == nil, let endpoint = grant.webSocketEndpoint else {
            throw MomoRemoteTerminalError.invalidGrant
        }
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData)
        request.timeoutInterval = 15
        request.setValue("Bearer \(grant.capabilityToken)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        socket = task
        task.resume()
        try await task.send(.string(try MomoTerminalAttachFrame.connect(ptyId: grant.ptyId)))

        return AsyncThrowingStream { continuation in
            let receiveTask = Task { [weak self] in
                guard let self else { return }
                do {
                    while !Task.isCancelled {
                        let message = try await task.receive()
                        switch message {
                        case .data(let data):
                            continuation.yield(data)
                        case .string(let text):
                            continuation.yield(Data(text.utf8))
                        @unknown default:
                            throw MomoRemoteTerminalError.networkDisconnected
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.classify(task: task, error: error))
                }
                await self.clear(task)
            }
            continuation.onTermination = { _ in receiveTask.cancel() }
        }
    }

    func sendInput(_ data: Data, ptyId: String) async throws {
        try await send(try MomoTerminalAttachFrame.sendStdin(ptyId: ptyId, data: data))
    }

    func resize(columns: Int, rows: Int, ptyId: String) async throws {
        try await send(try MomoTerminalAttachFrame.resize(ptyId: ptyId, columns: columns, rows: rows))
    }

    func kill(ptyId: String) async throws {
        try await send(try MomoTerminalAttachFrame.kill(ptyId: ptyId))
    }

    func close() {
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
    }

    private func send(_ text: String) async throws {
        guard let socket else { throw MomoRemoteTerminalError.networkDisconnected }
        do {
            try await socket.send(.string(text))
        } catch {
            throw Self.classify(task: socket, error: error)
        }
    }

    private func clear(_ task: URLSessionWebSocketTask) {
        if socket === task { socket = nil }
    }

    private nonisolated static func classify(
        task: URLSessionWebSocketTask,
        error: Error
    ) -> MomoRemoteTerminalError {
        let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }?.lowercased() ?? ""
        if reason.contains("expired") { return .grantExpired }
        if reason.contains("revoked") { return .revokedOrUnavailable }
        return .networkDisconnected
    }
}

@MainActor
final class MomoRemoteTerminalSession: ObservableObject, Identifiable {
    enum State: Equatable {
        case idle
        case issuingGrant
        case connecting
        case connected
        case failed(MomoRemoteTerminalError)
        case ended
    }

    let id = UUID()
    let terminalView: TerminalView
    @Published private(set) var state: State = .idle
    @Published private(set) var receivedByteCount = 0

    private let grantProvider: @MainActor @Sendable () async throws -> MomoTerminalAttachGrant
    private let transport: any MomoRemoteTerminalTransport
    private var ptyId: String?
    private var receiveTask: Task<Void, Never>?
    private var terminalBridge: TerminalBridge!

    init(
        grantProvider: @escaping @MainActor @Sendable () async throws -> MomoTerminalAttachGrant,
        transport: any MomoRemoteTerminalTransport = MomoURLSessionRemoteTerminalTransport()
    ) {
        self.grantProvider = grantProvider
        self.transport = transport
        terminalView = TerminalView(frame: .zero)
        terminalBridge = TerminalBridge(
            onInput: { [weak self] data in self?.sendInput(data) },
            onResize: { [weak self] columns, rows in self?.resize(columns: columns, rows: rows) }
        )
        terminalView.terminalDelegate = terminalBridge
        terminalView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        terminalView.optionAsMetaKey = true
        terminalView.changeScrollback(MomoTheme.WorkConsole.terminalScrollbackLines)
        applyTheme(.defaultPreset)
    }

    var isConnected: Bool { state == .connected }
    var isReadOnly: Bool { state == .ended }

    func start() async {
        guard state != .issuingGrant, state != .connecting, state != .connected else { return }
        receiveTask?.cancel()
        await transport.close()
        ptyId = nil
        state = .issuingGrant
        do {
            let grant = try await grantProvider()
            state = .connecting
            let output = try await transport.connect(grant: grant)
            ptyId = grant.ptyId
            state = .connected
            receiveTask = Task { [weak self] in
                guard let self else { return }
                do {
                    for try await data in output {
                        self.receivedByteCount += data.count
                        self.terminalView.feed(byteArray: [UInt8](data)[...])
                    }
                    if self.state == .connected { self.state = .failed(.networkDisconnected) }
                } catch {
                    if self.state == .connected { self.state = .failed(Self.map(error)) }
                }
            }
        } catch is CancellationError {
            return
        } catch {
            state = .failed(Self.map(error))
            await transport.close()
        }
    }

    func retry() async {
        await start()
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        ptyId = nil
        if state != .ended { state = .idle }
        Task { await transport.close() }
    }

    func terminate() {
        receiveTask?.cancel()
        receiveTask = nil
        let activePTY = ptyId
        ptyId = nil
        state = .ended
        Task {
            if let activePTY { try? await transport.kill(ptyId: activePTY) }
            await transport.close()
        }
    }

    func markEnded() {
        receiveTask?.cancel()
        receiveTask = nil
        ptyId = nil
        state = .ended
        Task { await transport.close() }
    }

    func focus() {
        terminalView.window?.makeFirstResponder(terminalView)
    }

    func applyTheme(_ preset: MomoTerminalThemePreset) {
        preset.theme.apply(to: terminalView)
    }

    func tail(lineCount: Int) -> String {
        let boundedCount = max(1, min(lineCount, 9_999))
        let data = terminalView.terminal.getBufferAsData(kind: .active)
        guard let text = String(data: data, encoding: .utf8) else { return "" }
        return text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .suffix(boundedCount)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func sendInput(_ data: Data) {
        guard state == .connected, let ptyId else { return }
        Task { [weak self] in
            do {
                try await self?.transport.sendInput(data, ptyId: ptyId)
            } catch {
                self?.state = .failed(Self.map(error))
            }
        }
    }

    private func resize(columns: Int, rows: Int) {
        guard state == .connected, let ptyId else { return }
        Task { [weak self] in
            do {
                try await self?.transport.resize(columns: columns, rows: rows, ptyId: ptyId)
            } catch {
                self?.state = .failed(Self.map(error))
            }
        }
    }

    private static func map(_ error: Error) -> MomoRemoteTerminalError {
        if let error = error as? MomoRemoteTerminalError { return error }
        if let error = error as? BackendError {
            return switch error {
            case .problem(status: 403, title: _, detail: _): .forbidden
            case .problem(status: 409, title: _, detail: _): .revokedOrUnavailable
            case .problem(status: 429, title: _, detail: _): .rateLimited
            case .timedOut: .grantExpired
            default: .networkDisconnected
            }
        }
        return .networkDisconnected
    }

    private final class TerminalBridge: NSObject, TerminalViewDelegate, @unchecked Sendable {
        private let onInput: @MainActor (Data) -> Void
        private let onResize: @MainActor (Int, Int) -> Void

        init(
            onInput: @escaping @MainActor (Data) -> Void,
            onResize: @escaping @MainActor (Int, Int) -> Void
        ) {
            self.onInput = onInput
            self.onResize = onResize
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let payload = Data(data)
            Task { @MainActor [onInput] in onInput(payload) }
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            Task { @MainActor [onResize] in onResize(newCols, newRows) }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

@MainActor
struct MomoRemoteSwiftTermView: NSViewRepresentable {
    @ObservedObject var session: MomoRemoteTerminalSession
    let theme: MomoTerminalThemePreset

    func makeNSView(context: Context) -> TerminalView {
        session.applyTheme(theme)
        Task { @MainActor [weak session] in
            await Task.yield()
            session?.focus()
        }
        return session.terminalView
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {
        session.applyTheme(theme)
    }
}
