import Foundation

struct ValidatedPluginTool: Equatable, Sendable {
    let name: String
    let scopes: [String]
    let risk: String
    let approvalPolicy: String
    let approvalTier: String
    let schemaDigest: String
}

struct ValidatedPluginManifest: Equatable, Sendable {
    let pluginID: String
    let name: String
    let version: String
    let description: String
    let mcpURL: String
    let mcpTransport: String
    let egressDomains: [String]
    let recommendedFor: [String]
    let installAllowed: Bool
    let enabledByDefault: Bool
    let allowedRoles: [String]
    let tools: [ValidatedPluginTool]
    let json: JSONValue
}

enum PluginManifestValidationError: Error, Equatable, CustomStringConvertible {
    case rejected(String)

    var description: String {
        switch self {
        case .rejected(let reason): return reason
        }
    }
}

/// ADR-0113 D6 manifest admission. Every policy vocabulary is an explicit
/// allowlist; unknown values are rejected so a newer manifest cannot silently
/// widen an older server's execution authority.
enum PluginManifestValidator {
    static let supportedProtocolVersions = ["2025-06-18"]
    static let supportedTransports = ["streamable_http"]
    static let allowedSPDX = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "LicenseRef-Linear-Hosted-Service"]
    static let allowedPluginRisks = ["low", "medium", "high", "critical"]
    static let allowedToolRisks = ["read", "write", "admin"]
    static let allowedApprovalPolicies = ["none", "require_approval", "always", "deny"]
    static let allowedApprovalTiers = ["read_only", "workspace_write", "network_write"]
    static let allowedInstallRoles = ["owner", "admin"]

    private static let forbiddenKeyFragments = [
        "credential", "access_token", "refresh_token", "oauth_token", "authorization",
        "client_secret", "private_key", "password", "bearer_token", "api_key"
    ]

    static func validate(
        manifestJSON: String,
        expectedDigest: String,
        computedDigest: String,
        revoked: Bool
    ) throws -> ValidatedPluginManifest {
        guard !revoked else { throw rejected("plugin is revoked") }
        guard expectedDigest.wholeMatch(of: /^sha256:[0-9a-f]{64}$/) != nil,
              expectedDigest == computedDigest
        else { throw rejected("manifest digest mismatch") }

        guard let data = manifestJSON.data(using: .utf8) else {
            throw rejected("manifest is not UTF-8")
        }
        let json: JSONValue
        do {
            json = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw rejected("manifest is malformed")
        }
        guard let root = json.objectValue else { throw rejected("manifest root must be an object") }
        try requireKeys(root, exactly: ["schemaVersion", "plugin", "mcp", "skill", "momo"], at: "manifest")
        guard try string(root, "schemaVersion", at: "manifest") == "momo.plugin.v1" else {
            throw rejected("unknown manifest schema")
        }
        try rejectSecretLikeKeys(json, path: "manifest")

        let plugin = try object(root, "plugin", at: "manifest")
        try requireKeys(plugin, exactly: ["id", "name", "version", "description", "publisher", "license", "provenance"], at: "plugin")
        let pluginID = try string(plugin, "id", at: "plugin")
        guard pluginID.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{2,127}$/) != nil else {
            throw rejected("invalid plugin id")
        }
        let name = try nonempty(string(plugin, "name", at: "plugin"), label: "plugin name")
        let version = try nonempty(string(plugin, "version", at: "plugin"), label: "plugin version")
        let description = try nonempty(string(plugin, "description", at: "plugin"), label: "plugin description")

        let publisher = try object(plugin, "publisher", at: "plugin")
        try requireKeys(publisher, exactly: ["id", "name", "verified"], at: "plugin.publisher")
        _ = try nonempty(string(publisher, "id", at: "plugin.publisher"), label: "publisher id")
        _ = try nonempty(string(publisher, "name", at: "plugin.publisher"), label: "publisher name")
        guard try bool(publisher, "verified", at: "plugin.publisher") else {
            throw rejected("publisher is not verified")
        }

        let license = try object(plugin, "license", at: "plugin")
        try requireKeys(license, exactly: ["spdx", "kind"], at: "plugin.license")
        let spdx = try string(license, "spdx", at: "plugin.license")
        let lowerSPDX = spdx.lowercased()
        guard !lowerSPDX.contains("gpl") && !lowerSPDX.contains("agpl"), allowedSPDX.contains(spdx) else {
            throw rejected("license is not admitted")
        }
        let licenseKind = try string(license, "kind", at: "plugin.license")
        guard ["open_source", "hosted_only"].contains(licenseKind) else {
            throw rejected("unknown license kind")
        }

        let provenance = try object(plugin, "provenance", at: "plugin")
        try requireKeys(provenance, exactly: ["sourceURL", "releaseRef", "verified"], at: "plugin.provenance")
        guard let sourceURL = URL(string: try string(provenance, "sourceURL", at: "plugin.provenance")),
              sourceURL.scheme == "https", sourceURL.host != nil,
              try bool(provenance, "verified", at: "plugin.provenance")
        else { throw rejected("publisher provenance is not verified HTTPS") }
        _ = try nonempty(string(provenance, "releaseRef", at: "plugin.provenance"), label: "release ref")

        let mcp = try object(root, "mcp", at: "manifest")
        try requireKeys(mcp, exactly: ["protocolVersion", "transport", "url", "server", "tools"], at: "mcp")
        guard supportedProtocolVersions.contains(try string(mcp, "protocolVersion", at: "mcp")) else {
            throw rejected("unknown MCP protocol")
        }
        let mcpTransport = try string(mcp, "transport", at: "mcp")
        guard supportedTransports.contains(mcpTransport) else {
            throw rejected("unknown MCP transport")
        }
        let mcpURL = try string(mcp, "url", at: "mcp")
        guard let endpoint = URL(string: mcpURL),
              endpoint.scheme == "https", let endpointHost = endpoint.host?.lowercased()
        else { throw rejected("MCP endpoint must be HTTPS") }
        let server = try object(mcp, "server", at: "mcp")
        try requireKeys(server, exactly: ["name", "version"], at: "mcp.server")
        _ = try nonempty(string(server, "name", at: "mcp.server"), label: "server name")
        _ = try nonempty(string(server, "version", at: "mcp.server"), label: "server version")

        let skill = try object(root, "skill", at: "manifest")
        try requireKeys(skill, exactly: ["reference", "optional"], at: "skill")
        guard try bool(skill, "optional", at: "skill") else {
            throw rejected("SKILL reference must remain optional in v1")
        }
        if let reference = skill["reference"], reference != .null {
            guard let value = reference.stringValue, let url = URL(string: value), url.scheme == "https" else {
                throw rejected("SKILL reference must be null or HTTPS")
            }
        }

        let momo = try object(root, "momo", at: "manifest")
        try requireKeys(momo, exactly: ["approvalTier", "risk", "egressDomains", "recommendedFor", "serverPolicy"], at: "momo")
        let pluginRisk = try string(momo, "risk", at: "momo")
        guard allowedPluginRisks.contains(pluginRisk) else { throw rejected("unknown plugin risk") }
        let approvalTier = try object(momo, "approvalTier", at: "momo")

        let egressDomains = try strings(momo, "egressDomains", at: "momo")
        guard !egressDomains.isEmpty,
              Set(egressDomains).count == egressDomains.count,
              egressDomains.allSatisfy({
                  $0 == $0.lowercased()
                    && $0.wholeMatch(of: /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/) != nil
              }),
              egressDomains.contains(endpointHost)
        else { throw rejected("egressDomains must be unique domain names and include the MCP endpoint") }
        let recommendedFor = try strings(momo, "recommendedFor", at: "momo")
        guard !recommendedFor.isEmpty, recommendedFor.allSatisfy({ !$0.isEmpty }) else {
            throw rejected("recommendedFor must not be empty")
        }

        let policy = try object(momo, "serverPolicy", at: "momo")
        try requireKeys(policy, exactly: ["installAllowed", "enabledByDefault", "allowedRoles"], at: "momo.serverPolicy")
        let installAllowed = try bool(policy, "installAllowed", at: "momo.serverPolicy")
        let enabledByDefault = try bool(policy, "enabledByDefault", at: "momo.serverPolicy")
        let allowedRoles = try strings(policy, "allowedRoles", at: "momo.serverPolicy")
        guard !allowedRoles.isEmpty,
              Set(allowedRoles).count == allowedRoles.count,
              allowedRoles.allSatisfy(allowedInstallRoles.contains)
        else { throw rejected("unknown serverPolicy role") }

        let rawTools = try array(mcp, "tools", at: "mcp")
        guard !rawTools.isEmpty else { throw rejected("manifest must declare at least one tool") }
        var tools: [ValidatedPluginTool] = []
        var toolNames = Set<String>()
        for (index, rawTool) in rawTools.enumerated() {
            guard let tool = rawTool.objectValue else { throw rejected("mcp.tools[\(index)] must be an object") }
            let path = "mcp.tools[\(index)]"
            try requireKeys(tool, exactly: ["name", "description", "inputSchema", "schemaDigest", "scopes", "risk", "approvalPolicy"], at: path)
            let toolName = try nonempty(string(tool, "name", at: path), label: "tool name")
            guard toolNames.insert(toolName).inserted else { throw rejected("duplicate tool name") }
            _ = try nonempty(string(tool, "description", at: path), label: "tool description")
            let inputSchema = try object(tool, "inputSchema", at: path)
            try validateInputSchema(inputSchema, at: "\(path).inputSchema")
            let schemaDigest = try string(tool, "schemaDigest", at: path)
            guard schemaDigest.wholeMatch(of: /^sha256:[0-9a-f]{64}$/) != nil else {
                throw rejected("invalid tool schema digest")
            }
            let scopes = try strings(tool, "scopes", at: path)
            guard !scopes.isEmpty, Set(scopes).count == scopes.count,
                  scopes.allSatisfy({ $0.wholeMatch(of: /^[a-z0-9][a-z0-9:._\/-]{0,127}$/) != nil })
            else { throw rejected("invalid tool scope") }
            let risk = try string(tool, "risk", at: path)
            guard allowedToolRisks.contains(risk) else { throw rejected("unknown tool risk") }
            let approvalPolicy = try string(tool, "approvalPolicy", at: path)
            guard allowedApprovalPolicies.contains(approvalPolicy) else {
                throw rejected("unknown approval policy")
            }
            guard let tier = approvalTier[toolName]?.stringValue,
                  allowedApprovalTiers.contains(tier)
            else { throw rejected("unknown or missing approval tier") }
            try validatePolicyCombination(risk: risk, approvalPolicy: approvalPolicy, approvalTier: tier)
            tools.append(.init(
                name: toolName,
                scopes: scopes,
                risk: risk,
                approvalPolicy: approvalPolicy,
                approvalTier: tier,
                schemaDigest: schemaDigest
            ))
        }
        guard Set(approvalTier.keys) == toolNames else {
            throw rejected("approvalTier must map exactly the declared tools")
        }

        return ValidatedPluginManifest(
            pluginID: pluginID,
            name: name,
            version: version,
            description: description,
            mcpURL: mcpURL,
            mcpTransport: mcpTransport,
            egressDomains: egressDomains,
            recommendedFor: recommendedFor,
            installAllowed: installAllowed,
            enabledByDefault: enabledByDefault,
            allowedRoles: allowedRoles,
            tools: tools,
            json: json
        )
    }

    private static func validatePolicyCombination(
        risk: String,
        approvalPolicy: String,
        approvalTier: String
    ) throws {
        switch risk {
        case "read":
            guard approvalPolicy == "none", approvalTier == "read_only" else {
                throw rejected("read tools must use none/read_only")
            }
        case "write":
            guard ["require_approval", "always"].contains(approvalPolicy),
                  ["workspace_write", "network_write"].contains(approvalTier)
            else { throw rejected("write tools require approval and a write tier") }
        case "admin":
            guard ["always", "deny"].contains(approvalPolicy), approvalTier == "network_write" else {
                throw rejected("admin tools must use always-or-deny/network_write")
            }
        default:
            throw rejected("unknown tool risk")
        }
    }

    private static func validateInputSchema(
        _ schema: [String: JSONValue],
        at path: String
    ) throws {
        let allowedRoot = Set(["type", "properties", "required", "additionalProperties"])
        guard Set(schema.keys).isSubset(of: allowedRoot),
              schema["type"]?.stringValue == "object",
              let properties = schema["properties"]?.objectValue,
              schema["additionalProperties"] == .bool(false)
        else { throw rejected("unknown or open tool schema at \(path)") }
        if let required = schema["required"] {
            guard let values = required.arrayValue?.compactMap(\.stringValue),
                  values.count == required.arrayValue?.count,
                  Set(values).count == values.count,
                  values.allSatisfy({ properties[$0] != nil })
            else { throw rejected("invalid required fields at \(path)") }
        }
        for (name, value) in properties {
            guard !name.isEmpty, let child = value.objectValue else {
                throw rejected("invalid tool property at \(path).properties")
            }
            try validatePropertySchema(child, at: "\(path).properties.\(name)")
        }
    }

    private static func validatePropertySchema(
        _ schema: [String: JSONValue],
        at path: String
    ) throws {
        let allowed = Set([
            "type", "description", "enum", "items", "properties", "required",
            "additionalProperties", "minLength", "maxLength", "minimum", "maximum"
        ])
        guard Set(schema.keys).isSubset(of: allowed),
              let type = schema["type"]?.stringValue,
              ["string", "integer", "number", "boolean", "array", "object"].contains(type)
        else { throw rejected("unknown property schema at \(path)") }
        if let description = schema["description"], description.stringValue == nil {
            throw rejected("invalid schema description at \(path)")
        }
        if let enumeration = schema["enum"] {
            guard let values = enumeration.arrayValue, !values.isEmpty,
                  values.allSatisfy({ $0.stringValue != nil || $0.objectValue == nil && $0.arrayValue == nil })
            else { throw rejected("invalid schema enum at \(path)") }
        }
        switch type {
        case "object":
            try validateInputSchema(schema, at: path)
        case "array":
            guard let items = schema["items"]?.objectValue else {
                throw rejected("array schema requires items at \(path)")
            }
            try validatePropertySchema(items, at: "\(path).items")
        default:
            guard schema["items"] == nil,
                  schema["properties"] == nil,
                  schema["required"] == nil,
                  schema["additionalProperties"] == nil
            else { throw rejected("scalar schema has container fields at \(path)") }
        }
    }

    private static func rejectSecretLikeKeys(_ value: JSONValue, path: String) throws {
        switch value {
        case .object(let object):
            for (key, child) in object {
                let normalized = key.lowercased()
                if forbiddenKeyFragments.contains(where: normalized.contains) {
                    throw rejected("secret-like manifest field is forbidden at \(path).\(key)")
                }
                try rejectSecretLikeKeys(child, path: "\(path).\(key)")
            }
        case .array(let values):
            for (index, child) in values.enumerated() {
                try rejectSecretLikeKeys(child, path: "\(path)[\(index)]")
            }
        default:
            break
        }
    }

    private static func requireKeys(
        _ object: [String: JSONValue],
        exactly expected: Set<String>,
        at path: String
    ) throws {
        guard Set(object.keys) == expected else { throw rejected("unknown or missing field at \(path)") }
    }

    private static func object(
        _ object: [String: JSONValue], _ key: String, at path: String
    ) throws -> [String: JSONValue] {
        guard let value = object[key]?.objectValue else { throw rejected("\(path).\(key) must be an object") }
        return value
    }

    private static func array(
        _ object: [String: JSONValue], _ key: String, at path: String
    ) throws -> [JSONValue] {
        guard let value = object[key]?.arrayValue else { throw rejected("\(path).\(key) must be an array") }
        return value
    }

    private static func strings(
        _ object: [String: JSONValue], _ key: String, at path: String
    ) throws -> [String] {
        try array(object, key, at: path).map { value in
            guard let string = value.stringValue else { throw rejected("\(path).\(key) must contain strings") }
            return string
        }
    }

    private static func string(
        _ object: [String: JSONValue], _ key: String, at path: String
    ) throws -> String {
        guard let value = object[key]?.stringValue else { throw rejected("\(path).\(key) must be a string") }
        return value
    }

    private static func bool(
        _ object: [String: JSONValue], _ key: String, at path: String
    ) throws -> Bool {
        guard case .bool(let value)? = object[key] else { throw rejected("\(path).\(key) must be a boolean") }
        return value
    }

    private static func nonempty(_ value: String, label: String) throws -> String {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw rejected("\(label) must not be empty")
        }
        return value
    }

    private static func rejected(_ reason: String) -> PluginManifestValidationError {
        .rejected(reason)
    }
}
