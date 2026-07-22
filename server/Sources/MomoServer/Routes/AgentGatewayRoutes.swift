import Foundation
import HTTPTypes
import Hummingbird
import Logging
import PostgresNIO

/// Hermes gateway native platform callback surface (MOMO-325).
///
/// This is intentionally **not** an agent provider credential surface. Hermes or
/// another provider runtime owns Codex/OpenAI OAuth and model keys. momo only
/// accepts run status/result callbacks for jobs that momo itself created, then
/// commits user-visible output through the same Postgres/outbox path as every
/// other message.
struct AgentGatewayRoutes: Sendable {
    static let progressRateWindowSeconds = 60
    static let maximumProgressEventsPerWindow = 240
    static let leaseDurationSeconds = 30

    let db: Database
    let config: AgentGatewayConfig
    private let progressLimiter: SlidingWindowRateLimiter

    init(
        db: Database,
        config: AgentGatewayConfig,
        progressLimiter: SlidingWindowRateLimiter = SlidingWindowRateLimiter()
    ) {
        self.db = db
        self.config = config
        self.progressLimiter = progressLimiter
    }

    static let gatewaySecretHeader = HTTPField.Name("X-Momo-Agent-Gateway-Secret")!

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get(
            "/v1/workspaces/:ws/agents/:agent/gateway/jobs/pending",
            use: pendingJobs
        )
        group.post(
            "/v1/workspaces/:ws/agents/:agent/gateway/jobs/:job/lease/renew",
            use: renewLease
        )
        group.post(
            "/v1/workspaces/:ws/agents/:agent/gateway/jobs/:job/lease/release",
            use: releaseLease
        )
        group.post("/v1/workspaces/:ws/agent-runs/:run/gateway/events", use: event)
        group.post("/v1/workspaces/:ws/agent-runs/:run/gateway/complete", use: complete)
    }

    @Sendable
    func pendingJobs(
        _ request: Request,
        context: AppRequestContext
    ) async throws -> AgentGatewayPendingJobsResponse {
        try requireGatewayMode()
        let workspaceID = try Self.workspaceID(context)
        let targetAgentID = try Self.agentID(context)
        let principal = try Self.gatewayPrincipal(context, workspaceID: workspaceID)
        if let principal, principal.memberID != targetAgentID {
            throw HTTPError(.forbidden, message: "agent bearer actor does not match target agent")
        }
        let limit = min(max(request.uri.queryParameters["limit"].flatMap { Int($0) } ?? 20, 1), 100)
        let jobs: [AgentGatewayPendingJobDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            guard try await Self.isActiveAgent(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                agentID: targetAgentID
            ) else {
                throw HTTPError(.notFound, message: "active agent not found")
            }
            let rows = try await conn.query(
                """
                WITH candidate AS (
                  SELECT o.id
                    FROM outbox o
                   WHERE o.workspace_id = \(workspaceID)
                     AND o.kind = 'agent_job'
                     AND o.method = 'gateway'
                     AND o.status = 'pending'
                     AND o.available_at <= now()
                     AND o.partition_key = \(targetAgentID)
                     AND o.payload->>'agent_member_id' = \(targetAgentID.uuidString)
                     AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= now())
                     AND EXISTS (
                       SELECT 1
                         FROM member m
                         JOIN agent a
                           ON a.member_id = m.id
                          AND a.workspace_id = m.workspace_id
                        WHERE m.id = \(targetAgentID)
                          AND m.workspace_id = \(workspaceID)
                          AND m.kind = 'agent'
                          AND m.status = 'active'
                          AND m.deleted_at IS NULL
                     )
                   ORDER BY o.id ASC
                   FOR UPDATE OF o SKIP LOCKED
                   LIMIT \(limit)
                ), claimed AS (
                  UPDATE outbox o
                     SET lease_owner = uuidv7(),
                         lease_acquired_at = now(),
                         lease_expires_at = now()
                           + make_interval(secs => \(Self.leaseDurationSeconds))
                    FROM candidate c
                   WHERE o.id = c.id
                  RETURNING o.id, o.payload::text, o.created_at,
                            o.lease_owner, o.lease_expires_at
                )
                SELECT id, payload, created_at, lease_owner, lease_expires_at
                  FROM claimed
                 ORDER BY id ASC
                """,
                logger: db.logger
            ).collect()
            return try rows.map { row in
                let (id, payloadJSON, createdAt, leaseID, leaseExpiresAt) = try row.decode(
                    (Int64, String, Date, UUID, Date).self
                )
                guard let data = payloadJSON.data(using: .utf8) else {
                    throw HTTPError(.internalServerError, message: "gateway job payload encoding failed")
                }
                let payload = try JSONDecoder().decode(JSONValue.self, from: data)
                return AgentGatewayPendingJobDTO(
                    id: id,
                    runId: payload.objectValue?["run_id"]?.stringValue ?? "",
                    payload: payload,
                    createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000),
                    leaseId: leaseID.uuidString,
                    leaseExpiresAtMs: Int64(leaseExpiresAt.timeIntervalSince1970 * 1000)
                )
            }
        }
        return AgentGatewayPendingJobsResponse(jobs: jobs)
    }

    @Sendable
    func renewLease(
        _ request: Request,
        context: AppRequestContext
    ) async throws -> AgentGatewayLeaseResponse {
        try requireGatewayMode()
        let workspaceID = try Self.workspaceID(context)
        let targetAgentID = try Self.agentID(context)
        let jobID = try Self.jobID(context)
        let principal = try Self.gatewayPrincipal(context, workspaceID: workspaceID)
        if let principal, principal.memberID != targetAgentID {
            throw HTTPError(.forbidden, message: "agent bearer actor does not match target agent")
        }
        let lease = try await request.decode(as: AgentGatewayLeaseRequest.self, context: context)
            .validated(jobID: jobID)
        let expiresAt: Date? = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                UPDATE outbox
                   SET lease_expires_at = now()
                     + make_interval(secs => \(Self.leaseDurationSeconds))
                 WHERE id = \(jobID)
                   AND workspace_id = \(workspaceID)
                   AND kind = 'agent_job'
                   AND method = 'gateway'
                   AND status = 'pending'
                   AND partition_key = \(targetAgentID)
                   AND payload->>'agent_member_id' = \(targetAgentID.uuidString)
                   AND lease_owner = \(lease.leaseID)
                   AND lease_expires_at > now()
                RETURNING lease_expires_at
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(Date.self)
        }
        guard let expiresAt else { try Self.rejectGatewayLease() }
        return AgentGatewayLeaseResponse(
            status: "renewed",
            jobId: jobID,
            leaseId: lease.leaseID.uuidString,
            leaseExpiresAtMs: Int64(expiresAt.timeIntervalSince1970 * 1000)
        )
    }

    @Sendable
    func releaseLease(
        _ request: Request,
        context: AppRequestContext
    ) async throws -> AgentGatewayLeaseResponse {
        try requireGatewayMode()
        let workspaceID = try Self.workspaceID(context)
        let targetAgentID = try Self.agentID(context)
        let jobID = try Self.jobID(context)
        let principal = try Self.gatewayPrincipal(context, workspaceID: workspaceID)
        if let principal, principal.memberID != targetAgentID {
            throw HTTPError(.forbidden, message: "agent bearer actor does not match target agent")
        }
        let lease = try await request.decode(as: AgentGatewayLeaseRequest.self, context: context)
            .validated(jobID: jobID)
        let released: Bool = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                UPDATE outbox
                   SET lease_owner = NULL,
                       lease_acquired_at = NULL,
                       lease_expires_at = NULL
                 WHERE id = \(jobID)
                   AND workspace_id = \(workspaceID)
                   AND kind = 'agent_job'
                   AND method = 'gateway'
                   AND status = 'pending'
                   AND partition_key = \(targetAgentID)
                   AND payload->>'agent_member_id' = \(targetAgentID.uuidString)
                   AND lease_owner = \(lease.leaseID)
                   AND lease_expires_at > now()
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            return !rows.isEmpty
        }
        guard released else { try Self.rejectGatewayLease() }
        return AgentGatewayLeaseResponse(
            status: "released",
            jobId: jobID,
            leaseId: lease.leaseID.uuidString,
            leaseExpiresAtMs: nil
        )
    }

    @Sendable
    func event(_ request: Request, context: AppRequestContext) async throws -> AgentGatewayEventResponse {
        try requireGatewayMode()
        let workspaceID = try Self.workspaceID(context)
        let principal = try Self.gatewayPrincipal(context, workspaceID: workspaceID)
        let runID = try Self.runID(context)
        try await requireRunActorBinding(
            principal: principal,
            workspaceID: workspaceID,
            runID: runID
        )
        let dto = try await request.decode(as: AgentGatewayEventRequest.self, context: context)
        guard let lease = dto.leaseBinding else { try Self.rejectGatewayLease() }
        let normalizedStatus = Self.normalizedStatus(dto.status ?? "running")

        if normalizedStatus == "tool_call" {
            guard let principal, principal.kind == .agent else {
                throw HTTPError(
                    .forbidden,
                    message: "gateway work tools require an agent bearer"
                )
            }
            guard principal.scopes.contains("work:control") else {
                throw HTTPError(
                    .forbidden,
                    message: "gateway work tools require work:control scope"
                )
            }
            guard let workToolCall = dto.toolCall else {
                throw HTTPError(.badRequest, message: "tool_call payload is required")
            }
            let validated = try workToolCall.validated()
            let verdict = await progressLimiter.check(
                key: "gateway-progress:\(workspaceID.uuidString):\(runID.uuidString)",
                limit: Self.maximumProgressEventsPerWindow,
                windowSeconds: Self.progressRateWindowSeconds
            )
            guard verdict.allowed else {
                throw HTTPError(.tooManyRequests, message: "gateway event rate limit exceeded")
            }
            let control = try await recordWorkToolCall(
                principal: principal,
                workspaceID: workspaceID,
                runID: runID,
                request: validated,
                lease: lease
            )
            return AgentGatewayEventResponse(
                status: "accepted",
                runId: runID.uuidString,
                workControl: control
            )
        }

        if normalizedStatus == "approval_request" {
            guard let approvalRequest = dto.approvalRequest else {
                throw HTTPError(.badRequest, message: "approval_request payload is required")
            }
            let validated = try approvalRequest.validated()
            let result = try await recordApprovalRequest(
                principal: principal,
                workspaceID: workspaceID,
                runID: runID,
                request: validated,
                lease: lease
            )
            switch result {
            case .notFound:
                throw HTTPError(.notFound, message: "agent run not found")
            case .leaseRejected:
                try Self.rejectGatewayLease()
            case .runConflict(let message):
                throw HTTPError(.conflict, message: message)
            case .accepted:
                break
            }
            return AgentGatewayEventResponse(
                status: "accepted",
                runId: runID.uuidString,
                workControl: nil
            )
        }

        let progress = try dto.validatedProgress(status: normalizedStatus)
        if normalizedStatus == "thinking" || normalizedStatus == "streaming" {
            let verdict = await progressLimiter.check(
                key: "gateway-progress:\(workspaceID.uuidString):\(runID.uuidString)",
                limit: Self.maximumProgressEventsPerWindow,
                windowSeconds: Self.progressRateWindowSeconds
            )
            guard verdict.allowed else {
                throw HTTPError(.tooManyRequests, message: "gateway progress rate limit exceeded")
            }
        }

        let result = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard let run = try await Self.lockGatewayRun(
                conn: conn, logger: db.logger, workspaceID: workspaceID, runID: runID)
            else { return GatewayEventResult.notFound }
            guard try await Self.gatewayLeaseIsAuthorized(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID,
                agentID: run.agentMemberID,
                lease: lease,
                allowSettled: normalizedStatus == "cancelled" && run.status == "cancelled"
            ) else { return GatewayEventResult.leaseRejected }
            let existingEvent = try await conn.query(
                """
                SELECT 1
                  FROM audit_log
                 WHERE workspace_id = \(workspaceID)
                   AND run_id = \(runID)
                   AND action = 'agent.gateway.status'
                   AND target_type = 'agent_run'
                   AND target_id = \(runID)
                   AND detail->>'event_id' = \(progress.eventID.uuidString)
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            if !existingEvent.isEmpty {
                return GatewayEventResult.accepted
            }
            if Self.isApprovalHeldRunStatus(run.status) {
                return GatewayEventResult.runConflict(
                    message: "agent run is awaiting a human approval decision"
                )
            }
            if Self.isTerminalRunStatus(run.status), normalizedStatus != "cancelled" {
                return GatewayEventResult.runConflict(message: "agent run is already terminal")
            }
            if normalizedStatus == "cancelled", run.status != "cancelled" {
                return GatewayEventResult.runConflict(
                    message: "gateway cancellation acknowledgement has no rejected run"
                )
            }
            if normalizedStatus == "running" || normalizedStatus == "thinking"
                || normalizedStatus == "streaming"
            {
                _ = try await conn.query(
                    """
                    UPDATE agent_run
                       SET status = CASE
                             WHEN status = 'queued' THEN 'running'::run_status
                             ELSE status
                           END,
                           started_at = COALESCE(started_at, now()),
                           updated_at = now()
                     WHERE id = \(runID)
                       AND status IN ('queued','running')
                    """,
                    logger: db.logger
                )
            }

            let detail = Self.jsonString([
                "schema": "momo.agent_gateway.event.v0",
                "status": normalizedStatus,
                "detail": progress.detail as Any,
                "event_id": progress.eventID.uuidString,
                "text_delta_bytes": progress.textDelta?.utf8.count as Any,
                "run_id": runID.uuidString,
                "agent_member_id": run.agentMemberID.uuidString,
                "source": "hermes_gateway",
            ])
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, run_id, detail)
                VALUES
                  (\(workspaceID), \(run.agentMemberID),
                   'agent.gateway.status', 'agent_run', \(runID),
                   \(principal?.tokenID), \(runID),
                   \(detail)::jsonb)
                """,
                logger: db.logger
            )

            let payload = Self.agentStatusBroadcastPayload(
                workspaceID: workspaceID,
                channelID: run.channelID,
                agentMemberID: run.agentMemberID,
                runID: runID,
                status: normalizedStatus,
                detail: progress.detail,
                eventID: progress.eventID
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish',
                   \(payload)::jsonb, \(run.agentMemberID))
                """,
                logger: db.logger
            )
            if let textDelta = progress.textDelta {
                let partialPayload = Self.agentPartialBroadcastPayload(
                    workspaceID: workspaceID,
                    channelID: run.channelID,
                    agentMemberID: run.agentMemberID,
                    runID: runID,
                    textDelta: textDelta,
                    eventID: progress.eventID
                )
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(workspaceID), 'broadcast', 'publish',
                       \(partialPayload)::jsonb, \(run.agentMemberID))
                    """,
                    logger: db.logger
                )
            }
            if normalizedStatus == "cancelled" {
                _ = try await conn.query(
                    """
                    UPDATE outbox
                       SET status = 'done',
                           processed_at = now(),
                           last_error = 'gateway stopped after approval rejection'
                     WHERE workspace_id = \(workspaceID)
                       AND id = \(lease.jobID)
                       AND kind = 'agent_job'
                       AND method = 'gateway'
                       AND status = 'pending'
                       AND lease_owner = \(lease.leaseID)
                       AND payload->>'run_id' = \(runID.uuidString)
                       AND payload ? 'resume_from_approval_id'
                       AND payload #>> '{approval_decision,status}' IN
                           ('rejected','cancelled','expired')
                    """,
                    logger: db.logger
                )
            }
            return GatewayEventResult.accepted
        }

        switch result {
        case .notFound:
            throw HTTPError(.notFound, message: "agent run not found")
        case .leaseRejected:
            try Self.rejectGatewayLease()
        case .runConflict(let message):
            throw HTTPError(.conflict, message: message)
        case .accepted:
            break
        }
        return AgentGatewayEventResponse(
            status: "accepted",
            runId: runID.uuidString,
            workControl: nil
        )
    }

    private func recordWorkToolCall(
        principal: AuthPrincipal,
        workspaceID: UUID,
        runID: UUID,
        request: AgentGatewayWorkToolCall,
        lease: AgentGatewayLeaseBinding
    ) async throws -> WorkControlDTO {
        try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard let run = try await Self.lockGatewayRun(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID
            ) else {
                throw HTTPError(.notFound, message: "agent run not found")
            }

            let requestJSON = request.auditRequestJSON
            let existingRows = try await conn.query(
                """
                SELECT target_id, detail->'request' = \(requestJSON)::jsonb
                  FROM audit_log
                 WHERE workspace_id = \(workspaceID)
                   AND run_id = \(runID)
                   AND action = 'agent.gateway.work_tool'
                   AND target_type = 'work_control'
                   AND detail->>'call_id' = \(request.callId)
                 ORDER BY created_at DESC
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            if let existingRow = existingRows.first {
                let (controlID, sameRequest) = try existingRow.decode((UUID, Bool).self)
                guard sameRequest else {
                    throw HTTPError(
                        .conflict,
                        message: "gateway work tool call_id was reused with different input"
                    )
                }
                guard try await Self.gatewayLeaseIsAuthorized(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    runID: runID,
                    agentID: run.agentMemberID,
                    lease: lease,
                    allowSettled: true
                ) else { try Self.rejectGatewayLease() }
                guard let existing = try await WorkControlRoutes.fetchControl(
                    conn: conn,
                    logger: db.logger,
                    controlID: controlID
                ) else {
                    throw HTTPError(
                        .internalServerError,
                        message: "gateway work control audit binding is missing"
                    )
                }
                return existing
            }

            guard try await Self.gatewayLeaseIsAuthorized(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID,
                agentID: run.agentMemberID,
                lease: lease,
                allowSettled: false
            ) else { try Self.rejectGatewayLease() }
            guard run.status == "queued" || run.status == "running" else {
                throw HTTPError(
                    .conflict,
                    message: "agent run is not eligible for a gateway work tool"
                )
            }

            let control = try await WorkControlRoutes.createControl(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                principal: principal,
                request: try request.createRequest(channelID: run.channelID, runID: runID)
            )
            let controlID = UUID(uuidString: control.id)!
            let detail = Self.jsonString([
                "schema": "momo.agent_gateway.work_tool.v1",
                "call_id": request.callId,
                "source": "hermes_gateway",
                "request": Self.jsonObject(requestJSON),
                "control_status": control.status,
            ])
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, run_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID),
                   'agent.gateway.work_tool', 'work_control', \(controlID),
                   \(principal.tokenID), \(runID), \(detail)::jsonb)
                """,
                logger: db.logger
            )
            if control.status == "pending_approval" {
                try await Self.settleGatewayJobForApproval(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    runID: runID,
                    lease: lease
                )
            }
            return control
        }
    }

    private func recordApprovalRequest(
        principal: AuthPrincipal?,
        workspaceID: UUID,
        runID: UUID,
        request: AgentGatewayApprovalRequest,
        lease: AgentGatewayLeaseBinding
    ) async throws -> GatewayEventResult {
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        return try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard let run = try await Self.lockGatewayRun(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID
            ) else { return GatewayEventResult.notFound }

            let existing = try await conn.query(
                """
                SELECT id
                  FROM approval
                 WHERE workspace_id = \(workspaceID)
                   AND run_id = \(runID)
                   AND status = 'pending'
                   AND payload #>> '{tool_call,call_id}' = \(request.toolCall.callId)
                 ORDER BY created_at DESC
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            if !existing.isEmpty {
                guard run.status == "awaiting_approval" else {
                    return GatewayEventResult.runConflict(
                        message: "approval request retry does not match run state"
                    )
                }
                guard try await Self.gatewayLeaseIsAuthorized(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    runID: runID,
                    agentID: run.agentMemberID,
                    lease: lease,
                    allowSettled: true
                ) else { return GatewayEventResult.leaseRejected }
                try await Self.settleGatewayJobForApproval(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    runID: runID,
                    lease: lease
                )
                return GatewayEventResult.accepted
            }

            guard try await Self.gatewayLeaseIsAuthorized(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID,
                agentID: run.agentMemberID,
                lease: lease,
                allowSettled: false
            ) else { return GatewayEventResult.leaseRejected }

            guard run.status == "queued" || run.status == "running" else {
                return GatewayEventResult.runConflict(
                    message: "agent run is not eligible for an approval request"
                )
            }

            let approvalPayload = Self.approvalPayload(runID: runID, request: request)
            let approvalRows = try await conn.query(
                """
                INSERT INTO approval
                  (workspace_id, run_id, channel_id, requested_by,
                   action_type, payload, status)
                VALUES
                  (\(workspaceID), \(runID), \(run.channelID), \(run.agentMemberID),
                   \(request.actionType), \(approvalPayload)::jsonb, 'pending')
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard let approvalID = try approvalRows.first?.decode(UUID.self) else {
                throw HTTPError(.internalServerError, message: "approval insert failed")
            }

            let props = Self.approvalRequestProps(
                approvalID: approvalID,
                runID: runID,
                channelID: run.channelID,
                request: request
            )
            let body = request.summary ?? "Approval required: \(request.toolCall.name)"
            let messageRows = try await conn.query(
                """
                WITH bumped AS (
                  UPDATE channel_seq
                     SET last_seq = last_seq + 1
                   WHERE channel_id = \(run.channelID)
                  RETURNING last_seq AS seq
                )
                INSERT INTO message
                  (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                   author_member_id, type, body, props, run_id)
                SELECT \(workspaceID), \(run.channelID), b.seq, \(hlcTs), 0,
                       \(run.agentMemberID), 'approval_request'::message_type,
                       \(body), \(props)::jsonb, \(runID)
                  FROM bumped b
                RETURNING id, seq
                """,
                logger: db.logger
            ).collect()
            guard let messageRow = messageRows.first else {
                throw HTTPError(.conflict, message: "approval channel sequence is unavailable")
            }
            let (messageID, seq) = try messageRow.decode((UUID, Int64).self)

            _ = try await conn.query(
                """
                UPDATE approval
                   SET request_message_id = \(messageID)
                 WHERE id = \(approvalID)
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                UPDATE agent_run
                   SET status = 'awaiting_approval',
                       updated_at = now()
                 WHERE id = \(runID)
                   AND status IN ('queued','running')
                """,
                logger: db.logger
            )

            let outboxPayload = Self.timelineBroadcastPayload(
                workspaceID: workspaceID,
                channelID: run.channelID,
                messageID: messageID,
                seq: seq,
                authorMemberID: run.agentMemberID,
                runID: runID,
                type: "approval_request",
                body: body,
                props: props,
                hlcTs: hlcTs
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish',
                   \(outboxPayload)::jsonb, \(run.channelID))
                """,
                logger: db.logger
            )

            let auditDetail = Self.jsonString([
                "schema": "momo.agent_gateway.approval_request.v0",
                "approval_id": approvalID.uuidString,
                "run_id": runID.uuidString,
                "source": "hermes_gateway",
                "request": Self.jsonObject(approvalPayload),
            ])
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, run_id, detail)
                VALUES
                  (\(workspaceID), \(run.agentMemberID),
                   'approval.requested', 'approval', \(approvalID),
                   \(principal?.tokenID), \(runID), \(auditDetail)::jsonb)
                """,
                logger: db.logger
            )
            try await Self.settleGatewayJobForApproval(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID,
                lease: lease
            )
            return GatewayEventResult.accepted
        }
    }

    @Sendable
    func complete(_ request: Request, context: AppRequestContext) async throws -> AgentGatewayCompleteResponse {
        try requireGatewayMode()
        let workspaceID = try Self.workspaceID(context)
        let principal = try Self.gatewayPrincipal(context, workspaceID: workspaceID)
        let runID = try Self.runID(context)
        try await requireRunActorBinding(
            principal: principal,
            workspaceID: workspaceID,
            runID: runID
        )
        let dto = try await request.decode(as: AgentGatewayCompleteRequest.self, context: context)
        let memoryDelivery = try dto.memoryDelivery?.validated()
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)

        let result = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard let run = try await Self.lockGatewayRun(
                conn: conn, logger: db.logger, workspaceID: workspaceID, runID: runID)
            else {
                return CompletionResult.notFound
            }
            if Self.completionPreLeaseDisposition(for: run.status) == .approvalHeld {
                return CompletionResult.approvalHeld(status: run.status)
            }
            guard let lease = dto.leaseBinding else {
                return CompletionResult.leaseRejected
            }
            guard try await Self.gatewayLeaseIsAuthorized(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                runID: runID,
                agentID: run.agentMemberID,
                lease: lease,
                allowSettled: Self.isTerminalRunStatus(run.status)
            ) else { return CompletionResult.leaseRejected }
            if Self.isTerminalRunStatus(run.status),
               let existing = try await Self.existingFinalMessage(
                conn: conn,
                logger: db.logger,
                channelID: run.channelID,
                agentMemberID: run.agentMemberID,
                runID: runID
               ) {
                return CompletionResult.completed(
                    messageID: existing.messageID,
                    seq: existing.seq,
                    status: run.status
                )
            }
            if Self.isTerminalRunStatus(run.status) {
                return CompletionResult.terminal(status: run.status)
            }

            let completionStatus = try Self.normalizedCompletionStatus(
                dto.status,
                error: dto.error
            )
            let safeError = Self.sanitizedGatewayError(dto.error, gatewaySecret: config.secret)
            let body = Self.timelineBody(
                dto: dto,
                status: completionStatus,
                safeError: safeError
            )
            let messageType = completionStatus == "succeeded" ? "text" : "system"
            let props = Self.timelineProps(
                run: run,
                runID: runID,
                status: completionStatus,
                usage: dto.usage,
                error: safeError
            )

            let rows = try await conn.query(
                """
                WITH bumped AS (
                  UPDATE channel_seq
                     SET last_seq = last_seq + 1
                   WHERE channel_id = \(run.channelID)
                  RETURNING last_seq AS seq
                )
                INSERT INTO message
                  (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                   author_member_id, type, body, props, run_id, client_msg_id)
                SELECT \(workspaceID), \(run.channelID), b.seq, \(hlcTs), 0,
                       \(run.agentMemberID), \(messageType)::message_type,
                       \(body), \(props)::jsonb, \(runID), \(runID)
                  FROM bumped b
                ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING
                RETURNING id, seq
                """,
                logger: db.logger
            ).collect()

            let messageID: UUID
            let seq: Int64
            let didInsert: Bool
            if let first = rows.first {
                (messageID, seq) = try first.decode((UUID, Int64).self)
                didInsert = true
            } else {
                let existing = try await conn.query(
                    """
                    SELECT id, seq
                      FROM message
                     WHERE channel_id = \(run.channelID)
                       AND author_member_id = \(run.agentMemberID)
                       AND client_msg_id = \(runID)
                     LIMIT 1
                    """,
                    logger: db.logger
                ).collect()
                guard let row = existing.first else {
                    throw HTTPError(.conflict, message: "gateway final message idempotency conflict")
                }
                (messageID, seq) = try row.decode((UUID, Int64).self)
                didInsert = false
            }

            if didInsert, messageType == "text" {
                _ = try await ReadStateMentions.record(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    channelID: run.channelID,
                    messageID: messageID,
                    messageSeq: seq,
                    authorMemberID: run.agentMemberID,
                    body: body
                )
            }

            let outboxPayload = Self.timelineBroadcastPayload(
                workspaceID: workspaceID,
                channelID: run.channelID,
                messageID: messageID,
                seq: seq,
                authorMemberID: run.agentMemberID,
                runID: runID,
                type: messageType,
                body: body,
                props: props,
                hlcTs: hlcTs
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish',
                   \(outboxPayload)::jsonb, \(run.channelID))
                """,
                logger: db.logger
            )

            try await Self.reconcileUsage(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                run: run,
                runID: runID,
                usage: dto.usage
            )

            let outputJSON = Self.outputJSON(dto: dto, status: completionStatus, messageID: messageID)
            let errorJSON = Self.errorJSON(error: safeError, status: completionStatus)
            if completionStatus == "succeeded" {
                _ = try await conn.query(
                    """
                    UPDATE agent_run
                       SET status = 'succeeded',
                           output = \(outputJSON)::jsonb,
                           error = NULL,
                           updated_at = now(),
                           finished_at = now()
                     WHERE id = \(runID)
                    """,
                    logger: db.logger
                )
            } else {
                _ = try await conn.query(
                    """
                    UPDATE agent_run
                       SET status = 'failed',
                           output = \(outputJSON)::jsonb,
                           error = \(errorJSON)::jsonb,
                           updated_at = now(),
                           finished_at = now()
                     WHERE id = \(runID)
                    """,
                    logger: db.logger
                )
            }

            if let memoryDelivery {
                _ = try await conn.query(
                    """
                    UPDATE agent_run
                       SET input = jsonb_set(
                             input,
                             '{memory_delivery}',
                             jsonb_build_object(
                               'included_count', \(memoryDelivery.includedCount)::integer,
                               'injected', \(memoryDelivery.injected)
                             ),
                             true
                           ),
                           updated_at = now()
                     WHERE id = \(runID)
                    """,
                    logger: db.logger
                )
            }

            _ = try await conn.query(
                """
                UPDATE outbox
                   SET status = 'done',
                       processed_at = now(),
                       last_error = CASE
                         WHEN \(completionStatus) = 'succeeded' THEN NULL
                         ELSE \(safeError ?? "gateway reported failure")
                       END
                 WHERE workspace_id = \(workspaceID)
                   AND id = \(lease.jobID)
                   AND kind = 'agent_job'
                   AND method = 'gateway'
                   AND lease_owner = \(lease.leaseID)
                   AND payload->>'run_id' = \(runID.uuidString)
                """,
                logger: db.logger
            )

            let detail = Self.jsonString([
                "schema": "momo.agent_gateway.completed.v0",
                "status": completionStatus,
                "run_id": runID.uuidString,
                "message_id": messageID.uuidString,
                "usage": dto.usage?.asObject() as Any,
                "memory_delivery": memoryDelivery?.asObject() as Any,
                "source": "hermes_gateway",
            ])
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, run_id, detail)
                VALUES
                  (\(workspaceID), \(run.agentMemberID),
                   'agent.gateway.completed', 'agent_run', \(runID),
                   \(principal?.tokenID), \(runID),
                   \(detail)::jsonb)
                """,
                logger: db.logger
            )

            return CompletionResult.completed(messageID: messageID, seq: seq, status: completionStatus)
        }

        switch result {
        case .notFound:
            throw HTTPError(.notFound, message: "agent run not found")
        case .terminal(let status):
            throw HTTPError(
                .conflict,
                message: "agent run is already terminal (\(status))"
            )
        case .approvalHeld(let status):
            throw HTTPError(
                .conflict,
                message: "agent run requires a human approval decision (\(status))"
            )
        case .leaseRejected:
            try Self.rejectGatewayLease()
        case .completed(let messageID, let seq, let status):
            return AgentGatewayCompleteResponse(
                status: status,
                runId: runID.uuidString,
                messageId: messageID.uuidString,
                seq: seq
            )
        }
    }

    private enum CompletionResult {
        case notFound
        case terminal(status: String)
        case approvalHeld(status: String)
        case leaseRejected
        case completed(messageID: UUID, seq: Int64, status: String)
    }

    private enum GatewayEventResult {
        // Expected 4xx outcomes must cross the Postgres transaction as values.
        // PostgresNIO wraps errors thrown by the closure in PostgresTransactionError.
        case notFound
        case leaseRejected
        case runConflict(message: String)
        case accepted
    }

    enum CompletionPreLeaseDisposition: Equatable {
        case approvalHeld
        case requireLease
    }

    private struct ExistingFinalMessage {
        let messageID: UUID
        let seq: Int64
    }

    private struct GatewayRunSnapshot {
        let agentMemberID: UUID
        let channelID: UUID
        let status: String
        let model: String
    }

    struct GatewayLeaseSnapshot: Equatable, Sendable {
        let status: String
        let owner: UUID?
        let active: Bool
    }

    struct GatewayClaimSnapshot: Equatable, Sendable {
        let status: String
        let available: Bool
        let leaseActive: Bool
    }

    private func requireGatewayMode() throws {
        guard config.enabled else {
            throw HTTPError(.forbidden, message: "agent gateway mode is disabled")
        }
    }

    private func requireRunActorBinding(
        principal: AuthPrincipal?,
        workspaceID: UUID,
        runID: UUID
    ) async throws {
        guard let principal else { return }
        let targetAgentID: UUID? = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT agent_member_id
                  FROM agent_run
                 WHERE id = \(runID)
                   AND workspace_id = \(workspaceID)
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(UUID.self)
        }
        guard let targetAgentID else { return }
        guard Self.runActorBindingAllows(
            principalMemberID: principal.memberID,
            runAgentMemberID: targetAgentID
        ) else {
            try Self.rejectRunActorBinding()
        }
    }

    static func runActorBindingAllows(
        principalMemberID: UUID?,
        runAgentMemberID: UUID?
    ) -> Bool {
        guard let principalMemberID, let runAgentMemberID else { return true }
        return principalMemberID == runAgentMemberID
    }

    static func rejectRunActorBinding() throws -> Never {
        throw HTTPError(.forbidden, message: "agent bearer actor does not match run agent")
    }

    private static func lockGatewayRun(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        runID: UUID
    ) async throws -> GatewayRunSnapshot? {
        let rows = try await conn.query(
            """
            SELECT r.agent_member_id, r.channel_id, r.status::text, a.model
              FROM agent_run r
              JOIN member m
                ON m.id = r.agent_member_id
               AND m.workspace_id = \(workspaceID)
               AND m.kind = 'agent'
               AND m.status = 'active'
              JOIN agent a
                ON a.member_id = m.id
               AND a.workspace_id = \(workspaceID)
             WHERE r.id = \(runID)
               AND r.workspace_id = \(workspaceID)
               AND EXISTS (
                 SELECT 1
                   FROM membership ms
                  WHERE ms.workspace_id = \(workspaceID)
                    AND ms.channel_id = r.channel_id
                    AND ms.member_id = r.agent_member_id
                    AND ms.left_at IS NULL
               )
             FOR UPDATE OF r
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let (agentID, channelID, status, model) = try row.decode((UUID, UUID, String, String).self)
        return GatewayRunSnapshot(
            agentMemberID: agentID,
            channelID: channelID,
            status: status,
            model: model
        )
    }

    private static func gatewayLeaseIsAuthorized(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        runID: UUID,
        agentID: UUID,
        lease: AgentGatewayLeaseBinding,
        allowSettled: Bool
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT status::text, lease_owner,
                   COALESCE(lease_expires_at > now(), false)
              FROM outbox
             WHERE id = \(lease.jobID)
               AND workspace_id = \(workspaceID)
               AND kind = 'agent_job'
               AND method = 'gateway'
               AND partition_key = \(agentID)
               AND payload->>'agent_member_id' = \(agentID.uuidString)
               AND payload->>'run_id' = \(runID.uuidString)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        let snapshot = try rows.first.map { row in
            let (status, owner, active) = try row.decode((String, UUID?, Bool).self)
            return GatewayLeaseSnapshot(status: status, owner: owner, active: active)
        }
        return gatewayLeaseAuthorized(
            snapshot: snapshot,
            presentedLeaseID: lease.leaseID,
            allowSettled: allowSettled
        )
    }

    static func gatewayLeaseAuthorized(
        snapshot: GatewayLeaseSnapshot?,
        presentedLeaseID: UUID,
        allowSettled: Bool
    ) -> Bool {
        guard let snapshot, snapshot.owner == presentedLeaseID else { return false }
        return (snapshot.status == "pending" && snapshot.active)
            || (snapshot.status == "done" && allowSettled)
    }

    static func gatewayClaimEligible(snapshot: GatewayClaimSnapshot) -> Bool {
        // Mirrors the pending claim CTE eligibility contract above.
        snapshot.status == "pending" && snapshot.available && !snapshot.leaseActive
    }

    static func rejectGatewayLease() throws -> Never {
        throw HTTPError(.conflict, message: "gateway job lease is expired or not owned")
    }

    static func isTerminalRunStatus(_ status: String) -> Bool {
        status == "succeeded" || status == "failed" || status == "cancelled"
            || status == "timed_out"
    }

    static func isApprovalHeldRunStatus(_ status: String) -> Bool {
        status == "awaiting_approval" || status == "paused"
    }

    static func completionPreLeaseDisposition(
        for runStatus: String
    ) -> CompletionPreLeaseDisposition {
        isApprovalHeldRunStatus(runStatus) ? .approvalHeld : .requireLease
    }

    private static func existingFinalMessage(
        conn: PostgresConnection,
        logger: Logger,
        channelID: UUID,
        agentMemberID: UUID,
        runID: UUID
    ) async throws -> ExistingFinalMessage? {
        let rows = try await conn.query(
            """
            SELECT id, seq
              FROM message
             WHERE channel_id = \(channelID)
               AND author_member_id = \(agentMemberID)
               AND client_msg_id = \(runID)
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let (messageID, seq) = try row.decode((UUID, Int64).self)
        return ExistingFinalMessage(messageID: messageID, seq: seq)
    }

    private static func reconcileUsage(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        run: GatewayRunSnapshot,
        runID: UUID,
        usage: AgentGatewayUsage?
    ) async throws {
        let promptTokens = usage?.promptTokens ?? 0
        let completionTokens = usage?.completionTokens ?? 0
        let cachedTokens = usage?.cachedTokens ?? 0
        let reasoningTokens = usage?.reasoningTokens ?? 0
        let costMicroUSD = usage?.costMicroUsd ?? 0
        let wasEstimated = usage == nil || (usage?.wasEstimated ?? true)

        _ = try await conn.query(
            """
            INSERT INTO usage_ledger
              (workspace_id, run_id, agent_member_id, channel_id, model,
               prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
               cost_micro_usd, was_estimated)
            SELECT \(workspaceID), \(runID), \(run.agentMemberID), \(run.channelID),
                   \(usage?.model ?? run.model), \(promptTokens), \(completionTokens),
                   \(cachedTokens), \(reasoningTokens), \(costMicroUSD), \(wasEstimated)
            WHERE NOT EXISTS (
              SELECT 1 FROM usage_ledger
               WHERE workspace_id = \(workspaceID)
                 AND run_id = \(runID)
            )
            """,
            logger: logger
        )
    }

    private static func workspaceID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("ws")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        return id
    }

    private static func agentID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("agent")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid agent id")
        }
        return id
    }

    private static func jobID(_ context: AppRequestContext) throws -> Int64 {
        let raw = try context.parameters.require("job")
        guard let id = Int64(raw), id > 0 else {
            throw HTTPError(.badRequest, message: "invalid gateway job id")
        }
        return id
    }

    private static func gatewayPrincipal(
        _ context: AppRequestContext,
        workspaceID: UUID
    ) throws -> AuthPrincipal? {
        if context.usedLegacyAgentGatewaySecret {
            return nil
        }
        let principal = try context.requirePrincipal()
        guard principal.kind == .agent else {
            throw HTTPError(.forbidden, message: "agent bearer required")
        }
        guard principal.workspaceID == workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return principal
    }

    private static func isActiveAgent(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        agentID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member m
              JOIN agent a
                ON a.member_id = m.id
               AND a.workspace_id = m.workspace_id
             WHERE m.id = \(agentID)
               AND m.workspace_id = \(workspaceID)
               AND m.kind = 'agent'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func runID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("run")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid run id")
        }
        return id
    }

    private static func normalizedStatus(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value.isEmpty ? "running" : value
    }

    static func normalizedCompletionStatus(_ raw: String?, error: String?) throws -> String {
        let status = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hasError = !(error?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        switch status {
        case nil, "":
            return hasError ? "failed" : "succeeded"
        case "failed", "error", "cancelled", "timed_out":
            return "failed"
        case "succeeded", "success", "done":
            guard !hasError else {
                throw HTTPError(
                    .badRequest,
                    message: "successful completion cannot include an error"
                )
            }
            return "succeeded"
        default:
            throw HTTPError(.badRequest, message: "unknown gateway completion status")
        }
    }

    private static func timelineBody(
        dto: AgentGatewayCompleteRequest,
        status: String,
        safeError: String?
    ) -> String {
        if status == "succeeded" {
            let text = dto.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return text.isEmpty ? "(Hermes gateway returned an empty response.)" : text
        }
        let reason = safeError?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let reason, !reason.isEmpty {
            return "Hermes gateway failed before producing a final response: \(reason)"
        }
        return "Hermes gateway failed before producing a final response."
    }

    private static func timelineProps(
        run: GatewayRunSnapshot,
        runID: UUID,
        status: String,
        usage: AgentGatewayUsage?,
        error: String?
    ) -> String {
        jsonString([
            "schema": "momo.agent_gateway.timeline.v0",
            "source": "hermes_gateway",
            "status": status,
            "run_id": runID.uuidString,
            "agent_member_id": run.agentMemberID.uuidString,
            "usage": usage?.asObject() as Any,
            "error": error as Any,
        ])
    }

    private static func outputJSON(
        dto: AgentGatewayCompleteRequest,
        status: String,
        messageID: UUID
    ) -> String {
        jsonString([
            "schema": "momo.agent_gateway.output.v0",
            "status": status,
            "body": dto.body as Any,
            "message_id": messageID.uuidString,
            "usage": dto.usage?.asObject() as Any,
        ])
    }

    private static func errorJSON(error: String?, status: String) -> String {
        guard status != "succeeded" else { return "{}" }
        return jsonString([
            "code": "hermes_gateway_failed",
            "message": error ?? "gateway reported failure",
            "source": "hermes_gateway",
        ])
    }

    static func sanitizedGatewayError(_ raw: String?, gatewaySecret: String) -> String? {
        guard var value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty
        else { return nil }
        if !gatewaySecret.isEmpty {
            value = value.replacingOccurrences(of: gatewaySecret, with: "[redacted]")
        }
        value = value.replacingOccurrences(
            of: #"momo_agent_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#,
            with: "[redacted-agent-token]",
            options: .regularExpression
        )
        value = value.replacingOccurrences(
            of: #"(?i)\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9._-]{8,})\b"#,
            with: "[redacted-provider-token]",
            options: .regularExpression
        )
        value = value.replacingOccurrences(
            of: #"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b"#,
            with: "[redacted-jwt]",
            options: .regularExpression
        )
        let sensitiveHints = ["bearer ", "authorization:", "api_key", "access_token", "refresh_token"]
        let lower = value.lowercased()
        if sensitiveHints.contains(where: { lower.contains($0) }) {
            value = "Hermes gateway reported an error with redacted credential-shaped content."
        }
        let maxLength = 1_000
        if value.count > maxLength {
            let prefix = String(value.prefix(maxLength))
            return "\(prefix)... [truncated]"
        }
        return value
    }

    private static func settleGatewayJobForApproval(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        runID: UUID,
        lease: AgentGatewayLeaseBinding
    ) async throws {
        _ = try await conn.query(
            """
            UPDATE outbox
               SET status = 'done',
                   processed_at = now(),
                   last_error = NULL
             WHERE workspace_id = \(workspaceID)
               AND id = \(lease.jobID)
               AND kind = 'agent_job'
               AND method = 'gateway'
               AND status = 'pending'
               AND lease_owner = \(lease.leaseID)
               AND payload->>'run_id' = \(runID.uuidString)
            """,
            logger: logger
        )
    }

    static func approvalPayload(
        runID: UUID,
        request: AgentGatewayApprovalRequest
    ) -> String {
        var toolCall: [String: Any] = [
            "call_id": request.toolCall.callId,
            "name": request.toolCall.name,
            "arguments": jsonValue(request.toolCall.arguments),
        ]
        if let toolGrant = request.toolCall.toolGrant {
            toolCall["tool_grant"] = jsonValue(toolGrant)
        }
        var payload: [String: Any] = [
            "run_id": runID.uuidString,
            "action_type": request.actionType,
            "tier": request.tier.rawValue,
            "tool_call": toolCall,
            "resume_model": "gateway_resume_agent_job",
            "source": "hermes_gateway",
        ]
        if let estimatedMicroUsd = request.estimatedMicroUsd {
            payload["estimated_micro_usd"] = estimatedMicroUsd
        }
        if let isReversible = request.isReversible {
            payload["is_reversible"] = isReversible
        }
        return jsonString(payload)
    }

    private static func approvalRequestProps(
        approvalID: UUID,
        runID: UUID,
        channelID: UUID,
        request: AgentGatewayApprovalRequest
    ) -> String {
        var props: [String: Any] = [
            "approval_id": approvalID.uuidString,
            "run_id": runID.uuidString,
            "channel_id": channelID.uuidString,
            "action_type": request.actionType,
            "tier": request.tier.rawValue,
            "call_id": request.toolCall.callId,
            "tool_name": request.toolCall.name,
            "title": request.title ?? "Approve \(request.toolCall.name)",
            "summary": request.summary
                ?? "Review the proposed tool call before Hermes executes it.",
            "arguments": jsonValue(request.toolCall.arguments),
            "status": "pending",
            "source": "hermes_gateway",
        ]
        if let toolGrant = request.toolCall.toolGrant {
            props["tool_grant"] = jsonValue(toolGrant)
        }
        if let estimatedMicroUsd = request.estimatedMicroUsd {
            props["estimated_micro_usd"] = estimatedMicroUsd
        }
        if let isReversible = request.isReversible {
            props["is_reversible"] = isReversible
        }
        return jsonString(props)
    }

    private static func jsonValue(_ value: JSONValue) -> Any {
        switch value {
        case .object(let object):
            return object.mapValues(jsonValue)
        case .array(let array):
            return array.map(jsonValue)
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

    private static func agentStatusBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        agentMemberID: UUID,
        runID: UUID,
        status: String,
        detail: String?,
        eventID: UUID
    ) -> String {
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        let centChannel = "agent:ws\(workspaceID.uuidString).\(channelID.uuidString).\(agentMemberID.uuidString)"
        let projection = agentStatusProjection(status)
        return jsonString([
            "channel": centChannel,
            "data": [
                "type": "agent.status",
                "v": 1,
                "ts": hlcTs,
                "payload": [
                    "run_id": runID.uuidString,
                    "agent_member_id": agentMemberID.uuidString,
                    "channel_id": channelID.uuidString,
                    "phase": projection.phase,
                    "run_status": projection.runStatus,
                    "detail": detail as Any,
                    "source": "hermes_gateway",
                ],
            ],
            "idempotency_key": "\(centChannel):gateway:\(eventID.uuidString):status",
        ])
    }

    private static func agentPartialBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        agentMemberID: UUID,
        runID: UUID,
        textDelta: String,
        eventID: UUID
    ) -> String {
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        let centChannel = "agent:ws\(workspaceID.uuidString).\(channelID.uuidString).\(agentMemberID.uuidString)"
        return jsonString([
            "channel": centChannel,
            "data": [
                "type": "agent.partial",
                "v": 1,
                "ts": hlcTs,
                "payload": [
                    "run_id": runID.uuidString,
                    "agent_member_id": agentMemberID.uuidString,
                    "channel_id": channelID.uuidString,
                    "text_delta": textDelta,
                    "source": "hermes_gateway",
                ],
            ],
            "idempotency_key": "\(centChannel):gateway:\(eventID.uuidString):partial",
        ])
    }

    private static func agentStatusProjection(_ status: String) -> (phase: String, runStatus: String) {
        switch status {
        case "streaming":
            return ("streaming", "running")
        case "cancelled":
            return ("error", "cancelled")
        default:
            return ("thinking", "running")
        }
    }

    private static func timelineBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        seq: Int64,
        authorMemberID: UUID,
        runID: UUID,
        type: String,
        body: String,
        props: String,
        hlcTs: Int64
    ) -> String {
        let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        return jsonString([
            "channel": centChannel,
            "data": [
                "type": "message.new",
                "v": 1,
                "ts": hlcTs,
                "seq": seq,
                "payload": [
                    "id": messageID.uuidString,
                    "channel_id": channelID.uuidString,
                    "channelId": channelID.uuidString,
                    "seq": seq,
                    "type": type,
                    "body": body,
                    "props": jsonObject(props),
                    "author_member_id": authorMemberID.uuidString,
                    "authorMemberId": authorMemberID.uuidString,
                    "run_id": runID.uuidString,
                    "runId": runID.uuidString,
                    "hlc_ts": hlcTs,
                    "hlcTs": hlcTs,
                    "hlc_count": 0,
                    "hlcCount": 0,
                ],
            ],
            "version": seq,
            "idempotency_key": "\(centChannel):\(seq)",
        ])
    }

    private static func jsonObject(_ json: String) -> Any {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data)
        else { return [:] }
        return object
    }

    private static func jsonString(_ object: Any) -> String {
        let normalized = normalizeJSON(object)
        guard JSONSerialization.isValidJSONObject(normalized),
              let data = try? JSONSerialization.data(
                withJSONObject: normalized, options: [.sortedKeys]),
              let str = String(data: data, encoding: .utf8)
        else { return "{}" }
        return str
    }

    private static func normalizeJSON(_ value: Any) -> Any {
        switch value {
        case Optional<Any>.none:
            return NSNull()
        case let dict as [String: Any]:
            return dict.mapValues { normalizeJSON($0) }
        case let array as [Any]:
            return array.map { normalizeJSON($0) }
        case let value as String:
            return value
        case let value as Int:
            return value
        case let value as Int64:
            return value
        case let value as Double:
            return value
        case let value as Bool:
            return value
        case _ as NSNull:
            return NSNull()
        default:
            return NSNull()
        }
    }
}

