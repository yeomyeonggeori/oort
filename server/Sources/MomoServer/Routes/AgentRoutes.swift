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
    private static let forbiddenConfigKeyFragments = [
        "credential", "accesstoken", "refreshtoken", "oauthtoken", "authorization",
        "clientsecret", "privatekey", "password", "bearertoken", "apikey",
        "codexaccess", "codexrefresh", "openaioauth",
    ]

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
        let ownerHumanID = dto.ownerHumanId ?? principal.memberID

        let result: AgentCreationResult = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let role = try await InviteRoutes.activeWorkspaceRole(
                conn: conn,
                logger: db.logger,
                memberID: principal.memberID
            )
            guard role == "owner" || role == "admin" else {
                return .forbidden
            }

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
                logger: db.logger
            ).collect()
            guard !ownerRows.isEmpty else { return .invalidOwner }

            let memberRows = try await conn.query(
                """
                INSERT INTO member
                  (workspace_id, kind, status, display_name, handle)
                VALUES
                  (\(workspaceID), 'agent', 'active', \(displayName), \(handle))
                ON CONFLICT (workspace_id, handle) DO NOTHING
                RETURNING id
                """,
                logger: db.logger
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
                logger: db.logger
            )

            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(agentID),
                   'agent.created', 'agent', \(agentID), \(principal.tokenID),
                   jsonb_build_object(
                     'schema', 'momo.agent.created.v1',
                     'handle', \(handle),
                     'model', \(model),
                     'endpoint_label', \(baseURL),
                     'owner_human_id', \(ownerHumanID)::text,
                     'channel_memberships_created', 0
                   ))
                """,
                logger: db.logger
            )

            return .created(AgentMemberDTO(
                id: agentID,
                handle: handle,
                displayName: displayName
            ))
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
        try rejectCredentialLikeKeys(.object(config), path: "config")
        let data = try JSONEncoder().encode(JSONValue.object(config))
        guard data.count <= 65_536 else {
            throw HTTPError(.badRequest, message: "config must be at most 65536 bytes")
        }
        return config
    }

    private static func rejectCredentialLikeKeys(_ value: JSONValue, path: String) throws {
        switch value {
        case .object(let object):
            for (key, child) in object {
                // Canonicalize snake_case, kebab-case, and camelCase to the
                // same comparison space so `apiKey` cannot bypass `api_key`.
                let normalized = key.lowercased().filter { $0.isLetter || $0.isNumber }
                if forbiddenConfigKeyFragments.contains(where: normalized.contains) {
                    throw HTTPError(
                        .badRequest,
                        message: "provider credential fields are forbidden at \(path).\(key)"
                    )
                }
                try rejectCredentialLikeKeys(child, path: "\(path).\(key)")
            }
        case .array(let values):
            for (index, child) in values.enumerated() {
                try rejectCredentialLikeKeys(child, path: "\(path)[\(index)]")
            }
        default:
            break
        }
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

private enum AgentCreationResult: Sendable {
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

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case displayName
        case handle
        case model
        case baseUrl
        case systemPrompt
        case config
        case ownerHumanId
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
