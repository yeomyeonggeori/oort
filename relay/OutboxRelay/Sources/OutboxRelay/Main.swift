import AsyncHTTPClient
import Foundation
import Logging
import PostgresNIO
import ServiceLifecycle

/// Entry point for the outbox relay (L4 §1.1 / §8.1 / §9.3).
///
/// Wires the supervised PostgresClient pool + the relay drain loop into a
/// ServiceLifecycle ServiceGroup with graceful shutdown on SIGTERM/SIGINT.
/// The relay connects as the BYPASSRLS `momo_relay` role so it polls the
/// `outbox` across all tenants (L4 §2.2 / §10.1).
///
/// runtime-unverified (no docker/psql): the build env has no PostgreSQL 18 /
/// Centrifugo v6, so the relay boots but cannot claim/publish here.
/// `swift build` is the verification gate for this package.
@main
struct OutboxRelayMain {
    static func main() async throws {
        var logger = Logger(label: "OutboxRelay")
        logger.logLevel =
            ProcessInfo.processInfo.environment["LOG_LEVEL"]
                .flatMap { Logger.Level(rawValue: $0) } ?? .info

        let config = Config.load()
        logger.info("starting OutboxRelay", metadata: [
            "pgHost": .string(config.pgHost),
            "pgDatabase": .string(config.pgDatabase),
            "pgUser": .string(config.pgUser),
            "centAPIURL": .string(config.centAPIURL),
        ])

        // ---- PostgreSQL pool (SoT access; BYPASSRLS role) ----
        // TLS disabled for v0 single-host docker-compose (private network); enable
        // for any non-loopback / multi-host deploy.
        let pgConfig = PostgresClient.Configuration(
            host: config.pgHost,
            port: config.pgPort,
            username: config.pgUser,
            password: config.pgPassword,
            database: config.pgDatabase,
            tls: .disable
        )
        let pg = PostgresClient(configuration: pgConfig, backgroundLogger: logger)

        // ---- AsyncHTTPClient → Centrifugo /api/publish ----
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let centrifugo = CentrifugoClient(
            httpClient: httpClient,
            apiURL: config.centAPIURL,
            apiKey: config.centAPIKey,
            logger: logger
        )

        let relay = RelayService(
            pg: pg, centrifugo: centrifugo, config: config, logger: logger)

        // ServiceGroup ordering: PostgresClient.run() must be live before the relay
        // issues queries; the HTTP client shutdown service tears down on cancel.
        let group = ServiceGroup(
            configuration: .init(
                services: [
                    .init(service: pg),
                    .init(service: relay),
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
