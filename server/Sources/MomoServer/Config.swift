import Foundation

/// Server configuration loaded from environment variables.
///
/// Keys match `infra/.env.example` so a single `.env` drives docker-compose,
/// the migration runner, and this server. All have dev-safe defaults so the
/// process can boot for local smoke checks even before `.env` is filled in
/// (runtime-unverified — DB/Centrifugo are not running in the build env).
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
    var centTokenHMAC: String // connection/subscription JWT signing (HMAC)
    var centConnectionTokenTTL: TimeInterval // short-lived client connection token

    // ---- Platform admin read-only inspection (MOMO-013) ----
    var platformAdminDatabaseURL: String?
    var platformAdminEmails: [String]
    var platformAdminLoginSecret: String?

    // ---- Kim Intern / Hermes provider boundary (MOMO-227) ----
    var momoEnvironment: String
    var agentProvider: AgentProviderConfig

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
            centTokenHMAC: env("CENT_TOKEN_HMAC", "dev-insecure-cent-token-hmac"),
            centConnectionTokenTTL: TimeInterval(
                clampedCentConnectionTokenTTL(
                    envInt("CENT_CONNECTION_TOKEN_TTL_SECONDS", 5 * 60)
                )
            ),
            platformAdminDatabaseURL: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_DATABASE_URL"],
            platformAdminEmails: env("PLATFORM_ADMIN_EMAILS", "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty },
            platformAdminLoginSecret: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_LOGIN_SECRET"]
                .flatMap { $0.isEmpty ? nil : $0 },
            momoEnvironment: env("MOMO_ENV", "local"),
            agentProvider: AgentProviderConfig.load(environment: ProcessInfo.processInfo.environment)
        )
    }

    /// Keep realtime connection JWTs short-lived. The upper bound is the
    /// MOMO-179 contract (`exp <= 30m`), while the lower bound avoids accidental
    /// zero/negative dev env values that would make every connect fail.
    static func clampedCentConnectionTokenTTL(_ seconds: Int) -> Int {
        min(max(seconds, 60), 30 * 60)
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

    static func load(environment: [String: String]) -> AgentProviderConfig {
        AgentProviderConfig(
            mode: AgentProviderMode.parse(environment["AGENT_PROVIDER_MODE"]),
            hermesBaseURL: environment["HERMES_BASE_URL"] ?? "http://localhost:8088/v1",
            hermesAPIKey: environment["HERMES_API_KEY"] ?? "dev-insecure-hermes-bearer",
            model: environment["AGENT_MODEL"] ?? "hermes-agent",
            agentHandle: environment["AGENT_HANDLE"] ?? "kim-intern",
            displayName: environment["AGENT_DISPLAY_NAME"] ?? "김인턴"
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
        return AgentRuntimeStatusResponse(
            schema: "momo.agent_runtime.status.v0",
            agentHandle: agentHandle,
            displayName: displayName,
            mode: mode.rawValue,
            availability: availability,
            model: model,
            endpointLabel: endpointLabel,
            keyConfigured: keyConfigured,
            diagnostics: diagnostics
        )
    }

    func validateForBoot(environmentName: String) throws {
        guard Self.requiresStrictExternalProvider(environmentName) else {
            return
        }

        var errors: [String] = []
        if mode != .externalHermes {
            errors.append("AGENT_PROVIDER_MODE must be external-hermes in \(environmentName)")
        }
        errors += validationErrors(strictEnvironment: true)
        if !errors.isEmpty {
            throw AgentProviderConfigurationError(errors: errors)
        }
    }

    func validationErrors(strictEnvironment: Bool) -> [String] {
        var errors: [String] = []
        let trimmedURL = hermesBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedURL.isEmpty {
            errors.append("HERMES_BASE_URL is missing")
        } else if mode == .externalHermes || strictEnvironment {
            guard let url = URL(string: trimmedURL), let scheme = url.scheme, let host = url.host else {
                errors.append("HERMES_BASE_URL must be an absolute HTTPS URL")
                return errors + keyErrors()
            }
            if scheme.lowercased() != "https" {
                errors.append("HERMES_BASE_URL must use https:// for external-hermes")
            }
            if Self.isLocalOrMockHost(host) {
                errors.append("HERMES_BASE_URL must not point at localhost or mock-hermes for external-hermes")
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
        "invalid Kim Intern/Hermes provider config: \(errors.joined(separator: "; "))"
    }
}
