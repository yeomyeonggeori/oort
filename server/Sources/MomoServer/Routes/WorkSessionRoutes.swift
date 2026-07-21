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
    private enum Tool: String, CaseIterable {
        case claude, codex, opencode, shell
    }

    struct EffectiveTierPolicy: Sendable, Equatable {
        let mode: String
        let autoTarget: String?
    }

    let db: Database

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
                       ended_at = clock_timestamp(),
                       exit_code = \(requestDTO.exitCode),
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
                         WHEN ws.status = 'running'
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

        let resumed = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
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
                memberID: principal.memberID
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
                         WHEN ws.status = 'running'
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
