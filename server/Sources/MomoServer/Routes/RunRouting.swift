import Foundation
import Hummingbird

/// MOMO-621 / ADR-0134 D1 — the optional per-request `routing { model?, effort? }`
/// override, shared by both surfaces that start an agent run:
///   - `POST .../agent-runs`  (work runs, MOMO-621)
///   - `POST .../messages`    (agent mentions, MOMO-625)
///
/// Both surfaces use the same validator, the same resolution chain, and the same
/// 400 rules, so a routing block can never mean two different things depending on
/// how the run happened to be triggered.
///
/// Closed-world both outside and inside: each request grows exactly one new key
/// (`routing`), and the routing object itself accepts only `model`/`effort`.
/// ADR-0134 D1 B (smuggling routing through a free-form input field) was
/// rejected precisely because it would break that contract.
///
/// Gate semantics differ by origin, and that asymmetry is the decision, not an
/// accident (ADR-0134 D1):
///   - an **explicit** `routing.model` outside the workspace allow-list, or an
///     `routing.effort` the resolved model does not accept, is a **400** — the
///     user just chose it, so the failure must be visible;
///   - an **inherited** agent-profile preference that is not usable is silently
///     ignored (the existing `model_pref` "ignored" convention, ADR-0131 D2).
struct RunRoutingInput: Equatable, Sendable {
    /// The only keys the routing object accepts. Anything else is a 400.
    static let allowedKeys = Set(["model", "effort"])
    static let maxModelLength = 200

    let model: String?
    let effort: String?

    /// Shape validation only — runs before any transaction opens (MOMO-362
    /// convention: shape errors become 4xx before the tenant tx starts).
    /// An empty/absent object inherits, so it decodes to `nil` rather than an
    /// all-nil block; that keeps the stored input JSON free of noise keys.
    static func validate(_ value: JSONValue?) throws -> RunRoutingInput? {
        guard let value else { return nil }
        if case .null = value { return nil }
        guard case .object(let object) = value else {
            throw HTTPError(.badRequest, message: "routing must be an object")
        }
        let unknownKeys = Set(object.keys).subtracting(allowedKeys)
        guard unknownKeys.isEmpty else {
            throw HTTPError(.badRequest, message: "routing contains unknown fields")
        }
        let model = try optionalToken(
            object["model"], field: "routing.model", limit: maxModelLength
        )
        let effort = try optionalToken(
            object["effort"],
            field: "routing.effort",
            limit: ProviderEffortTable.maxEffortLength
        ).map { try ProviderEffortTable.normalizedLevel($0, field: "routing.effort") }
        guard model != nil || effort != nil else { return nil }
        return RunRoutingInput(model: model, effort: effort)
    }

    /// Canonical echo written into `agent_run.input.routing`. Records what the
    /// caller asked for (not what was resolved) so the idempotency comparison
    /// stays a pure function of the request body.
    var jsonValue: JSONValue? {
        var object: [String: JSONValue] = [:]
        if let model { object["model"] = .string(model) }
        if let effort { object["effort"] = .string(effort) }
        return object.isEmpty ? nil : .object(object)
    }

    var auditObject: [String: Any] {
        var object: [String: Any] = [:]
        if let model { object["model"] = model }
        if let effort { object["effort"] = effort }
        return object
    }

    private static func optionalToken(
        _ value: JSONValue?,
        field: String,
        limit: Int
    ) throws -> String? {
        guard let value else { return nil }
        if case .null = value { return nil }
        guard let raw = value.stringValue else {
            throw HTTPError(.badRequest, message: "\(field) must be a string")
        }
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            throw HTTPError(.badRequest, message: "\(field) must not be empty")
        }
        guard normalized.utf8.count <= limit else {
            throw HTTPError(.badRequest, message: "\(field) is too large")
        }
        return normalized
    }
}

/// The resolved inheritance chain for one run (ADR-0134 D3, request tier).
///
/// `agent profile preference → request routing`. The workspace-default tier of
/// D3 has no storage yet, so its slot is the agent's own `agent.model`
/// (`baseModel`), exactly as the mention path already behaves.
struct RunRoutingResolution: Equatable, Sendable {
    let model: String
    let effort: String?
    /// Non-nil when an agent-profile preference existed but was not usable and
    /// was therefore ignored (audited, never a client error).
    let ignoredModelPref: String?
    let ignoredEffortPref: String?

    /// Runs inside the tenant transaction because the allow-list lives in
    /// `workspace.settings` and the preferences live in `agent_profile`.
    /// Throws `HTTPError(.badRequest)` for explicit-request violations.
    static func resolve(
        requested: RunRoutingInput?,
        baseModel: String,
        modelPref: String?,
        effortPref: String?,
        workspaceSettingsJSON: String
    ) throws -> RunRoutingResolution {
        let model: String
        var ignoredModelPref: String?
        if let requestedModel = requested?.model {
            // Same allow-list as ADR-0131 D2 (`allowed_agent_models` ∪ agent.model),
            // single-sourced so the two surfaces cannot drift.
            let allowed = MessageRoutes.allowedAgentModels(
                baseModel: baseModel, workspaceSettingsJSON: workspaceSettingsJSON
            )
            guard allowed.contains(requestedModel) else {
                throw HTTPError(
                    .badRequest,
                    message: "routing.model is not in workspace.settings.allowed_agent_models"
                )
            }
            model = requestedModel
        } else {
            let inherited = MessageRoutes.resolveProfileModel(
                baseModel: baseModel,
                modelPref: modelPref,
                workspaceSettingsJSON: workspaceSettingsJSON
            )
            model = inherited.model
            ignoredModelPref = inherited.ignoredPreference
        }

        let effort: String?
        var ignoredEffortPref: String?
        if let requestedEffort = requested?.effort {
            guard ProviderEffortTable.supports(model: model, effort: requestedEffort) else {
                throw HTTPError(
                    .badRequest,
                    message: "routing.effort is not supported by model \(model)"
                )
            }
            effort = requestedEffort
        } else if let preference = effortPref?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !preference.isEmpty {
            // Inherited preference: unusable → ignored (never a 400), which also
            // covers ADR-0134 D3's "model change invalidates the effort" case.
            if let normalized = ProviderEffortTable.knownLevel(preference),
               ProviderEffortTable.supports(model: model, effort: normalized) {
                effort = normalized
            } else {
                effort = nil
                ignoredEffortPref = preference
            }
        } else {
            effort = nil
        }

        return RunRoutingResolution(
            model: model,
            effort: effort,
            ignoredModelPref: ignoredModelPref,
            ignoredEffortPref: ignoredEffortPref
        )
    }
}
