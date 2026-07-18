import Foundation
import MomoCore

@MainActor
public final class MomoHuddleViewModel: ObservableObject {
    @Published public private(set) var state: MomoHuddleState
    @Published public private(set) var activeHuddle: MomoHuddle?
    @Published public private(set) var audioParticipants: [MomoHuddleAudioParticipant] = []
    @Published public private(set) var isMicrophoneMuted = false

    private let service: (any MomoHuddleService)?
    private var audioSession: (any MomoHuddleAudioSession)?
    private let now: @Sendable () -> Date
    private var workspace: WorkspaceID?
    private var channel: ChannelID?
    private var joinedHuddleID: UUID?
    private var eventTask: Task<Void, Never>?
    private var joinTask: Task<Void, Never>?
    private var participantTask: Task<Void, Never>?
    private var tokenRefreshTask: Task<Void, Never>?
    private var activationID = UUID()

    public init(
        service: (any MomoHuddleService)?,
        audioSession: (any MomoHuddleAudioSession)? = nil,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.service = service
        self.audioSession = audioSession
        self.now = now
        self.state = service == nil
            ? .unavailable("Connect to a configured momo server to use huddles.")
            : .idle
    }

    public static func live(serverIdentity: String?) -> MomoHuddleViewModel {
        guard let serverIdentity,
              serverIdentity != "local demo",
              let baseURL = URL(string: serverIdentity),
              baseURL.scheme != nil,
              baseURL.host != nil
        else {
            return MomoHuddleViewModel(service: nil)
        }
        return MomoHuddleViewModel(service: MomoHuddleRESTService(baseURL: baseURL))
    }

    public var participantCount: Int {
        max(activeHuddle?.participants.count ?? 0, audioParticipants.count)
    }

    public var isJoined: Bool { joinedHuddleID != nil && state == .joined }

