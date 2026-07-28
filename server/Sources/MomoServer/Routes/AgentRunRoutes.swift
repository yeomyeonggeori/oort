import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Work-v0 creation and read projections over the existing `agent_run` table.
///
///   POST /v1/workspaces/{ws}/channels/{ch}/agent-runs
///   GET  /v1/workspaces/{ws}/channels/{ch}/agent-runs?type=work
///   GET  /v1/workspaces/{ws}/agents/{agent}/runs
///   GET  /v1/workspaces/{ws}/agent-runs/{run}
///   POST /v1/workspaces/{ws}/agent-runs/{run}/cancel
///
/// Work input is validated before a tenant transaction starts. The server only
/// records and dispatches the run; execution remains on the BYOA gateway host.
struct AgentRunRoutes: Sendable {
    let db: Database
    let agentGateway: AgentGatewayConfig

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/channels/:ch/agent-runs", use: create)
        group.get("/v1/workspaces/:ws/channels/:ch/agent-runs", use: list)
        group.get("/v1/workspaces/:ws/agents/:agent/runs", use: listByAgent)
        group.get("/v1/workspaces/:ws/agent-runs/:run", use: detail)
        group.post("/v1/workspaces/:ws/agent-runs/:run/cancel", use: cancel)
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
        // MOMO-621 / ADR-0134 D1: routing shape (closed-world keys, known effort
        // level) is checked here; the allow-list / model×effort gates need tenant
        // rows and therefore run inside the transaction below.
        let requestRouting = try RunRoutingInput.validate(requestDTO.routing)
        let workInput = try WorkRunInput.require(requestDTO.input)
            .adoptingRequestRouting(requestRouting)
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
            guard !agent.paused else {
                return WorkRunCreationResult.agentPaused
            }
            guard agent.activeRuns < agent.maxConcurrentRuns else {
                return WorkRunCreationResult.concurrencyLimit
            }

            // ADR-0134 D1/D3: explicit routing is gated (400 on violation), an
            // absent one inherits from the agent profile. Throwing here rolls the
            // tx back before any row is written.
            let routing = try RunRoutingResolution.resolve(
                requested: workInput.routing,
                baseModel: agent.model,
                modelPref: agent.modelPref,
                effortPref: agent.effortPref,
                workspaceSettingsJSON: agent.workspaceSettingsJSON
            )

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
                model: routing.model,
                effort: routing.effort,
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

            // The resolved model/effort are audited next to the requested block so
            // "who ran on what" stays answerable without replaying inheritance
            // (ADR-0134 D4: the selected model is never hidden).
            var auditObject: [String: Any] = [
                "schema": "momo.agent_work.queued.v0",
                "run_id": runID.uuidString,
                "channel_id": channelID.uuidString,
                "agent_member_id": requestDTO.agentMemberId.uuidString,
                "client_run_id": requestDTO.clientRunId.uuidString,
                "input": Self.anyValue(workInput.jsonValue),
                "resolved_model": routing.model,
            ]
            if let requested = workInput.routing?.auditObject, !requested.isEmpty {
                auditObject["routing"] = requested
            }
            if let effort = routing.effort { auditObject["resolved_effort"] = effort }
            if let ignored = routing.ignoredModelPref { auditObject["ignored_model_pref"] = ignored }
            if let ignored = routing.ignoredEffortPref { auditObject["ignored_effort_pref"] = ignored }
            let auditDetail = Self.jsonString(auditObject)
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
        case .agentPaused:
            throw HTTPError(.conflict, message: "agent is paused")
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