struct AgentGatewayEventRequest: Decodable {
    static let maximumDetailBytes = 2_048
    static let maximumTextDeltaBytes = 8_192

    let eventID: UUID?
    let jobID: Int64?
    let leaseID: UUID?
    let status: String?
    let detail: String?
    let textDelta: String?
    let approvalRequest: AgentGatewayApprovalRequest?
    let toolCall: AgentGatewayWorkToolCall?

    private enum CodingKeys: String, CodingKey {
        case eventID = "event_id"
        case jobID = "job_id"
        case leaseID = "lease_id"
        case status
        case detail
        case textDelta = "text_delta"
        case approvalRequest = "approval_request"
        case toolCall = "tool_call"
    }

    func validatedLease() throws -> AgentGatewayLeaseBinding {
        guard let leaseBinding else {
            throw HTTPError(.badRequest, message: "job_id and lease_id are required")
        }
        return leaseBinding
    }

    var leaseBinding: AgentGatewayLeaseBinding? {
        guard let jobID, jobID > 0, let leaseID else { return nil }
        return AgentGatewayLeaseBinding(jobID: jobID, leaseID: leaseID)
    }

    func validatedProgress(status: String) throws -> AgentGatewayProgressEvent {
        guard ["running", "thinking", "streaming", "cancelled"].contains(status) else {
            throw HTTPError(.badRequest, message: "unknown gateway event status")
        }
        let detail = try Self.bounded(detail, field: "detail", limit: Self.maximumDetailBytes)
        let delta = try Self.bounded(
            textDelta,
            field: "text_delta",
            limit: Self.maximumTextDeltaBytes
        )
        if status == "streaming" {
            guard let delta, !delta.isEmpty else {
                throw HTTPError(.badRequest, message: "streaming event requires text_delta")
            }
        } else if delta != nil {
            throw HTTPError(.badRequest, message: "text_delta is only valid for streaming events")
        }
        return AgentGatewayProgressEvent(
            eventID: eventID ?? UUID(),
            detail: detail,
            textDelta: delta
        )
    }

