import Foundation

/// Server configuration loaded from environment variables.
///
/// Core keys match `infra/.env.example` so a single `.env` drives compose,
/// migration, and this server. Core services retain dev-safe defaults for
/// local smoke; optional feature credentials (LiveKit) remain nil and their
/// routes fail closed until explicitly configured.
struct Config: Sendable {
    // ---- HTTP server bind ----
    var host: String
    var port: Int

    // ---- PostgreSQL (SoT, L4 §1.2) ----
    var pgHost: String
    var pgPort: Int
    var pgUser: String
    var pgPassword: String
    var pgDatabase: String

    // ---- JWT (App access/refresh, HS256, L4 §7.1) ----
    var jwtHMAC: String
    var accessTokenTTL: TimeInterval   // 15m per spec
    var refreshTokenTTL: TimeInterval  // 30d per spec

    // ---- Centrifugo (transport, L4 §4) ----
    var centAPIURL: String   // e.g. http://centrifugo:8000/api
    var centAPIKey: String   // X-API-Key for POST /api/publish
    var realtimeWebSocketURL: String // public ws(s) endpoint advertised to app sessions
    var centTokenHMAC: String // connection/subscription JWT signing (HMAC)
    var centConnectionTokenTTL: TimeInterval // short-lived client connection token
    // Shared secret Centrifugo attaches to subscribe-proxy callbacks
    // (`X-Centrifugo-Proxy-Secret` static header, MOMO-300). The API rejects
    // proxy requests that do not present this value.
    var centProxySecret: String

    // ---- LiveKit huddles (ADR-0122 V-1) ----
    // Optional as a unit: HuddleRoutes fails closed with 503 unless all three
    // values are present and the public URL is valid.
    var liveKit: LiveKitConfig?

    // ---- Rate limiting (MOMO-300, in-memory sliding window, single node) ----
    var rateLimit: RateLimitConfig

    // ---- Platform admin read-only inspection (MOMO-013) ----
    var platformAdminDatabaseURL: String?
    var platformAdminEmails: [String]
    var platformAdminLoginSecret: String?

    // ---- Local Hermes provider boundary (MOMO-256) ----
    var momoEnvironment: String
    var agentProvider: AgentProviderConfig

    // ---- Hermes gateway native platform adapter (MOMO-325) ----
    var agentGateway: AgentGatewayConfig

    /// Read an env var, falling back to `default`.
    private static func env(_ key: String, _ fallback: String) -> String {
        ProcessInfo.processInfo.environment[key] ?? fallback
    }

    private static func envInt(_ key: String, _ fallback: Int) -> Int {
        ProcessInfo.processInfo.environment[key].flatMap(Int.init) ?? fallback
    }

