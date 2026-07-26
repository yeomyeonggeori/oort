import Foundation

/// MOMO-622 / ADR-0135 D1 — the provider cascade contract.
///
/// The chain is an ordered list of provider hops. Position 0 is the legacy
/// `provider_link` singleton (or, when the operator configured none, the env
/// fallback); positions >= 1 come from `provider_link_chain` (migration 042).
///
/// **Fall-over rule (the whole point of the ADR):** only a *provider-side
/// availability* failure advances to the next hop — no response at all, any 5xx,
/// or 429. Every other 4xx is a caller/config error (bad key, bad model, bad
/// request) and MUST propagate: retrying it on a second provider would spend a
/// second budget on the same guaranteed failure and hide the real cause.
///
/// The types are pure so the rule is unit-testable without a database, a network,
/// or a running worker; the AgentWorker package carries a mirror of
/// `ProviderCascadeClassifier` (the two packages share no module, exactly as
/// `ProviderLinkCrypto` is mirrored).
enum ProviderCascadeDecision: Sendable, Equatable {
    /// Provider-side availability failure — try the next hop and record the switch.
    case fallOver(reason: String)
    /// Caller/config error — surface it to the caller, never silently re-spend.
    case propagate(reason: String)

    var reason: String {
        switch self {
        case .fallOver(let reason), .propagate(let reason): return reason
        }
    }

    var isFallOver: Bool {
        if case .fallOver = self { return true }
        return false
    }
}

enum ProviderCascadeClassifier {
    /// Reason label for "the provider never answered" (connect refused, DNS,
    /// timeout, TLS, dropped stream). Matches `HTTPProviderHealthProbe`'s
    /// credential-free vocabulary so probe results and cascade audit rows read the
    /// same.
    static let unreachableReason = "provider_unreachable"
    static let rateLimitedReason = "provider_rate_limited"

    /// `nil` status == no response at all.
    static func decide(status: Int?) -> ProviderCascadeDecision {
        guard let status else { return .fallOver(reason: unreachableReason) }
        if status == 429 { return .fallOver(reason: rateLimitedReason) }
        if (500...599).contains(status) {
            return .fallOver(reason: "provider_status_\(status)")
        }
        return .propagate(reason: "provider_status_\(status)")
    }

    /// Convenience over a probe result: `ok` short-circuits, otherwise the coarse
    /// reason string is re-classified. Used by the chain probe to report, per hop,
    /// whether a real cascade would have moved past it.
    static func decide(probeReason: String?) -> ProviderCascadeDecision {
        guard let probeReason else { return .propagate(reason: "unknown") }
        if probeReason == unreachableReason || probeReason == rateLimitedReason {
            return .fallOver(reason: probeReason)
        }
        if probeReason.hasPrefix("provider_status_"),
           let code = Int(probeReason.dropFirst("provider_status_".count)) {
            return decide(status: code)
        }
        // provider_auth_failed (401/403), not_external_provider,
        // provider_not_configured … all caller/config problems.
        return .propagate(reason: probeReason)
    }
}

/// One resolved hop of the cascade, bearer included. Never serialize this type —
/// the REST projection (`ProviderChainEntryDTO`) is the only thing that leaves the
/// process, and it carries a masked tail instead of the bearer (ADR-0004).
struct ProviderCascadeHop: Sendable, Equatable {
    /// Where this hop's configuration came from — surfaced to the operator so the
    /// legacy singleton and the new chain rows are distinguishable in the UI.
    enum Source: String, Sendable {
        /// Position 0, from the `provider_link` singleton (migration 039).
        case providerLink = "provider_link"
        /// Position 0 with no DB row — the boot-time HERMES_* env trio.
        case environment
        /// Position >= 1, from `provider_link_chain` (migration 042).
        case chain
    }

    var position: Int
    var source: Source
    var baseURL: String
    var bearer: String
    var mode: AgentProviderMode
    var enabled: Bool

    var endpointLabel: String {
        AgentProviderConfig.redactedEndpointLabel(baseURL)
    }

    /// A hop is usable only when URL and bearer both carry real content. A
    /// half-written hop is skipped rather than failing the turn blank (same fail-safe
    /// posture as `DecryptedProviderLink.isUsable`).
    var isUsable: Bool {
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !bearer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum ProviderCascade {
    /// Build the full cascade: the effective position-0 link followed by the
    /// configured chain entries in ascending position order.
    ///
    /// `head` is the already-resolved DB-over-env position 0 (see
    /// `ProviderLinkResolver`), so this function never re-implements that
    /// precedence.
    static func plan(
        head: ResolvedProviderConfig,
        chain: [DecryptedProviderChainEntry]
    ) -> [ProviderCascadeHop] {
        var hops: [ProviderCascadeHop] = [
            ProviderCascadeHop(
                position: 0,
                source: head.source == .database ? .providerLink : .environment,
                baseURL: head.config.hermesBaseURL,
                bearer: head.config.hermesAPIKey,
                mode: head.config.mode,
                enabled: true
            ),
        ]
        for entry in chain.sorted(by: { $0.position < $1.position }) {
            hops.append(
                ProviderCascadeHop(
                    position: entry.position,
                    source: .chain,
                    baseURL: entry.baseURL,
                    bearer: entry.bearer,
                    mode: entry.mode,
                    enabled: entry.enabled
                )
            )
        }
        return hops
    }

    /// The hops a real turn would actually attempt, in order: enabled and usable.
    static func attemptable(_ hops: [ProviderCascadeHop]) -> [ProviderCascadeHop] {
        hops.filter { $0.enabled && $0.isUsable }
    }
}