    private static func bounded(_ raw: String?, field: String, limit: Int) throws -> String? {
        guard let raw else { return nil }
        guard raw.utf8.count <= limit else {
            throw HTTPError(.badRequest, message: "\(field) is too large")
        }
        return raw
    }
}

struct AgentGatewayWorkToolCall: Decodable, Equatable, Sendable {
    static let supportedNames = ["work.spawn", "work.input", "work.read", "work.kill"]

    let callId: String
    let name: String
    let targetHostId: UUID
    let arguments: JSONValue

    private enum CodingKeys: String, CodingKey {
        case callId = "call_id"
        case name
        case targetHostId = "target_host_id"
        case arguments
    }

    private init(callId: String, name: String, targetHostId: UUID, arguments: JSONValue) {
        self.callId = callId
        self.name = name
        self.targetHostId = targetHostId
        self.arguments = arguments
    }

    func validated() throws -> AgentGatewayWorkToolCall {
        let callId = callId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !callId.isEmpty, callId.count <= 512 else {
            throw HTTPError(
                .badRequest,
                message: "tool_call.call_id must contain 1...512 characters"
            )
        }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.supportedNames.contains(name) else {
            throw HTTPError(
                .badRequest,
                message: "gateway work tool must be work.spawn, work.input, work.read, or work.kill"
            )
        }
        guard arguments.objectValue != nil else {
            throw HTTPError(.badRequest, message: "tool_call.arguments must be an object")
        }
        guard (try? JSONEncoder().encode(arguments).count).map({ $0 <= 65_536 }) == true else {
            throw HTTPError(.badRequest, message: "tool_call.arguments is too large")
        }
        return AgentGatewayWorkToolCall(
            callId: callId,
            name: name,
            targetHostId: targetHostId,
            arguments: arguments
        )
    }

