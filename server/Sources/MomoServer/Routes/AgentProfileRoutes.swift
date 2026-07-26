import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct AgentProfileRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/agents/:agent/profile", use: get)
        group.put("/v1/workspaces/:ws/agents/:agent/profile", use: put)
        group.put("/v1/workspaces/:ws/agents/:agent/pause", use: putPause)
    }

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> AgentProfileResponse {
        let principal = try context.requirePrincipal()
        let (workspaceID, agentMemberID) = try Self.scope(context, principal: principal)
        let profile = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            try await Self.requireEditor(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                agentMemberID: agentMemberID, principal: principal
            )
            return try await Self.load(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                agentMemberID: agentMemberID
            )
        }
        guard let profile else {
            throw HTTPError(.notFound, message: "agent profile not found")
        }
        return AgentProfileResponse(profile: profile)
    }

    @Sendable
    func put(_ request: Request, context: AppRequestContext) async throws -> AgentProfileResponse {
        let principal = try context.requirePrincipal()
        let (workspaceID, agentMemberID) = try Self.scope(context, principal: principal)
        let input = try AgentProfileValidation.validate(
            try await request.decode(as: AgentProfileInput.self, context: context)
        )
        let profile = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await Self.requireEditor(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                agentMemberID: agentMemberID, principal: principal, forUpdate: true
            )
            return try await Self.upsert(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                agentMemberID: agentMemberID, actorMemberID: principal.memberID,
                viaTokenID: principal.tokenID, profile: input
            )
        }
        return AgentProfileResponse(profile: profile)
    }

    @Sendable
    func putPause(_ request: Request, context: AppRequestContext) async throws -> AgentProfileResponse {
        let principal = try context.requirePrincipal()
        let (workspaceID, agentMemberID) = try Self.scope(context, principal: principal)
        let input = try await request.decode(as: AgentPauseInput.self, context: context)
        let profile = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await Self.requireEditor(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                agentMemberID: agentMemberID, principal: principal, forUpdate: true
            )
            return try await Self.setPaused(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                agentMemberID: agentMemberID, actorMemberID: principal.memberID,
                viaTokenID: principal.tokenID, paused: input.paused
            )
        }
        return AgentProfileResponse(profile: profile)
    }

    static func insertInitialProfile(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentMemberID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        profile: ValidatedAgentProfile
    ) async throws {
        _ = try await upsert(
            conn: conn, logger: logger, workspaceID: workspaceID,
            agentMemberID: agentMemberID, actorMemberID: actorMemberID,
            viaTokenID: viaTokenID, profile: profile
        )
    }

    /// ADR-0131 D2 allow-list, applied at **write** time.
    ///
    /// The runtime keeps ignoring an unusable *inherited* preference silently
    /// (`MessageRoutes.resolveProfileModel` → `ignored_model_pref`), because by
    /// then the allow-list may have changed under a profile nobody re-saved.
    /// An explicit write is a different act: the client is asserting a model for
    /// this agent right now, so a violation is a visible 400 — exactly the
    /// asymmetry ADR-0134 D1 already draws for `routing.model` on the composer
    /// path, and the sibling of the `effortPref` 400 in `AgentProfileValidation`.
    ///
    /// The judgement is delegated to `MessageRoutes.allowedAgentModels` so this
    /// surface and the request tier cannot drift into disagreeing about the same
    /// string. It lives in the route layer rather than in
    /// `AgentProfileValidation` because the allow-list is workspace state, which
    /// body validation has no access to.
    static func assertModelPrefIsAllowed(
        _ modelPref: String?,
        baseModel: String,
        workspaceSettingsJSON: String
    ) throws {
        guard let modelPref, !modelPref.isEmpty else { return }
        let allowed = MessageRoutes.allowedAgentModels(
            baseModel: baseModel, workspaceSettingsJSON: workspaceSettingsJSON
        )
        guard allowed.contains(modelPref) else {
            throw HTTPError(
                .badRequest,
                message: "modelPref is not in workspace.settings.allowed_agent_models"
            )
        }
    }

    /// The two inputs `assertModelPrefIsAllowed` needs, read inside the tenant
    /// transaction that is about to write the profile.
    private static func loadModelPolicy(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentMemberID: UUID
    ) async throws -> (baseModel: String, workspaceSettingsJSON: String) {
        let rows = try await conn.query(
            """
            SELECT a.model, w.settings::text
              FROM agent a
              JOIN workspace w ON w.id = a.workspace_id
             WHERE a.workspace_id = \(workspaceID)
               AND a.member_id = \(agentMemberID)
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.notFound, message: "agent profile target not found")
        }
        let (model, settings) = try row.decode((String, String).self)
        return (model, settings)
    }

    private static func upsert(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentMemberID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        profile: ValidatedAgentProfile
    ) async throws -> AgentProfileDTO {
        // Every profile write funnels through here (REST PUT and the agent
        // creation form alike), so the allow-list gate cannot be bypassed by
        // adding another caller. Only paid for when a preference is present.
        if let modelPref = profile.modelPref, !modelPref.isEmpty {
            let policy = try await loadModelPolicy(
                conn: conn, logger: logger,
                workspaceID: workspaceID, agentMemberID: agentMemberID
            )
            try assertModelPrefIsAllowed(
                modelPref,
                baseModel: policy.baseModel,
                workspaceSettingsJSON: policy.workspaceSettingsJSON
            )
        }
        let rows = try await conn.query(
            """
            INSERT INTO agent_profile
              (agent_member_id, workspace_id, instructions, model_pref, effort_pref,
               enabled_tools, triggers, version, updated_by, updated_at)
            VALUES
              (\(agentMemberID), \(workspaceID), \(profile.instructions),
               \(profile.modelPref), \(profile.effortPref),
               \(profile.enabledToolsJSON)::jsonb,
               \(profile.triggersJSON)::jsonb, 1, \(actorMemberID), now())
            ON CONFLICT (agent_member_id) DO UPDATE
              SET instructions = EXCLUDED.instructions,
                  model_pref = EXCLUDED.model_pref,
                  effort_pref = EXCLUDED.effort_pref,
                  enabled_tools = EXCLUDED.enabled_tools,
                  triggers = EXCLUDED.triggers,
                  version = agent_profile.version + 1,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = now()
              WHERE agent_profile.workspace_id = EXCLUDED.workspace_id
            RETURNING instructions, model_pref, effort_pref,
                      enabled_tools::text, triggers::text,
                      paused, version, updated_by, updated_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.notFound, message: "agent profile target not found")
        }
        let dto = try decode(
            row, workspaceID: workspaceID, agentMemberID: agentMemberID
        )
        let action = dto.version == 1 ? "agent.profile.created" : "agent.profile.updated"
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), \(agentMemberID), \(action),
               'agent_profile', \(agentMemberID), \(viaTokenID),
               jsonb_build_object(
                 'schema', 'momo.agent_profile.updated.v1',
                 'version', \(dto.version)::integer,
                 'enabled_tool_count', \(dto.enabledTools.count)::integer,
                 'has_model_pref', \(dto.modelPref != nil),
                 'has_effort_pref', \(dto.effortPref != nil),
                 'mention_enabled', true
               ))
            """,
            logger: logger
        )
        return dto
    }

    private static func setPaused(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentMemberID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        paused: Bool
    ) async throws -> AgentProfileDTO {
        let rows = try await conn.query(
            """
            INSERT INTO agent_profile
              (agent_member_id, workspace_id, paused, version, updated_by, updated_at)
            VALUES
              (\(agentMemberID), \(workspaceID), \(paused), 1, \(actorMemberID), now())
            ON CONFLICT (agent_member_id) DO UPDATE
              SET paused = EXCLUDED.paused,
                  version = CASE
                    WHEN agent_profile.paused IS DISTINCT FROM EXCLUDED.paused
                    THEN agent_profile.version + 1 ELSE agent_profile.version END,
                  updated_by = CASE
                    WHEN agent_profile.paused IS DISTINCT FROM EXCLUDED.paused
                    THEN EXCLUDED.updated_by ELSE agent_profile.updated_by END,
                  updated_at = CASE
                    WHEN agent_profile.paused IS DISTINCT FROM EXCLUDED.paused
                    THEN now() ELSE agent_profile.updated_at END
              WHERE agent_profile.workspace_id = EXCLUDED.workspace_id
            RETURNING instructions, model_pref, effort_pref,
                      enabled_tools::text, triggers::text,
                      paused, version, updated_by, updated_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.notFound, message: "agent profile target not found")
        }
        let dto = try decode(row, workspaceID: workspaceID, agentMemberID: agentMemberID)
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), \(agentMemberID),
               \(paused ? "agent.profile.paused" : "agent.profile.resumed"),
               'agent_profile', \(agentMemberID), \(viaTokenID),
               jsonb_build_object(
                 'schema', 'momo.agent_profile.pause.v1',
                 'paused', \(paused),
                 'version', \(dto.version)::integer
               ))
            """,
            logger: logger
        )
        return dto
    }

    private static func load(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentMemberID: UUID
    ) async throws -> AgentProfileDTO? {
        let rows = try await conn.query(
            """
            SELECT instructions, model_pref, effort_pref,
                   enabled_tools::text, triggers::text,
                   paused, version, updated_by, updated_at
              FROM agent_profile
             WHERE workspace_id = \(workspaceID)
               AND agent_member_id = \(agentMemberID)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        return try decode(row, workspaceID: workspaceID, agentMemberID: agentMemberID)
    }

    private static func decode(
        _ row: PostgresRow,
        workspaceID: UUID,
        agentMemberID: UUID
    ) throws -> AgentProfileDTO {
        let (instructions, modelPref, effortPref, enabledToolsJSON, triggersJSON, paused,
             version, updatedBy, updatedAt) = try row.decode(
                (String, String?, String?, String, String, Bool, Int, UUID, Date).self
             )
        let decoder = JSONDecoder()
        let enabledTools = try decoder.decode([String].self, from: Data(enabledToolsJSON.utf8))
        let triggers = try decoder.decode(JSONValue.self, from: Data(triggersJSON.utf8))
        return AgentProfileDTO(
            agentMemberId: agentMemberID, workspaceId: workspaceID,
            instructions: instructions, modelPref: modelPref, effortPref: effortPref,
            enabledTools: enabledTools, triggers: triggers, paused: paused, version: version,
            updatedBy: updatedBy,
            updatedAtMs: Int64(updatedAt.timeIntervalSince1970 * 1_000)
        )
    }

    private static func requireEditor(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentMemberID: UUID,
        principal: AuthPrincipal,
        forUpdate: Bool = false
    ) async throws {
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human agent owner or workspace admin required")
        }
        let role = try await WorkspaceAuthorization.activeRole(
            conn: conn, logger: logger, workspaceID: workspaceID,
            memberID: principal.memberID, forUpdate: forUpdate
        )
        guard let role else {
            throw HTTPError(.forbidden, message: "not an active workspace member")
        }
        let rows = try await conn.query(
            """
            SELECT a.owner_human_id
              FROM agent a
              JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id
             WHERE a.workspace_id = \(workspaceID)
               AND a.member_id = \(agentMemberID)
               AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.notFound, message: "active agent not found")
        }
        let ownerID = try row.decode(UUID?.self)
        guard role.isAdmin || ownerID == principal.memberID else {
            throw HTTPError(.forbidden, message: "agent owner or workspace admin required")
        }
    }

    private static func scope(
        _ context: AppRequestContext,
        principal: AuthPrincipal
    ) throws -> (UUID, UUID) {
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let raw = try context.parameters.require("agent")
        guard let agentID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid agent id")
        }
        return (workspaceID, agentID)
    }
}

/// Closed-world profile body. MOMO-625 / ADR-0134 D3 grows exactly one key,
/// `effortPref` — the agent tier of the model→effort inheritance chain and the
/// sibling of the existing `modelPref`.
struct AgentProfileInput: Decodable, Sendable {
    let instructions: String
    let modelPref: String?
    let effortPref: String?
    let enabledTools: [String]
    let triggers: JSONValue?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case instructions, modelPref, effortPref, enabledTools, triggers
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: AgentProfileCodingKey.self)
        let unknown = dynamic.allKeys.map(\.stringValue).filter {
            !Set(CodingKeys.allCases.map(\.rawValue)).contains($0)
        }
        if !unknown.isEmpty {
            let shape = JSONValue.object(Dictionary(uniqueKeysWithValues: unknown.map { ($0, .null) }))
            try AgentCredentialFieldPolicy.rejectCredentialShapedFields(shape, path: "profile")
            throw DecodingError.dataCorruptedError(
                forKey: AgentProfileCodingKey(unknown.sorted()[0]), in: dynamic,
                debugDescription: "unknown agent-profile field"
            )
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        instructions = try values.decode(String.self, forKey: .instructions)
        modelPref = try values.decodeIfPresent(String.self, forKey: .modelPref)
        effortPref = try values.decodeIfPresent(String.self, forKey: .effortPref)
        enabledTools = try values.decode([String].self, forKey: .enabledTools)
        triggers = try values.decodeIfPresent(JSONValue.self, forKey: .triggers)
    }
}

struct AgentPauseInput: Decodable, Sendable {
    let paused: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case paused
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: AgentProfileCodingKey.self)
        let unknown = dynamic.allKeys.map(\.stringValue).filter { $0 != CodingKeys.paused.rawValue }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: AgentProfileCodingKey(unknown.sorted()[0]), in: dynamic,
                debugDescription: "unknown agent-pause field"
            )
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        paused = try values.decode(Bool.self, forKey: .paused)
    }
}

enum AgentProfileValidation {
    static func validate(_ input: AgentProfileInput) throws -> ValidatedAgentProfile {
        guard input.instructions.utf8.count <= 8_192 else {
            throw HTTPError(.badRequest, message: "instructions must be at most 8192 bytes")
        }
        let modelPref = input.modelPref?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let modelPref, modelPref.isEmpty || modelPref.count > 200 {
            throw HTTPError(.badRequest, message: "modelPref must contain 1...200 characters")
        }
        let effortPref = try normalizedEffortPref(input.effortPref, modelPref: modelPref)
        guard input.enabledTools.count <= 128 else {
            throw HTTPError(.badRequest, message: "enabledTools must contain at most 128 entries")
        }
        let enabledTools = input.enabledTools.map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard enabledTools.allSatisfy({ !$0.isEmpty && $0.count <= 200 }),
              Set(enabledTools).count == enabledTools.count
        else {
            throw HTTPError(.badRequest, message: "enabledTools entries must be unique non-empty names")
        }

        let triggers = input.triggers ?? .object(["mention": .bool(true)])
        guard case .object(let object) = triggers,
              object["mention"] == .bool(true),
              Set(object.keys).isSubset(of: ["mention", "schedule"])
        else {
            throw HTTPError(.badRequest, message: "triggers must contain mention=true and only optional schedule")
        }
        try AgentCredentialFieldPolicy.rejectCredentialShapedFields(triggers, path: "profile.triggers")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let toolData = try encoder.encode(enabledTools)
        let triggerData = try encoder.encode(triggers)
        guard triggerData.count <= 8_192 else {
            throw HTTPError(.badRequest, message: "triggers must be at most 8192 bytes")
        }
        return ValidatedAgentProfile(
            instructions: input.instructions, modelPref: modelPref, effortPref: effortPref,
            enabledTools: enabledTools,
            enabledToolsJSON: String(decoding: toolData, as: UTF8.self),
            triggersJSON: String(decoding: triggerData, as: UTF8.self)
        )
    }

    /// MOMO-625 / ADR-0134 D3 — the agent tier of the effort chain.
    ///
    /// Writing a preference is an explicit choice, so an unusable one is a
    /// visible **400** here. That is the same asymmetry ADR-0134 D1 draws for the
    /// request tier, and it does not contradict the runtime rule: once stored, a
    /// preference that the *resolved* model cannot honour is still silently
    /// ignored (`RunRoutingResolution.ignoredEffortPref`), because by then the
    /// model may have been changed by the workspace allow-list or by a per-request
    /// `routing` override.
    ///
    /// How much can be checked depends on what the body itself pins down:
    ///   - `modelPref` present → the model is determined for this profile, so the
    ///     provider×model effort table applies (`hermes-fast` + `max` is a 400);
    ///   - `modelPref` absent → the resolved model is only knowable at run time,
    ///     so only the canonical level set is enforced.
    /// The 32-byte ceiling mirrors migration 041's `agent_profile_effort_pref_ck`,
    /// so an over-long value is a 400 instead of a constraint violation 500.
    static func normalizedEffortPref(_ raw: String?, modelPref: String?) throws -> String? {
        guard let raw else { return nil }
        let level = try ProviderEffortTable.normalizedLevel(raw, field: "effortPref")
        if let modelPref, !ProviderEffortTable.supports(model: modelPref, effort: level) {
            throw HTTPError(
                .badRequest,
                message: "effortPref '\(level)' is not supported by modelPref '\(modelPref)'"
            )
        }
        return level
    }
}

struct ValidatedAgentProfile: Sendable {
    let instructions: String
    let modelPref: String?
    let effortPref: String?
    let enabledTools: [String]
    let enabledToolsJSON: String
    let triggersJSON: String
}

struct AgentProfileDTO: ResponseEncodable, Codable, Sendable {
    let agentMemberId: UUID
    let workspaceId: UUID
    let instructions: String
    let modelPref: String?
    /// ADR-0134 D3 agent-tier effort preference (MOMO-625). Absent = inherit.
    let effortPref: String?
    let enabledTools: [String]
    let triggers: JSONValue
    let paused: Bool
    let version: Int
    let updatedBy: UUID
    let updatedAtMs: Int64
}

struct AgentProfileResponse: ResponseEncodable, Codable, Sendable {
    let profile: AgentProfileDTO
}

private struct AgentProfileCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil
    init(_ stringValue: String) { self.stringValue = stringValue }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { self.stringValue = String(intValue) }
}
