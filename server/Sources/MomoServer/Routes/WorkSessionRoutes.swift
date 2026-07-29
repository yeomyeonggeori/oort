import AsyncHTTPClient
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
    let ptyId: String?
    let attachEndpoint: String?
}

enum WorkSessionObservation: String, Codable, Sendable, CaseIterable {
    case open
    case ownerOnly = "owner_only"
}

struct UpdateWorkSessionRequest: Decodable {
    let status: String?
    let exitCode: Int?
    let observation: WorkSessionObservation?
    let event: WorkSessionACPEvent?
}

struct WorkSessionACPEvent: Codable, Sendable, Equatable {
    let eventId: UUID
    let type: String
    let v: Int
    let ts: Int64
    let payload: JSONValue

    private enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case type, v, ts, payload
    }
}

struct ResumeWorkSessionRequest: Decodable {
    let targetHostId: UUID
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
    let observation: WorkSessionObservation
    let observerGrantCount: Int64
    let remoteAttachAvailable: Bool
    let startedAtMs: Int64
    let endedAtMs: Int64?
    let exitCode: Int?
    let endReason: String?
    let resumedFromSessionId: String?
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
/// POST  /v1/workspaces/{ws}/work-sessions/{session}/resume
/// GET   /v1/workspaces/{ws}/work-sessions?active=1
struct WorkSessionRoutes: Sendable {
    static let acpEventRateWindowSeconds = 60
    static let maximumACPEventsPerWindow = 240
    static let maximumACPEventBytes = 65_536

    struct EffectiveTierPolicy: Sendable, Equatable {
        let mode: String
        let autoTarget: String?
    }

    let db: Database
    private let acpEventLimiter: SlidingWindowRateLimiter
    private let httpClient: HTTPClient
    private let cloudProvisionerConfig: CloudProvisionerConfig

    init(
        db: Database,
        httpClient: HTTPClient,
        cloudProvisionerConfig: CloudProvisionerConfig,
        acpEventLimiter: SlidingWindowRateLimiter = SlidingWindowRateLimiter()
    ) {
        self.db = db
        self.httpClient = httpClient
        self.cloudProvisionerConfig = cloudProvisionerConfig
        self.acpEventLimiter = acpEventLimiter
    }

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/work-sessions", use: create)
        group.patch("/v1/workspaces/:ws/work-sessions/:session", use: end)
        group.post("/v1/workspaces/:ws/work-sessions/:session/resume", use: resume)
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
        let remotePTY = try RemotePTYBinding.validated(
            ptyID: requestDTO.ptyId,
            attachEndpoint: requestDTO.attachEndpoint
        )
        if principal.kind == .human, requestDTO.controlId != nil {
            throw HTTPError(.badRequest, message: "controlId is reserved for work host dispatch")
        }
        if principal.kind == .human, remotePTY != nil {
            throw HTTPError(.badRequest, message: "remote PTY binding requires work host signature")
        }
        if principal.kind == .workHost {
            guard hostID == principal.tokenID, requestDTO.controlId != nil else {
                throw HTTPError(.forbidden, message: "work host session binding is invalid")
            }
        }
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
        let targetCloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            hostID: hostID
        )

