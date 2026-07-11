import Foundation
import Hummingbird
import PostgresNIO

/// Persists and verifies App JWTs (`kind='session'`) and per-agent credentials
/// (`kind='agent_bearer'`) in the schema_v0 `token` table.
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

    struct AgentBearerIdentity: Sendable, Equatable {
        let tokenID: UUID
        let memberID: UUID
        let workspaceID: UUID
        let scopes: [String]
    }

    private enum AgentBearerResolution: Sendable {
        case active(AgentBearerIdentity, scopeGranted: Bool)
        case revoked
        case expired
        case unknown
    }

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

    /// Resolve an opaque agent bearer under tenant RLS, enforce the route's
    /// required scope, update liveness, and audit the presentation without ever
    /// persisting the raw secret.
    ///
    /// Scope-denied presentations are also committed to `audit_log` before the
    /// 403 is returned. Revoked/expired/unknown credentials fail closed with
    /// 401 and never become a principal.
    func authenticateAgentBearer(
        rawToken: String,
        requiredScope: String,
        method: String,
        path: String
    ) async throws -> AgentBearerIdentity {
        guard let workspaceID = AgentBearerToken.workspaceID(from: rawToken) else {
            throw HTTPError(.unauthorized, message: "invalid agent bearer token")
        }

        let result: AgentBearerResolution = try await db
            .withTenantTransaction(workspaceID: workspaceID) { conn in
                let rows = try await conn.query(
                    """
                    SELECT t.id, t.actor_member_id, t.scopes, t.revoked_at, t.expires_at
                      FROM token t
                      JOIN member m
                        ON m.id = t.actor_member_id
                       AND m.workspace_id = t.workspace_id
                       AND m.kind = 'agent'
                       AND m.status = 'active'
                       AND m.deleted_at IS NULL
                      JOIN agent a
                        ON a.member_id = m.id
                       AND a.workspace_id = m.workspace_id
                     WHERE t.workspace_id = \(workspaceID)
                       AND t.kind = 'agent_bearer'
                       AND t.subject_member_id IS NULL
                       AND t.token_hash = digest(\(rawToken), 'sha256')
                     LIMIT 1
                    """,
                    logger: db.logger
                ).collect()
                guard let row = rows.first else { return .unknown }
                let (tokenID, memberID, scopes, revokedAt, expiresAt) = try row.decode(
                    (UUID, UUID, [String], Date?, Date?).self
                )
                if revokedAt != nil { return .revoked }
                if let expiresAt, expiresAt <= Date() {
                    return .expired
                }

                let granted = scopes.contains(requiredScope)
                if granted {
                    _ = try await conn.query(
                        "UPDATE token SET last_used_at = now() WHERE id = \(tokenID)",
                        logger: db.logger
                    )
                }

                let action = granted
                    ? "auth.agent_bearer.used"
                    : "auth.agent_bearer.scope_denied"
                let detail = Self.agentBearerAuditDetail(
                    method: method,
                    path: path,
                    requiredScope: requiredScope,
                    granted: granted
                )
                _ = try await conn.query(
                    """
                    INSERT INTO audit_log
                      (workspace_id, actor_member_id, action, target_type,
                       via_token_id, detail)
                    VALUES
                      (\(workspaceID), \(memberID), \(action), 'route',
                       \(tokenID), \(detail)::jsonb)
                    """,
                    logger: db.logger
                )

                return .active(
                    AgentBearerIdentity(
                        tokenID: tokenID,
                        memberID: memberID,
                        workspaceID: workspaceID,
                        scopes: scopes
                    ),
                    scopeGranted: granted
                )
            }

        switch result {
        case .active(let identity, true):
            return identity
        case .active(_, false):
            throw HTTPError(.forbidden, message: "\(requiredScope) scope required")
        case .revoked:
            throw HTTPError(.unauthorized, message: "agent bearer token has been revoked")
        case .expired:
            throw HTTPError(.unauthorized, message: "agent bearer token has expired")
        case .unknown:
            throw HTTPError(.unauthorized, message: "unknown agent bearer token")
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

    /// Exact credential liveness for a Centrifugo connection JWT.  A token
    /// minted from one bearer must not remain subscribable merely because a
    /// rotated bearer for the same member is still active.
    func hasActiveRealtimeCredential(
        tokenID: UUID,
        memberID: UUID,
        workspaceID: UUID
    ) async throws -> Bool {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT 1
                  FROM token t
                  JOIN member m
                    ON m.id = t.actor_member_id
                   AND m.workspace_id = t.workspace_id
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                 WHERE t.id = \(tokenID)
                   AND t.actor_member_id = \(memberID)
                   AND t.workspace_id = \(workspaceID)
                   AND t.revoked_at IS NULL
                   AND (t.expires_at IS NULL OR t.expires_at > now())
                   AND (
                     (m.kind = 'human' AND t.kind = 'session')
                     OR
                     (m.kind = 'agent' AND t.kind = 'agent_bearer'
                      AND 'realtime:subscribe' = ANY(t.scopes))
                   )
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return !rows.isEmpty
        }
    }

    private static func agentBearerAuditDetail(
        method: String,
        path: String,
        requiredScope: String,
        granted: Bool
    ) -> String {
        let object: [String: Any] = [
            "schema": "momo.agent_bearer.use.v1",
            "method": method,
            "path": path,
            "required_scope": requiredScope,
            "granted": granted,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8)
        else { return "{}" }
        return value
    }
}
