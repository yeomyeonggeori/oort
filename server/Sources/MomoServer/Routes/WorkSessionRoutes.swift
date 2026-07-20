import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct CreateWorkSessionRequest: Decodable {
    let channelId: UUID
    let hostId: UUID
    let tool: String
    let label: String
    let controlId: UUID?
}

struct EndWorkSessionRequest: Decodable {
    let status: String
    let exitCode: Int?
}

struct WorkSessionDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let channelId: String
    let memberId: String
    let hostId: String
    let rootMessageId: String
    let tool: String
    let label: String
    let status: String
    let startedAtMs: Int64
    let endedAtMs: Int64?
    let exitCode: Int?
}

struct WorkSessionResponse: ResponseEncodable {
    let workSession: WorkSessionDTO
}

struct WorkSessionListResponse: ResponseEncodable {
    let workSessions: [WorkSessionDTO]
}

/// ADR-0114 session ledger. PostgreSQL owns lifecycle and delivery; the server
/// never sees host-local cwd/path/process state or provider credentials.
///
/// POST  /v1/workspaces/{ws}/work-sessions
/// PATCH /v1/workspaces/{ws}/work-sessions/{session}
/// GET   /v1/workspaces/{ws}/work-sessions?active=1
struct WorkSessionRoutes: Sendable {
    private enum Tool: String, CaseIterable {
        case claude, codex, opencode, shell
    }

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/work-sessions", use: create)
        group.patch("/v1/workspaces/:ws/work-sessions/:session", use: end)
        group.get("/v1/workspaces/:ws/work-sessions", use: list)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human || principal.kind == .workHost else {
            throw HTTPError(.forbidden, message: "work sessions require a human or work host")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let requestDTO = try await request.decode(
            as: CreateWorkSessionRequest.self,
            context: context
        )
        let tool = try Self.validatedTool(requestDTO.tool)
        let label = try Self.validatedLabel(requestDTO.label)
        let channelID = requestDTO.channelId
        let hostID = requestDTO.hostId
        if principal.kind == .human, requestDTO.controlId != nil {
            throw HTTPError(.badRequest, message: "controlId is reserved for work host dispatch")
        }
        if principal.kind == .workHost {
            guard hostID == principal.tokenID, requestDTO.controlId != nil else {
                throw HTTPError(.forbidden, message: "work host session binding is invalid")
            }
        }
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)

