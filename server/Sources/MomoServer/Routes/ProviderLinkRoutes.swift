import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// MOMO-572 / ADR-0004 증보 1 — operator REST for the instance-global provider
/// link (the DB override of the boot-time HERMES_* env trio).
///
/// Authorization (MOMO-576 / ADR-0004 증보1 D3 "설정 권한 = 서버 운영자/owner"):
/// a human principal that is EITHER a platform operator (`platform:read` scope —
/// the cross-tenant operator path) OR an owner/admin of its own workspace. The
/// workspace-role fallback exists because an owner's ordinary login token does
/// NOT carry `platform:read` (that scope is gated by `PLATFORM_ADMIN_EMAILS`), so
/// 성재(owner) was getting 403 when opening the "AI 연결" GUI (MOMO-574).
///
/// WARNING — provider_link is instance-global (no workspace_id). A workspace
/// owner/admin who edits it therefore changes provider resolution for EVERY
/// workspace on the instance. That is acceptable for the internal single-
/// workspace test build (one WS, 성재=owner) but MUST be re-tightened to
/// `platform:read`-only before any multi-workspace / public exposure. Follow-up:
/// STATUS "MOMO-576 후속 (멀티 WS provider-link 권한 조임)".
///
/// ADR-0004 invariants enforced here:
///   * The bearer is accepted only in the PUT body and stored as AES-GCM
///     ciphertext. It is never echoed, logged, audited, or returned — GET exposes
///     only a boolean + a masked 4-char tail.
///   * The request shape is closed-world, so no `codex_oauth_*` / `openai_*` /
///     raw-provider-key field can ever be introduced through this API.
struct ProviderLinkRoutes: Sendable {
    let db: Database
    let environmentName: String
    let allowLocalLoopback: Bool
    let providerLinkMasterKey: String
    let envProvider: AgentProviderConfig
    let healthProbe: any ProviderHealthProbing

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/provider/link", use: get)
        group.put("/v1/provider/link", use: put)
        group.delete("/v1/provider/link", use: delete)
        group.post("/v1/provider/link/test", use: test)
    }

    // MARK: - GET

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try await requireOperator(context)
        let stored: StoredProviderLink? = try await db.withProviderLinkReadConnection { conn in
            try await ProviderLinkStore.read(conn: conn, logger: db.logger)
        }
        return try makeResponse(stored: stored)
            .response(from: request, context: context)
    }

    // MARK: - PUT

    @Sendable
    func put(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        // provider_link is instance-global (no `:ws` path param); attribute the
        // operator audit entry to the acting principal's home workspace.
        let workspaceID = principal.workspaceID
        let dto = try await request.decode(as: PutProviderLinkRequest.self, context: context)

        let baseURL = try AgentRoutes.validatedBaseURL(
            dto.baseUrl,
            environmentName: environmentName,
            allowLocalLoopback: allowLocalLoopback
        )
        let bearer = dto.bearer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !bearer.isEmpty else {
            throw HTTPError(.badRequest, message: "bearer must not be empty")
        }
        let mode = try Self.resolvedMode(dto.mode)
        let ciphertext = try ProviderLinkCrypto.seal(bearer, masterKey: providerLinkMasterKey)

        let stored: StoredProviderLink = try await db.withProviderLinkTransaction(
            workspaceID: workspaceID
        ) { conn in
            let saved = try await ProviderLinkStore.upsert(
                conn: conn, logger: db.logger,
                baseURL: baseURL, bearerCiphertext: ciphertext,
                mode: mode.rawValue, updatedBy: principal.memberID
            )
            try await Self.writeAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                action: "provider_link.updated",
                mode: mode.rawValue,
                endpointLabel: AgentProviderConfig.redactedEndpointLabel(baseURL),
                bearerConfigured: true
            )
            return saved
        }
        return try makeResponse(stored: stored)
            .response(from: request, context: context)
    }

    // MARK: - DELETE

    @Sendable
    func delete(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        // Instance-global row; audit attributed to the acting principal's workspace.
        let workspaceID = principal.workspaceID

        try await db.withProviderLinkTransaction(workspaceID: workspaceID) { conn in
            let existed = try await ProviderLinkStore.delete(conn: conn, logger: db.logger)
            if existed {
                try await Self.writeAudit(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                    action: "provider_link.deleted",
                    mode: nil, endpointLabel: nil, bearerConfigured: false
                )
            }
        }
        // After deletion the effective config is the env fallback.
        return try makeResponse(stored: nil)
            .response(from: request, context: context)
    }

    // MARK: - POST test

    @Sendable
    func test(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try await requireOperator(context)
        let stored: StoredProviderLink? = try await db.withProviderLinkReadConnection { conn in
            try await ProviderLinkStore.read(conn: conn, logger: db.logger)
        }
        let resolved = resolve(stored: stored)
        let mode = resolved.config.mode
        let endpointLabel = resolved.config.endpointLabel

        let result: ProviderHealthResult
        if mode != .externalHermes {
            // Mock modes have no real provider to reach; report as not-external so
            // the operator knows a real base_url/bearer must be configured first.
            result = ProviderHealthResult(ok: false, reason: "not_external_provider")
        } else if !resolved.config.keyConfigured {
            result = ProviderHealthResult(ok: false, reason: "provider_not_configured")
        } else {
            result = await healthProbe.probe(
                baseURL: resolved.config.hermesBaseURL,
                bearer: resolved.config.hermesAPIKey
            )
        }

        let response = ProviderLinkTestResponse(
            schema: "momo.provider_link.test.v0",
            ok: result.ok,
            reason: result.reason,
            source: resolved.source.rawValue,
            mode: mode.rawValue,
            endpointLabel: endpointLabel,
            checkedAtMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
        return try response.response(from: request, context: context)
    }

    // MARK: - Resolution + response

    private func resolve(stored: StoredProviderLink?) -> ResolvedProviderConfig {
        let decrypted = stored.flatMap {
            ProviderLinkStore.decrypt($0, masterKey: providerLinkMasterKey)
        }
        return ProviderLinkResolver.resolve(env: envProvider, link: decrypted)
    }

    private func makeResponse(stored: StoredProviderLink?) -> ProviderLinkResponse {
        let decrypted = stored.flatMap {
            ProviderLinkStore.decrypt($0, masterKey: providerLinkMasterKey)
        }
        let resolved = ProviderLinkResolver.resolve(env: envProvider, link: decrypted)
        let config = resolved.config
        let strict = AgentProviderConfig.requiresStrictExternalProvider(environmentName)
        let diagnostics = config.validationErrors(
            strictEnvironment: strict || config.mode == .externalHermes
        )
        let fromDatabase = resolved.source == .database
        let last4 = fromDatabase ? decrypted.flatMap { ProviderLinkCrypto.maskedTail($0.bearer) } : nil
        return ProviderLinkResponse(
            schema: "momo.provider_link.v0",
            configured: fromDatabase,
            source: resolved.source.rawValue,
            mode: config.mode.rawValue,
            baseUrl: config.hermesBaseURL,
            endpointLabel: config.endpointLabel,
            bearerConfigured: config.keyConfigured,
            bearerLast4: last4,
            availability: config.availability,
            keyConfigured: config.keyConfigured,
            updatedAtMs: fromDatabase ? stored?.updatedAtMs : nil,
            updatedBy: fromDatabase ? stored?.updatedByMemberID?.uuidString : nil,
            diagnostics: diagnostics
        )
    }

    // MARK: - Helpers

    /// Pure authorization decision for the provider-link operator surface,
    /// separated from the DB role lookup so the full matrix is unit-testable
    /// without Postgres. A caller is an operator iff it is a human that either
    /// carries the `platform:read` cross-tenant scope, or is an owner/admin of
    /// its own workspace (ADR-0004 증보1 D3; owner||admin == `WorkspaceRole.isAdmin`).
    ///
    /// `workspaceRole` is the principal's role on its home workspace, or nil when
    /// no active membership exists. It is only consulted when `platform:read` is
    /// absent, so the platform path never needs a DB lookup.
    static func isOperatorAuthorized(
        kind: AuthPrincipalKind,
        scopes: [String],
        workspaceRole: WorkspaceRole?
    ) -> Bool {
        guard kind == .human else { return false }
        if scopes.contains("platform:read") { return true }
        return workspaceRole?.isAdmin ?? false
    }

    /// Authorizes the provider-link operator surface (see the type doc comment).
    ///
    /// The workspace-role fallback lookup runs in its own tenant transaction —
    /// `app.workspace_id` is set but `app.provider_link_admin` is NOT — so the
    /// authorization decision fully completes with provider_link still RLS-locked.
    /// Only after this returns does a caller open
    /// `withProviderLinkTransaction`/`withProviderLinkReadConnection`, preserving
    /// the "권한 판정 → GUC 세팅" ordering (D3 정합).
    func requireOperator(_ context: AppRequestContext) async throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human operator required")
        }
        // Platform operator scope authorizes without any workspace-role lookup.
        if Self.isOperatorAuthorized(
            kind: principal.kind, scopes: principal.scopes, workspaceRole: nil
        ) {
            return principal
        }
        // Fallback: owner/admin of the principal's own workspace.
        let role = try await db.withTenantConnection(workspaceID: principal.workspaceID) { conn in
            try await WorkspaceAuthorization.activeRole(
                conn: conn,
                logger: db.logger,
                workspaceID: principal.workspaceID,
                memberID: principal.memberID
            )
        }
        guard Self.isOperatorAuthorized(
            kind: principal.kind, scopes: principal.scopes, workspaceRole: role
        ) else {
            throw HTTPError(
                .forbidden,
                message: "platform:read scope or workspace owner/admin required"
            )
        }
        return principal
    }

    static func resolvedMode(_ raw: String?) throws -> AgentProviderMode {
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            // Configuring a provider link implies the external-hermes boundary.
            return .externalHermes
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let mode = AgentProviderMode(rawValue: trimmed) else {
            throw HTTPError(
                .badRequest,
                message: "mode must be one of local-mock, internal-host-mock, external-hermes"
            )
        }
        return mode
    }

    static func writeAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        action: String,
        mode: String?,
        endpointLabel: String?,
        bearerConfigured: Bool
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id,
               via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), \(action), 'provider_link', NULL,
               \(viaTokenID),
               jsonb_build_object(
                 'schema', 'momo.provider_link.audit.v1',
                 'mode', \(mode)::text,
                 'endpoint_label', \(endpointLabel)::text,
                 'bearer_configured', \(bearerConfigured)
               ))
            """,
            logger: logger
        )
    }
}

// MARK: - DTOs

struct ProviderLinkResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    let configured: Bool
    let source: String
    let mode: String
    let baseUrl: String
    let endpointLabel: String
    let bearerConfigured: Bool
    let bearerLast4: String?
    let availability: String
    let keyConfigured: Bool
    let updatedAtMs: Int64?
    let updatedBy: String?
    let diagnostics: [String]
}

struct ProviderLinkTestResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    let ok: Bool
    let reason: String?
    let source: String
    let mode: String
    let endpointLabel: String
    let checkedAtMs: Int64
}

/// Closed-world PUT body. Only baseUrl / bearer / mode are accepted; any other
/// key (including any Codex/OpenAI OAuth or raw-provider-key field) is rejected,
/// upholding ADR-0004 Rules #1-#2.
struct PutProviderLinkRequest: Decodable, Sendable {
    let baseUrl: String
    let bearer: String
    let mode: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case baseUrl
        case bearer
        case mode
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: ProviderLinkCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        let unknown = dynamic.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: unknown.sorted().first.map(ProviderLinkCodingKey.init)!,
                in: dynamic,
                debugDescription: "unknown provider-link field"
            )
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        baseUrl = try values.decode(String.self, forKey: .baseUrl)
        bearer = try values.decode(String.self, forKey: .bearer)
        mode = try values.decodeIfPresent(String.self, forKey: .mode)
    }
}

private struct ProviderLinkCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) { self.stringValue = stringValue }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { self.stringValue = String(intValue) }
}
