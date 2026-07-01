import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Inbound MCP v0 skeleton.
///
/// This is intentionally a spec-to-code bridge, not the final MCP JSON-RPC
/// transport. It mounts HTTP-shaped discovery/list/call endpoints so the server
/// package owns the v0 tool descriptors and security preflight in compiled code.
struct InboundMCPRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/mcp", use: discovery)
        group.get("/v1/mcp/tools", use: tools)
        group.post("/v1/mcp/tools/call", use: callTool)
    }

    @Sendable
    func discovery(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        try Self.requireAnyMCPScope(principal)
        try await preflightVisibility(
            workspaceID: principal.workspaceID,
            memberID: principal.memberID,
            channelIDs: []
        )

        let response = InboundMCPToolRegistry.discoveryResponse()
        return try response.response(from: request, context: context)
    }

    @Sendable
    func tools(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        try Self.requireAnyMCPScope(principal)
        try await preflightVisibility(
            workspaceID: principal.workspaceID,
            memberID: principal.memberID,
            channelIDs: []
        )

        let response = InboundMCPToolListResponse(tools: InboundMCPToolRegistry.tools)
        return try response.response(from: request, context: context)
    }

    @Sendable
    func callTool(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let dto = try await request.decode(as: InboundMCPToolCallRequest.self, context: context)
        let descriptor = InboundMCPToolRegistry.descriptor(named: dto.name)

        try Self.requireScopes(descriptor.policy.requiredScopes, principal: principal)
        let workspaceID = try Self.workspaceID(from: dto.arguments)
        guard workspaceID == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }

        let channelIDs = try Self.channelIDs(for: dto.name, arguments: dto.arguments)
        try await preflightVisibility(
            workspaceID: workspaceID,
            memberID: principal.memberID,
            channelIDs: channelIDs
        )

        // TODO(#80): replace this compile-safe HTTP skeleton with MCP JSON-RPC
        // transport plus real tool execution. post_message must reuse the
        // canonical message tx; create_tool_call must create tool_call,
        // approval_request, outbox, and audit rows without executing providers.
        let response = InboundMCPToolCallResponse(
            toolName: dto.name,
            isError: true,
            content: [
                .init(
                    type: "text",
                    text: "Inbound MCP tool execution is a compile-safe MOMO-172/GitHub #80 stub."
                ),
            ],
            structuredContent: .object([
                "error": .object([
                    "code": .string("momo.mcp.runtime_stub"),
                    "message": .string("MCP transport/tool execution is runtime-unverified and intentionally not implemented in this skeleton."),
                ]),
                "tool": .string(dto.name.rawValue),
                "required_scopes": .array(descriptor.policy.requiredScopes.map { .string($0.rawValue) }),
                "requires_rls": .bool(descriptor.policy.requiresRLS),
                "requires_channel_membership": .bool(descriptor.policy.requiresChannelMembership),
                "audit_action": .string(descriptor.policy.auditAction),
            ])
        )
        return try response.response(from: request, context: context)
    }

    private func preflightVisibility(
        workspaceID: UUID,
        memberID: UUID,
        channelIDs: [UUID]
    ) async throws {
        let allowed = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            guard try await Self.isActiveWorkspaceMember(
                conn: conn,
                memberID: memberID
            ) else {
                return false
            }

            for channelID in channelIDs {
                guard try await Self.hasActiveChannelMembership(
                    conn: conn,
                    channelID: channelID,
                    memberID: memberID
                ) else {
                    return false
                }
            }
            return true
        }

        guard allowed else {
            throw HTTPError(.forbidden, message: "not visible or not found")
        }
    }

    private static func isActiveWorkspaceMember(
        conn: PostgresConnection,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member
             WHERE id = \(memberID)
               AND status = 'active'
               AND deleted_at IS NULL
             LIMIT 1
            """,
            logger: .init(label: "momo.mcp.authz")
        ).collect()
        return !rows.isEmpty
    }

    private static func hasActiveChannelMembership(
        conn: PostgresConnection,
        channelID: UUID,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM membership
             WHERE channel_id = \(channelID)
               AND member_id = \(memberID)
               AND left_at IS NULL
             LIMIT 1
            """,
            logger: .init(label: "momo.mcp.authz")
        ).collect()
        return !rows.isEmpty
    }

    private static func requireAnyMCPScope(_ principal: AuthPrincipal) throws {
        let allowed = principal.scopes.contains { scope in
            scope == InboundMCPScope.read.rawValue ||
            scope == InboundMCPScope.post.rawValue ||
            scope == InboundMCPScope.toolPropose.rawValue
        }
        guard allowed else {
            throw HTTPError(.forbidden, message: "missing inbound MCP scope")
        }
    }

    private static func requireScopes(
        _ scopes: [InboundMCPScope],
        principal: AuthPrincipal
    ) throws {
        for scope in scopes where !principal.scopes.contains(scope.rawValue) {
            throw HTTPError(.forbidden, message: "missing scope: \(scope.rawValue)")
        }
    }

    private static func workspaceID(from arguments: [String: JSONValue]) throws -> UUID {
        guard let raw = arguments["workspace_id"]?.stringValue,
              let uuid = UUID(uuidString: raw)
        else {
            throw HTTPError(.badRequest, message: "workspace_id must be a UUID string")
        }
        return uuid
    }

    static func channelIDs(
        for toolName: InboundMCPToolName,
        arguments: [String: JSONValue]
    ) throws -> [UUID] {
        switch toolName {
        case .searchMessages:
            guard let values = arguments["channel_ids"]?.arrayValue else {
                throw HTTPError(.badRequest, message: "channel_ids is required for search_messages")
            }
            guard !values.isEmpty else {
                throw HTTPError(.badRequest, message: "channel_ids must contain at least one channel")
            }
            guard values.count <= InboundMCPToolRegistry.searchMessagesMaxChannelIDs else {
                throw HTTPError(
                    .badRequest,
                    message: "channel_ids must contain at most \(InboundMCPToolRegistry.searchMessagesMaxChannelIDs) channels"
                )
            }
            return try values.map { value in
                guard let raw = value.stringValue, let uuid = UUID(uuidString: raw) else {
                    throw HTTPError(.badRequest, message: "channel_ids must contain UUID strings")
                }
                return uuid
            }
        case .fetchThread, .postMessage, .createToolCall:
            guard let raw = arguments["channel_id"]?.stringValue,
                  let uuid = UUID(uuidString: raw)
            else {
                throw HTTPError(.badRequest, message: "channel_id must be a UUID string")
            }
            return [uuid]
        }
    }
}
