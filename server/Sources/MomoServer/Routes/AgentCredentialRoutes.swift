import Foundation
import HTTPTypes
import Hummingbird
import Logging
import PostgresNIO

/// Human-admin lifecycle surface for per-agent credentials (ADR-0101 Phase 1).
/// Raw credentials are returned exactly once from `create`; every persisted
/// representation is a pgcrypto sha256 digest in the existing `token` table.
struct AgentCredentialRoutes: Sendable {
    /// Scopes granted when the caller does not name any — the ordinary
    /// conversational agent set.
    static let defaultScopes = [
        "agent:jobs:read",
        "agent:runs:callback",
        "messages:read",
        "messages:write",
        "realtime:subscribe",
        "work:control",
    ]

    /// Everything an admin MAY grant. `provider:quota:write` (MOMO-623 /
    /// ADR-0135 D2) is grantable but deliberately NOT default: it reaches an
    /// instance-global surface, so only a credential minted explicitly for the
    /// provider-probing adapter should carry it. Existing agent credentials must
    /// not gain the ingest surface by being re-issued with default scopes.
    static let grantableScopes = defaultScopes + [
        ProviderQuotaSnapshotRoutes.ingestScope,
    ]
    static let maximumRotationGraceSeconds = 7 * 24 * 60 * 60

    let db: Database

    /// 워크스페이스 admin이 부여할 수 없는 스코프인가.
    ///
    /// 경계는 **스코프 단위**여야 한다. 발급 경로 전체를 운영자로 올리면
    /// verify_agent_create·verify_agent_live_channel·verify_drive_mcp·
    /// verify_lifecycle_completion·verify_hermes_gateway_adapter가 전부 깨진다 —
    /// 그 다섯은 워크스페이스 admin으로 자격증명을 발급한다. 순수 함수로 두는
    /// 이유는 그 규칙을 DB 없이 못박기 위해서다.
    static func requiresInstanceOperator(scopes: [String]) -> Bool {
        scopes.contains(ProviderQuotaSnapshotRoutes.ingestScope)
    }

    /// Reuse the provider-link instance-operator boundary for the one scope
    /// that can mutate instance-global quota telemetry.
    let platformAdminEmails: [String]

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/agents/:agent/credentials", use: create)
        group.get("/v1/workspaces/:ws/agents/:agent/credentials", use: list)
        group.post(
            "/v1/workspaces/:ws/agents/:agent/credentials/:credential/revoke",
            use: revoke
        )
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanAdminPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let agentID = try Self.agentID(context)
        let dto = try await request.decode(as: CreateAgentCredentialRequest.self, context: context)
        let scopes = try Self.normalizedScopes(dto.scopes)
        let label = try Self.normalizedLabel(dto.label)
        let expiresAt = try Self.validatedExpiresAt(dto.expiresAtMs)
        let graceSeconds = try Self.validatedRotationGraceSeconds(dto.rotationGraceSeconds)
        let graceDeadline = Date().addingTimeInterval(TimeInterval(graceSeconds))
        let rawToken = AgentBearerToken.mint(workspaceID: workspaceID)
        if Self.requiresInstanceOperator(scopes: scopes) {
            _ = try await ProviderLinkRoutes.requireOperator(
                db: db,
                platformAdminEmails: platformAdminEmails,
                context: context
            )
        }
        try await ChannelRoutes.requireWorkspaceAdmin(
            db: db,
            workspaceID: workspaceID,
            principal: principal
        )
        guard try await Self.activeAgentExists(
            db: db,
            workspaceID: workspaceID,
            agentID: agentID,
            requireUnbannedHandle: true
        ) else {
            throw HTTPError(.notFound, message: "active agent not found")
        }

        let result: AgentCredentialIssuance = try await db
            .withTenantTransaction(workspaceID: workspaceID) { conn in
                try await Self.issueCredential(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    agentID: agentID,
                    createdBy: principal.memberID,
                    viaTokenID: principal.tokenID,
                    rawToken: rawToken,
                    scopes: scopes,
                    label: label,
                    expiresAt: expiresAt,
                    graceDeadline: graceDeadline,
                    graceSeconds: graceSeconds
                )
            }

