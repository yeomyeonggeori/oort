import Foundation
import HTTPTypes
import Hummingbird
import Logging
import PostgresNIO

/// ADR-0113 SE-04A catalog/install/delegated-grant surface.
///
/// The server records policy and audit evidence only. Request DTOs have no
/// credential fields, SQL stores no provider secret, audit detail is an
/// allowlisted object, and response DTOs expose no token-shaped value.
struct PluginRoutes: Sendable {
    let db: Database

    // ADR-0113 D6 defines the onboarding example set as GitHub + Drive +
    // Slack-compatible webhook. Keep this product recommendation distinct
    // from each manifest's category-oriented `recommendedFor` metadata.
    private static let onboardingRecommendedPluginIDs: Set<String> = [
        "com.momo.plugins.github",
        "com.momo.plugins.drive",
        "external_webhook",
    ]

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/plugins", use: list)
        group.get("/v1/workspaces/:ws/plugins/:plugin", use: detail)
        group.post("/v1/workspaces/:ws/plugins/:plugin/install", use: install)
        group.delete("/v1/workspaces/:ws/plugins/:plugin/install", use: revokeInstall)
        group.post("/v1/workspaces/:ws/plugins/:plugin/grants", use: grant)
        group.delete("/v1/workspaces/:ws/plugins/:plugin/grants/:scope", use: revokeGrant)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        // Review #435 H1: HTTPError thrown inside the tenant closure gets
        // wrapped by PostgresNIO and rendered as 500 — unwrap like the
        // mutating handlers so 403/404/409 keep their semantics.
        let result = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceRole(conn: conn, logger: db.logger, principal: principal)
            let policyMemberID = try await Self.policyMemberID(
                request: request,
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT pr.plugin_id,
                       pr.manifest::text,
                       pr.manifest_digest,
                       'sha256:' || encode(sha256(convert_to(pr.manifest::text, 'UTF8')), 'hex'),
                       pr.revoked_at IS NOT NULL,
                       pr.official,
                       COALESCE(wpi.revoked_at IS NULL, false) AND wpi.id IS NOT NULL,
                       COALESCE(wpi.enabled, false)
                  FROM plugin_registry pr
                  LEFT JOIN workspace_plugin_install wpi
                    ON wpi.workspace_id = \(workspaceID)
                   AND wpi.plugin_id = pr.plugin_id
                 ORDER BY pr.official DESC, pr.plugin_id
                """,
                logger: db.logger
            ).collect()
            var manifests: [String: (RegistryRow, ValidatedPluginManifest)] = [:]
            let plugins = try rows.compactMap { row -> PluginCatalogItemDTO? in
                let decoded = try Self.decodeRegistryRow(row)
                guard let manifest = try? Self.validatedManifest(decoded) else { return nil }
                manifests[manifest.pluginID] = (decoded, manifest)
                return PluginCatalogItemDTO(
                    pluginId: manifest.pluginID,
                    name: manifest.name,
                    version: manifest.version,
                    description: manifest.description,
                    official: decoded.official,
                    recommended: Self.onboardingRecommendedPluginIDs.contains(manifest.pluginID),
                    egressDomains: manifest.egressDomains,
                    recommendedFor: manifest.recommendedFor,
                    installed: decoded.installed,
                    enabled: decoded.installed && decoded.enabled
                )
            }
            let capabilityRows = try await conn.query(
                """
                SELECT pcp.plugin_id, pcp.tool_name, pcp.risk, pcp.approval_tier
                  FROM plugin_capability_projection pcp
                  JOIN plugin_grant pg
                    ON pg.id = pcp.grant_id
                   AND pg.workspace_id = pcp.workspace_id
                   AND pg.member_id = pcp.member_id
                   AND pg.plugin_id = pcp.plugin_id
                   AND pg.scope = pcp.scope
                   AND pg.status = 'active'
                   AND pg.revoked_at IS NULL
                  JOIN workspace_plugin_install wpi
                    ON wpi.workspace_id = pcp.workspace_id
                   AND wpi.plugin_id = pcp.plugin_id
                   AND wpi.enabled
                   AND wpi.revoked_at IS NULL
                 WHERE pcp.workspace_id = \(workspaceID)
                   AND pcp.member_id = \(policyMemberID)
                 ORDER BY pcp.plugin_id, pcp.tool_name
                """,
                logger: db.logger
            ).collect()
            var toolsByPlugin: [String: [PluginPolicyToolDTO]] = [:]
            for row in capabilityRows {
                let (pluginID, toolName, risk, approvalTier) = try row.decode(
                    (String, String, String, String).self
                )
                guard manifests[pluginID] != nil else { continue }
                toolsByPlugin[pluginID, default: []].append(
                    PluginPolicyToolDTO(
                        name: toolName,
                        risk: risk,
                        approvalTier: approvalTier
                    )
                )
            }
            let policyPlugins = try toolsByPlugin.keys.sorted().compactMap { pluginID -> PluginPolicyDescriptorDTO? in
                guard let (_, manifest) = manifests[pluginID],
                      let tools = toolsByPlugin[pluginID], !tools.isEmpty
                else { return nil }
                return PluginPolicyDescriptorDTO(
                    pluginId: pluginID,
                    mcp: PluginPolicyMCPDTO(
                        url: try Self.descriptorURL(manifest: manifest, request: request),
                        transport: manifest.mcpTransport
                    ),
                    egressDomains: manifest.egressDomains,
                    tools: tools
                )
            }
            return PluginCatalogResponse(
                plugins: plugins,
                toolPolicy: PluginToolPolicyDTO(plugins: policyPlugins)
            )
        }
        return try result.response(from: request, context: context)
    }

    @Sendable
    func detail(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let pluginID = try Self.pluginID(context)
        let dto = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceRole(conn: conn, logger: db.logger, principal: principal)
            let row = try await Self.registryRow(
                conn: conn, logger: db.logger, workspaceID: workspaceID, pluginID: pluginID
            )
            let manifest = try Self.validatedManifest(row)
            return PluginDetailDTO(
                pluginId: manifest.pluginID,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
                official: row.official,
                egressDomains: manifest.egressDomains,
                recommendedFor: manifest.recommendedFor,
                installed: row.installed,
                enabled: row.installed && row.enabled,
                manifest: manifest.json
            )
        }
        return try PluginDetailResponse(plugin: dto).response(from: request, context: context)
    }

    @Sendable
    func install(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let pluginID = try Self.pluginID(context)
        let body = try await request.decode(as: InstallPluginRequest.self, context: context)

        let outcome = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            let role = try await Self.requireWorkspaceRole(conn: conn, logger: db.logger, principal: principal)
            let row = try await Self.registryRow(
                conn: conn, logger: db.logger, workspaceID: workspaceID, pluginID: pluginID
            )
            let manifest = try Self.validatedManifest(row)
            guard manifest.installAllowed, manifest.allowedRoles.contains(role) else {
                throw HTTPError(.forbidden, message: "plugin serverPolicy rejects installation")
            }
            let enabled = body.enabled ?? manifest.enabledByDefault
            try await Self.lockMutation(
                conn: conn, logger: db.logger,
                key: "install:\(workspaceID.uuidString):\(pluginID)"
            )
            let existing = try await conn.query(
                """
                SELECT id, revoked_at IS NULL
                  FROM workspace_plugin_install
                 WHERE workspace_id = \(workspaceID) AND plugin_id = \(pluginID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect().first
            let installID: UUID
            let created: Bool
            if let existing {
                let decoded = try existing.decode((UUID, Bool).self)
                installID = decoded.0
                created = false
            } else {
                installID = UUID()
                created = true
            }
            let auditID = UUID()
            try await Self.insertAudit(
                conn: conn,
                logger: db.logger,
                id: auditID,
                workspaceID: workspaceID,
                principal: principal,
                action: "plugin.installed",
                targetType: "plugin_install",
                targetID: installID,
                detailJSON: try Self.auditDetail([
                    "schema": .string("momo.plugin.installed.v1"),
                    "plugin_id": .string(pluginID),
                    "enabled": .bool(enabled),
                ])
            )
            if created {
                _ = try await conn.query(
                    """
                    INSERT INTO workspace_plugin_install
                      (id, workspace_id, plugin_id, enabled, installed_by, installed_audit_id)
                    VALUES (\(installID), \(workspaceID), \(pluginID), \(enabled),
                            \(principal.memberID), \(auditID))
                    """,
                    logger: db.logger
                )
            } else {
                _ = try await conn.query(
                    """
                    UPDATE workspace_plugin_install
                       SET enabled = \(enabled),
                           installed_by = \(principal.memberID),
                           installed_audit_id = \(auditID),
                           revoked_at = NULL,
                           revoked_by = NULL,
                           revoked_audit_id = NULL,
                           updated_at = now()
                     WHERE id = \(installID)
                    """,
                    logger: db.logger
                )
            }
            return (PluginMutationResponse(
                pluginId: pluginID,
                memberId: nil,
                scope: nil,
                status: enabled ? "enabled" : "disabled",
                enabled: enabled,
                auditRef: auditID.uuidString,
                capabilities: []
            ), created)
        }
        var response = try outcome.0.response(from: request, context: context)
        response.status = outcome.1 ? .created : .ok
        return response
    }

