import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct CreateWorkControlRequest: Decodable {
    let channelId: UUID
    let runId: UUID
    let targetHostId: UUID
    let sessionId: UUID?
    let kind: String
    let payload: JSONValue
}

struct WorkControlAckRequest: Decodable {
    let ok: Bool
    let sessionId: UUID?
    let errorLabel: String?
}

struct WorkControlDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let channelId: String
    let requesterMemberId: String
    let targetHostId: String
    let sessionId: String?
    let kind: String
    let payload: JSONValue
    let status: String
    let approvalMessageId: String?
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct WorkControlResponse: ResponseEncodable {
    let workControl: WorkControlDTO
}

struct WorkAutoApproveResponse: ResponseEncodable {
    let tool: String
    let enabled: Bool
}

struct WorkAutoApprovalsResponse: ResponseEncodable {
    let tools: [String]
}

/// ADR-0114 D4/D5 control ledger. The server validates, records, approves, and
/// delivers controls; host-local processes and credentials never cross this API.
///
/// POST   /v1/workspaces/{ws}/work-controls                 (agent only)
/// POST   /v1/workspaces/{ws}/work-controls/{control}/ack   (v0 host app)
/// GET    /v1/workspaces/{ws}/work-auto-approvals           (human owner)
/// PUT    /v1/workspaces/{ws}/work-auto-approvals/{tool}    (human owner)
/// DELETE /v1/workspaces/{ws}/work-auto-approvals/{tool}    (human owner)
struct WorkControlRoutes: Sendable {
    enum Kind: String, CaseIterable {
        case spawn, input, read, kill
    }

    struct ValidatedPayload: Sendable, Equatable {
        let value: JSONValue
        let json: String
        let object: [String: AnySendable]
    }

    /// A Sendable wrapper used only to move validated JSON scalars through pure
    /// helpers. SQL/outbox serialization unwraps it before crossing the DB API.
    enum AnySendable: Sendable, Equatable {
        case string(String)
        case int(Int)
    }

    private struct RunBinding: Sendable {
        let ownerHumanID: UUID
    }

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/work-controls", use: create)
        group.post("/v1/workspaces/:ws/work-controls/:control/ack", use: acknowledge)
        group.get("/v1/workspaces/:ws/work-auto-approvals", use: listAutoApprovals)
        group.put("/v1/workspaces/:ws/work-auto-approvals/:tool", use: enableAutoApprove)
        group.delete("/v1/workspaces/:ws/work-auto-approvals/:tool", use: disableAutoApprove)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .agent else {
            throw HTTPError(.forbidden, message: "work controls require an agent bearer")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let requestDTO = try await request.decode(
            as: CreateWorkControlRequest.self,
            context: context
        )
        let control = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await Self.createControl(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                principal: principal,
                request: requestDTO
            )
        }

