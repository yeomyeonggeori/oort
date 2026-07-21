import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Workspace channel read endpoints.
///
///   GET /v1/workspaces/{ws}/channels
///   POST /v1/workspaces/{ws}/channels
///   PUT /v1/workspaces/{ws}/channels/{ch}/notification-pref
///   POST /v1/workspaces/{ws}/channels/{ch}/members
///   DELETE /v1/workspaces/{ws}/channels/{ch}/members/{member}
///
/// The handler uses the normal tenant read path (`SET LOCAL app.workspace_id`)
/// and active workspace admin guards. Write endpoints must never use BYPASSRLS.
struct ChannelRoutes: Sendable {
    let db: Database

    /// Preserve intended 4xx responses thrown inside a Postgres transaction.
    /// PostgresNIO wraps closure errors after rollback by default.
    private func withTenantTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await db.withTenantTransaction(workspaceID: workspaceID, body)
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/channels", use: list)
        group.post("/v1/workspaces/:ws/channels", use: create)
        group.put("/v1/workspaces/:ws/channels/:ch/notification-pref", use: updateNotificationPref)
        group.post("/v1/workspaces/:ws/channels/:ch/members", use: addMember)
        group.delete("/v1/workspaces/:ws/channels/:ch/members/:member", use: removeMember)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let includeArchived = request.uri.queryParameters["include_archived"] == "true"
            || request.uri.queryParameters["includeArchived"] == "true"
        let limit = Self.validatedLimit(request.uri.queryParameters["limit"].map(String.init))

        let result: (isMember: Bool, channels: [ChannelDTO]) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role != nil else { return (false, []) }

