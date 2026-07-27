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
struct HuddleRecordingConsentResponse: ResponseEncodable {
    let huddleId: String
    let memberId: String
    let noticeVersion: Int
    let consentedAtMs: Int64
}
struct HuddleRecordingResponse: ResponseEncodable {
    let id: String
    let huddleId: String
    let model: String
    let status: String
    let requestedAtMs: Int64
}
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

enum HuddleRecordingConsentGate {
    static func allowsRecording(activeParticipantCount: Int, consentedParticipantCount: Int) -> Bool {
        activeParticipantCount > 0 && activeParticipantCount == consentedParticipantCount
    }
}

/// ADR-0122 V-1 huddle lifecycle. Every mutation is one tenant transaction:
/// PostgreSQL lifecycle + audit + broadcast outbox. The relay is the only
/// Centrifugo publisher.
struct HuddleRoutes: Sendable {
    let db: Database
    let liveKit: LiveKitConfig?
    let transcriptionModel: String?

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/channels/:ch/huddles", use: start)
        group.post("/v1/workspaces/:ws/huddles/:huddle/join", use: join)
        group.post("/v1/workspaces/:ws/huddles/:huddle/leave", use: leave)
        group.post(
            "/v1/workspaces/:ws/huddles/:huddle/recording-consent",
            use: consentToRecording
        )
        group.post("/v1/workspaces/:ws/huddles/:huddle/recordings", use: startRecording)
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
            let recordingRows = try await conn.query(
                "SELECT 1 FROM huddle_recording WHERE huddle_id = \(huddleID) AND status IN ('requested','recording')",
                logger: db.logger
            ).collect()
            if recordingRows.first != nil {
                let consentRows = try await conn.query(
                    """
                    SELECT 1
                      FROM huddle_recording_consent
                     WHERE huddle_id = \(huddleID)
                       AND member_id = \(principal.memberID)
                    """,
                    logger: db.logger
                ).collect()
                guard consentRows.first != nil else {
                    throw HTTPError(
                        .conflict,
                        message: "recording consent is required before joining this recorded huddle"
                    )
                }
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
                try await Self.enqueueTranscriptionIfRecordingEnded(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    huddleID: huddleID, channelID: scope.channelID
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
    func consentToRecording(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try configuredLiveKit()
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let huddleID = try Self.huddleID(context)
        let consentedAt: Date = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let scope = try await Self.lockHuddleForMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                huddleID: huddleID, principal: principal
            )
            guard scope.endedAt == nil else {
                throw HTTPError(.conflict, message: "huddle has ended")
            }
            let rows = try await conn.query(
                """
                INSERT INTO huddle_recording_consent
                  (workspace_id, huddle_id, member_id, notice_version)
                VALUES (\(workspaceID), \(huddleID), \(principal.memberID), 1)
                ON CONFLICT (huddle_id, member_id) DO UPDATE
                  SET consented_at = huddle_recording_consent.consented_at
                RETURNING consented_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "recording consent was not stored")
            }
            let recordedAt = try row.decode(Date.self)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, action: "huddle.recording_consent.granted",
                huddleID: huddleID,
                detailJSON: try Self.auditDetail(
                    schema: "momo.huddle.recording_consent.granted.v1",
                    channelID: scope.channelID
                )
            )
            return recordedAt
        }
        return try HuddleRecordingConsentResponse(
            huddleId: huddleID.uuidString.lowercased(),
            memberId: principal.memberID.uuidString.lowercased(),
            noticeVersion: 1,
            consentedAtMs: Int64(consentedAt.timeIntervalSince1970 * 1_000)
        ).response(from: request, context: context)
    }

    @Sendable
    func startRecording(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try configuredLiveKit()
        guard let model = Self.validatedTranscriptionModel(transcriptionModel) else {
            throw HTTPError(.serviceUnavailable, message: "huddle transcription is not configured")
        }
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let huddleID = try Self.huddleID(context)
        let outcome: (HuddleRecordingResponse, Bool) = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let scope = try await Self.lockHuddleForMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                huddleID: huddleID, principal: principal
            )
            guard scope.endedAt == nil else {
                throw HTTPError(.conflict, message: "huddle has ended")
            }
            let existing = try await Self.loadRecording(
                conn: conn, logger: db.logger, huddleID: huddleID
            )
            if let existing { return (existing, false) }

            let participantIDs = try await Self.activeParticipantIDs(
                conn: conn, logger: db.logger, huddleID: huddleID
            )
            let consentRows = try await conn.query(
                """
                SELECT member_id
                  FROM huddle_recording_consent
                 WHERE huddle_id = \(huddleID)
                   AND member_id = ANY(\(participantIDs))
                """,
                logger: db.logger
            ).collect()
            guard HuddleRecordingConsentGate.allowsRecording(
                activeParticipantCount: participantIDs.count,
                consentedParticipantCount: consentRows.count
            ) else {
                throw HTTPError(
                    .conflict,
                    message: "recording requires explicit consent from every active participant"
                )
            }

            let noticeMessageID = try await Self.insertRecordingNotice(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: scope.channelID, huddleID: huddleID,
                authorMemberID: principal.memberID
            )
            let rows = try await conn.query(
                """
                INSERT INTO huddle_recording
                  (workspace_id, huddle_id, channel_id, requested_by, model, notice_message_id)
                VALUES
                  (\(workspaceID), \(huddleID), \(scope.channelID), \(principal.memberID),
                   \(model), \(noticeMessageID))
                RETURNING id, requested_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "recording request was not created")
            }
            let (recordingID, requestedAt) = try row.decode((UUID, Date).self)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, action: "huddle.recording.requested",
                huddleID: huddleID,
                detailJSON: try Self.auditDetail(
                    schema: "momo.huddle.recording.requested.v1",
                    channelID: scope.channelID,
                    strings: [
                        "recording_id": recordingID.uuidString.lowercased(),
                        "model": model,
                    ]
                )
            )
            return (
                HuddleRecordingResponse(
                    id: recordingID.uuidString.lowercased(),
                    huddleId: huddleID.uuidString.lowercased(),
                    model: model,
                    status: "requested",
                    requestedAtMs: Int64(requestedAt.timeIntervalSince1970 * 1_000)
                ),
                true
            )
        }
        var response = try outcome.0.response(from: request, context: context)
        response.status = outcome.1 ? .created : .ok
        return response
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

    static func validatedTranscriptionModel(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty, value.count <= 255
        else { return nil }
        return value
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

    private static func loadRecording(
        conn: PostgresConnection,
        logger: Logger,
        huddleID: UUID
    ) async throws -> HuddleRecordingResponse? {
        let rows = try await conn.query(
            """
            SELECT id, model, status, requested_at
              FROM huddle_recording
             WHERE huddle_id = \(huddleID)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let (id, model, status, requestedAt) = try row.decode(
            (UUID, String, String, Date).self
        )
        return HuddleRecordingResponse(
            id: id.uuidString.lowercased(),
            huddleId: huddleID.uuidString.lowercased(),
            model: model,
            status: status,
            requestedAtMs: Int64(requestedAt.timeIntervalSince1970 * 1_000)
        )
    }

    private static func insertRecordingNotice(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        huddleID: UUID,
        authorMemberID: UUID
    ) async throws -> UUID {
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1_000)
        let body = "전원이 동의하여 녹음과 사후 전사가 시작됩니다. 계속 참여(Continue)하거나 허들을 나가세요(Leave)."
        let props: [String: Any] = [
            "kind": "huddle_recording_notice",
            "huddle_id": huddleID.uuidString.lowercased(),
            "notice_version": 1,
        ]
        let propsData = try JSONSerialization.data(withJSONObject: props, options: [.sortedKeys])
        guard let propsJSON = String(data: propsData, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "recording notice encoding failed")
        }
        let rows = try await conn.query(
            """
            WITH bumped AS (
              UPDATE channel_seq
                 SET last_seq = last_seq + 1
               WHERE workspace_id = \(workspaceID) AND channel_id = \(channelID)
              RETURNING last_seq AS seq
            )
            INSERT INTO message
              (workspace_id, channel_id, seq, hlc_ts, hlc_count,
               author_member_id, type, body, props)
            SELECT \(workspaceID), \(channelID), b.seq, \(hlcTs), 0,
                   \(authorMemberID), 'system'::message_type, \(body), \(propsJSON)::jsonb
              FROM bumped b
            RETURNING id, seq
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "recording notice insert failed")
        }
        let (messageID, seq) = try row.decode((UUID, Int64).self)
        let payload = MessageRoutes.broadcastPayload(
            centChannel: "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)",
            messageID: messageID,
            channelID: channelID,
            seq: seq,
            type: "system",
            body: body,
            authorMemberID: authorMemberID,
            hlcTs: hlcTs,
            hlcCount: 0,
            rootID: nil,
            props: props
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
            VALUES (\(workspaceID), 'broadcast', 'publish', \(payload)::jsonb, \(channelID))
            """,
            logger: logger
        )
        return messageID
    }

    private static func enqueueTranscriptionIfRecordingEnded(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        huddleID: UUID,
        channelID: UUID
    ) async throws {
        _ = try await conn.query(
            """
            WITH stopped AS (
              UPDATE huddle_recording
                 SET status = 'stopped', stopped_at = now()
               WHERE huddle_id = \(huddleID)
                 AND status IN ('requested','recording')
              RETURNING id, model
            )
            INSERT INTO huddle_transcription_job
              (workspace_id, huddle_id, recording_id, channel_id, model, status)
            SELECT \(workspaceID), \(huddleID), stopped.id, \(channelID), stopped.model, 'queued'
              FROM stopped
            ON CONFLICT (recording_id) DO NOTHING
            """,
            logger: logger
        )
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
        flags: [String: Bool] = [:],
        strings: [String: String] = [:]
    ) throws -> String {
        var detail: [String: Any] = [
            "schema": schema,
            "channel_id": channelID.uuidString,
        ]
        for (key, value) in flags { detail[key] = value }
        for (key, value) in strings { detail[key] = value }
        let data = try JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys])
        guard let json = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "huddle audit encoding failed")
        }
        return json
    }
}
