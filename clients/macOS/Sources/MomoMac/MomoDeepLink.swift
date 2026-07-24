import Foundation

// MARK: - momo:// deep link parsing (W-O1, MOMO-585)

/// A parsed `momo://join` deep link.
///
/// Shared contract with the invite tooling (MOMO-584):
/// `momo://join?server=<percent-encoded base URL>&code=<invite code>`.
/// Two query parameters, order-independent, unknown parameters ignored. The
/// `server` value is percent-decoded here; it is re-validated by the existing
/// `MomoServerSessionForm.validatedBaseURL()` rules before any connection is made.
public struct MomoDeepLink: Equatable, Sendable {
    /// Percent-decoded server base URL string, trimmed. May be empty when the
    /// link only carried an invite code.
    public var serverURLString: String
    /// Invite code, trimmed. May be empty when the link only carried a server URL.
    public var inviteCode: String

    public init(serverURLString: String, inviteCode: String) {
        self.serverURLString = serverURLString
        self.inviteCode = inviteCode
    }
}

/// Pure parsing for momo custom-scheme deep links. No AppKit or session state is
/// touched, so the whole surface is unit-testable without a window.
public enum MomoDeepLinkParser {
    public static let scheme = "momo"
    public static let joinAction = "join"

    /// Parses `momo://join?server=…&code=…`.
    ///
    /// Returns `nil` when the URL is not a momo join link, or when it carries
    /// nothing usable to prefill. When at least one recognized parameter has a
    /// non-empty value the available fields are returned so the chooser can
    /// prefill what it can (a link with only a server, or only a code, still
    /// helps the person get started). URLComponents percent-decodes the query
    /// values, so `server=http%3A%2F%2Fmacbook.local%3A28180` arrives decoded.
    public static func parseJoin(_ url: URL) -> MomoDeepLink? {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(),
            scheme == Self.scheme,
            resolvedAction(components) == Self.joinAction
        else {
            return nil
        }

        var server: String?
        var code: String?
        for item in components.queryItems ?? [] {
            switch item.name.lowercased() {
            case "server" where server == nil:
                server = item.value
            case "code" where code == nil:
                code = item.value
            default:
                continue // Unknown parameters are ignored per the shared contract.
            }
        }

        let trimmedServer = server?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let trimmedCode = code?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmedServer.isEmpty || !trimmedCode.isEmpty else {
            return nil
        }
        return MomoDeepLink(serverURLString: trimmedServer, inviteCode: trimmedCode)
    }

    /// The action is the authority (`momo://join`) or, when the link omits the
    /// authority (`momo:join`), the first path segment. Case-insensitive.
    private static func resolvedAction(_ components: URLComponents) -> String? {
        if let host = components.host, !host.isEmpty {
            return host.lowercased()
        }
        return components.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .first
            .map { $0.lowercased() }
    }
}

// MARK: - momo:// deep link assembly (MOMO-591)

/// Builds `momo://join` deep links, the inverse of `MomoDeepLinkParser`.
///
/// The output must match `docs/onboarding-deeplink.md` byte for byte so the
/// ops CLI (MOMO-584) and the in-app invite tooling produce identical links.
public enum MomoDeepLinkBuilder {
    /// RFC 3986 unreserved set: `A-Z a-z 0-9 - . _ ~`. Everything else is
    /// percent-encoded, so the server base URL's `:` and `/` become `%3A`/`%2F`
    /// per the deep link contract, and the same set safely encodes mailto header
    /// values (RFC 6068: spaces to `%20`, `&`/`=` to `%26`/`%3D`).
    static let unreservedCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    static func percentEncoded(_ value: String) -> String? {
        value.addingPercentEncoding(withAllowedCharacters: unreservedCharacters)
    }

    /// Assembles `momo://join?server=<percent-encoded base URL>&code=<code>`.
    ///
    /// The raw invite code is embedded on purpose: the deep link is a hand-off
    /// artifact the operator gives a new member, so carrying the code inside the
    /// link is the same allowance `docs/onboarding-deeplink.md` grants the ops
    /// CLI (the code only ever appears inside the link). Callers must build this
    /// only from a code they already surfaced to the operator.
    ///
    /// Returns `nil` when either input is blank, so a link is never emitted with
    /// a missing server or code.
    public static func buildJoinLink(serverURLString: String, inviteCode: String) -> String? {
        let server = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        let code = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !server.isEmpty, !code.isEmpty else { return nil }
        guard
            let encodedServer = percentEncoded(server),
            let encodedCode = percentEncoded(code)
        else {
            return nil
        }
        return "\(MomoDeepLinkParser.scheme)://\(MomoDeepLinkParser.joinAction)?server=\(encodedServer)&code=\(encodedCode)"
    }
}
