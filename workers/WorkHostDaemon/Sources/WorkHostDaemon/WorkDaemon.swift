import Foundation
import Logging

final class WorkDaemon: Sendable {
    private let hostID: UUID
    private let api: any WorkHostAPI
    private let processes: ProcessManager
    private let pollInterval: Duration
    private let heartbeatInterval: Duration
    private let localCommandOverrides: [String: LocalCommandOverride]
    /// MOMO-655: where clients are told to dial this host's PTYs, or nil when
    /// this host serves no attach.
    private let attachEndpoint: String?
    private let childEnvironmentPolicy: ChildEnvironmentPolicy
    private let allowProfileLegacyEnvironment: Bool
    private let logger: Logger
    private let spawnedSessions = SpawnedSessionCache()
    private let appliedControls = AppliedControlCache()

    init(
        hostID: UUID,
        api: any WorkHostAPI,
        processes: ProcessManager,
        pollInterval: Duration,
        heartbeatInterval: Duration,
        localCommandOverrides: [String: LocalCommandOverride] = [:],
        childEnvironmentPolicy: ChildEnvironmentPolicy = .safeDefault,
        allowProfileLegacyEnvironment: Bool = false,
        attachEndpoint: String? = nil,
        logger: Logger
    ) {
        self.attachEndpoint = attachEndpoint
        self.hostID = hostID
        self.api = api
        self.processes = processes
        self.pollInterval = pollInterval
        self.heartbeatInterval = heartbeatInterval
        self.localCommandOverrides = localCommandOverrides
        self.childEnvironmentPolicy = childEnvironmentPolicy
        self.allowProfileLegacyEnvironment = allowProfileLegacyEnvironment
        self.logger = logger
    }

    func run() async {
        var nextHeartbeat = ContinuousClock.now
        // MOMO-656: the boot snapshot is taken exactly once and then retried
        // as-is. Re-reading the ledger on every retry would eventually observe
        // a session the orphan sweep just resumed onto this same host and
        // report it lost too — a report is only honest about what existed
        // before this process started polling for controls.
        var lostSnapshot: [UUID]?
        var reconciled = false
        while !Task.isCancelled {
            // Reconcile before dispatching anything. A fast restart keeps
            // heartbeats inside the offline grace window, so this report is
            // the only signal that the ledger's running/idle rows lost their
            // PTYs.
            if !reconciled {
                if lostSnapshot == nil { lostSnapshot = await lostSessionSnapshot() }
                if let lost = lostSnapshot {
                    reconciled = await reportLostSessions(lost)
                }
            }
            if ContinuousClock.now >= nextHeartbeat {
                do {
                    try await api.heartbeat(hostID: hostID)
                    nextHeartbeat = ContinuousClock.now.advanced(by: heartbeatInterval)
                } catch {
                    logger.warning("work host heartbeat failed", metadata: [
                        "error_label": .string(Self.label(for: error)),
                    ])
                }
            }
            await pollOnce()
            try? await Task.sleep(for: pollInterval)
        }
    }

