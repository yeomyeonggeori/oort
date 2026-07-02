import Foundation

/// AgentWorker configuration loaded from environment variables.
///
/// Keys match `infra/.env.example` (the same `.env` that drives docker-compose,
/// the migration runner, the server, and the relay). The worker additionally
/// accepts `RELAY_*` overrides so it can connect as the BYPASSRLS `momo_relay`
/// role (L4 §2.2 / §10.1) — background consumers poll across all tenants — and
/// `HERMES_*` for the OpenAI-compatible gateway (L4 §6.2).
///
/// All values have dev-safe defaults so the process can boot for a local smoke
/// check even before `.env` is filled in (runtime-unverified — Postgres /
/// Centrifugo / hermes are not running in the build env).
struct Config: Sendable {
    // ---- PostgreSQL (SoT, L4 §1.2). Worker polls all tenants → BYPASSRLS role. ----
    var pgHost: String
    var pgPort: Int
    var pgUser: String
    var pgPassword: String
    var pgDatabase: String

    // ---- Centrifugo server HTTP API (L4 §4.3): publishes agent.status/partial. ----
    var centAPIURL: String   // e.g. http://centrifugo:8000/api
    var centAPIKey: String   // X-API-Key for POST /api/publish

    // ---- hermes OpenAI-compatible gateway (L4 §6.2) ----
    var momoEnvironment: String
    var agentProviderMode: AgentProviderMode
    var hermesBaseURL: String   // e.g. http://hermes:8088/v1
    var hermesAPIKey: String    // Bearer token
    var agentModel: String
    var allowLocalLoopbackExternalHermes: Bool

    // ---- Worker loop tuning (L4 §3.5) ----
    var pollInterval: Duration   // fallback poll cadence (spec: 300ms)
    var maxAttempts: Int         // give up → status='failed' after this many tries

    // ---- Loop-safety gate defaults (L4 §3.3 / §3.4) — overridable for tuning ----
    var maxConsecutiveAuto: Int  // G2: consecutive agent auto-replies before halt
    var maxSteps: Int            // G3: per-turn tool-call hard cap (v0 override of schema 50)
    var maxDepth: Int            // §3.4: A→B→A hop depth cap
    var maxConcurrentRuns: Int   // G1: per-agent semaphore (in-process complement to DB)

    private static func env(_ key: String, _ fallback: String) -> String {
        ProcessInfo.processInfo.environment[key] ?? fallback
    }

    private static func envInt(_ key: String, _ fallback: Int) -> Int {
        ProcessInfo.processInfo.environment[key].flatMap(Int.init) ?? fallback
    }

    static func load() -> Config {
        // Prefer DATABASE_URL (same var the server reads); RELAY_DATABASE_URL wins
        // when set so the worker can point at its own BYPASSRLS credentials.
        let urlString = ProcessInfo.processInfo.environment["RELAY_DATABASE_URL"]
            ?? ProcessInfo.processInfo.environment["DATABASE_URL"]
        let pg = parseDatabaseURL(urlString)

        let pollMs = envInt("WORKER_POLL_INTERVAL_MS", 300)   // spec fallback = 300ms

        return Config(
            pgHost: pg?.host ?? env("POSTGRES_HOST", "localhost"),
            pgPort: pg?.port ?? envInt("POSTGRES_PORT", 5432),
            pgUser: pg?.user ?? env("RELAY_POSTGRES_USER", env("POSTGRES_USER", "momo")),
            pgPassword: pg?.password
                ?? env("RELAY_POSTGRES_PASSWORD", env("POSTGRES_PASSWORD", "momo")),
            pgDatabase: pg?.database ?? env("POSTGRES_DB", "momo"),
            centAPIURL: env("CENT_API_URL", "http://localhost:8000/api"),
            centAPIKey: env("CENT_API_KEY", "dev-insecure-cent-api-key"),
            momoEnvironment: env("MOMO_ENV", "local"),
            agentProviderMode: AgentProviderMode.parse(ProcessInfo.processInfo.environment["AGENT_PROVIDER_MODE"]),
            hermesBaseURL: env("HERMES_BASE_URL", "http://localhost:8088/v1"),
            hermesAPIKey: env("HERMES_API_KEY", "dev-insecure-hermes-bearer"),
            agentModel: env("AGENT_MODEL", "hermes-agent"),
            allowLocalLoopbackExternalHermes: AgentProviderValidation.boolFlag(
                ProcessInfo.processInfo.environment["AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK"]
            ),
            pollInterval: .milliseconds(pollMs),
            maxAttempts: envInt("WORKER_MAX_ATTEMPTS", 8),
            // L4 §3.3 defaults (G2/G3, §3.4 depth). Schema default max_run_steps=50;
            // v0 overrides to 12 per the spec table.
            maxConsecutiveAuto: envInt("MAX_CONSECUTIVE_AUTO", 3),
            maxSteps: envInt("MAX_STEPS", 12),
            maxDepth: envInt("MAX_DEPTH", 4),
            maxConcurrentRuns: envInt("MAX_CONCURRENT_RUNS", 1)
        )
    }

