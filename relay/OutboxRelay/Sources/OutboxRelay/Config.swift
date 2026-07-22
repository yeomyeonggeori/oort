import Foundation

/// Relay configuration loaded from environment variables.
///
/// Keys match `infra/.env.example` (the same `.env` that drives docker-compose,
/// the migration runner, and the server). The relay additionally accepts
/// `RELAY_*` overrides so it can connect as the BYPASSRLS `momo_relay` role
/// (L4 §2.2 / §10.1) distinct from the API's tenant-scoped role.
///
/// All values have dev-safe defaults so the process can boot for a local smoke
/// check even before `.env` is filled in (runtime-unverified — Postgres /
/// Centrifugo are not running in the build env).
struct Config: Sendable {
    // ---- PostgreSQL (SoT, L4 §1.2). Relay polls all tenants → BYPASSRLS role. ----
    var pgHost: String
    var pgPort: Int
    var pgUser: String
    var pgPassword: String
    var pgDatabase: String

    // ---- Centrifugo server HTTP API (L4 §4.3): relay-only publish. ----
    var centAPIURL: String   // e.g. http://centrifugo:8000/api
    var centAPIKey: String   // X-API-Key for POST /api/publish

    // ---- Relay loop tuning (L4 §8.1) ----
    var pollInterval: Duration   // fallback poll cadence (spec: 300ms)
    var claimBatchSize: Int      // rows claimed per iteration
    var maxAttempts: Int         // give up → status='failed' after this many tries
    var webhookSigningMasterKey: String
    var webhookDisableAfterServerFailures: Int
    var allowDevelopmentWebhookHTTP: Bool

    private static func env(_ key: String, _ fallback: String) -> String {
        ProcessInfo.processInfo.environment[key] ?? fallback
    }

    private static func envInt(_ key: String, _ fallback: Int) -> Int {
        ProcessInfo.processInfo.environment[key].flatMap(Int.init) ?? fallback
    }

    static func load() -> Config {
        // Prefer DATABASE_URL (same var the server reads); RELAY_DATABASE_URL wins
        // when set so the relay can point at its own BYPASSRLS credentials.
        let urlString = ProcessInfo.processInfo.environment["RELAY_DATABASE_URL"]
            ?? ProcessInfo.processInfo.environment["DATABASE_URL"]
        let pg = parseDatabaseURL(urlString)

        let pollMs = envInt("RELAY_POLL_INTERVAL_MS", 300)   // spec fallback = 300ms

        return Config(
            pgHost: pg?.host ?? env("POSTGRES_HOST", "localhost"),
            pgPort: pg?.port ?? envInt("POSTGRES_PORT", 5432),
            pgUser: pg?.user ?? env("RELAY_POSTGRES_USER", env("POSTGRES_USER", "momo")),
            pgPassword: pg?.password
                ?? env("RELAY_POSTGRES_PASSWORD", env("POSTGRES_PASSWORD", "momo")),
            pgDatabase: pg?.database ?? env("POSTGRES_DB", "momo"),
            centAPIURL: env("CENT_API_URL", "http://localhost:8000/api"),
            centAPIKey: env("CENT_API_KEY", "dev-insecure-cent-api-key"),
            pollInterval: .milliseconds(pollMs),
            claimBatchSize: envInt("RELAY_CLAIM_BATCH", 64),
            maxAttempts: envInt("RELAY_MAX_ATTEMPTS", 8),
            webhookSigningMasterKey: env(
                "OUTBOUND_WEBHOOK_MASTER_KEY", env("JWT_HMAC", "dev-insecure-jwt-hmac-change-me")
            ),
            webhookDisableAfterServerFailures: max(
                1, envInt("WEBHOOK_DISABLE_AFTER_5XX", 5)
            ),
            allowDevelopmentWebhookHTTP:
                env("MOMO_ENV", "local").lowercased() == "local"
                && env("MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP", "0") == "1"
        )
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
