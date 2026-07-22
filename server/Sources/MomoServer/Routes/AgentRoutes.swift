import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Human-admin creation surface for first-class agent members.
///
/// Creation deliberately stops at the workspace identity boundary: it does
/// not add channel memberships and does not issue a credential. Callers use
/// the existing channel-membership and agent-credential routes for those two
/// explicit follow-up decisions.
struct AgentRoutes: Sendable {
    let db: Database
    let environmentName: String
    let allowLocalLoopback: Bool

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/agents", use: create)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human workspace admin required")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: CreateAgentRequest.self, context: context)
        let displayName = try JoinRoutes.normalizedDisplayName(dto.displayName)
        guard let handle = try JoinRoutes.normalizedRequestedHandle(dto.handle) else {
            throw HTTPError(.badRequest, message: "handle is required")
        }
        let model = try Self.normalizedModel(dto.model)
        let baseURL = try Self.validatedBaseURL(
            dto.baseUrl,
            environmentName: environmentName,
            allowLocalLoopback: allowLocalLoopback
        )
        let systemPrompt = try Self.normalizedSystemPrompt(dto.systemPrompt)
        let config = try Self.validatedConfig(dto.config)
        let configJSON = try Self.jsonString(.object(config))
        let profile = try dto.profile.map(AgentProfileValidation.validate)
        let ownerHumanID = dto.ownerHumanId ?? principal.memberID

        let result: AgentCreationResult = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role?.isAdmin == true else { return .forbidden }
            let creation = try await Self.createAgentIdentity(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                displayName: displayName, handle: handle, model: model, baseURL: baseURL,
                systemPrompt: systemPrompt, configJSON: configJSON,
                ownerHumanID: ownerHumanID, auditExtraJSON: "{}"
            )
            if case .created(let agent) = creation, let profile {
                try await AgentProfileRoutes.insertInitialProfile(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    agentMemberID: agent.id, actorMemberID: principal.memberID,
                    viaTokenID: principal.tokenID, profile: profile
                )
            }
            return creation
        }

        switch result {
        case .forbidden:
            throw HTTPError(.forbidden, message: "workspace admin required")
        case .invalidOwner:
            throw HTTPError(
                .badRequest,
                message: "ownerHumanId must reference an active human in this workspace"
            )
        case .duplicateHandle:
            throw HTTPError(.conflict, message: "agent handle already exists")
        case .created(let agent):
            var response = try CreateAgentResponse(agent: agent)
                .response(from: request, context: context)
            response.status = .created
            return response
        }
    }

    static func normalizedModel(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 200 else {
            throw HTTPError(.badRequest, message: "model must contain 1...200 characters")
        }
        return value
    }

    /// Canonical first-class agent identity primitive used by local creation
    /// and administrator-confirmed remote-card onboarding.
    static func createAgentIdentity(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        displayName: String,
        handle: String,
        model: String,
        baseURL: String,
        systemPrompt: String?,
        configJSON: String,
        ownerHumanID: UUID,
        auditExtraJSON: String
    ) async throws -> AgentCreationResult {
        try await JoinRoutes.requireNotBanned(
            conn: conn, logger: logger, email: nil, handle: handle
        )
        let ownerRows = try await conn.query(
            """
            SELECT 1
              FROM member
             WHERE id = \(ownerHumanID)
               AND workspace_id = \(workspaceID)
               AND kind = 'human'
               AND status = 'active'
               AND deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard !ownerRows.isEmpty else { return .invalidOwner }

        let memberRows = try await conn.query(
            """
            INSERT INTO member (workspace_id, kind, status, display_name, handle)
            VALUES (\(workspaceID), 'agent', 'active', \(displayName), \(handle))
            ON CONFLICT (workspace_id, handle) DO NOTHING
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard let memberRow = memberRows.first else { return .duplicateHandle }
        let agentID = try memberRow.decode(UUID.self)

        _ = try await conn.query(
            """
            INSERT INTO agent
              (member_id, workspace_id, model, base_url, system_prompt,
               tool_schema, config, owner_human_id)
            VALUES
              (\(agentID), \(workspaceID), \(model), \(baseURL), \(systemPrompt),
               '[]'::jsonb, \(configJSON)::jsonb, \(ownerHumanID))
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            INSERT INTO workspace_membership (workspace_id, member_id, role)
            VALUES (\(workspaceID), \(agentID), 'member')
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), \(agentID),
               'agent.created', 'agent', \(agentID), \(viaTokenID),
               jsonb_build_object(
                 'schema', 'momo.agent.created.v1',
                 'handle', \(handle),
                 'model', \(model),
                 'endpoint_label', \(baseURL),
                 'owner_human_id', \(ownerHumanID)::text,
                 'channel_memberships_created', 0
               ) || \(auditExtraJSON)::jsonb)
            """,
            logger: logger
        )
        return .created(AgentMemberDTO(
            id: agentID, handle: handle, displayName: displayName
        ))
    }

    static func normalizedSystemPrompt(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard value.utf8.count <= 32_768 else {
            throw HTTPError(.badRequest, message: "systemPrompt must be at most 32768 bytes")
        }
        return value
    }

    static func validatedBaseURL(
        _ raw: String,
        environmentName: String,
        allowLocalLoopback: Bool
    ) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.url != nil
        else {
            throw HTTPError(
                .badRequest,
                message: "baseUrl must be an absolute HTTP(S) URL without userinfo, query, or fragment"
            )
        }

        guard scheme == "http" || scheme == "https" else {
            throw HTTPError(.badRequest, message: "baseUrl must use http:// or https://")
        }
        guard !AgentProviderConfig.isMockHost(host) else {
            throw HTTPError(.badRequest, message: "baseUrl must not target a mock provider host")
        }

        let isLoopback = AgentProviderConfig.isAllowedLoopbackHost(host)
        let strictEnvironment = AgentProviderConfig.requiresStrictExternalProvider(environmentName)
        let localLoopbackAllowed = allowLocalLoopback && !strictEnvironment && isLoopback

        if isLoopback {
            guard localLoopbackAllowed else {
                throw HTTPError(
                    .badRequest,
                    message: "loopback baseUrl requires local mode and AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1"
                )
            }
            guard components.port != nil else {
                throw HTTPError(.badRequest, message: "loopback baseUrl must include an explicit port")
            }
        } else if scheme != "https" {
            throw HTTPError(.badRequest, message: "non-loopback baseUrl must use https://")
        }

        components.scheme = scheme
        guard let normalized = components.string else {
            throw HTTPError(.badRequest, message: "baseUrl is invalid")
        }
        return normalized
    }

    static func validatedConfig(_ raw: [String: JSONValue]?) throws -> [String: JSONValue] {
        let config = raw ?? [:]
        try AgentCredentialFieldPolicy.rejectCredentialShapedFields(.object(config), path: "config")
        let data = try JSONEncoder().encode(JSONValue.object(config))
        guard data.count <= 65_536 else {
            throw HTTPError(.badRequest, message: "config must be at most 65536 bytes")
        }
        return config
    }

    private static func jsonString(_ value: JSONValue) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw HTTPError(.badRequest, message: "config must be valid JSON")
        }
        return text
    }
}