    @Sendable
    func revokeInstall(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let pluginID = try Self.pluginID(context)
        let result = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceAdmin(conn: conn, logger: db.logger, principal: principal)
            try await Self.lockMutation(
                conn: conn, logger: db.logger,
                key: "install:\(workspaceID.uuidString):\(pluginID)"
            )
            let rows = try await conn.query(
                """
                SELECT id, revoked_at IS NULL, revoked_audit_id
                  FROM workspace_plugin_install
                 WHERE workspace_id = \(workspaceID) AND plugin_id = \(pluginID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { throw HTTPError(.notFound, message: "plugin install not found") }
            let (installID, active, previousAuditID) = try row.decode((UUID, Bool, UUID?).self)
            var auditID = previousAuditID
            if active {
                let newAuditID = UUID()
                try await Self.insertAudit(
                    conn: conn,
                    logger: db.logger,
                    id: newAuditID,
                    workspaceID: workspaceID,
                    principal: principal,
                    action: "plugin.revoked",
                    targetType: "plugin_install",
                    targetID: installID,
                    detailJSON: try Self.auditDetail([
                        "schema": .string("momo.plugin.revoked.v1"),
                        "plugin_id": .string(pluginID),
                    ])
                )
                _ = try await conn.query(
                    """
                    UPDATE workspace_plugin_install
                       SET enabled = false,
                           revoked_at = now(),
                           revoked_by = \(principal.memberID),
                           revoked_audit_id = \(newAuditID),
                           updated_at = now()
                     WHERE id = \(installID)
                    """,
                    logger: db.logger
                )
                _ = try await conn.query(
                    """
                    UPDATE plugin_grant
                       SET status = 'revoked',
                           revoked_at = now(),
                           revoked_audit_id = \(newAuditID),
                           updated_at = now()
                     WHERE workspace_id = \(workspaceID)
                       AND plugin_id = \(pluginID)
                       AND status = 'active'
                    """,
                    logger: db.logger
                )
                auditID = newAuditID
            }
            _ = try await conn.query(
                "DELETE FROM plugin_capability_projection WHERE workspace_id = \(workspaceID) AND plugin_id = \(pluginID)",
                logger: db.logger
            )
            return PluginMutationResponse(
                pluginId: pluginID,
                memberId: nil,
                scope: nil,
                status: "revoked",
                enabled: false,
                auditRef: auditID?.uuidString,
                capabilities: []
            )
        }
        return try result.response(from: request, context: context)
    }

    @Sendable
    func grant(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let pluginID = try Self.pluginID(context)
        let body = try await request.decode(as: GrantPluginRequest.self, context: context)
        let scope = try Self.normalizedScope(body.scope)

        let outcome = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceRole(conn: conn, logger: db.logger, principal: principal)
            let installRows = try await conn.query(
                """
                SELECT 1
                  FROM workspace_plugin_install
                 WHERE workspace_id = \(workspaceID)
                   AND plugin_id = \(pluginID)
                   AND enabled
                   AND revoked_at IS NULL
                """,
                logger: db.logger
            ).collect()
            guard !installRows.isEmpty else {
                throw HTTPError(.conflict, message: "plugin is not installed and enabled")
            }
            let registry = try await Self.registryRow(
                conn: conn, logger: db.logger, workspaceID: workspaceID, pluginID: pluginID
            )
            let manifest = try Self.validatedManifest(registry)
            let tools = manifest.tools.filter { $0.scopes.contains(scope) }
            guard !tools.isEmpty else { throw HTTPError(.badRequest, message: "scope is not declared by this plugin") }

            try await Self.lockMutation(
                conn: conn, logger: db.logger,
                key: "grant:\(workspaceID.uuidString):\(principal.memberID.uuidString):\(pluginID):\(scope)"
            )
            let existing = try await conn.query(
                """
                SELECT id
                  FROM plugin_grant
                 WHERE workspace_id = \(workspaceID)
                   AND member_id = \(principal.memberID)
                   AND plugin_id = \(pluginID)
                   AND scope = \(scope)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect().first
            let grantID = try existing?.decode(UUID.self) ?? UUID()
            let created = existing == nil
            let auditID = UUID()
            try await Self.insertAudit(
                conn: conn,
                logger: db.logger,
                id: auditID,
                workspaceID: workspaceID,
                principal: principal,
                action: "plugin.grant.created",
                targetType: "plugin_grant",
                targetID: grantID,
                detailJSON: try Self.auditDetail([
                    "schema": .string("momo.plugin.grant.v1"),
                    "plugin_id": .string(pluginID),
                    "scope": .string(scope),
                ])
            )
            if created {
                _ = try await conn.query(
                    """
                    INSERT INTO plugin_grant
                      (id, workspace_id, member_id, plugin_id, scope,
                       status, granted_by, granted_audit_id)
                    VALUES (\(grantID), \(workspaceID), \(principal.memberID),
                            \(pluginID), \(scope), 'active',
                            \(principal.memberID), \(auditID))
                    """,
                    logger: db.logger
                )
            } else {
                _ = try await conn.query(
                    """
                    UPDATE plugin_grant
                       SET status = 'active',
                           granted_by = \(principal.memberID),
                           granted_audit_id = \(auditID),
                           revoked_at = NULL,
                           revoked_audit_id = NULL,
                           updated_at = now()
                     WHERE id = \(grantID)
                    """,
                    logger: db.logger
                )
            }
            _ = try await conn.query(
                """
                DELETE FROM plugin_capability_projection
                 WHERE workspace_id = \(workspaceID)
                   AND member_id = \(principal.memberID)
                   AND plugin_id = \(pluginID)
                   AND scope = \(scope)
                """,
                logger: db.logger
            )
            for tool in tools {
                _ = try await conn.query(
                    """
                    INSERT INTO plugin_capability_projection
                      (workspace_id, member_id, plugin_id, scope, tool_name,
                       capability_version, schema_digest, risk, approval_tier, grant_id)
                    VALUES (\(workspaceID), \(principal.memberID), \(pluginID), \(scope),
                            \(tool.name), \(manifest.version), \(tool.schemaDigest),
                            \(tool.risk), \(tool.approvalTier), \(grantID))
                    """,
                    logger: db.logger
                )
            }
            return (PluginMutationResponse(
                pluginId: pluginID,
                memberId: principal.memberID.uuidString,
                scope: scope,
                status: "active",
                enabled: true,
                auditRef: auditID.uuidString,
                capabilities: tools.map(\.name)
            ), created)
        }
        var response = try outcome.0.response(from: request, context: context)
        response.status = outcome.1 ? .created : .ok
        return response
    }

