import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import PostgresNIO
import ServiceLifecycle

/// The push notifier loop (MOMO-404, ADR-0120 D3).
///
/// Consumes `outbox` rows with kind='push_candidate' (enqueued by the
/// 011_push_notifier.sql AFTER INSERT trigger on `message`, i.e. durably in
/// the same tenant transaction as the source event) and turns them into
/// id-only dispatches through the push relay.
///
/// Judgment v0 — THE single place notification judgment lives (ux-bible P9;
/// Slack's activity/delivery separation lesson):
///   - DM: every message in a `dm` channel notifies all other active channel
///     members.
///   - Mention: `message.props.mention_member_ids` — the server-recomputed
///     mention projection persisted by ReadStateMentions at insert time. The
///     notifier NEVER re-parses the body (it never even reads the body).
///   - Approval request: a message of type `approval_request` notifies the
///     humans who can decide it — active human members of the channel
///     (ApprovalDecisionRoutes authorization surface), excluding the
///     requesting agent.
///   - Channel mute (ADR-0124): suppress every reason, including mentions and
///     approval requests. The preference is read at judgment time; no cache.
///
/// Delivery contract:
///   - Claim: SELECT ... FOR UPDATE SKIP LOCKED, same as relay/AgentWorker;
///     the three consumers' WHERE clauses are mutually exclusive by `kind`.
///   - At-least-once: a startup sweep returns push_candidate rows stuck in
///     'processing' (crash between claim and settle) to 'pending'. Safe only
///     because dispatch is idempotent (below); scoped strictly to
///     kind='push_candidate' so relay/agent_job rows are never touched.
///   - Idempotent dispatch: one push_dispatch_log row per (member, token,
///     collapse_id) — 011 partial unique index. The row is inserted as an
///     in-flight claim (apns_status NULL), the relay is called, then
///     apns_status/apns_reason are settled. A redelivered candidate skips
///     every settled row and only re-sends genuinely in-flight ones.
///   - id-only payload (D2): see PushDispatch. Content never leaves Postgres.
struct NotifierService: Service {
    let pg: PostgresClient
    let relay: PushRelayClient
    let httpClient: HTTPClient
    let config: Config
    let logger: Logger

