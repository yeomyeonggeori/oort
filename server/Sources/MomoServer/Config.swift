import Foundation
import OutboundHTTPPolicy

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
    var outboundWebhookMasterKey: String
    // MOMO-572 / ADR-0004 증보 1: dedicated master key for the provider_link
    // bearer AES-GCM encryption. Deliberately separate from JWT_HMAC and
    // OUTBOUND_WEBHOOK_MASTER_KEY so a leak of one key never exposes another.
    var providerLinkMasterKey: String
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

    // ---- CORS origin allowlist (MOMO-605, ADR-0133 P2) ----
    // Empty (the default) means the surface is entirely absent: no middleware is
    // mounted and no CORS header is ever emitted.
    var cors: CORSConfig = .disabled

    // ---- Platform admin read-only inspection (MOMO-013) ----
    var platformAdminDatabaseURL: String?
    var platformAdminEmails: [String]
    var platformAdminLoginSecret: String?

    // ---- Local Hermes provider boundary (MOMO-256) ----
    var momoEnvironment: String
    var agentProvider: AgentProviderConfig

    // ---- Hermes gateway native platform adapter (MOMO-325) ----
    var agentGateway: AgentGatewayConfig

    // ---- momo Cloud / E2B provisioner (ADR-0136) ----
    // The operator key is optional at process boot. Only T3 routes fail closed
    // with 503 when it is absent; T1/T2 routes do not depend on this config.
    var cloudProvisioner: CloudProvisionerConfig

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

        let jwtHMAC = env("JWT_HMAC", "dev-insecure-jwt-hmac-change-me")
        return Config(
            host: env("HOST", "0.0.0.0"),
            port: envInt("PORT", 8080),
            pgHost: pg?.host ?? env("POSTGRES_HOST", "localhost"),
            pgPort: pg?.port ?? envInt("POSTGRES_PORT", 5432),
            pgUser: pg?.user ?? env("POSTGRES_USER", "momo"),
            pgPassword: pg?.password ?? env("POSTGRES_PASSWORD", "momo"),
            pgDatabase: pg?.database ?? env("POSTGRES_DB", "momo"),
            jwtHMAC: jwtHMAC,
            outboundWebhookMasterKey: env("OUTBOUND_WEBHOOK_MASTER_KEY", jwtHMAC),
            providerLinkMasterKey: env("PROVIDER_LINK_MASTER_KEY", jwtHMAC),
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
            cors: CORSConfig.load(environment: ProcessInfo.processInfo.environment),
            platformAdminDatabaseURL: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_DATABASE_URL"],
            platformAdminEmails: env("PLATFORM_ADMIN_EMAILS", "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty },
            platformAdminLoginSecret: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_LOGIN_SECRET"]
                .flatMap { $0.isEmpty ? nil : $0 },
            momoEnvironment: env("MOMO_ENV", "local"),
            agentProvider: AgentProviderConfig.load(environment: ProcessInfo.processInfo.environment),
            agentGateway: AgentGatewayConfig.load(environment: ProcessInfo.processInfo.environment),
            cloudProvisioner: CloudProvisionerConfig.load(
                environment: ProcessInfo.processInfo.environment
            )
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
        var errors: [String] = []
        if AgentProviderConfig.isUnsafeSecret(centProxySecret) {
            errors.append(
                "CENT_PROXY_SECRET is missing or uses a placeholder/dev value in \(momoEnvironment)"
            )
        }
        if outboundWebhookMasterKey == jwtHMAC {
            errors.append(
                "OUTBOUND_WEBHOOK_MASTER_KEY must not reuse JWT_HMAC in \(momoEnvironment)"
            )
        }
        if providerLinkMasterKey == jwtHMAC {
            errors.append(
                "PROVIDER_LINK_MASTER_KEY must not reuse JWT_HMAC in \(momoEnvironment)"
            )
        }
        if providerLinkMasterKey == outboundWebhookMasterKey {
            errors.append(
                "PROVIDER_LINK_MASTER_KEY must not reuse OUTBOUND_WEBHOOK_MASTER_KEY in \(momoEnvironment)"
            )
        }
        if AgentProviderConfig.isUnsafeSecret(providerLinkMasterKey) {
            errors.append(
                "PROVIDER_LINK_MASTER_KEY is missing or uses a placeholder/dev value in \(momoEnvironment)"
            )
        }
        if !errors.isEmpty {
            throw SecurityConfigurationError(errors: errors)
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

/// MOMO-605 / ADR-0133 P2 — browser & webview CORS origin allowlist.
///
/// Why this exists: the web client is served same-origin behind Caddy
/// (ADR-0119 D1-A) so it never needs CORS, but a packaged Tauri desktop build
/// runs its frontend on a webview-owned origin (`tauri://localhost` on
/// macOS/iOS/Linux, `http://tauri.localhost` on Windows/Android) and therefore
/// issues genuinely cross-origin `/v1/*` calls. Without an allowlist the
/// browser blocks them.
///
/// Contract (deliberately conservative):
///   * `MOMO_CORS_ALLOWED_ORIGINS` is a comma-separated exact-match allowlist.
///     **Unset or empty is the default and means "no change at all"** — the
///     middleware is not even mounted, so not a single response header, no
///     `Vary`, and no OPTIONS short-circuit differ from the pre-MOMO-605 build.
///   * **Wildcards are forbidden.** Any entry containing `*` (including a bare
///     `*` and subdomain patterns like `https://*.example.com`) is rejected at
///     parse time, as is the literal `null` origin (sandboxed iframes /
///     `file://` documents). Rejected entries are dropped and reported so the
///     server can log them once at boot; a typo can therefore only ever make
///     the surface *narrower*, never wider.
///   * Credentials stay off. momo authenticates with a bearer token in the
///     `Authorization` header and issues no cookies (`grep Set-Cookie` = 0), so
///     `Access-Control-Allow-Credentials` is never sent. Combined with the
///     exact-match echo above, the forbidden `Allow-Origin: *` +
///     `Allow-Credentials: true` combination is unrepresentable.
struct CORSConfig: Sendable, Equatable {
    /// Environment variable that drives the allowlist.
    static let environmentKey = "MOMO_CORS_ALLOWED_ORIGINS"

    /// Normalized (lowercased, exact) origins allowed to make cross-origin calls.
    var allowedOrigins: [String]
    /// Entries refused while parsing (wildcard, `null`, or malformed origin).
    /// Kept so `AppBuilder` can warn once at boot instead of failing silently.
    var rejectedEntries: [String]

    /// The shipped default: no origin, no middleware, no header.
    static let disabled = CORSConfig(allowedOrigins: [], rejectedEntries: [])

    /// Mount the middleware only when at least one origin survived parsing.
    var isEnabled: Bool { !allowedOrigins.isEmpty }

    static func load(environment: [String: String]) -> CORSConfig {
        parse(environment[environmentKey])
    }

    static func parse(_ raw: String?) -> CORSConfig {
        guard let raw else { return CORSConfig(allowedOrigins: [], rejectedEntries: []) }
        var allowed: [String] = []
        var rejected: [String] = []
        for entry in raw.split(separator: ",", omittingEmptySubsequences: false) {
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            // Blank slots (trailing comma, `MOMO_CORS_ALLOWED_ORIGINS=`) are the
            // documented "off" spelling — not an operator error.
            if trimmed.isEmpty { continue }
            guard let origin = normalizedOrigin(trimmed) else {
                rejected.append(trimmed)
                continue
            }
            if !allowed.contains(origin) { allowed.append(origin) }
        }
        return CORSConfig(allowedOrigins: allowed, rejectedEntries: rejected)
    }

    /// Canonicalize one allowlist entry (or an inbound `Origin` header) to the
    /// serialized form RFC 6454 §6.1 defines: `scheme "://" host [ ":" port ]`,
    /// ASCII-lowercased, with no path, query, fragment, userinfo, or trailing
    /// slash. Returns nil for anything else — including wildcards and `null`.
    static func normalizedOrigin(_ raw: String) -> String? {
        let candidate = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !candidate.isEmpty, candidate != "null" else { return nil }
        // Wildcards are banned outright: momo never answers `*`, and a pattern
        // entry must not silently degrade into an exact-match miss either.
        guard !candidate.contains("*") else { return nil }
        guard candidate.allSatisfy({ !$0.isWhitespace }) else { return nil }

        guard let separator = candidate.range(of: "://") else { return nil }
        let scheme = String(candidate[candidate.startIndex..<separator.lowerBound])
        let authority = String(candidate[separator.upperBound...])
        guard isValidScheme(scheme), !authority.isEmpty else { return nil }
        // Anything after the authority (path/query/fragment) or userinfo makes
        // this not an origin. A trailing slash is the common operator typo.
        guard !authority.contains(where: { "/?#@\\".contains($0) }) else { return nil }

        let host: String
        let port: String?
        if authority.hasPrefix("[") {
            // IPv6 literal: [::1]:8080
            guard let close = authority.firstIndex(of: "]") else { return nil }
            host = String(authority[authority.startIndex...close])
            let rest = String(authority[authority.index(after: close)...])
            if rest.isEmpty {
                port = nil
            } else if rest.hasPrefix(":") {
                port = String(rest.dropFirst())
            } else {
                return nil
            }
            guard isValidIPv6Literal(host) else { return nil }
        } else {
            let parts = authority.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count <= 2 else { return nil }
            host = String(parts[0])
            port = parts.count == 2 ? String(parts[1]) : nil
            guard isValidHost(host) else { return nil }
        }
        if let port {
            // ASCII digits only: `Int("+80")`/`Int("٨٠")` must not sneak through.
            guard !port.isEmpty,
                  port.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let number = Int(port), (1...65535).contains(number)
            else { return nil }
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    /// RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
    /// Custom webview schemes such as `tauri` are first-class here.
    private static func isValidScheme(_ scheme: String) -> Bool {
        guard let first = scheme.first, first.isLetter, first.isASCII else { return false }
        return scheme.allSatisfy { character in
            character.isASCII
                && (character.isLetter || character.isNumber || "+-.".contains(character))
        }
    }

    private static func isValidHost(_ host: String) -> Bool {
        guard !host.isEmpty else { return false }
        guard !host.hasPrefix("."), !host.hasSuffix("."), !host.contains("..") else { return false }
        return host.allSatisfy { character in
            character.isASCII
                && (character.isLetter || character.isNumber || character == "." || character == "-")
        }
    }

    private static func isValidIPv6Literal(_ host: String) -> Bool {
        guard host.hasPrefix("["), host.hasSuffix("]"), host.count > 2 else { return false }
        let inner = host.dropFirst().dropLast()
        return inner.allSatisfy { character in
            character.isASCII
                && (character.isHexDigit || character == ":" || character == "." || character == "%")
        }
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

    var memoryProviderTrust: ProviderEndpointTrust {
        ProviderEndpointTrustPolicy.classify(
            providerMode: mode.rawValue,
            baseURL: hermesBaseURL
        )
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