    @Sendable
    func revokeGrant(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let pluginID = try Self.pluginID(context)
        let scope = try Self.normalizedScope(context.parameters.require("scope"))
        let result = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceRole(conn: conn, logger: db.logger, principal: principal)
            try await Self.lockMutation(
                conn: conn, logger: db.logger,
                key: "grant:\(workspaceID.uuidString):\(principal.memberID.uuidString):\(pluginID):\(scope)"
            )
            let rows = try await conn.query(
                """
                SELECT id, status, revoked_audit_id
                  FROM plugin_grant
                 WHERE workspace_id = \(workspaceID)
                   AND member_id = \(principal.memberID)
                   AND plugin_id = \(pluginID)
                   AND scope = \(scope)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { throw HTTPError(.notFound, message: "plugin grant not found") }
            let (grantID, status, priorAuditID) = try row.decode((UUID, String, UUID?).self)
            var auditID = priorAuditID
            if status == "active" {
                let newAuditID = UUID()
                try await Self.insertAudit(
                    conn: conn,
                    logger: db.logger,
                    id: newAuditID,
                    workspaceID: workspaceID,
                    principal: principal,
                    action: "plugin.grant.revoked",
                    targetType: "plugin_grant",
                    targetID: grantID,
                    detailJSON: try Self.auditDetail([
                        "schema": .string("momo.plugin.grant.revoked.v1"),
                        "plugin_id": .string(pluginID),
                        "scope": .string(scope),
                    ])
                )
                _ = try await conn.query(
                    """
                    UPDATE plugin_grant
                       SET status = 'revoked',
                           revoked_at = now(),
                           revoked_audit_id = \(newAuditID),
                           updated_at = now()
                     WHERE id = \(grantID)
                    """,
                    logger: db.logger
                )
                auditID = newAuditID
            }
            _ = try await conn.query(
                """
                DELETE FROM plugin_capability_projection
                 WHERE workspace_id = \(workspaceID)
                   AND member_id = \(principal.memberID)
                   AND plugin_id = \(pluginID)
                   AND scope = \(scope)
                """,
                logger: db.logger
            )
            return PluginMutationResponse(
                pluginId: pluginID,
                memberId: principal.memberID.uuidString,
                scope: scope,
                status: "revoked",
                enabled: true,
                auditRef: auditID?.uuidString,
                capabilities: []
            )
        }
        return try result.response(from: request, context: context)
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

    private struct RegistryRow: Sendable {
        let pluginID: String
        let manifestJSON: String
        let expectedDigest: String
        let computedDigest: String
        let revoked: Bool
        let official: Bool
        let installed: Bool
        let enabled: Bool
    }

    private static func registryRow(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        pluginID: String
    ) async throws -> RegistryRow {
        let rows = try await conn.query(
            """
            SELECT pr.plugin_id,
                   pr.manifest::text,
                   pr.manifest_digest,
                   'sha256:' || encode(sha256(convert_to(pr.manifest::text, 'UTF8')), 'hex'),
                   pr.revoked_at IS NOT NULL,
                   pr.official,
                   COALESCE(wpi.revoked_at IS NULL, false) AND wpi.id IS NOT NULL,
                   COALESCE(wpi.enabled, false)
              FROM plugin_registry pr
              LEFT JOIN workspace_plugin_install wpi
                ON wpi.workspace_id = \(workspaceID)
               AND wpi.plugin_id = pr.plugin_id
             WHERE pr.plugin_id = \(pluginID)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { throw HTTPError(.notFound, message: "plugin not found") }
        return try decodeRegistryRow(row)
    }

    private static func decodeRegistryRow(_ row: PostgresRow) throws -> RegistryRow {
        let decoded = try row.decode((String, String, String, String, Bool, Bool, Bool, Bool).self)
        return RegistryRow(
            pluginID: decoded.0,
            manifestJSON: decoded.1,
            expectedDigest: decoded.2,
            computedDigest: decoded.3,
            revoked: decoded.4,
            official: decoded.5,
            installed: decoded.6,
            enabled: decoded.7
        )
    }

    private static func validatedManifest(_ row: RegistryRow) throws -> ValidatedPluginManifest {
        do {
            let manifest = try PluginManifestValidator.validate(
                manifestJSON: row.manifestJSON,
                expectedDigest: row.expectedDigest,
                computedDigest: row.computedDigest,
                revoked: row.revoked
            )
            guard manifest.pluginID == row.pluginID else {
                throw PluginManifestValidationError.rejected("registry id does not match manifest")
            }
            return manifest
        } catch let error as PluginManifestValidationError {
            throw HTTPError(.conflict, message: "plugin manifest rejected: \(error.description)")
        }
    }

    private static func humanPrincipal(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human delegated user required")
        }
        return principal
    }

