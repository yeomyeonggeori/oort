import Foundation
import Hummingbird
import PostgresNIO

/// ADR-0109 read-state surface.
///
///   GET /v1/workspaces/{ws}/read-state
///   PUT /v1/workspaces/{ws}/channels/{ch}/read-state
///
/// Both routes bind the cursor to the authenticated principal. The client never
/// supplies a member id. All database access uses the tenant transaction helper;
/// expected authorization/not-found outcomes are mapped to 4xx after the
/// transaction closure returns.
struct ReadStateRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/read-state", use: list)
        group.put("/v1/workspaces/:ws/channels/:ch/read-state", use: update)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)

        let result: (isMember: Bool, states: [ReadStateDTO]) = try await db
            .withTenantConnection(workspaceID: workspaceID) { conn in
                let role = try await WorkspaceAuthorization.activeRole(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    memberID: principal.memberID
                )
                guard role != nil else { return (false, []) }

                let rows = try await conn.query(
                    """
                    SELECT c.id,
                           COALESCE(rs.last_read_seq, 0)::bigint AS last_read_seq,
                           COALESCE(cs.last_seq, 0)::bigint AS latest_seq,
                           GREATEST(
                             COALESCE(cs.last_seq, 0) - COALESCE(rs.last_read_seq, 0),
                             0
                           )::bigint AS unread_count,
                           COALESCE(rs.mention_count, 0)::int AS mention_count
                      FROM membership ms
                      JOIN channel c
                        ON c.id = ms.channel_id
                       AND c.workspace_id = \(workspaceID)
                       AND c.archived_at IS NULL
                      JOIN channel_seq cs
                        ON cs.channel_id = c.id
                       AND cs.workspace_id = \(workspaceID)
                      LEFT JOIN read_state rs
                        ON rs.channel_id = c.id
                       AND rs.member_id = \(principal.memberID)
                       AND rs.workspace_id = \(workspaceID)
                     WHERE ms.member_id = \(principal.memberID)
                       AND ms.left_at IS NULL
                     ORDER BY ms.joined_at, c.id
                    """,
                    logger: db.logger
                ).collect()
                let states = try rows.map(Self.decodeState)
                return (true, states)
            }

        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }
        return try ReadStateListResponseDTO(readStates: result.states)
            .response(from: request, context: context)
    }

    @Sendable
    func update(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let channelID = try ChannelRoutes.channelID(context)
        let dto = try await request.decode(as: UpdateReadStateRequestDTO.self, context: context)
        guard dto.lastReadSeq >= 0 else {
            throw HTTPError(.badRequest, message: "last_read_seq must be non-negative")
        }

        let result: UpdateResult = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            // The membership row is the per-actor/channel serialization key even
            // before a read_state row exists, preventing duplicate first-write events.
            let headRows = try await conn.query(
                """
                SELECT cs.last_seq
                  FROM membership ms
                  JOIN channel c
                    ON c.id = ms.channel_id
                   AND c.workspace_id = \(workspaceID)
                   AND c.archived_at IS NULL
                  JOIN channel_seq cs
                    ON cs.channel_id = c.id
                   AND cs.workspace_id = \(workspaceID)
                 WHERE ms.channel_id = \(channelID)
                   AND ms.member_id = \(principal.memberID)
                   AND ms.left_at IS NULL
                 LIMIT 1
                 FOR UPDATE OF ms
                """,
                logger: db.logger
            ).collect()
            guard let headRow = headRows.first else { return .forbidden }
            let latestSeq = try headRow.decode(Int64.self)
            let boundedRequested = Self.effectiveCursor(
                current: 0,
                requested: dto.lastReadSeq,
                latest: latestSeq
            )

            let previousRows = try await conn.query(
                """
                SELECT last_read_seq
                  FROM read_state
                 WHERE channel_id = \(channelID)
                   AND member_id = \(principal.memberID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            let previousSeq = try previousRows.first?.decode(Int64.self) ?? 0

            let updatedRows = try await conn.query(
                """
                INSERT INTO read_state
                  (workspace_id, channel_id, member_id, last_read_seq,
                   last_read_at, mention_count, updated_at)
                VALUES
                  (\(workspaceID), \(channelID), \(principal.memberID),
                   \(boundedRequested), now(), 0, now())
                ON CONFLICT (channel_id, member_id)
                DO UPDATE
                   SET last_read_seq = GREATEST(
                         read_state.last_read_seq,
                         EXCLUDED.last_read_seq
                       ),
                       last_read_at = CASE
                         WHEN EXCLUDED.last_read_seq > read_state.last_read_seq THEN now()
                         ELSE read_state.last_read_at
                       END,
                       updated_at = CASE
                         WHEN EXCLUDED.last_read_seq > read_state.last_read_seq THEN now()
                         ELSE read_state.updated_at
                       END
                RETURNING last_read_seq
                """,
                logger: db.logger
            ).collect()
            guard let updatedRow = updatedRows.first else {
                throw HTTPError(.internalServerError, message: "read-state update failed")
            }
            let effectiveSeq = try updatedRow.decode(Int64.self)

            let mentionRows = try await conn.query(
                """
                SELECT count(*)::int
                  FROM message
                 WHERE channel_id = \(channelID)
                   AND seq > \(effectiveSeq)
                   AND deleted_at IS NULL
                   AND jsonb_typeof(props->'mention_member_ids') = 'array'
                   AND (props->'mention_member_ids') ? \(principal.memberID.uuidString)
                """,
                logger: db.logger
            ).collect()
            let mentionCount = try mentionRows.first?.decode(Int.self) ?? 0
            _ = try await conn.query(
                """
                UPDATE read_state
                   SET mention_count = \(mentionCount)
                 WHERE channel_id = \(channelID)
                   AND member_id = \(principal.memberID)
                """,
                logger: db.logger
            )

            let state = ReadStateDTO(
                channelId: channelID.uuidString,
                lastReadSeq: effectiveSeq,
                latestSeq: latestSeq,
                unreadCount: Self.unreadCount(latest: latestSeq, lastRead: effectiveSeq),
                mentionCount: mentionCount
            )
            if effectiveSeq > previousSeq {
                let payload = Self.broadcastPayload(
                    workspaceID: workspaceID,
                    memberID: principal.memberID,
                    state: state
                )
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(workspaceID), 'broadcast', 'publish',
                       \(payload)::jsonb, \(principal.memberID))
                    """,
                    logger: db.logger
                )
            }
            return .updated(state)
        }

        switch result {
        case .forbidden:
            throw Self.channelMembershipError()
        case .updated(let state):
            return try state.response(from: request, context: context)
        }
    }

    static func effectiveCursor(current: Int64, requested: Int64, latest: Int64) -> Int64 {
        max(current, min(requested, latest))
    }

    static func unreadCount(latest: Int64, lastRead: Int64) -> Int64 {
        max(0, latest - lastRead)
    }

    static func personalChannel(memberID: UUID) -> String {
        "user:read-state#\(memberID.uuidString)"
    }

    static func channelMembershipError() -> HTTPError {
        HTTPError(.forbidden, message: "not a member of this channel")
    }

    static func broadcastPayload(
        workspaceID: UUID,
        memberID: UUID,
        state: ReadStateDTO,
        timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> String {
        let channel = personalChannel(memberID: memberID)
        let object: [String: Any] = [
            "channel": channel,
            "data": [
                "type": "read_state",
                "v": 1,
                "ts": timestampMs,
                "payload": [
                    "workspace_id": workspaceID.uuidString,
                    "member_id": memberID.uuidString,
                    "channel_id": state.channelId,
                    "last_read_seq": state.lastReadSeq,
                    "latest_seq": state.latestSeq,
                    "unread_count": state.unreadCount,
                    "mention_count": state.mentionCount,
                ],
            ],
            "idempotency_key": "\(channel):\(state.channelId):\(state.lastReadSeq)",
        ]
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else { return "{}" }
        return json
    }

    private static func decodeState(_ row: PostgresRow) throws -> ReadStateDTO {
        let (channelID, lastReadSeq, latestSeq, unreadCount, mentionCount) = try row.decode(
            (UUID, Int64, Int64, Int64, Int).self
        )
        return ReadStateDTO(
            channelId: channelID.uuidString,
            lastReadSeq: lastReadSeq,
            latestSeq: latestSeq,
            unreadCount: unreadCount,
            mentionCount: mentionCount
        )
    }

    private enum UpdateResult: Sendable {
        case forbidden
        case updated(ReadStateDTO)
    }
}
