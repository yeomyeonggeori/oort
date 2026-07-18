import Foundation
import MomoCore
import Observation

/// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
/// iOS intentionally supports joining an existing huddle, not starting one.
@MainActor
@Observable
public final class IOSHuddleModel {
    public private(set) var state: IOSHuddleState
    public private(set) var activeHuddle: IOSHuddle?
    public private(set) var audioParticipants: [IOSHuddleAudioParticipant] = []
    public private(set) var isMicrophoneMuted = false

    private let workspace: WorkspaceID
    private let channel: ChannelID
    private let service: (any IOSHuddleService)?
    private let audioSession: any IOSHuddleAudioSession
    private let permissionAuthorizer: any IOSMicrophonePermissionAuthorizing
    private let now: @Sendable () -> Date
    private var joinedHuddleID: UUID?
    private var joinTask: Task<Void, Never>?
    private var participantTask: Task<Void, Never>?
    private var tokenRefreshTask: Task<Void, Never>?
    private var activationID = UUID()

    public init(
        workspace: WorkspaceID,
        channel: ChannelID,
        service: (any IOSHuddleService)?,
        audioSession: any IOSHuddleAudioSession,
        permissionAuthorizer: any IOSMicrophonePermissionAuthorizing,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.workspace = workspace
        self.channel = channel
        self.service = service
        self.audioSession = audioSession
        self.permissionAuthorizer = permissionAuthorizer
        self.now = now
        self.state = service == nil ? .unavailable : .idle
    }

    public var participantCount: Int {
        max(activeHuddle?.participants.count ?? 0, audioParticipants.count)
    }

    public var isJoined: Bool { joinedHuddleID != nil && state == .joined }

    public func activate() async {
        guard let service else { return }
        let activation = UUID()
        activationID = activation
        state = .connecting
        do {
            activeHuddle = try await service.active(workspace: workspace, channel: channel)
            guard activationID == activation else { return }
            state = .idle
        } catch is CancellationError {
            return
        } catch {
            guard activationID == activation else { return }
            present(error)
        }
    }

    public func join() async {
        guard let service, let huddle = activeHuddle, joinTask == nil else { return }
        let activation = activationID
        let task = Task { [weak self] in
            guard let self else { return }
            state = .connecting
            guard await permissionAuthorizer.requestPermission() else {
                guard activationID == activation else { return }
                state = .permissionDenied
                return
            }
            do {
                let joined = try await service.join(workspace: workspace, huddle: huddle.id)
                joinedHuddleID = joined.huddle.id
                guard !Task.isCancelled, activationID == activation else {
                    await leaveCurrentHuddle(reportErrors: false)
                    return
                }
                try await audioSession.connect(url: joined.liveKitURL, token: joined.token)
                guard !Task.isCancelled, activationID == activation else {
                    await leaveCurrentHuddle(reportErrors: false)
                    return
                }
                activeHuddle = joined.huddle
                isMicrophoneMuted = false
                state = .joined
                observeParticipants()
                scheduleTokenRefresh(joined)
            } catch is CancellationError {
                await leaveCurrentHuddle(reportErrors: false)
                return
            } catch {
                let shouldPresent = !Task.isCancelled && activationID == activation
                await leaveCurrentHuddle(reportErrors: false)
                if shouldPresent { present(error) }
            }
        }
        joinTask = task
        await task.value
        joinTask = nil
    }

    public func retry() async {
        await activate()
    }

    public func toggleMicrophone() async {
        guard isJoined else { return }
        let target = !isMicrophoneMuted
        do {
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
        let task = joinTask
        joinTask = nil
        task?.cancel()
        await task?.value
        await leaveCurrentHuddle(reportErrors: false)
    }

    public func apply(_ delta: HuddleDelta) async {
        guard delta.channelId == channel else { return }
        switch delta.action {
        case .ended:
            guard activeHuddle?.id == delta.huddleId || joinedHuddleID == delta.huddleId else { return }
            activationID = UUID()
            await leaveCurrentHuddle(reportErrors: false, notifyServer: false)
            activeHuddle = nil
            state = .idle
        case .started, .participantsChanged:
            await refreshActiveHuddle()
        }
    }

    private func refreshActiveHuddle() async {
        guard let service else { return }
        do {
            activeHuddle = try await service.active(workspace: workspace, channel: channel)
            if state != .joined { state = .idle }
        } catch is CancellationError {
            return
        } catch {
            present(error)
        }
    }

    private func observeParticipants() {
        participantTask?.cancel()
        participantTask = Task { [weak self] in
            guard let self else { return }
            let updates = await audioSession.participantUpdates()
            for await participants in updates {
                guard !Task.isCancelled else { return }
                audioParticipants = participants
            }
        }
    }

    private func scheduleTokenRefresh(_ joined: IOSHuddleJoin) {
        tokenRefreshTask?.cancel()
        let delay = max(1, joined.expiresAt.timeIntervalSince(now()) - 60)
        let huddleID = joined.huddle.id
        let activation = activationID
        tokenRefreshTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
                guard let self,
                      !Task.isCancelled,
                      joinedHuddleID == huddleID,
                      activationID == activation,
                      let service
                else { return }
                let refreshed = try await service.join(workspace: workspace, huddle: huddleID)
                guard !Task.isCancelled, joinedHuddleID == huddleID, activationID == activation else { return }
                try await audioSession.connect(url: refreshed.liveKitURL, token: refreshed.token)
                guard !Task.isCancelled, joinedHuddleID == huddleID, activationID == activation else {
                    await audioSession.disconnect()
                    return
                }
                try await audioSession.setMicrophoneMuted(isMicrophoneMuted)
                activeHuddle = refreshed.huddle
                state = .joined
                observeParticipants()
                scheduleTokenRefresh(refreshed)
            } catch is CancellationError {
                return
            } catch {
                self?.present(error)
            }
        }
    }

    private func leaveCurrentHuddle(reportErrors: Bool, notifyServer: Bool = true) async {
        let huddleID = joinedHuddleID
        joinedHuddleID = nil
        let refreshTask = tokenRefreshTask
        tokenRefreshTask = nil
        refreshTask?.cancel()
        participantTask?.cancel()
        participantTask = nil
        await refreshTask?.value
        await audioSession.disconnect()
        audioParticipants = []

        var leaveError: Error?
        if notifyServer, let service, let huddleID {
            do {
                try await service.leave(workspace: workspace, huddle: huddleID)
            } catch {
                leaveError = error
            }
        }
        isMicrophoneMuted = false
        if reportErrors, let leaveError {
            present(leaveError)
        } else if service != nil {
            state = .idle
        }
    }

    private func present(_ error: Error) {
        if let huddleError = error as? IOSHuddleClientError, huddleError.isUnconfigured {
            activeHuddle = nil
            state = .unavailable
        } else {
            state = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }
}
