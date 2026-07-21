import Foundation
import Logging
import PostgresNIO

extension NotifierService {
    struct StaleWorkSession: Sendable {
        let id: UUID
        let workspaceID: UUID
        let channelID: UUID
        let memberID: UUID
        let hostID: UUID
        let rootMessageID: UUID
        let tool: String
        let label: String
        let mode: String
        let autoTarget: String?
        let rootMessageSeq: Int64
    }

    /// ADR-0125 D11 reuses the notifier's existing bounded poll rather than
    /// adding another daemon. Each sweep claims stale running sessions with
    /// SKIP LOCKED and commits lifecycle, card/control, audit, and realtime
    /// outbox rows in the same PostgreSQL transaction.
    func sweepTierFallback() async {
        do {
            let transitioned = try await pg.withTransaction(logger: logger) { conn in
                let rows = try await conn.query(
                    """
                    SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                           ws.host_id, ws.root_message_id, ws.tool, ws.label,
                           COALESCE(policy.mode, 'ask') AS mode,
                           policy.auto_target, root.seq
                      FROM work_session ws
                      JOIN work_host h
                        ON h.id = ws.host_id
                       AND h.workspace_id = ws.workspace_id
                      JOIN message root ON root.id = ws.root_message_id
                      LEFT JOIN LATERAL (
                        SELECT p.mode, p.auto_target
                          FROM work_tier_policy p
                         WHERE p.workspace_id = ws.workspace_id
                           AND (p.member_id = ws.member_id OR p.member_id IS NULL)
                         ORDER BY CASE WHEN p.member_id = ws.member_id THEN 0 ELSE 1 END
                         LIMIT 1
                      ) policy ON true
                     WHERE ws.status = 'running'
                       AND COALESCE(h.last_seen_at, h.created_at)
                             < clock_timestamp()
                               - make_interval(secs => \(config.hostOfflineGraceSeconds))
                     ORDER BY COALESCE(h.last_seen_at, h.created_at), ws.id
                     FOR UPDATE OF ws SKIP LOCKED
                     LIMIT \(config.claimBatchSize)
                    """,
                    logger: logger
                ).collect()
                let sessions = try rows.map { row -> StaleWorkSession in
                    let value = try row.decode(
                        (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
                         String, String?, Int64).self
                    )
                    return StaleWorkSession(
                        id: value.0,
                        workspaceID: value.1,
                        channelID: value.2,
                        memberID: value.3,
                        hostID: value.4,
                        rootMessageID: value.5,
                        tool: value.6,
                        label: value.7,
                        mode: value.8,
                        autoTarget: value.9,
                        rootMessageSeq: value.10
                    )
                }
                for session in sessions {
                    try await transitionStaleSession(conn: conn, session: session)
                }
                return sessions.count
            }
            if transitioned > 0 {
                logger.info("orphaned stale work sessions", metadata: [
                    "count": .stringConvertible(transitioned),
                    "graceSeconds": .stringConvertible(config.hostOfflineGraceSeconds),
                ])
            }
        } catch {
            // Poll fallback retries. No partial state escapes the transaction.
            logger.error("tier fallback sweep failed", metadata: [
                "error": .string(String(describing: error)),
            ])
        }
    }

