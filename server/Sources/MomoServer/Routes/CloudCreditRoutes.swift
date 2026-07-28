import Foundation
import Hummingbird
import PostgresNIO

struct CloudCreditTopupRequest: Decodable {
    let amountMicroUsd: Int64
    let idempotencyRef: String
}

struct CloudCreditTopupResponse: ResponseEncodable, Encodable {
    let workspaceId: String
    let amountMicroUsd: Int64
    let idempotencyRef: String
    let balanceMicroUsd: Int64
}

/// Paid-credit mutation surface.
///
/// Cross-tenant reads and paid execution authority are deliberately separate:
/// `platform:read` must never be sufficient to increase a workspace balance.
/// The append-only credit row, balance trigger, and audit row commit together.
struct CloudCreditRoutes: Sendable {
    static let writeScope = "platform:credits:write"

    let db: Database
    let platformAdminEmails: [String]
    let cloudProvisionerConfig: CloudProvisionerConfig

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/admin/workspaces/:ws/credits/topups", use: topup)
    }

    @Sendable
    func topup(_ request: Request, context: AppRequestContext) async throws -> Response {
        try CloudProvisionerRoutes.requireEnabled(cloudProvisionerConfig)
        let principal = try await Self.requireCreditWriter(
            db: db,
            platformAdminEmails: platformAdminEmails,
            context: context
        )
        let rawWorkspaceID = try context.parameters.require("ws")
        guard let workspaceID = UUID(uuidString: rawWorkspaceID) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        let input = try await request.decode(as: CloudCreditTopupRequest.self, context: context)
        guard input.amountMicroUsd > 0, input.amountMicroUsd <= 1_000_000_000_000 else {
            throw HTTPError(
                .badRequest,
                message: "amountMicroUsd must be between 1 and 1000000000000"
            )
        }
        guard let refID = UUID(uuidString: input.idempotencyRef) else {
            throw HTTPError(.badRequest, message: "idempotencyRef must be a UUID")
        }

        let balance: Int64 = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let workspaceRows = try await conn.query(
                "SELECT 1 FROM workspace WHERE id = \(workspaceID) FOR SHARE",
                logger: db.logger
            ).collect()
            guard workspaceRows.first != nil else {
                throw HTTPError(.notFound, message: "workspace not found")
            }
            let inserted = try await conn.query(
                """
                INSERT INTO credit_entry
                  (workspace_id, delta_micro_usd, reason, ref_id)
                VALUES
                  (\(workspaceID), \(input.amountMicroUsd), 'topup', \(refID))
                ON CONFLICT (workspace_id, reason, ref_id) DO NOTHING
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            if inserted.first == nil {
                let rows = try await conn.query(
                    """
                    SELECT delta_micro_usd
                      FROM credit_entry
                     WHERE workspace_id = \(workspaceID)
                       AND reason = 'topup'
                       AND ref_id = \(refID)
                    """,
                    logger: db.logger
                ).collect()
                guard let existing = try rows.first?.decode(Int64.self),
                      existing == input.amountMicroUsd
                else {
                    throw HTTPError(
                        .conflict,
                        message: "idempotencyRef was already used with a different amount"
                    )
                }
            } else {
                _ = try await conn.query(
                    """
                    INSERT INTO audit_log
                      (workspace_id, actor_member_id, action, target_type,
                       target_id, via_token_id, detail)
                    VALUES
                      (\(workspaceID), \(principal.memberID), 'work.credit.topped_up',
                       'workspace_credit', \(workspaceID), \(principal.tokenID),
                       jsonb_build_object(
                         'schema', 'momo.work_credit.topup.v1',
                         'amount_micro_usd', \(input.amountMicroUsd),
                         'idempotency_ref', \(refID),
                         'operator_workspace_id', \(principal.workspaceID)
                       ))
                    """,
                    logger: db.logger
                )
            }
            let rows = try await conn.query(
                """
                SELECT balance_micro_usd
                  FROM workspace_credit
                 WHERE workspace_id = \(workspaceID)
                """,
                logger: db.logger
            ).collect()
            guard let value = try rows.first?.decode(Int64.self) else {
                throw HTTPError(.internalServerError, message: "credit balance unavailable")
            }
            return value
        }
        return try CloudCreditTopupResponse(
            workspaceId: workspaceID.uuidString.lowercased(),
            amountMicroUsd: input.amountMicroUsd,
            idempotencyRef: refID.uuidString.lowercased(),
            balanceMicroUsd: balance
        ).response(from: request, context: context)
    }

    static func isCreditWriter(kind: AuthPrincipalKind, scopes: [String]) -> Bool {
        kind == .human && scopes.contains(writeScope)
    }

    /// Two authorized paths, and `platform:read` is neither.
    ///
    /// The scope path is for platform tokens. The listed-instance-operator path
    /// (workspace admin + verified allowlisted email, both checked in the DB
    /// under RLS) is how a self-hosted operator does this at all — a self-host
    /// instance may never mint a platform token, and dropping that path would
    /// leave its T3 balance unreachable except by touching the database.
    ///
    /// What the security fix removed is `platform:read` SUFFICIENCY: a
    /// cross-tenant READ credential must never move money (design-review /
    /// adversarial-review #882). The allowlisted human operator is a different,
    /// deliberate authorization, not a bypass.
    static func requireCreditWriter(
        db: Database,
        platformAdminEmails: [String],
        context: AppRequestContext
    ) async throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human operator required")
        }
        if principal.scopes.contains(writeScope) { return principal }
        let (role, verifiedEmail) = try await db.withTenantConnection(
            workspaceID: principal.workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn,
                logger: db.logger,
                workspaceID: principal.workspaceID,
                memberID: principal.memberID
            )
            var email: String?
            let rows = try await conn.query(
                """
                SELECT email FROM human
                WHERE member_id = \(principal.memberID)
                  AND workspace_id = \(principal.workspaceID)
                  AND email_verified = true
                """,
                logger: db.logger
            )
            for try await row in rows {
                email = try row.decode(String.self)
            }
            return (role, email)
        }
        guard role?.isAdmin ?? false,
              let verifiedEmail,
              platformAdminEmails.contains(verifiedEmail.lowercased())
        else {
            throw HTTPError(
                .forbidden,
                message: "\(writeScope) scope or listed instance operator required"
            )
        }
        return principal
    }
}
