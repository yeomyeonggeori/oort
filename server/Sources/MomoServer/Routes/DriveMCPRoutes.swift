import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// ADR-0113 D3 path C: momo-hosted, read-only Google Drive MCP.
///
/// The route is stateless JSON-RPC. Agent bearer authentication happens in
/// `AuthMiddleware`; every request then proves the delegated human and agent
/// share the supplied channel. Every tools/call locks and revalidates the
/// active `(workspace, delegated member, plugin, drive:read)` grant and writes
/// a secret-free result audit in the same tenant transaction.
struct DriveMCPRoutes: Sendable {
    static let pluginID = "com.momo.plugins.drive"
    static let scope = "drive:read"

    let db: Database
    let backend: any DriveBackend

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/mcp/drive", use: handle)
    }

    @Sendable
    func handle(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .agent else {
            throw HTTPError(.forbidden, message: "Drive MCP requires an agent bearer")
        }
        let rpc: DriveMCPRequest
        do {
            rpc = try await request.decode(as: DriveMCPRequest.self, context: context)
        } catch {
            return try DriveMCPResponse.failure(
                id: .null,
                code: -32700,
                message: "Parse error"
            ).response(from: request, context: context)
        }
        guard rpc.jsonrpc == "2.0", let id = rpc.id else {
            return try DriveMCPResponse.failure(
                id: rpc.id ?? .null,
                code: -32600,
                message: "Invalid Request"
            ).response(from: request, context: context)
        }

        switch rpc.method {
        case "initialize":
            try await requireDelegationBinding(request: request, principal: principal)
            return try DriveMCPResponse.success(
                id: id,
                result: .object([
                    "protocolVersion": .string("2025-06-18"),
                    "capabilities": .object([
                        "tools": .object(["listChanged": .bool(false)])
                    ]),
                    "serverInfo": .object([
                        "name": .string("momo/drive-mcp"),
                        "version": .string("1.0.0"),
                    ]),
                    "instructions": .string("Read-only access to the operator-configured shared drive."),
                ])
            ).response(from: request, context: context)

        case "tools/list":
            try await requireDelegationBinding(request: request, principal: principal)
            return try DriveMCPResponse.success(
                id: id,
                result: .object(["tools": .array(DriveMCPToolRegistry.tools)])
            ).response(from: request, context: context)

        case "tools/call":
            guard let params = rpc.params?.objectValue,
                  let name = params["name"]?.stringValue,
                  let arguments = params["arguments"]?.objectValue
            else {
                return try DriveMCPResponse.failure(
                    id: id,
                    code: -32602,
                    message: "tools/call requires name and arguments"
                ).response(from: request, context: context)
            }
            let result = try await callTool(
                request: request,
                principal: principal,
                name: name,
                arguments: arguments
            )
            let response: DriveMCPResponse
            switch result {
            case .grantDenied:
                response = .failure(
                    id: id,
                    code: -32003,
                    message: "Active delegated Drive grant required",
                    data: .object(["code": .string("momo.drive.grant_required")])
                )
            case .toolResult(let value):
                response = .success(id: id, result: value)
            }
            return try response.response(from: request, context: context)

        default:
            return try DriveMCPResponse.failure(
                id: id,
                code: -32601,
                message: "Method not found"
            ).response(from: request, context: context)
        }
    }

    private func requireDelegationBinding(
        request: Request,
        principal: AuthPrincipal
    ) async throws {
        _ = try await withTenantTransactionUnwrapped(workspaceID: principal.workspaceID) { conn in
            try await PluginRoutes.policyMemberID(
                request: request,
                conn: conn,
                logger: db.logger,
                workspaceID: principal.workspaceID,
                principal: principal
            )
        }
    }

    private func callTool(
        request: Request,
        principal: AuthPrincipal,
        name: String,
        arguments: [String: JSONValue]
    ) async throws -> DriveCallOutcome {
        try await withTenantTransactionUnwrapped(workspaceID: principal.workspaceID) { conn in
            let delegatedMemberID = try await PluginRoutes.policyMemberID(
                request: request,
                conn: conn,
                logger: db.logger,
                workspaceID: principal.workspaceID,
                principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT pg.id
                  FROM plugin_grant pg
                  JOIN workspace_plugin_install wpi
                    ON wpi.workspace_id = pg.workspace_id
                   AND wpi.plugin_id = pg.plugin_id
                   AND wpi.enabled
                   AND wpi.revoked_at IS NULL
                  JOIN plugin_registry pr
                    ON pr.plugin_id = pg.plugin_id
                   AND pr.revoked_at IS NULL
                  JOIN plugin_capability_projection pcp
                    ON pcp.workspace_id = pg.workspace_id
                   AND pcp.member_id = pg.member_id
                   AND pcp.plugin_id = pg.plugin_id
                   AND pcp.scope = pg.scope
                   AND pcp.grant_id = pg.id
                   AND pcp.tool_name = \(name)
                   AND pcp.risk = 'read'
                   AND pcp.approval_tier = 'read_only'
                 WHERE pg.workspace_id = \(principal.workspaceID)
                   AND pg.member_id = \(delegatedMemberID)
                   AND pg.plugin_id = \(Self.pluginID)
                   AND pg.scope = \(Self.scope)
                   AND pg.status = 'active'
                   AND pg.revoked_at IS NULL
                 FOR SHARE OF pg, wpi, pr
                """,
                logger: db.logger
            ).collect()

            guard let grantID = try rows.first?.decode(UUID.self) else {
                try await Self.insertAudit(
                    conn: conn,
                    logger: db.logger,
                    principal: principal,
                    subjectMemberID: delegatedMemberID,
                    targetID: principal.tokenID,
                    toolName: name,
                    outcome: "grant_denied",
                    errorCode: "momo.drive.grant_required"
                )
                return .grantDenied
            }

            let backendResult: Result<JSONValue, DriveBackendError>
            do {
                backendResult = .success(try await executeTool(name: name, arguments: arguments))
            } catch let error as DriveBackendError {
                backendResult = .failure(error)
            } catch {
                backendResult = .failure(.upstreamFailure)
            }

            switch backendResult {
            case .success(let value):
                try await Self.insertAudit(
                    conn: conn,
                    logger: db.logger,
                    principal: principal,
                    subjectMemberID: delegatedMemberID,
                    targetID: grantID,
                    toolName: name,
                    outcome: "success",
                    errorCode: nil
                )
                return .toolResult(try Self.toolResult(value: value, isError: false))
            case .failure(let error):
                try await Self.insertAudit(
                    conn: conn,
                    logger: db.logger,
                    principal: principal,
                    subjectMemberID: delegatedMemberID,
                    targetID: grantID,
                    toolName: name,
                    outcome: "error",
                    errorCode: error.code
                )
                return .toolResult(Self.toolError(error))
            }
        }
    }

    private func executeTool(
        name: String,
        arguments: [String: JSONValue]
    ) async throws -> JSONValue {
        switch name {
        case "drive.search_files":
            try Self.requireOnlyKeys(arguments, allowed: ["query", "pageSize"])
            let query = arguments["query"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard query == nil || query!.count <= 500 else {
                throw DriveBackendError.invalidArguments("query must contain at most 500 characters")
            }
            let pageSize = Self.int(arguments["pageSize"]) ?? 20
            guard (1...100).contains(pageSize) else {
                throw DriveBackendError.invalidArguments("pageSize must be between 1 and 100")
            }
            return try await backend.searchFiles(query: query, pageSize: pageSize)

        case "drive.get_file_metadata":
            try Self.requireOnlyKeys(arguments, allowed: ["fileId"])
            guard let fileID = arguments["fileId"]?.stringValue else {
                throw DriveBackendError.invalidArguments("fileId is required")
            }
            return try await backend.fileMetadata(fileID: fileID)

        case "drive.export_text":
            try Self.requireOnlyKeys(arguments, allowed: ["fileId", "maxBytes"])
            guard let fileID = arguments["fileId"]?.stringValue else {
                throw DriveBackendError.invalidArguments("fileId is required")
            }
            let maxBytes = Self.int(arguments["maxBytes"]) ?? 1_000_000
            guard (1...5_000_000).contains(maxBytes) else {
                throw DriveBackendError.invalidArguments("maxBytes must be between 1 and 5000000")
            }
            return try await backend.exportText(fileID: fileID, maxBytes: maxBytes)

        default:
            throw DriveBackendError.invalidArguments("Unknown read-only Drive tool")
        }
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

    private static func insertAudit(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal,
        subjectMemberID: UUID,
        targetID: UUID,
        toolName: String,
        outcome: String,
        errorCode: String?
    ) async throws {
        var detail: [String: JSONValue] = [
            "schema": .string("momo.plugin.drive.tool_result.v1"),
            "plugin_id": .string(pluginID),
            "scope": .string(scope),
            "tool": .string(toolName),
            "outcome": .string(outcome),
        ]
        if let errorCode { detail["error_code"] = .string(errorCode) }
        let data = try JSONEncoder().encode(JSONValue.object(detail))
        guard let detailJSON = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "Drive audit encoding failed")
        }
        let auditID = UUID()
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (id, workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES (\(auditID), \(principal.workspaceID), \(principal.memberID),
                    \(subjectMemberID), 'plugin.drive.tool_result', 'plugin_grant',
                    \(targetID), \(principal.tokenID), \(detailJSON)::jsonb)
            """,
            logger: logger
        )
    }

    private static func toolResult(value: JSONValue, isError: Bool) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw DriveBackendError.upstreamFailure
        }
        return .object([
            "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
            "structuredContent": value,
            "isError": .bool(isError),
        ])
    }

    private static func toolError(_ error: DriveBackendError) -> JSONValue {
        let value: JSONValue = .object([
            "error": .object([
                "code": .string(error.code),
                "message": .string(error.safeMessage),
            ])
        ])
        return (try? toolResult(value: value, isError: true)) ?? .object([
            "isError": .bool(true),
            "structuredContent": value,
        ])
    }

    private static func requireOnlyKeys(
        _ arguments: [String: JSONValue],
        allowed: Set<String>
    ) throws {
        guard Set(arguments.keys).isSubset(of: allowed) else {
            throw DriveBackendError.invalidArguments("Unknown tool argument")
        }
    }

    private static func int(_ value: JSONValue?) -> Int? {
        guard case .int(let number) = value else { return nil }
        return number
    }
}