    /// Parse a `postgres://user:pass@host:port/db` URL into components, if present.
    /// `infra/.env.example` exposes DATABASE_URL — we prefer it, then fall back to
    /// the discrete POSTGRES_* vars, then to dev defaults.
    static func load() -> Config {
        let pg = parseDatabaseURL(ProcessInfo.processInfo.environment["DATABASE_URL"])

        return Config(
            host: env("HOST", "0.0.0.0"),
            port: envInt("PORT", 8080),
            pgHost: pg?.host ?? env("POSTGRES_HOST", "localhost"),
            pgPort: pg?.port ?? envInt("POSTGRES_PORT", 5432),
            pgUser: pg?.user ?? env("POSTGRES_USER", "momo"),
            pgPassword: pg?.password ?? env("POSTGRES_PASSWORD", "momo"),
            pgDatabase: pg?.database ?? env("POSTGRES_DB", "momo"),
            jwtHMAC: env("JWT_HMAC", "dev-insecure-jwt-hmac-change-me"),
            accessTokenTTL: 15 * 60,
            refreshTokenTTL: 30 * 24 * 60 * 60,
            centAPIURL: env("CENT_API_URL", "http://localhost:8000/api"),
            centAPIKey: env("CENT_API_KEY", "dev-insecure-cent-api-key"),
            realtimeWebSocketURL: realtimeWebSocketURL(
                environment: ProcessInfo.processInfo.environment
            ),
            centTokenHMAC: env("CENT_TOKEN_HMAC", "dev-insecure-cent-token-hmac"),
            centConnectionTokenTTL: TimeInterval(
                clampedCentConnectionTokenTTL(
                    envInt("CENT_CONNECTION_TOKEN_TTL_SECONDS", 5 * 60)
                )
            ),
            centProxySecret: env("CENT_PROXY_SECRET", "dev-insecure-cent-proxy-secret"),
            liveKit: LiveKitConfig.load(environment: ProcessInfo.processInfo.environment),
            rateLimit: RateLimitConfig.load(environment: ProcessInfo.processInfo.environment),
            platformAdminDatabaseURL: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_DATABASE_URL"],
            platformAdminEmails: env("PLATFORM_ADMIN_EMAILS", "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty },
            platformAdminLoginSecret: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_LOGIN_SECRET"]
                .flatMap { $0.isEmpty ? nil : $0 },
            momoEnvironment: env("MOMO_ENV", "local"),
            agentProvider: AgentProviderConfig.load(environment: ProcessInfo.processInfo.environment),
            agentGateway: AgentGatewayConfig.load(environment: ProcessInfo.processInfo.environment)
        )
    }

    /// Keep realtime connection JWTs short-lived. The upper bound is the
    /// MOMO-179 contract (`exp <= 30m`), while the lower bound avoids accidental
    /// zero/negative dev env values that would make every connect fail.
    static func clampedCentConnectionTokenTTL(_ seconds: Int) -> Int {
        min(max(seconds, 60), 30 * 60)
    }

    /// Public endpoint returned with login/join sessions. The API URL remains
    /// compose-internal; clients must never derive their WebSocket endpoint from it.
    static func realtimeWebSocketURL(environment: [String: String]) -> String {
        if let raw = environment["MOMO_CENTRIFUGO_WS_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           let url = URL(string: raw),
           url.scheme == "ws" || url.scheme == "wss",
           url.host != nil
        {
            return url.absoluteString
        }
        let port = environment["CENT_PORT"].flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil } ?? 8000
        return "ws://127.0.0.1:\(port)/connection/websocket"
    }

    /// MOMO-300 fail-fast: in strict environments (staging/prod/internal-host)
    /// the Centrifugo subscribe-proxy shared secret must be configured with a
    /// real value. A missing/placeholder secret would either let anyone spoof
    /// proxy callbacks (if we skipped verification) or silently deny every
    /// subscribe (if Centrifugo sends the placeholder) — both are boot errors.
    /// `scripts/prod_env_preflight.sh` enforces the same contract pre-compose.
    func validateSecurityForBoot() throws {
        if agentGateway.enabled
            && agentGateway.allowLegacySecret
            && !agentGateway.secretConfigured
        {
            throw SecurityConfigurationError(errors: [
                "AGENT_GATEWAY_SECRET is required when MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1"
            ])
        }
        guard AgentProviderConfig.requiresStrictExternalProvider(momoEnvironment) else {
            return
        }
        if AgentProviderConfig.isUnsafeSecret(centProxySecret) {
            throw SecurityConfigurationError(errors: [
                "CENT_PROXY_SECRET is missing or uses a placeholder/dev value in \(momoEnvironment)"
            ])
        }
    }

    func agentRuntimeStatusResponse() -> AgentRuntimeStatusResponse {
        guard agentGateway.enabled else {
            return agentProvider.statusResponse()
        }

        let diagnostics = agentGateway.allowLegacySecret && !agentGateway.secretConfigured
            ? ["AGENT_GATEWAY_SECRET is required when MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1"]
            : []
        let availability = diagnostics.isEmpty ? "available" : "degraded"
        return AgentRuntimeStatusResponse(
            schema: "momo.agent_runtime.status.v0",
            agentHandle: agentProvider.agentHandle,
            displayName: agentProvider.displayName,
            mode: agentGateway.mode.rawValue,
            availability: availability,
            model: agentProvider.model,
            endpointLabel: "Hermes gateway platform adapter",
            keyConfigured: !agentGateway.allowLegacySecret || agentGateway.secretConfigured,
            degradedReason: diagnostics.isEmpty ? nil : diagnostics.joined(separator: "; "),
            diagnostics: diagnostics
        )
    }

    /// Minimal `postgres://` URL parser (no extra deps). Returns nil if unparseable.
    private static func parseDatabaseURL(
        _ raw: String?
    ) -> (host: String, port: Int, user: String, password: String, database: String)? {
        guard let raw, let comps = URLComponents(string: raw),
              let host = comps.host
        else { return nil }
        let db = comps.path.hasPrefix("/") ? String(comps.path.dropFirst()) : comps.path
        return (
            host: host,
            port: comps.port ?? 5432,
            user: comps.user ?? "momo",
            password: comps.password ?? "",
            database: db.isEmpty ? "momo" : db
        )
    }
}

struct LiveKitConfig: Sendable, Equatable {
    let apiKey: String
    let apiSecret: String
    let url: String