        let session = try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: targetCloudHostID
        ) { conn in
            try await revalidateT3CloudHost(
                conn: conn,
                workspaceID: workspaceID,
                hostID: hostID,
                expectedCloudHostID: targetCloudHostID
            )
            try await WorkToolProfileRoutes.requireEnabled(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                toolKey: tool
            )
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
            if remotePTY != nil {
                try await Self.requireRemotePTYCapableHost(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    hostID: hostID
                )
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
                memberID: sessionOwnerMemberID,
                targetHostID: hostID
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
                   root_message_id, tool, label, pty_id, attach_endpoint, started_at)
                VALUES
                  (\(sessionID), \(workspaceID), \(channelID), \(sessionOwnerMemberID),
                   \(hostID), \(rootMessageID), \(tool), \(label),
                   \(remotePTY?.ptyID), \(remotePTY?.attachEndpoint), \(startedAt))
                RETURNING id, workspace_id, channel_id, member_id, host_id,
                          root_message_id, tool, label, status, observation,
                          0::bigint AS observer_grant_count,
                          (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)
                            AS remote_attach_available,
                          started_at, ended_at, exit_code, end_reason,
                          resumed_from_session_id
                """,
                logger: db.logger
            ).collect()
            guard let sessionRow = sessionRows.first else {
                throw HTTPError(.internalServerError, message: "work session insert failed")
            }
            let workSession = try Self.decodeSession(sessionRow)
            try await CloudUsageLedger.start(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                sessionID: sessionID,
                hostID: hostID
            )

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
            as: UpdateWorkSessionRequest.self,
            context: context
        )
        if let event = requestDTO.event {
            guard requestDTO.status == nil, requestDTO.exitCode == nil,
                  requestDTO.observation == nil
            else {
                throw HTTPError(.badRequest, message: "event cannot be combined with lifecycle fields")
            }
            return try await recordACPEvent(
                event,
                request: request,
                context: context,
                principal: principal,
                workspaceID: workspaceID,
                sessionID: sessionID
            )
        }
        if let observation = requestDTO.observation {
            guard requestDTO.status == nil, requestDTO.exitCode == nil else {
                throw HTTPError(.badRequest, message: "observation cannot be combined with lifecycle fields")
            }
            return try await updateObservation(
                observation,
                request: request,
                context: context,
                principal: principal,
                workspaceID: workspaceID,
                sessionID: sessionID
            )
        }
        switch requestDTO.status {
        case "idle":
            guard let exitCode = requestDTO.exitCode else {
                throw HTTPError(.badRequest, message: "idle transition requires exitCode")
            }
            return try await transitionToolLifecycle(
                targetStatus: "idle",
                exitCode: exitCode,
                request: request,
                context: context,
                principal: principal,
                workspaceID: workspaceID,
                sessionID: sessionID
            )
        case "running":
            guard requestDTO.exitCode == nil else {
                throw HTTPError(.badRequest, message: "running transition does not accept exitCode")
            }
            return try await transitionToolLifecycle(
                targetStatus: "running",
                exitCode: nil,
                request: request,
                context: context,
                principal: principal,
                workspaceID: workspaceID,
                sessionID: sessionID
            )
        case "ended":
            break
        default:
            throw HTTPError(.badRequest, message: "status must be idle, running, or ended")
        }

        let cloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            sessionID: sessionID
        )
        let session = try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: cloudHostID
        ) { conn in
            try await revalidateT3CloudHost(
                conn: conn,
                workspaceID: workspaceID,
                sessionID: sessionID,
                expectedCloudHostID: cloudHostID
            )
            let rows = try await conn.query(
                """
                SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                       ws.host_id, ws.root_message_id, ws.tool, ws.label,
                       ws.status, ws.observation,
                       0::bigint AS observer_grant_count,
                       (ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL),
                       ws.started_at, ws.ended_at, ws.exit_code,
                       ws.end_reason, ws.resumed_from_session_id,
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
                 String, String, Int64, Bool, Date, Date?, Int?, String?, UUID?, Int64).self
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
                return Self.sessionDTO(
                    from: (
                        decoded.0, decoded.1, decoded.2, decoded.3, decoded.4,
                        decoded.5, decoded.6, decoded.7, decoded.8, decoded.12,
                        decoded.13, decoded.14, decoded.15, decoded.16
                    ),
                    observation: decoded.9,
                    observerGrantCount: decoded.10,
                    remoteAttachAvailable: decoded.11
                )
            }

            let updatedRows = try await conn.query(
                """
                UPDATE work_session
                   SET status = 'ended',
                       idle_at = NULL,
                       ended_at = clock_timestamp(),
                       exit_code = COALESCE(\(requestDTO.exitCode), exit_code),
                       end_reason = NULL
                 WHERE id = \(sessionID)
                   AND status IN ('running', 'idle')
                RETURNING id, workspace_id, channel_id, member_id, host_id,
                          root_message_id, tool, label, status, observation,
                          0::bigint AS observer_grant_count,
                          (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)
                            AS remote_attach_available,
                          started_at, ended_at, exit_code, end_reason,
                          resumed_from_session_id
                """,
                logger: db.logger
            ).collect()
            guard let updatedRow = updatedRows.first else {
                throw HTTPError(.conflict, message: "work session state changed; retry")
            }
            let workSession = try Self.decodeSession(updatedRow)
            try await CloudUsageLedger.settle(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                sessionID: sessionID
            )
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
                rootMessageSeq: decoded.17
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

    private func t3CloudHostID(
        workspaceID: UUID,
        sessionID: UUID
    ) async throws -> UUID? {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT ch.id
                  FROM work_session ws
                  LEFT JOIN work_cloud_host ch
                    ON ch.workspace_id = ws.workspace_id
                   AND ch.host_id = ws.host_id
                 WHERE ws.workspace_id = \(workspaceID)
                   AND ws.id = \(sessionID)
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(UUID?.self) ?? nil
        }
    }

    private func t3CloudHostID(
        workspaceID: UUID,
        hostID: UUID
    ) async throws -> UUID? {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT id
                  FROM work_cloud_host
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(UUID.self)
        }
    }

    private func revalidateT3CloudHost(
        conn: PostgresConnection,
        workspaceID: UUID,
        sessionID: UUID,
        expectedCloudHostID: UUID?
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT ch.id
              FROM work_session ws
              LEFT JOIN work_cloud_host ch
                ON ch.workspace_id = ws.workspace_id
               AND ch.host_id = ws.host_id
             WHERE ws.workspace_id = \(workspaceID)
               AND ws.id = \(sessionID)
            """,
            logger: db.logger
        ).collect()
        let currentCloudHostID = try rows.first?.decode(UUID?.self) ?? nil
        guard currentCloudHostID == expectedCloudHostID else {
            throw HTTPError(
                .conflict,
                message: "work session cloud lifecycle changed; retry"
            )
        }
    }

    private func revalidateT3CloudHost(
        conn: PostgresConnection,
        workspaceID: UUID,
        hostID: UUID,
        expectedCloudHostID: UUID?
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT id
              FROM work_cloud_host
             WHERE workspace_id = \(workspaceID)
               AND host_id = \(hostID)
            """,
            logger: db.logger
        ).collect()
        let currentCloudHostID = try rows.first?.decode(UUID.self)
        guard currentCloudHostID == expectedCloudHostID else {
            throw HTTPError(
                .conflict,
                message: "work host cloud lifecycle changed; retry"
            )
        }
    }

    private func transitionToolLifecycle(
        targetStatus: String,
        exitCode: Int?,
        request: Request,
        context: AppRequestContext,
        principal: AuthPrincipal,
        workspaceID: UUID,
        sessionID: UUID
    ) async throws -> Response {
        guard principal.kind == .workHost else {
            throw HTTPError(
                .forbidden,
                message: "tool lifecycle transitions require work host signature"
            )
        }
        let transitionAt = Date()
        let transitionAtMs = Int64(transitionAt.timeIntervalSince1970 * 1_000)
        let preflightCloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            sessionID: sessionID
        )
        let cloudLifecycle = try await performCloudLifecycleIfNeeded(
            targetStatus: targetStatus,
            principal: principal,
            workspaceID: workspaceID,
            sessionID: sessionID
        )
        let transactionCloudHostID =
            cloudLifecycle?.cloudHostID ?? preflightCloudHostID

        let session = try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: transactionCloudHostID
        ) { conn in
            try await revalidateT3CloudHost(
                conn: conn,
                workspaceID: workspaceID,
                sessionID: sessionID,
                expectedCloudHostID: transactionCloudHostID
            )
            let rows = try await conn.query(
                """
                SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                       ws.host_id, ws.root_message_id, ws.tool, ws.label,
                       ws.status, ws.observation,
                       0::bigint AS observer_grant_count,
                       (ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL),
                       ws.started_at, ws.ended_at, ws.exit_code,
                       ws.end_reason, ws.resumed_from_session_id,
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
                 String, String, Int64, Bool, Date, Date?, Int?, String?, UUID?, Int64).self
            )
            guard decoded.4 == principal.tokenID else {
                throw HTTPError(
                    .forbidden,
                    message: "work host cannot update another host session"
                )
            }
            try await Self.requireChannelMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: decoded.2,
                memberID: decoded.3
            )

            if decoded.8 == targetStatus {
                return Self.sessionDTO(
                    from: (
                        decoded.0, decoded.1, decoded.2, decoded.3, decoded.4,
                        decoded.5, decoded.6, decoded.7, decoded.8, decoded.12,
                        decoded.13, decoded.14, decoded.15, decoded.16
                    ),
                    observation: decoded.9,
                    observerGrantCount: decoded.10,
                    remoteAttachAvailable: decoded.11
                )
            }
            let expectedStatus = targetStatus == "idle" ? "running" : "idle"
            guard decoded.8 == expectedStatus else {
                throw HTTPError(
                    .conflict,
                    message: "work session cannot transition from \(decoded.8) to \(targetStatus)"
                )
            }

            let updatedRows: [PostgresRow]
            if targetStatus == "idle" {
                if cloudLifecycle != nil {
                    try await CloudUsageLedger.pause(
                        conn: conn,
                        logger: db.logger,
                        workspaceID: workspaceID,
                        hostID: decoded.4,
                        sessionID: sessionID
                    )
                    try await updateCloudHostState(
                        conn: conn,
                        workspaceID: workspaceID,
                        hostID: decoded.4,
                        expected: "pausing",
                        next: "paused"
                    )
                }
                updatedRows = try await conn.query(
                    """
                    UPDATE work_session
                       SET status = 'idle',
                           idle_at = \(transitionAt),
                           exit_code = \(exitCode),
                           ended_at = NULL,
                           end_reason = NULL
                     WHERE id = \(sessionID)
                       AND status = 'running'
                    RETURNING id, workspace_id, channel_id, member_id, host_id,
                              root_message_id, tool, label, status, observation,
                              0::bigint AS observer_grant_count,
                              (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)
                                AS remote_attach_available,
                              started_at, ended_at, exit_code, end_reason,
                              resumed_from_session_id
                    """,
                    logger: db.logger
                ).collect()
            } else {
                if cloudLifecycle != nil {
                    try await CloudUsageLedger.resume(
                        conn: conn,
                        logger: db.logger,
                        workspaceID: workspaceID,
                        hostID: decoded.4,
                        sessionID: sessionID
                    )
                    try await updateCloudHostState(
                        conn: conn,
                        workspaceID: workspaceID,
                        hostID: decoded.4,
                        expected: "paused",
                        next: "running"
                    )
                }
                updatedRows = try await conn.query(
                    """
                    UPDATE work_session
                       SET status = 'running',
                           idle_at = NULL,
                           ended_at = NULL,
                           end_reason = NULL
                     WHERE id = \(sessionID)
                       AND status = 'idle'
                    RETURNING id, workspace_id, channel_id, member_id, host_id,
                              root_message_id, tool, label, status, observation,
                              0::bigint AS observer_grant_count,
                              (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)
                                AS remote_attach_available,
                              started_at, ended_at, exit_code, end_reason,
                              resumed_from_session_id
                    """,
                    logger: db.logger
                ).collect()
            }
            guard let updatedRow = updatedRows.first else {
                throw HTTPError(.conflict, message: "work session state changed; retry")
            }
            let workSession = try Self.decodeSession(updatedRow)
            let props = Self.cardProps(
                sessionID: sessionID,
                tool: workSession.tool,
                label: workSession.label,
                status: targetStatus,
                exitCode: workSession.exitCode
            )
            _ = try await conn.query(
                "UPDATE message SET props = \(Self.jsonString(props))::jsonb WHERE id = \(decoded.5)",
                logger: db.logger
            )

            let channel = Self.channelName(workspaceID: workspaceID, channelID: decoded.2)
            let eventType: String
            let eventSeq: Int64
            let idempotencyDiscriminator: String
            var messagePayload: String?
            if targetStatus == "idle" {
                let idleMessageProps: [String: Any] = [
                    "kind": "work_session_idle",
                    "session_id": sessionID.uuidString,
                    "owner_member_id": decoded.3.uuidString,
                ]
                let messageRows = try await conn.query(
                    """
                    WITH bumped AS (
                      UPDATE channel_seq
                         SET last_seq = last_seq + 1
                       WHERE workspace_id = \(workspaceID)
                         AND channel_id = \(decoded.2)
                      RETURNING last_seq AS seq
                    )
                    INSERT INTO message
                      (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                       author_member_id, type, body, props, root_id)
                    SELECT \(workspaceID), \(decoded.2), b.seq, \(transitionAtMs), 0,
                           \(decoded.3), 'system'::message_type,
                           '작업 완료 — idle 대기',
                           \(Self.jsonString(idleMessageProps))::jsonb, \(decoded.5)
                      FROM bumped b
                    RETURNING id, seq
                    """,
                    logger: db.logger
                ).collect()
                guard let messageRow = messageRows.first else {
                    throw HTTPError(
                        .internalServerError,
                        message: "idle notification message insert failed"
                    )
                }
                let (messageID, seq) = try messageRow.decode((UUID, Int64).self)
                eventType = "work.session.idle"
                eventSeq = seq
                idempotencyDiscriminator = messageID.uuidString
                messagePayload = MessageRoutes.broadcastPayload(
                    centChannel: channel,
                    messageID: messageID,
                    channelID: decoded.2,
                    seq: seq,
                    type: "system",
                    body: "작업 완료 — idle 대기",
                    authorMemberID: decoded.3,
                    hlcTs: transitionAtMs,
                    hlcCount: 0,
                    rootID: decoded.5,
                    props: idleMessageProps
                )
            } else {
                eventType = "work.session.resumed-to-running"
                eventSeq = decoded.17
                idempotencyDiscriminator = String(transitionAtMs)
            }
            let transitionPayload = Self.toolLifecyclePayload(
                eventType: eventType,
                session: workSession,
                seq: eventSeq,
                timestampMs: transitionAtMs,
                idempotencyDiscriminator: idempotencyDiscriminator
            )
            if let messagePayload {
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(workspaceID), 'broadcast', 'publish',
                       \(messagePayload)::jsonb, \(decoded.2)),
                      (\(workspaceID), 'broadcast', 'publish',
                       \(transitionPayload)::jsonb, \(decoded.2))
                    """,
                    logger: db.logger
                )
            } else {
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(workspaceID), 'broadcast', 'publish',
                       \(transitionPayload)::jsonb, \(decoded.2))
                    """,
                    logger: db.logger
                )
            }
            var auditDetail: [String: Any] = [
                "schema": targetStatus == "idle"
                    ? "momo.work_session.idle.v1"
                    : "momo.work_session.resumed_to_running.v1",
                "session_id": sessionID.uuidString,
                "host_id": decoded.4.uuidString,
            ]
            if let exitCode { auditDetail["exit_code"] = exitCode }
            if let cloudLifecycle {
                auditDetail["cloud_provider"] = "e2b"
                auditDetail["cloud_action"] = cloudLifecycle.action
                auditDetail["cloud_provisioner_latency_ms"] = cloudLifecycle.latencyMs
            }
            // A workHost principal signs with Ed25519 and carries the HOST id in
            // `tokenID`; that id is not a `token` row, so writing it here is an
            // audit_log_via_token_id FK violation (500, caught live by
            // verify_work_session_idle). No token was used, so NULL is the true
            // statement; the acting host is already named in detail.host_id.
            let viaTokenID: UUID? = principal.kind == .workHost ? nil : principal.tokenID
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(decoded.3), \(decoded.3), \(eventType),
                   'work_session', \(sessionID), \(viaTokenID),
                   \(Self.jsonString(auditDetail))::jsonb)
                """,
                logger: db.logger
            )
            return workSession
        }

        return try WorkSessionResponse(workSession: session)
            .response(from: request, context: context)
    }

    private struct CloudLifecycleEvidence: Sendable {
        let cloudHostID: UUID
        let action: String
        let latencyMs: Int64
    }

    private struct CloudLifecycleTarget: Sendable {
        let cloudHostID: UUID
        let sandboxID: String
    }

    /// Host identity is the T3 boundary: ordinary workd/desktop hosts return
    /// before cloud config, provider calls, or usage-ledger mutations.
    private func performCloudLifecycleIfNeeded(
        targetStatus: String,
        principal: AuthPrincipal,
        workspaceID: UUID,
        sessionID: UUID
    ) async throws -> CloudLifecycleEvidence? {
        guard let target = try await cloudLifecycleTarget(
            targetStatus: targetStatus,
            principal: principal,
            workspaceID: workspaceID,
            sessionID: sessionID
        ) else { return nil }

        let readyConfig = try CloudProvisionerRoutes.readyConfig(cloudProvisionerConfig)
        let provisioner = E2BProvisioner(httpClient: httpClient, config: readyConfig)
        // A paused daemon cannot initiate its own resume. Human REST records a
        // durable resuming intent, calls the provider, then advances both the
        // session and ledger. A later signed host report is confirmation only.
        guard targetStatus == "idle" else {
            throw HTTPError(
                .conflict,
                message: "paused momo Cloud sessions must be resumed by the human cloud resume endpoint"
            )
        }
        let action = "pause"
        let startedAt = Date()
        do {
            try await provisioner.pause(sandboxID: target.sandboxID)
        } catch {
            throw CloudProvisionerRoutes.httpError(error)
        }
        return CloudLifecycleEvidence(
            cloudHostID: target.cloudHostID,
            action: action,
            latencyMs: Self.elapsedMilliseconds(since: startedAt)
        )
    }

    private func cloudLifecycleTarget(
        targetStatus: String,
        principal: AuthPrincipal,
        workspaceID: UUID,
        sessionID: UUID
    ) async throws -> CloudLifecycleTarget? {
        let expectedCloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            sessionID: sessionID
        )
        return try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: expectedCloudHostID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT ws.host_id, ws.status, h.type, ws.channel_id, ws.member_id,
                       ch.provider_sandbox_id, ch.state, ch.id
                  FROM work_session ws
                  JOIN work_host h
                    ON h.id = ws.host_id
                   AND h.workspace_id = ws.workspace_id
                  LEFT JOIN work_cloud_host ch
                    ON ch.host_id = h.id
                   AND ch.workspace_id = h.workspace_id
                 WHERE ws.workspace_id = \(workspaceID)
                   AND ws.id = \(sessionID)
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (
                hostID, sessionStatus, hostType, channelID, memberID,
                sandboxID, cloudState, cloudHostID
            ) =
                try row.decode(
                    (UUID, String, String, UUID, UUID, String?, String?, UUID?).self
                )
            guard cloudHostID == expectedCloudHostID else {
                throw HTTPError(
                    .conflict,
                    message: "work session cloud lifecycle changed; retry"
                )
            }
            guard hostID == principal.tokenID else { return nil }
            if sessionStatus == targetStatus { return nil }
            let expectedSessionStatus = targetStatus == "idle" ? "running" : "idle"
            guard sessionStatus == expectedSessionStatus else { return nil }
            guard hostType == "cloud" else { return nil }
            // T1/T2 return above without consulting T3 configuration. A cloud
            // transition fails before writing a durable provider intent when
            // the unreleased T3 surface is not explicitly enabled.
            try CloudProvisionerRoutes.requireEnabled(cloudProvisionerConfig)
            try await Self.requireChannelMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: channelID,
                memberID: memberID
            )
            guard let sandboxID, let cloudState else {
                throw HTTPError(
                    .serviceUnavailable,
                    message: "momo Cloud 샌드박스 연결 정보가 준비되지 않았습니다."
                )
            }
            if targetStatus == "running" {
                guard cloudState == "running" else {
                    throw HTTPError(
                        .conflict,
                        message: "human cloud resume intent must complete before host confirmation"
                    )
                }
                return nil
            }
            let expectedCloudState = "running"
            guard cloudState == expectedCloudState else {
                throw HTTPError(
                    .conflict,
                    message: "momo Cloud 호스트 상태가 세션 상태와 일치하지 않습니다."
                )
            }
            let operationID = UUID()
            let intentRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = 'pausing',
                       lifecycle_operation_id = \(operationID),
                       lifecycle_operation_kind = 'pause',
                       lifecycle_operation_started_at = clock_timestamp(),
                       lifecycle_operation_version = lifecycle_operation_version + 1,
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND state = 'running'
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard intentRows.first != nil else {
                throw HTTPError(.conflict, message: "momo Cloud host lifecycle changed; retry")
            }
            guard let cloudHostID else {
                throw HTTPError(
                    .conflict,
                    message: "momo Cloud host lifecycle changed; retry"
                )
            }
            return CloudLifecycleTarget(
                cloudHostID: cloudHostID,
                sandboxID: sandboxID
            )
        }
    }

    private func updateCloudHostState(
        conn: PostgresConnection,
        workspaceID: UUID,
        hostID: UUID,
        expected: String,
        next: String
    ) async throws {
        let rows = try await conn.query(
            """
            UPDATE work_cloud_host
               SET state = \(next), updated_at = clock_timestamp()
             WHERE workspace_id = \(workspaceID)
               AND host_id = \(hostID)
               AND state = \(expected)
            RETURNING id
            """,
            logger: db.logger
        ).collect()
        guard rows.first != nil else {
            throw HTTPError(.conflict, message: "momo Cloud 호스트 상태가 변경되었습니다.")
        }
    }

    /// A provider-confirmed missing sandbox is terminal. Close the paid usage
    /// interval, revoke the dead host, and make it immediately eligible for the
    /// existing offline sweep, which owns orphaned events/cards/auto fallback.
    private func recordMissingCloudSandbox(
        workspaceID: UUID,
        sessionID: UUID,
        hostID: UUID,
        latencyMs: Int64,
        error: Error
    ) async throws {
        guard let cloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            hostID: hostID
        ) else {
            throw HTTPError(
                .conflict,
                message: "momo Cloud host lifecycle changed; retry"
            )
        }
        try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: cloudHostID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT member_id
                  FROM work_session
                 WHERE workspace_id = \(workspaceID)
                   AND id = \(sessionID)
                   AND host_id = \(hostID)
                   AND status = 'idle'
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let memberID = try rows.first?.decode(UUID.self) else {
                throw HTTPError(.conflict, message: "work session state changed; retry")
            }
            try await CloudUsageLedger.settle(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                sessionID: sessionID
            )
            let cloudRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = 'destroyed', updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND state IN ('paused', 'ready')
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard cloudRows.first != nil else {
                throw HTTPError(.conflict, message: "momo Cloud 호스트 상태가 변경되었습니다.")
            }
            _ = try await conn.query(
                """
                UPDATE work_host
                   SET revoked_at = COALESCE(revoked_at, clock_timestamp()),
                       last_seen_at = clock_timestamp() - interval '100 years'
                 WHERE workspace_id = \(workspaceID)
                   AND id = \(hostID)
                """,
                logger: db.logger
            )
            let upstreamStatus: Int?
            if case CloudProvisionerError.upstreamStatus(let status) = error {
                upstreamStatus = status
            } else {
                upstreamStatus = nil
            }
            let detail: [String: Any] = [
                "schema": "momo.work_cloud.resume_failed.v1",
                "host_id": hostID.uuidString,
                "session_id": sessionID.uuidString,
                "provider": "e2b",
                "reason": "sandbox_missing",
                "upstream_status": upstreamStatus ?? NSNull(),
                "provisioner_latency_ms": latencyMs,
                "orphan_transition": "host_offline_sweep",
            ]
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(memberID), \(memberID),
                   'work.cloud.resume_failed', 'work_host', \(hostID), NULL,
                   \(Self.jsonString(detail))::jsonb)
                """,
                logger: db.logger
            )
        }
    }

    private static func isMissingSandbox(_ error: Error) -> Bool {
        guard case CloudProvisionerError.upstreamStatus(let status) = error else {
            return false
        }
        return status == 404 || status == 410
    }

    private static func elapsedMilliseconds(since startedAt: Date) -> Int64 {
        max(0, Int64(Date().timeIntervalSince(startedAt) * 1_000))
    }

    private func recordACPEvent(
        _ event: WorkSessionACPEvent,
        request: Request,
        context: AppRequestContext,
        principal: AuthPrincipal,
        workspaceID: UUID,
        sessionID: UUID
    ) async throws -> Response {
        guard principal.kind == .workHost else {
            throw HTTPError(.forbidden, message: "ACP events require work host signature")
        }
        let eventData = try JSONEncoder().encode(event)
        guard eventData.count <= Self.maximumACPEventBytes else {
            throw HTTPError(.badRequest, message: "ACP event exceeds 65536 bytes")
        }
        let normalized = try Self.validatedACPEvent(event, sessionID: sessionID)
        let verdict = await acpEventLimiter.check(
            key: "work-acp:\(workspaceID.uuidString):\(sessionID.uuidString)",
            limit: Self.maximumACPEventsPerWindow,
            windowSeconds: Self.acpEventRateWindowSeconds
        )
        guard verdict.allowed else {
            throw HTTPError(.tooManyRequests, message: "ACP event rate limit exceeded")
        }

        let session = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                       ws.host_id, ws.root_message_id, ws.tool, ws.label,
                       ws.status, ws.observation,
                       0::bigint AS observer_grant_count,
                       (ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL),
                       ws.started_at, ws.ended_at, ws.exit_code,
                       ws.end_reason, ws.resumed_from_session_id,
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
                 String, String, Int64, Bool, Date, Date?, Int?, String?, UUID?, Int64).self
            )
            guard decoded.4 == principal.tokenID else {
                throw HTTPError(.forbidden, message: "work host cannot relay another host session")
            }
            guard decoded.8 == "running" else {
                throw HTTPError(.conflict, message: "work session is not running")
            }
            guard normalized.channelID == decoded.2 else {
                throw HTTPError(.badRequest, message: "ACP event channel does not match session")
            }
            try await Self.requireChannelMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: decoded.2,
                memberID: decoded.3
            )

            let duplicate = try await conn.query(
                """
                SELECT 1
                  FROM message
                 WHERE channel_id = \(decoded.2)
                   AND author_member_id = \(decoded.3)
                   AND client_msg_id = \(event.eventId)
                 LIMIT 1
                """,
                logger: db.logger
            ).collect().first != nil
            if !duplicate {
                let hlcTs = Int64(Date().timeIntervalSince1970 * 1_000)
                let propsJSON = Self.jsonString(normalized.props)
                let messageRows = try await conn.query(
                    """
                    WITH bumped AS (
                      UPDATE channel_seq
                         SET last_seq = last_seq + 1
                       WHERE workspace_id = \(workspaceID)
                         AND channel_id = \(decoded.2)
                      RETURNING last_seq AS seq
                    )
                    INSERT INTO message
                      (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                       author_member_id, type, body, props, root_id, client_msg_id)
                    SELECT \(workspaceID), \(decoded.2), b.seq, \(hlcTs), 0,
                           \(decoded.3), 'system'::message_type, \(normalized.body),
                           \(propsJSON)::jsonb, \(decoded.5), \(event.eventId)
                      FROM bumped b
                    RETURNING id, seq
                    """,
                    logger: db.logger
                ).collect()
                guard let messageRow = messageRows.first else {
                    throw HTTPError(.notFound, message: "channel not found or not provisioned")
                }
                let (messageID, seq) = try messageRow.decode((UUID, Int64).self)
                let channel = Self.channelName(workspaceID: workspaceID, channelID: decoded.2)
                let messagePayload = MessageRoutes.broadcastPayload(
                    centChannel: channel,
                    messageID: messageID,
                    channelID: decoded.2,
                    seq: seq,
                    type: "system",
                    body: normalized.body,
                    authorMemberID: decoded.3,
                    hlcTs: hlcTs,
                    hlcCount: 0,
                    rootID: decoded.5,
                    props: normalized.props
                )
                let eventPayload = Self.acpEventPayload(
                    channel: channel,
                    event: event,
                    safePayload: normalized.safePayload,
                    messageID: messageID,
                    rootMessageID: decoded.5,
                    seq: seq
                )
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(workspaceID), 'broadcast', 'publish',
                       \(messagePayload)::jsonb, \(decoded.2)),
                      (\(workspaceID), 'broadcast', 'publish',
                       \(eventPayload)::jsonb, \(decoded.2))
                    """,
                    logger: db.logger
                )
            }
            return Self.sessionDTO(
                from: (
                    decoded.0, decoded.1, decoded.2, decoded.3, decoded.4,
                    decoded.5, decoded.6, decoded.7, decoded.8, decoded.12,
                    decoded.13, decoded.14, decoded.15, decoded.16
                ),
                observation: decoded.9,
                observerGrantCount: decoded.10,
                remoteAttachAvailable: decoded.11
            )
        }
        return try WorkSessionResponse(workSession: session)
            .response(from: request, context: context)
    }

    private func updateObservation(
        _ observation: WorkSessionObservation,
        request: Request,
        context: AppRequestContext,
        principal: AuthPrincipal,
        workspaceID: UUID,
        sessionID: UUID
    ) async throws -> Response {
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "observation requires a human bearer")
        }
        let session = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn,
                logger: db.logger,
                principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT member_id, channel_id
                  FROM work_session
                 WHERE id = \(sessionID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "work session not found")
            }
            let (ownerMemberID, channelID) = try row.decode((UUID, UUID).self)
            guard ownerMemberID == principal.memberID else {
                throw HTTPError(.forbidden, message: "only the session owner can change observation")
            }
            try await Self.requireChannelMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: channelID,
                memberID: principal.memberID
            )
            _ = try await conn.query(
                "UPDATE work_session SET observation = \(observation.rawValue) WHERE id = \(sessionID)",
                logger: db.logger
            )
            if observation == .ownerOnly {
                _ = try await conn.query(
                    "DELETE FROM terminal_attach_capability WHERE work_session_id = \(sessionID) AND mode = 'observer'",
                    logger: db.logger
                )
            }
            let updatedRows = try await conn.query(
                """
                SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                       ws.host_id, ws.root_message_id, ws.tool, ws.label,
                       ws.status, ws.observation,
                       CASE
                         WHEN ws.status IN ('running', 'idle')
                          AND ws.observation = 'open'
                          AND h.revoked_at IS NULL
                         THEN (
                           SELECT count(*)
                             FROM terminal_attach_capability tac
                             JOIN member observer
                               ON observer.id = tac.owner_member_id
                              AND observer.workspace_id = tac.workspace_id
                              AND observer.kind = 'human'
                              AND observer.status = 'active'
                              AND observer.deleted_at IS NULL
                             JOIN membership observer_membership
                               ON observer_membership.workspace_id = tac.workspace_id
                              AND observer_membership.channel_id = ws.channel_id
                              AND observer_membership.member_id = tac.owner_member_id
                              AND observer_membership.left_at IS NULL
                            WHERE tac.work_session_id = ws.id
                              AND tac.mode = 'observer'
                              AND tac.expires_at > clock_timestamp()
                         )
                         ELSE 0
                       END,
                       (ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL),
                       ws.started_at, ws.ended_at, ws.exit_code,
                       ws.end_reason, ws.resumed_from_session_id
                  FROM work_session ws
                  JOIN work_host h
                    ON h.id = ws.host_id
                   AND h.workspace_id = ws.workspace_id
                 WHERE ws.id = \(sessionID)
                """,
                logger: db.logger
            ).collect()
            guard let updatedRow = updatedRows.first else {
                throw HTTPError(.internalServerError, message: "work session observation update failed")
            }
            return try Self.decodeSession(updatedRow)
        }
        return try WorkSessionResponse(workSession: session)
            .response(from: request, context: context)
    }

    @Sendable
    func resume(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "work session resume requires a human bearer")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let sourceSessionID = try Self.sessionID(context)
        let body = try await request.decode(as: ResumeWorkSessionRequest.self, context: context)
        let sourceCloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            sessionID: sourceSessionID
        )
        let targetCloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            hostID: body.targetHostId
        )
        let lifecycleHostIDs = [sourceCloudHostID, targetCloudHostID].compactMap { $0 }

        let resumed = try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostIDs: lifecycleHostIDs
        ) { conn in
            try await revalidateT3CloudHost(
                conn: conn,
                workspaceID: workspaceID,
                sessionID: sourceSessionID,
                expectedCloudHostID: sourceCloudHostID
            )
            try await revalidateT3CloudHost(
                conn: conn,
                workspaceID: workspaceID,
                hostID: body.targetHostId,
                expectedCloudHostID: targetCloudHostID
            )
            let rows = try await conn.query(
                """
                SELECT ws.id, ws.workspace_id, ws.channel_id, ws.member_id,
                       ws.host_id, ws.root_message_id, ws.tool, ws.label,
                       ws.status, ws.observation,
                       ws.started_at, ws.ended_at, ws.exit_code,
                       ws.end_reason, ws.resumed_from_session_id, root.seq
                  FROM work_session ws
                  JOIN message root ON root.id = ws.root_message_id
                 WHERE ws.id = \(sourceSessionID)
                 FOR UPDATE OF ws
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "work session not found")
            }
            let source = try row.decode(
                (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
                 String, String, Date, Date?, Int?, String?, UUID?, Int64).self
            )
            try await WorkToolProfileRoutes.requireEnabled(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                toolKey: source.6
            )
            guard source.3 == principal.memberID else {
                throw HTTPError(.forbidden, message: "only the session owner can resume it")
            }
            guard source.8 == "orphaned" else {
                throw HTTPError(.conflict, message: "only an orphaned work session can resume")
            }
            try await Self.requireChannelMember(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: source.2,
                memberID: principal.memberID
            )

            let policy = try await Self.effectiveTierPolicy(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard policy.mode != "t1_only" else {
                throw HTTPError(.conflict, message: "tier policy does not allow resume")
            }
            try await Self.requireResumeTarget(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID,
                hostID: body.targetHostId,
                policy: policy
            )
            try await WorkPoolRoutes.acquireSlot(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID,
                targetHostID: body.targetHostId
            )

            let idRows = try await conn.query("SELECT uuidv7()", logger: db.logger).collect()
            guard let resumedSessionID = try idRows.first?.decode(UUID.self) else {
                throw HTTPError(.internalServerError, message: "resumed session id allocation failed")
            }
            let newRows = try await conn.query(
                """
                INSERT INTO work_session
                  (id, workspace_id, channel_id, member_id, host_id,
                   root_message_id, tool, label, status, observation,
                   resumed_from_session_id)
                VALUES
                  (\(resumedSessionID), \(workspaceID), \(source.2), \(principal.memberID),
                   \(body.targetHostId), \(source.5), \(source.6), \(source.7),
                   'running', \(source.9), \(sourceSessionID))
                RETURNING id, workspace_id, channel_id, member_id, host_id,
                          root_message_id, tool, label, status, observation,
                          0::bigint AS observer_grant_count,
                          (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)
                            AS remote_attach_available,
                          started_at, ended_at, exit_code, end_reason,
                          resumed_from_session_id
                """,
                logger: db.logger
            ).collect()
            guard let newRow = newRows.first else {
                throw HTTPError(.internalServerError, message: "resumed work session insert failed")
            }
            let newSession = try Self.decodeSession(newRow)
            try await CloudUsageLedger.start(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                sessionID: resumedSessionID,
                hostID: body.targetHostId
            )

            let endedRows = try await conn.query(
                """
                UPDATE work_session
                   SET status = 'ended',
                       ended_at = clock_timestamp(),
                       exit_code = NULL,
                       end_reason = 'resumed'
                 WHERE id = \(sourceSessionID)
                   AND status = 'orphaned'
                RETURNING id, workspace_id, channel_id, member_id, host_id,
                          root_message_id, tool, label, status, observation,
                          0::bigint AS observer_grant_count,
                          (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)
                            AS remote_attach_available,
                          started_at, ended_at, exit_code, end_reason,
                          resumed_from_session_id
                """,
                logger: db.logger
            ).collect()
            guard let endedRow = endedRows.first else {
                throw HTTPError(.conflict, message: "work session state changed; retry")
            }
            let endedSource = try Self.decodeSession(endedRow)

            let controlRows = try await conn.query(
                """
                INSERT INTO work_control
                  (workspace_id, channel_id, requester_member_id, target_host_id,
                   session_id, kind, payload, status)
                VALUES
                  (\(workspaceID), \(source.2), \(principal.memberID), \(body.targetHostId),
                   \(resumedSessionID), 'spawn',
                   jsonb_build_object('tool', \(source.6), 'label', \(source.7)),
                   'dispatched')
                RETURNING id, workspace_id, channel_id, requester_member_id,
                          target_host_id, session_id, kind, payload::text, status,
                          approval_message_id, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let controlRow = controlRows.first else {
                throw HTTPError(.internalServerError, message: "resume dispatch insert failed")
            }
            let control = try WorkControlRoutes.decodeControl(controlRow)

            let props = Self.cardProps(
                sessionID: resumedSessionID,
                tool: newSession.tool,
                label: newSession.label,
                status: "running",
                resumedFromSessionID: sourceSessionID
            )
            _ = try await conn.query(
                "UPDATE message SET props = \(Self.jsonString(props))::jsonb WHERE id = \(source.5)",
                logger: db.logger
            )

            let endedPayload = Self.lifecyclePayload(
                eventType: "work.session.ended",
                session: endedSource,
                rootMessageSeq: source.15
            )
            let startedPayload = Self.lifecyclePayload(
                eventType: "work.session.started",
                session: newSession,
                rootMessageSeq: source.15
            )
            let dispatchPayload = WorkControlRoutes.dispatchPayload(
                workspaceID: workspaceID, control: control
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish', \(endedPayload)::jsonb, \(source.2)),
                  (\(workspaceID), 'broadcast', 'publish', \(startedPayload)::jsonb, \(source.2)),
                  (\(workspaceID), 'broadcast', 'publish', \(dispatchPayload)::jsonb, \(source.2))
                """,
                logger: db.logger
            )
            let auditDetail: [String: Any] = [
                "schema": "momo.work_session.resumed.v1",
                "source_session_id": sourceSessionID.uuidString,
                "resumed_session_id": resumedSessionID.uuidString,
                "target_host_id": body.targetHostId.uuidString,
                "automatic": false,
            ]
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(principal.memberID),
                   'work.session.resumed', 'work_session', \(resumedSessionID),
                   \(principal.tokenID), \(Self.jsonString(auditDetail))::jsonb)
                """,
                logger: db.logger
            )
            return newSession
        }

        var response = try WorkSessionResponse(workSession: resumed)
            .response(from: request, context: context)
        response.status = .created
        return response
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
                       ws.status, ws.observation,
                       CASE
                         WHEN ws.status IN ('running', 'idle')
                          AND ws.observation = 'open'
                          AND h.revoked_at IS NULL
                         THEN (
                           SELECT count(*)
                             FROM terminal_attach_capability tac
                             JOIN member observer
                               ON observer.id = tac.owner_member_id
                              AND observer.workspace_id = tac.workspace_id
                              AND observer.kind = 'human'
                              AND observer.status = 'active'
                              AND observer.deleted_at IS NULL
                             JOIN membership observer_membership
                               ON observer_membership.workspace_id = tac.workspace_id
                              AND observer_membership.channel_id = ws.channel_id
                              AND observer_membership.member_id = tac.owner_member_id
                              AND observer_membership.left_at IS NULL
                            WHERE tac.work_session_id = ws.id
                              AND tac.mode = 'observer'
                              AND tac.expires_at > clock_timestamp()
                         )
                         ELSE 0
                       END AS observer_grant_count,
                       (ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL)
                         AS remote_attach_available,
                       ws.started_at, ws.ended_at, ws.exit_code,
                       ws.end_reason, ws.resumed_from_session_id
                  FROM work_session ws
                  JOIN channel c ON c.id = ws.channel_id
                  JOIN work_host h
                    ON h.id = ws.host_id
                   AND h.workspace_id = ws.workspace_id
                  JOIN membership ms
                    ON ms.channel_id = ws.channel_id
                   AND ms.member_id = \(principal.memberID)
                   AND ms.left_at IS NULL
                 WHERE ws.workspace_id = \(workspaceID)
                   AND c.archived_at IS NULL
                   AND (NOT \(activeOnly) OR ws.status IN ('running', 'idle'))
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
        try WorkToolProfileRoutes.validatedToolKey(raw)
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
            if let endReason = session.endReason { payload["end_reason"] = endReason }
        } else {
            payload["started_at"] = session.startedAtMs
        }
        if let resumedFromSessionId = session.resumedFromSessionId {
            payload["resumed_from_session_id"] = resumedFromSessionId
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

    static func toolLifecyclePayload(
        eventType: String,
        session: WorkSessionDTO,
        seq: Int64,
        timestampMs: Int64,
        idempotencyDiscriminator: String
    ) -> String {
        var payload: [String: Any] = [
            "session_id": session.id,
            "channel_id": session.channelId,
            "root_message_id": session.rootMessageId,
            "member_id": session.memberId,
            "host_id": session.hostId,
            "status": session.status,
        ]
        if let exitCode = session.exitCode {
            payload["exit_code"] = exitCode
        }
        if eventType == "work.session.idle" {
            payload["idle_at"] = timestampMs
        } else {
            payload["resumed_at"] = timestampMs
        }
        let channel = "ch:ws\(session.workspaceId).\(session.channelId)"
        return jsonString([
            "channel": channel,
            "data": [
                "type": eventType,
                "v": 1,
                "ts": timestampMs,
                "seq": seq,
                "payload": payload,
            ],
            "idempotency_key":
                "\(channel):\(eventType):\(session.id):\(idempotencyDiscriminator)",
        ])
    }

    struct ValidatedACPEvent: @unchecked Sendable {
        let channelID: UUID
        let body: String
        let safePayload: [String: Any]
        let props: [String: Any]
    }

    static func validatedACPEvent(
        _ event: WorkSessionACPEvent,
        sessionID: UUID
    ) throws -> ValidatedACPEvent {
        guard event.v == 1, event.ts >= 0,
              let payload = event.payload.objectValue,
              !containsForbiddenACPKey(event.payload)
        else { throw HTTPError(.badRequest, message: "invalid ACP event envelope") }
        guard payload["run_id"]?.stringValue?.lowercased() == sessionID.uuidString.lowercased(),
              payload["work_session_id"]?.stringValue?.lowercased() == sessionID.uuidString.lowercased(),
              let channelRaw = payload["channel_id"]?.stringValue,
              let channelID = UUID(uuidString: channelRaw)
        else { throw HTTPError(.badRequest, message: "ACP event session binding is invalid") }

        let base = Set(["run_id", "work_session_id", "channel_id", "agent_member_id"])
        let allowed: Set<String>
        let body: String
        switch event.type {
        case "agent.partial":
            allowed = base.union(["text_delta"])
            guard let text = payload["text_delta"]?.stringValue,
                  !text.isEmpty, text.utf8.count <= 4_096
            else { throw HTTPError(.badRequest, message: "invalid ACP progress text") }
            body = text
        case "agent.status":
            allowed = base.union([
                "phase", "run_status", "detail", "tool_call_name", "has_plan",
                "plan", "terminal_event", "exit_code",
            ])
            guard let phase = payload["phase"]?.stringValue,
                  ["thinking", "streaming"].contains(phase),
                  payload["run_status"]?.stringValue == "running"
            else { throw HTTPError(.badRequest, message: "invalid ACP status projection") }
            if let detail = payload["detail"]?.stringValue, detail.utf8.count > 4_096 {
                throw HTTPError(.badRequest, message: "ACP status detail is too large")
            }
            if let terminal = payload["terminal_event"]?.stringValue,
               terminal != "created" && terminal != "ended" {
                throw HTTPError(.badRequest, message: "invalid ACP terminal event")
            }
            body = payload["detail"]?.stringValue ?? "ACP session update"
        case "approval.requested":
            allowed = base.union(["action", "action_type", "status", "options"])
            guard payload["action"]?.stringValue == "requested",
                  payload["action_type"]?.stringValue == "tool_call",
                  payload["status"]?.stringValue == "pending",
                  let options = payload["options"]?.arrayValue,
                  !options.isEmpty, options.count <= 16
            else { throw HTTPError(.badRequest, message: "invalid ACP approval request") }
            for option in options {
                guard let item = option.objectValue,
                      Set(item.keys).isSubset(of: ["option_id", "name", "kind"]),
                      let optionID = item["option_id"]?.stringValue,
                      !optionID.isEmpty, optionID.utf8.count <= 128,
                      let name = item["name"]?.stringValue,
                      !name.isEmpty, name.utf8.count <= 256
                else { throw HTTPError(.badRequest, message: "invalid ACP approval option") }
            }
            body = "Approval requested"
        case "approval.decided":
            allowed = base.union(["action", "status", "option_id"])
            guard payload["action"]?.stringValue == "decided",
                  let status = payload["status"]?.stringValue,
                  status == "approved" || status == "rejected"
            else { throw HTTPError(.badRequest, message: "invalid ACP approval decision") }
            body = status == "approved" ? "Approval granted" : "Approval rejected"
        default:
            throw HTTPError(.badRequest, message: "unsupported ACP event type")
        }
        guard Set(payload.keys).isSubset(of: allowed) else {
            throw HTTPError(.badRequest, message: "ACP event contains non-summary fields")
        }
        let safePayload = payload.mapValues(jsonValue)
        let props: [String: Any] = [
            "kind": "work_session_event",
            "schema": "momo.work_session.acp_event.v1",
            "source": "acp",
            "event_id": event.eventId.uuidString,
            "event_type": event.type,
            "event_ts": event.ts,
            "event": safePayload,
        ]
        return ValidatedACPEvent(
            channelID: channelID,
            body: body,
            safePayload: safePayload,
            props: props
        )
    }

    static func acpEventPayload(
        channel: String,
        event: WorkSessionACPEvent,
        safePayload: [String: Any],
        messageID: UUID,
        rootMessageID: UUID,
        seq: Int64
    ) -> String {
        var payload = safePayload
        payload["event_id"] = event.eventId.uuidString
        payload["message_id"] = messageID.uuidString
        payload["root_message_id"] = rootMessageID.uuidString
        return jsonString([
            "channel": channel,
            "data": [
                "type": event.type,
                "v": 1,
                "ts": event.ts,
                "seq": seq,
                "payload": payload,
            ],
            // message.new owns the Centrifugo version for this durable seq.
            "idempotency_key": "\(channel):acp:\(event.eventId.uuidString)",
        ])
    }

    private static func containsForbiddenACPKey(_ value: JSONValue) -> Bool {
        switch value {
        case .object(let object):
            let forbidden = ["_meta", "credential", "token", "secret", "environment",
                             "env", "command", "output", "cwd", "path", "raw"]
            return object.contains { key, child in
                let lowered = key.lowercased()
                return forbidden.contains(where: lowered.contains)
                    || containsForbiddenACPKey(child)
            }
        case .array(let array): return array.contains(where: containsForbiddenACPKey)
        case .string, .int, .double, .bool, .null: return false
        }
    }

    private static func jsonValue(_ value: JSONValue) -> Any {
        switch value {
        case .object(let object): return object.mapValues(jsonValue)
        case .array(let array): return array.map(jsonValue)
        case .string(let string): return string
        case .int(let int): return int
        case .double(let double): return double
        case .bool(let bool): return bool
        case .null: return NSNull()
        }
    }

    static func cardProps(
        sessionID: UUID,
        tool: String,
        label: String,
        status: String,
        endedAtMs: Int64? = nil,
        exitCode: Int? = nil,
        endReason: String? = nil,
        resumedFromSessionID: UUID? = nil
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
        if let endReason { props["end_reason"] = endReason }
        if let resumedFromSessionID {
            props["resumed_from_session_id"] = resumedFromSessionID.uuidString
        }
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

    private func withTenantLifecycleTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        cloudHostID: UUID?,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostIDs: cloudHostID.map { [$0] } ?? [],
            body
        )
    }

    private func withTenantLifecycleTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        cloudHostIDs: [UUID],
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            if !cloudHostIDs.isEmpty {
                return try await db.withTenantT3LifecycleTransaction(
                    workspaceID: workspaceID,
                    cloudHostIDs: cloudHostIDs,
                    body
                )
            }
            return try await db.withTenantTransaction(
                workspaceID: workspaceID,
                body
            )
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

    static func requireChannelMember(
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

    private static func requireRemotePTYCapableHost(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        hostID: UUID
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT revoked_at IS NULL AS active,
                   COALESCE((capabilities->>'terminal_attach')::boolean, false) AS supported
              FROM work_host
             WHERE id = \(hostID)
               AND workspace_id = \(workspaceID)
             FOR SHARE
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.forbidden, message: "work host not found")
        }
        let (active, supported) = try row.decode((Bool, Bool).self)
        guard active, supported else {
            throw HTTPError(.forbidden, message: "work host does not support terminal attach")
        }
    }

    static func effectiveTierPolicy(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID
    ) async throws -> EffectiveTierPolicy {
        let rows = try await conn.query(
            """
            SELECT mode, auto_target
              FROM work_tier_policy
             WHERE workspace_id = \(workspaceID)
               AND (member_id = \(memberID) OR member_id IS NULL)
             ORDER BY CASE WHEN member_id = \(memberID) THEN 0 ELSE 1 END
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            return EffectiveTierPolicy(mode: "ask", autoTarget: nil)
        }
        let (mode, autoTarget) = try row.decode((String, String?).self)
        return EffectiveTierPolicy(mode: mode, autoTarget: autoTarget)
    }

    private static func requireResumeTarget(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memberID: UUID,
        hostID: UUID,
        policy: EffectiveTierPolicy
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT scope, owner_member_id, type
              FROM work_host
             WHERE id = \(hostID)
               AND workspace_id = \(workspaceID)
               AND revoked_at IS NULL
             FOR SHARE
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "target work host is unavailable or revoked")
        }
        let (scope, ownerMemberID, type) = try row.decode((String, UUID, String).self)
        guard scope == "workspace" || ownerMemberID == memberID else {
            throw HTTPError(.conflict, message: "target work host belongs to another member")
        }
        if policy.mode == "auto", let autoTarget = policy.autoTarget {
            if autoTarget == "cloud" {
                guard type == "cloud" else {
                    throw HTTPError(.conflict, message: "auto policy requires a cloud work host")
                }
            } else {
                guard UUID(uuidString: autoTarget) == hostID else {
                    throw HTTPError(.conflict, message: "target work host is outside auto policy")
                }
            }
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
             String, String, Int64, Bool, Date, Date?, Int?, String?, UUID?).self
        )
        return sessionDTO(
            from: (
                decoded.0, decoded.1, decoded.2, decoded.3, decoded.4,
                decoded.5, decoded.6, decoded.7, decoded.8, decoded.12,
                decoded.13, decoded.14, decoded.15, decoded.16
            ),
            observation: decoded.9,
            observerGrantCount: decoded.10,
            remoteAttachAvailable: decoded.11
        )
    }

    private static func sessionDTO(
        from row: (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
                   String, Date, Date?, Int?, String?, UUID?),
        observation: String = WorkSessionObservation.open.rawValue,
        observerGrantCount: Int64 = 0,
        remoteAttachAvailable: Bool = false
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
            observation: WorkSessionObservation(rawValue: observation) ?? .open,
            observerGrantCount: observerGrantCount,
            remoteAttachAvailable: remoteAttachAvailable,
            startedAtMs: Int64(row.9.timeIntervalSince1970 * 1000),
            endedAtMs: row.10.map { Int64($0.timeIntervalSince1970 * 1000) },
            exitCode: row.11,
            endReason: row.12,
            resumedFromSessionId: row.13?.uuidString
        )
    }

    private static func sessionDTO(
        from row: (UUID, UUID, UUID, UUID, UUID, UUID, String, String,
                   String, Date, Date?, Int?, String?, UUID?, Int64)
    ) -> WorkSessionDTO {
        sessionDTO(from: (
            row.0, row.1, row.2, row.3, row.4, row.5, row.6,
            row.7, row.8, row.9, row.10, row.11, row.12, row.13
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
