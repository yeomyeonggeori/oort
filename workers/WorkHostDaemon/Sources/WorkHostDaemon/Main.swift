import Foundation
import Logging

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
            ])
            if CommandLine.arguments.contains("--bootstrap-only") { return }

            let processes = ProcessManager(
                templates: config.commandTemplates,
                outputDirectory: config.outputDirectory
            )
            let daemon = WorkDaemon(
                hostID: hostID,
                api: runtimeClient,
                processes: processes,
                pollInterval: config.pollInterval,
                heartbeatInterval: config.heartbeatInterval,
                logger: logger
            )
            await daemon.run()
        } catch {
            logger.error("momo-workd stopped", metadata: [
                "error_label": .string(WorkDaemon.label(for: error)),
            ])
        }
    }
}
