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

    // ---- Platform admin read-only inspection (MOMO-013) ----
    var platformAdminDatabaseURL: String?
    var platformAdminEmails: [String]
    var platformAdminLoginSecret: String?

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
            platformAdminDatabaseURL: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_DATABASE_URL"],
            platformAdminEmails: env("PLATFORM_ADMIN_EMAILS", "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty },
            platformAdminLoginSecret: ProcessInfo.processInfo.environment["PLATFORM_ADMIN_LOGIN_SECRET"]
                .flatMap { $0.isEmpty ? nil : $0 }
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
