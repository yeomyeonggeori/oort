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
    let db: Database
    let config: AgentGatewayConfig

    static let gatewaySecretHeader = HTTPField.Name("X-Momo-Agent-Gateway-Secret")!

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get(
            "/v1/workspaces/:ws/agents/:agent/gateway/jobs/pending",
            use: pendingJobs
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
        let activeAgent = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            try await Self.isActiveAgent(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                agentID: targetAgentID
            )
        }
        guard activeAgent else {
            throw HTTPError(.notFound, message: "active agent not found")
        }

        let jobs: [AgentGatewayPendingJobDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT id, payload::text, created_at
                  FROM outbox
                 WHERE workspace_id = \(workspaceID)
                   AND kind = 'agent_job'
                   AND method = 'gateway'
                   AND status = 'pending'
                   AND available_at <= now()
                   AND partition_key = \(targetAgentID)
                   AND payload->>'agent_member_id' = \(targetAgentID.uuidString)
                 ORDER BY id ASC
                 LIMIT \(limit)
                """,
                logger: db.logger
            ).collect()
            return try rows.map { row in
                let (id, payloadJSON, createdAt) = try row.decode((Int64, String, Date).self)
                guard let data = payloadJSON.data(using: .utf8) else {
                    throw HTTPError(.internalServerError, message: "gateway job payload encoding failed")
                }
                let payload = try JSONDecoder().decode(JSONValue.self, from: data)
                return AgentGatewayPendingJobDTO(
                    id: id,
                    runId: payload.objectValue?["run_id"]?.stringValue ?? "",
                    payload: payload,
                    createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
                )
            }
        }
        return AgentGatewayPendingJobsResponse(jobs: jobs)
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
        let normalizedStatus = Self.normalizedStatus(dto.status ?? "running")

        let accepted = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard let run = try await Self.lockGatewayRun(
                conn: conn, logger: db.logger, workspaceID: workspaceID, runID: runID)
            else { return false }
            if normalizedStatus == "running" || normalizedStatus == "thinking" {
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
                "detail": dto.detail as Any,
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
                agentMemberID: run.agentMemberID,
                runID: runID,
                status: normalizedStatus,
                detail: dto.detail
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
            return true
        }

        guard accepted else {
            throw HTTPError(.notFound, message: "agent run not found")
        }
        return AgentGatewayEventResponse(status: "accepted", runId: runID.uuidString)
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
        let completionStatus = Self.normalizedCompletionStatus(dto.status)
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)

        let result = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard let run = try await Self.lockGatewayRun(
                conn: conn, logger: db.logger, workspaceID: workspaceID, runID: runID)
            else {
                return CompletionResult.notFound
            }
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
            if let first = rows.first {
                (messageID, seq) = try first.decode((UUID, Int64).self)
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
                   AND kind = 'agent_job'
                   AND method = 'gateway'
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
        case completed(messageID: UUID, seq: Int64, status: String)
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
        guard targetAgentID == principal.memberID else {
            throw HTTPError(.forbidden, message: "agent bearer actor does not match run agent")
        }
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

    private static func isTerminalRunStatus(_ status: String) -> Bool {
        status == "succeeded" || status == "failed" || status == "cancelled"
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

    private static func normalizedCompletionStatus(_ raw: String?) -> String {
        switch raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "failed", "error", "cancelled", "timed_out":
            return "failed"
        default:
            return "succeeded"
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

    private static func agentStatusBroadcastPayload(
        workspaceID: UUID,
        agentMemberID: UUID,
        runID: UUID,
        status: String,
        detail: String?
    ) -> String {
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        let centChannel = "agent:ws\(workspaceID.uuidString).\(agentMemberID.uuidString)"
        return jsonString([
            "channel": centChannel,
            "data": [
                "type": "agent.status",
                "v": 1,
                "ts": hlcTs,
                "seq": hlcTs,
                "payload": [
                    "run_id": runID.uuidString,
                    "agent_member_id": agentMemberID.uuidString,
                    "status": status,
                    "detail": detail as Any,
                    "source": "hermes_gateway",
                ],
            ],
            "version": hlcTs,
            "idempotency_key": "\(centChannel):status:\(runID.uuidString):\(status):\(hlcTs)",
        ])
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
    let status: String?
    let detail: String?
}

struct AgentGatewayCompleteRequest: Decodable {
    let status: String?
    let body: String?
    let error: String?
    let usage: AgentGatewayUsage?
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
}

struct AgentGatewayPendingJobsResponse: ResponseEncodable {
    let jobs: [AgentGatewayPendingJobDTO]
}