    public func activate(workspace: WorkspaceID?, channel: ChannelID) async {
        guard let service else { return }
        guard let workspace else {
            state = .unavailable("Connect to a workspace to use huddles.")
            return
        }
        if self.workspace == workspace, self.channel == channel, eventTask != nil { return }

        let currentActivation = UUID()
        activationID = currentActivation
        eventTask?.cancel()
        eventTask = nil
        await cancelJoin()
        guard activationID == currentActivation else { return }
        await leaveCurrentHuddle(reportErrors: false)
        guard activationID == currentActivation else { return }
        self.workspace = workspace
        self.channel = channel
        state = .connecting

        do {
            activeHuddle = try await service.active(workspace: workspace, channel: channel)
            guard activationID == currentActivation else { return }
            state = .idle
        } catch {
            guard activationID == currentActivation else { return }
            present(error)
        }

        eventTask = Task { [weak self] in
            guard let self else { return }
            do {
                let events = try await service.events(workspace: workspace, channel: channel)
                for await delta in events {
                    guard !Task.isCancelled else { return }
                    await self.apply(delta)
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.present(error)
            }
        }
    }

    public func beginStartOrJoin() {
        launchStartOrJoin()
    }

    public func startOrJoin() async {
        let task = launchStartOrJoin()
        await task.value
    }

    @discardableResult
    private func launchStartOrJoin() -> Task<Void, Never> {
        joinTask?.cancel()
        let currentActivation = activationID
        let task = Task { [weak self] in
            guard let self else { return }
            await self.performStartOrJoin(activation: currentActivation)
        }
        joinTask = task
        return task
    }

    private func performStartOrJoin(activation: UUID) async {
        guard let service, let workspace, let channel else { return }
        state = .connecting
        do {
            let huddle: MomoHuddle
            if let activeHuddle {
                huddle = activeHuddle
            } else {
                huddle = try await service.start(workspace: workspace, channel: channel)
            }
            guard !Task.isCancelled, activationID == activation else { return }
            activeHuddle = huddle
            let joined = try await service.join(workspace: workspace, huddle: huddle.id)
            guard !Task.isCancelled, activationID == activation else { return }
            try await connect(to: joined, activation: activation)
        } catch {
            guard !Task.isCancelled, activationID == activation else { return }
            present(error)
        }
    }

    public func retry() async {
        guard let channel else { return }
        let workspace = workspace
        self.workspace = nil
        self.channel = nil
        await activate(workspace: workspace, channel: channel)
    }

    public func toggleMicrophone() async {
        guard isJoined else { return }
        let target = !isMicrophoneMuted
        do {
            guard let audioSession else { return }
            try await audioSession.setMicrophoneMuted(target)
            isMicrophoneMuted = target
        } catch {
            present(error)
        }
    }

    public func leave() async {
        await leaveCurrentHuddle(reportErrors: true)
    }

    public func shutdown() async {
        activationID = UUID()
        await cancelJoin()
        eventTask?.cancel()
        eventTask = nil
        await leaveCurrentHuddle(reportErrors: false)
        workspace = nil
        channel = nil
    }

    public func apply(_ delta: HuddleDelta) async {
        guard delta.channelId == channel else { return }
        switch delta.action {
        case .ended:
            guard activeHuddle?.id == delta.huddleId || joinedHuddleID == delta.huddleId else { return }
            activationID = UUID()
            await cancelJoin()
            let refreshTask = tokenRefreshTask
            refreshTask?.cancel()
            tokenRefreshTask = nil
            joinedHuddleID = nil
            await refreshTask?.value
            if let audioSession { await audioSession.disconnect() }
            audioParticipants = []
            activeHuddle = nil
            state = .idle
        case .started, .participantsChanged:
            guard let service, let workspace, let channel else { return }
            do {
                activeHuddle = try await service.active(workspace: workspace, channel: channel)
                if state != .joined { state = .idle }
            } catch {
                present(error)
            }
        }
    }

    private func connect(to joined: MomoHuddleJoin, activation: UUID) async throws {
        let audioSession = audioSession ?? MomoHuddleLiveKitSession()
        self.audioSession = audioSession
        try await audioSession.connect(url: joined.liveKitURL, token: joined.token)
        guard !Task.isCancelled, activationID == activation else {
            await audioSession.disconnect()
            return
        }
        activeHuddle = joined.huddle
        joinedHuddleID = joined.huddle.id
        isMicrophoneMuted = false
        state = .joined
        observeParticipants()
        scheduleTokenRefresh(joined)
    }

    private func observeParticipants() {
        participantTask?.cancel()
        participantTask = Task { [weak self] in
            guard let self, let audioSession = self.audioSession else { return }
            let updates = await audioSession.participantUpdates()
            for await participants in updates {
                guard !Task.isCancelled else { return }
                self.audioParticipants = participants
            }
        }
    }

    private func scheduleTokenRefresh(_ joined: MomoHuddleJoin) {
        tokenRefreshTask?.cancel()
        let delay = max(1, joined.expiresAt.timeIntervalSince(now()) - 60)
        let huddleID = joined.huddle.id
        let activation = activationID
        tokenRefreshTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
                guard let self,
                      !Task.isCancelled,
                      self.joinedHuddleID == huddleID,
                      let service = self.service,
                      let workspace = self.workspace
                else { return }
                let refreshed = try await service.join(workspace: workspace, huddle: huddleID)
                guard !Task.isCancelled,
                      self.joinedHuddleID == huddleID,
                      self.activationID == activation
                else { return }
                guard let audioSession = self.audioSession else { return }
                try await audioSession.connect(url: refreshed.liveKitURL, token: refreshed.token)
                guard !Task.isCancelled,
                      self.joinedHuddleID == huddleID,
                      self.activationID == activation
                else {
                    await audioSession.disconnect()
                    return
                }
                try await audioSession.setMicrophoneMuted(self.isMicrophoneMuted)
                self.activeHuddle = refreshed.huddle
                self.state = .joined
                self.observeParticipants()
                self.scheduleTokenRefresh(refreshed)
            } catch is CancellationError {
                return
            } catch {
                self?.present(error)
            }
        }
    }

    private func leaveCurrentHuddle(reportErrors: Bool) async {
        let huddleID = joinedHuddleID
        joinedHuddleID = nil
        let refreshTask = tokenRefreshTask
        refreshTask?.cancel()
        tokenRefreshTask = nil
        participantTask?.cancel()
        participantTask = nil
        await refreshTask?.value

        if let audioSession { await audioSession.disconnect() }
        audioParticipants = []

        var leaveError: Error?
        if let service, let workspace, let huddleID {
            do {
                try await service.leave(workspace: workspace, huddle: huddleID)
            } catch {
                leaveError = error
            }
        }
        activeHuddle = nil
        isMicrophoneMuted = false
        if reportErrors, let leaveError {
            present(leaveError)
        } else if service != nil {
            state = .idle
        }
    }

    private func present(_ error: Error) {
        if let error = error as? MomoHuddleClientError, error.isUnconfigured {
            state = .unavailable(error.localizedDescription)
        } else {
            state = .failed(error.localizedDescription)
        }
    }

    private func cancelJoin() async {
        let task = joinTask
        joinTask = nil
        task?.cancel()
        await task?.value
    }
}
