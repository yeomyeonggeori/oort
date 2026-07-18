import Foundation

struct MomoPluginCatalogSnapshot: Decodable, Equatable, Sendable {
    let plugins: [MomoPluginCatalogEntry]
    let toolPolicy: MomoPluginToolPolicy

    var grantedPluginIDs: Set<String> {
        Set(toolPolicy.plugins.lazy.filter { !$0.tools.isEmpty }.map(\.pluginId))
    }
}

struct MomoPluginCatalogEntry: Decodable, Equatable, Identifiable, Sendable {
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

    var id: String { pluginId }
    var isChannelIntegration: Bool { pluginId == "external_webhook" }

    var systemImage: String {
        switch pluginId {
        case "com.momo.plugins.drive": return "externaldrive"
        case "com.momo.plugins.github": return "chevron.left.forwardslash.chevron.right"
        case "com.momo.plugins.notion": return "doc.text"
        case "com.momo.plugins.linear": return "checklist"
        case "external_webhook": return "arrow.down.message"
        default: return "puzzlepiece.extension"
        }
    }
}

struct MomoPluginToolPolicy: Decodable, Equatable, Sendable {
    let plugins: [MomoPluginPolicyDescriptor]
}

struct MomoPluginPolicyDescriptor: Decodable, Equatable, Sendable {
    let pluginId: String
    let mcp: MomoPluginPolicyMCP
    let egressDomains: [String]
    let tools: [MomoPluginPolicyTool]
}

struct MomoPluginPolicyMCP: Decodable, Equatable, Sendable {
    let url: String
    let transport: String
}

struct MomoPluginPolicyTool: Decodable, Equatable, Sendable {
    let name: String
    let risk: String
    let approvalTier: String
}

struct MomoPluginDetailEnvelope: Decodable, Equatable, Sendable {
    let plugin: MomoPluginDetail
}

struct MomoPluginDetail: Decodable, Equatable, Identifiable, Sendable {
    let pluginId: String
    let name: String
    let version: String
    let description: String
    let official: Bool
    let egressDomains: [String]
    let recommendedFor: [String]
    let installed: Bool
    let enabled: Bool
    let manifest: MomoPluginManifest

    var id: String { pluginId }

    /// A-1 intentionally supports today's one-scope catalog contract only.
    /// A future multi-scope picker must be an additive UX and API decision.
    var singleDeclaredScope: String? {
        declaredScopes.count == 1 ? declaredScopes[0] : nil
    }

    var declaredScopes: [String] {
        var seen = Set<String>()
        return manifest.mcp.tools.flatMap(\.scopes).compactMap { rawScope in
            let scope = rawScope.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !scope.isEmpty, seen.insert(scope).inserted else { return nil }
            return scope
        }
    }
}

struct MomoPluginManifest: Decodable, Equatable, Sendable {
    let mcp: MomoPluginManifestMCP
    let momo: MomoPluginManifestPolicy
}

struct MomoPluginManifestMCP: Decodable, Equatable, Sendable {
    let tools: [MomoPluginManifestTool]
}

struct MomoPluginManifestTool: Decodable, Equatable, Sendable {
    let name: String
    let description: String
    let scopes: [String]
    let risk: String
    let approvalPolicy: String
}

struct MomoPluginManifestPolicy: Decodable, Equatable, Sendable {
    let risk: String
    let egressDomains: [String]
    let recommendedFor: [String]
    let serverPolicy: MomoPluginServerPolicy
}

struct MomoPluginServerPolicy: Decodable, Equatable, Sendable {
    let installAllowed: Bool
    let enabledByDefault: Bool
    let allowedRoles: [String]
}

struct MomoPluginMutationReceipt: Decodable, Equatable, Sendable {
    let pluginId: String
    let memberId: String?
    let scope: String?
    let status: String
    let enabled: Bool
    let auditRef: String?
    let capabilities: [String]
}

struct MomoInstallPluginRequest: Encodable, Equatable, Sendable {
    let enabled: Bool
}

struct MomoGrantPluginRequest: Encodable, Equatable, Sendable {
    let scope: String
}

enum MomoPluginMarketplaceError: Error, Equatable, Sendable {
    case invalidEndpoint
    case transport(code: Int, message: String)
    case http(status: Int, message: String)
    case decoding(String)
    case missingAuthentication
    case unsupportedScope(pluginName: String, declaredCount: Int)
    case channelIntegrationRequired

    var isOffline: Bool {
        guard case let .transport(code, _) = self else { return false }
        let urlCode = URLError.Code(rawValue: code)
        return [
            .notConnectedToInternet,
            .networkConnectionLost,
            .cannotConnectToHost,
            .cannotFindHost,
            .dnsLookupFailed,
            .timedOut,
        ].contains(urlCode)
    }

    var diagnosticMessage: String {
        switch self {
        case .invalidEndpoint:
            return "The plugin endpoint is invalid."
        case let .transport(_, message), let .http(_, message), let .decoding(message):
            return message
        case .missingAuthentication:
            return "An authenticated server session is required."
        case let .unsupportedScope(pluginName, declaredCount):
            return "\(pluginName) declares \(declaredCount) scopes; this client supports exactly one."
        case .channelIntegrationRequired:
            return "Incoming Webhook is managed from channel integrations."
        }
    }
}