        var response = try WorkControlResponse(workControl: control)
            .response(from: request, context: context)
        response.status = .created
        return response
    }

    /// Canonical work-control ledger mutation shared by the direct agent REST
    /// route and the gateway BYOA callback. Callers must already be inside the
    /// tenant transaction; all approval, host, lineage, audit, and outbox rules
    /// remain centralized here.
    static func createControl(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        request requestDTO: CreateWorkControlRequest
    ) async throws -> WorkControlDTO {
        guard principal.kind == .agent, principal.workspaceID == workspaceID else {
            throw HTTPError(.forbidden, message: "work controls require an agent bearer")
        }
        let kind = try validatedKind(requestDTO.kind)
        let payload = try validatedPayload(requestDTO.payload, kind: kind)
        try validateSessionShape(kind: kind, sessionID: requestDTO.sessionId)

        let binding = try await requireRunBinding(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            channelID: requestDTO.channelId,
            runID: requestDTO.runId,
            agentID: principal.memberID
        )
        try await requireTargetWorkHost(
            conn: conn,
            logger: logger,
            workspaceID: workspaceID,
            targetHostID: requestDTO.targetHostId,
            sessionOwnerMemberID: binding.ownerHumanID
        )

        if kind != .spawn {
            try await requireSessionControlLineage(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                channelID: requestDTO.channelId,
                sessionID: requestDTO.sessionId!,
                targetHostID: requestDTO.targetHostId,
                requesterMemberID: principal.memberID,
                requireRunning: kind == .input || kind == .kill
            )
        }

        let autoApproved: Bool
        if kind == .spawn {
            autoApproved = try await isAutoApproved(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                ownerHumanID: binding.ownerHumanID,
                tool: payload.object["tool"]?.stringValue
            )
        } else {
            autoApproved = false
        }
        let initialStatus = autoApproved || kind != .spawn
            ? "approved"
            : "pending_approval"
        let rows = try await conn.query(
            """
            INSERT INTO work_control
              (workspace_id, channel_id, requester_member_id, target_host_id,
               session_id, kind, payload, status)
            VALUES
              (\(workspaceID), \(requestDTO.channelId), \(principal.memberID),
               \(requestDTO.targetHostId), \(requestDTO.sessionId), \(kind.rawValue),
               \(payload.json)::jsonb, \(initialStatus))
            RETURNING id, workspace_id, channel_id, requester_member_id,
                      target_host_id, session_id, kind, payload::text, status,
                      approval_message_id, created_at, updated_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "work control insert failed")
        }
        var created = try decodeControl(row)

        let auditDetail = jsonString([
            "schema": "momo.work_control.requested.v1",
            "control_id": created.id,
            "run_id": requestDTO.runId.uuidString,
            "kind": kind.rawValue,
            "target_host_id": requestDTO.targetHostId.uuidString,
            "auto_approved": autoApproved,
        ])
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, run_id, detail)
            VALUES
              (\(workspaceID), \(principal.memberID), \(binding.ownerHumanID),
               'work.control.requested', 'work_control', \(UUID(uuidString: created.id)!),
               \(principal.tokenID), \(requestDTO.runId), \(auditDetail)::jsonb)
            """,
            logger: logger
        )

        if autoApproved || kind != .spawn {
            created = try await enqueueDispatch(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                control: created
            )
        } else {
            created = try await createSpawnApproval(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                runID: requestDTO.runId,
                ownerHumanID: binding.ownerHumanID,
                control: created,
                tokenID: principal.tokenID
            )
        }
        return created
    }

    @Sendable
    func acknowledge(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human || principal.kind == .workHost else {
            throw HTTPError(.forbidden, message: "work control ack requires the execution host")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let controlID = try Self.controlID(context)
        let requestDTO = try await request.decode(
            as: WorkControlAckRequest.self,
            context: context
        )
        let errorLabel = try Self.validatedErrorLabel(requestDTO.errorLabel)

        let control = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            guard var locked = try await Self.lockControl(
                conn: conn,
                logger: db.logger,
                controlID: controlID
            ) else {
                throw HTTPError(.notFound, message: "work control not found")
            }
            guard locked.status == "dispatched" else {
                throw HTTPError(.conflict, message: "only dispatched controls can be acknowledged")
            }
            guard let hostOwnerMemberID = try await Self.activeHostOwner(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                targetHostID: UUID(uuidString: locked.targetHostId)!
            ) else {
                throw HTTPError(.notFound, message: "work host not found")
            }
            if principal.kind == .workHost {
                guard UUID(uuidString: locked.targetHostId) == principal.tokenID else {
                    throw HTTPError(.forbidden, message: "work host cannot acknowledge another host control")
                }
            } else {
                guard hostOwnerMemberID == principal.memberID else {
                    throw HTTPError(.forbidden, message: "only the registered host owner can acknowledge")
                }
            }

            let ackSessionID: UUID?
            if locked.kind == Kind.spawn.rawValue, requestDTO.ok {
                guard let sessionID = requestDTO.sessionId else {
                    throw HTTPError(.badRequest, message: "successful spawn ack requires sessionId")
                }
                try await Self.requireSpawnAckSession(
                    conn: conn,
                    logger: db.logger,
                    control: locked,
                    sessionID: sessionID
                )
                ackSessionID = sessionID
            } else {
                if let supplied = requestDTO.sessionId,
                   supplied.uuidString.lowercased() != locked.sessionId?.lowercased()
                {
                    throw HTTPError(.badRequest, message: "ack sessionId does not match control")
                }
                ackSessionID = requestDTO.sessionId ?? locked.sessionId.flatMap(UUID.init(uuidString:))
            }
            if requestDTO.ok, errorLabel != nil {
                throw HTTPError(.badRequest, message: "successful ack cannot include errorLabel")
            }

            let status = requestDTO.ok ? "acked" : "failed"
            let rows = try await conn.query(
                """
                UPDATE work_control
                   SET status = \(status),
                       session_id = COALESCE(\(ackSessionID), session_id),
                       updated_at = clock_timestamp()
                 WHERE id = \(controlID)
                   AND status = 'dispatched'
                RETURNING id, workspace_id, channel_id, requester_member_id,
                          target_host_id, session_id, kind, payload::text, status,
                          approval_message_id, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.conflict, message: "work control state changed; retry")
            }
            locked = try Self.decodeControl(row)
            let event = Self.ackPayload(
                workspaceID: workspaceID,
                control: locked,
                ok: requestDTO.ok,
                errorLabel: errorLabel
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish', \(event)::jsonb,
                   \(UUID(uuidString: locked.channelId)!))
                """,
                logger: db.logger
            )
            return locked
        }

        return try WorkControlResponse(workControl: control)
            .response(from: request, context: context)
    }

    @Sendable
    func enableAutoApprove(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await mutateAutoApprove(request, context: context, enabled: true)
    }

    @Sendable
    func disableAutoApprove(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await mutateAutoApprove(request, context: context, enabled: false)
    }

    @Sendable
    func listAutoApprovals(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "auto-approve settings require a human owner")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)

        let tools = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard try await Self.isActiveHuman(
                conn: conn,
                logger: db.logger,
                memberID: principal.memberID
            ) else {
                throw HTTPError(.forbidden, message: "active human membership required")
            }

            let rows = try await conn.query(
                """
                SELECT tool
                  FROM work_auto_approve
                 WHERE workspace_id = \(workspaceID)
                   AND host_owner_member_id = \(principal.memberID)
                 ORDER BY tool ASC
                """,
                logger: db.logger
            ).collect()
            return try rows.map { try $0.decode(String.self) }
        }

        return try WorkAutoApprovalsResponse(tools: tools)
            .response(from: request, context: context)
    }

    private func mutateAutoApprove(
        _ request: Request,
        context: AppRequestContext,
        enabled: Bool
    ) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "auto-approve settings require a human owner")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let tool = try Self.validatedTool(try context.parameters.require("tool"))

        try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            guard try await Self.isActiveHuman(
                conn: conn,
                logger: db.logger,
                memberID: principal.memberID
            ) else {
                throw HTTPError(.forbidden, message: "active human membership required")
            }

            let rows: [PostgresRow]
            if enabled {
                rows = try await conn.query(
                    """
                    INSERT INTO work_auto_approve
                      (workspace_id, host_owner_member_id, tool)
                    VALUES (\(workspaceID), \(principal.memberID), \(tool))
                    ON CONFLICT DO NOTHING
                    RETURNING tool
                    """,
                    logger: db.logger
                ).collect()
            } else {
                rows = try await conn.query(
                    """
                    DELETE FROM work_auto_approve
                     WHERE workspace_id = \(workspaceID)
                       AND host_owner_member_id = \(principal.memberID)
                       AND tool = \(tool)
                    RETURNING tool
                    """,
                    logger: db.logger
                ).collect()
            }

            if !rows.isEmpty {
                let detail = Self.jsonString([
                    "schema": "momo.work_auto_approve.changed.v1",
                    "tool": tool,
                    "enabled": enabled,
                ])
                _ = try await conn.query(
                    """
                    INSERT INTO audit_log
                      (workspace_id, actor_member_id, subject_member_id, action,
                       target_type, via_token_id, detail)
                    VALUES
                      (\(workspaceID), \(principal.memberID), \(principal.memberID),
                       \(enabled ? "work.auto_approve.enabled" : "work.auto_approve.disabled"),
                       'work_auto_approve', \(principal.tokenID), \(detail)::jsonb)
                    """,
                    logger: db.logger
                )
            }
        }

        return try WorkAutoApproveResponse(tool: tool, enabled: enabled)
            .response(from: request, context: context)
    }

    /// Called from the canonical human approval decision transaction. A work
    /// control cannot be dispatched unless its linked approval is the row being
    /// decided, so pending/denied controls cannot bypass D5.
    static func applySpawnApprovalDecision(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        approvalID: UUID,
        controlID: UUID,
        approved: Bool
    ) async throws {
        let rows = try await conn.query(
            """
            UPDATE work_control wc
               SET status = \(approved ? "approved" : "denied"),
                   updated_at = clock_timestamp()
              FROM approval a
             WHERE wc.id = \(controlID)
               AND wc.workspace_id = \(workspaceID)
               AND wc.status = 'pending_approval'
               AND wc.approval_message_id = a.request_message_id
               AND a.id = \(approvalID)
            RETURNING wc.id, wc.workspace_id, wc.channel_id,
                      wc.requester_member_id, wc.target_host_id, wc.session_id,
                      wc.kind, wc.payload::text, wc.status,
                      wc.approval_message_id, wc.created_at, wc.updated_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "linked work control is not pending approval")
        }
        if approved {
            _ = try await enqueueDispatch(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                control: try decodeControl(row)
            )
        }
    }

    static func workControlID(from approvalPayload: JSONValue) throws -> UUID? {
        guard approvalPayload.objectValue?["source"]?.stringValue == "work_control" else {
            return nil
        }
        guard let raw = approvalPayload.objectValue?["work_control_id"]?.stringValue,
              let id = UUID(uuidString: raw)
        else {
            throw HTTPError(.internalServerError, message: "work control approval binding is malformed")
        }
        return id
    }

    static func validatedKind(_ raw: String) throws -> Kind {
        guard let kind = Kind(rawValue: raw) else {
            throw HTTPError(.badRequest, message: "kind must be spawn, input, read, or kill")
        }
        return kind
    }

    static func validatedTool(_ raw: String) throws -> String {
        guard ["claude", "codex", "opencode", "shell"].contains(raw) else {
            throw HTTPError(.badRequest, message: "unsupported work tool")
        }
        return raw
    }

    static func validatedPayload(_ raw: JSONValue, kind: Kind) throws -> ValidatedPayload {
        guard let object = raw.objectValue else {
            throw HTTPError(.badRequest, message: "payload must be an object")
        }
        func exactKeys(_ keys: Set<String>) throws {
            guard Set(object.keys) == keys else {
                throw HTTPError(.badRequest, message: "payload contains unsupported fields")
            }
        }

        let sendable: [String: AnySendable]
        switch kind {
        case .spawn:
            try exactKeys(["tool", "label"])
            guard let rawTool = object["tool"]?.stringValue,
                  let rawLabel = object["label"]?.stringValue
            else {
                throw HTTPError(.badRequest, message: "spawn payload requires tool and label strings")
            }
            let tool = try validatedTool(rawTool)
            let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, label.count <= 120 else {
                throw HTTPError(.badRequest, message: "spawn label must contain 1...120 characters")
            }
            sendable = ["tool": .string(tool), "label": .string(label)]
        case .input:
            try exactKeys(["text"])
            guard let text = object["text"]?.stringValue,
                  !text.isEmpty, text.count <= 32_768
            else {
                throw HTTPError(.badRequest, message: "input text must contain 1...32768 characters")
            }
            sendable = ["text": .string(text)]
        case .read:
            guard Set(object.keys).isSubset(of: ["tail_lines"]) else {
                throw HTTPError(.badRequest, message: "read payload only accepts tail_lines")
            }
            if let value = object["tail_lines"] {
                guard case .int(let lines) = value, (1...9_999).contains(lines) else {
                    throw HTTPError(.badRequest, message: "tail_lines must be an integer from 1 through 9999")
                }
                sendable = ["tail_lines": .int(lines)]
            } else {
                sendable = [:]
            }
        case .kill:
            try exactKeys([])
            sendable = [:]
        }
        let normalized = JSONValue.object(sendable.mapValues(\.jsonValue))
        return ValidatedPayload(
            value: normalized,
            json: jsonString(anyObject(sendable)),
            object: sendable
        )
    }

    static func dispatchPayload(workspaceID: UUID, control: WorkControlDTO) -> String {
        let channel = channelName(
            workspaceID: workspaceID,
            channelID: UUID(uuidString: control.channelId)!
        )
        return jsonString([
            "channel": channel,
            "data": [
                "type": "work.control.dispatched",
                "v": 1,
                "ts": control.updatedAtMs,
                "payload": controlEventBody(control),
            ],
            "idempotency_key": "\(channel):work.control.dispatched:\(control.id)",
        ])
    }

    static func ackPayload(
        workspaceID: UUID,
        control: WorkControlDTO,
        ok: Bool,
        errorLabel: String?
    ) -> String {
        let channel = channelName(
            workspaceID: workspaceID,
            channelID: UUID(uuidString: control.channelId)!
        )
        var body = controlEventBody(control)
        body["ok"] = ok
        body["status"] = control.status
        if let errorLabel { body["error_label"] = errorLabel }
        return jsonString([
            "channel": channel,
            "data": [
                "type": "work.control.acked",
                "v": 1,
                "ts": control.updatedAtMs,
                "payload": body,
            ],
            "idempotency_key": "\(channel):work.control.acked:\(control.id)",
        ])
    }

    private static func createSpawnApproval(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        runID: UUID,
        ownerHumanID: UUID,
        control: WorkControlDTO,
        tokenID: UUID
    ) async throws -> WorkControlDTO {
        let controlID = UUID(uuidString: control.id)!
        let channelID = UUID(uuidString: control.channelId)!
        let requesterID = UUID(uuidString: control.requesterMemberId)!
        let targetHostID = UUID(uuidString: control.targetHostId)!
        let payloadObject = anyValue(control.payload) as? [String: Any] ?? [:]
        let tool = payloadObject["tool"] as? String ?? ""
        let label = payloadObject["label"] as? String ?? ""
        let approvalPayload = jsonString([
            "source": "work_control",
            "work_control_id": control.id,
            "target_host_id": control.targetHostId,
            "on_behalf_of": ownerHumanID.uuidString,
            "tool_call": [
                "call_id": control.id,
                "name": "work.spawn",
                "arguments": payloadObject,
            ],
        ])
        let approvalRows = try await conn.query(
            """
            INSERT INTO approval
              (workspace_id, run_id, channel_id, requested_by,
               action_type, payload, status)
            VALUES
              (\(workspaceID), \(runID), \(channelID), \(requesterID),
               'work.spawn', \(approvalPayload)::jsonb, 'pending')
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard let approvalID = try approvalRows.first?.decode(UUID.self) else {
            throw HTTPError(.internalServerError, message: "work spawn approval insert failed")
        }

        let props: [String: Any] = [
            "kind": "work_control_approval",
            "approval_id": approvalID.uuidString,
            "control_id": control.id,
            "run_id": runID.uuidString,
            "action_type": "work.spawn",
            "approval_status": "pending",
            "status": "pending",
            "tool": tool,
            "label": label,
            "target_host_id": targetHostID.uuidString,
        ]
        let body = "Approval required: spawn \(tool) — \(label)"
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
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
               author_member_id, type, body, props, run_id)
            SELECT \(workspaceID), \(channelID), b.seq, \(hlcTs), 0,
                   \(requesterID), 'approval_request'::message_type,
                   \(body), \(jsonString(props))::jsonb, \(runID)
              FROM bumped b
            RETURNING id, seq
            """,
            logger: logger
        ).collect()
        guard let messageRow = messageRows.first else {
            throw HTTPError(.conflict, message: "approval channel sequence is unavailable")
        }
        let (messageID, seq) = try messageRow.decode((UUID, Int64).self)

        _ = try await conn.query(
            """
            UPDATE approval SET request_message_id = \(messageID) WHERE id = \(approvalID)
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            UPDATE work_control
               SET approval_message_id = \(messageID), updated_at = clock_timestamp()
             WHERE id = \(controlID)
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            UPDATE agent_run
               SET status = 'awaiting_approval', updated_at = now()
             WHERE id = \(runID) AND status IN ('queued','running')
            """,
            logger: logger
        )
        let broadcast = MessageRoutes.broadcastPayload(
            centChannel: channelName(workspaceID: workspaceID, channelID: channelID),
            messageID: messageID,
            channelID: channelID,
            seq: seq,
            type: "approval_request",
            body: body,
            authorMemberID: requesterID,
            hlcTs: hlcTs,
            hlcCount: 0,
            rootID: nil,
            props: props
        )
        let auditDetail = jsonString([
            "schema": "momo.work_control.approval_request.v1",
            "approval_id": approvalID.uuidString,
            "control_id": control.id,
            "run_id": runID.uuidString,
            "tool": tool,
        ])
        _ = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'broadcast', 'publish', \(broadcast)::jsonb, \(channelID))
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, run_id, detail)
            VALUES
              (\(workspaceID), \(requesterID), \(ownerHumanID),
               'approval.requested', 'approval', \(approvalID), \(tokenID),
               \(runID), \(auditDetail)::jsonb)
            """,
            logger: logger
        )
        guard let updated = try await fetchControl(
            conn: conn,
            logger: logger,
            controlID: controlID
        ) else {
            throw HTTPError(.internalServerError, message: "work control approval binding failed")
        }
        return updated
    }

    private static func enqueueDispatch(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        control: WorkControlDTO
    ) async throws -> WorkControlDTO {
        let controlID = UUID(uuidString: control.id)!
        let hostID = UUID(uuidString: control.targetHostId)!
        let activeRows = try await conn.query(
            """
            SELECT 1
              FROM work_host
             WHERE id = \(hostID)
               AND workspace_id = \(workspaceID)
               AND revoked_at IS NULL
             FOR SHARE
            """,
            logger: logger
        ).collect()
        guard !activeRows.isEmpty else {
            return try await failDispatchForRevokedHost(
                conn: conn,
                logger: logger,
                workspaceID: workspaceID,
                controlID: controlID
            )
        }

        let rows = try await conn.query(
            """
            UPDATE work_control
               SET status = 'dispatched', updated_at = clock_timestamp()
             WHERE id = \(controlID)
               AND status = 'approved'
            RETURNING id, workspace_id, channel_id, requester_member_id,
                      target_host_id, session_id, kind, payload::text, status,
                      approval_message_id, created_at, updated_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "work control is not approved for dispatch")
        }
        let dispatched = try decodeControl(row)
        let payload = dispatchPayload(workspaceID: workspaceID, control: dispatched)
        _ = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'broadcast', 'publish', \(payload)::jsonb,
               \(UUID(uuidString: dispatched.channelId)!))
            """,
            logger: logger
        )
        return dispatched
    }

    private static func failDispatchForRevokedHost(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        controlID: UUID
    ) async throws -> WorkControlDTO {
        let rows = try await conn.query(
            """
            UPDATE work_control
               SET status = 'failed', updated_at = clock_timestamp()
             WHERE id = \(controlID)
               AND status = 'approved'
            RETURNING id, workspace_id, channel_id, requester_member_id,
                      target_host_id, session_id, kind, payload::text, status,
                      approval_message_id, created_at, updated_at
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.conflict, message: "work control is not approved for dispatch")
        }
        let failed = try decodeControl(row)
        let payload = ackPayload(
            workspaceID: workspaceID,
            control: failed,
            ok: false,
            errorLabel: "host_revoked"
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(workspaceID), 'broadcast', 'publish', \(payload)::jsonb,
               \(UUID(uuidString: failed.channelId)!))
            """,
            logger: logger
        )
        return failed
    }

    private static func requireRunBinding(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        runID: UUID,
        agentID: UUID
    ) async throws -> RunBinding {
        let rows = try await conn.query(
            """
            SELECT a.owner_human_id
              FROM agent_run r
              JOIN member m
                ON m.id = r.agent_member_id
               AND m.workspace_id = r.workspace_id
               AND m.kind = 'agent'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
              JOIN agent a
                ON a.member_id = m.id
               AND a.workspace_id = m.workspace_id
              JOIN membership ms
                ON ms.workspace_id = r.workspace_id
               AND ms.channel_id = r.channel_id
               AND ms.member_id = r.agent_member_id
               AND ms.left_at IS NULL
              JOIN member owner
                ON owner.id = a.owner_human_id
               AND owner.workspace_id = r.workspace_id
               AND owner.kind = 'human'
               AND owner.status = 'active'
               AND owner.deleted_at IS NULL
             WHERE r.id = \(runID)
               AND r.workspace_id = \(workspaceID)
               AND r.channel_id = \(channelID)
               AND r.agent_member_id = \(agentID)
               AND r.status IN ('queued','running')
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let owner = try rows.first?.decode(UUID.self) else {
            throw HTTPError(.conflict, message: "agent run is not eligible for work control")
        }
        return RunBinding(ownerHumanID: owner)
    }

    private static func requireTargetWorkHost(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        targetHostID: UUID,
        sessionOwnerMemberID: UUID
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT scope, owner_member_id
              FROM work_host
             WHERE id = \(targetHostID)
               AND workspace_id = \(workspaceID)
               AND revoked_at IS NULL
             FOR SHARE
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            // Missing, revoked, and cross-workspace hosts deliberately collapse
            // to the same non-disclosing response.
            throw HTTPError(.notFound, message: "work host not found")
        }
        let (scope, ownerMemberID) = try row.decode((String, UUID).self)
        try validateTargetHostScope(
            scope: scope,
            ownerMemberID: ownerMemberID,
            sessionOwnerMemberID: sessionOwnerMemberID
        )
    }

    static func validateTargetHostScope(
        scope: String,
        ownerMemberID: UUID,
        sessionOwnerMemberID: UUID
    ) throws {
        if scope == "workspace" { return }
        guard scope == "member" else {
            throw HTTPError(.internalServerError, message: "work host scope is invalid")
        }
        guard ownerMemberID == sessionOwnerMemberID else {
            throw HTTPError(
                .forbidden,
                message: "member-scoped work host belongs to another session owner"
            )
        }
    }

    private static func activeHostOwner(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        targetHostID: UUID
    ) async throws -> UUID? {
        let rows = try await conn.query(
            """
            SELECT owner_member_id
              FROM work_host
             WHERE id = \(targetHostID)
               AND workspace_id = \(workspaceID)
               AND revoked_at IS NULL
             FOR SHARE
            """,
            logger: logger
        ).collect()
        return try rows.first?.decode(UUID.self)
    }

    private static func requireSessionControlLineage(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        sessionID: UUID,
        targetHostID: UUID,
        requesterMemberID: UUID,
        requireRunning: Bool
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT ws.status
              FROM work_session ws
              JOIN work_control root
                ON root.workspace_id = ws.workspace_id
               AND root.channel_id = ws.channel_id
               AND root.session_id = ws.id
               AND root.kind = 'spawn'
               AND root.status = 'acked'
             WHERE ws.id = \(sessionID)
               AND ws.workspace_id = \(workspaceID)
               AND ws.channel_id = \(channelID)
               AND ws.host_id = \(targetHostID)
               AND root.target_host_id = \(targetHostID)
               AND root.requester_member_id = \(requesterMemberID)
             ORDER BY root.created_at ASC
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let status = try rows.first?.decode(String.self) else {
            throw HTTPError(.forbidden, message: "session is outside the approved requester lineage")
        }
        if requireRunning, status != "running" {
            throw HTTPError(.conflict, message: "input and kill require a running work session")
        }
    }

    private static func requireSpawnAckSession(
        conn: PostgresConnection,
        logger: Logger,
        control: WorkControlDTO,
        sessionID: UUID
    ) async throws {
        let preallocatedSessionID = control.sessionId.flatMap(UUID.init(uuidString:))
        let rows = try await conn.query(
            """
            SELECT 1
              FROM work_session ws
              JOIN member requester
                ON requester.id = \(UUID(uuidString: control.requesterMemberId)!)
               AND requester.workspace_id = ws.workspace_id
               AND requester.kind IN ('agent', 'human')
               AND requester.status = 'active'
               AND requester.deleted_at IS NULL
              LEFT JOIN agent a
                ON a.member_id = requester.id
               AND a.workspace_id = requester.workspace_id
             WHERE ws.id = \(sessionID)
               AND ws.workspace_id = \(UUID(uuidString: control.workspaceId)!)
               AND ws.channel_id = \(UUID(uuidString: control.channelId)!)
               AND ws.host_id = \(UUID(uuidString: control.targetHostId)!)
               AND ws.status = 'running'
               AND (\(preallocatedSessionID)::uuid IS NULL OR ws.id = \(preallocatedSessionID)::uuid)
               AND (
                 (requester.kind = 'agent' AND ws.member_id = a.owner_human_id)
                 OR (
                   requester.kind = 'human'
                   AND ws.member_id = requester.id
                   AND ws.resumed_from_session_id IS NOT NULL
                 )
               )
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard !rows.isEmpty else {
            throw HTTPError(.conflict, message: "spawn ack session does not match work_session")
        }
    }

    private static func isAutoApproved(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        ownerHumanID: UUID,
        tool: String?
    ) async throws -> Bool {
        guard let tool else { return false }
        let rows = try await conn.query(
            """
            SELECT 1
              FROM work_auto_approve
             WHERE workspace_id = \(workspaceID)
               AND host_owner_member_id = \(ownerHumanID)
               AND tool = \(tool)
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func isActiveHuman(
        conn: PostgresConnection,
        logger: Logger,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM member
             WHERE id = \(memberID)
               AND kind = 'human'
               AND status = 'active'
               AND deleted_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    static func fetchControl(
        conn: PostgresConnection,
        logger: Logger,
        controlID: UUID
    ) async throws -> WorkControlDTO? {
        let rows = try await conn.query(
            """
            SELECT id, workspace_id, channel_id, requester_member_id,
                   target_host_id, session_id, kind, payload::text, status,
                   approval_message_id, created_at, updated_at
              FROM work_control
             WHERE id = \(controlID)
            """,
            logger: logger
        ).collect()
        return try rows.first.map(decodeControl)
    }

    private static func lockControl(
        conn: PostgresConnection,
        logger: Logger,
        controlID: UUID
    ) async throws -> WorkControlDTO? {
        let rows = try await conn.query(
            """
            SELECT id, workspace_id, channel_id, requester_member_id,
                   target_host_id, session_id, kind, payload::text, status,
                   approval_message_id, created_at, updated_at
              FROM work_control
             WHERE id = \(controlID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        return try rows.first.map(decodeControl)
    }

    static func decodeControl(_ row: PostgresRow) throws -> WorkControlDTO {
        let decoded = try row.decode(
            (UUID, UUID, UUID, UUID, UUID, UUID?, String, String,
             String, UUID?, Date, Date).self
        )
        let payload = try JSONDecoder().decode(JSONValue.self, from: Data(decoded.7.utf8))
        return WorkControlDTO(
            id: decoded.0.uuidString,
            workspaceId: decoded.1.uuidString,
            channelId: decoded.2.uuidString,
            requesterMemberId: decoded.3.uuidString,
            targetHostId: decoded.4.uuidString,
            sessionId: decoded.5?.uuidString,
            kind: decoded.6,
            payload: payload,
            status: decoded.8,
            approvalMessageId: decoded.9?.uuidString,
            createdAtMs: epochMs(decoded.10),
            updatedAtMs: epochMs(decoded.11)
        )
    }

    private static func validateSessionShape(kind: Kind, sessionID: UUID?) throws {
        if kind == .spawn, sessionID != nil {
            throw HTTPError(.badRequest, message: "spawn must not provide sessionId")
        }
        if kind != .spawn, sessionID == nil {
            throw HTTPError(.badRequest, message: "non-spawn controls require sessionId")
        }
    }

    private static func validatedErrorLabel(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let label = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label.count <= 120 else {
            throw HTTPError(.badRequest, message: "errorLabel must contain 1...120 characters")
        }
        return label
    }

    private static func controlID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("control")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid work control id")
        }
        return id
    }

    private static func controlEventBody(_ control: WorkControlDTO) -> [String: Any] {
        [
            "control_id": control.id,
            "channel_id": control.channelId,
            "requester_member_id": control.requesterMemberId,
            "target_host_id": control.targetHostId,
            "session_id": control.sessionId ?? NSNull(),
            "kind": control.kind,
            "payload": anyValue(control.payload),
        ]
    }

    private static func channelName(workspaceID: UUID, channelID: UUID) -> String {
        "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
    }

    private static func epochMs(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1000)
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

    private static func anyValue(_ value: JSONValue) -> Any {
        switch value {
        case .object(let object): object.mapValues(anyValue)
        case .array(let array): array.map(anyValue)
        case .string(let string): string
        case .int(let int): int
        case .double(let double): double
        case .bool(let bool): bool
        case .null: NSNull()
        }
    }

    private static func anyObject(_ object: [String: AnySendable]) -> [String: Any] {
        object.mapValues { value in
            switch value {
            case .string(let string): string
            case .int(let int): int
            }
        }
    }
}

private extension WorkControlRoutes.AnySendable {
    var jsonValue: JSONValue {
        switch self {
        case .string(let value): .string(value)
        case .int(let value): .int(value)
        }
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
}
