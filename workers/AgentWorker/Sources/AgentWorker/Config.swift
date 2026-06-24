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
    var hermesBaseURL: String   // e.g. http://hermes:8088/v1
    var hermesAPIKey: String    // Bearer token

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
            hermesBaseURL: env("HERMES_BASE_URL", "http://localhost:8088/v1"),
            hermesAPIKey: env("HERMES_API_KEY", "dev-insecure-hermes-bearer"),
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
