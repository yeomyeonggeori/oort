import AsyncHTTPClient
import Foundation
import Logging
import PostgresNIO
import ServiceLifecycle

/// Entry point for the push notifier worker (MOMO-404, ADR-0120 P-2).
///
/// Wires the supervised PostgresClient pool + the notifier drain loop into a
/// ServiceLifecycle ServiceGroup with graceful shutdown on SIGTERM/SIGINT —
/// the same supervision shape as relay/OutboxRelay. The notifier connects as
/// the BYPASSRLS `momo_notifier` role so it polls push_candidate rows across
/// all tenants (infra/e2e/bootstrap_roles.sql).
@main
struct NotifierWorkerMain {
    static func main() async throws {
        var logger = Logger(label: "NotifierWorker")
        logger.logLevel =
            ProcessInfo.processInfo.environment["LOG_LEVEL"]
                .flatMap { Logger.Level(rawValue: $0) } ?? .info

        let config = Config.load()
        logger.info("starting NotifierWorker", metadata: [
            "pgHost": .string(config.pgHost),
            "pgDatabase": .string(config.pgDatabase),
            "pgUser": .string(config.pgUser),
            "pushRelayURL": .string(config.pushRelayURL),
        ])

        // ---- PostgreSQL pool (SoT access; BYPASSRLS role) ----
        // TLS disabled for v0 single-host docker-compose (private network);
        // enable for any non-loopback / multi-host deploy.
        let pgConfig = PostgresClient.Configuration(
            host: config.pgHost,
            port: config.pgPort,
            username: config.pgUser,
            password: config.pgPassword,
            database: config.pgDatabase,
            tls: .disable
        )
        let pg = PostgresClient(configuration: pgConfig, backgroundLogger: logger)

        // ---- AsyncHTTPClient → push relay dispatch ----
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let requestSigner = try config.pushRelayPrivateKeyPath.map {
            try PushRelayRequestSigner(path: $0)
        }
        let relay = PushRelayClient(
            httpClient: httpClient,
            dispatchURL: config.pushRelayURL,
            logger: logger,
            serverID: config.serverID,
            requestSigner: requestSigner
        )

        let notifier = NotifierService(
            pg: pg, relay: relay, config: config, logger: logger)

        let group = ServiceGroup(
            configuration: .init(
                services: [
                    .init(service: pg),
                    .init(service: notifier),
                    .init(service: HTTPClientShutdownService(httpClient: httpClient)),
                ],
                gracefulShutdownSignals: [.sigterm, .sigint],
                logger: logger
            )
        )
        try await group.run()
    }
}

/// Wraps the AsyncHTTPClient lifetime so it shuts down with the ServiceGroup.
struct HTTPClientShutdownService: Service {
    let httpClient: HTTPClient
    func run() async throws {
        try? await gracefulShutdown()
        try? await httpClient.shutdown()
    }
}
