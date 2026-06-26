import Foundation
import Hummingbird

enum InboundMCPToolName: String, Codable, CaseIterable, Sendable {
    case searchMessages = "momo.search_messages"
    case fetchThread = "momo.fetch_thread"
    case postMessage = "momo.post_message"
    case createToolCall = "momo.create_tool_call"
}

enum InboundMCPScope: String, Codable, Sendable {
    case read = "mcp.read"
    case post = "mcp.post"
    case toolPropose = "mcp.tool.propose"
}

struct InboundMCPServerCapabilities: Codable, Equatable, Sendable {
    struct Tools: Codable, Equatable, Sendable {
        let listChanged: Bool
    }

    struct Resources: Codable, Equatable, Sendable {
        let subscribe: Bool
        let listChanged: Bool
    }

    struct Prompts: Codable, Equatable, Sendable {
        let listChanged: Bool
    }

    let tools: Tools
    let resources: Resources
    let prompts: Prompts
}

struct InboundMCPServerInfo: Codable, Equatable, Sendable {
    let name: String
    let version: String
    let transport: String
    let protocolVersion: String
    let capabilities: InboundMCPServerCapabilities

    enum CodingKeys: String, CodingKey {
        case name
        case version
        case transport
        case protocolVersion = "mcp_protocol_version"
        case capabilities
    }
}

struct InboundMCPToolAnnotations: Codable, Equatable, Sendable {
    let readOnlyHint: Bool
    let destructiveHint: Bool
    let idempotentHint: Bool
    let openWorldHint: Bool
}

struct InboundMCPToolPolicy: Codable, Equatable, Sendable {
    let requiredScopes: [InboundMCPScope]
    let requiresRLS: Bool
    let requiresChannelMembership: Bool
    let writes: [String]
    let canonicalWritePath: String?
    let requiresContextPacketOrAPIPacketBuild: Bool
    let requiresCapabilityCacheProjection: Bool
    let executesProviderTool: Bool
    let auditAction: String

    enum CodingKeys: String, CodingKey {
        case requiredScopes = "required_scopes"
        case requiresRLS = "requires_rls"
        case requiresChannelMembership = "requires_channel_membership"
        case writes
        case canonicalWritePath = "canonical_write_path"
        case requiresContextPacketOrAPIPacketBuild = "requires_context_packet_or_api_packet_build"
        case requiresCapabilityCacheProjection = "requires_capability_cache_projection"
        case executesProviderTool = "executes_provider_tool"
        case auditAction = "audit_action"
    }
}

struct InboundMCPToolDescriptor: Codable, Equatable, Sendable {
    let name: InboundMCPToolName
    let title: String
    let description: String
    let inputSchema: JSONValue
    let annotations: InboundMCPToolAnnotations
    let policy: InboundMCPToolPolicy

    enum CodingKeys: String, CodingKey {
        case name
        case title
        case description
        case inputSchema
        case annotations
        case policy = "momo_policy"
    }
}

struct InboundMCPResourceTemplate: Codable, Equatable, Sendable {
    let uriTemplate: String
    let name: String
    let title: String
    let description: String
    let mimeType: String
}

struct InboundMCPPromptDescriptor: Codable, Equatable, Sendable {
    struct Argument: Codable, Equatable, Sendable {
        let name: String
        let required: Bool
    }

    let name: String
    let title: String
    let description: String
    let arguments: [Argument]
}

struct InboundMCPAuditPolicy: Codable, Equatable, Sendable {
    let alwaysAudit: [String]
    let sampledReadAudit: [String]

    enum CodingKeys: String, CodingKey {
        case alwaysAudit = "always_audit"
        case sampledReadAudit = "sampled_read_audit"
    }
}

struct InboundMCPDiscoveryResponse: Codable, ResponseEncodable, Equatable, Sendable {
    let schema: String
    let server: InboundMCPServerInfo
    let tools: [InboundMCPToolDescriptor]
    let resourceTemplates: [InboundMCPResourceTemplate]
    let prompts: [InboundMCPPromptDescriptor]
    let auditPolicy: InboundMCPAuditPolicy
    let runtimeStatus: String

    enum CodingKeys: String, CodingKey {
        case schema
        case server
        case tools
        case resourceTemplates
        case prompts
        case auditPolicy = "audit_policy"
        case runtimeStatus = "runtime_status"
    }
}

struct InboundMCPToolListResponse: Codable, ResponseEncodable, Equatable, Sendable {
    let tools: [InboundMCPToolDescriptor]
}

struct InboundMCPToolCallRequest: Decodable, Sendable {
    let name: InboundMCPToolName
    let arguments: [String: JSONValue]
    let idempotencyKey: String?

    enum CodingKeys: String, CodingKey {
        case name
        case arguments
        case idempotencyKey = "idempotency_key"
    }
}

struct InboundMCPToolCallResponse: Codable, ResponseEncodable, Equatable, Sendable {
    struct Content: Codable, Equatable, Sendable {
        let type: String
        let text: String
    }

    let toolName: InboundMCPToolName
    let isError: Bool
    let content: [Content]
    let structuredContent: JSONValue

    enum CodingKeys: String, CodingKey {
        case toolName = "tool_name"
        case isError
        case content
        case structuredContent
    }
}
