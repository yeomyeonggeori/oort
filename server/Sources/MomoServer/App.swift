import AsyncHTTPClient
import Foundation
import Hummingbird
import JWTKit
import Logging
import MomoMetrics
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
        let driveBackend = await DriveBackendFactory.make(
            environmentName: config.momoEnvironment,
            environment: ProcessInfo.processInfo.environment,
            httpClient: httpClient
        )
        let driveArchive = await ArchiveClientFactory.make(
            environmentName: config.momoEnvironment,
            environment: ProcessInfo.processInfo.environment,
            httpClient: httpClient,
            stubBaseURL: ProcessInfo.processInfo.environment["MOMO_DRIVE_ARCHIVE_STUB_BASE_URL"]
                ?? "http://127.0.0.1:\(config.port)"
        )
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
        router.add(middleware: SecretRedactingRequestLogMiddleware(.info))
        // MOMO-605 / ADR-0133 P2 CORS allowlist. Mounted ONLY when
        // MOMO_CORS_ALLOWED_ORIGINS names at least one valid origin, so the
        // default (unset/empty) deployment keeps byte-identical responses.
        // Placed outside the rate limiter so a 429 still carries the CORS
        // header (otherwise the browser sees an opaque network error) and an
        // allowlisted preflight short-circuits before spending limiter budget.
        if !config.cors.rejectedEntries.isEmpty {
            logger.warning(
                """
                \(CORSConfig.environmentKey): ignoring invalid entries — wildcards, \
                'null', and malformed origins are refused, so the allowlist can only \
                get narrower, never wider
                """,
                metadata: [
                    "rejected": .string(config.cors.rejectedEntries.joined(separator: " ")),
                ]
            )
        }
        if config.cors.isEnabled {
            router.add(middleware: OriginAllowlistCORSMiddleware(
                allowedOrigins: config.cors.allowedOrigins
            ))
            logger.info(
                "CORS origin allowlist active (exact match, no credentials, no wildcard)",
                metadata: [
                    "origins": .string(config.cors.allowedOrigins.joined(separator: " ")),
                ]
            )
        }
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
        let attachmentRoutes = AttachmentRoutes(db: db, archive: driveArchive)
        if driveArchive.acceptsStubUploads {
            attachmentRoutes.addStubUpload(to: router)
        }
        let workHostRoutes = WorkHostRoutes(db: db)
        workHostRoutes.addPublic(to: router)

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
            .add(middleware: AuthMiddleware(
                jwt: jwt,
                tokenStore: tokenStore,
                workHostAuthenticator: WorkHostAuthenticator(db: db)
            ))
            .add(middleware: MemberRateLimitMiddleware(
                limiter: rateLimiter, config: config.rateLimit, db: db, logger: logger
            ))
        authRoutes.addProtected(to: authed)
        MessageRoutes(db: db, agentGateway: config.agentGateway).add(to: authed)
        ContextPacketRoutes(db: db).add(to: authed)
        WorkSessionRoutes(db: db).add(to: authed)
        TerminalAttachRoutes(db: db).add(to: authed)
        WorkPoolRoutes(db: db).add(to: authed)
        WorkControlRoutes(db: db).add(to: authed)
        WorkToolProfileRoutes(db: db).add(to: authed)
        WorkTierPolicyRoutes(db: db).add(to: authed)
        workHostRoutes.addProtected(to: authed)
        SearchRoutes(db: db, limiter: rateLimiter).add(to: authed)
        AgentRunRoutes(db: db, agentGateway: config.agentGateway).add(to: authed)
        AgentRoutes(
            db: db,
            environmentName: config.momoEnvironment,
            allowLocalLoopback: config.agentProvider.allowLocalLoopback
        ).add(to: authed)
        AgentProfileRoutes(db: db).add(to: authed)
        // MOMO-572 / ADR-0004 증보 1: operator provider-link control plane.
        ProviderLinkRoutes(
            db: db,
            environmentName: config.momoEnvironment,
            allowLocalLoopback: config.agentProvider.allowLocalLoopback,
            providerLinkMasterKey: config.providerLinkMasterKey,
            envProvider: config.agentProvider,
            healthProbe: HTTPProviderHealthProbe(httpClient: httpClient, logger: logger),
            platformAdminEmails: config.platformAdminEmails
        ).add(to: authed)
        // MOMO-582 / ADR-0114 증보1 B: per-workspace work host engine selection.
        WorkHostEngineRoutes(db: db).add(to: authed)
        // MOMO-621 / ADR-0134 D2: provider×model effort table (routing picker SoT).
        ProviderEffortTableRoutes().add(to: authed)
        let allowAgentCardHTTP = config.momoEnvironment.lowercased() == "local"
            && ProcessInfo.processInfo.environment["MOMO_AGENT_CARD_ALLOW_HTTP"] == "1"
        AgentCardRoutes(
            db: db,
            fetcher: SafeAgentCardFetcher(
                resolver: SystemAgentCardHostResolver(),
                transport: AsyncAgentCardHTTPTransport(),
                allowDevelopmentHTTP: allowAgentCardHTTP
            )
        ).add(to: authed)
        EventSubscriptionRoutes(
            db: db,
            signingMasterKey: config.outboundWebhookMasterKey,
            urlValidator: SystemEventSubscriptionURLValidator(
                resolver: SystemAgentCardHostResolver(),
                allowDevelopmentHTTP: config.momoEnvironment.lowercased() == "local"
                    && ProcessInfo.processInfo.environment["MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP"] == "1"
            )
        ).add(to: authed)
        AgentCredentialRoutes(db: db).add(to: authed)
        WorkspaceRoutes(
            db: db, platformAdminEmails: config.platformAdminEmails
        ).add(to: authed)
        RosterRoutes(db: db).add(to: authed)
        ChannelRoutes(db: db).add(to: authed)
        MemberLifecycleRoutes(db: db).add(to: authed)
        AuditRoutes(db: db).add(to: authed)
        DMRoutes(db: db).add(to: authed)
        ReadStateRoutes(db: db).add(to: authed)
        CostProjectionRoutes(db: db).add(to: authed)
        UsageSummaryRoutes(db: db).add(to: authed)
        ApprovalDecisionRoutes(db: db).add(to: authed)
        InviteRoutes(db: db).add(to: authed)
        InboundMCPRoutes(db: db).add(to: authed)
        PlatformAdminRoutes(db: db).add(to: authed)
        DeviceRoutes(db: db).add(to: authed)
        HuddleRoutes(db: db, liveKit: config.liveKit).add(to: authed)
        PluginRoutes(db: db).add(to: authed)
        DriveMCPRoutes(db: db, backend: driveBackend).add(to: authed)
        let memoryQueryEmbedding: any MemoryQueryEmbedding
        if config.agentProvider.mode == .externalHermes {
            memoryQueryEmbedding = HermesMemoryQueryEmbedding(
                httpClient: httpClient,
                baseURL: config.agentProvider.hermesBaseURL,
                apiKey: config.agentProvider.hermesAPIKey,
                model: ProcessInfo.processInfo.environment["MEMORY_EMBEDDING_MODEL"]
                    ?? "text-embedding-3-small"
            )
        } else {
            memoryQueryEmbedding = MockMemoryQueryEmbedding()
        }
        MemoryRoutes(
            db: db,
            limiter: rateLimiter,
            queryEmbedding: memoryQueryEmbedding,
            providerTrust: config.agentProvider.memoryProviderTrust,
            providerEndpointLabel: config.agentProvider.endpointLabel
        ).add(to: authed)
        attachmentRoutes.addProtected(to: authed)
        let webhookRoutes = WebhookRoutes(db: db, signingMasterKey: config.jwtHMAC)
        webhookRoutes.addPublic(to: router)
        webhookRoutes.addProtected(to: authed)

        // ---- Application ----
        // The PostgresClient is a ServiceLifecycle.Service; hand it to the app's
        // ServiceGroup so its run() drives the pool and shuts down gracefully.
        var services: [any Service] = [db.client]
        if DatabaseSecurityPosture.requiresBootGuard(
            environmentName: config.momoEnvironment
        ) {
            services.append(DatabaseSecurityPostureService(database: db, logger: logger))
        }
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

        let metrics = MetricsRegistry.api()
        let metricsEndpoint = MetricsEndpointConfig.load(defaultPort: 9090)
        app.addServices(MetricsHTTPServer.build(
            registry: metrics,
            host: metricsEndpoint.host,
            port: metricsEndpoint.port,
            serviceName: "MomoServer",
            logger: logger
        ))
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