    private func transitionStaleSession(
        conn: PostgresConnection,
        session: StaleWorkSession
    ) async throws {
        let terminal = session.mode == "t1_only"
        let rows = try await conn.query(
            terminal
                ? """
                  UPDATE work_session
                     SET status = 'ended', ended_at = clock_timestamp(),
                         exit_code = NULL, end_reason = 'orphaned'
                   WHERE id = \(session.id) AND status = 'running'
                  RETURNING COALESCE(ended_at, clock_timestamp())
                  """
                : """
                  UPDATE work_session
                     SET status = 'orphaned'
                   WHERE id = \(session.id) AND status = 'running'
                  RETURNING clock_timestamp()
                  """,
            logger: logger
        ).collect()
        guard let transitionedAt = try rows.first?.decode(Date.self) else { return }
        let transitionedAtMs = Self.epochMs(transitionedAt)
        let orphanPayload = Self.lifecyclePayload(
            eventType: "work.session.orphaned",
            session: session,
            timestampMs: transitionedAtMs,
            extra: terminal
                ? ["status": "ended", "end_reason": "orphaned", "ended_at": transitionedAtMs]
                : ["status": "orphaned"]
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
            VALUES (\(session.workspaceID), 'broadcast', 'publish',
                    \(orphanPayload)::jsonb, \(session.channelID))
            """,
            logger: logger
        )
        try await insertAudit(
            conn: conn,
            session: session,
            action: "work.session.orphaned",
            targetID: session.id,
            detail: [
                "schema": "momo.work_session.orphaned.v1",
                "policy_mode": session.mode,
                "source_host_id": session.hostID.uuidString,
            ]
        )

        switch session.mode {
        case "ask":
            try await createResumeOffer(conn: conn, session: session, timestampMs: transitionedAtMs)
        case "auto":
            try await autoResume(conn: conn, session: session, timestampMs: transitionedAtMs)
        default:
            break // t1_only: terminal orphan event only, no card/control
        }
    }

    private func createResumeOffer(
        conn: PostgresConnection,
        session: StaleWorkSession,
        timestampMs: Int64
    ) async throws {
        let props: [String: Any] = [
            "kind": "resume_offer",
            "session_id": session.id.uuidString,
            "owner_member_id": session.memberID.uuidString,
            "status": "pending",
            "tool": session.tool,
            "label": session.label,
        ]
        let body = "호스트 연결이 끊겼습니다. 다른 호스트에서 마지막 push 커밋부터 재개할까요?"
        let rows = try await conn.query(
            """
            WITH bumped AS (
              UPDATE channel_seq
                 SET last_seq = last_seq + 1
               WHERE workspace_id = \(session.workspaceID)
                 AND channel_id = \(session.channelID)
              RETURNING last_seq AS seq
            )
            INSERT INTO message
              (workspace_id, channel_id, seq, hlc_ts, hlc_count,
               author_member_id, type, body, props, root_id)
            SELECT \(session.workspaceID), \(session.channelID), b.seq,
                   \(timestampMs), 0, \(session.memberID),
                   'approval_request'::message_type, \(body),
                   \(Self.jsonString(props))::jsonb, \(session.rootMessageID)
              FROM bumped b
            RETURNING id, seq
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw TierFallbackError.channelSequenceUnavailable
        }
        let (messageID, seq) = try row.decode((UUID, Int64).self)
        let broadcast = Self.messageBroadcastPayload(
            workspaceID: session.workspaceID,
            channelID: session.channelID,
            messageID: messageID,
            seq: seq,
            authorMemberID: session.memberID,
            rootMessageID: session.rootMessageID,
            timestampMs: timestampMs,
            body: body,
            props: props
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
            VALUES (\(session.workspaceID), 'broadcast', 'publish',
                    \(broadcast)::jsonb, \(session.channelID))
            """,
            logger: logger
        )
        try await insertAudit(
            conn: conn,
            session: session,
            action: "work.session.resume_offered",
            targetID: messageID,
            detail: [
                "schema": "momo.work_session.resume_offer.v1",
                "session_id": session.id.uuidString,
                "message_id": messageID.uuidString,
            ]
        )
    }

    private func autoResume(
        conn: PostgresConnection,
        session: StaleWorkSession,
        timestampMs: Int64
    ) async throws {
        guard let targetHostID = try await resolveAutoTarget(conn: conn, session: session) else {
            try await recordAutoFailure(conn: conn, session: session, reason: "target_unavailable")
            return
        }
        guard try await acquireAutoResumeSlot(conn: conn, session: session) else {
            try await recordAutoFailure(conn: conn, session: session, reason: "pool_exhausted")
            return
        }
        let idRows = try await conn.query("SELECT uuidv7()", logger: logger).collect()
        guard let resumedID = try idRows.first?.decode(UUID.self) else {
            throw TierFallbackError.identifierAllocationFailed
        }
        let inserted = try await conn.query(
            """
            INSERT INTO work_session
              (id, workspace_id, channel_id, member_id, host_id,
               root_message_id, tool, label, status, resumed_from_session_id)
            VALUES
              (\(resumedID), \(session.workspaceID), \(session.channelID),
               \(session.memberID), \(targetHostID), \(session.rootMessageID),
               \(session.tool), \(session.label), 'running', \(session.id))
            RETURNING started_at
            """,
            logger: logger
        ).collect()
        guard let startedAt = try inserted.first?.decode(Date.self) else {
            throw TierFallbackError.sessionInsertFailed
        }
        let ended = try await conn.query(
            """
            UPDATE work_session
               SET status = 'ended', ended_at = clock_timestamp(),
                   exit_code = NULL, end_reason = 'resumed'
             WHERE id = \(session.id) AND status = 'orphaned'
            RETURNING ended_at
            """,
            logger: logger
        ).collect()
        guard let endedAt = try ended.first?.decode(Date.self) else {
            throw TierFallbackError.sessionStateChanged
        }
        let controlRows = try await conn.query(
            """
            INSERT INTO work_control
              (workspace_id, channel_id, requester_member_id, target_host_id,
               session_id, kind, payload, status)
            VALUES
              (\(session.workspaceID), \(session.channelID), \(session.memberID),
               \(targetHostID), \(resumedID), 'spawn',
               jsonb_build_object('tool', \(session.tool), 'label', \(session.label)),
               'dispatched')
            RETURNING id, updated_at
            """,
            logger: logger
        ).collect()
        guard let controlRow = controlRows.first else {
            throw TierFallbackError.controlInsertFailed
        }
        let (controlID, controlUpdatedAt) = try controlRow.decode((UUID, Date).self)

        let rootProps: [String: Any] = [
            "kind": "work_session",
            "session_id": resumedID.uuidString,
            "tool": session.tool,
            "label": session.label,
            "status": "running",
            "resumed_from_session_id": session.id.uuidString,
        ]
        _ = try await conn.query(
            "UPDATE message SET props = \(Self.jsonString(rootProps))::jsonb WHERE id = \(session.rootMessageID)",
            logger: logger
        )

        let endedPayload = Self.lifecyclePayload(
            eventType: "work.session.ended",
            session: session,
            timestampMs: Self.epochMs(endedAt),
            extra: [
                "status": "ended",
                "end_reason": "resumed",
                "ended_at": Self.epochMs(endedAt),
            ]
        )
        let startedPayload = Self.lifecyclePayload(
            eventType: "work.session.started",
            session: session,
            sessionID: resumedID,
            hostID: targetHostID,
            timestampMs: Self.epochMs(startedAt),
            extra: [
                "status": "running",
                "started_at": Self.epochMs(startedAt),
                "resumed_from_session_id": session.id.uuidString,
            ]
        )
        let dispatchPayload = Self.controlDispatchPayload(
            session: session,
            controlID: controlID,
            targetHostID: targetHostID,
            resumedSessionID: resumedID,
            timestampMs: Self.epochMs(controlUpdatedAt)
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(session.workspaceID), 'broadcast', 'publish', \(endedPayload)::jsonb, \(session.channelID)),
              (\(session.workspaceID), 'broadcast', 'publish', \(startedPayload)::jsonb, \(session.channelID)),
              (\(session.workspaceID), 'broadcast', 'publish', \(dispatchPayload)::jsonb, \(session.channelID))
            """,
            logger: logger
        )
        try await insertAudit(
            conn: conn,
            session: session,
            action: "work.session.resumed",
            targetID: resumedID,
            detail: [
                "schema": "momo.work_session.resumed.v1",
                "source_session_id": session.id.uuidString,
                "resumed_session_id": resumedID.uuidString,
                "target_host_id": targetHostID.uuidString,
                "automatic": true,
            ]
        )
    }

