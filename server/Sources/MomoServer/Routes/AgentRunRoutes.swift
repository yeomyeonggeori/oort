import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Work-v0 creation and read projections over the existing `agent_run` table.
///
///   POST /v1/workspaces/{ws}/channels/{ch}/agent-runs
///   GET  /v1/workspaces/{ws}/channels/{ch}/agent-runs?type=work
///   GET  /v1/workspaces/{ws}/agent-runs/{run}
///
/// Work input is validated before a tenant transaction starts. The server only
/// records and dispatches the run; execution remains on the BYOA gateway host.
struct AgentRunRoutes: Sendable {
    let db: Database
    let agentGateway: AgentGatewayConfig

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/channels/:ch/agent-runs", use: create)
        group.get("/v1/workspaces/:ws/channels/:ch/agent-runs", use: list)
        group.get("/v1/workspaces/:ws/agent-runs/:run", use: detail)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanPrincipal(context)
        let (workspaceID, channelID) = try Self.channelScope(
            context,
            principal: principal
        )
        let requestDTO = try await request.decode(
            as: CreateAgentRunRequest.self,
            context: context
        )

        // MOMO-362: shape errors must become 4xx before opening a transaction.
        let workInput = try WorkRunInput.require(requestDTO.input)
        let inputJSON = try Self.encodeJSON(workInput.jsonValue)
        guard agentGateway.enabled else {
            throw HTTPError(
                .conflict,
                message: "work runs require an enabled BYOA agent gateway"
            )
        }

        let idempotencyKey = Self.idempotencyKey(
            channelID: channelID,
            actorMemberID: principal.memberID,
            agentMemberID: requestDTO.agentMemberId,
            clientRunID: requestDTO.clientRunId
        )
        let result = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard try await Self.hasActiveHumanMembership(
                conn: conn,
                logger: db.logger,
                channelID: channelID,
                memberID: principal.memberID
            ) else {
                return WorkRunCreationResult.forbidden
            }

            if let existing = try await Self.fetchRun(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                idempotencyKey: idempotencyKey
            ) {
                guard existing.channelId == channelID.uuidString,
                      existing.agentMemberId == requestDTO.agentMemberId.uuidString,
                      existing.input == workInput.jsonValue
                else {
                    return WorkRunCreationResult.idempotencyConflict
                }
                return WorkRunCreationResult.ready(run: existing, created: false)
            }

            guard let agent = try await Self.fetchEligibleAgent(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: channelID,
                agentMemberID: requestDTO.agentMemberId
            ) else {
                return WorkRunCreationResult.agentNotFound
            }
            guard agent.activeRuns < agent.maxConcurrentRuns else {
                return WorkRunCreationResult.concurrencyLimit
            }

            let rows = try await conn.query(
                """
                INSERT INTO agent_run
                  (workspace_id, agent_member_id, channel_id, status,
                   step_count, max_steps, depth, input, idempotency_key)
                VALUES
                  (\(workspaceID), \(requestDTO.agentMemberId), \(channelID), 'queued',
                   0, \(agent.maxRunSteps), 0, \(inputJSON)::jsonb, \(idempotencyKey))
                ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard let runID = try rows.first?.decode(UUID.self) else {
                guard let existing = try await Self.fetchRun(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    idempotencyKey: idempotencyKey
                ) else {
                    throw HTTPError(.internalServerError, message: "work run insert failed")
                }
                guard existing.channelId == channelID.uuidString,
                      existing.agentMemberId == requestDTO.agentMemberId.uuidString,
                      existing.input == workInput.jsonValue
                else {
                    return WorkRunCreationResult.idempotencyConflict
                }
                return WorkRunCreationResult.ready(run: existing, created: false)
            }

            let createdAtMs = Int64(Date().timeIntervalSince1970 * 1_000)
            let jobPayload = Self.workJobPayload(
                workspaceID: workspaceID,
                channelID: channelID,
                actorMemberID: principal.memberID,
                agentMemberID: requestDTO.agentMemberId,
                runID: runID,
                model: agent.model,
                input: workInput,
                idempotencyKey: idempotencyKey,
                createdAtMs: createdAtMs
            )
            let jobRows = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, status, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'agent_job', 'pending', 'gateway',
                   \(jobPayload)::jsonb, \(requestDTO.agentMemberId))
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard let jobID = try jobRows.first?.decode(Int64.self) else {
                throw HTTPError(.internalServerError, message: "work gateway job insert failed")
            }

            let wakePayload = Self.agentJobBroadcastPayload(
                workspaceID: workspaceID,
                agentMemberID: requestDTO.agentMemberId,
                jobID: jobID,
                runID: runID,
                payloadJSON: jobPayload,
                createdAtMs: createdAtMs
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, status, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'pending', 'publish',
                   \(wakePayload)::jsonb, \(requestDTO.agentMemberId))
                """,
                logger: db.logger
            )

