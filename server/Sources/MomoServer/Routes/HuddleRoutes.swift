import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct HuddleParticipantDTO: ResponseEncodable, Decodable, Sendable, Equatable {
    let memberId: String
    let displayName: String
    let joinedAtMs: Int64
}

struct HuddleDTO: ResponseEncodable, Decodable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let channelId: String
    let startedBy: String
    let startedAtMs: Int64
    let endedAtMs: Int64?
    let participants: [HuddleParticipantDTO]
}

struct HuddleResponse: ResponseEncodable { let huddle: HuddleDTO }
struct ActiveHuddleResponse: ResponseEncodable { let huddle: HuddleDTO? }
struct LeaveHuddleResponse: ResponseEncodable { let huddle: HuddleDTO; let ended: Bool }
struct JoinHuddleResponse: ResponseEncodable {
    let huddle: HuddleDTO
    let livekitUrl: String
    let token: String
    let expiresAtMs: Int64
    let ttlSeconds: Int
}

enum HuddleLifecycle {
    static func eventAfterLeave(activeParticipantCount: Int) -> (ended: Bool, type: String) {
        precondition(activeParticipantCount >= 0)
        return activeParticipantCount == 0
            ? (true, "huddle_ended")
            : (false, "huddle_participants_changed")
    }
}

