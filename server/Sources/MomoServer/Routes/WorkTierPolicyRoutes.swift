import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct PutWorkTierPolicyRequest: Decodable {
    let mode: String
    let autoTarget: String?
}

struct WorkTierPolicyDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let workspaceId: String
    let memberId: String?
    let mode: String
    let autoTarget: String?
    let inherited: Bool
    let updatedAtMs: Int64?
}

struct WorkTierPolicyResponse: ResponseEncodable {
    let workTierPolicy: WorkTierPolicyDTO
}

/// ADR-0125 D11 policy ledger.
///
/// Workspace defaults are owner/admin-only. Every active human may read and
/// replace their own override. `cloud` is a reserved target selector; concrete
/// host UUIDs are checked against the active work_host registry.
struct WorkTierPolicyRoutes: Sendable {
    enum Scope: Sendable {
        case workspace
        case member(UUID)
    }

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/work-tier-policy", use: getWorkspaceDefault)
        group.put("/v1/workspaces/:ws/work-tier-policy", use: putWorkspaceDefault)
        group.get("/v1/workspaces/:ws/work-tier-policy/me", use: getMemberOverride)
        group.put("/v1/workspaces/:ws/work-tier-policy/me", use: putMemberOverride)
    }

    @Sendable
    func getWorkspaceDefault(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID) = try Self.requireHuman(context)
        let policy = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            try await Self.requireWorkspaceAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            return try await Self.loadPolicy(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                scope: .workspace
            )
        }
        return try WorkTierPolicyResponse(workTierPolicy: policy)
            .response(from: request, context: context)
    }

    @Sendable
    func getMemberOverride(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID) = try Self.requireHuman(context)
        let policy = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            try await Self.requireActiveHuman(
                conn: conn, logger: db.logger, principal: principal
            )
            return try await Self.loadPolicy(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                scope: .member(principal.memberID)
            )
        }
        return try WorkTierPolicyResponse(workTierPolicy: policy)
            .response(from: request, context: context)
    }

    @Sendable
    func putWorkspaceDefault(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await put(request, context: context, memberOverride: false)
    }

    @Sendable
    func putMemberOverride(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await put(request, context: context, memberOverride: true)
    }

    private func put(
        _ request: Request,
        context: AppRequestContext,
        memberOverride: Bool
    ) async throws -> Response {
        let (principal, workspaceID) = try Self.requireHuman(context)
        let body = try await request.decode(as: PutWorkTierPolicyRequest.self, context: context)
        let mode = try Self.validatedMode(body.mode)
        let autoTarget = try Self.validatedAutoTarget(body.autoTarget, mode: mode)
        let scope: Scope = memberOverride ? .member(principal.memberID) : .workspace

        let policy = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            if memberOverride {
                try await Self.requireActiveHuman(
                    conn: conn, logger: db.logger, principal: principal
                )
            } else {
                try await Self.requireWorkspaceAdmin(
                    conn: conn, logger: db.logger, principal: principal
                )
            }
            try await Self.requireAllowedTarget(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                scope: scope,
                autoTarget: autoTarget
            )

            let memberID: UUID? = memberOverride ? principal.memberID : nil
            let rows = try await conn.query(
                memberOverride
                    ? """
                      INSERT INTO work_tier_policy
                        (workspace_id, member_id, mode, auto_target)
                      VALUES (
                        \(workspaceID), \(memberID), \(mode), \(autoTarget)
                      )
                      ON CONFLICT (workspace_id, member_id) WHERE member_id IS NOT NULL
                      DO UPDATE SET mode = EXCLUDED.mode,
                                    auto_target = EXCLUDED.auto_target,
                                    updated_at = clock_timestamp()
                      RETURNING member_id, mode, auto_target, updated_at
                      """
                    : """
                      INSERT INTO work_tier_policy
                        (workspace_id, member_id, mode, auto_target)
                      VALUES (
                        \(workspaceID), NULL, \(mode), \(autoTarget)
                      )
                      ON CONFLICT (workspace_id) WHERE member_id IS NULL
                      DO UPDATE SET mode = EXCLUDED.mode,
                                    auto_target = EXCLUDED.auto_target,
                                    updated_at = clock_timestamp()
                      RETURNING member_id, mode, auto_target, updated_at
                      """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "work tier policy upsert failed")
            }
            let (storedMemberID, storedMode, storedTarget, updatedAt) = try row.decode(
                (UUID?, String, String?, Date).self
            )
            let detail: [String: Any] = [
                "schema": "momo.work_tier_policy.changed.v1",
                "scope": memberOverride ? "member" : "workspace",
                "mode": storedMode,
                "auto_target": storedTarget ?? NSNull(),
            ]
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(storedMemberID),
                   'work.tier_policy.changed', 'work_tier_policy',
                   \(principal.tokenID), \(Self.jsonString(detail))::jsonb)
                """,
                logger: db.logger
            )
            return WorkTierPolicyDTO(
                workspaceId: workspaceID.uuidString,
                memberId: storedMemberID?.uuidString,
                mode: storedMode,
                autoTarget: storedTarget,
                inherited: false,
                updatedAtMs: Self.epochMs(updatedAt)
            )
        }

        return try WorkTierPolicyResponse(workTierPolicy: policy)
            .response(from: request, context: context)
    }

    static func validatedMode(_ raw: String) throws -> String {
        guard ["t1_only", "ask", "auto"].contains(raw) else {
            throw HTTPError(.badRequest, message: "mode must be t1_only, ask, or auto")
        }
        return raw
    }

    static func validatedAutoTarget(_ raw: String?, mode: String) throws -> String? {
        if mode != "auto" {
            guard raw == nil else {
                throw HTTPError(.badRequest, message: "autoTarget is allowed only in auto mode")
            }
            return nil
        }
        guard let raw else {
            throw HTTPError(.badRequest, message: "auto mode requires autoTarget")
        }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value == "cloud" || UUID(uuidString: value) != nil else {
            throw HTTPError(.badRequest, message: "autoTarget must be a work host id or cloud")
        }
        return value
    }

    private static func requireAllowedTarget(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        scope: Scope,
        autoTarget: String?
    ) async throws {
        guard let autoTarget, autoTarget != "cloud", let hostID = UUID(uuidString: autoTarget) else {
            return
        }
        let rows = try await conn.query(
            """
            SELECT scope, owner_member_id
              FROM work_host
             WHERE id = \(hostID)
               AND workspace_id = \(workspaceID)
               AND revoked_at IS NULL
             FOR SHARE
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "auto target work host is unavailable")
        }
        let (hostScope, ownerMemberID) = try row.decode((String, UUID).self)
        switch scope {
        case .workspace:
            guard hostScope == "workspace" else {
                throw HTTPError(.conflict, message: "workspace policy requires a workspace-scoped host")
            }
        case .member(let memberID):
            guard hostScope == "workspace" || ownerMemberID == memberID else {
                throw HTTPError(.conflict, message: "member policy target belongs to another member")
            }
        }
    }

    private static func loadPolicy(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        scope: Scope
    ) async throws -> WorkTierPolicyDTO {
        let rows: [PostgresRow]
        switch scope {
        case .workspace:
            rows = try await conn.query(
                """
                SELECT member_id, mode, auto_target, updated_at, false AS inherited
                  FROM work_tier_policy
                 WHERE workspace_id = \(workspaceID)
                   AND member_id IS NULL
                 LIMIT 1
                """,
                logger: logger
            ).collect()
        case .member(let memberID):
            rows = try await conn.query(
                """
                SELECT member_id, mode, auto_target, updated_at, inherited
                  FROM (
                    SELECT member_id, mode, auto_target, updated_at,
                           false AS inherited, 0 AS priority
                      FROM work_tier_policy
                     WHERE workspace_id = \(workspaceID)
                       AND member_id = \(memberID)
                    UNION ALL
                    SELECT \(memberID), mode, auto_target, updated_at,
                           true AS inherited, 1 AS priority
                      FROM work_tier_policy
                     WHERE workspace_id = \(workspaceID)
                       AND member_id IS NULL
                  ) p
                 ORDER BY priority
                 LIMIT 1
                """,
                logger: logger
            ).collect()
        }
        guard let row = rows.first else {
            let memberID: UUID?
            if case .member(let id) = scope { memberID = id } else { memberID = nil }
            return WorkTierPolicyDTO(
                workspaceId: workspaceID.uuidString,
                memberId: memberID?.uuidString,
                mode: "ask",
                autoTarget: nil,
                inherited: memberID != nil,
                updatedAtMs: nil
            )
        }
        let (memberID, mode, autoTarget, updatedAt, inherited) = try row.decode(
            (UUID?, String, String?, Date, Bool).self
        )
        return WorkTierPolicyDTO(
            workspaceId: workspaceID.uuidString,
            memberId: memberID?.uuidString,
            mode: mode,
            autoTarget: autoTarget,
            inherited: inherited,
            updatedAtMs: epochMs(updatedAt)
        )
    }

    private static func requireWorkspaceAdmin(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws {
        guard (try? await WorkspaceAuthorization.requireAdmin(
            conn: conn, logger: logger, principal: principal
        )) != nil else {
            throw HTTPError(.forbidden, message: "workspace tier policy requires owner or admin")
        }
    }

    private static func requireActiveHuman(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member m
             WHERE m.workspace_id = \(principal.workspaceID)
               AND m.id = \(principal.memberID)
               AND m.kind = 'human'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
               AND EXISTS (
                 SELECT 1
                   FROM membership ms
                  WHERE ms.workspace_id = m.workspace_id
                    AND ms.member_id = m.id
                    AND ms.left_at IS NULL
               )
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard !rows.isEmpty else {
            throw HTTPError(.forbidden, message: "active human membership required")
        }
    }

    private static func requireHuman(_ context: AppRequestContext) throws -> (AuthPrincipal, UUID) {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "work tier policy requires a human bearer")
        }
        return (principal, try InviteRoutes.workspaceID(context, principal: principal))
    }

    private func withTenantTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await db.withTenantTransaction(workspaceID: workspaceID, body)
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    private static func epochMs(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1_000)
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else { return "{}" }
        return json
    }
}