            let auditDetail = Self.jsonString([
                "schema": "momo.agent_work.queued.v0",
                "run_id": runID.uuidString,
                "channel_id": channelID.uuidString,
                "agent_member_id": requestDTO.agentMemberId.uuidString,
                "client_run_id": requestDTO.clientRunId.uuidString,
                "input": Self.anyValue(workInput.jsonValue),
            ])
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, run_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(requestDTO.agentMemberId),
                   'agent.work.queued', 'agent_run', \(runID),
                   \(principal.tokenID), \(runID), \(auditDetail)::jsonb)
                """,
                logger: db.logger
            )

            guard let run = try await Self.fetchRun(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID
            ) else {
                throw HTTPError(.internalServerError, message: "created work run is unavailable")
            }
            return WorkRunCreationResult.ready(run: run, created: true)
        }

        switch result {
        case .forbidden:
            throw HTTPError(.forbidden, message: "not an active human channel member")
        case .agentNotFound:
            throw HTTPError(.notFound, message: "active channel agent not found")
        case .concurrencyLimit:
            throw HTTPError(.conflict, message: "agent concurrent run limit reached")
        case .idempotencyConflict:
            throw HTTPError(.conflict, message: "client_run_id idempotency conflict")
        case .ready(let run, let created):
            var response = try run.response(from: request, context: context)
            response.status = created ? .created : .ok
            return response
        }
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let (workspaceID, channelID) = try Self.channelScope(
            context,
            principal: principal
        )
        let requestedType = request.uri.queryParameters["type"].map(String.init) ?? "work"
        guard requestedType == "work" else {
            throw HTTPError(.badRequest, message: "only type=work is supported")
        }
        let limit = Self.validatedLimit(request.uri.queryParameters["limit"].map(String.init))

        let result: (isMember: Bool, runs: [AgentRunDTO]) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let isMember = try await Self.hasActiveMembership(
                conn: conn,
                logger: db.logger,
                channelID: channelID,
                memberID: principal.memberID
            )
            guard isMember else { return (false, []) }

            let rows = try await conn.query(
                """
                SELECT \(unescaped: Self.runProjectionSQL(alias: "r"))
                  FROM agent_run r
                 WHERE r.workspace_id = \(workspaceID)
                   AND r.channel_id = \(channelID)
                   AND r.input->>'type' = 'work'
                   AND (\(principal.kind.rawValue) <> 'agent'
                        OR r.agent_member_id = \(principal.memberID))
                 ORDER BY r.created_at DESC, r.id DESC
                 LIMIT \(limit)
                """,
                logger: db.logger
            ).collect()
            return (true, try rows.map(Self.decodeRun))
        }
        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not an active channel member")
        }
        return try AgentRunPageDTO(runs: result.runs).response(from: request, context: context)
    }

    @Sendable
    func detail(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceScope(context, principal: principal)
        let runID = try Self.runID(context)

        let row: (run: AgentRunDTO, hasChannelMembership: Bool)? = try await db
            .withTenantConnection(workspaceID: workspaceID) { conn in
                let rows = try await conn.query(
                    """
                    SELECT \(unescaped: Self.runProjectionSQL(alias: "r")),
                           EXISTS (
                             SELECT 1
                               FROM membership ms
                              WHERE ms.workspace_id = \(workspaceID)
                                AND ms.channel_id = r.channel_id
                                AND ms.member_id = \(principal.memberID)
                                AND ms.left_at IS NULL
                           ) AS has_channel_membership
                      FROM agent_run r
                     WHERE r.id = \(runID)
                       AND r.workspace_id = \(workspaceID)
                       AND r.input->>'type' = 'work'
                     LIMIT 1
                    """,
                    logger: db.logger
                ).collect()
                guard let first = rows.first else { return nil }
                let (json, hasMembership) = try first.decode((String, Bool).self)
                return (try Self.decodeRun(json), hasMembership)
            }
        guard let row else {
            throw HTTPError(.notFound, message: "work run not found")
        }
        guard Self.canReadRun(
            principalKind: principal.kind,
            principalMemberID: principal.memberID,
            runAgentMemberID: UUID(uuidString: row.run.agentMemberId),
            hasChannelMembership: row.hasChannelMembership
        ) else {
            throw HTTPError(.forbidden, message: "work run is not bound to this actor")
        }
        return try row.run.response(from: request, context: context)
    }

    static func validatedLimit(_ raw: String?) -> Int {
        min(max(raw.flatMap(Int.init) ?? 50, 1), 200)
    }

    static func canReadRun(
        principalKind: AuthPrincipalKind,
        principalMemberID: UUID,
        runAgentMemberID: UUID?,
        hasChannelMembership: Bool
    ) -> Bool {
        guard hasChannelMembership else { return false }
        switch principalKind {
        case .human:
            return true
        case .agent:
            return runAgentMemberID == principalMemberID
        }
    }

    private static func requireHumanPrincipal(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human member required to create work runs")
        }
        return principal
    }

    private static func fetchEligibleAgent(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        agentMemberID: UUID
    ) async throws -> EligibleWorkAgent? {
        let rows = try await conn.query(
            """
            SELECT a.model, a.max_run_steps, a.max_concurrent_runs,
                   (
                     SELECT count(*)::int
                       FROM agent_run active
                      WHERE active.workspace_id = \(workspaceID)
                        AND active.agent_member_id = \(agentMemberID)
                        AND active.status IN
                            ('queued','running','awaiting_approval','paused')
                   ) AS active_runs
              FROM member m
              JOIN agent a
                ON a.member_id = m.id
               AND a.workspace_id = m.workspace_id
              JOIN membership ms
                ON ms.workspace_id = m.workspace_id
               AND ms.channel_id = \(channelID)
               AND ms.member_id = m.id
               AND ms.left_at IS NULL
             WHERE m.id = \(agentMemberID)
               AND m.workspace_id = \(workspaceID)
               AND m.kind = 'agent'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             LIMIT 1
             FOR UPDATE OF a
            """,
            logger: logger
        ).collect()
        guard let first = rows.first else { return nil }
        let (model, maxRunSteps, maxConcurrentRuns, activeRuns) = try first.decode(
            (String, Int, Int, Int).self
        )
        return EligibleWorkAgent(
            model: model,
            maxRunSteps: maxRunSteps,
            maxConcurrentRuns: maxConcurrentRuns,
            activeRuns: activeRuns
        )
    }

    private static func hasActiveHumanMembership(
        conn: PostgresConnection,
        logger: Logger,
        channelID: UUID,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member m
              JOIN membership ms
                ON ms.workspace_id = m.workspace_id
               AND ms.member_id = m.id
               AND ms.channel_id = \(channelID)
               AND ms.left_at IS NULL
             WHERE m.id = \(memberID)
               AND m.kind = 'human'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func hasActiveMembership(
        conn: PostgresConnection,
        logger: Logger,
        channelID: UUID,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member m
              JOIN membership ms
                ON ms.workspace_id = m.workspace_id
               AND ms.member_id = m.id
               AND ms.channel_id = \(channelID)
               AND ms.left_at IS NULL
             WHERE m.id = \(memberID)
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func fetchRun(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        runID: UUID? = nil,
        idempotencyKey: String? = nil
    ) async throws -> AgentRunDTO? {
        let rows: [PostgresRow]
        if let runID {
            rows = try await conn.query(
                """
                SELECT \(unescaped: runProjectionSQL(alias: "r"))
                  FROM agent_run r
                 WHERE r.id = \(runID)
                   AND r.workspace_id = \(workspaceID)
                   AND r.input->>'type' = 'work'
                 LIMIT 1
                """,
                logger: logger
            ).collect()
        } else if let idempotencyKey {
            rows = try await conn.query(
                """
                SELECT \(unescaped: runProjectionSQL(alias: "r"))
                  FROM agent_run r
                 WHERE r.workspace_id = \(workspaceID)
                   AND r.idempotency_key = \(idempotencyKey)
                   AND r.input->>'type' = 'work'
                 LIMIT 1
                """,
                logger: logger
            ).collect()
        } else {
            return nil
        }
        return try rows.first.map(decodeRun)
    }

    private static func runProjectionSQL(alias: String) -> String {
        """
        jsonb_build_object(
          'id', \(alias).id::text,
          'workspaceId', \(alias).workspace_id::text,
          'agentMemberId', \(alias).agent_member_id::text,
          'channelId', \(alias).channel_id::text,
          'triggerMessageId', \(alias).trigger_message_id::text,
          'parentRunId', \(alias).parent_run_id::text,
          'status', \(alias).status::text,
          'stepCount', \(alias).step_count,
          'maxSteps', \(alias).max_steps,
          'depth', \(alias).depth,
          'input', \(alias).input,
          'output', \(alias).output,
          'error', \(alias).error,
          'startedAtMs', CASE WHEN \(alias).started_at IS NULL THEN NULL
            ELSE floor(extract(epoch FROM \(alias).started_at) * 1000)::bigint END,
          'finishedAtMs', CASE WHEN \(alias).finished_at IS NULL THEN NULL
            ELSE floor(extract(epoch FROM \(alias).finished_at) * 1000)::bigint END,
          'createdAtMs', floor(extract(epoch FROM \(alias).created_at) * 1000)::bigint,
          'updatedAtMs', floor(extract(epoch FROM \(alias).updated_at) * 1000)::bigint
        )::text
        """
    }

    private static func decodeRun(_ row: PostgresRow) throws -> AgentRunDTO {
        try decodeRun(row.decode(String.self))
    }

    private static func decodeRun(_ json: String) throws -> AgentRunDTO {
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "work run JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode(AgentRunDTO.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "work run JSON decoding failed")
        }
    }

    private static func workJobPayload(
        workspaceID: UUID,
        channelID: UUID,
        actorMemberID: UUID,
        agentMemberID: UUID,
        runID: UUID,
        model: String,
        input: WorkRunInput,
        idempotencyKey: String,
        createdAtMs: Int64
    ) -> String {
        jsonString([
            "run_id": runID.uuidString,
            "workspace_id": workspaceID.uuidString,
            "channel_id": channelID.uuidString,
            "agent_member_id": agentMemberID.uuidString,
            "author_member_id": actorMemberID.uuidString,
            "model": model,
            "prompt": input.brief,
            "input": anyValue(input.jsonValue),
            "work": anyValue(input.jsonValue),
            "idempotency_key": idempotencyKey,
            "delivery": "gateway",
            "created_from": "server.agent_work.v0",
            "created_at_ms": createdAtMs,
        ])
    }

    private static func agentJobBroadcastPayload(
        workspaceID: UUID,
        agentMemberID: UUID,
        jobID: Int64,
        runID: UUID,
        payloadJSON: String,
        createdAtMs: Int64
    ) -> String {
        let channel = "agentwork:ws\(workspaceID.uuidString).\(agentMemberID.uuidString)"
        var payload = jsonObject(payloadJSON)
        payload["agent_job_outbox_id"] = jobID
        return jsonString([
            "channel": channel,
            "data": [
                "type": "agent.job",
                "v": 1,
                "ts": createdAtMs,
                "seq": jobID,
                "payload": payload,
            ],
            "version": jobID,
            "idempotency_key": "\(channel):agent_job:\(runID.uuidString)",
        ])
    }

    private static func idempotencyKey(
        channelID: UUID,
        actorMemberID: UUID,
        agentMemberID: UUID,
        clientRunID: UUID
    ) -> String {
        "work:\(channelID.uuidString):\(actorMemberID.uuidString):\(agentMemberID.uuidString):\(clientRunID.uuidString)"
    }

    private static func workspaceScope(
        _ context: AppRequestContext,
        principal: AuthPrincipal
    ) throws -> UUID {
        let raw = try context.parameters.require("ws")
        guard let workspaceID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        guard workspaceID == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return workspaceID
    }

    private static func channelScope(
        _ context: AppRequestContext,
        principal: AuthPrincipal
    ) throws -> (workspaceID: UUID, channelID: UUID) {
        let workspaceID = try workspaceScope(context, principal: principal)
        let raw = try context.parameters.require("ch")
        guard let channelID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid channel id")
        }
        return (workspaceID, channelID)
    }

    private static func runID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("run")
        guard let runID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid run id")
        }
        return runID
    }

    private static func encodeJSON(_ value: JSONValue) throws -> String {
        let data = try JSONEncoder().encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw HTTPError(.badRequest, message: "work input is not valid JSON")
        }
        return string
    }

    private static func jsonObject(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return object
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
              ),
              let string = String(data: data, encoding: .utf8)
        else { return "{}" }
        return string
    }

    private static func anyValue(_ value: JSONValue) -> Any {
        switch value {
        case .object(let object):
            return object.mapValues(anyValue)
        case .array(let array):
            return array.map(anyValue)
        case .string(let string):
            return string
        case .int(let int):
            return int
        case .double(let double):
            return double
        case .bool(let bool):
            return bool
        case .null:
            return NSNull()
        }
    }
}

struct CreateAgentRunRequest: Decodable, Sendable {
    let agentMemberId: UUID
    let clientRunId: UUID
    let input: JSONValue

    private enum CodingKeys: String, CodingKey {
        case agentMemberId
        case agentMemberIdSnake = "agent_member_id"
        case clientRunId
        case clientRunIdSnake = "client_run_id"
        case input
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agentMemberId = try container.decodeIfPresent(UUID.self, forKey: .agentMemberId)
            ?? container.decode(UUID.self, forKey: .agentMemberIdSnake)
        clientRunId = try container.decodeIfPresent(UUID.self, forKey: .clientRunId)
            ?? container.decode(UUID.self, forKey: .clientRunIdSnake)
        input = try container.decode(JSONValue.self, forKey: .input)
    }
}

struct WorkRunInput: Equatable, Sendable {
    static let allowedKeys = Set(["type", "title", "brief", "repo", "branch"])

    let title: String
    let brief: String
    let repo: String?
    let branch: String?

    var jsonValue: JSONValue {
        var object: [String: JSONValue] = [
            "type": .string("work"),
            "title": .string(title),
            "brief": .string(brief),
        ]
        if let repo { object["repo"] = .string(repo) }
        if let branch { object["branch"] = .string(branch) }
        return .object(object)
    }

    /// Validates only inputs that explicitly opt into `type: work`.
    /// Existing mention and other non-work conventions pass through untouched.
    static func validateIfWork(_ input: JSONValue) throws -> WorkRunInput? {
        guard case .object(let object) = input,
              object["type"]?.stringValue == "work"
        else { return nil }
        let unknownKeys = Set(object.keys).subtracting(allowedKeys)
        guard unknownKeys.isEmpty else {
            throw HTTPError(.badRequest, message: "work input contains unknown fields")
        }
        return WorkRunInput(
            title: try requiredString(object["title"], field: "title", limit: 200),
            brief: try requiredString(object["brief"], field: "brief", limit: 16_384),
            repo: try optionalString(object["repo"], field: "repo", limit: 2_048),
            branch: try optionalString(object["branch"], field: "branch", limit: 512)
        )
    }

    static func require(_ input: JSONValue) throws -> WorkRunInput {
        guard let work = try validateIfWork(input) else {
            throw HTTPError(
                .badRequest,
                message: "agent run input must be an object with type=work"
            )
        }
        return work
    }

    private static func requiredString(
        _ value: JSONValue?,
        field: String,
        limit: Int
    ) throws -> String {
        guard let raw = value?.stringValue else {
            throw HTTPError(.badRequest, message: "work input \(field) is required")
        }
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            throw HTTPError(.badRequest, message: "work input \(field) is required")
        }
        guard normalized.utf8.count <= limit else {
            throw HTTPError(.badRequest, message: "work input \(field) is too large")
        }
        return normalized
    }

    private static func optionalString(
        _ value: JSONValue?,
        field: String,
        limit: Int
    ) throws -> String? {
        guard let value else { return nil }
        guard let raw = value.stringValue else {
            throw HTTPError(.badRequest, message: "work input \(field) must be a string")
        }
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            throw HTTPError(.badRequest, message: "work input \(field) must not be empty")
        }
        guard normalized.utf8.count <= limit else {
            throw HTTPError(.badRequest, message: "work input \(field) is too large")
        }
        return normalized
    }
}

struct AgentRunDTO: ResponseEncodable, Codable, Equatable, Sendable {
    let id: String
    let workspaceId: String
    let agentMemberId: String
    let channelId: String
    let triggerMessageId: String?
    let parentRunId: String?
    let status: String
    let stepCount: Int
    let maxSteps: Int
    let depth: Int
    let input: JSONValue
    let output: JSONValue?
    let error: JSONValue?
    let startedAtMs: Int64?
    let finishedAtMs: Int64?
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct AgentRunPageDTO: ResponseEncodable, Codable, Sendable {
    let runs: [AgentRunDTO]
}

private struct EligibleWorkAgent: Sendable {
    let model: String
    let maxRunSteps: Int
    let maxConcurrentRuns: Int
    let activeRuns: Int
}

private enum WorkRunCreationResult: Sendable {
    case forbidden
    case agentNotFound
    case concurrencyLimit
    case idempotencyConflict
    case ready(run: AgentRunDTO, created: Bool)
}