    func run() async throws {
        let c = config.pollInterval.components
        let pollMs = c.seconds * 1000 + c.attoseconds / 1_000_000_000_000_000
        logger.info("push notifier starting", metadata: [
            "pollIntervalMs": .stringConvertible(pollMs),
            "claimBatch": .stringConvertible(config.claimBatchSize),
            "relayURL": .string(relay.dispatchURL),
        ])

        // At-least-once recovery: reclaim candidates a previous notifier run
        // left mid-flight. Dispatch idempotency makes reprocessing harmless.
        await sweepStuckProcessing()

        let (wakes, wakeContinuation) = AsyncStream.makeStream(
            of: Void.self, bufferingPolicy: .bufferingNewest(1))

        try await withThrowingTaskGroup(of: Void.self) { group in
            // --- poll fallback ticker ---
            group.addTask {
                while !Task.isCancelled {
                    wakeContinuation.yield(())
                    try? await Task.sleep(for: config.pollInterval)
                }
            }

            // --- LISTEN/NOTIFY wakeups (best-effort; poll covers gaps) ---
            group.addTask {
                await listenLoop(wake: wakeContinuation)
            }

            // --- drain loop ---
            group.addTask {
                for await _ in wakes {
                    if Task.isCancelled { break }
                    await sweepTierFallback()
                    await reconcileCloudLifecycle()
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

    // MARK: - Startup sweep

    /// Return push_candidate rows stuck in 'processing' to 'pending'. Runs
    /// once per boot, BEFORE the drain loop starts. Never touches broadcast /
    /// agent_job rows — those consumers own their own recovery.
    private func sweepStuckProcessing() async {
        do {
            let rows = try await pg.query(
                """
                UPDATE outbox
                   SET status = 'pending', available_at = now()
                 WHERE kind = 'push_candidate'
                   AND status = 'processing'
                RETURNING id
                """,
                logger: logger
            ).collect()
            if !rows.isEmpty {
                logger.info("reclaimed stuck push candidates", metadata: [
                    "count": .stringConvertible(rows.count),
                ])
            }
        } catch {
            logger.warning("startup sweep failed; stuck rows stay until next boot", metadata: [
                "error": .string(String(describing: error)),
            ])
        }
    }

    // MARK: - LISTEN/NOTIFY

    private func listenLoop(wake: AsyncStream<Void>.Continuation) async {
        while !Task.isCancelled {
            do {
                try await pg.withConnection { conn in
                    try await conn.listen(on: "outbox") { notifications in
                        for try await note in notifications {
                            // The outbox trigger publishes the row kind as the
                            // NOTIFY payload; only push_candidate matters here.
                            if note.payload == "push_candidate" {
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
                let claimed = try await claimBatch()
                if claimed.isEmpty { return }
                for row in claimed {
                    await processClaimed(row)
                }
                if claimed.count < config.claimBatchSize { return }
            } catch {
                logger.error("notifier drain iteration failed", metadata: [
                    "error": .string(String(describing: error)),
                ])
                return   // next poll tick retries
            }
        }
    }

    /// A claimed push_candidate outbox row.
    struct ClaimedCandidate: Sendable {
        let id: Int64
        let attempts: Int
        let workspaceID: UUID
        let rawPayload: String
    }

    /// Claim pending push_candidate rows and flip them to 'processing' in one
    /// transaction (SKIP LOCKED — loss-free, no high-water-mark cursor).
    /// `kind = 'push_candidate'` is the mutual-exclusion boundary against the
    /// relay (kind='broadcast') and AgentWorker/gateway (kind='agent_job').
    private func claimBatch() async throws -> [ClaimedCandidate] {
        try await pg.withTransaction(logger: logger) { conn in
            let rows = try await conn.query(
                """
                WITH claimed AS (
                  SELECT id FROM outbox
                   WHERE kind = 'push_candidate'
                     AND status = 'pending'
                     AND available_at <= now()
                   ORDER BY id
                   FOR UPDATE SKIP LOCKED
                   LIMIT \(config.claimBatchSize)
                )
                UPDATE outbox o
                   SET status = 'processing', attempts = o.attempts + 1
                  FROM claimed c
                 WHERE o.id = c.id
                 RETURNING o.id, o.attempts, o.workspace_id, o.payload::text
                """,
                logger: logger
            ).collect()

            return try rows.map { row in
                let (id, attempts, workspaceID, payload) =
                    try row.decode((Int64, Int, UUID, String).self)
                return ClaimedCandidate(
                    id: id, attempts: attempts,
                    workspaceID: workspaceID, rawPayload: payload)
            }
        }
    }

    // MARK: - Candidate processing

    private struct CandidatePayload: Decodable {
        let messageID: UUID
        let channelID: UUID

        private enum CodingKeys: String, CodingKey {
            case messageID = "message_id"
            case channelID = "channel_id"
        }
    }

    /// One (member, active token) dispatch target with its judgment reason.
    private struct Target: Sendable {
        let memberID: UUID
        let tokenID: UUID
        let deviceID: UUID
        let devicePlatform: String
        let apnsToken: String
        let apnsEnv: String
        let apnsTopic: String
        let reason: String
        let threadID: UUID
        let category: String
        let approvalID: UUID?
    }

    private static let decoder = JSONDecoder()

    /// APNs collapse id for one message: stable across redeliveries (the 011
    /// dedupe index key) and within the 64-byte APNs header limit
    /// ("m:" + 36-char UUID = 38 bytes).
    static func collapseID(for messageID: UUID) -> String {
        "m:\(messageID.uuidString.lowercased())"
    }

    static func category(messageType: String, propsKind: String?, reason: String) -> String {
        if propsKind == "resume_offer" || propsKind == "work_session_idle" {
            return "momo.work"
        }
        if messageType == "approval_request" { return "momo.approval" }
        if propsKind == "work_session" { return "momo.work" }
        if reason == "mention" { return "momo.mention" }
        return "momo.message"
    }

    private func processClaimed(_ row: ClaimedCandidate) async {
        let payload: CandidatePayload
        do {
            payload = try Self.decoder.decode(
                CandidatePayload.self, from: Data(row.rawPayload.utf8))
        } catch {
            logger.error("push candidate payload decode failed; marking failed", metadata: [
                "outboxId": .stringConvertible(row.id),
                "error": .string(String(describing: error)),
            ])
            await markFailed(row.id, reason: "payload decode: \(error)")
            return
        }

        do {
            let targets = try await judgeTargets(
                workspaceID: row.workspaceID, payload: payload)
            if targets.isEmpty {
                await markDone(row.id)
                return
            }
            let collapseID = Self.collapseID(for: payload.messageID)
            var transientFailures: [String] = []
            for target in targets {
                if let failure = await dispatchOne(
                    workspaceID: row.workspaceID,
                    messageID: payload.messageID,
                    channelID: payload.channelID,
                    collapseID: collapseID,
                    target: target
                ) {
                    transientFailures.append(failure)
                }
            }
            if transientFailures.isEmpty {
                await markDone(row.id)
            } else {
                // Retry the whole candidate: settled dispatch-log rows are
                // skipped on redelivery, only failed targets are re-sent.
                await requeue(row, reason: transientFailures.joined(separator: "; "))
            }
        } catch {
            await requeue(row, reason: "judgment failed: \(error)")
        }
    }

    // MARK: - Judgment v0 (the only place this logic exists — P9)

    /// Decide who gets notified for one committed message, and on which
    /// active device tokens. Reads only ids/types/projections — never the
    /// message body.
    private func judgeTargets(
        workspaceID: UUID,
        payload: CandidatePayload
    ) async throws -> [Target] {
        // One query resolves the whole v0 judgment against committed state:
        //   recipients =
        //     dm:       other active channel members of a dm channel
        //     mention:  message.props.mention_member_ids (server projection)
        //     approval: active HUMAN channel members for approval_request
        //     resume:   the orphaned session owner for resume_offer
        //     idle:     the completed tool's session owner
        //   minus the author, joined to their ACTIVE push tokens (exactly one
        //   per device+env — 010 partial unique index).
        // Reason precedence per member: approval_request > mention > dm.
        // A member without an active token contributes no row (agents never
        // have devices, so agent recipients drop out naturally).
        //
        let rows = try await pg.query(
            """
            WITH msg AS (
              SELECT m.id, m.channel_id, m.author_member_id,
                     m.type::text AS message_type,
                     COALESCE(m.props->'mention_member_ids', '[]'::jsonb) AS mention_ids,
                     m.props->>'kind' AS props_kind,
                     m.props->>'owner_member_id' AS owner_member_id,
                     m.root_id,
                     c.kind::text AS channel_kind
                FROM message m
                JOIN channel c ON c.id = m.channel_id
               WHERE m.id = \(payload.messageID)
                 AND m.workspace_id = \(workspaceID)
            ),
            recipients AS (
              SELECT ms.member_id,
                     CASE
                       WHEN (SELECT props_kind FROM msg) = 'resume_offer'
                            AND lower(mem.id::text) = lower((SELECT owner_member_id FROM msg))
                         THEN 'resume_offer'
                       WHEN (SELECT props_kind FROM msg) = 'work_session_idle'
                            AND lower(mem.id::text) = lower((SELECT owner_member_id FROM msg))
                         THEN 'work_session_idle'
                       WHEN (SELECT message_type FROM msg) = 'approval_request'
                            AND mem.kind = 'human' THEN 'approval_request'
                       WHEN EXISTS (
                         SELECT 1 FROM jsonb_array_elements_text((SELECT mention_ids FROM msg)) t(v)
                          WHERE lower(t.v) = lower(ms.member_id::text)
                       ) THEN 'mention'
                       WHEN (SELECT channel_kind FROM msg) = 'dm' THEN 'dm'
                       ELSE NULL
                     END AS reason
                FROM membership ms
                JOIN member mem
                  ON mem.id = ms.member_id
                 AND mem.workspace_id = \(workspaceID)
                 AND mem.status = 'active'
                 AND mem.deleted_at IS NULL
                 AND mem.kind = 'human' -- 방어 필터(review #424 L1): 오늘은 agent가 push_token을 가질 수 없지만 스키마 드리프트에도 안전하게
               WHERE ms.channel_id = (SELECT channel_id FROM msg)
                 AND ms.workspace_id = \(workspaceID)
                 AND ms.left_at IS NULL
                 AND (
                   ms.member_id <> (SELECT author_member_id FROM msg)
                   OR (SELECT props_kind FROM msg) IN ('resume_offer', 'work_session_idle')
                 )
            )
            SELECT r.member_id, t.id, d.id, d.platform::text,
                   t.apns_token, t.env::text, t.topic, r.reason,
                   COALESCE((SELECT root_id FROM msg), (SELECT channel_id FROM msg)),
                   (SELECT message_type FROM msg), (SELECT props_kind FROM msg),
                   a.id
              FROM recipients r
              JOIN push_token t
                ON t.member_id = r.member_id
               AND t.workspace_id = \(workspaceID)
               AND t.invalidated_at IS NULL
              JOIN device d ON d.id = t.device_id
               AND d.workspace_id = \(workspaceID)
              LEFT JOIN notification_pref np
                ON np.workspace_id = \(workspaceID)
               AND np.channel_id = (SELECT channel_id FROM msg)
               AND np.member_id = r.member_id
              LEFT JOIN approval a
                ON a.workspace_id = \(workspaceID)
               AND a.request_message_id = \(payload.messageID)
             WHERE r.reason IS NOT NULL
               AND (
                 np.member_id IS NULL
                 OR (np.muted_until IS NOT NULL AND np.muted_until <= now())
               )
             ORDER BY r.member_id, t.id
            """,
            logger: logger
        ).collect()

        return try rows.map { row in
            let (memberID, tokenID, deviceID, platform, apnsToken, env, topic,
                 reason, threadID, messageType, propsKind, approvalID) = try row.decode(
                    (UUID, UUID, UUID, String, String, String, String, String,
                     UUID, String, String?, UUID?).self)
            return Target(
                memberID: memberID, tokenID: tokenID, deviceID: deviceID,
                devicePlatform: platform, apnsToken: apnsToken,
                apnsEnv: env, apnsTopic: topic, reason: reason,
                threadID: threadID,
                category: Self.category(
                    messageType: messageType, propsKind: propsKind, reason: reason),
                approvalID: Self.category(
                    messageType: messageType, propsKind: propsKind, reason: reason
                ) == "momo.approval" ? approvalID : nil)
        }
    }

    /// ADR-0109 badge: sum the server-owned unread projection across every
    /// active channel membership. This deliberately uses the same
    /// channel_seq/read_state formula as GET /read-state; clients and the
    /// notifier never derive unread from local message caches.
    private func unreadBadge(workspaceID: UUID, memberID: UUID) async -> Int {
        do {
            let rows = try await pg.query(
                """
                SELECT COALESCE(SUM(GREATEST(
                         COALESCE(cs.last_seq, 0) - COALESCE(rs.last_read_seq, 0),
                         0
                       )), 0)::int
                  FROM membership ms
                  JOIN channel c
                    ON c.id = ms.channel_id
                   AND c.workspace_id = \(workspaceID)
                   AND c.archived_at IS NULL
                  JOIN channel_seq cs
                    ON cs.channel_id = c.id
                   AND cs.workspace_id = \(workspaceID)
                  LEFT JOIN read_state rs
                    ON rs.channel_id = ms.channel_id
                   AND rs.member_id = ms.member_id
                   AND rs.workspace_id = \(workspaceID)
                 WHERE ms.workspace_id = \(workspaceID)
                   AND ms.member_id = \(memberID)
                   AND ms.left_at IS NULL
                """,
                logger: logger
            ).collect()
            return (try rows.first?.decode(Int.self)) ?? 0
        } catch {
            logger.warning("unread badge calculation failed; defaulting to zero", metadata: [
                "error": .string(String(describing: error)),
            ])
            return 0
        }
    }

    // MARK: - Idempotent dispatch

    /// Dispatch one target. Returns nil on success (or dedupe skip), or a
    /// transient-failure description when the candidate must be retried.
    ///
    /// Sequence (at-least-once toward the relay, exactly-once effect on the
    /// dispatch log):
    ///   1. INSERT push_dispatch_log ... ON CONFLICT DO NOTHING — the 011
    ///      unique index arbitrates concurrent/redelivered claims.
    ///   2. Row exists with apns_status set → already dispatched, skip.
    ///      Row exists with apns_status NULL → a crashed in-flight claim:
    ///      take it over and re-send (collapse_id makes the rare duplicate
    ///      APNs-side harmless).
    ///   3. POST the relay, then settle apns_status/apns_reason.
    private func dispatchOne(
        workspaceID: UUID,
        messageID: UUID,
        channelID: UUID,
        collapseID: String,
        target: Target
    ) async -> String? {
        let logID: UUID
        let alreadySettled: Bool
        do {
            let rows = try await pg.query(
                """
                WITH ins AS (
                  INSERT INTO push_dispatch_log
                    (workspace_id, message_id, member_id, push_token_id, collapse_id)
                  VALUES
                    (\(workspaceID), \(messageID), \(target.memberID),
                     \(target.tokenID), \(collapseID))
                  ON CONFLICT (member_id, push_token_id, collapse_id)
                    WHERE push_token_id IS NOT NULL AND collapse_id IS NOT NULL
                  DO NOTHING
                  RETURNING id
                )
                SELECT id, false AS settled FROM ins
                UNION ALL
                SELECT l.id, l.apns_status IS NOT NULL AS settled
                  FROM push_dispatch_log l
                 WHERE l.member_id = \(target.memberID)
                   AND l.push_token_id = \(target.tokenID)
                   AND l.collapse_id = \(collapseID)
                   AND NOT EXISTS (SELECT 1 FROM ins)
                 LIMIT 1
                """,
                logger: logger
            ).collect()
            guard let first = rows.first else {
                return "dispatch-log claim returned no row"
            }
            (logID, alreadySettled) = try first.decode((UUID, Bool).self)
        } catch {
            return "dispatch-log claim failed: \(error)"
        }

        if alreadySettled {
            logger.debug("dispatch already settled; skipping", metadata: [
                "collapseId": .string(collapseID),
                "memberId": .string(target.memberID.uuidString),
            ])
            return nil
        }

        let badge = await unreadBadge(
            workspaceID: workspaceID, memberID: target.memberID)
        let dispatch = PushDispatch(
            serverId: config.serverID,
            workspaceId: workspaceID.uuidString.lowercased(),
            deviceId: target.deviceID.uuidString.lowercased(),
            devicePlatform: target.devicePlatform,
            apnsToken: target.apnsToken,
            apnsEnv: target.apnsEnv,
            apnsTopic: target.apnsTopic,
            collapseId: collapseID,
            badge: badge,
            reason: target.reason,
            threadId: target.threadID.uuidString.lowercased(),
            category: target.category,
            approvalId: target.approvalID?.uuidString.lowercased(),
            channelId: channelID.uuidString.lowercased(),
            messageId: messageID.uuidString.lowercased()
        )

        do {
            let result = try await relay.dispatch(dispatch)
            switch result {
            case .accepted(let status, let reason):
                await settleDispatch(logID: logID, apnsStatus: status, apnsReason: reason)
                logger.debug("dispatched", metadata: [
                    "collapseId": .string(collapseID),
                    "memberId": .string(target.memberID.uuidString),
                    "reason": .string(target.reason),
                    "apnsStatus": .stringConvertible(status),
                ])
                return nil
            case .permanentFailure(let relayHTTPStatus, let reason):
                // Never succeeds on retry — settle with the REAL relay HTTP
                // status and a "relay_http:" prefixed reason so P-3 can never
                // mistake a relay-level failure for a genuine APNs 400
                // (BadDeviceToken) and over-invalidate healthy tokens
                // (review #424 M1). invalidated_at judgement happens only on
                // the accepted path's real APNs receipt.
                await settleDispatch(
                    logID: logID,
                    apnsStatus: relayHTTPStatus,
                    apnsReason: "relay_http: \(reason)")
                logger.error("permanent dispatch failure; settled with relay status", metadata: [
                    "collapseId": .string(collapseID),
                    "relayHTTPStatus": .stringConvertible(relayHTTPStatus),
                    "reason": .string(reason),
                ])
                return nil
            case .transientFailure(let reason):
                return "relay transient failure: \(reason)"
            }
        } catch {
            return "relay dispatch threw: \(error)"
        }
    }

    private func settleDispatch(logID: UUID, apnsStatus: Int, apnsReason: String?) async {
        await runUpdate(
            """
            UPDATE push_dispatch_log
               SET apns_status = \(apnsStatus), apns_reason = \(apnsReason)
             WHERE id = \(logID)
            """,
            context: "settleDispatch(\(logID))")
    }

    // MARK: - Candidate status transitions (OutboxRelay pattern)

    private func markDone(_ id: Int64) async {
        await runUpdate(
            "UPDATE outbox SET status='done', processed_at=now(), last_error=NULL WHERE id=\(id)",
            context: "markDone(\(id))")
    }

    private func markFailed(_ id: Int64, reason: String) async {
        await runUpdate(
            "UPDATE outbox SET status='failed', last_error=\(reason), processed_at=now() WHERE id=\(id)",
            context: "markFailed(\(id))")
    }

    private func requeue(_ row: ClaimedCandidate, reason: String) async {
        if row.attempts >= config.maxAttempts {
            logger.error("max attempts reached; marking failed", metadata: [
                "outboxId": .stringConvertible(row.id),
                "attempts": .stringConvertible(row.attempts),
                "reason": .string(reason),
            ])
            await markFailed(row.id, reason: "max attempts: \(reason)")
            return
        }
        let backoffSeconds = min(Int(pow(2.0, Double(row.attempts))), 60)
        logger.warning("transient dispatch failure; requeueing candidate", metadata: [
            "outboxId": .stringConvertible(row.id),
            "attempts": .stringConvertible(row.attempts),
            "backoffSeconds": .stringConvertible(backoffSeconds),
            "reason": .string(reason),
        ])
        await runUpdate(
            """
            UPDATE outbox
               SET status='pending',
                   available_at = now() + (\(backoffSeconds) * interval '1 second'),
                   last_error = \(reason)
             WHERE id = \(row.id)
            """,
            context: "requeue(\(row.id))")
    }

    private func runUpdate(_ query: PostgresQuery, context: String) async {
        do {
            _ = try await pg.query(query, logger: logger)
        } catch {
            logger.error("notifier status update failed", metadata: [
                "op": .string(context),
                "error": .string(String(describing: error)),
            ])
        }
    }
}
