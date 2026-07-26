import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

/// MOMO-621 / ADR-0134 D1·D2·D3 — request-level `routing { model, effort }`.
///
/// Everything here is pure unit (no DB): the closed-world request/routing shape,
/// the provider×model effort table, the allow-list + model×effort 400 gates, the
/// silent-inheritance fallbacks, and the usage-ledger effort precedence.
///
/// The live HTTP/SQL side (201 with the resolved model+effort on the agent_job
/// payload, 400s over real requests, `usage_ledger.effort` written by the gateway
/// completion callback, migration 041 columns + FORCE RLS) is exercised by
/// `scripts/verify_run_routing.sh` against compose PG18 + MomoServer.
final class RunRoutingTests: XCTestCase {
    // MARK: - routing block shape (closed-world, ADR-0134 D1)

    func testRoutingAcceptsModelAndEffort() throws {
        let routing = try RunRoutingInput.validate(.object([
            "model": .string("  hermes-fast  "),
            "effort": .string("  HIGH  "),
        ]))
        XCTAssertEqual(routing?.model, "hermes-fast")
        // The effort token is canonicalized to lowercase so the ledger and the
        // table can never disagree on casing.
        XCTAssertEqual(routing?.effort, "high")
    }

    func testAbsentOrEmptyRoutingInherits() throws {
        XCTAssertNil(try RunRoutingInput.validate(nil))
        XCTAssertNil(try RunRoutingInput.validate(.null))
        XCTAssertNil(try RunRoutingInput.validate(.object([:])))
        // Explicit nulls are "inherit", not "unknown field".
        XCTAssertNil(try RunRoutingInput.validate(.object([
            "model": .null, "effort": .null,
        ])))
    }

    func testRoutingRejectsUnknownFieldsAndBadShapesWith400() {
        let invalid: [JSONValue] = [
            .object(["provider": .string("openai")]),
            .object(["model": .string("hermes-fast"), "api_key": .string("sk-leak")]),
            .object(["model": .string("hermes-fast"), "thinking": .string("high")]),
            .object(["model": .bool(true)]),
            .object(["effort": .int(3)]),
            .object(["model": .string("   ")]),
            .object(["effort": .string("   ")]),
            .object(["model": .string(String(repeating: "m", count: 201))]),
            .array([]),
            .string("high"),
        ]
        for value in invalid {
            XCTAssertThrowsError(try RunRoutingInput.validate(value), "\(value)") { error in
                XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
            }
        }
    }

    func testRoutingRejectsEffortOutsideTheCanonicalLevels() {
        for bogus in ["ultra", "MAXIMUM", "none", "reasoning", "1"] {
            XCTAssertThrowsError(
                try RunRoutingInput.validate(.object(["effort": .string(bogus)])),
                "unknown effort '\(bogus)' must be a 400"
            ) { error in
                XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
            }
        }
    }

    // MARK: - Request body (closed-world outside too)

    func testCreateRequestDecodesTopLevelRoutingWithBothCasings() throws {
        let camel = try JSONDecoder().decode(
            CreateAgentRunRequest.self,
            from: Data("""
            {
              "agentMemberId": "00000000-0000-7000-8000-000000000103",
              "clientRunId": "00000000-0000-7000-8000-000000000621",
              "input": {"type":"work","title":"T","brief":"B"},
              "routing": {"model":"hermes-fast","effort":"low"}
            }
            """.utf8)
        )
        let snake = try JSONDecoder().decode(
            CreateAgentRunRequest.self,
            from: Data("""
            {
              "agent_member_id": "00000000-0000-7000-8000-000000000103",
              "client_run_id": "00000000-0000-7000-8000-000000000621",
              "input": {"type":"work","title":"T","brief":"B"},
              "routing": {"model":"hermes-fast","effort":"low"}
            }
            """.utf8)
        )
        XCTAssertEqual(camel.agentMemberId, snake.agentMemberId)
        let routing = try RunRoutingInput.validate(camel.routing)
        XCTAssertEqual(routing?.model, "hermes-fast")
        XCTAssertEqual(routing?.effort, "low")
    }

