import AsyncHTTPClient
import Foundation
import Hummingbird
import JWTKit
import Logging
import PostgresNIO
import ServiceLifecycle

/// Builds the Hummingbird `Application` with all routes, middleware, and the
/// supervised background services (the PostgresClient pool).
///
/// L4 §1.1: stateless API host = REST + JWT issue + Centrifugo publish +
/// subscribe proxy. Topology pieces that aren't running in this build env
/// (Postgres, Centrifugo) are wired but runtime-unverified.
enum AppBuilder {
    static func build(config: Config, logger: Logger) async -> some ApplicationProtocol {
        let db = Database(config: config, logger: logger)
        let jwt = await JWTService(config: config)

        // AsyncHTTPClient powers the CentrifugoClient (server publishes, L4 §4.3).
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let centrifugo = CentrifugoClient(
            httpClient: httpClient,
            apiURL: config.centAPIURL,
            apiKey: config.centAPIKey,
            logger: logger
        )
        // `centrifugo` is held for the server-initiated publish path; in v0 the
        // relay package owns the hot publish loop, so it may be unused here.
        _ = centrifugo

        // ---- Router ----
        let router = Router(context: AppRequestContext.self)
        router.add(middleware: LogRequestsMiddleware(.info))

        // Public routes (no auth): health, login, centrifugo subscribe proxy.
        router.get("/health") { _, _ -> HealthResponse in
            HealthResponse(status: "ok", service: "MomoServer")
        }
        AuthRoutes(db: db, jwt: jwt).add(to: router)
        CentrifugoRoutes(db: db).add(to: router)

        // Protected routes (require valid access token) — mounted in a group that
        // applies AuthMiddleware. The message read/write path lives here.
        let authed = router.group()
            .add(middleware: AuthMiddleware(jwt: jwt))
        MessageRoutes(db: db).add(to: authed)

        // ---- Application ----
        // The PostgresClient is a ServiceLifecycle.Service; hand it to the app's
        // ServiceGroup so its run() drives the pool and shuts down gracefully.
        var app = Application(
            router: router,
            configuration: .init(
                address: .hostname(config.host, port: config.port),
                serverName: "MomoServer"
            ),
            services: [db.client],
            logger: logger
        )

        // Close the shared HTTP client on shutdown (best-effort).
        app.addServices(HTTPClientShutdownService(httpClient: httpClient))
        return app
    }
}

/// Wraps the AsyncHTTPClient lifetime so it shuts down with the ServiceGroup.
struct HTTPClientShutdownService: Service {
    let httpClient: HTTPClient
    func run() async throws {
        // Stay alive until cancelled, then shut the client down.
        try? await gracefulShutdown()
        try? await httpClient.shutdown()
    }
}
