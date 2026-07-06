import Foundation
import Hummingbird
import Logging

/// Entry point for the momo API server (L4 §1.1 / §9.3).
///
/// Loads config from the environment, builds the Hummingbird application (router +
/// middleware + supervised PostgresClient pool), and runs it under a ServiceGroup
/// with graceful shutdown on SIGTERM/SIGINT.
///
/// Runtime verification status is tracked in STATUS.md. The server has been
/// exercised against Docker PG18/Centrifugo for health + message writes.
@main
struct MomoServerMain {
    static func main() async throws {
        var logger = Logger(label: "MomoServer")
        logger.logLevel =
            ProcessInfo.processInfo.environment["LOG_LEVEL"]
                .flatMap { Logger.Level(rawValue: $0) } ?? .info

        let config = Config.load()
        try config.agentProvider.validateForBoot(environmentName: config.momoEnvironment)
        // MOMO-300: strict envs must not boot with a placeholder proxy secret.
        try config.validateSecurityForBoot()
        logger.info("starting MomoServer", metadata: [
            "host": .string(config.host),
            "port": .stringConvertible(config.port),
            "pgHost": .string(config.pgHost),
            "pgDatabase": .string(config.pgDatabase),
            "momoEnvironment": .string(config.momoEnvironment),
            "agentProviderMode": .string(config.agentProvider.mode.rawValue),
            "agentProviderEndpoint": .string(config.agentProvider.endpointLabel),
        ])

        let app = await AppBuilder.build(config: config, logger: logger)
        try await app.runService()
    }
}
