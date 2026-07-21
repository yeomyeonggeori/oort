import Foundation
import MomoCore
import Observation

public enum IOSWorkSessionStatus: String, Codable, Sendable, Hashable {
    case running
    case orphaned
    case ended
}

public enum IOSWorkSessionTool: String, Codable, Sendable, Hashable {
    case claude
    case codex
    case opencode
    case shell
}

public enum IOSWorkSessionObservation: String, Codable, Sendable, Hashable {
    case open
    case ownerOnly = "owner_only"
}

/// Durable, credential-free Work projection consumed by the mobile observer UI.
/// Host-local paths, terminal output, process state, and attach capabilities are
/// deliberately absent from this model.
public struct IOSWorkSession: Identifiable, Codable, Sendable, Hashable {
    public let id: WorkSessionID
    public let workspaceId: WorkspaceID
    public let channelId: ChannelID
    public let memberId: MemberID
    public let hostId: WorkHostID
    public let rootMessageId: MessageID
    public let tool: IOSWorkSessionTool
    public let label: String
    public let status: IOSWorkSessionStatus
    public let observation: IOSWorkSessionObservation
    public let observerGrantCount: Int64
    public let remoteAttachAvailable: Bool
    public let startedAtMs: Int64
    public let endedAtMs: Int64?
    public let exitCode: Int?
    public let endReason: String?
    public let resumedFromSessionId: WorkSessionID?

    public init(
        id: WorkSessionID,
        workspaceId: WorkspaceID,
        channelId: ChannelID,
        memberId: MemberID,
        hostId: WorkHostID,
        rootMessageId: MessageID,
        tool: IOSWorkSessionTool,
        label: String,
        status: IOSWorkSessionStatus,
        observation: IOSWorkSessionObservation = .open,
        observerGrantCount: Int64 = 0,
        remoteAttachAvailable: Bool = false,
        startedAtMs: Int64,
        endedAtMs: Int64? = nil,
        exitCode: Int? = nil,
        endReason: String? = nil,
        resumedFromSessionId: WorkSessionID? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.channelId = channelId
        self.memberId = memberId
        self.hostId = hostId
        self.rootMessageId = rootMessageId
        self.tool = tool
        self.label = label
        self.status = status
        self.observation = observation
        self.observerGrantCount = observerGrantCount
        self.remoteAttachAvailable = remoteAttachAvailable
        self.startedAtMs = startedAtMs
        self.endedAtMs = endedAtMs
        self.exitCode = exitCode
        self.endReason = endReason
        self.resumedFromSessionId = resumedFromSessionId
    }

    public var isRunning: Bool { status == .running }
    public var isCompleted: Bool { status == .ended }

    public func elapsedDescription(now: Date = Date()) -> String {
        let endMs = endedAtMs ?? Int64(now.timeIntervalSince1970 * 1_000)
        let elapsedSeconds = max(0, (endMs - startedAtMs) / 1_000)
        if elapsedSeconds < 60 { return "< 1 min" }
        let minutes = elapsedSeconds / 60
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        if hours < 24 {
            return remainingMinutes == 0 ? "\(hours) hr" : "\(hours) hr \(remainingMinutes) min"
        }
        let days = hours / 24
        let remainingHours = hours % 24
        return remainingHours == 0 ? "\(days) day" : "\(days) day \(remainingHours) hr"
    }
}

public struct IOSWorkPool: Codable, Sendable, Hashable {
    public let workspaceId: WorkspaceID
    public let maxActive: Int
    public let includedActiveHours: Int?
    public let perMemberSoftLimit: Int
    public let activeSessions: Int
    public let memberActiveSessions: Int

    public init(
        workspaceId: WorkspaceID,
        maxActive: Int,
        includedActiveHours: Int? = nil,
        perMemberSoftLimit: Int,
        activeSessions: Int,
        memberActiveSessions: Int
    ) {
        self.workspaceId = workspaceId
        self.maxActive = maxActive
        self.includedActiveHours = includedActiveHours
        self.perMemberSoftLimit = perMemberSoftLimit
        self.activeSessions = activeSessions
        self.memberActiveSessions = memberActiveSessions
    }
}

public struct IOSWorkSnapshot: Sendable, Hashable {
    public let sessions: [IOSWorkSession]
    public let hosts: [WorkHost]
    public let pool: IOSWorkPool

    public init(sessions: [IOSWorkSession], hosts: [WorkHost], pool: IOSWorkPool) {
        self.sessions = sessions
        self.hosts = hosts
        self.pool = pool
    }
}

public protocol IOSWorkBackend: Sendable {
    func workSnapshot() async throws -> IOSWorkSnapshot
    func workEvents(channel: ChannelID) async throws -> AsyncStream<WorkSessionDelta>
}

public enum IOSWorkFilter: String, CaseIterable, Sendable, Hashable, Identifiable {
    case all
    case running

    public var id: String { rawValue }
}

public struct IOSWorkSummary: Sendable, Hashable {
    public let runningCount: Int
    public let completedCount: Int

    public init(sessions: [IOSWorkSession]) {
        runningCount = sessions.count(where: \.isRunning)
        completedCount = sessions.count(where: \.isCompleted)
    }
}

@MainActor
@Observable
public final class IOSWorkListModel {
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
    public private(set) var sessions: [IOSWorkSession] = []
    public private(set) var hostsByID: [WorkHostID: WorkHost] = [:]
    public private(set) var pool: IOSWorkPool?
    public private(set) var inlineFailureMessage: String?
    public var filter: IOSWorkFilter = .all

