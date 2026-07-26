import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Thin wrapper over `PostgresClient` (postgres-nio connection pool).
///
/// L4 §1.2: Postgres is the single source of truth. L4 §1.3 / §10.1: every
/// tenant-scoped transaction MUST run `SET LOCAL app.workspace_id = <uuid>` so
/// the RLS policies in `schema_v0.sql` filter rows to one workspace. The relay
/// (a separate package) uses a BYPASSRLS role and does not go through here.
///
/// `PostgresClient` is a `ServiceLifecycle.Service`: its `run()` drives the pool
/// and must be supervised by the application's ServiceGroup (see `App.swift`).
struct Database: Sendable {
    let client: PostgresClient
    let platformReadClient: PostgresClient?
    let logger: Logger

    init(config: Config, logger: Logger) {
        self.client = Self.makeClient(
            host: config.pgHost,
            port: config.pgPort,
            username: config.pgUser,
            password: config.pgPassword,
            database: config.pgDatabase,
            logger: logger
        )
        if let platformAdminDatabaseURL = config.platformAdminDatabaseURL,
           let pg = Self.parseDatabaseURL(platformAdminDatabaseURL)
        {
            self.platformReadClient = Self.makeClient(
                host: pg.host,
                port: pg.port,
                username: pg.user,
                password: pg.password,
                database: pg.database,
                logger: logger
            )
        } else {
            self.platformReadClient = nil
        }
        self.logger = logger
    }

    private static func makeClient(
        host: String,
        port: Int,
        username: String,
        password: String,
        database: String,
        logger: Logger
    ) -> PostgresClient {
        // TLS disabled for v0 single-host docker-compose (PG on a private network).
        // TODO: enable TLS (`.require(...)`) for any non-loopback / multi-host deploy.
        let pgConfig = PostgresClient.Configuration(
            host: host,
            port: port,
            username: username,
            password: password,
            database: database,
            tls: .disable
        )
        return PostgresClient(configuration: pgConfig, backgroundLogger: logger)
    }

    private static func parseDatabaseURL(
        _ raw: String
    ) -> (host: String, port: Int, user: String, password: String, database: String)? {
        guard let comps = URLComponents(string: raw), let host = comps.host else { return nil }
        let db = comps.path.hasPrefix("/") ? String(comps.path.dropFirst()) : comps.path
        return (
            host: host,
            port: comps.port ?? 5432,
            user: comps.user ?? "momo_platform_admin",
            password: comps.password ?? "",
            database: db.isEmpty ? "momo" : db
        )
    }

    /// Run `body` inside a transaction with the tenant's RLS scope set.
    ///
    /// `SET LOCAL` is transaction-scoped, so the workspace binding is released on
    /// commit/rollback — correct even under a transaction-mode pooler (L4 §10.2 #4).
    func withTenantTransaction<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await client.withTransaction(logger: logger) { conn in
                // set_config(..., is_local=true) == SET LOCAL, but parameterizable.
                _ = try await conn.query(
                    "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
                    logger: logger
                )
                return try await body(conn)
            }
        } catch let error as PostgresTransactionError {
            // withTransaction wraps closure throws; surface intentional HTTP
            // statuses (403/409/...) instead of a 500 "Unrecognised Error".
            // Routes used to unwrap this ad hoc — centralized here (MOMO-523).
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    /// Run a one-off read with the tenant scope set (no explicit BEGIN needed for a
    /// single statement, but RLS still requires the GUC — so we use a transaction).
    func withTenantConnection<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        try await withTenantTransaction(workspaceID: workspaceID, body)
    }

    /// Run an operator provider-link transaction (MOMO-572 / ADR-0004 증보 1).
    ///
    /// `provider_link` is instance-global operator config with a GUC-gated RLS
    /// policy. This sets `app.provider_link_admin = 'on'` to unlock the row and
    /// `app.workspace_id` so the same transaction can also write the operator's
    /// audit_log entry (which is workspace-scoped). Callers MUST verify the
    /// platform:read operator scope BEFORE opening this transaction.
    func withProviderLinkTransaction<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await client.withTransaction(logger: logger) { conn in
                _ = try await conn.query(
                    "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
                    logger: logger
                )
                _ = try await conn.query(
                    "SELECT set_config('app.provider_link_admin', 'on', true)",
                    logger: logger
                )
                return try await body(conn)
            }
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    /// Read-only variant of `withProviderLinkTransaction` for resolution paths
    /// that never write and therefore need no workspace binding.
    func withProviderLinkReadConnection<Result: Sendable>(
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await client.withTransaction(logger: logger) { conn in
                _ = try await conn.query("SET TRANSACTION READ ONLY", logger: logger)
                _ = try await conn.query(
                    "SELECT set_config('app.provider_link_admin', 'on', true)",
                    logger: logger
                )
                return try await body(conn)
            }
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    /// Run the provider quota-snapshot ingest transaction (MOMO-623 / ADR-0135 D2).
    ///
    /// `quota_snapshot` is instance-global (no workspace_id) and its write policy
    /// is gated on `app.provider_quota_admin`. Callers MUST have verified the
    /// agent bearer + `provider:quota:write` scope BEFORE opening this
    /// transaction — the GUC is the last gate, not the first.
    ///
    /// `app.workspace_id` is also bound (to the ingesting agent's workspace) so
    /// the tenant-scoped read policy behaves identically inside this transaction
    /// and any future audit write in the same tx stays attributable.
    func withProviderQuotaIngestTransaction<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await client.withTransaction(logger: logger) { conn in
                _ = try await conn.query(
                    "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
                    logger: logger
                )
                _ = try await conn.query(
                    "SELECT set_config('app.provider_quota_admin', 'on', true)",
                    logger: logger
                )
                return try await body(conn)
            }
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    /// Run an explicit platform-admin inspection read using a separate BYPASSRLS
    /// role. The transaction is read-only, so this helper must never back tenant
    /// write paths.
    func withPlatformReadConnection<Result: Sendable>(
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        guard let platformReadClient else {
            throw HTTPError(.serviceUnavailable, message: "platform admin read database is not configured")
        }
        return try await platformReadClient.withTransaction(logger: logger) { conn in
            _ = try await conn.query("SET TRANSACTION READ ONLY", logger: logger)
            return try await body(conn)
        }
    }
}