        let response = CreateAgentCredentialResponse(
            credential: result.credential,
            token: rawToken,
            tokenType: "Bearer",
            rotatedCredentialCount: result.rotatedCount,
            rotationGraceEndsAtMs: result.rotatedCount > 0
                ? Int64(graceDeadline.timeIntervalSince1970 * 1000)
                : nil
        )
        var encoded = try response.response(from: request, context: context)
        encoded.status = .created
        // The raw bearer is returned exactly once. Keep it out of browser,
        // intermediary, and shared response caches.
        encoded.headers[.cacheControl] = "no-store"
        encoded.headers[HTTPField.Name("Pragma")!] = "no-cache"
        return encoded
    }

    /// Shared one-time bearer issuance primitive. Agent-card confirmation uses
    /// this inside the same identity transaction, so no partially paired agent
    /// can commit if credential issuance or its audit row fails.
    static func issueCredential(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentID: UUID,
        createdBy: UUID,
        viaTokenID: UUID,
        rawToken: String,
        scopes: [String],
        label: String,
        expiresAt: Date?,
        graceDeadline: Date,
        graceSeconds: Int
    ) async throws -> AgentCredentialIssuance {
        let rotated = try await conn.query(
            """
            UPDATE token
               SET expires_at = CASE
                     WHEN expires_at IS NULL OR expires_at > \(graceDeadline)
                       THEN \(graceDeadline)
                     ELSE expires_at
                   END
             WHERE workspace_id = \(workspaceID)
               AND actor_member_id = \(agentID)
               AND kind = 'agent_bearer'
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())
            RETURNING id
            """,
            logger: logger
        ).collect()

        let rows = try await conn.query(
            """
            INSERT INTO token
              (workspace_id, kind, actor_member_id, subject_member_id,
               token_hash, scopes, label, expires_at, created_by)
            VALUES
              (\(workspaceID), 'agent_bearer', \(agentID), NULL,
               digest(\(rawToken), 'sha256'), \(scopes), \(label), \(expiresAt),
               \(createdBy))
            RETURNING id, actor_member_id, scopes, label, last_used_at,
                      expires_at, revoked_at, created_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "agent credential creation failed")
        }
        let credential = try Self.decodeCredential(row)
        let detail = Self.auditDetail([
            "schema": "momo.agent_credential.issued.v1",
            "scopes": scopes,
            "label": label,
            "rotated_credential_count": rotated.count,
            "rotation_grace_seconds": graceSeconds,
        ])
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES
              (\(workspaceID), \(createdBy), \(agentID),
               'agent.credential.issued', 'token', \(credential.id),
               \(viaTokenID), \(detail)::jsonb)
            """,
            logger: logger
        )
        return AgentCredentialIssuance(credential: credential, rotatedCount: rotated.count)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanAdminPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let agentID = try Self.agentID(context)
        try await ChannelRoutes.requireWorkspaceAdmin(
            db: db,
            workspaceID: workspaceID,
            principal: principal
        )
        guard try await Self.activeAgentExists(
            db: db,
            workspaceID: workspaceID,
            agentID: agentID
        ) else {
            throw HTTPError(.notFound, message: "active agent not found")
        }

        let credentials: [AgentCredentialDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT id, actor_member_id, scopes, label, last_used_at,
                       expires_at, revoked_at, created_at
                  FROM token
                 WHERE workspace_id = \(workspaceID)
                   AND actor_member_id = \(agentID)
                   AND kind = 'agent_bearer'
                 ORDER BY created_at DESC
                 LIMIT 100
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeCredential)
        }
        return try AgentCredentialListResponse(credentials: credentials)
            .response(from: request, context: context)
    }

    @Sendable
    func revoke(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanAdminPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let agentID = try Self.agentID(context)
        let credentialID = try Self.credentialID(context)
        let dto = try? await request.decode(as: RevokeAgentCredentialRequest.self, context: context)
        let reason = try Self.normalizedReason(dto?.reason)
        try await ChannelRoutes.requireWorkspaceAdmin(
            db: db,
            workspaceID: workspaceID,
            principal: principal
        )

        let result: (credential: AgentCredentialDTO, revokedNow: Bool)? = try await db
            .withTenantTransaction(workspaceID: workspaceID) { conn in
                let rows = try await conn.query(
                    """
                    UPDATE token
                       SET revoked_at = now()
                     WHERE id = \(credentialID)
                       AND workspace_id = \(workspaceID)
                       AND actor_member_id = \(agentID)
                       AND kind = 'agent_bearer'
                       AND revoked_at IS NULL
                    RETURNING id, actor_member_id, scopes, label, last_used_at,
                              expires_at, revoked_at, created_at
                    """,
                    logger: db.logger
                ).collect()

                let credential: AgentCredentialDTO
                let revokedNow: Bool
                if let row = rows.first {
                    credential = try Self.decodeCredential(row)
                    revokedNow = true
                } else {
                    let existing = try await conn.query(
                        """
                        SELECT id, actor_member_id, scopes, label, last_used_at,
                               expires_at, revoked_at, created_at
                          FROM token
                         WHERE id = \(credentialID)
                           AND workspace_id = \(workspaceID)
                           AND actor_member_id = \(agentID)
                           AND kind = 'agent_bearer'
                         LIMIT 1
                        """,
                        logger: db.logger
                    ).collect()
                    guard let row = existing.first else { return nil }
                    credential = try Self.decodeCredential(row)
                    revokedNow = false
                }

                if revokedNow {
                    let detail = Self.auditDetail([
                        "schema": "momo.agent_credential.revoked.v1",
                        "reason": reason.map { $0 as Any } ?? NSNull(),
                    ])
                    _ = try await conn.query(
                        """
                        INSERT INTO audit_log
                          (workspace_id, actor_member_id, subject_member_id, action,
                           target_type, target_id, via_token_id, detail)
                        VALUES
                          (\(workspaceID), \(principal.memberID), \(agentID),
                           'agent.credential.revoked', 'token', \(credentialID),
                           \(principal.tokenID), \(detail)::jsonb)
                        """,
                        logger: db.logger
                    )
                }
                return (credential, revokedNow)
            }
        guard let result else {
            throw HTTPError(.notFound, message: "agent credential not found")
        }

        return try RevokeAgentCredentialResponse(
            credential: result.credential,
            revokedNow: result.revokedNow,
            alreadyRevoked: !result.revokedNow
        ).response(from: request, context: context)
    }

    static func normalizedScopes(_ raw: [String]?) throws -> [String] {
        let input = raw ?? defaultScopes
        var seen: Set<String> = []
        let normalized = input.compactMap { value -> String? in
            let scope = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !scope.isEmpty, seen.insert(scope).inserted else { return nil }
            return scope
        }
        guard !normalized.isEmpty else {
            throw HTTPError(.badRequest, message: "at least one agent scope is required")
        }
        let allowed = Set(grantableScopes)
        guard normalized.allSatisfy(allowed.contains) else {
            throw HTTPError(.badRequest, message: "unsupported agent scope")
        }
        return normalized
    }

    static func validatedRotationGraceSeconds(_ raw: Int?) throws -> Int {
        let value = raw ?? 24 * 60 * 60
        guard (0...maximumRotationGraceSeconds).contains(value) else {
            throw HTTPError(
                .badRequest,
                message: "rotationGraceSeconds must be between 0 and \(maximumRotationGraceSeconds)"
            )
        }
        return value
    }

    static func validatedExpiresAt(_ expiresAtMs: Int64?) throws -> Date? {
        guard let expiresAtMs else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(expiresAtMs) / 1000)
        guard date > Date() else {
            throw HTTPError(.badRequest, message: "expiresAtMs must be in the future")
        }
        return date
    }

    static func normalizedLabel(_ raw: String?) throws -> String {
        let value = (raw ?? "agent bearer").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 120 else {
            throw HTTPError(.badRequest, message: "label must contain 1...120 characters")
        }
        return value
    }

    private static func normalizedReason(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count <= 500 else {
            throw HTTPError(.badRequest, message: "reason must be at most 500 characters")
        }
        return value.isEmpty ? nil : value
    }

    private static func requireHumanAdminPrincipal(
        _ context: AppRequestContext
    ) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human workspace admin required")
        }
        return principal
    }

    private static func agentID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("agent")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid agent id")
        }
        return id
    }

    private static func credentialID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("credential")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid credential id")
        }
        return id
    }

    private static func isActiveAgent(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member m
              JOIN agent a
                ON a.member_id = m.id
               AND a.workspace_id = m.workspace_id
             WHERE m.id = \(agentID)
               AND m.workspace_id = \(workspaceID)
               AND m.kind = 'agent'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func activeAgentExists(
        db: Database,
        workspaceID: UUID,
        agentID: UUID,
        requireUnbannedHandle: Bool = false
    ) async throws -> Bool {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let active = try await isActiveAgent(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                agentID: agentID
            )
            guard active else { return false }
            if requireUnbannedHandle {
                let rows = try await conn.query(
                    "SELECT handle FROM member WHERE workspace_id = \(workspaceID) AND id = \(agentID)",
                    logger: db.logger
                ).collect()
                guard let handle = try rows.first?.decode(String.self) else { return false }
                try await JoinRoutes.requireNotBanned(
                    conn: conn, logger: db.logger, email: nil, handle: handle
                )
            }
            return true
        }
    }

    static func decodeCredential(_ row: PostgresRow) throws -> AgentCredentialDTO {
        let (id, agentID, scopes, label, lastUsedAt, expiresAt, revokedAt, createdAt) = try row
            .decode((UUID, UUID, [String], String?, Date?, Date?, Date?, Date).self)
        let status: String
        if revokedAt != nil {
            status = "revoked"
        } else if let expiresAt, expiresAt <= Date() {
            status = "expired"
        } else {
            status = "active"
        }
        return AgentCredentialDTO(
            id: id,
            agentMemberId: agentID,
            status: status,
            scopes: scopes,
            label: label,
            lastUsedAtMs: lastUsedAt.map { Int64($0.timeIntervalSince1970 * 1000) },
            expiresAtMs: expiresAt.map { Int64($0.timeIntervalSince1970 * 1000) },
            revokedAtMs: revokedAt.map { Int64($0.timeIntervalSince1970 * 1000) },
            createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
        )
    }

    static func auditDetail(_ object: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8)
        else { return "{}" }
        return value
    }
}

