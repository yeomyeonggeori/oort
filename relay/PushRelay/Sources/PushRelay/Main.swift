import AsyncHTTPClient
import Foundation
import Hummingbird
import Logging
import MomoMetrics

@main
struct PushRelayMain {
    static func main() async throws {
        var logger = Logger(label: "PushRelay")
        logger.logLevel = ProcessInfo.processInfo.environment["LOG_LEVEL"]
            .flatMap(Logger.Level.init(rawValue:)) ?? .info
        // A configuration refusal is an operator message, not a crash trace.
        // The relay restart-loops under compose when it cannot boot, so the one
        // line that explains why has to survive `docker logs` legibly — a Swift
        // top-level `fatalError` backtrace does not. 78 is EX_CONFIG.
        let config: RelayConfig
        do {
            config = try RelayConfig.load()
        } catch let error as ConfigError {
            FileHandle.standardError.write(Data("PushRelay refused to start — \(error)\n".utf8))
            exit(78)
        }
        let metrics = await MetricsRegistry.pushRelay()

        let httpClient: HTTPClient?
        let sender: any APNSSender
        switch config.senderMode {
        case .stub:
            httpClient = nil
            sender = StubAPNSSender(
                status: config.stubStatus,
                reason: config.stubReason,
                capturePath: config.stubCapturePath
            )
        case .live:
            var clientConfiguration = HTTPClient.Configuration()
            // APNs requires HTTP/2. AHC's automatic mode negotiates h2 via
            // ALPN for the HTTPS APNs endpoints (and pools that connection).
            clientConfiguration.httpVersion = .automatic
            let client = HTTPClient(
                eventLoopGroupProvider: .singleton,
                configuration: clientConfiguration
            )
            httpClient = client
            sender = try LiveAPNSSender(
                httpClient: client,
                environment: config.apnsEnvironment!,
                keyPath: config.apnsKeyPath!,
                keyID: config.apnsKeyID!,
                teamID: config.apnsTeamID!
            )
        }

        logger.info("starting PushRelay", metadata: [
            "host": .string(config.host),
            "port": .stringConvertible(config.port),
            "registeredServers": .stringConvertible(config.servers.count),
            "rateLimitPerMinute": .stringConvertible(config.rateLimitPerMinute),
            "senderMode": .string(config.senderMode.rawValue),
        ])
        let app = PushRelayApp.build(
            config: config,
            sender: sender,
            metrics: metrics,
            logger: logger
        )
        do {
            try await app.runService()
        } catch {
            try? await httpClient?.shutdown()
            throw error
        }
        try? await httpClient?.shutdown()
    }
}
