import Foundation
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
    let logger: Logger

    init(config: Config, logger: Logger) {
        // TLS disabled for v0 single-host docker-compose (PG on a private network).
        // TODO: enable TLS (`.require(...)`) for any non-loopback / multi-host deploy.
        let pgConfig = PostgresClient.Configuration(
            host: config.pgHost,
            port: config.pgPort,
            username: config.pgUser,
            password: config.pgPassword,
            database: config.pgDatabase,
            tls: .disable
        )
        self.client = PostgresClient(configuration: pgConfig, backgroundLogger: logger)
        self.logger = logger
    }

    /// Run `body` inside a transaction with the tenant's RLS scope set.
    ///
    /// `SET LOCAL` is transaction-scoped, so the workspace binding is released on
    /// commit/rollback — correct even under a transaction-mode pooler (L4 §10.2 #4).
    func withTenantTransaction<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        try await client.withTransaction(logger: logger) { conn in
            // set_config(..., is_local=true) == SET LOCAL, but parameterizable.
            _ = try await conn.query(
                "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
                logger: logger
            )
            return try await body(conn)
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
}
