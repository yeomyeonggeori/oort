import Foundation
import Logging
import PostgresNIO
import ServiceLifecycle

struct DatabaseSecurityPosture: Equatable, Sendable {
    let currentUser: String
    let isSuperuser: Bool
    let bypassesRLS: Bool

    static func requiresBootGuard(environmentName: String) -> Bool {
        switch environmentName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "staging", "prod", "production", "internal-host", "internal-smoke":
            true
        default:
            false
        }
    }

    func validateForAPIBoot() throws {
        guard currentUser == "momo_app" else {
            throw DatabaseSecurityPostureError.unexpectedRole(currentUser)
        }
        guard !isSuperuser else {
            throw DatabaseSecurityPostureError.superuser(currentUser)
        }
        guard !bypassesRLS else {
            throw DatabaseSecurityPostureError.bypassesRLS(currentUser)
        }
    }
}

enum DatabaseSecurityPostureError: Error, Equatable, LocalizedError {
    case missingCurrentRole
    case unexpectedRole(String)
    case superuser(String)
    case bypassesRLS(String)

    var errorDescription: String? {
        switch self {
        case .missingCurrentRole:
            "database current_user posture query returned no role"
        case .unexpectedRole(let role):
            "API database current_user must be momo_app, got \(role)"
        case .superuser(let role):
            "API database role \(role) is a superuser; refusing to boot"
        case .bypassesRLS(let role):
            "API database role \(role) has BYPASSRLS; refusing to boot"
        }
    }
}

/// Runs against the same pool used by API routes. A failed query or unsafe
/// `current_user` throws from the service group, cancelling the HTTP service so
/// a strict deployment cannot remain healthy with RLS bypassed.
struct DatabaseSecurityPostureService: Service {
    let database: Database
    let logger: Logger

    func run() async throws {
        let rows = try await database.client.query(
            """
            SELECT current_user::text, rolsuper, rolbypassrls
              FROM pg_roles
             WHERE rolname = current_user
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw DatabaseSecurityPostureError.missingCurrentRole
        }
        let decoded = try row.decode((String, Bool, Bool).self)
        let posture = DatabaseSecurityPosture(
            currentUser: decoded.0,
            isSuperuser: decoded.1,
            bypassesRLS: decoded.2
        )
        try posture.validateForAPIBoot()
        logger.info("database API role posture verified", metadata: [
            "currentUser": .string(posture.currentUser),
            "superuser": .stringConvertible(posture.isSuperuser),
            "bypassRLS": .stringConvertible(posture.bypassesRLS),
        ])
        try? await gracefulShutdown()
    }
}
