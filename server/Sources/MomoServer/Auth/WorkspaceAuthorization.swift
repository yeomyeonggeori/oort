import Foundation
import Hummingbird
import Logging
import PostgresNIO

enum WorkspaceRole: String, CaseIterable, Sendable {
    case owner
    case admin
    case member
    case guest

    var rank: Int {
        switch self {
        case .owner: 0
        case .admin: 1
        case .member: 2
        case .guest: 3
        }
    }

    var isAdmin: Bool { self == .owner || self == .admin }

    static func parse(_ raw: String) throws -> Self {
        guard let role = Self(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) else {
            throw HTTPError(.badRequest, message: "role must be owner, admin, member, or guest")
        }
        return role
    }
}

/// The single workspace-role authority. Channel roles never imply workspace
/// authority after ADR-0128; all callers share this query and active-member guard.
enum WorkspaceAuthorization {
    static func activeRole(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID,
        forUpdate: Bool = false
    ) async throws -> WorkspaceRole? {
        let rows: [PostgresRow]
        if forUpdate {
            rows = try await conn.query(
                """
                SELECT wm.role::text
                  FROM workspace_membership wm
                  JOIN member m
                    ON m.workspace_id = wm.workspace_id
                   AND m.id = wm.member_id
                 WHERE wm.workspace_id = \(workspaceID)
                   AND wm.member_id = \(memberID)
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                 LIMIT 1
                 FOR UPDATE OF wm, m
                """,
                logger: logger
            ).collect()
        } else {
            rows = try await conn.query(
                """
                SELECT wm.role::text
                  FROM workspace_membership wm
                  JOIN member m
                    ON m.workspace_id = wm.workspace_id
                   AND m.id = wm.member_id
                 WHERE wm.workspace_id = \(workspaceID)
                   AND wm.member_id = \(memberID)
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                 LIMIT 1
                """,
                logger: logger
            ).collect()
        }
        guard let raw = try rows.first?.decode(String.self) else { return nil }
        return WorkspaceRole(rawValue: raw)
    }

    @discardableResult
    static func requireMember(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal,
        forUpdate: Bool = false
    ) async throws -> WorkspaceRole {
        guard let role = try await activeRole(
            conn: conn,
            logger: logger,
            workspaceID: principal.workspaceID,
            memberID: principal.memberID,
            forUpdate: forUpdate
        ) else {
            throw HTTPError(.forbidden, message: "not an active workspace member")
        }
        return role
    }

    @discardableResult
    static func requireAdmin(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal,
        forUpdate: Bool = false
    ) async throws -> WorkspaceRole {
        let role = try await requireMember(
            conn: conn, logger: logger, principal: principal, forUpdate: forUpdate
        )
        guard role.isAdmin else {
            throw HTTPError(.forbidden, message: "workspace admin required")
        }
        return role
    }
}
