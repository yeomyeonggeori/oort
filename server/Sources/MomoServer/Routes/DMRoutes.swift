import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Authenticated 1:1 direct-message discovery and idempotent creation.
///
///   GET  /v1/workspaces/{ws}/dms
///   POST /v1/workspaces/{ws}/dms  { memberId }
///
/// DM creation stays on the ordinary RLS-protected app role. The channel,
/// channel_seq row, and both active memberships are guaranteed in one tenant
/// transaction; the existing partial unique index on `(workspace_id, dm_key)`
/// is the concurrency authority for one channel per participant pair.
struct DMRoutes: Sendable {
    private enum OpenResult: Sendable {
        case forbidden
        case targetNotFound
        case opened(OpenDirectMessageResponse)
    }

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/dms", use: list)
        group.post("/v1/workspaces/:ws/dms", use: open)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)

        let result: (isMember: Bool, channels: [ChannelDTO]) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role != nil else { return (false, []) }
            return (
                true,
                try await Self.fetchDirectMessages(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    memberID: principal.memberID
                )
            )
        }

        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }
        return try WorkspaceChannelsResponse(channels: result.channels)
            .response(from: request, context: context)
    }

    @Sendable
    func open(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: OpenDirectMessageRequest.self, context: context)
        try Self.validateTargetMember(actorID: principal.memberID, targetID: dto.memberId)

        let participantIDs = Self.canonicalParticipantIDs(principal.memberID, dto.memberId)
        let participantKey = participantIDs.map(\.uuidString).joined(separator: ":").lowercased()
        let firstParticipantID = participantIDs[0]
        let secondParticipantID = participantIDs[1]

        let result: OpenResult = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role != nil else {
                return .forbidden
            }

            let targetRows = try await conn.query(
                """
                SELECT EXISTS (
                  SELECT 1
                    FROM member m
                   WHERE m.id = \(dto.memberId)
                     AND m.workspace_id = \(workspaceID)
                     AND m.status = 'active'
                     AND m.deleted_at IS NULL
                )
                """,
                logger: db.logger
            ).collect()
            guard try targetRows.first?.decode(Bool.self) == true else {
                return .targetNotFound
            }

            // Serialize only this workspace/pair before the INSERT statement takes
            // its snapshot. A concurrent ON CONFLICT loser can then see the winner's
            // committed channel; the partial unique index remains the data authority.
            let lockKey = "\(workspaceID.uuidString.lowercased()):\(participantKey)"
            _ = try await conn.query(
                "SELECT pg_advisory_xact_lock(hashtextextended(\(lockKey), 0))",
                logger: db.logger
            ).collect()

            let rows = try await conn.query(
                """
                WITH requested AS (
                  SELECT encode(digest(\(participantKey), 'sha256'), 'hex') AS dm_key
                ),
                inserted_channel AS (
                  INSERT INTO channel (
                    id, workspace_id, kind, name, topic, dm_key, created_by
                  )
                  SELECT uuidv7(), \(workspaceID), 'dm'::channel_kind,
                         NULL, NULL, requested.dm_key, \(principal.memberID)
                    FROM requested
                  ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm'
                  DO NOTHING
                  RETURNING channel.*, true AS created
                ),
                selected_channel AS (
                  SELECT inserted_channel.*
                    FROM inserted_channel
                  UNION ALL
                  SELECT existing.*, false AS created
                    FROM channel existing
                    JOIN requested ON requested.dm_key = existing.dm_key
                   WHERE existing.workspace_id = \(workspaceID)
                     AND existing.kind = 'dm'
                     AND NOT EXISTS (SELECT 1 FROM inserted_channel)
                  LIMIT 1
                ),
                reopened_channel AS (
                  UPDATE channel reopened
                     SET archived_at = NULL,
                         updated_at = now()
                    FROM selected_channel
                   WHERE reopened.id = selected_channel.id
                     AND reopened.archived_at IS NOT NULL
                  RETURNING reopened.id
                ),
                ensured_seq AS (
                  INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
                  SELECT id, workspace_id, 0
                    FROM selected_channel
                  ON CONFLICT (channel_id) DO NOTHING
                  RETURNING channel_id
                ),
                upserted_memberships AS (
                  INSERT INTO membership (workspace_id, channel_id, member_id, role)
                  SELECT selected_channel.workspace_id,
                         selected_channel.id,
                         participant.member_id,
                         'member'::membership_role
                    FROM selected_channel
                    CROSS JOIN LATERAL unnest(
                      ARRAY[\(firstParticipantID), \(secondParticipantID)]::uuid[]
                    ) AS participant(member_id)
                  ON CONFLICT (channel_id, member_id)
                  DO UPDATE SET left_at = NULL
                  RETURNING channel_id
                )
                SELECT jsonb_build_object(
                         'id', selected_channel.id,
                         'workspaceId', selected_channel.workspace_id,
                         'kind', selected_channel.kind::text,
                         'name', selected_channel.name,
                         'topic', selected_channel.topic,
                         'dmKey', selected_channel.dm_key,
                         'memberIds', to_jsonb(
                           ARRAY[\(firstParticipantID), \(secondParticipantID)]::uuid[]
                         ),
                         'createdBy', selected_channel.created_by,
                         'archivedAtMs', NULL,
                         'muted', EXISTS (
                           SELECT 1
                             FROM notification_pref np
                            WHERE np.workspace_id = selected_channel.workspace_id
                              AND np.channel_id = selected_channel.id
                              AND np.member_id = \(principal.memberID)
                              AND (np.muted_until IS NULL OR np.muted_until > now())
                         )
                       )::text AS channel_json,
                       selected_channel.created
                  FROM selected_channel
                 WHERE (
                         EXISTS (
                           SELECT 1 FROM channel_seq seq
                            WHERE seq.channel_id = selected_channel.id
                         )
                         OR EXISTS (
                           SELECT 1 FROM ensured_seq
                            WHERE ensured_seq.channel_id = selected_channel.id
                         )
                       )
                   AND (
                         selected_channel.archived_at IS NULL
                         OR EXISTS (
                           SELECT 1 FROM reopened_channel
                            WHERE reopened_channel.id = selected_channel.id
                         )
                       )
                   AND (
                         SELECT count(*) FROM upserted_memberships
                          WHERE upserted_memberships.channel_id = selected_channel.id
                       ) = 2
                """,
                logger: db.logger
            ).collect()

            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "direct message could not be opened")
            }
            let (channelJSON, created) = try row.decode((String, Bool).self)
            return .opened(
                OpenDirectMessageResponse(
                    channel: try ChannelRoutes.decodeChannel(channelJSON),
                    created: created
                )
            )
        }

        switch result {
        case .forbidden:
            throw HTTPError(.forbidden, message: "not a workspace member")
        case .targetNotFound:
            throw HTTPError(.notFound, message: "active workspace member not found")
        case .opened(let opened):
            var response = try opened.response(from: request, context: context)
            response.status = opened.created ? .created : .ok
            return response
        }
    }

    static func canonicalParticipantIDs(_ first: UUID, _ second: UUID) -> [UUID] {
        [first, second].sorted { $0.uuidString.lowercased() < $1.uuidString.lowercased() }
    }

    static func validateTargetMember(actorID: UUID, targetID: UUID) throws {
        guard actorID != targetID else {
            throw HTTPError(.badRequest, message: "direct message target must be another member")
        }
    }

    private static func fetchDirectMessages(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws -> [ChannelDTO] {
        let rows = try await conn.query(
            """
            SELECT COALESCE(
                     json_agg(row_json ORDER BY created_at DESC, channel_id)::text,
                     '[]'
                   ) AS payload
              FROM (
                SELECT c.id AS channel_id,
                       c.created_at,
                       json_build_object(
                         'id', c.id,
                         'workspaceId', c.workspace_id,
                         'kind', c.kind::text,
                         'name', c.name,
                         'topic', c.topic,
                         'dmKey', c.dm_key,
                         'memberIds', (
                           SELECT COALESCE(
                                    jsonb_agg(participant.member_id ORDER BY participant.member_id::text),
                                    '[]'::jsonb
                                  )
                             FROM membership participant
                            WHERE participant.channel_id = c.id
                              AND participant.left_at IS NULL
                         ),
                         'createdBy', c.created_by,
                         'archivedAtMs', NULL,
                         'muted', EXISTS (
                           SELECT 1
                             FROM notification_pref np
                            WHERE np.workspace_id = c.workspace_id
                              AND np.channel_id = c.id
                              AND np.member_id = \(memberID)
                              AND (np.muted_until IS NULL OR np.muted_until > now())
                         )
                       ) AS row_json
                  FROM channel c
                  JOIN membership actor_membership
                    ON actor_membership.channel_id = c.id
                   AND actor_membership.member_id = \(memberID)
                   AND actor_membership.left_at IS NULL
                 WHERE c.workspace_id = \(workspaceID)
                   AND c.kind = 'dm'
                   AND c.archived_at IS NULL
                 ORDER BY c.created_at DESC, c.id
                 LIMIT 500
              ) rows
            """,
            logger: logger
        ).collect()
        return try ChannelRoutes.decodeChannelList(from: rows.first)
    }
}
