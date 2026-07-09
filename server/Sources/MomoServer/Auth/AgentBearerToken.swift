import Foundation

/// Opaque, high-entropy momo credential presented by an agent runtime.
///
/// The workspace UUID is carried in the token envelope so a NOBYPASSRLS API
/// process can establish `SET LOCAL app.workspace_id` before looking up the
/// sha256 hash. The actor identity and scopes are never trusted from the
/// envelope; they always come from the tenant-scoped `token` row.
enum AgentBearerToken {
    static let prefix = "momo_agent_v1"

    static func mint(workspaceID: UUID) -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        let secret = Data(bytes)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "\(prefix).\(workspaceID.uuidString.lowercased()).\(secret)"
    }

    static func workspaceID(from rawToken: String) -> UUID? {
        let parts = rawToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0] == Substring(prefix),
              parts[2].count >= 43
        else { return nil }
        return UUID(uuidString: String(parts[1]))
    }
}
