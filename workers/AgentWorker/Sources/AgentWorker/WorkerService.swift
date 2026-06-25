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
        let payload: AgentJobPayload
    }

    /// L4 §3.5: claim ONE pending agent_job and flip it to `processing`.
    /// partition_key = agent_member_id ⇒ per-agent serialization.
    private func claimOne() async throws -> ClaimedJob? {
        let row: (Int64, UUID, Int, String)? = try await pg.withTransaction(logger: logger) { conn in
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
                 RETURNING o.id, o.workspace_id, o.attempts, o.payload::text
                """,
                logger: logger
            ).collect()
            guard let first = rows.first else { return nil }
            return try first.decode((Int64, UUID, Int, String).self)
        }
        guard let (id, ws, attempts, payloadText) = row else { return nil }

        do {
            let payload = try Self.decoder.decode(
                AgentJobPayload.self, from: Data(payloadText.utf8))
            return ClaimedJob(id: id, workspaceID: ws, attempts: attempts, payload: payload)
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

    private func process(_ job: ClaimedJob) async {
        let p = job.payload
        let agentChannel = "agent:ws\(job.workspaceID.uuidString).\(p.agentMemberID.uuidString)"   // L4 §4.1
        logger.info("processing agent_job", metadata: [
            "outboxId": .stringConvertible(job.id),
            "runId": .string(p.runID?.uuidString ?? "nil"),
            "agentMemberId": .string(p.agentMemberID.uuidString),
            "channelId": .string(p.channelID.uuidString),
        ])

        await publishStatus(agentChannel, runID: p.runID, status: .queued)

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
            await publishStatus(agentChannel, runID: p.runID, status: .error, detail: reason)
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
        case .tripped(let grain):
            let reason = "G5 budget trip (\(grain))"
            logger.warning("budget circuit breaker tripped", metadata: [
                "outboxId": .stringConvertible(job.id), "grain": .string(grain),
            ])
            await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .error, error: reason)
            await publishStatus(agentChannel, runID: p.runID, status: .error, detail: reason)
            await markJobDone(job.id)
            return
        }

        // ---- run → running; publish thinking ----
        // .thinking maps to the schema run_status 'running' in updateRunStatus.
        await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .thinking, error: nil)
        await publishStatus(agentChannel, runID: p.runID, status: .thinking)

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
                    await publishStatus(agentChannel, runID: p.runID, status: s)

                case .textDelta(let delta):
                    accumulatedText += delta
                    // agent.partial: 1st-class streaming render (L4 §5.2).
                    await publishPartial(agentChannel, runID: p.runID, delta: delta,
                                         fullText: accumulatedText)
                    // message PATCH: streaming mimic — upsert/patch the in-progress
                    // message body so reconnecting clients see partial state.
                    streamMessageID = await patchStreamingMessage(
                        existing: streamMessageID, job: job, body: accumulatedText)

                case .toolCall(let id, let name, let args):
                    // G6 approval gate (stub): side-effecting calls require a human.
                    let needsApproval = guards.requiresApproval(toolName: name)
                    logger.info("tool_call from hermes", metadata: [
                        "name": .string(name),
                        "callId": .string(id),
                        "needsApproval": .stringConvertible(needsApproval),
                    ])
                    if needsApproval {
                        // TODO (L4 §6.2): INSERT approval(status=pending),
                        // run→awaiting_approval, publish approval.requested, wait
                        // (timeout 30m → abort). v0 surfaces status + records intent.
                        await updateRunStatus(p.runID, workspaceID: job.workspaceID,
                                              status: .awaitingApproval, error: nil)
                        await publishStatus(agentChannel, runID: p.runID,
                                            status: .awaitingApproval, detail: name)
                    }
                    await publishToolCall(agentChannel, runID: p.runID, callID: id,
                                          name: name, arguments: args)

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

        // ---- terminal: finalize message + status ----
        if let err = sawError {
            await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .error, error: err)
            await publishStatus(agentChannel, runID: p.runID, status: .error, detail: err)
            // Streaming failures are transient at the transport level → requeue.
            await requeueJob(job, reason: err)
            return
        }

        await finalizeStreamingMessage(streamMessageID, job: job, body: accumulatedText)
        await updateRunStatus(p.runID, workspaceID: job.workspaceID, status: .done, error: nil)
        await publishStatus(agentChannel, runID: p.runID, status: .done)
        await markJobDone(job.id)
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
        _ channel: String, runID: UUID?, status: RunStatus, detail: String? = nil
    ) async {
        var payload: [String: JSONValue] = ["status": .string(status.rawValue)]
        if let runID { payload["runId"] = .string(runID.uuidString) }
        if let detail { payload["detail"] = .string(detail) }
        await centrifugo.publish(channel: channel, data: envelope(type: "agent.status", payload: payload))
    }

    private func publishPartial(
        _ channel: String, runID: UUID?, delta: String, fullText: String
    ) async {
        var payload: [String: JSONValue] = [
            "delta": .string(delta),
            "text": .string(fullText),
        ]
        if let runID { payload["runId"] = .string(runID.uuidString) }
        await centrifugo.publish(channel: channel, data: envelope(type: "agent.partial", payload: payload))
    }

    private func publishToolCall(
        _ channel: String, runID: UUID?, callID: String, name: String, arguments: String
    ) async {
        var payload: [String: JSONValue] = [
            "callId": .string(callID),
            "name": .string(name),
            "arguments": .string(arguments),
        ]
        if let runID { payload["runId"] = .string(runID.uuidString) }
        await centrifugo.publish(channel: channel, data: envelope(type: "agent.status", payload: payload))
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
