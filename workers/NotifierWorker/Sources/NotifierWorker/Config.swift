import Foundation

/// Notifier configuration loaded from environment variables.
///
/// Keys mirror relay/OutboxRelay's Config (the same `.env` drives compose and
/// every background consumer). The notifier accepts `NOTIFIER_*` overrides so
/// it can connect as its own BYPASSRLS `momo_notifier` role, distinct from the
/// API's tenant-scoped role and from relay/worker credentials.
struct Config: Sendable {
    // ---- PostgreSQL (SoT). Notifier polls all tenants → BYPASSRLS role. ----
    var pgHost: String
    var pgPort: Int
    var pgUser: String
    var pgPassword: String
    var pgDatabase: String

    // ---- Push relay dispatch endpoint (ADR-0120 D1) --------------------------
    // e2e: scripts/mock_push_relay.py (`http://mock-push-relay:8090/v1/push`).
    // P-3: the Dawn-operated PushRelay service.
    var pushRelayURL: String
    // Self-identification the relay uses for registration/rate limiting (D5).
    // No conversation content — an opaque server identifier only.
    var serverID: String

    // ---- Notifier loop tuning (OutboxRelay §8.1 pattern) ----------------------
    var pollInterval: Duration   // fallback poll cadence
    var claimBatchSize: Int      // candidate rows claimed per iteration
    var maxAttempts: Int         // give up → status='failed' after this many tries

    private static func env(_ key: String, _ fallback: String) -> String {
        ProcessInfo.processInfo.environment[key] ?? fallback
    }

    private static func envInt(_ key: String, _ fallback: Int) -> Int {
        ProcessInfo.processInfo.environment[key].flatMap(Int.init) ?? fallback
    }

    static func load() -> Config {
        // Prefer NOTIFIER_DATABASE_URL so the notifier points at its own
        // BYPASSRLS credentials; DATABASE_URL is the shared fallback.
        let urlString = ProcessInfo.processInfo.environment["NOTIFIER_DATABASE_URL"]
            ?? ProcessInfo.processInfo.environment["DATABASE_URL"]
        let pg = parseDatabaseURL(urlString)

        let pollMs = envInt("NOTIFIER_POLL_INTERVAL_MS", 300)

        return Config(
            pgHost: pg?.host ?? env("POSTGRES_HOST", "localhost"),
            pgPort: pg?.port ?? envInt("POSTGRES_PORT", 5432),
            pgUser: pg?.user ?? env("NOTIFIER_POSTGRES_USER", env("POSTGRES_USER", "momo")),
            pgPassword: pg?.password
                ?? env("NOTIFIER_POSTGRES_PASSWORD", env("POSTGRES_PASSWORD", "momo")),
            pgDatabase: pg?.database ?? env("POSTGRES_DB", "momo"),
            pushRelayURL: env("PUSH_RELAY_URL", "http://localhost:8090/v1/push"),
            serverID: env("PUSH_RELAY_SERVER_ID", "momo-local"),
            pollInterval: .milliseconds(pollMs),
            claimBatchSize: envInt("NOTIFIER_CLAIM_BATCH", 32),
            maxAttempts: envInt("NOTIFIER_MAX_ATTEMPTS", 8)
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
