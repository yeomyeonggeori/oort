import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Server-side approval_request decision endpoint (MOMO-167).
///
/// Canonical route:
///   POST /v1/workspaces/{ws}/approvals/{approval}/decision
///
/// Compatibility route:
///   POST /v1/agent-runs/{run}/approval-decisions
struct ApprovalDecisionRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/approvals", use: list)
        group.post("/v1/workspaces/:ws/approvals/:approval/decision", use: decideByApproval)
        group.post("/v1/agent-runs/:run/approval-decisions", use: decideByRun)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let status = try Self.validatedStatus(request.uri.queryParameters["status"].map(String.init))
        let limit = Self.validatedLimit(request.uri.queryParameters["limit"].map(String.init))

        let result: (isMember: Bool, approvals: [ApprovalProjectionDTO]) =
            try await db.withTenantConnection(workspaceID: workspaceID) { conn in
                guard try await Self.isActiveHumanMember(
                    conn: conn,
                    logger: db.logger,
                    memberID: principal.memberID
                ) else {
                    return (false, [])
                }
                let approvals = try await Self.fetchApprovals(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    memberID: principal.memberID,
                    status: status,
                    limit: limit
                )
                return (true, approvals)
            }

        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not an active human workspace member")
        }
        return try ApprovalProjectionPageDTO(approvals: result.approvals)
            .response(from: request, context: context)
    }

    @Sendable
    func decideByApproval(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let approvalID = try Self.approvalID(context)
        let dto = try await request.decode(as: ApprovalDecisionRequestDTO.self, context: context)
        try Self.validateBodyApprovalID(dto.approvalId, pathApprovalID: approvalID)
        let result = try await decide(
            principal: principal,
            workspaceID: workspaceID,
            approvalID: approvalID,
            routeRunID: nil,
            dto: dto
        )
        var response = try result.receipt.response(from: request, context: context)
        if let status = result.responseStatus {
            response.status = status
        }
        return response
    }

    @Sendable
    func decideByRun(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let runID = try Self.runID(context)
        let dto = try await request.decode(as: ApprovalDecisionRequestDTO.self, context: context)
        let result = try await decide(
            principal: principal,
            workspaceID: principal.workspaceID,
            approvalID: dto.approvalId,
            routeRunID: runID,
            dto: dto
        )
        var response = try result.receipt.response(from: request, context: context)
        if let status = result.responseStatus {
            response.status = status
        }
        return response
    }

    private struct DecisionResult: Sendable {
        let receipt: ApprovalDecisionReceiptDTO
        let responseStatus: HTTPResponse.Status?
    }

    private func decide(
        principal: AuthPrincipal,
        workspaceID: UUID,
        approvalID: UUID,
        routeRunID: UUID?,
        dto: ApprovalDecisionRequestDTO
    ) async throws -> DecisionResult {
        let reason = Self.normalizedReason(dto.reason)
        let desiredStatus = Self.status(approve: dto.approve)

        return try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            if let retry = try await Self.existingDecision(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                clientDecisionID: dto.clientDecisionId
            ) {
                if retry.approvalID == approvalID,
                   retry.decidedBy == principal.memberID,
                   retry.approve == dto.approve
                {
                    return DecisionResult(receipt: retry.receipt, responseStatus: nil)
                }
                return DecisionResult(
                    receipt: ApprovalDecisionReceiptDTO(
                        approvalId: approvalID.uuidString,
                        status: "idempotency_conflict",
                        decidedBy: principal.memberID.uuidString,
                        decidedAtMs: Self.epochMs(Date()),
                        decisionReason: "approval_decision_idempotency_conflict"
                    ),
                    responseStatus: .conflict
                )
            }

            guard try await Self.isActiveHumanMember(
                conn: conn,
                logger: db.logger,
                memberID: principal.memberID
            ) else {
                return Self.expectedFailure(
                    approvalID: approvalID,
                    principal: principal,
                    status: "forbidden",
                    reason: "approval decisions require an active human member",
                    responseStatus: .forbidden
                )
            }

            guard let approval = try await Self.lockApproval(
                conn: conn,
                logger: db.logger,
                approvalID: approvalID
            ) else {
                return Self.expectedFailure(
                    approvalID: approvalID,
                    principal: principal,
                    status: "not_found",
                    reason: "approval not found",
                    responseStatus: .notFound
                )
            }

            if let routeRunID, routeRunID != approval.runID {
                return Self.expectedFailure(
                    approvalID: approvalID,
                    principal: principal,
                    status: "bad_request",
                    reason: "approval does not belong to route run",
                    responseStatus: .badRequest
                )
            }
            guard try await Self.hasActiveChannelMembership(
                conn: conn,
                logger: db.logger,
                channelID: approval.channelID,
                memberID: principal.memberID
            ) else {
                return Self.expectedFailure(
                    approvalID: approval.id,
                    principal: principal,
                    status: "forbidden",
                    reason: "not a member of this approval channel",
                    responseStatus: .forbidden
                )
            }
            guard approval.status == "pending" else {
                return Self.expectedFailure(
                    approvalID: approval.id,
                    principal: principal,
                    status: approval.status,
                    reason: "approval is already \(approval.status)",
                    responseStatus: .conflict
                )
            }

            if let expiresAtMs = approval.expiresAtMs,
               expiresAtMs <= Self.epochMs(Date())
            {
                let expired = try await Self.recordExpiredClick(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    principal: principal,
                    approval: approval,
                    approve: dto.approve,
                    clientDecisionID: dto.clientDecisionId
                )
                return DecisionResult(receipt: expired, responseStatus: .conflict)
            }

            let decidedAtMs = Self.epochMs(Date())
            let receipt = ApprovalDecisionReceiptDTO(
                approvalId: approval.id.uuidString,
                status: desiredStatus,
                decidedBy: principal.memberID.uuidString,
                decidedAtMs: decidedAtMs,
                decisionReason: reason
            )
            let receiptJSON = Self.encodeJSON(receipt)
            let eventPayload = Self.decisionEventPayload(
                approval: approval,
                status: desiredStatus,
                decidedBy: principal.memberID,
                decidedAtMs: decidedAtMs,
                reason: reason
            )

            _ = try await conn.query(
                """
                UPDATE approval
                   SET status = \(desiredStatus)::approval_status,
                       decided_by = \(principal.memberID),
                       decided_at = to_timestamp(\(decidedAtMs) / 1000.0),
                       decision_reason = \(reason)
                 WHERE id = \(approval.id)
                """,
                logger: db.logger
            )
            try await Self.patchApprovalRequestMessage(
                conn: conn,
                logger: db.logger,
                approval: approval,
                status: desiredStatus,
                decidedBy: principal.memberID,
                decidedAtMs: decidedAtMs,
                reason: reason
            )
            _ = try await conn.query(
                """
                INSERT INTO approval_decision
                  (workspace_id, approval_id, client_decision_id, decided_by,
                   approve, status, reason, receipt)
                VALUES
                  (\(workspaceID), \(approval.id), \(dto.clientDecisionId),
                   \(principal.memberID), \(dto.approve), \(desiredStatus)::approval_status,
                   \(reason), \(receiptJSON)::jsonb)
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, run_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID),
                   \(Self.auditAction(status: desiredStatus)), 'approval',
                   \(approval.id), \(approval.runID), \(eventPayload)::jsonb)
                """,
                logger: db.logger
            )

            let gatewayRun: Bool
            if approval.payload.objectValue?["source"]?.stringValue == "hermes_gateway" {
                gatewayRun = true
            } else {
                gatewayRun = try await Self.isGatewayRun(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    runID: approval.runID
                )
            }

            if dto.approve {
                try await Self.enqueueResume(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    approval: approval,
                    eventPayload: eventPayload,
                    gatewayRun: gatewayRun,
                    decidedAtMs: decidedAtMs
                )
            } else {
                try await Self.cancelRunAndAppendToolResult(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    approval: approval,
                    principal: principal,
                    reason: reason,
                    decidedAtMs: decidedAtMs
                )
                if gatewayRun {
                    try await Self.enqueueGatewayStop(
                        conn: conn,
                        logger: db.logger,
                        workspaceID: workspaceID,
                        approval: approval,
                        eventPayload: eventPayload,
                        decidedAtMs: decidedAtMs
                    )
                }
            }

            try await Self.enqueueDecisionBroadcast(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                approval: approval,
                status: desiredStatus,
                eventPayload: eventPayload,
                decidedAtMs: decidedAtMs
            )
            return DecisionResult(receipt: receipt, responseStatus: nil)
        }
    }

    // MARK: - SQL rows

    private struct LockedApproval: Decodable, Sendable {
        let id: UUID
        let runID: UUID
        let channelID: UUID
        let requestedBy: UUID
        let requestMessageID: UUID?
        let actionType: String
        let payload: JSONValue
        let status: String
        let decidedBy: UUID?
        let decidedAtMs: Int64?
        let decisionReason: String?
        let expiresAtMs: Int64?
        let agentModel: String
        let runInput: JSONValue
        let stepCount: Int
        let maxSteps: Int
        let depth: Int

        private enum CodingKeys: String, CodingKey {
            case id
            case runID = "run_id"
            case channelID = "channel_id"
            case requestedBy = "requested_by"
            case requestMessageID = "request_message_id"
            case actionType = "action_type"
            case payload
            case status
            case decidedBy = "decided_by"
            case decidedAtMs = "decided_at_ms"
            case decisionReason = "decision_reason"
            case expiresAtMs = "expires_at_ms"
            case agentModel = "agent_model"
            case runInput = "run_input"
            case stepCount = "step_count"
            case maxSteps = "max_steps"
            case depth
        }
    }

    private struct ExistingDecision: Sendable {
        let approvalID: UUID
        let decidedBy: UUID
        let approve: Bool
        let receipt: ApprovalDecisionReceiptDTO
    }

    private static func existingDecision(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        clientDecisionID: UUID
    ) async throws -> ExistingDecision? {
        let rows = try await conn.query(
            """
            SELECT approval_id, decided_by, approve, receipt::text
              FROM approval_decision
             WHERE workspace_id = \(workspaceID)
               AND client_decision_id = \(clientDecisionID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let (approvalID, decidedBy, approve, receiptJSON) =
            try row.decode((UUID, UUID, Bool, String).self)
        return try ExistingDecision(
            approvalID: approvalID,
            decidedBy: decidedBy,
            approve: approve,
            receipt: JSONDecoder().decode(ApprovalDecisionReceiptDTO.self, from: Data(receiptJSON.utf8))
        )
    }

    private static func lockApproval(
        conn: PostgresConnection,
        logger: Logger,
        approvalID: UUID
    ) async throws -> LockedApproval? {
        let rows = try await conn.query(
            """
            SELECT jsonb_build_object(
                     'id', a.id,
                     'run_id', a.run_id,
                     'channel_id', a.channel_id,
                     'requested_by', a.requested_by,
                     'request_message_id', a.request_message_id,
                     'action_type', a.action_type,
                     'payload', a.payload,
                     'status', a.status::text,
                     'decided_by', a.decided_by,
                     'decided_at_ms',
                       CASE WHEN a.decided_at IS NULL
                            THEN NULL
                            ELSE floor(extract(epoch from a.decided_at) * 1000)::bigint
                       END,
                     'decision_reason', a.decision_reason,
                     'expires_at_ms',
                       CASE WHEN a.expires_at IS NULL
                            THEN NULL
                            ELSE floor(extract(epoch from a.expires_at) * 1000)::bigint
                       END,
                     'agent_model', ag.model,
                     'run_input', r.input,
                     'step_count', r.step_count,
                     'max_steps', r.max_steps,
                     'depth', r.depth
                   )::text AS approval_json
              FROM approval a
              JOIN agent_run r ON r.id = a.run_id
              JOIN agent ag ON ag.member_id = r.agent_member_id
             WHERE a.id = \(approvalID)
             FOR UPDATE OF a
            """,
            logger: logger
        ).collect()
        guard let json = try rows.first?.decode(String.self) else { return nil }
        return try JSONDecoder().decode(LockedApproval.self, from: Data(json.utf8))
    }

    static func validatedStatus(_ raw: String?) throws -> String {
        let status = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch status {
        case nil, "", "pending":
            return "pending"
        case "approved", "rejected", "expired", "cancelled":
            return status!
        default:
            throw HTTPError(.badRequest, message: "status must be pending, approved, rejected, expired, or cancelled")
        }
    }

    static func validatedLimit(_ raw: String?) -> Int {
        min(max(raw.flatMap { Int($0) } ?? 100, 1), 500)
    }

    private static func fetchApprovals(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID,
        status: String,
        limit: Int
    ) async throws -> [ApprovalProjectionDTO] {
        let rows = try await conn.query(
            """
            SELECT COALESCE(json_agg(row_json ORDER BY sort_expires_at NULLS LAST, sort_created_at DESC)::text, '[]') AS payload
              FROM (
                SELECT jsonb_build_object(
                         'id', a.id,
                         'workspace_id', a.workspace_id,
                         'run_id', a.run_id,
                         'channel_id', a.channel_id,
                         'request_message_id', a.request_message_id,
                         'requested_by', a.requested_by,
                         'on_behalf_of', a.payload->>'on_behalf_of',
                         'action_type', a.action_type,
                         'payload', a.payload,
                         'status', a.status::text,
                         'estimated_micro_usd',
                           COALESCE(
                             CASE
                               WHEN jsonb_typeof(a.payload->'estimated_micro_usd') = 'number'
                                 THEN (a.payload->>'estimated_micro_usd')::bigint
                               WHEN (a.payload->>'estimated_micro_usd') ~ '^[0-9]+$'
                                 THEN (a.payload->>'estimated_micro_usd')::bigint
                               ELSE NULL
                             END,
                             CASE
                               WHEN jsonb_typeof(a.payload #> '{tool_call,estimated_micro_usd}') = 'number'
                                 THEN (a.payload #>> '{tool_call,estimated_micro_usd}')::bigint
                               WHEN (a.payload #>> '{tool_call,estimated_micro_usd}') ~ '^[0-9]+$'
                                 THEN (a.payload #>> '{tool_call,estimated_micro_usd}')::bigint
                               ELSE NULL
                             END
                           ),
                         'is_reversible',
                           COALESCE(
                             CASE
                               WHEN jsonb_typeof(a.payload->'is_reversible') = 'boolean'
                                 THEN (a.payload->>'is_reversible')::boolean
                               WHEN lower(a.payload->>'is_reversible') IN ('true', 'false')
                                 THEN lower(a.payload->>'is_reversible')::boolean
                               ELSE NULL
                             END,
                             CASE
                               WHEN jsonb_typeof(a.payload #> '{risk,is_reversible}') = 'boolean'
                                 THEN (a.payload #>> '{risk,is_reversible}')::boolean
                               WHEN lower(a.payload #>> '{risk,is_reversible}') IN ('true', 'false')
                                 THEN lower(a.payload #>> '{risk,is_reversible}')::boolean
                               ELSE NULL
                             END
                           ),
                         'decided_by', a.decided_by,
                         'decided_at_ms',
                           CASE WHEN a.decided_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from a.decided_at) * 1000)::bigint
                           END,
                         'decision_reason', a.decision_reason,
                         'expires_at_ms',
                           CASE WHEN a.expires_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from a.expires_at) * 1000)::bigint
                           END
                       ) AS row_json,
                       a.expires_at AS sort_expires_at,
                       a.created_at AS sort_created_at
                  FROM approval a
                  JOIN membership ms
                    ON ms.channel_id = a.channel_id
                   AND ms.member_id = \(memberID)
                   AND ms.left_at IS NULL
                 WHERE a.workspace_id = \(workspaceID)
                   AND a.status = \(status)::approval_status
                 ORDER BY a.expires_at NULLS LAST, a.created_at DESC
                 LIMIT \(limit)
              ) rows
            """,
            logger: logger
        ).collect()
        return try decodeApprovalList(from: rows.first)
    }

    static func decodeApprovalList(from row: PostgresRow?) throws -> [ApprovalProjectionDTO] {
        guard let row else { return [] }
        let json = try row.decode(String.self)
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "approval JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode([ApprovalProjectionDTO].self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "approval JSON decoding failed")
        }
    }

    private static func isActiveHumanMember(
        conn: PostgresConnection,
        logger: Logger,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member
             WHERE id = \(memberID)
               AND kind = 'human'
               AND status = 'active'
               AND deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func hasActiveChannelMembership(
        conn: PostgresConnection,
        logger: Logger,
        channelID: UUID,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM membership
             WHERE channel_id = \(channelID)
               AND member_id = \(memberID)
               AND left_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func isGatewayRun(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        runID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT EXISTS (
              SELECT 1
                FROM outbox
               WHERE workspace_id = \(workspaceID)
                 AND kind = 'agent_job'
                 AND method = 'gateway'
                 AND payload->>'run_id' = \(runID.uuidString)
            )
            """,
            logger: logger
        ).collect()
        return try rows.first?.decode(Bool.self) ?? false
    }

    // MARK: - Effects

    private static func patchApprovalRequestMessage(
        conn: PostgresConnection,
        logger: Logger,
        approval: LockedApproval,
        status: String,
        decidedBy: UUID,
        decidedAtMs: Int64,
        reason: String?
    ) async throws {
        guard let requestMessageID = approval.requestMessageID else { return }
        let propsPatch = jsonString([
            "approval_status": status,
            "status": status,
            "decided_by": decidedBy.uuidString,
            "decided_at_ms": decidedAtMs,
            "decision_reason": reason ?? NSNull(),
        ])
        _ = try await conn.query(
            """
            UPDATE message
               SET props = COALESCE(props, '{}'::jsonb) || \(propsPatch)::jsonb
             WHERE id = \(requestMessageID)
            """,
            logger: logger
        )
    }

    private static func enqueueResume(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        approval: LockedApproval,
        eventPayload: String,
        gatewayRun: Bool,
        decidedAtMs: Int64
    ) async throws {
        _ = try await conn.query(
            """
            UPDATE agent_run
               SET status = 'queued',
                   updated_at = now(),
                   error = NULL,
                   finished_at = NULL
             WHERE id = \(approval.runID)
            """,
            logger: logger
        )
        let payload = resumePayload(
            workspaceID: workspaceID,
            approval: approval,
            eventPayload: eventPayload,
            delivery: gatewayRun ? "gateway" : nil
        )
        let jobMethod = gatewayRun ? "gateway" : "resume_approval"
        let rows = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'agent_job', \(jobMethod),
               \(payload)::jsonb, \(approval.requestedBy))
            RETURNING id
            """,
            logger: logger
        ).collect()
        if gatewayRun, let row = rows.first {
            let jobOutboxID = try row.decode(Int64.self)
            try await enqueueGatewayJobBroadcast(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                approval: approval,
                jobOutboxID: jobOutboxID,
                payload: payload,
                decidedAtMs: decidedAtMs
            )
        }
    }

    private static func enqueueGatewayStop(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        approval: LockedApproval,
        eventPayload: String,
        decidedAtMs: Int64
    ) async throws {
        let payload = resumePayload(
            workspaceID: workspaceID,
            approval: approval,
            eventPayload: eventPayload,
            delivery: "gateway"
        )
        let rows = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'agent_job', 'gateway',
               \(payload)::jsonb, \(approval.requestedBy))
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return }
        let jobOutboxID = try row.decode(Int64.self)
        try await enqueueGatewayJobBroadcast(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            approval: approval,
            jobOutboxID: jobOutboxID,
            payload: payload,
            decidedAtMs: decidedAtMs
        )
    }

    private static func enqueueGatewayJobBroadcast(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        approval: LockedApproval,
        jobOutboxID: Int64,
        payload: String,
        decidedAtMs: Int64
    ) async throws {
        let broadcast = gatewayJobBroadcastPayload(
            workspaceID: workspaceID,
            approval: approval,
            jobOutboxID: jobOutboxID,
            payload: payload,
            decidedAtMs: decidedAtMs
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'broadcast', 'publish',
               \(broadcast)::jsonb, \(approval.requestedBy))
            """,
            logger: logger
        )
    }

    private static func cancelRunAndAppendToolResult(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        approval: LockedApproval,
        principal: AuthPrincipal,
        reason: String?,
        decidedAtMs: Int64
    ) async throws {
        _ = try await conn.query(
            """
            UPDATE agent_run
               SET status = 'cancelled',
                   updated_at = now(),
                   finished_at = now(),
                   error = jsonb_build_object(
                     'code', 'approval_rejected',
                     'approval_id', \(approval.id.uuidString),
                     'reason', \(reason)
                   )
             WHERE id = \(approval.runID)
            """,
            logger: logger
        )

        let resultProps = jsonString([
            "approval_id": approval.id.uuidString,
            "run_id": approval.runID.uuidString,
            "is_error": true,
            "status": "rejected",
            "decided_by": principal.memberID.uuidString,
            "decided_at_ms": decidedAtMs,
            "reason": reason ?? NSNull(),
        ])
        let body = "Tool call rejected by human approval."
        let hlcTs = epochMs(Date())
        let rows = try await conn.query(
            """
            WITH bumped AS (
              UPDATE channel_seq
                 SET last_seq = last_seq + 1
               WHERE channel_id = \(approval.channelID)
              RETURNING last_seq AS seq
            )
            INSERT INTO message
              (workspace_id, channel_id, seq, hlc_ts, hlc_count,
               author_member_id, type, body, props, run_id)
            SELECT \(workspaceID), \(approval.channelID), b.seq, \(hlcTs), 0,
                   \(approval.requestedBy), 'tool_result'::message_type,
                   \(body), \(resultProps)::jsonb, \(approval.runID)
              FROM bumped b
            RETURNING id, seq
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return }
        let (messageID, seq) = try row.decode((UUID, Int64).self)
        let payload = messageBroadcastPayload(
            workspaceID: workspaceID,
            channelID: approval.channelID,
            messageID: messageID,
            seq: seq,
            authorMemberID: approval.requestedBy,
            runID: approval.runID,
            type: "tool_result",
            body: body,
            propsJSON: resultProps,
            hlcTs: hlcTs
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'broadcast', 'publish', \(payload)::jsonb,
               \(approval.channelID))
            """,
            logger: logger
        )
    }

    private static func recordExpiredClick(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        approval: LockedApproval,
        approve: Bool,
        clientDecisionID: UUID
    ) async throws -> ApprovalDecisionReceiptDTO {
        let decidedAtMs = epochMs(Date())
        let reason = "Approval expired before a human decision."
        let receipt = ApprovalDecisionReceiptDTO(
            approvalId: approval.id.uuidString,
            status: "expired",
            decidedBy: nil,
            decidedAtMs: decidedAtMs,
            decisionReason: reason
        )
        let receiptJSON = encodeJSON(receipt)
        let eventPayload = decisionEventPayload(
            approval: approval,
            status: "expired",
            decidedBy: nil,
            decidedAtMs: decidedAtMs,
            reason: reason
        )
        _ = try await conn.query(
            """
            UPDATE approval
               SET status = 'expired',
                   decided_at = to_timestamp(\(decidedAtMs) / 1000.0),
                   decision_reason = \(reason)
             WHERE id = \(approval.id)
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            UPDATE agent_run
               SET status = 'timed_out',
                   updated_at = now(),
                   finished_at = now(),
                   error = jsonb_build_object(
                     'code', 'approval_expired',
                     'approval_id', \(approval.id.uuidString)
                   )
             WHERE id = \(approval.runID)
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            INSERT INTO approval_decision
              (workspace_id, approval_id, client_decision_id, decided_by,
               approve, status, reason, receipt)
            VALUES
              (\(workspaceID), \(approval.id), \(clientDecisionID),
               \(principal.memberID), \(approve), 'expired', \(reason),
               \(receiptJSON)::jsonb)
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type,
               target_id, run_id, detail)
            VALUES
              (\(workspaceID), NULL, 'approval.expired', 'approval',
               \(approval.id), \(approval.runID), \(eventPayload)::jsonb)
            """,
            logger: logger
        )
        try await enqueueDecisionBroadcast(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            approval: approval,
            status: "expired",
            eventPayload: eventPayload,
            decidedAtMs: decidedAtMs
        )
        return receipt
    }

    private static func enqueueDecisionBroadcast(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        approval: LockedApproval,
        status: String,
        eventPayload: String,
        decidedAtMs: Int64
    ) async throws {
        let payload = decisionBroadcastPayload(
            workspaceID: workspaceID,
            channelID: approval.channelID,
            approvalID: approval.id,
            runID: approval.runID,
            status: status,
            eventPayload: eventPayload,
            decidedAtMs: decidedAtMs
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'broadcast', 'publish', \(payload)::jsonb,
               \(approval.channelID))
            """,
            logger: logger
        )
    }

    // MARK: - Pure helpers

    static func status(approve: Bool) -> String {
        approve ? "approved" : "rejected"
    }

    static func auditAction(status: String) -> String {
        "approval.\(status)"
    }

    static func normalizedReason(_ reason: String?) -> String? {
        guard let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return String(trimmed.prefix(2_000))
    }

    static func validateBodyApprovalID(_ bodyApprovalID: UUID, pathApprovalID: UUID) throws {
        guard bodyApprovalID == pathApprovalID else {
            throw HTTPError(.badRequest, message: "approval_id does not match path")
        }
    }

    private static func expectedFailure(
        approvalID: UUID,
        principal: AuthPrincipal,
        status: String,
        reason: String,
        responseStatus: HTTPResponse.Status
    ) -> DecisionResult {
        DecisionResult(
            receipt: ApprovalDecisionReceiptDTO(
                approvalId: approvalID.uuidString,
                status: status,
                decidedBy: principal.memberID.uuidString,
                decidedAtMs: epochMs(Date()),
                decisionReason: reason
            ),
            responseStatus: responseStatus
        )
    }

    private static func workspaceID(
        _ context: AppRequestContext,
        principal: AuthPrincipal
    ) throws -> UUID {
        let wsParam = try context.parameters.require("ws")
        guard let ws = UUID(uuidString: wsParam) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        guard ws == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return ws
    }

    private static func approvalID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("approval")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid approval id")
        }
        return id
    }

    private static func runID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("run")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid run id")
        }
        return id
    }

    private static func epochMs(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1000)
    }

    private static func encodeJSON<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let string = String(data: data, encoding: .utf8)
        else { return "{}" }
        return string
    }

    private static func decisionEventPayload(
        approval: LockedApproval,
        status: String,
        decidedBy: UUID?,
        decidedAtMs: Int64,
        reason: String?
    ) -> String {
        jsonString([
            "action": "decided",
            "approval_id": approval.id.uuidString,
            "run_id": approval.runID.uuidString,
            "channel_id": approval.channelID.uuidString,
            "requested_by": approval.requestedBy.uuidString,
            "action_type": approval.actionType,
            "status": status,
            "payload": anyValue(approval.payload),
            "decided_by": decidedBy?.uuidString ?? NSNull(),
            "decided_at_ms": decidedAtMs,
            "decision_reason": reason ?? NSNull(),
        ])
    }

    private static func resumePayload(
        workspaceID: UUID,
        approval: LockedApproval,
        eventPayload: String,
        delivery: String?
    ) -> String {
        let payload = approval.payload.objectValue ?? [:]
        let toolCall = payload["tool_call"]?.objectValue ?? [:]
        let toolGrant = toolCall["tool_grant"].map(anyValue) ?? [:]
        let runInput = approval.runInput.objectValue ?? [:]
        var result: [String: Any] = [
            "run_id": approval.runID.uuidString,
            "workspace_id": workspaceID.uuidString,
            "channel_id": approval.channelID.uuidString,
            "agent_member_id": approval.requestedBy.uuidString,
            "model": approval.agentModel,
            "prompt": runInput["prompt"]?.stringValue ?? "",
            "resume_from_approval_id": approval.id.uuidString,
            "approved_tool_call": [
                "call_id": toolCall["call_id"]?.stringValue ?? "",
                "name": toolCall["name"]?.stringValue ?? approval.actionType,
                "arguments": toolCall["arguments"].map(anyValue) ?? [:],
                "payload_sha256": "sha256:\(approval.id.uuidString)",
            ],
            "policy_evidence": toolGrant,
            "approval_decision": jsonObject(eventPayload),
            "step_count": approval.stepCount,
            "max_steps": approval.maxSteps,
            "depth": approval.depth,
        ]
        if let delivery {
            result["delivery"] = delivery
        }
        return jsonString(result)
    }

    private static func gatewayJobBroadcastPayload(
        workspaceID: UUID,
        approval: LockedApproval,
        jobOutboxID: Int64,
        payload: String,
        decidedAtMs: Int64
    ) -> String {
        let centChannel = "agentwork:ws\(workspaceID.uuidString).\(approval.requestedBy.uuidString)"
        var jobPayload = jsonObject(payload)
        jobPayload["agent_job_outbox_id"] = jobOutboxID
        jobPayload["delivery"] = "gateway"
        return jsonString([
            "channel": centChannel,
            "data": [
                "type": "agent.job",
                "v": 1,
                "ts": decidedAtMs,
                "seq": jobOutboxID,
                "payload": jobPayload,
            ],
            "version": jobOutboxID,
            "idempotency_key": "\(centChannel):agent_job:\(approval.runID.uuidString):resume:\(approval.id.uuidString)",
        ])
    }

    private static func decisionBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        approvalID: UUID,
        runID: UUID,
        status: String,
        eventPayload: String,
        decidedAtMs: Int64
    ) -> String {
        let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        return jsonString([
            "channel": centChannel,
            "data": [
                "type": "approval.decided",
                "v": 1,
                "ts": decidedAtMs,
                "payload": jsonObject(eventPayload),
            ],
            "idempotency_key": "approval-decision:\(approvalID.uuidString):\(status):\(runID.uuidString)",
        ])
    }

    private static func messageBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        seq: Int64,
        authorMemberID: UUID,
        runID: UUID,
        type: String,
        body: String,
        propsJSON: String,
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
                    "props": jsonObject(propsJSON),
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

    private static func jsonObject(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any]
        else { return [:] }
        return dict
    }

    private static func jsonString(_ object: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
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
