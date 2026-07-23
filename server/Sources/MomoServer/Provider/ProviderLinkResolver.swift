import Foundation

/// A decrypted `provider_link` row, resolved for use. The `bearer` is present
/// only in memory on the resolution boundary and must never be serialized.
struct DecryptedProviderLink: Sendable, Equatable {
    var baseURL: String
    var bearer: String
    var mode: AgentProviderMode
    var updatedByMemberID: UUID?
    var updatedAtMs: Int64

    /// A link is *usable* (and therefore wins over env) only when both the URL
    /// and the bearer carry real content. A half-written / cleared row falls back
    /// to env so the process never silently loses the provider (ADR-0004 fail
    /// safe rather than fail blank).
    var isUsable: Bool {
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !bearer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// The effective provider configuration after applying DB-over-env precedence,
/// tagged with which source won.
struct ResolvedProviderConfig: Sendable {
    enum Source: String, Sendable {
        case database
        case environment
    }

    var config: AgentProviderConfig
    var source: Source
}

/// ADR-0004 증보 1 D-? mode resolution: **DB `provider_link` (present & usable) >
/// env**. The env `AgentProviderConfig` supplies model / handle / display-name
/// (fields the operator link does not carry); the DB link overrides mode,
/// base URL, and bearer.
///
/// This is a pure function so the precedence + fail-closed behavior are unit
/// testable without a database.
enum ProviderLinkResolver {
    static func resolve(
        env: AgentProviderConfig,
        link: DecryptedProviderLink?
    ) -> ResolvedProviderConfig {
        guard let link, link.isUsable else {
            return ResolvedProviderConfig(config: env, source: .environment)
        }
        var effective = env
        effective.mode = link.mode
        effective.hermesBaseURL = link.baseURL
        effective.hermesAPIKey = link.bearer
        return ResolvedProviderConfig(config: effective, source: .database)
    }
}
