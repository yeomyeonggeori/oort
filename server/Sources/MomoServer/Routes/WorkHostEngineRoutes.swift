import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// MOMO-582 / ADR-0114 증보1 B (WH-2 서버 선행) — operator REST for the
/// per-workspace work host execution engine selection (opencode | goose |
/// codex-local). WH-2's GUI reads and writes it; momo-workd's
/// `WorkdConfig.resolveEngine` treats this DB row as the top precedence tier
/// (DB > MOMO_WORKD_ENGINE > compiled default).
///
/// Authorization mirrors the provider-link operator surface (MOMO-576 /
/// ADR-0004 증보1 D3): a human principal that is EITHER a platform operator
/// (`platform:read`) OR an owner/admin of its own workspace. The pure decision
/// is single-sourced in `ProviderLinkRoutes.isOperatorAuthorized` (already
/// unit-tested), so the operator matrix cannot drift between the two surfaces.
///
/// Unlike provider_link (instance-global, GUC-gated RLS), work_host_engine is
/// per-workspace under the uniform `app.workspace_id` RLS policy (migration
/// 040, FORCE), so every query runs inside
/// `withTenantConnection`/`withTenantTransaction`.
///
/// ADR-0004: only an engine LABEL is ever stored — never a provider key, OAuth
/// token, or host-local path. The PUT body is closed-world (engine only), so no
/// credential/path field can be smuggled through this API.
struct WorkHostEngineRoutes: Sendable {
    let db: Database

    /// Engine labels permitted by migration 040's CHECK constraint. Kept as a
    /// server-local literal set because the server package does not depend on the
    /// WorkHostDaemon's `MomoACPHost.WorkEngine`; these values MUST stay in
    /// lockstep with migration 040 and with `WorkEngine`.
    static let allowedEngines = ["opencode", "goose", "codex-local"]
    /// Boot default (ADR-0114 증보1 D1 / `WorkEngine.default`): an absent row
    /// resolves to opencode without any write.
    static let defaultEngine = "opencode"
    static let schema = "momo.work_host_engine.v0"

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/provider/work-host-engine", use: get)
        group.put("/v1/provider/work-host-engine", use: put)
    }

    // MARK: - GET

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        let stored = try await db.withTenantConnection(workspaceID: principal.workspaceID) { conn in
            try await WorkHostEngineStore.read(
                conn: conn, logger: db.logger, workspaceID: principal.workspaceID
            )
        }
        return try Self.makeResponse(stored: stored)
            .response(from: request, context: context)
    }

    // MARK: - PUT

    @Sendable
    func put(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        let workspaceID = principal.workspaceID
        let dto = try await request.decode(as: PutWorkHostEngineRequest.self, context: context)
        let engine = try Self.validatedEngine(dto.engine)

        let stored = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            let saved = try await WorkHostEngineStore.upsert(
                conn: conn, logger: db.logger,
                workspaceID: workspaceID, engine: engine, updatedBy: principal.memberID
            )
            try await Self.writeAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                engine: engine
            )
            return saved
        }
        return try Self.makeResponse(stored: stored)
            .response(from: request, context: context)
    }

    // MARK: - Response + validation

    /// Builds the wire response. A nil row means the workspace never selected an
    /// engine, so the effective engine is the boot default (opencode) with
    /// `source:"default"` and no write — matching `WorkdConfig.resolveEngine`'s
    /// default tier.
    static func makeResponse(stored: StoredWorkHostEngine?) -> WorkHostEngineResponse {
        if let stored {
            return WorkHostEngineResponse(
                engine: stored.engine,
                source: "database",
                updatedBy: stored.updatedByMemberID?.uuidString,
                updatedAtMs: stored.updatedAtMs,
                schema: schema
            )
        }
        return WorkHostEngineResponse(
            engine: defaultEngine,
            source: "default",
            updatedBy: nil,
            updatedAtMs: nil,
            schema: schema
        )
    }

    /// Validates the requested engine label against migration 040's CHECK set. An
    /// unknown value is a 400 (never a 500 surfaced from the DB constraint).
    static func validatedEngine(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard allowedEngines.contains(trimmed) else {
            throw HTTPError(
                .badRequest,
                message: "engine must be one of opencode, goose, codex-local"
            )
        }
        return trimmed
    }

    // MARK: - Authorization (provider-link operator model, ADR-0004 증보1 D3)

    /// Authorizes the work-host-engine operator surface: a human that either
    /// carries `platform:read` or is an owner/admin of its own workspace. The
    /// platform path needs no DB lookup; only the role fallback opens a tenant
    /// read, keeping "권한 판정 → GUC 세팅" ordering (D3 정합).
    func requireOperator(_ context: AppRequestContext) async throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human operator required")
        }
        if ProviderLinkRoutes.isOperatorAuthorized(
            kind: principal.kind, scopes: principal.scopes, workspaceRole: nil
        ) {
            return principal
        }
        let role = try await db.withTenantConnection(workspaceID: principal.workspaceID) { conn in
            try await WorkspaceAuthorization.activeRole(
                conn: conn,
                logger: db.logger,
                workspaceID: principal.workspaceID,
                memberID: principal.memberID
            )
        }
        guard ProviderLinkRoutes.isOperatorAuthorized(
            kind: principal.kind, scopes: principal.scopes, workspaceRole: role
        ) else {
            throw HTTPError(
                .forbidden,
                message: "platform:read scope or workspace owner/admin required"
            )
        }
        return principal
    }

    // MARK: - Audit

    /// Records the engine change in the acting principal's workspace. Only the
    /// engine label is persisted (ADR-0004) — no credential or path is available
    /// to leak here.
    static func writeAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        engine: String
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id,
               via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), 'work_host_engine.updated',
               'work_host_engine', NULL, \(viaTokenID),
               jsonb_build_object(
                 'schema', 'momo.work_host_engine.audit.v0',
                 'engine', \(engine)::text
               ))
            """,
            logger: logger
        )
    }
}

// MARK: - DTOs

struct WorkHostEngineResponse: ResponseEncodable, Encodable, Sendable {
    let engine: String
    let source: String
    let updatedBy: String?
    let updatedAtMs: Int64?
    let schema: String
}

/// Closed-world PUT body. Only `engine` is accepted; any other key (a smuggled
/// credential, OAuth token, or host-local path) is rejected — upholding ADR-0004
/// "engine label only, credentials/paths untouched".
struct PutWorkHostEngineRequest: Decodable, Sendable {
    let engine: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case engine
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: WorkHostEngineCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        let unknown = dynamic.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: unknown.sorted().first.map(WorkHostEngineCodingKey.init)!,
                in: dynamic,
                debugDescription: "unknown work-host-engine field"
            )
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        engine = try values.decode(String.self, forKey: .engine)
    }
}

private struct WorkHostEngineCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) { self.stringValue = stringValue }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { self.stringValue = String(intValue) }
}
