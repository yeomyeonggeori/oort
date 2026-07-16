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
        // MOMO-300 per-IP rate limit — applies to public + protected routes
        // (excludes /health and the shared-secret-authenticated subscribe proxy).
        let rateLimiter = SlidingWindowRateLimiter()
        router.add(middleware: IPRateLimitMiddleware(
            limiter: rateLimiter, config: config.rateLimit, logger: logger
        ))

        // Public routes (no auth): health, login, join, centrifugo subscribe proxy.
        router.get("/health") { _, _ -> HealthResponse in
            HealthResponse(
                status: "ok",
                service: "MomoServer",
                agentRuntime: config.agentRuntimeStatusResponse()
            )
        }
        router.get("/v1/agent-runtime/status") { _, _ -> AgentRuntimeStatusResponse in
            config.agentRuntimeStatusResponse()
        }
        let tokenStore = TokenStore(db: db)
        let authRoutes = AuthRoutes(
            db: db,
            jwt: jwt,
            tokenStore: tokenStore,
            platformAdminEmails: config.platformAdminEmails,
            platformAdminLoginSecret: config.platformAdminLoginSecret,
            realtimeWebSocketURL: config.realtimeWebSocketURL
        )
        authRoutes.add(to: router)
        JoinRoutes(
            db: db,
            jwt: jwt,
            tokenStore: tokenStore,
            realtimeWebSocketURL: config.realtimeWebSocketURL
        ).add(to: router)
        CentrifugoRoutes(
            db: db, tokenStore: tokenStore, proxySecret: config.centProxySecret
        ).add(to: router)

        // Gateway callbacks accept per-agent bearer credentials. The shared
        // secret is available only on this narrow group and only when the
        // explicit migration flag is enabled.
        let gatewayAuthed = router.group()
            .add(middleware: AuthMiddleware(
                jwt: jwt,
                tokenStore: tokenStore,
                legacyGatewayConfig: config.agentGateway
            ))
            .add(middleware: MemberRateLimitMiddleware(
                limiter: rateLimiter, config: config.rateLimit, db: db, logger: logger
            ))
        AgentGatewayRoutes(db: db, config: config.agentGateway).add(to: gatewayAuthed)

        // Protected routes (require valid access token) — mounted in a group that
        // applies AuthMiddleware (JWT + MOMO-300 revocation check), then the
        // per-member rate limit (needs the authenticated principal).
        let authed = router.group()
            .add(middleware: AuthMiddleware(jwt: jwt, tokenStore: tokenStore))
            .add(middleware: MemberRateLimitMiddleware(
                limiter: rateLimiter, config: config.rateLimit, db: db, logger: logger
            ))
        authRoutes.addProtected(to: authed)
        MessageRoutes(db: db, agentGateway: config.agentGateway).add(to: authed)
        AgentRunRoutes(db: db, agentGateway: config.agentGateway).add(to: authed)
        AgentCredentialRoutes(db: db).add(to: authed)
        WorkspaceRoutes(db: db).add(to: authed)
        RosterRoutes(db: db).add(to: authed)
        ChannelRoutes(db: db).add(to: authed)
        DMRoutes(db: db).add(to: authed)
        ReadStateRoutes(db: db).add(to: authed)
        CostProjectionRoutes(db: db).add(to: authed)
        ApprovalDecisionRoutes(db: db).add(to: authed)
        InviteRoutes(db: db).add(to: authed)
        InboundMCPRoutes(db: db).add(to: authed)
        PlatformAdminRoutes(db: db).add(to: authed)
        DeviceRoutes(db: db).add(to: authed)
        PluginRoutes(db: db).add(to: authed)

        // ---- Application ----
        // The PostgresClient is a ServiceLifecycle.Service; hand it to the app's
        // ServiceGroup so its run() drives the pool and shuts down gracefully.
        var services: [any Service] = [db.client]
        if let platformReadClient = db.platformReadClient {
            services.append(platformReadClient)
        }

        var app = Application(
            router: router,
            configuration: .init(
                address: .hostname(config.host, port: config.port),
                serverName: "MomoServer"
            ),
            services: services,
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