enum AgentCreationResult: Sendable {
    case created(AgentMemberDTO)
    case duplicateHandle
    case invalidOwner
    case forbidden
}

struct CreateAgentRequest: Decodable, Sendable {
    let displayName: String
    let handle: String
    let model: String
    let baseUrl: String
    let systemPrompt: String?
    let config: [String: JSONValue]?
    let ownerHumanId: UUID?
    let profile: AgentProfileInput?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case displayName
        case handle
        case model
        case baseUrl
        case systemPrompt
        case config
        case ownerHumanId
        case profile
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: AgentRequestCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        let unknown = dynamic.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: unknown.sorted().first.map(AgentRequestCodingKey.init)!,
                in: dynamic,
                debugDescription: "unknown create-agent field"
            )
        }

        let values = try decoder.container(keyedBy: CodingKeys.self)
        displayName = try values.decode(String.self, forKey: .displayName)
        handle = try values.decode(String.self, forKey: .handle)
        model = try values.decode(String.self, forKey: .model)
        baseUrl = try values.decode(String.self, forKey: .baseUrl)
        systemPrompt = try values.decodeIfPresent(String.self, forKey: .systemPrompt)
        config = try values.decodeIfPresent([String: JSONValue].self, forKey: .config)
        ownerHumanId = try values.decodeIfPresent(UUID.self, forKey: .ownerHumanId)
        profile = try values.decodeIfPresent(AgentProfileInput.self, forKey: .profile)
    }
}

private struct AgentRequestCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
    }
}

struct AgentMemberDTO: ResponseEncodable, Codable, Sendable {
    let id: UUID
    let handle: String
    let displayName: String
}

struct CreateAgentResponse: ResponseEncodable, Codable, Sendable {
    let agent: AgentMemberDTO
}