    func createRequest(channelID: UUID, runID: UUID) throws -> CreateWorkControlRequest {
        guard let object = arguments.objectValue else {
            throw HTTPError(.badRequest, message: "tool_call.arguments must be an object")
        }
        let kind: WorkControlRoutes.Kind
        let sessionID: UUID?
        let payload: JSONValue

        func requiredSessionID(_ value: JSONValue?) throws -> UUID {
            guard let raw = value?.stringValue, let id = UUID(uuidString: raw) else {
                throw HTTPError(.badRequest, message: "tool_call.arguments.session_id must be a UUID")
            }
            return id
        }

        switch name {
        case "work.spawn":
            guard Set(object.keys) == ["tool", "label"] else {
                throw HTTPError(.badRequest, message: "work.spawn accepts only tool and label")
            }
            kind = .spawn
            sessionID = nil
            payload = arguments
        case "work.input":
            guard Set(object.keys) == ["session_id", "text"] else {
                throw HTTPError(.badRequest, message: "work.input accepts only session_id and text")
            }
            kind = .input
            sessionID = try requiredSessionID(object["session_id"])
            payload = .object(["text": object["text"] ?? .null])
        case "work.read":
            guard Set(object.keys).isSubset(of: ["session_id", "tail_lines"]),
                  object["session_id"] != nil
            else {
                throw HTTPError(
                    .badRequest,
                    message: "work.read requires session_id and accepts optional tail_lines"
                )
            }
            kind = .read
            sessionID = try requiredSessionID(object["session_id"])
            payload = .object(object.filter { $0.key == "tail_lines" })
        case "work.kill":
            guard Set(object.keys) == ["session_id"] else {
                throw HTTPError(.badRequest, message: "work.kill accepts only session_id")
            }
            kind = .kill
            sessionID = try requiredSessionID(object["session_id"])
            payload = .object([:])
        default:
            throw HTTPError(.badRequest, message: "unknown gateway work tool")
        }
        _ = try WorkControlRoutes.validatedPayload(payload, kind: kind)
        return CreateWorkControlRequest(
            channelId: channelID,
            runId: runID,
            targetHostId: targetHostId,
            sessionId: sessionID,
            kind: kind.rawValue,
            payload: payload
        )
    }

