import Foundation
import Hummingbird

/// MOMO-621 / ADR-0134 D2 — `GET /v1/provider/effort-table`.
///
/// The effort axis has no single global vocabulary: which levels a model
/// actually accepts is a **provider × model** property (buzz 실측 — xhigh/max
/// support differs per model). ADR-0134 D2 therefore makes the server the SoT
/// for those valid values and exposes them so clients can pre-filter the picker
/// instead of guessing and eating a 400.
///
/// v0 starts as a compiled constant (`ProviderEffortTable.entries`) rather than
/// a table: momo's model universe today is the provider-agnostic hermes gateway
/// handle set (`agent.model`, ADR-0130), and a DB table with no writer would be
/// dead weight. The wire shape is already the extensible one (provider →
/// models → efforts), so a later DB/registry source can replace the constant
/// without a client-visible contract change.
///
/// Authorization: any authenticated principal. The table carries no tenant data
/// (no workspace row, no credential, no provider secret — ADR-0004), and the
/// composer needs it before a run exists.
struct ProviderEffortTableRoutes: Sendable {
    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/provider/effort-table", use: get)
    }

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try context.requirePrincipal()
        return try ProviderEffortTable.response.response(from: request, context: context)
    }
}

/// Server-side definition of the effort axis (ADR-0134 D2).
///
/// `levels` is the canonical superset in ascending order; an individual model
/// exposes a prefix/subset of it. A model that is not listed resolves to
/// `fallbackEfforts` — deliberately the conservative low/medium/high triple, so
/// an unknown model never silently accepts an xhigh/max the provider would
/// reject downstream.
enum ProviderEffortTable {
    static let schema = "momo.provider.effort_table.v0"

    /// Canonical superset, ascending. A value outside this set is never a valid
    /// `routing.effort` regardless of model.
    static let levels = ["low", "medium", "high", "xhigh", "max"]

    /// Longest accepted effort token. Mirrors migration 041's length CHECK on
    /// `usage_ledger.effort` / `agent_profile.effort_pref`.
    static let maxEffortLength = 32

    struct Entry: Equatable, Sendable {
        let provider: String
        let model: String
        let efforts: [String]
        let defaultEffort: String
    }

    /// v0 constant table. `hermes` is momo's provider-agnostic gateway handle
    /// namespace (ADR-0130); the seeded `agent.model` is `hermes-agent`.
    static let entries: [Entry] = [
        Entry(
            provider: "hermes",
            model: "hermes-agent",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            defaultEffort: "medium"
        ),
        Entry(
            provider: "hermes",
            model: "hermes-default",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            defaultEffort: "medium"
        ),
        Entry(
            provider: "hermes",
            model: "hermes-fast",
            efforts: ["low", "medium"],
            defaultEffort: "low"
        ),
        Entry(
            provider: "hermes",
            model: "hermes-lite",
            efforts: ["low", "medium"],
            defaultEffort: "low"
        ),
    ]

    static let fallbackEfforts = ["low", "medium", "high"]
    static let fallbackDefaultEffort = "medium"

    static func entry(model: String) -> Entry? {
        let normalized = model.trimmingCharacters(in: .whitespacesAndNewlines)
        return entries.first { $0.model == normalized }
    }

    static func supportedEfforts(model: String) -> [String] {
        entry(model: model)?.efforts ?? fallbackEfforts
    }

    static func defaultEffort(model: String) -> String {
        entry(model: model)?.defaultEffort ?? fallbackDefaultEffort
    }

    /// True when `effort` is an accepted level for `model`. Comparison is on the
    /// canonical lowercase token; callers normalize first.
    static func supports(model: String, effort: String) -> Bool {
        supportedEfforts(model: model).contains(effort)
    }

    /// Shape-only normalization, usable before a transaction opens: trims,
    /// lowercases, and requires membership in `levels`. Model compatibility is a
    /// separate, DB-dependent check (`RunRoutingResolution`).
    ///
    /// `field` only names the offending input in the message — the request tier
    /// (`routing.effort`) and the agent tier (`agent_profile.effort_pref`,
    /// MOMO-625) share one normalizer so the two writers cannot drift on casing,
    /// length, or the accepted level set.
    static func normalizedLevel(_ raw: String, field: String = "routing effort") throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= maxEffortLength else {
            throw HTTPError(.badRequest, message: "\(field) is empty or too large")
        }
        let normalized = trimmed.lowercased()
        guard levels.contains(normalized) else {
            throw HTTPError(
                .badRequest,
                message: "\(field) must be one of \(levels.joined(separator: ", "))"
            )
        }
        return normalized
    }

    /// A ledger/preference token that is a known level but is not necessarily
    /// valid for a given model. Returns nil instead of throwing — used on the
    /// silent-inheritance paths where an unusable preference is ignored, not a
    /// client-visible error.
    static func knownLevel(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty, levels.contains(normalized) else { return nil }
        return normalized
    }

    static var response: ProviderEffortTableResponse {
        var byProvider: [String] = []
        var models: [String: [ProviderEffortModelDTO]] = [:]
        for entry in entries {
            if models[entry.provider] == nil {
                byProvider.append(entry.provider)
                models[entry.provider] = []
            }
            models[entry.provider]?.append(
                ProviderEffortModelDTO(
                    model: entry.model,
                    efforts: entry.efforts,
                    defaultEffort: entry.defaultEffort
                )
            )
        }
        return ProviderEffortTableResponse(
            schema: schema,
            levels: levels,
            fallback: ProviderEffortFallbackDTO(
                efforts: fallbackEfforts,
                defaultEffort: fallbackDefaultEffort
            ),
            providers: byProvider.map {
                ProviderEffortProviderDTO(provider: $0, models: models[$0] ?? [])
            }
        )
    }
}

// MARK: - DTOs

struct ProviderEffortModelDTO: ResponseEncodable, Encodable, Sendable {
    let model: String
    let efforts: [String]
    let defaultEffort: String
}

struct ProviderEffortProviderDTO: ResponseEncodable, Encodable, Sendable {
    let provider: String
    let models: [ProviderEffortModelDTO]
}

struct ProviderEffortFallbackDTO: ResponseEncodable, Encodable, Sendable {
    let efforts: [String]
    let defaultEffort: String
}

struct ProviderEffortTableResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    let levels: [String]
    let fallback: ProviderEffortFallbackDTO
    let providers: [ProviderEffortProviderDTO]
}