    static func policyMemberID(
        request: Request,
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal
    ) async throws -> UUID {
        guard principal.kind == .agent else { return principal.memberID }
        guard let delegatedRaw = request.uri.queryParameters["delegatedMemberId"].map(String.init),
              let channelRaw = request.uri.queryParameters["channelId"].map(String.init),
              let delegatedMemberID = UUID(uuidString: delegatedRaw),
              let channelID = UUID(uuidString: channelRaw)
        else {
            throw HTTPError(.badRequest, message: "agent plugin policy requires delegatedMemberId and channelId")
        }
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member delegated
              JOIN membership delegated_membership
                ON delegated_membership.workspace_id = delegated.workspace_id
               AND delegated_membership.member_id = delegated.id
               AND delegated_membership.channel_id = \(channelID)
               AND delegated_membership.left_at IS NULL
              JOIN membership agent_membership
                ON agent_membership.workspace_id = delegated_membership.workspace_id
               AND agent_membership.channel_id = delegated_membership.channel_id
               AND agent_membership.member_id = \(principal.memberID)
               AND agent_membership.left_at IS NULL
             WHERE delegated.workspace_id = \(workspaceID)
               AND delegated.id = \(delegatedMemberID)
               AND delegated.kind = 'human'
               AND delegated.status = 'active'
               AND delegated.deleted_at IS NULL
            """,
            logger: logger
        ).collect()
        guard !rows.isEmpty else {
            throw HTTPError(.forbidden, message: "delegated member is not active in the agent job channel")
        }
        return delegatedMemberID
    }

    static func descriptorURL(
        manifest: ValidatedPluginManifest,
        request: Request,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> String {
        guard manifest.hosted else { return manifest.mcpURL }
        if let configured = environment["PUBLIC_BASE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !configured.isEmpty
        {
            guard let components = URLComponents(string: configured),
                  components.host != nil,
                  components.user == nil,
                  components.password == nil,
                  components.query == nil,
                  components.fragment == nil,
                  components.path.isEmpty || components.path == "/",
                  let base = components.url,
                  base.scheme == "https" || Self.isLocalHTTP(base),
                  let resolved = URL(string: manifest.mcpURL, relativeTo: base)?.absoluteURL
            else { throw HTTPError(.internalServerError, message: "hosted MCP public origin is invalid") }
            return resolved.absoluteString
        }

        let forwardedProto = HTTPField.Name("X-Forwarded-Proto")
            .flatMap { request.headers[$0] }?
            .split(separator: ",").first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let host = request.head.authority?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty,
              !host.contains("/"),
              !host.contains("@")
        else { throw HTTPError(.internalServerError, message: "hosted MCP public origin is unavailable") }
        let localHost = host.lowercased().hasPrefix("localhost:")
            || host.lowercased().hasPrefix("127.0.0.1:")
            || host.lowercased() == "localhost"
            || host.lowercased() == "127.0.0.1"
        let scheme = forwardedProto ?? (localHost ? "http" : "https")
        guard scheme == "https" || scheme == "http" && localHost,
              let absolute = URL(string: "\(scheme)://\(host)\(manifest.mcpURL)")
        else { throw HTTPError(.internalServerError, message: "hosted MCP public origin is invalid") }
        return absolute.absoluteString
    }

    private static func isLocalHTTP(_ url: URL) -> Bool {
        guard url.scheme == "http" else { return false }
        return url.host == "localhost" || url.host == "127.0.0.1"
    }

    private static func workspaceID(
        _ context: AppRequestContext, principal: AuthPrincipal
    ) throws -> UUID {
        let raw = try context.parameters.require("ws")
        guard let workspaceID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        guard workspaceID == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return workspaceID
    }

    private static func pluginID(_ context: AppRequestContext) throws -> String {
        let value = try context.parameters.require("plugin").lowercased()
        guard value.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{2,127}$/) != nil else {
            throw HTTPError(.badRequest, message: "invalid plugin id")
        }
        return value
    }

    static func normalizedScope(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.wholeMatch(of: /^[a-z0-9][a-z0-9:._\/-]{0,127}$/) != nil else {
            throw HTTPError(.badRequest, message: "invalid plugin scope")
        }
        return value
    }

    @discardableResult
    private static func requireWorkspaceRole(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws -> String {
        try await WorkspaceAuthorization.requireMember(
            conn: conn, logger: logger, principal: principal
        ).rawValue
    }

    @discardableResult
    private static func requireWorkspaceAdmin(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws -> String {
        try await WorkspaceAuthorization.requireAdmin(
            conn: conn, logger: logger, principal: principal
        ).rawValue
    }

    private static func lockMutation(
        conn: PostgresConnection,
        logger: Logger,
        key: String
    ) async throws {
        _ = try await conn.query(
            "SELECT pg_advisory_xact_lock(hashtextextended(\(key), 0))",
            logger: logger
        )
    }

    private static func insertAudit(
        conn: PostgresConnection,
        logger: Logger,
        id: UUID,
        workspaceID: UUID,
        principal: AuthPrincipal,
        action: String,
        targetType: String,
        targetID: UUID,
        detailJSON: String
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (id, workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES (\(id), \(workspaceID), \(principal.memberID), \(principal.memberID),
                    \(action), \(targetType), \(targetID), \(principal.tokenID), \(detailJSON)::jsonb)
            """,
            logger: logger
        )
    }

    private static func auditDetail(_ values: [String: JSONValue]) throws -> String {
        let data = try JSONEncoder().encode(JSONValue.object(values))
        guard let string = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "plugin audit detail encoding failed")
        }
        return string
    }
}