    static func load(environment: [String: String]) -> LiveKitConfig? {
        func value(_ key: String) -> String? {
            guard let raw = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty
            else { return nil }
            return raw
        }

        guard let apiKey = value("MOMO_LIVEKIT_API_KEY"),
              let apiSecret = value("MOMO_LIVEKIT_API_SECRET"),
              let rawURL = value("MOMO_LIVEKIT_URL"),
              let components = URLComponents(string: rawURL),
              let scheme = components.scheme?.lowercased(),
              ["http", "https", "ws", "wss"].contains(scheme),
              components.host != nil
        else { return nil }

        return LiveKitConfig(apiKey: apiKey, apiSecret: apiSecret, url: rawURL)
    }
}

/// MOMO-300 request rate limiting knobs (per-member + per-IP).
///
/// v0 scope (documented, single-node): an **in-memory sliding-window** limiter
/// inside the API process. State is per-process — restarting the server resets
/// the windows and multiple API replicas do not share counters. `/health` and
/// the Centrifugo subscribe proxy (its own shared-secret auth, internal traffic
/// funnels through one IP) are excluded. Cost circuit breaking (budget_window)
/// is an independent axis and is untouched by these limits.
///
/// A limit of 0 disables that axis.
struct RateLimitConfig: Sendable {
    /// Sliding window length in seconds (default 60).
    var windowSeconds: Int
    /// Max requests per authenticated member per window (default 600).
    var perMemberLimit: Int
    /// Max requests per client IP per window (default 1200).
    var perIPLimit: Int

    static func load(environment: [String: String]) -> RateLimitConfig {
        RateLimitConfig(
            windowSeconds: max(1, intValue(environment["RATE_LIMIT_WINDOW_SECONDS"], fallback: 60)),
            perMemberLimit: max(0, intValue(environment["RATE_LIMIT_PER_MEMBER"], fallback: 600)),
            perIPLimit: max(0, intValue(environment["RATE_LIMIT_PER_IP"], fallback: 1200))
        )
    }

    private static func intValue(_ raw: String?, fallback: Int) -> Int {
        raw.flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? fallback
    }
}

enum AgentGatewayMode: String, Sendable {
    case worker = "worker"
    case gateway = "gateway"

    static func parse(_ raw: String?) -> AgentGatewayMode {
        guard let raw else { return .worker }
        return AgentGatewayMode(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
            ?? .worker
    }
}

/// MOMO-325 native Hermes gateway mode.
///
/// `worker` is the product default: AgentWorker claims `agent_job` outbox rows
/// and calls the OpenAI-compatible provider directly. `gateway` is the optional
/// Hermes platform-adapter path: the server still creates the authoritative
/// agent_run/context/budget/audit shell, publishes an `agent.job` notification to
/// the agent realtime channel, and accepts status/result callbacks through a
/// momo-owned REST endpoint.
struct AgentGatewayConfig: Sendable {
    var mode: AgentGatewayMode
    var secret: String
    var allowLegacySecret: Bool = false