    func testCreateRequestWithoutRoutingStaysCompatible() throws {
        let dto = try JSONDecoder().decode(
            CreateAgentRunRequest.self,
            from: Data("""
            {
              "agentMemberId": "00000000-0000-7000-8000-000000000103",
              "clientRunId": "00000000-0000-7000-8000-000000000621",
              "input": {"type":"work","title":"T","brief":"B"}
            }
            """.utf8)
        )
        XCTAssertNil(dto.routing)
        XCTAssertNil(try RunRoutingInput.validate(dto.routing))
    }

    /// `routing` is the ONLY key the request grew (ADR-0134 D1).
    func testCreateRequestRejectsUnknownTopLevelFields() {
        let bodies = [
            #"{"agentMemberId":"00000000-0000-7000-8000-000000000103","clientRunId":"00000000-0000-7000-8000-000000000621","input":{"type":"work","title":"T","brief":"B"},"model":"hermes-fast"}"#,
            #"{"agentMemberId":"00000000-0000-7000-8000-000000000103","clientRunId":"00000000-0000-7000-8000-000000000621","input":{"type":"work","title":"T","brief":"B"},"effort":"max"}"#,
            #"{"agentMemberId":"00000000-0000-7000-8000-000000000103","clientRunId":"00000000-0000-7000-8000-000000000621","input":{"type":"work","title":"T","brief":"B"},"apiKey":"sk-leak"}"#,
        ]
        for body in bodies {
            XCTAssertThrowsError(
                try JSONDecoder().decode(CreateAgentRunRequest.self, from: Data(body.utf8)),
                "closed-world body must reject: \(body)"
            )
        }
        XCTAssertEqual(
            CreateAgentRunRequest.allowedKeys.subtracting([
                "agentMemberId", "agent_member_id", "clientRunId", "client_run_id", "input",
            ]),
            ["routing"]
        )
    }

    // MARK: - input.routing (allowedKeys gained exactly `routing`)

    func testWorkInputAllowedKeysGainedOnlyRouting() {
        XCTAssertEqual(
            WorkRunInput.allowedKeys.subtracting(["type", "title", "brief", "repo", "branch"]),
            ["routing"]
        )
    }

    func testWorkInputAcceptsAndEchoesRouting() throws {
        let work = try WorkRunInput.require(.object([
            "type": .string("work"),
            "title": .string("Prepare release"),
            "brief": .string("Build and open a PR."),
            "routing": .object(["model": .string("hermes-fast"), "effort": .string("low")]),
        ]))
        XCTAssertEqual(work.routing?.model, "hermes-fast")
        XCTAssertEqual(work.routing?.effort, "low")
        // The stored input echoes the REQUESTED routing, so the idempotency
        // comparison stays a pure function of the request body.
        let echoed = work.jsonValue.objectValue?["routing"]?.objectValue
        XCTAssertEqual(echoed?["model"]?.stringValue, "hermes-fast")
        XCTAssertEqual(echoed?["effort"]?.stringValue, "low")
    }

    func testWorkInputWithoutRoutingOmitsTheKeyEntirely() throws {
        let work = try WorkRunInput.require(.object([
            "type": .string("work"),
            "title": .string("T"),
            "brief": .string("B"),
        ]))
        XCTAssertNil(work.routing)
        XCTAssertFalse(work.jsonValue.objectValue?.keys.contains("routing") ?? true)
    }