    var auditRequestJSON: String {
        let value = JSONValue.object([
            "name": .string(name),
            "target_host_id": .string(targetHostId.uuidString.lowercased()),
            "arguments": arguments,
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value),
              let json = String(data: data, encoding: .utf8)
        else { return "{}" }
        return json
    }
}

struct AgentGatewayProgressEvent: Equatable, Sendable {
    let eventID: UUID
    let detail: String?
    let textDelta: String?
}

struct AgentGatewayApprovalRequest: Decodable, Equatable, Sendable {
    let actionType: String
    let tier: AgentGatewayApprovalTier
    let title: String?
    let summary: String?
    let toolCall: AgentGatewayApprovalToolCall
    let estimatedMicroUsd: Int64?
    let isReversible: Bool?

    private enum CodingKeys: String, CodingKey {
        case actionType = "action_type"
        case tier
        case title
        case summary
        case toolCall = "tool_call"
        case estimatedMicroUsd = "estimated_micro_usd"
        case isReversible = "is_reversible"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        actionType = try container.decodeIfPresent(String.self, forKey: .actionType)
            ?? "tool_call"
        tier = try AgentGatewayApprovalTier.validated(
            container.decodeIfPresent(String.self, forKey: .tier)
        )
        title = try container.decodeIfPresent(String.self, forKey: .title)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        toolCall = try container.decode(AgentGatewayApprovalToolCall.self, forKey: .toolCall)
        estimatedMicroUsd = try container.decodeIfPresent(Int64.self, forKey: .estimatedMicroUsd)
        isReversible = try container.decodeIfPresent(Bool.self, forKey: .isReversible)
    }