private enum DriveCallOutcome: Sendable {
    case grantDenied
    case toolResult(JSONValue)
}

private struct DriveMCPRequest: Decodable, Sendable {
    let jsonrpc: String
    let id: JSONValue?
    let method: String
    let params: JSONValue?
}

private struct DriveMCPResponse: Codable, ResponseEncodable, Sendable {
    let jsonrpc: String
    let id: JSONValue
    let result: JSONValue?
    let error: DriveMCPError?

    static func success(id: JSONValue, result: JSONValue) -> DriveMCPResponse {
        .init(jsonrpc: "2.0", id: id, result: result, error: nil)
    }

    static func failure(
        id: JSONValue,
        code: Int,
        message: String,
        data: JSONValue? = nil
    ) -> DriveMCPResponse {
        .init(
            jsonrpc: "2.0",
            id: id,
            result: nil,
            error: .init(code: code, message: message, data: data)
        )
    }
}

private struct DriveMCPError: Codable, Sendable {
    let code: Int
    let message: String
    let data: JSONValue?
}

enum DriveMCPToolRegistry {
    static let tools: [JSONValue] = [
        .object([
            "name": .string("drive.search_files"),
            "description": .string("Search files within the configured shared drive"),
            "inputSchema": .object([
                "type": .string("object"),
                "properties": .object([
                    "query": .object(["type": .string("string"), "maxLength": .int(500)]),
                    "pageSize": .object(["type": .string("integer"), "minimum": .int(1), "maximum": .int(100)]),
                ]),
                "additionalProperties": .bool(false),
            ]),
            "annotations": .object(["readOnlyHint": .bool(true)]),
        ]),
        .object([
            "name": .string("drive.get_file_metadata"),
            "description": .string("Get metadata for a file in the configured shared drive"),
            "inputSchema": .object([
                "type": .string("object"),
                "properties": .object([
                    "fileId": .object(["type": .string("string"), "minLength": .int(1), "maxLength": .int(200)])
                ]),
                "required": .array([.string("fileId")]),
                "additionalProperties": .bool(false),
            ]),
            "annotations": .object(["readOnlyHint": .bool(true)]),
        ]),
        .object([
            "name": .string("drive.export_text"),
            "description": .string("Export a Google Workspace document or download a text file with a bounded size"),
            "inputSchema": .object([
                "type": .string("object"),
                "properties": .object([
                    "fileId": .object(["type": .string("string"), "minLength": .int(1), "maxLength": .int(200)]),
                    "maxBytes": .object(["type": .string("integer"), "minimum": .int(1), "maximum": .int(5_000_000)]),
                ]),
                "required": .array([.string("fileId")]),
                "additionalProperties": .bool(false),
            ]),
            "annotations": .object(["readOnlyHint": .bool(true)]),
        ]),
    ]
}
