import Foundation

enum InboundMCPToolRegistry {
    static let searchMessagesMaxChannelIDs = 10

    static let server = InboundMCPServerInfo(
        name: "momo-inbound",
        version: "0.1.0",
        transport: "http-json-skeleton",
        protocolVersion: "2025-06-18",
        capabilities: .init(
            tools: .init(listChanged: true),
            resources: .init(subscribe: false, listChanged: true),
            prompts: .init(listChanged: true)
        )
    )

    static let tools: [InboundMCPToolDescriptor] = [
        .init(
            name: .searchMessages,
            title: "Search Momo Messages",
            description: "Search visible momo messages and return bounded source refs. Does not create memory.",
            inputSchema: schema(
                required: ["workspace_id", "query", "channel_ids", "limit"],
                properties: [
                    "workspace_id": uuidString(),
                    "query": string(minLength: 1, maxLength: 300),
                    "channel_ids": array(items: uuidString(), maxItems: searchMessagesMaxChannelIDs),
                    "thread_root_message_id": nullableUUIDString(),
                    "seq_from": nullableInteger(minimum: 1),
                    "seq_to": nullableInteger(minimum: 1),
                    "author_member_ids": array(items: uuidString(), maxItems: 20),
                    "limit": integer(minimum: 1, maximum: 50),
                    "include_deleted": boolean(defaultValue: false),
                    "include_memory_refs": boolean(defaultValue: false),
                ]
            ),
            annotations: .init(
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            ),
            policy: .init(
                requiredScopes: [.read],
                requiresRLS: true,
                requiresChannelMembership: true,
                writes: [],
                canonicalWritePath: nil,
                requiresContextPacketOrAPIPacketBuild: false,
                requiresCapabilityCacheProjection: false,
                executesProviderTool: false,
                auditAction: "mcp.search.performed"
            )
        ),
        .init(
            name: .fetchThread,
            title: "Fetch Momo Thread",
            description: "Fetch a visible thread ordered by message.seq with citeable message refs.",
            inputSchema: schema(
                required: ["workspace_id", "channel_id", "root_message_id", "limit"],
                properties: [
                    "workspace_id": uuidString(),
                    "channel_id": uuidString(),
                    "root_message_id": uuidString(),
                    "seq_from": nullableInteger(minimum: 1),
                    "seq_to": nullableInteger(minimum: 1),
                    "limit": integer(minimum: 1, maximum: 100),
                    "include_context_packet_seed": boolean(defaultValue: false),
                ]
            ),
            annotations: .init(
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            ),
            policy: .init(
                requiredScopes: [.read],
                requiresRLS: true,
                requiresChannelMembership: true,
                writes: [],
                canonicalWritePath: nil,
                requiresContextPacketOrAPIPacketBuild: false,
                requiresCapabilityCacheProjection: false,
                executesProviderTool: false,
                auditAction: "mcp.thread.fetched"
            )
        ),
        .init(
            name: .postMessage,
            title: "Post Momo Message",
            description: "Post a visible message through momo's canonical message transaction and outbox.",
            inputSchema: schema(
                required: ["workspace_id", "channel_id", "body", "client_msg_id"],
                properties: [
                    "workspace_id": uuidString(),
                    "channel_id": uuidString(),
                    "root_id": nullableUUIDString(),
                    "reply_to_id": nullableUUIDString(),
                    "body": string(minLength: 1, maxLength: 8000),
                    "props": .object(["type": .string("object"), "additionalProperties": .bool(true)]),
                    "client_msg_id": uuidString(),
                ]
            ),
            annotations: .init(
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            ),
            policy: .init(
                requiredScopes: [.post],
                requiresRLS: true,
                requiresChannelMembership: true,
                writes: ["message", "outbox", "audit_log"],
                canonicalWritePath: "channel_seq_bump_message_insert_outbox_insert",
                requiresContextPacketOrAPIPacketBuild: false,
                requiresCapabilityCacheProjection: false,
                executesProviderTool: false,
                auditAction: "mcp.message.posted"
            )
        ),
        .init(
            name: .createToolCall,
            title: "Create Approval-Safe Tool Call",
            description: "Create a momo-visible tool_call proposal and approval request. Does not execute the provider tool.",
            inputSchema: schema(
                required: [
                    "workspace_id", "channel_id", "tool_name",
                    "tool_arguments", "reason", "client_msg_id",
                ],
                properties: [
                    "workspace_id": uuidString(),
                    "channel_id": uuidString(),
                    "root_id": nullableUUIDString(),
                    "context_packet_id": nullableUUIDString(),
                    "tool_name": .object([
                        "type": .string("string"),
                        "pattern": .string("^[a-z0-9_]+(\\.[a-z0-9_]+)+$"),
                    ]),
                    "tool_arguments": .object(["type": .string("object"), "additionalProperties": .bool(true)]),
                    "reason": string(minLength: 1, maxLength: 1000),
                    "client_msg_id": uuidString(),
                ]
            ),
            annotations: .init(
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            ),
            policy: .init(
                requiredScopes: [.toolPropose],
                requiresRLS: true,
                requiresChannelMembership: true,
                writes: [
                    "message:tool_call",
                    "approval",
                    "message:approval_request",
                    "outbox",
                    "audit_log",
                ],
                canonicalWritePath: nil,
                requiresContextPacketOrAPIPacketBuild: true,
                requiresCapabilityCacheProjection: true,
                executesProviderTool: false,
                auditAction: "mcp.tool_call.proposed"
            )
        ),
    ]