    func pollOnce() async {
        do {
            let controls = try await api.pendingControls(hostID: hostID)
            for control in controls where control.targetHostId == hostID && control.status == "dispatched" {
                await handle(control)
            }
        } catch {
            logger.warning("work host control poll failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
        }
        await reportToolTransitions()
        await reportNaturalExits()
    }

    /// MOMO-656 step 1. Everything the ledger still attributes to this host
    /// that this process cannot serve. `nil` means the ledger read failed and
    /// the caller must retry — an empty array means "nothing was lost", which
    /// is a real, terminal answer.
    func lostSessionSnapshot() async -> [UUID]? {
        let live: [WorkHostLiveSession]
        do {
            live = try await api.liveSessions(hostID: hostID)
        } catch {
            logger.warning("work host live session read failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
            return nil
        }
        let servable = await processes.servableSessionIDs()
        return live.map(\.id).filter { !servable.contains($0) }
    }

    /// MOMO-656 step 2. Reports the snapshot under the host signature. The
    /// server only stamps eligibility; the existing orphan sweep still owns
    /// the transition, the resume card, and the lineage.
    func reportLostSessions(_ sessionIDs: [UUID]) async -> Bool {
        guard !sessionIDs.isEmpty else { return true }
        do {
            let reported = try await api.reportLostSessions(
                hostID: hostID,
                sessionIDs: sessionIDs
            )
            logger.info("work host restart reconciliation reported", metadata: [
                "lost_count": .stringConvertible(sessionIDs.count),
                "accepted_count": .stringConvertible(reported.count),
            ])
            return true
        } catch {
            logger.warning("work host restart reconciliation failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
            return false
        }
    }

    private func handle(_ control: WorkControl) async {
        switch control.kind {
        case "spawn": await handleSpawn(control)
        case "input": await handleInput(control)
        case "kill": await handleKill(control)
        default:
            await acknowledgeFailure(controlID: control.id, label: "unsupported_control")
        }
    }

    private func handleSpawn(_ control: WorkControl) async {
        if let existingSession = await spawnedSessions.session(for: control.id) {
            do {
                try await api.acknowledge(
                    hostID: hostID,
                    controlID: control.id,
                    ok: true,
                    sessionID: existingSession,
                    errorLabel: nil
                )
                await processes.markAcknowledged(existingSession)
            } catch {
                logger.warning("work host spawn ack retry failed", metadata: [
                    "error_label": .string(Self.label(for: error)),
                ])
            }
            return
        }

        let sessionID: UUID
        let tool: String
        if let preallocatedSessionID = control.sessionId,
           let payload = control.payload.objectValue,
           let preallocatedTool = payload["tool"]?.stringValue
        {
            // Tier fallback allocates the durable lineage before dispatch so
            // the resume REST can atomically return the new session. The host
            // reuses that id and performs no second session-create write.
            sessionID = preallocatedSessionID
            tool = preallocatedTool
        } else {
            let session: WorkSession
            do {
                session = try await api.createSession(hostID: hostID, control: control)
            } catch {
                await acknowledgeFailure(controlID: control.id, label: "session_create_failed")
                return
            }
            sessionID = session.id
            tool = session.tool
        }
        do {
            let profiles = try await api.workToolProfiles(hostID: hostID)
            let templates = try WorkdConfig.commandTemplates(
                profiles: profiles,
                localOverrides: localCommandOverrides,
                hostEnvironmentPolicy: childEnvironmentPolicy,
                allowProfileLegacyEnvironment: allowProfileLegacyEnvironment
            )
            await processes.replaceTemplates(templates)
            let prompt = control.payload.objectValue?["label"]?.stringValue ?? "Continue the work session."
            try await processes.start(
                sessionID: sessionID,
                channelID: control.channelId,
                tool: tool,
                prompt: prompt
            )
        } catch {
            logger.warning("work host process start failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
            try? await api.endSession(hostID: hostID, sessionID: sessionID, exitCode: -1)
            await acknowledgeFailure(controlID: control.id, label: "process_start_failed")
            return
        }
        await publishAttachBinding(sessionID: sessionID)
        await spawnedSessions.insert(sessionID, for: control.id)
        // The process may finish while the ack response is in flight. Mark it
        // locally before the network call so natural completion is still
        // reported when an ack response is lost after the server commits it.
        await processes.markAcknowledged(sessionID)
        do {
            try await api.acknowledge(
                hostID: hostID,
                controlID: control.id,
                ok: true,
                sessionID: sessionID,
                errorLabel: nil
            )
        } catch {
            // Keep the local control->session binding. A later poll retries the
            // same ack and never starts a duplicate process.
            logger.warning("work host spawn ack failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
        }
    }

    /// MOMO-655 step 2 of the seam: the PTY exists, so say where it can be
    /// reached. Deliberately best-effort — a session whose binding never lands
    /// is a session nobody can watch, which is exactly the state every session
    /// was in before this ticket, and losing the WORK over a failed
    /// watchability announcement would be a strictly worse trade. Only a PTY
    /// transport gets one; an ACP session has no attachable terminal, and
    /// `ProcessManager.ptyID(for:)` answers nil for it.
    private func publishAttachBinding(sessionID: UUID) async {
        guard let attachEndpoint,
              let ptyID = await processes.ptyID(for: sessionID)
        else { return }
        do {
            try await api.bindRemotePTY(
                hostID: hostID,
                sessionID: sessionID,
                ptyID: ptyID,
                attachEndpoint: attachEndpoint
            )
        } catch {
            logger.warning("work host attach binding failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
        }
    }

    private func handleInput(_ control: WorkControl) async {
        guard let sessionID = control.sessionId,
              let text = control.payload.objectValue?["text"]?.stringValue
        else {
            await acknowledgeFailure(controlID: control.id, label: "invalid_control")
            return
        }
        if await appliedControls.inputSession(for: control.id) == nil {
            do {
                try await processes.write(text, to: sessionID)
                await appliedControls.recordInput(control.id, sessionID: sessionID)
            } catch {
                await acknowledgeFailure(controlID: control.id, label: "stdin_unavailable")
                return
            }
        }
        do {
            try await api.acknowledge(
                hostID: hostID,
                controlID: control.id,
                ok: true,
                sessionID: sessionID,
                errorLabel: nil
            )
        } catch {
            logger.warning("work host input ack failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
        }
    }

    private func handleKill(_ control: WorkControl) async {
        guard let sessionID = control.sessionId else {
            await acknowledgeFailure(controlID: control.id, label: "invalid_control")
            return
        }
        let exitCode: Int
        if let applied = await appliedControls.killResult(for: control.id) {
            guard applied.sessionID == sessionID else {
                await acknowledgeFailure(controlID: control.id, label: "invalid_control")
                return
            }
            exitCode = applied.exitCode
        } else {
            do {
                exitCode = try await processes.terminate(sessionID)
                await appliedControls.recordKill(
                    control.id,
                    sessionID: sessionID,
                    exitCode: exitCode
                )
            } catch {
                await acknowledgeFailure(controlID: control.id, label: "process_terminate_failed")
                return
            }
        }
        await processes.markAcknowledged(sessionID)
        do {
            try await api.acknowledge(
                hostID: hostID,
                controlID: control.id,
                ok: true,
                sessionID: sessionID,
                errorLabel: nil
            )
        } catch {
            logger.warning("work host kill ack failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
        }
        do {
            try await api.endSession(
                hostID: hostID,
                sessionID: sessionID,
                exitCode: exitCode
            )
            await processes.markEndReported(sessionID)
        } catch {
            logger.warning("work host kill end report failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
        }
    }

    private func reportNaturalExits() async {
        for ended in await processes.endedSessions() {
            do {
                try await api.endSession(
                    hostID: hostID,
                    sessionID: ended.sessionID,
                    exitCode: ended.exitCode
                )
                await processes.markEndReported(ended.sessionID)
            } catch {
                logger.warning("work host session end report failed", metadata: [
                    "error_label": .string(Self.label(for: error)),
                ])
            }
        }
    }

    private func reportToolTransitions() async {
        for transition in await processes.toolTransitions() {
            do {
                switch transition.status {
                case .idle(let exitCode):
                    // TODO(#859): this lifecycle report is the T3 pause
                    // integration point; MOMO-649 only reports the host fact.
                    try await api.reportSessionIdle(
                        hostID: hostID,
                        sessionID: transition.sessionID,
                        exitCode: exitCode
                    )
                case .running:
                    // TODO(#859): resume the paused T3 sandbox before reporting
                    // running; local T2 shells need no provisioner operation.
                    try await api.reportSessionRunning(
                        hostID: hostID,
                        sessionID: transition.sessionID
                    )
                }
                await processes.markTransitionReported(transition)
            } catch {
                logger.warning("work host tool lifecycle report failed", metadata: [
                    "error_label": .string(Self.label(for: error)),
                ])
                // Preserve order: a running report must never overtake the
                // preceding idle report on a transient network failure.
                return
            }
        }
    }

    private func acknowledgeFailure(controlID: UUID, label: String) async {
        do {
            try await api.acknowledge(
                hostID: hostID,
                controlID: controlID,
                ok: false,
                sessionID: nil,
                errorLabel: label
            )
        } catch {
            logger.warning("work host failure ack failed", metadata: [
                "error_label": .string(Self.label(for: error)),
            ])
        }
    }

    static func label(for error: Error) -> String {
        (error as? WorkdFailure)?.errorLabel ?? "internal_failure"
    }
}

actor SpawnedSessionCache {
    private var sessions: [UUID: UUID] = [:]
    func session(for controlID: UUID) -> UUID? { sessions[controlID] }
    func insert(_ sessionID: UUID, for controlID: UUID) { sessions[controlID] = sessionID }
}

actor AppliedControlCache {
    struct KillResult: Sendable, Equatable {
        let sessionID: UUID
        let exitCode: Int
    }

    private var inputSessions: [UUID: UUID] = [:]
    private var killResults: [UUID: KillResult] = [:]

    func inputSession(for controlID: UUID) -> UUID? { inputSessions[controlID] }
    func recordInput(_ controlID: UUID, sessionID: UUID) {
        inputSessions[controlID] = sessionID
    }
    func killResult(for controlID: UUID) -> KillResult? { killResults[controlID] }
    func recordKill(_ controlID: UUID, sessionID: UUID, exitCode: Int) {
        killResults[controlID] = KillResult(sessionID: sessionID, exitCode: exitCode)
    }
}
