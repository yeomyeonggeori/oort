import Foundation
import Logging
import PostgresNIO

/// MOMO-573 / ADR-0004 증보 1 P-1b — job-time provider resolution for the worker.
///
/// 572 landed the `provider_link` table, its AES-GCM encryption, the operator
/// REST surface, and a *server-side* resolver. But the actual mention→conversation
/// turn runs in this separate `AgentWorker` process, which builds one boot-time
/// `HermesTransport` from env and therefore never saw an operator's GUI change.
/// This file closes that gap: at job time the worker reads the instance-global
/// `provider_link` row (as a BYPASSRLS role — migration 039 explicitly anticipates
/// this: "a future worker-side resolver reads+decrypts the row locally"), decrypts
/// the bearer with the same key derivation the server used, and — when the row is
/// present and usable — routes that turn through the DB base_url + bearer instead
/// of env.

/// The raw `provider_link` singleton row as stored (bearer still ciphertext).
struct StoredProviderLink: Sendable, Equatable {
    var baseURL: String
    var bearerCiphertext: Data
    var mode: String
    var updatedAtMs: Int64
}

/// A decrypted `provider_link` row, resolved for use. The `bearer` is present only
/// in memory on the resolution boundary and must never be serialized, logged, or
/// projected into an agent_job payload (ADR-0004 Rules #2 / #5).
struct DecryptedProviderLink: Sendable, Equatable {
    var baseURL: String
    var bearer: String
    var mode: AgentProviderMode
    var updatedAtMs: Int64

    /// A link is *usable* (and so wins over env) only when both the URL and the
    /// bearer carry real content. A half-written / cleared row falls back to env so
    /// the turn never silently loses the provider (ADR-0004 fail safe, mirrors the
    /// server-side resolver).
    var isUsable: Bool {
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !bearer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Pure DB-over-env precedence, unit-testable without a database. Returns the
/// (base_url, bearer) the turn should use, or nil to keep the env transport.
enum ProviderLinkResolution {
    static func transportOverride(
        link: DecryptedProviderLink?
    ) -> (baseURL: String, bearer: String)? {
        guard let link, link.isUsable else { return nil }
        return (link.baseURL, link.bearer)
    }
}

/// Read-only data access for the worker. Unlike the server's `ProviderLinkStore`,
/// this sets no `app.provider_link_admin` GUC: the worker connects as the BYPASSRLS
/// `momo_worker` role and so bypasses the operator-only RLS policy by design
/// (migration 039 §RLS). No RLS change is required by this ticket.
enum WorkerProviderLinkStore {
    static func read(
        pg: PostgresClient,
        logger: Logger
    ) async throws -> StoredProviderLink? {
        try await pg.withConnection { conn in
            let rows = try await conn.query(
                """
                SELECT base_url,
                       bearer_ciphertext,
                       mode,
                       floor(extract(epoch from updated_at) * 1000)::bigint
                  FROM provider_link
                 WHERE id = true
                 LIMIT 1
                """,
                logger: logger
            ).collect()
            guard let row = rows.first else { return nil }
            // `bearer_ciphertext` is a `bytea` column. Decode it as `Data`
            // (PostgresNIO maps `Data` to `.bytea`); decoding into `[UInt8]`
            // routes through the Array conformance and parses the value as a
            // Postgres array wire format, which does not match a bytea payload
            // and throws against a real row. Mirrors the server-side
            // `ProviderLinkStore` fix (MOMO-577).
            let decoded = try row.decode((String, Data, String, Int64).self)
            return StoredProviderLink(
                baseURL: decoded.0,
                bearerCiphertext: decoded.1,
                mode: decoded.2,
                updatedAtMs: decoded.3
            )
        }
    }

    /// Decrypt a stored row. A row whose ciphertext cannot be opened (e.g. the
    /// master key was rotated without re-configuring, or the worker's key differs
    /// from the server's) is treated as absent so the turn falls back to env
    /// rather than crashing.
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
            updatedAtMs: stored.updatedAtMs
        )
    }
}

/// Short-TTL cache in front of the per-job `provider_link` read + decrypt.
///
/// Reading and (especially) AES-GCM-decrypting the row on *every* job would add
/// load to a hot path, so this actor:
///   * serves a cached result for a short TTL without touching the DB (collapses
///     job bursts);
///   * after the TTL, issues one cheap `SELECT` and skips the decrypt entirely
///     when `updated_at` is unchanged — the decrypt (SHA-256 + AES-GCM) is the
///     real cost, and it only runs when the operator actually changed the link;
///   * caches row-absence / undecryptable / unusable rows as "use env" so those
///     cases don't re-read every job either.
///
/// An operator's GUI change is therefore picked up on the first job after the TTL
/// window (default 2s) — i.e. effectively "from the next job", never requiring a
/// worker restart. On a transient DB error the last-known value is retained (fail
/// safe, not fail blank).
actor ProviderLinkCache {
    typealias Reader = @Sendable () async throws -> StoredProviderLink?

    private struct Entry {
        var link: DecryptedProviderLink?   // nil ⇒ absent/unusable/undecryptable ⇒ env
        var updatedAtMs: Int64?            // source row updated_at for change detection
        var fetchedAt: ContinuousClock.Instant
    }

    private var entry: Entry?

    /// Resolve the effective link for this turn. `read` is injected so the cache is
    /// unit-testable without Postgres; `now` is injectable for deterministic TTL
    /// tests. Returns nil to signal env fallback.
    func resolve(
        masterKey: String,
        ttl: Duration,
        now: ContinuousClock.Instant = ContinuousClock.now,
        logger: Logger,
        read: Reader
    ) async -> DecryptedProviderLink? {
        if let cached = entry, now - cached.fetchedAt < ttl {
            return cached.link
        }

        let stored: StoredProviderLink?
        do {
            stored = try await read()
        } catch {
            // Transient DB error → keep serving the last-known value (throttled to
            // the TTL cadence so we don't hammer a struggling DB), else env.
            logger.warning("provider_link read failed; retaining last-known/env", metadata: [
                "error": .string(String(describing: error)),
            ])
            if entry != nil {
                entry?.fetchedAt = now
                return entry?.link ?? nil
            }
            return nil
        }

        guard let stored else {
            // No operator link configured → env fallback; cache the absence.
            entry = Entry(link: nil, updatedAtMs: nil, fetchedAt: now)
            return nil
        }

        // Unchanged since last decrypt → reuse without paying the decrypt cost.
        if let cached = entry, cached.updatedAtMs == stored.updatedAtMs {
            entry?.fetchedAt = now
            return cached.link
        }

        // Changed (or first sight) → decrypt exactly once per change.
        let decrypted = WorkerProviderLinkStore.decrypt(stored, masterKey: masterKey)
        let usable: DecryptedProviderLink?
        if let decrypted, decrypted.isUsable {
            usable = decrypted
        } else {
            usable = nil
            if decrypted == nil {
                logger.warning(
                    "provider_link present but could not be decrypted (PROVIDER_LINK_MASTER_KEY mismatch?); using env",
                    metadata: ["updatedAtMs": .stringConvertible(stored.updatedAtMs)]
                )
            } else {
                logger.warning(
                    "provider_link present but not usable (blank base_url/bearer); using env",
                    metadata: ["updatedAtMs": .stringConvertible(stored.updatedAtMs)]
                )
            }
        }
        entry = Entry(link: usable, updatedAtMs: stored.updatedAtMs, fetchedAt: now)
        return usable
    }

    /// Test hook: drop cached state.
    func reset() {
        entry = nil
    }
}
