import Foundation
import MomoCore
import Observation

public protocol IOSConversationBackend: Sendable {
    func snapshot() async throws -> IOSConversationSnapshot
    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message]
    func markRead(channel: ChannelID, through sequence: Int64) async throws
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent>
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus>
}

@MainActor
@Observable
public final class IOSChannelListModel {
    public struct Failure: Equatable {
        public let message: String
        public let isOffline: Bool
    }

    public enum Phase: Equatable {
        case loading
        case loaded
        case failed(Failure)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var sections = IOSChannelSections(channels: [], directMessages: [])
    public private(set) var membersByID: [MemberID: Member] = [:]

    private let currentMemberID: MemberID
    private let backend: any IOSConversationBackend

    public init(currentMemberID: MemberID, backend: any IOSConversationBackend) {
        self.currentMemberID = currentMemberID
        self.backend = backend
    }

    public func load() async {
        phase = .loading
        await refresh()
    }

    public func refresh() async {
        do {
            let snapshot = try await backend.snapshot()
            sections = IOSChannelListMapper.sections(
                channels: snapshot.channels,
                members: snapshot.members,
                readStates: snapshot.readStates,
                currentMemberID: currentMemberID
            )
            membersByID = Dictionary(uniqueKeysWithValues: snapshot.members.map { ($0.id, $0) })
            phase = .loaded
        } catch is CancellationError {
            return
        } catch {
            phase = .failed(Self.failure(for: error))
        }
    }

    private static func failure(for error: Error) -> Failure {
        if let sessionError = error as? SessionError,
           case .transport = sessionError {
            return Failure(
                message: "Could not refresh channels while offline. Check your connection and try again.",
                isOffline: true
            )
        }
        return Failure(message: "Could not refresh channels. Try again.", isOffline: false)
    }
}

@MainActor
@Observable
public final class IOSTimelineModel {
    public struct Failure: Equatable {
        public let message: String
        public let isOffline: Bool
    }

    public enum Phase: Equatable {
        case loading
        case loaded
        case failed(Failure)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var messages: [Message] = []
    public private(set) var realtimeStatus: RealtimeConnectionStatus

    private let channel: ChannelID
    private let backend: any IOSConversationBackend
    private var eventTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?

    public init(channel: ChannelID, backend: any IOSConversationBackend) {
        self.channel = channel
        self.backend = backend
        self.realtimeStatus = .idle(channel: channel)
    }

    public func stop() {
        eventTask?.cancel()
        statusTask?.cancel()
        eventTask = nil
        statusTask = nil
    }

    public func load() async {
        phase = .loading
        do {
            let history = try await backend.history(channel: channel, after: nil, limit: 200)
            messages = IOSTimelineReducer.sorted(history)
            phase = .loaded
            if let sequence = messages.compactMap(\.seq).max() {
                try? await backend.markRead(channel: channel, through: sequence)
            }
            subscribe()
        } catch is CancellationError {
            return
        } catch {
            let isOffline = (error as? SessionError).map {
                if case .transport = $0 { return true }
                return false
            } ?? false
            phase = .failed(Failure(
                message: isOffline
                    ? "Message history is unavailable while offline. Check your connection and try again."
                    : "Could not load message history. Try again.",
                isOffline: isOffline
            ))
        }
    }

    public func retry() async {
        eventTask?.cancel()
        statusTask?.cancel()
        await load()
    }

    private func subscribe() {
        eventTask?.cancel()
        statusTask?.cancel()
        let backend = backend
        let channel = channel
        statusTask = Task { [weak self] in
            let statuses = await backend.realtimeStatus(channel: channel)
            for await status in statuses {
                guard !Task.isCancelled else { return }
                self?.realtimeStatus = status
            }
        }
        eventTask = Task { [weak self] in
            do {
                let events = try await backend.subscribe(channel: channel)
                for await event in events {
                    guard !Task.isCancelled, let self else { return }
                    messages = IOSTimelineReducer.applying(event, to: messages, channel: channel)
                }
            } catch is CancellationError {
                return
            } catch {
                self?.realtimeStatus = .restFallback(
                    channel: channel,
                    message: "Realtime updates are unavailable. Pull to reload message history."
                )
            }
        }
    }
}
