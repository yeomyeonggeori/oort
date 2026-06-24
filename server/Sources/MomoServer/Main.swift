import Foundation
import Hummingbird
import Logging

/// Entry point for the momo API server (L4 §1.1 / §9.3).
///
/// Loads config from the environment, builds the Hummingbird application (router +
/// middleware + supervised PostgresClient pool), and runs it under a ServiceGroup
/// with graceful shutdown on SIGTERM/SIGINT.
///
/// runtime-unverified (no docker/psql): the build env has no PostgreSQL 18 /
/// Centrifugo v6, so the server boots but cannot serve DB-backed routes here.
/// `swift build` is the verification gate for this package.
@main
struct MomoServerMain {
    static func main() async throws {
        var logger = Logger(label: "MomoServer")
        logger.logLevel =
            ProcessInfo.processInfo.environment["LOG_LEVEL"]
                .flatMap { Logger.Level(rawValue: $0) } ?? .info

        let config = Config.load()
        logger.info("starting MomoServer", metadata: [
            "host": .string(config.host),
            "port": .stringConvertible(config.port),
            "pgHost": .string(config.pgHost),
            "pgDatabase": .string(config.pgDatabase),
        ])

        let app = await AppBuilder.build(config: config, logger: logger)
        try await app.runService()
    }
}