    static func load(environment: [String: String]) -> AgentGatewayConfig {
        AgentGatewayConfig(
            mode: AgentGatewayMode.parse(environment["AGENT_GATEWAY_MODE"]),
            secret: environment["AGENT_GATEWAY_SECRET"] ?? "",
            allowLegacySecret: AgentProviderConfig.boolFlag(
                environment["MOMO_ALLOW_LEGACY_GATEWAY_SECRET"]
            )
        )
    }

    var enabled: Bool { mode == .gateway }

    var secretConfigured: Bool {
        !AgentProviderConfig.isUnsafeSecret(secret)
    }

    var legacySecretEnabled: Bool {
        enabled && allowLegacySecret && secretConfigured
    }
}

struct SecurityConfigurationError: Error, CustomStringConvertible {
    let errors: [String]

    var description: String {
        "invalid security config: \(errors.joined(separator: "; "))"
    }
}

enum AgentProviderMode: String, Sendable {
    case localMock = "local-mock"
    case internalHostMock = "internal-host-mock"
    case externalHermes = "external-hermes"

    static func parse(_ raw: String?) -> AgentProviderMode {
        guard let raw else { return .localMock }
        return AgentProviderMode(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
            ?? .localMock
    }
}

struct AgentProviderConfig: Sendable {
    var mode: AgentProviderMode
    var hermesBaseURL: String
    var hermesAPIKey: String
    var model: String
    var agentHandle: String
    var displayName: String
    var allowLocalLoopback: Bool

    static func load(environment: [String: String]) -> AgentProviderConfig {
        AgentProviderConfig(
            mode: AgentProviderMode.parse(environment["AGENT_PROVIDER_MODE"]),
            hermesBaseURL: environment["HERMES_BASE_URL"] ?? "http://localhost:8088/v1",
            hermesAPIKey: environment["HERMES_API_KEY"] ?? "dev-insecure-hermes-bearer",
            model: environment["AGENT_MODEL"] ?? "hermes-agent",
            agentHandle: environment["AGENT_HANDLE"] ?? "hermes",
            displayName: environment["AGENT_DISPLAY_NAME"] ?? "Hermes",
            allowLocalLoopback: Self.boolFlag(environment["AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK"])
        )
    }

    var endpointLabel: String {
        Self.redactedEndpointLabel(hermesBaseURL)
    }

    var keyConfigured: Bool {
        !hermesAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !Self.isUnsafeSecret(hermesAPIKey)
    }

    var availability: String {
        switch mode {
        case .localMock, .internalHostMock:
            return "mock"
        case .externalHermes:
            return validationErrors(strictEnvironment: true).isEmpty ? "available" : "degraded"
        }
    }

    func statusResponse() -> AgentRuntimeStatusResponse {
        let diagnostics = validationErrors(strictEnvironment: mode == .externalHermes)
        let currentAvailability = availability
        return AgentRuntimeStatusResponse(
            schema: "momo.agent_runtime.status.v0",
            agentHandle: agentHandle,
            displayName: displayName,
            mode: mode.rawValue,
            availability: currentAvailability,
            model: model,
            endpointLabel: endpointLabel,
            keyConfigured: keyConfigured,
            degradedReason: currentAvailability == "degraded" && !diagnostics.isEmpty
                ? diagnostics.joined(separator: "; ")
                : nil,
            diagnostics: diagnostics
        )
    }

    func validateForBoot(environmentName: String) throws {
        var errors: [String] = []
        let strictEnvironment = Self.requiresStrictExternalProvider(environmentName)
        if !strictEnvironment && mode != .externalHermes {
            return
        }
        if strictEnvironment && mode != .externalHermes {
            errors.append("AGENT_PROVIDER_MODE must be external-hermes in \(environmentName)")
        }
        errors += validationErrors(
            strictEnvironment: strictEnvironment,
            allowLocalLoopback: allowLocalLoopback && !strictEnvironment
        )
        if !errors.isEmpty {
            throw AgentProviderConfigurationError(errors: errors)
        }
    }

