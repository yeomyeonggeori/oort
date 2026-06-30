import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import PostgresNIO
import ServiceLifecycle

/// The agent worker loop (L4 §3.5 / §6.2 / §8.5).
///
/// Hot path, per claimed job:
///   1. Claim a pending `kind='agent_job'` outbox row with
///      `SELECT ... FOR UPDATE SKIP LOCKED ORDER BY id LIMIT 1`, flipped to
///      `processing` in the SAME tx. `partition_key = agent_member_id` → one job
///      per agent in flight (per-agent serialization, L4 §3.5). SKIP LOCKED is
///      loss-free (commit-visibility only) — a high-water-mark cursor is forbidden.
///   2. Open the §3.3 loop-safety gates (G1 concurrency / G2 consecutive / G3 step
///      cap / §3.4 depth) — stubbed with default constants. Halt → mark run failed,
///      job done, publish agent.status=error.
///   3. Reserve estimated budget (§8.5) — trip → abort before any hermes spend.
///   4. publish agent.status=thinking; call hermes /v1/chat/completions
///      (stream=true). Each text delta → publish agent.partial + PATCH the
///      streaming `message.body` (streaming mimic, L4 §6.2). tool_calls → (would)
///      open an approval gate (G6 stub).
///   5. Reconcile budget + write the usage_ledger (§8.5). publish
///      agent.status=done.
///
/// Wakeups: a dedicated LISTEN connection on `outbox` (schema `outbox_notify_trg`
/// fires `pg_notify('outbox', kind)`) → sub-second pickup; a `pollInterval`
/// (300ms) ticker is the fallback (L4 §8.1).
///
/// Runtime verification status is tracked in STATUS.md. The MOMO-004 gate uses
/// Docker PostgreSQL/Centrifugo plus `scripts/mock_hermes.py` when real hermes is
/// unavailable.
struct WorkerService: Service {
    let pg: PostgresClient
    let hermes: HermesTransport
    let centrifugo: CentrifugoClient
    let guards: LoopGuards
    let cost: CostAccounting
    let config: Config
    let logger: Logger
    let resumeExecutor = ToolResumeExecutor()

    private static let decoder = JSONDecoder()