        let session = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let sessionOwnerMemberID: UUID
            if principal.kind == .workHost {
                sessionOwnerMemberID = try await Self.requireDispatchedSpawnControl(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    controlID: requestDTO.controlId!,
                    channelID: channelID,
                    hostID: hostID,
                    tool: tool,
                    label: label
                )
            } else {
                sessionOwnerMemberID = principal.memberID
            }
            try await Self.requireChannelMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: channelID,
                memberID: sessionOwnerMemberID
            )
            try await WorkPoolRoutes.acquireSlot(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: sessionOwnerMemberID
            )

            let idRows = try await conn.query("SELECT uuidv7()", logger: db.logger).collect()
            guard let idRow = idRows.first else {
                throw HTTPError(.internalServerError, message: "work session id allocation failed")
            }
            let sessionID = try idRow.decode(UUID.self)
            let props = Self.cardProps(
                sessionID: sessionID,
                tool: tool,
                label: label,
                status: "running"
            )
            let propsJSON = Self.jsonString(props)

            let messageRows = try await conn.query(
                """
                WITH bumped AS (
                  UPDATE channel_seq
                     SET last_seq = last_seq + 1
                   WHERE workspace_id = \(workspaceID)
                     AND channel_id = \(channelID)
                  RETURNING last_seq AS seq
                )
                INSERT INTO message
                  (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                   author_member_id, type, body, props, client_msg_id)
                SELECT \(workspaceID), \(channelID), b.seq, \(hlcTs), 0,
                       \(sessionOwnerMemberID), 'system'::message_type, NULL,
                       \(propsJSON)::jsonb, \(sessionID)
                  FROM bumped b
                RETURNING id, seq, created_at
                """,
                logger: db.logger
            ).collect()
            guard let messageRow = messageRows.first else {
                throw HTTPError(.notFound, message: "channel not found or not provisioned")
            }
            let (rootMessageID, rootMessageSeq, startedAt) = try messageRow.decode(
                (UUID, Int64, Date).self
            )

            let sessionRows = try await conn.query(
                """
                INSERT INTO work_session
                  (id, workspace_id, channel_id, member_id, host_id,
                   root_message_id, tool, label, started_at)
                VALUES
                  (\(sessionID), \(workspaceID), \(channelID), \(sessionOwnerMemberID),
                   \(hostID), \(rootMessageID), \(tool), \(label), \(startedAt))
                RETURNING id, workspace_id, channel_id, member_id, host_id,
                          root_message_id, tool, label, status, started_at,
                          ended_at, exit_code
                """,
                logger: db.logger
            ).collect()
            guard let sessionRow = sessionRows.first else {
                throw HTTPError(.internalServerError, message: "work session insert failed")
            }
            let workSession = try Self.decodeSession(sessionRow)

            let channel = Self.channelName(workspaceID: workspaceID, channelID: channelID)
            let messagePayload = MessageRoutes.broadcastPayload(
                centChannel: channel,
                messageID: rootMessageID,
                channelID: channelID,
                seq: rootMessageSeq,
                type: "system",
                body: nil,
                authorMemberID: sessionOwnerMemberID,
                hlcTs: hlcTs,
                hlcCount: 0,
                rootID: nil,
                props: props
            )
            let startedPayload = Self.lifecyclePayload(
                eventType: "work.session.started",
                session: workSession,
                rootMessageSeq: rootMessageSeq
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish',
                   \(messagePayload)::jsonb, \(channelID)),
                  (\(workspaceID), 'broadcast', 'publish',
                   \(startedPayload)::jsonb, \(channelID))
                """,
                logger: db.logger
            )
            return workSession
        }

        var response = try WorkSessionResponse(workSession: session)
            .response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func end(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let sessionID = try Self.sessionID(context)
        let requestDTO = try await request.decode(
            as: EndWorkSessionRequest.self,
            context: context
        )
        guard requestDTO.status == "ended" else {
            throw HTTPError(.badRequest, message: "status must be ended")
        }

        let session = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                       ws.host_id, ws.root_message_id, ws.tool, ws.label,
                       ws.status, ws.started_at, ws.ended_at, ws.exit_code,
                       root.seq
                  FROM work_session ws
                  JOIN message root ON root.id = ws.root_message_id
                 WHERE ws.id = \(sessionID)
                 FOR UPDATE OF ws
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "work session not found")
            }
            let decoded = try row.decode(
                (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
                 String, Date, Date?, Int?, Int64).self
            )
            let ownerMemberID = decoded.3
            if principal.kind == .workHost {
                guard decoded.4 == principal.tokenID else {
                    throw HTTPError(.forbidden, message: "work host cannot end another host session")
                }
            } else {
                guard ownerMemberID == principal.memberID else {
                    throw HTTPError(.forbidden, message: "only the session owner can end it")
                }
            }
            try await Self.requireChannelMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: decoded.2,
                memberID: ownerMemberID
            )

            if decoded.8 == "ended" {
                return Self.sessionDTO(from: decoded)
            }

            let updatedRows = try await conn.query(
                """
                UPDATE work_session
                   SET status = 'ended',
                       ended_at = clock_timestamp(),
                       exit_code = \(requestDTO.exitCode)
                 WHERE id = \(sessionID)
                   AND status = 'running'
                RETURNING id, workspace_id, channel_id, member_id, host_id,
                          root_message_id, tool, label, status, started_at,
                          ended_at, exit_code
                """,
                logger: db.logger
            ).collect()
            guard let updatedRow = updatedRows.first else {
                throw HTTPError(.conflict, message: "work session state changed; retry")
            }
            let workSession = try Self.decodeSession(updatedRow)
            let props = Self.cardProps(
                sessionID: sessionID,
                tool: workSession.tool,
                label: workSession.label,
                status: "ended",
                endedAtMs: workSession.endedAtMs,
                exitCode: workSession.exitCode
            )
            let propsJSON = Self.jsonString(props)
            _ = try await conn.query(
                "UPDATE message SET props = \(propsJSON)::jsonb WHERE id = \(decoded.5)",
                logger: db.logger
            )

            let endedPayload = Self.lifecyclePayload(
                eventType: "work.session.ended",
                session: workSession,
                rootMessageSeq: decoded.12
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish',
                   \(endedPayload)::jsonb, \(decoded.2))
                """,
                logger: db.logger
            )
            return workSession
        }

        return try WorkSessionResponse(workSession: session)
            .response(from: request, context: context)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let activeOnly = try Self.activeFilter(
            request.uri.queryParameters["active"].map(String.init)
        )

        let sessions: [WorkSessionDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                       ws.host_id, ws.root_message_id, ws.tool, ws.label,
                       ws.status, ws.started_at, ws.ended_at, ws.exit_code
                  FROM work_session ws
                  JOIN channel c ON c.id = ws.channel_id
                  JOIN membership ms
                    ON ms.channel_id = ws.channel_id
                   AND ms.member_id = \(principal.memberID)
                   AND ms.left_at IS NULL
                 WHERE ws.workspace_id = \(workspaceID)
                   AND c.archived_at IS NULL
                   AND (NOT \(activeOnly) OR ws.status = 'running')
                 ORDER BY ws.started_at DESC, ws.id DESC
                 LIMIT 200
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeSession)
        }

        return try WorkSessionListResponse(workSessions: sessions)
            .response(from: request, context: context)
    }

    static func validatedTool(_ raw: String) throws -> String {
        guard Tool(rawValue: raw) != nil else {
            throw HTTPError(
                .badRequest,
                message: "tool must be one of: claude, codex, opencode, shell"
            )
        }
        return raw
    }

    static func validatedLabel(_ raw: String) throws -> String {
        let label = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label.count <= 120 else {
            throw HTTPError(.badRequest, message: "label must contain 1...120 characters")
        }
        return label
    }

    static func activeFilter(_ raw: String?) throws -> Bool {
        switch raw {
        case nil, "0": false
        case "1": true
        default: throw HTTPError(.badRequest, message: "active must be 0 or 1")
        }
    }

    static func lifecyclePayload(
        eventType: String,
        session: WorkSessionDTO,
        rootMessageSeq: Int64
    ) -> String {
        let isEnded = eventType == "work.session.ended"
        let timestamp = isEnded ? session.endedAtMs : session.startedAtMs
        var payload: [String: Any] = [
            "session_id": session.id,
            "channel_id": session.channelId,
            "root_message_id": session.rootMessageId,
            "member_id": session.memberId,
            "host_id": session.hostId,
            "tool": session.tool,
            "label": session.label,
        ]
        if isEnded {
            if let endedAtMs = session.endedAtMs { payload["ended_at"] = endedAtMs }
            if let exitCode = session.exitCode { payload["exit_code"] = exitCode }
        } else {
            payload["started_at"] = session.startedAtMs
        }
        let channel = "ch:ws\(session.workspaceId).\(session.channelId)"
        let object: [String: Any] = [
            "channel": channel,
            "data": [
                "type": eventType,
                "v": 1,
                "ts": timestamp ?? session.startedAtMs,
                "seq": rootMessageSeq,
                "payload": payload,
            ],
            // Deliberately no Centrifugo version: the card's message.new owns
            // this seq and has already advanced the channel version.
            "idempotency_key": "\(channel):\(eventType):\(session.id)",
        ]
        return jsonString(object)
    }

    static func cardProps(
        sessionID: UUID,
        tool: String,
        label: String,
        status: String,
        endedAtMs: Int64? = nil,
        exitCode: Int? = nil
    ) -> [String: Any] {
        var props: [String: Any] = [
            "kind": "work_session",
            "session_id": sessionID.uuidString,
            "tool": tool,
            "label": label,
            "status": status,
        ]
        if let endedAtMs { props["ended_at"] = endedAtMs }
        if let exitCode { props["exit_code"] = exitCode }
        return props
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

    private static func sessionID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("session")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid work session id")
        }
        return id
    }

    private static func requireChannelMember(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        memberID: UUID
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM channel c
              JOIN membership ms
                ON ms.workspace_id = c.workspace_id
               AND ms.channel_id = c.id
               AND ms.member_id = \(memberID)
               AND ms.left_at IS NULL
              JOIN member m
                ON m.id = ms.member_id
               AND m.workspace_id = c.workspace_id
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             WHERE c.workspace_id = \(workspaceID)
               AND c.id = \(channelID)
               AND c.archived_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard rows.first != nil else {
            throw HTTPError(.forbidden, message: "active channel membership required")
        }
    }

    /// A signed work host may create only the session described by a dispatched
    /// spawn control targeted at that host. The session owner is derived from
    /// the requesting agent's human owner, never from host-supplied identity.
    private static func requireDispatchedSpawnControl(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        controlID: UUID,
        channelID: UUID,
        hostID: UUID,
        tool: String,
        label: String
    ) async throws -> UUID {
        let rows = try await conn.query(
            """
            SELECT a.owner_human_id
              FROM work_control wc
              JOIN member requester
                ON requester.id = wc.requester_member_id
               AND requester.workspace_id = wc.workspace_id
               AND requester.kind = 'agent'
               AND requester.status = 'active'
               AND requester.deleted_at IS NULL
              JOIN agent a
                ON a.member_id = requester.id
               AND a.workspace_id = requester.workspace_id
              JOIN member owner
                ON owner.id = a.owner_human_id
               AND owner.workspace_id = wc.workspace_id
               AND owner.kind = 'human'
               AND owner.status = 'active'
               AND owner.deleted_at IS NULL
             WHERE wc.id = \(controlID)
               AND wc.workspace_id = \(workspaceID)
               AND wc.channel_id = \(channelID)
               AND wc.target_host_id = \(hostID)
               AND wc.kind = 'spawn'
               AND wc.status = 'dispatched'
               AND wc.session_id IS NULL
               AND wc.payload->>'tool' = \(tool)
               AND wc.payload->>'label' = \(label)
             FOR SHARE OF wc
            """,
            logger: logger
        ).collect()
        guard let ownerMemberID = try rows.first?.decode(UUID.self) else {
            throw HTTPError(.conflict, message: "spawn control is not dispatchable by this host")
        }
        return ownerMemberID
    }

    private static func decodeSession(_ row: PostgresRow) throws -> WorkSessionDTO {
        let decoded = try row.decode(
            (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
             String, Date, Date?, Int?).self
        )
        return sessionDTO(from: decoded)
    }

    private static func sessionDTO(
        from row: (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
                   String, Date, Date?, Int?)
    ) -> WorkSessionDTO {
        WorkSessionDTO(
            id: row.0.uuidString,
            workspaceId: row.1.uuidString,
            channelId: row.2.uuidString,
            memberId: row.3.uuidString,
            hostId: row.4.uuidString,
            rootMessageId: row.5.uuidString,
            tool: row.6,
            label: row.7,
            status: row.8,
            startedAtMs: Int64(row.9.timeIntervalSince1970 * 1000),
            endedAtMs: row.10.map { Int64($0.timeIntervalSince1970 * 1000) },
            exitCode: row.11
        )
    }

    private static func sessionDTO(
        from row: (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
                   String, Date, Date?, Int?, Int64)
    ) -> WorkSessionDTO {
        sessionDTO(from: (
            row.0, row.1, row.2, row.3, row.4, row.5, row.6,
            row.7, row.8, row.9, row.10, row.11
        ))
    }

    private static func channelName(workspaceID: UUID, channelID: UUID) -> String {
        "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
              ),
              let json = String(data: data, encoding: .utf8)
        else { return "{}" }
        return json
    }
}