    public var visibleSessions: [IOSWorkSession] {
        switch filter {
        case .all: sessions
        case .running: sessions.filter(\.isRunning)
        }
    }

    public var summary: IOSWorkSummary { IOSWorkSummary(sessions: sessions) }

    private let backend: any IOSWorkBackend
    private var subscribedChannelIDs: Set<ChannelID> = []
    private var refreshRevision: UInt64 = 0

    public init(backend: any IOSWorkBackend) {
        self.backend = backend
    }

    public func start(channelIDs: [ChannelID]) async {
        await refresh(showsInitialLoading: sessions.isEmpty)
        let uniqueChannelIDs = Set(channelIDs)
        subscribedChannelIDs = uniqueChannelIDs
        defer { subscribedChannelIDs = [] }
        let backend = backend
        await withTaskGroup(of: Void.self) { group in
            for channelID in uniqueChannelIDs {
                group.addTask { [weak self] in
                    do {
                        let events = try await backend.workEvents(channel: channelID)
                        for await event in events {
                            guard !Task.isCancelled else { return }
                            await self?.receive(event)
                        }
                    } catch is CancellationError {
                        return
                    } catch {
                        await self?.recordRealtimeFailure(error)
                    }
                }
            }
            await group.waitForAll()
        }
    }

    public func retry() async {
        await refresh(showsInitialLoading: sessions.isEmpty)
    }

    /// Realtime events are hints. REST remains authoritative so future additive
    /// session fields cannot be accidentally synthesized from the smaller delta.
    func receive(_ delta: WorkSessionDelta) async {
        guard sessions.contains(where: { $0.channelId == delta.channelId })
                || subscribedChannelIDs.contains(delta.channelId)
        else { return }
        await refresh(showsInitialLoading: false)
    }

    public func host(for session: IOSWorkSession) -> WorkHost? {
        hostsByID[session.hostId]
    }

    private func refresh(showsInitialLoading: Bool) async {
        refreshRevision &+= 1
        let revision = refreshRevision
        if showsInitialLoading { phase = .loading }
        do {
            let snapshot = try await backend.workSnapshot()
            guard revision == refreshRevision else { return }
            sessions = snapshot.sessions.sorted(by: Self.sessionOrder)
            hostsByID = Dictionary(uniqueKeysWithValues: snapshot.hosts.map { ($0.id, $0) })
            pool = snapshot.pool
            inlineFailureMessage = nil
            phase = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard revision == refreshRevision else { return }
            let failure = Self.failure(for: error)
            if sessions.isEmpty {
                phase = .failed(failure)
            } else {
                inlineFailureMessage = failure.message
            }
        }
    }

    private func recordRealtimeFailure(_ error: Error) {
        guard !sessions.isEmpty else { return }
        inlineFailureMessage = Self.failure(for: error).message
    }

    private static func sessionOrder(_ lhs: IOSWorkSession, _ rhs: IOSWorkSession) -> Bool {
        if lhs.isRunning != rhs.isRunning { return lhs.isRunning }
        if lhs.startedAtMs != rhs.startedAtMs { return lhs.startedAtMs > rhs.startedAtMs }
        return lhs.id.description < rhs.id.description
    }

    private static func failure(for error: Error) -> Failure {
        let isOffline: Bool
        if let sessionError = error as? SessionError, case .transport = sessionError {
            isOffline = true
        } else {
            isOffline = false
        }
        return Failure(
            message: isOffline
                ? "Work is unavailable offline. Check your connection and try again."
                : "Could not load Work sessions. Try again.",
            isOffline: isOffline
        )
    }
}

private struct IOSWorkSessionListResponse: Decodable {
    let workSessions: [IOSWorkSession]
}

private struct IOSWorkPoolResponse: Decodable {
    let workPool: IOSWorkPool
}

extension MomoServerConversationClient: IOSWorkBackend {
    public func workSnapshot() async throws -> IOSWorkSnapshot {
        let workspacePath = "/v1/workspaces/\(authenticated.workspaceID.description)"
        async let sessionsData = get(workspacePath + "/work-sessions")
        async let hostsData = get(workspacePath + "/work-hosts")
        async let poolData = get(workspacePath + "/work-pool")
        return try Self.mapWorkSnapshot(
            sessionsData: try await sessionsData,
            hostsData: try await hostsData,
            poolData: try await poolData,
            decoder: decoder
        )
    }

    public func workEvents(channel: ChannelID) async throws -> AsyncStream<WorkSessionDelta> {
        let events = try await subscribe(channel: channel)
        return AsyncStream { continuation in
            let task = Task {
                for await event in events {
                    guard !Task.isCancelled else { break }
                    if case .workSession(let delta) = event {
                        continuation.yield(delta)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func mapWorkSnapshot(
        sessionsData: Data,
        hostsData: Data,
        poolData: Data,
        decoder: JSONDecoder = JSONDecoder()
    ) throws -> IOSWorkSnapshot {
        do {
            return IOSWorkSnapshot(
                sessions: try decoder.decode(IOSWorkSessionListResponse.self, from: sessionsData).workSessions,
                hosts: try decoder.decode(WorkHostListResponse.self, from: hostsData).workHosts,
                pool: try decoder.decode(IOSWorkPoolResponse.self, from: poolData).workPool
            )
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned Work data this app could not read.")
        }
    }
}