struct AgentCredentialIssuance: Sendable {
    let credential: AgentCredentialDTO
    let rotatedCount: Int
}

struct CreateAgentCredentialRequest: Decodable {
    let scopes: [String]?
    let label: String?
    let expiresAtMs: Int64?
    let rotationGraceSeconds: Int?
}

struct RevokeAgentCredentialRequest: Decodable {
    let reason: String?
}

struct AgentCredentialDTO: ResponseEncodable, Codable, Sendable {
    let id: UUID
    let agentMemberId: UUID
    let status: String
    let scopes: [String]
    let label: String?
    let lastUsedAtMs: Int64?
    let expiresAtMs: Int64?
    let revokedAtMs: Int64?
    let createdAtMs: Int64
}

struct CreateAgentCredentialResponse: ResponseEncodable {
    let credential: AgentCredentialDTO
    /// Returned once. The database stores only sha256(token).
    let token: String
    let tokenType: String
    let rotatedCredentialCount: Int
    let rotationGraceEndsAtMs: Int64?
}

struct AgentCredentialListResponse: ResponseEncodable {
    let credentials: [AgentCredentialDTO]
}

struct RevokeAgentCredentialResponse: ResponseEncodable {
    let credential: AgentCredentialDTO
    let revokedNow: Bool
    let alreadyRevoked: Bool
}