    static let resourceTemplates: [InboundMCPResourceTemplate] = [
        .init(
            uriTemplate: "momo://workspaces/{workspace_id}/channels/{channel_id}/messages/{message_id}",
            name: "momo_message",
            title: "Momo Message",
            description: "One visible message with bounded body and props.",
            mimeType: "application/json"
        ),
        .init(
            uriTemplate: "momo://workspaces/{workspace_id}/channels/{channel_id}/threads/{root_message_id}",
            name: "momo_thread",
            title: "Momo Thread",
            description: "Visible thread ordered by message.seq.",
            mimeType: "application/json"
        ),
        .init(
            uriTemplate: "momo://workspaces/{workspace_id}/context-packets/{context_packet_id}",
            name: "momo_context_packet",
            title: "Momo Context Packet",
            description: "Context Packet projection if the actor still has permission.",
            mimeType: "application/json"
        ),
        .init(
            uriTemplate: "momo://workspaces/{workspace_id}/memory/{memory_id}",
            name: "momo_memory_ref",
            title: "Momo Memory Projection",
            description: "Memory Plane projection only; no raw source body.",
            mimeType: "application/json"
        ),
        .init(
            uriTemplate: "momo://workspaces/{workspace_id}/capabilities/{cache_entry_id}",
            name: "momo_capability_projection",
            title: "Momo Capability Projection",
            description: "Capability Cache public projection with schema refs and policy version.",
            mimeType: "application/json"
        ),
        .init(
            uriTemplate: "momo://workspaces/{workspace_id}/approvals/{approval_id}",
            name: "momo_approval",
            title: "Momo Approval",
            description: "Visible approval request state.",
            mimeType: "application/json"
        ),
    ]

    static let prompts: [InboundMCPPromptDescriptor] = [
        .init(
            name: "momo.thread_brief",
            title: "Thread Brief",
            description: "Fetch a visible thread, cite source ids, and summarize without creating memory.",
            arguments: [
                .init(name: "workspace_id", required: true),
                .init(name: "channel_id", required: true),
                .init(name: "root_message_id", required: true),
            ]
        ),
        .init(
            name: "momo.reply_with_sources",
            title: "Reply With Sources",
            description: "Search/fetch visible messages, cite source ids, and post only when requested.",
            arguments: [
                .init(name: "workspace_id", required: true),
                .init(name: "channel_id", required: true),
                .init(name: "goal", required: true),
            ]
        ),
        .init(
            name: "momo.approval_proposal",
            title: "Approval Proposal",
            description: "Prepare a momo.create_tool_call proposal with approval-safe wording.",
            arguments: [
                .init(name: "workspace_id", required: true),
                .init(name: "channel_id", required: true),
                .init(name: "tool_name", required: true),
                .init(name: "reason", required: true),
            ]
        ),
        .init(
            name: "momo.memory_safe_search",
            title: "Memory Safe Search",
            description: "Explain message search versus Memory Plane retrieval and avoid memory creation.",
            arguments: [
                .init(name: "workspace_id", required: true),
                .init(name: "query", required: true),
            ]
        ),
    ]

    static let auditPolicy = InboundMCPAuditPolicy(
        alwaysAudit: [
            "mcp.tools.listed",
            "mcp.tool.called",
            "mcp.message.posted",
            "mcp.tool_call.proposed",
            "mcp.resource.read",
            "mcp.denied",
        ],
        sampledReadAudit: [
            "mcp.search.performed",
            "mcp.thread.fetched",
        ]
    )

    static func descriptor(named name: InboundMCPToolName) -> InboundMCPToolDescriptor {
        tools.first { $0.name == name }!
    }

    static func discoveryResponse() -> InboundMCPDiscoveryResponse {
        InboundMCPDiscoveryResponse(
            schema: "momo.inbound_mcp.discovery_snapshot.v0",
            server: server,
            tools: tools,
            resourceTemplates: resourceTemplates,
            prompts: prompts,
            auditPolicy: auditPolicy,
            runtimeStatus: "runtime-unverified: MCP JSON-RPC transport and tool execution are compile-safe stubs in MOMO-172/GitHub #80."
        )
    }

    private static func schema(required: [String], properties: [String: JSONValue]) -> JSONValue {
        .object([
            "type": .string("object"),
            "additionalProperties": .bool(false),
            "required": .array(required.map { .string($0) }),
            "properties": .object(properties),
        ])
    }

    private static func uuidString() -> JSONValue {
        .object(["type": .string("string"), "format": .string("uuid")])
    }

    private static func nullableUUIDString() -> JSONValue {
        .object(["type": .array([.string("string"), .string("null")]), "format": .string("uuid")])
    }

    private static func string(minLength: Int, maxLength: Int) -> JSONValue {
        .object([
            "type": .string("string"),
            "minLength": .int(minLength),
            "maxLength": .int(maxLength),
        ])
    }

    private static func integer(minimum: Int, maximum: Int) -> JSONValue {
        .object([
            "type": .string("integer"),
            "minimum": .int(minimum),
            "maximum": .int(maximum),
        ])
    }

    private static func nullableInteger(minimum: Int) -> JSONValue {
        .object([
            "type": .array([.string("integer"), .string("null")]),
            "minimum": .int(minimum),
        ])
    }

    private static func boolean(defaultValue: Bool) -> JSONValue {
        .object(["type": .string("boolean"), "default": .bool(defaultValue)])
    }

    private static func array(items: JSONValue, maxItems: Int) -> JSONValue {
        .object([
            "type": .string("array"),
            "items": items,
            "maxItems": .int(maxItems),
        ])
    }
}