            let channels = try await Self.fetchChannels(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID,
                includeArchived: includeArchived,
                limit: limit
            )
            return (true, channels)
        }

        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }
        return try WorkspaceChannelsResponse(channels: result.channels)
            .response(from: request, context: context)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: CreateChannelRequest.self, context: context)
        let kind = try Self.normalizedChannelKind(dto.kind)
        let name = try Self.normalizedChannelName(dto.name)
        let topic = try Self.normalizedTopic(dto.topic)
        try await Self.requireWorkspaceAdmin(db: db, workspaceID: workspaceID, principal: principal)

        let created: CreateChannelResponse? = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                WITH inserted_channel AS (
                  INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
                  SELECT uuidv7(), \(workspaceID), \(kind)::channel_kind,
                         \(name), \(topic), \(principal.memberID)
                   WHERE NOT EXISTS (
                         SELECT 1
                           FROM channel existing
                          WHERE existing.workspace_id = \(workspaceID)
                            AND existing.kind <> 'dm'
                            AND existing.archived_at IS NULL
                            AND lower(existing.name) = lower(\(name))
                       )
                  RETURNING *
                ),
                inserted_seq AS (
                  INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
                  SELECT id, workspace_id, 0
                    FROM inserted_channel
                  RETURNING channel_id
                ),
                inserted_membership AS (
                  INSERT INTO membership (workspace_id, channel_id, member_id, role)
                  SELECT workspace_id, id, \(principal.memberID), 'owner'::membership_role
                    FROM inserted_channel
                  RETURNING *
                )
                SELECT jsonb_build_object(
                         'id', c.id,
                         'workspaceId', c.workspace_id,
                         'kind', c.kind::text,
                         'name', c.name,
                         'topic', c.topic,
                         'dmKey', c.dm_key,
                         'memberIds', '[]'::jsonb,
                         'createdBy', c.created_by,
                         'archivedAtMs',
                           CASE WHEN c.archived_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from c.archived_at) * 1000)::bigint
                           END,
                         'muted', false
                       )::text AS channel_json,
                       jsonb_build_object(
                         'id', ms.id,
                         'workspaceId', ms.workspace_id,
                         'channelId', ms.channel_id,
                         'memberId', ms.member_id,
                         'role', ms.role::text,
                         'joinedAtMs', floor(extract(epoch from ms.joined_at) * 1000)::bigint,
                         'leftAtMs',
                           CASE WHEN ms.left_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from ms.left_at) * 1000)::bigint
                           END
                       )::text AS membership_json
                  FROM inserted_channel c
                  JOIN inserted_membership ms ON ms.channel_id = c.id
                  JOIN inserted_seq seq ON seq.channel_id = c.id
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (channelJSON, membershipJSON) = try row.decode((String, String).self)
            return CreateChannelResponse(
                channel: try Self.decodeChannel(channelJSON),
                creatorMembership: try Self.decodeMembership(membershipJSON)
            )
        }
        guard let created else {
            throw HTTPError(.conflict, message: "channel name already exists")
        }

        var response = try created.response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func addMember(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let channelID = try Self.channelID(context)
        let dto = try await request.decode(as: AddChannelMemberRequest.self, context: context)
        let role = try Self.normalizedMembershipRole(dto.role)
        try await Self.requireWorkspaceAdmin(db: db, workspaceID: workspaceID, principal: principal)

        let membership: ChannelMembershipDTO? = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                WITH target AS (
                  SELECT c.id AS channel_id,
                         c.workspace_id,
                         m.id AS member_id
                    FROM channel c
                    JOIN member m
                      ON m.workspace_id = c.workspace_id
                     AND m.id = \(dto.memberId)
                     AND m.status = 'active'
                     AND m.deleted_at IS NULL
                    JOIN workspace_membership wm
                      ON wm.workspace_id = m.workspace_id
                     AND wm.member_id = m.id
                   WHERE c.id = \(channelID)
                     AND c.workspace_id = \(workspaceID)
                     AND c.kind IN ('public', 'private')
                     AND c.archived_at IS NULL
                ),
                upserted AS (
                  INSERT INTO membership (workspace_id, channel_id, member_id, role)
                  SELECT workspace_id, channel_id, member_id, \(role)::membership_role
                    FROM target
                  ON CONFLICT (channel_id, member_id)
                  DO UPDATE
                     SET role = EXCLUDED.role,
                         left_at = NULL
                  RETURNING *
                )
                SELECT jsonb_build_object(
                         'id', ms.id,
                         'workspaceId', ms.workspace_id,
                         'channelId', ms.channel_id,
                         'memberId', ms.member_id,
                         'role', ms.role::text,
                         'joinedAtMs', floor(extract(epoch from ms.joined_at) * 1000)::bigint,
                         'leftAtMs',
                           CASE WHEN ms.left_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from ms.left_at) * 1000)::bigint
                           END
                       )::text AS membership_json
                  FROM upserted ms
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            return try Self.decodeMembership(row.decode(String.self))
        }
        guard let membership else {
            throw HTTPError(.notFound, message: "channel or member not found")
        }

        return try ChannelMembershipResponse(membership: membership)
            .response(from: request, context: context)
    }

    @Sendable
    func updateNotificationPref(
        _ request: Request,
        context: AppRequestContext
    ) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let channelID = try Self.channelID(context)
        let dto = try await request.decode(as: UpdateNotificationPrefRequest.self, context: context)

        try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            let membershipRows = try await conn.query(
                """
                SELECT 1
                  FROM membership ms
                  JOIN channel c
                    ON c.id = ms.channel_id
                   AND c.workspace_id = ms.workspace_id
                 WHERE ms.workspace_id = \(workspaceID)
                   AND ms.channel_id = \(channelID)
                   AND ms.member_id = \(principal.memberID)
                   AND ms.left_at IS NULL
                   AND c.archived_at IS NULL
                """,
                logger: db.logger
            ).collect()
            guard !membershipRows.isEmpty else {
                throw HTTPError(.forbidden, message: "active channel membership required")
            }

            if dto.muted {
                _ = try await conn.query(
                    """
                    INSERT INTO notification_pref (
                      workspace_id, member_id, channel_id, muted_until
                    )
                    VALUES (\(workspaceID), \(principal.memberID), \(channelID), NULL)
                    ON CONFLICT (workspace_id, member_id, channel_id)
                    DO UPDATE SET muted_until = NULL, updated_at = now()
                    """,
                    logger: db.logger
                )
            } else {
                _ = try await conn.query(
                    """
                    DELETE FROM notification_pref
                     WHERE workspace_id = \(workspaceID)
                       AND member_id = \(principal.memberID)
                       AND channel_id = \(channelID)
                    """,
                    logger: db.logger
                )
            }

            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, detail)
                VALUES (
                  \(workspaceID),
                  \(principal.memberID),
                  'notification_pref.updated',
                  'channel',
                  \(channelID),
                  \(principal.tokenID),
                  jsonb_build_object(
                    'schema', 'momo.notification_pref.updated.v1',
                    'muted', \(dto.muted)
                  )
                )
                """,
                logger: db.logger
            )
        }

        return try NotificationPrefResponse(muted: dto.muted)
            .response(from: request, context: context)
    }

    @Sendable
    func removeMember(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let channelID = try Self.channelID(context)
        let memberID = try Self.memberID(context)
        try await Self.requireWorkspaceAdmin(db: db, workspaceID: workspaceID, principal: principal)

        let membership: ChannelMembershipDTO? = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                WITH updated AS (
                  UPDATE membership ms
                     SET left_at = COALESCE(ms.left_at, now())
                    FROM channel c
                    JOIN member m
                      ON m.workspace_id = c.workspace_id
                     AND m.id = \(memberID)
                   WHERE c.id = \(channelID)
                     AND c.workspace_id = \(workspaceID)
                     AND c.kind IN ('public', 'private')
                     AND c.archived_at IS NULL
                     AND ms.channel_id = c.id
                     AND ms.member_id = m.id
                     AND ms.left_at IS NULL
                  RETURNING ms.*
                )
                SELECT jsonb_build_object(
                         'id', ms.id,
                         'workspaceId', ms.workspace_id,
                         'channelId', ms.channel_id,
                         'memberId', ms.member_id,
                         'role', ms.role::text,
                         'joinedAtMs', floor(extract(epoch from ms.joined_at) * 1000)::bigint,
                         'leftAtMs',
                           CASE WHEN ms.left_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from ms.left_at) * 1000)::bigint
                           END
                       )::text AS membership_json
                  FROM updated ms
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            return try Self.decodeMembership(row.decode(String.self))
        }
        guard let membership else {
            throw HTTPError(.notFound, message: "active channel membership not found")
        }

        return try ChannelMembershipResponse(membership: membership)
            .response(from: request, context: context)
    }

    static func validatedLimit(_ raw: String?) -> Int {
        min(max(raw.flatMap { Int($0) } ?? 200, 1), 500)
    }

    static func requireWorkspaceAdmin(
        db: Database,
        workspaceID: UUID,
        principal: AuthPrincipal
    ) async throws {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
        }
    }

    static func normalizedChannelKind(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value == "public" || value == "private" else {
            throw HTTPError(.badRequest, message: "channel kind must be public or private")
        }
        return value
    }

    static func normalizedChannelName(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard (1...80).contains(value.count) else {
            throw HTTPError(.badRequest, message: "channel name must be 1-80 characters")
        }
        guard value.range(
            of: #"^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$"#,
            options: .regularExpression
        ) != nil else {
            throw HTTPError(
                .badRequest,
                message: "channel name must use lowercase letters, numbers, hyphen, or underscore"
            )
        }
        return value
    }

    static func normalizedTopic(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard value.count <= 280 else {
            throw HTTPError(.badRequest, message: "channel topic must be 280 characters or fewer")
        }
        return value
    }

    static func normalizedMembershipRole(_ raw: String?) throws -> String {
        let value = (raw ?? "member")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard ["admin", "member", "guest"].contains(value) else {
            throw HTTPError(.badRequest, message: "membership role must be admin, member, or guest")
        }
        return value
    }

    static func channelID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("ch")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid channel id")
        }
        return id
    }

    static func memberID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("member")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid member id")
        }
        return id
    }

    static func decodeChannelList(from row: PostgresRow?) throws -> [ChannelDTO] {
        guard let row else { return [] }
        let json = try row.decode(String.self)
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "channel JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode([ChannelDTO].self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "channel JSON decoding failed")
        }
    }

    static func decodeChannel(_ json: String) throws -> ChannelDTO {
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "channel JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode(ChannelDTO.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "channel JSON decoding failed")
        }
    }

    static func decodeMembership(_ json: String) throws -> ChannelMembershipDTO {
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "membership JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode(ChannelMembershipDTO.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "membership JSON decoding failed")
        }
    }

    private static func fetchChannels(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID,
        includeArchived: Bool,
        limit: Int
    ) async throws -> [ChannelDTO] {
        let rows = try await conn.query(
            """
            SELECT COALESCE(json_agg(row_json ORDER BY sort_key, lower(COALESCE(row_json->>'name', '')))::text, '[]') AS payload
              FROM (
                SELECT json_build_object(
                         'id', c.id,
                         'workspaceId', c.workspace_id,
                         'kind', c.kind::text,
                         'name', c.name,
                         'topic', c.topic,
                         'dmKey', c.dm_key,
                         'memberIds',
                           CASE WHEN c.kind = 'dm' THEN (
                             SELECT COALESCE(jsonb_agg(dm_ms.member_id ORDER BY dm_ms.member_id::text), '[]'::jsonb)
                               FROM membership dm_ms
                              WHERE dm_ms.channel_id = c.id
                                AND dm_ms.left_at IS NULL
                           ) ELSE '[]'::jsonb END,
                         'createdBy', c.created_by,
                         'archivedAtMs',
                           CASE WHEN c.archived_at IS NULL
                                THEN NULL
                                ELSE floor(extract(epoch from c.archived_at) * 1000)::bigint
                           END,
                         'muted', EXISTS (
                           SELECT 1
                             FROM notification_pref np
                            WHERE np.workspace_id = c.workspace_id
                              AND np.channel_id = c.id
                              AND np.member_id = \(memberID)
                              AND (np.muted_until IS NULL OR np.muted_until > now())
                         )
                       ) AS row_json,
                       CASE c.kind::text
                         WHEN 'public' THEN 0
                         WHEN 'private' THEN 1
                         ELSE 2
                       END AS sort_key
                  FROM channel c
                  JOIN membership ms
                    ON ms.channel_id = c.id
                   AND ms.member_id = \(memberID)
                   AND ms.left_at IS NULL
                 WHERE c.workspace_id = \(workspaceID)
                   AND (\(includeArchived) OR c.archived_at IS NULL)
                 ORDER BY sort_key, lower(COALESCE(c.name, ''))
                 LIMIT \(limit)
              ) rows
            """,
            logger: logger
        ).collect()
        return try decodeChannelList(from: rows.first)
    }
}