    private init(
        actionType: String,
        tier: AgentGatewayApprovalTier,
        title: String?,
        summary: String?,
        toolCall: AgentGatewayApprovalToolCall,
        estimatedMicroUsd: Int64?,
        isReversible: Bool?
    ) {
        self.actionType = actionType
        self.tier = tier
        self.title = title
        self.summary = summary
        self.toolCall = toolCall
        self.estimatedMicroUsd = estimatedMicroUsd
        self.isReversible = isReversible
    }

    func validated() throws -> AgentGatewayApprovalRequest {
        let actionType = try Self.required(actionType, field: "action_type", limit: 128)
        let title = Self.optional(title, limit: 500)
        let summary = Self.optional(summary, limit: 2_000)
        guard estimatedMicroUsd.map({ $0 >= 0 }) ?? true else {
            throw HTTPError(.badRequest, message: "estimated_micro_usd must be non-negative")
        }
        return AgentGatewayApprovalRequest(
            actionType: actionType,
            tier: tier,
            title: title,
            summary: summary,
            toolCall: try toolCall.validated(),
            estimatedMicroUsd: estimatedMicroUsd,
            isReversible: isReversible
        )
    }

    private static func required(_ raw: String, field: String, limit: Int) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw HTTPError(.badRequest, message: "\(field) is required")
        }
        guard value.count <= limit else {
            throw HTTPError(.badRequest, message: "\(field) is too long")
        }
        return value
    }

    private static func optional(_ raw: String?, limit: Int) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty
        else { return nil }
        return String(value.prefix(limit))
    }
}

