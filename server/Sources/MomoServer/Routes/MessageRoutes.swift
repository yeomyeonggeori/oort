import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Message endpoints — the core write path of momo (L4 §1.2 / §3.1 / §8.1).
///
///   POST   /v1/workspaces/{ws}/channels/{ch}/messages   (send, idempotent)
///   GET    /v1/workspaces/{ws}/channels/{ch}/messages    (seq-cursor page)
///
/// The send handler runs the §3.1 SQL — `UPDATE channel_seq ... RETURNING` +
/// `INSERT message` + `INSERT outbox` — in ONE transaction so commit↔publish is
/// loss-free (transactional outbox). The relay (separate package) then publishes.
struct MessageRoutes: Sendable {
    let db: Database
    let agentGateway: AgentGatewayConfig

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/channels/:ch/messages", use: send)
        group.get("/v1/workspaces/:ws/channels/:ch/messages", use: history)
    }

    // MARK: - Send (core write path, L4 §3.1)

    @Sendable
    func send(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let (workspaceID, channelID) = try Self.scopeIDs(context, principal: principal)
        let dto = try await request.decode(as: SendMessageRequest.self, context: context)

        let type = dto.type ?? "text"
        let body = dto.body
        // HLC: v0 single-node uses SendOrLocal = (now_ms, monotonic count). We compute
        // a wall-clock ms here; the logical counter is 0 for the single-node case
        // (L4 §3.2 — Receive() is unused on one node but the columns are populated).
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        let hlcCount = 0
        // props/run_id are passed as JSON/uuid; v0 stub serializes props to a JSON string.
        let propsJSON = Self.encodeProps(dto.props)

        if principal.kind == .agent, let runID = dto.runId {
            let runMatchesActorAndChannel = try await db.withTenantConnection(
                workspaceID: workspaceID
            ) { conn in
                let rows = try await conn.query(
                    """
                    SELECT 1
                      FROM agent_run
                     WHERE id = \(runID)
                       AND workspace_id = \(workspaceID)
                       AND channel_id = \(channelID)
                       AND agent_member_id = \(principal.memberID)
                     LIMIT 1
                    """,
                    logger: db.logger
                ).collect()
                return !rows.isEmpty
            }
            guard runMatchesActorAndChannel else {
                throw HTTPError(
                    .forbidden,
                    message: "agent run does not match this channel and actor"
                )
            }
        }

        let result: (isMember: Bool, message: MessageDTO?) = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let isMember = try await Self.hasActiveMembership(
                conn: conn,
                logger: db.logger,
                channelID: channelID,
                memberID: principal.memberID
            )
            guard isMember else { return (false, nil) }

            // ---- L4 §3.1: single-transaction monotonic seq + idempotent insert ----
            // UPDATE channel_seq row-lock serializes writes per-channel (gapless);
            // ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING
            // makes retries idempotent (exactly-once effect).
            let insertRows = try await conn.query(
                """
                WITH bumped AS (
                  UPDATE channel_seq
                     SET last_seq = last_seq + 1
                   WHERE channel_id = \(channelID)
                  RETURNING last_seq AS seq
                )
                INSERT INTO message
                  (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id,
                   type, body, props, client_msg_id, run_id)
                SELECT \(workspaceID), \(channelID), b.seq, \(hlcTs), \(hlcCount),
                       \(principal.memberID), \(type)::message_type, \(body),
                       \(propsJSON)::jsonb, \(dto.clientMsgId), \(dto.runId)
                FROM bumped b
                ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING
                RETURNING id, seq, hlc_ts, hlc_count, created_at, props::text
                """,
                logger: db.logger
            ).collect()

            let row: PostgresRow
            let didInsert: Bool
            if let first = insertRows.first {
                row = first
                didInsert = true
            } else {
                // 0 rows → idempotency hit: re-select the existing message to return
                // the prior seq (exactly-once effect, L4 §3.1).
                let existing = try await conn.query(
                    """
                    SELECT id, seq, hlc_ts, hlc_count, created_at, props::text
                      FROM message
                     WHERE channel_id = \(channelID)
                       AND author_member_id = \(principal.memberID)
                       AND client_msg_id = \(dto.clientMsgId)
                    """,
                    logger: db.logger
                ).collect()
                guard let existingRow = existing.first else { return (true, nil) }
                row = existingRow
                didInsert = false
            }

            let (id, seq, ts, count, createdAt, rowPropsJSON) =
                try row.decode((UUID, Int64, Int64, Int, Date, String).self)
            var responsePropsJSON = rowPropsJSON
            if didInsert, type == "text" {
                let mentionMemberIDs = try await ReadStateMentions.record(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    channelID: channelID,
                    messageID: id,
                    messageSeq: seq,
                    authorMemberID: principal.memberID,
                    body: body
                )
                if !mentionMemberIDs.isEmpty {
                    responsePropsJSON = Self.encodeProps(
                        dto.props,
                        mentionMemberIDs: mentionMemberIDs
                    )
                }
            }
            let responseProps = Self.decodeProps(responsePropsJSON)

            // ---- outbox INSERT in the SAME tx (L4 §8.1: transactional outbox) ----
            // partition_key = channel_id → per-channel ordering for the relay.
            // payload mirrors the Centrifugo publish args the relay will POST:
            // {channel, data:{type,seq,...}, version=seq, idempotency_key="<ch>:<seq>"}.
            let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
            let outboxPayload = Self.broadcastPayload(
                centChannel: centChannel, messageID: id, channelID: channelID,
                seq: seq, type: type, body: body, authorMemberID: principal.memberID,
                hlcTs: ts, hlcCount: count
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish', \(outboxPayload)::jsonb, \(channelID))
                """,
                logger: db.logger
            )

            // MOMO-215: mention routing is part of the same commit boundary as
            // the source message. It only runs on the first idempotent insert;
            // retries that hit message_client_idem_uniq return the existing
            // message without creating duplicate agent_run/outbox rows.
            if didInsert, type == "text", let body, !body.isEmpty {
                try await Self.routeAgentMentions(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    channelID: channelID,
                    messageID: id,
                    messageSeq: seq,
                    authorMemberID: principal.memberID,
                    body: body,
                    hlcTs: ts,
                    agentGateway: agentGateway
                )
            }

            if didInsert, principal.kind == .agent {
                let detail = Self.jsonString([
                    "schema": "momo.agent_message.sent.v1",
                    "channel_id": channelID.uuidString,
                    "client_msg_id": dto.clientMsgId.uuidString,
                    "message_type": type,
                ])
                _ = try await conn.query(
                    """
                    INSERT INTO audit_log
                      (workspace_id, actor_member_id, action, target_type,
                       target_id, via_token_id, detail)
                    VALUES
                      (\(workspaceID), \(principal.memberID), 'message.sent',
                       'message', \(id), \(principal.tokenID), \(detail)::jsonb)
                    """,
                    logger: db.logger
                )
            }

            return (true, MessageDTO(
                id: id.uuidString, channelId: channelID.uuidString, seq: seq,
                hlcTs: ts, hlcCount: count, authorMemberId: principal.memberID.uuidString,
                type: type, body: body, props: responseProps,
                runId: dto.runId?.uuidString, clientMsgId: dto.clientMsgId.uuidString,
                createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
            ))
        }

        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not a member of this channel")
        }
        guard let message = result.message else {
            // channel_seq row missing → channel not provisioned (or wrong tenant).
            throw HTTPError(.notFound, message: "channel not found or not provisioned")
        }
        // 201 Created with the authoritative seq for optimistic reconcile (L4 §5.3).
        var response = try message.response(from: request, context: context)
        response.status = .created
        return response
    }

    // MARK: - History (seq cursor pagination, L4 §5.1 / §8.2)

    @Sendable
    func history(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let (workspaceID, channelID) = try Self.scopeIDs(context, principal: principal)

        let q = request.uri.queryParameters
        let limit = min(max(q["limit"].flatMap { Int($0) } ?? 50, 1), 200)
        let before = q["before"].flatMap { Int64($0) }   // older than this seq
        let after = q["after"].flatMap { Int64($0) }     // newer than this seq (backfill)

        let result: (isMember: Bool, page: MessagePage?) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let isMember = try await Self.hasActiveMembership(
                conn: conn,
                logger: db.logger,
                channelID: channelID,
                memberID: principal.memberID
            )
            guard isMember else { return (false, nil) }

            // `after` = backfill gap (ascending); otherwise newest-first by seq with
            // an optional `before` cursor. Both read via message_channel_seq_idx.
            let rows: [PostgresRow]
            if let after {
                rows = try await conn.query(
                    """
                    SELECT id, seq, hlc_ts, hlc_count, author_member_id, type, body,
                           props::text, run_id, client_msg_id, created_at
                      FROM message
                     WHERE channel_id = \(channelID) AND seq > \(after)
                       AND deleted_at IS NULL
                     ORDER BY seq ASC
                     LIMIT \(limit)
                    """,
                    logger: db.logger
                ).collect()
            } else if let before {
                rows = try await conn.query(
                    """
                    SELECT id, seq, hlc_ts, hlc_count, author_member_id, type, body,
                           props::text, run_id, client_msg_id, created_at
                      FROM message
                     WHERE channel_id = \(channelID) AND seq < \(before)
                       AND deleted_at IS NULL
                     ORDER BY seq DESC
                     LIMIT \(limit)
                    """,
                    logger: db.logger
                ).collect()
            } else {
                rows = try await conn.query(
                    """
                    SELECT id, seq, hlc_ts, hlc_count, author_member_id, type, body,
                           props::text, run_id, client_msg_id, created_at
                      FROM message
                     WHERE channel_id = \(channelID)
                       AND deleted_at IS NULL
                     ORDER BY seq DESC
                     LIMIT \(limit)
                    """,
                    logger: db.logger
                ).collect()
            }

            let dtos = try rows.map { row -> MessageDTO in
                let (id, seq, ts, count, author, type, body, propsJSON, runID, clientMsgID, createdAt) =
                    try row.decode((UUID, Int64, Int64, Int, UUID, String, String?, String, UUID?, UUID?, Date).self)
                return MessageDTO(
                    id: id.uuidString, channelId: channelID.uuidString, seq: seq,
                    hlcTs: ts, hlcCount: count, authorMemberId: author.uuidString,
                    type: type, body: body, props: Self.decodeProps(propsJSON),
                    runId: runID?.uuidString, clientMsgId: clientMsgID?.uuidString,
                    createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
                )
            }
            // nextBefore = smallest seq in this page (for the next older page).
            let nextBefore = dtos.map(\.seq).min()
            return (true, MessagePage(messages: dtos, nextBefore: nextBefore))
        }
        guard result.isMember, let page = result.page else {
            throw HTTPError(.forbidden, message: "not a member of this channel")
        }
        return try page.response(from: request, context: context)
    }

    // MARK: - Helpers

    /// REST read/write access is channel membership-gated in addition to tenant
    /// RLS. Centrifugo subscribe proxy performs the same check for realtime.
    private static func hasActiveMembership(
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

    private struct AgentMentionCandidate {
        let id: UUID
        let handle: String
        let displayName: String
        let model: String
        let toolSchemaJSON: String
        let configJSON: String
        let systemPrompt: String?
        let maxRunSteps: Int
        let isChannelMember: Bool
    }

    private static func routeAgentMentions(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        body: String,
        hlcTs: Int64,
        agentGateway: AgentGatewayConfig
    ) async throws {
        let candidates = try await loadAgentMentionCandidates(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            channelID: channelID
        )
        let mentioned = candidates.filter {
            containsAgentMention(body, handle: $0.handle, displayName: $0.displayName, memberID: $0.id)
        }
        guard !mentioned.isEmpty else { return }

        for agent in mentioned {
            if !agent.isChannelMember {
                try await insertMentionDiagnostic(
                    conn: conn,
                    logger: logger,
                    workspaceID: workspaceID,
                    channelID: channelID,
                    messageID: messageID,
                    messageSeq: messageSeq,
                    authorMemberID: authorMemberID,
                    agent: agent,
                    reason: "agent_not_channel_member"
                )
                continue
            }

            try await enqueueMentionJob(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                channelID: channelID,
                messageID: messageID,
                messageSeq: messageSeq,
                authorMemberID: authorMemberID,
                body: body,
                hlcTs: hlcTs,
                agent: agent,
                agentGateway: agentGateway
            )
        }
    }

    private static func loadAgentMentionCandidates(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID
    ) async throws -> [AgentMentionCandidate] {
        let rows = try await conn.query(
            """
            SELECT m.id, m.handle, m.display_name, a.model,
                   a.tool_schema::text, a.config::text, a.system_prompt, a.max_run_steps,
                   EXISTS (
                     SELECT 1
                       FROM membership ms
                      WHERE ms.channel_id = \(channelID)
                        AND ms.member_id = m.id
                        AND ms.left_at IS NULL
                   ) AS is_channel_member
              FROM member m
              JOIN agent a ON a.member_id = m.id
             WHERE m.workspace_id = \(workspaceID)
               AND m.kind = 'agent'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             ORDER BY m.created_at ASC, m.id ASC
            """,
            logger: logger
        ).collect()

        return try rows.map { row in
            let (id, handle, displayName, model, toolSchema, config, systemPrompt, maxRunSteps, isChannelMember) =
                try row.decode((UUID, String, String, String, String, String, String?, Int, Bool).self)
            return AgentMentionCandidate(
                id: id,
                handle: handle,
                displayName: displayName,
                model: model,
                toolSchemaJSON: toolSchema,
                configJSON: config,
                systemPrompt: systemPrompt,
                maxRunSteps: maxRunSteps,
                isChannelMember: isChannelMember
            )
        }
    }

    // MARK: - Context assembly window (MOMO-302)

    /// `AGENT_CONTEXT_MAX_MESSAGES` (default 30, clamped 1…200): the recent-N
    /// history window size projected into the agent_job payload.
    private static func agentContextMaxMessages() -> Int {
        let parsed = ProcessInfo.processInfo.environment["AGENT_CONTEXT_MAX_MESSAGES"]
            .flatMap(Int.init) ?? 30
        return min(max(parsed, 1), 200)
    }

    /// Fetch the same-channel history window for a trigger. Thread messages
    /// (root + replies) are prioritized when the trigger is inside a thread
    /// (thread = session boundary), then remaining budget is filled with the
    /// channel's most-recent messages. `type='system'` and deleted messages are
    /// excluded; the caller runs inside the tenant transaction so RLS is scoped.
    private static func loadRecentMessages(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        triggerMessageID: UUID,
        maxMessages: Int
    ) async throws -> [[String: Any]] {
        let rootRows = try await conn.query(
            """
            SELECT root_id
              FROM message
             WHERE id = \(triggerMessageID)
               AND channel_id = \(channelID)
            """,
            logger: logger
        ).collect()
        let rootID: UUID?
        if let firstRoot = rootRows.first {
            rootID = try firstRoot.decode(UUID?.self)
        } else {
            rootID = nil
        }

        var rows: [PostgresRow]
        if let rootID {
            // Thread priority: root message + all its replies, newest-first.
            let threadRows = try await conn.query(
                """
                SELECT m.seq, m.id, m.author_member_id, mem.kind::text,
                       mem.display_name, m.type::text, m.body, m.props::text, m.created_at
                  FROM message m
                  JOIN member mem ON mem.id = m.author_member_id
                 WHERE m.channel_id = \(channelID)
                   AND (m.root_id = \(rootID) OR m.id = \(rootID))
                   AND m.type <> 'system'
                   AND m.state <> 'deleted'
                   AND m.deleted_at IS NULL
                 ORDER BY m.seq DESC
                 LIMIT \(maxMessages)
                """,
                logger: logger
            ).collect()
            rows = threadRows
            let remaining = maxMessages - threadRows.count
            if remaining > 0 {
                let fillRows = try await conn.query(
                    """
                    SELECT m.seq, m.id, m.author_member_id, mem.kind::text,
                           mem.display_name, m.type::text, m.body, m.props::text, m.created_at
                      FROM message m
                      JOIN member mem ON mem.id = m.author_member_id
                     WHERE m.channel_id = \(channelID)
                       AND m.id <> \(rootID)
                       AND m.root_id IS DISTINCT FROM \(rootID)
                       AND m.type <> 'system'
                       AND m.state <> 'deleted'
                       AND m.deleted_at IS NULL
                     ORDER BY m.seq DESC
                     LIMIT \(remaining)
                    """,
                    logger: logger
                ).collect()
                rows.append(contentsOf: fillRows)
            }
        } else {
            rows = try await conn.query(
                """
                SELECT m.seq, m.id, m.author_member_id, mem.kind::text,
                       mem.display_name, m.type::text, m.body, m.props::text, m.created_at
                  FROM message m
                  JOIN member mem ON mem.id = m.author_member_id
                 WHERE m.channel_id = \(channelID)
                   AND m.type <> 'system'
                   AND m.state <> 'deleted'
                   AND m.deleted_at IS NULL
                 ORDER BY m.seq DESC
                 LIMIT \(maxMessages)
                """,
                logger: logger
            ).collect()
        }

        // Dedupe by id (thread rows win), then order ASC by seq for chat replay.
        var seen = Set<UUID>()
        var ordered: [(seq: Int64, dict: [String: Any])] = []
        for row in rows {
            let (seq, id, author, kind, display, type, body, propsText, createdAt) =
                try row.decode(
                    (Int64, UUID, UUID, String, String, String, String?, String, Date).self)
            guard seen.insert(id).inserted else { continue }
            ordered.append((
                seq,
                recentMessageProjection(
                    workspaceID: workspaceID,
                    channelID: channelID,
                    seq: seq,
                    messageID: id,
                    authorMemberID: author,
                    authorKind: kind,
                    authorDisplay: display,
                    type: type,
                    body: body,
                    propsJSON: propsText,
                    createdAt: createdAt
                )
            ))
        }
        ordered.sort { $0.seq < $1.seq }
        return ordered.map(\.dict)
    }

    private static func recentMessageProjection(
        workspaceID: UUID,
        channelID: UUID,
        seq: Int64,
        messageID: UUID,
        authorMemberID: UUID,
        authorKind: String,
        authorDisplay: String,
        type: String,
        body: String?,
        propsJSON: String,
        createdAt: Date
    ) -> [String: Any] {
        [
            "message_id": messageID.uuidString,
            "channel_id": channelID.uuidString,
            "seq": seq,
            "author_member_id": authorMemberID.uuidString,
            "author_kind": authorKind,
            "author_display": authorDisplay,
            "type": type,
            "body": recentMessageBody(type: type, body: body, propsJSON: propsJSON),
            "created_at": Int64(createdAt.timeIntervalSince1970 * 1000),
            "source_id": "msg_\(messageID.uuidString)",
        ]
    }

    /// Render a display body for the history window: text is trimmed to 2000
    /// chars (with an ellipsis marker); structured tool events collapse to a
    /// terse summary instead of leaking raw JSON payloads.
    private static func recentMessageBody(
        type: String,
        body: String?,
        propsJSON: String
    ) -> String {
        switch type {
        case "tool_call":
            if let object = jsonObject(propsJSON) as? [String: Any],
               let name = object["name"] as? String,
               !name.isEmpty {
                return "[tool_call: \(name)]"
            }
            return "[tool_call]"
        case "tool_result":
            return "[tool_result]"
        case "diff":
            // MOMO-302 (review high): structured types carry payload in props with
            // body=NULL. Summarize them like tool_* so they never project to an empty
            // chat turn (some OpenAI-compatible endpoints reject empty `content`).
            if let object = jsonObject(propsJSON) as? [String: Any],
               let path = object["path"] as? String, !path.isEmpty {
                return "[diff: \(path)]"
            }
            return "[diff]"
        case "artifact":
            if let object = jsonObject(propsJSON) as? [String: Any],
               let title = object["title"] as? String, !title.isEmpty {
                return "[artifact: \(title)]"
            }
            return "[artifact]"
        case "approval_request":
            return "[approval_request]"
        default:
            let text = body ?? ""
            if text.count > 2000 {
                return String(text.prefix(2000)) + "…"
            }
            return text
        }
    }

    static func containsAgentMention(
        _ text: String,
        handle: String,
        displayName: String,
        memberID: UUID
    ) -> Bool {
        ReadStateMentions.containsMention(
            text,
            handle: handle,
            displayName: displayName,
            memberID: memberID
        )
    }

    private static func enqueueMentionJob(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        body: String,
        hlcTs: Int64,
        agent: AgentMentionCandidate,
        agentGateway: AgentGatewayConfig
    ) async throws {
        let idempotencyKey = "mention:\(messageID.uuidString):\(agent.id.uuidString)"
        let input = mentionRunInput(
            workspaceID: workspaceID,
            channelID: channelID,
            messageID: messageID,
            messageSeq: messageSeq,
            authorMemberID: authorMemberID,
            agent: agent,
            body: body,
            idempotencyKey: idempotencyKey
        )
        // MOMO-302: materialize a same-channel history window (recent-N, thread
        // priority) so the worker assembles a conversation instead of a single
        // amnesiac trigger message. RLS/tenant scope comes from the enclosing
        // `withTenantTransaction` (SET LOCAL app.workspace_id).
        let recentMessages = try await loadRecentMessages(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            channelID: channelID,
            triggerMessageID: messageID,
            maxMessages: agentContextMaxMessages()
        )
        let rows = try await conn.query(
            """
            INSERT INTO agent_run
              (workspace_id, agent_member_id, channel_id, trigger_message_id,
               status, step_count, max_steps, depth, input, idempotency_key)
            VALUES
              (\(workspaceID), \(agent.id), \(channelID), \(messageID),
               'queued', 0, \(agent.maxRunSteps), 0, \(input)::jsonb,
               \(idempotencyKey))
            ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard let first = rows.first else { return }
        let runID = try first.decode(UUID.self)

        let payload = mentionJobPayload(
            workspaceID: workspaceID,
            channelID: channelID,
            messageID: messageID,
            messageSeq: messageSeq,
            authorMemberID: authorMemberID,
            runID: runID,
            agent: agent,
            body: body,
            hlcTs: hlcTs,
            idempotencyKey: idempotencyKey,
            recentMessages: recentMessages,
            delivery: agentGateway.enabled ? "gateway" : "worker"
        )
        let jobMethod = agentGateway.enabled ? "gateway" : "publish"
        let jobRows = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, status, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'agent_job', 'pending', \(jobMethod),
               \(payload)::jsonb, \(agent.id))
            RETURNING id
            """,
            logger: logger
        ).collect()

        if agentGateway.enabled, let firstJob = jobRows.first {
            let jobOutboxID = try firstJob.decode(Int64.self)
            let gatewayPayload = agentJobBroadcastPayload(
                workspaceID: workspaceID,
                agentMemberID: agent.id,
                jobOutboxID: jobOutboxID,
                runID: runID,
                payloadJSON: payload,
                hlcTs: hlcTs
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, status, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'pending', 'publish',
                   \(gatewayPayload)::jsonb, \(agent.id))
                """,
                logger: logger
            )
        }

        let detail = mentionDiagnosticDetail(
            workspaceID: workspaceID,
            channelID: channelID,
            messageID: messageID,
            messageSeq: messageSeq,
            authorMemberID: authorMemberID,
            agent: agent,
            reason: "queued",
            runID: runID,
            idempotencyKey: idempotencyKey
        )
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, run_id, detail)
            VALUES
              (\(workspaceID), \(authorMemberID), \(agent.id),
               'agent.mention.queued', 'message', \(messageID), \(runID),
               \(detail)::jsonb)
            """,
            logger: logger
        )
    }

    private static func insertMentionDiagnostic(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        agent: AgentMentionCandidate,
        reason: String
    ) async throws {
        let detail = mentionDiagnosticDetail(
            workspaceID: workspaceID,
            channelID: channelID,
            messageID: messageID,
            messageSeq: messageSeq,
            authorMemberID: authorMemberID,
            agent: agent,
            reason: reason,
            runID: nil,
            idempotencyKey: nil
        )
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, detail)
            VALUES
              (\(workspaceID), \(authorMemberID), \(agent.id),
               'agent.mention.skipped', 'message', \(messageID), \(detail)::jsonb)
            """,
            logger: logger
        )
    }

    private static func mentionRunInput(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        agent: AgentMentionCandidate,
        body: String,
        idempotencyKey: String
    ) -> String {
        jsonString([
            "schema": "momo.agent_run.input.v0",
            "surface": "mention",
            "prompt": body,
            "idempotency_key": idempotencyKey,
            "trigger_message_id": messageID.uuidString,
            "author_member_id": authorMemberID.uuidString,
            "agent_member_id": agent.id.uuidString,
            "channel_id": channelID.uuidString,
            "workspace_id": workspaceID.uuidString,
            "source": messageSource(
                workspaceID: workspaceID,
                channelID: channelID,
                messageID: messageID,
                messageSeq: messageSeq,
                authorMemberID: authorMemberID,
                body: body
            ),
        ])
    }

    private static func mentionJobPayload(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        runID: UUID,
        agent: AgentMentionCandidate,
        body: String,
        hlcTs: Int64,
        idempotencyKey: String,
        recentMessages: [[String: Any]],
        delivery: String
    ) -> String {
        let source = messageSource(
            workspaceID: workspaceID,
            channelID: channelID,
            messageID: messageID,
            messageSeq: messageSeq,
            authorMemberID: authorMemberID,
            body: body
        )
        let contextPacket = contextPacketProjection(
            workspaceID: workspaceID,
            channelID: channelID,
            messageID: messageID,
            messageSeq: messageSeq,
            authorMemberID: authorMemberID,
            runID: runID,
            agent: agent,
            body: body,
            idempotencyKey: idempotencyKey,
            source: source,
            recentMessages: recentMessages
        )
        var payload: [String: Any] = [
            "run_id": runID.uuidString,
            "workspace_id": workspaceID.uuidString,
            "channel_id": channelID.uuidString,
            "agent_member_id": agent.id.uuidString,
            "author_member_id": authorMemberID.uuidString,
            "trigger_message_id": messageID.uuidString,
            "trigger_message_seq": messageSeq,
            "model": agent.model,
            "prompt": body,
            // MOMO-302: worker-facing conversation window (recent-N/thread, ASC).
            "recent_messages": recentMessages,
            "tools": jsonObject(agent.toolSchemaJSON),
            "tool_grants": readOnlyToolGrants(),
            "context_packet_projection": contextPacket,
            "source_attribution": source,
            "max_output_tokens": maxOutputTokens(from: agent.configJSON),
            "step_count": 0,
            "depth": 0,
            "consecutive_auto": 0,
            "delivery": delivery,
            "created_from": "server.message_send.agent_mention.v0",
            "created_at_ms": hlcTs,
        ]
        // The agent's own system prompt seeds the first `system` chat message; the
        // worker keeps the amnesiac single-message path when it is absent.
        if let systemPrompt = agent.systemPrompt,
           !systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["system_prompt"] = systemPrompt
        }
        return jsonString(payload)
    }

    private static func agentJobBroadcastPayload(
        workspaceID: UUID,
        agentMemberID: UUID,
        jobOutboxID: Int64,
        runID: UUID,
        payloadJSON: String,
        hlcTs: Int64
    ) -> String {
        let centChannel = "agentwork:ws\(workspaceID.uuidString).\(agentMemberID.uuidString)"
        var jobPayload = (jsonObject(payloadJSON) as? [String: Any]) ?? [:]
        jobPayload["agent_job_outbox_id"] = jobOutboxID
        jobPayload["delivery"] = "gateway"

        return jsonString([
            "channel": centChannel,
            "data": [
                "type": "agent.job",
                "v": 1,
                "ts": hlcTs,
                "seq": jobOutboxID,
                "payload": jobPayload,
            ],
            "version": jobOutboxID,
            "idempotency_key": "\(centChannel):agent_job:\(runID.uuidString)",
        ])
    }

    private static func contextPacketProjection(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        runID: UUID,
        agent: AgentMentionCandidate,
        body: String,
        idempotencyKey: String,
        source: [String: Any],
        recentMessages: [[String: Any]]
    ) -> [String: Any] {
        // Acceptance ②: the projection carries real channel history with source
        // attribution, not just the trigger echo. Fall back to the trigger source
        // when the window is somehow empty so the field is never absent.
        let history = recentMessages.isEmpty ? [source] : recentMessages
        return [
            "schema": "momo.context_packet.mention_projection.v0",
            "request": [
                "surface": "mention",
                "request_id": runID.uuidString,
                "actor_member_id": authorMemberID.uuidString,
                "agent_member_id": agent.id.uuidString,
                "channel_id": channelID.uuidString,
                "trigger_message_id": messageID.uuidString,
                "idempotency_key": idempotencyKey,
                "raw_text": body,
                "normalized_intent": body,
            ],
            "scope": [
                "workspace_id": workspaceID.uuidString,
                "channel_id": channelID.uuidString,
                "visibility": "channel",
                "permission_basis": [
                    "actor_channel_member",
                    "agent_channel_member",
                    "rls_workspace_scope",
                ],
                "rls_context": [
                    "set_local_workspace_id": workspaceID.uuidString,
                ],
            ],
            "recent_messages": history,
            "sources": [source],
            "tool_grants": readOnlyToolGrants(),
        ]
    }

    private static func readOnlyToolGrants() -> [[String: Any]] {
        [[
            "tool_name": "github.search_issues",
            "provider": "github",
            "grant": "read",
            "risk": "read",
            "approval_policy": "none",
            "resource_scope_summary": "repo:Dawn-kim-official/momo",
            "capability_version": "mock-github@0.1.0",
            "policy_version": "capability-policy@2026-06-30",
        ]]
    }

    private static func messageSource(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        body: String
    ) -> [String: Any] {
        [
            "source_id": "msg_\(messageID.uuidString)",
            "kind": "message",
            "title": "Message #\(messageSeq)",
            "uri": "momo://workspaces/\(workspaceID.uuidString)/channels/\(channelID.uuidString)/messages/\(messageID.uuidString)",
            "workspace_id": workspaceID.uuidString,
            "channel_id": channelID.uuidString,
            "message_id": messageID.uuidString,
            "message_seq": messageSeq,
            "author_member_id": authorMemberID.uuidString,
            "permission_snapshot": "actor:channel_member agent:channel_member",
            "excerpt": String(body.prefix(512)),
        ]
    }

    private static func mentionDiagnosticDetail(
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        agent: AgentMentionCandidate,
        reason: String,
        runID: UUID?,
        idempotencyKey: String?
    ) -> String {
        var detail: [String: Any] = [
            "schema": "momo.agent_mention.diagnostic.v0",
            "reason": reason,
            "workspace_id": workspaceID.uuidString,
            "channel_id": channelID.uuidString,
            "message_id": messageID.uuidString,
            "message_seq": messageSeq,
            "author_member_id": authorMemberID.uuidString,
            "agent_member_id": agent.id.uuidString,
            "agent_handle": agent.handle,
            "agent_display_name": agent.displayName,
            "agent_channel_member": agent.isChannelMember,
            "policy": agent.isChannelMember ? "queued" : "no_op_fail_closed",
        ]
        if let runID { detail["run_id"] = runID.uuidString }
        if let idempotencyKey { detail["idempotency_key"] = idempotencyKey }
        return jsonString(detail)
    }

    private static func maxOutputTokens(from configJSON: String) -> Int {
        guard let object = jsonObject(configJSON) as? [String: Any] else { return 1024 }
        if let value = object["max_output_tokens"] as? Int {
            return value
        }
        if let value = object["max_output_tokens"] as? Double {
            return Int(value)
        }
        if let value = object["maxOutputTokens"] as? Int {
            return value
        }
        return 1024
    }

    /// Resolve workspace/channel UUIDs from the path and verify the path workspace
    /// matches the authenticated token's workspace (tenant isolation, L4 §1.3).
    private static func scopeIDs(
        _ context: AppRequestContext, principal: AuthPrincipal
    ) throws -> (workspace: UUID, channel: UUID) {
        let wsParam = try context.parameters.require("ws")
        let chParam = try context.parameters.require("ch")
        guard let ws = UUID(uuidString: wsParam) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        guard let ch = UUID(uuidString: chParam) else {
            throw HTTPError(.badRequest, message: "invalid channel id")
        }
        guard ws == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return (ws, ch)
    }

    /// Serialize the optional flat props map to a JSON object string for `::jsonb`.
    static func encodeProps(
        _ props: [String: String]?,
        mentionMemberIDs: [UUID] = []
    ) -> String {
        var object: [String: Any] = props ?? [:]
        // This key is a server-owned save-time parsing result. Never persist a
        // client-supplied value, including legacy string-shaped props.
        object.removeValue(forKey: "mention_member_ids")
        if !mentionMemberIDs.isEmpty {
            object["mention_member_ids"] = mentionMemberIDs.map(\.uuidString)
        }
        guard !object.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let str = String(data: data, encoding: .utf8)
        else { return "{}" }
        return str
    }

    private static func jsonObject(_ json: String) -> Any {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data)
        else { return [:] }
        return object
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
              ),
              let str = String(data: data, encoding: .utf8)
        else { return "{}" }
        return str
    }

    private static func decodeProps(_ propsJSON: String) -> [String: JSONValue]? {
        guard let data = propsJSON.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let props) = value,
              !props.isEmpty
        else {
            return nil
        }
        return props
    }

    /// Build the outbox `payload` JSON (the args the relay will POST to Centrifugo).
    static func broadcastPayload(
        centChannel: String, messageID: UUID, channelID: UUID, seq: Int64,
        type: String, body: String?, authorMemberID: UUID, hlcTs: Int64, hlcCount: Int
    ) -> String {
        // Event envelope per L4 §5.2: {type, v, ts, seq, payload:{...}}.
        let data: [String: Any] = [
            "type": "message.new",
            "v": 1,
            "ts": hlcTs,
            "seq": seq,
            "payload": [
                "id": messageID.uuidString,
                "channel_id": channelID.uuidString,
                "seq": seq,
                "type": type,
                "body": body as Any,
                "author_member_id": authorMemberID.uuidString,
                "hlc_ts": hlcTs,
                "hlc_count": hlcCount,
            ],
        ]
        let envelope: [String: Any] = [
            "channel": centChannel,
            "data": data,
            "version": seq,
            "idempotency_key": "\(centChannel):\(seq)",
        ]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: envelope),
              let str = String(data: jsonData, encoding: .utf8)
        else { return "{}" }
        return str
    }
}
