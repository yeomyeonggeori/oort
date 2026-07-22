import Hummingbird

/// Shared ADR-0004 boundary for public agent metadata and local profiles.
enum AgentCredentialFieldPolicy {
    private static let forbiddenFragments = [
        "credential", "accesstoken", "refreshtoken", "oauthtoken", "authorization",
        "clientsecret", "privatekey", "password", "bearertoken", "apikey",
        "codexaccess", "codexrefresh", "openaioauth",
    ]

    static func rejectCredentialShapedFields(
        _ value: JSONValue,
        path: String,
        error: (String) -> any Error = {
            HTTPError(.badRequest, message: "credential-shaped field is forbidden at \($0)")
        }
    ) throws {
        switch value {
        case .object(let object):
            for (key, child) in object {
                let normalized = key.lowercased().filter { $0.isLetter || $0.isNumber }
                if forbiddenFragments.contains(where: normalized.contains) {
                    throw error("\(path).\(key)")
                }
                try rejectCredentialShapedFields(child, path: "\(path).\(key)", error: error)
            }
        case .array(let values):
            for (index, child) in values.enumerated() {
                try rejectCredentialShapedFields(child, path: "\(path)[\(index)]", error: error)
            }
        default:
            break
        }
    }
}