    var agentProviderEndpointLabel: String {
        AgentProviderValidation.redactedEndpointLabel(hermesBaseURL)
    }

    var agentAvailability: String {
        switch agentProviderMode {
        case .localMock, .internalHostMock:
            return "mock"
        case .externalHermes:
            return AgentProviderValidation.validationErrors(
                mode: agentProviderMode,
                hermesBaseURL: hermesBaseURL,
                hermesAPIKey: hermesAPIKey,
                strictEnvironment: true,
                allowLocalLoopback: allowLocalLoopbackExternalHermes
            ).isEmpty ? "available" : "degraded"
        }
    }

    func validateAgentProviderForBoot() throws {
        let strictEnvironment = AgentProviderValidation.requiresStrictExternalProvider(momoEnvironment)
        guard strictEnvironment || agentProviderMode == .externalHermes else {
            return
        }

        var errors: [String] = []
        if strictEnvironment && agentProviderMode != .externalHermes {
            errors.append("AGENT_PROVIDER_MODE must be external-hermes in \(momoEnvironment)")
        }
        errors += AgentProviderValidation.validationErrors(
            mode: agentProviderMode,
            hermesBaseURL: hermesBaseURL,
            hermesAPIKey: hermesAPIKey,
            strictEnvironment: strictEnvironment,
            allowLocalLoopback: allowLocalLoopbackExternalHermes && !strictEnvironment
        )
        if !errors.isEmpty {
            throw AgentProviderConfigurationError(errors: errors)
        }
    }

    /// Minimal `postgres://user:pass@host:port/db` parser (no extra deps).
    private static func parseDatabaseURL(
        _ raw: String?
    ) -> (host: String, port: Int, user: String, password: String, database: String)? {
        guard let raw, let comps = URLComponents(string: raw), let host = comps.host
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

enum AgentProviderValidation {
    static func validationErrors(
        mode: AgentProviderMode,
        hermesBaseURL: String,
        hermesAPIKey: String,
        strictEnvironment: Bool,
        allowLocalLoopback: Bool = false
    ) -> [String] {
        var errors: [String] = []
        let trimmedURL = hermesBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedURL.isEmpty {
            errors.append("HERMES_BASE_URL is missing")
        } else if mode == .externalHermes || strictEnvironment {
            guard let url = URL(string: trimmedURL), let scheme = url.scheme, let host = url.host else {
                errors.append("HERMES_BASE_URL must be an absolute HTTP(S) URL")
                return errors + keyErrors(hermesAPIKey)
            }
            let normalizedScheme = scheme.lowercased()
            let isLoopback = isAllowedLoopbackHost(host)
            if normalizedScheme == "http" {
                if !(allowLocalLoopback && isLoopback) {
                    errors.append("HERMES_BASE_URL must use https:// unless AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 targets localhost/127.0.0.1 in local mode")
                }
            } else if normalizedScheme != "https" {
                errors.append("HERMES_BASE_URL must use http:// or https://")
            }
            if isMockHost(host) {
                errors.append("HERMES_BASE_URL must not point at mock-hermes for external-hermes")
            } else if isLocalOrMockHost(host) && !(allowLocalLoopback && isLoopback) {
                errors.append("HERMES_BASE_URL must not point at localhost for external-hermes unless AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 in local mode")
            }
        }
        errors += keyErrors(hermesAPIKey)
        return errors
    }

    static func keyErrors(_ value: String) -> [String] {
        if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return ["HERMES_API_KEY is missing"]
        }
        if isUnsafeSecret(value) {
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
