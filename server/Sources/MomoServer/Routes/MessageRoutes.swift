import Foundation
import Hummingbird
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

        let message: MessageDTO? = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
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
                guard let existingRow = existing.first else { return nil }
                row = existingRow
            }

            let (id, seq, ts, count, createdAt) =
                try row.decode((UUID, Int64, Int64, Int, Date).self)

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

            return MessageDTO(
                id: id.uuidString, channelId: channelID.uuidString, seq: seq,
                hlcTs: ts, hlcCount: count, authorMemberId: principal.memberID.uuidString,
                type: type, body: body,
                createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
            )
        }

        guard let message else {
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

        let page: MessagePage = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            // `after` = backfill gap (ascending); otherwise newest-first by seq with
            // an optional `before` cursor. Both read via message_channel_seq_idx.
            let rows: [PostgresRow]
            if let after {
                rows = try await conn.query(
                    """
                    SELECT id, seq, hlc_ts, hlc_count, author_member_id, type, body, created_at
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
                    SELECT id, seq, hlc_ts, hlc_count, author_member_id, type, body, created_at
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
                    SELECT id, seq, hlc_ts, hlc_count, author_member_id, type, body, created_at
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
                let (id, seq, ts, count, author, type, body, createdAt) =
                    try row.decode((UUID, Int64, Int64, Int, UUID, String, String?, Date).self)
                return MessageDTO(
                    id: id.uuidString, channelId: channelID.uuidString, seq: seq,
                    hlcTs: ts, hlcCount: count, authorMemberId: author.uuidString,
                    type: type, body: body,
                    createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
                )
            }
            // nextBefore = smallest seq in this page (for the next older page).
            let nextBefore = dtos.map(\.seq).min()
            return MessagePage(messages: dtos, nextBefore: nextBefore)
        }
        return try page.response(from: request, context: context)
    }

    // MARK: - Helpers

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

    /// Build the outbox `payload` JSON (the args the relay will POST to Centrifugo).
    private static func broadcastPayload(
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
                "channelId": channelID.uuidString,
                "seq": seq,
                "type": type,
                "body": body as Any,
                "authorMemberId": authorMemberID.uuidString,
                "hlcTs": hlcTs,
                "hlcCount": hlcCount,
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
