import Foundation
import Hummingbird
import PostgresNIO

/// Persists issued App JWTs in the `token` table (schema_v0 `kind='session'`)
/// so they can be revoked (MOMO-300 / L4 §7.1).
///
/// Only `sha256(jwt)` is stored (`token_hash`, computed by pgcrypto `digest()`
/// inside Postgres — the raw token is never written to a table). Every
/// authenticated request re-checks the stored row:
///
///   - row missing        → 401 (fail closed: unknown/pre-revocation tokens die)
///   - `revoked_at` set   → 401 (logout / rotation)
///   - `expires_at` past  → 401 (JWT `exp` already covers this; DB is belt+braces)
///
/// All queries run under tenant RLS (`withTenantConnection`), so a token row is
/// only visible inside its own workspace.
struct TokenStore: Sendable {
    let db: Database

    /// Outcome of looking up a presented token against the `token` table.
    enum TokenState: Sendable, Equatable {
        case active(id: UUID)
        case revoked(id: UUID)
        case expired(id: UUID)
        case unknown
    }

    /// Record a freshly issued session JWT so it can be revoked later.
    ///
    /// Every app JWT carries a random `jti` (MOMO-300 review fix), so two
    /// logins in the same second can no longer mint byte-identical JWTs whose
    /// shared `token_hash` row might already be revoked. The
    /// `ON CONFLICT DO NOTHING` is therefore a pure defensive guard against a
    /// (practically impossible) sha256 collision, not a dedupe path.
    func record(
        rawToken: String,
        label: String,
        memberID: UUID,
        workspaceID: UUID,
        scopes: [String],
        expiresAt: Date
    ) async throws {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            _ = try await conn.query(
                """
                INSERT INTO token
                  (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at)
                VALUES
                  (\(workspaceID), 'session', \(memberID),
                   digest(\(rawToken), 'sha256'), \(scopes), \(label), \(expiresAt))
                ON CONFLICT (token_hash) DO NOTHING
                """,
                logger: db.logger
            )
        }
    }

    /// Look up the presented token's revocation state.
    func state(rawToken: String, workspaceID: UUID) async throws -> TokenState {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT id, revoked_at, expires_at
                  FROM token
                 WHERE token_hash = digest(\(rawToken), 'sha256')
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return TokenState.unknown }
            let (id, revokedAt, expiresAt) = try row.decode((UUID, Date?, Date?).self)
            if revokedAt != nil { return .revoked(id: id) }
            if let expiresAt, expiresAt < Date() { return .expired(id: id) }
            return .active(id: id)
        }
    }

    /// Throw 401 unless the presented token is recorded, unrevoked, unexpired.
    @discardableResult
    func requireActive(rawToken: String, workspaceID: UUID) async throws -> UUID {
        switch try await state(rawToken: rawToken, workspaceID: workspaceID) {
        case .active(let id):
            return id
        case .revoked:
            throw HTTPError(.unauthorized, message: "token has been revoked")
        case .expired:
            throw HTTPError(.unauthorized, message: "token has expired")
        case .unknown:
            throw HTTPError(.unauthorized, message: "unknown token")
        }
    }

    /// Revoke the presented token (idempotent).
    ///
    /// Returns the affected token id and whether this call actually flipped
    /// `revoked_at` (`false` = it was already revoked or was never recorded).
    func revoke(
        rawToken: String,
        workspaceID: UUID
    ) async throws -> (id: UUID?, revokedNow: Bool) {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                UPDATE token
                   SET revoked_at = now()
                 WHERE token_hash = digest(\(rawToken), 'sha256')
                   AND revoked_at IS NULL
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            if let row = rows.first {
                return (id: try row.decode(UUID.self), revokedNow: true)
            }
            // Already revoked (or never recorded) — resolve the id for auditing.
            let existing = try await conn.query(
                """
                SELECT id FROM token
                 WHERE token_hash = digest(\(rawToken), 'sha256')
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            let id = try existing.first.map { try $0.decode(UUID.self) }
            return (id: id, revokedNow: false)
        }
    }

    /// True when the member still holds at least one active (unrevoked,
    /// unexpired) session token in the workspace.
    ///
    /// Used by the Centrifugo subscribe proxy (MOMO-300): connection JWTs are
    /// short-lived and not stored, so "has this member logged out everywhere?"
    /// is approximated by session-token liveness. Coarse by design (v0): a
    /// member with two devices keeps realtime until the last session is
    /// revoked. // TODO(MOMO-300 follow-up): bind connection JWTs to a session
    /// token id (Centrifugo `include_connection_meta`) for per-device eviction.
    func hasActiveSessionToken(memberID: UUID, workspaceID: UUID) async throws -> Bool {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT 1
                  FROM token
                 WHERE actor_member_id = \(memberID)
                   AND workspace_id = \(workspaceID)
                   AND kind = 'session'
                   AND revoked_at IS NULL
                   AND (expires_at IS NULL OR expires_at > now())
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return !rows.isEmpty
        }
    }
}