private struct InstallPluginRequest: Decodable, Sendable {
    let enabled: Bool?
}

private struct GrantPluginRequest: Decodable, Sendable {
    let scope: String
}

private struct PluginCatalogItemDTO: Codable, Sendable {
    let pluginId: String
    let name: String
    let version: String
    let description: String
    let official: Bool
    let recommended: Bool
    let egressDomains: [String]
    let recommendedFor: [String]
    let installed: Bool
    let enabled: Bool
}

private struct PluginCatalogResponse: Codable, ResponseEncodable, Sendable {
    let plugins: [PluginCatalogItemDTO]
    let toolPolicy: PluginToolPolicyDTO
}

private struct PluginToolPolicyDTO: Codable, Sendable {
    let plugins: [PluginPolicyDescriptorDTO]
}

private struct PluginPolicyDescriptorDTO: Codable, Sendable {
    let pluginId: String
    let mcp: PluginPolicyMCPDTO
    let egressDomains: [String]
    let tools: [PluginPolicyToolDTO]
}

private struct PluginPolicyMCPDTO: Codable, Sendable {
    let url: String
    let transport: String
}

private struct PluginPolicyToolDTO: Codable, Sendable {
    let name: String
    let risk: String
    let approvalTier: String
}

private struct PluginDetailDTO: Codable, Sendable {
    let pluginId: String
    let name: String
    let version: String
    let description: String
    let official: Bool
    let egressDomains: [String]
    let recommendedFor: [String]
    let installed: Bool
    let enabled: Bool
    let manifest: JSONValue
}

private struct PluginDetailResponse: Codable, ResponseEncodable, Sendable {
    let plugin: PluginDetailDTO
}

private struct PluginMutationResponse: Codable, ResponseEncodable, Sendable {
    let pluginId: String
    let memberId: String?
    let scope: String?
    let status: String
    let enabled: Bool
    let auditRef: String?
    let capabilities: [String]
}