    func validationErrors(strictEnvironment: Bool, allowLocalLoopback: Bool? = nil) -> [String] {
        var errors: [String] = []
        let localLoopbackAllowed = allowLocalLoopback ?? self.allowLocalLoopback
        let trimmedURL = hermesBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedURL.isEmpty {
            errors.append("HERMES_BASE_URL is missing")
        } else if mode == .externalHermes || strictEnvironment {
            guard let url = URL(string: trimmedURL), let scheme = url.scheme, let host = url.host else {
                errors.append("HERMES_BASE_URL must be an absolute HTTP(S) URL")
                return errors + keyErrors()
            }
            let normalizedScheme = scheme.lowercased()
            let isLoopback = Self.isAllowedLoopbackHost(host)
            if normalizedScheme == "http" {
                if !(localLoopbackAllowed && isLoopback) {
                    errors.append("HERMES_BASE_URL must use https:// unless AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 targets localhost/127.0.0.1 in local mode")
                }
            } else if normalizedScheme != "https" {
                errors.append("HERMES_BASE_URL must use http:// or https://")
            }
            if Self.isMockHost(host) {
                errors.append("HERMES_BASE_URL must not point at mock-hermes for external-hermes")
            } else if Self.isLocalOrMockHost(host) && !(localLoopbackAllowed && isLoopback) {
                errors.append("HERMES_BASE_URL must not point at localhost for external-hermes unless AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 in local mode")
            }
        }
        errors += keyErrors()
        return errors
    }

    private func keyErrors() -> [String] {
        if hermesAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return ["HERMES_API_KEY is missing"]
        }
        if Self.isUnsafeSecret(hermesAPIKey) {
            return ["HERMES_API_KEY uses a placeholder/dev value"]
        }
        return []
    }

    static func requiresStrictExternalProvider(_ environmentName: String) -> Bool {
        switch environmentName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "staging", "prod", "production", "internal-host":
            return true
        default:
            return false
        }
    }

    static func isUnsafeSecret(_ value: String) -> Bool {
        let lowered = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lowered.isEmpty { return true }
        if ["password", "secret", "token", "default", "dev", "test", "staging", "prod", "production", "admin", "momo"].contains(lowered) {
            return true
        }
        return lowered.contains("change-me")
            || lowered.contains("changeme")
            || lowered.contains("dev-insecure")
            || lowered.contains("placeholder")
            || lowered.contains("example")
    }

    static func isLocalOrMockHost(_ host: String) -> Bool {
        let lowered = host.lowercased()
        return lowered == "localhost"
            || lowered == "127.0.0.1"
            || lowered == "0.0.0.0"
            || lowered == "::1"
            || lowered.contains("mock")
    }

    static func isAllowedLoopbackHost(_ host: String) -> Bool {
        let lowered = host.lowercased()
        return lowered == "localhost"
            || lowered == "127.0.0.1"
            || lowered == "::1"
    }

    static func isMockHost(_ host: String) -> Bool {
        host.lowercased().contains("mock")
    }

    static func boolFlag(_ raw: String?) -> Bool {
        switch raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on":
            return true
        default:
            return false
        }
    }

    static func redactedEndpointLabel(_ raw: String) -> String {
        guard var components = URLComponents(string: raw), let host = components.host else {
            return raw.isEmpty ? "not configured" : "invalid url"
        }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        let scheme = components.scheme.map { "\($0)://" } ?? ""
        let port = components.port.map { ":\($0)" } ?? ""
        let path = components.path.isEmpty ? "" : components.path
        return "\(scheme)\(host)\(port)\(path)"
    }
}

struct AgentProviderConfigurationError: Error, CustomStringConvertible {
    let errors: [String]

    var description: String {
        "invalid Hermes provider config: \(errors.joined(separator: "; "))"
    }
}