    /// Workspace-global history for one agent, reduced to the fields needed by
    /// an agent hub. The caller still sees only runs in channels where they have
    /// active membership. The query deliberately uses the summary projection,
    /// so input/output/error and gateway-adjacent payloads never cross this read
    /// boundary (MOMO-653).
    @Sendable
    func listByAgent(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanPrincipal(context)
        let workspaceID = try Self.workspaceScope(context, principal: principal)
        let agentMemberID = try Self.agentID(context)
        let query = request.uri.queryParameters
        let cursor = try Self.validatedCursor(query["cursor"].map(String.init))
        let limit = Self.validatedLimit(query["limit"].map(String.init))

        let page: AgentRunSummaryPageDTO = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            _ = try await WorkspaceAuthorization.requireMember(
                conn: conn, logger: db.logger, principal: principal
            )

            let agentRows = try await conn.query(
                """
                SELECT 1
                  FROM member m
                 WHERE m.workspace_id = \(workspaceID)
                   AND m.id = \(agentMemberID)
                   AND m.kind = 'agent'
                   AND m.status = 'active'
                   AND m.deleted_at IS NULL
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard !agentRows.isEmpty else {
                throw HTTPError(.notFound, message: "active agent not found")
            }

            if let cursor {
                let cursorRows = try await conn.query(
                    """
                    SELECT 1
                      FROM agent_run r
                      JOIN membership visible
                        ON visible.workspace_id = r.workspace_id
                       AND visible.channel_id = r.channel_id
                       AND visible.member_id = \(principal.memberID)
                       AND visible.left_at IS NULL
                     WHERE r.workspace_id = \(workspaceID)
                       AND r.agent_member_id = \(agentMemberID)
                       AND r.id = \(cursor)
                     LIMIT 1
                    """,
                    logger: db.logger
                ).collect()
                guard !cursorRows.isEmpty else {
                    throw HTTPError(.badRequest, message: "agent run cursor was not found")
                }
            }

            let rows = try await conn.query(
                """
                SELECT \(unescaped: Self.runSummaryProjectionSQL(alias: "r"))
                  FROM agent_run r
                  JOIN membership visible
                    ON visible.workspace_id = r.workspace_id
                   AND visible.channel_id = r.channel_id
                   AND visible.member_id = \(principal.memberID)
                   AND visible.left_at IS NULL
                 WHERE r.workspace_id = \(workspaceID)
                   AND r.agent_member_id = \(agentMemberID)
                   AND (\(cursor)::uuid IS NULL OR (r.created_at, r.id) < (
                         SELECT cursor_row.created_at, cursor_row.id
                           FROM agent_run cursor_row
                          WHERE cursor_row.workspace_id = \(workspaceID)
                            AND cursor_row.agent_member_id = \(agentMemberID)
                            AND cursor_row.id = \(cursor)::uuid
                       ))
                 ORDER BY r.created_at DESC, r.id DESC
                 LIMIT \(limit + 1)
                """,
                logger: db.logger
            ).collect()
            let decoded = try rows.map(Self.decodeRunSummary)
            let hasMore = decoded.count > limit
            let runs = Array(decoded.prefix(limit))
            return AgentRunSummaryPageDTO(
                runs: runs,
                nextCursor: hasMore ? runs.last?.id : nil
            )
        }
        return try page.response(from: request, context: context)
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
                     LIMIT 1
                    """,
                    logger: db.logger
                ).collect()
                guard let first = rows.first else { return nil }
                let (json, hasMembership) = try first.decode((String, Bool).self)
                return (try Self.decodeRun(json), hasMembership)
        }
        guard let row else {
            throw HTTPError(.notFound, message: "agent run not found")
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

    @Sendable
    func cancel(_ request: Request, context: AppRequestContext) async throws -> AgentRunCancelResponse {
        let principal = try Self.requireHumanPrincipal(context)
        let workspaceID = try Self.workspaceScope(context, principal: principal)
        let runID = try Self.runID(context)

        let result = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT r.channel_id, r.agent_member_id, r.status::text,
                       EXISTS (
                         SELECT 1 FROM membership ms
                          WHERE ms.workspace_id = \(workspaceID)
                            AND ms.channel_id = r.channel_id
                            AND ms.member_id = \(principal.memberID)
                            AND ms.left_at IS NULL
                       ) AS can_cancel
                  FROM agent_run r
                 WHERE r.workspace_id = \(workspaceID) AND r.id = \(runID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return AgentRunCancelResult.notFound }
            let (channelID, agentMemberID, status, canCancel) = try row.decode(
                (UUID, UUID, String, Bool).self
            )
            guard canCancel else { return AgentRunCancelResult.forbidden }
            guard status == "cancelled" || Self.isCancellableRunStatus(status) else {
                return AgentRunCancelResult.conflict(status: status)
            }

            let sessionRows = try await conn.query(
                """
                SELECT DISTINCT wc.session_id
                  FROM audit_log al
                  JOIN work_control wc
                    ON wc.workspace_id = al.workspace_id
                   AND wc.id = al.target_id
                   AND al.target_type = 'work_control'
                 WHERE al.workspace_id = \(workspaceID)
                   AND al.run_id = \(runID)
                   AND wc.session_id IS NOT NULL
                 ORDER BY wc.session_id
                """,
                logger: db.logger
            ).collect()
            let linkedSessionIDs = try sessionRows.map { try $0.decode(UUID.self) }
            if status == "cancelled" {
                return .cancelled(linkedSessionIDs: linkedSessionIDs)
            }

            let linkedSessionsJSON = Self.jsonString(
                linkedSessionIDs.map { $0.uuidString.lowercased() }
            )
            _ = try await conn.query(
                """
                UPDATE agent_run
                   SET status = 'cancelled',
                       error = jsonb_build_object(
                         'code', 'human_cancelled',
                         'cancelled_by', \(principal.memberID),
                         'linked_work_session_ids', \(linkedSessionsJSON)::jsonb,
                         'work_sessions_terminated', false
                       ),
                       updated_at = now(), finished_at = now()
                 WHERE workspace_id = \(workspaceID) AND id = \(runID)
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                UPDATE outbox
                   SET status = 'done', processed_at = now(),
                       last_error = 'human cancelled agent run'
                 WHERE workspace_id = \(workspaceID)
                   AND kind = 'agent_job' AND status = 'pending'
                   AND payload->>'run_id' = \(runID.uuidString)
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                UPDATE approval
                   SET status = 'cancelled', decided_at = now(),
                       decision_reason = 'agent run cancelled by human'
                 WHERE workspace_id = \(workspaceID)
                   AND run_id = \(runID) AND status = 'pending'
                """,
                logger: db.logger
            )

            let hlcTs = Int64(Date().timeIntervalSince1970 * 1_000)
            let props = Self.jsonString([
                "kind": "agent_run_cancelled",
                "run_id": runID.uuidString.lowercased(),
                "agent_member_id": agentMemberID.uuidString.lowercased(),
                "cancelled_by": principal.memberID.uuidString.lowercased(),
                "linked_work_session_ids": linkedSessionIDs.map { $0.uuidString.lowercased() },
                "work_sessions_terminated": false,
            ])
            let messageRows = try await conn.query(
                """
                WITH bumped AS (
                  UPDATE channel_seq SET last_seq = last_seq + 1
                   WHERE workspace_id = \(workspaceID) AND channel_id = \(channelID)
                  RETURNING last_seq AS seq
                )
                INSERT INTO message
                  (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                   author_member_id, type, body, props, run_id)
                SELECT \(workspaceID), \(channelID), b.seq, \(hlcTs), 0,
                       \(principal.memberID), 'system'::message_type,
                       '실행이 사람에 의해 중지되었습니다.', \(props)::jsonb, \(runID)
                  FROM bumped b
                RETURNING id, seq
                """,
                logger: db.logger
            ).collect()
            guard let messageRow = messageRows.first else {
                throw HTTPError(.internalServerError, message: "cancel system line insert failed")
            }
            let (messageID, seq) = try messageRow.decode((UUID, Int64).self)
            let broadcast = Self.cancelMessageBroadcastPayload(
                workspaceID: workspaceID, channelID: channelID,
                messageID: messageID, seq: seq, authorMemberID: principal.memberID,
                runID: runID, propsJSON: props, hlcTs: hlcTs
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
                VALUES (\(workspaceID), 'broadcast', 'publish',
                        \(broadcast)::jsonb, \(channelID))
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, run_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(agentMemberID),
                   'agent.run.cancelled', 'agent_run', \(runID),
                   \(principal.tokenID), \(runID),
                   jsonb_build_object(
                     'schema', 'momo.agent_run.cancelled.v1',
                     'previous_status', \(status),
                     'linked_work_session_ids', \(linkedSessionsJSON)::jsonb,
                     'work_sessions_terminated', false,
                     'system_message_id', \(messageID)
                   ))
                """,
                logger: db.logger
            )
            return .cancelled(linkedSessionIDs: linkedSessionIDs)
        }

        switch result {
        case .notFound:
            throw HTTPError(.notFound, message: "agent run not found")
        case .forbidden:
            throw HTTPError(.forbidden, message: "active human channel member required")
        case .conflict(let status):
            throw HTTPError(.conflict, message: "agent run is already \(status)")
        case .cancelled(let linkedSessionIDs):
            return AgentRunCancelResponse(
                runId: runID.uuidString.lowercased(), status: "cancelled",
                linkedWorkSessionIds: linkedSessionIDs.map { $0.uuidString.lowercased() },
                workSessionsTerminated: false
            )
        }
    }

    static func isCancellableRunStatus(_ status: String) -> Bool {
        ["queued", "running", "awaiting_approval", "paused"].contains(status)
    }

    static func validatedLimit(_ raw: String?) -> Int {
        min(max(raw.flatMap(Int.init) ?? 50, 1), 200)
    }

    static func validatedCursor(_ raw: String?) throws -> UUID? {
        guard let raw else { return nil }
        guard let cursor = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid agent run cursor")
        }
        return cursor
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
        case .workHost:
            return false
        }
    }

    private static func requireHumanPrincipal(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human member required")
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
                   COALESCE(ap.paused, false),
                   (
                     SELECT count(*)::int
                       FROM agent_run active
                      WHERE active.workspace_id = \(workspaceID)
                        AND active.agent_member_id = \(agentMemberID)
                        AND active.status IN
                            ('queued','running','awaiting_approval','paused')
                   ) AS active_runs,
                   ap.model_pref, ap.effort_pref, w.settings::text
              FROM member m
              JOIN agent a
                ON a.member_id = m.id
               AND a.workspace_id = m.workspace_id
              JOIN workspace w
                ON w.id = m.workspace_id
              JOIN membership ms
                ON ms.workspace_id = m.workspace_id
               AND ms.channel_id = \(channelID)
               AND ms.member_id = m.id
               AND ms.left_at IS NULL
              LEFT JOIN agent_profile ap
                ON ap.workspace_id = a.workspace_id AND ap.agent_member_id = a.member_id
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
        let (model, maxRunSteps, maxConcurrentRuns, paused, activeRuns,
             modelPref, effortPref, workspaceSettingsJSON) = try first.decode(
            (String, Int, Int, Bool, Int, String?, String?, String).self
        )
        return EligibleWorkAgent(
            model: model,
            maxRunSteps: maxRunSteps,
            maxConcurrentRuns: maxConcurrentRuns,
            paused: paused,
            activeRuns: activeRuns,
            modelPref: modelPref,
            effortPref: effortPref,
            workspaceSettingsJSON: workspaceSettingsJSON
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
          \(runSummaryFieldsSQL(alias: alias)),
          'workspaceId', \(alias).workspace_id::text,
          'agentMemberId', \(alias).agent_member_id::text,
          'parentRunId', \(alias).parent_run_id::text,
          'stepCount', \(alias).step_count,
          'maxSteps', \(alias).max_steps,
          'depth', \(alias).depth,
          'input', \(alias).input,
          'output', \(alias).output,
          'error', \(alias).error
        )::text
        """
    }

    /// The channel list is a historical full projection consumed by existing
    /// clients. The agent-global list is intentionally smaller, but both call
    /// this exact field fragment so shared summary values cannot drift.
    static func runSummaryFieldsSQL(alias: String) -> String {
        """
        'id', \(alias).id::text,
        'channelId', \(alias).channel_id::text,
        'triggerMessageId', \(alias).trigger_message_id::text,
        'triggerSummary', CASE
          WHEN \(alias).input->>'type' = 'work'
            THEN left(nullif(btrim(\(alias).input->>'title'), ''), 200)
          WHEN \(alias).input->>'surface' = 'mention'
            THEN left(nullif(btrim(\(alias).input->>'prompt'), ''), 200)
          ELSE NULL
        END,
        'status', \(alias).status::text,
        'startedAtMs', CASE WHEN \(alias).started_at IS NULL THEN NULL
          ELSE floor(extract(epoch FROM \(alias).started_at) * 1000)::bigint END,
        'finishedAtMs', CASE WHEN \(alias).finished_at IS NULL THEN NULL
          ELSE floor(extract(epoch FROM \(alias).finished_at) * 1000)::bigint END,
        'createdAtMs', floor(extract(epoch FROM \(alias).created_at) * 1000)::bigint,
        'updatedAtMs', floor(extract(epoch FROM \(alias).updated_at) * 1000)::bigint
        """
    }

    private static func runSummaryProjectionSQL(alias: String) -> String {
        """
        jsonb_build_object(
          \(runSummaryFieldsSQL(alias: alias))
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

    private static func decodeRunSummary(_ row: PostgresRow) throws -> AgentRunSummaryDTO {
        let json = try row.decode(String.self)
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "agent run summary JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode(AgentRunSummaryDTO.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "agent run summary JSON decoding failed")
        }
    }

    private static func workJobPayload(
        workspaceID: UUID,
        channelID: UUID,
        actorMemberID: UUID,
        agentMemberID: UUID,
        runID: UUID,
        model: String,
        effort: String?,
        input: WorkRunInput,
        idempotencyKey: String,
        createdAtMs: Int64
    ) -> String {
        // `model`/`effort` here are the RESOLVED values (request → profile), which
        // is what the gateway hands the adapter (ADR-0130 payload convention) and
        // what the worker records on the usage ledger. `effort` is omitted rather
        // than null when nothing was chosen or inherited.
        var payload: [String: Any] = [
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
        ]
        if let effort { payload["effort"] = effort }
        return jsonString(payload)
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

    private static func cancelMessageBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        seq: Int64,
        authorMemberID: UUID,
        runID: UUID,
        propsJSON: String,
        hlcTs: Int64
    ) -> String {
        let channel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        return jsonString([
            "channel": channel,
            "data": [
                "type": "message.new", "v": 1, "ts": hlcTs, "seq": seq,
                "payload": [
                    "id": messageID.uuidString, "channel_id": channelID.uuidString,
                    "channelId": channelID.uuidString, "seq": seq, "type": "system",
                    "body": "실행이 사람에 의해 중지되었습니다.",
                    "props": jsonObject(propsJSON),
                    "author_member_id": authorMemberID.uuidString,
                    "authorMemberId": authorMemberID.uuidString,
                    "run_id": runID.uuidString, "runId": runID.uuidString,
                    "hlc_ts": hlcTs, "hlcTs": hlcTs, "hlc_count": 0, "hlcCount": 0,
                ],
            ],
            "version": seq,
            "idempotency_key": "\(channel):\(seq)",
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

    private static func agentID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("agent")
        guard let agentID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid agent id")
        }
        return agentID
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

/// Closed-world run creation body (ADR-0134 D1). The request grows exactly one
/// new key, `routing`; every other unknown top-level field is a 400 so a
/// smuggled model/effort/credential can never ride along unvalidated.
///
/// `routing` is kept as raw JSON here and validated in the route
/// (`RunRoutingInput.validate`) so its 400s are plain `HTTPError`s raised before
/// the tenant transaction opens, instead of decoder errors.
struct CreateAgentRunRequest: Decodable, Sendable {
    static let allowedKeys = Set([
        "agentMemberId", "agent_member_id",
        "clientRunId", "client_run_id",
        "input", "routing",
    ])

    let agentMemberId: UUID
    let clientRunId: UUID
    let input: JSONValue
    let routing: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case agentMemberId
        case agentMemberIdSnake = "agent_member_id"
        case clientRunId
        case clientRunIdSnake = "client_run_id"
        case input
        case routing
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: CreateAgentRunCodingKey.self)
        let unknownKeys = dynamic.allKeys
            .map(\.stringValue)
            .filter { !Self.allowedKeys.contains($0) }
        if let first = unknownKeys.sorted().first {
            throw DecodingError.dataCorruptedError(
                forKey: CreateAgentRunCodingKey(first),
                in: dynamic,
                debugDescription: "unknown agent run request field"
            )
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agentMemberId = try container.decodeIfPresent(UUID.self, forKey: .agentMemberId)
            ?? container.decode(UUID.self, forKey: .agentMemberIdSnake)
        clientRunId = try container.decodeIfPresent(UUID.self, forKey: .clientRunId)
            ?? container.decode(UUID.self, forKey: .clientRunIdSnake)
        input = try container.decode(JSONValue.self, forKey: .input)
        routing = try container.decodeIfPresent(JSONValue.self, forKey: .routing)
    }
}

private struct CreateAgentRunCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) { self.stringValue = stringValue }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { self.stringValue = String(intValue) }
}

struct WorkRunInput: Equatable, Sendable {
    /// ADR-0134 D1: `routing` is the single new allowed key. The input stays
    /// closed-world, and the routing object is itself closed-world.
    static let allowedKeys = Set(["type", "title", "brief", "repo", "branch", "routing"])

    let title: String
    let brief: String
    let repo: String?
    let branch: String?
    let routing: RunRoutingInput?

    init(
        title: String,
        brief: String,
        repo: String?,
        branch: String?,
        routing: RunRoutingInput? = nil
    ) {
        self.title = title
        self.brief = brief
        self.repo = repo
        self.branch = branch
        self.routing = routing
    }

    var jsonValue: JSONValue {
        var object: [String: JSONValue] = [
            "type": .string("work"),
            "title": .string(title),
            "brief": .string(brief),
        ]
        if let repo { object["repo"] = .string(repo) }
        if let branch { object["branch"] = .string(branch) }
        if let routingJSON = routing?.jsonValue { object["routing"] = routingJSON }
        return .object(object)
    }

    /// Folds the top-level `routing` block into the input. Both spellings are
    /// accepted (top-level per ADR-0134 D1's request shape, `input.routing` per
    /// the allow-list wording), but they must agree — a disagreement is a 400
    /// rather than a silent winner.
    func adoptingRequestRouting(_ requestRouting: RunRoutingInput?) throws -> WorkRunInput {
        guard let requestRouting else { return self }
        if let existing = routing, existing != requestRouting {
            throw HTTPError(
                .badRequest,
                message: "routing conflicts with input.routing"
            )
        }
        return WorkRunInput(
            title: title, brief: brief, repo: repo, branch: branch, routing: requestRouting
        )
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
            branch: try optionalString(object["branch"], field: "branch", limit: 512),
            routing: try RunRoutingInput.validate(object["routing"])
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
    let triggerSummary: String?
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

struct AgentRunSummaryDTO: ResponseEncodable, Codable, Equatable, Sendable {
    let id: String
    let channelId: String
    let triggerMessageId: String?
    let triggerSummary: String?
    let status: String
    let startedAtMs: Int64?
    let finishedAtMs: Int64?
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct AgentRunSummaryPageDTO: ResponseEncodable, Codable, Equatable, Sendable {
    let runs: [AgentRunSummaryDTO]
    let nextCursor: String?
}

private struct EligibleWorkAgent: Sendable {
    let model: String
    let maxRunSteps: Int
    let maxConcurrentRuns: Int
    let paused: Bool
    let activeRuns: Int
    /// ADR-0134 D3 inheritance inputs (agent tier + the workspace allow-list the
    /// request tier is gated against).
    let modelPref: String?
    let effortPref: String?
    let workspaceSettingsJSON: String
}

private enum WorkRunCreationResult: Sendable {
    case forbidden
    case agentNotFound
    case agentPaused
    case concurrencyLimit
    case idempotencyConflict
    case ready(run: AgentRunDTO, created: Bool)
}

private enum AgentRunCancelResult: Sendable {
    case notFound
    case forbidden
    case conflict(status: String)
    case cancelled(linkedSessionIDs: [UUID])
}

struct AgentRunCancelResponse: ResponseEncodable, Codable, Sendable {
    let runId: String
    let status: String
    let linkedWorkSessionIds: [String]
    let workSessionsTerminated: Bool
}
