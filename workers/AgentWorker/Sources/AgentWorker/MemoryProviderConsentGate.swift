import Foundation
import Logging
import OutboundHTTPPolicy
import PostgresNIO

enum MemoryProviderConsentDecision: Equatable, Sendable {
    case proceed
    case skipAndAudit

    static func evaluate(
        providerTrust: ProviderEndpointTrust,
        workspaceConsented: Bool
    ) -> Self {
        providerTrust.requiresWorkspaceConsent && !workspaceConsented
            ? .skipAndAudit
            : .proceed
    }
}

/// Reads the server-owned workspace consent ledger before any raw memory text
/// can cross the provider boundary. The worker does not infer workspace policy
/// from environment flags. Local/self-host trust classification is shared with
/// the server through OutboundHTTPPolicy.
struct MemoryProviderConsentGate: Sendable {
    let pg: PostgresClient
    let providerTrust: ProviderEndpointTrust
    let logger: Logger

    var requiresConsent: Bool { providerTrust.requiresWorkspaceConsent }

    func isAllowed(workspaceID: UUID) async throws -> Bool {
        guard requiresConsent else { return true }
        let rows = try await pg.query(
            "SELECT memory_external_provider_consent FROM workspace WHERE id = \(workspaceID)",
            logger: logger
        ).collect()
        guard let consented = try rows.first?.decode(Bool.self) else { return false }
        return MemoryProviderConsentDecision.evaluate(
            providerTrust: providerTrust,
            workspaceConsented: consented
        ) == .proceed
    }

    func recordRequiredOnce(workspaceID: UUID) async throws {
        guard requiresConsent else { return }
        try await pg.withTransaction(logger: logger) { conn in
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type, target_id, detail)
                VALUES
                  (\(workspaceID), NULL::uuid, 'memory.extraction.consent_required',
                   'workspace', \(workspaceID),
                   jsonb_build_object(
                     'schema', 'momo.memory.extraction.consent_required.v1',
                     'provider_trust', \(providerTrust.rawValue),
                     'extraction_skipped', true,
                     'embedding_skipped', true))
                ON CONFLICT (workspace_id, action)
                  WHERE action = 'memory.extraction.consent_required'
                DO NOTHING
                """,
                logger: logger
            )
        }
    }
}