enum AgentGatewayApprovalTier: String, Codable, Equatable, Sendable {
    case readOnly = "read_only"
    case workspaceWrite = "workspace_write"
    case networkWrite = "network_write"

    /// Missing tier is the conservative legacy bridge for MOMO-349 Hermes
    /// callbacks. It still requires approval; new work adapters send it explicitly.
    static func validated(_ raw: String?) throws -> AgentGatewayApprovalTier {
        guard let raw else { return .workspaceWrite }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case AgentGatewayApprovalTier.readOnly.rawValue:
            return .readOnly
        case AgentGatewayApprovalTier.workspaceWrite.rawValue:
            return .workspaceWrite
        case AgentGatewayApprovalTier.networkWrite.rawValue:
            return .networkWrite
        case "danger", "danger_full_access", "danger-full-access", "full_access", "full-access":
            throw HTTPError(.badRequest, message: "danger approval tier is not allowed")
        default:
            throw HTTPError(.badRequest, message: "unknown approval tier")
        }
    }
}

struct AgentGatewayApprovalToolCall: Decodable, Equatable, Sendable {
    let callId: String
    let name: String
    let arguments: JSONValue
    let toolGrant: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case callId = "call_id"
        case name
        case arguments
        case toolGrant = "tool_grant"
    }

    private init(
        callId: String,
        name: String,
        arguments: JSONValue,
        toolGrant: JSONValue?
    ) {
        self.callId = callId
        self.name = name
        self.arguments = arguments
        self.toolGrant = toolGrant
    }

    func validated() throws -> AgentGatewayApprovalToolCall {
        let callId = try required(callId, field: "tool_call.call_id", limit: 512)
        let name = try required(name, field: "tool_call.name", limit: 256)
        guard (try? JSONEncoder().encode(arguments).count).map({ $0 <= 65_536 }) == true else {
            throw HTTPError(.badRequest, message: "tool_call.arguments is too large")
        }
        if let toolGrant, toolGrant.objectValue == nil {
            throw HTTPError(.badRequest, message: "tool_call.tool_grant must be an object")
        }
        if let toolGrant,
           (try? JSONEncoder().encode(toolGrant).count).map({ $0 <= 32_768 }) != true
        {
            throw HTTPError(.badRequest, message: "tool_call.tool_grant is too large")
        }
        return AgentGatewayApprovalToolCall(
            callId: callId,
            name: name,
            arguments: arguments,
            toolGrant: toolGrant
        )
    }

    private func required(_ raw: String, field: String, limit: Int) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw HTTPError(.badRequest, message: "\(field) is required")
        }
        guard value.count <= limit else {
            throw HTTPError(.badRequest, message: "\(field) is too long")
        }
        return value
    }
}

