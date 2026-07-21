import Foundation
import Hummingbird
import Logging
import PostgresNIO

private struct CreateWorkToolProfileRequest: Decodable, Sendable {
    let toolKey: String
    let displayName: String
    let launchTemplate: JSONValue
    let tierDefaults: JSONValue?
    let enabled: Bool?
}

private struct UpdateWorkToolProfileRequest: Decodable, Sendable {
    let displayName: String?
    let launchTemplate: JSONValue?
    let tierDefaults: JSONValue?
    let enabled: Bool?
}

struct WorkToolProfileDTO: Codable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let toolKey: String
    let displayName: String
    let launchTemplate: JSONValue
    let tierDefaults: JSONValue
    let enabled: Bool
    let createdBy: String
    let updatedBy: String
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

private struct WorkToolProfilesResponse: ResponseEncodable {
    let workToolProfiles: [WorkToolProfileDTO]
}

private struct WorkToolProfileResponse: ResponseEncodable {
    let workToolProfile: WorkToolProfileDTO
}

/// ADR-0130 D3 workspace work-tool catalog.
///
/// Human reads and mutations require workspace admin authority. A signed work
/// host may read only the enabled projection it needs to resolve commands
/// locally; executable paths, environment values, and credentials never enter
/// this API or its audit records.
struct WorkToolProfileRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/work-tool-profiles", use: list)
        group.post("/v1/workspaces/:ws/work-tool-profiles", use: create)
        group.put("/v1/workspaces/:ws/work-tool-profiles/:tool", use: update)
        group.delete("/v1/workspaces/:ws/work-tool-profiles/:tool", use: delete)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let profiles = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            switch principal.kind {
            case .human:
                try await WorkspaceAuthorization.requireAdmin(
                    conn: conn, logger: db.logger, principal: principal
                )
            case .workHost:
                break
            case .agent:
                throw HTTPError(.forbidden, message: "work tool profiles require an admin or work host")
            }
            let enabledClause = principal.kind == .workHost ? "AND enabled" : ""
            let rows = try await conn.query(
                """
                SELECT id, workspace_id, tool_key, display_name,
                       launch_template::text, tier_defaults::text, enabled,
                       created_by, updated_by, created_at, updated_at
                  FROM work_tool_profile
                 WHERE workspace_id = \(workspaceID)
                       \(unescaped: enabledClause)
                 ORDER BY tool_key
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeProfile)
        }
        return try WorkToolProfilesResponse(workToolProfiles: profiles)
            .response(from: request, context: context)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let body = try await request.decode(as: CreateWorkToolProfileRequest.self, context: context)
        let toolKey = try Self.validatedToolKey(body.toolKey)
        let displayName = try Self.validatedDisplayName(body.displayName)
        let launchTemplate = try Self.validatedLaunchTemplate(body.launchTemplate, toolKey: toolKey)
        let tierDefaults = try Self.validatedTierDefaults(body.tierDefaults ?? .object([:]))
        let enabled = body.enabled ?? true

        let profile = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let rows = try await conn.query(
                """
                INSERT INTO work_tool_profile
                  (workspace_id, tool_key, display_name, launch_template,
                   tier_defaults, enabled, created_by, updated_by)
                VALUES
                  (\(workspaceID), \(toolKey), \(displayName), \(launchTemplate)::jsonb,
                   \(tierDefaults)::jsonb, \(enabled), \(principal.memberID), \(principal.memberID))
                ON CONFLICT (workspace_id, tool_key) DO NOTHING
                RETURNING id, workspace_id, tool_key, display_name,
                          launch_template::text, tier_defaults::text, enabled,
                          created_by, updated_by, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.conflict, message: "work tool profile already exists")
            }
            let profile = try Self.decodeProfile(row)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, profileID: UUID(uuidString: profile.id)!,
                action: "work.tool_profile.created", toolKey: toolKey, enabled: enabled
            )
            return profile
        }
        var response = try WorkToolProfileResponse(workToolProfile: profile)
            .response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func update(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let toolKey = try Self.validatedToolKey(try context.parameters.require("tool"))
        let body = try await request.decode(as: UpdateWorkToolProfileRequest.self, context: context)
        guard body.displayName != nil || body.launchTemplate != nil ||
                body.tierDefaults != nil || body.enabled != nil
        else {
            throw HTTPError(.badRequest, message: "work tool profile update is empty")
        }
        let displayName = try body.displayName.map(Self.validatedDisplayName)
        let launchTemplate = try body.launchTemplate.map {
            try Self.validatedLaunchTemplate($0, toolKey: toolKey)
        }
        let tierDefaults = try body.tierDefaults.map(Self.validatedTierDefaults)

        let profile = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let rows = try await conn.query(
                """
                UPDATE work_tool_profile
                   SET display_name = COALESCE(\(displayName)::text, display_name),
                       launch_template = COALESCE(\(launchTemplate)::jsonb, launch_template),
                       tier_defaults = COALESCE(\(tierDefaults)::jsonb, tier_defaults),
                       enabled = COALESCE(\(body.enabled)::boolean, enabled),
                       updated_by = \(principal.memberID),
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND tool_key = \(toolKey)
                RETURNING id, workspace_id, tool_key, display_name,
                          launch_template::text, tier_defaults::text, enabled,
                          created_by, updated_by, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "work tool profile not found")
            }
            let profile = try Self.decodeProfile(row)
            if !profile.enabled {
                _ = try await conn.query(
                    "DELETE FROM work_auto_approve WHERE workspace_id = \(workspaceID) AND tool = \(toolKey)",
                    logger: db.logger
                )
            }
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, profileID: UUID(uuidString: profile.id)!,
                action: "work.tool_profile.updated", toolKey: toolKey,
                enabled: profile.enabled
            )
            return profile
        }
        return try WorkToolProfileResponse(workToolProfile: profile)
            .response(from: request, context: context)
    }

    @Sendable
    func delete(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let toolKey = try Self.validatedToolKey(try context.parameters.require("tool"))
        let profile = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            _ = try await conn.query(
                "DELETE FROM work_auto_approve WHERE workspace_id = \(workspaceID) AND tool = \(toolKey)",
                logger: db.logger
            )
            let rows = try await conn.query(
                """
                DELETE FROM work_tool_profile
                 WHERE workspace_id = \(workspaceID)
                   AND tool_key = \(toolKey)
                RETURNING id, workspace_id, tool_key, display_name,
                          launch_template::text, tier_defaults::text, enabled,
                          created_by, updated_by, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "work tool profile not found")
            }
            let profile = try Self.decodeProfile(row)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, profileID: UUID(uuidString: profile.id)!,
                action: "work.tool_profile.deleted", toolKey: toolKey, enabled: false
            )
            return profile
        }
        return try WorkToolProfileResponse(workToolProfile: profile)
            .response(from: request, context: context)
    }

    static func validatedToolKey(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{1,63}$/) != nil else {
            throw HTTPError(.badRequest, message: "invalid work tool key")
        }
        return value
    }

    static func requireEnabled(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        toolKey: String
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT id
              FROM work_tool_profile
             WHERE workspace_id = \(workspaceID)
               AND tool_key = \(toolKey)
               AND enabled
             FOR SHARE
            """,
            logger: logger
        ).collect()
        guard rows.first != nil else {
            throw HTTPError(.badRequest, message: "work tool is not registered or enabled")
        }
    }

    private static func validatedDisplayName(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 80 else {
            throw HTTPError(.badRequest, message: "displayName must contain 1...80 characters")
        }
        return value
    }

    private static func validatedLaunchTemplate(
        _ raw: JSONValue,
        toolKey: String
    ) throws -> String {
        guard let object = raw.objectValue,
              Set(object.keys) == ["command", "arguments"],
              let command = object["command"]?.stringValue,
              command.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{0,63}$/) != nil,
              let rawArguments = object["arguments"]?.arrayValue,
              rawArguments.count <= 64
        else {
            throw HTTPError(.badRequest, message: "launchTemplate must contain a local command key and arguments only")
        }
        let forbidden = ["authorization", "bearer", "password", "secret", "token", "api-key", "api_key"]
        for rawArgument in rawArguments {
            guard let argument = rawArgument.stringValue,
                  argument.count <= 4_096,
                  !argument.contains("\0"),
                  !argument.contains("\n"),
                  !argument.hasPrefix("/"),
                  !argument.lowercased().hasPrefix("file:"),
                  !forbidden.contains(where: { argument.lowercased().contains($0) })
            else {
                throw HTTPError(
                    .badRequest,
                    message: "launchTemplate arguments cannot contain credentials or absolute paths"
                )
            }
        }
        return try jsonString(raw)
    }

    private static func validatedTierDefaults(_ raw: JSONValue) throws -> String {
        guard raw.objectValue != nil else {
            throw HTTPError(.badRequest, message: "tierDefaults must be an object")
        }
        let json = try jsonString(raw)
        guard json.utf8.count <= 8_192 else {
            throw HTTPError(.badRequest, message: "tierDefaults is too large")
        }
        return json
    }

    private static func jsonString(_ value: JSONValue) throws -> String {
        let data = try JSONEncoder().encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "work tool profile JSON encoding failed")
        }
        return string
    }

    private static func decodeProfile(_ row: PostgresRow) throws -> WorkToolProfileDTO {
        let decoded = try row.decode(
            (UUID, UUID, String, String, String, String, Bool, UUID, UUID, Date, Date).self
        )
        let decoder = JSONDecoder()
        guard let launchData = decoded.4.data(using: .utf8),
              let tierData = decoded.5.data(using: .utf8)
        else {
            throw HTTPError(.internalServerError, message: "work tool profile JSON is invalid")
        }
        return WorkToolProfileDTO(
            id: decoded.0.uuidString,
            workspaceId: decoded.1.uuidString,
            toolKey: decoded.2,
            displayName: decoded.3,
            launchTemplate: try decoder.decode(JSONValue.self, from: launchData),
            tierDefaults: try decoder.decode(JSONValue.self, from: tierData),
            enabled: decoded.6,
            createdBy: decoded.7.uuidString,
            updatedBy: decoded.8.uuidString,
            createdAtMs: Int64(decoded.9.timeIntervalSince1970 * 1_000),
            updatedAtMs: Int64(decoded.10.timeIntervalSince1970 * 1_000)
        )
    }

    private static func requireHuman(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "work tool profile mutation requires a human admin")
        }
        return principal
    }

    private static func insertAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        profileID: UUID,
        action: String,
        toolKey: String,
        enabled: Bool
    ) async throws {
        let detail = try jsonString(.object([
            "schema": .string("momo.work_tool_profile.changed.v1"),
            "tool_key": .string(toolKey),
            "enabled": .bool(enabled),
        ]))
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES
              (\(workspaceID), \(principal.memberID), \(principal.memberID), \(action),
               'work_tool_profile', \(profileID), \(principal.tokenID), \(detail)::jsonb)
            """,
            logger: logger
        )
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
}