    private func resolveAutoTarget(
        conn: PostgresConnection,
        session: StaleWorkSession
    ) async throws -> UUID? {
        guard let autoTarget = session.autoTarget else { return nil }
        let rows: [PostgresRow]
        if autoTarget == "cloud" {
            rows = try await conn.query(
                """
                SELECT id
                  FROM work_host
                 WHERE workspace_id = \(session.workspaceID)
                   AND type = 'cloud'
                   AND revoked_at IS NULL
                   AND id <> \(session.hostID)
                   AND (scope = 'workspace' OR owner_member_id = \(session.memberID))
                   AND last_seen_at >= clock_timestamp()
                         - make_interval(secs => \(config.hostOfflineGraceSeconds))
                 ORDER BY last_seen_at DESC, id
                 LIMIT 1
                 FOR SHARE
                """,
                logger: logger
            ).collect()
        } else if let hostID = UUID(uuidString: autoTarget) {
            rows = try await conn.query(
                """
                SELECT id
                  FROM work_host
                 WHERE id = \(hostID)
                   AND workspace_id = \(session.workspaceID)
                   AND revoked_at IS NULL
                   AND id <> \(session.hostID)
                   AND (scope = 'workspace' OR owner_member_id = \(session.memberID))
                   AND last_seen_at >= clock_timestamp()
                         - make_interval(secs => \(config.hostOfflineGraceSeconds))
                 FOR SHARE
                """,
                logger: logger
            ).collect()
        } else {
            return nil
        }
        return try rows.first?.decode(UUID.self)
    }