struct AgentGatewayCompleteRequest: Decodable {
    let jobID: Int64?
    let leaseID: UUID?
    let status: String?
    let body: String?
    let error: String?
    let usage: AgentGatewayUsage?
    let memoryDelivery: AgentMemoryDeliveryReceipt?

    private enum CodingKeys: String, CodingKey {
        case jobID = "job_id"
        case leaseID = "lease_id"
        case status
        case body
        case error
        case usage
        case memoryDelivery = "memory_delivery"
    }

    func validatedLease() throws -> AgentGatewayLeaseBinding {
        guard let leaseBinding else {
            throw HTTPError(.badRequest, message: "job_id and lease_id are required")
        }
        return leaseBinding
    }

    var leaseBinding: AgentGatewayLeaseBinding? {
        guard let jobID, jobID > 0, let leaseID else { return nil }
        return AgentGatewayLeaseBinding(jobID: jobID, leaseID: leaseID)
    }
}

struct AgentMemoryDeliveryReceipt: Decodable, Equatable, Sendable {
    let includedCount: Int
    let injected: Bool

    private enum CodingKeys: String, CodingKey {
        case includedCount = "included_count"
        case injected
    }

    func validated() throws -> AgentMemoryDeliveryReceipt {
        guard includedCount >= 0 && includedCount <= 10_000 else {
            throw HTTPError(.badRequest, message: "memory_delivery.included_count is invalid")
        }
        guard includedCount > 0 || !injected else {
            throw HTTPError(
                .badRequest,
                message: "memory_delivery.injected requires an included memory"
            )
        }
        return self
    }

    func asObject() -> [String: Any] {
        ["included_count": includedCount, "injected": injected]
    }
}

struct AgentGatewayUsage: Decodable {
    let model: String?
    let promptTokens: Int?
    let completionTokens: Int?
    let cachedTokens: Int?
    let reasoningTokens: Int?
    let costMicroUsd: Int64?
    let wasEstimated: Bool?

    private enum CodingKeys: String, CodingKey {
        case model
        case promptTokens
        case promptTokensSnake = "prompt_tokens"
        case completionTokens
        case completionTokensSnake = "completion_tokens"
        case cachedTokens
        case cachedTokensSnake = "cached_tokens"
        case reasoningTokens
        case reasoningTokensSnake = "reasoning_tokens"
        case costMicroUsd
        case costMicroUsdSnake = "cost_micro_usd"
        case wasEstimated
        case wasEstimatedSnake = "was_estimated"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        promptTokens = try c.decodeIfPresent(Int.self, forKey: .promptTokens)
            ?? c.decodeIfPresent(Int.self, forKey: .promptTokensSnake)
        completionTokens = try c.decodeIfPresent(Int.self, forKey: .completionTokens)
            ?? c.decodeIfPresent(Int.self, forKey: .completionTokensSnake)
        cachedTokens = try c.decodeIfPresent(Int.self, forKey: .cachedTokens)
            ?? c.decodeIfPresent(Int.self, forKey: .cachedTokensSnake)
        reasoningTokens = try c.decodeIfPresent(Int.self, forKey: .reasoningTokens)
            ?? c.decodeIfPresent(Int.self, forKey: .reasoningTokensSnake)
        costMicroUsd = try c.decodeIfPresent(Int64.self, forKey: .costMicroUsd)
            ?? c.decodeIfPresent(Int64.self, forKey: .costMicroUsdSnake)
        wasEstimated = try c.decodeIfPresent(Bool.self, forKey: .wasEstimated)
            ?? c.decodeIfPresent(Bool.self, forKey: .wasEstimatedSnake)
    }

    func asObject() -> [String: Any] {
        [
            "model": model as Any,
            "prompt_tokens": promptTokens as Any,
            "completion_tokens": completionTokens as Any,
            "cached_tokens": cachedTokens as Any,
            "reasoning_tokens": reasoningTokens as Any,
            "cost_micro_usd": costMicroUsd as Any,
            "was_estimated": wasEstimated as Any,
        ]
    }
}

struct AgentGatewayEventResponse: ResponseEncodable {
    let status: String
    let runId: String
    let workControl: WorkControlDTO?
}

struct AgentGatewayCompleteResponse: ResponseEncodable {
    let status: String
    let runId: String
    let messageId: String
    let seq: Int64
}

struct AgentGatewayPendingJobDTO: ResponseEncodable, Codable, Sendable {
    let id: Int64
    let runId: String
    let payload: JSONValue
    let createdAtMs: Int64
    let leaseId: String
    let leaseExpiresAtMs: Int64
}

struct AgentGatewayPendingJobsResponse: ResponseEncodable {
    let jobs: [AgentGatewayPendingJobDTO]
}

struct AgentGatewayLeaseBinding: Equatable, Sendable {
    let jobID: Int64
    let leaseID: UUID
}

struct AgentGatewayLeaseRequest: Decodable {
    let jobID: Int64?
    let leaseID: UUID?

    private enum CodingKeys: String, CodingKey {
        case jobID = "job_id"
        case leaseID = "lease_id"
    }

    func validated(jobID pathJobID: Int64) throws -> AgentGatewayLeaseBinding {
        if let jobID, jobID != pathJobID {
            throw HTTPError(.conflict, message: "gateway job id does not match path")
        }
        guard let leaseID else {
            throw HTTPError(.conflict, message: "lease_id is required")
        }
        return AgentGatewayLeaseBinding(jobID: pathJobID, leaseID: leaseID)
    }
}

struct AgentGatewayLeaseResponse: ResponseEncodable {
    let status: String
    let jobId: Int64
    let leaseId: String
    let leaseExpiresAtMs: Int64?
}