/// ADR-0122 V-1 huddle lifecycle. Every mutation is one tenant transaction:
/// PostgreSQL lifecycle + audit + broadcast outbox. The relay is the only
/// Centrifugo publisher.
struct HuddleRoutes: Sendable {
    let db: Database
    let liveKit: LiveKitConfig?

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/channels/:ch/huddles", use: start)
        group.post("/v1/workspaces/:ws/huddles/:huddle/join", use: join)
        group.post("/v1/workspaces/:ws/huddles/:huddle/leave", use: leave)
        group.get("/v1/workspaces/:ws/channels/:ch/huddles/active", use: active)
    }

    @Sendable
    func start(_ request: Request, context: AppRequestContext) async throws -> Response {
        let config = try configuredLiveKit()
        _ = config // All huddle APIs share the same fail-closed configuration guard.
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let channelID = try ChannelRoutes.channelID(context)

        let outcome: (HuddleDTO, Bool) = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireChannelMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: channelID, principal: principal
            )
            let inserted = try await conn.query(
                """
                INSERT INTO huddle (workspace_id, channel_id, started_by)
                VALUES (\(workspaceID), \(channelID), \(principal.memberID))
                ON CONFLICT (channel_id) WHERE ended_at IS NULL DO NOTHING
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            let created = inserted.first != nil
            let huddleID: UUID
            if let row = inserted.first {
                huddleID = try row.decode(UUID.self)
            } else {
                let rows = try await conn.query(
                    "SELECT id FROM huddle WHERE channel_id = \(channelID) AND ended_at IS NULL",
                    logger: db.logger
                ).collect()
                guard let row = rows.first else {
                    throw HTTPError(.conflict, message: "active huddle changed concurrently — retry")
                }
                huddleID = try row.decode(UUID.self)
            }

            if created {
                try await Self.insertEvent(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    channelID: channelID, huddleID: huddleID,
                    type: "huddle_started", participantMemberIDs: []
                )
                try await Self.insertAudit(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    principal: principal, action: "huddle.started", huddleID: huddleID,
                    detailJSON: try Self.auditDetail(
                        schema: "momo.huddle.started.v1", channelID: channelID
                    )
                )
            }
            return (try await Self.loadHuddle(conn: conn, logger: db.logger, huddleID: huddleID), created)
        }

        var response = try HuddleResponse(huddle: outcome.0).response(from: request, context: context)
        response.status = outcome.1 ? .created : .ok
        return response
    }

    @Sendable
    func join(_ request: Request, context: AppRequestContext) async throws -> Response {
        let config = try configuredLiveKit()
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let huddleID = try Self.huddleID(context)

        let outcome: (HuddleDTO, IssuedLiveKitToken) = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let scope = try await Self.lockHuddleForMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                huddleID: huddleID, principal: principal
            )
            guard scope.endedAt == nil else {
                throw HTTPError(.conflict, message: "huddle has ended")
            }
            let inserted = try await conn.query(
                """
                INSERT INTO huddle_participant (workspace_id, huddle_id, member_id)
                VALUES (\(workspaceID), \(huddleID), \(principal.memberID))
                ON CONFLICT (huddle_id, member_id) WHERE left_at IS NULL DO NOTHING
                RETURNING joined_at
                """,
                logger: db.logger
            ).collect()
            if inserted.first != nil {
                let memberIDs = try await Self.activeParticipantIDs(
                    conn: conn, logger: db.logger, huddleID: huddleID
                )
                try await Self.insertEvent(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    channelID: scope.channelID, huddleID: huddleID,
                    type: "huddle_participants_changed", participantMemberIDs: memberIDs
                )
            }
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, action: "huddle.joined", huddleID: huddleID,
                detailJSON: try Self.auditDetail(
                    schema: "momo.huddle.joined.v1", channelID: scope.channelID,
                    flags: ["participant_created": !inserted.isEmpty]
                )
            )
            let token = try LiveKitTokenService.issue(
                config: config, roomID: huddleID, memberID: principal.memberID,
                displayName: scope.displayName
            )
            return (try await Self.loadHuddle(conn: conn, logger: db.logger, huddleID: huddleID), token)
        }

        return try JoinHuddleResponse(
            huddle: outcome.0,
            livekitUrl: config.url,
            token: outcome.1.token,
            expiresAtMs: Int64(outcome.1.expiresAt.timeIntervalSince1970 * 1000),
            ttlSeconds: outcome.1.ttlSeconds
        ).response(from: request, context: context)
    }

    @Sendable
    func leave(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try configuredLiveKit()
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let huddleID = try Self.huddleID(context)

        let outcome: (HuddleDTO, Bool) = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let scope = try await Self.lockHuddleForMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                huddleID: huddleID, principal: principal
            )
            if scope.endedAt != nil {
                return (try await Self.loadHuddle(conn: conn, logger: db.logger, huddleID: huddleID), true)
            }
            let left = try await conn.query(
                """
                UPDATE huddle_participant
                   SET left_at = now()
                 WHERE huddle_id = \(huddleID)
                   AND member_id = \(principal.memberID)
                   AND left_at IS NULL
                RETURNING joined_at
                """,
                logger: db.logger
            ).collect()
            guard left.first != nil else {
                throw HTTPError(.conflict, message: "member is not in this huddle")
            }
            let memberIDs = try await Self.activeParticipantIDs(
                conn: conn, logger: db.logger, huddleID: huddleID
            )
            let transition = HuddleLifecycle.eventAfterLeave(
                activeParticipantCount: memberIDs.count
            )
            let ended = transition.ended
            if ended {
                _ = try await conn.query(
                    "UPDATE huddle SET ended_at = now() WHERE id = \(huddleID) AND ended_at IS NULL",
                    logger: db.logger
                )
            }
            try await Self.insertEvent(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: scope.channelID, huddleID: huddleID,
                type: transition.type,
                participantMemberIDs: memberIDs
            )
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, action: "huddle.left", huddleID: huddleID,
                detailJSON: try Self.auditDetail(
                    schema: "momo.huddle.left.v1", channelID: scope.channelID,
                    flags: ["ended": ended]
                )
            )
            return (try await Self.loadHuddle(conn: conn, logger: db.logger, huddleID: huddleID), ended)
        }

        return try LeaveHuddleResponse(huddle: outcome.0, ended: outcome.1)
            .response(from: request, context: context)
    }

    @Sendable
    func active(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try configuredLiveKit()
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let channelID = try ChannelRoutes.channelID(context)
        let huddle: HuddleDTO? = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireChannelMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: channelID, principal: principal
            )
            let rows = try await conn.query(
                "SELECT id FROM huddle WHERE channel_id = \(channelID) AND ended_at IS NULL",
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            return try await Self.loadHuddle(
                conn: conn, logger: db.logger, huddleID: try row.decode(UUID.self)
            )
        }
        return try ActiveHuddleResponse(huddle: huddle).response(from: request, context: context)
    }

    private func configuredLiveKit() throws -> LiveKitConfig {
        guard let liveKit else {
            throw HTTPError(.serviceUnavailable, message: "허들 미구성")
        }
        return liveKit
    }

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

    private static func huddleID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("huddle")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid huddle id")
        }
        return id
    }

    private static func requireChannelMember(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        principal: AuthPrincipal
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM channel c
              JOIN membership ms ON ms.channel_id = c.id
                                AND ms.member_id = \(principal.memberID)
                                AND ms.left_at IS NULL
              JOIN member m ON m.id = ms.member_id
                           AND m.workspace_id = c.workspace_id
                           AND m.status = 'active'
                           AND m.deleted_at IS NULL
             WHERE c.id = \(channelID)
               AND c.workspace_id = \(workspaceID)
               AND c.archived_at IS NULL
            """,
            logger: logger
        ).collect()
        guard rows.first != nil else {
            throw HTTPError(.forbidden, message: "active channel membership required")
        }
    }

    private static func lockHuddleForMember(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        huddleID: UUID,
        principal: AuthPrincipal
    ) async throws -> (channelID: UUID, displayName: String, endedAt: Date?) {
        let rows = try await conn.query(
            """
            SELECT h.channel_id, m.display_name, h.ended_at
              FROM huddle h
              JOIN membership ms ON ms.channel_id = h.channel_id
                                AND ms.member_id = \(principal.memberID)
                                AND ms.left_at IS NULL
              JOIN member m ON m.id = ms.member_id
                           AND m.workspace_id = h.workspace_id
                           AND m.status = 'active'
                           AND m.deleted_at IS NULL
             WHERE h.id = \(huddleID)
               AND h.workspace_id = \(workspaceID)
             FOR UPDATE OF h
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.forbidden, message: "active channel membership required")
        }
        return try row.decode((UUID, String, Date?).self)
    }

    private static func activeParticipantIDs(
        conn: PostgresConnection,
        logger: Logger,
        huddleID: UUID
    ) async throws -> [UUID] {
        let rows = try await conn.query(
            "SELECT member_id FROM huddle_participant WHERE huddle_id = \(huddleID) AND left_at IS NULL ORDER BY joined_at",
            logger: logger
        ).collect()
        return try rows.map { try $0.decode(UUID.self) }
    }

    private static func loadHuddle(
        conn: PostgresConnection,
        logger: Logger,
        huddleID: UUID
    ) async throws -> HuddleDTO {
        let rows = try await conn.query(
            """
            SELECT jsonb_build_object(
                     'id', h.id,
                     'workspaceId', h.workspace_id,
                     'channelId', h.channel_id,
                     'startedBy', h.started_by,
                     'startedAtMs', floor(extract(epoch from h.started_at) * 1000)::bigint,
                     'endedAtMs', CASE WHEN h.ended_at IS NULL THEN NULL
                                       ELSE floor(extract(epoch from h.ended_at) * 1000)::bigint END,
                     'participants', COALESCE((
                       SELECT jsonb_agg(jsonb_build_object(
                                'memberId', hp.member_id,
                                'displayName', m.display_name,
                                'joinedAtMs', floor(extract(epoch from hp.joined_at) * 1000)::bigint
                              ) ORDER BY hp.joined_at)
                         FROM huddle_participant hp
                         JOIN member m ON m.id = hp.member_id
                        WHERE hp.huddle_id = h.id AND hp.left_at IS NULL
                     ), '[]'::jsonb)
                   )::text
              FROM huddle h
             WHERE h.id = \(huddleID)
            """,
            logger: logger
        ).collect()
        guard let json = try rows.first?.decode(String.self),
              let data = json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(HuddleDTO.self, from: data)
        else { throw HTTPError(.internalServerError, message: "huddle response encoding failed") }
        return decoded
    }

    private static func insertEvent(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        huddleID: UUID,
        type: String,
        participantMemberIDs: [UUID]
    ) async throws {
        let eventID = UUID()
        let timestampMs = Int64(Date().timeIntervalSince1970 * 1000)
        let payload: [String: Any] = [
            "channel": "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)",
            "data": [
                "type": type,
                "v": 1,
                "ts": timestampMs,
                "payload": [
                    "huddle_id": huddleID.uuidString,
                    "channel_id": channelID.uuidString,
                    "participant_member_ids": participantMemberIDs.map(\.uuidString),
                ],
            ],
            "idempotency_key": "huddle:\(eventID.uuidString)",
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        guard let json = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "huddle event encoding failed")
        }
        _ = try await conn.query(
            """
            INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
            VALUES (\(workspaceID), 'broadcast', 'publish', \(json)::jsonb, \(channelID))
            """,
            logger: logger
        )
    }

    private static func insertAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        action: String,
        huddleID: UUID,
        detailJSON: String
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type,
               target_id, via_token_id, detail)
            VALUES (\(workspaceID), \(principal.memberID), \(action), 'huddle',
                    \(huddleID), \(principal.tokenID), \(detailJSON)::jsonb)
            """,
            logger: logger
        )
    }

    private static func auditDetail(
        schema: String,
        channelID: UUID,
        flags: [String: Bool] = [:]
    ) throws -> String {
        var detail: [String: Any] = [
            "schema": schema,
            "channel_id": channelID.uuidString,
        ]
        for (key, value) in flags { detail[key] = value }
        let data = try JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys])
        guard let json = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "huddle audit encoding failed")
        }
        return json
    }
}
