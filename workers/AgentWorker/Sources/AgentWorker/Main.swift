import AsyncHTTPClient
import Foundation
import Logging
import PostgresNIO
import ServiceLifecycle

/// Entry point for the agent worker (L4 §1.1 / §3.5 / §6.2 / §9.3).
///
/// Wires the supervised PostgresClient pool + the hermes transport + the
/// Centrifugo client + the worker drain loop into a ServiceLifecycle ServiceGroup
/// with graceful shutdown on SIGTERM/SIGINT. The worker connects as the BYPASSRLS
/// `momo_relay` role family so it claims `agent_job` rows across all tenants
/// (L4 §2.2 / §10.1).
///
/// runtime-unverified (no docker/psql/hermes): the build env has no PostgreSQL 18 /
/// Centrifugo v6 / hermes gateway, so the worker boots but cannot claim/call/publish
/// here. `swift build` is the verification gate for this package.
@main
struct AgentWorkerMain {
    static func main() async throws {
        var logger = Logger(label: "AgentWorker")
        logger.logLevel =
            ProcessInfo.processInfo.environment["LOG_LEVEL"]
                .flatMap { Logger.Level(rawValue: $0) } ?? .info

        let config = Config.load()
        try config.validateAgentProviderForBoot()
        logger.info("starting AgentWorker", metadata: [
            "pgHost": .string(config.pgHost),
            "pgDatabase": .string(config.pgDatabase),
            "pgUser": .string(config.pgUser),
            "centAPIURL": .string(config.centAPIURL),
            "momoEnvironment": .string(config.momoEnvironment),
            "agentProviderMode": .string(config.agentProviderMode.rawValue),
            "agentProviderEndpoint": .string(config.agentProviderEndpointLabel),
            "agentAvailability": .string(config.agentAvailability),
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

        // ---- AsyncHTTPClient → hermes (/v1/chat/completions SSE) + Centrifugo ----
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let hermes = HermesTransport(
            httpClient: httpClient,
            baseURL: config.hermesBaseURL,
            apiKey: config.hermesAPIKey,
            logger: logger
        )
        let centrifugo = CentrifugoClient(
            httpClient: httpClient,
            apiURL: config.centAPIURL,
            apiKey: config.centAPIKey,
            logger: logger
        )
        let workControls = WorkControlClient(
            httpClient: httpClient,
            baseURL: config.momoAPIURL,
            agentToken: config.momoAgentToken,
            targetHostID: config.momoWorkHostID,
            logger: logger
        )

        let guards = LoopGuards(config: config, logger: logger)
        let cost = CostAccounting(pg: pg, logger: logger)

        let worker = WorkerService(
            pg: pg, hermes: hermes, centrifugo: centrifugo,
            workControls: workControls, guards: guards, cost: cost,
            config: config, logger: logger)
        let memoryExtractor: any MemoryExtracting = config.agentProviderMode == .externalHermes
            ? HermesMemoryExtractor(hermes: hermes)
            : MockMemoryExtractor()
        let memoryWorker = MemoryExtractionService(
            pg: pg,
            extractor: memoryExtractor,
            pollInterval: config.memoryExtractionPollInterval,
            batchSize: config.memoryExtractionBatchSize,
            logger: logger
        )
        let memoryEmbeddingProvider: any MemoryEmbeddingProvider =
            config.agentProviderMode == .externalHermes
            ? HermesMemoryEmbeddingProvider(
                httpClient: httpClient,
                baseURL: config.hermesBaseURL,
                apiKey: config.hermesAPIKey,
                model: config.memoryEmbeddingModel
            )
            : MockMemoryEmbeddingProvider()
        let memoryEmbeddingWorker = MemoryEmbeddingService(
            pg: pg,
            provider: memoryEmbeddingProvider,
            pollInterval: config.memoryEmbeddingPollInterval,
            batchSize: config.memoryEmbeddingBatchSize,
            logger: logger
        )

        // ServiceGroup ordering: PostgresClient.run() must be live before the worker
        // issues queries; the HTTP client shutdown service tears down on cancel.
        var services: [ServiceGroupConfiguration.ServiceConfiguration] = [
            .init(service: pg),
            .init(service: worker),
            .init(service: HTTPClientShutdownService(httpClient: httpClient)),
        ]
        if config.memoryExtractionEnabled {
            services.insert(.init(service: memoryWorker), at: 2)
        } else {
            logger.info("memory extraction worker disabled")
        }
        if config.memoryEmbeddingEnabled {
            services.insert(.init(service: memoryEmbeddingWorker), at: min(3, services.count))
        } else {
            logger.info("memory embedding worker disabled")
        }
        let group = ServiceGroup(
            configuration: .init(
                services: services,
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