    private func acquireAutoResumeSlot(
        conn: PostgresConnection,
        session: StaleWorkSession
    ) async throws -> Bool {
        _ = try await conn.query(
            """
            INSERT INTO work_pool (workspace_id)
            VALUES (\(session.workspaceID))
            ON CONFLICT (workspace_id) DO NOTHING
            """,
            logger: logger
        )
        let settingsRows = try await conn.query(
            """
            SELECT max_active, per_member_soft_limit
              FROM work_pool
             WHERE workspace_id = \(session.workspaceID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let settings = settingsRows.first else { return false }
        let (maxActive, memberLimit) = try settings.decode((Int, Int).self)
        let usageRows = try await conn.query(
            """
            SELECT count(*)::int,
                   count(*) FILTER (WHERE member_id = \(session.memberID))::int
              FROM work_session
             WHERE workspace_id = \(session.workspaceID)
               AND status = 'running'
            """,
            logger: logger
        ).collect()
        guard let usage = usageRows.first else { return false }
        let (active, memberActive) = try usage.decode((Int, Int).self)
        return active < maxActive && memberActive < memberLimit
    }

    private func recordAutoFailure(
        conn: PostgresConnection,
        session: StaleWorkSession,
        reason: String
    ) async throws {
        try await insertAudit(
            conn: conn,
            session: session,
            action: "work.session.auto_resume_failed",
            targetID: session.id,
            detail: [
                "schema": "momo.work_session.auto_resume_failed.v1",
                "reason": reason,
                "automatic": true,
            ]
        )
    }

    private func insertAudit(
        conn: PostgresConnection,
        session: StaleWorkSession,
        action: String,
        targetID: UUID,
        detail: [String: Any]
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, detail)
            VALUES
              (\(session.workspaceID), \(session.memberID), \(session.memberID),
               \(action), 'work_session', \(targetID),
               \(Self.jsonString(detail))::jsonb)
            """,
            logger: logger
        )
    }

    static func lifecyclePayload(
        eventType: String,
        session: StaleWorkSession,
        sessionID: UUID? = nil,
        hostID: UUID? = nil,
        timestampMs: Int64,
        extra: [String: Any] = [:]
    ) -> String {
        let resolvedSessionID = sessionID ?? session.id
        var body: [String: Any] = [
            "session_id": resolvedSessionID.uuidString,
            "channel_id": session.channelID.uuidString,
            "root_message_id": session.rootMessageID.uuidString,
            "member_id": session.memberID.uuidString,
            "host_id": (hostID ?? session.hostID).uuidString,
            "tool": session.tool,
            "label": session.label,
        ]
        for (key, value) in extra { body[key] = value }
        let channel = Self.channelName(session)
        return jsonString([
            "channel": channel,
            "data": [
                "type": eventType,
                "v": 1,
                "ts": timestampMs,
                "seq": session.rootMessageSeq,
                "payload": body,
            ],
            "idempotency_key": "\(channel):\(eventType):\(resolvedSessionID.uuidString)",
        ])
    }

    static func controlDispatchPayload(
        session: StaleWorkSession,
        controlID: UUID,
        targetHostID: UUID,
        resumedSessionID: UUID,
        timestampMs: Int64
    ) -> String {
        let channel = channelName(session)
        return jsonString([
            "channel": channel,
            "data": [
                "type": "work.control.dispatched",
                "v": 1,
                "ts": timestampMs,
                "payload": [
                    "control_id": controlID.uuidString,
                    "channel_id": session.channelID.uuidString,
                    "requester_member_id": session.memberID.uuidString,
                    "target_host_id": targetHostID.uuidString,
                    "session_id": resumedSessionID.uuidString,
                    "kind": "spawn",
                    "payload": ["tool": session.tool, "label": session.label],
                ],
            ],
            "idempotency_key": "\(channel):work.control.dispatched:\(controlID.uuidString)",
        ])
    }

    static func messageBroadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        seq: Int64,
        authorMemberID: UUID,
        rootMessageID: UUID,
        timestampMs: Int64,
        body: String,
        props: [String: Any]
    ) -> String {
        let channel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        return jsonString([
            "channel": channel,
            "data": [
                "type": "message.new",
                "v": 1,
                "ts": timestampMs,
                "seq": seq,
                "payload": [
                    "id": messageID.uuidString,
                    "channel_id": channelID.uuidString,
                    "seq": seq,
                    "type": "approval_request",
                    "body": body,
                    "author_member_id": authorMemberID.uuidString,
                    "hlc_ts": timestampMs,
                    "hlc_count": 0,
                    "root_id": rootMessageID.uuidString,
                    "props": props,
                ],
            ],
            "version": seq,
            "idempotency_key": "\(channel):\(seq)",
        ])
    }

    private static func channelName(_ session: StaleWorkSession) -> String {
        "ch:ws\(session.workspaceID.uuidString).\(session.channelID.uuidString)"
    }

    private static func epochMs(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1_000)
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8)
        else { return "{}" }
        return value
    }
}

enum TierFallbackError: Error {
    case channelSequenceUnavailable
    case identifierAllocationFailed
    case sessionInsertFailed
    case sessionStateChanged
    case controlInsertFailed
}
