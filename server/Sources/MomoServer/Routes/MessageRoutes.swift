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
                RETURNING id, seq, hlc_ts, hlc_count, created_at
                """,
                logger: db.logger
            ).collect()

            let row: PostgresRow
            if let first = insertRows.first {
                row = first
            } else {
                // 0 rows → idempotency hit: re-select the existing message to return
                // the prior seq (exactly-once effect, L4 §3.1).
                let existing = try await conn.query(
                    """
                    SELECT id, seq, hlc_ts, hlc_count, created_at
                      FROM message
                     WHERE channel_id = \(channelID)
                       AND author_member_id = \(principal.memberID)
                       AND client_msg_id = \(dto.clientMsgId)
                    """,
                    logger: db.logger
                ).collect()
                guard let existingRow = existing.first else { return (true, nil) }
                row = existingRow
            }

            let (id, seq, ts, count, createdAt) =
                try row.decode((UUID, Int64, Int64, Int, Date).self)
            let responseProps = Self.decodeProps(propsJSON)

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
    private static func encodeProps(_ props: [String: String]?) -> String {
        guard let props, !props.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: props),
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
