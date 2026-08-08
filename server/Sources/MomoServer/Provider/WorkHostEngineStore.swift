import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// The stored `work_host_engine` row for a single workspace (migration 040).
struct StoredWorkHostEngine: Sendable, Equatable {
    var engine: String
    var updatedByMemberID: UUID?
    var updatedAtMs: Int64
}

/// Data-access for the per-workspace `work_host_engine` selection (MOMO-582 /
/// ADR-0114 증보1 B). Every method runs inside a tenant transaction
/// (`Database.withTenantConnection` / `withTenantTransaction`) which has already
/// set `app.workspace_id`, so the uniform `ws_isolation` RLS policy (migration
/// 040, FORCE) scopes each statement to the caller's workspace.
///
/// ADR-0004: the row carries only an engine LABEL — never a provider key, OAuth
/// token, or host-local path. `codex-local` selects the user host's own Codex;
/// the credential boundary stays outside oort.
enum WorkHostEngineStore {
    /// Read the workspace's engine row, or nil when it has never been set. A nil
    /// result means the effective engine is the boot default (opencode) and the
    /// caller reports it WITHOUT any write.
    static func read(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID
    ) async throws -> StoredWorkHostEngine? {
        let rows = try await conn.query(
            """
            SELECT engine,
                   updated_by,
                   floor(extract(epoch from updated_at) * 1000)::bigint
              FROM work_host_engine
             WHERE workspace_id = \(workspaceID)
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let decoded = try row.decode((String, UUID?, Int64).self)
        return StoredWorkHostEngine(
            engine: decoded.0,
            updatedByMemberID: decoded.1,
            updatedAtMs: decoded.2
        )
    }

    /// Upsert the workspace's engine (ON CONFLICT workspace_id). `updated_at` is
    /// advanced monotonically so a same-millisecond re-save still moves it forward
    /// (the provider_link pattern), keeping GUI polling coherent. `engine` is
    /// validated against the CHECK set by the caller before this runs.
    static func upsert(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        engine: String,
        updatedBy: UUID
    ) async throws -> StoredWorkHostEngine {
        let rows = try await conn.query(
            """
            INSERT INTO work_host_engine
              (workspace_id, engine, updated_by, updated_at)
            VALUES
              (\(workspaceID), \(engine), \(updatedBy), now())
            ON CONFLICT (workspace_id) DO UPDATE
              SET engine = EXCLUDED.engine,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = greatest(
                    clock_timestamp(),
                    work_host_engine.updated_at + interval '1 millisecond'
                  )
            RETURNING engine,
                      updated_by,
                      floor(extract(epoch from updated_at) * 1000)::bigint
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "work host engine upsert returned no row")
        }
        let decoded = try row.decode((String, UUID?, Int64).self)
        return StoredWorkHostEngine(
            engine: decoded.0,
            updatedByMemberID: decoded.1,
            updatedAtMs: decoded.2
        )
    }
}
