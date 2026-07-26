import Foundation
import Hummingbird
import Logging
import NIOCore
import PostgresNIO

/// One stored `provider_link_chain` row (bearer still ciphertext).
///
/// MOMO-622 / ADR-0135 D1. Positions here are always >= 1: position 0 is the
/// legacy `provider_link` singleton (or the env fallback when no row exists), as
/// documented in migration 042.
struct StoredProviderChainEntry: Sendable, Equatable {
    var id: UUID
    var position: Int
    var baseURL: String
    var bearerCiphertext: Data
    var mode: String
    var enabled: Bool
    var updatedByMemberID: UUID?
    var updatedAtMs: Int64
}

/// A chain entry with its bearer opened, ready to be turned into a cascade hop.
struct DecryptedProviderChainEntry: Sendable, Equatable {
    var id: UUID
    var position: Int
    var baseURL: String
    var bearer: String
    var mode: AgentProviderMode
    var enabled: Bool
    var updatedByMemberID: UUID?
    var updatedAtMs: Int64
}

/// The desired state of one chain entry as supplied by the operator. `bearer` is
/// nil when the operator is editing an existing position without re-sending the
/// write-only secret; the route then reuses the stored ciphertext.
struct ProviderChainEntryInput: Sendable, Equatable {
    var position: Int
    var baseURL: String
    var bearer: String?
    var mode: AgentProviderMode
    var enabled: Bool
}

/// Data-access for `provider_link_chain`. Every method runs inside a provider-link
/// transaction (`Database.withProviderLinkTransaction` /
/// `withProviderLinkReadConnection`) which has already unlocked the RLS policy.
enum ProviderLinkChainStore {
    /// Read the whole chain in cascade (ascending position) order.
    static func read(
        conn: PostgresConnection,
        logger: Logger
    ) async throws -> [StoredProviderChainEntry] {
        let rows = try await conn.query(
            """
            SELECT id,
                   position,
                   base_url,
                   bearer_ciphertext,
                   mode,
                   enabled,
                   updated_by,
                   floor(extract(epoch from updated_at) * 1000)::bigint
              FROM provider_link_chain
             ORDER BY position ASC
            """,
            logger: logger
        ).collect()
        return try rows.map { row in
            // `bearer_ciphertext` is `bytea` — decode as `Data`, never `[UInt8]`
            // (which routes through PostgresNIO's Array conformance and parses the
            // value as a Postgres array wire format). Same trap as MOMO-577.
            let decoded = try row.decode(
                (UUID, Int, String, Data, String, Bool, UUID?, Int64).self
            )
            return StoredProviderChainEntry(
                id: decoded.0,
                position: decoded.1,
                baseURL: decoded.2,
                bearerCiphertext: decoded.3,
                mode: decoded.4,
                enabled: decoded.5,
                updatedByMemberID: decoded.6,
                updatedAtMs: decoded.7
            )
        }
    }

    /// Replace the entire chain in one transaction (positions >= 1).
    ///
    /// Replace-all rather than per-row PATCH: `position` is UNIQUE, so a partial
    /// edit that swaps two positions would otherwise need a temporary hole and
    /// could leave a half-applied cascade order visible to a concurrently
    /// resolving worker. One DELETE + INSERT inside the operator transaction makes
    /// the new order atomic.
    static func replaceAll(
        conn: PostgresConnection,
        logger: Logger,
        entries: [(position: Int, baseURL: String, bearerCiphertext: Data, mode: String, enabled: Bool)],
        updatedBy: UUID
    ) async throws -> [StoredProviderChainEntry] {
        _ = try await conn.query("DELETE FROM provider_link_chain", logger: logger)
        for entry in entries {
            // Bind the AES-GCM ciphertext as `bytea` via ByteBuffer (MOMO-577).
            let ciphertext = ByteBuffer(bytes: entry.bearerCiphertext)
            _ = try await conn.query(
                """
                INSERT INTO provider_link_chain
                  (position, base_url, bearer_ciphertext, mode, enabled, updated_by, updated_at)
                VALUES
                  (\(entry.position), \(entry.baseURL), \(ciphertext), \(entry.mode),
                   \(entry.enabled), \(updatedBy), now())
                """,
                logger: logger
            )
        }
        return try await read(conn: conn, logger: logger)
    }

    /// Delete every chain entry (revert to the position-0 link alone). Returns the
    /// number of removed hops.
    static func deleteAll(
        conn: PostgresConnection,
        logger: Logger
    ) async throws -> Int {
        let rows = try await conn.query(
            "DELETE FROM provider_link_chain RETURNING id",
            logger: logger
        ).collect()
        return rows.count
    }

    /// Decrypt one stored entry. An entry whose ciphertext cannot be opened (e.g.
    /// the master key was rotated without re-configuring) is treated as absent so
    /// the cascade skips that hop rather than failing the whole chain.
    static func decrypt(
        _ stored: StoredProviderChainEntry,
        masterKey: String
    ) -> DecryptedProviderChainEntry? {
        guard let bearer = try? ProviderLinkCrypto.open(
            stored.bearerCiphertext, masterKey: masterKey
        ) else { return nil }
        return DecryptedProviderChainEntry(
            id: stored.id,
            position: stored.position,
            baseURL: stored.baseURL,
            bearer: bearer,
            mode: AgentProviderMode.parse(stored.mode),
            enabled: stored.enabled,
            updatedByMemberID: stored.updatedByMemberID,
            updatedAtMs: stored.updatedAtMs
        )
    }
}
