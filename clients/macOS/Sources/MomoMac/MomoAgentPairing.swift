import Foundation
import MomoCore

enum MomoAgentPairingPermissionScope: String, CaseIterable, Identifiable, Codable, Sendable {
    case channelReadReply = "channel.read_reply"
    case channelReadReplyApprovalTools = "channel.read_reply.approval_tools"

    var id: String { rawValue }
}

struct MomoAgentPairingEndpointPolicy: Equatable, Sendable {
    var isAllowed: Bool
    var isLoopback: Bool
    var requiresExplicitOptIn: Bool
    var reason: String
    var sanitizedEndpoint: String?
}

enum MomoAgentPairingSecurity {
    static func endpointPolicy(_ endpoint: String, allowNonLoopbackHTTP: Bool) -> MomoAgentPairingEndpointPolicy {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              !host.isEmpty
        else {
            return MomoAgentPairingEndpointPolicy(
                isAllowed: false,
                isLoopback: false,
                requiresExplicitOptIn: false,
                reason: "Enter an endpoint like http://127.0.0.1:28188/v1.",
                sanitizedEndpoint: nil
            )
        }

        guard url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil
        else {
            return MomoAgentPairingEndpointPolicy(
                isAllowed: false,
                isLoopback: false,
                requiresExplicitOptIn: false,
                reason: "Endpoint must not include username, password, query, or fragment values.",
                sanitizedEndpoint: nil
            )
        }

        let isLoopback = host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.hasSuffix(".localhost")

        let sanitizedEndpoint = sanitizedEndpoint(from: url) ?? trimmed

        if scheme == "http", !isLoopback {
            return MomoAgentPairingEndpointPolicy(
                isAllowed: allowNonLoopbackHTTP,
                isLoopback: false,
                requiresExplicitOptIn: true,
                reason: allowNonLoopbackHTTP
                    ? "Non-loopback HTTP allowed by explicit opt-in."
                    : "Non-loopback HTTP is blocked unless you explicitly opt in.",
                sanitizedEndpoint: allowNonLoopbackHTTP ? sanitizedEndpoint : nil
            )
        }

        if scheme != "http", scheme != "https" {
            return MomoAgentPairingEndpointPolicy(
                isAllowed: false,
                isLoopback: isLoopback,
                requiresExplicitOptIn: false,
                reason: "Only http or https endpoints are supported.",
                sanitizedEndpoint: nil
            )
        }

        return MomoAgentPairingEndpointPolicy(
            isAllowed: true,
            isLoopback: isLoopback,
            requiresExplicitOptIn: false,
            reason: isLoopback ? "Loopback endpoint allowed." : "Endpoint allowed by explicit configuration.",
            sanitizedEndpoint: sanitizedEndpoint
        )
    }

    static func normalizedHandle(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutAt = trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        return withoutAt.lowercased().filter { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
        }
    }

    static func sanitizedEndpoint(_ endpoint: String) -> String? {
        endpointPolicy(endpoint, allowNonLoopbackHTTP: true).sanitizedEndpoint
    }

    private static func sanitizedEndpoint(from url: URL) -> String? {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.user = nil
        components?.password = nil
        components?.query = nil
        components?.fragment = nil
        return components?.string
    }
}

struct MomoAgentPairingManifest: Codable, Equatable, Sendable {
    struct Runtime: Codable, Equatable, Sendable {
        var kind: String
        var endpoint: String
        var modelLabel: String
        var providerCredentialPolicy: String
    }

    struct Agent: Codable, Equatable, Sendable {
        var handle: String
        var displayName: String
        var memberKind: String
        var permissionScope: String
    }

    struct MomoConnection: Codable, Equatable, Sendable {
        var apiURL: String
        var workspaceID: String?
        var channelID: String?
        var gatewaySecretSource: String
        var helperCommands: [String]
    }

    var schema: String
    var generatedAtMs: Int64
    var agent: Agent
    var runtime: Runtime
    var momo: MomoConnection
    var securityNotes: [String]

    static func make(
        displayName: String,
        handle rawHandle: String,
        endpoint: String,
        modelLabel: String,
        permissionScope: MomoAgentPairingPermissionScope,
        workspaceID: WorkspaceID?,
        channelID: ChannelID?,
        apiURL: String?,
        generatedAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> MomoAgentPairingManifest {
        let handle = MomoAgentPairingSecurity.normalizedHandle(rawHandle)
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveName = name.isEmpty ? handle.capitalized : name
        return MomoAgentPairingManifest(
            schema: "momo.agent_pairing_manifest.v0",
            generatedAtMs: generatedAtMs,
            agent: Agent(
                handle: handle,
                displayName: effectiveName,
                memberKind: "agent",
                permissionScope: permissionScope.rawValue
            ),
            runtime: Runtime(
                kind: "hermes-compatible-gateway",
                endpoint: MomoAgentPairingSecurity.sanitizedEndpoint(endpoint) ?? "invalid-endpoint",
                modelLabel: modelLabel.trimmingCharacters(in: .whitespacesAndNewlines),
                providerCredentialPolicy: "provider-owned; do not paste Codex/OpenAI OAuth tokens into momo"
            ),
            momo: MomoConnection(
                apiURL: apiURL ?? "http://127.0.0.1:28180",
                workspaceID: workspaceID?.description,
                channelID: channelID?.description,
                gatewaySecretSource: "$HOME/.momo/hermes-gateway.env:MOMO_AGENT_GATEWAY_SECRET",
                helperCommands: [
                    "scripts/momo hermes-gateway-init",
                    "scripts/momo hermes-gateway-install-plugin",
                    "scripts/momo hermes-gateway-status",
                    "MOMO_HERMES_PROVIDER_READY=1 scripts/momo hermes-gateway-smoke --real --trigger",
                ]
            ),
            securityNotes: [
                "This manifest intentionally excludes Codex/OpenAI OAuth tokens, refresh tokens, and provider API keys.",
                "Provider credentials must stay inside the local Hermes/provider runtime.",
                "All user-visible writes must return through momo REST so Postgres remains the source of truth.",
            ]
        )
    }

    var prettyJSONString: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self),
              let text = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return text
    }

    var inviteCode: String {
        let payload = "\(schema)|\(agent.handle)|\(agent.permissionScope)|\(runtime.endpoint)|\(momo.workspaceID ?? "workspace")|\(momo.channelID ?? "channel")"
        let digest = payload.utf8.reduce(UInt64(0xcbf29ce484222325)) { partial, byte in
            (partial ^ UInt64(byte)).multipliedReportingOverflow(by: 0x100000001b3).partialValue
        }
        return "momo-agent-\(String(digest, radix: 16))"
    }
}
