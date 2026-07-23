import Foundation
import Hummingbird
import Logging
import NIOCore
import PostgresNIO

/// The raw `provider_link` singleton row as stored (bearer still ciphertext).
struct StoredProviderLink: Sendable {
    var baseURL: String
    var bearerCiphertext: Data
    var mode: String
    var updatedByMemberID: UUID?
    var updatedAtMs: Int64
}

/// Data-access for the instance-global `provider_link` singleton. All methods run
/// inside a provider-link transaction (see `Database.withProviderLinkTransaction`)
/// which has already unlocked the RLS policy.
enum ProviderLinkStore {
    /// Read the singleton row, or nil when the operator has not configured a link.
    static func read(
        conn: PostgresConnection,
        logger: Logger
    ) async throws -> StoredProviderLink? {
        let rows = try await conn.query(
            """
            SELECT base_url,
                   bearer_ciphertext,
                   mode,
                   updated_by,
                   floor(extract(epoch from updated_at) * 1000)::bigint
              FROM provider_link
             WHERE id = true
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        // `bearer_ciphertext` is a `bytea` column. Decode it as `Data` (which
        // PostgresNIO maps to `.bytea`); decoding into `[UInt8]` would instead go
        // through PostgresNIO's Array conformance and try to parse the value as a
        // Postgres array wire format, which does not match a bytea payload.
        let decoded = try row.decode((String, Data, String, UUID?, Int64).self)
        return StoredProviderLink(
            baseURL: decoded.0,
            bearerCiphertext: decoded.1,
            mode: decoded.2,
            updatedByMemberID: decoded.3,
            updatedAtMs: decoded.4
        )
    }

    /// Upsert the singleton row. `bearerCiphertext` is already AES-GCM sealed.
    static func upsert(
        conn: PostgresConnection,
        logger: Logger,
        baseURL: String,
        bearerCiphertext: Data,
        mode: String,
        updatedBy: UUID
    ) async throws -> StoredProviderLink {
        // Bind the AES-GCM ciphertext as a `bytea` parameter. PostgresNIO encodes
        // `ByteBuffer` (and `Data`) with `psqlType == .bytea`, whereas `[UInt8]`
        // resolves to the Array conformance and is encoded as a Postgres `"char"[]`
        // array — which the `bytea` column rejects at bind time (observed as a 500
        // on PUT /v1/provider/link against a real Postgres). See MOMO-577.
        let ciphertext = ByteBuffer(bytes: bearerCiphertext)
        let rows = try await conn.query(
            """
            INSERT INTO provider_link
              (id, base_url, bearer_ciphertext, mode, updated_by, updated_at)
            VALUES
              (true, \(baseURL), \(ciphertext), \(mode), \(updatedBy), now())
            ON CONFLICT (id) DO UPDATE
              SET base_url = EXCLUDED.base_url,
                  bearer_ciphertext = EXCLUDED.bearer_ciphertext,
                  mode = EXCLUDED.mode,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = greatest(
                    clock_timestamp(),
                    provider_link.updated_at + interval '1 millisecond'
                  )
            RETURNING base_url,
                      bearer_ciphertext,
                      mode,
                      updated_by,
                      floor(extract(epoch from updated_at) * 1000)::bigint
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "provider link upsert returned no row")
        }
        // Decode `bearer_ciphertext` (bytea) as `Data`; see `read` for the rationale.
        let decoded = try row.decode((String, Data, String, UUID?, Int64).self)
        return StoredProviderLink(
            baseURL: decoded.0,
            bearerCiphertext: decoded.1,
            mode: decoded.2,
            updatedByMemberID: decoded.3,
            updatedAtMs: decoded.4
        )
    }

    /// Delete the singleton row (revert to env fallback). Returns true if a row
    /// existed.
    static func delete(
        conn: PostgresConnection,
        logger: Logger
    ) async throws -> Bool {
        let rows = try await conn.query(
            "DELETE FROM provider_link WHERE id = true RETURNING true",
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    /// Decrypt a stored row into a resolvable link. A row whose ciphertext cannot
    /// be decrypted (e.g. the master key was rotated without re-configuring) is
    /// treated as absent so the process falls back to env rather than crashing.
    static func decrypt(
        _ stored: StoredProviderLink,
        masterKey: String
    ) -> DecryptedProviderLink? {
        guard let bearer = try? ProviderLinkCrypto.open(
            stored.bearerCiphertext, masterKey: masterKey
        ) else { return nil }
        return DecryptedProviderLink(
            baseURL: stored.baseURL,
            bearer: bearer,
            mode: AgentProviderMode.parse(stored.mode),
            updatedByMemberID: stored.updatedByMemberID,
            updatedAtMs: stored.updatedAtMs
        )
    }
}