    func testUnknownRoutingSubfieldInsideInputIsStillA400() {
        XCTAssertThrowsError(try WorkRunInput.require(.object([
            "type": .string("work"),
            "title": .string("T"),
            "brief": .string("B"),
            "routing": .object(["model": .string("hermes-fast"), "temperature": .double(0.7)]),
        ]))) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }
    }

    func testTopLevelAndInputRoutingMustAgree() throws {
        let base = try WorkRunInput.require(.object([
            "type": .string("work"),
            "title": .string("T"),
            "brief": .string("B"),
            "routing": .object(["model": .string("hermes-fast")]),
        ]))
        let same = RunRoutingInput(model: "hermes-fast", effort: nil)
        XCTAssertEqual(try base.adoptingRequestRouting(same).routing, same)

        let different = RunRoutingInput(model: "hermes-lite", effort: nil)
        XCTAssertThrowsError(try base.adoptingRequestRouting(different)) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }

        // Top-level only: adopted verbatim.
        let bare = try WorkRunInput.require(.object([
            "type": .string("work"), "title": .string("T"), "brief": .string("B"),
        ]))
        XCTAssertEqual(try bare.adoptingRequestRouting(different).routing, different)
        XCTAssertNil(try bare.adoptingRequestRouting(nil).routing)
    }

    // MARK: - Provider × model effort table (ADR-0134 D2)

    func testEffortTableExposesPerModelSupport() {
        XCTAssertEqual(ProviderEffortTable.levels, ["low", "medium", "high", "xhigh", "max"])
        // xhigh/max support differs per model — the whole reason the table exists.
        XCTAssertTrue(ProviderEffortTable.supports(model: "hermes-agent", effort: "max"))
        XCTAssertFalse(ProviderEffortTable.supports(model: "hermes-fast", effort: "high"))
        XCTAssertFalse(ProviderEffortTable.supports(model: "hermes-lite", effort: "xhigh"))
        XCTAssertTrue(ProviderEffortTable.supports(model: "hermes-fast", effort: "low"))
    }

    func testUnknownModelFallsBackToTheConservativeTriple() {
        XCTAssertEqual(
            ProviderEffortTable.supportedEfforts(model: "some-future-model"),
            ["low", "medium", "high"]
        )
        XCTAssertFalse(ProviderEffortTable.supports(model: "some-future-model", effort: "max"))
        XCTAssertEqual(ProviderEffortTable.defaultEffort(model: "some-future-model"), "medium")
    }

    func testEveryTableEntryIsSelfConsistent() {
        for entry in ProviderEffortTable.entries {
            XCTAssertFalse(entry.efforts.isEmpty, entry.model)
            XCTAssertTrue(
                entry.efforts.allSatisfy(ProviderEffortTable.levels.contains),
                "\(entry.model) exposes a level outside the canonical set"
            )
            XCTAssertTrue(
                entry.efforts.contains(entry.defaultEffort),
                "\(entry.model) default is not one of its own levels"
            )
        }
        XCTAssertTrue(
            ProviderEffortTable.fallbackEfforts.contains(ProviderEffortTable.fallbackDefaultEffort)
        )
    }

    func testEffortTableResponseShape() throws {
        let data = try JSONEncoder().encode(ProviderEffortTable.response)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(json?["schema"] as? String, "momo.provider.effort_table.v0")
        XCTAssertEqual(json?["levels"] as? [String], ProviderEffortTable.levels)
        let providers = json?["providers"] as? [[String: Any]]
        XCTAssertEqual(providers?.count, 1)
        XCTAssertEqual(providers?.first?["provider"] as? String, "hermes")
        let models = providers?.first?["models"] as? [[String: Any]]
        XCTAssertEqual(models?.count, ProviderEffortTable.entries.count)
        XCTAssertEqual(models?.first?["model"] as? String, "hermes-agent")
        XCTAssertEqual(models?.first?["efforts"] as? [String], ProviderEffortTable.levels)
        let fallback = json?["fallback"] as? [String: Any]
        XCTAssertEqual(fallback?["efforts"] as? [String], ["low", "medium", "high"])
        XCTAssertEqual(fallback?["defaultEffort"] as? String, "medium")
        // ADR-0004: the table is a capability list, never a credential surface.
        XCTAssertEqual(
            Set(json.map { Array($0.keys) } ?? []),
            ["schema", "levels", "fallback", "providers"]
        )
    }

    // MARK: - Explicit routing is gated with 400 (ADR-0134 D1)

    private static let allowlist = #"{"allowed_agent_models":["hermes-fast","hermes-lite"]}"#

    func testExplicitModelMustBeInTheWorkspaceAllowlist() throws {
        let allowed = try RunRoutingResolution.resolve(
            requested: RunRoutingInput(model: "hermes-fast", effort: nil),
            baseModel: "hermes-agent", modelPref: nil, effortPref: nil,
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertEqual(allowed.model, "hermes-fast")
        XCTAssertNil(allowed.ignoredModelPref)

        // The agent's own model is always inside the allow-list (ADR-0131 D2).
        let ownModel = try RunRoutingResolution.resolve(
            requested: RunRoutingInput(model: "hermes-agent", effort: nil),
            baseModel: "hermes-agent", modelPref: nil, effortPref: nil,
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertEqual(ownModel.model, "hermes-agent")

        XCTAssertThrowsError(try RunRoutingResolution.resolve(
            requested: RunRoutingInput(model: "external-premium", effort: nil),
            baseModel: "hermes-agent", modelPref: nil, effortPref: nil,
            workspaceSettingsJSON: Self.allowlist
        )) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }
    }

    func testExplicitEffortMustBeSupportedByTheResolvedModel() throws {
        // hermes-fast tops out at medium, so `high` is a visible failure — even
        // though `high` is a perfectly valid level for other models.
        XCTAssertThrowsError(try RunRoutingResolution.resolve(
            requested: RunRoutingInput(model: "hermes-fast", effort: "high"),
            baseModel: "hermes-agent", modelPref: nil, effortPref: nil,
            workspaceSettingsJSON: Self.allowlist
        )) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }

        let ok = try RunRoutingResolution.resolve(
            requested: RunRoutingInput(model: nil, effort: "max"),
            baseModel: "hermes-agent", modelPref: nil, effortPref: nil,
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertEqual(ok.model, "hermes-agent")
        XCTAssertEqual(ok.effort, "max")
    }

    /// The effort gate is evaluated against the model the request itself chose,
    /// not the agent's base model.
    func testEffortIsGatedAgainstTheRequestedModelNotTheBaseModel() {
        XCTAssertThrowsError(try RunRoutingResolution.resolve(
            requested: RunRoutingInput(model: "hermes-lite", effort: "max"),
            baseModel: "hermes-agent", modelPref: nil, effortPref: nil,
            workspaceSettingsJSON: Self.allowlist
        )) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }
    }

    // MARK: - Inheritance is silent (ADR-0134 D3)

    func testAbsentRoutingInheritsAgentPreferences() throws {
        let inherited = try RunRoutingResolution.resolve(
            requested: nil,
            baseModel: "hermes-agent", modelPref: "hermes-fast", effortPref: "low",
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertEqual(inherited.model, "hermes-fast")
        XCTAssertEqual(inherited.effort, "low")
        XCTAssertNil(inherited.ignoredModelPref)
        XCTAssertNil(inherited.ignoredEffortPref)
    }

    func testNoPreferencesAtAllResolvesToTheAgentModelAndNoEffort() throws {
        let bare = try RunRoutingResolution.resolve(
            requested: nil,
            baseModel: "hermes-agent", modelPref: nil, effortPref: nil,
            workspaceSettingsJSON: "{}"
        )
        XCTAssertEqual(bare.model, "hermes-agent")
        XCTAssertNil(bare.effort)
    }

    func testUnusablePreferencesAreIgnoredNotRejected() throws {
        // Disallowed model_pref: existing ADR-0131 D2 "ignored" contract.
        let ignoredModel = try RunRoutingResolution.resolve(
            requested: nil,
            baseModel: "hermes-agent", modelPref: "external-premium", effortPref: nil,
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertEqual(ignoredModel.model, "hermes-agent")
        XCTAssertEqual(ignoredModel.ignoredModelPref, "external-premium")

        // effort_pref that the resolved model cannot honour → dropped, no 400.
        // This is also ADR-0134 D3's "model change invalidates the effort" case.
        let ignoredEffort = try RunRoutingResolution.resolve(
            requested: nil,
            baseModel: "hermes-agent", modelPref: "hermes-fast", effortPref: "max",
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertEqual(ignoredEffort.model, "hermes-fast")
        XCTAssertNil(ignoredEffort.effort)
        XCTAssertEqual(ignoredEffort.ignoredEffortPref, "max")

        // Garbage preference: also ignored, never surfaced as a client error.
        let garbage = try RunRoutingResolution.resolve(
            requested: nil,
            baseModel: "hermes-agent", modelPref: nil, effortPref: "ultra",
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertNil(garbage.effort)
        XCTAssertEqual(garbage.ignoredEffortPref, "ultra")
    }

    func testRequestRoutingOverridesTheAgentPreference() throws {
        let overridden = try RunRoutingResolution.resolve(
            requested: RunRoutingInput(model: "hermes-lite", effort: "medium"),
            baseModel: "hermes-agent", modelPref: "hermes-fast", effortPref: "low",
            workspaceSettingsJSON: Self.allowlist
        )
        XCTAssertEqual(overridden.model, "hermes-lite")
        XCTAssertEqual(overridden.effort, "medium")
        XCTAssertNil(overridden.ignoredModelPref)
        XCTAssertNil(overridden.ignoredEffortPref)
    }

    // MARK: - usage_ledger.effort precedence (ADR-0134 D2)

    func testLedgerEffortPrefersTheAdapterReport() {
        XCTAssertEqual(
            AgentGatewayRoutes.ledgerEffort(
                reported: "High", requested: "low", profilePreference: "medium",
                model: "hermes-agent"
            ),
            "high"
        )
        // The provider is the authority on what it actually ran, so a reported
        // level is kept even when this server's table would not offer it.
        XCTAssertEqual(
            AgentGatewayRoutes.ledgerEffort(
                reported: "max", requested: nil, profilePreference: nil,
                model: "hermes-fast"
            ),
            "max"
        )
    }

    func testLedgerEffortFallsBackThroughRequestThenProfile() {
        XCTAssertEqual(
            AgentGatewayRoutes.ledgerEffort(
                reported: nil, requested: "xhigh", profilePreference: "low",
                model: "hermes-agent"
            ),
            "xhigh"
        )
        XCTAssertEqual(
            AgentGatewayRoutes.ledgerEffort(
                reported: nil, requested: nil, profilePreference: "medium",
                model: "hermes-agent"
            ),
            "medium"
        )
    }

    func testLedgerEffortDropsInferencesTheModelCannotSupport() {
        // An inferred value the model does not accept must not be recorded as if
        // it had been used — NULL is the honest answer.
        XCTAssertNil(AgentGatewayRoutes.ledgerEffort(
            reported: nil, requested: nil, profilePreference: "max", model: "hermes-fast"
        ))
        XCTAssertNil(AgentGatewayRoutes.ledgerEffort(
            reported: nil, requested: "ultra", profilePreference: nil, model: "hermes-agent"
        ))
        XCTAssertNil(AgentGatewayRoutes.ledgerEffort(
            reported: "  ", requested: nil, profilePreference: nil, model: "hermes-agent"
        ))
        XCTAssertNil(AgentGatewayRoutes.ledgerEffort(
            reported: nil, requested: nil, profilePreference: nil, model: "hermes-agent"
        ))
    }

    func testGatewayUsageDecodesTheOptionalEffortField() throws {
        let withEffort = try JSONDecoder().decode(
            AgentGatewayUsage.self,
            from: Data(#"{"model":"hermes-agent","effort":"high","prompt_tokens":10}"#.utf8)
        )
        XCTAssertEqual(withEffort.effort, "high")
        XCTAssertEqual(withEffort.asObject()["effort"] as? String, "high")

        // Additive: an adapter that never learned about the axis still decodes.
        let legacy = try JSONDecoder().decode(
            AgentGatewayUsage.self,
            from: Data(#"{"model":"hermes-agent","prompt_tokens":10}"#.utf8)
        )
        XCTAssertNil(legacy.effort)
    }
}
