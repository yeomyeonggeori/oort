import Foundation
import Logging

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

@main
struct WorkHostDaemonMain {
    static func main() async {
        var logger = Logger(label: "momo-workd")
        logger.logLevel = .info
        do {
            var config = try WorkdConfig.load()
            let signer = try SecureLocalStore.loadOrCreateSigner(at: config.keyURL)
            let client = WorkHostAPIClient(config: config, signer: signer)
            let hostID: UUID
            if let registered = try SecureLocalStore.loadHostID(at: config.hostIDURL) {
                hostID = registered
            } else {
                guard let token = config.registrationToken else {
                    throw WorkdFailure.registrationRequired
                }
                hostID = try await client.register(registrationToken: token)
                try SecureLocalStore.saveHostID(hostID, at: config.hostIDURL)
            }
            if let tokenURL = config.registrationTokenURL {
                // A surviving token file after an interrupted prior bootstrap
                // is consumed once a durable local host id exists as well.
                try SecureLocalStore.removeConsumedSecret(at: tokenURL)
            }
            // Registration bearer is one-shot bootstrap material. It is never
            // persisted and is dropped before any tool process can be spawned.
            config.registrationToken = nil
            let runtimeClient = WorkHostAPIClient(config: config, signer: signer)
            try await runtimeClient.heartbeat(hostID: hostID)
            logger.info("momo-workd host ready", metadata: [
                "workspace_id": .string(config.workspaceID.uuidString.lowercased()),
                "host_id": .string(hostID.uuidString.lowercased()),
                // WH-1: the boot-selected engine. A DB-backed override (migration
                // 040) is resolved per dispatch via WorkdConfig.resolveEngine.
                "engine": .string(config.engine.rawValue),
            ])
            let profiles = try await runtimeClient.workToolProfiles(hostID: hostID)
            let templates = try WorkdConfig.commandTemplates(
                profiles: profiles,
                localOverrides: config.localCommandOverrides,
                hostEnvironmentPolicy: config.childEnvironmentPolicy,
                allowProfileLegacyEnvironment: config.allowProfileLegacyEnvironment
            )
            let processes = ProcessManager(
                templates: templates,
                outputDirectory: config.outputDirectory,
                ringBufferBytes: config.ringBufferBytes,
                subscriberQueueBytes: config.subscriberQueueBytes,
                acpEventRelay: { sessionID, event in
                    try await runtimeClient.relayACPEvent(
                        hostID: hostID, sessionID: sessionID, event: event
                    )
                }
            )
            if CommandLine.arguments.contains("--bootstrap-only") { return }
            let daemon = WorkDaemon(
                hostID: hostID,
                api: runtimeClient,
                processes: processes,
                pollInterval: config.pollInterval,
                heartbeatInterval: config.heartbeatInterval,
                localCommandOverrides: config.localCommandOverrides,
                childEnvironmentPolicy: config.childEnvironmentPolicy,
                allowProfileLegacyEnvironment: config.allowProfileLegacyEnvironment,
                attachEndpoint: config.terminalAttach?.publicEndpoint,
                logger: logger
            )
            // MOMO-655: the attach listener runs beside the control loop, not
            // inside it. A bind failure is fatal (an operator who configured an
            // endpoint must not get a host that quietly serves nothing), but a
            // host with no attach configured never opens a socket at all.
            if let attach = config.terminalAttach {
                let server = TerminalAttachServer(
                    config: attach,
                    hostID: hostID,
                    api: runtimeClient,
                    processes: processes,
                    logger: logger
                )
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask { try await server.run() }
                    group.addTask { await daemon.run() }
                    try await group.next()
                    group.cancelAll()
                }
            } else {
                await daemon.run()
            }
        } catch {
            logger.error("momo-workd stopped", metadata: [
                "error_label": .string(WorkDaemon.label(for: error)),
            ])
            exit(EXIT_FAILURE)
        }
    }
}