    func run() async throws {
        let c = config.pollInterval.components
        let pollMs = c.seconds * 1000 + c.attoseconds / 1_000_000_000_000_000
        logger.info("agent worker starting", metadata: [
            "pollIntervalMs": .stringConvertible(pollMs),
            "maxSteps": .stringConvertible(config.maxSteps),
            "maxConsecutiveAuto": .stringConvertible(config.maxConsecutiveAuto),
            "maxDepth": .stringConvertible(config.maxDepth),
        ])

        // Coalesce NOTIFY signals + poll ticks into one drain loop (buffer of 1:
        // a wake burst collapses to "one drain pending"; each drain runs to empty
        // so no job is left behind, L4 §3.5 loss-free claim).
        let (wakes, wakeContinuation) = AsyncStream.makeStream(
            of: Void.self, bufferingPolicy: .bufferingNewest(1))

        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                while !Task.isCancelled {
                    wakeContinuation.yield(())
                    try? await Task.sleep(for: config.pollInterval)
                }
            }
            group.addTask {
                await listenLoop(wake: wakeContinuation)
            }
            group.addTask {
                for await _ in wakes {
                    if Task.isCancelled { break }
                    await drainToEmpty()
                }
            }
            group.addTask {
                try? await gracefulShutdown()
                wakeContinuation.finish()
            }
            try await group.next()
            group.cancelAll()
        }
    }

    // MARK: - LISTEN/NOTIFY

    private func listenLoop(wake: AsyncStream<Void>.Continuation) async {
        while !Task.isCancelled {
            do {
                try await pg.withConnection { conn in
                    try await conn.listen(on: "outbox") { notifications in
                        for try await note in notifications {
                            // Only agent_job notifications matter here; broadcast
                            // wakes are harmless (claim filters by kind) but we can
                            // skip the drain for them to avoid churn.
                            if note.payload == "agent_job" {
                                wake.yield(())
                            }
                            if Task.isCancelled { break }
                        }
                    }
                }
            } catch {
                if Task.isCancelled { return }
                logger.warning("LISTEN connection lost; relying on poll fallback", metadata: [
                    "error": .string(String(describing: error)),
                ])
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    // MARK: - Drain

    private func drainToEmpty() async {
        while !Task.isCancelled {
            do {
                guard let job = try await claimOne() else { return }
                await process(job)
            } catch {
                logger.error("worker drain iteration failed", metadata: [
                    "error": .string(String(describing: error)),
                ])
                return   // next poll tick retries
            }
        }
    }

    /// A claimed agent_job row.
    private struct ClaimedJob: Sendable {
        let id: Int64
        let workspaceID: UUID
        let attempts: Int
        let method: String
        let payload: AgentJobPayload
    }

    /// L4 §3.5: claim ONE pending agent_job and flip it to `processing`.
    /// partition_key = agent_member_id ⇒ per-agent serialization.
    private func claimOne() async throws -> ClaimedJob? {
        let row: (Int64, UUID, Int, String, String)? = try await pg.withTransaction(logger: logger) { conn in
            let rows = try await conn.query(
                """
                WITH claimed AS (
                  SELECT id FROM outbox
                   WHERE kind = 'agent_job'
                     AND status = 'pending'
                     AND available_at <= now()
                   ORDER BY id
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1
                )
                UPDATE outbox o
                   SET status = 'processing', attempts = o.attempts + 1
                  FROM claimed c
                 WHERE o.id = c.id
                 RETURNING o.id, o.workspace_id, o.attempts, o.method, o.payload::text
                """,
                logger: logger
            ).collect()
            guard let first = rows.first else { return nil }
            return try first.decode((Int64, UUID, Int, String, String).self)
        }
        guard let (id, ws, attempts, method, payloadText) = row else { return nil }

        do {
            let payload = try Self.decoder.decode(
                AgentJobPayload.self, from: Data(payloadText.utf8))
            return ClaimedJob(
                id: id,
                workspaceID: ws,
                attempts: attempts,
                method: method,
                payload: payload
            )
        } catch {
            // Malformed payload can never succeed → fail permanently (no poison loop).
            logger.error("agent_job payload decode failed; marking failed", metadata: [
                "outboxId": .stringConvertible(id),
                "error": .string(String(describing: error)),
            ])
            await markJobFailed(id, reason: "payload decode: \(error)")
            return nil
        }
    }

    // MARK: - Process one job

    private struct AgentRealtimeContext: Sendable {
        let channel: String
        let channelID: UUID
        let agentMemberID: UUID
    }

    private func process(_ job: ClaimedJob) async {
        let p = job.payload
        let agentRealtime = AgentRealtimeContext(
            channel: "agent:ws\(job.workspaceID.uuidString).\(p.agentMemberID.uuidString)",
            channelID: p.channelID,
            agentMemberID: p.agentMemberID
        )
        logger.info("processing agent_job", metadata: [
            "outboxId": .stringConvertible(job.id),
            "runId": .string(p.runID?.uuidString ?? "nil"),
            "agentMemberId": .string(p.agentMemberID.uuidString),
            "channelId": .string(p.channelID.uuidString),
            "method": .string(job.method),
        ])

        await publishStatus(agentRealtime, runID: p.runID, status: .queued)

        if job.method == "resume_approval" || p.resumeFromApprovalID != nil {
            await processResumeApproval(job, agentRealtime: agentRealtime)
            return
        }

        // ---- §3.3 gates (stubs) ----
        let gateState = LoopGuards.RunGateState(
            stepCount: p.stepCount ?? 0,
            depth: p.depth ?? 0,
            consecutiveAuto: p.consecutiveAuto ?? 0,
            activeRunsForAgent: 0,
            lastContentHash: nil)
        if case .halt(let reason) = guards.evaluatePreInvoke(gateState) {
            logger.warning("run halted by loop guard", metadata: [
                "outboxId": .stringConvertible(job.id), "reason": .string(reason),
            ])
            await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .error, error: reason)
            await publishStatus(agentRealtime, runID: p.runID, status: .error, detail: reason)
            await markJobDone(job.id)
            return
        }

        // ---- §8.5 reserve (trip = abort before spend) ----
        let maxOutputTokens = p.maxOutputTokens ?? 1024
        let reserve = await cost.reserve(
            workspaceID: job.workspaceID, agentMemberID: p.agentMemberID,
            channelID: p.channelID, model: p.model, maxOutputTokens: maxOutputTokens)
        let reservedMicroUSD: Int64
        switch reserve {
        case .reserved(let est):
            reservedMicroUSD = est
            await recordCostProjection(
                p.runID,
                workspaceID: job.workspaceID,
                reservedMicroUSD: est
            )
        case .tripped(let grain):
            let reason = "G5 budget trip (\(grain))"
            logger.warning("budget circuit breaker tripped", metadata: [
                "outboxId": .stringConvertible(job.id), "grain": .string(grain),
            ])
            await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .error, error: reason)
            await publishStatus(agentRealtime, runID: p.runID, status: .error, detail: reason)
            await markJobDone(job.id)
            return
        }

        // ---- run → running; publish thinking ----
        // .thinking maps to the schema run_status 'running' in updateRunStatus.
        await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .thinking, error: nil)
        await publishStatus(agentRealtime, runID: p.runID, status: .thinking)

        // ---- hermes call + SSE stream → agent.partial + message PATCH ----
        var accumulatedText = ""
        var usage: (prompt: Int, completion: Int, cached: Int, reasoning: Int)?
        var sawError: String?

        // Streaming message id: created lazily on the first text delta so the
        // PATCH (streaming mimic) targets one growing message (L4 §6.2).
        var streamMessageID: UUID?

        let messages = [HermesTransport.ChatMessage(role: "user", content: p.prompt)]
        let stream = hermes.invoke(
            model: p.model, messages: messages, tools: p.tools, maxTokens: maxOutputTokens)

        do {
            for try await event in stream {
                if Task.isCancelled { break }
                switch event {
                case .status(let s):
                    await publishStatus(agentRealtime, runID: p.runID, status: s)

                case .textDelta(let delta):
                    accumulatedText += delta
                    // agent.partial: 1st-class streaming render (L4 §5.2).
                    await publishPartial(agentRealtime, runID: p.runID, delta: delta,
                                         fullText: accumulatedText)
                    // message PATCH: streaming mimic — upsert/patch the in-progress
                    // message body so reconnecting clients see partial state.
                    streamMessageID = await patchStreamingMessage(
                        existing: streamMessageID, job: job, body: accumulatedText)

                case .toolCall(let id, let name, let args):
                    // G6 approval gate: prefer Context Packet / Capability Cache
                    // tool grant metadata; missing or ambiguous metadata fails closed.
                    let toolGrant = p.toolGrant(for: name)
                    let needsApproval = guards.requiresApproval(
                        toolName: name,
                        toolGrants: p.toolGrants
                    )
                    logger.info("tool_call from hermes", metadata: [
                        "name": .string(name),
                        "callId": .string(id),
                        "needsApproval": .stringConvertible(needsApproval),
                        "approvalPolicy": .string(toolGrant?.approvalPolicy ?? "missing_or_ambiguous"),
                        "riskLevel": .string(toolGrant?.effectiveRiskLevel ?? "missing_or_ambiguous"),
                    ])
                    await publishToolCall(agentRealtime, runID: p.runID, callID: id,
                                          name: name, arguments: args)
                    if needsApproval {
                        let toolCall = ApprovalRuntime.ToolCall(
                            callID: id, name: name, arguments: args, toolGrant: toolGrant)
                        let pause = await recordApprovalPause(job: job, toolCall: toolCall)
                        switch pause {
                        case .paused(let approvalID, let requestMessageID):
                            logger.info("run paused for approval", metadata: [
                                "approvalId": .string(approvalID.uuidString),
                                "requestMessageId": .string(requestMessageID.uuidString),
                                "runId": .string(p.runID?.uuidString ?? "nil"),
                            ])
                            await publishStatus(agentRealtime, runID: p.runID,
                                                status: .awaitingApproval, detail: name)
                            await markJobDone(job.id)
                        case .failed(let reason):
                            await updateRunStatus(p.runID, workspaceID: job.workspaceID,
                                                  status: .error, error: reason)
                            await publishStatus(agentRealtime, runID: p.runID,
                                                status: .error, detail: reason)
                            await markJobFailed(job.id, reason: reason)
                        }
                        return
                    }

                case .usage(let prompt, let completion, let cached, let reasoning):
                    usage = (prompt, completion, cached, reasoning)

                case .finished:
                    break

                case .error(let msg):
                    sawError = msg
                }
            }
        } catch {
            sawError = "stream error: \(error)"
        }

        // ---- §8.5 reconcile (usage may be absent → was_estimated) ----
        let wasEstimated = usage == nil
        let u = usage ?? (prompt: 0, completion: 0, cached: 0, reasoning: 0)
        await cost.reconcile(
            workspaceID: job.workspaceID, runID: p.runID, agentMemberID: p.agentMemberID,
            channelID: p.channelID, model: p.model,
            promptTokens: u.prompt, completionTokens: u.completion,
            cachedTokens: u.cached, reasoningTokens: u.reasoning,
            wasEstimated: wasEstimated, reservedMicroUSD: reservedMicroUSD)
        await recordCostProjection(
            p.runID,
            workspaceID: job.workspaceID,
            reservedMicroUSD: 0
        )

        // ---- terminal: finalize message + status ----
        if let err = sawError {
            await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .error, error: err)
            await publishStatus(agentRealtime, runID: p.runID, status: .error, detail: err)
            // Streaming failures are transient at the transport level → requeue.
            await requeueJob(job, reason: err)
            return
        }

        await finalizeStreamingMessage(streamMessageID, job: job, body: accumulatedText)
        await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .done, error: nil)
        await publishStatus(agentRealtime, runID: p.runID, status: .done)
        await markJobDone(job.id)
    }

    // MARK: - approval resume executor (MOMO-178)

    private struct ApprovalResumeState: Sendable {
        let status: String
        let runID: UUID
        let channelID: UUID
        let requestedBy: UUID
        let payload: JSONValue
    }

    private func processResumeApproval(_ job: ClaimedJob, agentRealtime: AgentRealtimeContext) async {
        let p = job.payload
        let request: ToolResumeExecutor.ValidatedRequest
        do {
            request = try resumeExecutor.validate(p)
        } catch {
            let reason = "resume approval validation failed: \(error)"
            logger.warning("resume_approval validation failed", metadata: [
                "outboxId": .stringConvertible(job.id),
                "runId": .string(p.runID?.uuidString ?? "nil"),
                "approvalId": .string(p.resumeFromApprovalID?.uuidString ?? "nil"),
                "error": .string(String(describing: error)),
            ])
            await recordResumeFailure(
                job: job,
                runID: p.runID,
                approvalID: p.resumeFromApprovalID,
                reason: reason,
                markRunFailed: p.runID != nil
            )
            await publishStatus(agentRealtime, runID: p.runID, status: .error, detail: reason)
            return
        }

        do {
            let state = try await loadApprovalResumeState(
                workspaceID: job.workspaceID,
                approvalID: request.approvalID
            )
            try validateResumeState(state, job: job, request: request)

            await updateRunStatus(
                request.runID,
                workspaceID: job.workspaceID,
                status: .thinking,
                error: nil
            )
            await publishStatus(agentRealtime, runID: request.runID, status: .thinking)

            let result = try resumeExecutor.execute(request)
            try await recordResumeSuccess(job: job, request: request, result: result)
            await publishStatus(agentRealtime, runID: request.runID, status: .done)
        } catch {
            let reason = "resume approval execution failed: \(error)"
            let markRunFailed: Bool
            if let resumeError = error as? ResumeApprovalError,
               case .approvalNotApproved = resumeError
            {
                markRunFailed = false
            } else {
                markRunFailed = true
            }
            logger.error("resume_approval execution failed", metadata: [
                "outboxId": .stringConvertible(job.id),
                "runId": .string(request.runID.uuidString),
                "approvalId": .string(request.approvalID.uuidString),
                "toolName": .string(request.toolCall.name),
                "error": .string(String(describing: error)),
            ])
            await recordResumeFailure(
                job: job,
                runID: request.runID,
                approvalID: request.approvalID,
                reason: reason,
                markRunFailed: markRunFailed
            )
            await publishStatus(agentRealtime, runID: request.runID, status: .error, detail: reason)
        }
    }

    private func loadApprovalResumeState(
        workspaceID: UUID,
        approvalID: UUID
    ) async throws -> ApprovalResumeState {
        try await pg.withTransaction(logger: logger) { conn in
            _ = try await conn.query(
                "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
                logger: logger)
            let rows = try await conn.query(
                """
                SELECT status::text, run_id, channel_id, requested_by, payload::text
                  FROM approval
                 WHERE id = \(approvalID)
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
            guard let row = rows.first else {
                throw ResumeApprovalError.approvalNotFound(approvalID)
            }
            let (status, runID, channelID, requestedBy, payloadText) =
                try row.decode((String, UUID, UUID, UUID, String).self)
            let payload = try Self.decoder.decode(JSONValue.self, from: Data(payloadText.utf8))
            return ApprovalResumeState(
                status: status,
                runID: runID,
                channelID: channelID,
                requestedBy: requestedBy,
                payload: payload
            )
        }
    }

    private func validateResumeState(
        _ state: ApprovalResumeState,
        job: ClaimedJob,
        request: ToolResumeExecutor.ValidatedRequest
    ) throws {
        guard state.status == "approved" else {
            throw ResumeApprovalError.approvalNotApproved(state.status)
        }
        guard state.runID == request.runID else {
            throw ResumeApprovalError.runMismatch(expected: state.runID, actual: request.runID)
        }
        guard state.channelID == job.payload.channelID else {
            throw ResumeApprovalError.channelMismatch(expected: state.channelID, actual: job.payload.channelID)
        }
        guard state.requestedBy == job.payload.agentMemberID else {
            throw ResumeApprovalError.agentMismatch(expected: state.requestedBy, actual: job.payload.agentMemberID)
        }
        let frozenTool = state.payload["tool_call"]
        guard frozenTool?["call_id"]?.stringValue == request.toolCall.callID else {
            throw ResumeApprovalError.frozenPayloadMismatch("call_id")
        }
        guard frozenTool?["name"]?.stringValue == request.toolCall.name else {
            throw ResumeApprovalError.frozenPayloadMismatch("name")
        }
        guard frozenTool?["arguments"] == request.toolCall.arguments else {
            throw ResumeApprovalError.frozenPayloadMismatch("arguments")
        }
    }

    private enum ResumeApprovalError: Error, CustomStringConvertible, Sendable {
        case approvalNotFound(UUID)
        case approvalNotApproved(String)
        case runMismatch(expected: UUID, actual: UUID)
        case channelMismatch(expected: UUID, actual: UUID)
        case agentMismatch(expected: UUID, actual: UUID)
        case frozenPayloadMismatch(String)
        case missingInsertedToolResult

        var description: String {
            switch self {
            case .approvalNotFound(let id):
                return "approval not found: \(id.uuidString)"
            case .approvalNotApproved(let status):
                return "approval is \(status), not approved"
            case .runMismatch(let expected, let actual):
                return "resume run mismatch: expected \(expected.uuidString), got \(actual.uuidString)"
            case .channelMismatch(let expected, let actual):
                return "resume channel mismatch: expected \(expected.uuidString), got \(actual.uuidString)"
            case .agentMismatch(let expected, let actual):
                return "resume agent mismatch: expected \(expected.uuidString), got \(actual.uuidString)"
            case .frozenPayloadMismatch(let field):
                return "approved_tool_call does not match frozen approval payload field: \(field)"
            case .missingInsertedToolResult:
                return "tool_result insert did not return a row"
            }
        }
    }

    private func recordResumeSuccess(
        job: ClaimedJob,
        request: ToolResumeExecutor.ValidatedRequest,
        result: ToolResumeExecutor.Result
    ) async throws {
        let p = job.payload
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        let props = Self.toolResultProps(
            request: request,
            output: result.output,
            isError: result.isError
        )

        try await pg.withTransaction(logger: logger) { conn in
            _ = try await conn.query(
                "SELECT set_config('app.workspace_id', \(job.workspaceID.uuidString), true)",
                logger: logger)

            _ = try await conn.query(
                """
                UPDATE agent_run
                   SET status = 'running',
                       started_at = COALESCE(started_at, now()),
                       updated_at = now(),
                       error = NULL,
                       finished_at = NULL
                 WHERE id = \(request.runID)
                """,
                logger: logger
            )

            let rows = try await conn.query(
                """
                WITH bumped AS (
                  UPDATE channel_seq
                     SET last_seq = last_seq + 1
                   WHERE channel_id = \(p.channelID)
                  RETURNING last_seq AS seq
                )
                INSERT INTO message
                  (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                   author_member_id, type, body, props, run_id)
                SELECT \(job.workspaceID), \(p.channelID), b.seq, \(hlcTs), 0,
                       \(p.agentMemberID), 'tool_result'::message_type,
                       \(result.body), \(props)::jsonb, \(request.runID)
                  FROM bumped b
                RETURNING id, seq
                """,
                logger: logger
            ).collect()
            guard let row = rows.first else {
                throw ResumeApprovalError.missingInsertedToolResult
            }
            let (messageID, seq) = try row.decode((UUID, Int64).self)

            let outboxPayload = Self.toolResultBroadcastPayload(
                workspaceID: job.workspaceID,
                channelID: p.channelID,
                messageID: messageID,
                seq: seq,
                authorMemberID: p.agentMemberID,
                runID: request.runID,
                body: result.body,
                props: props,
                hlcTs: hlcTs
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(job.workspaceID), 'broadcast', 'publish',
                   \(outboxPayload)::jsonb, \(p.channelID))
                """,
                logger: logger
            )

            let detail = Self.resumeAuditDetail(
                request: request,
                output: result.output,
                error: nil
            )
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, run_id, detail)
                VALUES
                  (\(job.workspaceID), \(p.agentMemberID),
                   'approval.resume', 'approval', \(request.approvalID),
                   \(request.runID), \(detail)::jsonb),
                  (\(job.workspaceID), \(p.agentMemberID),
                   'tool.executed', 'message', \(messageID),
                   \(request.runID), \(detail)::jsonb)
                """,
                logger: logger
            )

            _ = try await conn.query(
                """
                UPDATE agent_run
                   SET status = 'succeeded',
                       output = \(result.output.jsonString())::jsonb,
                       error = NULL,
                       updated_at = now(),
                       finished_at = now()
                 WHERE id = \(request.runID)
                """,
                logger: logger
            )

            _ = try await conn.query(
                """
                UPDATE outbox
                   SET status = 'done',
                       processed_at = now(),
                       last_error = NULL
                 WHERE id = \(job.id)
                """,
                logger: logger
            )
        }
    }

    private func recordResumeFailure(
        job: ClaimedJob,
        runID: UUID?,
        approvalID: UUID?,
        reason: String,
        markRunFailed: Bool
    ) async {
        do {
            try await pg.withTransaction(logger: logger) { conn in
                _ = try await conn.query(
                    "SELECT set_config('app.workspace_id', \(job.workspaceID.uuidString), true)",
                    logger: logger)

                if markRunFailed, let runID {
                    _ = try await conn.query(
                        """
                        UPDATE agent_run
                           SET status = 'failed',
                               error = jsonb_build_object(
                                 'code', 'approval_resume_failed',
                                 'reason', \(reason)
                               ),
                               updated_at = now(),
                               finished_at = now()
                         WHERE id = \(runID)
                        """,
                        logger: logger
                    )
                }

                let detail = Self.resumeFailureAuditDetail(
                    job: job,
                    runID: runID,
                    approvalID: approvalID,
                    reason: reason
                )
                if let approvalID, let runID {
                    _ = try await conn.query(
                        """
                        INSERT INTO audit_log
                          (workspace_id, actor_member_id, action, target_type,
                           target_id, run_id, detail)
                        VALUES
                          (\(job.workspaceID), \(job.payload.agentMemberID),
                           'approval.resume_failed', 'approval', \(approvalID),
                           \(runID), \(detail)::jsonb),
                          (\(job.workspaceID), \(job.payload.agentMemberID),
                           'tool.failed', 'approval', \(approvalID),
                           \(runID), \(detail)::jsonb)
                        """,
                        logger: logger
                    )
                } else {
                    _ = try await conn.query(
                        """
                        INSERT INTO audit_log
                          (workspace_id, actor_member_id, action, target_type,
                           target_id, run_id, detail)
                        VALUES
                          (\(job.workspaceID), \(job.payload.agentMemberID),
                           'approval.resume_failed', 'outbox', NULL,
                           NULL, \(detail)::jsonb)
                        """,
                        logger: logger
                    )
                }

                _ = try await conn.query(
                    """
                    UPDATE outbox
                       SET status = 'failed',
                           processed_at = now(),
                           last_error = \(reason)
                     WHERE id = \(job.id)
                    """,
                    logger: logger
                )
            }
        } catch {
            logger.error("resume failure record failed", metadata: [
                "outboxId": .stringConvertible(job.id),
                "error": .string(String(describing: error)),
            ])
            await markJobFailed(job.id, reason: reason)
        }
    }

    // MARK: - approval pause checkpoint (MOMO-161)

    private enum ApprovalPauseRecord: Sendable {
        case paused(approvalID: UUID, requestMessageID: UUID)
        case failed(reason: String)
    }

    /// Persist the protocol checkpoint:
    /// tool_call -> approval(status=pending) -> approval_request message ->
    /// agent_run(status=awaiting_approval) -> audit_log, all in one DB tx.
    ///
    /// The claimed `agent_job` is completed after this commit; the run remains
    /// awaiting approval. The future decision endpoint resumes the same run by
    /// enqueueing a new `agent_job` payload with the same run_id.
    private func recordApprovalPause(
        job: ClaimedJob,
        toolCall: ApprovalRuntime.ToolCall
    ) async -> ApprovalPauseRecord {
        let p = job.payload
        guard let runID = p.runID else {
            return .failed(reason: "approval pause requires agent_job.payload.run_id")
        }

        let plan = ApprovalRuntime.pausePlan(for: toolCall)
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        let hlcCount = 0
        let body = "Approval required: \(toolCall.name)"
        let approvalPayload = Self.approvalPayload(plan: plan, runID: runID)

        do {
            let result: (UUID, UUID) = try await pg.withTransaction(logger: logger) { conn in
                _ = try await conn.query(
                    "SELECT set_config('app.workspace_id', \(job.workspaceID.uuidString), true)",
                    logger: logger)

                let approvalRows = try await conn.query(
                    """
                    INSERT INTO approval
                      (workspace_id, run_id, channel_id, requested_by,
                       action_type, payload, status)
                    VALUES
                      (\(job.workspaceID), \(runID), \(p.channelID), \(p.agentMemberID),
                       \(plan.actionType), \(approvalPayload)::jsonb,
                       \(plan.approvalStatus)::approval_status)
                    RETURNING id
                    """,
                    logger: logger
                ).collect()
                guard let approvalRow = approvalRows.first else {
                    throw ApprovalPauseError.missingInsertedApproval
                }
                let approvalID = try approvalRow.decode(UUID.self)

                let props = Self.approvalRequestProps(
                    approvalID: approvalID,
                    runID: runID,
                    channelID: p.channelID,
                    actionType: plan.actionType,
                    toolCall: toolCall
                )
                let messageRows = try await conn.query(
                    """
                    WITH bumped AS (
                      UPDATE channel_seq
                         SET last_seq = last_seq + 1
                       WHERE channel_id = \(p.channelID)
                      RETURNING last_seq AS seq
                    )
                    INSERT INTO message
                      (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                       author_member_id, type, body, props, run_id)
                    SELECT \(job.workspaceID), \(p.channelID), b.seq, \(hlcTs), \(hlcCount),
                           \(p.agentMemberID), \(plan.messageType)::message_type,
                           \(body), \(props)::jsonb, \(runID)
                      FROM bumped b
                    RETURNING id, seq
                    """,
                    logger: logger
                ).collect()
                guard let messageRow = messageRows.first else {
                    throw ApprovalPauseError.missingInsertedMessage
                }
                let (messageID, seq) = try messageRow.decode((UUID, Int64).self)

                _ = try await conn.query(
                    """
                    UPDATE approval
                       SET request_message_id = \(messageID)
                     WHERE id = \(approvalID)
                    """,
                    logger: logger
                )

                _ = try await conn.query(
                    """
                    UPDATE agent_run
                       SET status = \(plan.runStatus.rawValue)::run_status,
                           updated_at = now()
                     WHERE id = \(runID)
                    """,
                    logger: logger
                )

                let outboxPayload = Self.approvalRequestBroadcastPayload(
                    workspaceID: job.workspaceID,
                    channelID: p.channelID,
                    messageID: messageID,
                    seq: seq,
                    authorMemberID: p.agentMemberID,
                    runID: runID,
                    body: body,
                    props: props,
                    hlcTs: hlcTs,
                    hlcCount: hlcCount
                )
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(job.workspaceID), 'broadcast', 'publish',
                       \(outboxPayload)::jsonb, \(p.channelID))
                    """,
                    logger: logger
                )

                _ = try await conn.query(
                    """
                    INSERT INTO audit_log
                      (workspace_id, actor_member_id, action, target_type,
                       target_id, run_id, detail)
                    VALUES
                      (\(job.workspaceID), \(p.agentMemberID),
                       \(plan.auditAction), 'approval', \(approvalID), \(runID),
                       \(approvalPayload)::jsonb)
                    """,
                    logger: logger
                )

                return (approvalID, messageID)
            }
            return .paused(approvalID: result.0, requestMessageID: result.1)
        } catch {
            logger.error("approval pause record failed", metadata: [
                "runId": .string(runID.uuidString),
                "toolName": .string(toolCall.name),
                "error": .string(String(describing: error)),
            ])
            return .failed(reason: "approval pause failed: \(error)")
        }
    }

    private enum ApprovalPauseError: Error, Sendable {
        case missingInsertedApproval
        case missingInsertedMessage
    }

    private static func approvalPayload(
        plan: ApprovalRuntime.PausePlan,
        runID: UUID
    ) -> String {
        var toolCall: [String: Any] = [
            "call_id": plan.toolCall.callID,
            "name": plan.toolCall.name,
            "arguments": plan.toolCall.arguments,
        ]
        if let toolGrant = plan.toolCall.toolGrant {
            toolCall["tool_grant"] = toolGrant.jsonObject()
        }

        return jsonString([
            "run_id": runID.uuidString,
            "action_type": plan.actionType,
            "tool_call": toolCall,
            "resume_model": "same_run_new_agent_job",
        ])
    }

    private static func approvalRequestProps(
        approvalID: UUID,
        runID: UUID,
        channelID: UUID,
        actionType: String,
        toolCall: ApprovalRuntime.ToolCall
    ) -> String {
        var props: [String: Any] = [
            "approval_id": approvalID.uuidString,
            "run_id": runID.uuidString,
            "channel_id": channelID.uuidString,
            "action_type": actionType,
            "call_id": toolCall.callID,
            "tool_name": toolCall.name,
            "title": "Approve \(toolCall.name)",
            "summary": "Review the proposed tool call before momo executes it.",
            "arguments": toolCall.arguments,
            "status": "pending",
        ]
        if let toolGrant = toolCall.toolGrant {
            props["tool_grant"] = toolGrant.jsonObject()
        }
        return jsonString(props)
    }

    private static func approvalRequestBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        seq: Int64,
        authorMemberID: UUID,
        runID: UUID,
        body: String,
        props: String,
        hlcTs: Int64,
        hlcCount: Int
    ) -> String {
        let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        let propsObject = (try? JSONSerialization.jsonObject(with: Data(props.utf8))) ?? [:]
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
                    "type": "approval_request",
                    "body": body,
                    "props": propsObject,
                    "author_member_id": authorMemberID.uuidString,
                    "authorMemberId": authorMemberID.uuidString,
                    "run_id": runID.uuidString,
                    "runId": runID.uuidString,
                    "hlc_ts": hlcTs,
                    "hlcTs": hlcTs,
                    "hlc_count": hlcCount,
                    "hlcCount": hlcCount,
                ],
            ],
            "version": seq,
            "idempotency_key": "\(centChannel):\(seq)",
        ])
    }

    private static func toolResultProps(
        request: ToolResumeExecutor.ValidatedRequest,
        output: JSONValue,
        isError: Bool
    ) -> String {
        jsonString([
            "call_id": request.toolCall.callID,
            "tool_name": request.toolCall.name,
            "approval_id": request.approvalID.uuidString,
            "run_id": request.runID.uuidString,
            "payload_sha256": request.toolCall.payloadSHA256.map { $0 as Any } ?? NSNull(),
            "output": anyValue(output),
            "is_error": isError,
            "executor": "agentworker.resume_approval.v0",
        ])
    }

    private static func toolResultBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        seq: Int64,
        authorMemberID: UUID,
        runID: UUID,
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
                    "type": "tool_result",
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

    private static func resumeAuditDetail(
        request: ToolResumeExecutor.ValidatedRequest,
        output: JSONValue,
        error: String?
    ) -> String {
        jsonString([
            "approval_id": request.approvalID.uuidString,
            "run_id": request.runID.uuidString,
            "tool_call": [
                "call_id": request.toolCall.callID,
                "name": request.toolCall.name,
                "arguments": anyValue(request.toolCall.arguments),
                "payload_sha256": request.toolCall.payloadSHA256.map { $0 as Any } ?? NSNull(),
            ],
            "policy_evidence": request.policyEvidence.jsonObject(),
            "output": anyValue(output),
            "error": error ?? NSNull(),
            "executor": "agentworker.resume_approval.v0",
        ])
    }

    private static func resumeFailureAuditDetail(
        job: ClaimedJob,
        runID: UUID?,
        approvalID: UUID?,
        reason: String
    ) -> String {
        var object: [String: Any] = [
            "outbox_id": job.id,
            "outbox_method": job.method,
            "agent_member_id": job.payload.agentMemberID.uuidString,
            "channel_id": job.payload.channelID.uuidString,
            "reason": reason,
            "executor": "agentworker.resume_approval.v0",
        ]
        if let runID {
            object["run_id"] = runID.uuidString
        }
        if let approvalID {
            object["approval_id"] = approvalID.uuidString
        }
        if let toolCall = job.payload.approvedToolCall {
            object["tool_call"] = [
                "call_id": toolCall.callID,
                "name": toolCall.name,
                "arguments": anyValue(toolCall.arguments),
                "payload_sha256": toolCall.payloadSHA256.map { $0 as Any } ?? NSNull(),
            ]
        }
        return jsonString(object)
    }

    private static func jsonObject(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any]
        else { return [:] }
        return dict
    }

    private static func anyValue(_ value: JSONValue) -> Any {
        switch value {
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
        case .object(let object):
            return object.mapValues(anyValue)
        case .array(let array):
            return array.map(anyValue)
        }
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
              ),
              let string = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return string
    }

    // MARK: - message PATCH (streaming mimic, L4 §6.2)

    /// PATCH the in-progress agent message (streaming mimic). v0 stub: the durable
    /// agent message lands via the canonical REST/outbox→relay path; here we only
    /// log the intended body PATCH and mint a stable message id so partial state is
    /// addressable on reconnect.
    ///
    /// TODO (L4 §3.1 / §6.2): on first delta, INSERT a `message` (type='text',
    /// state='sent', run_id) via the §3.1 seq-bump tx + outbox(broadcast); on
    /// subsequent deltas, `UPDATE message SET body=$body, edited_at=now()` +
    /// outbox(broadcast 'message.edited'). For v0 the per-delta agent.partial
    /// publish already drives the live render.
    private func patchStreamingMessage(
        existing: UUID?, job: ClaimedJob, body: String
    ) async -> UUID {
        let id = existing ?? UUID()
        logger.debug("message PATCH (streaming mimic, stub)", metadata: [
            "messageId": .string(id.uuidString),
            "bodyLen": .stringConvertible(body.count),
            "new": .stringConvertible(existing == nil),
        ])
        return id
    }

    /// Mark the streaming message final (state stays 'sent'; edited_at cleared in
    /// the real path). v0 stub logs only — the durable insert is the REST path's job.
    private func finalizeStreamingMessage(_ id: UUID?, job: ClaimedJob, body: String) async {
        guard let id else { return }
        logger.debug("message finalize (stub)", metadata: [
            "messageId": .string(id.uuidString),
            "finalBodyLen": .stringConvertible(body.count),
        ])
    }

    // MARK: - agent.status / agent.partial publishes (L4 §5.2)

    private func publishStatus(
        _ context: AgentRealtimeContext, runID: UUID?, status: RunStatus, detail: String? = nil
    ) async {
        guard let runID else {
            logger.debug("skipping agent.status without run_id", metadata: [
                "channel": .string(context.channel),
                "status": .string(status.rawValue),
            ])
            return
        }
        var payload: [String: JSONValue] = [
            "agent_member_id": .string(context.agentMemberID.uuidString),
            "channel_id": .string(context.channelID.uuidString),
            "phase": .string(Self.agentPhase(status).rawValue),
            "run_status": .string(Self.clientRunStatus(status)),
            "run_id": .string(runID.uuidString),
        ]
        if let detail { payload["detail"] = .string(detail) }
        await centrifugo.publish(
            channel: context.channel,
            data: envelope(type: "agent.status", payload: payload)
        )
    }

    private func recordCostProjection(
        _ runID: UUID?,
        workspaceID: UUID,
        reservedMicroUSD: Int64
    ) async {
        guard let runID else { return }
        do {
            try await pg.withTransaction(logger: logger) { conn in
                _ = try await conn.query(
                    "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
                    logger: logger
                )
                _ = try await conn.query(
                    """
                    UPDATE agent_run
                       SET input = jsonb_set(
                             jsonb_set(
                               jsonb_set(input, '{cost_projection}', '{}'::jsonb, true),
                               '{cost_projection,reserved_micro_usd}',
                               to_jsonb(\(reservedMicroUSD)::bigint),
                               true
                             ),
                             '{cost_projection,source}',
                             to_jsonb('agent_worker'::text),
                             true
                           ),
                           updated_at = now()
                     WHERE id = \(runID)
                    """,
                    logger: logger
                )
            }
        } catch {
            logger.error("cost projection update failed", metadata: [
                "runId": .string(runID.uuidString),
                "error": .string(String(describing: error)),
            ])
        }
    }

    private func publishPartial(
        _ context: AgentRealtimeContext, runID: UUID?, delta: String, fullText: String
    ) async {
        guard let runID else {
            logger.debug("skipping agent.partial without run_id", metadata: [
                "channel": .string(context.channel),
            ])
            return
        }
        let payload: [String: JSONValue] = [
            "channel_id": .string(context.channelID.uuidString),
            "run_id": .string(runID.uuidString),
            "text_delta": .string(delta),
            "text": .string(fullText),
        ]
        await centrifugo.publish(
            channel: context.channel,
            data: envelope(type: "agent.partial", payload: payload)
        )
    }

    private func publishToolCall(
        _ context: AgentRealtimeContext, runID: UUID?, callID: String, name: String, arguments: String
    ) async {
        guard let runID else {
            logger.debug("skipping agent.partial tool call without run_id", metadata: [
                "channel": .string(context.channel),
                "tool": .string(name),
            ])
            return
        }
        let payload: [String: JSONValue] = [
            "channel_id": .string(context.channelID.uuidString),
            "run_id": .string(runID.uuidString),
            "tool_call_args": .string(arguments),
            "tool_call_id": .string(callID),
            "tool_call_name": .string(name),
        ]
        await centrifugo.publish(
            channel: context.channel,
            data: envelope(type: "agent.partial", payload: payload)
        )
    }

    /// L4 §5.2 single envelope: {type, v, ts, payload}.
    private func envelope(type: String, payload: [String: JSONValue]) -> JSONValue {
        .object([
            "type": .string(type),
            "v": .int(1),
            "ts": .int(Int64(Date().timeIntervalSince1970 * 1000)),
            "payload": .object(payload),
        ])
    }

    private enum AgentPhase: String {
        case queued
        case thinking
        case streaming
        case done
        case error
    }

    private static func agentPhase(_ status: RunStatus) -> AgentPhase {
        switch status {
        case .queued: return .queued
        case .thinking, .awaitingApproval: return .thinking
        case .streaming: return .streaming
        case .done: return .done
        case .error, .cancelled, .timedOut: return .error
        }
    }

    private static func clientRunStatus(_ status: RunStatus) -> String {
        switch status {
        case .queued: return "queued"
        case .thinking, .streaming: return "running"
        case .awaitingApproval: return "awaiting_approval"
        case .done: return "succeeded"
        case .error: return "failed"
        case .cancelled: return "cancelled"
        case .timedOut: return "timed_out"
        }
    }

    // MARK: - agent_run status transitions (stub-aware)

    /// Update the run's state-machine row. v0 best-effort: failures logged, not
    /// fatal (the job-status transition is the durable progress marker).
    private func updateRunStatus(
        _ runID: UUID?, workspaceID: UUID, status: RunStatus, error: String?
    ) async {
        guard let runID else { return }
        // Map worker RunStatus → schema run_status enum (thinking/streaming are
        // worker-stream states → 'running'; done → 'succeeded'; error → 'failed').
        let dbStatus: String
        switch status {
        case .queued: dbStatus = "queued"
        case .thinking, .streaming: dbStatus = "running"
        case .awaitingApproval: dbStatus = "awaiting_approval"
        case .done: dbStatus = "succeeded"
        case .error: dbStatus = "failed"
        case .cancelled: dbStatus = "cancelled"
        case .timedOut: dbStatus = "timed_out"
        }
        do {
            try await pg.withTransaction(logger: logger) { conn in
                _ = try await conn.query(
                    "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
                    logger: logger)
                if let error {
                    _ = try await conn.query(
                        """
                        UPDATE agent_run
                           SET status = \(dbStatus)::run_status,
                               error = to_jsonb(\(error)::text),
                               updated_at = now(),
                               finished_at = CASE WHEN \(dbStatus) IN ('succeeded','failed','cancelled','timed_out')
                                                  THEN now() ELSE finished_at END
                         WHERE id = \(runID)
                        """,
                        logger: logger)
                } else {
                    _ = try await conn.query(
                        """
                        UPDATE agent_run
                           SET status = \(dbStatus)::run_status,
                               error = NULL,
                               updated_at = now(),
                               finished_at = CASE WHEN \(dbStatus) IN ('succeeded','failed','cancelled','timed_out')
                                                  THEN now() ELSE finished_at END
                         WHERE id = \(runID)
                        """,
                        logger: logger)
                }
            }
        } catch {
            logger.warning("agent_run status update failed (non-fatal)", metadata: [
                "runId": .string(runID.uuidString),
                "error": .string(String(describing: error)),
            ])
        }
    }

    // MARK: - job status transitions (outbox)

    private func markJobDone(_ id: Int64) async {
        await runJobUpdate(
            "UPDATE outbox SET status='done', processed_at=now(), last_error=NULL WHERE id=\(id)",
            context: "markJobDone(\(id))")
    }

    private func markJobFailed(_ id: Int64, reason: String) async {
        await runJobUpdate(
            "UPDATE outbox SET status='failed', last_error=\(reason), processed_at=now() WHERE id=\(id)",
            context: "markJobFailed(\(id))")
    }

    /// Transient failure: retry with exponential backoff, or give up after
    /// maxAttempts (deterministic — attempts already incremented on claim).
    private func requeueJob(_ job: ClaimedJob, reason: String) async {
        if job.attempts >= config.maxAttempts {
            logger.error("max attempts reached; marking job failed", metadata: [
                "outboxId": .stringConvertible(job.id),
                "attempts": .stringConvertible(job.attempts),
            ])
            await markJobFailed(job.id, reason: "max attempts: \(reason)")
            return
        }
        let backoffSeconds = min(Int(pow(2.0, Double(job.attempts))), 60)
        logger.warning("transient job failure; requeueing", metadata: [
            "outboxId": .stringConvertible(job.id),
            "attempts": .stringConvertible(job.attempts),
            "backoffSeconds": .stringConvertible(backoffSeconds),
        ])
        await runJobUpdate(
            """
            UPDATE outbox
               SET status='pending',
                   available_at = now() + (\(backoffSeconds) * interval '1 second'),
                   last_error = \(reason)
             WHERE id = \(job.id)
            """,
            context: "requeueJob(\(job.id))")
    }

    private func runJobUpdate(_ query: PostgresQuery, context: String) async {
        do {
            _ = try await pg.query(query, logger: logger)
        } catch {
            logger.error("outbox job status update failed", metadata: [
                "op": .string(context),
                "error": .string(String(describing: error)),
            ])
        }
    }
}
